import { hash, hashString } from '../../nodes/core/NodeUtils.js';
import RenderGeneration, { captureDrawState, drawStateEquals } from './RenderGeneration.js';
import RenderGenerationTask from './RenderGenerationTask.js';
import WorkTask from './WorkTask.js';

let _id = 0;

function getKeys( obj ) {

	const keys = Object.keys( obj );

	let proto = Object.getPrototypeOf( obj );

	while ( proto ) {

		const descriptors = Object.getOwnPropertyDescriptors( proto );

		for ( const key in descriptors ) {

			if ( descriptors[ key ] !== undefined ) {

				const descriptor = descriptors[ key ];

				if ( descriptor && typeof descriptor.get === 'function' ) {

					keys.push( key );

				}

			}

		}

		proto = Object.getPrototypeOf( proto );

	}

	return keys;

}

/**
 * A render object is the renderer's representation of single entity that gets drawn
 * with a draw command. There is no unique mapping of render objects to 3D objects in the
 * scene since render objects also depend from the used material, the current render context
 * and the current scene's lighting.
 *
 * In general, the basic process of the renderer is:
 *
 * - Analyze the 3D objects in the scene and generate render lists containing render items.
 * - Process the render lists by calling one or more render commands for each render item.
 * - For each render command, request a render object and perform the draw.
 *
 * The module provides an interface to get data required for the draw command like the actual
 * draw parameters or vertex buffers. It also holds a series of caching related methods since
 * creating render objects should only be done when necessary.
 *
 * @private
 */
class RenderObject {

