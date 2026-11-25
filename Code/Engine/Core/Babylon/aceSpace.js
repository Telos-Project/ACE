/*

	ACE - Babylon.js space extension.

	Loads after aceOperators.js. Adds what a universe needs and a document cannot
	carry in its own data:

		starfield  The sky of a place with no sky: stars, and the band of a galaxy.
		star       A sun: a glowing sphere that lights what is near it.
		planet     A world: a telluric one (terrain made of the noise its data
		           describes, drawn at every scale from orbit to the ground, with
		           an ocean, an atmosphere, clouds and rings) or a gas giant.

	The common thread, as for terrain and scatter, is that bulk stays out of the
	document: a planet's surface is a function of a few numbers, made where it is
	looked at and nowhere else.

	Positions of things so far apart that a float cannot place them are held in the
	document as they are, and the world names the entity the view is at
	(`world.origin`); see "ACE Liberty.md" section 2.3.27 onward.

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

	const now = () =>
		root.performance != null ? root.performance.now() : Date.now();

	const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
	const mix = (a, b, t) => a + (b - a) * t;
	const smooth = (a, b, x) => { let t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

	/* ============================================================== noise */

	/*

		Simplex noise in three dimensions, from a seed. A planet's height is a
		function of the direction from its centre and a handful of numbers, so
		the same planet is the same planet wherever it is asked about.

	*/
	const hashInt = (seed, index) => {

		let h = Math.imul(index | 0, 0xd2a80a3f);

		h = (h + (seed | 0)) | 0;
		h ^= h >>> 9; h = (h + 0xa884f197) | 0;
		h ^= h >>> 11; h = Math.imul(h, 0x6c736f4b);
		h ^= h >>> 13; h = (h + 0xb79f3abb) | 0;
		h ^= h >>> 15; h = Math.imul(h, 0x1b56c4f5);
		h ^= h >>> 17;

		return h >>> 0;
	};

	const GRAD3 = [
		[1, 1, 0], [-1, 1, 0], [1, -1, 0], [-1, -1, 0], [1, 0, 1], [-1, 0, 1],
		[1, 0, -1], [-1, 0, -1], [0, 1, 1], [0, -1, 1], [0, 1, -1], [0, -1, -1]
	];

	const makeNoise = seed => {

		let perm = new Uint8Array(512), permMod = new Uint8Array(512), table = new Uint8Array(256);

		for(let i = 0; i < 256; i++)
			table[i] = i;

		for(let i = 255; i > 0; i--) {

			let j = hashInt(seed, i) % (i + 1);
			let t = table[i]; table[i] = table[j]; table[j] = t;
		}

		for(let i = 0; i < 512; i++) {

			perm[i] = table[i & 255];
			permMod[i] = perm[i] % 12;
		}

		const F3 = 1 / 3, G3 = 1 / 6;

		return (x, y, z) => {

			let s = (x + y + z) * F3;
			let i = Math.floor(x + s), j = Math.floor(y + s), k = Math.floor(z + s);
			let t = (i + j + k) * G3;
			let x0 = x - (i - t), y0 = y - (j - t), z0 = z - (k - t);
			let i1, j1, k1, i2, j2, k2;

			if(x0 >= y0) {

				if(y0 >= z0) { i1 = 1; j1 = 0; k1 = 0; i2 = 1; j2 = 1; k2 = 0; }
				else if(x0 >= z0) { i1 = 1; j1 = 0; k1 = 0; i2 = 1; j2 = 0; k2 = 1; }
				else { i1 = 0; j1 = 0; k1 = 1; i2 = 1; j2 = 0; k2 = 1; }

			} else {

				if(y0 < z0) { i1 = 0; j1 = 0; k1 = 1; i2 = 0; j2 = 1; k2 = 1; }
				else if(x0 < z0) { i1 = 0; j1 = 1; k1 = 0; i2 = 0; j2 = 1; k2 = 1; }
				else { i1 = 0; j1 = 1; k1 = 0; i2 = 1; j2 = 1; k2 = 0; }
			}

			let x1 = x0 - i1 + G3, y1 = y0 - j1 + G3, z1 = z0 - k1 + G3;
			let x2 = x0 - i2 + 2 * G3, y2 = y0 - j2 + 2 * G3, z2 = z0 - k2 + 2 * G3;
			let x3 = x0 - 1 + 3 * G3, y3 = y0 - 1 + 3 * G3, z3 = z0 - 1 + 3 * G3;
			let ii = i & 255, jj = j & 255, kk = k & 255;
			let n = 0, a;

			a = 0.6 - x0 * x0 - y0 * y0 - z0 * z0;

			if(a > 0) { let g = GRAD3[permMod[ii + perm[jj + perm[kk]]]]; a *= a; n += a * a * (g[0] * x0 + g[1] * y0 + g[2] * z0); }

			a = 0.6 - x1 * x1 - y1 * y1 - z1 * z1;

			if(a > 0) { let g = GRAD3[permMod[ii + i1 + perm[jj + j1 + perm[kk + k1]]]]; a *= a; n += a * a * (g[0] * x1 + g[1] * y1 + g[2] * z1); }

			a = 0.6 - x2 * x2 - y2 * y2 - z2 * z2;

			if(a > 0) { let g = GRAD3[permMod[ii + i2 + perm[jj + j2 + perm[kk + k2]]]]; a *= a; n += a * a * (g[0] * x2 + g[1] * y2 + g[2] * z2); }

			a = 0.6 - x3 * x3 - y3 * y3 - z3 * z3;

			if(a > 0) { let g = GRAD3[permMod[ii + 1 + perm[jj + 1 + perm[kk + 1]]]]; a *= a; n += a * a * (g[0] * x3 + g[1] * y3 + g[2] * z3); }

			return 32 * n;
		};
	};

	const fbm = (noise, x, y, z, octaves, gain) => {

		let sum = 0, amp = 1, norm = 0, f = 1;

		for(let o = 0; o < octaves; o++) {

			sum += amp * noise(x * f, y * f, z * f);
			norm += amp;
			amp *= gain;
			f *= 2.03;
		}

		return sum / norm;
	};

	/* ============================================================== colour of a hot body */

	/* The colour of a black body at a temperature, as linear RGB: Tanner Helland's fit to the Planckian locus. */
	const blackBody = kelvin => {

		let t = clamp(kelvin, 1000, 40000) / 100, r, g, b;

		if(t <= 66) {

			r = 255;
			g = clamp(99.4708025861 * Math.log(t) - 161.1195681661, 0, 255);
			b = t <= 19 ? 0 : clamp(138.5177312231 * Math.log(t - 10) - 305.0447927307, 0, 255);

		} else {

			r = clamp(329.698727446 * Math.pow(t - 60, -0.1332047592), 0, 255);
			g = clamp(288.1221695283 * Math.pow(t - 60, -0.0755148492), 0, 255);
			b = 255;
		}

		return [Math.pow(r / 255, 2.2), Math.pow(g / 255, 2.2), Math.pow(b / 255, 2.2)];
	};

	/* ============================================================== shared shader text */

	const NOISE_GLSL = `
		vec3 hash33(vec3 p) {
			p = vec3(dot(p, vec3(127.1, 311.7, 74.7)), dot(p, vec3(269.5, 183.3, 246.1)), dot(p, vec3(113.5, 271.9, 124.6)));
			return fract(sin(p) * 43758.5453123) * 2.0 - 1.0;
		}
		float vnoise(vec3 p) {
			vec3 i = floor(p), f = fract(p);
			vec3 u = f * f * (3.0 - 2.0 * f);
			float a = dot(hash33(i + vec3(0, 0, 0)), f - vec3(0, 0, 0));
			float b = dot(hash33(i + vec3(1, 0, 0)), f - vec3(1, 0, 0));
			float c = dot(hash33(i + vec3(0, 1, 0)), f - vec3(0, 1, 0));
			float d = dot(hash33(i + vec3(1, 1, 0)), f - vec3(1, 1, 0));
			float e = dot(hash33(i + vec3(0, 0, 1)), f - vec3(0, 0, 1));
			float g = dot(hash33(i + vec3(1, 0, 1)), f - vec3(1, 0, 1));
			float h = dot(hash33(i + vec3(0, 1, 1)), f - vec3(0, 1, 1));
			float k = dot(hash33(i + vec3(1, 1, 1)), f - vec3(1, 1, 1));
			return mix(mix(mix(a, b, u.x), mix(c, d, u.x), u.y), mix(mix(e, g, u.x), mix(h, k, u.x), u.y), u.z);
		}
		float fbm3(vec3 p, int oct) {
			float s = 0.0, a = 0.5;
			for (int i = 0; i < 8; i++) {
				if (i >= oct) break;
				s += a * vnoise(p);
				p = p * 2.03 + vec3(7.1, 3.3, 1.7);
				a *= 0.5;
			}
			return s;
		}
	`;

	const SHADERS = BABYLON.Effect.ShadersStore;

	/* ============================================================== starfield */

	SHADERS.aceStarfieldVertexShader = `
		precision highp float;
		attribute vec3 position;
		uniform mat4 worldViewProjection;
		varying vec3 vDir;
		void main(void) {
			vDir = position;
			gl_Position = worldViewProjection * vec4(position, 1.0);
		}
	`;

	SHADERS.aceStarfieldFragmentShader = `
		precision highp float;
		precision highp sampler2D;
		varying vec3 vDir;
		uniform float seed;
		uniform float density;
		uniform float band;
		uniform vec3 bandAxis;
		${NOISE_GLSL}

		// stars: a cell of the sphere holds at most one, at a place and brightness of its own
		vec3 stars(vec3 d, float scale, float threshold, float sizeScale) {
			vec3 p = d * scale;
			vec3 cell = floor(p);
			vec3 local = fract(p) - 0.5;
			vec3 h = hash33(cell + seed) * 0.5 + 0.5;
			vec3 centre = (hash33(cell * 1.7 + seed + 9.0)) * 0.30;
			float r = h.x;
			if (r < threshold) return vec3(0.0);
			float mag = pow((r - threshold) / (1.0 - threshold), 3.0);
			float dist = length(local - centre);
			float core = smoothstep(0.09 * sizeScale, 0.0, dist);
			vec3 tint = mix(vec3(1.0, 0.82, 0.62), vec3(0.72, 0.82, 1.0), h.y);
			return tint * core * (0.25 + 2.5 * mag);
		}

		void main(void) {
			vec3 d = normalize(vDir);
			vec3 col = vec3(0.0);
			col += stars(d, 90.0, 1.0 - 0.06 * density, 1.0);
			col += stars(d, 190.0, 1.0 - 0.05 * density, 0.9);
			col += stars(d, 420.0, 1.0 - 0.03 * density, 0.8) * 0.8;
			// the band of the galaxy: dense along a great circle, broken by dust
			float lat = dot(d, normalize(bandAxis));
			float strength = exp(-lat * lat * 14.0);
			float cloud = fbm3(d * 3.0 + seed, 5) * 0.5 + 0.5;
			float dust = fbm3(d * 7.0 + 11.0 + seed, 5) * 0.5 + 0.5;
			vec3 glow = mix(vec3(0.34, 0.30, 0.38), vec3(0.62, 0.52, 0.42), cloud) * strength * (0.55 + 0.9 * cloud) * (1.0 - 0.7 * smoothstep(0.35, 0.7, dust));
			col += glow * band * 0.22;
			col += stars(d, 700.0, 1.0 - 0.18 * strength * density, 0.8) * strength * 0.5;
			gl_FragColor = vec4(col, 1.0);
		}
	`;

	/* The meshes that are the sky are drawn first, then everything else over them. */
	const skyFirst = scene => {

		if(scene.aceSkyFirst === true)
			return;

		scene.aceSkyFirst = true;

		scene.setRenderingOrder(0, (a, b) => {

			let skyA = a.getMesh().aceSky === true, skyB = b.getMesh().aceSky === true;

			if(skyA !== skyB)
				return skyA ? -1 : 1;

			return a.getMesh()._distanceToCamera - b.getMesh()._distanceToCamera;
		});
	};

	const starfield = {

		type: "starfield",

		onCreate: (context, instance) => {

			let scene = context.meta.scene;
			let data = instance.data;
			let node = H.nodeFor(context, instance.entity);

			let mesh = BABYLON.MeshBuilder.CreateSphere(instance.path.join("."), { diameter: 2000, segments: 24 }, scene);

			mesh.parent = node;
			mesh.infiniteDistance = true;
			mesh.isPickable = false;
			mesh.aceSky = true;
			mesh.alwaysSelectAsActiveMesh = true;
			H.own(mesh, instance.entityKey);

			let material = new BABYLON.ShaderMaterial(
				instance.path.join(".") + ".material", scene,
				{ vertex: "aceStarfield", fragment: "aceStarfield" },
				{
					attributes: ["position"],
					uniforms: ["worldViewProjection", "seed", "density", "band", "bandAxis"]
				}
			);

			material.backFaceCulling = false;
			material.disableDepthWrite = true;
			material.setFloat("seed", data.seed != null ? data.seed : 1);
			material.setFloat("density", data.density != null ? data.density : 1);
			material.setFloat("band", data.band != null ? data.band : 1);
			material.setVector3("bandAxis", H.vector(data.axis, [0.3, 1, 0.2]));
			mesh.material = material;
			skyFirst(scene);

			return { mesh, material };
		},

		onChange: (context, instance) => {

			starfield.onDestroy(context, instance);
			instance.object = starfield.onCreate(context, instance);
		},

		onUpdate: () => { },

		onDestroy: (context, instance) => {

			instance.object.material.dispose();
			instance.object.mesh.dispose();
		}
	};

	/* ============================================================== star */

	SHADERS.aceStarVertexShader = `
		precision highp float;
		attribute vec3 position;
		uniform mat4 world;
		uniform mat4 viewProjection;
		varying vec3 vWorld;
		varying vec3 vObj;
		void main(void) {
			vObj = normalize(position);
			vec4 w = world * vec4(position, 1.0);
			vWorld = w.xyz;
			gl_Position = viewProjection * w;
		}
	`;

	SHADERS.aceStarFragmentShader = `
		precision highp float;
		precision highp sampler2D;
		varying vec3 vWorld;
		varying vec3 vObj;
		uniform vec3 camPos;
		uniform vec3 starColor;
		uniform float time;
		uniform float seed;
		uniform float power;
		${NOISE_GLSL}
		void main(void) {
			vec3 n = normalize(vObj);
			vec3 V = normalize(camPos - vWorld);
			float mu = clamp(dot(n, V), 0.0, 1.0);
			// granulation, drifting slowly, and larger cooler patches
			float g1 = fbm3(n * 9.0 + vec3(0.0, time * 0.02, seed), 5);
			float g2 = fbm3(n * 3.0 + vec3(seed, time * 0.01, 0.0), 4);
			float spots = smoothstep(0.30, 0.55, g2) * 0.45;
			float surface = 0.82 + 0.5 * g1 - spots;
			// limb darkening
			float limb = 0.35 + 0.65 * pow(mu, 0.6);
			vec3 col = starColor * surface * limb * power;
			col = mix(col, starColor * power * 1.15, 0.12);
			gl_FragColor = vec4(col, 1.0);
		}
	`;

	SHADERS.aceGlowVertexShader = `
		precision highp float;
		attribute vec3 position;
		attribute vec2 uv;
		uniform mat4 world;
		uniform mat4 viewProjection;
		varying vec2 vUv;
		void main(void) {
			vUv = uv * 2.0 - 1.0;
			gl_Position = viewProjection * world * vec4(position, 1.0);
		}
	`;

	SHADERS.aceGlowFragmentShader = `
		precision highp float;
		varying vec2 vUv;
		uniform vec3 starColor;
		uniform float strength;
		void main(void) {
			float r = length(vUv);
			if (r > 1.0) discard;
			// from the limb of the star outwards: a hot ring, then a long soft fall
			float core = exp(-pow(r * 3.2, 2.0));
			float halo = pow(1.0 - r, 3.0) * 0.5;
			float ray = pow(max(0.0, 1.0 - r), 6.0);
			vec3 col = starColor * (core * 1.4 + halo + ray * 0.6) * strength;
			gl_FragColor = vec4(col, clamp(core + halo, 0.0, 1.0));
		}
	`;

	const star = {

		type: "star",

		onCreate: (context, instance) => {

			let scene = context.meta.scene;
			let data = instance.data;
			let node = H.nodeFor(context, instance.entity);
			let name = instance.path.join(".");
			let radius = data.radius != null ? data.radius : 6.96e8;
			let temperature = data.temperature != null ? data.temperature : 5778;
			let colour = blackBody(temperature);
			let peak = Math.max(colour[0], colour[1], colour[2]);

			colour = colour.map(value => value / peak);

			let mesh = BABYLON.MeshBuilder.CreateSphere(name, { diameter: 2, segments: 48 }, scene);

			mesh.parent = node;
			mesh.scaling.setAll(radius);
			mesh.isPickable = false;
			mesh.alwaysSelectAsActiveMesh = true;
			H.own(mesh, instance.entityKey);

			let material = new BABYLON.ShaderMaterial(
				name + ".material", scene, { vertex: "aceStar", fragment: "aceStar" },
				{ attributes: ["position"], uniforms: ["world", "viewProjection", "camPos", "starColor", "time", "seed", "power"] }
			);

			material.backFaceCulling = true;
			material.setVector3("starColor", new BABYLON.Vector3(colour[0], colour[1], colour[2]));
			material.setFloat("seed", data.seed != null ? data.seed % 100 : 0);
			material.setFloat("power", data.kind === "blackhole" ? 0 : (data.power != null ? data.power : 1.6));
			mesh.material = material;

			let glow = BABYLON.MeshBuilder.CreatePlane(name + ".glow", { size: 2 }, scene);

			glow.parent = node;
			glow.billboardMode = BABYLON.Mesh.BILLBOARDMODE_ALL;
			glow.scaling.setAll(data.kind === "blackhole" ? (data.glowRadius != null ? data.glowRadius : radius * 24) : radius * 7);
			glow.isPickable = false;
			glow.alwaysSelectAsActiveMesh = true;
			glow.alphaIndex = 20;

			let glowMaterial = new BABYLON.ShaderMaterial(
				name + ".glowMaterial", scene, { vertex: "aceGlow", fragment: "aceGlow" },
				{ attributes: ["position", "uv"], uniforms: ["world", "viewProjection", "starColor", "strength"] }
			);

			glowMaterial.backFaceCulling = false;
			glowMaterial.disableDepthWrite = true;
			glowMaterial.alphaMode = BABYLON.Engine.ALPHA_ADD;
			glowMaterial.needAlphaBlending = () => true;
			glowMaterial.setVector3("starColor", new BABYLON.Vector3(colour[0], colour[1], colour[2]));
			glowMaterial.setFloat("strength", 0.9);
			glow.material = glowMaterial;

			/* flux at one astronomical unit relative to the sun's: what a world standing here is lit by */
			let luminosity = Math.pow(temperature / 5778, 4) * Math.pow(radius / 6.96e8, 2);

			ace.setState(context, instance.record, { color: colour, luminosity, radius });

			return { mesh, material, glow, glowMaterial, node, colour, luminosity, radius, temperature };
		},

		onChange: (context, instance) => {

			star.onDestroy(context, instance);
			instance.object = star.onCreate(context, instance);
		},

		onUpdate: (context, instance) => {

			let object = instance.object;
			let scene = context.meta.scene;
			let camera = scene.activeCamera;

			if(camera == null)
				return;

			object.material.setVector3("camPos", camera.globalPosition);
			object.material.setFloat("time", context.meta.elapsed != null ? context.meta.elapsed : 0);
		},

		onDestroy: (context, instance) => {

			let object = instance.object;

			object.glowMaterial.dispose();
			object.glow.dispose();
			object.material.dispose();
			object.mesh.dispose();
		}
	};

	/* ============================================================== planet */

	/* The stars lighting a place, as they appear to the view: where, what colour, how bright. */
	const sunsOf = (context, around) => {

		let list = [];

		Object.keys(context.instances).forEach(id => {

			let instance = context.instances[id];

			if(instance.type !== "star" || instance.object == null || instance.object.node == null)
				return;

			instance.object.node.computeWorldMatrix(false);

			let p = instance.object.node.absolutePosition;
			let flux = 1;

			if(around != null) {

				let d = BABYLON.Vector3.Distance(p, around) / 1.496e11;

				flux = clamp(instance.object.luminosity / Math.max(d * d, 1e-6), 0.12, 2.6);
			}

			list.push({ position: p.clone(), colour: instance.object.colour, flux });
		});

		return list;
	};

	const MAX_SUNS = 4;

	const setSuns = (material, suns) => {

		let positions = [], colours = [];

		for(let i = 0; i < MAX_SUNS; i++) {

			let s = suns[i];

			positions.push(s ? s.position.x : 0, s ? s.position.y : 0, s ? s.position.z : 0);
			colours.push(s ? s.colour[0] * s.flux : 0, s ? s.colour[1] * s.flux : 0, s ? s.colour[2] * s.flux : 0);
		}

		material.setArray3("sunPos", positions);
		material.setArray3("sunCol", colours);
		material.setInt("nSuns", Math.min(suns.length, MAX_SUNS));
	};

	const SUN_UNIFORMS = `
		uniform vec3 sunPos[4];
		uniform vec3 sunCol[4];
		uniform int nSuns;
	`;

	/* ---- the surface of a telluric world */

	SHADERS.aceSurfaceVertexShader = `
		precision highp float;
		attribute vec3 position;
		attribute vec3 normal;
		attribute vec2 uv;
		uniform mat4 world;
		uniform mat4 viewProjection;
		varying vec3 vWorld;
		varying vec3 vNormal;
		varying float vHeight;
		void main(void) {
			vec4 w = world * vec4(position, 1.0);
			vWorld = w.xyz;
			vNormal = normalize(mat3(world) * normal);
			vHeight = uv.x;
			gl_Position = viewProjection * w;
		}
	`;

	SHADERS.aceSurfaceFragmentShader = `
		precision highp float;
		precision highp sampler2D;
		varying vec3 vWorld;
		varying vec3 vNormal;
		varying float vHeight;
		uniform vec3 camPos;
		uniform vec3 planetCenter;
		uniform vec3 axis;
		uniform float seaLevel;
		uniform float warmth;
		uniform float barren;
		uniform float tileNear;
		uniform vec3 skyColor;
		uniform vec3 tint;
		uniform sampler2D grassT, rockT, sandT, iceT;
		${SUN_UNIFORMS}

		vec3 lin(vec3 c) { return pow(c, vec3(2.2)); }

		// one layer, sampled along all three axes so that cliffs do not stretch
		vec3 tri(sampler2D t, vec3 p, vec3 n, float tile, float f) {
			vec3 w = pow(abs(n), vec3(4.0));
			w /= (w.x + w.y + w.z);
			vec3 a = lin(texture2D(t, p.zy / tile).rgb);
			vec3 b = lin(texture2D(t, p.xz / tile).rgb);
			vec3 c = lin(texture2D(t, p.xy / tile).rgb);
			vec3 near = a * w.x + b * w.y + c * w.z;
			vec3 w2 = w;
			vec3 far = lin(texture2D(t, p.zy / (tile * 23.0)).rgb) * w2.x + lin(texture2D(t, p.xz / (tile * 23.0)).rgb) * w2.y + lin(texture2D(t, p.xy / (tile * 23.0)).rgb) * w2.z;
			return mix(near, far, f);
		}

		void main(void) {
			vec3 rel = vWorld - planetCenter;
			vec3 up = normalize(rel);
			vec3 N = normalize(vNormal);
			float dist = length(camPos - vWorld);
			float lat = abs(dot(up, normalize(axis)));
			float slope = 1.0 - clamp(dot(N, up), 0.0, 1.0);
			float h = vHeight - seaLevel;      // metres above the sea (or the lowest ground, where there is no sea)

			// the temperature: cold toward the poles and the heights, warm at the equator
			float cold = clamp(lat * 1.15 - warmth + h / 9000.0, 0.0, 1.0);
			float f = smoothstep(120.0, 1600.0, dist);
			float steep = smoothstep(0.10, 0.34, slope);
			float beach = (1.0 - smoothstep(10.0, 90.0, h)) * (1.0 - steep);
			float snow = smoothstep(0.55, 0.78, cold + (h > 3000.0 ? 0.15 : 0.0)) * (1.0 - smoothstep(0.35, 0.6, slope));
			float rockW = max(steep, smoothstep(2500.0, 6500.0, h));

			vec3 p = vWorld;
			vec3 col = vec3(0.0);
			float wRock = clamp(rockW, 0.0, 1.0);
			float wSand = beach * (1.0 - wRock);
			float wSnow = snow * (1.0 - wRock * 0.7);
			float wGrass = max(1.0 - wRock - wSand - wSnow, 0.0) * (1.0 - barren);
			float wDust = max(1.0 - wRock - wSand - wSnow, 0.0) * barren;
			float sum = wRock + wSand + wSnow + wGrass + wDust;
			wRock /= sum; wSand /= sum; wSnow /= sum; wGrass /= sum; wDust /= sum;

			if (wRock > 0.01) col += wRock * tri(rockT, p, N, tileNear * 2.0, f);
			if (wSand > 0.01) col += wSand * tri(sandT, p, N, tileNear, f);
			if (wSnow > 0.01) col += wSnow * tri(iceT, p, N, tileNear, f);
			if (wGrass > 0.01) col += wGrass * tri(grassT, p, N, tileNear, f) * vec3(0.82, 0.95, 0.7);
			if (wDust > 0.01) col += wDust * tri(sandT, p, N, tileNear * 1.7, f) * vec3(0.55, 0.52, 0.5);
			col *= tint;

			// light from every star near enough to matter
			vec3 light = vec3(0.0);
			for (int i = 0; i < 4; i++) {
				if (i >= nSuns) break;
				vec3 L = normalize(sunPos[i] - vWorld);
				float ndl = dot(N, L);
				float lit = max(ndl, 0.0);
				float wrap = max((ndl + 0.18) / 1.18, 0.0);
				float upNdl = dot(up, L);
				float day = smoothstep(-0.12, 0.18, upNdl);
				light += sunCol[i] * mix(wrap, lit, 0.6) * day;
			}
			vec3 ambient = skyColor * (0.012 + 0.03 * clamp(light.r + light.g + light.b, 0.0, 1.0));
			vec3 lit = col * (light * 3.4 + ambient);
			vec3 mapped = lit / (1.0 + lit * 0.18);
			gl_FragColor = vec4(pow(clamp(mapped, 0.0, 1.0), vec3(1.0 / 2.2)), 1.0);
		}
	`;

	/* ---- the ocean */

	SHADERS.aceOceanVertexShader = `
		precision highp float;
		attribute vec3 position;
		attribute vec3 normal;
		attribute vec2 uv;
		uniform mat4 world;
		uniform mat4 viewProjection;
		varying vec3 vWorld;
		varying vec3 vNormal;
		varying float vDepth;
		void main(void) {
			vec4 w = world * vec4(position, 1.0);
			vWorld = w.xyz;
			vNormal = normalize(mat3(world) * normal);
			vDepth = uv.x;
			gl_Position = viewProjection * w;
		}
	`;

	SHADERS.aceOceanFragmentShader = `
		precision highp float;
		precision highp sampler2D;
		varying vec3 vWorld;
		varying vec3 vNormal;
		varying float vDepth;
		uniform vec3 camPos;
		uniform vec3 planetCenter;
		uniform float time;
		uniform vec3 shallowColor;
		uniform vec3 deepColor;
		uniform vec3 skyColor;
		uniform sampler2D waves;
		${SUN_UNIFORMS}
		void main(void) {
			vec3 N0 = normalize(vNormal);
			vec3 V = normalize(camPos - vWorld);
			float dist = length(camPos - vWorld);
			vec3 up = normalize(vWorld - planetCenter);
			// ripples as the tangent plane sees them
			vec3 t1 = normalize(cross(up, vec3(0.31, 0.93, 0.19)));
			vec3 t2 = cross(up, t1);
			vec2 uvw = vec2(dot(vWorld, t1), dot(vWorld, t2));
			vec2 a = texture2D(waves, uvw / 38.0 + vec2(time * 0.011, time * 0.007)).xy * 2.0 - 1.0;
			vec2 b = texture2D(waves, uvw / 9.0 + vec2(-time * 0.019, time * 0.013)).xy * 2.0 - 1.0;
			float fade = 1.0 / (1.0 + dist * 0.0007);
			vec3 N = normalize(N0 + (t1 * (a.x + 0.5 * b.x) + t2 * (a.y + 0.5 * b.y)) * 0.28 * fade);
			float depth = max(vDepth, 0.0);
			float shoal = exp(-depth / 140.0);
			vec3 water = mix(deepColor, shallowColor, shoal);
			water = water * 2.4 + skyColor * 0.05;
			float fres = pow(1.0 - clamp(dot(N, V), 0.0, 1.0), 4.0);
			vec3 col = water * 0.0;
			vec3 spec = vec3(0.0);
			float sunLit = 0.0;
			for (int i = 0; i < 4; i++) {
				if (i >= nSuns) break;
				vec3 L = normalize(sunPos[i] - vWorld);
				float day = smoothstep(-0.1, 0.2, dot(up, L));
				float ndl = max(dot(N, L), 0.0);
				col += water * sunCol[i] * (0.06 + 0.9 * ndl) * day;
				vec3 H = normalize(L + V);
				spec += sunCol[i] * pow(max(dot(N, H), 0.0), 220.0) * 2.0 * day;
				sunLit += day;
			}
			col += (skyColor * 0.55 + vec3(0.1)) * (0.18 + fres * 0.8) * clamp(sunLit, 0.0, 1.0);
			col += spec;
			// foam where the ground comes close to the surface
			float foam = smoothstep(7.0, 0.0, depth) * smoothstep(-5.0, 0.0, vDepth);
			col += foam * 0.5 * clamp(sunLit, 0.0, 1.0);
			float alpha = clamp(0.42 + (1.0 - shoal) * 0.58 + fres * 0.3 + foam * 0.4, 0.0, 1.0);
			alpha *= smoothstep(-6.0, 1.5, vDepth);
			vec3 mapped = col / (1.0 + col * 0.18);
			gl_FragColor = vec4(pow(clamp(mapped, 0.0, 1.0), vec3(1.0 / 2.2)), alpha);
		}
	`;

	/* ---- atmosphere and clouds: shells of which only the ray through them matters */

	SHADERS.aceShellVertexShader = `
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

	const RAY_SPHERE = `
		// distance along a ray to a sphere: x is the near hit, y the far (both negative or x > y for a miss)
		vec2 raySphere(vec3 o, vec3 d, float r) {
			float b = dot(o, d);
			float c = dot(o, o) - r * r;
			float disc = b * b - c;
			if (disc < 0.0) return vec2(1.0, -1.0);
			float s = sqrt(disc);
			return vec2(-b - s, -b + s);
		}
	`;

	SHADERS.aceAtmosphereFragmentShader = `
		precision highp float;
		precision highp sampler2D;
		varying vec3 vWorld;
		uniform vec3 camPos;
		uniform vec3 planetCenter;
		uniform float groundRadius;
		uniform float atmoRadius;
		uniform float scaleHeight;
		uniform vec3 rayleigh;
		uniform float mieStrength;
		uniform float density;
		${SUN_UNIFORMS}
		${RAY_SPHERE}
		void main(void) {
			vec3 o = camPos - planetCenter;
			vec3 d = normalize(vWorld - camPos);
			vec2 atm = raySphere(o, d, atmoRadius);
			if (atm.y < 0.0) discard;
			vec2 gnd = raySphere(o, d, groundRadius);
			float t0 = max(atm.x, 0.0);
			float t1 = atm.y;
			if (gnd.y > 0.0 && gnd.x > 0.0 && gnd.x < t1) t1 = gnd.x;
			if (t1 <= t0) discard;
			float steps = 14.0;
			float dt = (t1 - t0) / steps;
			vec3 sum = vec3(0.0);
			float opticalView = 0.0;
			for (int i = 0; i < 14; i++) {
				vec3 p = o + d * (t0 + dt * (float(i) + 0.5));
				float h = length(p) - groundRadius;
				float rho = exp(-max(h, 0.0) / scaleHeight) * density;
				opticalView += rho * dt;
				for (int s = 0; s < 4; s++) {
					if (s >= nSuns) break;
					vec3 L = normalize(sunPos[s] - planetCenter);
					vec2 hit = raySphere(p, L, atmoRadius);
					float lightLen = max(hit.y, 0.0);
					// density toward the sun, by a mean over its path
					float hm = max(length(p + L * lightLen * 0.4) - groundRadius, 0.0);
					float opticalSun = exp(-hm / scaleHeight) * density * lightLen * 0.55;
					vec2 shadow = raySphere(p, L, groundRadius);
					float blocked = (shadow.x > 0.0) ? 0.0 : 1.0;
					vec3 att = exp(-(opticalSun + opticalView) * rayleigh);
					float mu = dot(d, L);
					float phaseR = 0.75 * (1.0 + mu * mu);
					float g = 0.76;
					float phaseM = (1.0 - g * g) / pow(1.0 + g * g - 2.0 * g * mu, 1.5) * 0.5;
					vec3 scatter = rayleigh * phaseR + vec3(mieStrength / scaleHeight * phaseM);
					vec3 sc = sunCol[s]; sc = mix(sc, vec3(max(sc.r, max(sc.g, sc.b))), 0.65);
						sum += sc * scatter * att * rho * dt * blocked * 1.15;
				}
			}
			vec3 transmit = exp(-opticalView * rayleigh);
			float alpha = clamp(1.0 - (transmit.r + transmit.g + transmit.b) / 3.0, 0.0, 1.0);
			vec3 mapped = sum / (1.0 + sum);
			gl_FragColor = vec4(pow(clamp(mapped, 0.0, 1.0), vec3(1.0 / 2.2)), alpha);
		}
	`;

	SHADERS.aceCloudsFragmentShader = `
		precision highp float;
		precision highp sampler2D;
		varying vec3 vWorld;
		uniform vec3 camPos;
		uniform vec3 planetCenter;
		uniform float cloudRadius;
		uniform mat3 spin;
		uniform float coverage;
		uniform float freq;
		uniform float time;
		uniform float seed;
		${SUN_UNIFORMS}
		${NOISE_GLSL}
		${RAY_SPHERE}
		void main(void) {
			vec3 o = camPos - planetCenter;
			vec3 d = normalize(vWorld - camPos);
			vec2 hit = raySphere(o, d, cloudRadius);
			if (hit.y < 0.0) discard;
			float t = hit.x > 0.0 ? hit.x : hit.y;
			vec3 p = o + d * t;
			vec3 n = normalize(p);
			vec3 local = spin * n;
			float base = fbm3(local * freq + vec3(seed, time * 0.0004, 0.0), 5);
			float detail = fbm3(local * freq * 3.4 + vec3(time * 0.0016, seed, 3.0), 4);
			float c = base + 0.28 * detail;
			float amount = smoothstep(0.30 - coverage * 0.5, 0.52 - coverage * 0.5, c);
			if (amount < 0.01) discard;
			vec3 light = vec3(0.0);
			for (int i = 0; i < 4; i++) {
				if (i >= nSuns) break;
				vec3 L = normalize(sunPos[i] - planetCenter);
				float ndl = dot(n, L);
				light += sunCol[i] * (smoothstep(-0.1, 0.35, ndl) * (0.18 + 0.82 * max(ndl, 0.0)));
			}
			vec3 col = vec3(0.92, 0.94, 0.97) * light * (1.0 - 0.25 * smoothstep(0.35, 0.8, c));
			vec3 mapped = col / (1.0 + col * 0.18);
			gl_FragColor = vec4(pow(clamp(mapped, 0.0, 1.0), vec3(1.0 / 2.2)), amount * 0.95);
		}
	`;

	/* ---- a gas giant */

	SHADERS.aceGasVertexShader = `
		precision highp float;
		attribute vec3 position;
		uniform mat4 world;
		uniform mat4 viewProjection;
		varying vec3 vWorld;
		varying vec3 vObj;
		void main(void) {
			vObj = normalize(position);
			vec4 w = world * vec4(position, 1.0);
			vWorld = w.xyz;
			gl_Position = viewProjection * w;
		}
	`;

	SHADERS.aceGasFragmentShader = `
		precision highp float;
		precision highp sampler2D;
		varying vec3 vWorld;
		varying vec3 vObj;
		uniform vec3 camPos;
		uniform vec3 planetCenter;
		uniform vec3 colour1;
		uniform vec3 colour2;
		uniform vec3 colour3;
		uniform float sharpness;
		uniform float time;
		uniform float seed;
		${SUN_UNIFORMS}
		${NOISE_GLSL}
		void main(void) {
			vec3 n = normalize(vObj);
			vec3 N = normalize(vWorld - planetCenter);
			float lat = n.y;
			// bands of latitude, bent by turbulence, with storms that drift along them
			float warpX = fbm3(vec3(lat * 3.0, n.x * 2.0 + seed, n.z * 2.0), 4);
			float bands = sin(lat * 14.0 + warpX * 4.5 + fbm3(n * 5.0 + vec3(time * 0.003, seed, 0.0), 4) * 1.4);
			float t = smoothstep(-1.0, 1.0, bands * (sharpness * 0.28));
			float t2 = smoothstep(-0.2, 0.9, sin(lat * 6.0 + warpX * 2.0 + seed));
			vec3 col = mix(mix(colour1, colour2, t), colour3, t2 * 0.55);
			col += 0.08 * fbm3(n * 24.0 + seed, 4);
			vec3 V = normalize(camPos - vWorld);
			vec3 light = vec3(0.0);
			for (int i = 0; i < 4; i++) {
				if (i >= nSuns) break;
				vec3 L = normalize(sunPos[i] - vWorld);
				float ndl = dot(N, L);
				light += sunCol[i] * (smoothstep(-0.15, 0.25, ndl) * (0.1 + 0.9 * max(ndl, 0.0)));
			}
			vec3 lit = pow(col, vec3(2.2)) * light * 1.5;
			vec3 mapped = lit / (1.0 + lit * 0.18);
			gl_FragColor = vec4(pow(clamp(mapped, 0.0, 1.0), vec3(1.0 / 2.2)), 1.0);
		}
	`;

	/* ---- rings */

	SHADERS.aceRingsVertexShader = `
		precision highp float;
		attribute vec3 position;
		attribute vec2 uv;
		uniform mat4 world;
		uniform mat4 viewProjection;
		varying vec3 vWorld;
		varying vec2 vUv;
		void main(void) {
			vec4 w = world * vec4(position, 1.0);
			vWorld = w.xyz;
			vUv = uv;
			gl_Position = viewProjection * w;
		}
	`;

	SHADERS.aceRingsFragmentShader = `
		precision highp float;
		precision highp sampler2D;
		varying vec3 vWorld;
		varying vec2 vUv;
		uniform vec3 planetCenter;
		uniform float planetRadius;
		uniform float innerRadius;
		uniform float outerRadius;
		uniform vec3 iceAlbedo;
		uniform vec3 dustAlbedo;
		uniform float seed;
		uniform float frequency;
		uniform vec3 axis;
		${SUN_UNIFORMS}
		${NOISE_GLSL}
		${RAY_SPHERE}
		void main(void) {
			float r = mix(innerRadius, outerRadius, vUv.x);
			float u = (r - innerRadius) / (outerRadius - innerRadius);
			float bands = fbm3(vec3(r / planetRadius * frequency, seed * 7.0, 0.0), 6) * 0.5 + 0.5;
			float gaps = smoothstep(0.30, 0.55, fbm3(vec3(r / planetRadius * frequency * 0.35, seed * 3.0, 4.0), 4) * 0.5 + 0.5);
			float edge = smoothstep(0.0, 0.05, u) * (1.0 - smoothstep(0.93, 1.0, u));
			float density = clamp(bands * gaps * 1.4, 0.0, 1.0) * edge;
			if (density < 0.02) discard;
			vec3 albedo = mix(dustAlbedo, iceAlbedo, bands);
			vec3 light = vec3(0.0);
			for (int i = 0; i < 4; i++) {
				if (i >= nSuns) break;
				vec3 L = normalize(sunPos[i] - vWorld);
				// the planet's shadow falls across the rings
				vec2 sh = raySphere(vWorld - planetCenter, L, planetRadius);
				float lit = (sh.x > 0.0) ? 0.0 : 1.0;
				light += sunCol[i] * (0.28 + 0.72 * abs(dot(normalize(axis), L))) * lit;
			}
			vec3 col = albedo * light * 1.4;
			vec3 mapped = col / (1.0 + col * 0.18);
			gl_FragColor = vec4(pow(clamp(mapped, 0.0, 1.0), vec3(1.0 / 2.2)), density * 0.92);
		}
	`;

	/* ---- the cube sphere */

	/* A point of face `face` at (u, v) in [-1, 1], as a direction, spread so that the squares of the cube are nearly equal on the sphere. */
	const cubeDirection = (face, u, v, out) => {

		let x, y, z;

		switch(face) {

			case 0: x = 1; y = v; z = -u; break;
			case 1: x = -1; y = v; z = u; break;
			case 2: x = u; y = 1; z = -v; break;
			case 3: x = u; y = -1; z = v; break;
			case 4: x = u; y = v; z = 1; break;
			default: x = -u; y = v; z = -1; break;
		}

		let x2 = x * x, y2 = y * y, z2 = z * z;

		out[0] = x * Math.sqrt(1 - y2 / 2 - z2 / 2 + y2 * z2 / 3);
		out[1] = y * Math.sqrt(1 - z2 / 2 - x2 / 2 + z2 * x2 / 3);
		out[2] = z * Math.sqrt(1 - x2 / 2 - y2 / 2 + x2 * y2 / 3);

		return out;
	};

	const GRID = 32;

	/* The height of the ground above the lowest ground, as a function of direction. */
	const makeHeight = (data, seed) => {

		let t = isObject(data.terrain) ? data.terrain : { };
		let continents = makeNoise(seed * 31 + 7), mountains = makeNoise(seed * 17 + 3), bumps = makeNoise(seed * 13 + 11), ridges = makeNoise(seed * 5 + 29);
		let cf = (t.continentsFrequency != null ? t.continentsFrequency : 1) * 1.4;
		let fragmentation = t.continentsFragmentation != null ? t.continentsFragmentation : 0.6;
		let base = t.continentBaseHeight != null ? t.continentBaseHeight : 0;
		let mf = (t.mountainsFrequency != null ? t.mountainsFrequency : 60) / 12;
		let bf = (t.bumpsFrequency != null ? t.bumpsFrequency : 30) / 4;
		let maxMountain = t.maxMountainHeight != null ? t.maxMountainHeight : 10e3;
		let maxBump = t.maxBumpHeight != null ? t.maxBumpHeight : 1.5e3;
		let threshold = mix(-0.55, 0.55, fragmentation);
		let ox = seed * 0.37, oy = seed * 0.61, oz = seed * 0.83;

		return (x, y, z) => {

			let c = fbm(continents, x * cf + ox, y * cf + oy, z * cf + oz, 6, 0.5) * 1.6;
			let land = smooth(threshold - 0.04, threshold + 0.16, c);
			let mountainMask = smooth(0.12, 0.7, c - threshold);
			let ridge = 1 - Math.abs(fbm(ridges, x * mf * 0.12 + oy, y * mf * 0.12 + oz, z * mf * 0.12 + ox, 4, 0.5) * 2.2);
			let rough = fbm(mountains, x * mf, y * mf, z * mf, 7, 0.52) * 0.5 + 0.5;
			let mountain = maxMountain * mountainMask * Math.pow(clamp(ridge, 0, 1), 2.2) * (0.35 + 0.65 * rough);
			let bump = maxBump * (fbm(bumps, x * bf, y * bf, z * bf, 5, 0.5) * 0.5 + 0.5) * (0.2 + 0.8 * land);

			return land * base + land * (mountain + bump) + (1 - land) * bump * 0.08;
		};
	};

	const planet = {

		type: "planet",

		onCreate: (context, instance) => {

			let scene = context.meta.scene;
			let data = instance.data;
			let name = instance.path.join(".");
			let node = H.nodeFor(context, instance.entity);
			let gas = data.kind === "gas";
			let radius = data.radius != null ? data.radius : 1e6;
			let seed = data.seed != null ? data.seed : 1;
			let ocean = isObject(data.ocean) ? data.ocean : null;
			let atmosphere = isObject(data.atmosphere) ? data.atmosphere : null;
			let seaLevel = ocean != null ? ocean.depth : 0;

			let object = {
				node, name, gas, radius, seed, seaLevel, ocean, atmosphere,
				roots: [], chunks: new Set(), height: gas ? null : makeHeight(data, seed),
				owned: [], shells: [], frame: 0, queue: 0,
				centre: new BABYLON.Vector3(), q: BABYLON.Quaternion.Identity(), tmp: [0, 0, 0],
				altitude: null
			};

			const textureOf = (url, plain) => {

				if(typeof url !== "string") {

					/* no picture named: a plain one (a flat grey; for ripples, a flat surface) */
					let bytes = plain === "flat" ? [128, 128, 255, 255] : [128, 128, 128, 255];
					let flat = new BABYLON.RawTexture(new Uint8Array(bytes), 1, 1, BABYLON.Engine.TEXTUREFORMAT_RGBA, scene, false, false, BABYLON.Texture.NEAREST_SAMPLINGMODE);

					object.owned.push(flat);

					return flat;
				}

				let texture = new BABYLON.Texture(url, scene, false, true, BABYLON.Texture.TRILINEAR_SAMPLINGMODE);

				texture.wrapU = texture.wrapV = BABYLON.Texture.WRAP_ADDRESSMODE;
				texture.anisotropicFilteringLevel = 4;
				object.owned.push(texture);

				return texture;
			};

			const shader = (key, fragment, vertex, attributes, uniforms, samplers) => {

				let material = new BABYLON.ShaderMaterial(
					name + "." + key, scene, { vertex: vertex, fragment: fragment },
					{ attributes, uniforms: ["world", "viewProjection"].concat(uniforms), samplers: samplers || [] }
				);

				object.owned.push(material);

				return material;
			};

			const SUN = ["sunPos", "sunCol", "nSuns"];

			if(gas) {

				let palette = isObject(data.palette) ? data.palette : { };
				let mesh = BABYLON.MeshBuilder.CreateSphere(name + ".body", { diameter: 2, segments: 160 }, scene);

				mesh.parent = node;
				mesh.scaling.setAll(radius);
				mesh.isPickable = false;
				mesh.alwaysSelectAsActiveMesh = true;
				H.own(mesh, instance.entityKey);

				let material = shader("body", "aceGas", "aceGas", ["position"], ["camPos", "planetCenter", "colour1", "colour2", "colour3", "sharpness", "time", "seed"].concat(SUN));
				let c = (value, fallback) => { let a = Array.isArray(value) ? value : fallback; return new BABYLON.Vector3(a[0], a[1], a[2]); };

				material.setVector3("colour1", c(palette.color1, [0.6, 0.5, 0.4]));
				material.setVector3("colour2", c(palette.color2, [0.2, 0.15, 0.1]));
				material.setVector3("colour3", c(palette.color3, [0.8, 0.7, 0.6]));
				material.setFloat("sharpness", palette.sharpness != null ? palette.sharpness : 6);
				material.setFloat("seed", (seed % 97) + 0.5);
				mesh.material = material;
				object.body = mesh;
				object.bodyMaterial = material;

			} else {

				let tex = isObject(data.textures) ? data.textures : { };
				let material = shader("surface", "aceSurface", "aceSurface", ["position", "normal", "uv"],
					["camPos", "planetCenter", "axis", "seaLevel", "warmth", "barren", "tileNear", "skyColor", "tint"].concat(SUN),
					["grassT", "rockT", "sandT", "iceT"]);

				material.backFaceCulling = false;
				material.setTexture("grassT", textureOf(tex.grass));
				material.setTexture("rockT", textureOf(tex.rock));
				material.setTexture("sandT", textureOf(tex.sand));
				material.setTexture("iceT", textureOf(tex.ice));
				material.setFloat("seaLevel", seaLevel);
				material.setFloat("warmth", data.warmth != null ? data.warmth : 0.45);
				material.setFloat("barren", atmosphere == null ? 1 : (data.barren != null ? data.barren : 0));
				material.setFloat("tileNear", data.tile != null ? data.tile : 14);
				material.setVector3("tint", H.vector(data.tint, [1, 1, 1]));
				material.setVector3("skyColor", H.vector(atmosphere != null ? atmosphere.color : null, [0.3, 0.5, 1]));
				object.surface = material;

				if(ocean != null) {

					let water = shader("ocean", "aceOcean", "aceOcean", ["position", "normal", "uv"],
						["camPos", "planetCenter", "time", "shallowColor", "deepColor", "skyColor"].concat(SUN), ["waves"]);

					water.backFaceCulling = false;
					water.disableDepthWrite = false;
					water.needAlphaBlending = () => true;
					water.setTexture("waves", textureOf(ocean.waves, "flat"));
					water.setVector3("shallowColor", H.vector(ocean.shallow, [0.05, 0.55, 0.6]));
					water.setVector3("deepColor", H.vector(ocean.deep, [0.005, 0.07, 0.2]));
					water.setVector3("skyColor", H.vector(atmosphere != null ? atmosphere.color : null, [0.3, 0.5, 1]));
					object.water = water;
				}

				/* the six faces, each a square of the cube */
				for(let face = 0; face < 6; face++)
					object.roots.push({ face, level: 0, u0: -1, u1: 1, v0: -1, v1: 1, children: null, chunk: null });
			}

			/* the shells: atmosphere, clouds */
			const sphereMesh = (key, diameter, segments) => {

				let mesh = BABYLON.MeshBuilder.CreateSphere(name + "." + key, { diameter: 2, segments }, scene);

				/* not a child of the planet: from inside, the shell is drawn small and around the view (the shader works from the ray, not the mesh), because a sphere of
				   planetary size has its far side lost to the arithmetic of the depth range */
				mesh.scaling.setAll(diameter / 2);
				mesh.isPickable = false;
				mesh.alwaysSelectAsActiveMesh = true;
				mesh.alphaIndex = 10;
				H.own(mesh, instance.entityKey);

				return mesh;
			};

			if(atmosphere != null) {

				let height = atmosphere.height != null ? atmosphere.height : radius * 0.07;
				let ground = radius + seaLevel;
				let material = shader("atmosphere", "aceAtmosphere", "aceShell", ["position"],
					["camPos", "planetCenter", "groundRadius", "atmoRadius", "scaleHeight", "rayleigh", "mieStrength", "density"].concat(SUN));

				material.backFaceCulling = true;
				material.disableDepthWrite = true;
				material.needAlphaBlending = () => true;
				material.alphaMode = BABYLON.Engine.ALPHA_PREMULTIPLIED;
				material.setFloat("groundRadius", ground);
				material.setFloat("atmoRadius", ground + height);
				material.setFloat("scaleHeight", height * 0.28);
				/* the optical depth, straight up, of each colour: the coefficient is that over the scale height */
				material.setVector3("rayleigh", H.vector(atmosphere.rayleigh, [0.12, 0.30, 0.78]).scale((atmosphere.density != null ? atmosphere.density : 1) / (height * 0.28)));
				material.setFloat("mieStrength", atmosphere.mie != null ? atmosphere.mie : 0.06);
				material.setFloat("density", 1);

				let mesh = sphereMesh("atmosphere", ground + height, 96);

				mesh.material = material;
				object.shells.push({ mesh, material, kind: "atmosphere", outer: ground + height });
			}

			if(isObject(data.clouds)) {

				let clouds = data.clouds;
				let layer = radius + seaLevel + (clouds.height != null ? clouds.height : 7e3);
				let material = shader("clouds", "aceClouds", "aceShell", ["position"],
					["camPos", "planetCenter", "cloudRadius", "spin", "coverage", "freq", "time", "seed"].concat(SUN));

				material.backFaceCulling = true;
				material.disableDepthWrite = true;
				material.needAlphaBlending = () => true;
				material.setFloat("cloudRadius", layer);
				material.setFloat("coverage", clouds.coverage != null ? clouds.coverage : 0.4);
				material.setFloat("freq", clouds.frequency != null ? clouds.frequency : 4);
				material.setFloat("seed", (seed % 53) + 0.3);

				let mesh = sphereMesh("clouds", layer, 96);

				mesh.alphaIndex = 12;
				mesh.material = material;
				object.shells.push({ mesh, material, kind: "clouds", outer: layer });
			}

			if(isObject(data.rings)) {

				let rings = data.rings;
				let inner = rings.innerRadius, outer = rings.outerRadius;
				let positions = [], uvs = [], indices = [], segments = 160;

				for(let i = 0; i <= segments; i++) {

					let a = i / segments * Math.PI * 2, c = Math.cos(a), s = Math.sin(a);

					positions.push(c * inner, 0, s * inner, c * outer, 0, s * outer);
					uvs.push(0, i / segments, 1, i / segments);

					if(i < segments) {

						let k = i * 2;

						indices.push(k, k + 1, k + 2, k + 1, k + 3, k + 2);
					}
				}

				let mesh = new BABYLON.Mesh(name + ".rings", scene);
				let vertexData = new BABYLON.VertexData();

				vertexData.positions = positions;
				vertexData.uvs = uvs;
				vertexData.indices = indices;
				vertexData.applyToMesh(mesh);
				mesh.parent = node;
				mesh.isPickable = false;
				mesh.alwaysSelectAsActiveMesh = true;
				mesh.alphaIndex = 11;

				let material = shader("rings", "aceRings", "aceRings", ["position", "uv"],
					["planetCenter", "planetRadius", "innerRadius", "outerRadius", "iceAlbedo", "dustAlbedo", "seed", "frequency", "axis"].concat(SUN));

				material.backFaceCulling = false;
				material.disableDepthWrite = true;
				material.needAlphaBlending = () => true;
				material.setFloat("planetRadius", radius);
				material.setFloat("innerRadius", inner);
				material.setFloat("outerRadius", outer);
				material.setVector3("iceAlbedo", H.vector(rings.ice, [0.93, 0.92, 0.9]));
				material.setVector3("dustAlbedo", H.vector(rings.dust, [0.45, 0.4, 0.34]));
				material.setFloat("seed", rings.seed != null ? rings.seed : 0.3);
				material.setFloat("frequency", rings.frequency != null ? rings.frequency : 10);
				mesh.material = material;
				object.rings = { mesh, material };
			}

			ace.setState(context, instance.record, { loaded: true, chunks: 0, live: 0 });

			return object;
		},

		onChange: (context, instance) => {

			planet.onDestroy(context, instance);
			instance.object = planet.onCreate(context, instance);
		},

		/* ---------------------------------------------------------------- per frame */

		onUpdate: (context, instance) => {

			let object = instance.object;
			let data = instance.data;
			let scene = context.meta.scene;
			let camera = scene.activeCamera;

			if(camera == null)
				return;

			let record = context.resolved.entities.find(entity => entity.key === instance.entityKey);
			let place = record != null && Array.isArray(record.data.position) ? record.data.position : [0, 0, 0];
			let origin = context.meta.origin != null ? context.meta.origin : [0, 0, 0];
			let seconds = context.meta.elapsed != null ? context.meta.elapsed : 0;

			/* where the planet's centre is, from the view, and which way it faces */
			let centre = object.centre;

			centre.set(place[0] - origin[0], place[1] - origin[1], place[2] - origin[2]);

			let spin = isObject(data.spin) ? data.spin : { };
			let angle = (spin.angle != null ? spin.angle : 0) + (spin.period ? seconds / spin.period * Math.PI * 2 : 0);
			let q = BABYLON.Quaternion.RotationAxis(BABYLON.Axis.Z, spin.tilt != null ? spin.tilt : 0)
				.multiply(BABYLON.Quaternion.RotationAxis(BABYLON.Axis.Y, angle));

			object.q = q;

			let axis = new BABYLON.Vector3(0, 1, 0).applyRotationQuaternion(q);
			let suns = sunsOf(context, centre);
			let eye = camera.globalPosition;
			let toCamera = eye.subtract(centre);
			let distance = toCamera.length();

			let uniforms = material => {

				material.setVector3("camPos", eye);
				material.setVector3("planetCenter", centre);
				material.setFloat("time", seconds);
				setSuns(material, suns);
			};

			/* the body is where the entity is; its node is rebased already for what is far, so only its turn is added */
			object.node.rotationQuaternion = q;

			if(object.gas) {

				uniforms(object.bodyMaterial);

			} else {

				object.surface.setVector3("axis", axis);
				uniforms(object.surface);

				if(object.water != null)
					uniforms(object.water);

				this_streaming(context, instance, object, data, centre, q, distance, toCamera, eye);
			}

			/* the shells: the face that is on the near side from outside, the far side from inside */
			object.shells.forEach(shell => {

				uniforms(shell.material);

				let outside = distance > shell.outer;

				if(outside) {

					shell.mesh.position.copyFrom(centre);
					shell.mesh.scaling.setAll(shell.outer);

				} else {

					shell.mesh.position.copyFrom(eye);
					shell.mesh.scaling.setAll(2.0e4);
				}

				shell.material.cullBackFaces = outside;
				shell.material.backFaceCulling = true;

				if(shell.kind === "clouds") {

					let inverse = new BABYLON.Matrix();

					q.toRotationMatrix(inverse);
					inverse.invert();

					let m = inverse.m;

					shell.material.setMatrix3x3("spin", new Float32Array([m[0], m[1], m[2], m[4], m[5], m[6], m[8], m[9], m[10]]));
				}
			});

			if(object.rings != null) {

				uniforms(object.rings.material);
				object.rings.material.setVector3("axis", axis);
			}

			/* where the view stands on this world: the height of the ground beneath it, the altitude above that */
			let state = { loaded: true, chunks: object.chunks.size, queued: object.queue, distance };

			if(!object.gas) {

				let local = toCamera.clone();
				let inv = q.clone();

				inv = BABYLON.Quaternion.Inverse(inv);
				local.applyRotationQuaternionInPlace(inv);

				let length = local.length();
				let dx = local.x / length, dy = local.y / length, dz = local.z / length;
				let height = object.height(dx, dy, dz);
				let surface = object.radius + Math.max(height, object.seaLevel);

				state.altitude = length - surface;
				state.height = height;
				state.surface = surface;
				state.up = [dx, dy, dz];
				state.latitude = Math.asin(clamp(dy, -1, 1));
				state.longitude = Math.atan2(dz, dx);
			} else {

				state.altitude = (centre.length()) - object.radius;
			}

			ace.setState(context, instance.record, state);
		},

		onDestroy: (context, instance) => {

			let object = instance.object;

			const dropNode = node => {

				if(node.chunk != null) {

					if(node.chunk.mesh != null) node.chunk.mesh.dispose();
					if(node.chunk.water != null) node.chunk.water.dispose();
				}

				if(node.children != null)
					node.children.forEach(dropNode);
			};

			object.roots.forEach(dropNode);
			object.shells.forEach(shell => { shell.mesh.dispose(); });

			if(object.rings != null)
				object.rings.mesh.dispose();

			if(object.body != null)
				object.body.dispose();

			object.owned.forEach(item => item.dispose());
		}
	};

	/* ---------------------------------------------------------------- the terrain, made where it is looked at */

	/* One piece of the surface: a (GRID + 1) square of heights, with skirts, as a mesh whose own origin is its middle. */
	const makeChunk = (context, object, node) => {

		let scene = context.meta.scene;
		let R = object.radius;
		let N = GRID;
		let M = N + 3;
		let dir = [0, 0, 0];
		let heights = new Float32Array(M * M);
		let px = new Float64Array(M * M), py = new Float64Array(M * M), pz = new Float64Array(M * M);
		let centreDir = cubeDirection(node.face, (node.u0 + node.u1) / 2, (node.v0 + node.v1) / 2, [0, 0, 0]);
		let cx = centreDir[0] * R, cy = centreDir[1] * R, cz = centreDir[2] * R;
		let minHeight = 1e30, maxHeight = -1e30;

		for(let b = -1; b <= N + 1; b++) {

			let v = node.v0 + (node.v1 - node.v0) * b / N;

			for(let a = -1; a <= N + 1; a++) {

				let u = node.u0 + (node.u1 - node.u0) * a / N;

				cubeDirection(node.face, u, v, dir);

				let h = object.height(dir[0], dir[1], dir[2]);
				let at = (b + 1) * M + (a + 1);

				heights[at] = h;
				px[at] = dir[0] * (R + h);
				py[at] = dir[1] * (R + h);
				pz[at] = dir[2] * (R + h);

				if(a >= 0 && a <= N && b >= 0 && b <= N) {

					if(h < minHeight) minHeight = h;
					if(h > maxHeight) maxHeight = h;
				}
			}
		}

		let count = (N + 1) * (N + 1);
		let skirtCount = 4 * (N + 1);
		let positions = new Float32Array((count + skirtCount) * 3);
		let normals = new Float32Array((count + skirtCount) * 3);
		let uvs = new Float32Array((count + skirtCount) * 2);
		let size = R * Math.PI / 2 / Math.pow(2, node.level);
		let skirt = size / N * 2.5 + 2;

		const put = (slot, a, b, drop) => {

			let at = (b + 1) * M + (a + 1);
			let x = px[at], y = py[at], z = pz[at];
			let l = Math.sqrt(x * x + y * y + z * z);

			positions[slot * 3] = x - cx - x / l * drop;
			positions[slot * 3 + 1] = y - cy - y / l * drop;
			positions[slot * 3 + 2] = z - cz - z / l * drop;

			let ax = px[at + 1] - px[at - 1], ay = py[at + 1] - py[at - 1], az = pz[at + 1] - pz[at - 1];
			let bx = px[at + M] - px[at - M], by = py[at + M] - py[at - M], bz = pz[at + M] - pz[at - M];
			let nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
			let nl = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;

			/* outward: the way the position points */
			let sign = (nx * x + ny * y + nz * z) < 0 ? -1 : 1;

			normals[slot * 3] = sign * nx / nl;
			normals[slot * 3 + 1] = sign * ny / nl;
			normals[slot * 3 + 2] = sign * nz / nl;
			uvs[slot * 2] = heights[at];
			uvs[slot * 2 + 1] = 0;
		};

		for(let b = 0; b <= N; b++)
			for(let a = 0; a <= N; a++)
				put(b * (N + 1) + a, a, b, 0);

		let indices = [];

		for(let b = 0; b < N; b++) {

			for(let a = 0; a < N; a++) {

				let i0 = b * (N + 1) + a, i1 = i0 + 1, i2 = i0 + N + 1, i3 = i2 + 1;

				indices.push(i0, i1, i2, i1, i3, i2);
			}
		}

		let slot = count;
		const skirtEdge = (aOf, bOf) => {

			let start = slot;

			for(let k = 0; k <= N; k++)
				put(slot++, aOf(k), bOf(k), skirt);

			for(let k = 0; k < N; k++) {

				let top = bOf(k) * (N + 1) + aOf(k), topNext = bOf(k + 1) * (N + 1) + aOf(k + 1);

				indices.push(top, start + k, topNext, topNext, start + k, start + k + 1);
			}
		};

		skirtEdge(k => k, () => 0);
		skirtEdge(k => k, () => N);
		skirtEdge(() => 0, k => k);
		skirtEdge(() => N, k => k);

		let mesh = new BABYLON.Mesh(object.name + ".chunk", scene);
		let vertexData = new BABYLON.VertexData();

		vertexData.positions = positions;
		vertexData.normals = normals;
		vertexData.uvs = uvs;
		vertexData.indices = indices;
		vertexData.applyToMesh(mesh, false);
		mesh.material = object.surface;
		mesh.isPickable = false;
		mesh.receiveShadows = false;
		mesh.rotationQuaternion = BABYLON.Quaternion.Identity();

		let chunk = { mesh, water: null, centre: [cx, cy, cz], size, minHeight, maxHeight, face: node.face, level: node.level };

		/* an ocean where the ground dips below the surface of the sea */
		if(object.ocean != null && minHeight < object.seaLevel + 30) {

			let waterPositions = new Float32Array(count * 3), waterNormals = new Float32Array(count * 3), waterUvs = new Float32Array(count * 2);
			let level = R + object.seaLevel;
			let wn = 16, stride = N / wn;
			let wcount = (wn + 1) * (wn + 1);

			waterPositions = new Float32Array(wcount * 3);
			waterNormals = new Float32Array(wcount * 3);
			waterUvs = new Float32Array(wcount * 2);

			let wi = 0;

			for(let b = 0; b <= wn; b++) {

				let v = node.v0 + (node.v1 - node.v0) * b / wn;

				for(let a = 0; a <= wn; a++) {

					let u = node.u0 + (node.u1 - node.u0) * a / wn;

					cubeDirection(node.face, u, v, dir);
					waterPositions[wi * 3] = dir[0] * level - cx;
					waterPositions[wi * 3 + 1] = dir[1] * level - cy;
					waterPositions[wi * 3 + 2] = dir[2] * level - cz;
					waterNormals[wi * 3] = dir[0];
					waterNormals[wi * 3 + 1] = dir[1];
					waterNormals[wi * 3 + 2] = dir[2];

					/* how deep the water is: the height of the sea above the ground beneath, at the nearest sample */
					let ga = Math.min(N, Math.round(a * stride)), gb = Math.min(N, Math.round(b * stride));

					waterUvs[wi * 2] = object.seaLevel - heights[(gb + 1) * M + (ga + 1)];
					wi++;
				}
			}

			let waterIndices = [];

			for(let b = 0; b < wn; b++) {

				for(let a = 0; a < wn; a++) {

					let i0 = b * (wn + 1) + a, i1 = i0 + 1, i2 = i0 + wn + 1, i3 = i2 + 1;

					waterIndices.push(i0, i1, i2, i1, i3, i2);
				}
			}

			let water = new BABYLON.Mesh(object.name + ".sea", scene);
			let data = new BABYLON.VertexData();

			data.positions = waterPositions;
			data.normals = waterNormals;
			data.uvs = waterUvs;
			data.indices = waterIndices;
			data.applyToMesh(water, false);
			water.material = object.water;
			water.isPickable = false;
			water.alphaIndex = 3;
			water.rotationQuaternion = BABYLON.Quaternion.Identity();
			chunk.water = water;
		}

		return chunk;
	};

	/* The tree of pieces is walked each frame, and split or joined as the view moves. */
	const this_streaming = (context, instance, object, data, centre, q, distance, toCamera, eye) => {

		object.frame++;

		let R = object.radius;
		let maxLevel = data.maxLevel != null ? data.maxLevel : 15;
		let splitFactor = data.detail != null ? data.detail : 2.4;
		let started = now();
		let budget = object.frame < 30 ? 22 : 9;
		let built = 0;
		let inverse = BABYLON.Quaternion.Inverse(q);

		/* the camera in the planet's own frame (a rotation, no translation: the planet is at the origin of it) */
		let cam;

		cam = new BABYLON.Vector3(toCamera.x, toCamera.y, toCamera.z).applyRotationQuaternion(inverse);

		let camLength = cam.length();
		let reachHeight = R + (data.terrain && data.terrain.maxMountainHeight ? data.terrain.maxMountainHeight : 1e4) + 3000;
		let horizon = camLength > reachHeight ? Math.acos(reachHeight / camLength) : Math.PI;
		let camDir = cam.clone().scale(1 / (camLength || 1));
		let dir = [0, 0, 0];
		let shown = new Set();
		let queued = 0;

		const nodeCentre = node => cubeDirection(node.face, (node.u0 + node.u1) / 2, (node.v0 + node.v1) / 2, [0, 0, 0]);

		const visit = node => {

			let n = nodeCentre(node);
			let size = R * Math.PI / 2 / Math.pow(2, node.level);
			let angular = size * 0.9 / R;
			let across = Math.acos(clamp(n[0] * camDir.x + n[1] * camDir.y + n[2] * camDir.z, -1, 1));
			let hidden = across - angular > horizon;

			let dx = n[0] * R - cam.x, dy = n[1] * R - cam.y, dz = n[2] * R - cam.z;
			let range = Math.sqrt(dx * dx + dy * dy + dz * dz);
			let wantSplit = !hidden && node.level < maxLevel && range < size * splitFactor + size * 0.4;

			if(wantSplit) {

				if(node.children == null) {

					/* the four are made together or not at all, so that no frame shows a gap */
					if(built > 0 && now() - started > budget) {

						queued++;
						wantSplit = false;

					} else {

						let mu = (node.u0 + node.u1) / 2, mv = (node.v0 + node.v1) / 2;
						let kids = [[node.u0, mu, node.v0, mv], [mu, node.u1, node.v0, mv], [node.u0, mu, mv, node.v1], [mu, node.u1, mv, node.v1]].map(
							box => ({ face: node.face, level: node.level + 1, u0: box[0], u1: box[1], v0: box[2], v1: box[3], children: null, chunk: null })
						);

						kids.forEach(kid => { kid.chunk = makeChunk(context, object, kid); object.chunks.add(kid.chunk); });
						built += 4;
						node.children = kids;

						if(node.chunk != null) {

							node.chunk.mesh.dispose();

							if(node.chunk.water != null)
								node.chunk.water.dispose();

							object.chunks.delete(node.chunk);
							node.chunk = null;
						}
					}
				}

				if(node.children != null) {

					node.children.forEach(visit);

					return;
				}
			}

			if(!wantSplit && node.children != null) {

				/* joined again: the piece itself is made before the four are let go */
				if(node.chunk == null) {

					if(built > 0 && now() - started > budget) {

						queued++;
						node.children.forEach(visit);

						return;
					}

					node.chunk = makeChunk(context, object, node);
					object.chunks.add(node.chunk);
					built++;
				}

				const release = child => {

					if(child.children != null)
						child.children.forEach(release);

					if(child.chunk != null) {

						child.chunk.mesh.dispose();

						if(child.chunk.water != null)
							child.chunk.water.dispose();

						object.chunks.delete(child.chunk);
						child.chunk = null;
					}
				};

				node.children.forEach(release);
				node.children = null;
			}

			if(node.chunk == null) {

				if(built > 0 && now() - started > budget) {

					queued++;

					return;
				}

				node.chunk = makeChunk(context, object, node);
				object.chunks.add(node.chunk);
				built++;
			}

			node.chunk.hidden = hidden;
			shown.add(node.chunk);
		};

		object.roots.forEach(visit);
		object.queue = queued;

		/* every piece is put where it is relative to the view, with the arithmetic done in numbers that have room for it */
		let local = [0, 0, 0];

		object.chunks.forEach(chunk => {

			let visible = shown.has(chunk) && chunk.hidden !== true;
			let v = new BABYLON.Vector3(chunk.centre[0], chunk.centre[1], chunk.centre[2]).applyRotationQuaternion(q);

			chunk.mesh.position.set(centre.x + v.x, centre.y + v.y, centre.z + v.z);
			chunk.mesh.rotationQuaternion = q;
			chunk.mesh.setEnabled(visible);

			if(chunk.water != null) {

				chunk.water.position.copyFrom(chunk.mesh.position);
				chunk.water.rotationQuaternion = q;
				chunk.water.setEnabled(visible);
			}
		});

		void local; void dir;
	};

	ace.register([starfield, star, planet]);

	};

	if(root.ace.adapter != null)
		extension();
	else
		(root.ace.deferred = root.ace.deferred || []).push(extension);

})(typeof globalThis !== "undefined" ? globalThis : this);
