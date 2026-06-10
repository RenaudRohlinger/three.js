/**
 * Captures every structural material value that is read after render-list
 * construction or during backend encoding into a plain frozen snapshot.
 * The snapshot mirrors the material property names so it can be passed in
 * place of the material to state-derivation helpers.
 *
 * It is captured at request time — during traversal — when pass-dependent
 * state like `material.side` has already been resolved by the renderer
 * (back-side pass, shadow override), so background builds never read these
 * values live. The property set must stay in sync with
 * `WebGPUBackend._syncStructuralState()` and `getRenderCacheKey()`.
 *
 * @private
 * @param {Material} material - The material to capture.
 * @return {Object} The frozen draw state snapshot.
 */
export function captureDrawState( material ) {

	return Object.freeze( {

		isMaterial: true,
		isDrawState: true,

		// label data

		id: material.id,
		name: material.name,
		type: material.type,

		// render list / blending

		transparent: material.transparent,
		blending: material.blending,
		premultipliedAlpha: material.premultipliedAlpha,
		blendSrc: material.blendSrc,
		blendDst: material.blendDst,
		blendEquation: material.blendEquation,
		blendSrcAlpha: material.blendSrcAlpha,
		blendDstAlpha: material.blendDstAlpha,
		blendEquationAlpha: material.blendEquationAlpha,
		blendColor: material.blendColor,
		blendAlpha: material.blendAlpha,

		// output

		colorWrite: material.colorWrite,

		// depth

		depthWrite: material.depthWrite,
		depthTest: material.depthTest,
		depthFunc: material.depthFunc,

		// stencil

		stencilWrite: material.stencilWrite,
		stencilFunc: material.stencilFunc,
		stencilRef: material.stencilRef,
		stencilFail: material.stencilFail,
		stencilZFail: material.stencilZFail,
		stencilZPass: material.stencilZPass,
		stencilFuncMask: material.stencilFuncMask,
		stencilWriteMask: material.stencilWriteMask,

		// rasterization

		side: material.side,
		wireframe: material.wireframe === true,
		alphaToCoverage: material.alphaToCoverage,
		forceSinglePass: material.forceSinglePass,
		polygonOffset: material.polygonOffset,
		polygonOffsetFactor: material.polygonOffsetFactor,
		polygonOffsetUnits: material.polygonOffsetUnits

	} );

}

/**
 * Returns `true` if the two draw snapshots describe the same structural
 * state. Used to deduplicate generation requests when several change paths
 * fire in the same frame.
 *
 * @private
 * @param {Object} a - The first draw snapshot.
 * @param {Object} b - The second draw snapshot.
 * @return {boolean} Whether the snapshots are structurally equal or not.
 */
export function drawStateEquals( a, b ) {

	for ( const key in a ) {

		if ( a[ key ] !== b[ key ] ) return false;

	}

	return true;

}

/**
 * An immutable compiled drawable state — everything required to issue this
 * draw safely, captured at build time. A render object draws only from its
 * promoted (`active`) generation; live material state is never consulted at
 * draw-encoding time for structural values.
 *
 * Lifecycle: `requested` → `promotable` → `active`, or terminal `stale` /
 * `failed` / `disposed`.
 *
 * @private
 */
class RenderGeneration {

	/**
	 * Constructs a new render generation.
	 *
	 * @param {number} cacheKey - The structural cache key this generation is built for.
	 * @param {number} version - The owning render object's `generationVersion` at request time.
	 */
	constructor( cacheKey, version ) {

		/**
		 * The structural cache key this generation is built for.
		 *
		 * @type {number}
		 */
		this.cacheKey = cacheKey;

		/**
		 * The owning render object's `generationVersion` at request time.
		 * Re-validated at every phase transition; stale candidates stop early.
		 *
		 * @type {number}
		 */
		this.version = version;

		/**
		 * The generation status.
		 *
		 * @type {string}
		 */
		this.status = 'requested';

		/**
		 * The node builder state.
		 *
		 * @type {?NodeBuilderState}
		 */
		this.nodeBuilderState = null;

		/**
		 * The ready backend pipeline (never a building one).
		 *
		 * @type {?RenderObjectPipeline}
		 */
		this.pipeline = null;

		/**
		 * The bind groups built for this generation.
		 *
		 * @type {?Array<BindGroup>}
		 */
		this.bindings = null;

		/**
		 * The structural draw snapshot, see `captureDrawState()`.
		 *
		 * @type {?Object}
		 */
		this.drawState = null;

		/**
		 * The owning build task while pending.
		 *
		 * @type {?RenderGenerationTask}
		 */
		this.task = null;

		/**
		 * The attributes computed for this generation's node builder state.
		 *
		 * @type {?Array<BufferAttribute>}
		 */
		this.attributes = null;

		/**
		 * The vertex buffers computed for this generation.
		 *
		 * @type {?Array<BufferAttribute|InterleavedBuffer>}
		 */
		this.vertexBuffers = null;

		/**
		 * The attribute versions computed for this generation.
		 *
		 * @type {?Object<string,number>}
		 */
		this.attributesId = null;

	}

	/**
	 * Returns `true` if the generation has reached a terminal status.
	 *
	 * @return {boolean} Whether the generation is terminal or not.
	 */
	isTerminal() {

		const status = this.status;

		return status === 'stale' || status === 'failed' || status === 'disposed';

	}

}

export default RenderGeneration;
