import ChainMap from './ChainMap.js';
import RenderObject from './RenderObject.js';
import { DoubleSide } from '../../constants.js';

const _chainKeys = [];

/**
 * Returns `true` if the given material classifies as transparent for
 * render-list purposes.
 *
 * @private
 * @param {Material} material - The material.
 * @return {boolean} Whether the material classifies as transparent or not.
 */
function isTransparent( material ) {

	return material.transparent === true || material.transmission > 0 ||
		( material.transmissionNode && material.transmissionNode.isNode ) ||
		( material.backdropNode && material.backdropNode.isNode ) ? true : false;

}

/**
 * Returns `true` if the given transparent material requires a double pass.
 *
 * @private
 * @param {Material} material - The material.
 * @return {boolean} Whether the given material requires a double pass or not.
 */
function needsDoublePass( material ) {

	const hasTransmission = material.transmission > 0 || ( material.transmissionNode && material.transmissionNode.isNode );

	return hasTransmission && material.side === DoubleSide && material.forceSinglePass === false;

}

/**
 * This module manages the render objects of the renderer.
 *
 * @private
 */
class RenderObjects {

	/**
	 * Constructs a new render object management component.
	 *
	 * @param {Renderer} renderer - The renderer.
	 * @param {NodeManager} nodes - Renderer component for managing nodes related logic.
	 * @param {Geometries} geometries - Renderer component for managing geometries.
	 * @param {Pipelines} pipelines - Renderer component for managing pipelines.
	 * @param {Bindings} bindings - Renderer component for managing bindings.
	 * @param {Info} info - Renderer component for managing metrics and monitoring data.
	 */
	constructor( renderer, nodes, geometries, pipelines, bindings, info ) {

		/**
		 * The renderer.
		 *
		 * @type {Renderer}
		 */
		this.renderer = renderer;

		/**
		 * Renderer component for managing nodes related logic.
		 *
		 * @type {NodeManager}
		 */
		this.nodes = nodes;

		/**
		 * Renderer component for managing geometries.
		 *
		 * @type {Geometries}
		 */
		this.geometries = geometries;

		/**
		 * Renderer component for managing pipelines.
		 *
		 * @type {Pipelines}
		 */
		this.pipelines = pipelines;

		/**
		 * Renderer component for managing bindings.
		 *
		 * @type {Bindings}
		 */
		this.bindings = bindings;

		/**
		 * Renderer component for managing metrics and monitoring data.
		 *
		 * @type {Info}
		 */
		this.info = info;

		/**
		 * A dictionary that manages render contexts in chain maps
		 * for each pass ID.
		 *
		 * @type {Object<string,ChainMap>}
		 */
		this.chainMaps = {};

		/**
		 * Per-material promoted classification snapshots, used by async
		 * compilation mode to classify render lists from the promoted truth.
		 *
		 * @private
		 * @type {WeakMap<Material,{transparent:boolean,doublePass:boolean}>}
		 */
		this._classifications = new WeakMap();

	}

	/**
	 * Updates the promoted classification snapshot for the given material
	 * from its live state. Called only at promotion — a top-level safe
	 * point, outside the renderer's temporary pass-related `material.side`
	 * mutations — so the captured values are always the application's.
	 *
	 * @param {Material} material - The material.
	 */
	updateClassification( material ) {

		let classification = this._classifications.get( material );

		if ( classification === undefined ) {

			classification = { transparent: false, doublePass: false };

			this._classifications.set( material, classification );

		}

		classification.transparent = isTransparent( material );
		classification.doublePass = needsDoublePass( material );

	}

	/**
	 * Returns the promoted classification snapshot for the given material,
	 * or `null` when no generation has ever been promoted for it (new
	 * materials classify live; their draws are skipped until ready).
	 *
	 * @param {Material} material - The material.
	 * @return {?{transparent:boolean,doublePass:boolean}} The classification snapshot.
	 */
	getClassification( material ) {

		const classification = this._classifications.get( material );

		return classification !== undefined ? classification : null;

	}

	/**
	 * Releases the resources held by the given generation. Generations own a
	 * reference-count unit on everything they capture until they are promoted
	 * (ownership transfers to the render object) or discarded.
	 *
	 * @param {RenderGeneration} generation - The generation to release.
	 * @param {string} [status='stale'] - The terminal status to apply.
	 */
	releaseGeneration( generation, status = 'stale' ) {

		if ( generation.isTerminal() === true || generation.status === 'active' ) return;

		generation.status = status;

		if ( generation.nodeBuilderState !== null ) {

			this.nodes.releaseBuilderState( generation.cacheKey, generation.nodeBuilderState );
			generation.nodeBuilderState = null;

		}

		if ( generation.pipeline !== null ) {

			this.pipelines.releaseGenerationPipeline( generation.pipeline );
			generation.pipeline = null;

		}

		if ( generation.bindings !== null ) {

			this.bindings.destroyForGeneration( generation.bindings );
			generation.bindings = null;

		}

	}

