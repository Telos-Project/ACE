## The ACE runtime.
##
## Attached to the root of the exported scene. Loads the document, runs a frame
## in the order the standard sets out, and reconciles what the document says
## against the nodes that exist.
extends Node3D

const AceDocument = preload("res://addons/ace/ace_document.gd")
const AceOperators = preload("res://addons/ace/ace_operators.gd")
const AceScripts = preload("res://addons/ace/ace_scripts.gd")

@export var document_path: String = "res://document.json"
@export var manifest_path: String = "res://assets/manifest.json"

## Set to an entity's path — `avatar`, or `player.head` — to have what the
## document is being told about it printed twice a second. Two rounds of this
## port were spent guessing at a value nobody could see; this is cheaper.
@export var trace: String = ""

var data: Dictionary = {}
var resolved: Dictionary = {"components": [], "entities": [], "errors": []}
var instances: Dictionary = {}
var state: Dictionary = {}
var errors: Array = []
var frame: int = 0

var nodes: Dictionary = {}
var bodies: Dictionary = {}
var applied: Dictionary = {}
var manifest: Dictionary = {}
var cache: Dictionary = {}

var physics_on: bool = false
var step: float = 1.0 / 60.0
var elapsed: float = 0.0
var time_scale: float = 1.0

## Built in _ready rather than here. A class scope initialiser that reaches
## into another script is the one that has kept failing, and when one of them
## fails the rest never run: every member declared after it is left null.
var _doc = null
var _ops = null
var _scripts = null

var _camera_claimed: bool = false
var _ambient: Color = Color(0, 0, 0)
var _ambient_energy: float = 0.0
var _xr_interface: XRInterface = null
var _xr_presenting: bool = false
var _xr_requested: Dictionary = {}
var _gesture: bool = false
var _said: Dictionary = {}
var _spaces: Dictionary = {}
var _pressed: Dictionary = {}
var _released: Dictionary = {}
var _previous_keys: Dictionary = {}
var _pointer: Dictionary = {"x": 0.5, "y": 0.5, "dx": 0.0, "dy": 0.0, "wheel": 0.0}
var _pointer_buttons: Array = []


func _ready() -> void:
	_doc = AceDocument.new()
	_ops = AceOperators.new()
	_scripts = AceScripts.new()

	var file = FileAccess.open(manifest_path, FileAccess.READ)

	if file != null:
		var listed = JSON.parse_string(file.get_as_text())
		if listed is Dictionary:
			manifest = listed

	var doc = FileAccess.open(document_path, FileAccess.READ)

	if doc == null:
		push_error("ACE: could not open " + document_path)
		return

	var parsed = JSON.parse_string(doc.get_as_text())

	if not (parsed is Dictionary):
		push_error("ACE: " + document_path + " is not a document")
		return

	data = parsed

	set_process(true)
	set_process_input(true)


func _input(event: InputEvent) -> void:
	if event is InputEventKey and event.pressed:
		_gesture = true

	if event is InputEventMouseButton:
		_gesture = true

		var name = "button" + str(event.button_index - 1)

		if event.pressed:
			if not (name in _pointer_buttons):
				_pointer_buttons.append(name)
		else:
			_pointer_buttons.erase(name)

	if event is InputEventMouseMotion:
		var size = get_viewport().get_visible_rect().size

		_pointer["dx"] += event.relative.x / maxf(1.0, size.x)
		_pointer["dy"] -= event.relative.y / maxf(1.0, size.y)
		_pointer["x"] = event.position.x / maxf(1.0, size.x)
		_pointer["y"] = 1.0 - event.position.y / maxf(1.0, size.y)


func _process(delta: float) -> void:
	if data.is_empty():
		return

	errors = []
	frame += 1

	_sync(delta)

	resolved = _doc.collect(data)

	if frame == 1:
		_run_scripts("start")

	_run_scripts("update")

	_reconcile()
	_consume()
	_reflect()
	_update()
	_flush()

	for problem in resolved["errors"]:
		errors.append({
			"type": "document", "hook": "collect",
			"message": problem["message"]
		})

	_announce()
	_trace()

	_pointer["dx"] = 0.0
	_pointer["dy"] = 0.0
	_pointer["wheel"] = 0.0
	_pressed = {}
	_released = {}


## Comparisons kept as methods rather than as lambdas: a lambda body is
## indentation sensitive in a way that is easy to get wrong and hard to see.
func _by_rank(a, b) -> bool:
	if a["rank"] != b["rank"]:
		return a["rank"] < b["rank"]

	return str(a["id"]) < str(b["id"])


func _by_distance(a, b) -> bool:
	return a["distance"] < b["distance"]


func report(type: String, hook: String, message: String) -> void:
	errors.append({"type": type, "hook": hook, "message": message})