	/**
	 * Constructs a new render object.
	 *
	 * @param {NodeManager} nodes - Renderer component for managing nodes related logic.
	 * @param {Geometries} geometries - Renderer component for managing geometries.
	 * @param {Renderer} renderer - The renderer.
	 * @param {Object3D} object - The 3D object.
	 * @param {Material} material - The 3D object's material.
	 * @param {Scene} scene - The scene the 3D object belongs to.
	 * @param {Camera} camera - The camera the object should be rendered with.
	 * @param {LightsNode} lightsNode - The lights node.
	 * @param {RenderContext} renderContext - The render context.
	 * @param {ClippingContext} clippingContext - The clipping context.
	 */
	constructor( nodes, geometries, renderer, object, material, scene, camera, lightsNode, renderContext, clippingContext ) {

		this.id = _id ++;

		/**
		 * Renderer component for managing nodes related logic.
		 *
		 * @type {NodeManager}
		 * @private
		 */
		this._nodes = nodes;

		/**
		 * Renderer component for managing geometries.
		 *
		 * @type {Geometries}
		 * @private
		 */
		this._geometries = geometries;

		/**
		 * The renderer.
		 *
		 * @type {Renderer}
		 */
		this.renderer = renderer;

		/**
		 * The 3D object.
		 *
		 * @type {Object3D}
		 */
		this.object = object;

		/**
		 * The 3D object's material.
		 *
		 * @type {Material}
		 */
		this.material = material;

		/**
		 * The scene the 3D object belongs to.
		 *
		 * @type {Scene}
		 */
		this.scene = scene;

		/**
		 * The camera the 3D object should be rendered with.
		 *
		 * @type {Camera}
		 */
		this.camera = camera;

		/**
		 * The lights node.
		 *
		 * @type {LightsNode}
		 */
		this.lightsNode = lightsNode;

		/**
		 * The render context.
		 *
		 * @type {RenderContext}
		 */
		this.context = renderContext;

		/**
		 * The 3D object's geometry.
		 *
		 * @type {BufferGeometry}
		 */
		this.geometry = object.geometry;

		/**
		 * The render object's version.
		 *
		 * @type {number}
		 */
		this.version = material.version;

		/**
		 * The draw range of the geometry.
		 *
		 * @type {?Object}
		 * @default null
		 */
		this.drawRange = null;

		/**
		 * An array holding the buffer attributes
		 * of the render object. This entails attribute
		 * definitions on geometry and node level.
		 *
		 * @type {?Array<BufferAttribute>}
		 * @default null
		 */
		this.attributes = null;

		/**
		 * An object holding the version of the
		 * attributes. The keys are the attribute names
		 * and the values are the attribute versions.
		 *
		 * @type {?Object<string, number>}
		 * @default null
		 */
		this.attributesId = null;

		/**
		 * A reference to a render pipeline the render
		 * object is processed with.
		 *
		 * @type {RenderPipeline}
		 * @default null
		 */
		this.pipeline = null;

		/**
		 * Only relevant for objects using
		 * multiple materials. This represents a group entry
		 * from the respective `BufferGeometry`.
		 *
		 * @type {?{start: number, count: number}}
		 * @default null
		 */
		this.group = null;

		/**
		 * An array holding the vertex buffers which can
		 * be buffer attributes but also interleaved buffers.
		 *
		 * @type {?Array<BufferAttribute|InterleavedBuffer>}
		 * @default null
		 */
		this.vertexBuffers = null;

		/**
		 * The parameters for the draw command.
		 *
		 * @type {?Object}
		 * @default null
		 */
		this.drawParams = null;

		/**
		 * If this render object is used inside a render bundle,
		 * this property points to the respective bundle group.
		 *
		 * @type {?BundleGroup}
		 * @default null
		 */
		this.bundle = null;

		/**
		 * The clipping context.
		 *
		 * @type {ClippingContext}
		 */
		this.clippingContext = clippingContext;

		/**
		 * The clipping context's cache key.
		 *
		 * @type {string}
		 */
		this.clippingContextCacheKey = clippingContext !== null ? clippingContext.cacheKey : '';

		/**
		 * The initial node cache key.
		 *
		 * @type {number}
		 */
		this.initialNodesCacheKey = this.getDynamicCacheKey();

		/**
		 * The initial cache key.
		 *
		 * @type {number}
		 */
		this.initialCacheKey = this.getCacheKey();

		/**
		 * The node builder state.
		 *
		 * @type {?NodeBuilderState}
		 * @private
		 * @default null
		 */
		this._nodeBuilderState = null;

		/**
		 * An array of bindings.
		 *
		 * @type {?Array<BindGroup>}
		 * @private
		 * @default null
		 */
		this._bindings = null;

		/**
		 * Reference to the node material observer.
		 *
		 * @type {?NodeMaterialObserver}
		 * @private
		 * @default null
		 */
		this._monitor = null;

		/**
		 * The object's original material when this render object is drawn with an
		 * override material.
		 *
		 * @type {?Material}
		 * @private
		 * @default null
		 */
		this._sourceMaterial = renderer._currentSourceMaterial;

		/**
		 * The render generation currently drawn in async compilation mode.
		 * Drawing reads only from here; `null` means the render object is
		 * skipped until its first generation promotes.
		 *
		 * @type {?RenderGeneration}
		 * @default null
		 */
		this.active = null;

		/**
		 * The render generation being prepared in the background.
		 *
		 * @type {?RenderGeneration}
		 * @default null
		 */
		this.pending = null;

		/**
		 * Bumped on every structural generation request. Candidates capture
		 * this value and are re-validated against it at every phase
		 * transition; only the latest requested version can promote.
		 *
		 * @type {number}
		 * @default 0
		 */
		this.generationVersion = 0;

		/**
		 * The structural draw snapshot of the active generation. In async
		 * compilation mode the backend reads encode-time structural values
		 * (e.g. `wireframe`, `stencilRef`) from here instead of from the
		 * live material.
		 *
		 * @type {?Object}
		 * @default null
		 */
		this.drawState = null;

		/**
		 * An event listener which is defined by `RenderObjects`. It performs
		 * clean up tasks when `dispose()` on this render object.
		 *
		 * @method
		 */
		this.onDispose = null;

		/**
		 * This flag can be used for type testing.
		 *
		 * @type {boolean}
		 * @readonly
		 * @default true
		 */
		this.isRenderObject = true;

		/**
		 * An event listener which is executed when `dispose()` is called on
		 * the material of this render object.
		 *
		 * @method
		 */
		this.onMaterialDispose = () => {

			this.dispose();

		};

		/**
		 * An event listener which is executed when `dispose()` is called on
		 * the geometry of this render object.
		 *
		 * @method
		 */
		this.onGeometryDispose = () => {

			// clear geometry cache attributes

			this.attributes = null;
			this.attributesId = null;

		};

		this.material.addEventListener( 'dispose', this.onMaterialDispose );
		this.geometry.addEventListener( 'dispose', this.onGeometryDispose );

		if ( this._sourceMaterial !== null ) {

			this._sourceMaterial.addEventListener( 'dispose', this.onMaterialDispose );

		}

	}

