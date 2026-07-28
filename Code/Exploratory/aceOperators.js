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

				if(data.fog != null) {

					scene.fogMode = BABYLON.Scene.FOGMODE_LINEAR;
					scene.fogColor = color3(data.fog.color, [1, 1, 1]);
					scene.fogStart = data.fog.near != null ? data.fog.near : 10;
					scene.fogEnd = data.fog.far != null ? data.fog.far : 100;
				}

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

			onChange: (context, instance) => {

				operators[0].onDestroy(context, instance);

				instance.object = operators[0].onCreate(context, instance);
			},

			/*

				The world is created before any texture exists, so a skybox
				referencing one is built on the first frame it becomes
				available and is left alone thereafter.

			*/
			onUpdate: (context, instance) => {

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
				if(instance.object.skybox != null)
					instance.object.skybox.isPickable = false;

				scene.environmentTexture = texture;
			},

			onDestroy: (context, instance) => {

				if(instance != null && instance.object != null &&
					instance.object.skybox != null) {

					instance.object.skybox.dispose();
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

				camera.parent = node;
				camera.minZ = data.near != null ? data.near : 0.1;
				camera.maxZ = data.far != null ? data.far : 1000;

				let object = { camera, attached: false, xr: null };

				operators[1].apply(context, instance, object);

				if(scene.activeCamera == null)
					scene.activeCamera = camera;

				ace.setState(context, instance.record, {
					supported: [],
					presenting: false
				});

				if(data.xr != null)
					operators[1].requestXR(context, instance, object);

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

				if(Array.isArray(data.target))
					camera.setTarget(vector(data.target));

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

				if(scene.createDefaultXRExperienceAsync == null || !hasDOM)
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
						data.xr.features : []

				}).then(experience => {

					object.xr = experience;

					ace.setState(context, instance.record, {
						supported: [data.xr.mode]
					});

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

				if(presenting && xr.baseExperience.camera != null) {

					let camera = xr.baseExperience.camera;

					state.pose = {
						position: array3(camera.position),
						rotation: array4(
							camera.rotationQuaternion != null ?
								camera.rotationQuaternion :
								BABYLON.Quaternion.Identity()
						)
					};
				}

				ace.setState(context, instance.record, state);
			},

			onDestroy: (context, instance) => {

				if(instance.object.xr != null)
					instance.object.xr.dispose();

				instance.object.camera.dispose();
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

							object.owned[slot] = new BABYLON.Texture(
								value, context.meta.scene
							);
						}

						texture = object.owned[slot];
					}

					if(texture != null) {

						material[target] = texture;

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

						BABYLON.VertexData.CreateGroundFromHeightMap(
							Object.assign({ }, options, {
								buffer: samples.buffer,
								bufferWidth: samples.width,
								bufferHeight: samples.height
							})
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

				let width = parsed.resolution[0];
				let height = parsed.resolution[1];
				let buffer = new Uint8Array(width * height * 4);

				parsed.heights.forEach((value, index) => {

					let sample = Math.max(0, Math.min(255, Math.round(value * 255)));

					buffer[index * 4] = sample;
					buffer[index * 4 + 1] = sample;
					buffer[index * 4 + 2] = sample;
					buffer[index * 4 + 3] = 255;
				});

				return { buffer, width, height };
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

				let meshes = mesh.getChildMeshes != null ?
					[mesh].concat(mesh.getChildMeshes()) : [mesh];

				meshes.forEach(target => {

					if(target.receiveShadows !== undefined) {

						target.receiveShadows =
							data.shadow?.receive !== false;
					}
				});

				if(data.billboard != null && data.billboard !== "none") {

					mesh.billboardMode = data.billboard === "y" ?
						BABYLON.Mesh.BILLBOARDMODE_Y :
						BABYLON.Mesh.BILLBOARDMODE_ALL;
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

			onChange: (context, instance) => {

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

			onCreate: (context, instance) => {

				let scene = context.meta.scene;
				let data = instance.data;
				let node = nodeFor(context, instance.entity);
				let name = instance.path.join(".");

				let size = data.size != null ? data.size : 1;
				let text = instance.content != null ? instance.content : "";
				let width = data.width != null ? data.width : text.length * size * 0.6;

				let plane = BABYLON.MeshBuilder.CreatePlane(name, {
					width: Math.max(width, 0.001),
					height: Math.max(size * (data.leading != null ? data.leading : 1.2), 0.001),
					sideOrientation: BABYLON.Mesh.DOUBLESIDE
				}, scene);

				plane.parent = node;

				if(data.billboard != null && data.billboard !== "none") {

					plane.billboardMode = data.billboard === "y" ?
						BABYLON.Mesh.BILLBOARDMODE_Y :
						BABYLON.Mesh.BILLBOARDMODE_ALL;
				}

				own(plane, instance.entityKey);

				let object = { mesh: plane, texture: null, material: null };

				/*

					Glyph rasterisation needs a 2D canvas. Headless runtimes get
					the correctly sized and positioned quad without it, which
					keeps layout, picking and bounds meaningful.

				*/
				if(hasDOM) {

					let texture = new BABYLON.DynamicTexture(name, {
						width: 1024, height: 128
					}, scene, true);

					let base = color(data.color, [1, 1, 1, 1]);

					texture.drawText(
						text,
						null,
						null,
						"bold 72px sans-serif",
						"#" + [base.r, base.g, base.b].map(channel =>
							Math.round(channel * 255).toString(16).padStart(2, "0")
						).join(""),
						"transparent",
						true
					);

					let material = new BABYLON.StandardMaterial(name, scene);

					material.diffuseTexture = texture;
					material.emissiveTexture = texture;
					material.opacityTexture = texture;
					material.backFaceCulling = false;

					plane.material = material;

					object.texture = texture;
					object.material = material;
				}

				ace.setState(context, instance.record, {
					loaded: true,
					bounds: {
						min: [-width / 2, -size / 2, 0],
						max: [width / 2, size / 2, 0]
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

				if(Array.isArray(data.velocity))
					impostor.setLinearVelocity(vector(data.velocity));

				if(Array.isArray(data.angular))
					impostor.setAngularVelocity(vector(data.angular));

				if(data.damping != null && impostor.setDeltaPosition !== undefined)
					impostor.physicsBody != null &&
						(impostor.physicsBody.linearDamping = data.damping);

				if(data.angularDamping != null && impostor.physicsBody != null)
					impostor.physicsBody.angularDamping = data.angularDamping;

				if(data.sleep === false && impostor.physicsBody != null &&
					impostor.physicsBody.allowSleep !== undefined) {

					impostor.physicsBody.allowSleep = false;
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

				let velocity = impostor.getLinearVelocity();
				let angular = impostor.getAngularVelocity();

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

				let data = instance.data;
				let object = { sound: null, blocked: false };

				let sources = (
					Array.isArray(instance.source) ?
						instance.source : [instance.source]
				).filter(candidate => typeof candidate === "string");

				/* Babylon accepts a list and falls through it in order. */
				let source = sources.length > 1 ? sources : sources[0];

				if(sources.length === 0 || BABYLON.Sound == null) {

					ace.setState(context, instance.record, {
						loaded: false,
						playing: false
					});

					return object;
				}

				try {

					object.sound = new BABYLON.Sound(
						instance.path.join("."),
						source,
						context.meta.scene,
						() => ace.setState(context, instance.record, {
							loaded: true,
							duration: object.sound.getAudioBuffer?.()?.duration
						}),
						{
							loop: data.loop === true,
							autoplay: data.autoplay === true,
							volume: data.volume != null ? data.volume : 1,
							spatialSound: data.spatial === true,
							maxDistance: Array.isArray(data.distance) ?
								data.distance[1] : 100
						}
					);

					if(data.spatial === true) {

						object.sound.attachToMesh(
							nodeFor(context, instance.entity)
						);
					}

				} catch(error) {

					ace.setState(context, instance.record, {
						loaded: false,
						playing: false,
						error: error.message
					});
				}

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

				let sound = instance.object.sound;

				if(sound == null)
					return;

				ace.setState(context, instance.record, {
					playing: sound.isPlaying === true,
					blocked: context.meta.gesture === false &&
						instance.data.autoplay === true &&
						sound.isPlaying !== true
				});
			},

			onDestroy: (context, instance) => {

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

				let group = scene.animationGroups.find(
					candidate => candidate.name === clip
				);

				if(group == null)
					return;

				object.group = group;

				group.speedRatio = instance.data.speed != null ?
					instance.data.speed : 1;

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

				ace.setState(context, instance.record, {
					playing: group.isPlaying === true,
					time: group.animatables?.[0]?.masterFrame,
					duration: group.to - group.from,
					finished: group.isPlaying !== true &&
						instance.data.loop === false
				});
			},

			onDestroy: (context, instance) => {

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
						(1 - data.screen[1]) * size.height
					);

					let hit = describe(pick);

					if(hit != null)
						hits.push(hit);

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

						let hit = describe(scene.pickWithRay(ray));

						if(hit != null)
							hits.push(hit);

					} else {

						(scene.multiPickWithRay(ray) || []).forEach(pick => {

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

			const gesture = () => { input.gesture = true; };

			on("keydown", event => {

				gesture();

				if(!keyboard.digital.includes(event.code)) {

					keyboard.digital.push(event.code);
					keyboard.pressed.push(event.code);
				}
			});

			on("keyup", event => {

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

		onSync: context => {

			let now = typeof performance !== "undefined" ?
				performance.now() : Date.now();

			let previous = context.meta.clock != null ? context.meta.clock : now;
			let unscaled = Math.min((now - previous) / 1000, 0.25);

			context.meta.clock = now;
			context.meta.gesture = input.gesture;

			let scale = context.meta.timeScale != null ?
				context.meta.timeScale : 1;

			context.meta.elapsed =
				(context.meta.elapsed != null ? context.meta.elapsed : 0) +
				unscaled * scale;

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
								xr: { presenting: false }
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

			context.resolved.entities.forEach(record => {

				live[record.key] = true;

				let node = nodeFor(context, record.path);
				let data = record.data;

				let body = context.resolved.components.find(component =>
					component.type === "body" &&
					component.entityKey === record.key &&
					(component.data.mode == null ||
						component.data.mode === "dynamic")
				);

				let driven = body != null && context.meta.physics;
				let previous = context.meta.applied[record.key];
				let signature = JSON.stringify([
					data.position, data.rotation, data.scale
				]);

				let collider = context.resolved.components.find(component =>
					component.type === "collider" &&
					component.entityKey === record.key
				);

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

						Authored transform values are applied only when they
						change, so that they read as a teleport rather than a
						per-frame override that would fight the solver.

					*/
					if(Array.isArray(data.position))
						node.position = vector(data.position);

					if(data.rotation != null)
						node.rotationQuaternion = quaternion(data.rotation);

					if(data.scale != null)
						node.scaling = scale(data.scale);
				}

				context.meta.applied[record.key] = signature;

				node.setEnabled(data.enabled !== false);

				if(node.computeWorldMatrix != null)
					node.computeWorldMatrix(true);

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
				if(node.getChildMeshes != null) {

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

			if(mode === "locked" && !input.locked && !context.meta.lockPending) {

				context.meta.lockPending = true;

				surface.addEventListener("click", () => {

					if(input.locked)
						return;

					let request = surface.requestPointerLock();

					if(request != null && request.catch != null)
						request.catch(() => { });
				});
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
					engine = new BABYLON.Engine(canvas, true);

				} else {

					engine = new BABYLON.NullEngine();
				}

				ownsEngine = true;
			}

			let scene = new BABYLON.Scene(engine);

			/* Standard 2.2.3: right-handed, Y-up. Babylon defaults to left. */
			scene.useRightHandedSystem = true;

			scene.clearColor = new BABYLON.Color4(0, 0, 0, 1);

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
				let measured = context.meta.engine.getDeltaTime();

				if(!(measured > 0)) {

					physics._step(step);

				} else {

					context.meta.accumulator =
						(context.meta.accumulator != null ?
							context.meta.accumulator : 0) +
						Math.min(measured / 1000, 0.25);

					let iterations = 0;

					while(context.meta.accumulator >= step && iterations < 5) {

						physics._step(step);

						context.meta.accumulator -= step;
						iterations++;
					}
				}
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

	/* The original entry point, preserved. */
	ace.run = adapter.run;

	return adapter;
});
