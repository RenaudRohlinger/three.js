import { REVISION } from 'three/webgpu';

import { Inspector } from '../Inspector.js';
import { RendererInspector } from '../RendererInspector.js';
import { Performance } from '../tabs/Performance.js';
import { Memory } from '../tabs/Memory.js';
import { Console } from '../tabs/Console.js';
import { setText } from '../ui/utils.js';
import { WorkerParameters } from './tabs/WorkerParameters.js';
import { WorkerTimeline } from './tabs/WorkerTimeline.js';

function createMemoryState() {

	return {
		textures: 0,
		texturesSize: 0,
		renderTargets: 0,
		geometries: 0,
		attributes: 0,
		attributesSize: 0,
		indexAttributes: 0,
		indexAttributesSize: 0,
		indirectStorageAttributes: 0,
		indirectStorageAttributesSize: 0,
		storageAttributes: 0,
		storageAttributesSize: 0,
		programs: 0,
		programsSize: 0,
		total: 0
	};

}

class WorkerInspector extends Inspector {

	constructor() {

		super();

		this._remoteEndpoint = null;
		this._remoteMessageHandler = null;
		this._remoteRenderer = null;
		this.isWorkerInspector = true;

		if ( this.profiler.activeTabId === null || this.profiler.tabs[ this.profiler.activeTabId ] === undefined ) {

			this.profiler.setActiveTab( this.performance.id );

		}

	}

	_createTabs() {

		const parameters = new WorkerParameters( {
			builtin: true,
			icon: '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path stroke="none" d="M0 0h24v24H0z" fill="none"/><path d="M14 6m-2 0a2 2 0 1 0 4 0a2 2 0 1 0 -4 0" /><path d="M4 6l8 0" /><path d="M16 6l4 0" /><path d="M8 12m-2 0a2 2 0 1 0 4 0a2 2 0 1 0 -4 0" /><path d="M4 12l2 0" /><path d="M10 12l10 0" /><path d="M17 18m-2 0a2 2 0 1 0 4 0a2 2 0 1 0 -4 0" /><path d="M4 18l11 0" /><path d="M19 18l1 0" /></svg>'
		} );
		parameters.hide();

		return {
			parameters,
			viewer: null,
			performance: new Performance(),
			memory: new Memory(),
			timeline: new WorkerTimeline(),
			consoleTab: new Console(),
			settings: null
		};

	}

	onExtension() {

		this.resolveConsoleOnce( 'warn', 'THREE.WorkerInspector: Extensions are unavailable in worker mode.' );
		return this;

	}

	setActiveExtension() {

		this.resolveConsoleOnce( 'warn', 'THREE.WorkerInspector: Extensions are unavailable in worker mode.' );
		return this;

	}

	connect( endpoint ) {

		if ( endpoint === null || typeof endpoint !== 'object' ) {

			throw new Error( 'WorkerInspector.connect: Expected a MessagePort or Worker-like endpoint.' );

		}

		this.disconnect();
		this._resetRemoteState();
		this._ensureRemoteRenderer();

		this.parameters.resetRemote();
		this.timeline.setRemoteMode( true );
		this.timeline.clear( false );

		this._remoteEndpoint = endpoint;
		this._remoteMessageHandler = ( event ) => {

			this._handleRemoteMessage( event.data );

		};

		if ( typeof endpoint.addEventListener === 'function' ) {

			endpoint.addEventListener( 'message', this._remoteMessageHandler );

		} else {

			endpoint.onmessage = this._remoteMessageHandler;

		}

		if ( typeof endpoint.start === 'function' ) {

			endpoint.start();

		}

		this.resolveConsole( 'log', 'THREE.WorkerInspector: Waiting for worker frames.' );
		this.profiler.setActiveTab( this.performance.id );

		return this;

	}

	disconnect() {

		const endpoint = this._remoteEndpoint;

		if ( endpoint !== null && this._remoteMessageHandler !== null ) {

			if ( typeof endpoint.removeEventListener === 'function' ) {

				endpoint.removeEventListener( 'message', this._remoteMessageHandler );

			} else if ( endpoint.onmessage === this._remoteMessageHandler ) {

				endpoint.onmessage = null;

			}

		}

		this._remoteEndpoint = null;
		this._remoteMessageHandler = null;

		return this;

	}

	sendRemoteMessage( data ) {

		if ( this._remoteEndpoint === null || typeof this._remoteEndpoint.postMessage !== 'function' ) return;

		this._remoteEndpoint.postMessage( data );

	}

