import { Timeline } from '../../tabs/Timeline.js';

const LIMIT = 500;
const TRIANGLES_GRAPH_LIMIT = 60;

class WorkerTimeline extends Timeline {

	constructor( options = {} ) {

		super( options );

		this.remoteMode = true;
		this.selectedFrameIndex = - 1;
		this.fixedScreenX = 0;
		this.isTrackingLatest = true;
		this.isManualScrubbing = false;

		this.recordRefreshButton.style.display = 'none';

	}

	setRemoteMode( enabled = true ) {

		this.remoteMode = enabled;
		this.recordRefreshButton.style.display = enabled ? 'none' : '';

		return this;

	}

	toggleRecording() {

		if ( this.remoteMode ) {

			const nextState = ! this.isRecording;

			if ( nextState ) {

				this.clear( false );
				this.frameInfo.textContent = 'Recording...';

			}

			this.handleRemoteState( nextState );
			this.inspector.sendRemoteMessage( { type: nextState ? 'timeline:start' : 'timeline:stop' } );

			return;

		}

		super.toggleRecording();

	}

	handleRemoteState( recording ) {

		this.isRecording = recording;

		if ( this.isRecording ) {

			this.recordButton.title = 'Stop';
			this.recordButton.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect></svg>';
			this.recordButton.style.color = 'var(--color-red)';

		} else {

			this.recordButton.title = 'Record';
			this.recordButton.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><circle cx="12" cy="12" r="4" fill="currentColor"></circle></svg>';
			this.recordButton.style.color = '';

			if ( this.frames.length > 0 ) {

				this.renderSlider();

			}

		}

	}

	handleRemoteClear() {

		this.clear( false );

	}

	handleRemoteFrame( frame ) {

		if ( ! frame ) return;

		this.frames.push( frame );

		if ( this.frames.length > LIMIT ) {

			this.frames.shift();

		}

		const triangles = frame.triangles || 0;

		if ( triangles > this.baseTriangles ) {

			const oldBase = this.baseTriangles;
			this.baseTriangles = triangles;

			if ( oldBase > 0 ) {

				const ratio = oldBase / this.baseTriangles;
				const points = this.graph.lines[ 'triangles' ].points;

				for ( let i = 0; i < points.length; i ++ ) {

					points[ i ] *= ratio;

				}

			}

		}

		const normalizedTriangles = this.baseTriangles > 0 ? ( triangles / this.baseTriangles ) * TRIANGLES_GRAPH_LIMIT : 0;

		this.graph.addPoint( 'calls', frame.calls.length );
		this.graph.addPoint( 'fps', frame.fps || 0 );
		this.graph.addPoint( 'triangles', normalizedTriangles );
		this.graph.update();

		if ( ! this.isManualScrubbing ) {

			if ( this.isTrackingLatest ) {

				this.selectFrame( this.frames.length - 1 );

			} else if ( this.selectedFrameIndex !== - 1 ) {

				const pointCount = this.graph.lines[ 'calls' ].points.length;

				if ( pointCount > 0 ) {

					const rect = this.graphSlider.getBoundingClientRect();
					const pointStep = rect.width / ( this.graph.maxPoints - 1 );
					const offset = rect.width - ( ( pointCount - 1 ) * pointStep );

					let localFrameIndex = Math.round( ( this.fixedScreenX - offset ) / pointStep );
					localFrameIndex = Math.max( 0, Math.min( localFrameIndex, pointCount - 1 ) );

					let newFrameIndex = localFrameIndex;

					if ( this.frames.length > pointCount ) {

						newFrameIndex += this.frames.length - pointCount;

					}

					this.selectFrame( newFrameIndex );

				}

			}

		}

	}

	clear( sendRemote = true ) {

		super.clear();

		this.currentFrame = null;
		this.selectedFrameIndex = - 1;
		this.fixedScreenX = 0;
		this.isTrackingLatest = true;
		this.isManualScrubbing = false;

		if ( sendRemote && this.remoteMode ) {

			this.inspector.sendRemoteMessage( { type: 'timeline:clear' } );

		}

	}

}

export { WorkerTimeline };
