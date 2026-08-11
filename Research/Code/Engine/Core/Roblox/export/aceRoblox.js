#!/usr/bin/env node

/*

	ace-roblox — builds a Rojo project from an ACE document.

		node export/aceRoblox.js <document.json> <output directory> [options]

	Rojo, not a raw .rbxlx, is the target: a filesystem project Roblox Studio
	opens and stays synced to, the way project.godot and a tree of .gd files
	were the target for Godot. The runtime does the real work — this writes
	the project shape around it, fetches assets, and pre-compiles every
	script component into a real ModuleScript, since Roblox disables
	loadstring as a held security boundary and a script's source cannot be
	compiled from the document at runtime the way it can on every other
	adapter.

	Options:

		--name <title>        the project name; defaults to the document's
		--assets <mode>       "manifest" (default) or "live"
		--force               overwrite an output directory that is not empty
		--timeout <ms>        per asset, default 30000

	--assets manifest fetches every source locally and writes them in a
	Tarmac-friendly layout, but stops short of uploading them: Roblox has no
	local-file reference for a mesh, texture, or sound at all — everything is
	a cloud asset with an rbxassetid, uploaded through Roblox's own pipeline —
	and that upload step needs the developer's own Roblox credentials, which
	this tool has no business obtaining on anyone's behalf. Running
	`tarmac sync --target roblox` in the exported project, with those
	credentials, is what actually produces the manifest the runtime reads.

	--assets live writes the project without fetching anything, and the
	runtime is left to resolve document sources for itself at the moment it
	needs them. Whether that is possible at all — whether HttpService can
	turn an arbitrary external asset into something AssetService or
	EditableMesh can use — is not verified by anything in this project. Try
	it; if it does not work, this flag is the one to drop.

*/

const fs = require("fs");
const path = require("path");
const https = require("https");
const http = require("http");

const RUNTIME = path.join(__dirname, "..", "roblox", "src", "ace");
const TAG = "telos-ace";

// ---------------------------------------------------------------- arguments

const parse = (argv) => {

	let options = {
		document: null, output: null, name: null,
		assets: "manifest", force: false, timeout: 30000, trace: null,
	};

	let loose = [];

	for(let index = 0; index < argv.length; index++) {

		let arg = argv[index];

		if(arg === "--force") options.force = true;
		else if(arg === "--name") options.name = argv[++index];
		else if(arg === "--timeout") options.timeout = Number(argv[++index]);
		else if(arg === "--trace") options.trace = argv[++index];
		else if(arg === "--assets") {

			let value = argv[++index];

			if(value !== "manifest" && value !== "live")
				throw new Error('--assets must be "manifest" or "live", got: ' + value);

			options.assets = value;

		}
		else if(arg.startsWith("--")) throw new Error("unknown option: " + arg);
		else loose.push(arg);
	}

	options.document = loose[0];
	options.output = loose[1];

	return options;
};

// -------------------------------------------------------------- traversal

const walk = (node, visit, path_) => {

	path_ = path_ != null ? path_ : [];

	if(node == null || typeof node !== "object")
		return;

	if(Array.isArray(node)) {

		node.forEach((entry, index) => walk(entry, visit, path_.concat([String(index)])));

		return;
	}

	visit(node, path_);

	Object.keys(node).forEach(key => walk(node[key], visit, path_.concat([key])));
};

const sourcesIn = (doc) => {

	let found = [];

	walk(doc, node => {

		if(node.source != null) {

			(Array.isArray(node.source) ? node.source : [node.source])
				.filter(entry => typeof entry === "string")
				.forEach(entry => found.push(entry));
		}

		if(node.properties?.data?.maps != null) {

			Object.values(node.properties.data.maps).forEach(value => {

				if(typeof value === "string") found.push(value);
			});
		}
	});

	return [...new Set(found)];
};

