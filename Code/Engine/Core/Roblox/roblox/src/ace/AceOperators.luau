--!strict

--[[

	The Roblox operator table: what each kind of ACE component builds,
	changes, and destroys.

	Roblox is right handed, Y up, with -Z forward for its default camera —
	the same convention the standard already mandates — so no axis is
	converted anywhere in this file, the same as the Godot port.

	Three places where Roblox's own model is genuinely different from
	Babylon's or Godot's, stated here once rather than re-discovered at each
	site below:

	- Every Part is already a physical body. There is no separate collider
	  object to build — a Part's own geometry (or a MeshPart's
	  CollisionFidelity) is its collision shape, for free. "collider" is
	  therefore mostly bookkeeping here, not construction.

	- There is no general PBR material system. Part.Material is a fixed enum
	  of built-in physical surfaces (Plastic, Wood, Concrete, ...); a document
	  asking for an arbitrary base/normal/roughness map gets a best-effort
	  SurfaceAppearance if the maps resolve to real assets, and a plain colour
	  otherwise. That is a real capability gap, not a bug, and it is reported
	  as one.

	- Animation is built around Humanoid and Animator, not an arbitrary
	  per-mesh clip player. A document's clip is played through whichever of
	  those the loaded model actually has; a model with neither cannot be
	  animated by this operator, and that is reported too.

]]

local AceOperators = {}

export type Runtime = {
	report: (self: Runtime, type_: string, hook: string, message: string) -> (),
	setState: (self: Runtime, record: { id: any, key: string }, values: { [string]: any }) -> (),
	nodeFor: (self: Runtime, path: { string }) -> Instance,
	sibling: (self: Runtime, entityKey: string, type_: string) -> any,
	loadAsset: (self: Runtime, source: string) -> Instance?,
	sourcesOf: (self: Runtime, element: { [string]: any }) -> { string },
	claimCamera: (self: Runtime) -> boolean,
	ambient: (self: Runtime, colour: Color3, intensity: number) -> (),
	[string]: any,
}

function AceOperators.table(): { [string]: { order: number } }

	return {
		world = { order = -100 },
		texture = { order = -20 },
		material = { order = -10 },
		camera = { order = 0 },
		light = { order = 0 },
		mesh = { order = 0 },
		text = { order = 0 },
		collider = { order = 10 },
		body = { order = 20 },
		joint = { order = 30 },
		animation = { order = 10 },
		audio = { order = 0 },
		query = { order = 40 },
		script = { order = 0 },
	}
end

-- ---------------------------------------------------------------- conversions

function AceOperators.vector3(value: any, fallback: Vector3?): Vector3

	if type(value) ~= "table" then
		return fallback or Vector3.zero
	end

	local held = value :: { number }

	return Vector3.new(
		if held[1] ~= nil then held[1] else 0,
		if held[2] ~= nil then held[2] else 0,
		if held[3] ~= nil then held[3] else 0
	)
end

function AceOperators.scaling(value: any): Vector3

	if type(value) == "number" then
		return Vector3.new(value, value, value)
	end

	return AceOperators.vector3(value, Vector3.one)
end

function AceOperators.rotation(value: any): CFrame

	if type(value) ~= "table" then
		return CFrame.identity
	end

	local held = value :: { number }

	if #held >= 4 then

		return CFrame.new(0, 0, 0, held[1], held[2], held[3], held[4])
	end

	local euler = AceOperators.vector3(value)

	return CFrame.fromEulerAnglesXYZ(euler.X, euler.Y, euler.Z)
end

-- A colour is a three or four element array of linear floats, or an sRGB hex
-- string. Both are accepted everywhere.
function AceOperators.colour(value: any, fallback: Color3?): Color3

	if type(value) == "string" and string.sub(value, 1, 1) == "#" then

		local hex = string.sub(value, 2)

		return Color3.fromHex(hex)
	end

	if type(value) == "table" then

		local held = value :: { number }

		return Color3.new(
			if held[1] ~= nil then held[1] else 0,
			if held[2] ~= nil then held[2] else 0,
			if held[3] ~= nil then held[3] else 0
		)
	end

	return fallback or Color3.new(0, 0, 0)
end

local function opacity(value: any): number

	if type(value) == "table" and #(value :: { number }) >= 4 then
		return 1 - (value :: { number })[4]
	end

	return 0
end