## Everything the frame went wrong with, said once each.
##
## The browser adapter has a page to put these on and this has nothing, so
## until now a document could fail in every component it had and look merely
## odd. A fault that is not reported is one somebody has to guess at from the
## outside, which is the most expensive kind there is.
func _trace() -> void:
	if trace == "" or frame % 30 != 0:
		return

	var wanted = _doc.path_key(Array(trace.split(".")))

	for record in resolved["entities"]:
		if record["key"] != wanted:
			continue

		var held = state.get(_doc.identity(record))
		var body = bodies.get(record["key"])

		print("[ace ", trace, "] state ", held,
			"  velocity ", body.linear_velocity if body is RigidBody3D else "-",
			"  data ", record["data"])

	for record in resolved["components"]:
		if record["entityKey"] != wanted:
			continue

		print("  [ace ", ".".join(record["path"]), "] ", record["type"],
			" state ", state.get(_doc.identity(record)))


func _announce() -> void:
	for problem in errors:
		var line = ("ACE: " + str(problem["type"]) + "." + str(problem["hook"])
			+ ": " + str(problem["message"]))

		if _said.has(line):
			continue

		_said[line] = true

		push_warning(line)

	## A script that fails says so in its own state, where nothing reads it.
	for record in resolved["components"]:
		if record["type"] != "script" or record["reserved"] == true:
			continue

		var held = state.get(_doc.identity(record))

		if not (held is Dictionary) or held.get("error") == null:
			continue

		var failure = ("ACE: the script at " + ".".join(record["path"])
			+ " failed: " + str(held["error"]))

		if _said.has(failure):
			continue

		_said[failure] = true

		push_error(failure)


# ------------------------------------------------------------------- assets

## A source is looked up in the manifest the exporter wrote, which maps the
## location a document names to the file that was fetched for it.
func resolve_asset(source: String) -> String:
	if manifest.has(source):
		return str(manifest[source])

	if source.begins_with("res://"):
		return source

	return ""


func sources_of(element: Dictionary) -> Array:
	var source = element.get("source")

	if source is String:
		return [source]

	if source is Array:
		var list = []
		for entry in source:
			if entry is String:
				list.append(entry)
		return list

	return []


func load_asset(source: String) -> Variant:
	if cache.has(source):
		return cache[source]

	var path = resolve_asset(source)

	## Said out loud. A model or a texture that quietly fails to load leaves a
	## scene that looks wrong for no stated reason, which is the hardest kind
	## of fault to work back from.
	if path == "":
		cache[source] = null

		push_warning("ACE: nothing was fetched for " + source
			+ " — the export could not reach it, so it is not in assets/")

		return null

	## Read from the file rather than through the import pipeline. Godot only
	## imports what was on disk when the project was last opened in the editor,
	## and a project that has just been written has not been opened at all, so
	## everything the exporter fetched would be missing on the first run.
	var found = _read(path)

	if found == null and ResourceLoader.exists(path):
		found = ResourceLoader.load(path)

	if found == null:
		push_warning("ACE: could not read " + path + ", fetched for " + source
			+ ". The format may not be one Godot reads.")

	cache[source] = found

	return found


func _read(path: String) -> Variant:
	if not FileAccess.file_exists(path):
		return null

	match path.get_extension().to_lower():

		"glb", "gltf":
			var document = GLTFDocument.new()
			var held = GLTFState.new()

			if document.append_from_file(path, held) != OK:
				return null

			## Kept as a template and copied wherever it is used, since one
			## location may be named by several meshes.
			return document.generate_scene(held)

		"png", "jpg", "jpeg", "webp", "bmp", "tga", "svg":
			var image = Image.new()

			if image.load(path) != OK:
				return null

			return ImageTexture.create_from_image(image)

		"mp3":
			var file = FileAccess.open(path, FileAccess.READ)

			if file == null:
				return null

			var sound = AudioStreamMP3.new()
			sound.data = file.get_buffer(file.get_length())

			return sound

		"ogg":
			return AudioStreamOggVorbis.load_from_file(path)

	return null


func load_image(source: String) -> Image:
	var found = load_asset(source)

	if found is Texture2D:
		return found.get_image()

	return null


## True once every texture the document declares has been built, so that
## something waiting on one knows when to stop waiting.
func textures_settled() -> bool:
	for record in resolved["components"]:
		if record["type"] != "texture":
			continue

		if not instances.has(_doc.identity(record)):
			return false

	return true


func texture_named(reference) -> Texture2D:
	var element = _doc.get_element(data, reference)

	if element.is_empty():
		return null

	var key = _doc.path_key(element["path"])

	for id in instances.keys():
		var instance = instances[id]

		if instance["key"] == key and instance["type"] == "texture":
			return instance["object"].get("texture")

	return null


func clips_of(node: Node) -> Array:
	var player = find_player(node)

	if player == null:
		return []

	return Array(player.get_animation_list())


func find_player(node: Node) -> AnimationPlayer:
	if node is AnimationPlayer:
		return node

	for child in node.get_children():
		var found = find_player(child)
		if found != null:
			return found

	return null


# -------------------------------------------------------------------- nodes

## Entities are packages, so their nodes are built lazily by whichever
## component needs one first, and placed at once: a body built in the same
## frame is made from this transform.
func node_for(path: Array) -> Node3D:
	var key = _doc.path_key(path)

	if nodes.has(key) and is_instance_valid(nodes[key]):
		return nodes[key]

	var made = Node3D.new()
	made.name = str(path[path.size() - 1]) if path.size() > 0 else "root"

	nodes[key] = made

	if path.size() > 1:
		node_for(path.slice(0, path.size() - 1)).add_child(made)
	else:
		add_child(made)

	for record in resolved["entities"]:
		if record["key"] == key:
			_place(made, record["data"])
			break

	return made


