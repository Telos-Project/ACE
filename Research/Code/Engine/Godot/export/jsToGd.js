/*

	jsToGd — turns an ACE agnostic script written in JavaScript into one
	written in GDScript.

	An agnostic script is the body of a function taking a serialisation of the
	document and the path of the script within it, and returning either nothing
	or a patch. Nothing in that contract mentions a language, and Godot has no
	JavaScript engine on the desktop, so the honest way to run a JavaScript
	document there is to translate it at export and let GDScript run it.

	This covers the language the ACE demos are written in and nothing more. It
	refuses anything it does not understand rather than guessing, because a
	translation that is quietly wrong is worse than one that did not happen:
	the export says which construct it could not take, and the script is left
	in JavaScript for a bridge to run.

	What it does not do is check that the result behaves the same. The emitted
	GDScript is parsed and scope checked, so it is known to be a program; that
	it is the same program is argued for below, construct by construct, and not
	demonstrated.

*/

const acorn = require("acorn");

const KEYWORDS = new Set([
	"if", "elif", "else", "for", "while", "match", "return", "var", "const",
	"func", "static", "class", "class_name", "extends", "enum", "signal",
	"and", "or", "not", "in", "is", "as", "pass", "break", "continue",
	"await", "self", "super", "null", "true", "false", "void", "when",
	"assert", "breakpoint", "range", "load", "preload", "print"
]);

/*

	Every name is prefixed. JavaScript and GDScript do not reserve the same
	words, and a script is free to call a variable `range` or `in`.

*/
const local = (name) => "_v_" + name;
const method = (name) => "_fn_" + name;

const MATH = {
	min: "min", max: "max", abs: "abs", floor: "floor", ceil: "ceil",
	round: "round", sqrt: "sqrt", sin: "sin", cos: "cos", tan: "tan",
	atan2: "atan2", pow: "pow", sign: "sign", log: "log", exp: "exp"
};

class Unsupported extends Error {

	constructor(node, why) {

		super(why + " (" + node.type + ")");

		this.node = node;
	}
}

class Translator {

	constructor() {

		this.lines = [];
		this.methods = [];
		this.members = new Set();
		this.depth = 1;
		this.temps = 0;
	}

	// ------------------------------------------------------------- writing

	write(text) {

		this.lines.push("\t".repeat(this.depth) + text);
	}

	blank() {

		this.lines.push("");
	}

	temp() {

		this.temps++;

		return "_t" + this.temps;
	}

	/* One function, however it was written: declared, or an arrow given a name. */
	define(name, node) {

		if(node.async || node.generator)
			throw new Unsupported(node, "an async or generator function is not translated");

		if(node.params.some(entry => entry.type !== "Identifier"))
			throw new Unsupported(node, "only plain parameters are taken");

		let inner = new Translator();

		inner.top = false;
		inner.members = this.members;
		inner.functions = this.functions;
		inner.depth = 1;

		if(node.body.type === "BlockStatement")
			inner.block(node.body.body);
		else
			inner.write("return " + inner.expression(node.body));

		this.methods.push({
			name: method(name),
			params: node.params.map(entry => local(entry.name)),
			lines: inner.lines,
			methods: inner.methods
		});
	}

	// ---------------------------------------------------------- statements

	block(body) {

		if(body.length === 0) {

			this.write("pass");

			return;
		}

		body.forEach(node => this.statement(node));
	}