	/**
	 * Updates the clipping context.
	 *
	 * @param {ClippingContext} context - The clipping context to set.
	 */
	updateClipping( context ) {

		this.clippingContext = context;

	}

	/**
	 * Whether the clipping requires an update or not.
	 *
	 * @type {boolean}
	 * @readonly
	 */
	get clippingNeedsUpdate() {

		if ( this.clippingContext === null || this.clippingContext.cacheKey === this.clippingContextCacheKey ) return false;

		this.clippingContextCacheKey = this.clippingContext.cacheKey;

		return true;

	}

	/**
	 * The number of clipping planes defined in context of hardware clipping.
	 *
	 * @type {number}
	 * @readonly
	 */
	get hardwareClippingPlanes() {

		return this.getNodeBuilderState().hardwareClipping === true ? this.clippingContext.unionClippingCount : 0;

	}

	/**
	 * Returns the node builder state of this render object.
	 *
	 * @return {NodeBuilderState} The node builder state.
	 */
	getNodeBuilderState() {

		return this._nodeBuilderState || ( this._nodeBuilderState = this._nodes.getForRender( this ) );

	}

	/**
	 * Returns the node material observer of this render object.
	 *
	 * @return {NodeMaterialObserver} The node material observer.
	 */
	getMonitor() {

		return this._monitor || ( this._monitor = this.getNodeBuilderState().observer );

	}

	/**
	 * Returns an array of bind groups of this render object.
	 *
	 * @return {Array<BindGroup>} The bindings.
	 */
	getBindings() {

		return this._bindings || ( this._bindings = this.getNodeBuilderState().createBindings() );

	}

	/**
	 * Returns a binding group by group name of this render object.
	 *
	 * @param {string} name - The name of the binding group.
	 * @return {?BindGroup} The bindings.
	 */
	getBindingGroup( name ) {

		for ( const bindingGroup of this.getBindings() ) {

			if ( bindingGroup.name === name ) {

				return bindingGroup;

			}

		}

	}

	/**
	 * Returns the index of the render object's geometry.
	 *
	 * @return {?BufferAttribute} The index. Returns `null` for non-indexed geometries.
	 */
	getIndex() {

		return this._geometries.getIndex( this );

	}

	/**
	 * Returns the indirect buffer attribute.
	 *
	 * @return {?BufferAttribute} The indirect attribute. `null` if no indirect drawing is used.
	 */
	getIndirect() {

		return this._geometries.getIndirect( this );

	}

	/**
	 * Returns the byte offset into the indirect attribute buffer.
	 *
	 * @return {number|Array<number>} The byte offset into the indirect attribute buffer.
	 */
	getIndirectOffset() {

		return this._geometries.getIndirectOffset( this );

	}

	/**
	 * Returns an array that acts as a key for identifying the render object in a chain map.
	 *
	 * @return {Array<Object>} An array with object references.
	 */
	getChainArray() {

		return [ this.object, this.material, this.context, this.lightsNode ];

	}

	/**
	 * This method is used when the geometry of a 3D object has been exchanged and the
	 * respective render object now requires an update.
	 *
	 * @param {BufferGeometry} geometry - The geometry to set.
	 */
	setGeometry( geometry ) {

		this.geometry = geometry;
		this.attributes = null;
		this.attributesId = null;

	}

