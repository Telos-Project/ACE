/*

	ACE - Babylon.js physics extension (Havok).

	Loads after aceOperators.js and aceWorld.js. Adds one component, `character`,
	and the collision world it moves in:

		character  A body that is moved by asking for a velocity. It is a capsule
		           swept through the world by the physics engine's own character
		           controller, so it stops at, and slides along, whatever is there,
		           however fast it is asked to go and however long the frame was.

	The world it collides with is not authored. It is made, near the character
	and only there, from what the document already says is solid:

		terrain    a heightfield, from the terrain's own height grid, while the
		           terrain is switched on.
		meshes     the triangles of every mesh whose entity is tagged "solid" or
		           "ground", while it is within reach of the character. A mesh that
		           has a skeleton (a person) is a capsule round its bounds.
		scatter    the trunks and crowns (`collide`) of the scatter instances within
		           reach, a few dozen bodies handed from instance to instance.

	The engine is Havok, and the host supplies it: a page loads the Havok script
	and sets `root.havokInstance` to what it resolves. Without it, `available` in
	the character's state stays false, and a document should keep to whatever it
	did before.

	See "ACE Liberty.md", section 2.3.26.

*/

(function(root) {
	/* The files that add to the adapter may be loaded in any order after ace.js: one that arrives before the adapter
	   waits for it, and the adapter starts it when it is made. */
	const extension = function() {


	const ace = root.ace;
	const BABYLON = root.BABYLON;
	const H = ace.adapter.helpers;

	const now = () =>
		root.performance != null ? root.performance.now() : Date.now();

	/* How far from the character the world is made solid, and how far it is kept once made. */
	const NEAR = 320;
	const FAR = 520;

	/* ---------------------------------------------------------------- the world */

	const world = context => {

		if(context.meta.havokWorld !== undefined)
			return context.meta.havokWorld;

		let scene = context.meta.scene;

		if(root.havokInstance == null || BABYLON.HavokPlugin == null ||
			BABYLON.PhysicsCharacterController == null || scene.getPhysicsEngine() != null) {

			context.meta.havokWorld = null;

			return null;
		}

		try {

			scene.enablePhysics(
				new BABYLON.Vector3(0, 0, 0),
				new BABYLON.HavokPlugin(true, root.havokInstance)
			);

		} catch(error) {

			context.errors.push({ type: "character", hook: "world", message: error.message });
			context.meta.havokWorld = null;

			return null;
		}

		context.meta.havokWorld = {
			terrains: new Map(),
			meshes: new Map(),
			solids: new Map(),
			ticked: -1000,
			pending: 0,
			failed: 0
		};

		return context.meta.havokWorld;
	};

	/* Entity keys that carry any of the tags, once per frame. */
	const tagged = (context, wanted) => {

		let cache = context.meta.havokTags;

		if(cache == null || cache.frame !== context.frame)
			cache = context.meta.havokTags = { frame: context.frame, sets: new Map() };

		let id = wanted.join("|");

		if(!cache.sets.has(id)) {

			cache.sets.set(id, new Set(
				context.resolved.entities.filter(
					entity => entity.tags.some(tag => wanted.includes(tag))
				).map(entity => entity.key)
			));
		}

		return cache.sets.get(id);
	};

	const drop = entry => {

		try {

			entry.body.dispose();

			if(entry.shape != null)
				entry.shape.dispose();

			if(entry.node != null)
				entry.node.dispose();

			if(entry.proxy != null)
				entry.proxy.dispose();

		} catch(error) { /* already gone with its mesh */ }
	};

	/* ---------------------------------------------------------------- terrain */

	/*

		The terrain's grid has row 0 at +Z and rows running toward -Z; the
		engine's heightfield reads its samples the same way, so the grid goes in
		as it is (measured, not assumed: turning the rows over puts the ground on
		the wrong side of the island).

	*/
	const syncTerrains = (context, w) => {

		let scene = context.meta.scene;
		let list = context.meta.terrains != null ? context.meta.terrains : [];

		list.forEach(entry => {

			let object = entry.object;
			let grid = object.grid;
			let on = grid != null && !object.disposed && object.node.isEnabled(true);
			let have = w.terrains.get(entry.key);

			if(on && have != null && have.object !== object) {

				drop(have);
				w.terrains.delete(entry.key);
				have = null;
			}

			if(on && have == null) {

				let { heights, width, height, elevation, size } = grid;
				let origin = object.node.getAbsolutePosition();
				let rise = elevation[1] - elevation[0];
				let data = new Float32Array(width * height);

				for(let at = 0; at < data.length; at++)
					data[at] = origin.y + elevation[0] + rise * heights[at];

				let shape = new BABYLON.PhysicsShapeHeightField(
					size[0], size[1], width, height, data, scene
				);

				let node = new BABYLON.TransformNode("havok.terrain", scene);

				node.position.set(origin.x, 0, origin.z);

				let body = new BABYLON.PhysicsBody(
					node, BABYLON.PhysicsMotionType.STATIC, false, scene
				);

				body.shape = shape;
				w.terrains.set(entry.key, { body, shape, node, object });

			} else if(!on && have != null) {

				drop(have);
				w.terrains.delete(entry.key);
			}
		});
	};

	/* ---------------------------------------------------------------- meshes */

	const makeMeshBody = (context, w, mesh) => {

		let scene = context.meta.scene;

		mesh.computeWorldMatrix(true);

		try {

			if(mesh.skeleton != null) {

				/* a person: a capsule round the bounds, standing where they stand */
				let box = mesh.getBoundingInfo().boundingBox;
				let low = box.minimumWorld, high = box.maximumWorld;
				let radius = Math.max(0.3, Math.min(high.x - low.x, high.z - low.z) / 2);
				let x = (low.x + high.x) / 2, z = (low.z + high.z) / 2;

				let shape = new BABYLON.PhysicsShapeCapsule(
					new BABYLON.Vector3(x, low.y + radius, z),
					new BABYLON.Vector3(x, Math.max(low.y + radius, high.y - radius), z),
					radius, scene
				);

				let node = new BABYLON.TransformNode("havok.person", scene);
				let body = new BABYLON.PhysicsBody(node, BABYLON.PhysicsMotionType.STATIC, false, scene);

				body.shape = shape;
				w.meshes.set(mesh.uniqueId, { body, shape, node, mesh });

				return;
			}

			/*

				The shape is made from the mesh's triangles where they are in the
				world, on a body that has no transform of its own: a shape made
				from the mesh in place does not take on the scaling of the entity
				it hangs from, and a model is always scaled by something.

			*/
			let positions = mesh.getVerticesData(BABYLON.VertexBuffer.PositionKind);
			let indices = mesh.getIndices();
			let matrix = mesh.getWorldMatrix().m;
			let flip = mesh.getWorldMatrix().determinant() < 0;
			let moved = new Float32Array(positions.length);

			for(let at = 0; at < positions.length; at += 3) {

				let x = positions[at], y = positions[at + 1], z = positions[at + 2];

				moved[at] = x * matrix[0] + y * matrix[4] + z * matrix[8] + matrix[12];
				moved[at + 1] = x * matrix[1] + y * matrix[5] + z * matrix[9] + matrix[13];
				moved[at + 2] = x * matrix[2] + y * matrix[6] + z * matrix[10] + matrix[14];
			}

			let triangles = indices;

			if(flip) {

				triangles = new indices.constructor(indices.length);

				for(let at = 0; at < indices.length; at += 3) {

					triangles[at] = indices[at];
					triangles[at + 1] = indices[at + 2];
					triangles[at + 2] = indices[at + 1];
				}
			}

			let proxy = new BABYLON.Mesh("havok.proxy", scene);
			let data = new BABYLON.VertexData();

			data.positions = moved;
			data.indices = triangles;
			data.applyToMesh(proxy);
			proxy.isVisible = false;
			proxy.isPickable = false;

			let shape = new BABYLON.PhysicsShapeMesh(proxy, scene);
			let node = new BABYLON.TransformNode("havok.mesh", scene);
			let body = new BABYLON.PhysicsBody(node, BABYLON.PhysicsMotionType.STATIC, false, scene);

			body.shape = shape;
			w.meshes.set(mesh.uniqueId, { body, shape, node, mesh, proxy });

		} catch(error) {

			/* a mesh the engine cannot make a shape of is left to whatever else is there */
			w.meshes.set(mesh.uniqueId, { body: { dispose: () => { } }, shape: null, node: null, mesh });
			w.failed++;
			w.lastError = mesh.name + ": " + error.message;
		}
	};

	/* Returns how many solid meshes within reach are still without a body. */
	const syncMeshes = (context, w, centre, budget) => {

		let scene = context.meta.scene;
		let solid = tagged(context, ["solid", "ground"]);
		let terrainKeys = new Set((context.meta.terrains || []).map(entry => entry.key));
		let started = now();
		let wanted = [];

		/* what has been disposed with its mesh */
		w.meshes.forEach((entry, id) => {

			if(entry.mesh.isDisposed()) {

				drop(entry);
				w.meshes.delete(id);
			}
		});

		for(let index = 0; index < scene.meshes.length; index++) {

			let mesh = scene.meshes[index];
			let key = mesh.metadata != null ? mesh.metadata.aceEntity : null;

			if(key == null || !solid.has(key) || terrainKeys.has(key))
				continue;

			if(mesh.hasThinInstances || mesh.getClassName() === "InstancedMesh" || mesh.getTotalVertices() === 0)
				continue;

			let have = w.meshes.get(mesh.uniqueId);

			if(!mesh.isEnabled()) {

				if(have != null) {

					drop(have);
					w.meshes.delete(mesh.uniqueId);
				}

				continue;
			}

			let sphere = mesh.getBoundingInfo().boundingSphere;
			let reach = BABYLON.Vector3.Distance(sphere.centerWorld, centre) - sphere.radiusWorld;

			if(reach > FAR) {

				if(have != null) {

					drop(have);
					w.meshes.delete(mesh.uniqueId);
				}

				continue;
			}

			if(have == null && reach <= NEAR)
				wanted.push({ mesh, reach });
		}

		/* the nearest first, as many as the time allows (at least one) */
		wanted.sort((a, b) => a.reach - b.reach);

		let pending = 0;

		wanted.forEach((item, order) => {

			if(order > 0 && budget != null && now() - started > budget) {

				pending++;

				return;
			}

			makeMeshBody(context, w, item.mesh);
		});

		return pending;
	};

	/* ---------------------------------------------------------------- scatter */

	const syncSolids = (context, w, centre, budget) => {

		let scene = context.meta.scene;
		let near = ace.adapter.solidsNear != null ? ace.adapter.solidsNear(context, centre, 60) : [];
		let want = new Map();

		near.sort((a, b) => a.distance - b.distance);
		near.slice(0, 96).forEach(item => want.set(item.id, item));

		w.solids.forEach((entry, id) => {

			if(!want.has(id)) {

				drop(entry);
				w.solids.delete(id);
			}
		});

		let made = 0, pending = 0;

		want.forEach((item, id) => {

			if(w.solids.has(id))
				return;

			if(made >= budget) {

				pending++;

				return;
			}

			made++;

			let container = new BABYLON.PhysicsShapeContainer(scene);

			item.parts.forEach(part => container.addChild(new BABYLON.PhysicsShapeCylinder(
				new BABYLON.Vector3(item.x, part.low, item.z),
				new BABYLON.Vector3(item.x, part.high, item.z),
				part.radius, scene
			)));

			let node = new BABYLON.TransformNode("havok.solid", scene);
			let body = new BABYLON.PhysicsBody(node, BABYLON.PhysicsMotionType.STATIC, false, scene);

			body.shape = container;
			w.solids.set(id, { body, shape: container, node });
		});

		return pending;
	};

	/*

		The whole of it, near a point. `force` builds everything at once (a
		teleport); `urgent` builds a good deal each frame (the character has not
		settled); otherwise a little every other frame.

	*/
	const stream = (context, w, centre, force, urgent) => {

		syncTerrains(context, w);

		if(force || urgent || context.frame - w.ticked >= 2) {

			w.ticked = context.frame;
			w.pending = syncMeshes(context, w, centre, force ? null : (urgent ? 30 : 8)) +
				syncSolids(context, w, centre, force ? 400 : (urgent ? 80 : 24));
		}

		return w.pending;
	};

	/* ---------------------------------------------------------------- the character */

	const character = {

		type: "character",
		order: 36,

		onCreate: (context, instance) => {

			let object = { controller: null, node: H.nodeFor(context, instance.entity), written: null };

			if(world(context) == null) {

				ace.setState(context, instance.record, {
					available: false, grounded: false, position: null, velocity: [0, 0, 0]
				});
			}

			return object;
		},

		onChange: () => { },

		onUpdate: (context, instance) => {

			let w = world(context);
			let object = instance.object;
			let data = instance.data;

			if(w == null)
				return;

			let radius = data.radius != null ? data.radius : 0.55;
			let height = Math.max(data.height != null ? data.height : 1.8, radius * 2 + 0.01);
			let half = height / 2;

			object.node.computeWorldMatrix(true);

			let here = object.node.absolutePosition;

			/* the character is made where its entity is, at the first frame of it */
			if(object.controller == null) {

				object.controller = new BABYLON.PhysicsCharacterController(
					new BABYLON.Vector3(here.x, here.y + half, here.z),
					{ capsuleHeight: height, capsuleRadius: radius },
					context.meta.scene
				);

				let c = object.controller;

				c.maxSlopeCosine = data.slope != null ? data.slope : 0.2;
				c.keepDistance = 0.05;
				c.keepContactTolerance = 0.25;
				c.maxCastIterations = 12;

				object.written = here.clone();
				object.force = true;
				object.since = 0;
			}

			let controller = object.controller;

			/*

				Where the entity is, if the document has put it somewhere other than
				where this last left it, is a teleport: the character is taken there
				and the world around it is made at once.

			*/
			if(BABYLON.Vector3.Distance(here, object.written) > 0.05) {

				controller._position.set(here.x, here.y + half, here.z);
				controller._manifold.length = 0;
				controller.setVelocity(BABYLON.Vector3.Zero());
				object.force = true;
				object.since = 0;
			}

			let delta = Math.min(context.meta.frameDelta != null ? context.meta.frameDelta : 0, 0.05);
			let centre = controller.getPosition();
			let lead = controller.getVelocity();
			let ahead = new BABYLON.Vector3(centre.x + lead.x * 0.5, centre.y + lead.y * 0.5, centre.z + lead.z * 0.5);

			/*

				After a teleport the world round the character is made before it
				moves: it is `settled` when a few frames have passed (what has to
				be switched on has been) and nothing within reach is still to be
				built, or, at the longest, after a few seconds.

			*/
			object.since++;

			let pending = stream(context, w, ahead, object.force === true, object.since < 10 || w.pending > 0);

			/* settled once, after a teleport; flying on into new country is not a reason to stop */
			if(object.since < 10 || object.force === true)
				object.ready = false;
			else if(!object.ready && (pending === 0 || object.since > 400))
				object.ready = true;

			let settled = object.ready === true;
			let state = { available: true, settled, pending };

			if(delta > 1e-5 && object.force !== true && settled) {

				let wanted = Array.isArray(data.velocity) ? data.velocity : [0, 0, 0];
				let support = controller.checkSupport(delta, new BABYLON.Vector3(0, -1, 0));

				controller.setVelocity(new BABYLON.Vector3(wanted[0], wanted[1], wanted[2]));
				controller.integrate(delta, support, BABYLON.Vector3.Zero());

				let supported = support != null ? support.supportedState : 0;

				state.support = supported === 2 ? "supported" : supported === 1 ? "sliding" : "unsupported";
				state.grounded = supported === 2;
				state.normal = support != null && support.averageSurfaceNormal != null ?
					[support.averageSurfaceNormal.x, support.averageSurfaceNormal.y, support.averageSurfaceNormal.z] : [0, 1, 0];
			}

			object.force = false;

			let at = controller.getPosition();
			let speed = controller.getVelocity();

			object.node.position.set(at.x, at.y - half, at.z);
			object.node.computeWorldMatrix(true);
			object.written = object.node.absolutePosition.clone();

			state.position = [at.x, at.y - half, at.z];
			state.velocity = [speed.x, speed.y, speed.z];
			state.bodies = w.meshes.size + w.solids.size + w.terrains.size;

			ace.setState(context, instance.record, state);
		},

		onDestroy: () => { }
	};

	ace.register([character]);

	};

	if(root.ace.adapter != null)
		extension();
	else
		(root.ace.deferred = root.ace.deferred || []).push(extension);

})(typeof globalThis !== "undefined" ? globalThis : this);