function AceOperators.dimensions(data: { [string]: any }, fallback: Vector3?): Vector3

	local size = data.size

	if type(size) == "number" then
		return Vector3.new(size, size, size)
	end

	return AceOperators.vector3(size, fallback or Vector3.one)
end

-- A field that reads as a flag is not always a bool: "shadow" is false, or
-- true, or a table of settings meaning true.
function AceOperators.truthy(value: any, fallback: boolean): boolean

	if type(value) == "boolean" then
		return value
	end

	if value == nil then
		return fallback
	end

	return true
end

-- -------------------------------------------------------------------- create

function AceOperators.create(runtime: Runtime, type_: string, instance: any): any

	if type_ == "world" then return AceOperators.world(runtime, instance) end
	if type_ == "camera" then return AceOperators.camera(runtime, instance) end
	if type_ == "light" then return AceOperators.light(runtime, instance) end
	if type_ == "texture" then return AceOperators.texture(runtime, instance) end
	if type_ == "material" then return AceOperators.material(runtime, instance) end
	if type_ == "mesh" then return AceOperators.mesh(runtime, instance) end
	if type_ == "text" then return AceOperators.text(runtime, instance) end
	if type_ == "collider" then return AceOperators.collider(runtime, instance) end
	if type_ == "body" then return AceOperators.body(runtime, instance) end
	if type_ == "audio" then return AceOperators.audio(runtime, instance) end
	if type_ == "animation" then return AceOperators.animation(runtime, instance) end
	if type_ == "query" then return {} end
	if type_ == "script" then return {} end

	runtime:report(type_, "create", "no operator for component type")

	return nil
end

function AceOperators.world(runtime: Runtime, instance: any): { [string]: any }

	local data = instance.data

	local gravity = if data.gravity ~= nil then data.gravity else { 0, -196.2, 0 }
	local physics = gravity ~= nil

	if physics then

		local pull = AceOperators.vector3(gravity, Vector3.new(0, -196.2, 0))

		workspace.Gravity = pull.Magnitude
	end

	local lighting = game:GetService("Lighting")

	local ambient = data.ambient

	if ambient ~= nil then
		lighting.Ambient = AceOperators.colour(ambient, Color3.new(0, 0, 0))
	end

	local background = data.background

	-- A background naming a texture becomes a sky, resolved once the texture
	-- itself exists; a plain colour is not directly representable the way a
	-- clear colour is elsewhere, since Lighting has no single "clear colour."
	-- The closest honest analogue is the ambient it already carries.
	if type(background) == "table" and background.texture ~= nil then

		instance.object = instance.object or {}
		(instance.object :: any).skyPending = background.texture
	end

	local capabilities = { "audio" }

	if physics then
		table.insert(capabilities, "physics")
	end

	local missing = {}
	local required = data.requires

	if type(required) == "table" then

		for _, want in ipairs(required :: { string }) do

			local have = false

			for _, capability in ipairs(capabilities) do
				if capability == want then
					have = true
					break
				end
			end

			if not have then
				table.insert(missing, want)
			end
		end
	end

	if #missing > 0 then
		runtime:report("world", "create", "unmet capabilities: " .. table.concat(missing, ", "))
	end

	runtime:setState(instance.record, { ready = true, capabilities = capabilities })

	return { lighting = lighting }
end

function AceOperators.camera(runtime: Runtime, instance: any): { [string]: any }

	local data = instance.data
	local node = runtime:nodeFor(instance.entity)

	-- The definitions file declares CurrentCamera as always present, and
	-- this is deliberately more cautious than that: a server script can
	-- plausibly run before Roblox has assigned one. Read once into its own
	-- local rather than mutating a pre-declared one — narrowing a freshly
	-- read value within its own branch is the pattern Luau's checker
	-- reliably follows; narrowing after a reassignment is not.
	local existing = workspace.CurrentCamera :: Camera?
	local camera: Camera

	if existing ~= nil then

		camera = existing

	else

		camera = Instance.new("Camera")
		camera.Parent = workspace
		workspace.CurrentCamera = camera
	end

	local claimed = runtime:claimCamera()

	if not claimed then

		runtime:report("camera", "create",
			"more than one camera component was found; the first is used, "
				.. "since Roblox has exactly one active camera per client")

		return { camera = nil }
	end

	if data.projection == "orthographic" then

		(camera :: any).FieldOfView = 1 -- Roblox has no true orthographic mode
		runtime:report("camera", "create",
			"orthographic projection is not available; the narrowest field "
				.. "of view is used instead")

	else

		(camera :: Camera).FieldOfView = math.deg(data.fov or 1.05)
	end

	-- The node an entity gets is always a Model — nodeFor never creates a
	-- BasePart — so a check for one is dead code that silently falls back
	-- to the world's raw origin every time, regardless of what the document
	-- actually placed the entity at. GetPivot is what _place and _reflect
	-- already use for a Model's real position; the camera has to read the
	-- same way it's written, or it can never agree with what the document
	-- said.
	local pivot = if node:IsA("Model") then (node :: Model):GetPivot()
		elseif node:IsA("BasePart") then (node :: BasePart).CFrame
		else CFrame.identity

	if data.target ~= nil then

		-- target is world space, per the standard, the same as every other
		-- adapter. CFrame.lookAt degenerates if the target and the eye
		-- coincide exactly, which is worth guarding rather than leaving as
		-- a NaN camera someone has to debug blind.
		local aim = AceOperators.vector3(data.target)

		if (aim - pivot.Position).Magnitude > 1e-4 then
			pivot = CFrame.lookAt(pivot.Position, aim)
		end
	end

	(camera :: Camera).CFrame = pivot

	runtime:setState(instance.record, { supported = {}, presenting = false })

	return { camera = camera }
