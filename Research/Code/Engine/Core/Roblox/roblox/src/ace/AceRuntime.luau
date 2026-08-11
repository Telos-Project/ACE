--!strict

--[[

	The ACE runtime for Roblox.

	Runs server side, in ServerScriptService: it is the reconciler, the same
	role AceRuntime.gd plays for Godot and the browser adapter plays for
	Babylon. It reads a document, builds and updates real Instances under
	workspace, and writes state back into the document every heartbeat.
	Everything it builds replicates to clients through Roblox's own ordinary
	replication — nothing here talks to a client directly.

	One thing this cannot do that every other adapter's runtime can: compile
	a script's source from the document at runtime. Roblox disables
	loadstring for the whole client and server sandbox, as a deliberate,
	held security boundary, not an incidental gap. A script component's
	content therefore has to already exist as a real ModuleScript by the
	time this runs — the exporter writes one per script at build time — and
	this runtime finds it by the script's own identity rather than
	compiling it. Every other field in the document stays exactly as live
	as it is anywhere else: only a script's source is not.

]]

local AceDocument = require(script.Parent.AceDocument)
local AceOperators = require(script.Parent.AceOperators)

local RunService = game:GetService("RunService")

local AceRuntime = {}
AceRuntime.__index = AceRuntime

export type Instance_ = {
	id: string,
	type: string,
	path: { string },
	key: string,
	entity: { string },
	entityKey: string,
	record: AceDocument.ComponentRecord,
	data: { [string]: any },
	source: any,
	content: any,
	object: any,
}

export type Runtime = typeof(setmetatable({} :: {
	data: any,
	resolved: AceDocument.Collected,
	instances: { [string]: Instance_ },
	state: { [string]: { [string]: any } },
	errors: { { type: string, hook: string, message: string } },
	frame: number,
	elapsed: number,

	nodes: { [string]: Instance? },
	applied: { [string]: string },
	manifest: { [string]: any },
	scripts: { [string]: ModuleScript? },

	physicsOn: boolean,
	cameraClaimed: boolean,
	ambientColour: Color3,
	ambientEnergy: number,

	_said: { [string]: boolean },
	trace: string?,
}, AceRuntime))

-- ------------------------------------------------------------------- setup

function AceRuntime.new(documentJson: string, manifestJson: string?, scriptsFolder: Instance?,
	scriptIndexJson: string?, traceTarget: string?): Runtime

	local self = setmetatable({
		data = game:GetService("HttpService"):JSONDecode(documentJson),
		resolved = { components = {}, entities = {}, errors = {} },
		instances = {},
		state = {},
		errors = {},
		frame = 0,
		elapsed = 0,

		nodes = {},
		applied = {},
		manifest = if manifestJson ~= nil
			then game:GetService("HttpService"):JSONDecode(manifestJson)
			else {},
		scripts = {},

		physicsOn = false,
		cameraClaimed = false,
		ambientColour = Color3.new(0, 0, 0),
		ambientEnergy = 0,

		_said = {},
		trace = traceTarget,
	}, AceRuntime)

	-- The identity a script is compiled under has characters no filesystem
	-- should carry in a name, so the file it became was sanitized, and the
	-- Roblox instance name that results is not the identity itself. The
	-- index the exporter wrote alongside the scripts is what actually
	-- connects the two; without it, a script keyed by its real identity
	-- would never be found under a Roblox instance name that was never
	-- meant to equal it in the first place.
	if scriptsFolder ~= nil and scriptIndexJson ~= nil then

		local index = game:GetService("HttpService"):JSONDecode(scriptIndexJson)

		for id, instanceName in pairs(index) do

			local child = scriptsFolder:FindFirstChild(instanceName :: string)

			if child ~= nil and child:IsA("ModuleScript") then
				(self :: any).scripts[id] = child
			end
		end
	end

	return (self :: any) :: Runtime
end

-- --------------------------------------------------------------- reporting

function AceRuntime.report(self: Runtime, type_: string, hook: string, message: string)

	table.insert(self.errors, { type = type_, hook = hook, message = message })
end

function AceRuntime._announce(self: Runtime)

	for _, problem in ipairs(self.errors) do

		local line = "ACE: " .. problem.type .. "." .. problem.hook .. ": " .. problem.message

		if not self._said[line] then

			self._said[line] = true
			warn(line)
		end
	end

	for _, record in ipairs(self.resolved.components) do

		if record.type ~= "script" or record.reserved then
			continue
		end

		local held = self.state[AceDocument.identity(record)]

		if type(held) ~= "table" or held.error == nil then
			continue
		end

		local line = "ACE: the script at " .. table.concat(record.path, ".")
			.. " failed: " .. tostring(held.error)

		if not self._said[line] then

			self._said[line] = true
			warn(line)
		end
	end
