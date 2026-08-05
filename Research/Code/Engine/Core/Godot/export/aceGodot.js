#!/usr/bin/env node

/*

	ace-godot — builds a Godot project from an ACE document.

		node export/aceGodot.js <document.json> <output directory> [options]

	The document is the game. What is written out is a Godot project which runs
	it: the same reconciler, the same operator table, and the same scripts,
	against Godot nodes instead of Babylon ones.

	Nothing about the document is translated or rewritten, beyond pointing its
	asset locations at the copies that were fetched. It is emitted as it stands
	and read at runtime, which is the whole point of a declarative format: a
	second engine is a second reader, not a second copy of the game.

	Options:

		--name <title>       the project name; defaults to the document's
		--no-assets          skip fetching, and leave locations as they are
		--keep-js            leave JavaScript scripts alone, for a project
		                     that will run them through a bridge
		--force              overwrite an output directory that is not empty
		--timeout <ms>       per asset, default 30000

*/

const fs = require("fs");
const path = require("path");
const https = require("https");
const http = require("http");

const { translate, Unsupported } = require("./jsToGd.js");

const RUNTIME = path.join(__dirname, "..", "godot", "addons", "ace");

const TAG = "telos-ace";

// ---------------------------------------------------------------- arguments

const parse = (argv) => {

	let options = {
		document: null, output: null, name: null,
		assets: true, force: false, timeout: 30000, translate: true
	};

	let loose = [];

	for(let index = 0; index < argv.length; index++) {

		let arg = argv[index];

		if(arg === "--no-assets") options.assets = false;
		else if(arg === "--keep-js") options.translate = false;
		else if(arg === "--force") options.force = true;
		else if(arg === "--name") options.name = argv[++index];
		else if(arg === "--timeout") options.timeout = Number(argv[++index]);
		else if(arg.startsWith("--")) throw new Error("unknown option: " + arg);
		else loose.push(arg);
	}

	options.document = loose[0];
	options.output = loose[1];

	return options;
};

// ------------------------------------------------------------------- assets

/*

	Every source in the document, in the order a document would try them. APInt
	allows a list of locations in order of preference, so all of them are
	fetched: a project that has been exported should not depend on a host being
	reachable later.

*/
const sourcesIn = (node, found) => {

	found = found != null ? found : [];

	if(node == null || typeof node !== "object")
		return found;

	if(Array.isArray(node)) {

		node.forEach(entry => sourcesIn(entry, found));

		return found;
	}

	if(node.source != null) {

		(Array.isArray(node.source) ? node.source : [node.source])
			.filter(entry => typeof entry === "string")
			.forEach(entry => found.push(entry));
	}

	/* A texture referenced by a material map is a location too. */
	if(node.properties?.data?.maps != null) {

		Object.values(node.properties.data.maps).forEach(value => {

			if(typeof value === "string")
				found.push(value);
		});
	}

	Object.keys(node).forEach(key => sourcesIn(node[key], found));

	return found;
};

const localName = (source, taken) => {

	let base = source.split("?")[0].split("#")[0];
	let name = base.substring(base.lastIndexOf("/") + 1) || "asset";

	name = name.replace(/[^A-Za-z0-9._-]/g, "_");

	if(!/\.[A-Za-z0-9]{1,5}$/.test(name))
		name += ".bin";

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
				new URL(response.headers.location, source).toString(),
				into, timeout
			));
		}

		if(response.statusCode !== 200) {

			response.resume();

			return resolve({
				ok: false, why: "HTTP " + response.statusCode
			});
		}

		let chunks = [];

		response.on("data", chunk => chunks.push(chunk));

		response.on("end", () => {

			fs.writeFileSync(into, Buffer.concat(chunks));

			resolve({ ok: true, bytes: Buffer.concat(chunks).length });
		});
	});

	request.on("timeout", () => {

		request.destroy();

		resolve({ ok: false, why: "timed out" });
	});

	request.on("error", error => resolve({ ok: false, why: error.message }));
});

/*

	A cubemap is a prefix rather than a file: the document names the stem and
	the runtime appends the face suffixes. Godot has no such convention, so the
	faces are fetched individually and the manifest points at the first of them.

*/
const FACES = ["_px.jpg", "_py.jpg", "_pz.jpg", "_nx.jpg", "_ny.jpg", "_nz.jpg"];

