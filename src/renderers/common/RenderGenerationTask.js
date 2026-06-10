import WorkTask from './WorkTask.js';
import { error } from '../../utils.js';
import { StackTrace } from '../../nodes/Nodes.js';

/**
 * Coordinates the background compilation of one structural cache key:
 *
 * ```text
 * requested → build (cooperative) → bindings → pipeline (async) → promotable
 * ```
 *
 * One task exists per structural cache key; render objects sharing the key
 * join the task, each with its own candidate {@link RenderGeneration}. The
 * node build is shared between owners; bindings and pipelines are created
 * per owner since objects can require distinct pipelines for the same key
 * (e.g. mirrored transforms flip the front face).
 *
 * Asynchronous completions only ever call `scheduler.resume( task )`. Every
 * phase re-validates the generation version — stale candidates stop early
 * and release their resources.
 *
 * @private
 * @augments WorkTask
 */
class RenderGenerationTask extends WorkTask {

	/**
	 * Constructs a new render generation task.
	 *
	 * @param {Renderer} renderer - The renderer.
	 * @param {number} cacheKey - The structural cache key to build.
	 * @param {number} [priority=WorkTask.NORMAL] - The task priority.
	 */
	constructor( renderer, cacheKey, priority = WorkTask.NORMAL ) {

		super( cacheKey, priority );

		/**
		 * The renderer.
		 *
		 * @type {Renderer}
		 */
		this.renderer = renderer;

		/**
		 * The candidate generations per owning render object.
		 *
		 * @type {Map<RenderObject,RenderGeneration>}
		 */
		this.generations = new Map();

		/**
		 * The shared node builder state, once compiled or found in the cache.
		 *
		 * @type {?NodeBuilderState}
		 */
		this.nodeBuilderState = null;

		/**
		 * The in-flight cooperative node builder.
		 *
		 * @private
		 * @type {?NodeBuilder}
		 */
		this._builder = null;

		/**
		 * The lights of the build, captured at request time. The renderer
		 * restores the scene's lights node to its pre-render state after every
		 * render call, so build slices must re-apply the lights that were
		 * current when the generation was requested.
		 *
		 * @private
		 * @type {?LightsNode}
		 */
		this._lightsNode = null;
		this._lights = null;

	}

	/**
	 * Joins a render object's candidate generation to this task.
	 *
	 * @param {RenderObject} renderObject - The owning render object.
	 * @param {RenderGeneration} generation - The candidate generation.
	 */
	join( renderObject, generation ) {

		const previous = this.generations.get( renderObject );

		if ( previous !== undefined && previous !== generation ) {

			this.renderer._objects.releaseGeneration( previous, 'stale' );

		}

		this.generations.set( renderObject, generation );

		generation.task = this;

		// joined owners adopt an already finished shared build

		if ( this.nodeBuilderState !== null && generation.nodeBuilderState === null ) {

			generation.nodeBuilderState = this.nodeBuilderState;
			this.nodeBuilderState.usedTimes ++;

		}

		// capture the request-time lights for the shared build — requests are
		// made during traversal, when the render list has set the lights

		if ( this._lightsNode === null && renderObject.lightsNode !== null && renderObject.lightsNode !== undefined ) {

			this._lightsNode = renderObject.lightsNode;
			this._lights = renderObject.lightsNode.getLights().slice();

		}

		// requeue so a joined owner is processed even when the task is
		// currently awaiting another owner's pipeline

		if ( this.scheduler !== null ) this.scheduler.poke( this );

	}

	/**
	 * Removes an owner and releases its candidate generation. Cancels the
	 * task when the last owner is removed.
	 *
	 * @param {RenderObject} renderObject - The owner to remove.
	 */
	removeOwner( renderObject ) {

		const generation = this.generations.get( renderObject );

		if ( generation !== undefined ) {

			this.generations.delete( renderObject );
			this.renderer._objects.releaseGeneration( generation, 'disposed' );

			if ( renderObject.pending === generation ) renderObject.pending = null;

		}

		if ( this.generations.size === 0 ) this.cancel();

	}

	/**
	 * Advances the task.
	 *
	 * @param {number} deadline - Absolute `performance.now()` deadline.
	 * @return {number} The task result.
	 */
	run( deadline ) {

		this._pruneStale();

		if ( this.generations.size === 0 ) {

			this.settle( 'stale' );

			return WorkTask.DONE;

		}

		if ( this.nodeBuilderState === null ) {

			const result = this._build( deadline );

			if ( result !== null ) return result;

		}

		return this._finalize( deadline );

	}

