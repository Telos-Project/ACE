/*

	jsToLuau — turns an ACE agnostic script written in JavaScript into one
	written in Luau, so it can run on the Roblox adapter the same way
	jsToGd.js lets a JavaScript script run on the Godot one.

	The two transpilers solve related problems but Luau's own rules are
	different enough from GDScript's that little of the actual emission
	logic is shared — the design is the same (walk an acorn AST, refuse
	anything outside a known subset, lean on a small helper library for the
	places JavaScript and Luau quietly disagree about what a value means),
	not the code.

	Two disagreements matter enough to call out once, here, rather than
	rediscover at every call site below:

	- Lua's only falsy values are nil and false. 0 and "" are truthy. Every
	  place JavaScript's own truthiness would matter — an if, a ternary, a
	  && or || — goes through a helper that judges truthiness the way
	  JavaScript does, not the way Luau's own if statement would on its own.

	- Luau's .. operator concatenates strings and does not coerce a number
	  the way JavaScript's + silently does. Every + goes through a helper
	  that decides, at the value's actual type, whether this was addition or
	  concatenation — the same problem jsToGd.js solved for GDScript's own
	  string type, solved the same way here.

	Roblox's own JSON functions live on HttpService, not as bare globals —
	the exporter already provides a local HttpService for exactly this
	reason, and JSON.parse/JSON.stringify are translated assuming it is in
	scope.

*/

const acorn = require("acorn");

class Unsupported extends Error {

	constructor(node, why) {

		super(why + " (" + node.type + ")");

		this.node = node;
	}
}

const local = (name) => "_v_" + name;
const method = (name) => "_fn_" + name;

const MATH = {
	min: "min", max: "max", abs: "abs", floor: "floor", ceil: "ceil",
	round: "round", sqrt: "sqrt", sin: "sin", cos: "cos", tan: "tan",
	atan2: "atan2", pow: "pow", sign: "sign", log: "log", exp: "exp"
};

class Translator {

	constructor() {

		this.lines = [];
		this.locals = new Set();
		this.depth = 1;
		this.temps = 0;
	}

	write(text) { this.lines.push("\t".repeat(this.depth) + text); }

	temp() { this.temps++; return "_t" + this.temps; }

	// ------------------------------------------------------------- blocks

	block(body) {

		if(body.length === 0) { this.write("-- (nothing)"); return; }

		body.forEach(node => this.statement(node));
	}

	statement(node) {

		switch(node.type) {

			case "VariableDeclaration":

				node.declarations.forEach(entry => {

					if(entry.id.type !== "Identifier")
						throw new Unsupported(entry, "only plain names may be declared");

					if(entry.init != null &&
						(entry.init.type === "ArrowFunctionExpression" ||
							entry.init.type === "FunctionExpression")) {

						this.define(entry.id.name, entry.init);

						return;
					}

					let name = local(entry.id.name);

					this.locals.add(name);

					this.write("local " + name + " = " + (entry.init
						? this.expression(entry.init) : "nil"));
				});

				return;

			case "ExpressionStatement":

				if(this.forEachLoop(node.expression)) return;

				this.write(this.expression(node.expression));

				return;

			case "ReturnStatement":

				this.write("return " + (node.argument
					? this.expression(node.argument) : "nil"));

				return;

			case "IfStatement": {

				this.write("if " + this.truthy(node.test) + " then");
				this.depth++;
				this.block(node.consequent.type === "BlockStatement"
					? node.consequent.body : [node.consequent]);
				this.depth--;

				let alternate = node.alternate;

				while(alternate != null && alternate.type === "IfStatement") {

					this.write("elseif " + this.truthy(alternate.test) + " then");
					this.depth++;
					this.block(alternate.consequent.type === "BlockStatement"
						? alternate.consequent.body : [alternate.consequent]);
					this.depth--;

					alternate = alternate.alternate;
				}

				if(alternate != null) {

					this.write("else");
					this.depth++;
					this.block(alternate.type === "BlockStatement"
						? alternate.body : [alternate]);
					this.depth--;
				}

				this.write("end");

				return;
			}

			case "ForOfStatement": {

				if(node.left.type !== "VariableDeclaration")
					throw new Unsupported(node, "a for of loop must declare its name");

				let name = local(node.left.declarations[0].id.name);

				this.locals.add(name);

				this.write("for _, " + name + " in ipairs(" +
					this.expression(node.right) + ") do");
				this.depth++;
				this.block(node.body.type === "BlockStatement"
					? node.body.body : [node.body]);
				this.depth--;
				this.write("end");

				return;
			}

			case "ForStatement": {

				if(node.init != null)
					this.statement(node.init.type === "VariableDeclaration"
						? node.init
						: { type: "ExpressionStatement", expression: node.init });

				this.write("while " + (node.test
					? this.truthy(node.test) : "true") + " do");
				this.depth++;
				this.block(node.body.type === "BlockStatement"
					? node.body.body : [node.body]);

				if(node.update != null)
					this.write(this.expression(node.update));

				this.depth--;
				this.write("end");

				return;
			}

			case "WhileStatement":

				this.write("while " + this.truthy(node.test) + " do");
				this.depth++;
				this.block(node.body.type === "BlockStatement"
					? node.body.body : [node.body]);
				this.depth--;
				this.write("end");

				return;

			case "BreakStatement": this.write("break"); return;

			// Luau has no continue keyword outside a loop's own natural
			// end; ACE's demos do not use one and this refuses rather than
			// emulate one with a wrapping repeat/goto that would obscure
			// what actually runs.
			case "ContinueStatement":
				throw new Unsupported(node, "continue is not translated");

			case "BlockStatement": this.block(node.body); return;

			case "FunctionDeclaration":

				this.define(node.id.name, node);

				return;

			case "EmptyStatement": return;
		}

		throw new Unsupported(node, "this kind of statement is not translated");
	}

