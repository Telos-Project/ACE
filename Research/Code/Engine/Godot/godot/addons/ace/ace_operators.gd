## The Godot operator table: what each kind of ACE component builds, changes,
## and destroys.
##
## Godot's 3D space is right handed, Y up, with -Z forward, which is the
## convention the standard already mandates, so no axis is converted anywhere
## in this file.
extends RefCounted


func table() -> Dictionary:
	return {
		"world": {"order": -100},
		"texture": {"order": -20},
		"material": {"order": -10},
		"camera": {"order": 0},
		"light": {"order": 0},
		"mesh": {"order": 0},
		"text": {"order": 0},
		"collider": {"order": 10},
		"body": {"order": 20},
		"joint": {"order": 30},
		"animation": {"order": 10},
		"audio": {"order": 0},
		"query": {"order": 40},
		"script": {"order": 0}
	}


# ---------------------------------------------------------------- conversions

func vector(value, fallback = Vector3.ZERO) -> Vector3:
	if not (value is Array):
		return fallback

	return Vector3(
		float(value[0]) if value.size() > 0 else 0.0,
		float(value[1]) if value.size() > 1 else 0.0,
		float(value[2]) if value.size() > 2 else 0.0
	)


func scaling(value) -> Vector3:
	if value is float or value is int:
		return Vector3(float(value), float(value), float(value))
	return vector(value, Vector3.ONE)


func basis_of(value) -> Basis:
	if value is Array and value.size() >= 4:
		return Basis(Quaternion(
			float(value[0]), float(value[1]),
			float(value[2]), float(value[3])
		))

	if value is Array:
		var euler = vector(value)
		return Basis.from_euler(euler)

	return Basis()


## A colour is a three or four element array of linear floats, or an sRGB hex
## string. Both are accepted everywhere.
func colour(value, fallback = Color(0, 0, 0, 1)) -> Color:
	if value is String and value.begins_with("#"):
		return Color(value)

	if value is Array:
		return Color(
			float(value[0]) if value.size() > 0 else 0.0,
			float(value[1]) if value.size() > 1 else 0.0,
			float(value[2]) if value.size() > 2 else 0.0,
			float(value[3]) if value.size() > 3 else 1.0
		)

	return fallback


func dimensions(data: Dictionary, fallback = Vector3.ONE) -> Vector3:
	var size = data.get("size")

	if size is float or size is int:
		return Vector3(float(size), float(size), float(size))

	return vector(size, fallback)


# -------------------------------------------------------------------- create

func create(runtime, type: String, instance: Dictionary) -> Variant:
	match type:
		"world": return _world(runtime, instance)
		"camera": return _camera(runtime, instance)
		"light": return _light(runtime, instance)
		"texture": return _texture(runtime, instance)
		"material": return _material(runtime, instance)
		"mesh": return _mesh(runtime, instance)
		"text": return _text(runtime, instance)
		"collider": return _collider(runtime, instance)
		"body": return _body(runtime, instance)
		"audio": return _audio(runtime, instance)
		"animation": return _animation(runtime, instance)
		"query": return {}
		"script": return {}

	runtime.report(type, "create", "no operator for component type")
	return null


func _world(runtime, instance: Dictionary) -> Dictionary:
	var data: Dictionary = instance["data"]
	var env = Environment.new()

	var background = data.get("background")

	if background is Dictionary or background == null:
		env.background_mode = Environment.BG_COLOR
		env.background_color = Color(0, 0, 0, 1)
	else:
		var tint = colour(background, Color(0, 0, 0, 1))
		env.background_mode = Environment.BG_COLOR
		env.background_color = tint

		## An alpha of zero clears to nothing at all, which is what an
		## augmented session needs.
		if tint.a < 0.001:
			env.background_mode = Environment.BG_CANVAS

	env.ambient_light_color = colour(data.get("ambient"), Color(0, 0, 0))
	env.ambient_light_energy = 1.0
	env.ambient_light_source = Environment.AMBIENT_SOURCE_COLOR

	if data.get("fog") is Dictionary:
		env.fog_enabled = true
		env.fog_light_color = colour(data["fog"].get("colour",
			data["fog"].get("color")), Color(1, 1, 1))

	var holder = WorldEnvironment.new()
	holder.environment = env
	holder.name = "AceEnvironment"

	runtime.add_child(holder)

	var gravity = data.get("gravity", [0, -9.81, 0])
	var physics = gravity != null

	if physics:
		var pull = vector(gravity, Vector3(0, -9.81, 0))

		PhysicsServer3D.area_set_param(
			runtime.get_viewport().find_world_3d().space,
			PhysicsServer3D.AREA_PARAM_GRAVITY_VECTOR,
			pull.normalized() if pull.length() > 0.0 else Vector3.DOWN
		)

		PhysicsServer3D.area_set_param(
			runtime.get_viewport().find_world_3d().space,
			PhysicsServer3D.AREA_PARAM_GRAVITY,
			pull.length()
		)

	runtime.physics_on = physics

	var capabilities = ["audio"]

	if physics:
		capabilities.append("physics")

	var missing = []
	var required = data.get("requires")

	if required is Array:
		for want in required:
			if not (want in capabilities):
				missing.append(want)

	if missing.size() > 0:
		runtime.report("world", "create",
			"unmet capabilities: " + ", ".join(missing))

	runtime.set_state(instance["record"], {
		"ready": true, "capabilities": capabilities
	})

	return {"environment": holder}


