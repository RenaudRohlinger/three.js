/**
 * Abstract base class for node compilers used by async compilation mode.
 *
 * A node compiler advances the TSL build of a render generation task under a
 * deadline. The cooperative main-thread compiler is the universal fallback;
 * the worker compiler covers supported snapshots off the main thread.
 *
 * @private
 * @abstract
 */
class NodeCompiler {

	constructor() {

		/**
		 * The name of the scheduler gate that serializes this compiler's
		 * builds, or `null` if the compiler manages its own concurrency.
		 *
		 * @type {?string}
		 */
		this.gate = null;

	}

	/**
	 * Returns `true` if this compiler can compile the given render object's
	 * structural state.
	 *
	 * @abstract
	 * @param {RenderObject} renderObject - The render object.
	 * @return {boolean} Whether the build is supported or not.
	 */
	supports( /* renderObject */ ) {

		return false;

	}

	/**
	 * Advances the build for the given task. Returns the finished node
	 * builder when the build has completed, or `null` when more work
	 * remains (the task yields and resumes under budget).
	 *
	 * @abstract
	 * @param {RenderGenerationTask} task - The owning task.
	 * @param {RenderObject} renderObject - The representative render object for the build.
	 * @param {number} deadline - Absolute `performance.now()` deadline.
	 * @return {?NodeBuilder} The finished node builder, or `null`.
	 */
	run( /* task, renderObject, deadline */ ) {

		return null;

	}

	/**
	 * Cancels any in-flight build state for the given task.
	 *
	 * @param {RenderGenerationTask} task - The task.
	 */
	cancel( /* task */ ) {}

	/**
	 * Frees internal resources.
	 */
	dispose() {}

}

export default NodeCompiler;