const looksLikeFile = (source) =>
	/\.[A-Za-z0-9]{1,5}$/.test(source.split("?")[0].split("#")[0]);

const gather = async (document, into, options, log) => {

	let manifest = { };
	let taken = new Set();
	let report = [];

	if(!options.assets)
		return { manifest, report };

	let sources = [...new Set(sourcesIn(document))];

	for(const source of sources) {

		if(!/^https?:/.test(source)) {

			report.push({ source, ok: false, why: "not a remote location" });

			continue;
		}

		/* A stem with no extension is a cubemap prefix. */
		let wanted = looksLikeFile(source)
			? [source]
			: FACES.map(face => source + face);

		let first = null;
		let failures = [];

		for(const each of wanted) {

			let name = localName(each, taken);
			let target = path.join(into, name);

			log("  fetching " + each);

			let outcome = await fetchOne(each, target, options.timeout);

			if(!outcome.ok) {

				failures.push(each + ": " + outcome.why);

				try { fs.unlinkSync(target); } catch(error) { }

				continue;
			}

			manifest[each] = "res://assets/" + name;

			if(first == null)
				first = "res://assets/" + name;

			report.push({ source: each, ok: true, bytes: outcome.bytes, name });
		}

		if(first != null) {

			manifest[source] = first;

		} else {

			report.push({
				source, ok: false, why: failures.join("; ") || "no candidates"
			});
		}
	}

	return { manifest, report };
};

// -------------------------------------------------------------------- files


/* What the exported README says about how its scripts came to be as they are. */
const scriptNote = (translated) => {

	let done = translated.filter(entry => entry.ok);
	let refused = translated.filter(entry => !entry.ok);

	let out = [];

	if(done.length > 0) {

		out.push(
			"Godot has no JavaScript engine on the desktop, so the " +
			done.length + " script" + (done.length === 1 ? "" : "s") +
			" this document\nhad in JavaScript " +
			(done.length === 1 ? "was" : "were") +
			" translated into GDScript when it was exported.\n" +
			"Nothing needs installing. The document here is the translated " +
			"one; the document\nit was built from still says JavaScript, and " +
			"still runs in a browser.\n\n" +
			"The translation covers the language the ACE demos are written " +
			"in and refuses\nanything outside it rather than guessing. What " +
			"it emits is parsed and scope\nchecked before it is written, so " +
			"it is known to be a program; that it is the\nsame program is " +
			"argued for construct by construct in `export/jsToGd.js` and is " +
			"not\ndemonstrated by running it. If something behaves oddly " +
			"that file is where to\nlook, and `--keep-js` turns the whole " +
			"pass off."
		);
	}

	if(refused.length > 0) {

		out.push(
			"### Not translated\n\n" +
			refused.map(entry => "- `" + entry.where + "` — " + entry.why)
				.join("\n") +
			"\n\nThese are still in JavaScript and will not run without a " +
			"bridge."
		);
	}

	out.push(
		"Where a script is in JavaScript and no bridge is present it reports " +
		"so in its own\n`state.error` and warns once in the console, rather " +
		"than failing quietly. A\nbridge means Godot's own " +
		"`JavaScriptBridge` on a web export, or\n" +
		"[GodotJS](https://github.com/ialex32x/GodotJS) as a GDExtension."
	);

	return out.join("\n\n");
};

const PROJECT = (name, hasXR) => `; Written by ace-godot.
;
; The game is document.json. This file only says how to open it.

config_version=5

[application]

config/name="${name}"
run/main_scene="res://main.tscn"
config/features=PackedStringArray("4.3", "Forward Plus")

[rendering]

textures/canvas_textures/default_texture_filter=1
environment/defaults/default_clear_color=Color(0, 0, 0, 1)

[physics]

3d/default_gravity=9.81
3d/default_gravity_vector=Vector3(0, -1, 0)
${hasXR ? `
[xr]

openxr/enabled=true
openxr/startup_alert=false
shaders/enabled=true
` : ""}
[input_devices]

pointing/emulate_touch_from_mouse=true
`;