	/**
	 * Advances the shared node build: cache lookup, then cooperative
	 * stepping under the `'builder'` gate — the node system has shared
	 * caches and mutable builder state, so only one build advances at a time.
	 *
	 * @private
	 * @param {number} deadline - Absolute `performance.now()` deadline.
	 * @return {?number} A task result when the run should stop, or `null` to continue.
	 */
	_build( deadline ) {

		const nodes = this.renderer._nodes;
		const scheduler = this.scheduler;

		let state = this.nodeBuilderState = nodes.nodeBuilderCache.get( this.key ) || null;

		if ( state === null ) {

			if ( scheduler.tryAcquireGate( 'builder', this ) === false ) return WorkTask.BLOCKED;

			// build slices run outside the render call, after the renderer has
			// restored the scene's lights node — apply the request-time lights
			// for the duration of the slice

			const lightsNode = this._lightsNode;
			const previousLights = lightsNode !== null ? lightsNode.getLights() : null;

			if ( lightsNode !== null ) lightsNode.setLights( this._lights );

			let complete = false;

			try {

				const renderObject = this._primaryOwner();

				if ( this._builder === null ) this._builder = nodes._createNodeBuilder( renderObject, renderObject.material );

				complete = this._builder.buildStep( deadline );

			} catch ( e ) {

				this._builder = null;

				return this._fail( e );

			} finally {

				if ( lightsNode !== null ) lightsNode.setLights( previousLights );

			}

			if ( complete === false ) return WorkTask.YIELD;

			state = this.nodeBuilderState = nodes.adoptNodeBuilder( this.key, this._builder );
			this._builder = null;

			// release the gate before the pipeline phase so other builds can
			// advance while pipelines compile

			scheduler.release( 'builder' );

		}

		for ( const generation of this.generations.values() ) {

			if ( generation.nodeBuilderState === null ) {

				generation.nodeBuilderState = state;
				state.usedTimes ++;

			}

		}

		return null;

	}

	/**
	 * Advances bindings and pipeline creation for each owner. Owners progress
	 * independently; each generation is queued for promotion as soon as its
	 * pipeline is ready.
	 *
	 * @private
	 * @param {number} deadline - Absolute `performance.now()` deadline.
	 * @return {number} The task result.
	 */
	_finalize( deadline ) {

		const renderer = this.renderer;
		const scheduler = this.scheduler;

		let waiting = 0;
		let blocked = false;

		for ( const [ renderObject, generation ] of this.generations ) {

			if ( generation.bindings === null ) {

				const attributeData = renderObject.computeAttributes( generation.nodeBuilderState );

				generation.attributes = attributeData.attributes;
				generation.vertexBuffers = attributeData.vertexBuffers;
				generation.attributesId = attributeData.attributesId;

				const bindings = generation.nodeBuilderState.createBindings();

				try {

					renderer._bindings._createBindings( bindings );

				} catch ( e ) {

					return this._fail( e );

				}

				generation.bindings = bindings;

				if ( performance.now() >= deadline ) return WorkTask.YIELD;

			}

			if ( generation.pipeline === null ) {

				let result;

				try {

					result = renderer._pipelines.requestGenerationPipeline( renderObject, generation, this );

				} catch ( e ) {

					return this._fail( e );

				}

				if ( result === null ) {

					// pipeline capacity exhausted — the gate is set on the task

					blocked = true;

					continue;

				}

				if ( result.promise !== null ) {

					result.promise.then( () => {

						if ( this.isTerminal() === false ) scheduler.resume( this );

					} );

					waiting ++;

					continue;

				}

			}

			const pipelines = renderer._pipelines;

			if ( pipelines.isPipelineFailed( generation.pipeline ) === true ) {

				return this._fail( new Error( 'Async render pipeline creation failed.' ) );

			}

			if ( pipelines.isPipelineReady( generation.pipeline ) === false ) {

				waiting ++;

				continue;

			}

			// promotable — hand the candidate over to the render object

			generation.status = 'promotable';
			generation.task = null;

			scheduler.queuePromotion( renderObject, generation );

			this.generations.delete( renderObject );

		}

		if ( this.generations.size === 0 ) {

			this.settle( 'ready' );

			return WorkTask.DONE;

		}

		if ( waiting > 0 ) return WorkTask.WAIT;
		if ( blocked === true ) return WorkTask.BLOCKED;

		return WorkTask.YIELD;

	}

	/**
	 * Releases candidates whose render object has requested a newer
	 * generation or has been disposed since.
	 *
	 * @private
	 */
	_pruneStale() {

		for ( const [ renderObject, generation ] of this.generations ) {

			if ( generation.version !== renderObject.generationVersion || generation.isTerminal() === true ) {

				this.generations.delete( renderObject );
				this.renderer._objects.releaseGeneration( generation, 'stale' );

				if ( renderObject.pending === generation ) renderObject.pending = null;

			}

		}

	}

	/**
	 * Fails the task: logs once with diagnostics, releases all candidate
	 * generations and settles `'failed'`. The key enters the scheduler's
	 * bounded failure cache; the owning render objects keep drawing their
	 * active generations.
	 *
	 * @private
	 * @param {Error} e - The error.
	 * @return {number} `WorkTask.DONE`.
	 */
	_fail( e ) {

		let stackTrace = e.stackTrace;

		if ( ! stackTrace && e.stack ) {

			stackTrace = new StackTrace( e.stack );

		}

		error( 'TSL: ' + e, stackTrace );

		for ( const [ renderObject, generation ] of this.generations ) {

			this.renderer._objects.releaseGeneration( generation, 'failed' );

			if ( renderObject.pending === generation ) renderObject.pending = null;

		}

		this.generations.clear();

		this.settle( 'failed', e );

		return WorkTask.DONE;

	}

	/**
	 * Returns the representative owner used for the shared build.
	 *
	 * @private
	 * @return {RenderObject} The representative render object.
	 */
	_primaryOwner() {

		return this.generations.keys().next().value;

	}

}

export default RenderGenerationTask;