	statement(node) {

		switch(node.type) {

			case "VariableDeclaration":

				node.declarations.forEach(entry => {

					if(entry.id.type !== "Identifier")
						throw new Unsupported(entry, "only plain names may be declared");

					/*

						An arrow given a name is a function. Written in place it
						is a lambda, and the difference is what a script means
						by it: a named one is called, and the ones written in
						place are handed to filter and its kin.

					*/
					if(entry.init != null &&
						(entry.init.type === "ArrowFunctionExpression" ||
							entry.init.type === "FunctionExpression")) {

						this.define(entry.id.name, entry.init);

						return;
					}

					let name = local(entry.id.name);

					/*

						Declared at the top of the script rather than where it
						stands, so that a nested function can see it: JavaScript
						closes over the scope it was written in, and a GDScript
						method can only see the object it belongs to.

					*/
					if(this.depth === 1 && this.top) {

						this.members.add(name);

						this.write(name + " = " + (entry.init
							? this.expression(entry.init) : "null"));

						return;
					}

					this.write("var " + name + " = " + (entry.init
						? this.expression(entry.init) : "null"));
				});

				return;

			case "ExpressionStatement":

				/* A callback that mutates what it can see is a loop, not a
				   lambda: GDScript captures by value and the writes would be
				   lost. */
				if(this.forEachLoop(node.expression))
					return;

				this.write(this.expression(node.expression));

				return;

			case "ReturnStatement":

				this.write("return " + (node.argument
					? this.expression(node.argument) : "null"));

				return;

			case "IfStatement": {

				this.write("if " + this.truthy(node.test) + ":");
				this.depth++;
				this.block(node.consequent.type === "BlockStatement"
					? node.consequent.body : [node.consequent]);
				this.depth--;

				if(node.alternate == null)
					return;

				this.write("else:");
				this.depth++;
				this.block(node.alternate.type === "BlockStatement"
					? node.alternate.body : [node.alternate]);
				this.depth--;

				return;
			}

			case "ForOfStatement": {

				if(node.left.type !== "VariableDeclaration")
					throw new Unsupported(node, "a for of loop must declare its name");

				let name = local(node.left.declarations[0].id.name);

				this.write("for " + name + " in " + this.expression(node.right) + ":");
				this.depth++;
				this.block(node.body.type === "BlockStatement"
					? node.body.body : [node.body]);
				this.depth--;

				return;
			}

			case "ForStatement": {

				/* GDScript counts over a range, so a general loop is a while
				   with its step at the end. */
				if(node.init != null)
					this.statement(node.init.type === "VariableDeclaration"
						? node.init
						: { type: "ExpressionStatement", expression: node.init });

				this.write("while " + (node.test
					? this.truthy(node.test) : "true") + ":");

				this.depth++;

				this.block(node.body.type === "BlockStatement"
					? node.body.body : [node.body]);

				if(node.update != null)
					this.write(this.expression(node.update));

				this.depth--;

				return;
			}

			case "WhileStatement":

				this.write("while " + this.truthy(node.test) + ":");
				this.depth++;
				this.block(node.body.type === "BlockStatement"
					? node.body.body : [node.body]);
				this.depth--;

				return;

			case "BreakStatement":

				this.write("break");

				return;

			case "ContinueStatement":

				this.write("continue");

				return;

			case "BlockStatement":

				this.block(node.body);

				return;

			case "FunctionDeclaration":

				this.define(node.id.name, node);

				return;

			case "EmptyStatement":

				return;
		}

		throw new Unsupported(node, "this kind of statement is not translated");
	}

	/*

		forEach with a callback written in place becomes a loop. Everything
		else in the callback family becomes a lambda, which GDScript captures
		by value — safe for a predicate, wrong for anything that assigns
		outward, and forEach is where that is done.

	*/
	forEachLoop(node) {

		if(node.type !== "CallExpression")
			return false;

		let callee = node.callee;

		if(callee.type !== "MemberExpression" || callee.computed)
			return false;

		if(callee.property.name !== "forEach" || node.arguments.length !== 1)
			return false;

		let fn = node.arguments[0];

		if(fn.type !== "ArrowFunctionExpression" &&
			fn.type !== "FunctionExpression") {

			return false;
		}

		let over = this.expression(callee.object);
		let name = fn.params.length > 0
			? local(fn.params[0].name) : this.temp();

		if(fn.params.length > 1) {

			/* An index is asked for, so the loop counts and reads. */
			let held = this.temp();
			let index = local(fn.params[1].name);

			this.write("var " + held + " = " + over);
			this.write("for " + index + " in range(_len(" + held + ")):");
			this.depth++;
			this.write("var " + name + " = _get(" + held + ", " + index + ")");

		} else {

			this.write("for " + name + " in " + over + ":");
			this.depth++;
		}

		this.block(fn.body.type === "BlockStatement"
			? fn.body.body : [{ type: "ExpressionStatement", expression: fn.body }]);

		this.depth--;

		return true;
	}

