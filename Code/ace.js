var ace = {
	getUtilities: (item, path) => {

		path = path != null ? path : [];

		let components = { };
		
		Object.keys(
			item.utilities != null ? item.utilities : { }
		).forEach(key => {

			if(item.utilities[key].properties != null) {

				if(Array.isArray(item.utilities[key].properties?.tags) ?
					!item.utilities[key].properties.tags.includes(
						"telos-ace"
					) :
					true) {

					return;
				}
			}

			components[
				JSON.stringify(path.concat([key]))
			] = item.utilities[key];
		});

		Object.keys(
			item.packages != null ? item.packages : { }
		).forEach(key => {
			
			Object.assign(components, ace.getUtilities(
				item.packages[key], path.concat([key])
			));
		});

		return components;
	},
	getPackage: (entity, path) => {

		entity.packages =
			entity.packages != null ? entity.packages : { };

		entity.utilities =
			entity.utilities != null ? entity.utilities : { };

		if(path.length == 0)
			return entity;

		entity.packages[path[0]] =
			entity.packages[path[0]] != null ?
				entity.packages[path[0]] : { };

		return ace.getPackage(entity.packages[path[0]], path.slice(1));
	},
	operators: [],
	processContext: (context) => {

		let components = ace.getUtilities(context.data);

		Object.keys(components).forEach(key => {

			ace.operators.filter(
				operator => operator.onProcess != null
			).forEach(operator => {

				operator.onProcess(
					context.data,
					components[key],
					JSON.parse(key)
				);
			});
		});

		let dataComponents = ace.getUtilities(context.data);
		let objectComponents = ace.getUtilities(context.objects);

		Object.keys(dataComponents).filter(
			key => !Object.keys(objectComponents).includes(key)
		).forEach(key => {

			let path = JSON.parse(key);

			let item = {
				type: "",
				content: null
			};

			ace.operators.filter(
				operator => operator.onCreate != null
			).forEach(operator => {

				Object.assign(
					item,
					operator.onCreate(
						context, path, dataComponents[key]
					)
				);
			});

			ace.getPackage(
				context.objects, path.slice(0, path.length - 1)
			).utilities[path[path.length - 1]] = {
				data: dataComponents[key],
				object: item
			};
		});
		
		Object.keys(objectComponents).filter(
			key => !Object.keys(dataComponents).includes(key)
		).forEach(key => {

			let path = JSON.parse(key);

			ace.operators.filter(
				operator => operator.onDestroy != null
			).forEach(operator => {

				operator.onDestroy(
					context, path, objectComponents[key]
				);
			});

			delete ace.getPackage(
				context.objects, path.slice(0, path.length - 1)
			).utilities[path[path.length - 1]];
		});
		
		Object.keys(objectComponents).filter(
			key => dataComponents[key] != null ?
				JSON.stringify(dataComponents[key]) !=
					JSON.stringify(objectComponents[key].data) :
				false
		).forEach(key => {

			let path = JSON.parse(key);

			ace.operators.filter(
				operator => operator.onChange != null
			).forEach(operator => {

				operator.onChange(
					context,
					path,
					objectComponents[key],
					dataComponents[key]
				);
			});
		});
		
		Object.keys(objectComponents).forEach(key => {

			let path = JSON.parse(key);

			ace.operators.filter(
				operator => operator.onUpdate != null
			).forEach(operator => {

				operator.onUpdate(
					context, path, objectComponents[key]
				);
			});
		});
	},
	run: (selector, data) => {

		let element = document.querySelector(selector);

		element.innerHTML = `
			<canvas style="width: 100%; height: 100%; touch-action: none;">
			</canvas>
		`;

		let canvas = element.children[0];
		let engine = new BABYLON.Engine(canvas, true);

		let context = {
			meta: {
				anchor: {
					canvas,
					engine,
					scene: new BABYLON.Scene(engine)
				}
			},
			objects: { },
			data
		};

		engine.runRenderLoop(() => {

			ace.processContext(context);

			context.meta.anchor.scene.render();
		});
		
		window.addEventListener("resize", () => {
			engine.resize();
		});
	}
}