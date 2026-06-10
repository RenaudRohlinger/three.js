import WorkTask from './WorkTask.js';
import { error } from '../../utils.js';
import { StackTrace } from '../../nodes/Nodes.js';

/**
 * Coordinates the background compilation of one structural cache key:
 *
 * ```text
 * requested → compile (worker or cooperative) → bindings → pipeline (async) → promotable
 * ```
 *
 * One task exists per structural cache key; render objects sharing the key
 * join the task as owners, each with its own candidate {@link RenderGeneration}.
 * The node build is shared between owners (render objects with identical
 * cache keys share the same node builder state); bindings and pipelines are
 * created per owner since objects can require distinct pipelines for the
 * same key (e.g. mirrored transforms flip the front face).
 *
 * Asynchronous completions only ever call `scheduler.resume( task )`; all
 * result processing happens inside `run( deadline )` under budget. Every
 * phase transition re-validates `generation.version` against the owning
 * render object — stale candidates stop early and release their resources.
 *
 * @private
 * @augments WorkTask
 */
class RenderGenerationTask extends WorkTask {

	/**
	 * Constructs a new render generation task.
	 *
	 * @param {Renderer} renderer - The renderer.
	 * @param {number} cacheKey - The structural cache key this task builds.
	 * @param {number} [priority=WorkTask.NORMAL] - The task priority.
	 */
	constructor( renderer, cacheKey, priority = WorkTask.NORMAL ) {

		super( 'generation:' + cacheKey, priority );

		/**
		 * The renderer.
		 *
		 * @type {Renderer}
		 */
		this.renderer = renderer;

		/**
		 * The structural cache key this task builds.
		 *
		 * @type {number}
		 */
		this.cacheKey = cacheKey;

		this.failureKey = cacheKey;

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
		 * The in-flight cooperative node builder, owned by the compiler.
		 *
		 * @type {?NodeBuilder}
		 */
		this._builder = null;

		/**
		 * The compiler advancing this task's build.
		 *
		 * @private
		 * @type {?NodeCompiler}
		 */
		this._compiler = null;

		/**
		 * The lights node of the build, captured at request time.
		 *
		 * @private
		 * @type {?LightsNode}
		 */
		this._lightsNode = null;

		/**
		 * The lights of the build, captured at request time. The renderer
		 * restores the scene's lights node to its pre-render state after
		 * every render call, so background build slices must re-apply the
		 * lights that were current when the generation was requested.
		 *
		 * @private
		 * @type {?Array<Light>}
		 */
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

		this.addOwner( renderObject );
		this.generations.set( renderObject, generation );

		generation.task = this;

		// capture the request-time lights for the shared build — requests are
		// made during traversal, when the render list has set the lights

		if ( this._lightsNode === null && renderObject.lightsNode !== null && renderObject.lightsNode !== undefined ) {

			this._lightsNode = renderObject.lightsNode;
			this._lights = renderObject.lightsNode.getLights().slice();

		}

		// joined owners adopt an already finished shared build

		if ( this.nodeBuilderState !== null && generation.nodeBuilderState === null ) {

			generation.nodeBuilderState = this.nodeBuilderState;
			generation.status = 'building';

			this.nodeBuilderState.usedTimes ++;

		}

		// requeue the task so the joined owner is processed even when the
		// task is currently awaiting another owner's pipeline

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

		super.removeOwner( renderObject );

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

		// phase: compile — shared per cache key

		if ( this.nodeBuilderState === null ) {

			const result = this._compile( deadline );

			if ( result !== null ) return result;

		}

		// phase: finalize — bindings and pipeline per owner

		return this._finalize( deadline );

	}

	/**
	 * Advances the shared node build: cache lookup, compiler selection and
	 * cooperative stepping under the compiler's gate.
	 *
	 * @private
	 * @param {number} deadline - Absolute `performance.now()` deadline.
	 * @return {?number} A task result when the run should stop, or `null` to continue.
	 */
	_compile( deadline ) {

		const nodes = this.renderer._nodes;
		const scheduler = this.scheduler;

		let state = nodes.getCachedBuilderState( this.cacheKey );

		if ( state === null ) {

			if ( this._compiler === null ) {

				this._compiler = nodes.getCompiler( this._primaryOwner() );

			}

			const compiler = this._compiler;

			if ( compiler.gate !== null && scheduler.tryAcquireGate( compiler.gate, this ) === false ) {

				return WorkTask.BLOCKED;

			}

			// build slices run outside the render call, after the renderer has
			// restored the scene's lights node to its pre-render state — apply
			// the request-time lights for the duration of the slice

			const lightsNode = this._lightsNode;
			const previousLights = lightsNode !== null ? lightsNode.getLights() : null;

			if ( lightsNode !== null ) lightsNode.setLights( this._lights );

			let builder = null;

			try {

				builder = compiler.run( this, this._primaryOwner(), deadline );

			} catch ( e ) {

				compiler.cancel( this );

				return this._fail( e );

			} finally {

				if ( lightsNode !== null ) lightsNode.setLights( previousLights );

			}

			if ( builder === null ) return WorkTask.YIELD;

			state = nodes.adoptBuilderForGeneration( this.cacheKey, builder );

			// the build is done — release the gate before the pipeline phase
			// so other builds can advance while pipelines compile

			if ( compiler.gate !== null ) scheduler.release( compiler.gate );

		}

		this.nodeBuilderState = state;

		for ( const generation of this.generations.values() ) {

			if ( generation.nodeBuilderState === null ) {

				generation.nodeBuilderState = state;
				state.usedTimes ++;

			}

			generation.status = 'building';

		}

		return null;

	}

	/**
	 * Advances bindings and pipeline creation for each owner. Owners progress
	 * independently; each owner's generation is queued for promotion as soon
	 * as its pipeline is ready.
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

			let stage = generation._finalize || 'bindings';

			if ( stage === 'bindings' ) {

				const attributeData = renderObject.computeAttributes( generation.nodeBuilderState );

				generation.attributes = attributeData.attributes;
				generation.vertexBuffers = attributeData.vertexBuffers;
				generation.attributesId = attributeData.attributesId;

				generation.bindings = generation.nodeBuilderState.createBindings();

				try {

					renderer._bindings.createForGeneration( generation.bindings );

				} catch ( e ) {

					return this._fail( e );

				}

				generation._finalize = stage = 'pipeline';

				if ( performance.now() >= deadline ) return WorkTask.YIELD;

			}

			if ( stage === 'pipeline' ) {

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

				generation._finalize = stage = 'wait';

				if ( result.promise !== null ) {

					result.promise.then( () => {

						if ( this.isTerminal() === false ) scheduler.resume( this );

					} );

					waiting ++;

					continue;

				}

			}

			if ( stage === 'wait' ) {

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
				generation._finalize = 'done';
				generation.task = null;

				scheduler.queuePromotion( renderObject, generation );

				this.generations.delete( renderObject );
				this.owners.delete( renderObject );

			}

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
				this.owners.delete( renderObject );

				this.renderer._objects.releaseGeneration( generation, 'stale' );

				if ( renderObject.pending === generation ) renderObject.pending = null;

			}

		}

	}

	/**
	 * Fails the task: logs once with diagnostics, releases all candidate
	 * generations and settles `'failed'`. The failure is remembered in the
	 * scheduler's bounded failure cache, so the key is not recompiled every
	 * frame; the owning render objects keep drawing their active generations.
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