func _camera(runtime, instance: Dictionary) -> Dictionary:
	var data: Dictionary = instance["data"]
	var camera = Camera3D.new()

	camera.name = "camera"
	camera.near = float(data.get("near", 0.1))
	camera.far = float(data.get("far", 1000.0))

	if data.get("projection") == "orthographic":
		camera.projection = Camera3D.PROJECTION_ORTHOGONAL
		camera.size = float(data.get("size", 10.0))
	else:
		camera.projection = Camera3D.PROJECTION_PERSPECTIVE
		camera.fov = rad_to_deg(float(data.get("fov", 1.05)))

	runtime.node_for(instance["entity"]).add_child(camera)

	if data.get("target") is Array:
		camera.look_at(vector(data["target"]), Vector3.UP)

	camera.current = runtime.claim_camera()

	runtime.set_state(instance["record"], {
		"supported": runtime.xr_modes(), "presenting": runtime.xr_presenting()
	})

	if data.get("xr") is Dictionary:
		runtime.request_xr(camera, data["xr"], instance)

	return {"camera": camera}


func _light(runtime, instance: Dictionary) -> Dictionary:
	var data: Dictionary = instance["data"]
	var kind = str(data.get("type", "directional"))
	var light: Node3D

	match kind:
		"point":
			light = OmniLight3D.new()
			light.omni_range = float(data.get("range", 10.0))
		"spot":
			light = SpotLight3D.new()
			light.spot_range = float(data.get("range", 10.0))
			light.spot_angle = rad_to_deg(float(data.get("angle", 0.7)))
		"ambient":
			## Carried by the environment rather than by a node of its own.
			runtime.ambient(colour(data.get("color"), Color(1, 1, 1)),
				float(data.get("intensity", 1.0)))
			return {"light": null, "ambient": true}
		_:
			light = DirectionalLight3D.new()

	light.name = "light"
	light.light_color = colour(data.get("color"), Color(1, 1, 1))
	light.light_energy = float(data.get("intensity", 1.0))

	var shadow = data.get("shadow")
	light.shadow_enabled = shadow != null and shadow != false

	runtime.node_for(instance["entity"]).add_child(light)

	return {"light": light}


func _texture(runtime, instance: Dictionary) -> Dictionary:
	var data: Dictionary = instance["data"]
	var element: Dictionary = instance["record"]["element"]
	var content = element.get("content")

	## Raw samples, given as bytes.
	if content is Array and data.get("size") is Array:
		var width = int(data["size"][0])
		var height = int(data["size"][1])
		var bytes = PackedByteArray()

		for value in content:
			bytes.append(int(value) & 0xFF)

		var image = Image.create_from_data(
			width, height, false, Image.FORMAT_RGBA8, bytes
		)

		var made = ImageTexture.create_from_image(image)

		runtime.set_state(instance["record"], {
			"loaded": true, "size": [width, height]
		})

		return {"texture": made}

	var sources = runtime.sources_of(element)

	for source in sources:
		var found = runtime.load_asset(source)

		if found != null:
			runtime.set_state(instance["record"], {
				"loaded": true, "source": source
			})
			return {"texture": found}

	runtime.set_state(instance["record"], {
		"loaded": false,
		"error": "all sources failed" if sources.size() > 0
			else "texture has neither source nor content"
	})

	return {"texture": null}


