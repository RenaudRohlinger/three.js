import { InspectorBase, REVISION, setConsoleFunction } from '../../../../build/three.webgpu.js';
import { WorkerTimelineRecorder } from './WorkerTimelineRecorder.js';

function getSceneName( scene ) {

	let name = scene?.name || '';

	if ( name === '' ) {

		if ( scene?.isScene ) {

			name = 'Scene';

		} else if ( scene?.isQuadMesh ) {

			name = 'QuadMesh';

		}

	}

	return name || 'Render';

}

function formatConsoleParam( value ) {

	if ( value === undefined ) return 'undefined';
	if ( value === null ) return 'null';

	if ( typeof value === 'string' ) return value;
	if ( typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint' ) return String( value );

	if ( value instanceof Error ) return value.message;

	try {

		return JSON.stringify( value );

	} catch {

		return String( value );

	}

}

function serializeStats( stats ) {

	return {
		uid: stats.uid,
		cid: stats.cid,
		name: stats.name,
		cpu: stats.cpu,
		gpu: 0,
		gpuNotAvailable: true,
		isComputeStats: stats.isComputeStats === true,
		isRenderStats: stats.isRenderStats === true,
		children: stats.children.map( serializeStats )
	};

}

function accumulateStats( stats ) {

	let cpu = stats.cpu;
	let gpu = stats.gpu;

	for ( const child of stats.children ) {

		const totals = accumulateStats( child );
		cpu += totals.cpu;
		gpu += totals.gpu;

	}

	return {
		cpu,
		gpu,
		total: cpu + gpu
	};

}

function cloneMemory( memory = {} ) {

	return {
		textures: memory.textures || 0,
		texturesSize: memory.texturesSize || 0,
		renderTargets: memory.renderTargets || 0,
		geometries: memory.geometries || 0,
		attributes: memory.attributes || 0,
		attributesSize: memory.attributesSize || 0,
		indexAttributes: memory.indexAttributes || 0,
		indexAttributesSize: memory.indexAttributesSize || 0,
		indirectStorageAttributes: memory.indirectStorageAttributes || 0,
		indirectStorageAttributesSize: memory.indirectStorageAttributesSize || 0,
		storageAttributes: memory.storageAttributes || 0,
		storageAttributesSize: memory.storageAttributesSize || 0,
		programs: memory.programs || 0,
		programsSize: memory.programsSize || 0,
		total: memory.total || 0
	};

}

class WorkerParameterController {

	constructor( inspector, groupId, object, property, type, options = {} ) {

		this.inspector = inspector;
		this.id = `control-${ inspector._nextParameterControlId ++ }`;
		this.groupId = groupId;
		this.object = object;
		this.property = property;
		this.type = type;
		this.label = property;
		this.options = options;
		this._onChange = null;
		this._listen = false;
		this._lastValue = this.serializeValue();

		this.inspector._parameterControls.set( this.id, this );
		this.inspector.postMessage( {
			type: 'parameters:control',
			control: this.serialize()
		} );

	}

	name( label ) {

		this.label = label;

		this.inspector.postMessage( {
			type: 'parameters:label',
			controlId: this.id,
			label
		} );

		return this;

	}

	onChange( callback ) {

		this._onChange = callback;
		return this;

	}

	listen() {

		this._listen = true;
		this.inspector._listeningParameterControls.add( this );
		this.inspector._syncRemoteController( this, true );

		return this;

	}

	step( value ) {

		this.options.step = value;

		this.inspector.postMessage( {
			type: 'parameters:config',
			controlId: this.id,
			config: { step: value }
		} );

		return this;

	}

	setValue( value ) {

		this.applyValue( value, 'local' );
		return this;

	}

	getValue() {

		return this.object[ this.property ];

	}

	serializeValue() {

		return this.inspector._serializeParameterValue( this.object[ this.property ], this.type );

	}

	serialize() {

		return {
			id: this.id,
			groupId: this.groupId,
			type: this.type,
			property: this.property,
			label: this.label,
			value: this.serializeValue(),
			options: this.options.options,
			min: this.options.min,
			max: this.options.max,
			step: this.options.step
		};

	}

	invoke() {

		const fn = this.object[ this.property ];

		if ( typeof fn === 'function' ) {

			fn.call( this.object );

		}

	}

	applyValue( value, source = 'remote' ) {

		if ( this.type === 'button' ) {

			this.invoke();
			return;

		}

		if ( this.type === 'color' ) {

			const currentValue = this.object[ this.property ];

			if ( currentValue && currentValue.isColor === true ) {

				currentValue.setHex( value );

			} else {

				this.object[ this.property ] = value;

			}

		} else {

			this.object[ this.property ] = value;

		}

		if ( this._onChange ) {

			this._onChange( this.object[ this.property ] );

		}

		this.inspector._syncRemoteController( this, source !== 'remote' );

	}

}

class WorkerParametersGroup {

	constructor( inspector, id, name ) {

		this.inspector = inspector;
		this.id = id;
		this.name = name;

	}

	close() {

		this.inspector.postMessage( {
			type: 'parameters:groupState',
			groupId: this.id,
			closed: true
		} );

		return this;

	}

	add( object, property, ...params ) {

		const value = object[ property ];
		const type = typeof value;

		if ( typeof params[ 0 ] === 'object' ) {

			return this.addSelect( object, property, params[ 0 ] );

		} else if ( type === 'number' ) {

			if ( params.length >= 2 ) {

				return this.addSlider( object, property, ...params );

			}

			return this.addNumber( object, property, ...params );

		} else if ( type === 'boolean' ) {

			return this.addBoolean( object, property );

		} else if ( type === 'string' ) {

			return this.addString( object, property );

		} else if ( type === 'function' ) {

			return this.addButton( object, property );

		}

		return null;

	}

	addFolder( name ) {

		return this.inspector._createParameterGroup( name, this.id );

	}

	addString( object, property ) {

		return this.inspector._createParameterController( this.id, object, property, 'string' );

	}

	addBoolean( object, property ) {

		return this.inspector._createParameterController( this.id, object, property, 'boolean' );

	}

	addSelect( object, property, options ) {

		return this.inspector._createParameterController( this.id, object, property, 'select', { options } );

	}

	addColor( object, property ) {

		return this.inspector._createParameterController( this.id, object, property, 'color' );

	}

	addSlider( object, property, min = 0, max = 1, step = 0.01 ) {

		return this.inspector._createParameterController( this.id, object, property, 'slider', { min, max, step } );

	}

	addNumber( object, property, min = - Infinity, max = Infinity ) {

		return this.inspector._createParameterController( this.id, object, property, 'number', { min, max } );

	}

	addButton( object, property ) {

		return this.inspector._createParameterController( this.id, object, property, 'button' );

	}

}

class WorkerInspectorBackend extends InspectorBase {

	constructor( endpoint = null ) {

		super();

		this.endpoint = null;
		this.currentRender = null;
		this.currentCompute = null;
		this.currentNodes = null;
		this.frames = [];
		this.maxFrames = 120;
		this.fps = 0;
		this._lastFinishTime = 0;
		this._endpointMessageHandler = null;
		this.timelineRecorder = null;
		this._nextParameterGroupId = 0;
		this._nextParameterControlId = 0;
		this._parameterGroups = new Map();
		this._parameterControls = new Map();
		this._listeningParameterControls = new Set();

		this.setEndpoint( endpoint );

	}

	setEndpoint( endpoint ) {

		if ( this.endpoint !== null && this._endpointMessageHandler !== null ) {

			if ( typeof this.endpoint.removeEventListener === 'function' ) {

				this.endpoint.removeEventListener( 'message', this._endpointMessageHandler );

			} else if ( this.endpoint.onmessage === this._endpointMessageHandler ) {

				this.endpoint.onmessage = null;

			}

		}

		this.endpoint = endpoint;
		this._endpointMessageHandler = ( event ) => {

			this.handleMessage( event.data );

		};

		if ( endpoint !== null ) {

			if ( typeof endpoint.addEventListener === 'function' ) {

				endpoint.addEventListener( 'message', this._endpointMessageHandler );

			} else {

				endpoint.onmessage = this._endpointMessageHandler;

			}

		}

		if ( endpoint !== null && typeof endpoint.start === 'function' ) {

			endpoint.start();

		}

		return this;

	}

	setRenderer( renderer ) {

		super.setRenderer( renderer );

		setConsoleFunction( renderer !== null ? this.resolveConsole.bind( this ) : null );

		if ( renderer !== null ) {

			this.postMessage( {
				type: 'init',
				revision: REVISION,
				backend: renderer.backend.isWebGPUBackend ? 'WebGPU' : renderer.backend.isWebGLBackend ? 'WebGL2' : 'Unknown'
			} );

			this.postMessage( {
				type: 'parameters:reset'
			} );

			this.postMessage( {
				type: 'timeline:state',
				recording: false
			} );

			this.timelineRecorder = new WorkerTimelineRecorder( renderer, this.postMessage.bind( this ) );

		}

		return this;

	}

	resolveConsole( type, message, ...params ) {

		const text = [ message, ...params ].map( formatConsoleParam ).join( ' ' ).trim();

		this.postMessage( {
			type: 'console',
			level: type,
			message: text
		} );

	}

	postMessage( data ) {

		if ( this.endpoint === null || typeof this.endpoint.postMessage !== 'function' ) return;

		this.endpoint.postMessage( data );

	}

	handleMessage( data ) {

		if ( data === null || typeof data !== 'object' ) return;

		switch ( data.type ) {

			case 'parameters:set':

				this._handleParameterSet( data.controlId, data.value );
				break;

			case 'parameters:invoke':

				this._handleParameterInvoke( data.controlId );
				break;

			case 'timeline:start':

				this.timelineRecorder?.start();
				break;

			case 'timeline:stop':

				this.timelineRecorder?.stop();
				break;

			case 'timeline:clear':

				this.timelineRecorder?.clear();
				break;

		}

	}

	createParameters( name ) {

		return this._createParameterGroup( name );

	}

	_createParameterGroup( name, parentId = null ) {

		const id = `group-${ this._nextParameterGroupId ++ }`;
		const group = new WorkerParametersGroup( this, id, name );

		this._parameterGroups.set( id, group );

		this.postMessage( {
			type: 'parameters:group',
			groupId: id,
			parentId,
			name
		} );

		return group;

	}

	_createParameterController( groupId, object, property, type, options = {} ) {

		return new WorkerParameterController( this, groupId, object, property, type, options );

	}

	_handleParameterSet( controlId, value ) {

		const control = this._parameterControls.get( controlId );

		if ( control ) {

			control.applyValue( value, 'remote' );

		}

	}

	_handleParameterInvoke( controlId ) {

		const control = this._parameterControls.get( controlId );

		if ( control ) {

			control.invoke();

		}

	}

	_serializeParameterValue( value, type ) {

		if ( type === 'button' || typeof value === 'function' ) {

			return null;

		}

		if ( type === 'color' ) {

			if ( value && value.isColor === true ) {

				return value.getHex();

			}

			return typeof value === 'string' ? parseInt( value.replace( '#', '' ), 16 ) : value;

		}

		return value;

	}

	_syncRemoteController( control, force = false ) {

		if ( control.type === 'button' ) return;

		const value = control.serializeValue();

		if ( force !== true && control._listen !== true && value === control._lastValue ) return;

		control._lastValue = value;

		this.postMessage( {
			type: 'parameters:value',
			controlId: control.id,
			value
		} );

	}

	getFrame() {

		return this.currentFrame;

	}

	getParent() {

		return this.currentRender || this.getFrame();

	}

	begin() {

		this.currentFrame = {
			frameId: this.nodeFrame.frameId,
			deltaTime: 0,
			startTime: performance.now(),
			finishTime: 0,
			fps: 0,
			children: [],
			renders: [],
			computes: [],
			nodes: []
		};

		this.currentRender = this.currentFrame;
		this.currentCompute = null;
		this.currentNodes = [];

	}

	finish() {

		if ( this.currentFrame === null ) return;

		const now = performance.now();
		const frame = this.currentFrame;

		frame.finishTime = now;
		frame.deltaTime = now - ( this._lastFinishTime > 0 ? this._lastFinishTime : now );
		frame.nodes = this.currentNodes.map( ( node ) => node?.getName?.() || node?.name || node?.type || node?.constructor?.name || 'Node' );

		this.addFrame( frame );
		this._syncListeningParameters();

		this.currentFrame = null;
		this.currentRender = null;
		this.currentCompute = null;
		this.currentNodes = null;
		this._lastFinishTime = now;

	}

	_syncListeningParameters() {

		for ( const control of this._listeningParameterControls ) {

			this._syncRemoteController( control );

		}

	}

	addFrame( frame ) {

		if ( this.frames.length >= this.maxFrames ) {

			this.frames.shift();

		}

		this.frames.push( frame );
		this.fps = this.getFPS();
		frame.fps = this.fps;

		const serializedChildren = frame.children.map( serializeStats );
		let cpu = 0;
		let gpu = 0;

		for ( const child of serializedChildren ) {

			const totals = accumulateStats( child );
			cpu += totals.cpu;
			gpu += totals.gpu;

		}

		const total = cpu + gpu;
		const miscellaneous = Math.max( frame.deltaTime - total, 0 );

		this.postMessage( {
			type: 'frame',
			frame: {
				frameId: frame.frameId,
				startTime: frame.startTime,
				finishTime: frame.finishTime,
				deltaTime: frame.deltaTime,
				fps: frame.fps,
				cpu,
				gpu,
				total,
				miscellaneous,
				children: serializedChildren,
				nodes: frame.nodes
			},
			memory: cloneMemory( this.getRenderer()?.info?.memory )
		} );

	}

	getFPS() {

		let frameSum = 0;
		let timeSum = 0;

		for ( let i = this.frames.length - 1; i >= 0; i -- ) {

			const frame = this.frames[ i ];

			frameSum ++;
			timeSum += frame.deltaTime;

			if ( timeSum >= 1000 ) break;

		}

		return timeSum > 0 ? ( frameSum * 1000 ) / timeSum : 0;

	}

	inspect( node ) {

		if ( this.currentNodes !== null ) {

			this.currentNodes.push( node );

		}

	}

	beginCompute( uid, computeNode ) {

		const frame = this.getFrame();

		if ( frame === null ) return;

		const currentCompute = {
			uid,
			cid: uid.match( /^(.*):f(\d+)$/ )?.[ 1 ] || uid,
			name: computeNode?.name || 'Compute',
			timestamp: performance.now(),
			cpu: 0,
			gpu: 0,
			children: [],
			parent: this.currentCompute || this.getParent(),
			isComputeStats: true
		};

		frame.computes.push( currentCompute );

		if ( this.currentRender !== null ) {

			this.currentRender.children.push( currentCompute );

		} else {

			frame.children.push( currentCompute );

		}

		this.currentCompute = currentCompute;

	}

	finishCompute() {

		if ( this.currentCompute === null ) return;

		const currentCompute = this.currentCompute;

		currentCompute.cpu = performance.now() - currentCompute.timestamp;
		this.currentCompute = currentCompute.parent?.isComputeStats === true ? currentCompute.parent : null;

	}

	beginRender( uid, scene, camera, renderTarget ) {

		const frame = this.getFrame();

		if ( frame === null ) return;

		const currentRender = {
			uid,
			cid: uid.match( /^(.*):f(\d+)$/ )?.[ 1 ] || uid,
			name: getSceneName( scene ),
			timestamp: performance.now(),
			cpu: 0,
			gpu: 0,
			children: [],
			parent: this.getParent(),
			renderTarget: renderTarget ? renderTarget.texture?.name || renderTarget.name || 'Render Target' : null,
			cameraName: camera?.name || camera?.type || 'Camera',
			isRenderStats: true
		};

		frame.renders.push( currentRender );

		if ( this.currentRender !== null ) {

			this.currentRender.children.push( currentRender );

		} else {

			frame.children.push( currentRender );

		}

		this.currentRender = currentRender;

	}

	finishRender() {

		if ( this.currentRender === null ) return;

		const currentRender = this.currentRender;

		currentRender.cpu = performance.now() - currentRender.timestamp;
		this.currentRender = currentRender.parent?.isRenderStats === true ? currentRender.parent : null;

	}

}

export { WorkerInspectorBackend };
