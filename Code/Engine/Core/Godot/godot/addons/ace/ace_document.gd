## ACE document handling: resolution, element paths, and merge patching.
##
## This is the GDScript half of the same core that runs under the browser
## adapter. It knows nothing about Godot: it turns an APInt document into a set
## of components and entities, and applies patches back to it.
extends RefCounted

const TAG = "telos-ace"
const RESERVED = "engine"

## Fields the engine may write to a data object. The sole exception to the
## authority rule; see standard section 2.2.4.
const CONSUMABLE = {
	"": ["position", "rotation", "scale"],
	"body": ["impulse", "torque", "teleport"],
	"audio": ["play", "stop", "seek"],
	"animation": ["play", "stop", "seek"],
	"controller": ["haptic"],
	"display": ["fullscreen", "capture"]
}


func is_object(value) -> bool:
	return value is Dictionary


func path_key(path: Array) -> String:
	return JSON.stringify(path)


func parse_path(path) -> Array:
	if path is Array:
		return path.duplicate()
	if path is String:
		return Array(path.split("."))
	return []


## RFC 7386. Objects merge recursively, null deletes, arrays and primitives
## replace wholesale.
func merge(target, patch) -> Variant:
	if not (patch is Dictionary):
		return _clone(patch)

	if not (target is Dictionary):
		target = {}

	for key in patch.keys():
		if patch[key] == null:
			target.erase(key)
			continue

		target[key] = merge(target.get(key), patch[key])

	return target


func _clone(value) -> Variant:
	if value is Dictionary or value is Array:
		return value.duplicate(true)
	return value


func _has_id(element, alias: String) -> bool:
	if not (element is Dictionary):
		return false

	var props = element.get("properties")

	if not (props is Dictionary):
		return false

	var id = props.get("id")

	if id == null and props.get("meta") is Dictionary:
		id = props["meta"].get("id")

	if id is Array:
		return alias in id

	return id == alias


## Resolves an APInt element path against a package. Adjacent aliases need not
## be immediate parent and child, so each is searched for breadth first among
## descendants. Honours the ID property protocol.
func get_element(pkg, path) -> Dictionary:
	var steps = parse_path(path)
	var current = {"element": pkg, "path": []}

	for alias in steps:
		var found = null
		var queue = [current]

		while queue.size() > 0 and found == null:
			var node = queue.pop_front()
			var element = node["element"]

			if not (element is Dictionary):
				continue

			for field in ["utilities", "packages"]:
				if not (element.get(field) is Dictionary):
					continue

				for key in element[field].keys():
					var child = element[field][key]
					var entry = {
						"element": child,
						"path": node["path"] + [key]
					}

					if key == alias or _has_id(child, alias):
						found = entry
						break

					queue.append(entry)

				if found != null:
					break

		if found == null:
			return {}

		current = found

	return current


func _inherit(parent: Dictionary, own) -> Dictionary:
	var result = parent.duplicate()

	if own is Dictionary:
		for key in own.keys():
			if key == "meta":
				continue
			result[key] = own[key]

	return result


## Walks the document and returns every component and entity, with package
## properties bubbled down to descendants. The meta field is excluded from
## bubbling.
##
## A utility without the tag is not a component and is left alone: it stays in
## the document for scripts to read. A package with no component anywhere
## beneath it is not part of the scene, and is marked so that no node is built
## for it.
func collect(doc) -> Dictionary:
	var components = []
	var entities = []
	var errors = []

	_walk(doc, [], {}, false, components, entities, errors)

	var scene = {}

	for record in components:
		var path: Array = record["entity"]
		var depth = path.size()

		while depth > 0:
			scene[path_key(path.slice(0, depth))] = true
			depth -= 1

	for record in entities:
		record["scene"] = scene.has(record["key"])

	return {"components": components, "entities": entities, "errors": errors}


func _walk(pkg, path: Array, inherited: Dictionary, reserved: bool,
		components: Array, entities: Array, errors: Array) -> void:

	if pkg is String:
		errors.append({
			"path": path,
			"message": "unresolved package reference: " + pkg
		})
		return

	if not (pkg is Dictionary):
		return

	var props = _inherit(inherited, pkg.get("properties"))
	var meta = {}

	if pkg.get("properties") is Dictionary:
		if pkg["properties"].get("meta") is Dictionary:
			meta = pkg["properties"]["meta"]

	if path.size() > 0:
		var tags = meta.get("tags")
		var data = meta.get("data")

		entities.append({
			"kind": "entity",
			"path": path,
			"key": path_key(path),
			"id": _first_id(meta.get("id")),
			"element": pkg,
			"meta": meta,
			"tags": tags if tags is Array else [],
			"data": data if data is Dictionary else {},
			"reserved": reserved,
			"scene": true
		})

	if pkg.get("utilities") is Dictionary:
		for key in pkg["utilities"].keys():
			var utility = pkg["utilities"][key]

			if not (utility is Dictionary):
				continue

			var uprops = _inherit(props, utility.get("properties"))
			var utility_tags = uprops.get("tags")

			if not (utility_tags is Array) or not (TAG in utility_tags) or utility_tags.is_empty():
				continue

			if utility_tags[0] == TAG:
				errors.append({
					"path": path + [key],
					"message": "component has no primary tag"
				})
				continue

			var utility_data = uprops.get("data")

			components.append({
				"kind": "component",
				"type": utility_tags[0],
				"path": path + [key],
				"key": path_key(path + [key]),
				"id": _first_id(uprops.get("id")),
				"entity": path,
				"entityKey": path_key(path),
				"element": utility,
				"properties": uprops,
				"tags": utility_tags,
				"data": utility_data if utility_data is Dictionary else {},
				"reserved": reserved
			})

	if pkg.get("packages") is Dictionary:
		for key in pkg["packages"].keys():
			_walk(
				pkg["packages"][key],
				path + [key],
				props,
				reserved or (path.is_empty() and key == RESERVED),
				components, entities, errors
			)


func _first_id(id) -> Variant:
	if id is Array:
		return id[0] if id.size() > 0 else null
	return id


## Identity is the declared id where present, else the element path, so that
## renaming a component does not destroy and rebuild it.
func identity(record: Dictionary) -> String:
	if record.get("id") != null:
		return "#" + str(record["id"])
	return record["key"]
