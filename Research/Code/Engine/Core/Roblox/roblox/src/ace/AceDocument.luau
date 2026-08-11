--!strict

--[[

	ACE document handling: resolution, element paths, and merge patching.

	This is the Luau half of the same core that runs under the browser and
	Godot adapters. It knows nothing about Roblox: it turns an APInt document
	into a set of components and entities, and applies patches back to it.
	Ported from ace.js directly rather than from the Godot port, since Luau's
	tables map onto JavaScript's objects and arrays more directly than
	GDScript's typed Dictionary/Array split does.

]]

local AceDocument = {}

AceDocument.TAG = "telos-ace"
AceDocument.RESERVED = "engine"

-- Fields the engine may write to a data object. The sole exception to the
-- authority rule; see standard section 2.2.4.
AceDocument.CONSUMABLE = {
	[""] = { "position", "rotation", "scale" },
	body = { "impulse", "torque", "teleport" },
	audio = { "play", "stop", "seek" },
	animation = { "play", "stop", "seek" },
	controller = { "haptic" },
	display = { "fullscreen", "capture" },
}

export type Json = { [string]: any } | { any } | string | number | boolean | nil

local function isArray(value: any): boolean

	if type(value) ~= "table" then
		return false
	end

	-- Empty is treated as an object, not an array. ACE documents are full of
	-- empty data:{} fields, and merging a patch into one has to merge rather
	-- than wholesale-replace, matching every other adapter's own reading of
	-- an empty JSON object.
	if next(value :: { [any]: any }) == nil then
		return false
	end

	local length = #(value :: { any })
	local count = 0

	for key in pairs(value :: { [any]: any }) do

		count += 1

		if type(key) ~= "number" or key < 1 or key > length or key % 1 ~= 0 then
			return false
		end
	end

	return count == length
end

function AceDocument.isObject(value: any): boolean

	return type(value) == "table" and not isArray(value)
end

function AceDocument.pathKey(path: { string }): string

	local encoded = {}

	for index, step in ipairs(path) do
		encoded[index] = string.format("%q", step)
	end

	return "[" .. table.concat(encoded, ",") .. "]"
end

function AceDocument.parsePath(path: any): { string }

	if type(path) == "table" then

		local out = {}

		for index, step in ipairs(path :: { any }) do
			out[index] = tostring(step)
		end

		return out
	end

	if type(path) == "string" then

		local out = {}

		for step in string.gmatch(path, "[^.]+") do
			table.insert(out, step)
		end

		return out
	end

	return {}
end

local function clone(value: any): any

	if type(value) ~= "table" then
		return value
	end

	local out = {}

	for key, entry in pairs(value) do
		out[key] = clone(entry)
	end

	return out
end

-- RFC 7386. Objects merge recursively, null (Luau's nil, carried through as a
-- sentinel since a table cannot hold a real nil) deletes, arrays and
-- primitives replace wholesale.
AceDocument.NULL = setmetatable({}, { __tostring = function()
	return "ace.null"
end })

function AceDocument.merge(target: any, patch: any): any

	if type(patch) ~= "table" or isArray(patch) then

		if patch == AceDocument.NULL then
			return nil
		end

		return clone(patch)
	end

	if type(target) ~= "table" or isArray(target) then
		target = {}
	end

	for key, value in pairs(patch :: { [string]: any }) do

		if value == AceDocument.NULL then
			target[key] = nil
		else
			target[key] = AceDocument.merge(target[key], value)
		end
	end

	return target
end

local function firstId(id: any): any

	if type(id) == "table" and not AceDocument.isObject(id) then
		return (id :: { any })[1]
	end

	return id
end

local function hasId(element: any, alias: string): boolean

	if type(element) ~= "table" then
		return false
	end

	local props = element.properties

	if type(props) ~= "table" then
		return false
	end

	local id = props.id

	if id == nil and type(props.meta) == "table" then
		id = props.meta.id
	end

	if type(id) == "table" and not AceDocument.isObject(id) then

		for _, entry in ipairs(id :: { any }) do
			if entry == alias then
				return true
			end
		end

		return false
	end

	return id == alias
end

-- Resolves an APInt element path against a package. Adjacent aliases need not
-- be immediate parent and child, so each is searched for breadth first among
-- descendants. Honours the ID property protocol.
function AceDocument.getElement(pkg: any, path: any): { element: any, path: { string } }?

	local steps = AceDocument.parsePath(path)
	local current = { element = pkg, path = {} }

	for _, alias in ipairs(steps) do

		local found = nil
		local queue = { current }
		local head = 1

		while head <= #queue and found == nil do

			local node = queue[head]
			head += 1

			local element = node.element

			if type(element) == "table" then

				for _, field in ipairs({ "utilities", "packages" }) do

					local held = element[field]

					if type(held) == "table" then

						for key, child in pairs(held :: { [string]: any }) do

							local nextPath = table.clone(node.path)
							table.insert(nextPath, key)

							local entry = { element = child, path = nextPath }

							if key == alias or hasId(child, alias) then
								found = entry
								break
							end

							table.insert(queue, entry)
						end
					end

					if found ~= nil then
						break
					end
				end
			end
		end

		if found == nil then
			return nil
		end

		current = found
	end

	return current
