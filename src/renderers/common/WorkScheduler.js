import WorkTask from './WorkTask.js';
import { error } from '../../utils.js';

/**
 * The maximum number of structural cache keys remembered as failed.
 * Bounds the failure cache so procedural key generators cannot grow
 * it without bound.
 *
 * @private
 * @type {number}
 */
const FAILED_KEYS_LIMIT = 256;

let _cleanupId = 0;

/**
 * A low-priority task running a one-shot cleanup function, used to defer
 * expensive disposal of replaced generation resources out of the promotion
 * loop.
 *
 * @private
 * @augments WorkTask
 */
class CleanupTask extends WorkTask {

	/**
	 * Constructs a new cleanup task.
	 *
	 * @param {Function} fn - The cleanup function.
	 */
	constructor( fn ) {

		super( 'cleanup:' + ( _cleanupId ++ ), WorkTask.LOW );

		this._fn = fn;

	}

	run() {

		this._fn();
		this.settle( 'ready' );

		return WorkTask.DONE;

	}

}

/**
 * Coordinates all deferred renderer work: node builds, worker requests,
 * pipeline creation, hydration, uploads and safe-point promotion.
 *
 * The scheduler owns three priority queues, an in-flight set, named gates
 * with waiter lists, a promotion queue and one main-thread time budget.
 * It is deliberately small; work-specific complexity lives in tasks.
 *
 * @private
 */
class WorkScheduler {

	/**
	 * Constructs a new work scheduler.
	 *
	 * @param {?Renderer} [renderer=null] - The renderer this scheduler belongs to.
	 */
	constructor( renderer = null ) {

		/**
		 * The renderer this scheduler belongs to.
		 *
		 * @type {?Renderer}
		 */
		this.renderer = renderer;

		/**
		 * Active tasks by key, used for deduplication.
		 *
		 * @type {Map<(string|number),WorkTask>}
		 */
		this.tasks = new Map();

		/**
		 * The priority queues. Index corresponds to `WorkTask.HIGH`,
		 * `WorkTask.NORMAL` and `WorkTask.LOW`.
		 *
		 * @type {Array<Array<WorkTask>>}
		 */
		this.queues = [[], [], []];

		/**
		 * Tasks in `WAIT`, awaiting an asynchronous completion that
		 * calls `resume()`.
		 *
		 * @type {Set<WorkTask>}
		 */
		this.inFlight = new Set();

		/**
		 * Named gates. Each gate has an optional holder and a waiter list.
		 *
		 * @type {Map<string,{held:?WorkTask,waiters:Array<WorkTask>}>}
		 */
		this.gates = new Map();

		/**
		 * Queued promotions, applied at the renderer's top-level safe point.
		 *
		 * @type {Array<{target:Object,candidate:Object}>}
		 */
		this.promotions = [];

		/**
		 * Failed structural cache keys (bounded LRU). A request whose key is
		 * remembered as failed settles `'failed'` immediately without new work.
		 *
		 * @type {Map<(string|number),boolean>}
		 */
		this.failedKeys = new Map();

		/**
		 * The main-thread time budget per service slice in milliseconds.
		 *
		 * @type {number}
		 */
		this.timeBudget = 2;

		/**
		 * The maximum number of in-flight worker and upload requests.
		 * GPU pipeline creation is exempt, see `maxPipelinesInFlight`.
		 *
		 * @type {number}
		 */
		this.maxInFlight = 4;

		/**
		 * The maximum number of asynchronous GPU pipelines awaiting completion.
		 *
		 * @type {number}
		 */
		this.maxPipelinesInFlight = 32;

		/**
		 * Lifetime statistics, mirrored into `renderer.info.asyncCompilation`.
		 *
		 * @type {Object}
		 */
		this.stats = {
			promotions: 0,
			failed: 0,
			fallbacks: 0,
			workerTime: 0,
			mainThreadTime: 0,
			pendingBytes: 0
		};

		/**
		 * The number of in-flight worker/upload requests holding a capacity slot.
		 *
		 * @private
		 * @type {number}
		 */
		this._workInFlight = 0;

		/**
		 * The number of asynchronous GPU pipelines awaiting completion.
		 *
		 * @private
		 * @type {number}
		 */
		this._pipelinesInFlight = 0;

		/**
		 * The number of tasks parked on gates.
		 *
		 * @private
		 * @type {number}
		 */
		this._blockedCount = 0;

		/**
		 * Whether a service callback has been scheduled.
		 *
		 * @private
		 * @type {boolean}
		 */
		this._updateScheduled = false;

		/**
		 * Whether `onBackgroundWorkReady` should be invoked from the next
		 * service callback.
		 *
		 * @private
		 * @type {boolean}
		 */
		this._notifyRequested = false;

		/**
		 * Handle of the scheduled idle callback, if any.
		 *
		 * @private
		 * @type {?number}
		 */
		this._idleHandle = null;

		/**
		 * Handle of the scheduled timeout, if any.
		 *
		 * @private
		 * @type {?number}
		 */
		this._timeoutHandle = null;

		/**
		 * The info target object, see `attachInfo()`.
		 *
		 * @private
		 * @type {?Object}
		 */
		this._info = null;

		/**
		 * Bound service callback.
		 *
		 * @private
		 * @type {Function}
		 */
		this._onServiceCallback = this._service.bind( this );

	}

