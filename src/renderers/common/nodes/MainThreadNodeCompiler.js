import NodeCompiler from './NodeCompiler.js';

/**
 * The cooperative main-thread node compiler. Advances the existing node
 * builder via `NodeBuilder.buildStep( deadline )` in budgeted slices on the
 * main thread.
 *
 * This compiler supports every build and acts as the universal fallback for
 * builds the worker compiler declines. Builds are serialized through the
 * `'builder'` scheduler gate — the node system has shared caches and mutable
 * builder state, so only one main-thread build advances at a time.
 *
 * @private
 * @augments NodeCompiler
 */
class MainThreadNodeCompiler extends NodeCompiler {

	/**
	 * Constructs a new main-thread node compiler.
	 *
	 * @param {NodeManager} nodes - The node manager.
	 */
	constructor( nodes ) {

		super();

		/**
		 * The node manager.
		 *
		 * @type {NodeManager}
		 */
		this.nodes = nodes;

		this.gate = 'builder';

	}

	/**
	 * The cooperative compiler supports every build.
	 *
	 * @param {RenderObject} renderObject - The render object.
	 * @return {boolean} Always `true`.
	 */
	supports( /* renderObject */ ) {

		return true;

	}

	/**
	 * Advances the build by bounded units until the deadline is reached.
	 *
	 * @param {RenderGenerationTask} task - The owning task.
	 * @param {RenderObject} renderObject - The representative render object for the build.
	 * @param {number} deadline - Absolute `performance.now()` deadline.
	 * @return {?NodeBuilder} The finished node builder, or `null` when more work remains.
	 */
	run( task, renderObject, deadline ) {

		let builder = task._builder;

		if ( builder === null ) {

			builder = task._builder = this.nodes.createBuilderForGeneration( renderObject );

		}

		if ( builder.buildStep( deadline ) === false ) return null;

		task._builder = null;

		return builder;

	}

	/**
	 * Drops the in-flight builder of the given task.
	 *
	 * @param {RenderGenerationTask} task - The task.
	 */
	cancel( task ) {

		task._builder = null;

	}

}

export default MainThreadNodeCompiler;