/*

	Every script, with the identity AceDocument.luau's own collect() would
	compute for it at runtime — not the raw JSON traversal walk() uses for
	finding asset sources, which is a different, structural path that
	includes "packages" and "utilities" as literal steps. APInt's real path
	only advances a segment when descending through a package (an entity)
	or landing on a utility (a component); the wrapping object keys around
	them are not addressable steps in ACE's own path notion at all.

	This has to walk the document the same way the Luau side does, by the
	same rule, or a script compiled under one identity is never found under
	the other — which is exactly what happened before this was fixed: every
	exported script silently failed to be found by any document, not just
	one of them, because the two implementations were never checked against
	each other.

*/
const inheritId = (parent, own) => {

	let id = own?.properties?.id;

	if(id == null) id = own?.properties?.meta?.id;

	return id != null ? id : parent;
};

const acePath = (pkg, path_, inheritedId, visit) => {

	path_ = path_ != null ? path_ : [];

	if(pkg == null || typeof pkg !== "object")
		return;

	let ownId = inheritId(inheritedId, pkg);

	if(pkg.utilities != null && typeof pkg.utilities === "object") {

		Object.keys(pkg.utilities).forEach(key => {

			let utility = pkg.utilities[key];

			if(utility == null || typeof utility !== "object")
				return;

			let componentId = inheritId(ownId, utility);
			let entryPath = path_.concat([key]);

			visit(utility, entryPath, componentId);
		});
	}

	if(pkg.packages != null && typeof pkg.packages === "object") {

		Object.keys(pkg.packages).forEach(key => {

			acePath(pkg.packages[key], path_.concat([key]), ownId, visit);
		});
	}
};

const identityOf = (path_, id) => {

	if(id != null) return "#" + String(id);

	return "[" + path_.map(step => JSON.stringify(step)).join(",") + "]";
};

const scriptsIn = (doc) => {

	let found = [];

	acePath(doc, [], null, (node, path_, id) => {

		let tags = node.properties?.tags;

		if(Array.isArray(tags) && tags[0] === "script" && tags.includes(TAG)
			&& typeof node.content === "string") {

			found.push({ path: path_, id, node });
		}
	});

	return found;
};

// localName is still used for asset filenames, unrelated to script identity.