	// --------------------------------------------------------- expressions

	truthy(node) {

		/* A comparison is already a bool; anything else is measured the way
		   JavaScript measures it. */
		if(node.type === "BinaryExpression" &&
			["===", "!==", "==", "!=", "<", ">", "<=", ">=", "instanceof", "in"]
				.includes(node.operator)) {

			return this.expression(node);
		}

		if(node.type === "LogicalExpression" && node.operator !== "??")
			return "_truthy(" + this.expression(node) + ")";

		if(node.type === "UnaryExpression" && node.operator === "!")
			return "not " + this.truthy(node.argument);

		return "_truthy(" + this.expression(node) + ")";
	}

	expression(node) {

		switch(node.type) {

			case "Literal":

				if(node.value === null) return "null";
				if(typeof node.value === "string") return JSON.stringify(node.value);
				if(typeof node.value === "boolean") return node.value ? "true" : "false";
				if(typeof node.value === "number") {

					return Number.isInteger(node.value)
						? String(node.value) : String(node.value);
				}

				throw new Unsupported(node, "this kind of value is not translated");

			case "Identifier":

				if(this.functions != null && this.functions.has(node.name))
					return "Callable(self, \"" + method(node.name) + "\")";

				if(node.name === "undefined") return "null";
				if(node.name === "state") return "state";
				if(node.name === "path") return "path";
				if(node.name === "NaN") return "NAN";
				if(node.name === "Infinity") return "INF";

				return local(node.name);

			case "ThisExpression":

				throw new Unsupported(node, "this is not translated");

			case "ArrayExpression":

				return "[" + node.elements.map(entry =>
					entry == null ? "null" : this.expression(entry)).join(", ") + "]";

			case "ObjectExpression":

				return "{" + node.properties.map(entry => {

					if(entry.type !== "Property" || entry.kind !== "init")
						throw new Unsupported(entry, "only plain fields are taken");

					let key = entry.computed
						? this.expression(entry.key)
						: (entry.key.type === "Identifier"
							? JSON.stringify(entry.key.name)
							: JSON.stringify(String(entry.key.value)));

					return key + ": " + this.expression(entry.value);

				}).join(", ") + "}";

			case "MemberExpression":

				return this.member(node);

			case "CallExpression":

				return this.call(node);

			case "UnaryExpression": {

				if(node.operator === "!")
					return "(not " + this.truthy(node.argument) + ")";

				if(node.operator === "-")
					return "(-" + this.expression(node.argument) + ")";

				if(node.operator === "+")
					return "float(" + this.expression(node.argument) + ")";

				if(node.operator === "typeof")
					return "_typeof(" + this.expression(node.argument) + ")";

				if(node.operator === "delete") {

					let target = node.argument;

					if(target.type !== "MemberExpression")
						throw new Unsupported(node, "only a field may be deleted");

					return "_erase(" + this.expression(target.object) + ", "
						+ this.key(target) + ")";
				}

				throw new Unsupported(node, "this operator is not translated");
			}

			case "UpdateExpression": {

				if(!node.prefix && node.argument.type === "Identifier") {

					let name = this.expression(node.argument);

					return name + " " + (node.operator === "++" ? "+" : "-") + "= 1";
				}

				throw new Unsupported(node, "this update is not translated");
			}

			case "BinaryExpression":

				return this.binary(node);

			case "LogicalExpression":

				return this.logical(node);

			case "ConditionalExpression":

				return "(" + this.expression(node.consequent) + " if "
					+ this.truthy(node.test) + " else "
					+ this.expression(node.alternate) + ")";

			case "AssignmentExpression":

				return this.assign(node);

			case "ArrowFunctionExpression":
			case "FunctionExpression":

				return this.lambda(node);

			case "SequenceExpression":

				throw new Unsupported(node, "a comma expression is not translated");
		}

		throw new Unsupported(node, "this kind of expression is not translated");
	}

	key(node) {

		return node.computed
			? this.expression(node.property)
			: JSON.stringify(node.property.name);
	}