end

export type ComponentRecord = {
	kind: "component",
	type: string,
	path: { string },
	key: string,
	id: any,
	entity: { string },
	entityKey: string,
	element: any,
	properties: { [string]: any },
	tags: { string },
	data: { [string]: any },
	reserved: boolean,
}

export type EntityRecord = {
	kind: "entity",
	path: { string },
	key: string,
	id: any,
	element: any,
	meta: { [string]: any },
	tags: { string },
	data: { [string]: any },
	reserved: boolean,
	scene: boolean,
}

export type Collected = {
	components: { ComponentRecord },
	entities: { EntityRecord },
	errors: { { path: { string }, message: string } },
}

local function inherit(parent: { [string]: any }, own: any): { [string]: any }

	local result = table.clone(parent)

	if type(own) == "table" then

		for key, value in pairs(own :: { [string]: any }) do

			if key ~= "meta" then
				result[key] = value
			end
		end
	end

	return result
end

-- Walks the document and returns every component and entity, with package
-- properties bubbled down to descendants. The meta field is excluded from
-- bubbling.
--
-- A utility without the tag is not a component and is left alone: it stays in
-- the document for scripts to read. A package with no component anywhere
-- beneath it is not part of the scene, and is marked so that no node is built
-- for it.
function AceDocument.collect(doc: any): Collected

	local components: { ComponentRecord } = {}
	local entities: { EntityRecord } = {}
	local errors: { { path: { string }, message: string } } = {}

	local function walk(pkg: any, path: { string }, inherited: { [string]: any },
		reserved: boolean)

		if type(pkg) == "string" then

			table.insert(errors, {
				path = path,
				message = "unresolved package reference: " .. pkg,
			})

			return
		end

		if type(pkg) ~= "table" then
			return
		end

		local props = inherit(inherited, pkg.properties)
		local meta: { [string]: any } = {}

		if type(pkg.properties) == "table" and type(pkg.properties.meta) == "table" then
			meta = pkg.properties.meta
		end

		if #path > 0 then

			local tags = meta.tags
			local data = meta.data

			table.insert(entities, {
				kind = "entity",
				path = path,
				key = AceDocument.pathKey(path),
				id = firstId(meta.id),
				element = pkg,
				meta = meta,
				tags = if type(tags) == "table" then tags else {},
				data = if type(data) == "table" then data else {},
				reserved = reserved,
				scene = true,
			})
		end

		if type(pkg.utilities) == "table" then

			for key, utility in pairs(pkg.utilities :: { [string]: any }) do

				if type(utility) == "table" then

					local uprops = inherit(props, utility.properties)
					local tags = uprops.tags

					if type(tags) == "table" and #(tags :: { any }) > 0 then

						local has = false

						for _, entry in ipairs(tags :: { any }) do
							if entry == AceDocument.TAG then
								has = true
								break
							end
						end

						if has then

							if tags[1] == AceDocument.TAG then

								local entryPath = table.clone(path)
								table.insert(entryPath, key)

								table.insert(errors, {
									path = entryPath,
									message = "component has no primary tag",
								})

							else

								local entryPath = table.clone(path)
								table.insert(entryPath, key)

								local data = uprops.data

								table.insert(components, {
									kind = "component",
									type = tags[1],
									path = entryPath,
									key = AceDocument.pathKey(entryPath),
									id = firstId(uprops.id),
									entity = path,
									entityKey = AceDocument.pathKey(path),
									element = utility,
									properties = uprops,
									tags = tags,
									data = if type(data) == "table" then data else {},
									reserved = reserved,
								})
							end
						end
					end
				end
			end
		end

		if type(pkg.packages) == "table" then

			for key, child in pairs(pkg.packages :: { [string]: any }) do

				local nextPath = table.clone(path)
				table.insert(nextPath, key)

				walk(
					child, nextPath, props,
					reserved or (#path == 0 and key == AceDocument.RESERVED)
				)
			end
		end
	end

	walk(doc, {}, {}, false)

	local scene: { [string]: boolean } = {}

	for _, record in ipairs(components) do

		local path = record.entity
		local depth = #path

		while depth > 0 do

			local partial = {}

			for index = 1, depth do
				partial[index] = path[index]
			end

			scene[AceDocument.pathKey(partial)] = true
			depth -= 1
		end
	end

	for _, record in ipairs(entities) do
		record.scene = scene[record.key] == true
	end

	return { components = components, entities = entities, errors = errors }
end

-- Identity is the declared id where present, else the element path, so that
-- renaming a component does not destroy and rebuild it.
function AceDocument.identity(record: { id: any, key: string }): string

	if record.id ~= nil then
		return "#" .. tostring(record.id)
	end

	return record.key
end

return AceDocument
