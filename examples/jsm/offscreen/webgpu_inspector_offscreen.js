import * as THREE from '../../../build/three.webgpu.js';
import { WorkerInspectorBackend } from '../inspector/worker/WorkerInspectorBackend.js';

const PALETTES = {
	sunset: { background: 0x10151d, key: 0xffffff, fill: 0xff8844, keyIntensity: 2.4, fillIntensity: 18, hueOffset: 0.00, saturation: 0.65, lightness: 0.55 },
	arctic: { background: 0x0a1620, key: 0xd8f1ff, fill: 0x5bc0ff, keyIntensity: 2.8, fillIntensity: 16, hueOffset: 0.18, saturation: 0.50, lightness: 0.62 },
	mono: { background: 0x111111, key: 0xf3f3f3, fill: 0xb8b8b8, keyIntensity: 2.0, fillIntensity: 12, hueOffset: 0.00, saturation: 0.00, lightness: 0.65 }
};

const controls = {
	rotationSpeed: 0.2,
	bobAmplitude: 0.7,
	clearcoat: 0.7,
	metalness: 0.15,
	palette: 'sunset',
	fillColor: PALETTES.sunset.fill,
	averageHeight: 0,
	cyclePalette() {}
};

const cameraTarget = new THREE.Vector3( 0, 0.35, 0 );

let camera, scene, renderer, group, keyLight, fillLight;
let inspectorPort = null;

if ( typeof self !== 'undefined' ) {

	self.onmessage = async ( event ) => {

		const data = event.data;

		switch ( data.type ) {

			case 'init':

				await init( data );
				break;

			case 'resize':

				onResize( data.width, data.height, data.pixelRatio );
				break;

		}

	};

}

async function init( data ) {

	inspectorPort = data.inspectorPort || null;

	camera = new THREE.PerspectiveCamera( 45, data.width / data.height, 0.1, 100 );
	camera.position.set( 0, 2.6, 11.5 );
	camera.lookAt( cameraTarget );

	scene = new THREE.Scene();
	scene.name = 'Worker Scene';
	scene.background = new THREE.Color( 0x10151d );
	scene.fog = new THREE.Fog( 0x10151d, 12, 30 );

	group = new THREE.Group();
	scene.add( group );

	scene.add( new THREE.HemisphereLight( 0x88aaff, 0x101018, 1.1 ) );

	keyLight = new THREE.DirectionalLight( 0xffffff, 2.4 );
	keyLight.position.set( 3, 7, 4 );
	scene.add( keyLight );

	fillLight = new THREE.PointLight( 0xff8844, 18, 30, 2 );
	fillLight.position.set( - 4, 2, 4 );
	scene.add( fillLight );

	const geometry = new THREE.TorusKnotGeometry( 0.45, 0.16, 160, 32 );

	for ( let i = 0; i < 42; i ++ ) {

		const material = new THREE.MeshPhysicalMaterial( {
			color: new THREE.Color().setHSL( i / 42, 0.65, 0.55 ),
			roughness: 0.2,
			metalness: 0.15,
			clearcoat: 0.7
		} );

		const mesh = new THREE.Mesh( geometry, material );
		const angle = ( i / 42 ) * Math.PI * 2;
		const radius = 4 + ( i % 3 ) * 0.45;

		mesh.position.set( Math.cos( angle ) * radius, Math.sin( angle * 2 ) * 0.8, Math.sin( angle ) * radius );
		mesh.rotation.set( angle * 0.5, angle, 0 );
		mesh.scale.setScalar( 0.55 + ( i % 5 ) * 0.08 );

		group.add( mesh );

	}

	renderer = new THREE.WebGPURenderer( { canvas: data.drawingSurface, antialias: true } );
	renderer.setPixelRatio( data.pixelRatio );
	renderer.setSize( data.width, data.height, false );
	renderer.inspector = new WorkerInspectorBackend( inspectorPort );

	setupInspectorControls();
	applyPalette( controls.palette );
	applyMaterial();

	try {

		await renderer.init();
		postConsole( 'log', 'WorkerInspectorBackend: Connected to worker renderer.' );

	} catch ( error ) {

		postConsole( 'error', `WorkerInspectorBackend: ${ error.message }` );
		throw error;

	}

	renderer.setAnimationLoop( animate );

}