	/**
	 * Returns a render object for the given object and state data.
	 *
	 * @param {Object3D} object - The 3D object.
	 * @param {Material} material - The 3D object's material.
	 * @param {Scene} scene - The scene the 3D object belongs to.
	 * @param {Camera} camera - The camera the 3D object should be rendered with.
	 * @param {LightsNode} lightsNode - The lights node.
	 * @param {RenderContext} renderContext - The render context.
	 * @param {ClippingContext} clippingContext - The clipping context.
	 * @param {string} [passId] - An optional ID for identifying the pass.
	 * @return {RenderObject} The render object.
	 */
	get( object, material, scene, camera, lightsNode, renderContext, clippingContext, passId ) {

		const chainMap = this.getChainMap( passId );

		// set chain keys

		_chainKeys[ 0 ] = object;
		_chainKeys[ 1 ] = material;
		_chainKeys[ 2 ] = renderContext;
		_chainKeys[ 3 ] = lightsNode;

		//

		let renderObject = chainMap.get( _chainKeys );

		if ( renderObject === undefined ) {

			renderObject = this.createRenderObject( this.nodes, this.geometries, this.renderer, object, material, scene, camera, lightsNode, renderContext, clippingContext, passId );

			chainMap.set( _chainKeys, renderObject );

		} else {

			// update references

			renderObject.camera = camera;

			//

			renderObject.updateClipping( clippingContext );

			let geometryChanged = false;

			if ( renderObject.needsGeometryUpdate ) {

				geometryChanged = true;

				renderObject.setGeometry( object.geometry );

			}

			if ( renderObject.version !== material.version || renderObject.needsUpdate ) {

				if ( this.renderer._asyncCompilation === true ) {

					// async mode: a structural change requests a background
					// generation; the render object keeps its identity and
					// keeps drawing its active generation until promotion

					const cacheKey = renderObject.getCacheKey();

					if ( renderObject.initialCacheKey !== cacheKey ) {

						renderObject.requestGeneration( cacheKey, geometryChanged );

					}

					renderObject.version = material.version;

				} else if ( renderObject.initialCacheKey !== renderObject.getCacheKey() ) {

					renderObject.dispose();

					renderObject = this.get( object, material, scene, camera, lightsNode, renderContext, clippingContext, passId );

				} else {

					renderObject.version = material.version;

				}

			}

		}

		// reset chain array

		_chainKeys[ 0 ] = null;
		_chainKeys[ 1 ] = null;
		_chainKeys[ 2 ] = null;
		_chainKeys[ 3 ] = null;

		//

		return renderObject;

	}

	/**
	 * Returns a chain map for the given pass ID.
	 *
	 * @param {string} [passId='default'] - The pass ID.
	 * @return {ChainMap} The chain map.
	 */
	getChainMap( passId = 'default' ) {

		return this.chainMaps[ passId ] || ( this.chainMaps[ passId ] = new ChainMap() );

	}

	/**
	 * Frees internal resources.
	 */
	dispose() {

		this.chainMaps = {};

	}

	/**
	 * Factory method for creating render objects with the given list of parameters.
	 *
	 * @param {NodeManager} nodes - Renderer component for managing nodes related logic.
	 * @param {Geometries} geometries - Renderer component for managing geometries.
	 * @param {Renderer} renderer - The renderer.
	 * @param {Object3D} object - The 3D object.
	 * @param {Material} material - The object's material.
	 * @param {Scene} scene - The scene the 3D object belongs to.
	 * @param {Camera} camera - The camera the object should be rendered with.
	 * @param {LightsNode} lightsNode - The lights node.
	 * @param {RenderContext} renderContext - The render context.
	 * @param {ClippingContext} clippingContext - The clipping context.
	 * @param {string} [passId] - An optional ID for identifying the pass.
	 * @return {RenderObject} The render object.
	 */
	createRenderObject( nodes, geometries, renderer, object, material, scene, camera, lightsNode, renderContext, clippingContext, passId ) {

		const chainMap = this.getChainMap( passId );

		const renderObject = new RenderObject( nodes, geometries, renderer, object, material, scene, camera, lightsNode, renderContext, clippingContext );

		renderObject.onDispose = () => {

			this.pipelines.delete( renderObject );
			this.bindings.deleteForRender( renderObject );
			this.nodes.delete( renderObject );

			chainMap.delete( renderObject.getChainArray() );

		};

		if ( renderer._asyncCompilation === true ) {

			// new drawables compile in the background and are skipped until
			// their first generation promotes

			renderObject.requestGeneration( renderObject.initialCacheKey );

		}

		return renderObject;

	}


}

export default RenderObjects;