## Which transform an entity's own is measured against.
##
## The default is the package it sits in, and a document says otherwise when it
## wants something to ride the view rather than stand in the world: a readout
## that hangs in front of the eyes belongs to the camera, wherever the camera
## has got to. Without this such a thing sits at the origin of the world, far
## away and facing nowhere, which is exactly how it looks.
func _rehome(record: Dictionary, node: Node3D, data: Dictionary) -> void:
	var wanted = str(data.get("space", "parent"))

	if _spaces.get(record["key"]) == wanted:
		return

	var host = null

	if wanted == "camera" or wanted == "screen":
		host = _view_node()

	elif wanted == "world":
		host = self

	elif wanted == "parent":
		host = (node_for(record["path"].slice(0, record["path"].size() - 1))
			if record["path"].size() > 1 else self)

	if host == null:
		## The camera may not be built yet; ask again next frame.
		return

	_spaces[record["key"]] = wanted

	if node.get_parent() == host:
		return

	if node.get_parent() != null:
		node.get_parent().remove_child(node)

	host.add_child(node)


## The entity the active camera belongs to, which is what a camera space is
## measured against: the camera itself carries no transform of the document's.
func _view_node() -> Node3D:
	for id in instances.keys():
		var instance = instances[id]

		if instance["type"] != "camera":
			continue

		var camera = instance["object"].get("camera")

		if camera != null and camera.current:
			return nodes.get(instance["entityKey"])

	return null


func _place(node: Node3D, data: Dictionary) -> void:
	if data.get("position") is Array:
		node.position = _ops.vector(data["position"])

	if data.get("rotation") != null:
		node.basis = _ops.basis_of(data["rotation"])

	if data.get("scale") != null:
		node.scale = _ops.scaling(data["scale"])


## A collider needs something to hang from. An entity with a body component
## gets one of the right kind; an entity with only colliders gets a static one.
func body_for(entity_key: String, body_data = null) -> Node3D:
	if bodies.has(entity_key) and is_instance_valid(bodies[entity_key]):
		return bodies[entity_key]

	var path: Array = JSON.parse_string(entity_key)
	var parent = node_for(path)

	var mode = "static"

	if body_data is Dictionary:
		mode = str(body_data.get("mode", "dynamic"))
	else:
		for record in resolved["components"]:
			if record["type"] == "body" and record["entityKey"] == entity_key:
				mode = str(record["data"].get("mode", "dynamic"))
				break

	var made: Node3D

	match mode:
		"dynamic":
			made = RigidBody3D.new()
		"kinematic":
			made = CharacterBody3D.new()
		_:
			made = StaticBody3D.new()

	made.name = "body"

	if made is RigidBody3D:
		## A simulated body stands in the world rather than under the entity it
		## belongs to. Hung beneath it, the solver would move the body while the
		## entity stayed where it was put, and the document would be told its
		## subject had not moved: a scene that cannot be walked at all. The
		## entity follows the body instead, in _reflect.
		add_child(made)
		made.global_transform = parent.global_transform

	else:
		parent.add_child(made)

	bodies[entity_key] = made

	return made


func sibling(entity_key: String, type: String) -> Variant:
	for id in instances.keys():
		var instance = instances[id]

		if instance["entityKey"] == entity_key and instance["type"] == type:
			return instance

	return null


func claim_camera() -> bool:
	if _camera_claimed:
		return false

	_camera_claimed = true

	return true


func ambient(tint: Color, energy: float) -> void:
	_ambient = tint
	_ambient_energy = energy

	for child in get_children():
		if child is WorldEnvironment and child.environment != null:
			child.environment.ambient_light_color = tint
			child.environment.ambient_light_energy = energy


# --------------------------------------------------------------------- state

func set_state(record: Dictionary, values: Dictionary) -> void:
	var id = _doc.identity(record)

	if not state.has(id):
		state[id] = {}

	for key in values.keys():
		state[id][key] = values[key]


func clear_state(id: String) -> void:
	state.erase(id)


func _flush() -> void:
	for record in resolved["entities"]:
		_write(record, true)

	for record in resolved["components"]:
		_write(record, false)


func _write(record: Dictionary, is_entity: bool) -> void:
	if record.get("reserved") == true:
		return

	var id = _doc.identity(record)
	var element: Dictionary = record["element"]
	var held = state.get(id)

	if not (element.get("properties") is Dictionary):
		element["properties"] = {}

	if is_entity:
		if not (element["properties"].get("meta") is Dictionary):
			element["properties"]["meta"] = {}

		if held == null:
			element["properties"]["meta"].erase("state")
		else:
			element["properties"]["meta"]["state"] = held

		return

	if held == null:
		element["properties"].erase("state")
	else:
		element["properties"]["state"] = held


# --------------------------------------------------------------- consumables

