// onProcess, onCreate, onDestroy, onChange, onUpdate
ace.operators = [
	{ // camera
		onCreate: (context, path, data) => {

			if(Array.isArray(data.properties?.tags) ?
				data.properties?.tags[0] != "camera" : true) {

				return;
			}
	
			let camera = new (
				data.properties?.info?.type != null ?
					{
						"fly": BABYLON.FlyCamera,
						"free": BABYLON.FreeCamera,
						"universal": BABYLON.UniversalCamera
					}[data.properties.info.type] :
					BABYLON.UniversalCamera
			)(
				JSON.stringify(path), 
				Array.isArray(data.properties?.info?.position) ?
					new BABYLON.Vector3(
						...data.properties.info.position
					) :
					new BABYLON.Vector3(0, 0, 0),
				context.meta.anchor.scene
			);
		
			camera.setTarget(
				Array.isArray(data.properties?.info?.target) ?
					new BABYLON.Vector3(
						...data.properties.info.target
					) :
					new BABYLON.Vector3(0, 0, 0)
			);

			camera.attachControl(context.meta.anchor.scene, true);

			return {
				type: "camera",
				object: camera
			};
		}
	},
	{ // light
		onCreate: (context, path, data) => {

			if(Array.isArray(data.properties?.tags) ?
				data.properties?.tags[0] != "light" : true) {

				return;
			}
			
			let light = new (
				data.properties?.info?.type != null ?
					{
						"hemispheric": BABYLON.HemisphericLight
					}[data.properties.info.type] :
					BABYLON.HemisphericLight
			)(
				JSON.stringify(path), 
				Array.isArray(data.properties?.info?.position) ?
					new BABYLON.Vector3(
						...data.properties.info.position
					) :
					new BABYLON.Vector3(0, 0, 0),
				context.meta.anchor.scene
			);
			
			if(data.properties?.info?.intensity != null)
				light.intensity = data.properties.info.intensity;

			return {
				type: "light",
				object: light
			};
		}
	},
	{ // sphere
		onCreate: (context, path, data) => {

			if(Array.isArray(data.properties?.tags) ?
				data.properties?.tags[0] != "sphere" : true) {

				return;
			}
			
			let sphere = BABYLON.MeshBuilder.CreateSphere(
				JSON.stringify(path),
				{
					diameter: data.properties?.info?.diameter,
					segments: data.properties?.info?.segments
				},
				context.meta.anchor.scene
			);
			
			if(data.properties?.info?.position != null) {

				sphere.position = new BABYLON.Vector3(
					...data.properties.info.position
				);
			}

			return {
				type: "sphere",
				object: sphere
			};
		}
	},
	{ // ground
		onCreate: (context, path, data) => {

			if(Array.isArray(data.properties?.tags) ?
				data.properties?.tags[0] != "ground" : true) {

				return;
			}
			
			let ground = BABYLON.MeshBuilder.CreateGround(
				JSON.stringify(path),
				{
					width: data.properties?.info?.width,
					height: data.properties?.info?.height
				},
				context.meta.anchor.scene
			);
			
			if(data.properties?.info?.position != null) {

				ground.position = new BABYLON.Vector3(
					...data.properties.info.position
				);
			}

			return {
				type: "ground",
				object: ground
			};
		}
	},
	{ // audio
		onCreate: (context, path, data) => {

			if(Array.isArray(data.properties?.tags) ?
				data.properties?.tags[0] != "audio" : true) {

				return;
			}
	
			let audio = new Audio(data.source);

			audio.loop = data.properties?.info?.loop != null ?
				data.properties?.info?.loop : true;

			audio.play();

			return {
				type: "audio",
				object: audio
			};
		}
	}
];