end

function AceOperators.light(runtime: Runtime, instance: any): { [string]: any }

	local data = instance.data
	local kind = data.type or "directional"

	if kind == "ambient" then

		runtime:ambient(AceOperators.colour(data.color, Color3.new(1, 1, 1)),
			data.intensity or 1)

		return { light = nil, ambient = true }
	end

	local node = runtime:nodeFor(instance.entity)
	local light: Light

	if kind == "point" then

		light = Instance.new("PointLight");
		(light :: PointLight).Range = data.range or 10

	elseif kind == "spot" then

		light = Instance.new("SpotLight");
		(light :: SpotLight).Range = data.range or 10;
		(light :: SpotLight).Angle = math.deg(data.angle or 0.7)

	else

		-- Roblox has no per-object directional light; the closest analogue
		-- is Lighting's own single global sun, driven by ClockTime rather
		-- than a placed object.
		local lighting = game:GetService("Lighting")

		lighting.Brightness = data.intensity or 2

		runtime:report("light", "create",
			"a directional light is approximated with Lighting's single "
				.. "global sun rather than a placed light")

		return { light = nil, sun = true }
	end

	light.Color = AceOperators.colour(data.color, Color3.new(1, 1, 1))
	light.Brightness = data.intensity or 1
	light.Shadows = AceOperators.truthy(data.shadow, false)

	-- A PointLight or SpotLight needs a BasePart to attach to for its own
	-- position — an entity's own node is always a Model, never one, so the
	-- check this used to have (node:IsA("BasePart")) was always false and
	-- the light was never parented anywhere at all. It gets its own small
	-- invisible anchor instead, the same way text does, placed at the
	-- model's own already-correct pivot rather than left at the origin.
	local anchor = Instance.new("Part")
	anchor.Name = "light"
	anchor.Transparency = 1
	anchor.CanCollide = false
	anchor.CanQuery = false
	anchor.Anchored = true
	anchor.Size = Vector3.new(0.1, 0.1, 0.1)

	if node:IsA("Model") then
		anchor.CFrame = (node :: Model):GetPivot()
	end

	anchor.Parent = node
	light.Parent = anchor

	return { light = light, part = anchor }
end

function AceOperators.texture(runtime: Runtime, instance: any): { [string]: any }

	local element = instance.record.element
	local sources = runtime:sourcesOf(element)

	for _, source in ipairs(sources) do

		local found = runtime:loadAsset(source)

		if found ~= nil then

			runtime:setState(instance.record, { loaded = true, source = source })

			return { assetId = (found :: any).AssetId or found }
		end
	end

	runtime:setState(instance.record, {
		loaded = false,
		error = if #sources > 0 then "all sources failed"
			else "texture has neither source nor content",
	})

	return { assetId = nil }
end

function AceOperators.material(runtime: Runtime, instance: any): { [string]: any }

	local object = { colour = nil :: Color3?, transparency = 0, appearance = nil :: any }

	AceOperators.applyMaterial(runtime, instance, object)

	return object
end

