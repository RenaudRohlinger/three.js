import {
	ByteType,
	FloatType,
	HalfFloatType,
	IntType,
	ShortType,
	UnsignedByteType,
	UnsignedInt101111Type,
	UnsignedInt248Type,
	UnsignedInt5999Type,
	UnsignedIntType,
	UnsignedShort4444Type,
	UnsignedShort5551Type,
	UnsignedShortType,
	AlphaFormat,
	RGBFormat,
	RGBAFormat,
	DepthFormat,
	DepthStencilFormat,
	RedFormat,
	RedIntegerFormat,
	RGFormat,
	RGIntegerFormat,
	RGBIntegerFormat,
	RGBAIntegerFormat
} from '../../../../build/three.webgpu.js';

class WorkerTimelineRecorder {

	constructor( renderer, postMessage ) {

		this.renderer = renderer;
		this.postMessage = postMessage;

		this.isRecording = false;
		this.currentFrame = null;
		this.originalMethods = new Map();

	}

	start() {

		if ( this.isRecording === true ) return;

		this.isRecording = true;
		this.currentFrame = null;

		this.postMessage( {
			type: 'timeline:clear'
		} );

		this.postMessage( {
			type: 'timeline:state',
			recording: true
		} );

		const backend = this.renderer.backend;
		const methods = Object.getOwnPropertyNames( Object.getPrototypeOf( backend ) ).filter( ( prop ) => prop !== 'constructor' );

		for ( const prop of methods ) {

			const descriptor = Object.getOwnPropertyDescriptor( Object.getPrototypeOf( backend ), prop );

			if ( descriptor && ( descriptor.get || descriptor.set ) ) continue;

			const originalFunc = backend[ prop ];

			if ( typeof originalFunc !== 'function' || typeof prop !== 'string' ) continue;

			this.originalMethods.set( prop, originalFunc );

			backend[ prop ] = ( ...args ) => {

				if ( prop.toLowerCase().includes( 'timestamp' ) || prop.startsWith( 'get' ) || prop.startsWith( 'set' ) || prop.startsWith( 'has' ) || prop.startsWith( '_' ) || prop.startsWith( 'needs' ) ) {

					return originalFunc.apply( backend, args );

				}

				this._ensureFrame();

				const call = { method: prop, target: null };
				const details = this.getCallDetail( prop, args );

				if ( details !== null ) {

					call.details = details;

					if ( details.triangles !== undefined ) {

						this.currentFrame.triangles += details.triangles;

					}

				}

				this.currentFrame.calls.push( call );

				return originalFunc.apply( backend, args );

			};

		}

	}

	stop() {

		if ( this.isRecording === false ) return;

		const backend = this.renderer.backend;

		for ( const [ prop, originalFunc ] of this.originalMethods.entries() ) {

			backend[ prop ] = originalFunc;

		}

		this.originalMethods.clear();
		this._finalizeFrame();

		this.isRecording = false;

		this.postMessage( {
			type: 'timeline:state',
			recording: false
		} );

	}

	clear() {

		this.currentFrame = null;

		this.postMessage( {
			type: 'timeline:clear'
		} );

	}

	_ensureFrame() {

		const frameNumber = this.renderer.info.frame;

		if ( this.currentFrame !== null && this.currentFrame.id !== frameNumber ) {

			this._finalizeFrame();

		}

		if ( this.currentFrame === null ) {

			this.currentFrame = { id: frameNumber, calls: [], fps: 0, triangles: 0 };

		}

	}

	_finalizeFrame() {

		if ( this.currentFrame === null ) return;

		this.currentFrame.fps = this.renderer.inspector ? this.renderer.inspector.fps : 0;

		if ( isFinite( this.currentFrame.fps ) !== true ) {

			this.currentFrame.fps = 0;

		}

		this.postMessage( {
			type: 'timeline:frame',
			frame: this.currentFrame
		} );

		this.currentFrame = null;

	}