	/**
	 * Computes the buffer attributes for the given node builder state. The
	 * returned data holds attribute definitions on geometry and node level.
	 *
	 * This is a pure computation without caching, so background generations
	 * can resolve their attributes without touching the active state.
	 *
	 * @param {NodeBuilderState} nodeBuilderState - The node builder state.
	 * @return {{attributes:Array<BufferAttribute>,vertexBuffers:Array<BufferAttribute|InterleavedBuffer>,attributesId:Object<string,number>}} The attribute data.
	 */
	computeAttributes( nodeBuilderState ) {

		const nodeAttributes = nodeBuilderState.nodeAttributes;
		const geometry = this.geometry;

		const attributes = [];
		const vertexBuffers = new Set();

		const attributesId = {};

		for ( const nodeAttribute of nodeAttributes ) {

			let attribute;

			if ( nodeAttribute.node && nodeAttribute.node.attribute ) {

				// node attribute
				attribute = nodeAttribute.node.attribute;

			} else {

				// geometry attribute
				attribute = geometry.getAttribute( nodeAttribute.name );

				if ( attribute !== undefined ) {

					if ( attribute.isInterleavedBufferAttribute ) {

						attributesId[ nodeAttribute.name ] = attribute.data.uuid;

					} else {

						attributesId[ nodeAttribute.name ] = attribute.id;

					}

				}

			}

			if ( attribute === undefined ) continue;

			attributes.push( attribute );

			const bufferAttribute = attribute.isInterleavedBufferAttribute ? attribute.data : attribute;
			vertexBuffers.add( bufferAttribute );

		}

		return { attributes, vertexBuffers: Array.from( vertexBuffers.values() ), attributesId };

	}

	/**
	 * Returns the buffer attributes of the render object. The returned array holds
	 * attribute definitions on geometry and node level.
	 *
	 * @return {Array<BufferAttribute>} An array with buffer attributes.
	 */
	getAttributes() {

		if ( this.attributes !== null ) return this.attributes;

		const { attributes, vertexBuffers, attributesId } = this.computeAttributes( this.getNodeBuilderState() );

		this.attributes = attributes;
		this.attributesId = attributesId;
		this.vertexBuffers = vertexBuffers;

		return attributes;

	}

	/**
	 * Returns the vertex buffers of the render object.
	 *
	 * @return {Array<BufferAttribute|InterleavedBuffer>} An array with buffer attribute or interleaved buffers.
	 */
	getVertexBuffers() {

		if ( this.vertexBuffers === null ) this.getAttributes();

		return this.vertexBuffers;

	}

	/**
	 * Returns the draw parameters for the render object.
	 *
	 * @return {?{vertexCount: number, firstVertex: number, instanceCount: number, firstInstance: number}} The draw parameters.
	 */
	getDrawParameters() {

		const { object, material, geometry, group, drawRange } = this;

		const drawParams = this.drawParams || ( this.drawParams = {
			vertexCount: 0,
			firstVertex: 0,
			instanceCount: 0,
			firstInstance: 0
		} );

		const index = this.getIndex();
		const hasIndex = ( index !== null );

		let instanceCount = 1;

		if ( geometry.isInstancedBufferGeometry === true ) {

			instanceCount = geometry.instanceCount;

		} else if ( object.count !== undefined ) {

			instanceCount = Math.max( 0, object.count );

		}

		if ( instanceCount === 0 ) return null;

		drawParams.instanceCount = instanceCount;

		if ( object.isBatchedMesh === true ) return drawParams;

		let rangeFactor = 1;

		const wireframe = this.drawState !== null ? this.drawState.wireframe : material.wireframe;

		if ( wireframe === true && ! object.isPoints && ! object.isLineSegments && ! object.isLine && ! object.isLineLoop ) {

			rangeFactor = 2;

		}

		let firstVertex = drawRange.start * rangeFactor;
		let lastVertex = ( drawRange.start + drawRange.count ) * rangeFactor;

		if ( group !== null ) {

			firstVertex = Math.max( firstVertex, group.start * rangeFactor );
			lastVertex = Math.min( lastVertex, ( group.start + group.count ) * rangeFactor );

		}

		const position = geometry.attributes.position;
		let itemCount = Infinity;

		if ( hasIndex ) {

			itemCount = index.count;

		} else if ( position !== undefined && position !== null ) {

			itemCount = position.count;

		}

		firstVertex = Math.max( firstVertex, 0 );
		lastVertex = Math.min( lastVertex, itemCount );

		const count = lastVertex - firstVertex;

		if ( count < 0 || count === Infinity ) return null;

		drawParams.vertexCount = count;
		drawParams.firstVertex = firstVertex;

		return drawParams;

	}