	/**
	 * Adds or joins work. Returns the canonical task for the key — callers
	 * must use the return value, not the argument.
	 *
	 * @param {WorkTask} task - The task to add.
	 * @return {WorkTask} The deduplicated task.
	 */
	add( task ) {

		const existing = this.tasks.get( task.key );

		if ( existing !== undefined && existing.isTerminal() === false ) return existing;

		task.scheduler = this;

		this.tasks.set( task.key, task );
		this._enqueue( task );
		this.requestUpdate();
		this._syncInfo();

		return task;

	}

	/**
	 * Returns the active task for the given key, if any.
	 *
	 * @param {string|number} key - The task key.
	 * @return {?WorkTask} The task, or `null`.
	 */
	get( key ) {

		const task = this.tasks.get( key );

		return ( task !== undefined && task.isTerminal() === false ) ? task : null;

	}

	/**
	 * Runs one budgeted slice. Each runnable task runs at most once per
	 * slice, so no task can starve the others within a slice.
	 */
	update() {

		const start = performance.now();
		const deadline = start + this.timeBudget;

		let remaining = this._runnableCount();

		while ( remaining -- > 0 && performance.now() < deadline ) {

			const task = this._next();

			if ( task === null ) break;

			let result;

			try {

				result = task.isTerminal() === true ? WorkTask.DONE : task.run( deadline );

			} catch ( e ) {

				task.settle( 'failed', e );
				result = WorkTask.DONE;

			}

			if ( result === WorkTask.YIELD ) {

				this._enqueue( task );

			} else if ( result === WorkTask.WAIT ) {

				task.status = 'waiting';
				this.inFlight.add( task );

			} else if ( result === WorkTask.BLOCKED ) {

				this._park( task );

			} else {

				this._finish( task );

			}

		}

		this.stats.mainThreadTime += performance.now() - start;

		if ( this._runnableCount() > 0 ) this.requestUpdate();

		this._syncInfo();

	}

	/**
	 * Called from promise/worker callbacks when an asynchronous completion
	 * arrives. Cheap by contract: requeue only — expensive result processing
	 * happens inside `run()` under budget.
	 *
	 * @param {WorkTask} task - The task to resume.
	 */
	resume( task ) {

		this.inFlight.delete( task );
		this.releaseInFlightSlot( task );

		if ( task.isTerminal() === true ) {

			// the task settled while in flight (cancellation, disposal, device
			// loss) — reap it so held gates and slots are released

			this._finish( task );

		} else {

			this._enqueue( task );

		}

		this.requestUpdate();
		this._syncInfo();

	}

	/**
	 * Requeues a non-terminal task so newly joined work is processed. Unlike
	 * `resume()`, this does not release in-flight slots — the task may still
	 * have an asynchronous request outstanding. Parked tasks are left to
	 * their gate.
	 *
	 * @param {WorkTask} task - The task to poke.
	 */
	poke( task ) {

		if ( task.isTerminal() === true || task.status === 'blocked' ) return;

		this._enqueue( task );
		this.requestUpdate();

	}

	/**
	 * Escalates the priority of an existing task, e.g. when a prioritized
	 * render object joins work that was queued at a lower priority. Tasks
	 * are never demoted — the priority of a shared task is the highest of
	 * its owners.
	 *
	 * @param {WorkTask} task - The task to escalate.
	 * @param {number} priority - The new priority.
	 */
	reprioritize( task, priority ) {

		if ( task.isTerminal() === true || priority >= task.priority ) return;

		if ( task.queued === true ) {

			const queue = this.queues[ task.priority ];
			const index = queue.indexOf( task );

			if ( index !== - 1 ) queue.splice( index, 1 );

			task.priority = priority;
			task.queued = false;

			this._enqueue( task );

		} else {

			task.priority = priority;

		}

	}