	define(name, node) {

		if(node.async || node.generator)
			throw new Unsupported(node, "an async or generator function is not translated");

		if(node.params.some(entry => entry.type !== "Identifier"))
			throw new Unsupported(node, "only plain parameters are taken");

		let params = node.params.map(entry => local(entry.name)).join(", ");

		// Written inline, exactly where it stood in the source — not
		// collected and hoisted to the top of the whole script. A function
		// closing over a variable declared earlier needs that variable to
		// already be a local at the point this assignment runs, or Lua
		// resolves the reference to an unrelated global with the same
		// name instead of the real upvalue. The name itself is still
		// forward declared once, at the very top, by the caller — that is
		// what lets one function call another regardless of which was
		// written first; this is what keeps a function in the place that
		// makes its own closures correct.
		this.write(method(name) + " = function(" + params + ")");
		this.depth++;

		if(node.body.type === "BlockStatement") this.block(node.body.body);
		else this.write("return " + this.expression(node.body));

		this.depth--;
		this.write("end");
	}

	forEachLoop(node) {

		if(node.type !== "CallExpression") return false;

		let callee = node.callee;

		if(callee.type !== "MemberExpression" || callee.computed) return false;
		if(callee.property.name !== "forEach" || node.arguments.length !== 1) return false;

		let fn = node.arguments[0];

		if(fn.type !== "ArrowFunctionExpression" && fn.type !== "FunctionExpression")
			return false;

		let over = this.expression(callee.object);
		let name = fn.params.length > 0 ? local(fn.params[0].name) : this.temp();
		let index = fn.params.length > 1 ? local(fn.params[1].name) : "_";

		this.locals.add(name);

		this.write("for " + index + ", " + name + " in ipairs(" + over + ") do");
		this.depth++;
		this.block(fn.body.type === "BlockStatement"
			? fn.body.body
			: [{ type: "ExpressionStatement", expression: fn.body }]);
		this.depth--;
		this.write("end");

		return true;
	}

	// -------------------------------------------------------------- truthy

	truthy(node) {

		if(node.type === "BinaryExpression" &&
			["===", "!==", "==", "!=", "<", ">", "<=", ">=", "in", "instanceof"]
				.includes(node.operator)) {

			return this.expression(node);
		}

		if(node.type === "UnaryExpression" && node.operator === "!")
			return "not " + this.truthy(node.argument);

		return "_js_truthy(" + this.expression(node) + ")";
	}

	// ---------------------------------------------------------- expression

