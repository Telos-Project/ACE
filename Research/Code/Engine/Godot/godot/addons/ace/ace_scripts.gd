## Where a document's scripts are run.
##
## ACE agnostic scripts are function bodies taking a serialisation of the whole
## document and the path of the script within it, and returning either nothing
## or a patch. That contract is language agnostic by design, so the host simply
## needs one runner per language.
##
## GDScript is native. JavaScript needs a bridge, since Godot has no JavaScript
## engine of its own: any GDExtension exposing a `JavaScriptBridge`-shaped
## `eval` will do, and the web export has one already. Where none is present,
## a JavaScript script reports that plainly rather than failing silently.
extends RefCounted

## Every member says what it is, so that none of them can be nothing.
var _compiled: Dictionary = {}
var _runs: Dictionary = {}
var _js_host = null
var _js_looked: bool = false


## The bridge, if there is one. Godot's own JavaScriptBridge exists on a web
## export; a desktop build needs a GDExtension such as GodotJS, which is
## detected by the same shape rather than by name.
func _javascript() -> Variant:
	if _js_looked:
		return _js_host

	_js_looked = true

	if Engine.has_singleton("JavaScriptBridge"):
		_js_host = Engine.get_singleton("JavaScriptBridge")
	elif ClassDB.class_exists("JavaScriptBridge"):
		_js_host = ClassDB.instantiate("JavaScriptBridge")
	elif Engine.has_singleton("GodotJS"):
		_js_host = Engine.get_singleton("GodotJS")
	elif Engine.has_singleton("JavaScript"):
		_js_host = Engine.get_singleton("JavaScript")

	return _js_host


func run(_runtime, record: Dictionary, document: Dictionary) -> Dictionary:
	var data: Dictionary = record["data"]
	var language = str(data.get("language", "js")).to_lower()
	var mode = str(data.get("mode", "blunt")).to_lower()

	if mode != "blunt":
		return {"error": "unimplemented script mode: " + mode}

	var element: Dictionary = record["element"]
	var code = element.get("content")

	if not (code is String):
		return {"error": "script source has not been loaded"
			if element.get("source") != null else "script has no content"}

	var id: String = record["key"]
	var state = JSON.stringify(document)
	var path = JSON.stringify(record["path"])

	_runs[id] = int(_runs.get(id, 0)) + 1

	match language:
		"gdscript", "gd":
			return _gdscript(id, code, state, path)
		"js", "javascript":
			return _js(id, code, state, path)

	return {"error": "unsupported script language: " + language}


## A GDScript agnostic script is the body of a function taking `state` and
## `path`, exactly as the JavaScript one is. It is wrapped and compiled once.
func _gdscript(id: String, code: String, state: String,
		path: String) -> Dictionary:

	if not _compiled.has(id) or _compiled[id]["source"] != code:
		var body = ""

		for line in code.split("\n"):
			body += "\t" + line + "\n"

		var source = (
			"extends RefCounted\n"
			+ "func run(state: String, path: String):\n"
			+ body
			+ "\treturn null\n"
		)

		var made = GDScript.new()
		made.source_code = source

		var problem = made.reload()

		if problem != OK:
			return {"error": "compile failed with code " + str(problem)}

		_compiled[id] = {"source": code, "script": made, "instance": made.new()}

	var host = _compiled[id]["instance"]
	var output = host.run(state, path)

	if output == null:
		return {"output": null, "runs": _runs[id]}

	if output is Dictionary or output is Array:
		output = JSON.stringify(output)

	return {"output": str(output), "runs": _runs[id]}


func _js(id: String, code: String, state: String, path: String) -> Dictionary:
	var host = _javascript()

	if host == null:
		return {"error":
			"no JavaScript engine is available. Install a bridge such as "
			+ "GodotJS, or export for the web, or declare the script as "
			+ "gdscript."}

	## The body is wrapped once into a named function on the host, and then
	## called with the frame's arguments. Rebuilding the function every frame
	## would recompile the whole script on every tick.
	if not _compiled.has(id) or _compiled[id]["source"] != code:
		var name = "__ace_" + id.sha256_text().substr(0, 16)

		var wrapper = (
			"globalThis[" + JSON.stringify(name) + "] = "
			+ "function (state, path) {\n" + code + "\n};"
		)

		var problem = host.eval(wrapper, true)

		if problem is String and problem.begins_with("SyntaxError"):
			return {"error": problem}

		_compiled[id] = {"source": code, "name": name}

	var call = (
		"globalThis[" + JSON.stringify(_compiled[id]["name"]) + "]("
		+ JSON.stringify(state) + ", " + JSON.stringify(path) + ")"
	)

	var output = host.eval(call, true)

	if output == null:
		return {"output": null, "runs": _runs[id]}

	return {"output": str(output), "runs": _runs[id]}