	/**
	 * Returns the render object's geometry cache key.
	 *
	 * The geometry cache key is part of the material cache key.
	 *
	 * @return {string} The geometry cache key.
	 */
	getGeometryCacheKey() {

		const { geometry } = this;

		let cacheKey = '';

		for ( const name of Object.keys( geometry.attributes ).sort() ) {

			const attribute = geometry.attributes[ name ];

			cacheKey += name + ',';

			if ( attribute.data ) cacheKey += attribute.data.stride + ',';
			if ( attribute.offset ) cacheKey += attribute.offset + ',';
			if ( attribute.itemSize ) cacheKey += attribute.itemSize + ',';
			if ( attribute.normalized ) cacheKey += 'n,';

		}

		// structural equality isn't sufficient for morph targets since the
		// data are maintained in textures. only if the targets are all equal
		// the texture and thus the `morphReference` can be shared.

		for ( const name of Object.keys( geometry.morphAttributes ).sort() ) {

			const targets = geometry.morphAttributes[ name ];

			cacheKey += 'morph-' + name + ',';

			for ( let i = 0, l = targets.length; i < l; i ++ ) {

				const attribute = targets[ i ];

				cacheKey += attribute.id + ',';

			}

		}

		if ( geometry.index ) {

			cacheKey += 'index,';

		}

		return cacheKey;

	}

	/**
	 * Returns the render object's material cache key.
	 *
	 * The material cache key is part of the render object cache key.
	 *
	 * @return {number} The material cache key.
	 */
	getMaterialCacheKey() {

		const { object, material, renderer } = this;

		let cacheKey = material.customProgramCacheKey();

		for ( const property of getKeys( material ) ) {

			if ( /^(is[A-Z]|_)|^(visible|version|uuid|name|opacity|userData)$/.test( property ) ) continue;

			const value = material[ property ];

			let valueKey;

			if ( value !== null ) {

				// some material values require a formatting

				const type = typeof value;

				if ( type === 'number' ) {

					valueKey = value !== 0 ? '1' : '0'; // Convert to on/off, important for clearcoat, transmission, etc

				} else if ( type === 'object' ) {

					valueKey = '{';

					if ( value.isTexture ) {

						valueKey += value.mapping;

						// WebGPU must honor the sampler data because they are part of the bindings

						if ( renderer.backend.isWebGPUBackend === true ) {

							valueKey += value.magFilter;
							valueKey += value.minFilter;
							valueKey += value.wrapS;
							valueKey += value.wrapT;
							valueKey += value.wrapR;

						}

					}

					valueKey += '}';

				} else {

					valueKey = String( value );

				}

			} else {

				valueKey = String( value );

			}

			cacheKey += /*property + ':' +*/ valueKey + ',';

		}

		cacheKey += this.clippingContextCacheKey + ',';

		if ( object.geometry ) {

			cacheKey += this.getGeometryCacheKey();

		}

		if ( object.skeleton ) {

			cacheKey += object.skeleton.bones.length + ',';

		}

		if ( object.isBatchedMesh ) {

			cacheKey += object._matricesTexture.uuid + ',';

			if ( object._colorsTexture !== null ) {

				cacheKey += object._colorsTexture.uuid + ',';

			}

		}

		if ( object.isInstancedMesh || object.count > 1 || Array.isArray( object.morphTargetInfluences ) ) {

			// TODO: https://github.com/mrdoob/three.js/pull/29066#issuecomment-2269400850

			cacheKey += object.uuid + ',';

		}

		cacheKey += this.context.id + ',';

		cacheKey += object.receiveShadow + ',';

		return hashString( cacheKey );

	}

	/**
	 * Whether the geometry requires an update or not.
	 *
	 * @type {boolean}
	 * @readonly
	 */
	get needsGeometryUpdate() {

		if ( this.geometry.id !== this.object.geometry.id ) return true;

		if ( this.attributes !== null ) {

			const attributesId = this.attributesId;

			for ( const name in attributesId ) {

				const attribute = this.geometry.getAttribute( name );

				if ( attribute === undefined ) return true;

				const id = attribute.isInterleavedBufferAttribute ? attribute.data.uuid : attribute.id;

				if ( attributesId[ name ] !== id ) {

					return true;

				}

			}

		}

		return false;

	}