// JSON's "key": value is not Luau's key = value — despite the visual
// similarity, prepending "return " to raw JSON text is not a valid module.
// The document and manifest are carried as an escaped Luau string instead,
// decoded through HttpService:JSONDecode at load time the same way a
// script's own state parameter already is; nothing here hand-converts JSON
// into a table literal.
const luauString = (text) => {

	let escaped = text
		.replace(/\\/g, "\\\\")
		.replace(/"/g, '\\"')
		.replace(/\n/g, "\\n")
		.replace(/\r/g, "\\r")
		.replace(/\t/g, "\\t");

	return '"' + escaped + '"';
};

// ------------------------------------------------------------------- assets

const localName = (source, taken) => {

	let base = source.split("?")[0].split("#")[0];
	let name = base.substring(base.lastIndexOf("/") + 1) || "asset";

	name = name.replace(/[^A-Za-z0-9._-]/g, "_");

	if(!/\.[A-Za-z0-9]{1,5}$/.test(name)) name += ".bin";

	let unique = name;
	let count = 2;

	while(taken.has(unique)) {

		let dot = name.lastIndexOf(".");

		unique = name.slice(0, dot) + "-" + count + name.slice(dot);
		count++;
	}

	taken.add(unique);

	return unique;
};

const fetchOne = (source, into, timeout) => new Promise((resolve) => {

	let client = source.startsWith("https:") ? https : http;

	let request = client.get(source, { timeout }, response => {

		if(response.statusCode >= 300 && response.statusCode < 400 &&
			response.headers.location) {

			response.resume();

			return resolve(fetchOne(
				new URL(response.headers.location, source).toString(), into, timeout
			));
		}

		if(response.statusCode !== 200) {

			response.resume();

			return resolve({ ok: false, why: "HTTP " + response.statusCode });
		}

		let chunks = [];

		response.on("data", chunk => chunks.push(chunk));

		response.on("end", () => {

			fs.writeFileSync(into, Buffer.concat(chunks));

			resolve({ ok: true, bytes: Buffer.concat(chunks).length });
		});
	});

	request.on("timeout", () => { request.destroy(); resolve({ ok: false, why: "timed out" }); });
	request.on("error", error => resolve({ ok: false, why: error.message }));
});

const gather = async (sources, into, timeout, log) => {

	let taken = new Set();
	let report = [];

	for(const source of sources) {

		if(!/^https?:/.test(source)) {

			report.push({ source, ok: false, why: "not a remote location" });

			continue;
		}

		let name = localName(source, taken);
		let target = path.join(into, name);

		log("  fetching " + source);

		let outcome = await fetchOne(source, target, timeout);

		if(outcome.ok) {

			report.push({ source, ok: true, name, bytes: outcome.bytes });

		} else {

			report.push({ source, ok: false, why: outcome.why });

			try { fs.unlinkSync(target); } catch(error) { }
		}
	}

	return report;
};

// -------------------------------------------------------------------- files

const PROJECT = (name) => JSON.stringify({
	name,
	tree: {
		"$className": "DataModel",
		ServerScriptService: {
			"$className": "ServerScriptService",
			ace: { "$path": "src/ace" },
			bootstrap: { "$path": "src/server" },
		},
	},
}, null, "\t");

const BOOTSTRAP = (traceTarget) => `--!strict

-- Written by ace-roblox. Starts the runtime against document.luau.

local ServerScriptService = game:GetService("ServerScriptService")

local AceRuntime = require(ServerScriptService.ace.AceRuntime)
local documentJson = require(ServerScriptService.ace.document).json
local manifestJson = require(ServerScriptService.ace.manifest).json
local scriptIndexJson = require(ServerScriptService.ace.scriptIndex).json

local runtime = AceRuntime.new(
	documentJson, manifestJson, ServerScriptService.ace.scripts, scriptIndexJson,
	${traceTarget != null ? luauString(traceTarget) : "nil"}
)

runtime:start()
`;

const README = (name, scripts, missing, mode) => {

	let out = [
		"# " + name, "",
		"Built from an ACE document by `ace-roblox`. The game is `src/ace/document.luau`;",
		"everything else is what Roblox needs in order to read it.", "",
		"## Opening this", "",
		"This is a [Rojo](https://rojo.space) project, not a raw place file. Install Rojo",
		"(`aftman install` if you use Aftman, or grab a release directly), then from this",
		"folder:", "",
		"```",
		"rojo serve",
		"```", "",
		"and connect the Rojo plugin inside Roblox Studio to it, or run `rojo build -o",
		"place.rbxl` to produce a place file directly.", "",
		"## Scripts", "",
		"This document carries " + scripts + " script" + (scripts === 1 ? "" : "s") + ". Roblox disables `loadstring` as a held",
		"security boundary, so a script's source cannot be compiled from the document at",
		"runtime the way it can on every other ACE adapter. Each one was compiled into its",
		"own real `ModuleScript` under `src/ace/scripts` at export time instead, named by",
		"the script component's own identity, and the runtime looks it up rather than",
		"interpreting it live. Everything else in the document — positions, materials,",
		"whatever a script reads and writes — stays exactly as live as it is anywhere",
		"else. Only a script's own logic is baked in, and changing it means re-exporting.",
		"",
	];

	if(mode === "manifest") {

		out.push(
			"## Assets", "",
			"Every asset this document refers to was fetched into `assets/`, but Roblox has",
			"no local-file reference for a mesh, texture, or sound — everything is a cloud",
			"asset addressed by an `rbxassetid`, uploaded through Roblox's own pipeline. This",
			"export stops at fetching; the upload needs your own Roblox credentials, which",
			"this tool has no business obtaining on your behalf.", "",
			"[Tarmac](https://github.com/rojo-rbx/tarmac) is the tool that does the upload and",
			"produces the mapping the runtime reads. From this folder, with your own",
			"credentials available to it:", "",
			"```", "tarmac sync --target roblox", "```", "",
			"This writes `src/ace/manifest.luau`, mapping every source this document names to",
			"the `rbxassetid` Tarmac uploaded it as. Nothing in this project resolves an",
			"asset correctly until that step has been run once.", ""
		);

	} else {

		out.push(
			"## Assets", "",
			"Nothing was fetched. This export asks the runtime to resolve every source live,",
			"at the moment it is needed, through `HttpService`. **This is not verified.**",
			"Whether Roblox's asset APIs can turn an arbitrary externally fetched file into",
			"something `AssetService` or `EditableMesh` can actually use, with no upload or",
			"moderation step, is unconfirmed — try it, and if it does not work, re-export with",
			"`--assets manifest` instead, which is the path that is known to work.", ""
		);
	}

	if(missing.length > 0) {

		out.push("### Not fetched", "");

		missing.forEach(entry => out.push("- `" + entry.source + "` — " + entry.why));

		out.push("", "The document will report these at runtime as a source that failed.", "");
	}

	return out.join("\n");
};

// --------------------------------------------------------------------- main

const copyTree = (from, to) => {

	fs.mkdirSync(to, { recursive: true });

	fs.readdirSync(from).forEach(entry => {

		let source = path.join(from, entry);
		let target = path.join(to, entry);

		if(fs.statSync(source).isDirectory()) copyTree(source, target);
		else fs.copyFileSync(source, target);
	});
};

const build = async (options, log) => {

	if(options.document == null || options.output == null)
		throw new Error(
			"usage: aceRoblox.js <document.json> <output directory> [options]"
		);

	if(!fs.existsSync(options.document))
		throw new Error("no such document: " + options.document);

	let document = JSON.parse(fs.readFileSync(options.document, "utf8"));

	if(typeof document !== "object" || document == null)
		throw new Error("that document is not an object");

	if(fs.existsSync(options.output)) {

		let held = fs.readdirSync(options.output);

		if(held.length > 0 && !options.force)
			throw new Error(options.output + " is not empty; pass --force to overwrite");
	}

	let name = options.name != null
		? options.name
		: path.basename(options.document).replace(/\.json$/, "");

	log("building " + name + " into " + options.output + " (assets: " + options.assets + ")");

	let srcAce = path.join(options.output, "src", "ace");
	let srcServer = path.join(options.output, "src", "server");
	let scriptsDir = path.join(srcAce, "scripts");
	let assetsDir = path.join(options.output, "assets");

	fs.mkdirSync(scriptsDir, { recursive: true });
	fs.mkdirSync(srcServer, { recursive: true });
	fs.mkdirSync(assetsDir, { recursive: true });

	if(!fs.existsSync(RUNTIME))
		throw new Error("the runtime is missing from " + RUNTIME);

	copyTree(RUNTIME, srcAce);

	// require() refuses a module that returns anything but a table or a
	// function — the JSON string is wrapped in a one-field table rather
	// than returned bare, which the bootstrap unwraps.
	fs.writeFileSync(
		path.join(srcAce, "document.luau"),
		"return { json = " + luauString(JSON.stringify(document)) + " }\n"
	);

	// Every script becomes a real ModuleScript, named by its own identity,
	// so the runtime can require() it without ever compiling anything from
	// a string.
	let scripts = scriptsIn(document);

	// Raw identity -> the Roblox instance name of its compiled script.
	// The identity string itself has characters no filesystem should be
	// asked to carry in a filename, so the file it becomes is sanitized;
	// the runtime cannot recover the original from that sanitized form on
	// its own, so this index is what actually connects the two rather than
	// asking them to agree on an encoding neither of them owns.
	let scriptIndex = {};

	scripts.forEach(({ path: scriptPath, id: inheritedId, node }) => {

		let id = identityOf(scriptPath, inheritedId);
		let fileName = id.replace(/[^A-Za-z0-9]/g, "_") + ".luau";

		scriptIndex[id] = fileName.replace(/\.luau$/, "");

		let language = String(node.properties?.data?.language || "").toLowerCase();

		if(language !== "" && language !== "lua" && language !== "luau") {

			log("  NOTE  " + scriptPath.join(".") + " is written in \"" + language +
				"\", which this exporter does not translate; it will fail at " +
				"runtime with that reported as its error");
		}

		let body = node.content.split("\n").map(line => "\t\t\t" + line).join("\n");

		// The body is nested in a function of its own rather than being the
		// run function's direct statement list. An ACE script normally ends
		// with its own return, and Lua/Luau requires return to be the final
		// statement of its block — nothing may follow it, not even another
		// return. Wrapping the body in a function makes whatever it returns,
		// wherever it returns it, legal on its own terms; run then simply
		// forwards that result, or nil if the body never returns at all,
		// which is what a function that falls off its end already does in
		// Luau without needing a trailing return nil to say so.
		let compiled = "--!strict\n\n"
			+ "-- Provided the way JSON.parse/JSON.stringify are implicit in a "
			+ "browser script and JSON.parse_string/JSON.stringify are implicit "
			+ "in a Godot one: Roblox's JSON functions live on a service, not as "
			+ "bare globals, and a script author should not have to know that "
			+ "just to use the same state/path contract every other adapter gives "
			+ "them for free.\n"
			+ "local HttpService = game:GetService(\"HttpService\")\n\n"
			+ "return {\n\trun = function(state: string, path: string)\n\n"
			+ "\t\tlocal function body(state, path)\n"
			+ body + "\n\t\tend\n\n"
			+ "\t\treturn body(state, path)\n\tend,\n}\n";

		fs.writeFileSync(path.join(scriptsDir, fileName), compiled);
	});

	fs.writeFileSync(
		path.join(srcAce, "scriptIndex.luau"),
		"return { json = " + luauString(JSON.stringify(scriptIndex)) + " }\n"
	);

	// The manifest, either fetched now or left for Tarmac to produce.
	let manifest = {};
	let report = [];

	if(options.assets === "manifest") {

		let sources = sourcesIn(document);

		report = await gather(sources, assetsDir, options.timeout, log);

		// Tarmac reads a plain filesystem tree and produces its own mapping;
		// this records which local file stands for which source, so a
		// person running tarmac afterward knows what maps to what, and so
		// manifest.luau has a real (if placeholder) shape to load even
		// before that step runs.
		report.filter(entry => entry.ok).forEach(entry => {
			manifest[entry.source] = "PENDING: " + entry.name;
		});
	}

	let missing = report.filter(entry => !entry.ok);

	fs.writeFileSync(
		path.join(srcAce, "manifest.luau"),
		"return { json = " + luauString(JSON.stringify(manifest)) + " }\n"
	);

	fs.writeFileSync(
		path.join(srcServer, "bootstrap.server.luau"), BOOTSTRAP(options.trace)
	);
	fs.writeFileSync(path.join(options.output, "default.project.json"), PROJECT(name));

	fs.writeFileSync(
		path.join(options.output, "README.md"),
		README(name, scripts.length, missing, options.assets)
	);

	fs.writeFileSync(path.join(options.output, ".gitattributes"), "* text=auto eol=lf\n");

	log("");
	log("  scripts         " + scripts.length + " compiled");
	log("  assets          " + (options.assets === "manifest"
		? report.filter(e => e.ok).length + " fetched" +
			(missing.length > 0 ? ", " + missing.length + " failed" : "")
		: "left for the runtime to resolve live (unverified)"));
	log("");
	log("open " + options.output + " with Rojo — see the README written out");

	return { name, scripts, manifest, report, document };
};

module.exports = { build, parse, sourcesIn, scriptsIn, identityOf, localName };

if(require.main === module) {

	build(parse(process.argv.slice(2)), line => console.log(line))
		.catch(error => {

			console.error("ace-roblox: " + error.message);

			process.exit(1);
		});
}