func _material(runtime, instance: Dictionary) -> Dictionary:
	var made = StandardMaterial3D.new()
	var object = {"material": made}

	apply_material(runtime, instance, object)

	return object


func apply_material(runtime, instance: Dictionary, object: Dictionary) -> void:
	var data: Dictionary = instance["data"]
	var made: StandardMaterial3D = object["material"]

	var base = colour(data.get("color"), Color(1, 1, 1, 1))

	made.albedo_color = base
	made.metallic = float(data.get("metallic", 0.0))
	made.roughness = float(data.get("roughness", 1.0))

	var glow = colour(data.get("emissive"), Color(0, 0, 0))

	made.emission_enabled = glow.r + glow.g + glow.b > 0.0
	made.emission = glow

	if data.get("unlit") == true:
		made.shading_mode = BaseMaterial3D.SHADING_MODE_UNSHADED

	match str(data.get("blend", "opaque")):
		"blend":
			made.transparency = BaseMaterial3D.TRANSPARENCY_ALPHA
		"mask":
			made.transparency = BaseMaterial3D.TRANSPARENCY_ALPHA_SCISSOR
			made.alpha_scissor_threshold = float(data.get("cutoff", 0.5))
		_:
			made.transparency = (BaseMaterial3D.TRANSPARENCY_ALPHA
				if base.a < 1.0 else BaseMaterial3D.TRANSPARENCY_DISABLED)

	match str(data.get("side", "front")):
		"double": made.cull_mode = BaseMaterial3D.CULL_DISABLED
		"back": made.cull_mode = BaseMaterial3D.CULL_FRONT
		_: made.cull_mode = BaseMaterial3D.CULL_BACK

	var loaded = true
	var maps = data.get("maps")

	if maps is Dictionary:
		for slot in maps.keys():
			var value = maps[slot]
			var texture = null

			if value is Dictionary and value.has("texture"):
				texture = runtime.texture_named(value["texture"])
				if texture == null:
					loaded = false
			elif value is String:
				texture = runtime.load_asset(value)

			if texture == null:
				continue

			match slot:
				"base": made.albedo_texture = texture
				"normal":
					made.normal_enabled = true
					made.normal_texture = texture
				"emissive":
					made.emission_enabled = true
					made.emission_texture = texture
				"occlusion":
					made.ao_enabled = true
					made.ao_texture = texture

	if data.get("tiling") is Array:
		var tiling: Array = data["tiling"]
		made.uv1_scale = Vector3(float(tiling[0]), float(tiling[1]), 1.0)

	if data.get("region") is Array:
		var region: Array = data["region"]
		made.uv1_offset = Vector3(float(region[0]), float(region[1]), 0.0)
		made.uv1_scale = Vector3(float(region[2]), float(region[3]), 1.0)

	runtime.set_state(instance["record"], {"loaded": loaded})