	/**
	 * Whether the render object requires an update or not.
	 *
	 * Note: There are two distinct places where render objects are checked for an update.
	 *
	 * 1. In `RenderObjects.get()` which is executed when the render object is request. This
	 * method checks the `needsUpdate` flag and recreates the render object if necessary.
	 * 2. In `Renderer._renderObjectDirect()` right after getting the render object via
	 * `RenderObjects.get()`. The render object's NodeMaterialObserver is then used to detect
	 * a need for a refresh due to material, geometry or object related value changes.
	 *
	 * TODO: Investigate if it's possible to merge both steps so there is only a single place
	 * that performs the 'needsUpdate' check.
	 *
	 * @type {boolean}
	 * @readonly
	 */
	get needsUpdate() {

		return /*this.object.static !== true &&*/ ( this.initialNodesCacheKey !== this.getDynamicCacheKey() || this.clippingNeedsUpdate );

	}

	/**
	 * Returns the dynamic cache key which represents a key that is computed per draw command.
	 *
	 * @return {number} The cache key.
	 */
	getDynamicCacheKey() {

		let cacheKey = 0;

		// `Nodes.getCacheKey()` returns an environment cache key which is not relevant when
		// the renderer is inside a shadow pass.

		if ( this.material.isShadowPassMaterial !== true ) {

			cacheKey = this._nodes.getCacheKey( this.scene, this.lightsNode );

		}

		if ( this.camera.isArrayCamera ) {

			cacheKey = hash( cacheKey, this.camera.cameras.length );

		}

		if ( this.object.receiveShadow ) {

			cacheKey = hash( cacheKey, 1 );

		}

		cacheKey = hash( cacheKey, this.renderer.contextNode.id, this.renderer.contextNode.version );

		return cacheKey;

	}

	/**
	 * Returns the render object's cache key.
	 *
	 * @return {number} The cache key.
	 */
	getCacheKey() {

		return this.getMaterialCacheKey() + this.getDynamicCacheKey();

	}

	/**
	 * Requests a background generation for the given structural cache key.
	 *
	 * The render object keeps drawing its active generation (or keeps being
	 * skipped when it has none) until the candidate promotes at a top-level
	 * safe point. The requested-state keys are updated eagerly so unchanged
	 * frames perform no further key computation while the candidate compiles.
	 *
	 * @param {number} cacheKey - The structural cache key to build.
	 * @param {boolean} [dropActive=false] - Whether the active generation has become
	 * invalid (e.g. a structural geometry change) and drawing must be skipped until
	 * the replacement is ready.
	 * @param {boolean} [force=false] - Whether to request a new candidate even when
	 * the cache key is unchanged. Used for pipeline-only state changes that do not
	 * affect the node cache key (e.g. blend mode values).
	 */
	requestGeneration( cacheKey, dropActive = false, force = false ) {

		const renderer = this.renderer;
		const scheduler = renderer._scheduler;

		if ( scheduler === null ) return;

		this.generationVersion ++;

		this.initialCacheKey = cacheKey;
		this.initialNodesCacheKey = this.getDynamicCacheKey();

		const drawState = captureDrawState( this.material );

		const pending = this.pending;

		if ( pending !== null ) {

			const covered = pending.cacheKey === cacheKey && pending.isTerminal() === false &&
				( force === false || drawStateEquals( pending.drawState, drawState ) );

			if ( covered === true ) {

				// the in-flight candidate already covers this state — keep it valid

				pending.version = this.generationVersion;

				return;

			}

			// superseded — release the previous candidate

			if ( pending.task !== null ) {

				pending.task.removeOwner( this );

			} else {

				renderer._objects.releaseGeneration( pending, 'stale' );

			}

			this.pending = null;

		}

		if ( this.active !== null && this.active.cacheKey === cacheKey &&
			( force === false || drawStateEquals( this.active.drawState, drawState ) ) ) {

			// reverted to the active state before the pending build finished

			return;

		}

		if ( dropActive === true && this.active !== null ) {

			// the active pipeline's vertex layout no longer matches the
			// geometry; skip drawing until the replacement is ready

			this.active.status = 'stale';
			this.active = null;
			this.drawState = null;

		}

		if ( scheduler.isFailed( cacheKey ) === true ) return; // known-broken key — keep last

		const generation = new RenderGeneration( cacheKey, this.generationVersion );

		generation.drawState = drawState;
		generation.dynamicCacheKey = this.initialNodesCacheKey;

		// visible objects without an active generation compile first;
		// compileAsync prewarming always joins at normal priority

		const priority = ( renderer._compilationTasks === null && this.active === null ) ? WorkTask.HIGH : WorkTask.NORMAL;

		// join existing work for this key or create it — always use the returned task

		const task = scheduler.add( new RenderGenerationTask( renderer, cacheKey, priority ) );

		task.join( this, generation );

		this.pending = generation;

	}

