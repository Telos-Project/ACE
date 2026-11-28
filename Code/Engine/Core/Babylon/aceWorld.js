/*

	ACE - Babylon.js world extensions.

	Loads after aceOperators.js. Adds the components a large open world needs and
	that the base adapter has no way to express without carrying the whole world
	inside the document:

		terrain    A streamed, level-of-detail heightfield read from an image,
		           shaded from a splat map and a set of tiling material layers.
		scatter    Many copies of a few models, read from a binary table and drawn
		           by chunk, with a model per distance band.
		particles  A particle emitter.
		speech     A voice, through the host's speech synthesis.
		storage    A value the host keeps between sessions.
		water      The sea: depth-coloured, foamed, rippled, seen from both sides.
		clouds     Clouds: heaps of lit puffs in three dimensions.

	The common thread is that bulk data stays in files. Every script receives the
	serialised document on every frame, and the reconciler compares every
	component's data on every frame, so a document that held a million height
	samples or fifty thousand tree positions would spend its whole frame on them.

	See "ACE Liberty.md" sections 2.3.18 to 2.3.20.

*/

(function(root) {
	/* The files that add to the adapter may be loaded in any order after ace.js: one that arrives before the adapter
	   waits for it, and the adapter starts it when it is made. */
	const extension = function() {


	const ace = root.ace;
	const BABYLON = root.BABYLON;
	const H = ace.adapter.helpers;

	const isObject = value =>
		value != null && typeof value === "object" && !Array.isArray(value);

	const sourcesOf = value =>
		(Array.isArray(value) ? value : [value]).filter(
			candidate => typeof candidate === "string"
		);

	/* Tries each candidate location in turn (APInt 2.1.2). */
	const fetchFirst = async (locations, kind) => {

		let failure = null;

		for(const location of locations) {

			try {

				let response = await fetch(location);

				if(!response.ok)
					throw new Error("HTTP " + response.status);

				return { location, data: await response[kind]() };

			} catch(error) {

				failure = error;
			}
		}

		throw failure != null ? failure : new Error("no source");
	};

	const now = () =>
		root.performance != null ? root.performance.now() : Date.now();

	// ================================================================ terrain

	/*

		Height samples are read from an image. Two encodings:

			"rg16"  red is the high byte and green the low byte of a sixteen
			        bit height, which is what lets a 600 m range come out
			        without terracing.
			"r8"    a single eight bit channel.

		Samples are a grid of columns along +X and rows along -Z, the same
		orientation the mesh heightmap uses.

	*/
	const decodeHeights = async (bitmap, encoding) => {

		let canvas = typeof OffscreenCanvas !== "undefined" ?
			new OffscreenCanvas(bitmap.width, bitmap.height) :
			Object.assign(root.document.createElement("canvas"), {
				width: bitmap.width, height: bitmap.height
			});

		let context = canvas.getContext("2d", { willReadFrequently: true });

		context.drawImage(bitmap, 0, 0);

		let pixels = context.getImageData(0, 0, bitmap.width, bitmap.height).data;
		let heights = new Float32Array(bitmap.width * bitmap.height);

		if(encoding === "r8") {

			for(let index = 0; index < heights.length; index++)
				heights[index] = pixels[index * 4] / 255;

		} else {

			for(let index = 0; index < heights.length; index++) {

				heights[index] =
					(pixels[index * 4] * 256 + pixels[index * 4 + 1]) / 65535;
			}
		}

		return { heights, width: bitmap.width, height: bitmap.height };
	};

	/*

		The same heights, without a canvas. Drawing an image to a canvas and
		reading it back hands the bytes to the browser to treat as a picture:
		it may convert colours for the display, premultiply, or (with its
		fingerprinting protection on) change the low bits of what is read, and
		a height held in two bytes is wrecked by any of them: one step of the
		high byte is metres of ground. A PNG is read here directly: the
		chunks, the inflate, the row filters. Only the plain forms are
		handled (8 bits a channel, not interlaced); anything else returns
		null and the canvas is used.

	*/
	const inflate = async bytes => {

		let stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate"));

		return new Uint8Array(await new Response(stream).arrayBuffer());
	};

	const decodePng = async buffer => {

		if(typeof DecompressionStream === "undefined")
			return null;

		let d = new Uint8Array(buffer);
		let signature = [137, 80, 78, 71, 13, 10, 26, 10];

		if(d.length < 33 || signature.some((value, index) => d[index] !== value))
			return null;

		let view = new DataView(d.buffer, d.byteOffset, d.byteLength);
		let at = 8, width = 0, height = 0, depth = 0, type = 0, interlace = 0, parts = [];

		while(at + 8 <= d.length) {

			let length = view.getUint32(at);
			let name = String.fromCharCode(d[at + 4], d[at + 5], d[at + 6], d[at + 7]);

			if(name === "IHDR") {

				width = view.getUint32(at + 8);
				height = view.getUint32(at + 12);
				depth = d[at + 16];
				type = d[at + 17];
				interlace = d[at + 20];

			} else if(name === "IDAT") {

				parts.push(d.subarray(at + 8, at + 8 + length));

			} else if(name === "IEND") {

				break;
			}

			at += 12 + length;
		}

		let channels = type === 0 ? 1 : type === 2 ? 3 : type === 6 ? 4 : 0;

		if(depth !== 8 || interlace !== 0 || channels === 0 || width === 0 || parts.length === 0)
			return null;

		let joined = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
		let place = 0;

		parts.forEach(part => { joined.set(part, place); place += part.length; });

		let raw = await inflate(joined);
		let stride = width * channels;

		if(raw.length < (stride + 1) * height)
			return null;

		let out = new Uint8Array(stride * height);

		for(let row = 0; row < height; row++) {

			let filter = raw[row * (stride + 1)];
			let from = row * (stride + 1) + 1;
			let into = row * stride;
			let above = into - stride;

			for(let x = 0; x < stride; x++) {

				let value = raw[from + x];
				let left = x >= channels ? out[into + x - channels] : 0;
				let up = row > 0 ? out[above + x] : 0;
				let corner = row > 0 && x >= channels ? out[above + x - channels] : 0;

				if(filter === 1)
					value += left;
				else if(filter === 2)
					value += up;
				else if(filter === 3)
					value += (left + up) >> 1;
				else if(filter === 4) {

					let guess = left + up - corner;
					let a = Math.abs(guess - left), b = Math.abs(guess - up), c = Math.abs(guess - corner);

					value += a <= b && a <= c ? left : b <= c ? up : corner;

				} else if(filter !== 0)
					return null;

				out[into + x] = value & 255;
			}
		}

		return { width, height, channels, data: out };
	};

	/* Heights in [0,1] from the location of an image: exact where the image is a plain PNG, through a canvas where it is not. */
	const loadHeights = async (locations, encoding) => {

		let result = await fetchFirst(locations, "arrayBuffer");
		let png = null;

		try { png = await decodePng(result.data); } catch(error) { png = null; }

		if(png != null) {

			let count = png.width * png.height;
			let heights = new Float32Array(count);

			if(encoding === "r8" || png.channels === 1) {

				for(let index = 0; index < count; index++)
					heights[index] = png.data[index * png.channels] / 255;

			} else {

				for(let index = 0; index < count; index++) {

					heights[index] = (png.data[index * png.channels] * 256 +
						png.data[index * png.channels + 1]) / 65535;
				}
			}

			return { heights, width: png.width, height: png.height, location: result.location, exact: true };
		}

		let bitmap = await root.createImageBitmap(new Blob([result.data]), {
			colorSpaceConversion: "none",
			premultiplyAlpha: "none"
		});

		let decoded = await decodeHeights(bitmap, encoding);

		decoded.location = result.location;
		decoded.exact = false;

		return decoded;
	};

	const TERRAIN_VERTEX = `
		precision highp float;
		attribute vec3 position;
		attribute vec3 normal;
		uniform mat4 world;
		uniform mat4 viewProjection;
		varying vec3 vWorld;
		varying vec3 vNormal;
		void main(void) {
			vec4 w = world * vec4(position, 1.0);
			vWorld = w.xyz;
			vNormal = normalize(mat3(world) * normal);
			gl_Position = viewProjection * w;
		}
	`;

	const TERRAIN_FRAGMENT = `
		precision highp float;
		varying vec3 vWorld;
		varying vec3 vNormal;
		uniform vec3 camPos;
		uniform vec3 sunDir;
		uniform vec3 sunColor;
		uniform vec3 skyColor;
		uniform vec3 groundColor;
		uniform vec3 fogColor;
		uniform float fogDensity;
		uniform float exposure;
		uniform vec3 grassTint;
		uniform vec4 rect;
		uniform vec4 tiles;
		uniform vec2 fade;
		uniform sampler2D splat, forestMap;
		uniform sampler2D grassD, grassN, dirtD, dirtN, rockD, rockN, sandD, sandN, snowD, snowN;

		vec3 lin(vec3 c) { return pow(c, vec3(2.2)); }

		// Near the viewer the layer tiles finely. Further away it fades to its own average colour, modulated by a
		// very large tile so the landscape keeps a believable variation instead of a visible repeat.
		vec3 sampleLayer(sampler2D t, vec2 p, float tile, float far, float f) {
			vec3 near = lin(texture2D(t, p / tile).rgb);
			vec3 mean = lin(texture2D(t, p / far, 9.0).rgb);
			vec3 macro = lin(texture2D(t, p / far).rgb) / max(mean, vec3(0.02));
			macro = clamp(macro, vec3(0.55), vec3(1.7));
			vec3 mid = clamp(lin(texture2D(t, p / (tile * 4.3)).rgb) / max(mean, vec3(0.02)), vec3(0.6), vec3(1.6));
			return mix(near, mean, f) * mix(vec3(1.0), macro, 0.4) * mix(vec3(1.0), sqrt(mid), 0.55 * (1.0 - f));
		}

		void main(void) {
			vec3 N = normalize(vNormal);
			vec3 toCam = camPos - vWorld;
			float dist = length(toCam);
			vec2 p = vWorld.xz;

			vec2 suv = vec2(0.5 + (vWorld.x - rect.x) / rect.z, 0.5 + (vWorld.z - rect.y) / rect.w);
			vec4 sp = texture2D(splat, suv);

			// steep ground is rock whatever the splat map says
			float steep = smoothstep(0.34, 0.56, 1.0 - N.y);
			float wRock = clamp(max(sp.r, steep), 0.0, 1.0);
			float wSnow = sp.b * (1.0 - smoothstep(0.52, 0.80, 1.0 - N.y));
			float wSand = sp.g * (1.0 - steep);
			wRock *= 1.0 - wSnow;
			float wDirt = sp.a * (1.0 - steep);
			float wGrass = max(1.0 - wRock - wSnow - wSand - wDirt, 0.0);
			float total = wRock + wSnow + wSand + wDirt + wGrass;
			wRock /= total; wSnow /= total; wSand /= total; wDirt /= total; wGrass /= total;

			float f = smoothstep(tiles.w * 0.25, tiles.w * 1.1, dist);
			float tn = tiles.x, tf = tiles.y;

			vec3 albedo = vec3(0.0);
			vec2 nm = vec2(0.0);
			float detail = 1.0 - smoothstep(40.0, 260.0, dist);

			if (wGrass > 0.003) {
				albedo += wGrass * sampleLayer(grassD, p, tn, tf, f) * grassTint;
				if (detail > 0.0) nm += wGrass * (texture2D(grassN, p / tn).xy * 2.0 - 1.0);
			}
			if (wDirt > 0.003) {
				albedo += wDirt * sampleLayer(dirtD, p, tn, tf, f);
				if (detail > 0.0) nm += wDirt * (texture2D(dirtN, p / tn).xy * 2.0 - 1.0);
			}
			if (wSand > 0.003) {
				albedo += wSand * sampleLayer(sandD, p, tn * 1.2, tf, f);
				if (detail > 0.0) nm += wSand * (texture2D(sandN, p / (tn * 1.2)).xy * 2.0 - 1.0);
			}
			if (wSnow > 0.003) {
				albedo += wSnow * sampleLayer(snowD, p, tn * 1.5, tf, f);
				if (detail > 0.0) nm += wSnow * (texture2D(snowN, p / (tn * 1.5)).xy * 2.0 - 1.0);
			}
			if (wRock > 0.003) {
				vec3 bw = pow(abs(N), vec3(4.0));
				bw /= (bw.x + bw.y + bw.z);
				float rt = tiles.z;
				vec3 r = bw.y * sampleLayer(rockD, p, rt, rt * 27.3, f)
					+ bw.x * sampleLayer(rockD, vWorld.zy, rt, rt * 27.3, f)
					+ bw.z * sampleLayer(rockD, vWorld.xy, rt, rt * 27.3, f);
				float rl = dot(r, vec3(0.3, 0.59, 0.11));
				r = mix(r, vec3(rl), 0.4) * vec3(0.88, 0.9, 0.97);
				albedo += wRock * r;
				if (detail > 0.0) nm += wRock * (1.0 - steep) * (texture2D(rockN, p / rt).xy * 2.0 - 1.0);   // projected from above, a normal map only streaks a cliff
			}

			// woodland: darker, greener ground under the trees, which is also what shows from far above
			float woods = texture2D(forestMap, suv).r;
			albedo *= mix(vec3(1.0), vec3(0.5, 0.66, 0.42), woods * 0.9);

			vec3 n = normalize(N + vec3(nm.x, 0.0, nm.y) * 0.9 * detail);

			float ndl = max(dot(n, sunDir), 0.0);
			vec3 hemi = mix(groundColor, skyColor, n.y * 0.5 + 0.5);
			vec3 col = albedo * (sunColor * ndl + hemi * 1.45) * exposure;

			// PBR materials apply fog after the gamma curve, so the haze is mixed in display space here as well
			float fog = 1.0 - exp(-pow(dist * fogDensity, 2.0));
			col = pow(col, vec3(1.0 / 2.2));
			col = mix(col, fogColor, clamp(fog, 0.0, 1.0));

			// far enough away the ground is less and less there, and then not there at all
			float seen = fade.y > fade.x ? 1.0 - smoothstep(fade.x, fade.y, dist) : 1.0;

			if (seen <= 0.004) discard;

			gl_FragColor = vec4(col, seen);
		}
	`;

	const DEFAULT_LAYERS = {
		grass: ["Assets/Textures/grass_diff.jpg", "Assets/Textures/grass_nor.jpg"],
		dirt: ["Assets/Textures/dirt_diff.jpg", "Assets/Textures/dirt_nor.jpg"],
		rock: ["Assets/Textures/rock_diff.jpg", "Assets/Textures/rock_nor.jpg"],
		sand: ["Assets/Textures/sand_diff.jpg", "Assets/Textures/sand_nor.jpg"],
		snow: ["Assets/Textures/snow_diff.jpg", "Assets/Textures/snow_nor.jpg"]
	};

	const terrainMaterial = (context, instance, grid) => {

		let scene = context.meta.scene;
		let data = instance.data;
		let layers = isObject(data.layers) ? data.layers : { };

		if(BABYLON.Effect.ShadersStore.aceTerrainVertexShader == null) {

			BABYLON.Effect.ShadersStore.aceTerrainVertexShader = TERRAIN_VERTEX;
			BABYLON.Effect.ShadersStore.aceTerrainFragmentShader = TERRAIN_FRAGMENT;
		}

		let material = new BABYLON.ShaderMaterial(
			instance.path.join(".") + ".material",
			scene,
			{ vertex: "aceTerrain", fragment: "aceTerrain" },
			{
				attributes: ["position", "normal"],
				uniforms: [
					"world", "viewProjection", "camPos", "sunDir", "sunColor",
					"skyColor", "groundColor", "fogColor", "fogDensity", "exposure", "grassTint",
					"rect", "tiles", "fade"
				],
				samplers: [
					"splat", "forestMap", "grassD", "grassN", "dirtD", "dirtN", "rockD", "rockN",
					"sandD", "sandN", "snowD", "snowN"
				]
			}
		);

		material.backFaceCulling = false;
		material.needAlphaBlending = () => material.blended === true;
		material.forceDepthWrite = true;      // translucent, it is still a solid surface: the ground behind it does not show through the ground in front

		const texture = (url, repeat) => {

			let result = new BABYLON.Texture(
				url, scene, false, true, BABYLON.Texture.TRILINEAR_SAMPLINGMODE
			);

			result.wrapU = result.wrapV = repeat ?
				BABYLON.Texture.WRAP_ADDRESSMODE : BABYLON.Texture.CLAMP_ADDRESSMODE;

			if(repeat)
				result.anisotropicFilteringLevel = 8;

			return result;
		};

		let owned = [];

		const bind = (sampler, url, repeat) => {

			let result = texture(url, repeat);

			owned.push(result);
			material.setTexture(sampler, result);
		};

		bind("splat", layers.splat != null ? layers.splat : "Assets/Terrain/splat.png", false);
		bind("forestMap", layers.forest != null ? layers.forest : "Assets/Terrain/forest.png", false);

		Object.keys(DEFAULT_LAYERS).forEach(name => {

			let given = isObject(layers[name]) ? layers[name] : { };

			bind(name + "D", given.base != null ? given.base : DEFAULT_LAYERS[name][0], true);
			bind(name + "N", given.normal != null ? given.normal : DEFAULT_LAYERS[name][1], true);
		});

		let tile = data.tile != null ? data.tile : 6;

		material.setColor3("grassTint", H.color3(data.grassTint, [1, 1, 1]));
		material.setVector2("fade", Array.isArray(data.fade) && data.fade.length > 1 ?
			new BABYLON.Vector2(data.fade[0], data.fade[1]) : new BABYLON.Vector2(0, 0));
		material.setVector4("rect", new BABYLON.Vector4(0, 0, grid.size[0], grid.size[1]));
		material.setVector4("tiles", new BABYLON.Vector4(
			tile,
			tile * 23.7,
			data.rockTile != null ? data.rockTile : 9,
			data.blend != null ? data.blend : 320
		));

		return { material, owned };
	};

	/*

		One chunk's vertex data at a given step. Normals come from the full
		resolution grid so that lighting does not shift when a chunk changes
		level, and a skirt hangs below each edge so that neighbours at
		different levels cannot show a crack between them.

	*/
	const chunkGeometry = (grid, column, row, step, skirt) => {

		let { heights, width, height, size, elevation, cells } = grid;
		let cellX = size[0] / (width - 1);
		let cellZ = size[1] / (height - 1);
		let rise = elevation[1] - elevation[0];
		let per = cells / step + 1;

		const at = (i, j) => heights[
			Math.min(Math.max(j, 0), height - 1) * width +
			Math.min(Math.max(i, 0), width - 1)
		];

		let positions = [];
		let normals = [];
		let indices = [];

		const vertex = (i, j, drop) => {

			let y = elevation[0] + rise * at(i, j);

			positions.push(
				(i / (width - 1) - 0.5) * size[0],
				y - drop,
				(0.5 - j / (height - 1)) * size[1]
			);

			let dx = (at(i + step, j) - at(i - step, j)) * rise / (2 * step * cellX);
			let dz = (at(i, j - step) - at(i, j + step)) * rise / (2 * step * cellZ);
			let length = Math.sqrt(dx * dx + 1 + dz * dz);

			normals.push(-dx / length, 1 / length, -dz / length);
		};

		for(let j = 0; j < per; j++) {

			for(let i = 0; i < per; i++)
				vertex(column * cells + i * step, row * cells + j * step, 0);
		}

		for(let j = 0; j < per - 1; j++) {

			for(let i = 0; i < per - 1; i++) {

				let a = j * per + i;
				let b = a + 1;
				let c = a + per;
				let d = c + 1;

				indices.push(a, b, c, b, d, c);
			}
		}

		const edge = (index, next) => {

			let start = positions.length / 3;

			for(let k = 0; k < per; k++) {

				let at = index(k);
				let i = column * cells + (at % per) * step;
				let j = row * cells + Math.floor(at / per) * step;

				vertex(i, j, skirt);
			}

			for(let k = 0; k < per - 1; k++) {

				let top = index(k);
				let topNext = index(k + 1);

				indices.push(
					top, topNext, start + k,
					topNext, start + k + 1, start + k
				);
			}
		};

		edge(k => k);                       // north (row 0)
		edge(k => (per - 1) * per + k);     // south
		edge(k => k * per);                 // west
		edge(k => k * per + per - 1);       // east

		return { positions, normals, indices };
	};

	const terrain = {

		type: "terrain",
		order: 5,

		onCreate: (context, instance) => {

			let object = {
				disposed: false,
				ready: false,
				grid: null,
				key: instance.entityKey,
				chunks: [],
				material: null,
				owned: [],
				node: H.nodeFor(context, instance.entity),
				frame: 0,
				last: null,
				fixed: null
			};

			let data = instance.data;
			let locations = sourcesOf(instance.source);

			if(locations.length === 0) {

				ace.setState(context, instance.record, {
					loaded: false, error: "terrain has no source"
				});

				return object;
			}

			ace.setState(context, instance.record, { loaded: false });

			loadHeights(locations, data.encoding != null ? data.encoding : "rg16").then(async decoded => {

				let result = { location: decoded.location };

				if(object.disposed)
					return;

				let size = Array.isArray(data.size) ? data.size : [1000, 1000];

				let grid = Object.assign(decoded, {
					size,
					elevation: Array.isArray(data.elevation) ? data.elevation : [0, 100],
					cells: data.chunk != null ? data.chunk : 128
				});

				let across = (grid.width - 1) / grid.cells;
				let down = (grid.height - 1) / grid.cells;

				if(across !== Math.floor(across) || down !== Math.floor(down)) {

					ace.setState(context, instance.record, {
						loaded: false,
						error: "heightmap size minus one must be a multiple of the chunk size"
					});

					return;
				}

				object.grid = grid;

				/* the ground can be asked how high it is anywhere, without a ray: see ace.adapter.groundAt */
				context.meta.terrains = (context.meta.terrains || []).filter(
					entry => entry.object !== object
				).concat([{ key: object.key, object }]);

				let built = terrainMaterial(context, instance, grid);

				object.material = built.material;
				object.owned = built.owned;
				object.material.blended = false;

				for(let row = 0; row < down; row++) {

					for(let column = 0; column < across; column++) {

						let x0 = (column * grid.cells / (grid.width - 1) - 0.5) * size[0];
						let x1 = ((column + 1) * grid.cells / (grid.width - 1) - 0.5) * size[0];
						let z0 = (0.5 - row * grid.cells / (grid.height - 1)) * size[1];
						let z1 = (0.5 - (row + 1) * grid.cells / (grid.height - 1)) * size[1];

						object.chunks.push({
							column, row, lod: -1, mesh: null,
							cx: (x0 + x1) / 2, cz: (z0 + z1) / 2,
							half: Math.abs(x1 - x0) / 2
						});
					}
				}

				object.ready = true;

				ace.setState(context, instance.record, {
					loaded: true,
					exact: decoded.exact,
					source: result.location,
					chunks: object.chunks.length,
					size,
					resolution: [grid.width, grid.height]
				});

			}).catch(error => {

				ace.setState(context, instance.record, {
					loaded: false, error: error.message
				});
			});

			return object;
		},

		/* Streaming is re-evaluated whenever the viewer has moved, and at worst every few frames. */
		onUpdate: (context, instance) => {

			let object = instance.object;

			if(!object.ready)
				return;

			let scene = context.meta.scene;
			let camera = scene.activeCamera;

			if(camera == null)
				return;

			let data = instance.data;
			let lods = Array.isArray(data.lods) ? data.lods : [
				{ range: 700, step: 1 }, { range: 1600, step: 2 },
				{ range: 3400, step: 4 }, { range: 1e9, step: 8 }
			];

			/* The sun, the sky, and the haze come from whatever the document set on the scene. */
			let material = object.material;
			let eye = camera.globalPosition;

			material.setVector3("camPos", eye);
			material.setColor3("fogColor", scene.fogColor);
			material.setFloat("fogDensity",
				scene.fogMode === BABYLON.Scene.FOGMODE_EXP2 ? scene.fogDensity : 0);
			material.setFloat("exposure", scene.imageProcessingConfiguration.exposure);

			/* Some of it is further than the fade begins: from here on it is drawn translucent, nearer it is not. */
			if(Array.isArray(data.fade) && data.fade.length > 1 && object.grid != null) {

				let centre = object.node.absolutePosition;
				let reach = Math.hypot(
					Math.abs(eye.x - centre.x) + object.grid.size[0] / 2,
					Math.abs(eye.z - centre.z) + object.grid.size[1] / 2
				);

				object.blended = reach > data.fade[0];

			} else {

				object.blended = false;
			}

			material.blended = object.blended;

			let sun = null;
			let sky = null;

			scene.lights.forEach(light => {

				if(light instanceof BABYLON.DirectionalLight && sun == null)
					sun = light;

				if(light instanceof BABYLON.HemisphericLight && sky == null)
					sky = light;
			});

			if(sun != null) {

				let direction = sun.getAbsoluteDirection != null ?
					sun.getAbsoluteDirection() : sun.direction;

				material.setVector3("sunDir", direction.scale(-1).normalize());
				material.setColor3("sunColor", sun.diffuse.scale(sun.intensity));

			} else {

				material.setVector3("sunDir", new BABYLON.Vector3(0.3, 0.8, 0.4).normalize());
				material.setColor3("sunColor", new BABYLON.Color3(0, 0, 0));
			}

			material.setColor3("skyColor", sky != null ?
				sky.diffuse.scale(sky.intensity) : new BABYLON.Color3(0.3, 0.3, 0.3));

			material.setColor3("groundColor", sky != null ?
				sky.groundColor.scale(sky.intensity) : new BABYLON.Color3(0.1, 0.1, 0.1));

			if(!object.node.isEnabled(true)) {

				object.last = null;
				object.pending = null;

				ace.setState(context, instance.record, {
					live: object.chunks.filter(chunk => chunk.mesh != null).length, queued: 0
				});

				return;
			}

			object.node.computeWorldMatrix(true);

			let origin = object.node.absolutePosition;

			material.setVector4("rect", new BABYLON.Vector4(
				origin.x, origin.z, object.grid.size[0], object.grid.size[1]
			));

			object.frame++;

			let moved = object.last == null ||
				Math.abs(eye.x - object.last.x) > 6 ||
				Math.abs(eye.z - object.last.z) > 6 ||
				Math.abs(eye.y - object.last.y) > 25;

			if(!moved && object.frame % 20 !== 0 && object.pending == null)
				return;

			object.last = { x: eye.x, y: eye.y, z: eye.z };

			let grid = object.grid;
			let cell = grid.size[0] / (grid.width - 1);
			let pending = [];

			object.chunks.forEach(chunk => {

				let dx = Math.max(0, Math.abs(eye.x - origin.x - chunk.cx) - chunk.half);
				let dz = Math.max(0, Math.abs(eye.z - origin.z - chunk.cz) - chunk.half);
				let dy = eye.y - origin.y;
				let distance = Math.sqrt(dx * dx + dz * dz + dy * dy * 0.25);

				let wanted = lods.length - 1;

				for(let index = 0; index < lods.length; index++) {

					if(distance < lods[index].range) {

						wanted = index;
						break;
					}
				}

				if(wanted !== chunk.lod)
					pending.push({ chunk, wanted, distance });
			});

			pending.sort((a, b) => a.distance - b.distance);

			/* The first frames stream in the whole world; after that, a small slice each frame. */
			let budget = object.frame < 40 ? 28 : 4;
			let started = now();

			let built = 0;

			for(const entry of pending) {

				if(built > 0 && now() - started > budget)
					break;

				let { chunk, wanted } = entry;
				let step = lods[wanted].step;

				let geometry = chunkGeometry(
					grid, chunk.column, chunk.row, step,
					4 + step * cell * 0.4
				);

				let vertexData = new BABYLON.VertexData();

				vertexData.positions = geometry.positions;
				vertexData.normals = geometry.normals;
				vertexData.indices = geometry.indices;

				if(chunk.mesh == null) {

					chunk.mesh = new BABYLON.Mesh(
						instance.path.join(".") + ".chunk." + chunk.column + "." + chunk.row,
						scene
					);

					chunk.mesh.parent = object.node;
					chunk.mesh.material = material;
					chunk.mesh.receiveShadows = false;
					chunk.mesh.alphaIndex = 1;      // translucent, it is drawn before the sea (which is 5) and after what is behind it

					H.own(chunk.mesh, instance.entityKey);
				}

				vertexData.applyToMesh(chunk.mesh, false);
				chunk.mesh.refreshBoundingInfo();

				chunk.lod = wanted;
				built++;
			}

			object.pending = pending.length > built ? true : null;

			ace.setState(context, instance.record, {
				live: object.chunks.filter(chunk => chunk.mesh != null).length,
				queued: Math.max(0, pending.length - built)
			});
		},

		onDestroy: (context, instance) => {

			let object = instance.object;

			object.disposed = true;

			object.chunks.forEach(chunk => {

				if(chunk.mesh != null)
					chunk.mesh.dispose();
			});

			object.owned.forEach(texture => texture.dispose());

			if(object.material != null)
				object.material.dispose();
		}
	};

	// ================================================================ scatter

	const loadModel = async (context, locations) => {

		let scene = context.meta.scene;
		let failure = null;

		for(const location of locations) {

			try {

				let split = location.lastIndexOf("/") + 1;

				let content = await BABYLON.SceneLoader.ImportMeshAsync(
					"", location.substring(0, split), location.substring(split), scene
				);

				let parts = [];

				content.meshes.forEach(mesh => {

					if(mesh.getTotalVertices == null || mesh.getTotalVertices() === 0)
						return;

					mesh.computeWorldMatrix(true);

					parts.push({
						mesh,
						relative: mesh.getWorldMatrix().clone()
					});
				});

				content.meshes.forEach(mesh => mesh.setEnabled(false));

				return { content, parts, location };

			} catch(error) {

				failure = error;
			}
		}

		throw failure != null ? failure : new Error("no source");
	};

	const RECORD = 5; // x, y, z, yaw, scale

	const scatter = {

		type: "scatter",
		order: 6,

		onCreate: (context, instance) => {

			let object = {
				disposed: false,
				ready: false,
				models: [],
				buckets: new Map(),
				count: 0,
				frame: 0,
				last: null,
				node: H.nodeFor(context, instance.entity)
			};

			let data = instance.data;
			let locations = sourcesOf(data.table);

			if(locations.length === 0 || !Array.isArray(data.lods)) {

				ace.setState(context, instance.record, {
					loaded: false, error: "scatter needs data.table and data.lods"
				});

				return object;
			}

			ace.setState(context, instance.record, { loaded: false });

			Promise.all([
				fetchFirst(locations, "arrayBuffer"),
				Promise.all(data.lods.map(lod => loadModel(context, sourcesOf(lod.source))))
			]).then(([table, models]) => {

				if(object.disposed) {

					models.forEach(model =>
						model.content.meshes.forEach(mesh => mesh.dispose()));

					return;
				}

				object.models = models;

				let records = new Float32Array(table.data);
				let chunk = data.chunk != null ? data.chunk : 256;

				object.count = Math.floor(records.length / RECORD);

				let groups = new Map();

				for(let index = 0; index < object.count; index++) {

					let x = records[index * RECORD];
					let z = records[index * RECORD + 2];
					let key = Math.floor(x / chunk) + "," + Math.floor(z / chunk);

					if(!groups.has(key))
						groups.set(key, []);

					groups.get(key).push(index);
				}

				groups.forEach((list, key) => {

					let [i, j] = key.split(",").map(Number);
					let sum = 0;

					let array = new Float32Array(list.length * RECORD);

					list.forEach((source, slot) => {

						for(let k = 0; k < RECORD; k++)
							array[slot * RECORD + k] = records[source * RECORD + k];

						sum += records[source * RECORD + 1];
					});

					object.buckets.set(key, {
						array,
						count: list.length,
						cx: (i + 0.5) * chunk,
						cz: (j + 0.5) * chunk,
						cy: sum / list.length,
						half: chunk / 2,
						lod: -1,
						meshes: []
					});
				});

				object.ready = true;

				ace.setState(context, instance.record, {
					loaded: true,
					source: table.location,
					instances: object.count,
					chunks: object.buckets.size
				});

			}).catch(error => {

				ace.setState(context, instance.record, {
					loaded: false, error: error.message
				});
			});

			return object;
		},

		onUpdate: (context, instance) => {

			let object = instance.object;

			if(!object.ready)
				return;

			/*

				A scatter whose entity is switched off (an island the viewer is far
				from, a world the viewer has left) lets go of everything it had
				built and does no work at all until it is switched on again.

			*/
			if(!object.node.isEnabled(true)) {

				if(!object.asleep) {

					object.buckets.forEach(bucket => {

						bucket.meshes.forEach(mesh => mesh.dispose());
						bucket.meshes = [];
						bucket.lod = -1;
					});

					object.asleep = true;
				}

				/* Nothing is waiting on a scatter that is asleep. */
				ace.setState(context, instance.record, { live: 0, queued: 0 });

				return;
			}

			if(object.asleep) {

				object.asleep = false;
				object.last = null;
			}

			let scene = context.meta.scene;
			let camera = scene.activeCamera;

			if(camera == null)
				return;

			object.frame++;

			let eye = camera.globalPosition;

			let moved = object.last == null ||
				Math.abs(eye.x - object.last.x) > 8 ||
				Math.abs(eye.z - object.last.z) > 8 ||
				Math.abs(eye.y - object.last.y) > 30;

			if(!moved && object.frame % 30 !== 0 && object.pending == null)
				return;

			object.last = { x: eye.x, y: eye.y, z: eye.z };

			object.node.computeWorldMatrix(true);

			let origin = object.node.absolutePosition;
			let lods = instance.data.lods;
			let pending = [];
			let live = 0;

			object.buckets.forEach(bucket => {

				let dx = Math.max(0, Math.abs(eye.x - origin.x - bucket.cx) - bucket.half);
				let dz = Math.max(0, Math.abs(eye.z - origin.z - bucket.cz) - bucket.half);
				let dy = Math.max(0, Math.abs(eye.y - origin.y - bucket.cy) - 20);
				let distance = Math.sqrt(dx * dx + dz * dz + dy * dy);

				let wanted = -1;

				for(let index = 0; index < lods.length; index++) {

					/* A little hysteresis, so a chunk on a boundary does not flicker between levels. */
					let range = lods[index].range * (bucket.lod === index ? 1.08 : 1);

					if(distance < range) {

						wanted = index;
						break;
					}
				}

				if(wanted !== bucket.lod)
					pending.push({ bucket, wanted, distance });

				if(bucket.lod >= 0)
					live += bucket.count;
			});

			pending.sort((a, b) => a.distance - b.distance);

			let started = now();
			let built = 0;
			let budget = object.frame < 60 ? 24 : 9;

			for(const entry of pending) {

				let { bucket, wanted } = entry;

				if(wanted >= 0 && built > 0 && now() - started > budget)
					break;

				bucket.meshes.forEach(mesh => mesh.dispose());
				bucket.meshes = [];
				bucket.lod = wanted;

				if(wanted < 0)
					continue;

				let model = object.models[wanted];
				let shadow = instance.data.shadow?.cast === true;

				model.parts.forEach(part => {

					let mesh = part.mesh.clone(
						instance.path.join(".") + "." + bucket.cx + "." + bucket.cz,
						null
					);

					/*

						A clone keeps its source's parent, and the model's root is
						disabled. The instance matrices already carry the whole path
						from the model's root to this mesh, so the clone itself sits at
						the origin.

					*/
					mesh.parent = null;

					/*

						Clones of one model share its vertex data, and chunks of trees
						that share it with a sibling stop drawing: whole groves vanish
						the moment a neighbouring chunk is rebuilt, which, flying toward
						a forest, looks like flickering. Each chunk's meshes therefore
						own a copy of the geometry.

					*/
					if(typeof mesh.makeGeometryUnique === "function")
						mesh.makeGeometryUnique();

					mesh.position.set(0, 0, 0);
					mesh.rotationQuaternion = BABYLON.Quaternion.Identity();
					mesh.scaling.set(1, 1, 1);
					mesh.setEnabled(true);
					mesh.isPickable = false;
					mesh.alwaysSelectAsActiveMesh = false;

					let matrices = new Float32Array(bucket.count * 16);

					for(let index = 0; index < bucket.count; index++) {

						let record = index * RECORD;
						let size = bucket.array[record + 4];

						let placed = BABYLON.Matrix.Compose(
							new BABYLON.Vector3(size, size, size),
							BABYLON.Quaternion.RotationAxis(
								BABYLON.Axis.Y, bucket.array[record + 3]
							),
							new BABYLON.Vector3(
								bucket.array[record] + origin.x,
								bucket.array[record + 1] + origin.y,
								bucket.array[record + 2] + origin.z
							)
						);

						part.relative.multiply(placed).copyToArray(matrices, index * 16);
					}

					mesh.thinInstanceSetBuffer("matrix", matrices, 16, true);
					mesh.thinInstanceRefreshBoundingInfo(true);

					if(shadow)
						H.shadowCaster?.(context, mesh);

					bucket.meshes.push(mesh);
				});

				built++;
			}

			object.pending = pending.length > built ? true : null;

			ace.setState(context, instance.record, {
				live,
				queued: Math.max(0, pending.length - built)
			});
		},

		onDestroy: (context, instance) => {

			let object = instance.object;

			object.disposed = true;

			object.buckets.forEach(bucket =>
				bucket.meshes.forEach(mesh => mesh.dispose()));

			object.models.forEach(model =>
				model.content.meshes.forEach(mesh => mesh.dispose()));
		}
	};

	/*

		Scatter instances can be solid. `data.collide` gives a trunk as a cylinder
		and, optionally, a crown above it, in metres at unit scale:

			{ radius, height, base, crown: { radius, base, height } }

		Overlap queries ask here after they have asked the meshes. The answer has
		the same shape as any other overlap: the target entity, the nearest point,
		the normal from the thing toward the query centre, and how far the centre
		is from the surface (negative when inside).

	*/
	/*

		How high the terrain is at a point, and which way it faces there, read
		from the height grid itself. A ray that points straight down at the
		ground is answered from this: testing it against the triangles of the
		chunk below costs a great deal more, and a world full of things that keep
		to the ground asks dozens of times a frame.

	*/
	ace.adapter.groundAt = (context, x, z, allowed) => {

		let list = context.meta.terrains;

		if(list == null)
			return null;

		for(let index = 0; index < list.length; index++) {

			let entry = list[index], grid = entry.object.grid;

			if(grid == null || !entry.object.node.isEnabled(true) || (allowed != null && !allowed.has(entry.key)))
				continue;

			let origin = entry.object.node.getAbsolutePosition();
			let u = (x - origin.x) / grid.size[0] + 0.5;
			let v = 0.5 - (z - origin.z) / grid.size[1];

			if(u < 0 || v < 0 || u > 1 || v > 1)
				continue;

			let { heights, width, height, elevation } = grid;
			let rise = elevation[1] - elevation[0];

			const sample = (fi, fj) => {

				fi = Math.min(Math.max(fi, 0), width - 1.001);
				fj = Math.min(Math.max(fj, 0), height - 1.001);

				let i = Math.floor(fi), j = Math.floor(fj), tx = fi - i, tz = fj - j;
				let a = heights[j * width + i], b = heights[j * width + i + 1];
				let c = heights[(j + 1) * width + i], d = heights[(j + 1) * width + i + 1];

				return (a * (1 - tx) + b * tx) * (1 - tz) + (c * (1 - tx) + d * tx) * tz;
			};

			let fi = u * (width - 1), fj = v * (height - 1);
			let y = origin.y + elevation[0] + rise * sample(fi, fj);
			let cellX = grid.size[0] / (width - 1), cellZ = grid.size[1] / (height - 1);
			let dx = (sample(fi + 1, fj) - sample(fi - 1, fj)) * rise / (2 * cellX);
			let dz = (sample(fi, fj - 1) - sample(fi, fj + 1)) * rise / (2 * cellZ);
			let length = Math.sqrt(dx * dx + 1 + dz * dz);

			return {
				y,
				normal: [-dx / length, 1 / length, -dz / length],
				target: JSON.parse(entry.key)
			};
		}

		return null;
	};

	/*

		The solid scatter instances within `reach` of a point, as the pieces a
		physics world would be made of: each is the trunk (and crown) of the
		`collide` spec, in world space, with a stable id.

	*/
	ace.adapter.solidsNear = (context, centre, reach) => {

		let found = [];

		Object.keys(context.instances).forEach(id => {

			let instance = context.instances[id];

			if(instance.type !== "scatter")
				return;

			let spec = instance.data.collide;
			let object = instance.object;

			if(!isObject(spec) || !object.ready || object.asleep || !object.node.isEnabled(true))
				return;

			object.node.computeWorldMatrix(false);

			let origin = object.node.absolutePosition;
			let lx = centre.x - origin.x, lz = centre.z - origin.z;
			let parts = [{ radius: spec.radius, base: spec.base != null ? spec.base : 0, height: spec.height }];

			if(isObject(spec.crown))
				parts.push(spec.crown);

			object.buckets.forEach((bucket, key) => {

				if(Math.abs(lx - bucket.cx) > bucket.half + reach || Math.abs(lz - bucket.cz) > bucket.half + reach)
					return;

				for(let index = 0; index < bucket.count; index++) {

					let at = index * RECORD;
					let x = bucket.array[at], y = bucket.array[at + 1], z = bucket.array[at + 2], size = bucket.array[at + 4];
					let dx = lx - x, dz = lz - z;

					if(Math.abs(dx) > reach || Math.abs(dz) > reach)
						continue;

					found.push({
						id: id + "|" + key + "|" + index,
						distance: Math.hypot(dx, dz),
						x: x + origin.x,
						z: z + origin.z,
						parts: parts.map(part => ({
							radius: Math.max(0.05, part.radius * size),
							low: origin.y + y + (part.base != null ? part.base : 0) * size,
							high: origin.y + y + (part.base != null ? part.base : 0) * size + Math.max(0.1, part.height * size)
						}))
					});
				}
			});
		});

		return found;
	};

	ace.adapter.collide = (context, centre, radius, allowed, hits) => {

		Object.keys(context.instances).forEach(id => {

			let instance = context.instances[id];

			if(instance.type !== "scatter")
				return;

			let spec = instance.data.collide;
			let object = instance.object;

			if(!isObject(spec) || !object.ready || object.asleep || !object.node.isEnabled(true))
				return;

			if(allowed != null && !allowed.has(instance.entityKey))
				return;

			object.node.computeWorldMatrix(false);

			let origin = object.node.absolutePosition;
			let lx = centre.x - origin.x, ly = centre.y - origin.y, lz = centre.z - origin.z;
			let reach = radius + (spec.reach != null ? spec.reach : 10);
			let parts = [{
				radius: spec.radius, base: spec.base != null ? spec.base : 0, height: spec.height
			}];

			if(isObject(spec.crown))
				parts.push(spec.crown);

			object.buckets.forEach(bucket => {

				if(Math.abs(lx - bucket.cx) > bucket.half + reach ||
					Math.abs(lz - bucket.cz) > bucket.half + reach) {

					return;
				}

				let target = null;

				for(let index = 0; index < bucket.count; index++) {

					let at = index * RECORD;
					let x = bucket.array[at], y = bucket.array[at + 1];
					let z = bucket.array[at + 2], size = bucket.array[at + 4];
					let dx = lx - x, dz = lz - z;

					if(Math.abs(dx) > reach || Math.abs(dz) > reach)
						continue;

					let flat = Math.sqrt(dx * dx + dz * dz);
					let best = null;

					parts.forEach(part => {

						let low = y + (part.base != null ? part.base : 0) * size;
						let high = low + part.height * size;

						if(ly + radius < low || ly - radius > high)
							return;

						let distance = flat - part.radius * size;

						if(distance < radius && (best == null || distance < best))
							best = distance;
					});

					if(best == null)
						continue;

					if(target == null)
						target = JSON.parse(instance.entityKey);

					let nx = flat > 1e-4 ? dx / flat : 1;
					let nz = flat > 1e-4 ? dz / flat : 0;

					hits.push({
						target,
						point: [lx - nx * best + origin.x, ly + origin.y, lz - nz * best + origin.z],
						normal: [nx, 0, nz],
						distance: best
					});
				}
			});
		});
	};

	// ================================================================ particles

	/*

		An emitter at its entity. Emission is a standing state rather than a
		command: `emitting` turns it on and off and `rate` is particles per
		second, so a document produces a burst by raising the flag for a
		moment, which keeps the component inside the data and state split.

	*/
	const particles = {

		type: "particles",

		onCreate: (context, instance) => {

			let scene = context.meta.scene;
			let data = instance.data;
			let node = H.nodeFor(context, instance.entity);

			let system = new BABYLON.ParticleSystem(
				instance.path.join("."),
				data.capacity != null ? data.capacity : 300,
				scene
			);

			let location = sourcesOf(instance.source)[0];

			if(location != null)
				system.particleTexture = new BABYLON.Texture(location, scene);

			let object = { system, node, position: new BABYLON.Vector3() };

			system.emitter = object.position;

			particles.apply(context, instance, object);

			system.start();

			ace.setState(context, instance.record, { loaded: true });

			return object;
		},

		apply: (context, instance, object) => {

			let data = instance.data;
			let system = object.system;

			const range = (value, fallback) =>
				Array.isArray(value) ? value : fallback;

			let size = range(data.size, [0.5, 1.5]);
			let life = range(data.life, [0.5, 1.2]);
			let power = range(data.speed, [1, 3]);

			system.minSize = size[0];
			system.maxSize = size[1];
			system.minLifeTime = life[0];
			system.maxLifeTime = life[1];
			system.minEmitPower = power[0];
			system.maxEmitPower = power[1];

			system.emitRate = data.emitting === false ? 0 :
				(data.rate != null ? data.rate : 60);

			let radius = data.radius != null ? data.radius : 0.2;
			let spread = data.spread != null ? data.spread : 1;

			system.minEmitBox = new BABYLON.Vector3(-radius, -radius, -radius);
			system.maxEmitBox = new BABYLON.Vector3(radius, radius, radius);

			system.direction1 = new BABYLON.Vector3(-spread, spread * 0.6, -spread);
			system.direction2 = new BABYLON.Vector3(spread, spread * 1.4, spread);

			if(Array.isArray(data.direction)) {

				let d = H.vector(data.direction);

				system.direction1 = d.add(new BABYLON.Vector3(-spread, -spread, -spread));
				system.direction2 = d.add(new BABYLON.Vector3(spread, spread, spread));
			}

			system.gravity = H.vector(data.gravity, [0, 0, 0]);

			system.color1 = H.color(data.color, [1, 0.8, 0.4, 1]);
			system.color2 = H.color(data.color2, [1, 0.4, 0.1, 1]);
			system.colorDead = H.color(data.fade, [0.2, 0.1, 0.1, 0]);

			system.blendMode = data.blend === "standard" ?
				BABYLON.ParticleSystem.BLENDMODE_STANDARD :
				BABYLON.ParticleSystem.BLENDMODE_ADD;

			system.updateSpeed = data.timeScale != null ? data.timeScale : 0.016;
			system.isLocal = data.local === true;
		},

		onChange: (context, instance) => {

			particles.apply(context, instance, instance.object);
		},

		onUpdate: (context, instance) => {

			let object = instance.object;

			/*

				A particle system is not a child of its entity's node, so
				disabling the entity would leave what it had already made
				hanging in the air, frozen. It is stopped and cleared instead,
				and started again when the entity returns.

			*/
			let shown = object.node.isEnabled(true);

			if(!shown && !object.hidden) {

				object.system.stop();
				object.system.reset();
				object.hidden = true;

			} else if(shown && object.hidden) {

				object.system.start();
				object.hidden = false;
			}

			object.node.computeWorldMatrix(true);
			object.position.copyFrom(object.node.absolutePosition);

			ace.setState(context, instance.record, {
				alive: object.system.getActiveCount()
			});
		},

		onDestroy: (context, instance) => {

			instance.object.system.dispose();
		}
	};

	// ================================================================ speech

	/*

		A voice. `revision` is the trigger: when it changes the component says
		`text`, cutting off whatever it was saying, and an empty text is silence.
		That keeps a spoken line a matter of data and state like everything else,
		without a command field. The adapter uses the host's speech synthesis, so
		which voices exist, and how good they are, depends on the machine.

		`voice` is a part of a voice's name ("Zira"), or the number of the nth
		voice in the language; `pitch` and `rate` shape it.

	*/
	const speech = {

		type: "speech",

		onCreate: (context, instance) => {

			let synth = root.speechSynthesis;

			ace.setState(context, instance.record, {
				supported: synth != null,
				speaking: false,
				voices: synth != null ? synth.getVoices().length : 0
			});

			return { synth };
		},

		onChange: (context, instance, previous) => {

			let synth = instance.object.synth;
			let data = instance.data;

			if(synth == null || data.revision === previous.data.revision)
				return;

			synth.cancel();

			if(typeof data.text !== "string" || data.text === "" || data.mute === true)
				return;

			let utterance = new root.SpeechSynthesisUtterance(data.text);
			let language = data.lang != null ? data.lang : "en";

			utterance.pitch = data.pitch != null ? data.pitch : 1;
			utterance.rate = data.rate != null ? data.rate : 1;
			utterance.volume = data.volume != null ? data.volume : 1;
			utterance.lang = language;

			let voices = synth.getVoices().filter(
				voice => voice.lang.toLowerCase().startsWith(language.toLowerCase())
			);

			let chosen = null;

			if(typeof data.voice === "string") {

				chosen = voices.find(voice =>
					voice.name.toLowerCase().includes(data.voice.toLowerCase())
				);

			} else if(typeof data.voice === "number" && voices.length > 0) {

				chosen = voices[data.voice % voices.length];
			}

			if(chosen != null)
				utterance.voice = chosen;

			synth.speak(utterance);
		},

		onUpdate: (context, instance) => {

			let synth = instance.object.synth;

			ace.setState(context, instance.record, {
				speaking: synth != null && synth.speaking === true
			});
		},

		onDestroy: (context, instance) => {

			if(instance.object.synth != null)
				instance.object.synth.cancel();
		}
	};

	// ================================================================ storage

	/*

		Something that outlives the page: a value kept by the host under `key`.
		Writing is also a matter of revision. When `revision` changes, `value` is
		stored (an empty one removes the key); the stored value is always
		reflected in `state.value`, so a document reads its saved games from
		state and need keep a written value in its data for one frame only.

	*/
	const storage = {

		type: "storage",

		onCreate: (context, instance) => {

			let available = true;
			let value = "";

			try {

				let stored = root.localStorage.getItem(instance.data.key);

				value = stored != null ? stored : "";

			} catch(error) {

				available = false;
			}

			ace.setState(context, instance.record, {
				available, value, revision: instance.data.revision != null ?
					instance.data.revision : 0
			});

			return { available };
		},

		onChange: (context, instance, previous) => {

			let data = instance.data;

			if(!instance.object.available || data.revision === previous.data.revision)
				return;

			try {

				if(typeof data.value === "string" && data.value !== "")
					root.localStorage.setItem(data.key, data.value);
				else
					root.localStorage.removeItem(data.key);

			} catch(error) {

				instance.object.available = false;
			}

			ace.setState(context, instance.record, {
				available: instance.object.available,
				value: typeof data.value === "string" ? data.value : "",
				revision: data.revision
			});
		}
	};

	// ================================================================ the sun, the sky and the haze, as the document set them

	const environment = scene => {

		let sun = null, sky = null;

		scene.lights.forEach(light => {

			if(light instanceof BABYLON.DirectionalLight && sun == null)
				sun = light;

			if(light instanceof BABYLON.HemisphericLight && sky == null)
				sky = light;
		});

		let direction = sun != null ? (
			sun.getAbsoluteDirection != null ? sun.getAbsoluteDirection() : sun.direction
		).scale(-1).normalize() : new BABYLON.Vector3(0.3, 0.8, 0.4).normalize();

		return {
			sunDir: direction,
			sunColor: sun != null ? sun.diffuse.scale(sun.intensity) : new BABYLON.Color3(0, 0, 0),
			skyColor: sky != null ? sky.diffuse.scale(sky.intensity) : new BABYLON.Color3(0.3, 0.3, 0.3),
			fogColor: scene.fogColor,
			fogDensity: scene.fogMode === BABYLON.Scene.FOGMODE_EXP2 ? scene.fogDensity : 0
		};
	};

	// ================================================================ water

	/*

		The sea. One surface, seen from both sides.

		Above it, the colour comes from how deep the water is, which the shader
		reads from the same height image the terrain is made from: pale and clear
		over the shoals, deep where the floor falls away, with foam where it
		meets the land and rolling in over the shallows. Two or three layers of
		ripples drift different ways at different scales (the fine ones fade out
		with distance so that the far water does not shimmer), and the sky is
		reflected in them by Fresnel's rule, with a glitter of sun.

		Below it, looking up, there is a bright window of sky about the width
		Snell's law allows, and beyond it only the colour of the water.

		The surface is a coarse grid rather than one quad: depth is interpolated
		across each triangle, and over a very large one the error at the
		shoreline is larger than anything the shader can hide.

	*/
	const WATER_VERTEX = `
		precision highp float;
		attribute vec3 position;
		uniform mat4 world;
		uniform mat4 viewProjection;
		varying vec3 vWorld;
		void main(void) {
			vec4 w = world * vec4(position, 1.0);
			vWorld = w.xyz;
			gl_Position = viewProjection * w;
		}
	`;

	const WATER_FRAGMENT = `
		precision highp float;
		precision highp sampler2D;
		varying vec3 vWorld;
		uniform vec3 camPos;
		uniform vec3 sunDir;
		uniform vec3 sunColor;
		uniform vec3 fogColor;
		uniform float fogDensity;
		uniform float time;
		uniform float level;
		uniform vec3 shallowColor;
		uniform vec3 deepColor;
		uniform vec3 underColor;
		uniform vec4 rect;
		uniform vec4 hinfo;
		uniform vec4 rect2;
		uniform vec4 hinfo2;
		uniform vec2 fadeA, fadeB;
		uniform float under;
		uniform sampler2D heightMap, heightMap2, normA, normB;
		uniform samplerCube sky;

		float decode(vec2 texel) {
			return texture2D(heightMap, texel / hinfo.x).r * hinfo.z + hinfo.y;
		}

		float decode2(vec2 texel) {
			return texture2D(heightMap2, texel / hinfo2.x).r * hinfo2.z + hinfo2.y;
		}

		// the ground's height under a point, interpolated by hand (the 16 bits are in two channels); a second map covers a second island
		float elevAt(vec2 xz) {
			vec2 uv = vec2(0.5 + (xz.x - rect.x) / rect.z, 0.5 + (xz.y - rect.y) / rect.w);
			if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) {
				vec2 uw = vec2(0.5 + (xz.x - rect2.x) / rect2.z, 0.5 + (xz.y - rect2.y) / rect2.w);
				if (rect2.z <= 0.0 || uw.x < 0.0 || uw.y < 0.0 || uw.x > 1.0 || uw.y > 1.0) return hinfo.w;
				vec2 q = uw * hinfo2.x - 0.5;
				vec2 j = floor(q);
				vec2 g = fract(q);
				float a2 = decode2(j + vec2(0.5, 0.5));
				float b2 = decode2(j + vec2(1.5, 0.5));
				float c2 = decode2(j + vec2(0.5, 1.5));
				float d2 = decode2(j + vec2(1.5, 1.5));
				return mix(mix(a2, b2, g.x), mix(c2, d2, g.x), g.y);
			}
			vec2 p = uv * hinfo.x - 0.5;
			vec2 i = floor(p);
			vec2 f = fract(p);
			float a = decode(i + vec2(0.5, 0.5));
			float b = decode(i + vec2(1.5, 0.5));
			float c = decode(i + vec2(0.5, 1.5));
			float d = decode(i + vec2(1.5, 1.5));
			return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
		}

		// how much of an island is to be seen from here (the ground itself fades out by the same rule, far off): 1 whole, 0 gone
		float seenAt(vec2 xz, float dist) {
			vec2 uv = vec2(0.5 + (xz.x - rect.x) / rect.z, 0.5 + (xz.y - rect.y) / rect.w);
			if (uv.x >= 0.0 && uv.y >= 0.0 && uv.x <= 1.0 && uv.y <= 1.0)
				return fadeA.y > fadeA.x ? 1.0 - smoothstep(fadeA.x, fadeA.y, dist) : 1.0;
			vec2 uw = vec2(0.5 + (xz.x - rect2.x) / rect2.z, 0.5 + (xz.y - rect2.y) / rect2.w);
			if (rect2.z > 0.0 && uw.x >= 0.0 && uw.y >= 0.0 && uw.x <= 1.0 && uw.y <= 1.0)
				return fadeB.y > fadeB.x ? 1.0 - smoothstep(fadeB.x, fadeB.y, dist) : 1.0;
			return 1.0;
		}

		void main(void) {
			vec3 toEye = camPos - vWorld;
			float dist = length(toEye);
			vec3 V = toEye / dist;
			vec2 xz = vWorld.xz;

			// ripples: large swell, a middle layer going the other way, and fine ones that fade with distance
			vec2 s1 = texture2D(normA, xz * 0.011 + vec2(time * 0.010, time * 0.006)).xy * 2.0 - 1.0;
			vec2 s2 = texture2D(normB, xz * 0.037 + vec2(-time * 0.017, time * 0.012)).xy * 2.0 - 1.0;
			vec2 s3 = texture2D(normA, xz * 0.121 + vec2(time * 0.031, -time * 0.026)).xy * 2.0 - 1.0;
			float fine = 1.0 / (1.0 + dist * 0.006);
			float calm = 1.0 / (1.0 + dist * 0.0006);
			vec2 slope = (s1 * 0.5 + s2 * 0.34) * calm + s3 * 0.2 * fine;
			vec3 N = normalize(vec3(slope.x * 0.42, 1.0, slope.y * 0.42));

			vec3 col;
			float alpha = 1.0;

			if (camPos.y >= level) {
				// ---- from above
				float elev = elevAt(xz);
				float depth = level - elev;
				float seen = seenAt(xz, dist);

				if (under > 0.5) {

					// the sheet laid under the islands: open sea, where there is land that is fading out, so that what shows through it is sea
					if (depth > 0.12 || seen > 0.995) discard;
					depth = 70.0;

				} else {

					if (depth < -0.3) discard;

					// far off, the shoals and the surf of an island go with it
					depth = mix(70.0, depth, seen);
				}

				float shoal = 1.0 - exp(-max(depth, 0.0) * 0.07);
				vec3 body = mix(shallowColor, deepColor, shoal);

				float F = 0.02 + 0.98 * pow(1.0 - max(dot(N, V), 0.0), 5.0);
				F = mix(F, 0.02 + 0.98 * pow(1.0 - max(V.y, 0.0), 5.0), clamp(dist * 0.0004, 0.0, 1.0));
				vec3 R = reflect(-V, N);
				R.y = abs(R.y);
				vec3 refl = textureCube(sky, R).rgb;

				float sd = max(dot(R, sunDir), 0.0);
				vec3 glitter = vec3(1.0, 0.93, 0.78) * (pow(sd, 500.0) * 7.0 + pow(sd, 36.0) * 0.28) * length(sunColor) * 0.33;
				col = mix(body, refl, F) + glitter;

				// foam: right at the shore, and breakers rolling in across the shallows
				float shore = 1.0 - smoothstep(0.0, 0.9, depth);
				float lap = 0.5 + 0.5 * sin(depth * 1.9 - time * 1.1 + s1.x * 4.0 + s2.y * 2.0);
				float lacy = texture2D(normB, xz * 0.19 + vec2(time * 0.004, -time * 0.003)).x;
				float band = (1.0 - smoothstep(0.6, 3.4, depth)) * smoothstep(0.55, 0.9, lap * 0.75 + lacy * 0.5);
				float foam = clamp(shore * (0.55 + lacy * 0.6) + band * 0.65, 0.0, 1.0);
				col = mix(col, vec3(0.94, 0.97, 0.99), foam * 0.92);

				alpha = 1.0 - exp(-max(depth, 0.0) * 0.26);
				alpha = mix(alpha, 1.0, F);
				alpha = max(alpha, foam * 0.95);
				alpha *= smoothstep(-0.3, 0.12, depth);
			} else {
				// ---- from below: a window of sky, then only water
				if (under > 0.5) discard;
				vec3 up = -V;
				up.xz += slope * 0.35;
				up = normalize(up);
				float cosi = abs(up.y);
				float sini = sqrt(max(1.0 - cosi * cosi, 0.0));
				float sint = sini * 1.333;
				vec2 horiz = normalize(up.xz + vec2(1e-5));
				vec3 outDir = normalize(vec3(horiz.x * min(sint, 0.999), sqrt(max(1.0 - min(sint * sint, 0.998), 0.0)), horiz.y * min(sint, 0.999)));
				vec3 seen = textureCube(sky, outDir).rgb * vec3(0.55, 0.85, 1.0);
				float window = 1.0 - smoothstep(0.72, 0.78, sint);
				float ring = smoothstep(0.55, 0.75, sint) * (1.0 - smoothstep(0.75, 0.9, sint));
				col = mix(underColor * 0.9, seen, window) + vec3(0.1, 0.22, 0.3) * ring * 0.5;
				float sd = max(dot(outDir, sunDir), 0.0);
				col += vec3(1.0, 0.95, 0.8) * pow(sd, 260.0) * 3.0 * window;
			}

			float fog = 1.0 - exp(-pow(dist * fogDensity, 2.0));
			col = mix(col, fogColor, clamp(fog, 0.0, 1.0));
			gl_FragColor = vec4(col, alpha);
		}
	`;

	const water = {

		type: "water",

		onCreate: (context, instance) => {

			let scene = context.meta.scene;
			let data = instance.data;
			let node = H.nodeFor(context, instance.entity);
			let name = instance.path.join(".");

			if(BABYLON.Effect.ShadersStore.aceWaterVertexShader == null) {

				BABYLON.Effect.ShadersStore.aceWaterVertexShader = WATER_VERTEX;
				BABYLON.Effect.ShadersStore.aceWaterFragmentShader = WATER_FRAGMENT;
			}

			let size = Array.isArray(data.size) ? data.size : [40000, 40000];

			let mesh = BABYLON.MeshBuilder.CreateGround(name, {
				width: size[0], height: size[1],
				subdivisions: data.segments != null ? data.segments : 300
			}, scene);

			mesh.parent = node;
			mesh.isPickable = false;
			mesh.alphaIndex = 5;
			H.own(mesh, instance.entityKey);

			let material = new BABYLON.ShaderMaterial(
				name + ".material", scene,
				{ vertex: "aceWater", fragment: "aceWater" },
				{
					attributes: ["position"],
					uniforms: [
						"world", "viewProjection", "camPos", "sunDir", "sunColor", "fogColor",
						"fogDensity", "time", "level", "shallowColor", "deepColor", "underColor",
						"rect", "hinfo", "rect2", "hinfo2", "fadeA", "fadeB", "under"
					],
					samplers: ["heightMap", "heightMap2", "normA", "normB", "sky"]
				}
			);

			material.backFaceCulling = false;
			material.disableDepthWrite = true;
			material.needAlphaBlending = () => true;
			mesh.material = material;
			material.setFloat("under", 0);

			let layers = isObject(data.layers) ? data.layers : { };
			let terrain = isObject(data.terrain) ? data.terrain : { };
			let owned = [];

			const bind = (sampler, url, repeat, nearest) => {

				let texture = new BABYLON.Texture(
					url, scene, nearest === true, true,
					nearest === true ? BABYLON.Texture.NEAREST_SAMPLINGMODE :
						BABYLON.Texture.TRILINEAR_SAMPLINGMODE
				);

				texture.wrapU = texture.wrapV = repeat ?
					BABYLON.Texture.WRAP_ADDRESSMODE : BABYLON.Texture.CLAMP_ADDRESSMODE;

				if(repeat)
					texture.anisotropicFilteringLevel = 4;

				owned.push(texture);
				material.setTexture(sampler, texture);
			};

			bind("normA", layers.a != null ? layers.a : "Assets/Textures/water_nor.png", true);
			bind("normB", layers.b != null ? layers.b : "Assets/Textures/water_nor2.png", true);
			/*

				The heights are given to the shader as numbers, not as the two
				bytes of a picture: a float texture sampled without blending is
				the same on every machine, which a picture read through the
				browser's image handling is not.

			*/
			let sized = [];
			const height = (sampler, url) => {

				let placeholder = BABYLON.RawTexture.CreateRTexture(
					new Float32Array([0]), 1, 1, scene, false, false,
					BABYLON.Texture.NEAREST_SAMPLINGMODE, BABYLON.Constants.TEXTURETYPE_FLOAT
				);

				owned.push(placeholder);
				material.setTexture(sampler, placeholder);

				loadHeights([url], "rg16").then(decoded => {

					if(object.disposed)
						return;

					/* rows are turned over: row 0 of the image is the far edge, which is the top of the texture */
					let turned = new Float32Array(decoded.heights.length);

					for(let row = 0; row < decoded.height; row++)
						turned.set(decoded.heights.subarray(row * decoded.width, (row + 1) * decoded.width), (decoded.height - 1 - row) * decoded.width);

					let texture = BABYLON.RawTexture.CreateRTexture(
						turned, decoded.width, decoded.height, scene, false, false,
						BABYLON.Texture.NEAREST_SAMPLINGMODE, BABYLON.Constants.TEXTURETYPE_FLOAT
					);

					texture.wrapU = texture.wrapV = BABYLON.Texture.CLAMP_ADDRESSMODE;
					owned.push(texture);
					[material].concat((object.sheets || []).map(entry => entry.material)).forEach(each => each.setTexture(sampler, texture));
					sized.push(decoded.exact);
				}).catch(error => context.errors.push({ type: "water", hook: sampler, message: error.message }));
			};

			let object = { disposed: false };

			height("heightMap", terrain.height != null ? terrain.height : "Assets/Terrain/height.png");

			let second = isObject(data.terrain2) ? data.terrain2 : null;

			height("heightMap2", second != null ? second.height : (terrain.height != null ? terrain.height : "Assets/Terrain/height.png"));

			let elevation = Array.isArray(terrain.elevation) ? terrain.elevation : [-80, 1500];
			let extent = terrain.size != null ? terrain.size : 8192;

			let middle = Array.isArray(terrain.center) ? terrain.center : [0, 0];

			material.setVector4("rect", new BABYLON.Vector4(middle[0], middle[1], extent, extent));
			material.setVector4("hinfo", new BABYLON.Vector4(
				terrain.resolution != null ? terrain.resolution : 2049,
				elevation[0], elevation[1] - elevation[0],
				terrain.floor != null ? terrain.floor : -72
			));

			if(second != null) {

				let c2 = Array.isArray(second.center) ? second.center : [0, 0];
				let e2 = Array.isArray(second.elevation) ? second.elevation : [-80, 1500];

				material.setVector4("rect2", new BABYLON.Vector4(c2[0], c2[1], second.size, second.size));
				material.setVector4("hinfo2", new BABYLON.Vector4(second.resolution, e2[0], e2[1] - e2[0], 0));

			} else {

				material.setVector4("rect2", new BABYLON.Vector4(0, 0, 0, 0));
				material.setVector4("hinfo2", new BABYLON.Vector4(2, 0, 1, 0));
			}

			material.setColor3("shallowColor", H.color3(data.shallow, [0.1, 0.5, 0.52]));
			material.setColor3("deepColor", H.color3(data.deep, [0.01, 0.12, 0.24]));
			material.setColor3("underColor", H.color3(data.under, [0.02, 0.2, 0.32]));

			const span = value => Array.isArray(value) && value.length > 1 ? new BABYLON.Vector2(value[0], value[1]) : new BABYLON.Vector2(0, 0);

			material.setVector2("fadeA", span(terrain.fade));
			material.setVector2("fadeB", second != null ? span(second.fade) : span(null));

			object.mesh = mesh; object.material = material; object.owned = owned; object.node = node;
			object.sheets = [];

			/*

				Where an island fades with distance, the sea is laid under it as well: a flat sheet of open sea over the whole of the island's map, drawn
				before the island is, so that what the fading ground lets through is sea and not the sky behind it.

			*/
			const sheet = (map, index) => {

				if(map == null || !Array.isArray(map.fade) || map.fade.length < 2)
					return;

				node.computeWorldMatrix(true);

				let at = Array.isArray(map.center) ? map.center : [0, 0];
				let flat = BABYLON.MeshBuilder.CreateGround(name + ".sheet" + index, { width: map.size, height: map.size, subdivisions: 1 }, scene);

				flat.parent = node;
				flat.position.set(at[0] - node.absolutePosition.x, 0.02, at[1] - node.absolutePosition.z);
				flat.isPickable = false;
				flat.alphaIndex = 0;
				H.own(flat, instance.entityKey);

				/* a copy of the sea's own material that is told it is the sheet; its textures and colours are the same ones */
				let copy = material.clone(name + ".sheet" + index + ".material");

				copy.backFaceCulling = false;
				copy.disableDepthWrite = true;
				copy.needAlphaBlending = () => true;
				copy.setFloat("under", 1);
				flat.material = copy;
				object.sheets.push({ mesh: flat, material: copy });
			};

			sheet(terrain.fade != null ? Object.assign({ center: middle, size: extent }, { fade: terrain.fade }) : null, 0);
			sheet(second, 1);

			return object;
		},

		onUpdate: (context, instance) => {

			let object = instance.object;
			let scene = context.meta.scene;
			let camera = scene.activeCamera;

			if(camera == null)
				return;

			let env = environment(scene);

			object.node.computeWorldMatrix(true);

			[object.material].concat(object.sheets.map(entry => entry.material)).forEach(material => {

				material.setVector3("camPos", camera.globalPosition);
				material.setVector3("sunDir", env.sunDir);
				material.setColor3("sunColor", env.sunColor);
				material.setColor3("fogColor", env.fogColor);
				material.setFloat("fogDensity", env.fogDensity);
				material.setFloat("time", (root.performance.now() % 3600000) / 1000);
				material.setFloat("level", object.node.absolutePosition.y);

				let sky = scene.environmentTexture;

				if(sky != null)
					material.setTexture("sky", sky);
			});
		},

		onChange: (context, instance) => {

			water.onDestroy(context, instance);
			instance.object = water.onCreate(context, instance);
		},

		onDestroy: (context, instance) => {

			instance.object.disposed = true;
			instance.object.sheets.forEach(entry => { entry.mesh.dispose(); entry.material.dispose(); });
			instance.object.owned.forEach(texture => texture.dispose());
			instance.object.material.dispose();
			instance.object.mesh.dispose();
		}
	};

	// ================================================================ clouds

	/*

		Clouds that are somewhere, not painted on the sky: heaps of soft puffs
		arranged in three dimensions, so that the viewer can fly round one, over
		it, or into it.

		A cloud is a flat-bottomed cluster of puffs, bigger and lower at the base,
		smaller and higher toward the top. Each puff is a billboard (a quad that
		always faces the viewer) shaded as if it were a sphere lit from the sun,
		its edge eaten away by noise so that it is billowy and not round, and
		brighter toward the top of its cloud. Thousands are drawn as thin
		instances of one quad, in a single call, and the instances are put in
		order from far to near now and then, because translucent things only
		blend properly in that order.

		The field is made around the viewer from a hash of where each cell is, so
		it is the same every time, extends as far as the viewer goes, and drifts
		with the wind as a whole. The cells nearest are rich; the far ones are a
		few big puffs each. A puff the viewer is inside fades out as it is
		approached, so passing through is a thickening of the air.

	*/
	const PUFF_VERTEX = `
		precision highp float;
		attribute vec3 position;
		attribute vec4 world0;
		attribute vec4 world1;
		attribute vec4 world2;
		attribute vec4 world3;
		uniform mat4 viewProjection;
		uniform vec3 camPos;
		uniform vec3 camRight;
		uniform vec3 camUp;
		uniform vec3 drift;
		uniform float base;
		uniform float tall;
		varying vec2 vP;
		varying float vSeed;
		varying float vHeight;
		varying float vDist;
		varying float vSize;
		void main(void) {
			float size = world0.x;
			vec3 centre = world3.xyz + drift;
			vec3 corner = centre + (camRight * position.x + camUp * position.y) * size;
			vP = position.xy;
			vSeed = world3.w;
			vHeight = clamp((centre.y - base) / tall, 0.0, 1.0);
			vDist = length(centre - camPos);
			vSize = size;
			gl_Position = viewProjection * vec4(corner, 1.0);
		}
	`;

	const PUFF_FRAGMENT = `
		precision highp float;
		varying vec2 vP;
		varying float vSeed;
		varying float vHeight;
		varying float vDist;
		varying float vSize;
		uniform vec3 camPos;
		uniform vec3 sunView;
		uniform vec3 sunColor;
		uniform vec3 fogColor;
		uniform float fogDensity;
		uniform float time;
		uniform float opacity;
		uniform vec3 litColor;
		uniform vec3 shadeColor;
		uniform sampler2D cloudMap;

		void main(void) {
			float r2 = dot(vP, vP);
			if (r2 >= 1.0) discard;

			vec2 nuv = vP * 0.45 + vec2(vSeed * 7.13, vSeed * 3.71) + vec2(time * 0.0016, 0.0);
			float n = texture2D(cloudMap, nuv).r * 0.5 + texture2D(cloudMap, nuv * 2.9 + 0.31).r * 0.32 + texture2D(cloudMap, nuv * 7.3 + 0.7).r * 0.18;

			float body = 1.0 - r2;                          // thick in the middle, nothing at the rim
			float dens = body * 1.15 - (1.0 - n) * 0.95;     // the noise eats the rim away, so it is not a circle
			if (dens <= 0.0) discard;
			float alpha = smoothstep(0.0, 0.3, dens);

			// shaded as a sphere with a rough skin, lit from the sun's side
			vec3 nrm = normalize(vec3(vP + (n - 0.5) * 0.7, sqrt(max(1.0 - r2, 0.02))));
			float facing = dot(nrm, normalize(sunView)) * 0.5 + 0.5;
			float core = clamp(dens * 1.4, 0.0, 1.0);
			float lit = clamp(facing * 1.3 - core * 0.28 + vHeight * 0.45 - 0.1, 0.0, 1.0);
			vec3 col = mix(shadeColor, litColor, lit);
			col *= 0.6 + 0.4 * clamp(length(sunColor) * 0.33, 0.0, 1.5);

			// near: a puff the viewer is in or near gives way; far: it thins into the haze
			float nearFade = smoothstep(vSize * 0.12, vSize * 0.9, vDist);
			float farFade = 1.0 - smoothstep(6500.0, 9500.0, vDist);
			alpha *= nearFade * farFade * opacity;
			if (alpha < 0.004) discard;

			float fog = 1.0 - exp(-pow(vDist * fogDensity, 2.0));
			col = mix(col, fogColor, clamp(fog, 0.0, 1.0));
			gl_FragColor = vec4(col, alpha);
		}
	`;

	// tileable value noise, in one channel: the skin of a puff
	const cloudNoise = size => {

		let seed = 12345;
		const random = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
		let data = new Uint8Array(size * size * 4);
		let field = new Float32Array(size * size);

		for(let octave = 0, amplitude = 0.5, frequency = 4, total = 0; octave < 5; octave++) {

			let n = frequency, grid = new Float32Array(n * n);

			for(let index = 0; index < grid.length; index++)
				grid[index] = random();

			for(let y = 0; y < size; y++) {

				let fy = y / size * n, y0 = Math.floor(fy), ty = fy - y0;
				ty = ty * ty * (3 - 2 * ty);

				for(let x = 0; x < size; x++) {

					let fx = x / size * n, x0 = Math.floor(fx), tx = fx - x0;
					tx = tx * tx * (3 - 2 * tx);

					let a = grid[(y0 % n) * n + (x0 % n)], b = grid[(y0 % n) * n + ((x0 + 1) % n)];
					let c = grid[((y0 + 1) % n) * n + (x0 % n)], d = grid[((y0 + 1) % n) * n + ((x0 + 1) % n)];

					field[y * size + x] += amplitude *
						((a + (b - a) * tx) * (1 - ty) + (c + (d - c) * tx) * ty);
				}
			}

			total += amplitude;
			amplitude *= 0.5;
			frequency *= 2;

			if(octave === 4) {

				for(let index = 0; index < field.length; index++) {

					let v = Math.min(1, Math.max(0, (field[index] / total - 0.2) / 0.62));

					data[index * 4] = data[index * 4 + 1] = data[index * 4 + 2] = Math.round(v * 255);
					data[index * 4 + 3] = 255;
				}
			}
		}

		return data;
	};

	const hash2 = (x, z, s) => {

		let h = (Math.imul(x, 374761393) + Math.imul(z, 668265263) + Math.imul(s, 1442695041)) | 0;

		h = Math.imul(h ^ (h >>> 13), 1274126177);
		h ^= h >>> 16;

		return (h >>> 0) / 4294967296;
	};

	/* Where cloud is, as a smooth field over the cells: a few cells wide, with a little finer grain. */
	const coverAt = (x, z, s) => {

		const lattice = (scale, salt) => {

			let fx = x / scale, fz = z / scale;
			let ix = Math.floor(fx), iz = Math.floor(fz);
			let tx = fx - ix, tz = fz - iz;

			tx = tx * tx * (3 - 2 * tx);
			tz = tz * tz * (3 - 2 * tz);

			let a = hash2(ix, iz, s + salt), b = hash2(ix + 1, iz, s + salt);
			let c = hash2(ix, iz + 1, s + salt), d = hash2(ix + 1, iz + 1, s + salt);

			return (a + (b - a) * tx) * (1 - tz) + (c + (d - c) * tx) * tz;
		};

		return lattice(4.2, 11) * 0.72 + lattice(1.6, 23) * 0.28;
	};

	/* The puffs of every cloud within range of a point, as [x, y, z, size, seed], near cells fully and far ones coarsely. */
	const cloudField = (data, cx, cz) => {

		let cell = data.cell != null ? data.cell : 1500;
		let range = data.range != null ? data.range : 9500;
		let base = data.altitude != null ? data.altitude : 1400;
		let tall = data.thickness != null ? data.thickness : 520;
		let cover = data.cover != null ? data.cover : 0.5;
		let seed = data.seed != null ? data.seed : 7;
		let puffs = [];

		let reach = Math.ceil(range / cell);
		let i0 = Math.floor(cx / cell), j0 = Math.floor(cz / cell);

		for(let dj = -reach; dj <= reach; dj++) {

			for(let di = -reach; di <= reach; di++) {

				let ci = i0 + di, cj = j0 + dj;

				if(coverAt(ci, cj, seed) < cover)
					continue;

				let rand = (k) => hash2(ci * 31 + k, cj * 17 - k, seed + k * 7);
				let x = (ci + 0.5 + (rand(1) - 0.5) * 0.6) * cell;
				let z = (cj + 0.5 + (rand(2) - 0.5) * 0.6) * cell;
				let distance = Math.hypot(x - cx, z - cz);

				if(distance > range)
					continue;

				let radius = 240 + rand(3) * 340;
				let height = tall * (0.35 + rand(4) * rand(4) * 0.85);
				let floor = base + (rand(5) - 0.5) * 140;
				let far = distance > 6000;
				let count = Math.round((30 + radius / 9) * (far ? 0.3 : 1));
				let grow = far ? 1.9 : 1;

				for(let k = 0; k < count; k++) {

					let r = (k + 1) * 977 + ci * 3 + cj * 5;
					let u = hash2(r, 1, seed), v = hash2(r, 2, seed), w = hash2(r, 3, seed), q = hash2(r, 4, seed);
					let t = Math.pow(u, 1.8);                               // heaped toward the bottom
					let flatBase = k < count * 0.3;
					let level = flatBase ? v * 0.12 : t;
					let spread = radius * Math.sqrt(v) * (1 - 0.62 * level) * (flatBase ? 1.1 : 0.9);
					let angle = w * Math.PI * 2;
					let size = (55 + q * 100) * (1 - 0.4 * level) * (0.7 + radius / 800) * grow * (flatBase ? 1.25 : 1);

					puffs.push(
						x + Math.cos(angle) * spread,
						floor + level * height + (flatBase ? 0 : size * 0.15),
						z + Math.sin(angle) * spread,
						size,
						hash2(r, 5, seed)
					);
				}
			}
		}

		return puffs;
	};

	const clouds = {

		type: "clouds",

		onCreate: (context, instance) => {

			let scene = context.meta.scene;
			let data = instance.data;
			let node = H.nodeFor(context, instance.entity);
			let name = instance.path.join(".");

			if(BABYLON.Effect.ShadersStore.acePuffVertexShader == null) {

				BABYLON.Effect.ShadersStore.acePuffVertexShader = PUFF_VERTEX;
				BABYLON.Effect.ShadersStore.acePuffFragmentShader = PUFF_FRAGMENT;
			}

			let mesh = BABYLON.MeshBuilder.CreatePlane(name, { size: 2, sideOrientation: BABYLON.Mesh.DOUBLESIDE }, scene);

			mesh.parent = node;
			mesh.isPickable = false;
			mesh.alphaIndex = 8;
			mesh.alwaysSelectAsActiveMesh = true;
			H.own(mesh, instance.entityKey);

			let material = new BABYLON.ShaderMaterial(
				name + ".material", scene,
				{ vertex: "acePuff", fragment: "acePuff" },
				{
					attributes: ["position", "world0", "world1", "world2", "world3"],
					uniforms: [
						"viewProjection", "camPos", "camRight", "camUp", "drift", "base", "tall", "sunView", "sunColor",
						"fogColor", "fogDensity", "time", "opacity", "litColor", "shadeColor"
					],
					samplers: ["cloudMap"]
				}
			);

			material.backFaceCulling = false;
			material.disableDepthWrite = true;
			material.needAlphaBlending = () => true;
			mesh.material = material;

			let size = 256;
			let texture = new BABYLON.RawTexture(
				cloudNoise(size), size, size, BABYLON.Engine.TEXTUREFORMAT_RGBA,
				scene, true, false, BABYLON.Texture.TRILINEAR_SAMPLINGMODE
			);

			texture.wrapU = texture.wrapV = BABYLON.Texture.WRAP_ADDRESSMODE;
			material.setTexture("cloudMap", texture);

			material.setFloat("base", data.altitude != null ? data.altitude : 1400);
			material.setFloat("tall", data.thickness != null ? data.thickness : 520);
			material.setFloat("opacity", data.opacity != null ? data.opacity : 1);
			material.setColor3("litColor", H.color3(data.lit, [1, 0.98, 0.94]));
			material.setColor3("shadeColor", H.color3(data.shade, [0.66, 0.71, 0.8]));

			/* A thin instance with no matrices yet draws nothing; the first update fills them. */
			mesh.thinInstanceSetBuffer("matrix", new Float32Array(16), 16, false);

			return {
				mesh, material, texture, node,
				field: null, built: null, sorted: null, order: null, count: 0
			};
		},

		onUpdate: (context, instance) => {

			let object = instance.object;
			let scene = context.meta.scene;
			let camera = scene.activeCamera;

			if(camera == null)
				return;

			let data = instance.data;
			let env = environment(scene);
			let material = object.material;
			let eye = camera.globalPosition;
			let wind = Array.isArray(data.wind) ? data.wind : [6, 2.5];
			let seconds = (root.performance.now() % 36000000) / 1000;

			/* The whole field drifts; the viewer's place in it is what the field is built around. */
			let drift = new BABYLON.Vector3(wind[0] * seconds, 0, wind[1] * seconds);
			let cell = data.cell != null ? data.cell : 1500;
			let fx = eye.x - drift.x, fz = eye.z - drift.z;

			object.mesh.setEnabled(env.fogDensity < 0.004);

			if(object.built == null || Math.hypot(fx - object.built[0], fz - object.built[1]) > cell * 1.2) {

				object.field = cloudField(data, fx, fz);
				object.built = [fx, fz];
				object.sorted = null;
			}

			let puffs = object.field;
			let count = puffs.length / 5;

			/* Far to near, so that they blend over one another correctly; redone when the viewer has gone some way. */
			if(object.sorted == null || Math.hypot(fx - object.sorted[0], eye.y - object.sorted[1], fz - object.sorted[2]) > 60) {

				let order = new Array(count);
				let distance = new Float32Array(count);

				for(let index = 0; index < count; index++) {

					order[index] = index;

					let dx = puffs[index * 5] - fx, dy = puffs[index * 5 + 1] - eye.y, dz = puffs[index * 5 + 2] - fz;

					distance[index] = dx * dx + dy * dy + dz * dz;
				}

				order.sort((a, b) => distance[b] - distance[a]);

				let matrices = new Float32Array(Math.max(count, 1) * 16);

				for(let slot = 0; slot < count; slot++) {

					let at = order[slot] * 5, m = slot * 16, size = puffs[at + 3];

					matrices[m] = size;
					matrices[m + 5] = size;
					matrices[m + 10] = size;
					matrices[m + 12] = puffs[at];
					matrices[m + 13] = puffs[at + 1];
					matrices[m + 14] = puffs[at + 2];
					matrices[m + 15] = puffs[at + 4];
				}

				object.mesh.thinInstanceSetBuffer("matrix", matrices, 16, false);
				object.sorted = [fx, eye.y, fz];
				object.count = count;
			}

			let view = camera.getViewMatrix().m;
			let right = new BABYLON.Vector3(view[0], view[4], view[8]);
			let up = new BABYLON.Vector3(view[1], view[5], view[9]);
			let toward = new BABYLON.Vector3(-view[2], -view[6], -view[10]);

			material.setVector3("camPos", eye);
			material.setVector3("camRight", right);
			material.setVector3("camUp", up);
			material.setVector3("drift", drift);
			material.setVector3("sunView", new BABYLON.Vector3(
				BABYLON.Vector3.Dot(env.sunDir, right),
				BABYLON.Vector3.Dot(env.sunDir, up),
				BABYLON.Vector3.Dot(env.sunDir, toward)
			));
			material.setColor3("sunColor", env.sunColor);
			material.setColor3("fogColor", env.fogColor);
			material.setFloat("fogDensity", env.fogDensity);
			material.setFloat("time", seconds);

			ace.setState(context, instance.record, { puffs: object.count });
		},

		onChange: (context, instance) => {

			clouds.onDestroy(context, instance);
			instance.object = clouds.onCreate(context, instance);
		},

		onDestroy: (context, instance) => {

			instance.object.texture.dispose();
			instance.object.material.dispose();
			instance.object.mesh.dispose();
		}
	};

	ace.register([terrain, scatter, particles, speech, storage, water, clouds]);

	/* ================================================================ boot

		What a document wants of the page that runs it, it says itself, in the world's settings (`boot`, §2.3.1), and `ace.run` sees to it:
		the title of the page, the fonts that text is to be drawn in (text is drawn once, in whatever face is there when it is drawn), the
		physics that has to be fetched before the world is made, and a cover that stays solid until the world has been made. The page that
		hosts a document is therefore nothing but a stage, the engine files and a call to `ace.run`.

		The address can ask for a lighter picture, which belongs to the machine and not to the document:
			?detail=0.6    pulls the ranges of terrain and scatter in to 60% (a headset does this by itself, to half)
			?xrscale=0.8   the fraction of a headset's own resolution to draw at (0.7 by itself, on a Quest)
			?post=0        no final image pass
			?physics=off   no character collision
	*/

	const run = ace.run;

	const loadScript = source => new Promise(resolve => {

		let element = root.document.createElement("script");

		element.src = source;
		element.onload = element.onerror = () => resolve();
		root.document.head.appendChild(element);
	});

	const make = (tag, css, text) => {

		let element = root.document.createElement(tag);

		if(css) element.style.cssText = css;
		if(text) element.textContent = text;

		return element;
	};

	/* Every component, wherever it is in the document. */
	const each = (entity, visit) => {

		Object.keys(entity.utilities || { }).forEach(name => visit(entity.utilities[name]));
		Object.keys(entity.packages || { }).forEach(name => each(entity.packages[name], visit));
	};

	ace.run = (selector, scene) => {

		const params = new root.URLSearchParams(root.location != null ? root.location.search : "");
		const settings = (((scene.packages || { }).world || { }).utilities || { }).settings;
		const data = settings != null && settings.properties != null && settings.properties.data != null ? settings.properties.data : { };
		const boot = isObject(data.boot) ? data.boot : { };
		const quest = /OculusBrowser|Quest/i.test(root.navigator != null ? root.navigator.userAgent : "");

		if(boot.title && root.document != null)
			root.document.title = boot.title;

		/* the lighter picture, made by changing what is about to be run */
		if(params.get("post") === "0" && isObject(data.post))
			delete data.post.finish;

		const xrscale = parseFloat(params.get("xrscale")) || (quest ? 0.7 : null);
		const detail = params.has("detail") ? parseFloat(params.get("detail")) : (quest ? 0.5 : 1);

		each(scene, component => {

			let tags = (component.properties || { }).tags || [];
			let own = (component.properties || { }).data;

			if(own == null)
				return;

			if(xrscale && tags[0] === "camera" && isObject(own.xr))
				own.xr.scale = xrscale;

			if(detail > 0 && detail !== 1 && (tags[0] === "scatter" || tags[0] === "terrain") && Array.isArray(own.lods))
				own.lods.forEach(level => { if(level.range < 1e8) level.range *= detail; });
		});

		/* the cover */
		let overlay = null, bar = null, status = null;
		const cover = isObject(boot.loading) ? boot.loading : null;

		if(cover != null) {

			overlay = make("div", "position:absolute;inset:0;z-index:10;display:flex;align-items:center;justify-content:center;flex-direction:column;pointer-events:none;letter-spacing:.1em;line-height:1.1;font-weight:700;font-size:clamp(28px,5vw,64px);" +
				"background:" + (cover.background || "#000") + ";color:" + (cover.color || "#fff") + ";font-family:" + (cover.titleFont ? "\"" + cover.titleFont + "\"," : "") + "serif", cover.title || "");

			let track = make("div", "width:min(320px,60vw);height:3px;margin-top:1em;border-radius:2px;overflow:hidden;background:" + (cover.track || "#333"));

			bar = make("div", "height:100%;width:0;transition:width .3s;background:" + (cover.bar || cover.color || "#fff"));
			track.appendChild(bar);

			status = make("small", "font-weight:400;font-size:15px;line-height:1.5;letter-spacing:.08em;margin-top:1.4em;color:" + (cover.muted || cover.color || "#aaa") + ";font-family:" +
				(cover.bodyFont ? "\"" + cover.bodyFont + "\"," : "") + "system-ui,sans-serif", cover.status || "");

			overlay.appendChild(track);
			overlay.appendChild(status);
			overlay.id = "loading";
			root.document.body.appendChild(overlay);
		}

		/* The world is made at once, and held still until what it needs has arrived. */
		const context = run(selector, scene);

		context.running = false;
		root.origins = root.angaia = root.ace_context = context;

		if(root.addEventListener != null)
			root.addEventListener("contextmenu", event => event.preventDefault());

		context.booting = (async () => {

			await Promise.all((Array.isArray(boot.fonts) ? boot.fonts : []).map(font => {

				try {

					let face = new root.FontFace(font.family, "url(" + font.src + ")", { weight: font.weight || "400" });

					return face.load().then(loaded => root.document.fonts.add(loaded)).catch(() => { });

				} catch(error) {

					return null;
				}
			}));

			if(data.gravity != null && root.CANNON === undefined)
				await loadScript("https://cdn.babylonjs.com/cannon.js");

			/* a document that asks for Havok gets it; if it cannot be had the document keeps to what it did without */
			if(data.physics === "character" && params.get("physics") !== "off" && root.havokInstance == null) {

				await loadScript("https://cdn.babylonjs.com/havok/HavokPhysics_umd.js");

				try {

					root.havokInstance = await root.HavokPhysics();

				} catch(error) {

					root.console.warn("Havok did not load: " + error.message);
				}
			}

			context.running = true;

			if(overlay == null)
				return context;

			/*
				The cover stays solid until the world is made: the terrain (if there is one) is there, every model and texture has arrived,
				nothing is waiting to be built, and that has held for a moment.
			*/
			const started = root.performance.now();
			const minimum = (cover.minimum != null ? cover.minimum : 3) * 1000;
			const timeout = (cover.timeout != null ? cover.timeout : 60) * 1000;

			let quiet = 0;

			const timer = root.setInterval(() => {

				let total = 0, done = 0, waiting = 0;

				Object.keys(context.state).forEach(id => {

					let st = context.state[id];

					if(st == null || typeof st !== "object")
						return;

					if(st.loaded !== undefined) {

						total++;

						if(st.loaded === true) done++;
						else waiting++;
					}

					if(st.queued > 0) waiting++;
					if(st.error) status.textContent = "problem: " + st.error;
				});

				let terrainRecord = context.resolved.components.find(component => component.type === "terrain");
				let terrainState = terrainRecord != null && context.instances[ace.identity(terrainRecord)] ? context.state[ace.identity(terrainRecord)] : null;
				let ready = (terrainRecord == null || (terrainState != null && terrainState.loaded)) && context.frame > 120 && waiting === 0;

				quiet = ready ? quiet + 1 : 0;

				if(total > 0)
					bar.style.width = Math.round(100 * done / total) + "%";

				if(!status.textContent.startsWith("problem"))
					status.textContent = ready ? (cover.ready || "") : (cover.status || "") + (cover.status ? "  " : "") + done + " of " + total;

				if((quiet >= 8 && root.performance.now() - started > minimum) || root.performance.now() - started > timeout) {

					overlay.style.transition = "opacity 1.2s";
					overlay.style.opacity = 0;
					root.clearInterval(timer);
					root.setTimeout(() => overlay.remove(), 1400);
				}

			}, 250);

			return context;
		})();

		return context;
	};


	};

	/* (`ace.adapter` is an empty object until the operators make the real one: it is the helpers that say it is there) */
	if(root.ace.adapter != null && root.ace.adapter.helpers != null)
		extension();
	else
		(root.ace.deferred = root.ace.deferred || []).push(extension);

})(typeof globalThis !== "undefined" ? globalThis : this);