func _consume() -> void:
	for record in resolved["components"]:
		var fields = _doc.CONSUMABLE.get(record["type"])

		if fields is Array:
			_fire(record, fields, record["data"], record)

	## Entity transform fields are consumable only where the entity carries a
	## dynamic body; otherwise they are authored state and must persist.
	for record in resolved["entities"]:
		var body = null

		for candidate in resolved["components"]:
			if (candidate["type"] == "body"
					and candidate["entityKey"] == record["key"]):
				body = candidate
				break

		if body == null:
			continue

		if str(body["data"].get("mode", "dynamic")) != "dynamic":
			continue

		_fire(record, _doc.CONSUMABLE[""], record["data"], body)


func _fire(record: Dictionary, fields: Array, holder: Dictionary,
		owner: Dictionary) -> void:

	for field in fields:
		if not holder.has(field):
			continue

		var value = holder[field]
		var id = _doc.identity(owner)
		var instance = instances.get(id)

		if instance != null:
			_apply_consumable(instance, field, value)

		holder.erase(field)

		if owner == record and instance != null:
			instance["data"].erase(field)


func _apply_consumable(instance: Dictionary, field: String, value) -> void:
	var object = instance.get("object")

	if not (object is Dictionary):
		return

	match instance["type"]:
		"body":
			var body = bodies.get(instance["entityKey"])

			if not (body is RigidBody3D):
				return

			match field:
				"impulse":
					body.apply_central_impulse(_ops.vector(value))
				"torque":
					body.apply_torque_impulse(_ops.vector(value))
				"teleport", "position":
					if value is Dictionary:
						body.global_position = _ops.vector(
							value.get("position"))
					else:
						body.global_position = _ops.vector(value)

					body.linear_velocity = Vector3.ZERO
					body.angular_velocity = Vector3.ZERO
				"rotation":
					body.global_basis = _ops.basis_of(value)

		"audio":
			var player = object.get("player")

			if player == null:
				return

			match field:
				"play": player.play()
				"stop": player.stop()
				"seek": player.seek(float(value))

		"animation":
			var motion: AnimationPlayer = object.get("player")

			if motion == null:
				return

			match field:
				"play":
					var clip = instance["data"].get("clip")
					if clip != null and motion.has_animation(str(clip)):
						motion.play(str(clip))
				"stop": motion.stop()
				"seek": motion.seek(float(value))


# ---------------------------------------------------------------- reconciler

func _reconcile() -> void:
	var present = {}
	var order = _ops.table()

	for record in resolved["components"]:
		if record["reserved"] == true or record["type"] == "script":
			continue

		present[_doc.identity(record)] = record

	for id in instances.keys().duplicate():
		if present.has(id):
			continue

		var going = instances[id]

		_ops.destroy(self, going["type"], going)

		instances.erase(id)
		clear_state(id)

	var ranked = []

	for id in present.keys():
		var kind = present[id]["type"]
		var rank = 0

		if order.has(kind):
			rank = int(order[kind].get("order", 0))

		ranked.append({"rank": rank, "id": id})

	ranked.sort_custom(_by_rank)

	var pending = []

	for entry in ranked:
		pending.append(entry["id"])

	for id in pending:
		if instances.has(id):
			continue

		var wanted: Dictionary = present[id]

		var built = {
			"id": id,
			"type": wanted["type"],
			"path": wanted["path"],
			"key": wanted["key"],
			"entity": wanted["entity"],
			"entityKey": wanted["entityKey"],
			"record": wanted,
			"data": wanted["data"].duplicate(true),
			"source": wanted["element"].get("source"),
			"content": wanted["element"].get("content"),
			"object": null
		}

		var object = _ops.create(self, wanted["type"], built)

		if object == null:
			continue

		built["object"] = object
		instances[id] = built

	## Change is compared against data, source and content, and never against
	## state, which is what makes it safe for the engine to write into the
	## document every frame.
	for id in instances.keys():
		if not present.has(id):
			continue

		var living = instances[id]
		var current: Dictionary = present[id]

		living["record"] = current

		var changed = (
			JSON.stringify(current["data"]) != JSON.stringify(living["data"])
			or JSON.stringify(current["element"].get("source"))
				!= JSON.stringify(living["source"])
			or current["element"].get("content") != living["content"]
		)

		if not changed:
			continue

		var previous = {
			"data": living["data"],
			"source": living["source"],
			"content": living["content"]
		}

		living["data"] = current["data"].duplicate(true)
		living["source"] = current["element"].get("source")
		living["content"] = current["element"].get("content")

		_change(living, previous)


func _change(instance: Dictionary, _previous: Dictionary) -> void:
	match instance["type"]:
		"material":
			_ops.apply_material(self, instance, instance["object"])
		"text":
			var label = instance["object"].get("label")
			if label != null:
				label.text = str(instance["content"])
				label.modulate = _ops.colour(
					instance["data"].get("color"), Color(1, 1, 1, 1))
		"animation":
			_ops.apply_clip(self, instance, instance["object"])
		"mesh":
			## Instance lists change constantly in a tiled scene; the rest is a
			## rebuild.
			var object: Dictionary = instance["object"]

			if object.get("multi") != null and instance["data"].get("instances") is Array:
				var many: Array = instance["data"]["instances"]
				var multi: MultiMesh = object["multi"]

				multi.instance_count = many.size()

				for index in many.size():
					var entry = many[index]
					multi.set_instance_transform(index, Transform3D(
						_ops.basis_of(entry.get("rotation")).scaled(
							_ops.scaling(entry.get("scale", 1.0))),
						_ops.vector(entry.get("position"))
					))
			else:
				_ops.destroy(self, "mesh", instance)
				instance["object"] = _ops.create(self, "mesh", instance)
		_:
			pass