	_resetRemoteState() {

		this.frames = [];
		this.framesLib = {};
		this.lastFrame = null;
		this.currentFrame = null;
		this.currentRender = null;
		this.currentNodes = null;
		this.fps = 0;
		this.statsData.clear();

		if ( this._remoteRenderer !== null ) {

			this._remoteRenderer.info.memory = createMemoryState();
			this._remoteRenderer._nodes.nodeFrame.frameId = 0;
			this._remoteRenderer._nodes.nodeFrame.deltaTime = 0;

		}

	}

	_ensureRemoteRenderer() {

		if ( this._remoteRenderer !== null ) return this._remoteRenderer;

		this._remoteRenderer = {
			isRemoteRenderer: true,
			backend: {
				isWebGPUBackend: false,
				isWebGLBackend: false
			},
			info: { memory: createMemoryState() },
			_nodes: {
				nodeFrame: {
					frameId: 0,
					deltaTime: 0
				}
			}
		};

		RendererInspector.prototype.setRenderer.call( this, this._remoteRenderer );

		return this._remoteRenderer;

	}

	_handleRemoteMessage( data ) {

		if ( data === null || typeof data !== 'object' ) return;

		switch ( data.type ) {

			case 'init':

				this._handleRemoteInit( data );
				break;

			case 'console':

				this.resolveConsole( data.level || 'log', data.message || '' );
				break;

			case 'parameters:reset':

				this.parameters.resetRemote();
				break;

			case 'parameters:group':

				this.parameters.ensureRemoteGroup( data.groupId, data.name, data.parentId );
				break;

			case 'parameters:groupState':

				this.parameters.updateRemoteGroupState( data.groupId, data.closed );
				break;

			case 'parameters:control':

				this.parameters.addRemoteControl( data.control );
				break;

			case 'parameters:label':

				this.parameters.updateRemoteControlLabel( data.controlId, data.label );
				break;

			case 'parameters:config':

				this.parameters.updateRemoteControlConfig( data.controlId, data.config );
				break;

			case 'parameters:value':

				this.parameters.updateRemoteControlValue( data.controlId, data.value );
				break;

			case 'timeline:state':

				this.timeline.handleRemoteState( data.recording );
				break;

			case 'timeline:clear':

				this.timeline.handleRemoteClear();
				break;

			case 'timeline:frame':

				this.timeline.handleRemoteFrame( data.frame );
				break;

			case 'frame':

				this._handleRemoteFrame( data.frame, data.memory );
				break;

		}

	}

	_handleRemoteInit( data ) {

		const renderer = this._ensureRemoteRenderer();
		const backend = data.backend || 'Unknown';

		renderer.backend.isWebGPUBackend = backend === 'WebGPU';
		renderer.backend.isWebGLBackend = backend === 'WebGL2';

		this.resolveConsole( 'log', `THREE.WorkerInspector: ${ data.revision || REVISION } [ "${ backend }" ]` );

	}

	_handleRemoteFrame( frame, memory ) {

		if ( frame === undefined || frame === null ) return;

		const renderer = this._ensureRemoteRenderer();
		const wasEmpty = this.frames.length === 0;

		if ( this.frames.length >= this.maxFrames ) {

			const removedFrame = this.frames.shift();
			delete this.framesLib[ removedFrame.frameId ];

		}

		renderer.info.memory = Object.assign( renderer.info.memory, memory || {} );
		renderer._nodes.nodeFrame.frameId = frame.frameId;
		renderer._nodes.nodeFrame.deltaTime = frame.deltaTime / 1000;

		this._attachRemoteParents( frame, frame.children );

		this.frames.push( frame );
		this.framesLib[ frame.frameId ] = frame;
		this.lastFrame = frame;
		this.currentFrame = null;
		this.currentRender = null;
		this.currentNodes = frame.nodes || [];
		this.fps = frame.fps || 0;

		for ( const stats of frame.children ) {

			this.resolveStats( stats );

		}

		if ( wasEmpty ) {

			this.displayCycle.text.needsUpdate = true;
			this.displayCycle.graph.needsUpdate = true;

		}

		this.updateCycle( this.displayCycle.text );
		this.updateCycle( this.displayCycle.graph );

		if ( this.displayCycle.text.needsUpdate ) {

			setText( 'fps-counter', this.fps.toFixed() );

			this.performance.updateText( this, frame );
			this.memory.updateText( this );

		}

		if ( this.displayCycle.graph.needsUpdate ) {

			this.performance.updateGraph( this, frame );
			this.memory.updateGraph( this );

		}

		this.displayCycle.text.needsUpdate = false;
		this.displayCycle.graph.needsUpdate = false;

	}

	_attachRemoteParents( frame, children, parent = frame ) {

		for ( const child of children ) {

			child.parent = parent;
			this._attachRemoteParents( frame, child.children, child );

		}

	}

}

export { WorkerInspector };