function AceOperators.applyMaterial(runtime: Runtime, instance: any, object: { [string]: any })

	local data = instance.data

	object.colour = AceOperators.colour(data.color, Color3.new(1, 1, 1))
	object.transparency = opacity(data.color)

	local loaded = true
	local maps = data.maps

	if type(maps) == "table" then

		for _, slot in ipairs({ "base", "normal", "roughness", "emissive" }) do

			local value = (maps :: { [string]: any })[slot]

			if value ~= nil then

				local resolved = nil

				if type(value) == "table" and value.texture ~= nil then

					local found = runtime:sibling(
						AceOperators.textureKeyOf(runtime, value.texture), "texture"
					)

					resolved = found and found.object and found.object.assetId

				elseif type(value) == "string" then

					local built = runtime:loadAsset(value)
					resolved = built and (built :: any).AssetId
				end

				if resolved == nil then
					loaded = false
				else
					object[slot] = resolved
				end
			end
		end
	end

	runtime:setState(instance.record, { loaded = loaded })
end

-- A reference of the form { texture = "path.to.component" } names another
-- component by its element path, in the same document.
function AceOperators.textureKeyOf(runtime: Runtime, reference: any): string

	return tostring(reference)
end

function AceOperators.mesh(runtime: Runtime, instance: any): { [string]: any }

	local data = instance.data
	local element = instance.record.element
	local parent = runtime:nodeFor(instance.entity)
	local shape = data.shape

	local object = { part = nil :: BasePart?, shape = shape, loaded = false }

	-- A loaded model: Roblox has no local-file mesh import, so this always
	-- goes through the asset resolver, the same as every texture and audio
	-- source. Nothing here can bypass Roblox's own asset system.
	if element.source ~= nil then

		for _, source in ipairs(runtime:sourcesOf(element)) do

			local found = runtime:loadAsset(source)

			if found ~= nil and found:IsA("BasePart") then

				local part = found:Clone()
				part.Name = "mesh"
				part.Parent = parent

				object.part = part
				object.loaded = true

				runtime:setState(instance.record, { loaded = true, source = source })

				return object
			end
		end

		runtime:setState(instance.record, { loaded = false, error = "all sources failed" })

		return object
	end

	local size = AceOperators.dimensions(data)
	local part: BasePart

	if shape == "box" or shape == nil then

		part = Instance.new("Part");
		(part :: Part).Shape = Enum.PartType.Block
		part.Size = size

	elseif shape == "sphere" then

		part = Instance.new("Part");
		(part :: Part).Shape = Enum.PartType.Ball
		part.Size = Vector3.new(size.X, size.X, size.X)

	elseif shape == "cylinder" then

		part = Instance.new("Part");
		(part :: Part).Shape = Enum.PartType.Cylinder

		-- Roblox's own current docs are explicit that its cylinder is
		-- oriented along the local X axis, contradicting an older
		-- community wiki that claims Y — checked directly rather than
		-- assumed, since Babylon and Godot both treat Y as a cylinder's
		-- height and that was the wrong convention to carry over here.
		-- The size is remapped to Roblox's real axis, and the attribute
		-- is what a fixed quarter turn needs to survive every later
		-- reposition — see _place, which is the only place this is read.
		part.Size = Vector3.new(size.Y, size.X, size.Z)
		part:SetAttribute("aceBaseRotation", Vector3.new(0, 0, math.rad(90)))

	elseif shape == "plane" or shape == "ground" then

		part = Instance.new("Part");
		(part :: Part).Shape = Enum.PartType.Block
		part.Size = Vector3.new(size.X, 0.05, size.Z ~= 0 and size.Z or size.Y)

	else

		-- capsule, torus, heightmap: no native Roblox primitive. These need
		-- an uploaded MeshPart the same way a loaded model does; without a
		-- source there is nothing to build them from.
		runtime:report("mesh", "create",
			"shape \"" .. tostring(shape) .. "\" has no built-in Roblox "
				.. "primitive and no source was given to load one from")

		runtime:setState(instance.record, {
			loaded = false,
			error = "no primitive or source for shape " .. tostring(shape),
		})

		return object
	end

	part.Name = "mesh"
	part.Anchored = true
	part.Parent = parent

	object.part = part
	object.loaded = true

	runtime:setState(instance.record, { loaded = true })

	return object
end