	/**
	 * Attempts to acquire a named gate for the given task. If the gate is
	 * already held by another task, the task's `gate` property is set so a
	 * subsequent `BLOCKED` result parks it on the gate.
	 *
	 * @param {string} name - The gate name.
	 * @param {WorkTask} task - The acquiring task.
	 * @return {boolean} Whether the gate was acquired or not.
	 */
	tryAcquireGate( name, task ) {

		let gate = this.gates.get( name );

		if ( gate === undefined ) {

			gate = { held: null, waiters: [] };
			this.gates.set( name, gate );

		}

		if ( gate.held === null || gate.held === task ) {

			gate.held = task;
			task.heldGates.add( name );

			return true;

		}

		task.gate = name;

		return false;

	}

	/**
	 * Releases a named gate and wakes its highest-priority non-terminal
	 * parked task (FIFO within the same priority). Terminal waiters are
	 * reaped.
	 *
	 * @param {string} name - The gate name.
	 */
	release( name ) {

		const gate = this.gates.get( name );

		if ( gate === undefined ) return;

		if ( gate.held !== null ) {

			gate.held.heldGates.delete( name );
			gate.held = null;

		}

		const waiters = gate.waiters;

		let best = - 1;

		for ( let i = 0; i < waiters.length; i ++ ) {

			const waiter = waiters[ i ];

			if ( waiter.isTerminal() === true ) {

				// settled while parked — reap

				waiters.splice( i, 1 );
				this._blockedCount --;
				this._finish( waiter );

				i --;

			} else if ( best === - 1 || waiter.priority < waiters[ best ].priority ) {

				best = i;

			}

		}

		if ( best !== - 1 ) {

			const waiter = waiters.splice( best, 1 )[ 0 ];

			this._blockedCount --;

			waiter.gate = null;
			waiter.status = 'queued';

			this._enqueue( waiter );
			this.requestUpdate();

		}

	}

	/**
	 * Attempts to acquire an in-flight capacity slot (worker and upload
	 * requests). If capacity is exhausted, the task's `gate` property is set
	 * so a subsequent `BLOCKED` result parks it on the capacity gate.
	 *
	 * @param {WorkTask} task - The acquiring task.
	 * @return {boolean} Whether a slot was acquired or not.
	 */
	requestInFlightSlot( task ) {

		if ( task._holdsWorkSlot === true ) return true;

		if ( this._workInFlight >= this.maxInFlight ) {

			task.gate = 'capacity';

			return false;

		}

		this._workInFlight ++;
		task._holdsWorkSlot = true;

		return true;

	}

	/**
	 * Releases the in-flight capacity slot held by the given task, if any,
	 * and wakes a capacity waiter.
	 *
	 * @param {WorkTask} task - The task.
	 */
	releaseInFlightSlot( task ) {

		if ( task._holdsWorkSlot !== true ) return;

		task._holdsWorkSlot = false;
		this._workInFlight --;

		this.release( 'capacity' );

	}

	/**
	 * Attempts to acquire an asynchronous pipeline slot. Pipeline creation
	 * runs on browser-internal threads and therefore has its own, more
	 * generous cap (see `maxPipelinesInFlight`) and does not consume
	 * worker/upload capacity.
	 *
	 * @param {?WorkTask} [task=null] - The acquiring task, for gate parking.
	 * @return {boolean} Whether a slot was acquired or not.
	 */
	acquirePipelineSlot( task = null ) {

		if ( this._pipelinesInFlight >= this.maxPipelinesInFlight ) {

			if ( task !== null ) task.gate = 'pipelines';

			return false;

		}

		this._pipelinesInFlight ++;

		return true;

	}

	/**
	 * Releases an asynchronous pipeline slot and wakes a pipeline waiter.
	 */
	releasePipelineSlot() {

		this._pipelinesInFlight --;

		this.release( 'pipelines' );

	}

	/**
	 * Enqueues a one-shot cleanup function as low-priority work.
	 *
	 * @param {Function} fn - The cleanup function.
	 * @return {WorkTask} The cleanup task.
	 */
	cleanup( fn ) {

		return this.add( new CleanupTask( fn ) );

	}