	member(node) {

		let object = node.object;

		/* The libraries a script may name. */
		if(object.type === "Identifier" && !node.computed) {

			if(object.name === "Math") {

				if(node.property.name === "PI") return "PI";
				if(node.property.name === "E") return "exp(1.0)";
			}
		}

		if(!node.computed && node.property.name === "length")
			return "_len(" + this.expression(object) + ")";

		/*

			A field that is not there reads as nothing in JavaScript, and a
			subscript that is not there is an error in GDScript, so every read
			goes through a lookup that answers null.

		*/
		return "_get(" + this.expression(object) + ", " + this.key(node) + ")";
	}

	binary(node) {

		let left = this.expression(node.left);
		let right = this.expression(node.right);

		switch(node.operator) {

			case "+":
				/* Either side may be a string, and GDScript will not add a
				   string to a number. */
				return "_add(" + left + ", " + right + ")";

			case "-": case "*":
				return "(" + left + " " + node.operator + " " + right + ")";

			case "/":
				/* Two integers divide to an integer in GDScript and to a
				   number in JavaScript. */
				return "_div(" + left + ", " + right + ")";

			case "%":
				return "_mod(" + left + ", " + right + ")";

			case "===": case "==":
				return "(" + left + " == " + right + ")";

			case "!==": case "!=":
				return "(" + left + " != " + right + ")";

			case "<": case ">": case "<=": case ">=":
				return "(" + left + " " + node.operator + " " + right + ")";

			case "in":
				return "_has(" + right + ", " + left + ")";

			case "instanceof":
				throw new Unsupported(node, "instanceof is not translated");
		}

		throw new Unsupported(node, "this operator is not translated");
	}

	/*

		JavaScript's and and or answer with one of their operands rather than
		with a bool, and they do not evaluate the second unless they must.
		Wrapping the right hand side in a lambda keeps both of those true.

	*/
	logical(node) {

		let left = this.expression(node.left);
		let right = "func(): return " + this.expression(node.right);

		if(node.operator === "||")
			return "_or(" + left + ", " + right + ")";

		if(node.operator === "&&")
			return "_and(" + left + ", " + right + ")";

		if(node.operator === "??")
			return "_nullish(" + left + ", " + right + ")";

		throw new Unsupported(node, "this operator is not translated");
	}

	assign(node) {

		let target = node.left;

		if(target.type === "Identifier") {

			let name = this.expression(target);

			if(node.operator === "=")
				return name + " = " + this.expression(node.right);

			return name + " = " + this.compound(
				node.operator, name, this.expression(node.right));
		}

		if(target.type !== "MemberExpression")
			throw new Unsupported(node, "only a name or a field may be assigned");

		let object = this.expression(target.object);
		let key = this.key(target);

		if(node.operator === "=") {

			return "_put(" + object + ", " + key + ", "
				+ this.expression(node.right) + ")";
		}

		return "_put(" + object + ", " + key + ", " + this.compound(
			node.operator, "_get(" + object + ", " + key + ")",
			this.expression(node.right)) + ")";
	}

	compound(operator, left, right) {

		switch(operator) {

			case "+=": return "_add(" + left + ", " + right + ")";
			case "-=": return "(" + left + " - " + right + ")";
			case "*=": return "(" + left + " * " + right + ")";
			case "/=": return "_div(" + left + ", " + right + ")";
			case "%=": return "_mod(" + left + ", " + right + ")";
		}

		throw new Error("this assignment is not translated: " + operator);
	}

	lambda(node) {

		if(node.async || node.generator)
			throw new Unsupported(node, "an async or generator function is not translated");

		if(node.body.type === "BlockStatement") {

			let body = node.body.body;

			if(body.length !== 1 || body[0].type !== "ReturnStatement") {

				throw new Unsupported(node,
					"a callback of more than one line is only taken by forEach");
			}

			return "func(" + node.params.map(entry => local(entry.name)).join(", ")
				+ "): return " + this.expression(body[0].argument);
		}

		return "func(" + node.params.map(entry => local(entry.name)).join(", ")
			+ "): return " + this.expression(node.body);
	}