	getRenderTargetDetails( renderTarget ) {

		const textures = renderTarget.textures;
		const attachments = [];

		const getBPC = ( texture ) => {

			switch ( texture.type ) {

				case ByteType:
				case UnsignedByteType:
					return '8';
				case ShortType:
				case UnsignedShortType:
				case HalfFloatType:
				case UnsignedShort4444Type:
				case UnsignedShort5551Type:
					return '16';
				case IntType:
				case UnsignedIntType:
				case FloatType:
				case UnsignedInt248Type:
				case UnsignedInt5999Type:
				case UnsignedInt101111Type:
					return '32';
				default:
					return '?';

			}

		};

		const getFormat = ( texture ) => {

			switch ( texture.format ) {

				case AlphaFormat:
					return 'a';
				case RedFormat:
				case RedIntegerFormat:
					return 'r';
				case RGFormat:
				case RGIntegerFormat:
					return 'rg';
				case RGBFormat:
				case RGBIntegerFormat:
					return 'rgb';
				case DepthFormat:
					return 'depth';
				case DepthStencilFormat:
					return 'depth-stencil';
				case RGBAFormat:
				case RGBAIntegerFormat:
				default:
					return 'rgba';

			}

		};

		for ( let i = 0; i < textures.length; i ++ ) {

			const texture = textures[ i ];

			const bpc = getBPC( texture );
			const format = getFormat( texture );

			let description = `[${ i }]`;

			if ( texture.name && ! ( texture.isDepthTexture && texture.name === 'depth' ) ) {

				description += ` ${ texture.name }`;

			}

			description += ` ${ format } ${ bpc } bpc`;

			attachments.push( description );

		}

		const details = {
			target: renderTarget.name || 'RenderTarget',
			[ `attachments(${ textures.length })` ]: attachments.join( ', ' )
		};

		if ( renderTarget.depthTexture ) {

			details.depth = `${ getBPC( renderTarget.depthTexture ) } bpc`;

		}

		return details;

	}

