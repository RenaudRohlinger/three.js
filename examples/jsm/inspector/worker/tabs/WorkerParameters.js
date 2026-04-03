import { Parameters } from '../../tabs/Parameters.js';

function toColorHex( value ) {

	if ( typeof value === 'number' ) {

		return `#${ value.toString( 16 ).padStart( 6, '0' ) }`;

	}

	if ( typeof value === 'string' ) {

		return value[ 0 ] === '#' ? value : `#${ value }`;

	}

	return '#000000';

}

class WorkerParameters extends Parameters {

	constructor( options = {} ) {

		super( options );

		this.remoteGroups = new Map();
		this.remoteControls = new Map();

	}

	resetRemote() {

		for ( const group of [ ...this.groups ] ) {

			if ( group.paramList.parent ) {

				group.paramList.parent.remove( group.paramList );

			}

		}

		this.groups.length = 0;
		this.remoteGroups.clear();
		this.remoteControls.clear();
		this.hide();

	}

	ensureRemoteGroup( groupId, name, parentId = null ) {

		if ( this.remoteGroups.has( groupId ) ) return this.remoteGroups.get( groupId );

		const group = parentId === null ? this.createGroup( name ) : this.remoteGroups.get( parentId )?.addFolder( name );

		if ( group === undefined ) return null;

		this.remoteGroups.set( groupId, group );
		this.show();

		return group;

	}

	updateRemoteGroupState( groupId, closed ) {

		const group = this.remoteGroups.get( groupId );

		if ( group && closed === true ) {

			group.close();

		}

	}

	addRemoteControl( descriptor ) {

		const group = this.remoteGroups.get( descriptor.groupId );

		if ( ! group ) return;

		const state = {};
		const property = descriptor.property;

		if ( descriptor.type === 'button' ) {

			state[ property ] = () => this.inspector.sendRemoteMessage( {
				type: 'parameters:invoke',
				controlId: descriptor.id
			} );

		} else {

			state[ property ] = descriptor.value;

		}

		let editor = null;

		switch ( descriptor.type ) {

			case 'select':
				editor = group.addSelect( state, property, descriptor.options );
				break;
			case 'slider':
				editor = group.addSlider( state, property, descriptor.min, descriptor.max, descriptor.step );
				break;
			case 'number':
				editor = group.addNumber( state, property, descriptor.min, descriptor.max );
				break;
			case 'boolean':
				editor = group.addBoolean( state, property );
				break;
			case 'string':
				editor = group.addString( state, property );
				break;
			case 'button':
				editor = group.addButton( state, property );
				break;
			case 'color':
				editor = group.addColor( state, property );
				break;

		}

		if ( editor === null ) return;

		if ( descriptor.label ) {

			editor.name( descriptor.label );

		}

		const remoteControl = {
			editor,
			state,
			property,
			suppress: false,
			type: descriptor.type,
			options: descriptor.options || null
		};

		if ( descriptor.type !== 'button' ) {

			editor.onChange( ( value ) => {

				if ( remoteControl.suppress ) return;

				this.inspector.sendRemoteMessage( {
					type: 'parameters:set',
					controlId: descriptor.id,
					value
				} );

			} );

		}

		this.remoteControls.set( descriptor.id, remoteControl );
		this.show();

	}

	updateRemoteControlValue( controlId, value ) {

		const remoteControl = this.remoteControls.get( controlId );

		if ( ! remoteControl ) return;

		remoteControl.suppress = true;
		remoteControl.state[ remoteControl.property ] = value;
		this._setRemoteEditorValue( remoteControl, value );

		requestAnimationFrame( () => {

			remoteControl.suppress = false;

		} );

	}

	updateRemoteControlLabel( controlId, label ) {

		const remoteControl = this.remoteControls.get( controlId );

		if ( remoteControl ) {

			remoteControl.editor.name?.( label );

		}

	}

	updateRemoteControlConfig( controlId, config ) {

		const remoteControl = this.remoteControls.get( controlId );

		if ( ! remoteControl || ! config ) return;

		const editor = remoteControl.editor;

		if ( config.step !== undefined ) {

			if ( typeof editor.step === 'function' ) {

				editor.step( config.step );

			} else if ( editor.input ) {

				editor.input.step = config.step;

			}

		}

	}

	_setRemoteEditorValue( remoteControl, value ) {

		const { editor, type, options } = remoteControl;

		if ( type === 'select' && editor.select ) {

			if ( Array.isArray( options ) ) {

				editor.select.selectedIndex = options.indexOf( value );

			} else if ( options ) {

				for ( const [ key, optionValue ] of Object.entries( options ) ) {

					if ( optionValue === value ) {

						editor.select.value = key;
						break;

					}

				}

			}

			return;

		}

		if ( type === 'color' && editor.colorInput ) {

			editor._value = value;
			editor.colorInput.value = toColorHex( value );

			return;

		}

		editor.setValue?.( value );

	}

}

export { WorkerParameters };
