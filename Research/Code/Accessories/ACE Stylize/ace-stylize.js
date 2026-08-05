/*

	ace-stylize.js — an optional visual pass over an ACE canvas.

	Drop this in after ace.js and aceOperators.js on any demo page:

		<script src="../stylize/ace-stylize.js"></script>
		<script>
			AceStylize.attach(document.querySelector("canvas"), {
				backend: "lucy",   // "lucy" | "streamdiffusion" | "off" (default)
				apiKey: "...",      // required for "lucy" — see stylize/README.md
				endpoint: "ws://localhost:8189/stylize",  // for "streamdiffusion"
				prompt: null         // null = the built-in "enhance" default below
			});
		</script>

	Nothing here touches ACE. It reads whatever the adapter has already drawn
	onto its canvas and hands frames to whichever backend is configured; the
	document, the reconciler, and the simulation are exactly as they were.
	With no backend chosen this file draws nothing and costs nothing — the
	default is "off" on purpose, since one of the two backends bills per
	second and the other assumes a local GPU server that may not be running.

	The panel this injects in the corner is how a person switches backends or
	types a custom style while the scene is running. attach() is how a page
	wires one in ahead of time. Either can be used without the other.

*/

(function(global) {

	"use strict";

	/*

		The default style. Deliberately conservative: it asks for more detail
		at the same layout rather than a different picture, because a game
		still has to be legible as the game it is. A custom prompt overrides
		this outright — see the "custom style" note in each backend below for
		how strongly it is allowed to depart from the input.

	*/
	const DEFAULT_PROMPT = (
		"The exact same scene, unchanged in layout, camera angle, colors, and " +
		"composition. Increase surface and geometric detail as though every " +
		"model were re-rendered at maximum polygon count with sharp, high " +
		"resolution textures and refined lighting. Do not add, remove, " +
		"recolor, or relocate any object. Do not change the art style or mood."
	);

	const DEFAULTS = {
		backend: "off",
		prompt: null,
		fps: 24,

		/* lucy */
		apiKey: null,
		model: "lucy-2.5",
		enhance: true,

		/* streamdiffusion */
		endpoint: "ws://localhost:8189/stylize",
		quality: 0.82,

		/* shared */
		panel: true,
		autoStart: false
	};

	const attachments = new Map();

	// ------------------------------------------------------------- utility

	const log = (...args) => console.log("[ace-stylize]", ...args);
	const warn = (...args) => console.warn("[ace-stylize]", ...args);

	const styleOf = (rules) => Object.entries(rules)
		.map(([key, value]) => key + ":" + value).join(";");

	// ------------------------------------------------------------ backends

	/*

		A backend is anything with connect(canvas, config) -> a handle with
		disconnect() and setPrompt(text). What it does with the frames is its
		own business; attach() only needs those two calls.

	*/
	const backends = {};

	// --- Decart's hosted realtime API (Lucy). Bills per second of video;
	//     nothing streams until connect() is called.
	backends.lucy = {

		async connect(canvas, config, output) {

			if(!global.decartai || typeof global.decartai.createDecartClient !== "function") {

				throw new Error(
					"the Decart SDK is not loaded. Add before this script:\n" +
					'  <script type="module">\n' +
					'    import { createDecartClient, models } from ' +
					'"https://esm.sh/@decartai/sdk";\n' +
					"    window.decartai = { createDecartClient, models };\n" +
					"  </script>\n" +
					"or npm install @decartai/sdk and bundle it yourself. " +
					"See stylize/README.md."
				);
			}

			if(!config.apiKey) {
				throw new Error("backend \"lucy\" needs an apiKey (see stylize/README.md)");
			}

			const { createDecartClient, models } = global.decartai;

			const model = models.realtime(config.model);

			/*

				captureStream reads whatever the canvas has drawn each time a
				new frame is requested; nothing else on the page changes. The
				engine already sets preserveDrawingBuffer, which this depends
				on to read a WebGL canvas at all.

			*/
			const stream = canvas.captureStream(config.fps);

			const client = createDecartClient({ apiKey: config.apiKey });

			const realtime = await client.realtime.connect(stream, {
				model,
				mirror: false,
				initialState: {
					prompt: { text: config.prompt, enhance: config.enhance }
				},
				onRemoteStream: (transformed) => {

					output.srcObject = transformed;
					output.play().catch(() => { });
				}
			});

			log("lucy: connected, model", config.model);

			return {

				disconnect: () => realtime.disconnect(),

				setPrompt: (text) => {

					if(typeof realtime.set === "function") {
						realtime.set({ prompt: text, enhance: config.enhance });
					} else if(typeof realtime.setPrompt === "function") {
						realtime.setPrompt(text);
					}
				}
			};
		}
	};

	// --- a local StreamDiffusion server (stylize/server). Nothing bills;
	//     nothing runs until a server is started and this connects to it.
	backends.streamdiffusion = {

		connect(canvas, config, output) {

			return new Promise((resolve, reject) => {

				const socket = new WebSocket(config.endpoint);
				let settled = false;
				let sending = false;
				let closed = false;

				const grab = document.createElement("canvas");
				const context = grab.getContext("2d");

				const drawing = document.createElement("canvas");
				const drawn = drawing.getContext("2d");

				output.replaceWith(drawing);
				drawing.id = output.id;

				socket.binaryType = "arraybuffer";

				socket.addEventListener("open", () => {

					socket.send(JSON.stringify({
						type: "configure",
						prompt: config.prompt,
						fps: config.fps
					}));

					settled = true;

					log("streamdiffusion: connected to", config.endpoint);

					const timer = setInterval(() => {

						if(closed) { clearInterval(timer); return; }

						if(sending || socket.bufferedAmount > 2_000_000)
							return;

						grab.width = canvas.width;
						grab.height = canvas.height;

						context.drawImage(canvas, 0, 0);

						grab.toBlob((blob) => {

							if(!blob || closed) return;

							sending = true;

							blob.arrayBuffer().then((bytes) => {

								if(!closed) socket.send(bytes);

							}).finally(() => { sending = false; });

						}, "image/jpeg", config.quality);

					}, Math.round(1000 / config.fps));

					resolve({

						disconnect: () => {

							closed = true;
							clearInterval(timer);
							socket.close();
							drawing.replaceWith(output);
						},

						setPrompt: (text) => {

							socket.send(JSON.stringify({ type: "prompt", prompt: text }));
						}
					});
				});

				socket.addEventListener("message", (event) => {

					if(!(event.data instanceof ArrayBuffer))
						return;

					const blob = new Blob([event.data], { type: "image/jpeg" });
					const url = URL.createObjectURL(blob);
					const image = new Image();

					image.onload = () => {

						drawing.width = image.width;
						drawing.height = image.height;

						drawn.drawImage(image, 0, 0);

						URL.revokeObjectURL(url);
					};

					image.src = url;
				});

				socket.addEventListener("error", () => {

					if(!settled) {

						reject(new Error(
							"could not reach " + config.endpoint +
							" — is stylize/server/streamdiffusion_server.py running? " +
							"See stylize/README.md."
						));
					}
				});

				socket.addEventListener("close", () => { closed = true; });
			});
		}
	};

	// ---------------------------------------------------------------- panel

	/*

		A small floating control, not a designed surface: pick a backend, type
		a style, watch what it says. It matches the demos' own look (dark,
		monospace) rather than introducing a second visual language.

	*/
	const buildPanel = (canvas, state) => {

		const root = document.createElement("div");

		root.style.cssText = styleOf({
			position: "fixed", right: "12px", bottom: "12px", width: "260px",
			background: "#11141bdd", border: "1px solid #232833",
			"border-radius": "8px", padding: "10px", "z-index": "9999",
			font: "12px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace",
			color: "#d8dee9", "backdrop-filter": "blur(4px)"
		});

		root.innerHTML =
			'<div style="display:flex;justify-content:space-between;' +
				'align-items:center;margin-bottom:6px">' +
				'<b style="color:#e8b877">stylize</b>' +
				'<button data-role="fold" style="background:none;border:none;' +
					'color:#7d8798;cursor:pointer;font:inherit">\u2013</button>' +
			"</div>" +
			'<div data-role="body">' +
				'<select data-role="backend" style="width:100%;margin-bottom:6px;' +
					'background:#0c0e13;color:#d8dee9;border:1px solid #232833;' +
					'padding:4px;font:inherit">' +
					'<option value="off">off</option>' +
					'<option value="lucy">lucy (hosted)</option>' +
					'<option value="streamdiffusion">streamdiffusion (local)</option>' +
				"</select>" +
				'<textarea data-role="prompt" rows="3" placeholder="custom style, ' +
					'or leave blank for the default enhance pass" style="width:100%;' +
					'resize:vertical;background:#0c0e13;color:#d8dee9;' +
					'border:1px solid #232833;padding:4px;font:inherit;' +
					'margin-bottom:6px;box-sizing:border-box"></textarea>' +
				'<button data-role="toggle" style="width:100%;padding:5px;' +
					'background:#1c212c;color:#cfe0ff;border:1px solid #2d3444;' +
					'border-radius:4px;cursor:pointer;font:inherit">connect</button>' +
				'<div data-role="status" style="margin-top:6px;color:#7d8798;' +
					'font-size:11px"></div>' +
			"</div>";

		document.body.appendChild(root);

		const body = root.querySelector('[data-role="body"]');
		const fold = root.querySelector('[data-role="fold"]');
		const select = root.querySelector('[data-role="backend"]');
		const prompt_ = root.querySelector('[data-role="prompt"]');
		const toggle = root.querySelector('[data-role="toggle"]');
		const status = root.querySelector('[data-role="status"]');

		select.value = state.config.backend;

		fold.addEventListener("click", () => {

			const open = body.style.display !== "none";

			body.style.display = open ? "none" : "block";
			fold.textContent = open ? "+" : "\u2013";
		});

		const setStatus = (text, tone) => {

			status.textContent = text;
			status.style.color = tone === "bad" ? "#e08080"
				: tone === "good" ? "#8fd0a0" : "#7d8798";
		};

		toggle.addEventListener("click", async () => {

			if(state.handle) {

				state.handle.disconnect();
				state.handle = null;

				toggle.textContent = "connect";
				setStatus("disconnected");

				return;
			}

			const chosen = select.value;

			if(chosen === "off") {

				setStatus("choose a backend first", "bad");
				return;
			}

			state.config.backend = chosen;
			state.config.prompt = prompt_.value.trim() || null;

			toggle.textContent = "connecting\u2026";
			toggle.disabled = true;
			setStatus("connecting to " + chosen + "\u2026");

			try {

				state.handle = await start(canvas, state);

				toggle.textContent = "disconnect";
				setStatus("running: " + chosen, "good");

			} catch(error) {

				setStatus(error.message, "bad");
				warn(error.message);

			} finally {

				toggle.disabled = false;
			}
		});

		return root;
	};

	// ------------------------------------------------------------- driving

	const start = async (canvas, state) => {

		const backend = backends[state.config.backend];

		if(backend == null) {
			throw new Error("no backend named \"" + state.config.backend + "\"");
		}

		const config = Object.assign({}, state.config, {
			prompt: state.config.prompt || DEFAULT_PROMPT
		});

		if(state.output == null) {

			state.output = document.createElement(
				state.config.backend === "lucy" ? "video" : "canvas"
			);

			state.output.id = "ace-stylize-output-" + Math.random().toString(36).slice(2);
			state.output.autoplay = true;
			state.output.muted = true;
			state.output.playsInline = true;

			state.output.style.cssText = styleOf({
				position: "absolute", inset: "0",
				width: "100%", height: "100%"
			});

			canvas.style.position = canvas.style.position || "relative";
			canvas.parentNode.insertBefore(state.output, canvas.nextSibling);
		}

		return backend.connect(canvas, config, state.output);
	};

	// -------------------------------------------------------------- public

	const attach = (canvas, options) => {

		if(canvas == null) {
			throw new Error("AceStylize.attach needs a canvas element");
		}

		const config = Object.assign({}, DEFAULTS, options || { });

		const state = { config, handle: null, output: null, panel: null };

		attachments.set(canvas, state);

		if(config.panel) {
			state.panel = buildPanel(canvas, state);
		}

		if(config.autoStart && config.backend !== "off") {

			start(canvas, state).then((handle) => {

				state.handle = handle;

				if(state.panel) {

					state.panel.querySelector('[data-role="toggle"]').textContent
						= "disconnect";
				}

			}).catch((error) => warn(error.message));
		}

		return {

			setPrompt: (text) => { if(state.handle) state.handle.setPrompt(text); },

			detach: () => {

				if(state.handle) state.handle.disconnect();
				if(state.panel) state.panel.remove();
				if(state.output) state.output.remove();

				attachments.delete(canvas);
			}
		};
	};

	global.AceStylize = {
		attach,
		backends,
		DEFAULT_PROMPT
	};

})(typeof window !== "undefined" ? window : globalThis);