const SCENE = `[gd_scene load_steps=2 format=3]

[ext_resource type="Script" path="res://addons/ace/ace_runtime.gd" id="1"]

[node name="Ace" type="Node3D"]
script = ExtResource("1")
document_path = "res://document.json"
manifest_path = "res://assets/manifest.json"
trace = ""
`;

const README = (name, scripts, missing, hasXR, translated) => `# ${name}

Built from an ACE document by \`ace-godot\`. The game is \`document.json\`;
everything else is what Godot needs in order to read it.

## Running it

Open the folder in Godot 4.3 or later and press play. \`main.tscn\` holds a
single node carrying \`addons/ace/ace_runtime.gd\`, which loads the document and
runs it.

## Scripts

This document carries ${scripts.total} script${scripts.total === 1 ? "" : "s"}: \
${scripts.gdscript} in GDScript and ${scripts.js} in JavaScript.

An ACE agnostic script is the body of a function taking a serialisation of the
whole document and the path of the script within it, and returning either
nothing or a patch. The contract says nothing about a language, so either will
do, and both are read from the same \`language\` field.

${scriptNote(translated)}
## Assets

Everything the document referred to was fetched into \`assets/\`, and
\`assets/manifest.json\` maps the location the document names to the file that
was fetched for it. The document itself was left as it was: it still names the
original locations, and the manifest is what redirects them. That way the same
document runs unchanged in a browser, where the locations are the real ones.
${missing.length > 0 ? `
### Not fetched

${missing.map(entry => "- `" + entry.source + "` — " + entry.why).join("\n")}

The document will report these at runtime as a source that failed.
` : ""}`;

// --------------------------------------------------------------------- main

/*

	Every JavaScript script in the document, translated into GDScript in place.
	The document that is written out is the translated one; the original is
	untouched on disk.

	Anything the translator does not understand is left in JavaScript and
	reported, so that a project is never quietly half translated: what did not
	come across is named, and a bridge will still run it.

*/
const translateScripts = (node, report, path_) => {

	path_ = path_ != null ? path_ : [];

	if(node == null || typeof node !== "object")
		return;

	if(Array.isArray(node)) {

		node.forEach((entry, index) =>
			translateScripts(entry, report, path_.concat([String(index)])));

		return;
	}

	let tags = node.properties?.tags;

	if(Array.isArray(tags) && tags[0] === "script" && tags.includes(TAG) &&
		typeof node.content === "string") {

		let language = String(
			node.properties?.data?.language != null
				? node.properties.data.language : "js"
		).toLowerCase();

		if(language === "js" || language === "javascript") {

			try {

				node.content = translate(node.content);
				node.properties.data.language = "gdscript";

				report.push({ where: path_.join("."), ok: true });

			} catch(error) {

				report.push({
					where: path_.join("."), ok: false, why: error.message
				});
			}
		}
	}

	Object.keys(node).forEach(key =>
		translateScripts(node[key], report, path_.concat([key])));
};

const scriptCounts = (node, counts) => {

	counts = counts != null ? counts : { total: 0, js: 0, gdscript: 0 };

	if(node == null || typeof node !== "object")
		return counts;

	if(Array.isArray(node)) {

		node.forEach(entry => scriptCounts(entry, counts));

		return counts;
	}

	let tags = node.properties?.tags;

	if(Array.isArray(tags) && tags.includes(TAG) && tags[0] === "script") {

		counts.total++;

		let language = String(
			node.properties?.data?.language != null
				? node.properties.data.language : "js"
		).toLowerCase();

		if(language === "gdscript" || language === "gd")
			counts.gdscript++;
		else
			counts.js++;
	}

	Object.keys(node).forEach(key => scriptCounts(node[key], counts));

	return counts;
};

const wantsXR = (node) => {

	if(node == null || typeof node !== "object")
		return false;

	if(Array.isArray(node))
		return node.some(wantsXR);

	if(node.properties?.data?.xr != null)
		return true;

	return Object.keys(node).some(key => wantsXR(node[key]));
};