func _update() -> void:
	for id in instances.keys():
		var instance = instances[id]

		match instance["type"]:
			"world": _ops.bind_sky(self, instance, instance["object"])
			"mesh": _ops.bind_material(self, instance, instance["object"])
			"body": _update_body(instance)
			"query": _update_query(instance)
			"audio":
				var player = instance["object"].get("player")
				if player != null:
					set_state(instance["record"], {
						"playing": player.playing
					})
			"animation":
				var motion: AnimationPlayer = instance["object"].get("player")

				if motion == null:
					## A model that loaded after the component was built.
					instance["object"]["player"] = _rebind(instance)

					_ops.apply_clip(self, instance, instance["object"])

					continue

				set_state(instance["record"], {
					"playing": motion.is_playing(),
					"time": motion.current_animation_position,
					"duration": motion.current_animation_length
				})


func _rebind(instance: Dictionary) -> AnimationPlayer:
	var found = sibling(instance["entityKey"], "mesh")

	if found == null or found["object"].get("node") == null:
		return null

	return find_player(found["object"]["node"])


## What the simulation produced is read first. Reporting after the command is
## applied would hand a document back its own request, so gravity would never
## be seen and a body told to rise once would rise for ever.
func _update_body(instance: Dictionary) -> void:
	var body = bodies.get(instance["entityKey"])

	if not (body is RigidBody3D):
		return

	set_state(instance["record"], {
		"velocity": [body.linear_velocity.x, body.linear_velocity.y,
			body.linear_velocity.z],
		"angular": [body.angular_velocity.x, body.angular_velocity.y,
			body.angular_velocity.z],
		"sleeping": body.sleeping,
		"grounded": false
	})

	## The command itself is applied on the simulation's own clock, in
	## _physics_process, and not here. See the note there.


## A standing instruction to the simulation belongs on the simulation's clock.
##
## Writing a velocity from the drawing frame sets the body's state, and a state
## written between one step and the next lands at the start of the following
## one — on top of the velocity that step had just integrated. Reading the
## vertical and handing it straight back therefore undoes exactly the gravity
## that had been applied to it, and a body told once to rise rises for ever at
## the speed it started with. Read in the drawing frame, applied here.
func _physics_process(_delta: float) -> void:
	if data.is_empty():
		return

	for id in instances.keys():
		var instance = instances[id]

		if instance["type"] != "body":
			continue

		var body = bodies.get(instance["entityKey"])

		if not (body is RigidBody3D):
			continue

		var asked = instance["data"].get("velocity")

		if not (asked is Array):
			continue

		var live = body.linear_velocity

		## A component given as null is left to the simulation.
		body.linear_velocity = Vector3(
			float(asked[0]) if asked.size() > 0 and asked[0] != null else live.x,
			float(asked[1]) if asked.size() > 1 and asked[1] != null else live.y,
			float(asked[2]) if asked.size() > 2 and asked[2] != null else live.z
		)


func _update_query(instance: Dictionary) -> void:
	var data: Dictionary = instance["data"]

	if data.get("continuous") != true and instance.get("answered") == true:
		return

	instance["answered"] = true

	var space = get_world_3d().direct_space_state
	var kind = str(data.get("type", "ray"))
	var limit = int(data.get("limit", 1))
	var wanted = data.get("tags")

	var hits = []

	var origin = _ops.vector(data.get("origin"))

	if not (data.get("origin") is Array):
		var node = nodes.get(instance["entityKey"])
		if node != null:
			origin = node.global_position

	origin += _ops.vector(data.get("offset"))

	if kind == "overlap":
		var radius = 1.0
		var form = data.get("shape")

		if form is Dictionary:
			var size = form.get("size")
			radius = float(size) if (size is float or size is int) else radius
		elif data.get("distance") != null:
			radius = float(data["distance"])

		var ball = SphereShape3D.new()
		ball.radius = radius

		var params = PhysicsShapeQueryParameters3D.new()
		params.shape = ball
		params.transform = Transform3D(Basis(), origin)
		params.collide_with_areas = true

		var mine = bodies.get(instance["entityKey"])

		if mine != null:
			params.exclude = [mine.get_rid()]

		for result in space.intersect_shape(params, 32):
			var found = _describe_collision(result.get("collider"), origin,
				wanted)

			if not found.is_empty():
				hits.append(found)
	else:
		var direction = _ops.vector(data.get("direction"),
			Vector3(0, 0, -1)).normalized()

		var distance = float(data.get("distance", 1000.0))

		var beam = PhysicsRayQueryParameters3D.create(
			origin, origin + direction * distance
		)

		beam.collide_with_areas = true
		beam.collide_with_bodies = true

		## A probe cast from within a subject must not answer with the subject.
		## A ground probe that finds the feet it was cast from reports no
		## ground at all once the answer is filtered by tag.
		var own = bodies.get(instance["entityKey"])

		if own != null:
			beam.exclude = [own.get_rid()]

		var result = space.intersect_ray(beam)

		if not result.is_empty():
			var struck = _describe_ray(result, origin, wanted)

			if not struck.is_empty():
				hits.append(struck)

	hits.sort_custom(_by_distance)

	if limit > 0:
		hits = hits.slice(0, limit)

	set_state(instance["record"], {"hits": hits})