	call(node) {

		let callee = node.callee;
		let args = node.arguments.map(entry => this.expression(entry));

		if(node.arguments.some(entry => entry.type === "SpreadElement"))
			throw new Unsupported(node, "spread is not translated");

		if(callee.type === "Identifier") {

			if(callee.name === "parseInt") return "int(" + args[0] + ")";
			if(callee.name === "parseFloat") return "float(" + args[0] + ")";
			if(callee.name === "isNaN") return "is_nan(float(" + args[0] + "))";
			if(callee.name === "String") return "str(" + args[0] + ")";
			if(callee.name === "Number") return "float(" + args[0] + ")";
			if(callee.name === "Boolean") return "_truthy(" + args[0] + ")";

			if(this.functions != null && !this.functions.has(callee.name)) {

				throw new Unsupported(node,
					"nothing named " + callee.name + " is defined in this script");
			}

			return method(callee.name) + "(" + args.join(", ") + ")";
		}

		if(callee.type !== "MemberExpression")
			throw new Unsupported(node, "this call is not translated");

		let name = callee.computed ? null : callee.property.name;
		let host = callee.object;

		if(host.type === "Identifier" && !callee.computed) {

			if(host.name === "Math" && MATH[name] != null) {

				if(name === "min" || name === "max")
					return MATH[name] + "(" + args.join(", ") + ")";

				return MATH[name] + "(" + args.map(a => "float(" + a + ")").join(", ") + ")";
			}

			if(host.name === "Math" && name === "hypot")
				return "_hypot([" + args.join(", ") + "])";

			if(host.name === "Math" && name === "random")
				return "randf()";

			if(host.name === "JSON" && name === "parse")
				return "JSON.parse_string(" + args[0] + ")";

			if(host.name === "JSON" && name === "stringify")
				return "JSON.stringify(" + args[0] + ")";

			if(host.name === "Object" && name === "keys")
				return "_keys(" + args[0] + ")";

			if(host.name === "Object" && name === "values")
				return "_values(" + args[0] + ")";

			if(host.name === "Object" && name === "assign")
				return "_assign([" + args.join(", ") + "])";

			if(host.name === "Array" && name === "isArray")
				return "(" + args[0] + " is Array)";
		}

		let object = this.expression(host);

		switch(name) {

			case "push": return "_push(" + object + ", " + args.join(", ") + ")";
			case "pop": return "_pop(" + object + ")";
			case "shift": return "_shift(" + object + ")";
			case "indexOf": return "_index_of(" + object + ", " + args[0] + ")";
			case "includes": return "(_index_of(" + object + ", " + args[0] + ") >= 0)";
			case "join": return "_join(" + object + ", " + (args[0] || '""') + ")";
			case "slice": return "_slice(" + object + ", " + (args[0] || "0")
				+ ", " + (args[1] != null ? args[1] : "null") + ")";
			case "concat": return "_concat(" + object + ", " + args[0] + ")";
			case "toFixed": return "_fixed(" + object + ", " + (args[0] || "0") + ")";
			case "toString": return "str(" + object + ")";
			case "toLowerCase": return "str(" + object + ").to_lower()";
			case "toUpperCase": return "str(" + object + ").to_upper()";
			case "map": return "_map(" + object + ", " + args[0] + ")";
			case "filter": return "_filter(" + object + ", " + args[0] + ")";
			case "some": return "_some(" + object + ", " + args[0] + ")";
			case "every": return "_every(" + object + ", " + args[0] + ")";
			case "find": return "_find(" + object + ", " + args[0] + ")";
			case "findIndex": return "_find_index(" + object + ", " + args[0] + ")";
			case "sort": return "_sort(" + object + ", " + (args[0] || "null") + ")";
			case "reverse": return "_reverse(" + object + ")";
			case "reduce": return "_reduce(" + object + ", " + args[0]
				+ ", " + (args[1] != null ? args[1] : "null") + ")";
			case "split": return "_split(" + object + ", " + args[0] + ")";
			case "substring": return "_slice(" + object + ", " + args[0]
				+ ", " + (args[1] != null ? args[1] : "null") + ")";
			case "forEach":

				throw new Unsupported(node,
					"forEach is only taken where its result is not used");
		}

		throw new Unsupported(node, "the method " + name + " is not translated");
	}
}