	/**
	 * Queues a generation promotion. Promotions are applied at the renderer's
	 * top-level safe point, see `applyPromotions()`.
	 *
	 * @param {Object} target - The promotion target (a render object).
	 * @param {Object} candidate - The candidate generation.
	 */
	queuePromotion( target, candidate ) {

		this.promotions.push( { target, candidate } );
		this._requestNotify();

	}

	/**
	 * Applies queued promotions. Called only from the renderer at the
	 * top-level safe point. Promotion is validate + swap + enqueue cleanup;
	 * expensive disposal becomes new scheduler work.
	 */
	applyPromotions() {

		const promotions = this.promotions;

		if ( promotions.length === 0 ) return;

		for ( let i = 0; i < promotions.length; i ++ ) {

			const { target, candidate } = promotions[ i ];

			try {

				if ( target.promote( candidate ) === true ) this.stats.promotions ++;

			} catch ( e ) {

				error( 'WorkScheduler: Promotion failed.', e );

			}

		}

		promotions.length = 0;

		this._syncInfo();

	}

	/**
	 * Remembers the given key as failed in a bounded LRU so a broken shader
	 * is not recompiled every frame.
	 *
	 * @param {string|number} key - The structural cache key.
	 */
	rememberFailure( key ) {

		const failedKeys = this.failedKeys;

		if ( failedKeys.has( key ) === true ) failedKeys.delete( key );

		failedKeys.set( key, true );

		while ( failedKeys.size > FAILED_KEYS_LIMIT ) {

			failedKeys.delete( failedKeys.keys().next().value );

		}

	}

	/**
	 * Returns `true` if the given key is remembered as failed.
	 *
	 * @param {string|number} key - The structural cache key.
	 * @return {boolean} Whether the key is remembered as failed or not.
	 */
	isFailed( key ) {

		return this.failedKeys.has( key );

	}

	/**
	 * Schedules a coalesced service callback. Uses `requestIdleCallback`
	 * (with a timeout backstop) when the document is visible and falls back
	 * to `setTimeout` otherwise, so background compilation continues in
	 * hidden tabs.
	 */
	requestUpdate() {

		if ( this._updateScheduled === true ) return;

		this._updateScheduled = true;

		const hidden = ( typeof document !== 'undefined' ) && document.visibilityState === 'hidden';

		if ( hidden === false && typeof requestIdleCallback !== 'undefined' ) {

			this._idleHandle = requestIdleCallback( this._onServiceCallback, { timeout: 100 } );

			// backstop for agendas where idle callbacks stall (e.g. the tab
			// becomes hidden after scheduling)

			this._timeoutHandle = setTimeout( this._onServiceCallback, 150 );

		} else {

			this._timeoutHandle = setTimeout( this._onServiceCallback, 0 );

		}

	}

	/**
	 * Settles all tasks, clears all queues, gates and promotions. Used on
	 * device loss and disposal. Settled waiters are notified.
	 *
	 * @param {string} [status='cancelled'] - The terminal status to settle tasks with.
	 */
	settleAll( status = 'cancelled' ) {

		for ( const task of this.tasks.values() ) {

			task.settle( status );

		}

		this.tasks.clear();
		this.inFlight.clear();
		this.gates.clear();

		this.queues[ 0 ].length = 0;
		this.queues[ 1 ].length = 0;
		this.queues[ 2 ].length = 0;

		this.promotions.length = 0;

		this._workInFlight = 0;
		this._pipelinesInFlight = 0;
		this._blockedCount = 0;
		this._notifyRequested = false;

		this._cancelServiceCallback();
		this._syncInfo();

	}

	/**
	 * Frees internal resources.
	 */
	dispose() {

		this.settleAll( 'disposed' );

		this.failedKeys.clear();

	}

	/**
	 * Attaches an info object whose properties are kept in sync with the
	 * scheduler state, see `Renderer.info.asyncCompilation`.
	 *
	 * @param {Object} info - The info target object.
	 */
	attachInfo( info ) {

		this._info = info;

		this._syncInfo();

	}