func _owner_of(node) -> Array:
	var current = node

	while current != null:
		var key = current.get_meta("ace_entity", null)

		if key != null:
			return JSON.parse_string(str(key))

		current = current.get_parent()

	return []


func _wanted_here(path: Array, wanted) -> bool:
	if not (wanted is Array) or wanted.is_empty():
		return true

	if path.is_empty():
		return false

	var key = _doc.path_key(path)

	for record in resolved["entities"]:
		if record["key"] != key:
			continue

		for tag in record["tags"]:
			if tag in wanted:
				return true

	return false


func _describe_ray(result: Dictionary, origin: Vector3, wanted) -> Dictionary:
	var path = _owner_of(result.get("collider"))

	if not _wanted_here(path, wanted):
		return {}

	var point: Vector3 = result["position"]
	var normal: Vector3 = result["normal"]

	return {
		"target": path,
		"point": [point.x, point.y, point.z],
		"normal": [normal.x, normal.y, normal.z],
		"distance": origin.distance_to(point)
	}


func _describe_collision(collider, origin: Vector3, wanted) -> Dictionary:
	var path = _owner_of(collider)

	if not _wanted_here(path, wanted):
		return {}

	var where = origin

	if collider is Node3D:
		where = collider.global_position

	var away = origin - where
	var far = away.length()

	var normal = away.normalized() if far > 0.0001 else Vector3.UP

	return {
		"target": path,
		"point": [where.x, where.y, where.z],
		"normal": [normal.x, normal.y, normal.z],
		"distance": far
	}


# ---------------------------------------------------------------- transforms

func _reflect() -> void:
	var live = {}

	for record in resolved["entities"]:
		if record.get("scene") == false:
			continue

		live[record["key"]] = true

		var node = node_for(record["path"])
		var data: Dictionary = record["data"]

		_rehome(record, node, data)

		var body = bodies.get(record["key"])
		var driven = body is RigidBody3D and physics_on

		var signature = JSON.stringify([
			data.get("position"), data.get("rotation"), data.get("scale")
		])

		if driven:
			## A simulated entity owns its own pose. An authored transform is a
			## teleport, taken only when it changes and carried to the body;
			## every other frame the entity follows what the solver did.
			if applied.get(record["key"]) != signature:
				_place(node, data)
				body.global_transform = node.global_transform

			else:
				node.global_transform = body.global_transform

		else:
			_place(node, data)

		applied[record["key"]] = signature

		node.visible = _ops.truth(data.get("enabled"), true)

		## The entity carries its own identity, so that a collision can be
		## attributed however the node has been reparented.
		node.set_meta("ace_entity", record["key"])

		for child in node.get_children():
			if child is Node3D:
				child.set_meta("ace_entity", record["key"])
				for grand in child.get_children():
					if grand is Node3D:
						grand.set_meta("ace_entity", record["key"])

		var world = node.global_position
		var turn = node.global_basis.get_rotation_quaternion()

		set_state(record, {
			"position": [world.x, world.y, world.z],
			"rotation": [turn.x, turn.y, turn.z, turn.w],
			"scale": [node.scale.x, node.scale.y, node.scale.z]
		})

	for key in nodes.keys().duplicate():
		if live.has(key):
			continue

		if is_instance_valid(nodes[key]):
			nodes[key].queue_free()

		nodes.erase(key)
		bodies.erase(key)
		applied.erase(key)
		_spaces.erase(key)
		clear_state(key)


# ------------------------------------------------------------------- scripts

func _run_scripts(phase: String) -> void:
	var due = []

	for record in resolved["components"]:
		if record["type"] != "script" or record["reserved"] == true:
			continue

		if record["data"].get("enabled") == false:
			continue

		if str(record["data"].get("phase", "update")) != phase:
			continue

		due.append(record)

	var ordered = []

	for record in due:
		ordered.append({
			"rank": int(record["data"].get("order", 0)),
			"id": record["key"],
			"record": record
		})

	ordered.sort_custom(_by_rank)

	for entry in ordered:
		var record = entry["record"]
		var id = _doc.identity(record)

		## An earlier script may have removed this one; the schedule was fixed
		## before any of them ran.
		var current = null

		for candidate in resolved["components"]:
			if _doc.identity(candidate) == id and candidate["type"] == "script":
				current = candidate
				break

		if current == null:
			continue

		var outcome = _scripts.run(self, current, data)

		if outcome.get("error") != null:
			set_state(current, {"error": outcome["error"]})
			continue

		set_state(current, {"error": null, "runs": outcome.get("runs", 0)})

		var output = outcome.get("output")

		if output == null or output == "":
			continue

		var parsed = JSON.parse_string(str(output))

		if parsed == null:
			set_state(current, {"error": "output is not valid JSON"})
			continue

		if str(current["data"].get("output", "patch")) == "override":
			data = parsed
		else:
			_doc.merge(data, parsed)

		resolved = _doc.collect(data)