/*

	The helpers every translated script carries. They are what makes the
	emitted code mean what the JavaScript meant: a lookup that answers nothing
	rather than failing, an addition that knows about strings, a division that
	does not round, and an or that answers with a value.

*/
const HELPERS = `

## --- what JavaScript means by these, written out once ---

func _truthy(v) -> bool:
	if v == null:
		return false
	if v is bool:
		return v
	if v is int or v is float:
		return v != 0
	if v is String:
		return v != ""
	if v is Array or v is Dictionary:
		return true
	return true


func _or(a, b: Callable):
	return a if _truthy(a) else b.call()


func _and(a, b: Callable):
	return b.call() if _truthy(a) else a


func _nullish(a, b: Callable):
	return b.call() if a == null else a


func _get(o, k):
	if o == null:
		return null
	if o is Dictionary:
		return o.get(k)
	if o is Array:
		var i = int(k) if (k is int or k is float) else -1
		return o[i] if i >= 0 and i < o.size() else null
	if o is String:
		var i = int(k) if (k is int or k is float) else -1
		return o[i] if i >= 0 and i < o.length() else null
	return null


func _put(o, k, value):
	if o is Dictionary:
		o[k] = value
	elif o is Array and (k is int or k is float):
		var i = int(k)
		while o.size() <= i:
			o.append(null)
		o[i] = value
	return value


func _erase(o, k) -> bool:
	if o is Dictionary:
		return o.erase(k)
	return false


func _has(o, k) -> bool:
	if o is Dictionary:
		return o.has(k)
	if o is Array:
		return o.has(k)
	return false


func _len(o) -> int:
	if o == null:
		return 0
	if o is String:
		return o.length()
	if o is Array or o is Dictionary:
		return o.size()
	return 0


func _add(a, b):
	if a is String or b is String:
		return _text(a) + _text(b)
	if a == null:
		a = 0
	if b == null:
		b = 0
	return a + b


func _text(v) -> String:
	if v == null:
		return "null"
	if v is bool:
		return "true" if v else "false"
	if v is float and v == floor(v) and abs(v) < 1000000000000000.0:
		return str(int(v))
	return str(v)


func _div(a, b):
	return float(a) / float(b)


func _mod(a, b):
	if a is int and b is int:
		return a % b
	return fmod(float(a), float(b))


func _typeof(v) -> String:
	if v == null:
		return "undefined"
	if v is bool:
		return "boolean"
	if v is int or v is float:
		return "number"
	if v is String:
		return "string"
	return "object"


func _keys(o) -> Array:
	if o is Dictionary:
		return o.keys()
	if o is Array:
		var out = []
		for i in range(o.size()):
			out.append(str(i))
		return out
	return []


func _values(o) -> Array:
	if o is Dictionary:
		return o.values()
	if o is Array:
		return o.duplicate()
	return []


func _assign(parts: Array):
	var out = parts[0] if parts.size() > 0 and parts[0] is Dictionary else {}
	for i in range(1, parts.size()):
		var each = parts[i]
		if each is Dictionary:
			for k in each.keys():
				out[k] = each[k]
	return out


func _push(o, v):
	if o is Array:
		o.append(v)
		return o.size()
	return 0


func _pop(o):
	if o is Array and o.size() > 0:
		return o.pop_back()
	return null


func _shift(o):
	if o is Array and o.size() > 0:
		return o.pop_front()
	return null


func _index_of(o, v) -> int:
	if o is Array:
		return o.find(v)
	if o is String:
		return o.find(str(v))
	return -1


func _join(o, sep) -> String:
	if not (o is Array):
		return ""
	var parts = []
	for each in o:
		parts.append(_text(each))
	return sep.join(parts)


func _slice(o, from, upto):
	var size = _len(o)
	var a = int(from)
	if a < 0:
		a = max(0, size + a)
	var b = size if upto == null else int(upto)
	if b < 0:
		b = max(0, size + b)
	b = min(b, size)
	if a >= b:
		return "" if o is String else []
	if o is String:
		return o.substr(a, b - a)
	if o is Array:
		return o.slice(a, b)
	return []


func _concat(o, other):
	if o is Array and other is Array:
		return o + other
	if o is Array:
		return o + [other]
	return o


func _fixed(v, places) -> String:
	return String.num(float(v), int(places))


func _split(o, sep) -> Array:
	if not (o is String):
		return []
	return Array(o.split(str(sep)))


func _map(o, fn: Callable) -> Array:
	var out = []
	if o is Array:
		for each in o:
			out.append(fn.call(each))
	return out


func _filter(o, fn: Callable) -> Array:
	var out = []
	if o is Array:
		for each in o:
			if _truthy(fn.call(each)):
				out.append(each)
	return out


func _some(o, fn: Callable) -> bool:
	if o is Array:
		for each in o:
			if _truthy(fn.call(each)):
				return true
	return false


func _every(o, fn: Callable) -> bool:
	if o is Array:
		for each in o:
			if not _truthy(fn.call(each)):
				return false
	return true


func _find(o, fn: Callable):
	if o is Array:
		for each in o:
			if _truthy(fn.call(each)):
				return each
	return null


func _find_index(o, fn: Callable) -> int:
	if o is Array:
		for i in range(o.size()):
			if _truthy(fn.call(o[i])):
				return i
	return -1


func _sort(o, fn):
	if not (o is Array):
		return o
	if fn == null:
		o.sort()
	else:
		o.sort_custom(func(a, b): return float(fn.call(a, b)) < 0.0)
	return o


func _reverse(o):
	if o is Array:
		o.reverse()
	return o


func _reduce(o, fn: Callable, start):
	var total = start
	if o is Array:
		var first = 0
		if total == null and o.size() > 0:
			total = o[0]
			first = 1
		for i in range(first, o.size()):
			total = fn.call(total, o[i])
	return total


func _hypot(parts: Array) -> float:
	var total = 0.0
	for each in parts:
		total += float(each) * float(each)
	return sqrt(total)
`;