	/**
	 * Promotes the given candidate generation to the active one. Called only
	 * from the scheduler's promotion queue at a top-level safe point, while
	 * no pass or encoder is active.
	 *
	 * Promotion validates the candidate, swaps the active state atomically,
	 * updates the per-material classification snapshot, invalidates affected
	 * render bundles and defers the release of the previously owned resources
	 * to a low-priority cleanup task.
	 *
	 * @param {RenderGeneration} candidate - The candidate generation.
	 * @return {boolean} Whether the candidate was promoted or not.
	 */
	promote( candidate ) {

		const renderer = this.renderer;

		if ( candidate !== this.pending || candidate.version !== this.generationVersion || candidate.status !== 'promotable' ) {

			// stale, superseded or invalid — release and drop

			renderer._objects.releaseGeneration( candidate, 'stale' );

			if ( this.pending === candidate ) this.pending = null;

			return false;

		}

		const previous = this.active;

		// transfer ownership of the candidate's resources to this render
		// object and capture the previously owned resources for cleanup

		const previousNodeData = renderer._nodes.applyGeneration( this, candidate );
		const previousPipeline = renderer._pipelines.applyGeneration( this, candidate );
		const previousBindings = this._bindings;

		renderer._bindings.applyGeneration( this, candidate );

		this._nodeBuilderState = candidate.nodeBuilderState;
		this._bindings = candidate.bindings;
		this._monitor = null;

		this.attributes = candidate.attributes;
		this.vertexBuffers = candidate.vertexBuffers;
		this.attributesId = candidate.attributesId;

		this.drawState = candidate.drawState;

		// prime the structural change detector from the promoted snapshot so
		// live mutations made during the build are still detected

		renderer.backend.syncRenderUpdateState( this, candidate.drawState );

		// classification follows the promoted truth from the next render list
		// on — captured here, at the safe point, outside the renderer's
		// temporary pass-related side mutations

		renderer._objects.updateClassification( this.material );

		// bundles encoding this object must re-record

		if ( this.bundle !== null ) this.bundle.needsUpdate = true;

		if ( previous !== null ) previous.status = 'stale';

		candidate.status = 'active';
		candidate.task = null;

		this.active = candidate;
		this.pending = null;

		// expensive disposal of the replaced resources is deferred scheduler work

		if ( previousNodeData !== null || previousPipeline !== null || previousBindings !== null ) {

			renderer._scheduler.cleanup( () => {

				if ( previousNodeData !== null ) renderer._nodes.releaseBuilderState( previousNodeData.cacheKey, previousNodeData.state );
				if ( previousPipeline !== null ) renderer._pipelines.releaseGenerationPipeline( previousPipeline );
				if ( previousBindings !== null ) renderer._bindings.destroyForGeneration( previousBindings );

			} );

		}

		return true;

	}

	/**
	 * Frees internal resources.
	 */
	dispose() {

		// release background generations

		if ( this.pending !== null ) {

			const pending = this.pending;

			if ( pending.task !== null ) {

				pending.task.removeOwner( this );

			} else {

				this.renderer._objects.releaseGeneration( pending, 'disposed' );

			}

			this.pending = null;

		}

		if ( this.active !== null ) {

			// active resources are owned by this render object and released
			// through the regular dispose path below

			this.active.status = 'disposed';
			this.active = null;

		}

		this.material.removeEventListener( 'dispose', this.onMaterialDispose );
		this.geometry.removeEventListener( 'dispose', this.onGeometryDispose );

		if ( this._sourceMaterial !== null ) {

			this._sourceMaterial.removeEventListener( 'dispose', this.onMaterialDispose );

		}

		this.onDispose();

	}

}

export default RenderObject;