func _mesh(runtime, instance: Dictionary) -> Dictionary:
	var data: Dictionary = instance["data"]
	var element: Dictionary = instance["record"]["element"]
	var parent = runtime.node_for(instance["entity"])
	var shape = data.get("shape")

	var object = {"node": null, "shape": shape, "loaded": false}

	## Terrain. The heights arrive as an image or as numbers, and both build
	## the same surface.
	if shape == "heightmap":
		var built = _heightmap(runtime, instance)

		if built != null:
			var terrain = MeshInstance3D.new()
			terrain.name = "mesh"
			terrain.mesh = built
			parent.add_child(terrain)
			object["node"] = terrain
			object["loaded"] = true
			runtime.set_state(instance["record"], {"loaded": true})
		else:
			runtime.set_state(instance["record"], {
				"loaded": false, "error": "heightmap has no usable heights"
			})

		return object

	## A loaded model.
	if element.get("source") != null:
		for source in runtime.sources_of(element):
			var scene = runtime.load_asset(source)

			if scene is PackedScene:
				var loaded = scene.instantiate()
				loaded.name = "mesh"
				parent.add_child(loaded)

				object["node"] = loaded
				object["loaded"] = true

				runtime.set_state(instance["record"], {
					"loaded": true,
					"clips": runtime.clips_of(loaded),
					"source": source
				})

				return object

		runtime.set_state(instance["record"], {
			"loaded": false, "error": "all sources failed"
		})

		return object

	## Manual geometry, given in the content field.
	if element.get("content") != null and shape == null:
		var custom = _manual(element["content"])

		if custom != null:
			var surface = MeshInstance3D.new()
			surface.name = "mesh"
			surface.mesh = custom
			parent.add_child(surface)
			object["node"] = surface
			object["loaded"] = true
			object["shape"] = "convex"
			runtime.set_state(instance["record"], {"loaded": true})
			return object

	## A parametric primitive.
	var size = dimensions(data)
	var segments = 16

	if data.get("segments") is Array:
		segments = int(data["segments"][0])
	elif data.get("segments") != null:
		segments = int(data["segments"])

	var made_mesh: Mesh = null

	match str(shape if shape != null else "box"):
		"box":
			var box = BoxMesh.new()
			box.size = size
			made_mesh = box
		"sphere":
			var ball = SphereMesh.new()
			ball.radius = size.x / 2.0
			ball.height = size.y
			ball.radial_segments = segments
			ball.rings = int(segments / 2.0)
			made_mesh = ball
		"plane", "ground":
			var flat = PlaneMesh.new()
			flat.size = Vector2(size.x, size.z if size.z > 0.0 else size.y)
			flat.orientation = (PlaneMesh.FACE_Z if shape == "plane"
				else PlaneMesh.FACE_Y)
			made_mesh = flat
		"cylinder":
			var tube = CylinderMesh.new()
			tube.top_radius = size.x / 2.0
			tube.bottom_radius = size.x / 2.0
			tube.height = size.y
			tube.radial_segments = segments
			made_mesh = tube
		"capsule":
			var pill = CapsuleMesh.new()
			pill.radius = size.x / 2.0
			pill.height = size.y
			pill.radial_segments = segments
			made_mesh = pill
		"torus":
			var ring = TorusMesh.new()
			ring.inner_radius = maxf(0.01, (size.x - size.y) / 2.0)
			ring.outer_radius = size.x / 2.0
			made_mesh = ring
		_:
			runtime.report("mesh", "create", "unknown shape: " + str(shape))
			runtime.set_state(instance["record"], {
				"loaded": false, "error": "unknown shape: " + str(shape)
			})
			return object

	var holder = MeshInstance3D.new()
	holder.name = "mesh"
	holder.mesh = made_mesh

	## One mesh drawn many times. A tiled scene is thousands of copies of a
	## handful of shapes, and a node apiece would be thousands of nodes.
	if data.get("instances") is Array:
		var many: Array = data["instances"]
		var multi = MultiMesh.new()

		multi.transform_format = MultiMesh.TRANSFORM_3D
		multi.mesh = made_mesh
		multi.instance_count = many.size()

		for index in many.size():
			var entry = many[index]
			var where = Transform3D(
				basis_of(entry.get("rotation")).scaled(
					scaling(entry.get("scale", 1.0))
				),
				vector(entry.get("position"))
			)
			multi.set_instance_transform(index, where)

		var drawn = MultiMeshInstance3D.new()
		drawn.name = "mesh"
		drawn.multimesh = multi
		parent.add_child(drawn)

		object["node"] = drawn
		object["multi"] = multi
		object["loaded"] = true

		runtime.set_state(instance["record"], {"loaded": true})

		return object

	parent.add_child(holder)

	object["node"] = holder
	object["loaded"] = true

	runtime.set_state(instance["record"], {"loaded": true})

	return object


func _manual(content) -> Mesh:
	var geometry = content

	if content is String:
		geometry = JSON.parse_string(content)

	if not (geometry is Dictionary) or not (geometry.get("positions") is Array):
		return null

	var points = PackedVector3Array()
	var raw: Array = geometry["positions"]
	var index = 0

	while index + 2 < raw.size():
		points.append(Vector3(
			float(raw[index]), float(raw[index + 1]), float(raw[index + 2])
		))
		index += 3

	var arrays = []
	arrays.resize(Mesh.ARRAY_MAX)
	arrays[Mesh.ARRAY_VERTEX] = points

	if geometry.get("indices") is Array:
		var faces = PackedInt32Array()
		for value in geometry["indices"]:
			faces.append(int(value))
		arrays[Mesh.ARRAY_INDEX] = faces

	if geometry.get("uvs") is Array:
		var coords = PackedVector2Array()
		var uvs: Array = geometry["uvs"]
		var step = 0
		while step + 1 < uvs.size():
			coords.append(Vector2(float(uvs[step]), float(uvs[step + 1])))
			step += 2
		arrays[Mesh.ARRAY_TEX_UV] = coords

	var made = ArrayMesh.new()
	made.add_surface_from_arrays(Mesh.PRIMITIVE_TRIANGLES, arrays)

	return made


