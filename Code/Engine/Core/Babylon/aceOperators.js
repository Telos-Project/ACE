/*

	ACE - Babylon.js adapter.

	Implements the component standard against Babylon.js. Every engine-specific
	assumption lives here; ace.js remains portable.

	Loads in a browser after ace.js and babylon.js, or in Node via require.

*/

(function(root, factory) {

	let ace = typeof module === "object" && module.exports != null ?
		require("./ace.js") : root.ace;

	let BABYLON = typeof module === "object" && module.exports != null ?
		require("babylonjs") : root.BABYLON;

	let adapter = factory(ace, BABYLON, root);

	if(typeof module === "object" && module.exports != null)
		module.exports = adapter;

	root.aceBabylon = adapter;

})(typeof globalThis !== "undefined" ? globalThis : this, function(ace, BABYLON, root) {

	const hasDOM = typeof root.document !== "undefined" && root.document != null;

	const isObject = value =>
		value != null && typeof value === "object" && !Array.isArray(value);

	// ------------------------------------------------------------ conversions

	const vector = (value, fallback) => {

		if(!Array.isArray(value))
			return fallback != null ?
				new BABYLON.Vector3(...fallback) : new BABYLON.Vector3(0, 0, 0);

		return new BABYLON.Vector3(
			value[0] != null ? value[0] : 0,
			value[1] != null ? value[1] : 0,
			value[2] != null ? value[2] : 0
		);
	};

	const quaternion = value => {

		if(Array.isArray(value) && value.length >= 4) {

			return new BABYLON.Quaternion(
				value[0], value[1], value[2], value[3]
			);
		}

		if(Array.isArray(value)) {

			return BABYLON.Quaternion.RotationYawPitchRoll(
				value[1] != null ? value[1] : 0,
				value[0] != null ? value[0] : 0,
				value[2] != null ? value[2] : 0
			);
		}

		return BABYLON.Quaternion.Identity();
	};

	const scale = value => {

		if(typeof value === "number")
			return new BABYLON.Vector3(value, value, value);

		return vector(value, [1, 1, 1]);
	};

	/*

		Standard section 2.2.3: a color is a 3 or 4 element array of linear
		floats, or an sRGB hex string. Both forms are accepted everywhere.

	*/
	const color = (value, fallback) => {

		if(typeof value === "string" && value.startsWith("#")) {

			let hex = value.slice(1);

			if(hex.length === 3) {

				hex = hex.split("").map(character =>
					character + character
				).join("");
			}

			let channels = [];

			for(let index = 0; index < hex.length; index += 2)
				channels.push(parseInt(hex.substr(index, 2), 16) / 255);

			return new BABYLON.Color4(
				channels[0], channels[1], channels[2],
				channels[3] != null ? channels[3] : 1
			);
		}

		if(Array.isArray(value)) {

			return new BABYLON.Color4(
				value[0] != null ? value[0] : 0,
				value[1] != null ? value[1] : 0,
				value[2] != null ? value[2] : 0,
				value[3] != null ? value[3] : 1
			);
		}

		return fallback != null ?
			color(fallback) : new BABYLON.Color4(0, 0, 0, 1);
	};

	const color3 = (value, fallback) => {

		let result = color(value, fallback);

		return new BABYLON.Color3(result.r, result.g, result.b);
	};

	const array3 = value => [value.x, value.y, value.z];
	const array4 = value => [value.x, value.y, value.z, value.w];

	// --------------------------------------------------------------- entities

	/*

		Entities are packages, so their transform nodes are created lazily by
		whichever component needs them first. This avoids any dependency on the
		order in which components are reconciled.

	*/
	const nodeFor = (context, path) => {

		let key = ace.pathKey(path);
		let nodes = context.meta.nodes;

		if(nodes[key] != null)
			return nodes[key];

		let node = new BABYLON.TransformNode(
			path.join("."), context.meta.scene
		);

		node.rotationQuaternion = BABYLON.Quaternion.Identity();

		nodes[key] = node;

		if(path.length > 1)
			node.parent = nodeFor(context, path.slice(0, path.length - 1));

		/*

			The authored transform is applied at birth rather than waiting for
			onReflect. Components created in the same frame — physics impostors
			above all — are built from this node's world matrix, and would
			otherwise be placed at the origin for their first frame.

		*/
		let record = context.resolved.entities.find(
			candidate => candidate.key === key
		);

		if(record != null) {

			let data = record.data;

			if(Array.isArray(data.position))
				node.position = vector(data.position);

			if(data.rotation != null)
				node.rotationQuaternion = quaternion(data.rotation);

			if(data.scale != null)
				node.scaling = scale(data.scale);

			node.computeWorldMatrix(true);
		}

		return node;
	};

	/*

		A mesh carrying a body is lifted out of its entity's transform node, so
		parent-walking cannot recover which entity it belongs to. Ownership is
		recorded on the mesh itself instead, which survives reparenting.

	*/
	const own = (mesh, entityKey) => {

		if(mesh == null)
			return mesh;

		[mesh].concat(
			mesh.getChildMeshes != null ? mesh.getChildMeshes() : []
		).forEach(target => {

			target.metadata = Object.assign(
				target.metadata != null ? target.metadata : { },
				{ aceEntity: entityKey }
			);
		});

		return mesh;
	};

	/*

		A shadow generator casts nothing until it is told what to cast. Meshes
		and lights arrive in either order, so both ends register: a new mesh
		joins every generator, and a new generator collects every mesh.

	*/
	const shadows = (context, mesh) => {

		if(mesh == null || context.meta.scene.lights == null)
			return;

		let casters = [mesh].concat(
			mesh.getChildMeshes != null ? mesh.getChildMeshes() : []
		).filter(target => target.getTotalVertices != null);

		context.meta.scene.lights.forEach(light => {

			let generator = light.getShadowGenerator != null ?
				light.getShadowGenerator() : null;

			if(generator == null || generator.addShadowCaster == null)
				return;

			casters.forEach(target => generator.addShadowCaster(target, false));
		});
	};

	const collectShadowCasters = (context, generator) => {

		Object.values(context.instances).filter(
			instance => instance.type === "mesh" || instance.type === "text"
		).forEach(instance => {

			let mesh = instance.object.mesh;

			if(mesh == null || instance.record?.data?.shadow?.cast === false)
				return;

			[mesh].concat(
				mesh.getChildMeshes != null ? mesh.getChildMeshes() : []
			).filter(
				target => target.getTotalVertices != null
			).forEach(target => generator.addShadowCaster(target, false));
		});
	};

	const recordFor = (context, entityKey, type) =>
		context.resolved.components.find(record =>
			record.type === type && record.entityKey === entityKey
		);

	const siblingInstance = (context, instance, type) => {

		let record = recordFor(context, instance.entityKey, type);

		return record != null ?
			context.instances[ace.identity(record)] : null;
	};

	/*

		Beginning playback needs an audio engine, and a host may not have built
		one by the time a document is first resolved. Absence is therefore a
		condition to wait on rather than a permanent failure: the state reports
		why nothing is playing, and clears itself if an engine turns up.

	*/
	const beginAudio = (context, instance, object) => {

		if(object.started || object.disposed)
			return;

		let data = instance.data;

		let sources = (
			Array.isArray(instance.source) ?
				instance.source : [instance.source]
		).filter(candidate => typeof candidate === "string");

		if(sources.length === 0) {

			object.started = true;

			ace.setState(context, instance.record, {
				loaded: false,
				playing: false,
				error: "audio has no source"
			});

			return;
		}

		if(BABYLON.Sound == null || audioEngine() == null) {

			ace.setState(context, instance.record, {
				loaded: false,
				playing: false,
				blocked: true,
				error: "no audio engine is available"
			});

			return;
		}

		object.started = true;

		ace.setState(context, instance.record, {
			loaded: false,
			playing: false,
			error: null
		});

		/*

			Babylon accepts a list of locations but chooses between them on file
			extension, not on whether they can be reached, so it never falls
			back from a location that fails. Fetching the data here gives the
			list the meaning APInt 2.1.2 assigns it, and turns a failure into a
			reported error rather than silence.

		*/
		const attempt = index => {

			if(object.disposed)
				return;

			if(index >= sources.length) {

				ace.setState(context, instance.record, {
					loaded: false,
					playing: false,
					error: "all sources failed"
				});

				return;
			}

			let source = sources[index];

			Promise.resolve(fetch(source)).then(response => {

				if(!response.ok)
					throw new Error("HTTP " + response.status);

				return response.arrayBuffer();

			}).then(buffer => {

				if(object.disposed)
					return;

				object.sound = new BABYLON.Sound(
					instance.path.join("."),
					buffer,
					context.meta.scene,
					() => {

						ace.setState(context, instance.record, {
							loaded: true,
							source,
							duration: object.sound.getAudioBuffer?.()?.duration
						});
					},
					{
						loop: data.loop === true,
						autoplay: data.autoplay === true,
						volume: data.volume != null ? data.volume : 1,
						spatialSound: data.spatial === true,
						maxDistance: Array.isArray(data.distance) ?
							data.distance[1] : 100
					}
				);

				if(data.spatial === true)
					object.sound.attachToMesh(nodeFor(context, instance.entity));

			}).catch(() => attempt(index + 1));
		};

		attempt(0);
	};

	/*

		Resolves a texture reference — an APInt element path — to the live
		Babylon texture, or null while it is still pending.

	*/
	const resolveTexture = (context, path) => {

		let element = ace.getElement(context.data, path);

		if(element == null)
			return null;

		let record = context.resolved.components.find(
			candidate => candidate.key === ace.pathKey(element.path)
		);

		let instance = record != null ?
			context.instances[ace.identity(record)] : null;

		return instance != null && instance.object != null ?
			instance.object.texture : null;
	};

	/*

		The entity node the active camera hangs off. Camera-space entities are
		parented to it rather than to the camera, so that they inherit the
		document's forward axis rather than Babylon's.

	*/
	const viewNode = context => {

		let active = context.meta.scene.activeCamera;

		if(active == null)
			return null;

		let record = context.resolved.components.find(candidate => {

			let object = context.instances[ace.identity(candidate)]?.object;

			if(candidate.type !== "camera" || object == null)
				return false;

			/* In a session Babylon renders through its own camera instead. */
			return object.camera === active ||
				object.xr?.baseExperience?.camera === active;
		});

		return record != null ? context.meta.nodes[record.entityKey] : null;
	};

	/*

		How much of a mesh, and of every mesh under it, can be seen. A mesh's own
		visibility is not enough: a PBR material loaded with a model is opaque, and
		does not draw translucent for it. The material is told as well, and put
		back exactly as it was when the mesh is whole again. Depth is still written
		while translucent, so that a body does not show its own far side through
		its near one.

	*/
	const fade = (meshes, value) => {

		meshes.forEach(target => {

			if(target.visibility !== undefined)
				target.visibility = value;

			let material = target.material;

			if(material == null || material.alpha === undefined)
				return;

			if(material.__aceFade === undefined) {

				material.__aceFade = {
					mode: material.transparencyMode,
					depth: material.forceDepthWrite
				};
			}

			if(value < 1) {

				material.alpha = value;

				if(material.transparencyMode !== undefined)
					material.transparencyMode = BABYLON.Material.MATERIAL_ALPHABLEND;

				material.forceDepthWrite = true;

				/*

					A PBR material adds its specular and its reflection of the
					environment on top of its alpha, so that glass still shines.
					A body that is fading out is not glass: left on, the shine
					is all that remains of it, and over a bright sea or sky it
					turns white instead of clear.

				*/
				if(material.useRadianceOverAlpha !== undefined) {

					material.useRadianceOverAlpha = false;
					material.useSpecularOverAlpha = false;
				}

			} else {

				if(material.useRadianceOverAlpha !== undefined) {

					material.useRadianceOverAlpha = true;
					material.useSpecularOverAlpha = true;
				}

				material.alpha = 1;
				material.transparencyMode = material.__aceFade.mode;
				material.forceDepthWrite = material.__aceFade.depth;
			}
		});
	};

	/*

		The finish: what is done to the picture after it is drawn. A pipeline
		for bloom (the glow round anything much brighter than its surroundings)
		and edge smoothing, then one pass of grading: a filmic tone curve in
		place of a hard clip, shadows leaning cool and highlights warm, a little
		more colour, a slight vignette, a touch of grain. It is stated in
		`world.post.finish`, applies to whatever camera is active, and is made
		again if the camera is replaced.

		Everything in the scene is drawn in display colours, so the pass takes
		them to linear light, shapes them, and brings them back.

	*/
	const GRADE_FRAGMENT = `
		precision highp float;
		varying vec2 vUV;
		uniform sampler2D textureSampler;
		uniform vec3 g1;
		uniform vec3 g2;
		uniform vec3 shadowTint;
		uniform vec3 highlightTint;
		uniform vec2 texel;

		vec3 aces(vec3 x) {
			return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
		}

		float hash(vec2 p) {
			return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
		}

		void main(void) {
			vec3 c = texture2D(textureSampler, vUV).rgb;

			// a little sharpening, from the four neighbours
			vec3 blur = (texture2D(textureSampler, vUV + vec2(texel.x, 0.0)).rgb + texture2D(textureSampler, vUV - vec2(texel.x, 0.0)).rgb +
				texture2D(textureSampler, vUV + vec2(0.0, texel.y)).rgb + texture2D(textureSampler, vUV - vec2(0.0, texel.y)).rgb) * 0.25;
			c = clamp(c + (c - blur) * g2.z, 0.0, 1.0);

			vec3 lin = pow(c, vec3(2.2)) * g1.x;
			vec3 d = pow(aces(lin), vec3(1.0 / 2.2));

			float l = dot(d, vec3(0.299, 0.587, 0.114));
			d *= mix(shadowTint, highlightTint, smoothstep(0.12, 0.85, l));
			d = mix(vec3(l), d, g1.y);
			d = (d - 0.5) * g1.z + 0.5;

			vec2 q = vUV - 0.5;
			d *= 1.0 - dot(q, q) * g2.x * 2.2;
			d += (hash(vUV * 1000.0 + fract(g2.y)) - 0.5) * 0.02 * step(0.001, g2.x);

			gl_FragColor = vec4(clamp(d, 0.0, 1.0), 1.0);
		}
	`;

	const finishing = (context, instance) => {

		let scene = context.meta.scene;
		let camera = scene.activeCamera;
		let spec = instance.data.post != null ? instance.data.post.finish : null;
		let state = context.meta.finish;

		/*

			Not inside a headset session: the pipeline is built on the
			session's own cameras and the output is the session's framebuffer,
			where a full-resolution chain of passes is both the most expensive
			thing in the frame and, as a render target of the wrong size, a
			source of GL errors. The finish returns when the session ends.

		*/
		let inSession = context.meta.xr != null && context.meta.xr.baseExperience != null &&
			context.meta.xr.baseExperience.state === BABYLON.WebXRState.IN_XR;

		if(inSession)
			spec = null;

		let signature = JSON.stringify(spec);

		if(state != null && state.camera === camera && state.signature === signature)
			return;

		if(state != null) {

			if(state.pipeline != null)
				state.pipeline.dispose();

			if(state.grade != null)
				state.grade.dispose();

			context.meta.finish = null;
		}

		if(camera == null || !isObject(spec) || !hasDOM)
			return;

		let pipeline = null;

		if(isObject(spec.bloom) || spec.fxaa === true) {

			pipeline = new BABYLON.DefaultRenderingPipeline(
				"aceFinish", false, scene, [camera]
			);

			pipeline.imageProcessingEnabled = false;
			pipeline.fxaaEnabled = spec.fxaa === true;

			if(isObject(spec.bloom)) {

				pipeline.bloomEnabled = true;
				pipeline.bloomThreshold = spec.bloom.threshold != null ? spec.bloom.threshold : 0.85;
				pipeline.bloomWeight = spec.bloom.weight != null ? spec.bloom.weight : 0.3;
				pipeline.bloomKernel = spec.bloom.kernel != null ? spec.bloom.kernel : 64;
				pipeline.bloomScale = spec.bloom.scale != null ? spec.bloom.scale : 0.5;
			}
		}

		let grade = null;

		if(isObject(spec.grade)) {

			let g = spec.grade;

			if(BABYLON.Effect.ShadersStore.aceGradePixelShader == null)
				BABYLON.Effect.ShadersStore.aceGradePixelShader = GRADE_FRAGMENT;

			grade = new BABYLON.PostProcess(
				"aceGrade", "aceGrade",
				["g1", "g2", "shadowTint", "highlightTint", "texel"], null, 1.0, camera
			);

			grade.onApply = effect => {

				effect.setFloat3("g1",
					g.exposure != null ? g.exposure : 1.1,
					g.saturation != null ? g.saturation : 1.1,
					g.contrast != null ? g.contrast : 1.05
				);

				effect.setFloat3("g2",
					g.vignette != null ? g.vignette : 0.2,
					(root.performance.now() % 1000) / 1000,
					g.sharpen != null ? g.sharpen : 0.35
				);

				let shadows = Array.isArray(g.shadows) ? g.shadows : [0.93, 1, 1.05];
				let highlights = Array.isArray(g.highlights) ? g.highlights : [1.05, 1, 0.94];

				effect.setFloat3("shadowTint", shadows[0], shadows[1], shadows[2]);
				effect.setFloat3("highlightTint", highlights[0], highlights[1], highlights[2]);
				effect.setFloat2("texel", 1 / grade.width, 1 / grade.height);
			};
		}

		context.meta.finish = { camera, pipeline, grade, signature };
	};

	/*

		Precise contact. A bounding box says a building is a block; a body
		walking into one needs to find the doorway. For a still mesh (not
		skinned, not drawn as instances) the triangles are taken into world space
		once and sorted into a grid of cells, and a query for what is within a
		radius of a point looks only at the triangles in the cells it touches and
		answers with the nearest point on the nearest of them. The table is made
		again if the mesh has moved.

	*/
	const PRECISE_CELL = 6;

	const preciseTable = mesh => {

		let world = mesh.getWorldMatrix().m;
		let signature = world.join(",");
		let table = mesh.__acePrecise;

		if(table != null && table.signature === signature)
			return table;

		let source = mesh.getVerticesData(BABYLON.VertexBuffer.PositionKind);
		let indices = mesh.getIndices();

		if(source == null || indices == null)
			return null;

		let count = source.length / 3;
		let positions = new Float32Array(source.length);

		for(let index = 0; index < count; index++) {

			let x = source[index * 3], y = source[index * 3 + 1], z = source[index * 3 + 2];

			positions[index * 3] = x * world[0] + y * world[4] + z * world[8] + world[12];
			positions[index * 3 + 1] = x * world[1] + y * world[5] + z * world[9] + world[13];
			positions[index * 3 + 2] = x * world[2] + y * world[6] + z * world[10] + world[14];
		}

		let cells = new Map();

		for(let tri = 0; tri < indices.length; tri += 3) {

			let a = indices[tri] * 3, b = indices[tri + 1] * 3, c = indices[tri + 2] * 3;
			let lo = [0, 0, 0], hi = [0, 0, 0];

			for(let axis = 0; axis < 3; axis++) {

				let p = positions[a + axis], q = positions[b + axis], r = positions[c + axis];

				lo[axis] = Math.floor(Math.min(p, q, r) / PRECISE_CELL);
				hi[axis] = Math.floor(Math.max(p, q, r) / PRECISE_CELL);
			}

			for(let i = lo[0]; i <= hi[0]; i++) {

				for(let j = lo[1]; j <= hi[1]; j++) {

					for(let k = lo[2]; k <= hi[2]; k++) {

						let key = i + "," + j + "," + k;
						let list = cells.get(key);

						if(list == null)
							cells.set(key, list = []);

						list.push(tri);
					}
				}
			}
		}

		return mesh.__acePrecise = {
			signature, positions, indices, cells,
			seen: new Int32Array(Math.ceil(indices.length / 3) + 1), stamp: 0
		};
	};

	/* The point of triangle abc nearest to p (Ericson, Real-Time Collision Detection 5.1.5). */
	const nearestOnTriangle = (p, a, b, c, out) => {

		let abx = b[0] - a[0], aby = b[1] - a[1], abz = b[2] - a[2];
		let acx = c[0] - a[0], acy = c[1] - a[1], acz = c[2] - a[2];
		let apx = p[0] - a[0], apy = p[1] - a[1], apz = p[2] - a[2];
		let d1 = abx * apx + aby * apy + abz * apz, d2 = acx * apx + acy * apy + acz * apz;

		const put = (x, y, z) => { out[0] = x; out[1] = y; out[2] = z; return out; };

		if(d1 <= 0 && d2 <= 0)
			return put(a[0], a[1], a[2]);

		let bpx = p[0] - b[0], bpy = p[1] - b[1], bpz = p[2] - b[2];
		let d3 = abx * bpx + aby * bpy + abz * bpz, d4 = acx * bpx + acy * bpy + acz * bpz;

		if(d3 >= 0 && d4 <= d3)
			return put(b[0], b[1], b[2]);

		let vc = d1 * d4 - d3 * d2;

		if(vc <= 0 && d1 >= 0 && d3 <= 0) {

			let v = d1 / (d1 - d3);

			return put(a[0] + abx * v, a[1] + aby * v, a[2] + abz * v);
		}

		let cpx = p[0] - c[0], cpy = p[1] - c[1], cpz = p[2] - c[2];
		let d5 = abx * cpx + aby * cpy + abz * cpz, d6 = acx * cpx + acy * cpy + acz * cpz;

		if(d6 >= 0 && d5 <= d6)
			return put(c[0], c[1], c[2]);

		let vb = d5 * d2 - d1 * d6;

		if(vb <= 0 && d2 >= 0 && d6 <= 0) {

			let w = d2 / (d2 - d6);

			return put(a[0] + acx * w, a[1] + acy * w, a[2] + acz * w);
		}

		let va = d3 * d6 - d5 * d4;

		if(va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {

			let w = (d4 - d3) / ((d4 - d3) + (d5 - d6));

			return put(b[0] + (c[0] - b[0]) * w, b[1] + (c[1] - b[1]) * w, b[2] + (c[2] - b[2]) * w);
		}

		let denominator = 1 / (va + vb + vc);
		let v = vb * denominator, w = vc * denominator;

		return put(a[0] + abx * v + acx * w, a[1] + aby * v + acy * w, a[2] + abz * v + acz * w);
	};

	/* Whether a mesh can answer precisely, and if so the nearest point of it within `radius` of `centre`: { point, distance } or null. */
	const preciseCapable = mesh =>
		mesh.skeleton == null && !(mesh.thinInstanceCount > 0) &&
		mesh.getTotalIndices != null && mesh.getTotalIndices() > 0 &&
		mesh.getTotalIndices() <= 1200000;

	const preciseNearest = (mesh, centre, radius) => {

		let table = preciseTable(mesh);

		if(table == null)
			return null;

		let { positions, indices, cells } = table;
		let p = [centre.x, centre.y, centre.z];
		let lo = p.map(v => Math.floor((v - radius) / PRECISE_CELL));
		let hi = p.map(v => Math.floor((v + radius) / PRECISE_CELL));
		let best = null, bestSquared = radius * radius;
		let a = [0, 0, 0], b = [0, 0, 0], c = [0, 0, 0], q = [0, 0, 0];

		table.stamp++;

		for(let i = lo[0]; i <= hi[0]; i++) {

			for(let j = lo[1]; j <= hi[1]; j++) {

				for(let k = lo[2]; k <= hi[2]; k++) {

					let list = cells.get(i + "," + j + "," + k);

					if(list == null)
						continue;

					for(let n = 0; n < list.length; n++) {

						let tri = list[n], id = tri / 3;

						if(table.seen[id] === table.stamp)
							continue;

						table.seen[id] = table.stamp;

						for(let axis = 0; axis < 3; axis++) {

							a[axis] = positions[indices[tri] * 3 + axis];
							b[axis] = positions[indices[tri + 1] * 3 + axis];
							c[axis] = positions[indices[tri + 2] * 3 + axis];
						}

						nearestOnTriangle(p, a, b, c, q);

						let dx = p[0] - q[0], dy = p[1] - q[1], dz = p[2] - q[2];
						let squared = dx * dx + dy * dy + dz * dz;

						if(squared <= bestSquared) {

							bestSquared = squared;
							best = { point: q.slice(), distance: Math.sqrt(squared) };
						}
					}
				}
			}
		}

		return best;
	};

	/* Babylon exposes the audio engine statically, on different classes by version. */
	const audioEngine = () =>
		BABYLON.Engine?.audioEngine != null ? BABYLON.Engine.audioEngine :
		BABYLON.AbstractEngine?.audioEngine != null ?
			BABYLON.AbstractEngine.audioEngine : null;

	/*

		Browsers start an audio context suspended and will not resume it except
		from inside a user gesture. Babylon's own remedy is to inject a button
		over the rendering surface, which is precisely the kind of overlay that
		swallows the events a document needs, so it is turned off and the
		unlocking is done here instead.

	*/
	const unlockAudio = () => {

		let engine = audioEngine();

		if(engine == null || engine.unlocked)
			return;

		engine.useCustomUnlockedButton = true;

		if(typeof engine.unlock === "function")
			engine.unlock();
	};

	// ---------------------------------------------------------------- physics

	/*

		Babylon V1 physics fuses collision shape and body dynamics into a single
		impostor, while the standard separates collider from body. The collider
		operator therefore owns the impostor and reads dynamics from the sibling
		body record; both operators route rebuilds through here so the two stay
		consistent without either reaching into the other's instance.

	*/
	const SHAPES = () => ({
		box: BABYLON.PhysicsImpostor.BoxImpostor,
		sphere: BABYLON.PhysicsImpostor.SphereImpostor,
		capsule: BABYLON.PhysicsImpostor.CapsuleImpostor != null ?
			BABYLON.PhysicsImpostor.CapsuleImpostor :
			BABYLON.PhysicsImpostor.CylinderImpostor,
		cylinder: BABYLON.PhysicsImpostor.CylinderImpostor,
		plane: BABYLON.PhysicsImpostor.PlaneImpostor,
		convex: BABYLON.PhysicsImpostor.ConvexHullImpostor != null ?
			BABYLON.PhysicsImpostor.ConvexHullImpostor :
			BABYLON.PhysicsImpostor.MeshImpostor,
		mesh: BABYLON.PhysicsImpostor.MeshImpostor,
		heightmap: BABYLON.PhysicsImpostor.HeightmapImpostor
	});

	const rebuildImpostor = (context, entityKey) => {

		let colliderRecord = context.resolved.components.find(record =>
			record.type === "collider" && record.entityKey === entityKey
		);

		if(colliderRecord == null)
			return null;

		let instance = context.instances[ace.identity(colliderRecord)];

		if(instance == null)
			return null;

		let bodyRecord = recordFor(context, entityKey, "body");
		let mode = bodyRecord != null ?
			(bodyRecord.data.mode != null ? bodyRecord.data.mode : "dynamic") :
			"static";

		let mass = mode === "dynamic" ?
			(bodyRecord.data.mass != null ? bodyRecord.data.mass : 1) : 0;

		let data = colliderRecord.data;
		let shape = data.shape != null ? data.shape : "auto";
		let mesh = instance.object.mesh;

		if(mesh == null)
			return null;

		if(shape === "auto") {

			let meshInstance = siblingInstance(context, colliderRecord, "mesh");
			let named = meshInstance?.object?.shape;

			shape = named != null && SHAPES()[named] != null ? named : "box";
		}

		if(instance.object.impostor != null) {

			instance.object.impostor.dispose();
			instance.object.impostor = null;
		}

		if(!context.meta.physics)
			return null;

		/*

			Geometry loaded from a location arrives after the mesh does:
			CreateGroundFromHeightMap and the model importers both return an
			empty mesh and fill it in later. Building a shape from it now would
			hand the solver a null vertex buffer, so the impostor is deferred
			and the collider retries once the geometry lands.

		*/
		if(mesh.getTotalVertices != null && mesh.getTotalVertices() === 0)
			return null;

		/*

			A Babylon V1 impostor cannot sit beneath a parent that has no
			impostor of its own, and entity transform nodes never have one. The
			collision mesh is therefore lifted into world space and the entity
			node is synchronised to it each frame instead; see onReflect.

		*/
		if(mesh.parent != null) {

			let node = mesh.parent;

			node.computeWorldMatrix(true);

			mesh.parent = null;
			mesh.position = node.absolutePosition.clone();
			mesh.rotationQuaternion = (
				node.absoluteRotationQuaternion != null ?
					node.absoluteRotationQuaternion :
					BABYLON.Quaternion.Identity()
			).clone();

			mesh.scaling = (
				node.absoluteScaling != null ? node.absoluteScaling : node.scaling
			).clone();

			mesh.computeWorldMatrix(true);
		}

		let type = SHAPES()[shape];

		if(type == null)
			type = BABYLON.PhysicsImpostor.BoxImpostor;

		/*

			MeshImpostor under Cannon supports static bodies only; silently
			producing a broken dynamic body is worse than substituting a hull.

		*/
		if((type === BABYLON.PhysicsImpostor.MeshImpostor ||
			type === BABYLON.PhysicsImpostor.HeightmapImpostor) && mass > 0) {

			type = BABYLON.PhysicsImpostor.BoxImpostor;
		}

		try {

			instance.object.impostor = new BABYLON.PhysicsImpostor(
				mesh,
				type,
				{
					mass,
					friction: data.friction != null ? data.friction : 0.5,
					restitution: data.restitution != null ? data.restitution : 0
				},
				context.meta.scene
			);

		} catch(error) {

			context.errors.push({
				type: "collider",
				hook: "physics",
				message: error.message
			});

			return null;
		}

		return instance.object.impostor;
	};

	const impostorFor = (context, entityKey) => {

		let record = recordFor(context, entityKey, "collider");

		if(record == null)
			return null;

		let instance = context.instances[ace.identity(record)];

		return instance != null ? instance.object.impostor : null;
	};

	// -------------------------------------------------------------- operators

	const operators = [

		{	// world -------------------------------------------------------
			type: "world",
			order: -100,

			onCreate: (context, instance) => {

				let scene = context.meta.scene;
				let data = instance.data;

				scene.clearColor = color(data.background, [0, 0, 0, 1]);
				scene.ambientColor = color3(data.ambient, [0, 0, 0]);

				let gravity = data.gravity !== undefined ?
					data.gravity : [0, -9.81, 0];

				let physics = false;

				if(gravity != null && BABYLON.CannonJSPlugin != null) {

					try {

						scene.enablePhysics(
							vector(gravity, [0, -9.81, 0]),
							new BABYLON.CannonJSPlugin(
								true,
								data.substeps != null ? data.substeps : 10
							)
						);

						/*

							Babylon advances physics from the render loop's
							wall-clock delta. A declarative simulation needs a
							reproducible step instead, so ACE takes ownership of
							stepping here and drives it from world.data.step.

						*/
						scene.physicsEnabled = false;

						/*

							Solver iterations are raised, which costs a little
							and settles contacts more thoroughly. Contact
							stiffness is left alone: winding it up does not stop
							a driven body pushing through anything, and a very
							stiff contact makes a resting body chatter.

						*/
						let world = scene.getPhysicsEngine()
							?.getPhysicsPlugin()?.world;

						if(world?.solver != null) {

							world.solver.iterations = Math.max(
								10, data.substeps != null ? data.substeps : 10
							);
						}

						physics = true;

					} catch(error) {

						context.errors.push({
							type: "world",
							hook: "onCreate",
							message: "physics unavailable: " + error.message
						});
					}
				}

				context.meta.physics = physics;
				context.meta.step = data.step != null ? data.step : 1 / 60;
				context.meta.accumulator = 0;

				operators[0].atmosphere(context, instance);

				let capabilities = ["audio"].concat(
					physics ? ["physics"] : []
				).concat(context.meta.xr != null ? context.meta.xr : []);

				let missing = (
					Array.isArray(data.requires) ? data.requires : []
				).filter(capability => !capabilities.includes(capability));

				if(missing.length > 0) {

					context.errors.push({
						type: "world",
						hook: "onCreate",
						message: "unmet capabilities: " + missing.join(", ")
					});
				}

				ace.setState(context, instance.record, {
					ready: true,
					capabilities
				});

				return { scene, skybox: null };
			},

			/*

				The haze, the grading and the sky's visibility, which a document
				changes as the viewer passes from air to water or from day to
				night. They are applied in place: rebuilding the world to change
				the fog would rebuild the sky with it.

			*/
			atmosphere: (context, instance) => {

				let scene = context.meta.scene;
				let data = instance.data;

				if(data.fog != null) {

					scene.fogColor = color3(data.fog.color, [1, 1, 1]);

					/*

						A fog with a density is exponential-squared, which is what
						distance haze over a large landscape wants; one with near and
						far is linear, as before.

					*/
					if(data.fog.density != null) {

						scene.fogMode = BABYLON.Scene.FOGMODE_EXP2;
						scene.fogDensity = data.fog.density;

					} else {

						scene.fogMode = BABYLON.Scene.FOGMODE_LINEAR;
						scene.fogStart = data.fog.near != null ? data.fog.near : 10;
						scene.fogEnd = data.fog.far != null ? data.fog.far : 100;
					}
				}

				/* Optional colour grading, honoured by every material using image processing. */
				if(isObject(data.post)) {

					let processing = scene.imageProcessingConfiguration;

					processing.toneMappingEnabled = data.post.tonemap === "aces";

					if(data.post.tonemap === "aces") {

						processing.toneMappingType =
							BABYLON.ImageProcessingConfiguration.TONEMAPPING_ACES;
					}

					processing.exposure = data.post.exposure != null ? data.post.exposure : 1;
					processing.contrast = data.post.contrast != null ? data.post.contrast : 1;

					if(data.post.vignette != null) {

						processing.vignetteEnabled = true;
						processing.vignetteWeight = data.post.vignette;
					}
				}

				let skybox = instance.object != null ? instance.object.skybox : null;

				if(skybox != null)
					skybox.setEnabled(data.sky !== false);

				/* With no sky to show, what is behind everything is the haze. */
				if(data.sky === false && data.fog != null) {

					let c = Array.isArray(data.fog.color) ? data.fog.color : [0, 0, 0];

					scene.clearColor = new BABYLON.Color4(c[0], c[1], c[2], 1);

				} else {

					scene.clearColor = color(data.background, [0, 0, 0, 1]);
				}
			},

			onChange: (context, instance, previous) => {

				const rest = data => {

					let copy = Object.assign({ }, data);

					delete copy.fog;
					delete copy.post;
					delete copy.sky;

					return JSON.stringify(copy);
				};

				if(previous != null && previous.data != null &&
					rest(previous.data) === rest(instance.data)) {

					operators[0].atmosphere(context, instance);
					return;
				}

				operators[0].onDestroy(context, instance);

				instance.object = operators[0].onCreate(context, instance);
			},

			/*

				The world is created before any texture exists, so a skybox
				referencing one is built on the first frame it becomes
				available and is left alone thereafter.

			*/
			onUpdate: (context, instance) => {

				finishing(context, instance);

				let background = instance.data.background;

				if(instance.object.skybox != null ||
					!isObject(background) || background.texture == null) {

					return;
				}

				let texture = resolveTexture(context, background.texture);

				if(texture == null)
					return;

				let scene = context.meta.scene;

				instance.object.skybox = scene.createDefaultSkybox(
					texture,
					true,
					instance.data.horizon != null ? instance.data.horizon : 1000
				);

				/* The sky is scenery, not geometry: it must not answer rays. */
				if(instance.object.skybox != null) {

					instance.object.skybox.isPickable = false;

					/*

						The sky is drawn at infinite distance inside a small box. If it
						writes depth, everything beyond the box's radius is behind it
						and never appears.

					*/
					if(instance.object.skybox.material != null)
						instance.object.skybox.material.disableDepthWrite = true;

					/*

						Babylon draws the sky box last among the opaque meshes (to
						spare the pixels the scene already covers), and tests it
						against depth: its faces, a few hundred metres off, then paint
						over anything farther than that, so an island a kilometre away
						was replaced by sky and cloud, and a building appeared only
						once it was inside the box. The sky writes no depth, so it is
						drawn first, and everything is then drawn over it.

					*/
					let sky = instance.object.skybox;

					scene.setRenderingOrder(0, (a, b) => {

						let skyA = a.getMesh() === sky, skyB = b.getMesh() === sky;

						if(skyA !== skyB)
							return skyA ? -1 : 1;

						return a.getMesh()._distanceToCamera - b.getMesh()._distanceToCamera;
					});
				}

				scene.environmentTexture = texture;
			},

			onDestroy: (context, instance) => {

				if(instance != null && instance.object != null &&
					instance.object.skybox != null) {

					instance.object.skybox.dispose();
				}

				if(context.meta.finish != null) {

					if(context.meta.finish.pipeline != null)
						context.meta.finish.pipeline.dispose();

					if(context.meta.finish.grade != null)
						context.meta.finish.grade.dispose();

					context.meta.finish = null;
				}

				context.meta.scene.environmentTexture = null;

				if(context.meta.physics)
					context.meta.scene.disablePhysicsEngine();

				context.meta.physics = false;
			}
		},

		{	// camera ------------------------------------------------------
			type: "camera",

			onCreate: (context, instance) => {

				let scene = context.meta.scene;
				let data = instance.data;
				let node = nodeFor(context, instance.entity);

				let camera = new BABYLON.UniversalCamera(
					instance.path.join("."),
					BABYLON.Vector3.Zero(),
					scene
				);

				/*

					Standard 2.2.3 puts forward on -Z, and the light operator
					already aims along the entity's -Z. A Babylon camera looks
					along +Z, and in a right-handed scene its own rotation
					property does not reach its world matrix, so the correction
					is carried by a pivot between the entity and the camera.

					Without it a camera and a light on the same entity face
					opposite ways, and every control scheme reads inverted.

				*/
				let pivot = new BABYLON.TransformNode(
					instance.path.join(".") + ".pivot", scene
				);

				pivot.parent = node;
				pivot.rotationQuaternion =
					BABYLON.Quaternion.RotationAxis(BABYLON.Axis.Y, Math.PI);

				camera.parent = pivot;
				camera.minZ = data.near != null ? data.near : 0.1;
				camera.maxZ = data.far != null ? data.far : 1000;

				let object = { camera, pivot, node, attached: false, xr: null };

				operators[1].apply(context, instance, object);

				if(scene.activeCamera == null)
					scene.activeCamera = camera;

				ace.setState(context, instance.record, {
					supported: [],
					presenting: false
				});

				/*

					Babylon throws at once, not through the promise, when
					immersive sessions are requested from an origin it does not
					consider secure. That must cost the document its headset and
					nothing else: a camera whose creation fails is created
					again on every frame.

				*/
				if(data.xr != null) {

					try {

						operators[1].requestXR(context, instance, object);

					} catch(error) {

						context.errors.push({
							type: "camera",
							hook: "requestXR",
							message: error.message
						});
					}
				}

				return object;
			},

			apply: (context, instance, object) => {

				let data = instance.data;
				let camera = object.camera;

				if(data.projection === "orthographic") {

					camera.mode = BABYLON.Camera.ORTHOGRAPHIC_CAMERA;

					let height = (data.size != null ? data.size : 10) / 2;
					let aspect = context.meta.engine.getAspectRatio(camera);

					camera.orthoTop = height;
					camera.orthoBottom = -height;
					camera.orthoLeft = -height * aspect;
					camera.orthoRight = height * aspect;

				} else {

					camera.mode = BABYLON.Camera.PERSPECTIVE_CAMERA;
					camera.fov = data.fov != null ? data.fov : 1.05;
				}

				if(Array.isArray(data.viewport)) {

					camera.viewport = new BABYLON.Viewport(
						...data.viewport
					);
				}

				camera.speed = data.speed != null ? data.speed : 1;

				/*

					A target is a world-space point, but Babylon aims a parented
					camera in its parent's frame, so the point is carried into
					pivot space first. Passing world coordinates straight
					through aims the camera at nothing in particular as soon as
					its entity is not at the origin.

				*/
				if(Array.isArray(data.target)) {

					object.pivot.computeWorldMatrix(true);

					camera.setTarget(BABYLON.Vector3.TransformCoordinates(
						vector(data.target),
						BABYLON.Matrix.Invert(object.pivot.getWorldMatrix())
					));
				}

				let control = data.control != null ? data.control : "none";

				if(control !== "none" && !object.attached && hasDOM) {

					try {

						camera.attachControl(true);
						object.attached = true;

					} catch(error) { /* no input surface */ }

				} else if(control === "none" && object.attached) {

					camera.detachControl();
					object.attached = false;
				}
			},

			/*

				An immersive session is started only where the document asks for
				one, and never implicitly on camera creation.

			*/
			requestXR: (context, instance, object) => {

				let data = instance.data;
				let scene = context.meta.scene;

				/*

					Support is decided by the runtime, which resolves without a
					base experience where there is none. Guessing at it from the
					presence of a document object only makes the request
					untestable.

				*/
				if(scene.createDefaultXRExperienceAsync == null)
					return;

				let mode = data.xr.mode === "ar" ?
					"immersive-ar" : "immersive-vr";

				scene.createDefaultXRExperienceAsync({
					uiOptions: {
						sessionMode: mode,
						referenceSpaceType: data.xr.space != null ?
							data.xr.space : "local-floor"
					},
					optionalFeatures: Array.isArray(data.xr.features) ?
						data.xr.features : [],

					/*

						Babylon enables teleportation by default, which takes
						the thumbstick and moves in jumps. A document asking for
						continuous locomotion has to say so, and it does that by
						not asking for teleportation.

					*/
					disableTeleportation: data.xr.teleport !== true,

					/*

						A headset draws the scene twice, at a resolution the
						device chooses; a document that cannot afford that
						asks for a fraction of it (1 is the device's own).

					*/
					outputCanvasOptions: data.xr.scale != null ? {
						canvasOptions: {
							antialias: true, depth: true, stencil: true, alpha: true,
							framebufferScaleFactor: data.xr.scale
						}
					} : undefined

				}).then(experience => {

					object.xr = experience;
					context.meta.xr = experience;

					ace.setState(context, instance.record, {
						supported: [data.xr.mode]
					});

					let base = experience.baseExperience;

					if(base == null)
						return;

					/*

						The headset reports its pose within a reference space,
						which has no idea where the document has put the player.
						Riding the camera's entity makes the document's position
						the origin the headset moves around in, so walking is
						expressed exactly as it is on a desktop.

						Eye height comes from the headset in a floor-relative
						space, so a document that raises its camera for a desktop
						view should lower it again while presenting.

					*/
					/*

						The rig is not parented. A parent transform reaches the
						headset camera's position but not its orientation,
						because the view direction is rebuilt from the session
						pose every frame; turning the parent then swings the
						viewer around a point instead of turning them on the
						spot. The reference space is what has to move, and it is
						updated in onUpdate below.

					*/

				}).catch(error => {

					context.errors.push({
						type: "camera",
						hook: "requestXR",
						message: error.message
					});
				});
			},

			onChange: (context, instance) => {

				operators[1].apply(context, instance, instance.object);
			},

			onUpdate: (context, instance) => {

				let xr = instance.object.xr;

				if(xr == null)
					return;

				let presenting = xr.baseExperience?.state ===
					BABYLON.WebXRState.IN_XR;

				let state = { presenting };

				/*

					A session has its own cameras and its own depth buffer, drawn
					with the projection the device supplies, which is an
					ordinary one. A reversed depth buffer (cleared to 0, tested
					greater-or-equal) is not what that projection writes, and
					everything is then drawn out of order, or not at all. It is
					put aside while presenting and put back afterwards.

					The near plane is also raised, since an ordinary 24-bit
					depth buffer gets its precision from it: the document may
					say how far in a headset is drawn from and to (`xr.near`,
					`xr.far`).

				*/
				let engine = context.meta.engine;

				if(presenting) {

					if(engine.useReverseDepthBuffer) {

						engine.useReverseDepthBuffer = false;
						context.meta.reverseHeld = true;
					}

					let head = xr.baseExperience.camera;

					if(head != null) {

						let near = instance.data.xr.near, far = instance.data.xr.far;

						if(near != null && head.minZ !== near)
							head.minZ = near;

						if(far != null && head.maxZ !== far)
							head.maxZ = far;
					}

				} else if(context.meta.reverseHeld) {

					engine.useReverseDepthBuffer = true;
					context.meta.reverseHeld = false;
				}

				if(presenting && xr.baseExperience.camera != null) {

					let head = xr.baseExperience.camera;
					let node = instance.object.node;

					/*

						The document's transform is carried into the session by
						moving the reference space the headset is tracked
						within, which is the only thing that turns a viewer
						rather than orbiting them.

						Babylon takes the yaw of the camera it is handed and
						discards the rest, and forces the floor to y = 0, so the
						height is restored afterwards.

					*/
					if(node != null && instance.object.camera != null &&
						typeof head.setTransformationFromNonVRCamera === "function") {

						node.computeWorldMatrix(true);
						instance.object.camera.computeWorldMatrix(true);

						let ground = node.absolutePosition;

						let facing = node.absoluteRotationQuaternion != null ?
							node.absoluteRotationQuaternion :
							BABYLON.Quaternion.Identity();

						let signature = [
							Math.round(ground.x * 1000),
							Math.round(ground.y * 1000),
							Math.round(ground.z * 1000),
							Math.round(facing.y * 10000),
							Math.round(facing.w * 10000)
						].join(",");

						if(signature !== instance.object.rig) {

							head.setTransformationFromNonVRCamera(
								instance.object.camera, true
							);

							head.position.y = ground.y;

							instance.object.rig = signature;
						}

						state.rigged = "reference-space";

						/*

							The view is not tilted. Babylon's helper carries the
							yaw of the camera it is handed and discards the
							rest, and layering a rotation of one's own over the
							base reference space discards the position along
							with it: the viewer is dropped to the origin on
							every frame the rig is not otherwise moving, and
							snaps back for a single frame whenever it is.

							Babylon does have a mechanism for this — it watches
							its own camera and rebuilds the space from the
							difference — but it is meant to be driven once, not
							held against head tracking every frame. Pitching a
							reference space also tilts the horizon with it,
							which is uncomfortable on foot.

						*/

					} else if(node != null) {

						/* Nothing better available; at least follow position. */
						if(head.parent !== node)
							head.parent = node;

						state.rigged = "parent";
					}

					/*

						Which frame a runtime reports its headset in is not
						something to be assumed. The world position is taken
						from the engine, and the offset within the rig is
						derived from it, so both are in frames defined here.

						Reading the camera's own position field instead gives a
						value whose meaning depends on whether parenting took
						effect, and a document using it to turn about the head
						is then thrown across the scene as it walks.

					*/
					let world = head.globalPosition != null ?
						head.globalPosition : head.position;

					state.pose = {
						position: array3(world),
						rotation: array4(
							head.absoluteRotation != null ?
								head.absoluteRotation :
							head.rotationQuaternion != null ?
								head.rotationQuaternion :
								BABYLON.Quaternion.Identity()
						)
					};

					if(node != null) {

						node.computeWorldMatrix(true);

						state.offset = array3(
							BABYLON.Vector3.TransformCoordinates(
								world,
								BABYLON.Matrix.Invert(node.getWorldMatrix())
							)
						);
					}
				}

				ace.setState(context, instance.record, state);
			},

			onDestroy: (context, instance) => {

				if(instance.object.xr != null)
					instance.object.xr.dispose();

				instance.object.camera.dispose();

				if(instance.object.pivot != null)
					instance.object.pivot.dispose();
			}
		},

		{	// light -------------------------------------------------------
			type: "light",

			onCreate: (context, instance) => {

				let scene = context.meta.scene;
				let data = instance.data;
				let node = nodeFor(context, instance.entity);
				let type = data.type != null ? data.type : "directional";
				let name = instance.path.join(".");

				let light =
					type === "point" ?
						new BABYLON.PointLight(
							name, BABYLON.Vector3.Zero(), scene
						) :
					type === "spot" ?
						new BABYLON.SpotLight(
							name,
							BABYLON.Vector3.Zero(),
							new BABYLON.Vector3(0, 0, -1),
							data.angle != null ? data.angle * 2 : 1.4,
							2,
							scene
						) :
					type === "ambient" ?
						new BABYLON.HemisphericLight(
							name, new BABYLON.Vector3(0, 1, 0), scene
						) :
						new BABYLON.DirectionalLight(
							name, new BABYLON.Vector3(0, 0, -1), scene
						);

				light.parent = node;

				let object = { light, generator: null, type };

				operators[2].apply(context, instance, object);

				return object;
			},

			apply: (context, instance, object) => {

				let data = instance.data;
				let light = object.light;

				light.diffuse = color3(data.color, [1, 1, 1]);
				light.intensity = data.intensity != null ? data.intensity : 1;

				/* A light can be switched off without being removed: `on: false`. (Switching its entity off is not the same: a light's state is not re-read from its parents.) */
				light.setEnabled(data.on !== false);

				/* An ambient light may light the underside differently from the top. */
				if(data.ground != null && light.groundColor !== undefined)
					light.groundColor = color3(data.ground, [0, 0, 0]);

				if(data.range != null && light.range !== undefined)
					light.range = data.range;

				if(data.angle != null && light.angle !== undefined)
					light.angle = data.angle * 2;

				let wanted = data.shadow != null && data.shadow !== false;

				if(wanted && object.generator == null &&
					light.getShadowGenerator === undefined ||
					wanted && object.generator == null) {

					try {

						let settings = isObject(data.shadow) ? data.shadow : { };

						object.generator = new BABYLON.ShadowGenerator(
							settings.resolution != null ?
								settings.resolution : 1024,
							light
						);

						if(settings.bias != null)
							object.generator.bias = settings.bias;

						object.generator.usePercentageCloserFiltering = true;

						collectShadowCasters(context, object.generator);

					} catch(error) { /* light type cannot cast shadows */ }
				}

				if(!wanted && object.generator != null) {

					object.generator.dispose();
					object.generator = null;
				}
			},

			onChange: (context, instance, previous) => {

				let type = instance.data.type != null ?
					instance.data.type : "directional";

				/* A change of light type is a change of Babylon class. */
				if(type !== instance.object.type) {

					operators[2].onDestroy(context, instance);
					instance.object = operators[2].onCreate(context, instance);

					return;
				}

				operators[2].apply(context, instance, instance.object);
			},

			onDestroy: (context, instance) => {

				if(instance.object.generator != null)
					instance.object.generator.dispose();

				instance.object.light.dispose();
			}
		},

		{	// texture -----------------------------------------------------
			type: "texture",
			order: -20,

			onCreate: (context, instance) => {

				let scene = context.meta.scene;
				let data = instance.data;
				let object = { texture: null, shape: null };

				let configure = texture => {

					if(data.cube === true) {

						texture.coordinatesMode =
							BABYLON.Texture.SKYBOX_MODE;

						return;
					}

					texture.wrapU = texture.wrapV =
						data.wrap === "clamp" ?
							BABYLON.Texture.CLAMP_ADDRESSMODE :
						data.wrap === "mirror" ?
							BABYLON.Texture.MIRROR_ADDRESSMODE :
							BABYLON.Texture.WRAP_ADDRESSMODE;

					if(data.filter === "nearest") {

						texture.updateSamplingMode(
							BABYLON.Texture.NEAREST_SAMPLINGMODE
						);
					}
				};

				/* Manual pixel data, per standard section 2.3.6. */
				if(Array.isArray(instance.content)) {

					if(!Array.isArray(data.size)) {

						ace.setState(context, instance.record, {
							loaded: false,
							error: "manual texture content requires data.size"
						});

						return object;
					}

					let texture = BABYLON.RawTexture.CreateRGBATexture(
						new Uint8Array(instance.content),
						data.size[0],
						data.size[1],
						scene,
						data.mipmaps !== false,
						data.flip === true
					);

					configure(texture);

					object.texture = texture;

					ace.setState(context, instance.record, {
						loaded: true,
						size: data.size
					});

					return object;
				}

				let sources = (
					Array.isArray(instance.source) ?
						instance.source : [instance.source]
				).filter(candidate => typeof candidate === "string");

				if(sources.length === 0) {

					ace.setState(context, instance.record, {
						loaded: false,
						error: "texture has neither source nor content"
					});

					return object;
				}

				/*

					APInt 2.1.2 allows a source to be a list of locations in
					order of preference. Each is tried in turn, which is what
					makes a document that depends on third-party asset hosts
					degrade rather than break.

				*/
				let attempt = index => {

					if(index >= sources.length) {

						ace.setState(context, instance.record, {
							loaded: false,
							error: "all sources failed"
						});

						return;
					}

					let source = sources[index];

					let texture = data.cube === true ?
						new BABYLON.CubeTexture(
							source,
							scene,
							Array.isArray(data.faces) ? data.faces : null,
							data.mipmaps === false,
							null,
							() => {

								ace.setState(context, instance.record, {
									loaded: true
								});
							},
							() => attempt(index + 1)
						) :
						new BABYLON.Texture(
							source,
							scene,
							data.mipmaps === false,
							data.flip !== true,
							null,
							() => {

								ace.setState(context, instance.record, {
									loaded: true,
									size: [
										texture.getSize().width,
										texture.getSize().height
									]
								});
							},
							() => attempt(index + 1)
						);

					configure(texture);

					if(object.texture != null && object.texture !== texture)
						object.texture.dispose();

					object.texture = texture;
				};

				attempt(0);

				ace.setState(context, instance.record, { loaded: false });

				return object;
			},

			onChange: (context, instance) => {

				operators[3].onDestroy(context, instance);
				instance.object = operators[3].onCreate(context, instance);
			},

			onDestroy: (context, instance) => {

				if(instance.object.texture != null)
					instance.object.texture.dispose();
			}
		},

		{	// material ----------------------------------------------------
			type: "material",
			order: -10,

			onCreate: (context, instance) => {

				let material = new BABYLON.PBRMaterial(
					instance.path.join("."), context.meta.scene
				);

				let object = { material };

				operators[4].apply(context, instance, object);

				return object;
			},

			apply: (context, instance, object) => {

				let data = instance.data;
				let material = object.material;
				let base = color(data.color, [1, 1, 1, 1]);

				material.albedoColor = new BABYLON.Color3(base.r, base.g, base.b);
				material.alpha = base.a;
				material.metallic = data.metallic != null ? data.metallic : 0;
				material.roughness = data.roughness != null ? data.roughness : 1;
				material.emissiveColor = color3(data.emissive, [0, 0, 0]);
				material.unlit = data.unlit === true;

				material.backFaceCulling = data.side !== "double";

				if(data.side === "back")
					material.sideOrientation = BABYLON.Material.ClockWiseSideOrientation;

				if(data.blend === "mask") {

					material.transparencyMode =
						BABYLON.PBRMaterial.PBRMATERIAL_ALPHATEST;

					material.alphaCutOff =
						data.cutoff != null ? data.cutoff : 0.5;

				} else if(data.blend === "blend" || base.a < 1) {

					material.transparencyMode =
						BABYLON.PBRMaterial.PBRMATERIAL_ALPHABLEND;

				} else {

					material.transparencyMode =
						BABYLON.PBRMaterial.PBRMATERIAL_OPAQUE;
				}

				let slots = {
					base: "albedoTexture",
					normal: "bumpTexture",
					metallic: "metallicTexture",
					roughness: "metallicTexture",
					emissive: "emissiveTexture",
					occlusion: "ambientTexture"
				};

				let loaded = true;

				Object.keys(
					isObject(data.maps) ? data.maps : { }
				).forEach(slot => {

					let target = slots[slot];

					if(target == null)
						return;

					let value = data.maps[slot];
					let texture = null;

					/*

						A plain string is a literal location; a reference is an
						object keyed by the target kind, so the two can never be
						confused (standard section 2.2.3).

					*/
					if(isObject(value) && value.texture != null) {

						let element = ace.getElement(context.data, value.texture);

						if(element == null) {

							loaded = false;
							return;
						}

						let referenced = context.resolved.components.find(
							record => record.key === ace.pathKey(element.path)
						);

						let referencedInstance = referenced != null ?
							context.instances[ace.identity(referenced)] : null;

						texture = referencedInstance?.object?.texture;

						if(texture == null)
							loaded = false;

					} else if(typeof value === "string") {

						if(object.owned == null)
							object.owned = { };

						if(object.owned[slot] == null) {

							/* Pixel art is sampled as it is: no blending of neighbours, and no smaller copies. */
							if(data.filter === "nearest") {

								object.owned[slot] = new BABYLON.Texture(
									value, context.meta.scene, true, true,
									BABYLON.Texture.NEAREST_SAMPLINGMODE
								);

								object.owned[slot].wrapU = object.owned[slot].wrapV =
									BABYLON.Texture.CLAMP_ADDRESSMODE;

							} else {

								object.owned[slot] = new BABYLON.Texture(
									value, context.meta.scene
								);
							}
						}

						texture = object.owned[slot];
					}

					if(texture != null) {

						material[target] = texture;

						/* A picture with transparency in it, rather than a flat colour with an alpha. */
						if(slot === "base" && data.alpha === "texture") {

							texture.hasAlpha = true;
							material.useAlphaFromAlbedoTexture = true;
						}

						if(Array.isArray(data.region)) {

							texture.uOffset = data.region[0];
							texture.vOffset = data.region[1];
							texture.uScale = data.region[2];
							texture.vScale = data.region[3];

						} else {

							if(Array.isArray(data.tiling)) {

								texture.uScale = data.tiling[0];
								texture.vScale = data.tiling[1];
							}

							if(Array.isArray(data.offset)) {

								texture.uOffset = data.offset[0];
								texture.vOffset = data.offset[1];
							}
						}
					}
				});

				/* Optional refinements of the surface. */
				if(data.zOffset != null)
					material.zOffset = data.zOffset;

				if(data.bump != null && material.bumpTexture != null)
					material.bumpTexture.level = data.bump;

				if(data.antialias === true)
					material.enableSpecularAntiAliasing = true;

				ace.setState(context, instance.record, { loaded });
			},

			onChange: (context, instance) => {

				operators[4].apply(context, instance, instance.object);
			},

			/*

				Referenced textures may finish loading after the material was
				built, so map binding is re-checked while any slot is pending.

			*/
			onUpdate: (context, instance) => {

				let state = context.state[instance.id];

				if(state != null && state.loaded === false)
					operators[4].apply(context, instance, instance.object);
			},

			onDestroy: (context, instance) => {

				Object.values(
					instance.object.owned != null ? instance.object.owned : { }
				).forEach(texture => texture.dispose());

				instance.object.material.dispose();
			}
		},

		{	// mesh --------------------------------------------------------
			type: "mesh",

			onCreate: (context, instance) => {

				let scene = context.meta.scene;
				let data = instance.data;
				let node = nodeFor(context, instance.entity);
				let name = instance.path.join(".");

				let object = {
					mesh: null,
					shape: null,
					loader: null,
					disposed: false
				};

				let size = data.size;
				let dimensions =
					typeof size === "number" ? [size, size, size] :
					Array.isArray(size) ? size : [1, 1, 1];

				let segments = Array.isArray(data.segments) ?
					data.segments[0] :
					data.segments != null ? data.segments : 16;

				let shape = data.shape != null ? data.shape : null;

				/*

					Heightmap terrain. The geometry is identical whether the
					heights arrive as an image at a URL or as raw samples in the
					content field; only the means of obtaining them differs, so
					a document can be authored either way and tested headlessly
					with the second.

				*/
				if(shape === "heightmap") {

					let options = {
						width: dimensions[0],
						height: dimensions[2] != null ?
							dimensions[2] : dimensions[0],
						subdivisions: Array.isArray(data.segments) ?
							data.segments[0] :
							data.segments != null ? data.segments : 100,
						minHeight: Array.isArray(data.elevation) ?
							data.elevation[0] : 0,
						maxHeight: Array.isArray(data.elevation) ?
							data.elevation[1] : dimensions[1],
						colorFilter: new BABYLON.Color3(0.3, 0.59, 0.11),
						alphaFilter: 0
					};

					object.shape = "heightmap";

					let samples = operators[5].heights(instance, data);

					if(samples != null) {

						let mesh = new BABYLON.Mesh(name, scene);

						/*

							Heights given as numbers are used as given. Routing
							them through an image buffer would quantise them to
							256 levels, which on a gentle grade is coarse enough
							to change the slope the surface reports.

						*/
						(samples.heights != null ?
							operators[5].heightfield(samples, options) :
							BABYLON.VertexData.CreateGroundFromHeightMap(
								Object.assign({ }, options, {
									buffer: samples.buffer,
									bufferWidth: samples.width,
									bufferHeight: samples.height
								})
							)
						).applyToMesh(mesh);

						mesh.parent = node;
						object.mesh = mesh;

						operators[5].finish(context, instance, object);

						return object;
					}

					let source = Array.isArray(instance.source) ?
						instance.source[0] : instance.source;

					if(typeof source !== "string") {

						ace.setState(context, instance.record, {
							loaded: false,
							error: "heightmap needs a source image or height content"
						});

						return object;
					}

					object.mesh = BABYLON.MeshBuilder.CreateGroundFromHeightMap(
						name,
						source,
						Object.assign({ }, options, {
							onReady: () => {

								if(object.disposed)
									return;

								operators[5].finish(context, instance, object);

								/*

									Terrain collision cannot be built until the
									heights have arrived.

								*/
								rebuildImpostor(context, instance.entityKey);
							}
						}),
						scene
					);

					object.mesh.parent = node;

					ace.setState(context, instance.record, { loaded: false });

					return object;
				}


				/* Loaded model. */
				if(instance.source != null) {

					object.mesh = new BABYLON.TransformNode(name, scene);
					object.mesh.parent = node;

					operators[5].load(context, instance, object);

					ace.setState(context, instance.record, { loaded: false });

					return object;
				}

				/* Manual geometry, supplied through the APInt content field. */
				if(instance.content != null) {

					let geometry = null;

					try {

						geometry = typeof instance.content === "string" ?
							JSON.parse(instance.content) :
							operators[5].decode(instance.content, data.layout);

					} catch(error) {

						ace.setState(context, instance.record, {
							loaded: false,
							error: "geometry: " + error.message
						});

						return object;
					}

					let mesh = new BABYLON.Mesh(name, scene);
					let vertexData = new BABYLON.VertexData();

					vertexData.positions = geometry.positions;
					vertexData.indices = geometry.indices;

					if(geometry.normals != null)
						vertexData.normals = geometry.normals;
					else if(geometry.positions != null && geometry.indices != null) {

						let normals = [];

						BABYLON.VertexData.ComputeNormals(
							geometry.positions, geometry.indices, normals
						);

						vertexData.normals = normals;
					}

					if(geometry.uvs != null)
						vertexData.uvs = geometry.uvs;

					if(geometry.colors != null)
						vertexData.colors = geometry.colors;

					vertexData.applyToMesh(mesh);

					mesh.parent = node;

					object.mesh = mesh;
					object.shape = "convex";

					operators[5].finish(context, instance, object);

					return object;
				}

				/* Parametric primitive. */
				shape = shape != null ? shape : "box";

				let builders = {
					box: () => BABYLON.MeshBuilder.CreateBox(name, {
						width: dimensions[0],
						height: dimensions[1],
						depth: dimensions[2]
					}, scene),
					sphere: () => BABYLON.MeshBuilder.CreateSphere(name, {
						diameterX: dimensions[0],
						diameterY: dimensions[1],
						diameterZ: dimensions[2],
						segments
					}, scene),
					plane: () => BABYLON.MeshBuilder.CreatePlane(name, {
						width: dimensions[0],
						height: dimensions[1],
						sideOrientation: BABYLON.Mesh.DOUBLESIDE
					}, scene),
					ground: () => BABYLON.MeshBuilder.CreateGround(name, {
						width: dimensions[0],
						height: dimensions[2] != null ?
							dimensions[2] : dimensions[1],
						subdivisions: segments
					}, scene),
					cylinder: () => BABYLON.MeshBuilder.CreateCylinder(name, {
						diameter: dimensions[0],
						height: dimensions[1],
						tessellation: segments
					}, scene),
					capsule: () => BABYLON.MeshBuilder.CreateCapsule(name, {
						radius: dimensions[0] / 2,
						height: dimensions[1],
						tessellation: segments
					}, scene),
					torus: () => BABYLON.MeshBuilder.CreateTorus(name, {
						diameter: dimensions[0],
						thickness: dimensions[1],
						tessellation: segments
					}, scene)
				};

				let builder = builders[shape];

				if(builder == null) {

					ace.setState(context, instance.record, {
						loaded: false,
						error: "unknown shape: " + shape
					});

					return object;
				}

				object.mesh = builder();
				object.mesh.parent = node;
				object.shape =
					shape === "ground" || shape === "plane" ? "box" : shape;

				operators[5].finish(context, instance, object);

				return object;
			},

			/*

				Height content is accepted either as raw RGBA samples matching
				an image, or as a JSON object of normalised heights, which is
				far easier to author and to generate.

			*/
			heights: (instance, data) => {

				if(instance.content == null)
					return null;

				if(Array.isArray(instance.content)) {

					if(!Array.isArray(data.resolution))
						return null;

					return {
						buffer: new Uint8Array(instance.content),
						width: data.resolution[0],
						height: data.resolution[1]
					};
				}

				let parsed = JSON.parse(instance.content);

				if(!Array.isArray(parsed.heights) ||
					!Array.isArray(parsed.resolution)) {

					return null;
				}

				return {
					heights: parsed.heights,
					width: parsed.resolution[0],
					height: parsed.resolution[1]
				};
			},

			/*

				A height grid built directly from numbers. Columns run along +X
				and rows along -Z, matching the orientation an image heightmap
				is sampled with, so both forms describe the same terrain.

			*/
			heightfield: (samples, options) => {

				let width = samples.width;
				let depth = samples.height;
				let heights = samples.heights;
				let steps = Math.max(1, Math.round(options.subdivisions));

				const at = (column, row) => heights[
					Math.min(Math.max(row, 0), depth - 1) * width +
					Math.min(Math.max(column, 0), width - 1)
				];

				const sample = (u, v) => {

					let x = u * (width - 1);
					let y = v * (depth - 1);
					let column = Math.floor(x);
					let row = Math.floor(y);
					let fx = x - column;
					let fy = y - row;

					return (
						at(column, row) * (1 - fx) + at(column + 1, row) * fx
					) * (1 - fy) + (
						at(column, row + 1) * (1 - fx) +
						at(column + 1, row + 1) * fx
					) * fy;
				};

				let rise = options.maxHeight - options.minHeight;
				let positions = [];
				let uvs = [];
				let indices = [];

				for(let row = 0; row <= steps; row++) {

					for(let column = 0; column <= steps; column++) {

						let u = column / steps;
						let v = row / steps;

						positions.push(
							(u - 0.5) * options.width,
							options.minHeight + rise * sample(u, v),
							options.height / 2 - v * options.height
						);

						uvs.push(u, 1 - v);
					}
				}

				for(let row = 0; row < steps; row++) {

					for(let column = 0; column < steps; column++) {

						let a = row * (steps + 1) + column;
						let b = a + 1;
						let c = a + steps + 1;
						let d = c + 1;

						indices.push(a, b, c, b, d, c);
					}
				}

				let normals = [];

				BABYLON.VertexData.ComputeNormals(positions, indices, normals);

				let data = new BABYLON.VertexData();

				data.positions = positions;
				data.indices = indices;
				data.normals = normals;
				data.uvs = uvs;

				return data;
			},

			decode: (bytes, layout) => {

				if(!isObject(layout))
					throw new Error("binary content requires data.layout");

				let buffer = new Uint8Array(bytes).buffer;
				let view = new DataView(buffer);
				let count = layout.count;
				let result = { };

				Object.keys(layout.attributes).forEach(name => {

					let attribute = layout.attributes[name];
					let values = [];

					for(let index = 0; index < count; index++) {

						for(let element = 0; element < attribute.count; element++) {

							values.push(view.getFloat32(
								index * layout.stride +
								attribute.offset + element * 4,
								true
							));
						}
					}

					result[name] = values;
				});

				if(layout.indices != null) {

					let indices = [];

					for(let index = 0; index < layout.indices.count; index++) {

						indices.push(view.getUint16(
							layout.indices.offset + index * 2, true
						));
					}

					result.indices = indices;
				}

				return result;
			},

			load: (context, instance, object) => {

				let scene = context.meta.scene;
				let sources = Array.isArray(instance.source) ?
					instance.source : [instance.source];

				let attempt = index => {

					if(index >= sources.length) {

						ace.setState(context, instance.record, {
							loaded: false,
							error: "all sources failed"
						});

						return;
					}

					let source = sources[index];
					let split = source.lastIndexOf("/") + 1;

					let importer = BABYLON.SceneLoader != null ?
						BABYLON.SceneLoader.ImportMeshAsync : null;

					if(importer == null) {

						ace.setState(context, instance.record, {
							loaded: false,
							error: "no model loader is registered"
						});

						return;
					}

					object.loader = importer.call(
						BABYLON.SceneLoader,
						"",
						source.substring(0, split),
						source.substring(split),
						scene

					).then(content => {

						/*

							The component may have been destroyed while the
							import was in flight.

						*/
						if(object.disposed) {

							content.meshes.forEach(mesh => mesh.dispose());
							return;
						}

						content.meshes.filter(
							mesh => mesh.parent == null
						).forEach(mesh => {

							mesh.parent = object.mesh;
						});

						object.content = content;

						/*

							Loaders commonly start the first clip themselves.
							Which clip plays is the document's decision, so
							whatever arrived running is stopped.

						*/
						(content.animationGroups != null ?
							content.animationGroups : []
						).forEach(group => group.stop());

						operators[5].finish(context, instance, object);

						rebuildImpostor(context, instance.entityKey);

						ace.setState(context, instance.record, {
							loaded: true,
							nodes: content.meshes.map(mesh => mesh.name),
							clips: content.animationGroups.map(
								group => group.name
							),
							materials: (content.materials != null ?
								content.materials : []
							).map(material => material.name)
						});

					}).catch(() => attempt(index + 1));
				};

				attempt(0);
			},

			finish: (context, instance, object) => {

				let data = instance.data;
				let mesh = object.mesh;

				if(mesh == null)
					return;

				own(mesh, instance.entityKey);

				if(data.shadow?.cast !== false)
					shadows(context, mesh);

				let meshes = mesh.getChildMeshes != null ?
					[mesh].concat(mesh.getChildMeshes()) : [mesh];

				meshes.forEach(target => {

					if(target.receiveShadows !== undefined) {

						target.receiveShadows =
							data.shadow?.receive !== false;
					}

					/*

						Translucent surfaces are drawn far to near, measured to
						the middle of each one, which puts a wide panel in front
						of text lying across its corner. `order` (default 0)
						sets the layer first: a higher one is drawn later, over
						every lower one, and only those of a layer are sorted
						by distance.

					*/
					target.alphaIndex = data.order != null ? data.order : 0;

					/* An overlay (order 10 and above) is drawn in a layer of its own, over everything, with a fresh depth buffer. */
					if(data.order != null && data.order >= 10)
						target.renderingGroupId = 1;

				});

				/* How much of it can be seen: 1 whole, 0 gone. Anything under 1 is drawn translucent. */
				if(data.opacity != null)
					fade(meshes, data.opacity);

				if(data.billboard != null && data.billboard !== "none") {

					mesh.billboardMode = data.billboard === "y" ?
						BABYLON.Mesh.BILLBOARDMODE_Y :
						BABYLON.Mesh.BILLBOARDMODE_ALL;
				}

				/*

					One mesh drawn many times. A tiled scene is thousands of
					copies of a handful of shapes, and a component apiece would
					be thousands of components diffed every frame to say the
					same thing.

				*/
				if(Array.isArray(data.instances) &&
					mesh.thinInstanceSetBuffer != null) {

					let matrices = new Float32Array(data.instances.length * 16);

					data.instances.forEach((entry, index) => {

						BABYLON.Matrix.Compose(
							scale(entry.scale != null ? entry.scale : 1),
							quaternion(entry.rotation),
							vector(entry.position)
						).copyToArray(matrices, index * 16);
					});

					mesh.thinInstanceSetBuffer("matrix", matrices, 16, true);
				}

				let material = siblingInstance(context, instance, "material");

				if(material != null && mesh.material !== undefined)
					mesh.material = material.object.material;

				if(mesh.getBoundingInfo != null) {

					let bounds = mesh.getBoundingInfo().boundingBox;

					ace.setState(context, instance.record, {
						loaded: true,
						bounds: {
							min: array3(bounds.minimum),
							max: array3(bounds.maximum)
						}
					});
				}
			},

			/*

				Materials are created before meshes, but a material added to an
				existing entity later must still bind.

			*/
			onUpdate: (context, instance) => {

				let mesh = instance.object.mesh;

				if(mesh == null || mesh.material === undefined)
					return;

				let material = siblingInstance(context, instance, "material");
				let wanted = material != null ? material.object.material : null;

				if(mesh.material !== wanted)
					mesh.material = wanted;
			},

			onChange: (context, instance, previous) => {

				/*

					Fading something out must not reload it: when only its
					opacity has changed the meshes are simply told.

				*/
				const rest = data => {

					let copy = Object.assign({ }, data);

					delete copy.opacity;

					return JSON.stringify(copy);
				};

				if(previous != null && previous.data != null &&
					instance.object.mesh != null &&
					rest(previous.data) === rest(instance.data)) {

					let mesh = instance.object.mesh;
					let value = instance.data.opacity != null ?
						instance.data.opacity : 1;

					fade([mesh].concat(
						mesh.getChildMeshes != null ? mesh.getChildMeshes() : [ ]
					), value);

					return;
				}

				operators[5].onDestroy(context, instance);
				instance.object = operators[5].onCreate(context, instance);

				rebuildImpostor(context, instance.entityKey);
			},

			onDestroy: (context, instance) => {

				instance.object.disposed = true;

				if(instance.object.mesh != null) {

					instance.object.mesh.getChildMeshes?.().forEach(
						mesh => mesh.dispose()
					);

					instance.object.mesh.dispose();
				}
			}
		},

		{	// text --------------------------------------------------------
			type: "text",

			/*

				Text is drawn on a canvas and shown on a plane. A line of text is
				`resolution` pixels high however large it is drawn, and the plane is
				as wide as `width` says, so the glyphs are sized by the plane and
				the canvas follows it. With `wrap` a long string is broken into
				lines to fit the width, and a newline always starts one. The plane
				grows downward as lines are added; `anchor` says which part of it
				sits at the entity: "center" (the default), or any of "top",
				"bottom", "left", "right" and the corner combinations.

			*/
			onCreate: (context, instance) => {

				let scene = context.meta.scene;
				let data = instance.data;
				let node = nodeFor(context, instance.entity);
				let name = instance.path.join(".");

				let size = data.size != null ? data.size : 1;
				let leading = data.leading != null ? data.leading : 1.2;
				let text = instance.content != null ? String(instance.content) : "";
				let width = Math.max(
					data.width != null ? data.width : text.length * size * 0.6, 0.001
				);

				let lineHeight = data.resolution != null ? data.resolution : 128;
				let canvasWidth = Math.min(4096, Math.max(64, Math.round(
					lineHeight * width / (size * leading)
				)));

				let font = data.font != null ?
					data.font : "bold " + Math.round(lineHeight * 0.56) + "px sans-serif";

				let align = data.align === "left" || data.align === "right" ?
					data.align : "center";

				let padding = Math.round(lineHeight * 0.18);
				let lines = text.split("\n");
				let measure = null;

				if(hasDOM) {

					let probe = root.document.createElement("canvas").getContext("2d");

					probe.font = font;
					measure = string => probe.measureText(string).width;
				}

				if(data.wrap === true && measure != null) {

					let wrapped = [];

					lines.forEach(line => {

						let current = "";

						line.split(" ").forEach(word => {

							let attempt = current === "" ? word : current + " " + word;

							if(current !== "" && measure(attempt) > canvasWidth - padding * 2) {

								wrapped.push(current);
								current = word;

							} else {

								current = attempt;
							}
						});

						wrapped.push(current);
					});

					lines = wrapped;
				}

				let rows = Math.max(1, lines.length);
				let height = size * leading * rows;

				let plane = BABYLON.MeshBuilder.CreatePlane(name, {
					width: Math.max(width, 0.001),
					height: Math.max(height, 0.001),
					sideOrientation: BABYLON.Mesh.DOUBLESIDE
				}, scene);

				let anchor = typeof data.anchor === "string" ? data.anchor : "center";

				plane.position.set(
					anchor.includes("left") ? width / 2 :
						anchor.includes("right") ? -width / 2 : 0,
					anchor.includes("top") ? -height / 2 :
						anchor.includes("bottom") ? height / 2 : 0,
					0
				);

				plane.parent = node;

				if(data.billboard != null && data.billboard !== "none") {

					plane.billboardMode = data.billboard === "y" ?
						BABYLON.Mesh.BILLBOARDMODE_Y :
						BABYLON.Mesh.BILLBOARDMODE_ALL;

					/* A billboard turns its back to the viewer, so what it shows is mirrored back. */
					plane.scaling.x = -1;
					plane.position.x = -plane.position.x;
				}

				plane.alphaIndex = data.order != null ? data.order : 0;

				if(data.order != null && data.order >= 10)
					plane.renderingGroupId = 1;

				own(plane, instance.entityKey);

				let object = { mesh: plane, texture: null, material: null };

				/*

					Glyph rasterisation needs a 2D canvas. Headless runtimes get
					the correctly sized and positioned quad without it, which
					keeps layout, picking and bounds meaningful.

				*/
				if(hasDOM) {

					let texture = new BABYLON.DynamicTexture(name, {
						width: canvasWidth, height: lineHeight * rows
					}, scene, true);

					let base = color(data.color, [1, 1, 1, 1]);
					let canvas = texture.getContext();

					canvas.clearRect(0, 0, canvasWidth, lineHeight * rows);
					canvas.font = font;
					canvas.textBaseline = "middle";
					canvas.textAlign = align;
					canvas.fillStyle = "rgba(" + [base.r, base.g, base.b].map(
						channel => Math.round(channel * 255)
					).join(",") + "," + base.a + ")";

					if(data.shadow !== false) {

						canvas.shadowColor = "rgba(0,0,0,0.85)";
						canvas.shadowBlur = Math.round(lineHeight * 0.07);
						canvas.shadowOffsetX = canvas.shadowOffsetY =
							Math.max(1, Math.round(lineHeight * 0.02));
					}

					let x = align === "left" ? padding :
						align === "right" ? canvasWidth - padding : canvasWidth / 2;

					lines.forEach((line, index) =>
						canvas.fillText(line, x, lineHeight * (index + 0.5))
					);

					texture.update(true);

					let material = new BABYLON.StandardMaterial(name, scene);

					material.diffuseTexture = texture;
					material.emissiveTexture = texture;
					material.opacityTexture = texture;
					material.backFaceCulling = false;
					material.disableLighting = true;
					material.fogEnabled = false;

					plane.material = material;

					object.texture = texture;
					object.material = material;
				}

				ace.setState(context, instance.record, {
					loaded: true,
					lines: rows,
					bounds: {
						min: [-width / 2, -height / 2, 0],
						max: [width / 2, height / 2, 0]
					}
				});

				return object;
			},

			onChange: (context, instance) => {

				operators[6].onDestroy(context, instance);
				instance.object = operators[6].onCreate(context, instance);
			},

			onDestroy: (context, instance) => {

				if(instance.object.texture != null)
					instance.object.texture.dispose();

				if(instance.object.material != null)
					instance.object.material.dispose();

				instance.object.mesh.dispose();
			}
		},

		{	// collider ----------------------------------------------------
			type: "collider",
			order: 10,

			onCreate: (context, instance) => {

				let mesh = siblingInstance(context, instance, "mesh");
				let object = { mesh: null, impostor: null, owned: false };

				if(mesh != null && mesh.object.mesh != null &&
					mesh.object.mesh.getTotalVertices != null) {

					object.mesh = mesh.object.mesh;

				} else {

					/*

						A collider without renderable geometry still needs a
						body to attach to, so an invisible proxy is built from
						the declared shape.

					*/
					let size = typeof instance.data.size === "number" ?
						[instance.data.size, instance.data.size, instance.data.size] :
						Array.isArray(instance.data.size) ?
							instance.data.size : [1, 1, 1];

					object.mesh = BABYLON.MeshBuilder.CreateBox(
						instance.path.join(".") + ".proxy",
						{ width: size[0], height: size[1], depth: size[2] },
						context.meta.scene
					);

					object.mesh.isVisible = false;
					object.mesh.parent = nodeFor(context, instance.entity);
					object.owned = true;

					own(object.mesh, instance.entityKey);
				}

				if(Array.isArray(instance.data.offset))
					object.mesh.position = vector(instance.data.offset);

				context.instances[instance.id] = instance;
				instance.object = object;

				rebuildImpostor(context, instance.entityKey);

				ace.setState(context, instance.record, { contacts: [] });

				return object;
			},

			onChange: (context, instance) => {

				if(Array.isArray(instance.data.offset))
					instance.object.mesh.position = vector(instance.data.offset);

				rebuildImpostor(context, instance.entityKey);
			},

			onUpdate: (context, instance) => {

				let impostor = instance.object.impostor;

				/*

					Retry for as long as the shape is pending. This covers every
					asynchronous geometry source uniformly, rather than relying
					on each loader to remember to rebuild.

				*/
				if(impostor == null) {

					let mesh = siblingInstance(context, instance, "mesh");
					let geometry = mesh != null ? mesh.object.mesh : null;

					if(context.meta.physics && geometry != null &&
						geometry.getTotalVertices != null &&
						geometry.getTotalVertices() > 0) {

						instance.object.mesh = geometry;

						impostor = rebuildImpostor(context, instance.entityKey);
					}

					if(impostor == null)
						return;
				}

				let contacts = context.meta.contacts[instance.entityKey];

				ace.setState(context, instance.record, {
					contacts: contacts != null ? contacts : []
				});
			},

			onDestroy: (context, instance) => {

				if(instance.object.impostor != null)
					instance.object.impostor.dispose();

				if(instance.object.owned && instance.object.mesh != null)
					instance.object.mesh.dispose();
			}
		},

		{	// body --------------------------------------------------------
			type: "body",
			order: 20,

			onCreate: (context, instance) => {

				rebuildImpostor(context, instance.entityKey);

				let object = { entityKey: instance.entityKey };

				operators[8].apply(context, instance);

				return object;
			},

			apply: (context, instance) => {

				let impostor = impostorFor(context, instance.entityKey);
				let data = instance.data;

				if(impostor == null)
					return;

				/*

					Velocity is deliberately not set here. This runs from
					onChange, which is before the frame reads back what the
					simulation produced, so setting it here would hand the
					document its own command instead of the result and gravity
					would never be seen at all. It is applied once per frame in
					onUpdate, after the reading is taken.

				*/

				if(data.damping != null && impostor.setDeltaPosition !== undefined)
					impostor.physicsBody != null &&
						(impostor.physicsBody.linearDamping = data.damping);

				if(data.angularDamping != null && impostor.physicsBody != null)
					impostor.physicsBody.angularDamping = data.angularDamping;

				if(data.sleep === false && impostor.physicsBody != null &&
					impostor.physicsBody.allowSleep !== undefined) {

					impostor.physicsBody.allowSleep = false;
				}

				/*

					A body meant to stay upright has to be told so. Anything
					standing taller than it is wide topples the moment it meets
					an edge, and a figure that has fallen over cannot be walked.

				*/
				if(isObject(data.freeze) && impostor.physicsBody != null) {

					let locked = Array.isArray(data.freeze.rotation) ?
						data.freeze.rotation : [true, true, true];

					let body = impostor.physicsBody;

					if(body.angularFactor != null &&
						body.angularFactor.set != null) {

						body.angularFactor.set(
							locked[0] ? 0 : 1,
							locked[1] ? 0 : 1,
							locked[2] ? 0 : 1
						);

					} else if(body.fixedRotation !== undefined) {

						/*

							Where only a whole-body lock is offered, asking for
							any axis takes all of them, which is what an upright
							character wants in any case.

						*/
						body.fixedRotation = locked.some(axis => axis);

						if(body.updateMassProperties != null)
							body.updateMassProperties();
					}

					impostor.setAngularVelocity(BABYLON.Vector3.Zero());
				}
			},

			onChange: (context, instance, previous) => {

				let mode = key => key.mode != null ? key.mode : "dynamic";

				if(mode(instance.data) !== mode(previous.data) ||
					instance.data.mass !== previous.data.mass) {

					rebuildImpostor(context, instance.entityKey);
				}

				operators[8].apply(context, instance);
			},

			onConsume: (context, instance, field, value) => {

				let impostor = impostorFor(context, instance.entityKey);

				if(impostor == null)
					return;

				/*

					Entity transform fields reach this operator because a
					dynamic body owns its entity's pose. Unlike the teleport
					field they preserve velocity, so that authoring a starting
					position does not also cancel an authored starting motion.

				*/
				if(field === "position" || field === "rotation" || field === "scale") {

					let mesh = impostor.object;
					let node = context.meta.nodes[instance.entityKey];

					[mesh, node].filter(target => target != null).forEach(target => {

						if(field === "position")
							target.position = vector(value);
						else if(field === "rotation")
							target.rotationQuaternion = quaternion(value);
						else
							target.scaling = scale(value);
					});

					if(mesh != null && mesh.computeWorldMatrix != null)
						mesh.computeWorldMatrix(true);

					return;
				}

				if(field === "impulse") {

					impostor.applyImpulse(
						vector(value), impostor.getObjectCenter()
					);

				} else if(field === "torque") {

					let current = impostor.getAngularVelocity();

					impostor.setAngularVelocity(current.add(vector(value)));

				} else if(field === "teleport" && isObject(value)) {

					let node = context.meta.nodes[instance.entityKey];

					if(node != null) {

						if(Array.isArray(value.position))
							node.position = vector(value.position);

						if(value.rotation != null)
							node.rotationQuaternion = quaternion(value.rotation);
					}

					impostor.setLinearVelocity(BABYLON.Vector3.Zero());
					impostor.setAngularVelocity(BABYLON.Vector3.Zero());
				}
			},

			onUpdate: (context, instance) => {

				let impostor = impostorFor(context, instance.entityKey);

				if(impostor == null)
					return;

				/*

					What the simulation produced is read first. Reporting after
					the command below would hand a document back its own
					request, so gravity would never be seen and a body told to
					rise once would rise for ever.

				*/
				let velocity = impostor.getLinearVelocity();
				let angular = impostor.getAngularVelocity();

				/*

					Then the command for the coming step. Velocity is reasserted
					every frame rather than only when it changes: setting it
					once and leaving it lets friction and the solver eat it, so
					a document holding a steady velocity — which is how anything
					is driven under its own power — comes to a halt and never
					moves again. A document that wants the solver to own
					velocity simply omits the field.

				*/
				/*

					A component given as null is left to the simulation. A body
					driven along the ground wants to say how fast it is going
					without saying anything about falling: reading the vertical
					back out and handing it in again feeds a value that is
					always a frame old into the value it came from, and the two
					settle into an oscillation instead of a fall.

				*/
				const drive = (axis, current) => {

					let asked = instance.data[axis];

					if(!Array.isArray(asked))
						return null;

					let live = axis === "velocity" ?
						impostor.getLinearVelocity() :
						impostor.getAngularVelocity();

					if(live == null)
						return null;

					return new BABYLON.Vector3(
						typeof asked[0] === "number" ? asked[0] : live.x,
						typeof asked[1] === "number" ? asked[1] : live.y,
						typeof asked[2] === "number" ? asked[2] : live.z
					);
				};

				let linear = drive("velocity");

				if(linear != null)
					impostor.setLinearVelocity(linear);

				let spin = drive("angular");

				if(spin != null)
					impostor.setAngularVelocity(spin);

				let contacts = context.meta.contacts[instance.entityKey];

				ace.setState(context, instance.record, {
					velocity: velocity != null ? array3(velocity) : [0, 0, 0],
					angular: angular != null ? array3(angular) : [0, 0, 0],
					sleeping: impostor.physicsBody?.sleepState === 2,
					grounded: (contacts != null ? contacts : []).some(
						contact => contact.normal[1] > 0.7
					)
				});
			},

			onDestroy: (context, instance) => {

				/* The impostor belongs to the collider, which disposes it. */
				let impostor = impostorFor(context, instance.entityKey);

				if(impostor != null)
					impostor.setMass(0);
			}
		},

		{	// joint -------------------------------------------------------
			type: "joint",
			order: 30,

			onCreate: (context, instance) => {

				let data = instance.data;
				let object = { joint: null };

				let source = impostorFor(context, instance.entityKey);

				if(source == null || !context.meta.physics)
					return object;

				let targetKey = instance.entityKey;

				if(data.target != null) {

					let element = ace.getElement(context.data, data.target);

					if(element == null) {

						ace.setState(context, instance.record, {
							broken: false,
							error: "joint target not found"
						});

						return object;
					}

					targetKey = ace.pathKey(element.path);
				}

				let target = impostorFor(context, targetKey);

				if(target == null)
					return object;

				let types = {
					fixed: BABYLON.PhysicsJoint.LockJoint,
					hinge: BABYLON.PhysicsJoint.HingeJoint,
					slider: BABYLON.PhysicsJoint.PrismaticJoint,
					ball: BABYLON.PhysicsJoint.BallAndSocketJoint,
					distance: BABYLON.PhysicsJoint.DistanceJoint,
					spring: BABYLON.PhysicsJoint.SpringJoint
				};

				let type = types[data.type != null ? data.type : "fixed"];

				if(type == null)
					type = BABYLON.PhysicsJoint.LockJoint;

				try {

					object.joint = new BABYLON.PhysicsJoint(type, {
						mainPivot: vector(data.anchor),
						connectedPivot: vector(data.targetAnchor),
						mainAxis: vector(data.axis, [0, 1, 0]),
						connectedAxis: vector(data.axis, [0, 1, 0]),
						nativeParams: {
							stiffness: data.stiffness,
							damping: data.damping
						}
					});

					source.addJoint(target, object.joint);

				} catch(error) {

					context.errors.push({
						type: "joint",
						hook: "onCreate",
						message: error.message
					});
				}

				ace.setState(context, instance.record, { broken: false });

				return object;
			},

			onChange: (context, instance) => {

				operators[9].onDestroy(context, instance);
				instance.object = operators[9].onCreate(context, instance);
			},

			onDestroy: (context, instance) => {

				let impostor = impostorFor(context, instance.entityKey);

				if(impostor != null && instance.object.joint != null) {

					try {

						impostor.removeJoint(instance.object.joint);

					} catch(error) { /* impostor already gone */ }
				}
			}
		},

		{	// audio -------------------------------------------------------
			type: "audio",

			onCreate: (context, instance) => {

				let object = {
					sound: null, disposed: false, started: false
				};

				beginAudio(context, instance, object);

				return object;
			},

			onChange: (context, instance) => {

				let sound = instance.object.sound;
				let data = instance.data;

				if(sound == null)
					return;

				if(data.volume != null)
					sound.setVolume(data.volume);

				sound.loop = data.loop === true;

				if(data.rate != null && sound.setPlaybackRate != null)
					sound.setPlaybackRate(data.rate);
			},

			onConsume: (context, instance, field, value) => {

				let sound = instance.object.sound;

				if(sound == null)
					return;

				/* Playback is impossible while the engine is still locked. */
				unlockAudio();

				if(field === "play") {

					sound.play(0, typeof value === "number" ? value : 0);

				} else if(field === "stop") {

					sound.stop();

				} else if(field === "seek") {

					sound.stop();
					sound.play(0, value);
				}
			},

			onUpdate: (context, instance) => {

				/* An engine that arrives late is still an engine. */
				if(!instance.object.started) {

					beginAudio(context, instance, instance.object);

					return;
				}

				let sound = instance.object.sound;

				if(sound == null)
					return;

				let engine = audioEngine();

				ace.setState(context, instance.record, {
					playing: sound.isPlaying === true,
					blocked: engine != null && engine.unlocked === false
				});
			},

			onDestroy: (context, instance) => {

				instance.object.disposed = true;

				if(instance.object.sound != null) {

					instance.object.sound.stop();
					instance.object.sound.dispose();
				}
			}
		},

		{	// animation ---------------------------------------------------
			type: "animation",
			order: 10,

			onCreate: (context, instance) => {

				let object = { group: null };

				operators[11].bind(context, instance, object);

				return object;
			},

			bind: (context, instance, object) => {

				let scene = context.meta.scene;
				let clip = instance.data.clip;

				if(clip == null)
					return;

				/*

					Every copy of a model brings groups with the same names, so a lookup
					by name across the scene always finds the first copy's. The entity's
					own mesh is asked first.

				*/
				let sibling = siblingInstance(context, instance, "mesh");
				let own = sibling?.object?.content?.animationGroups;

				/* A model still on its way has no groups yet, and the scene's belong to other copies. */
				if(sibling != null && sibling.source != null && own == null)
					return;

				let group = (own != null ? own : scene.animationGroups).find(
					candidate => candidate.name === clip
				);

				if(group == null && own != null) {

					group = scene.animationGroups.find(
						candidate => candidate.name === clip
					);
				}

				if(group == null)
					return;

				/*

					Switching clips has to stop the one being replaced. Leaving
					it running blends two poses together and the figure comes
					apart.

				*/
				if(object.group != null && object.group !== group) {

					/*

						With `blend` (seconds) the clip being replaced goes on playing
						while the new one is mixed in over it, and is stopped when the
						mix is whole. A switch made during a mix completes that one
						first.

					*/
					let blend = instance.data.blend != null ? instance.data.blend : 0;

					if(object.fading != null) {

						if(object.fading.out !== group)
							object.fading.out.stop();

						object.fading = null;
					}

					if(blend > 0 && object.group.isPlaying === true)
						object.fading = { out: object.group, start: performance.now(), duration: blend * 1000 };
					else
						object.group.stop();
				}

				object.group = group;

				group.speedRatio = instance.data.speed != null ?
					instance.data.speed : 1;

				/*

					With autoplay the selected clip plays whenever it is bound, which is
					what a document wants when it picks a clip by name and has no moment
					at which to issue the command.

				*/
				if(instance.data.autoplay === true && object.autoplayed !== group) {

					object.autoplayed = group;
					group.play(instance.data.loop !== false);

					if(object.fading != null)
						group.setWeightForAllAnimatables(0);
				}

				if(instance.data.weight != null && group.setWeightForAllAnimatables != null)
					group.setWeightForAllAnimatables(instance.data.weight);
			},

			onChange: (context, instance) => {

				operators[11].bind(context, instance, instance.object);
			},

			onConsume: (context, instance, field, value) => {

				let group = instance.object.group;

				if(group == null)
					return;

				if(field === "play") {

					group.play(instance.data.loop !== false);

					if(instance.object.fading != null)
						group.setWeightForAllAnimatables(0);

				} else if(field === "stop") {

					group.stop();

				} else if(field === "seek") {

					group.goToFrame(value);
				}
			},

			onUpdate: (context, instance) => {

				let group = instance.object.group;

				if(group == null) {

					/* A model may not have finished loading on the first frame. */
					operators[11].bind(context, instance, instance.object);

					ace.setState(context, instance.record, { playing: false });

					return;
				}

				let fade = instance.object.fading;

				if(fade != null) {

					let t = Math.min(1, (performance.now() - fade.start) / fade.duration);

					if(t >= 1) {

						fade.out.stop();
						instance.object.fading = null;
						group.setWeightForAllAnimatables(-1);

					} else {

						/* the new clip is mixed over the old one, which stays whole until it is stopped */
						group.setWeightForAllAnimatables(t * t * (3 - 2 * t));
					}
				}

				ace.setState(context, instance.record, {
					playing: group.isPlaying === true,
					time: group.animatables?.[0]?.masterFrame,
					duration: group.to - group.from,
					finished: group.isPlaying !== true &&
						instance.data.loop === false
				});
			},

			onDestroy: (context, instance) => {

				if(instance.object.fading != null)
					instance.object.fading.out.stop();

				if(instance.object.group != null)
					instance.object.group.stop();
			}
		},

		{	// query -------------------------------------------------------
			type: "query",
			order: 40,

			onCreate: (context, instance) => {

				operators[12].run(context, instance);

				return { };
			},

			onChange: (context, instance) => {

				operators[12].run(context, instance);
			},

			onUpdate: (context, instance) => {

				if(instance.data.continuous === true)
					operators[12].run(context, instance);
			},

			run: (context, instance) => {

				let scene = context.meta.scene;
				let data = instance.data;
				let type = data.type != null ? data.type : "ray";
				let limit = data.limit != null ? data.limit : 1;
				let hits = [];

				/*

					A query with no tags answers for anything in the scene,
					which is rarely what a probe wants: a ground probe that
					accepts the first surface below it will happily report the
					underside of whatever the player is walking beneath.

				*/
				let wanted = Array.isArray(data.tags) ? data.tags :
					typeof data.tags === "string" ? [data.tags] : null;

				let allowed = null;

				if(wanted != null) {

					let cache = context.meta.tagCache;

					if(cache == null || cache.frame !== context.frame)
						cache = context.meta.tagCache = { frame: context.frame, sets: new Map() };

					let id = wanted.join("|");

					if(!cache.sets.has(id)) {

						cache.sets.set(id, new Set(
							context.resolved.entities.filter(
								entity => entity.tags.some(tag => wanted.includes(tag))
							).map(entity => entity.key)
						));
					}

					allowed = cache.sets.get(id);
				}

				let predicate = allowed == null ? undefined : mesh => {

					if(mesh.isPickable === false)
						return false;

					let key = mesh.metadata?.aceEntity;

					/* (a predicate replaces Babylon's own check that a mesh is switched on) */
					return key != null && allowed.has(key) && mesh.isEnabled();
				};

				const describe = pick => {

					if(pick == null || !pick.hit)
						return null;

					let owner = pick.pickedMesh;
					let path = null;

					if(owner != null && owner.metadata?.aceEntity != null)
						path = JSON.parse(owner.metadata.aceEntity);

					while(owner != null && path == null) {

						let key = Object.keys(context.meta.nodes).find(
							candidate => context.meta.nodes[candidate] === owner
						);

						if(key != null)
							path = JSON.parse(key);
						else
							owner = owner.parent;
					}

					return {
						target: path != null ? path : null,
						point: pick.pickedPoint != null ?
							array3(pick.pickedPoint) : null,
						normal: pick.getNormal != null && pick.getNormal(true) != null ?
							array3(pick.getNormal(true)) : [0, 1, 0],
						distance: pick.distance
					};
				};

				if(type === "pick" && Array.isArray(data.screen)) {

					let size = context.meta.engine.getRenderWidth != null ? {
						width: context.meta.engine.getRenderWidth(),
						height: context.meta.engine.getRenderHeight()
					} : { width: 1, height: 1 };

					let pick = scene.pick(
						data.screen[0] * size.width,
						(1 - data.screen[1]) * size.height,
						predicate
					);

					let hit = describe(pick);

					if(hit != null)
						hits.push(hit);

				} else if(type === "overlap") {

					/*

						An overlap answers for everything within a radius rather
						than along a line, which is what a body needs in order
						to be pushed out of the things it has walked into. The
						normal points from the other body toward the query, so a
						document can move along it to separate them.

						The test is against world bounding volumes, so it is an
						approximation, and a generous one for long thin shapes
						held at an angle.

					*/
					let centre = Array.isArray(data.origin) ?
						vector(data.origin) :
						(context.meta.nodes[instance.entityKey] != null ?
							context.meta.nodes[instance.entityKey]
								.getAbsolutePosition().clone() :
							BABYLON.Vector3.Zero());

					if(Array.isArray(data.offset))
						centre.addInPlace(vector(data.offset));

					let radius =
						typeof data.shape?.size === "number" ? data.shape.size :
						Array.isArray(data.shape?.size) ? data.shape.size[0] :
						data.distance != null ? data.distance : 1;

					scene.meshes.forEach(mesh => {

						if(mesh.isEnabled() === false)
							return;

						if(predicate != null ? !predicate(mesh) :
							mesh.isPickable === false) {

							return;
						}

						if(mesh.metadata?.aceEntity == null ||
							mesh.getTotalVertices == null ||
							mesh.getTotalVertices() === 0) {

							return;
						}

						mesh.computeWorldMatrix(false);

						let box = mesh.getBoundingInfo().boundingBox;
						let min = box.minimumWorld;
						let max = box.maximumWorld;

						let closest = new BABYLON.Vector3(
							Math.min(Math.max(centre.x, min.x), max.x),
							Math.min(Math.max(centre.y, min.y), max.y),
							Math.min(Math.max(centre.z, min.z), max.z)
						);

						let delta = centre.subtract(closest);
						let distance = delta.length();

						if(distance > radius)
							return;

						/* A still mesh answers for its triangles, not for the box round them. */
						if(preciseCapable(mesh)) {

							let found = preciseNearest(mesh, centre, radius);

							if(found == null)
								return;

							let away = centre.subtract(new BABYLON.Vector3(
								found.point[0], found.point[1], found.point[2]
							));
							let length = away.length();

							/* On the surface itself there is no direction: up is as good as any, and the walker's push is lateral anyway. */
							let direction = length > 1e-5 ? away.scale(1 / length) : new BABYLON.Vector3(0, 1, 0);

							hits.push({
								target: JSON.parse(mesh.metadata.aceEntity),
								point: found.point.map(v => Math.round(v * 1000) / 1000),
								normal: array3(direction),
								distance: found.distance
							});

							return;
						}

						let normal;

						if(distance > 1e-6) {

							normal = delta.scale(1 / distance);

						} else {

							/*

								The query is inside the volume, so there is no
								direction away from the surface to report, and
								the shortest way out has to be chosen.

								Only the sides are considered. The floor of a
								volume a body is standing inside is usually the
								nearest face of all, and answering with it says
								the way out is downwards, which is no use to
								anything that walks. Separating vertically is
								the ground probe's business; an overlap answers
								laterally.

							*/
							let faces = [
								[new BABYLON.Vector3(-1, 0, 0), centre.x - min.x],
								[new BABYLON.Vector3(1, 0, 0), max.x - centre.x],
								[new BABYLON.Vector3(0, 0, -1), centre.z - min.z],
								[new BABYLON.Vector3(0, 0, 1), max.z - centre.z]
							];

							let escape = faces.reduce(
								(best, face) => face[1] < best[1] ? face : best
							);

							normal = escape[0];

							/*

								Inside, the distance is reported as how far in
								the query has gone, negatively. Answering zero
								would have a document separate by a fixed amount
								however deep it was, and anything moving faster
								than that per frame walks straight through.

							*/
							distance = -escape[1];
						}

						hits.push({
							target: JSON.parse(mesh.metadata.aceEntity),
							point: array3(closest),
							normal: array3(normal),
							distance
						});
					});

					/* Things that are drawn as instances answer from their tables. */
					if(ace.adapter.collide != null)
						ace.adapter.collide(context, centre, radius, allowed, hits);

				} else if(type === "ray" || type === "shape") {

					let origin = Array.isArray(data.origin) ?
						vector(data.origin) :
						(context.meta.nodes[instance.entityKey] != null ?
							context.meta.nodes[instance.entityKey]
								.getAbsolutePosition().clone() :
							BABYLON.Vector3.Zero());

					/*

						An offset lets a probe track its entity without the
						document rewriting the origin every frame.

					*/
					if(Array.isArray(data.offset))
						origin.addInPlace(vector(data.offset));

					let direction = vector(data.direction, [0, 0, -1]).normalize();
					let distance = data.distance != null ? data.distance : 1000;

					let ray = new BABYLON.Ray(origin, direction, distance);

					if(limit === 1) {

						/* Straight down at the terrain: answered from its height grid, not its triangles. */
						let fast = allowed != null && ace.adapter.groundAt != null &&
							type === "ray" && direction.y < -0.999 ?
							ace.adapter.groundAt(context, origin.x, origin.z, allowed) : null;

						if(fast != null) {

							/* Only a probe that asks (surfaces: "all") pays for the triangles of everything else; most only want the ground. */
							let terrainKeys = new Set((context.meta.terrains || []).map(entry => entry.key));
							let other = data.surfaces === "all" ? scene.pickWithRay(ray, mesh =>
								predicate(mesh) && !terrainKeys.has(mesh.metadata?.aceEntity)
							) : null;
							let top = fast.y;
							let away = origin.y - fast.y;

							/* A bridge, a roof or a floor above the ground answers for itself if it is nearer to the ray's start. */
							if(other != null && other.hit && other.pickedPoint != null &&
								other.pickedPoint.y > fast.y) {

								hits.push(describe(other));

							} else if((away >= 0 || data.under === true) && Math.abs(away) <= distance) {

								/* With `under`, a ray that starts below the ground still answers with it, at a negative distance. */
								hits.push({
									target: fast.target,
									point: [origin.x, fast.y, origin.z],
									normal: fast.normal,
									distance: away
								});
							}

						} else {

							let hit = describe(scene.pickWithRay(ray, predicate));

							if(hit != null)
								hits.push(hit);
						}

					} else {

						(scene.multiPickWithRay(ray, predicate) || []).forEach(pick => {

							let hit = describe(pick);

							if(hit != null)
								hits.push(hit);
						});
					}
				}

				hits.sort((a, b) => a.distance - b.distance);

				if(limit > 0)
					hits = hits.slice(0, limit);

				ace.setState(context, instance.record, { hits });
			},

			onDestroy: () => { }
		},

		{	// script — instantiated so that scripts appear in the instance
			// set for tooling; execution itself is handled by the core.
			type: "script",
			onCreate: () => ({ })
		}
	];

	// ------------------------------------------------------------ reserved

	const DIGITAL = {
		/* The xr-standard mapping, in button order. */
		xr: ["trigger", "squeeze", "touchpad", "thumbstick", "a", "b"],
		gamepad: [
			"a", "b", "x", "y", "left-bumper", "right-bumper",
			null, null, "select", "start", "left-stick", "right-stick",
			"up", "down", "left", "right", "home"
		],
		xr: ["trigger", "squeeze", "touchpad", "thumbstick", "a", "b"]
	};

	const input = {

		controllers: { },
		gesture: false,
		attached: false,
		locked: false,
		surface: null,

		/* Accepts an injected event target, so input is testable headlessly. */
		attach: target => {

			if(target == null || input.attached)
				return;

			input.attached = true;
			input.surface = target;

			let keyboard = input.device("keyboard", 0);
			let pointer = input.device("pointer", 0);

			const on = (name, handler) =>
				target.addEventListener(name, handler);

			/*

				Keys are heard by the whole page, not by the canvas: a canvas
				hears them only while it has focus, and focus is lost whenever
				the pointer is given back (a menu opening) or the page is
				clicked outside it. A key that moves focus or scrolls the page
				is kept from doing so.

			*/
			let keyed = target.ownerDocument != null &&
				target.ownerDocument.addEventListener != null ?
				target.ownerDocument : target;

			const onKey = (name, handler) => keyed.addEventListener(name, handler);
			const KEEP = ["Tab", "Space", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"];

			if(target.setAttribute != null)
				target.setAttribute("tabindex", "0");

			const gesture = () => {

				input.gesture = true;

				unlockAudio();
			};

			/*

				The runtime's own entry button is not the canvas, so a gesture
				is watched for across the whole document as well.

			*/
			let owner = target.ownerDocument;

			if(owner != null && owner.addEventListener != null) {

				["pointerdown", "keydown"].forEach(name =>
					owner.addEventListener(name, gesture, { capture: true })
				);
			}

			onKey("keydown", event => {

				gesture();

				if(KEEP.includes(event.code))
					event.preventDefault();

				if(!keyboard.digital.includes(event.code)) {

					keyboard.digital.push(event.code);
					keyboard.pressed.push(event.code);
				}
			});

			onKey("keyup", event => {

				keyboard.digital = keyboard.digital.filter(
					code => code !== event.code
				);

				keyboard.released.push(event.code);
			});

			on("pointerdown", event => {

				gesture();

				let id = "button" + event.button;

				if(!pointer.digital.includes(id)) {

					pointer.digital.push(id);
					pointer.pressed.push(id);
				}
			});

			on("pointerup", event => {

				let id = "button" + event.button;

				pointer.digital = pointer.digital.filter(
					candidate => candidate !== id
				);

				pointer.released.push(id);
			});

			on("pointermove", event => {

				let width = event.target?.clientWidth != null ?
					event.target.clientWidth : 1;

				let height = event.target?.clientHeight != null ?
					event.target.clientHeight : 1;

				let x = event.clientX / width;
				let y = 1 - event.clientY / height;

				/*

					Under pointer lock the cursor has no position, only motion,
					and movementX/Y is the only meaningful signal. Both are
					reported in the same normalised units so that a document
					reading dx and dy behaves the same either way.

				*/
				if(input.locked && event.movementX != null) {

					pointer.analog.dx =
						(pointer.analog.dx != null ? pointer.analog.dx : 0) +
						event.movementX / width;

					pointer.analog.dy =
						(pointer.analog.dy != null ? pointer.analog.dy : 0) -
						event.movementY / height;

				} else {

					pointer.analog.dx =
						x - (pointer.analog.x != null ? pointer.analog.x : x);

					pointer.analog.dy =
						y - (pointer.analog.y != null ? pointer.analog.y : y);
				}

				pointer.analog.x = x;
				pointer.analog.y = y;
				pointer.analog.pressure = event.pressure != null ? event.pressure : 0;
			});

			on("wheel", event => {

				pointer.analog.wheel = event.deltaY;
			});
		},

		device: (kind, index, handedness) => {

			let id = kind + "-" + index;

			if(input.controllers[id] == null) {

				input.controllers[id] = {
					device: kind,
					index,
					handedness: handedness != null ? handedness : "none",
					connected: true,
					digital: [],
					pressed: [],
					released: [],
					analog: { }
				};
			}

			return input.controllers[id];
		},

		/*

			Tracked controllers are polled from the session rather than from the
			gamepad API, but they are published as the same controller component
			as a keyboard or a pad, with a pose and a pointing ray added. A
			document reads a thumbstick the same way whatever it is attached to.

		*/
		xr: context => {

			let experience = context.meta.xr;
			let base = experience != null ? experience.baseExperience : null;

			let live = { };

			let presenting = base != null &&
				base.state === BABYLON.WebXRState.IN_XR;

			if(presenting && experience.input != null) {

				(experience.input.controllers != null ?
					experience.input.controllers : []
				).forEach(source => {

					let hand = source.inputSource?.handedness != null ?
						source.inputSource.handedness : "none";

					let controller = input.device("xr-controller", hand, hand);

					live["xr-controller-" + hand] = true;

					let pad = source.inputSource?.gamepad;
					let previous = controller.digital;

					controller.digital = [];

					if(pad != null) {

						pad.buttons.forEach((button, slot) => {

							let name = DIGITAL.xr[slot];

							if(name != null && button.pressed)
								controller.digital.push(name);
						});

						let dead = controller.deadzone != null ?
							controller.deadzone : 0.1;

						const axis = value =>
							value == null || Math.abs(value) < dead ? 0 : value;

						/*

							WebXR reports a stick pushed away from the user as
							negative, which is the opposite of the convention
							every other device here uses.

						*/
						controller.analog = {
							"touchpad-x": axis(pad.axes[0]),
							"touchpad-y": axis(-pad.axes[1]),
							"thumbstick-x": axis(pad.axes[2]),
							"thumbstick-y": axis(-pad.axes[3]),
							trigger: pad.buttons[0]?.value != null ?
								pad.buttons[0].value : 0,
							squeeze: pad.buttons[1]?.value != null ?
								pad.buttons[1].value : 0
						};
					}

					controller.pressed = controller.digital.filter(
						name => !previous.includes(name)
					);

					controller.released = previous.filter(
						name => !controller.digital.includes(name)
					);

					let node = source.grip != null ? source.grip : source.pointer;

					if(node != null) {

						node.computeWorldMatrix(true);

						controller.pose = {
							position: array3(node.absolutePosition),
							rotation: array4(
								node.absoluteRotationQuaternion != null ?
									node.absoluteRotationQuaternion :
									BABYLON.Quaternion.Identity()
							)
						};
					}

					/*

						The pointing ray is asked for rather than derived from
						the pointer node, since which local axis points forward
						is a detail of how the session was imported.

					*/
					if(source.getWorldPointerRayToRef != null) {

						if(context.meta.ray == null) {

							context.meta.ray = new BABYLON.Ray(
								BABYLON.Vector3.Zero(),
								new BABYLON.Vector3(0, 0, -1)
							);
						}

						source.getWorldPointerRayToRef(context.meta.ray);

						controller.ray = {
							origin: array3(context.meta.ray.origin),
							direction: array3(context.meta.ray.direction)
						};

						/*

							The same ray in the frame of the entity the view hangs
							off, which is the frame a camera-space entity (a menu,
							a heads-up display) is laid out in. A document aims at
							its own interface with this, whatever the headset's
							reference space has been moved to.

						*/
						let view = viewNode(context);

						if(view != null) {

							view.computeWorldMatrix(true);

							let inverse = BABYLON.Matrix.Invert(view.getWorldMatrix());

							controller.local = {
								origin: array3(BABYLON.Vector3.TransformCoordinates(
									context.meta.ray.origin, inverse)),
								direction: array3(BABYLON.Vector3.TransformNormal(
									context.meta.ray.direction, inverse))
							};
						}
					}
				});
			}

			/* A controller that has gone is removed, not left stale. */
			Object.keys(input.controllers).filter(
				id => id.startsWith("xr-controller-") && !live[id]
			).forEach(id => delete input.controllers[id]);

			return presenting;
		},

		/* Polls devices that do not deliver events, then publishes a frame. */
		poll: () => {

			let navigator = root.navigator;

			if(navigator != null && navigator.getGamepads != null) {

				Array.from(navigator.getGamepads()).forEach((pad, index) => {

					if(pad == null)
						return;

					let controller = input.device("gamepad", index);
					let previous = controller.digital;

					controller.digital = [];

					pad.buttons.forEach((button, slot) => {

						let name = DIGITAL.gamepad[slot];

						if(name != null && button.pressed)
							controller.digital.push(name);
					});

					controller.pressed = controller.digital.filter(
						name => !previous.includes(name)
					);

					controller.released = previous.filter(
						name => !controller.digital.includes(name)
					);

					let deadzone = 0.1;

					let axis = value =>
						Math.abs(value) < deadzone ? 0 : value;

					controller.analog = {
						"left-x": axis(pad.axes[0]),
						"left-y": axis(-pad.axes[1]),
						"right-x": axis(pad.axes[2]),
						"right-y": axis(-pad.axes[3]),
						"left-trigger": pad.buttons[6]?.value,
						"right-trigger": pad.buttons[7]?.value
					};
				});
			}

			return input.controllers;
		},

		/* Edge lists are valid for exactly one frame. */
		flush: () => {

			Object.values(input.controllers).forEach(controller => {

				controller.pressed = [];
				controller.released = [];
				controller.analog.dx = 0;
				controller.analog.dy = 0;
				controller.analog.wheel = 0;
			});
		}
	};

	// -------------------------------------------------------------- adapter

	const adapter = {

		input,
		operators,

		/* Shared with operator files that extend the adapter (aceWorld.js). */
		helpers: {
			nodeFor, own, vector, quaternion, scale, color, color3,
			recordFor, siblingInstance, array3, array4
		},

		/* Passed to any engine the adapter builds for itself. */
		engineOptions: {
			audioEngine: true,
			preserveDrawingBuffer: true,
			stencil: true
		},

		onSync: context => {

			/*

				One clock. A host that measures its own frames supplies the
				duration; a host that does not is given the fixed step, which
				is also what the simulation advances by. Deriving the two from
				different sources leaves the scripts and the solver disagreeing
				about how much time a frame was, and a document driving a body
				under its own power then asks for a speed it never reaches.

				It also makes a run without a display reproducible, since
				nothing is left depending on how long a frame happened to take.

			*/
			let measured = context.meta.engine.getDeltaTime != null ?
				context.meta.engine.getDeltaTime() : 0;

			let fixed = context.meta.step != null ? context.meta.step : 1 / 60;

			let unscaled = measured > 0 ?
				Math.min(measured / 1000, 0.25) : fixed;
			context.meta.gesture = input.gesture;

			/*

				Suppress Babylon's unmute overlay before it can be shown, and
				take any chance to resume a context the browser suspended.

			*/
			let audio = audioEngine();

			if(audio != null) {

				audio.useCustomUnlockedButton = true;

				if(input.gesture && !audio.unlocked)
					unlockAudio();
			}

			let scale = context.meta.timeScale != null ?
				context.meta.timeScale : 1;

			context.meta.elapsed =
				(context.meta.elapsed != null ? context.meta.elapsed : 0) +
				unscaled * scale;

			/* The same duration the simulation will be advanced by. */
			context.meta.frame = unscaled * scale;

			let presenting = input.xr(context);

			/*

				A headset delivers no pointer events to the canvas, so the
				gesture that unblocks audio never arrives by the usual route.
				Entering a session is itself a deliberate act by the wearer and
				is treated as one.

			*/
			if(presenting && !input.gesture) {

				input.gesture = true;

				unlockAudio();
			}

			let controllers = { };

			Object.entries(input.poll()).forEach(([id, controller]) => {

				controllers[id] = {
					properties: {
						tags: ["controller", ace.TAG],
						data: { },
						state: JSON.parse(JSON.stringify(controller))
					}
				};
			});

			let engine = context.meta.engine;

			/*

				The reserved entity is rewritten every frame, but its data
				objects are authored — time scale, cursor mode — and belong to
				the document. They are carried across the rewrite; only state
				is replaced.

			*/
			let existing = context.data.packages != null ?
				context.data.packages[ace.RESERVED] : null;

			const carry = alias => {

				let data = existing?.utilities?.[alias]?.properties?.data;

				return isObject(data) ? data : { };
			};

			let timeData = carry("time");
			let displayData = carry("display");

			scale = timeData.scale != null ? timeData.scale : 1;

			context.meta.timeScale = scale;
			context.meta.frameDelta = unscaled * scale;

			adapter.cursor(context, displayData.cursor);

			let reserved = {
				utilities: {
					time: {
						properties: {
							tags: ["time", ace.TAG],
							data: timeData,
							state: {
								delta: unscaled * scale,
								unscaled,
								elapsed: context.meta.elapsed,
								frame: context.frame,
								step: 1 / 60,
								now: Date.now()
							}
						}
					},
					display: {
						properties: {
							tags: ["display", ace.TAG],
							data: displayData,
							state: {
								size: [
									engine.getRenderWidth(),
									engine.getRenderHeight()
								],
								ratio: engine.getHardwareScalingLevel != null ?
									1 / engine.getHardwareScalingLevel() : 1,
								aspect: engine.getRenderWidth() /
									Math.max(engine.getRenderHeight(), 1),
								focused: true,
								fullscreen: false,
								gesture: input.gesture,
								locked: input.locked,
								fps: engine.getFps != null ?
									Math.round(engine.getFps()) : 0,
								xr: {
									presenting,
									mode: presenting ?
										context.meta.xr?.baseExperience
											?.sessionManager?.sessionMode : null
								}
							}
						}
					}
				},
				packages: {
					controllers: { utilities: controllers }
				}
			};

			context.data.packages = context.data.packages != null ?
				context.data.packages : { };

			/* State is rewritten wholesale; script writes to it never survive. */
			context.data.packages[ace.RESERVED] = reserved;
		},

		/*

			Entity transforms are applied here, after component reconciliation,
			so that a node created lazily during onCreate is positioned in the
			same frame it appears.

		*/
		onReflect: context => {

			let live = { };

			/*

				A world far larger than a float can place (a planet a hundred
				million kilometres from its star, a ship a metre from the ground)
				names the entity the view is at: `world.origin`. The document keeps
				every position as it is, in numbers with room for it, and each
				entity at the top of the document is put where it is *relative to
				that one* by subtraction done here, before the engine ever sees
				a coordinate too big for it. What is near the viewer is then
				exact, and what is far is far enough for the error not to show.

			*/
			let origin = null;
			{
				let world = context.resolved.components.find(component => component.type === "world");
				let reference = world != null && world.data != null ? world.data.origin : null;

				if(reference != null) {

					let wanted = (Array.isArray(reference) ? reference : String(reference).split(".")).join(".");
					let record = context.resolved.entities.find(entity => entity.path.join(".") === wanted);

					if(record != null && Array.isArray(record.data.position))
						origin = record.data.position;
				}
			}

			context.meta.origin = origin != null ? origin.slice() : null;

			/* the entities it applies to: those with no transform above them, however many packages they are filed under */
			let byPath = new Map(), topMemo = new Map();

			if(origin != null)
				context.resolved.entities.forEach(entity => byPath.set(entity.path.join(" "), entity));

			const isTop = record => {

				let key = record.path.join(" ");

				if(topMemo.has(key))
					return topMemo.get(key);

				let top = true;

				for(let length = 1; length < record.path.length && top; length++) {

					let above = byPath.get(record.path.slice(0, length).join(" "));

					if(above != null && (Array.isArray(above.data.position) || above.data.rotation != null || above.data.scale != null))
						top = false;
				}

				topMemo.set(key, top);

				return top;
			};

			/*

				Bodies and colliders are looked up for every entity every frame, so
				they are indexed once here rather than searched for.

			*/
			let bodyOf = new Map(), colliderOf = new Map();

			context.resolved.components.forEach(component => {

				if(component.type === "body")
					bodyOf.set(component.entityKey, component);
				else if(component.type === "collider")
					colliderOf.set(component.entityKey, component);
			});

			/*

				Everything under an entity that is switched off is asleep: it cannot
				be seen, it cannot move (nothing is moving it), and its transform
				need not be read every frame. Once it has been set up, an entity
				with a switched-off ancestor is left alone until the ancestor is
				switched on. A world that keeps a whole island, or a building's
				rooms, behind one switch costs nothing for them while it is off.

			*/
			let named = new Map();

			context.resolved.entities.forEach(record =>
				named.set(record.path.join(""), record.data.enabled === false)
			);

			let sleepMemo = new Map();

			const above = path => {

				if(path.length <= 1)
					return false;

				let parent = path.slice(0, -1);
				let key = parent.join("");
				let value = sleepMemo.get(key);

				if(value === undefined) {

					value = named.get(key) === true || above(parent);
					sleepMemo.set(key, value);
				}

				return value;
			};

			context.resolved.entities.filter(
				record => record.scene !== false
			).forEach(record => {

				live[record.key] = true;

				if(context.meta.applied[record.key] !== undefined && above(record.path))
					return;

				let node = nodeFor(context, record.path);
				let data = record.data;

				let body = bodyOf.get(record.key);

				if(body != null && !(body.data.mode == null || body.data.mode === "dynamic"))
					body = null;

				let driven = body != null && context.meta.physics;
				let previous = context.meta.applied[record.key];
				let signature = JSON.stringify([
					data.position, data.rotation, data.scale
				]);

				let collider = colliderOf.get(record.key);

				let simulated = collider != null ?
					context.instances[ace.identity(collider)]?.object : null;

				let simulatedMesh = simulated != null &&
					simulated.impostor != null ? simulated.mesh : null;

				/*

					A dynamic body simulates in world space, so its entity is
					detached from its parent's transform and follows the
					simulation rather than the document.

				*/
				if(driven && simulatedMesh != null) {

					/*

						An invisible collision proxy is never drawn, so nothing
						else recomputes its world matrix, and its absolute
						position stays as stale as the last time something did.
						The body moves correctly and the document is told it has
						barely moved at all.

					*/
					simulatedMesh.computeWorldMatrix(true);

					if(previous !== signature) {

						if(Array.isArray(data.position))
							simulatedMesh.position = vector(data.position);

						if(data.rotation != null) {

							simulatedMesh.rotationQuaternion =
								quaternion(data.rotation);
						}

						simulatedMesh.computeWorldMatrix(true);
					}

					node.parent = null;
					node.position = simulatedMesh.absolutePosition.clone();

					node.rotationQuaternion = (
						simulatedMesh.rotationQuaternion != null ?
							simulatedMesh.rotationQuaternion :
							BABYLON.Quaternion.Identity()
					).clone();

				} else {

					/*

						A camera-space entity rides the view. Its transform is
						read in the active camera's frame, which is how a
						heads-up display is expressed without a separate
						component family.

					*/
					if(data.space === "camera" || data.space === "screen") {

						if(context.meta.viewFrame !== context.frame) {

							context.meta.viewFrame = context.frame;
							context.meta.viewCached = viewNode(context);
						}

						let view = context.meta.viewCached;

						if(view != null && view !== node && node.parent !== view)
							node.parent = view;
					}

					/*

						Authored transform values are applied only when they
						change, so that they read as a teleport rather than a
						per-frame override that would fight the solver.

					*/
					if(previous !== signature) {

						if(Array.isArray(data.position))
							node.position = vector(data.position);

						if(data.rotation != null)
							node.rotationQuaternion = quaternion(data.rotation);

						if(data.scale != null)
							node.scaling = scale(data.scale);
					}
				}

				let shifted = false;

				if(origin != null && !driven && isTop(record) && Array.isArray(data.position) &&
					data.space !== "camera" && data.space !== "screen") {

					node.position.set(
						data.position[0] - origin[0],
						data.position[1] - origin[1],
						data.position[2] - origin[2]
					);

					shifted = true;
				}

				context.meta.applied[record.key] = signature;

				node.setEnabled(data.enabled !== false);

				/*

					A node that has not been moved is not forced to recompute: Babylon
					still notices when an ancestor has, and the work is otherwise spent
					every frame on every entity in the document.

				*/
				if(node.computeWorldMatrix != null)
					node.computeWorldMatrix(previous !== signature || shifted);

				/*

					A static or kinematic collider is carried by its entity.
					The transform is written only when the entity has actually
					moved: rewriting a resting body's transform on every step
					perturbs the solver and injects energy into anything
					resting on it.

				*/
				if(!driven && simulatedMesh != null) {

					let pose = node.absolutePosition.asArray().concat(
						(node.absoluteRotationQuaternion != null ?
							node.absoluteRotationQuaternion :
							BABYLON.Quaternion.Identity()).asArray()
					);

					let carried = context.meta.carried[record.key];

					if(carried == null ||
						pose.some((value, index) =>
							Math.abs(value - carried[index]) > 1e-6)) {

						simulatedMesh.position = node.absolutePosition.clone();

						simulatedMesh.rotationQuaternion = (
							node.absoluteRotationQuaternion != null ?
								node.absoluteRotationQuaternion :
								BABYLON.Quaternion.Identity()
						).clone();

						simulatedMesh.computeWorldMatrix(true);

						context.meta.carried[record.key] = pose;
					}
				}

				/*

					World matrices are normally refreshed by the render pass,
					which does not run when a document declares no camera.
					Queries and bounds must still be correct in that case.

				*/
				if(node.getChildMeshes != null &&
					(previous !== signature || context.meta.canvas == null)) {

					node.getChildMeshes().forEach(
						mesh => mesh.computeWorldMatrix(true)
					);
				}

				let world = { position: node.absolutePosition };

				ace.setState(context, record, {
					position: array3(world.position),
					rotation: array4(
						node.absoluteRotationQuaternion != null ?
							node.absoluteRotationQuaternion :
							BABYLON.Quaternion.Identity()
					),
					scale: array3(node.absoluteScaling != null ?
						node.absoluteScaling : node.scaling)
				});
			});

			Object.keys(context.meta.nodes).forEach(key => {

				if(live[key])
					return;

				context.meta.nodes[key].dispose();

				delete context.meta.nodes[key];
				delete context.meta.applied[key];
				delete context.meta.carried[key];

				ace.clearState(context, key);
			});
		},

		/*

			Pointer lock can only be requested from inside a user gesture, so a
			document asking for it is honoured on the next click rather than
			immediately.

		*/
		cursor: (context, mode) => {

			let surface = input.surface;

			if(surface == null || surface.requestPointerLock == null)
				return;

			let owner = surface.ownerDocument;

			input.locked = owner != null &&
				owner.pointerLockElement === surface;

			/*

				The mode the document wants is remembered, so that a click made
				while a menu is open does not capture the pointer, and one made
				on "resume" does.

			*/
			context.meta.cursorMode = mode;

			const request = () => {

				if(input.locked || context.meta.cursorMode !== "locked")
					return;

				let promise = surface.requestPointerLock();

				if(promise != null && promise.catch != null)
					promise.catch(() => { });
			};

			if(!context.meta.lockPending) {

				context.meta.lockPending = true;

				surface.addEventListener("click", request);
			}

			/* A document that asks for the lock just after a click may have it at once. */
			let activation = root.navigator != null ? root.navigator.userActivation : null;

			if(mode === "locked" && !input.locked && activation != null &&
				activation.isActive && root.performance.now() -
				(context.meta.lockAsked != null ? context.meta.lockAsked : -1e9) > 1500) {

				context.meta.lockAsked = root.performance.now();
				request();
			}

			if(mode !== "locked" && input.locked && owner.exitPointerLock != null)
				owner.exitPointerLock();

			if(surface.style != null)
				surface.style.cursor = mode === "hidden" ? "none" : "";
		},

		onDispose: context => {

			Object.values(context.meta.nodes).forEach(node => node.dispose());

			context.meta.nodes = { };
			context.meta.applied = { };
			context.meta.carried = { };

			if(context.meta.scene != null)
				context.meta.scene.dispose();

			if(context.meta.ownsEngine && context.meta.engine != null)
				context.meta.engine.dispose();

			if(context.meta.resize != null && typeof root.removeEventListener === "function")
				root.removeEventListener("resize", context.meta.resize);
		},

		/*

			Collision events are gathered from the physics plugin once per
			frame and indexed by entity so that colliders can publish them as
			reflected state.

		*/
		observe: context => {

			let scene = context.meta.scene;

			if(!context.meta.physics || context.meta.observing)
				return;

			context.meta.observing = true;

			scene.onAfterPhysicsObservable.add(() => {

				context.meta.contacts = { };
			});
		},

		/* Creates a context bound to a Babylon scene. */
		context: (data, options) => {

			options = options != null ? options : { };

			let engine = options.engine;
			let ownsEngine = false;
			let canvas = null;

			if(engine == null) {

				if(options.canvas != null) {

					canvas = options.canvas;

					/*

						audioEngine is opt-in and has no default, so Babylon
						creates no audio engine at all unless it is asked. A
						document with an audio component then reports that none
						is available, which is accurate and entirely the host's
						fault.

					*/
					engine = new BABYLON.Engine(
						canvas, true, adapter.engineOptions, true
					);

				} else {

					engine = new BABYLON.NullEngine();
				}

				ownsEngine = true;
			}

			/*

				A depth buffer keeps most of its precision for what is close, and a
				world a few centimetres from the camera and sixteen kilometres to the
				horizon spends it all there: two surfaces a metre apart a kilometre
				away are one depth to the buffer, and flicker as one drawn through the
				other. Reversing it (near is 1, far is 0, in floating point) spreads
				the precision evenly across the whole range.

			*/
			if(hasDOM && options.reverseDepth !== false && engine.getCaps != null) {

				try { engine.useReverseDepthBuffer = true; } catch(error) { /* an old GPU */ }
			}

			let scene = new BABYLON.Scene(engine);

			/* Standard 2.2.3: right-handed, Y-up. Babylon defaults to left. */
			scene.useRightHandedSystem = true;

			scene.clearColor = new BABYLON.Color4(0, 0, 0, 1);

			/*

				Overlays (a heads-up display, a menu) are drawn in group 1 on a cleared depth buffer, so
				that a wall between the viewer and the display does not hide it, and the display can be
				put far from the camera and made large: far from the world's origin a position is only
				good to a few millimetres, which at a metre is a visible shiver and at ten metres is not.

			*/
			scene.setRenderingAutoClearDepthStencil(1, true, true, true);

			let context = ace.context(data, {
				engine,
				scene,
				canvas,
				ownsEngine,
				nodes: { },
				applied: { },
				carried: { },
				contacts: { },
				physics: false,
				gesture: false,
				xr: []
			});

			if(canvas != null) {

				input.attach(canvas);

				context.meta.resize = () => engine.resize();

				root.addEventListener("resize", context.meta.resize);
			}

			return context;
		},

		/* One reconciliation pass plus a render. */
		step: context => {

			ace.step(context);

			adapter.observe(context);

			if(context.meta.scene.activeCamera != null)
				context.meta.scene.render();

			/*

				Physics is advanced by the render pass. A document that declares
				no camera never renders, so the step is driven explicitly in
				that case — and only in that case, since Babylon already
				substitutes a fixed step for a non-positive delta and stepping
				again here would advance the simulation twice per frame.

			*/
			let physics = context.meta.scene.getPhysicsEngine != null ?
				context.meta.scene.getPhysicsEngine() : null;

			if(physics != null && typeof physics._step === "function") {

				let step = context.meta.step != null ? context.meta.step : 1 / 60;

				/*

					A host with no frame timing — a headless runtime, or a test
					— advances exactly one step per frame, which makes a
					document's behaviour reproducible. A host that reports real
					elapsed time catches up to it, capped so that a long stall
					cannot spiral.

				*/
				/*

					Advanced by the same duration the frame told the scripts
					about, so that what a document asks for and what the solver
					delivers are measured against one clock.

				*/
				context.meta.accumulator =
					(context.meta.accumulator != null ?
						context.meta.accumulator : 0) +
					(context.meta.frame != null ? context.meta.frame : step);

				let iterations = 0;

				let ceiling = Math.max(5, Math.ceil(
					(context.meta.timeScale != null ?
						context.meta.timeScale : 1) * 4
				));

				while(context.meta.accumulator >= step && iterations < ceiling) {

					physics._step(step);

					context.meta.accumulator -= step;
					iterations++;
				}

				/* A backlog beyond the ceiling is dropped, not carried. */
				if(context.meta.accumulator > step * ceiling)
					context.meta.accumulator = 0;
			}

			input.flush();

			return context;
		},

		run: (selector, data) => {

			let element = typeof selector === "string" ?
				root.document.querySelector(selector) : selector;

			element.innerHTML =
				"<canvas style=\"width: 100%; height: 100%; " +
				"touch-action: none;\"></canvas>";

			let context = adapter.context(data, {
				canvas: element.children[0]
			});

			context.running = true;

			context.meta.engine.runRenderLoop(() => {

				if(!context.running)
					return;

				adapter.step(context);
			});

			return context;
		}
	};

	ace.register(operators);

	ace.adapter = adapter;

	/* What was loaded before the adapter existed is started now. */
	(ace.deferred || []).splice(0).forEach(extension => extension());

	/* The original entry point, preserved. */
	ace.run = adapter.run;

	return adapter;
});