# ------------------------------------------------------------ reserved entity

func xr_modes() -> Array:
	return ["vr"] if _xr_interface != null else []


func xr_presenting() -> bool:
	return _xr_presenting


func request_xr(_camera: Camera3D, wanted: Dictionary, instance: Dictionary) -> void:
	var key = _doc.identity(instance["record"])

	if _xr_requested.has(key):
		return

	_xr_requested[key] = true

	var mode = str(wanted.get("mode", "vr"))
	var name = "OpenXR" if mode == "vr" else "WebXR"

	var found = XRServer.find_interface(name)

	if found == null:
		found = XRServer.find_interface("OpenXR")

	if found == null or not found.is_initialized():
		if found != null and found.initialize():
			pass
		else:
			report("camera", "requestXR",
				"no immersive runtime is available")
			return

	_xr_interface = found
	_xr_presenting = true

	get_viewport().use_xr = true

	DisplayServer.window_set_vsync_mode(DisplayServer.VSYNC_DISABLED)

	set_state(instance["record"], {
		"supported": [mode], "presenting": true
	})


func _sync(delta: float) -> void:
	var reserved = data.get("packages", {}).get(_doc.RESERVED)

	var time_data = {}
	var display_data = {}

	if reserved is Dictionary and reserved.get("utilities") is Dictionary:
		var held = reserved["utilities"]

		if held.get("time") is Dictionary:
			var props = held["time"].get("properties", {})
			if props.get("data") is Dictionary:
				time_data = props["data"]

		if held.get("display") is Dictionary:
			var shown = held["display"].get("properties", {})
			if shown.get("data") is Dictionary:
				display_data = shown["data"]

	time_scale = float(time_data.get("scale", 1.0))

	var unscaled: float = minf(delta, 0.25)

	elapsed += unscaled * time_scale

	var size = get_viewport().get_visible_rect().size

	var controllers = {}

	_gather_keyboard(controllers)
	_gather_pointer(controllers)
	_gather_pads(controllers)
	_gather_xr(controllers)

	if not (data.get("packages") is Dictionary):
		data["packages"] = {}

	## The state is rewritten wholesale each frame; only the authored data is
	## carried across, so that a scale or a cursor mode a script set persists.
	data["packages"][_doc.RESERVED] = {
		"utilities": {
			"time": {"properties": {
				"tags": ["time", _doc.TAG],
				"data": time_data,
				"state": {
					"delta": unscaled * time_scale,
					"unscaled": unscaled,
					"elapsed": elapsed,
					"frame": frame,
					"step": step,
					"now": Time.get_unix_time_from_system() * 1000.0
				}
			}},
			"display": {"properties": {
				"tags": ["display", _doc.TAG],
				"data": display_data,
				"state": {
					"size": [size.x, size.y],
					"ratio": 1.0,
					"aspect": size.x / maxf(1.0, size.y),
					"focused": true,
					"fullscreen": DisplayServer.window_get_mode()
						== DisplayServer.WINDOW_MODE_FULLSCREEN,
					"gesture": _gesture,
					"locked": Input.get_mouse_mode()
						== Input.MOUSE_MODE_CAPTURED,
					"fps": Engine.get_frames_per_second(),
					"xr": {"presenting": _xr_presenting}
				}
			}}
		},
		"packages": {"controllers": {"utilities": controllers}}
	}

	match str(display_data.get("cursor", "default")):
		"locked": Input.set_mouse_mode(Input.MOUSE_MODE_CAPTURED)
		"hidden": Input.set_mouse_mode(Input.MOUSE_MODE_HIDDEN)
		_: Input.set_mouse_mode(Input.MOUSE_MODE_VISIBLE)


const KEYS = {
	"KeyW": KEY_W, "KeyA": KEY_A, "KeyS": KEY_S, "KeyD": KEY_D,
	"KeyQ": KEY_Q, "KeyE": KEY_E, "KeyZ": KEY_Z, "KeyX": KEY_X,
	"KeyC": KEY_C, "Space": KEY_SPACE, "Enter": KEY_ENTER,
	"ShiftLeft": KEY_SHIFT, "ShiftRight": KEY_SHIFT,
	"ArrowUp": KEY_UP, "ArrowDown": KEY_DOWN,
	"ArrowLeft": KEY_LEFT, "ArrowRight": KEY_RIGHT
}


func _publish(controllers: Dictionary, alias: String, device: String,
		index: int, handedness: String, digital: Array, pressed: Array,
		released: Array, analog: Dictionary, extra = {}) -> void:

	var reported = {
		"device": device, "index": index, "handedness": handedness,
		"digital": digital, "pressed": pressed, "released": released,
		"analog": analog
	}

	for key in extra.keys():
		reported[key] = extra[key]

	controllers[alias] = {"properties": {
		"tags": ["controller", _doc.TAG],
		"data": {},
		"state": reported
	}}