## Columns run along +X and rows along -Z, matching the way an image heightmap
## is sampled, so both forms describe the same terrain. Numbers are used at the
## precision given rather than being crushed into eight bits.
func _heightmap(runtime, instance: Dictionary) -> Mesh:
	var data: Dictionary = instance["data"]
	var element: Dictionary = instance["record"]["element"]

	var heights = []
	var width = 0
	var depth = 0

	var content = element.get("content")

	if content is String:
		var parsed = JSON.parse_string(content)

		if parsed is Dictionary and parsed.get("heights") is Array:
			heights = parsed["heights"]
			width = int(parsed["resolution"][0])
			depth = int(parsed["resolution"][1])

	if heights.is_empty() and element.get("source") != null:
		for source in runtime.sources_of(element):
			var image = runtime.load_image(source)

			if image == null:
				continue

			width = image.get_width()
			depth = image.get_height()

			for row in depth:
				for column in width:
					heights.append(image.get_pixel(column, row).r)

			break

	if heights.is_empty():
		return null

	var size = dimensions(data)
	var steps: int = maxi(1, int(data.get("segments", 100)))

	var low = 0.0
	var high = size.y

	if data.get("elevation") is Array:
		low = float(data["elevation"][0])
		high = float(data["elevation"][1])

	var span = size.z if size.z > 0.0 else size.x

	var points = PackedVector3Array()
	var coords = PackedVector2Array()
	var faces = PackedInt32Array()

	for row in steps + 1:
		for column in steps + 1:
			var u = float(column) / float(steps)
			var v = float(row) / float(steps)

			var sx: int = clampi(int(u * (width - 1)), 0, width - 1)
			var sy: int = clampi(int(v * (depth - 1)), 0, depth - 1)

			var height: float = low + (high - low) * float(
				heights[sy * width + sx]
			)

			points.append(Vector3(
				(u - 0.5) * size.x, height, span / 2.0 - v * span
			))

			coords.append(Vector2(u, 1.0 - v))

	for row in steps:
		for column in steps:
			var a = row * (steps + 1) + column
			var b = a + 1
			var c = a + steps + 1
			var d = c + 1

			faces.append(a)
			faces.append(b)
			faces.append(c)
			faces.append(b)
			faces.append(d)
			faces.append(c)

	var arrays = []
	arrays.resize(Mesh.ARRAY_MAX)
	arrays[Mesh.ARRAY_VERTEX] = points
	arrays[Mesh.ARRAY_TEX_UV] = coords
	arrays[Mesh.ARRAY_INDEX] = faces

	var made = ArrayMesh.new()
	made.add_surface_from_arrays(Mesh.PRIMITIVE_TRIANGLES, arrays)

	return made


func _text(runtime, instance: Dictionary) -> Dictionary:
	var data: Dictionary = instance["data"]
	var element: Dictionary = instance["record"]["element"]

	var label = Label3D.new()

	label.name = "text"
	label.text = str(element.get("content", ""))
	label.font_size = 64
	label.pixel_size = float(data.get("size", 1.0)) / 64.0
	label.modulate = colour(data.get("color"), Color(1, 1, 1, 1))
	label.billboard = (BaseMaterial3D.BILLBOARD_ENABLED
		if data.get("billboard") not in [null, "none"]
		else BaseMaterial3D.BILLBOARD_DISABLED)

	match str(data.get("align", "left")):
		"center": label.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
		"right": label.horizontal_alignment = HORIZONTAL_ALIGNMENT_RIGHT
		_: label.horizontal_alignment = HORIZONTAL_ALIGNMENT_LEFT

	if data.get("width") != null:
		label.width = float(data["width"]) / label.pixel_size
		label.autowrap_mode = TextServer.AUTOWRAP_WORD

	label.no_depth_test = true

	runtime.node_for(instance["entity"]).add_child(label)

	runtime.set_state(instance["record"], {"loaded": true})

	return {"label": label}


