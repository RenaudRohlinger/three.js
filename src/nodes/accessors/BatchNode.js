import Node from '../core/Node.js';
import { normalLocal } from './Normal.js';
import { positionLocal } from './Position.js';
import { nodeProxy, vec3, mat3, mat4, int, ivec2, float, Fn } from '../tsl/TSLBase.js';
import { textureLoad } from './TextureNode.js';
import { textureSize } from './TextureSizeNode.js';
import { tangentLocal } from './Tangent.js';
import { instanceIndex, drawIndex } from '../core/IndexNode.js';
import { varyingProperty } from '../core/PropertyNode.js';
import { NodeUpdateType } from '../Nodes.js';
import IndirectStorageBufferAttribute from '../../renderers/common/IndirectStorageBufferAttribute.js';

class BatchNode extends Node {

	static get type() {

		return 'BatchNode';

	}

	constructor( batchMesh ) {

		super( 'void' );

		this.batchMesh = batchMesh;


		this.batchingIdNode = null;
		this._indirectAttribute = null;
		this.updateBeforeType = NodeUpdateType.FRAME;

	}

	setup( builder ) {

		// POSITION

		if ( this.batchingIdNode === null ) {

			if ( builder.getDrawIndex() === null ) {

				this.batchingIdNode = instanceIndex;

			} else {

				this.batchingIdNode = drawIndex;

			}

		}


		const object = this.batchMesh;
		const geometry = object.geometry;

		const uint32 = new Uint32Array( 5 * object._multiDrawCount );
		const starts = object._multiDrawStarts;
		const counts = object._multiDrawCounts;
		const drawCount = object._multiDrawCount;
		const drawInstances = object._multiDrawInstances;

		for ( let i = 0; i < drawCount; i ++ ) {

			const count = drawInstances ? drawInstances[ i ] : 1;

			uint32[ i * 5 ] = counts[ i ];
			uint32[ i * 5 + 1 ] = count;
			uint32[ i * 5 + 2 ] = starts[ i ];
			uint32[ i * 5 + 3 ] = 0;
			uint32[ i * 5 + 4 ] = drawInstances ? 0 : i;

		}

		const indirectAttribute = new IndirectStorageBufferAttribute( uint32, 5 );
		geometry.setIndirect( indirectAttribute );
		this._indirectAttribute = indirectAttribute;

		const getIndirectIndex = Fn( ( [ id ] ) => {

			const size = textureSize( textureLoad( this.batchMesh._indirectTexture ), 0 );
			const x = int( id ).modInt( int( size ) );
			const y = int( id ).div( int( size ) );
			return textureLoad( this.batchMesh._indirectTexture, ivec2( x, y ) ).x;

		} ).setLayout( {
			name: 'getIndirectIndex',
			type: 'uint',
			inputs: [
				{ name: 'id', type: 'int' }
			]
		} );

		const indirectId = getIndirectIndex( int( this.batchingIdNode ) );

		const matricesTexture = this.batchMesh._matricesTexture;

		const size = textureSize( textureLoad( matricesTexture ), 0 );
		const j = float( indirectId ).mul( 4 ).toInt().toVar();

		const x = j.modInt( size );
		const y = j.div( int( size ) );
		const batchingMatrix = mat4(
			textureLoad( matricesTexture, ivec2( x, y ) ),
			textureLoad( matricesTexture, ivec2( x.add( 1 ), y ) ),
			textureLoad( matricesTexture, ivec2( x.add( 2 ), y ) ),
			textureLoad( matricesTexture, ivec2( x.add( 3 ), y ) )
		);


		const colorsTexture = this.batchMesh._colorsTexture;

		if ( colorsTexture !== null ) {

			const getBatchingColor = Fn( ( [ id ] ) => {

				const size = textureSize( textureLoad( colorsTexture ), 0 ).x;
				const j = id;
				const x = j.modInt( size );
				const y = j.div( size );
				return textureLoad( colorsTexture, ivec2( x, y ) ).rgb;

			} ).setLayout( {
				name: 'getBatchingColor',
				type: 'vec3',
				inputs: [
					{ name: 'id', type: 'int' }
				]
			} );

			const color = getBatchingColor( indirectId );

			varyingProperty( 'vec3', 'vBatchColor' ).assign( color );

		}

		const bm = mat3( batchingMatrix );

		positionLocal.assign( batchingMatrix.mul( positionLocal ) );

		const transformedNormal = normalLocal.div( vec3( bm[ 0 ].dot( bm[ 0 ] ), bm[ 1 ].dot( bm[ 1 ] ), bm[ 2 ].dot( bm[ 2 ] ) ) );

		const batchingNormal = bm.mul( transformedNormal ).xyz;

		normalLocal.assign( batchingNormal );

		if ( builder.hasGeometryAttribute( 'tangent' ) ) {

			tangentLocal.mulAssign( bm );

		}

	}

	updateBefore( frame ) {

		// WIP
		// const object = this.batchMesh;

		// const uint32 = new Uint32Array( 5 * object._multiDrawCount );
		// const starts = object._multiDrawStarts;
		// const counts = object._multiDrawCounts;
		// const drawCount = object._multiDrawCount;
		// const drawInstances = object._multiDrawInstances;

		// for ( let i = 0; i < drawCount; i ++ ) {

		// 	const count = drawInstances ? drawInstances[ i ] : 1;

		// 	uint32[ i * 5 ] = counts[ i ];
		// 	uint32[ i * 5 + 1 ] = count;
		// 	uint32[ i * 5 + 2 ] = starts[ i ];
		// 	uint32[ i * 5 + 3 ] = 0;
		// 	uint32[ i * 5 + 4 ] = drawInstances ? 0 : i;

		// }


		// const indirect = this._indirectAttribute;
		// indirect.value = uint32;
		// indirect.needsUpdate = true;

	}

}

export default BatchNode;

export const batch = /*@__PURE__*/ nodeProxy( BatchNode );