/*

	Translates one script body. Returns the GDScript that the runtime's script
	host expects: a class with a run of state and path.

*/
const translate = (source) => {

	let tree;

	try {

		tree = acorn.parse("function __ace(state, path) {\n" + source + "\n}", {
			ecmaVersion: 2022
		});

	} catch(error) {

		throw new Error("could not read the JavaScript: " + error.message);
	}

	let body = tree.body[0].body.body;

	/*

		Gathered first, so that a script may call a function written further
		down, as JavaScript allows.

	*/
	let functions = new Set();

	const gather = (node) => {

		if(node == null || typeof node !== "object")
			return;

		if(Array.isArray(node))
			return node.forEach(gather);

		if(node.type === "FunctionDeclaration" && node.id != null)
			functions.add(node.id.name);

		if(node.type === "VariableDeclarator" && node.id.type === "Identifier" &&
			node.init != null &&
			(node.init.type === "ArrowFunctionExpression" ||
				node.init.type === "FunctionExpression")) {

			functions.add(node.id.name);
		}

		Object.keys(node).forEach(key => gather(node[key]));
	};

	gather(body);

	let translator = new Translator();

	translator.top = true;
	translator.depth = 1;
	translator.functions = functions;

	translator.block(body);

	let out = ["extends RefCounted", ""];

	if(translator.members.size > 0) {

		out.push("## The script's own names, held on the object so that a");
		out.push("## function written inside it can see them, as it could in");
		out.push("## JavaScript.");

		[...translator.members].forEach(name => out.push("var " + name + " = null"));

		out.push("");
	}

	out.push("func run(state: String, path: String) -> Variant:");
	out.push(...translator.lines);
	out.push("\treturn null");

	const emit = (holder) => {

		holder.methods.forEach(entry => {

			out.push("");
			out.push("");
			out.push("func " + entry.name + "(" + entry.params.join(", ") + ") -> Variant:");

			if(entry.lines.length === 0)
				out.push("\tpass");
			else
				out.push(...entry.lines);

			out.push("\treturn null");

			emit(entry);
		});
	};

	emit(translator);

	out.push(HELPERS);

	return out.join("\n");
};

module.exports = { translate, Unsupported };