	getCallDetail( method, args ) {

		switch ( method ) {

			case 'draw': {

				const renderObject = args[ 0 ];

				const details = {
					object: renderObject.object.name || renderObject.object.type,
					material: renderObject.material.name || renderObject.material.type,
					geometry: renderObject.geometry.name || renderObject.geometry.type
				};

				if ( renderObject.getDrawParameters ) {

					const drawParams = renderObject.getDrawParameters();

					if ( drawParams ) {

						if ( renderObject.object.isMesh || renderObject.object.isSprite ) {

							details.triangles = drawParams.vertexCount / 3;

							if ( renderObject.object.count > 1 ) {

								details.instance = renderObject.object.count;
								details[ 'triangles per instance' ] = details.triangles;
								details.triangles *= details.instance;

							}

						}

					}

				}

				return details;

			}

			case 'beginRender': {

				const renderContext = args[ 0 ];
				const details = {
					scene: this.renderer.inspector.currentRender?.name || 'unknown',
					camera: renderContext.camera.name || renderContext.camera.type
				};

				if ( renderContext.renderTarget && ! renderContext.renderTarget.isPostProcessingRenderTarget ) {

					Object.assign( details, this.getRenderTargetDetails( renderContext.renderTarget ) );

				} else {

					details.target = 'CanvasTarget';

				}

				return details;

			}

			case 'beginCompute':
				return {
					compute: this.renderer.inspector.currentCompute?.name || 'unknown'
				};

			case 'compute': {

				const computeNode = args[ 1 ];
				const bindings = args[ 2 ];
				const dispatchSize = args[ 4 ] || computeNode.dispatchSize || computeNode.count;

				let dispatch;

				if ( dispatchSize.isIndirectStorageBufferAttribute ) {

					dispatch = 'indirect';

				} else if ( Array.isArray( dispatchSize ) ) {

					dispatch = dispatchSize.join( ', ' );

				} else {

					dispatch = dispatchSize;

				}

				return {
					node: computeNode.name || computeNode.type || 'unknown',
					bindings: bindings ? bindings.length : 0,
					dispatch
				};

			}

			case 'updateBinding':
				return { group: args[ 0 ].name || 'unknown' };

			case 'clear': {

				const renderContext = args[ 3 ];
				const details = {
					color: args[ 0 ],
					depth: args[ 1 ],
					stencil: args[ 2 ]
				};

				if ( renderContext.renderTarget && ! renderContext.renderTarget.isPostProcessingRenderTarget ) {

					Object.assign( details, this.getRenderTargetDetails( renderContext.renderTarget ) );

				} else {

					details.target = 'CanvasTarget';

				}

				return details;

			}

			case 'updateViewport': {

				const renderContext = args[ 0 ];
				const { x, y, width, height } = renderContext.viewportValue;

				return { x, y, width, height };

			}

			case 'updateScissor': {

				const renderContext = args[ 0 ];
				const { x, y, width, height } = renderContext.scissorValue;

				return { x, y, width, height };

			}

			case 'createProgram':
			case 'destroyProgram': {

				const program = args[ 0 ];
				return { stage: program.stage, name: program.name || 'unknown' };

			}

			case 'createRenderPipeline': {

				const renderObject = args[ 0 ];
				return {
					object: renderObject.object ? ( renderObject.object.name || renderObject.object.type || 'unknown' ) : 'unknown',
					material: renderObject.material ? ( renderObject.material.name || renderObject.material.type || 'unknown' ) : 'unknown'
				};

			}

			case 'createComputePipeline':
			case 'destroyComputePipeline':
				return { name: args[ 0 ].name || 'unknown' };

			case 'createBindings':
			case 'updateBindings': {

				const bindGroup = args[ 0 ];
				return {
					group: bindGroup.name || 'unknown',
					count: bindGroup.bindings ? bindGroup.bindings.length : undefined
				};

			}

			case 'createNodeBuilder': {

				const object = args[ 0 ];
				const details = { object: object.name || object.type || 'unknown' };

				if ( object.material ) {

					details.material = object.material.name || object.material.type || 'unknown';

				}

				return details;

			}

			case 'createAttribute':
			case 'createIndexAttribute':
			case 'createStorageAttribute':
			case 'destroyAttribute':
			case 'destroyIndexAttribute':
			case 'destroyStorageAttribute': {

				const attribute = args[ 0 ];
				const details = {};

				if ( attribute.name ) details.name = attribute.name;
				if ( attribute.count !== undefined ) details.count = attribute.count;
				if ( attribute.itemSize !== undefined ) details.itemSize = attribute.itemSize;

				return details;

			}

			case 'copyFramebufferToTexture': {

				const target = args[ 0 ];
				const rectangle = args[ 2 ];

				return {
					target: this.getTextureName( target ),
					width: rectangle.z,
					height: rectangle.w
				};

			}

			case 'copyTextureToTexture':
				return {
					source: this.getTextureName( args[ 0 ] ),
					destination: this.getTextureName( args[ 1 ] )
				};

			case 'updateSampler': {

				const texture = args[ 0 ];
				return {
					magFilter: this.getTextureFilterName( texture.magFilter ),
					minFilter: this.getTextureFilterName( texture.minFilter ),
					wrapS: this.getTextureWrapName( texture.wrapS ),
					wrapT: this.getTextureWrapName( texture.wrapT ),
					anisotropy: texture.anisotropy
				};

			}

			case 'updateTexture':
			case 'generateMipmaps':
			case 'createTexture':
			case 'destroyTexture': {

				const texture = args[ 0 ];
				const details = { texture: this.getTextureName( texture ) };

				if ( texture.image ) {

					if ( texture.image.width !== undefined ) details.width = texture.image.width;
					if ( texture.image.height !== undefined ) details.height = texture.image.height;

				}

				return details;

			}

		}

		return null;

	}

	getTextureName( texture ) {

		if ( texture.name ) return texture.name;

		const types = [
			'isFramebufferTexture', 'isDepthTexture', 'isDataArrayTexture',
			'isData3DTexture', 'isDataTexture', 'isCompressedArrayTexture',
			'isCompressedTexture', 'isCubeTexture', 'isVideoTexture',
			'isCanvasTexture', 'isTexture'
		];

		for ( const type of types ) {

			if ( texture[ type ] ) return type.replace( 'is', '' );

		}

		return 'Texture';

	}

	getTextureFilterName( filter ) {

		const filters = {
			1003: 'Nearest',
			1004: 'NearestMipmapNearest',
			1005: 'NearestMipmapLinear',
			1006: 'Linear',
			1007: 'LinearMipmapNearest',
			1008: 'LinearMipmapLinear'
		};

		return filters[ filter ] || filter;

	}

	getTextureWrapName( wrap ) {

		const wrappings = {
			1000: 'Repeat',
			1001: 'ClampToEdge',
			1002: 'MirroredRepeat'
		};

		return wrappings[ wrap ] || wrap;

	}

}

export { WorkerTimelineRecorder };
