/*

	ACE - Telos ACE core.

	Adapter-agnostic. Resolves APInt documents into a component set, reconciles
	that set against live instances, hosts scripts, and mediates the data/state
	authority split. Contains no engine-specific code.

*/

(function(root, factory) {

	let ace = factory();

	if(typeof module === "object" && module.exports != null)
		module.exports = ace;

	root.ace = ace;

})(typeof globalThis !== "undefined" ? globalThis : this, function() {

	const TAG = "telos-ace";
	const RESERVED = "engine";

	/*

		Fields the engine is permitted to write to a data object. This is the
		sole exception to the authority rule; see standard section 2.2.4.

	*/
	const CONSUMABLE = {
		"": ["position", "rotation", "scale"], // entity meta, dynamic bodies only
		body: ["impulse", "torque", "teleport"],
		audio: ["play", "stop", "seek"],
		animation: ["play", "stop", "seek"],
		controller: ["haptic"],
		display: ["fullscreen", "capture"]
	};

	const isObject = value =>
		value != null && typeof value === "object" && !Array.isArray(value);

	const clone = value =>
		value == null ? value : JSON.parse(JSON.stringify(value));

	let ace = {

		version: "0.2.0",

		TAG,
		RESERVED,
		CONSUMABLE,

		/*

			Operators implement component types. Hooks:

				onCreate  (context, instance) -> object | null
				onDestroy (context, instance)
				onChange  (context, instance, previous)
				onUpdate  (context, instance)
				onConsume (context, instance, field, value)

			An operator claims a component by declaring `type`, or by declaring
			`types` as a list. Exactly one operator may claim a given type.

		*/
		operators: [],

		/*

			Adapters register frame hooks here:

				onSync    (context) - poll input/time/display, write reserved entity
				onReflect (context) - flush engine state into the document
				onRender  (context)
				onDispose (context)

		*/
		adapter: { },

		/* Script language compilers. A compiler returns fn(state, path). */
		languages: {

			js: code => new Function("state", "path", code)
		},

		/*

			Optional resolver for string package references (APInt 2.1.2).
			Signature: (location) -> Promise<packageObject>. Absent by default;
			documents using string references without one are reported as errors
			rather than silently dropped.

		*/
		resolve: null,

		// ---------------------------------------------------------------- paths

		pathKey: path => JSON.stringify(path),

		/* Accepts a list of aliases or a period-delimited string. */
		parsePath: path =>
			Array.isArray(path) ? path.slice() :
			typeof path === "string" ? path.split(".") : [],

		/*

			Resolves an APInt element path against a package. Adjacent aliases
			need not be immediate parent and child (APInt 2.1.4), so each alias
			is searched for breadth-first among descendants. Honours the ID
			property protocol (APInt 2.2.1).

		*/
		getElement: (pkg, path) => {

			path = ace.parsePath(path);

			let current = { element: pkg, path: [] };

			for(const alias of path) {

				let found = null;
				let queue = [current];

				while(queue.length > 0 && found == null) {

					let node = queue.shift();
					let element = node.element;

					if(!isObject(element))
						continue;

					for(const field of ["utilities", "packages"]) {

						if(!isObject(element[field]))
							continue;

						for(const key of Object.keys(element[field])) {

							let child = element[field][key];
							let entry = {
								element: child,
								path: node.path.concat([key])
							};

							if(key === alias || ace.hasId(child, alias)) {

								found = entry;
								break;
							}

							queue.push(entry);
						}

						if(found != null)
							break;
					}
				}

				if(found == null)
					return null;

				current = found;
			}

			return current;
		},

		hasId: (element, alias) => {

			let id = isObject(element?.properties) ?
				(element.properties.id != null ?
					element.properties.id :
					element.properties.meta?.id) :
				null;

			return Array.isArray(id) ? id.includes(alias) : id === alias;
		},

		// ---------------------------------------------------- JSON merge patch

		/*

			RFC 7386. Objects merge recursively, null deletes, arrays and
			primitives replace wholesale.

		*/
		merge: (target, patch) => {

			if(!isObject(patch))
				return clone(patch);

			if(!isObject(target))
				target = { };

			Object.keys(patch).forEach(key => {

				if(patch[key] === null) {

					delete target[key];
					return;
				}

				target[key] = ace.merge(target[key], patch[key]);
			});

			return target;
		},

		// ------------------------------------------------ document resolution

		/*

			Walks the document and returns every component and entity, with
			package properties bubbled down to descendants per APInt 2.1.2.
			The `meta` field is excluded from bubbling per APInt 2.2.3.

		*/
		collect: (context, doc) => {

			let components = [];
			let entities = [];
			let errors = [];

			const inherit = (parent, own) => {

				let result = Object.assign({ }, parent);

				Object.keys(own != null ? own : { }).forEach(key => {

					if(key === "meta")
						return;

					result[key] = own[key];
				});

				return result;
			};

			const walk = (pkg, path, inherited, reserved) => {

				if(typeof pkg === "string") {

					let resolved = context != null ?
						context.references[pkg] : null;

					if(resolved === undefined) {

						errors.push({
							path,
							message: "unresolved package reference: " + pkg
						});

						if(context != null)
							ace.request(context, pkg);

						return;
					}

					if(resolved === null)
						return;

					pkg = resolved;
				}

				if(!isObject(pkg))
					return;

				let props = inherit(inherited, pkg.properties);
				let meta = isObject(pkg.properties?.meta) ?
					pkg.properties.meta : { };

				if(path.length > 0) {

					entities.push({
						kind: "entity",
						path,
						key: ace.pathKey(path),
						id: Array.isArray(meta.id) ? meta.id[0] : meta.id,
						element: pkg,
						meta,
						tags: Array.isArray(meta.tags) ? meta.tags : [],
						data: isObject(meta.data) ? meta.data : { },
						reserved
					});
				}

				Object.keys(
					isObject(pkg.utilities) ? pkg.utilities : { }
				).forEach(key => {

					let utility = pkg.utilities[key];

					if(!isObject(utility))
						return;

					let uprops = inherit(props, utility.properties);
					let tags = Array.isArray(uprops.tags) ? uprops.tags : null;

					if(tags == null || !tags.includes(TAG) || tags.length === 0)
						return;

					let type = tags[0] === TAG ? null : tags[0];

					if(type == null) {

						errors.push({
							path: path.concat([key]),
							message: "component has no primary tag"
						});

						return;
					}

					components.push({
						kind: "component",
						type,
						path: path.concat([key]),
						key: ace.pathKey(path.concat([key])),
						id: Array.isArray(uprops.id) ? uprops.id[0] : uprops.id,
						entity: path,
						entityKey: ace.pathKey(path),
						element: utility,
						properties: uprops,
						tags,
						data: isObject(uprops.data) ? uprops.data : { },
						reserved
					});
				});

				Object.keys(
					isObject(pkg.packages) ? pkg.packages : { }
				).forEach(key => {

					walk(
						pkg.packages[key],
						path.concat([key]),
						props,
						reserved || (path.length === 0 && key === RESERVED)
					);
				});
			};

			walk(doc, [], { }, false);

			/*

				A package is part of the scene only if something beneath it is a
				component. APInt utilities without the tag are data — world
				content, tables, saved state — and the packages holding them are
				a filing system, not a place. Marking them keeps an adapter from
				building a transform for every row of a table.

			*/
			let scene = { };

			components.forEach(record => {

				let path = record.entity;

				for(let depth = path.length; depth > 0; depth--)
					scene[ace.pathKey(path.slice(0, depth))] = true;
			});

			entities.forEach(record => {

				record.scene = scene[record.key] === true;
			});

			return { components, entities, errors };
		},

		/* Identity is the declared id where present, else the element path. */
		identity: record =>
			record.id != null ? "#" + record.id : record.key,

		request: (context, location) => {

			if(context.references[location] !== undefined)
				return;

			if(typeof ace.resolve !== "function") {

				context.references[location] = null;
				return;
			}

			context.references[location] = null;

			Promise.resolve(ace.resolve(location)).then(pkg => {

				context.references[location] = pkg;

			}).catch(() => {

				context.references[location] = null;
			});
		},

		// ------------------------------------------------------- engine state

		/*

			Adapters and operators write reflected data points here. The core
			flushes them into the document once per frame, after scripts have
			run, so that script writes to a state object are discarded.

		*/
		setState: (context, target, state) => {

			let key = typeof target === "string" ?
				target : ace.identity(target);

			context.state[key] = Object.assign(
				context.state[key] != null ? context.state[key] : { }, state
			);
		},

		clearState: (context, target) => {

			delete context.state[
				typeof target === "string" ? target : ace.identity(target)
			];
		},

		flush: context => {

			const write = record => {

				/*

					The adapter rewrites the reserved entity wholesale at the
					top of each frame, so its state must not be flushed over.

				*/
				if(record.reserved)
					return;

				let state = context.state[ace.identity(record)];

				if(record.kind === "entity") {

					if(state == null) {

						if(record.meta.state != null)
							delete record.meta.state;

						return;
					}

					record.element.properties =
						isObject(record.element.properties) ?
							record.element.properties : { };

					record.element.properties.meta =
						isObject(record.element.properties.meta) ?
							record.element.properties.meta : { };

					record.element.properties.meta.state = state;

					return;
				}

				if(state == null) {

					if(record.element.properties?.state != null)
						delete record.element.properties.state;

					return;
				}

				record.element.properties =
					isObject(record.element.properties) ?
						record.element.properties : { };

				record.element.properties.state = state;
			};

			context.resolved.entities.forEach(write);
			context.resolved.components.forEach(write);
		},

		// -------------------------------------------------------- consumables

		/*

			Applies and clears one-shot command fields. Runs before the change
			diff is taken, so a consumed field never registers as a change.

		*/
		consume: context => {

			const fire = (record, fields, dataObject, owner) => {

				owner = owner != null ? owner : record;

				fields.forEach(field => {

					if(!(field in dataObject))
						return;

					let value = dataObject[field];
					let instance = context.instances[ace.identity(owner)];

					ace.dispatch(
						context,
						owner.type,
						"onConsume",
						[
							context,
							instance != null ? instance : owner,
							field,
							value
						]
					);

					delete dataObject[field];

					/*

						The reconciler's snapshot was taken while the field was
						still present. Clearing it there too keeps the two in
						agreement, so consuming a command never registers as a
						change on the following frame.

					*/
					if(owner === record && instance != null && instance.data != null)
						delete instance.data[field];
				});
			};

			context.resolved.components.forEach(record => {

				let fields = CONSUMABLE[record.type];

				if(fields != null)
					fire(record, fields, record.data);
			});

			/*

				Entity transform fields are consumable only where the entity
				carries a dynamic body; otherwise they are ordinary authored
				state and must persist.

			*/
			context.resolved.entities.forEach(record => {

				let body = context.resolved.components.find(component =>
					component.type === "body" &&
					component.entityKey === record.key
				);

				if(body == null)
					return;

				let mode = body.data.mode != null ? body.data.mode : "dynamic";

				if(mode !== "dynamic")
					return;

				fire(record, CONSUMABLE[""], record.data, body);
			});
		},

		// ------------------------------------------------------------ scripts

		runScripts: (context, phase) => {

			let scripts = context.resolved.components.filter(record =>
				record.type === "script" &&
				!record.reserved &&
				(record.data.enabled !== false) &&
				((record.data.phase != null ? record.data.phase : "update")
					=== phase)
			).sort((a, b) => {

				let order = (a.data.order != null ? a.data.order : 0) -
					(b.data.order != null ? b.data.order : 0);

				return order !== 0 ? order :
					a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
			});

			scripts.forEach(record => {

				let id = ace.identity(record);

				/*

					An earlier script in this frame may have removed or disabled
					this one; the schedule was fixed before any of them ran.

				*/
				let current = context.resolved.components.find(
					candidate => ace.identity(candidate) === id
				);

				if(current == null || current.type !== "script" ||
					current.data.enabled === false) {

					return;
				}

				record = current;

				let compiled = context.scripts[id];

				if(compiled == null || compiled.source !== record.element.content) {

					let language = (
						record.data.language != null ? record.data.language : "js"
					).toLowerCase();

					let compiler = ace.languages[language];

					if(compiler == null) {

						ace.setState(context, record, {
							error: "unsupported script language: " + language
						});

						return;
					}

					if(typeof record.element.content !== "string") {

						ace.setState(context, record, {
							error: record.element.source != null ?
								"script source has not been loaded" :
								"script has no content"
						});

						return;
					}

					try {

						compiled = {
							source: record.element.content,
							fn: compiler(record.element.content),
							runs: 0
						};

					} catch(error) {

						ace.setState(context, record, {
							error: "compile: " + error.message
						});

						return;
					}

					context.scripts[id] = compiled;
				}

				let mode = (
					record.data.mode != null ? record.data.mode : "blunt"
				).toLowerCase();

				if(mode !== "blunt") {

					ace.setState(context, record, {
						error: "unimplemented script mode: " + mode
					});

					return;
				}

				let started = Date.now();
				let output;

				try {

					output = compiled.fn(
						JSON.stringify(context.data),
						JSON.stringify(record.path)
					);

				} catch(error) {

					ace.setState(context, record, {
						error: error.message,
						runs: compiled.runs,
						duration: (Date.now() - started) / 1000
					});

					return;
				}

				compiled.runs++;

				ace.setState(context, record, {
					error: null,
					runs: compiled.runs,
					duration: (Date.now() - started) / 1000
				});

				if(output == null || output === "")
					return;

				let parsed;

				try {

					parsed = JSON.parse(output);

				} catch(error) {

					ace.setState(context, record, {
						error: "output is not valid JSON: " + error.message
					});

					return;
				}

				let outputMode = (
					record.data.output != null ? record.data.output : "patch"
				).toLowerCase();

				if(outputMode === "override")
					context.data = parsed;
				else
					ace.merge(context.data, parsed);

				/* The document changed underneath us; re-resolve for the next script. */
				context.resolved = ace.collect(context, context.data);
			});
		},

		// -------------------------------------------------------- reconciler

		dispatch: (context, type, hook, args) => {

			let operator = context.registry[type];

			if(operator == null || operator[hook] == null)
				return undefined;

			try {

				return operator[hook](...args);

			} catch(error) {

				context.errors.push({
					type,
					hook,
					message: error.message,
					stack: error.stack
				});

				return undefined;
			}
		},

		reconcile: context => {

			let present = { };

			context.resolved.components.filter(
				record => !record.reserved && record.type !== "script"
			).forEach(record => {

				present[ace.identity(record)] = record;
			});

			/* Destroy instances whose components have left the document. */
			Object.keys(context.instances).forEach(id => {

				if(present[id] != null)
					return;

				let instance = context.instances[id];

				ace.dispatch(
					context, instance.type, "onDestroy", [context, instance]
				);

				delete context.instances[id];
				ace.clearState(context, id);
			});

			/*

				Create in operator-declared order so that dependencies such as
				physics world initialisation precede the components that need
				them, rather than depending on key iteration order.

			*/
			let pending = Object.keys(present).filter(
				id => context.instances[id] == null
			).sort((a, b) => {

				let ranked = record => {

					let operator = context.registry[record.type];

					return operator != null && operator.order != null ?
						operator.order : 0;
				};

				let order = ranked(present[a]) - ranked(present[b]);

				return order !== 0 ? order : a < b ? -1 : a > b ? 1 : 0;
			});

			pending.forEach(id => {

				let record = present[id];

				let instance = {
					id,
					type: record.type,
					path: record.path,
					key: record.key,
					entity: record.entity,
					entityKey: record.entityKey,
					record,
					data: clone(record.data),
					source: clone(record.element.source),
					content: record.element.content,
					object: null
				};

				let object = ace.dispatch(
					context, record.type, "onCreate", [context, instance]
				);

				if(object === undefined) {

					if(context.registry[record.type] == null) {

						context.errors.push({
							type: record.type,
							hook: "onCreate",
							message: "no operator registered for component type"
						});
					}

					return;
				}

				instance.object = object;
				context.instances[id] = instance;
			});

			/* Fire change against the snapshot, then resynchronise it. */
			Object.keys(context.instances).forEach(id => {

				let instance = context.instances[id];
				let record = present[id];

				if(record == null)
					return;

				instance.record = record;

				let changed =
					JSON.stringify(record.data) !== JSON.stringify(instance.data) ||
					JSON.stringify(record.element.source) !== JSON.stringify(instance.source) ||
					record.element.content !== instance.content;

				if(!changed)
					return;

				let previous = {
					data: instance.data,
					source: instance.source,
					content: instance.content
				};

				instance.data = clone(record.data);
				instance.source = clone(record.element.source);
				instance.content = record.element.content;

				ace.dispatch(
					context, instance.type, "onChange", [context, instance, previous]
				);
			});
		},

		update: context => {

			Object.keys(context.instances).forEach(id => {

				let instance = context.instances[id];

				ace.dispatch(
					context, instance.type, "onUpdate", [context, instance]
				);
			});
		},

		// ------------------------------------------------------------- frame

		step: context => {

			context.errors = [];
			context.frame++;

			if(ace.adapter.onSync != null)
				ace.adapter.onSync(context);

			context.resolved = ace.collect(context, context.data);

			if(context.frame === 1)
				ace.runScripts(context, "start");

			ace.runScripts(context, "update");

			ace.reconcile(context);
			ace.consume(context);

			if(ace.adapter.onReflect != null)
				ace.adapter.onReflect(context);

			ace.update(context);
			ace.flush(context);

			context.errors = context.errors.concat(context.resolved.errors);

			return context;
		},

		// ------------------------------------------------------------ context

		register: operators => {

			(Array.isArray(operators) ? operators : [operators]).forEach(
				operator => ace.operators.push(operator)
			);
		},

		context: (data, meta) => {

			let registry = { };

			ace.operators.forEach(operator => {

				let types = operator.types != null ?
					operator.types : [operator.type];

				types.filter(type => type != null).forEach(type => {

					registry[type] = operator;
				});
			});

			return {
				meta: meta != null ? meta : { },
				data: data != null ? data : { },
				registry,
				instances: { },
				scripts: { },
				state: { },
				references: { },
				resolved: { components: [], entities: [], errors: [] },
				errors: [],
				frame: 0,
				running: false
			};
		},

		dispose: context => {

			context.running = false;

			Object.keys(context.instances).forEach(id => {

				let instance = context.instances[id];

				ace.dispatch(
					context, instance.type, "onDestroy", [context, instance]
				);
			});

			context.instances = { };
			context.state = { };
			context.scripts = { };

			if(ace.adapter.onDispose != null)
				ace.adapter.onDispose(context);

			return context;
		}
	};

	return ace;
});