end

-- ------------------------------------------------------------------- state

function AceRuntime.setState(self: Runtime, record: { id: any, key: string }, values: { [string]: any })

	local id = AceDocument.identity(record)

	if self.state[id] == nil then
		self.state[id] = {}
	end

	for key, value in pairs(values) do
		self.state[id][key] = value
	end
end

function AceRuntime._flush(self: Runtime)

	for _, record in ipairs(self.resolved.entities) do
		self:_write(record, true)
	end

	for _, record in ipairs(self.resolved.components) do
		self:_write(record, false)
	end
end

function AceRuntime._write(self: Runtime, record: any, isEntity: boolean)

	if record.reserved then
		return
	end

	local id = AceDocument.identity(record)
	local element = record.element
	local held = self.state[id]

	if type(element.properties) ~= "table" then
		element.properties = {}
	end

	if isEntity then

		if type(element.properties.meta) ~= "table" then
			element.properties.meta = {}
		end

		if held == nil then
			element.properties.meta.state = nil
		else
			element.properties.meta.state = held
		end

		return
	end

	if held == nil then
		element.properties.state = nil
	else
		element.properties.state = held
	end
end

-- --------------------------------------------------------------------- nodes

function AceRuntime.nodeFor(self: Runtime, path: { string }): Instance

	local key = AceDocument.pathKey(path)

	-- Read once into a local rather than checking the indexed expression
	-- directly and re-reading it — the same narrowing limitation as the
	-- camera lookup in AceOperators, and the same fix.
	local existing = self.nodes[key]

	if existing ~= nil then
		return existing
	end

	local made = Instance.new("Model")
	made.Name = if #path > 0 then path[#path] else "root"

	self.nodes[key] = made

	if #path > 1 then

		local parentPath = {}

		for index = 1, #path - 1 do
			parentPath[index] = path[index]
		end

		made.Parent = self:nodeFor(parentPath)

	else

		made.Parent = workspace
	end

	for _, record in ipairs(self.resolved.entities) do

		if record.key == key then
			self:_place(made, record.data)
			break
		end
	end

	return made
end

function AceRuntime._place(self: Runtime, node: Instance, data: { [string]: any })

	if node:IsA("BasePart") then

		local part = node :: BasePart

		if data.position ~= nil or data.rotation ~= nil then

			local position = AceOperators.vector3(data.position)
			local turn = AceOperators.rotation(data.rotation)

			part.CFrame = turn + position
		end

	elseif node:IsA("Model") then

		local model = node :: Model
		local pivot = model:GetPivot()

		local position = if data.position ~= nil then AceOperators.vector3(data.position)
			else pivot.Position

		local turn = if data.rotation ~= nil then AceOperators.rotation(data.rotation)
			else (pivot - pivot.Position)

		local target = turn + position

		model:PivotTo(target)

		-- PivotTo is documented to carry existing descendants along with the
		-- pivot it moves to. Traced directly against a real session: a Part
		-- parented in after the model's pivot was already set does not
		-- track it — the model's own GetPivot() reads correctly and the
		-- Part inside it stays exactly where it was created regardless.
		-- Every direct BasePart child is set to the same target explicitly
		-- here, which does not depend on that behaviour holding at all.
		for _, child in ipairs(model:GetChildren()) do

			if child:IsA("BasePart") then
				(child :: BasePart).CFrame = target
			end
		end
	end
end

function AceRuntime.sibling(self: Runtime, entityKey: string, type_: string): Instance_?

	for _, instance in pairs(self.instances) do

		if instance.entityKey == entityKey and instance.type == type_ then
			return instance
		end
	end

	return nil
end

function AceRuntime.claimCamera(self: Runtime): boolean

	if self.cameraClaimed then
		return false
	end

	self.cameraClaimed = true

	return true
end

function AceRuntime.ambient(self: Runtime, colour: Color3, intensity: number)

	self.ambientColour = colour
	self.ambientEnergy = intensity

	game:GetService("Lighting").Ambient = colour
end

-- ------------------------------------------------------------------- assets

-- Roblox has no local-file reference for a mesh, texture, or sound; every
-- one of them is a cloud asset with an rbxassetid. The manifest, written by
-- the exporter's Tarmac hand-off, maps a document's own source strings to
-- the id that was actually uploaded for it. Nothing here can invent one on
-- its own.
function AceRuntime.loadAsset(self: Runtime, source: string): Instance?

	local id = self.manifest[source]

	if id == nil then

		self:report("asset", "load", "no uploaded asset is known for " .. source
			.. " — see the manifest this project was exported with")

		return nil
	end

	local holder = Instance.new("StringValue")
	holder.Name = "asset"
	holder.Value = tostring(id);
	(holder :: any).AssetId = id

	return holder