function onResize( width, height, pixelRatio ) {

	if ( renderer === undefined ) return;

	camera.aspect = width / height;
	camera.updateProjectionMatrix();
	camera.lookAt( cameraTarget );

	renderer.setPixelRatio( pixelRatio );
	renderer.setSize( width, height, false );

}

function animate() {

	const time = performance.now() * 0.001;
	let averageHeight = 0;

	group.rotation.y = time * controls.rotationSpeed;

	for ( let i = 0; i < group.children.length; i ++ ) {

		const mesh = group.children[ i ];
		const phase = time + i * 0.12;

		mesh.rotation.x += 0.003;
		mesh.rotation.z += 0.002;
		mesh.position.y = Math.sin( phase * 1.5 ) * controls.bobAmplitude;
		averageHeight += mesh.position.y;

	}

	controls.averageHeight = averageHeight / group.children.length;

	renderer.render( scene, camera );

}

function applyMaterial() {

	for ( const mesh of group.children ) {

		mesh.material.clearcoat = controls.clearcoat;
		mesh.material.metalness = controls.metalness;

	}

}

function applyPalette( name ) {

	const palette = PALETTES[ name ] || PALETTES.sunset;

	controls.palette = name;
	controls.fillColor = palette.fill;

	scene.background.setHex( palette.background );
	scene.fog.color.setHex( palette.background );

	keyLight.color.setHex( palette.key );
	keyLight.intensity = palette.keyIntensity;

	fillLight.color.setHex( palette.fill );
	fillLight.intensity = palette.fillIntensity;

	for ( let i = 0; i < group.children.length; i ++ ) {

		group.children[ i ].material.color.setHSL( ( i / group.children.length + palette.hueOffset ) % 1, palette.saturation, palette.lightness );

	}

}

function setupInspectorControls() {

	const gui = renderer.inspector.createParameters( 'Scene' );

	gui.add( controls, 'rotationSpeed', 0, 1, 0.01 ).name( 'orbit speed' );
	gui.add( controls, 'bobAmplitude', 0, 1.5, 0.01 ).name( 'bob amplitude' );
	gui.add( controls, 'palette', {
		Sunset: 'sunset',
		Arctic: 'arctic',
		Mono: 'mono'
	} ).name( 'palette' ).listen().onChange( ( value ) => {

		applyPalette( value );

	} );

	const lighting = gui.addFolder( 'Lighting' );
	lighting.add( keyLight, 'visible' ).name( 'key light' );
	lighting.add( fillLight, 'intensity', 0, 24, 0.1 ).name( 'fill intensity' ).listen();
	lighting.addColor( controls, 'fillColor' ).name( 'fill color' ).listen().onChange( ( value ) => {

		fillLight.color.setHex( value );

	} );

	const material = gui.addFolder( 'Material' );
	material.add( controls, 'clearcoat', 0, 1, 0.01 ).listen().onChange( applyMaterial );
	material.add( controls, 'metalness', 0, 1, 0.01 ).listen().onChange( applyMaterial );

	controls.cyclePalette = () => {

		const entries = Object.keys( PALETTES );
		const index = entries.indexOf( controls.palette );
		const nextPalette = entries[ ( index + 1 ) % entries.length ];

		applyPalette( nextPalette );

	};

	material.add( controls, 'cyclePalette' ).name( 'cycle palette' );

	const stats = gui.addFolder( 'Stats' );
	stats.add( controls, 'averageHeight' ).name( 'avg height' ).listen();
	stats.close();

}

function postConsole( level, message ) {

	if ( inspectorPort === null ) return;

	inspectorPort.postMessage( {
		type: 'console',
		level,
		message
	} );

}