func _gather_keyboard(controllers: Dictionary) -> void:
	var digital = []

	for name in KEYS.keys():
		if Input.is_key_pressed(KEYS[name]):
			digital.append(name)

	var previous: Array = _previous_keys.get("keyboard-0", [])

	var pressed = []
	var released = []

	for name in digital:
		if not (name in previous):
			pressed.append(name)

	for name in previous:
		if not (name in digital):
			released.append(name)

	_previous_keys["keyboard-0"] = digital

	_publish(controllers, "keyboard-0", "keyboard", 0, "none",
		digital, pressed, released, {})


func _gather_pointer(controllers: Dictionary) -> void:
	var previous: Array = _previous_keys.get("pointer-0", [])

	var pressed = []
	var released = []

	for name in _pointer_buttons:
		if not (name in previous):
			pressed.append(name)

	for name in previous:
		if not (name in _pointer_buttons):
			released.append(name)

	_previous_keys["pointer-0"] = _pointer_buttons.duplicate()

	_publish(controllers, "pointer-0", "pointer", 0, "none",
		_pointer_buttons.duplicate(), pressed, released, _pointer.duplicate())


func _gather_pads(controllers: Dictionary) -> void:
	for device in Input.get_connected_joypads():
		var digital = []

		var buttons = {
			JOY_BUTTON_A: "a", JOY_BUTTON_B: "b", JOY_BUTTON_X: "x",
			JOY_BUTTON_Y: "y",
			JOY_BUTTON_LEFT_SHOULDER: "left-bumper",
			JOY_BUTTON_RIGHT_SHOULDER: "right-bumper",
			JOY_BUTTON_START: "start", JOY_BUTTON_BACK: "select",
			JOY_BUTTON_DPAD_UP: "up", JOY_BUTTON_DPAD_DOWN: "down",
			JOY_BUTTON_DPAD_LEFT: "left", JOY_BUTTON_DPAD_RIGHT: "right"
		}

		for code in buttons.keys():
			if Input.is_joy_button_pressed(device, code):
				digital.append(buttons[code])

		var alias = "gamepad-" + str(device)
		var previous: Array = _previous_keys.get(alias, [])

		var pressed = []
		var released = []

		for name in digital:
			if not (name in previous):
				pressed.append(name)

		for name in previous:
			if not (name in digital):
				released.append(name)

		_previous_keys[alias] = digital

		_publish(controllers, alias, "gamepad", device, "none",
			digital, pressed, released, {
				"left-x": Input.get_joy_axis(device, JOY_AXIS_LEFT_X),
				"left-y": -Input.get_joy_axis(device, JOY_AXIS_LEFT_Y),
				"right-x": Input.get_joy_axis(device, JOY_AXIS_RIGHT_X),
				"right-y": -Input.get_joy_axis(device, JOY_AXIS_RIGHT_Y),
				"left-trigger": Input.get_joy_axis(device, JOY_AXIS_TRIGGER_LEFT),
				"right-trigger": Input.get_joy_axis(device, JOY_AXIS_TRIGGER_RIGHT)
			})


## Tracked controllers are published as the same component as a keyboard or a
## pad, with a pose and a pointing ray added, and aliased by handedness.
func _gather_xr(controllers: Dictionary) -> void:
	if not _xr_presenting:
		return

	for child in get_tree().root.find_children("*", "XRController3D", true, false):
		var hand = "none"

		if child.tracker == "left_hand":
			hand = "left"
		elif child.tracker == "right_hand":
			hand = "right"

		var alias = "xr-controller-" + hand
		var digital = []

		for name in ["trigger_click", "grip_click", "primary_click",
				"ax_button", "by_button"]:
			if child.is_button_pressed(name):
				digital.append({
					"trigger_click": "trigger", "grip_click": "squeeze",
					"primary_click": "thumbstick", "ax_button": "a",
					"by_button": "b"
				}[name])

		if "trigger" in digital and not ("select" in digital):
			digital.append("select")

		var previous: Array = _previous_keys.get(alias, [])

		var pressed = []
		var released = []

		for name in digital:
			if not (name in previous):
				pressed.append(name)

		for name in previous:
			if not (name in digital):
				released.append(name)

		_previous_keys[alias] = digital

		var stick = child.get_vector2("primary")

		var forward = -child.global_basis.z

		_publish(controllers, alias, "xr-controller", 0, hand,
			digital, pressed, released, {
				"thumbstick-x": stick.x,
				"thumbstick-y": stick.y,
				"trigger": child.get_float("trigger"),
				"squeeze": child.get_float("grip")
			}, {
				"pose": {
					"position": [child.global_position.x,
						child.global_position.y, child.global_position.z],
					"rotation": [0, 0, 0, 1]
				},
				"ray": {
					"origin": [child.global_position.x,
						child.global_position.y, child.global_position.z],
					"direction": [forward.x, forward.y, forward.z]
				}
			})