	/**
	 * The service callback body: runs one budgeted slice and fires the
	 * deferred `onBackgroundWorkReady` notification.
	 *
	 * @private
	 */
	_service() {

		if ( this._updateScheduled === false ) return; // already serviced by the other callback

		this._updateScheduled = false;
		this._cancelServiceCallback();

		this.update();

		if ( this._notifyRequested === true ) {

			this._notifyRequested = false;

			const renderer = this.renderer;

			if ( renderer !== null && typeof renderer.onBackgroundWorkReady === 'function' ) {

				renderer.onBackgroundWorkReady();

			}

		}

	}

	/**
	 * Cancels any scheduled service callbacks.
	 *
	 * @private
	 */
	_cancelServiceCallback() {

		if ( this._idleHandle !== null ) {

			if ( typeof cancelIdleCallback !== 'undefined' ) cancelIdleCallback( this._idleHandle );

			this._idleHandle = null;

		}

		if ( this._timeoutHandle !== null ) {

			clearTimeout( this._timeoutHandle );

			this._timeoutHandle = null;

		}

		this._updateScheduled = false;

	}

	/**
	 * Requests the deferred `onBackgroundWorkReady` notification. The
	 * notification fires from the scheduler's own service callback — never
	 * synchronously from a promise resolution.
	 *
	 * @private
	 */
	_requestNotify() {

		this._notifyRequested = true;

		this.requestUpdate();

	}

	/**
	 * Enqueues the task into its priority queue. Idempotent: a task already
	 * queued or terminal is not queued twice.
	 *
	 * @private
	 * @param {WorkTask} task - The task to enqueue.
	 */
	_enqueue( task ) {

		if ( task.queued === true || task.isTerminal() === true ) return;

		task.queued = true;
		task.status = 'queued';

		this.queues[ task.priority ].push( task );

	}

	/**
	 * Removes and returns the next runnable task, highest priority first.
	 *
	 * @private
	 * @return {?WorkTask} The next task, or `null`.
	 */
	_next() {

		for ( let i = 0; i < this.queues.length; i ++ ) {

			const queue = this.queues[ i ];

			if ( queue.length > 0 ) {

				const task = queue.shift();
				task.queued = false;
				task.status = 'running';

				return task;

			}

		}

		return null;

	}

	/**
	 * Returns the number of runnable (queued) tasks.
	 *
	 * @private
	 * @return {number} The number of runnable tasks.
	 */
	_runnableCount() {

		return this.queues[ 0 ].length + this.queues[ 1 ].length + this.queues[ 2 ].length;

	}

	/**
	 * Parks the task on its named gate. A parked task consumes zero
	 * service-callback work until the gate is released.
	 *
	 * @private
	 * @param {WorkTask} task - The task to park.
	 */
	_park( task ) {

		const name = task.gate;

		if ( name === null ) {

			// defensive: BLOCKED without a gate cannot be woken — treat as YIELD

			this._enqueue( task );

			return;

		}

		let gate = this.gates.get( name );

		if ( gate === undefined ) {

			gate = { held: null, waiters: [] };
			this.gates.set( name, gate );

		}

		task.status = 'blocked';
		gate.waiters.push( task );

		this._blockedCount ++;

	}

	/**
	 * Finishes a task: releases held gates and slots, removes it from the
	 * registry and records failures.
	 *
	 * @private
	 * @param {WorkTask} task - The task to finish.
	 */
	_finish( task ) {

		if ( task._finished === true ) return;

		task._finished = true;
		task.queued = false;

		if ( task.isTerminal() === false ) task.settle( 'ready' );

		for ( const name of task.heldGates ) {

			this.release( name );

		}

		this.releaseInFlightSlot( task );
		this.inFlight.delete( task );

		if ( this.tasks.get( task.key ) === task ) this.tasks.delete( task.key );

		if ( task.status === 'failed' ) {

			this.stats.failed ++;
			this.rememberFailure( task.failureKey );

		}

	}

	/**
	 * Mirrors scheduler state into the attached info object.
	 *
	 * @private
	 */
	_syncInfo() {

		const info = this._info;

		if ( info === null ) return;

		const stats = this.stats;

		info.queued = this._runnableCount();
		info.blocked = this._blockedCount;
		info.inFlight = this.inFlight.size;
		info.pipelines = this._pipelinesInFlight;
		info.promotions = stats.promotions;
		info.failed = stats.failed;
		info.fallbacks = stats.fallbacks;
		info.workerTime = stats.workerTime;
		info.mainThreadTime = stats.mainThreadTime;
		info.pendingBytes = stats.pendingBytes;

	}

}

export default WorkScheduler;
