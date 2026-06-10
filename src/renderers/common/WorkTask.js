/**
 * Base class for background renderer work managed by {@link WorkScheduler}.
 *
 * A task advances by being called with a deadline and reporting one of four
 * results: `YIELD` (made progress, more synchronous work remains), `WAIT`
 * (asynchronous work in flight, `scheduler.resume()` will requeue), `BLOCKED`
 * (cannot progress until a named gate is released) or `DONE` (terminal).
 *
 * Tasks are owned by one or more owners (e.g. render objects). When the last
 * owner is removed, the task cancels itself.
 *
 * @private
 */
class WorkTask {

	/**
	 * Constructs a new work task.
	 *
	 * @param {string|number} key - A key identifying this work. The scheduler deduplicates tasks by key.
	 * @param {number} [priority=WorkTask.NORMAL] - The task priority.
	 */
	constructor( key, priority = WorkTask.NORMAL ) {

		/**
		 * A key identifying this work. The scheduler deduplicates tasks by key.
		 *
		 * @type {string|number}
		 */
		this.key = key;

		/**
		 * The key recorded in the scheduler's failure cache when this task
		 * fails. Defaults to the task key; tasks can set a semantic key
		 * (e.g. the structural cache key) so request sites can consult the
		 * cache directly.
		 *
		 * @type {string|number}
		 */
		this.failureKey = key;

		/**
		 * The task priority. One of `WorkTask.HIGH`, `WorkTask.NORMAL`, `WorkTask.LOW`.
		 *
		 * @type {number}
		 */
		this.priority = priority;

		/**
		 * The task status. Non-terminal statuses are `'queued'`, `'running'`,
		 * `'waiting'` and `'blocked'`. Terminal statuses are `'ready'`, `'failed'`,
		 * `'stale'`, `'cancelled'` and `'disposed'`.
		 *
		 * @type {string}
		 */
		this.status = 'queued';

		/**
		 * When the task reports `BLOCKED`, this property must name the gate the
		 * task is parked on.
		 *
		 * @type {?string}
		 */
		this.gate = null;

		/**
		 * The error that settled this task, if any.
		 *
		 * @type {?Error}
		 */
		this.error = null;

		/**
		 * The owners of this task. When the last owner is removed, the task
		 * cancels itself.
		 *
		 * @type {Set<Object>}
		 */
		this.owners = new Set();

		/**
		 * The scheduler this task belongs to. Assigned by `WorkScheduler.add()`.
		 *
		 * @type {?WorkScheduler}
		 */
		this.scheduler = null;

		/**
		 * The names of the gates this task currently holds. Held gates are
		 * released when the task finishes.
		 *
		 * @type {Set<string>}
		 */
		this.heldGates = new Set();

		/**
		 * Whether the task is currently enqueued in a scheduler queue. Used to
		 * keep `_enqueue()` idempotent.
		 *
		 * @type {boolean}
		 */
		this.queued = false;

		/**
		 * Settlement listeners, see `onSettled()`.
		 *
		 * @private
		 * @type {?Array<Function>}
		 */
		this._settledCallbacks = null;

	}

	/**
	 * Advances the task. Every operation inside `run()` must be incremental or
	 * measured bounded. Wrapping one large synchronous call in a task does not
	 * make it non-blocking.
	 *
	 * @abstract
	 * @param {number} deadline - Absolute `performance.now()` deadline.
	 * @return {number} One of `WorkTask.YIELD`, `WAIT`, `BLOCKED`, `DONE`.
	 */
	run( /* deadline */ ) {

		return WorkTask.DONE;

	}

	/**
	 * Adds an owner to this task.
	 *
	 * @param {Object} owner - The owner.
	 */
	addOwner( owner ) {

		this.owners.add( owner );

	}

	/**
	 * Removes an owner from this task. When the last owner is removed, the
	 * task cancels itself.
	 *
	 * @param {Object} owner - The owner.
	 */
	removeOwner( owner ) {

		this.owners.delete( owner );

		if ( this.owners.size === 0 ) this.cancel();

	}

	/**
	 * Cancels the task. A no-op if the task is already terminal.
	 */
	cancel() {

		this.settle( 'cancelled' );

	}

	/**
	 * Settles the task into a terminal status. Exactly-once: subsequent calls
	 * are ignored.
	 *
	 * @param {string} status - One of `'ready'`, `'failed'`, `'stale'`, `'cancelled'`, `'disposed'`.
	 * @param {?Error} [error=null] - The error that settled the task, if any.
	 */
	settle( status, error = null ) {

		if ( this.isTerminal() === true ) return;

		this.status = status;
		this.error = error;

		if ( this._settledCallbacks !== null ) {

			const callbacks = this._settledCallbacks;
			this._settledCallbacks = null;

			for ( let i = 0; i < callbacks.length; i ++ ) {

				callbacks[ i ]( this );

			}

		}

	}

	/**
	 * Registers a callback which is invoked exactly once when the task settles.
	 * If the task is already terminal, the callback is invoked immediately.
	 *
	 * @param {Function} callback - The callback. Receives the task.
	 */
	onSettled( callback ) {

		if ( this.isTerminal() === true ) {

			callback( this );
			return;

		}

		if ( this._settledCallbacks === null ) this._settledCallbacks = [];

		this._settledCallbacks.push( callback );

	}

	/**
	 * Returns `true` if the task has settled into a terminal status.
	 *
	 * @return {boolean} Whether the task is terminal or not.
	 */
	isTerminal() {

		const status = this.status;

		return status === 'ready' || status === 'failed' || status === 'stale' || status === 'cancelled' || status === 'disposed';

	}

}

/**
 * Task result: made progress, more synchronous work remains.
 *
 * @static
 * @type {number}
 */
WorkTask.YIELD = 0;

/**
 * Task result: asynchronous work in flight, `scheduler.resume()` will requeue.
 *
 * @static
 * @type {number}
 */
WorkTask.WAIT = 1;

/**
 * Task result: cannot progress until a gate is released.
 *
 * @static
 * @type {number}
 */
WorkTask.BLOCKED = 2;

/**
 * Task result: terminal, leaves scheduler ownership.
 *
 * @static
 * @type {number}
 */
WorkTask.DONE = 3;

/**
 * High task priority. Used for visible objects without an active generation
 * and for application-prioritized work (`object.compilePriority > 0`).
 *
 * @static
 * @type {number}
 */
WorkTask.HIGH = 0;

/**
 * Normal task priority.
 *
 * @static
 * @type {number}
 */
WorkTask.NORMAL = 1;

/**
 * Low task priority. Used for deprioritized application work
 * (`object.compilePriority < 0`) and deferred cleanup.
 *
 * @static
 * @type {number}
 */
WorkTask.LOW = 2;

export default WorkTask;