function AceOperators.text(runtime: Runtime, instance: any): { [string]: any }

	local data = instance.data
	local element = instance.record.element
	local node = runtime:nodeFor(instance.entity)

	local anchor = Instance.new("Part")
	anchor.Name = "text"
	anchor.Transparency = 1
	anchor.CanCollide = false
	anchor.CanQuery = false
	anchor.Anchored = true
	anchor.Size = Vector3.new(0.1, 0.1, 0.1)
	anchor.Parent = node

	local billboard = Instance.new("BillboardGui")
	billboard.Size = UDim2.fromScale(
		math.max(1, data.width or 4), math.max(1, data.width or 4)
	)
	billboard.AlwaysOnTop = true
	billboard.Parent = anchor

	local label = Instance.new("TextLabel")
	label.BackgroundTransparency = 1
	label.Size = UDim2.fromScale(1, 1)
	label.Text = tostring(element.content or "")
	label.TextColor3 = AceOperators.colour(data.color, Color3.new(1, 1, 1))
	label.TextScaled = true
	label.Font = Enum.Font.Gotham
	label.TextXAlignment = if data.align == "center" then Enum.TextXAlignment.Center
		elseif data.align == "right" then Enum.TextXAlignment.Right
		else Enum.TextXAlignment.Left
	label.Parent = billboard

	runtime:setState(instance.record, { loaded = true })

	return { part = anchor, gui = billboard, label = label }
end

function AceOperators.collider(runtime: Runtime, instance: any): { [string]: any }

	-- Every Part is already a physical body with its own collision geometry.
	-- There is nothing to build here; this exists to report the state a
	-- Babylon or Godot document would expect to read.
	runtime:setState(instance.record, { contacts = {} })

	return {}
end

function AceOperators.body(runtime: Runtime, instance: any): { [string]: any }

	local data = instance.data
	local sibling = runtime:sibling(instance.entityKey, "mesh")

	local part = sibling and sibling.object and sibling.object.part

	if part == nil then

		runtime:report("body", "create",
			"a body needs a sibling mesh; none was found on this entity")

		return { part = nil }
	end

	local mode = data.mode or "dynamic"

	part.Anchored = mode ~= "dynamic"
	part.CanCollide = true

	if mode == "dynamic" then

		local density = data.mass and (data.mass / math.max(0.001,
			part.Size.X * part.Size.Y * part.Size.Z)) or 1

		part.CustomPhysicalProperties = PhysicalProperties.new(
			density, part.CustomPhysicalProperties.Friction,
			part.CustomPhysicalProperties.Elasticity
		)
	end

	return { part = part }
end

function AceOperators.audio(runtime: Runtime, instance: any): { [string]: any }

	local data = instance.data
	local element = instance.record.element
	local node = runtime:nodeFor(instance.entity)

	local sound = Instance.new("Sound")
	sound.Name = "audio"
	sound.Volume = data.volume or 0.5
	sound.Looped = AceOperators.truthy(data.loop, false)

	for _, source in ipairs(runtime:sourcesOf(element)) do

		local found = runtime:loadAsset(source)

		if found ~= nil then

			sound.SoundId = "rbxassetid://" .. tostring((found :: any).AssetId)
			sound.Parent = node

			runtime:setState(instance.record, { loaded = true, playing = false })

			if AceOperators.truthy(data.autoplay, false) then
				sound:Play()
			end

			return { sound = sound }
		end
	end

	sound:Destroy()

	runtime:setState(instance.record, {
		loaded = false, playing = false, error = "all sources failed",
	})

	return { sound = nil }
end

function AceOperators.animation(runtime: Runtime, instance: any): { [string]: any }

	local sibling = runtime:sibling(instance.entityKey, "mesh")
	local part = sibling and sibling.object and sibling.object.part

	local humanoid = nil
	local animator = nil

	if part ~= nil and part.Parent ~= nil then

		humanoid = part.Parent:FindFirstChildOfClass("Humanoid")

		if humanoid ~= nil then
			animator = humanoid:FindFirstChildOfClass("Animator")
				or Instance.new("Animator", humanoid)
		end
	end

	if humanoid == nil then

		runtime:report("animation", "create",
			"the loaded model has no Humanoid; a clip cannot be played "
				.. "against it through this operator")
	end

	return { animator = animator, track = nil, clip = nil }
end

-- ------------------------------------------------------------------- destroy

function AceOperators.destroy(runtime: Runtime, type_: string, instance: any)

	local object = instance.object

	if type(object) ~= "table" then
		return
	end

	for _, key in ipairs({ "part", "light", "camera", "sound", "label" }) do

		local held = (object :: { [string]: any })[key]

		if typeof(held) == "Instance" and held ~= workspace.CurrentCamera then
			held:Destroy()
		end
	end
end

return AceOperators