end

function AceRuntime.sourcesOf(self: Runtime, element: { [string]: any }): { string }

	local source = element.source

	if type(source) == "string" then
		return { source }
	end

	if type(source) == "table" then

		local list = {}

		for _, entry in ipairs(source :: { any }) do

			if type(entry) == "string" then
				table.insert(list, entry)
			end
		end

		return list
	end

	return {}
end

-- --------------------------------------------------------------- reconciler

local ORDER = AceOperators.table()

function AceRuntime._reconcile(self: Runtime)

	local present: { [string]: any } = {}

	for _, record in ipairs(self.resolved.components) do

		if record.reserved or record.type == "script" then
			continue
		end

		present[AceDocument.identity(record)] = record
	end

	for id in pairs(self.instances) do

		if present[id] == nil then

			local instance = self.instances[id]

			AceOperators.destroy(self :: any, instance.type, instance)

			self.instances[id] = nil
			self.state[id] = nil
		end
	end

	local pending = {}

	for id in pairs(present) do
		table.insert(pending, id)
	end

	table.sort(pending, function(a, b)

		local left = (ORDER[present[a].type] or { order = 0 }).order
		local right = (ORDER[present[b].type] or { order = 0 }).order

		if left ~= right then
			return left < right
		end

		return a < b
	end)

	for _, id in ipairs(pending) do

		if self.instances[id] ~= nil then
			continue
		end

		local record = present[id]

		local built: Instance_ = {
			id = id,
			type = record.type,
			path = record.path,
			key = record.key,
			entity = record.entity,
			entityKey = record.entityKey,
			record = record,
			data = table.clone(record.data),
			source = record.element.source,
			content = record.element.content,
			object = nil,
		}

		local object = AceOperators.create(self :: any, record.type, built)

		if object == nil then
			continue
		end

		built.object = object
		self.instances[id] = built
	end

	for id, living in pairs(self.instances) do

		local current = present[id]

		if current == nil then
			continue
		end

		living.record = current

		local changed = (
			game:GetService("HttpService"):JSONEncode(current.data)
				~= game:GetService("HttpService"):JSONEncode(living.data)
			or game:GetService("HttpService"):JSONEncode(current.element.source)
				~= game:GetService("HttpService"):JSONEncode(living.source)
			or current.element.content ~= living.content
		)

		if not changed then
			continue
		end

		living.data = table.clone(current.data)
		living.source = current.element.source
		living.content = current.element.content

		if living.type == "material" then
			AceOperators.applyMaterial(self :: any, living, living.object)
		end
	end
end

function AceRuntime._reflect(self: Runtime)

	local live: { [string]: boolean } = {}

	for _, record in ipairs(self.resolved.entities) do

		if not record.scene then
			continue
		end

		live[record.key] = true

		local node = self:nodeFor(record.path)
		local data = record.data

		local signature = game:GetService("HttpService"):JSONEncode({
			data.position, data.rotation, data.scale,
		})

		if self.applied[record.key] ~= signature then

			self:_place(node, data)
			self.applied[record.key] = signature
		end

		if node:IsA("Model") then

			for _, child in ipairs(node:GetDescendants()) do

				if child:IsA("BasePart") then
					child.LocalTransparencyModifier = if data.enabled == false then 1 else 0
				end
			end
		end

		local pivot = if node:IsA("Model") then (node :: Model):GetPivot()
			elseif node:IsA("BasePart") then (node :: BasePart).CFrame
			else CFrame.identity

		self:setState(record, {
			position = { pivot.Position.X, pivot.Position.Y, pivot.Position.Z },
			rotation = { 0, 0, 0, 1 },
			scale = { 1, 1, 1 },
		})
	end

	for key in pairs(self.nodes) do

		if not live[key] then

			local node = self.nodes[key]

			if node ~= nil and node.Parent ~= nil then
				node:Destroy()
			end

			self.nodes[key] = nil
			self.applied[key] = nil
		end
	end
end

-- ------------------------------------------------------------------ scripts