func _collider(runtime, instance: Dictionary) -> Dictionary:
	var data: Dictionary = instance["data"]
	var shape = str(data.get("shape", "auto"))
	var size = dimensions(data)

	if shape == "auto":
		var found = runtime.sibling(instance["entityKey"], "mesh")

		if found != null:
			shape = str(found["object"].get("shape", "box"))

			var mesh_data: Dictionary = found["data"]

			if mesh_data.get("size") != null:
				size = dimensions(mesh_data)

		if shape in [null, "", "auto"]:
			shape = "box"

	var made: Shape3D

	match shape:
		"sphere":
			var ball = SphereShape3D.new()
			ball.radius = size.x / 2.0
			made = ball
		"capsule":
			var pill = CapsuleShape3D.new()
			pill.radius = size.x / 2.0
			pill.height = size.y
			made = pill
		"cylinder":
			var tube = CylinderShape3D.new()
			tube.radius = size.x / 2.0
			tube.height = size.y
			made = tube
		"heightmap", "mesh", "convex":
			var owner = runtime.sibling(instance["entityKey"], "mesh")
			var source: Node = null

			if owner != null:
				source = owner["object"].get("node")

			if source is MeshInstance3D and source.mesh != null:
				made = source.mesh.create_trimesh_shape()
			else:
				var fallback = BoxShape3D.new()
				fallback.size = size
				made = fallback
		_:
			var box = BoxShape3D.new()
			box.size = size
			made = box

	var holder = CollisionShape3D.new()
	holder.name = "collider"
	holder.shape = made
	holder.position = vector(data.get("offset"))

	runtime.body_for(instance["entityKey"]).add_child(holder)

	runtime.set_state(instance["record"], {"contacts": []})

	return {"shape": holder}


func _body(runtime, instance: Dictionary) -> Dictionary:
	var data: Dictionary = instance["data"]
	var body = runtime.body_for(instance["entityKey"], data)

	if body is RigidBody3D:
		body.mass = float(data.get("mass", 1.0))
		body.can_sleep = data.get("sleep") != false

		var freeze = data.get("freeze")

		if freeze is Dictionary and freeze.get("rotation") is Array:
			var locked: Array = freeze["rotation"]

			body.axis_lock_angular_x = locked.size() > 0 and locked[0] == true
			body.axis_lock_angular_y = locked.size() > 1 and locked[1] == true
			body.axis_lock_angular_z = locked.size() > 2 and locked[2] == true

		if data.get("gravity") != null:
			body.gravity_scale = float(data["gravity"])

	return {"body": body}


func _audio(runtime, instance: Dictionary) -> Dictionary:
	var data: Dictionary = instance["data"]
	var element: Dictionary = instance["record"]["element"]

	var player: Node

	if data.get("spatial") == true:
		player = AudioStreamPlayer3D.new()
	else:
		player = AudioStreamPlayer.new()

	player.name = "audio"

	var stream = null

	for source in runtime.sources_of(element):
		stream = runtime.load_asset(source)
		if stream != null:
			break

	if stream == null:
		runtime.set_state(instance["record"], {
			"loaded": false, "playing": false, "error": "all sources failed"
		})
		return {"player": null}

	player.stream = stream
	player.volume_db = linear_to_db(maxf(0.0001, float(data.get("volume", 1.0))))

	runtime.node_for(instance["entity"]).add_child(player)

	if data.get("loop") == true and stream is AudioStream:
		if "loop" in stream:
			stream.loop = true

	if data.get("autoplay") == true:
		player.play()

	runtime.set_state(instance["record"], {"loaded": true, "playing": false})

	return {"player": player}


func _animation(runtime, instance: Dictionary) -> Dictionary:
	var found = runtime.sibling(instance["entityKey"], "mesh")
	var player: AnimationPlayer = null

	if found != null and found["object"].get("node") != null:
		player = runtime.find_player(found["object"]["node"])

	return {"player": player, "clip": null}


# ------------------------------------------------------------------- destroy

func destroy(_runtime, type: String, instance: Dictionary) -> void:
	var object = instance.get("object")

	if not (object is Dictionary):
		return

	for key in ["environment", "camera", "light", "node", "label", "shape",
			"player"]:
		var node = object.get(key)

		if node is Node and is_instance_valid(node):
			node.queue_free()

	if type == "material" and object.get("material") != null:
		object["material"] = null