	expression(node) {

		switch(node.type) {

			case "Literal":

				if(node.value === null) return "nil";
				if(typeof node.value === "string") return luauString(node.value);
				if(typeof node.value === "boolean") return node.value ? "true" : "false";
				if(typeof node.value === "number") return String(node.value);

				throw new Unsupported(node, "this kind of value is not translated");

			case "Identifier":

				if(node.name === "undefined") return "nil";
				if(node.name === "state" || node.name === "path") return node.name;
				if(node.name === "NaN") return "(0/0)";
				if(node.name === "Infinity") return "math.huge";

				if(this.functions != null && this.functions.has(node.name))
					return "(function(...) return " + method(node.name) + "(...) end)";

				return local(node.name);

			case "ThisExpression": throw new Unsupported(node, "this is not translated");

			case "ArrayExpression":

				return "{" + node.elements.map(entry =>
					entry == null ? "nil" : this.expression(entry)).join(", ") + "}";

			case "ObjectExpression":

				return "{" + node.properties.map(entry => {

					if(entry.type !== "Property" || entry.kind !== "init")
						throw new Unsupported(entry, "only plain fields are taken");

					let key = entry.computed
						? "[" + this.expression(entry.key) + "]"
						: "[" + luauString(entry.key.type === "Identifier"
							? entry.key.name : String(entry.key.value)) + "]";

					return key + " = " + this.expression(entry.value);

				}).join(", ") + "}";

			case "MemberExpression": return this.member(node);

			case "CallExpression": return this.call(node);

			case "UnaryExpression": {

				if(node.operator === "!") return "(not " + this.truthy(node.argument) + ")";
				if(node.operator === "-") return "(-" + this.expression(node.argument) + ")";
				if(node.operator === "+") return "tonumber(" + this.expression(node.argument) + ")";
				if(node.operator === "typeof")
					return "_js_typeof(" + this.expression(node.argument) + ")";

				if(node.operator === "delete") {

					let target = node.argument;

					if(target.type !== "MemberExpression")
						throw new Unsupported(node, "only a field may be deleted");

					return "_js_erase(" + this.expression(target.object) + ", "
						+ this.key(target) + ")";
				}

				throw new Unsupported(node, "this operator is not translated");
			}

			case "UpdateExpression": {

				if(!node.prefix && node.argument.type === "Identifier") {

					let name = this.expression(node.argument);

					return name + " = " + name + " " +
						(node.operator === "++" ? "+" : "-") + " 1";
				}

				throw new Unsupported(node, "this update is not translated");
			}

			case "BinaryExpression": return this.binary(node);

			case "LogicalExpression": return this.logical(node);

			case "ConditionalExpression":

				return "(if " + this.truthy(node.test) + " then "
					+ this.expression(node.consequent) + " else "
					+ this.expression(node.alternate) + ")";

			case "AssignmentExpression": return this.assign(node);

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
			: luauString(node.property.name);
	}

	member(node) {

		let object = node.object;

		if(object.type === "Identifier" && !node.computed) {

			if(object.name === "Math" && node.property.name === "PI") return "math.pi";
			if(object.name === "Math" && node.property.name === "E") return "math.exp(1)";
		}

		if(!node.computed && node.property.name === "length")
			return "_js_len(" + this.expression(object) + ")";

		return "_js_get(" + this.expression(object) + ", " + this.key(node) + ")";
	}

	binary(node) {

		let left = this.expression(node.left);
		let right = this.expression(node.right);

		switch(node.operator) {

			case "+": return "_js_add(" + left + ", " + right + ")";
			case "-": case "*": return "(" + left + " " + node.operator + " " + right + ")";
			case "/": return "(" + left + " / " + right + ")";
			case "%": return "_js_mod(" + left + ", " + right + ")";
			case "===": case "==": return "(" + left + " == " + right + ")";
			case "!==": case "!=": return "(" + left + " ~= " + right + ")";
			case "<": case ">": case "<=": case ">=":
				return "(" + left + " " + node.operator + " " + right + ")";
			case "in": return "_js_has(" + right + ", " + left + ")";
		}

		throw new Unsupported(node, "this operator is not translated");
	}

	logical(node) {

		let left = this.expression(node.left);
		let right = "function() return " + this.expression(node.right) + " end";

		if(node.operator === "||") return "_js_or(" + left + ", " + right + ")";
		if(node.operator === "&&") return "_js_and(" + left + ", " + right + ")";
		if(node.operator === "??") return "_js_nullish(" + left + ", " + right + ")";

		throw new Unsupported(node, "this operator is not translated");
	}

	assign(node) {

		let target = node.left;

		if(target.type === "Identifier") {

			let name = this.expression(target);

			if(node.operator === "=") return name + " = " + this.expression(node.right);

			return name + " = " + this.compound(
				node.operator, name, this.expression(node.right));
		}

		if(target.type !== "MemberExpression")
			throw new Unsupported(node, "only a name or a field may be assigned");

		let object = this.expression(target.object);
		let key = this.key(target);

		if(node.operator === "=")
			return "_js_put(" + object + ", " + key + ", " + this.expression(node.right) + ")";

		return "_js_put(" + object + ", " + key + ", " + this.compound(
			node.operator, "_js_get(" + object + ", " + key + ")",
			this.expression(node.right)) + ")";
	}

	compound(operator, left, right) {

		switch(operator) {

			case "+=": return "_js_add(" + left + ", " + right + ")";
			case "-=": return "(" + left + " - " + right + ")";
			case "*=": return "(" + left + " * " + right + ")";
			case "/=": return "(" + left + " / " + right + ")";
			case "%=": return "_js_mod(" + left + ", " + right + ")";
		}

		throw new Error("this assignment is not translated: " + operator);
	}

	lambda(node) {

		if(node.async || node.generator)
			throw new Unsupported(node, "an async or generator function is not translated");

		let params = node.params.map(entry => local(entry.name)).join(", ");

		if(node.body.type === "BlockStatement") {

			let body = node.body.body;

			if(body.length !== 1 || body[0].type !== "ReturnStatement")
				throw new Unsupported(node,
					"a callback of more than one line is only taken by forEach");

			return "(function(" + params + ") return " +
				this.expression(body[0].argument) + " end)";
		}

		return "(function(" + params + ") return " + this.expression(node.body) + " end)";
	}

	call(node) {

		let callee = node.callee;
		let args = node.arguments.map(entry => this.expression(entry));

		if(node.arguments.some(entry => entry.type === "SpreadElement"))
			throw new Unsupported(node, "spread is not translated");

		if(callee.type === "Identifier") {

			if(callee.name === "parseInt") return "math.floor(tonumber(" + args[0] + ") or 0)";
			if(callee.name === "parseFloat") return "(tonumber(" + args[0] + ") or 0)";
			if(callee.name === "isNaN") return "(tostring(" + args[0] + ") == \"nan\")";
			if(callee.name === "String") return "_js_text(" + args[0] + ")";
			if(callee.name === "Number") return "(tonumber(" + args[0] + ") or 0)";
			if(callee.name === "Boolean") return "_js_truthy(" + args[0] + ")";

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

			if(host.name === "Math" && MATH[name] != null)
				return "math." + MATH[name] + "(" + args.join(", ") + ")";

			if(host.name === "Math" && name === "hypot")
				return "_js_hypot({" + args.join(", ") + "})";

			if(host.name === "Math" && name === "random") return "math.random()";

			if(host.name === "JSON" && name === "parse")
				return "HttpService:JSONDecode(" + args[0] + ")";

			if(host.name === "JSON" && name === "stringify")
				return "HttpService:JSONEncode(" + args[0] + ")";

			if(host.name === "Object" && name === "keys")
				return "_js_keys(" + args[0] + ")";

			if(host.name === "Object" && name === "values")
				return "_js_values(" + args[0] + ")";

			if(host.name === "Object" && name === "assign")
				return "_js_assign({" + args.join(", ") + "})";

			if(host.name === "Array" && name === "isArray")
				return "_js_isArray(" + args[0] + ")";
		}

		let object = this.expression(host);

		switch(name) {

			case "push": return "_js_push(" + object + ", " + args.join(", ") + ")";
			case "pop": return "_js_pop(" + object + ")";
			case "shift": return "_js_shift(" + object + ")";
			case "indexOf": return "_js_indexOf(" + object + ", " + args[0] + ")";
			case "includes": return "(_js_indexOf(" + object + ", " + args[0] + ") ~= nil)";
			case "join": return "_js_join(" + object + ", " + (args[0] || '""') + ")";
			case "slice": return "_js_slice(" + object + ", " + (args[0] || "0")
				+ ", " + (args[1] != null ? args[1] : "nil") + ")";
			case "concat": return "_js_concat(" + object + ", " + args[0] + ")";
			case "toFixed": return "_js_fixed(" + object + ", " + (args[0] || "0") + ")";
			case "toString": return "_js_text(" + object + ")";
			case "toLowerCase": return "string.lower(" + object + ")";
			case "toUpperCase": return "string.upper(" + object + ")";
			case "map": return "_js_map(" + object + ", " + args[0] + ")";
			case "filter": return "_js_filter(" + object + ", " + args[0] + ")";
			case "some": return "_js_some(" + object + ", " + args[0] + ")";
			case "every": return "_js_every(" + object + ", " + args[0] + ")";
			case "find": return "_js_find(" + object + ", " + args[0] + ")";
			case "findIndex": return "_js_findIndex(" + object + ", " + args[0] + ")";
			case "sort": return "_js_sort(" + object + ", " + (args[0] || "nil") + ")";
			case "reverse": return "_js_reverse(" + object + ")";
			case "split": return "_js_split(" + object + ", " + args[0] + ")";
			case "substring": return "_js_slice(" + object + ", " + args[0]
				+ ", " + (args[1] != null ? args[1] : "nil") + ")";
			case "reduce": return "_js_reduce(" + object + ", " + args[0]
				+ ", " + (args[1] != null ? args[1] : "nil") + ")";

			case "forEach":
				throw new Unsupported(node,
					"forEach is only taken where its result is not used");
		}

		throw new Unsupported(node, "the method " + (name || "?") + " is not translated");
	}
}

// A Luau double-quoted string literal for arbitrary text — the same
// requirement the exporter's own document.luau already has, solved the
// same way: escape backslash, quote, and control characters, nothing else.
const luauString = (text) => {

	let escaped = text
		.replace(/\\/g, "\\\\")
		.replace(/"/g, '\\"')
		.replace(/\n/g, "\\n")
		.replace(/\r/g, "\\r")
		.replace(/\t/g, "\\t");

	return '"' + escaped + '"';
};

/*

	Every helper a translated script may call. Every one carries the _js_
	prefix so that none of them can ever collide with a Roblox virtual or a
	future Luau builtin — the same lesson the Godot port learned the hard
	way when a helper named _get collided with Object._get and broke every
	script that used it.

*/
const HELPERS = `

-- --- what JavaScript means by these, written out once ---
-- Every name forward declared together, so that one helper may call
-- another regardless of which is written first — local function
-- declarations are not hoisted the way a JavaScript function
-- declaration is, and _js_add calling _js_text, which is written
-- later in this same file, needs that to be true.
local _js_truthy, _js_or, _js_and, _js_nullish, _js_isArray, _js_get, _js_put, _js_erase, _js_has, _js_len, _js_add, _js_text, _js_mod, _js_typeof, _js_keys, _js_values, _js_assign, _js_push, _js_pop, _js_shift, _js_indexOf, _js_join, _js_slice, _js_concat, _js_fixed, _js_split, _js_map, _js_filter, _js_some, _js_every, _js_find, _js_findIndex, _js_sort, _js_reverse, _js_reduce, _js_hypot


_js_truthy = function(v)
	if v == nil or v == false then
		return false
	end
	-- Lua does not treat 0 as false the way JavaScript does, and there is
	-- no automatic coercion between them to lean on — false, 0, "", and
	-- NaN are all falsy in JavaScript, and every one of them needs its own
	-- explicit check here.
	if typeof(v) == "number" and (v == 0 or v ~= v) then
		return false
	end
	if typeof(v) == "string" and v == "" then
		return false
	end
	return true
end


_js_or = function(a, b)
	if _js_truthy(a) then
		return a
	end
	return b()
end


_js_and = function(a, b)
	if _js_truthy(a) then
		return b()
	end
	return a
end


_js_nullish = function(a, b)
	if a == nil then
		return b()
	end
	return a
end


_js_isArray = function(v)
	if typeof(v) ~= "table" then
		return false
	end
	local n = 0
	for _ in pairs(v) do
		n += 1
	end
	return n == #v
end


_js_get = function(o, k)
	if o == nil then
		return nil
	end
	if typeof(o) == "table" then
		if typeof(k) == "number" then
			return o[k + 1]
		end
		return o[k]
	end
	if typeof(o) == "string" then
		if typeof(k) == "number" then
			local i = k + 1
			if i >= 1 and i <= #o then
				return string.sub(o, i, i)
			end
			return nil
		end
	end
	return nil
end


_js_put = function(o, k, value)
	if typeof(o) == "table" then
		if typeof(k) == "number" then
			o[k + 1] = value
		else
			o[k] = value
		end
	end
	return value
end


_js_erase = function(o, k)
	if typeof(o) == "table" then
		o[k] = nil
		return true
	end
	return false
end


_js_has = function(o, k)
	if typeof(o) ~= "table" then
		return false
	end
	return o[k] ~= nil
end


_js_len = function(o)
	if o == nil then
		return 0
	end
	if typeof(o) == "string" then
		return #o
	end
	if typeof(o) == "table" then
		return #o
	end
	return 0
end


_js_add = function(a, b)
	if typeof(a) == "string" or typeof(b) == "string" then
		return _js_text(a) .. _js_text(b)
	end
	if a == nil then
		a = 0
	end
	if b == nil then
		b = 0
	end
	return a + b
end


_js_text = function(v)
	if v == nil then
		return "undefined"
	end
	if v == true then
		return "true"
	end
	if v == false then
		return "false"
	end
	if typeof(v) == "number" then
		if v == math.floor(v) and math.abs(v) < 1e15 then
			return string.format("%d", v)
		end
		return tostring(v)
	end
	if typeof(v) == "string" then
		return v
	end
	return tostring(v)
end


_js_mod = function(a, b)
	return math.fmod(a, b)
end


_js_typeof = function(v)
	if v == nil then
		return "undefined"
	end
	if v == true or v == false then
		return "boolean"
	end
	if typeof(v) == "number" then
		return "number"
	end
	if typeof(v) == "string" then
		return "string"
	end
	return "object"
end


_js_keys = function(o)
	local out = {}
	if typeof(o) ~= "table" then
		return out
	end
	if _js_isArray(o) then
		for i = 1, #o do
			table.insert(out, tostring(i - 1))
		end
		return out
	end
	for k in pairs(o) do
		table.insert(out, k)
	end
	return out
end


_js_values = function(o)
	local out = {}
	if typeof(o) ~= "table" then
		return out
	end
	if _js_isArray(o) then
		for i = 1, #o do
			table.insert(out, o[i])
		end
		return out
	end
	for _, v in pairs(o) do
		table.insert(out, v)
	end
	return out
end


_js_assign = function(parts)
	local out = {}
	if #parts > 0 and typeof(parts[1]) == "table" then
		out = parts[1]
	end
	for i = 2, #parts do
		local each = parts[i]
		if typeof(each) == "table" then
			for k, v in pairs(each) do
				out[k] = v
			end
		end
	end
	return out
end


_js_push = function(o, v)
	if typeof(o) == "table" then
		table.insert(o, v)
		return #o
	end
	return 0
end


_js_pop = function(o)
	if typeof(o) == "table" and #o > 0 then
		return table.remove(o, #o)
	end
	return nil
end


_js_shift = function(o)
	if typeof(o) == "table" and #o > 0 then
		return table.remove(o, 1)
	end
	return nil
end


_js_indexOf = function(o, v)
	if typeof(o) ~= "table" then
		return nil
	end
	for i = 1, #o do
		if o[i] == v then
			return i - 1
		end
	end
	return -1
end


_js_join = function(o, sep)
	if typeof(o) ~= "table" then
		return ""
	end
	local parts = {}
	for i = 1, #o do
		table.insert(parts, _js_text(o[i]))
	end
	return table.concat(parts, sep)
end


_js_slice = function(o, from, upto)
	local size = _js_len(o)
	local a = math.floor(from)
	if a < 0 then
		a = math.max(0, size + a)
	end
	local b = if upto == nil then size else math.floor(upto)
	if b < 0 then
		b = math.max(0, size + b)
	end
	b = math.min(b, size)
	if a >= b then
		if typeof(o) == "string" then
			return ""
		end
		return {}
	end
	if typeof(o) == "string" then
		return string.sub(o, a + 1, b)
	end
	if typeof(o) == "table" then
		local out = {}
		for i = a + 1, b do
			table.insert(out, o[i])
		end
		return out
	end
	return {}
end


_js_concat = function(o, other)
	if typeof(o) == "table" and typeof(other) == "table" then
		local out = table.clone(o)
		for _, v in ipairs(other) do
			table.insert(out, v)
		end
		return out
	end
	if typeof(o) == "table" then
		local out = table.clone(o)
		table.insert(out, other)
		return out
	end
	return o
end


_js_fixed = function(v, places)
	return string.format("%." .. tostring(math.floor(places)) .. "f", v)
end


_js_split = function(o, sep)
	if typeof(o) ~= "string" then
		return {}
	end
	local out = {}
	if sep == "" then
		for i = 1, #o do
			table.insert(out, string.sub(o, i, i))
		end
		return out
	end
	local start = 1
	while true do
		local from, upto = string.find(o, sep, start, true)
		if from == nil then
			table.insert(out, string.sub(o, start))
			break
		end
		table.insert(out, string.sub(o, start, from - 1))
		start = upto + 1
	end
	return out
end


_js_map = function(o, fn)
	local out = {}
	if typeof(o) == "table" then
		for _, v in ipairs(o) do
			table.insert(out, fn(v))
		end
	end
	return out
end


_js_filter = function(o, fn)
	local out = {}
	if typeof(o) == "table" then
		for _, v in ipairs(o) do
			if _js_truthy(fn(v)) then
				table.insert(out, v)
			end
		end
	end
	return out
end


_js_some = function(o, fn)
	if typeof(o) == "table" then
		for _, v in ipairs(o) do
			if _js_truthy(fn(v)) then
				return true
			end
		end
	end
	return false
end


_js_every = function(o, fn)
	if typeof(o) == "table" then
		for _, v in ipairs(o) do
			if not _js_truthy(fn(v)) then
				return false
			end
		end
	end
	return true
end


_js_find = function(o, fn)
	if typeof(o) == "table" then
		for _, v in ipairs(o) do
			if _js_truthy(fn(v)) then
				return v
			end
		end
	end
	return nil
end


_js_findIndex = function(o, fn)
	if typeof(o) == "table" then
		for i, v in ipairs(o) do
			if _js_truthy(fn(v)) then
				return i - 1
			end
		end
	end
	return -1
end


_js_sort = function(o, fn)
	if typeof(o) ~= "table" then
		return o
	end
	if fn == nil then
		table.sort(o, function(a, b) return _js_text(a) < _js_text(b) end)
	else
		table.sort(o, function(a, b) return fn(a, b) < 0 end)
	end
	return o
end


_js_reverse = function(o)
	if typeof(o) == "table" then
		local n = #o
		for i = 1, math.floor(n / 2) do
			o[i], o[n - i + 1] = o[n - i + 1], o[i]
		end
	end
	return o
end


_js_reduce = function(o, fn, start)
	local total = start
	if typeof(o) == "table" then
		local first = 1
		if total == nil and #o > 0 then
			total = o[1]
			first = 2
		end
		for i = first, #o do
			total = fn(total, o[i])
		end
	end
	return total
end


_js_hypot = function(parts)
	local total = 0
	for _, v in ipairs(parts) do
		total += v * v
	end
	return math.sqrt(total)
end
`;

/*

	Translates one script body into the Luau equivalent of the same
	function: run(state, path). Returned as the body text alone — the
	exporter's own wrapping (the state/path signature, the HttpService
	local, nesting the body in its own function so an ACE script's own
	return is always legal) is unchanged and still does that part; this
	only has to produce what goes inside it.

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

	let functions = new Set();

	const gather = (node) => {

		if(node == null || typeof node !== "object") return;
		if(Array.isArray(node)) return node.forEach(gather);

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

	translator.depth = 1;
	translator.functions = functions;

	translator.block(body);

	let out = [];

	// Every function's name, forward declared together at the very top —
	// this is what lets one call another regardless of which was written
	// first, the same hoisting a JavaScript function declaration already
	// gives a script author. The assignments themselves are not here:
	// define() writes each one inline, at its own original position in
	// the statement stream, which is what lets a function correctly close
	// over a variable declared earlier in the same scope — collecting
	// every function and hoisting the assignments to the very top, the
	// way an earlier version of this did, breaks exactly that: a closure
	// defined before the variable it captures is a reference to an
	// unrelated global of the same name, not the real local.
	if(functions.size > 0)
		out.push("local " + [...functions].map(method).join(", "), "");

	out.push(...translator.lines);

	return { body: out.join("\n"), helpers: HELPERS };
};

module.exports = { translate, Unsupported, luauString };