-- A script's source is not compiled here — it already exists, as a real
-- ModuleScript the exporter wrote, one per script component, named by that
-- component's own identity. This looks the module up and calls the run it
-- exports, which is the exact same (state, path) -> patch|nil contract every
-- other adapter's script host honours; only where the compiling happened is
-- different.
function AceRuntime._runScripts(self: Runtime)

	local due = {}

	for _, record in ipairs(self.resolved.components) do

		if record.type ~= "script" or record.reserved then
			continue
		end

		if record.data.enabled == false then
			continue
		end

		table.insert(due, record)
	end

	table.sort(due, function(a, b)

		local left = a.data.order or 0
		local right = b.data.order or 0

		if left ~= right then
			return left < right
		end

		return a.key < b.key
	end)

	for _, record in ipairs(due) do

		local id = AceDocument.identity(record)
		local module = self.scripts[id]

		if module == nil then

			self:setState(record, {
				error = "no compiled script was found for this identity; "
					.. "the project needs to be re-exported after this "
					.. "script's content changed",
			})

			continue
		end

		local ok, held = pcall(require, module)

		if not ok then

			self:setState(record, { error = tostring(held) })
			continue
		end

		if type(held) ~= "table" or type(held.run) ~= "function" then

			self:setState(record, {
				error = "the compiled script does not export a run function",
			})

			continue
		end

		local state = game:GetService("HttpService"):JSONEncode(self.data)
		local path = game:GetService("HttpService"):JSONEncode(record.path)

		local ran, output = pcall(held.run, state, path)

		if not ran then

			self:setState(record, { error = tostring(output) })
			continue
		end

		self:setState(record, { error = nil })

		if output == nil or output == "" then
			continue
		end

		local decoded = nil

		local decodeOk = pcall(function()
			decoded = game:GetService("HttpService"):JSONDecode(output)
		end)

		if not decodeOk then

			self:setState(record, { error = "output is not valid JSON" })
			continue
		end

		if record.data.output == "override" then
			self.data = decoded
		else
			self.data = AceDocument.merge(self.data, decoded)
		end

		self.resolved = AceDocument.collect(self.data)
	end
end

-- --------------------------------------------------------------------- frame

local function splitTrace(path: string, separator: string): { string }

	local out = {}

	for step in string.gmatch(path, "[^" .. separator .. "]+") do
		table.insert(out, step)
	end

	return out
end

-- Set to entity paths — "plaza.pillar0" or several, comma separated
-- ("plaza,plaza.pillar0" — to compare a parent against its own child in one
-- run) — to have what the document says about each printed twice a second,
-- alongside what the actual Instance built for it reports back: the
-- Model's own pivot, and separately the real world CFrame of anything
-- actually parented inside it, since those can disagree even when the
-- Model's own pivot looks correct.
function AceRuntime._trace(self: Runtime)

	if self.trace == nil or self.trace == "" then
		return
	end

	if self.frame % 30 ~= 0 then
		return
	end

	for _, wanted in ipairs(splitTrace(self.trace :: string, ",")) do
		self:_traceOne(wanted)
	end
end

function AceRuntime._traceOne(self: Runtime, wanted: string)

	local key = AceDocument.pathKey(splitTrace(wanted, "."))

	for _, record in ipairs(self.resolved.entities) do

		if record.key ~= key then
			continue
		end

		local node = self.nodes[key]

		local built = "no node was built for it at all"
		local contents = ""

		if node ~= nil then

			local pivot = if node:IsA("Model") then (node :: Model):GetPivot()
				elseif node:IsA("BasePart") then (node :: BasePart).CFrame
				else nil

			built = if pivot ~= nil
				then string.format("model pivot at (%.2f, %.2f, %.2f)",
					pivot.Position.X, pivot.Position.Y, pivot.Position.Z)
				else "built, but not something with a position at all"

			-- The Model's own pivot can look right while whatever was
			-- actually parented inside it sits somewhere else — this is
			-- the other half of that question, not assumed to agree.
			local parts = {}

			for _, child in ipairs(node:GetDescendants()) do

				if child:IsA("BasePart") then

					table.insert(parts, string.format(
						"%s at (%.2f, %.2f, %.2f)",
						child.Name, child.Position.X, child.Position.Y, child.Position.Z
					))
				end
			end

			contents = if #parts > 0
				then "  parts: " .. table.concat(parts, "; ")
				else "  parts: none parented in yet"
		end

		print(
			"[ace trace] " .. wanted .. "  data: "
				.. game:GetService("HttpService"):JSONEncode(record.data)
				.. "  scene: " .. tostring(record.scene)
				.. "  " .. built .. contents
		)

		return
	end

	print("[ace trace] " .. wanted .. "  not found in the document at all — " ..
		"check the path against the document's own package names")
end

function AceRuntime.step(self: Runtime, delta: number)

	self.errors = {}
	self.frame += 1
	self.elapsed += delta

	self.resolved = AceDocument.collect(self.data)

	self:_runScripts()

	self:_reconcile()
	self:_reflect()
	self:_flush()

	for _, problem in ipairs(self.resolved.errors) do
		self:report("document", "collect", problem.message)
	end

	self:_announce()
	self:_trace()
end

function AceRuntime.start(self: Runtime)

	RunService.Heartbeat:Connect(function(delta)
		self:step(delta)
	end)
end

return AceRuntime
