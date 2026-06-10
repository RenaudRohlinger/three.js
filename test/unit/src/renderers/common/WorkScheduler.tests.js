import WorkScheduler from '../../../../../src/renderers/common/WorkScheduler.js';
import WorkTask from '../../../../../src/renderers/common/WorkTask.js';

/**
 * A controllable task for scheduler tests. The `script` array defines the
 * result of each successive run() call; the last entry repeats.
 */
class TestTask extends WorkTask {

	constructor( key, priority, script = [ WorkTask.DONE ] ) {

		super( key, priority );

		this.script = script;
		this.runs = 0;
		this.log = null;

	}

	run( /* deadline */ ) {

		this.runs ++;

		if ( this.log !== null ) this.log.push( this.key );

		const result = this.script[ Math.min( this.runs - 1, this.script.length - 1 ) ];

		if ( result === WorkTask.DONE ) this.settle( 'ready' );

		return result;

	}

}

function createScheduler() {

	const scheduler = new WorkScheduler();

	// deterministic tests: no background service callbacks
	scheduler.requestUpdate = function () {};

	return scheduler;

}

export default QUnit.module( 'Renderers', () => {

	QUnit.module( 'Common', () => {

		QUnit.module( 'WorkScheduler', () => {

			QUnit.test( 'add() deduplicates by key and returns the canonical task', ( assert ) => {

				const scheduler = createScheduler();

				const a = new TestTask( 'k', WorkTask.NORMAL, [ WorkTask.YIELD ] );
				const b = new TestTask( 'k', WorkTask.NORMAL, [ WorkTask.YIELD ] );

				assert.strictEqual( scheduler.add( a ), a, 'first add returns the task' );
				assert.strictEqual( scheduler.add( b ), a, 'second add returns the canonical task' );

				// a terminal task is replaced by new work

				a.settle( 'cancelled' );

				assert.strictEqual( scheduler.add( b ), b, 'terminal tasks are replaced' );

			} );

			QUnit.test( 'priority order: HIGH before NORMAL before LOW', ( assert ) => {

				const scheduler = createScheduler();
				const log = [];

				const low = new TestTask( 'low', WorkTask.LOW );
				const normal = new TestTask( 'normal', WorkTask.NORMAL );
				const high = new TestTask( 'high', WorkTask.HIGH );

				low.log = normal.log = high.log = log;

				scheduler.add( low );
				scheduler.add( normal );
				scheduler.add( high );

				scheduler.update();

				assert.deepEqual( log, [ 'high', 'normal', 'low' ], 'tasks ran in priority order' );

			} );

			QUnit.test( 'one run per task per slice', ( assert ) => {

				const scheduler = createScheduler();
				scheduler.timeBudget = 1000; // effectively unbounded for this test

				const a = new TestTask( 'a', WorkTask.NORMAL, [ WorkTask.YIELD ] );
				const b = new TestTask( 'b', WorkTask.NORMAL, [ WorkTask.YIELD ] );

				scheduler.add( a );
				scheduler.add( b );

				scheduler.update();

				assert.strictEqual( a.runs, 1, 'task a ran once in the slice' );
				assert.strictEqual( b.runs, 1, 'task b ran once in the slice' );

				scheduler.update();

				assert.strictEqual( a.runs, 2, 'task a ran once in the next slice' );
				assert.strictEqual( b.runs, 2, 'task b ran once in the next slice' );

			} );

			QUnit.test( 'budget enforcement stops the slice', ( assert ) => {

				const scheduler = createScheduler();
				scheduler.timeBudget = 5;

				// deterministic virtual clock — independent of wall time and of
				// other suites mocking the global performance object

				const originalNow = performance.now;

				let fakeTime = 1000;

				performance.now = () => fakeTime;

				try {

					const slow = new TestTask( 'slow', WorkTask.NORMAL, [ WorkTask.YIELD ] );

					slow.run = function () {

						this.runs ++;

						fakeTime += 10; // overruns the 5 ms budget

						return WorkTask.YIELD;

					};

					const starved = new TestTask( 'starved', WorkTask.NORMAL, [ WorkTask.YIELD ] );

					scheduler.add( slow );
					scheduler.add( starved );

					scheduler.update();

					assert.strictEqual( slow.runs, 1, 'first task ran' );
					assert.strictEqual( starved.runs, 0, 'budget exhausted before the second task' );

					scheduler.update();

					assert.strictEqual( starved.runs, 1, 'second task ran in the next slice (FIFO within priority)' );

				} finally {

					performance.now = originalNow;

				}

			} );

			QUnit.test( 'BLOCKED parks on a gate without re-running until release', ( assert ) => {

				const scheduler = createScheduler();

				const holder = new TestTask( 'holder', WorkTask.NORMAL, [ WorkTask.WAIT ] );
				const blocked = new TestTask( 'blocked', WorkTask.NORMAL );

				blocked.run = function () {

					this.runs ++;

					if ( scheduler.tryAcquireGate( 'builder', this ) === false ) return WorkTask.BLOCKED;

					this.settle( 'ready' );

					return WorkTask.DONE;

				};

				scheduler.add( holder );
				scheduler.update(); // holder runs, WAITs

				assert.strictEqual( scheduler.tryAcquireGate( 'builder', holder ), true, 'holder acquired the gate' );

				scheduler.add( blocked );

				scheduler.update();
				assert.strictEqual( blocked.runs, 1, 'blocked task ran once and parked' );

				scheduler.update();
				scheduler.update();
				assert.strictEqual( blocked.runs, 1, 'parked task consumes no further slices' );

				scheduler.release( 'builder' );
				scheduler.update();

				assert.strictEqual( blocked.runs, 2, 'released gate woke the parked task' );
				assert.strictEqual( blocked.status, 'ready', 'woken task completed' );

			} );

			QUnit.test( 'gate wake order is FIFO and skips terminal waiters', ( assert ) => {

				const scheduler = createScheduler();
				const log = [];

				const holder = new TestTask( 'holder', WorkTask.NORMAL, [ WorkTask.WAIT ] );
				scheduler.add( holder );
				scheduler.update();
				scheduler.tryAcquireGate( 'g', holder );

				const makeWaiter = ( key ) => {

					const task = new TestTask( key, WorkTask.NORMAL );

					task.run = function () {

						this.runs ++;

						if ( scheduler.tryAcquireGate( 'g', this ) === false ) return WorkTask.BLOCKED;

						log.push( this.key );
						this.settle( 'ready' );

						return WorkTask.DONE;

					};

					scheduler.add( task );

					return task;

				};

				const w1 = makeWaiter( 'w1' );
				const w2 = makeWaiter( 'w2' );
				const w3 = makeWaiter( 'w3' );

				scheduler.update(); // all three park

				assert.strictEqual( w1.runs + w2.runs + w3.runs, 3, 'all waiters parked' );

				w1.settle( 'cancelled' ); // cancelled while parked

				scheduler.release( 'g' );
				scheduler.update();

				assert.deepEqual( log, [ 'w2' ], 'first non-terminal waiter woke (terminal waiter skipped)' );

				// w2 finished and released the gate via _finish

				scheduler.update();

				assert.deepEqual( log, [ 'w2', 'w3' ], 'next waiter woke after the gate was released again' );

			} );

			QUnit.test( 'WAIT + resume() requeues; resuming a terminal task releases its gates', ( assert ) => {

				const scheduler = createScheduler();

				const task = new TestTask( 'waiting', WorkTask.NORMAL, [ WorkTask.WAIT, WorkTask.DONE ] );

				scheduler.add( task );
				scheduler.update();

				assert.strictEqual( scheduler.inFlight.has( task ), true, 'task is in flight' );

				scheduler.resume( task );
				scheduler.update();

				assert.strictEqual( task.status, 'ready', 'resumed task completed' );

				// terminal-while-in-flight: gates release on resume

				const holder = new TestTask( 'holder', WorkTask.NORMAL, [ WorkTask.WAIT ] );

				holder.run = function () {

					this.runs ++;
					scheduler.tryAcquireGate( 'builder', this );

					return WorkTask.WAIT;

				};

				scheduler.add( holder );
				scheduler.update();

				assert.strictEqual( scheduler.gates.get( 'builder' ).held, holder, 'gate held by in-flight task' );

				holder.settle( 'cancelled' );
				scheduler.resume( holder );

				assert.strictEqual( scheduler.gates.get( 'builder' ).held, null, 'gate released when the cancelled task resumed' );

			} );

			QUnit.test( 'a thrown task fails alone and is remembered in the failure cache', ( assert ) => {

				const scheduler = createScheduler();

				const bad = new TestTask( 12345, WorkTask.NORMAL );

				bad.run = function () {

					throw new Error( 'broken shader' );

				};

				const good = new TestTask( 'good', WorkTask.NORMAL );

				scheduler.add( bad );
				scheduler.add( good );

				scheduler.update();

				assert.strictEqual( bad.status, 'failed', 'throwing task settled failed' );
				assert.strictEqual( bad.error.message, 'broken shader', 'error preserved' );
				assert.strictEqual( good.status, 'ready', 'other task unaffected' );
				assert.strictEqual( scheduler.isFailed( 12345 ), true, 'failure remembered under the task key' );
				assert.strictEqual( scheduler.stats.failed, 1, 'failure counted' );

			} );

			QUnit.test( 'failure cache is bounded', ( assert ) => {

				const scheduler = createScheduler();

				for ( let i = 0; i < 300; i ++ ) {

					scheduler.rememberFailure( i );

				}

				assert.strictEqual( scheduler.failedKeys.size, 256, 'failure cache capped at 256 entries' );
				assert.strictEqual( scheduler.isFailed( 0 ), false, 'oldest entries evicted' );
				assert.strictEqual( scheduler.isFailed( 299 ), true, 'newest entries retained' );

			} );

			QUnit.test( 'settlement is exactly once and onSettled fires immediately on terminal tasks', ( assert ) => {

				const task = new TestTask( 't', WorkTask.NORMAL );

				let calls = 0;

				task.onSettled( () => calls ++ );

				task.settle( 'failed', new Error( 'x' ) );
				task.settle( 'ready' );

				assert.strictEqual( task.status, 'failed', 'second settle ignored' );
				assert.strictEqual( calls, 1, 'settlement callback fired once' );

				task.onSettled( () => calls ++ );

				assert.strictEqual( calls, 2, 'late onSettled fired immediately' );

			} );

			QUnit.test( 'promotions are queued and applied at the safe point', ( assert ) => {

				const scheduler = createScheduler();

				const applied = [];

				const target = {

					promote( candidate ) {

						applied.push( candidate );

						return true;

					}

				};

				scheduler.queuePromotion( target, 'a' );
				scheduler.queuePromotion( target, 'b' );

				assert.strictEqual( applied.length, 0, 'nothing applied before the safe point' );

				scheduler.applyPromotions();

				assert.deepEqual( applied, [ 'a', 'b' ], 'promotions applied in order' );
				assert.strictEqual( scheduler.stats.promotions, 2, 'promotions counted' );
				assert.strictEqual( scheduler.promotions.length, 0, 'queue cleared' );

				// a throwing promote must not break the loop

				const throwing = {

					promote() {

						throw new Error( 'invalid' );

					}

				};

				scheduler.queuePromotion( throwing, 'c' );
				scheduler.queuePromotion( target, 'd' );

				scheduler.applyPromotions();

				assert.deepEqual( applied, [ 'a', 'b', 'd' ], 'later promotions applied after a throwing one' );

			} );

			QUnit.test( 'cleanup() runs deferred work at low priority', ( assert ) => {

				const scheduler = createScheduler();

				let cleaned = 0;

				scheduler.cleanup( () => cleaned ++ );

				scheduler.update();

				assert.strictEqual( cleaned, 1, 'cleanup function ran once' );

				scheduler.update();

				assert.strictEqual( cleaned, 1, 'cleanup did not run again' );

			} );

			QUnit.test( 'settleAll cancels everything and resolves waiters', ( assert ) => {

				const scheduler = createScheduler();

				const queued = new TestTask( 'queued', WorkTask.NORMAL, [ WorkTask.YIELD ] );
				const waiting = new TestTask( 'waiting', WorkTask.NORMAL, [ WorkTask.WAIT ] );

				let settled = 0;

				queued.onSettled( () => settled ++ );
				waiting.onSettled( () => settled ++ );

				scheduler.add( queued );
				scheduler.add( waiting );
				scheduler.update(); // waiting → WAIT, queued → YIELD (requeued)

				scheduler.queuePromotion( {}, {} );

				scheduler.settleAll( 'cancelled' );

				assert.strictEqual( queued.status, 'cancelled', 'queued task cancelled' );
				assert.strictEqual( waiting.status, 'cancelled', 'in-flight task cancelled' );
				assert.strictEqual( settled, 2, 'all waiters notified' );
				assert.strictEqual( scheduler.promotions.length, 0, 'promotions cleared' );
				assert.strictEqual( scheduler.tasks.size, 0, 'task registry cleared' );

			} );

			QUnit.test( 'pipeline slots have their own cap', ( assert ) => {

				const scheduler = createScheduler();
				scheduler.maxPipelinesInFlight = 2;

				assert.strictEqual( scheduler.acquirePipelineSlot(), true, 'slot 1 acquired' );
				assert.strictEqual( scheduler.acquirePipelineSlot(), true, 'slot 2 acquired' );

				const task = new TestTask( 't', WorkTask.NORMAL );

				assert.strictEqual( scheduler.acquirePipelineSlot( task ), false, 'cap reached' );
				assert.strictEqual( task.gate, 'pipelines', 'task parked on the pipelines gate' );

				scheduler.releasePipelineSlot();

				assert.strictEqual( scheduler.acquirePipelineSlot(), true, 'slot freed' );

			} );

			QUnit.test( 'reprioritize() escalates queued tasks and never demotes', ( assert ) => {

				const scheduler = createScheduler();
				const log = [];

				const first = new TestTask( 'first', WorkTask.NORMAL );
				const second = new TestTask( 'second', WorkTask.NORMAL );

				first.log = second.log = log;

				scheduler.add( first );
				scheduler.add( second );

				// a prioritized owner joins the second task — it must run first

				scheduler.reprioritize( second, WorkTask.HIGH );

				scheduler.update();

				assert.deepEqual( log, [ 'second', 'first' ], 'escalated task ran before earlier-queued work' );

				const task = new TestTask( 't', WorkTask.HIGH, [ WorkTask.YIELD ] );

				scheduler.add( task );
				scheduler.reprioritize( task, WorkTask.LOW );

				assert.strictEqual( task.priority, WorkTask.HIGH, 'tasks are never demoted' );

			} );

			QUnit.test( 'gate release wakes the highest-priority waiter', ( assert ) => {

				const scheduler = createScheduler();
				const log = [];

				const holder = new TestTask( 'holder', WorkTask.NORMAL, [ WorkTask.WAIT ] );
				scheduler.add( holder );
				scheduler.update();
				scheduler.tryAcquireGate( 'g', holder );

				const makeWaiter = ( key, priority ) => {

					const task = new TestTask( key, priority );

					task.run = function () {

						this.runs ++;

						if ( scheduler.tryAcquireGate( 'g', this ) === false ) return WorkTask.BLOCKED;

						log.push( this.key );
						this.settle( 'ready' );

						return WorkTask.DONE;

					};

					scheduler.add( task );

					return task;

				};

				makeWaiter( 'normal', WorkTask.NORMAL );
				makeWaiter( 'low', WorkTask.LOW );
				makeWaiter( 'high', WorkTask.HIGH );

				scheduler.update(); // all three park, in that order

				scheduler.release( 'g' );
				scheduler.update();
				scheduler.update();
				scheduler.update();

				assert.deepEqual( log, [ 'high', 'normal', 'low' ], 'waiters woke in priority order, not FIFO' );

			} );

			QUnit.test( 'poke() requeues waiting tasks but not parked ones', ( assert ) => {

				const scheduler = createScheduler();

				const waiting = new TestTask( 'waiting', WorkTask.NORMAL, [ WorkTask.WAIT, WorkTask.WAIT ] );

				scheduler.add( waiting );
				scheduler.update();

				assert.strictEqual( waiting.runs, 1, 'task is in flight' );

				scheduler.poke( waiting );
				scheduler.update();

				assert.strictEqual( waiting.runs, 2, 'poked task ran again' );

				const parked = new TestTask( 'parked', WorkTask.NORMAL );

				parked.status = 'blocked';

				scheduler.poke( parked );

				assert.strictEqual( scheduler._runnableCount(), 0, 'parked tasks are not requeued by poke' );

			} );

		} );

	} );

} );