const copyTree = (from, to) => {

	fs.mkdirSync(to, { recursive: true });

	fs.readdirSync(from).forEach(entry => {

		let source = path.join(from, entry);
		let target = path.join(to, entry);

		if(fs.statSync(source).isDirectory())
			copyTree(source, target);
		else
			fs.copyFileSync(source, target);
	});
};

const build = async (options, log) => {

	if(options.document == null || options.output == null)
		throw new Error(
			"usage: aceGodot.js <document.json> <output directory> [options]"
		);

	if(!fs.existsSync(options.document))
		throw new Error("no such document: " + options.document);

	let document = JSON.parse(fs.readFileSync(options.document, "utf8"));

	if(typeof document !== "object" || document == null)
		throw new Error("that document is not an object");

	if(fs.existsSync(options.output)) {

		let held = fs.readdirSync(options.output);

		if(held.length > 0 && !options.force)
			throw new Error(
				options.output + " is not empty; pass --force to overwrite"
			);
	}

	let name = options.name != null
		? options.name
		: path.basename(options.document).replace(/\.json$/, "");

	log("building " + name + " into " + options.output);

	fs.mkdirSync(path.join(options.output, "assets"), { recursive: true });

	if(!fs.existsSync(RUNTIME))
		throw new Error("the runtime is missing from " + RUNTIME);

	copyTree(RUNTIME, path.join(options.output, "addons", "ace"));

	let { manifest, report } = await gather(
		document, path.join(options.output, "assets"), options, log
	);

	let missing = report.filter(entry => !entry.ok);
	let fetched = report.filter(entry => entry.ok);

	fs.writeFileSync(
		path.join(options.output, "assets", "manifest.json"),
		JSON.stringify(manifest, null, "\t")
	);

	/*

		Translated before it is written, if it needs to be. Everything else
		about the document is left as it stands: it still names the locations
		it always named, and the manifest is what points them at the copies, so
		one document runs in both places without being forked.

	*/
	let translated = [];

	if(options.translate)
		translateScripts(document, translated);

	let refused = translated.filter(entry => !entry.ok);

	fs.writeFileSync(
		path.join(options.output, "document.json"),
		JSON.stringify(document, null, "\t")
	);

	let scripts = scriptCounts(document);
	let xr = wantsXR(document);

	fs.writeFileSync(
		path.join(options.output, "project.godot"), PROJECT(name, xr)
	);

	fs.writeFileSync(path.join(options.output, "main.tscn"), SCENE);

	fs.writeFileSync(
		path.join(options.output, "README.md"),
		README(name, scripts, missing, xr, translated)
	);

	fs.writeFileSync(
		path.join(options.output, ".gitattributes"),
		"* text=auto eol=lf\n"
	);

	log("");
	log("  assets fetched  " + fetched.length +
		(missing.length > 0 ? ", " + missing.length + " failed" : ""));
	log("  scripts         " + scripts.total +
		" (" + scripts.gdscript + " gdscript, " + scripts.js + " javascript)");
	log("  immersive       " + (xr ? "yes, OpenXR enabled" : "no"));
	log("");
	log("open " + options.output + " in Godot 4.3 or later and press play");

	if(translated.length > 0) {

		log("  translated      " + translated.filter(e => e.ok).length +
			" JavaScript scripts into GDScript" +
			(refused.length > 0 ? ", " + refused.length + " refused" : ""));
	}

	if(refused.length > 0) {

		log("");
		log("  NOT TRANSLATED");

		refused.forEach(entry =>
			log("    " + entry.where + "\n      " + entry.why));

		log("");
		log("  These are left in JavaScript and will not run without a " +
			"bridge.");
	}

	if(scripts.js > 0 && !options.translate) {

		log("");
		log("  NOTE  " + scripts.js + " of this document's scripts are in " +
			"JavaScript, and Godot has no");
		log("        JavaScript engine on desktop. Without a bridge they " +
			"will not run at all.");
	}

	return { name, manifest, report, scripts, xr, document };
};

module.exports = { build, parse, sourcesIn, localName, scriptCounts, wantsXR };

if(require.main === module) {

	build(parse(process.argv.slice(2)), line => console.log(line))
		.catch(error => {

			console.error("ace-godot: " + error.message);

			process.exit(1);
		});
}
