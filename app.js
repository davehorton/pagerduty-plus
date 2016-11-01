'use strict' ;

var PagerDuty = require('pagerduty');
var Emitter = require('events').EventEmitter ;
var util = require('util') ;
var assert = require('assert') ;
var _ = require('lodash') ;
var os = require('os') ;

module.exports = exports = Alerter ;

/**
 * A PagerDuty integration capable of notifying multiple accounts, throttling and filtering alerts
 * @constructor
 * @param {Alerter~createOptions}  [opts] - Alerter configuration options
 */
function Alerter(opts) {
  if (!(this instanceof Alerter)) { return new Alerter(opts); }
  Emitter.call(this); 

  assert.ok(typeof opts === 'object', '\'opts\' parameter must be provided') ;
  assert.ok(_.isArray(opts.serviceKeys), '\'opts.serviceKeys\' parameter must be an array') ;

  opts.events = opts.events || [] ;

  this._knownEvents = {} ;

  var resolves = {} ;

  /*
  configure this._knownEvents, which will be in the form:
  {
    'event-name': {
      description: 'lengthier description which gets sent to pagerduty',
      level: (optional) integer value representing severity, higher means more severe
      throttle: integer representing interval in seconds that must elapse before re-sending this alert (0 means no throttling)
      resolves: (optional) name of another event that this event resolves (e.g. 'connection established' may resolve 'connection lost')
      resolvedBy: (optional) reverse pointer to the above; i.e. name of an event that resolves an incident of this type,
      notify: boolean, indicating whether to send an alert to pager duty for this event (e.g. an event may simply resolve another event)
    }

  }
  */
  
  opts.events.forEach( function(ev) {
    assert.ok(typeof(ev.name) === 'string', 'objects in the \'opts.events\' array must have a \'name\' property') ;

    var obj = {
      description: ev.description || ev.name,
      level: ev.level || 0,
      throttle: 0, 
      resolves: ev.resolves,
      notify: ev.notify || true
    } ;

    if( !!ev.throttle ) {
      var arr ;
      if( arr = /(\d+)\s*(mins|min|secs|sec)/.exec( ev.throttle )  ) {
        obj.throttle = parseInt( arr[1] ) * ( arr[2].indexOf('min') !== -1 ? 60 : 1) ;
      }
    }

    if( !!ev.resolves ) {
      resolves[ev.name] = ev.resolves ;
    }

    this._knownEvents[ev.name] = obj ;

  }, this) ;

  // point back to which event resolves this one (if any)
  _.each( resolves, function( value, key ) {
    if( !!this._knownEvents[value] ) {
      this._knownEvents[value].resolvedBy = key ;
    }
  }.bind(this) ) ;

  /* configure this._alerters, which will be in the form:
  {
    pd: Array of PagerDuty instances that get every alert,
    filtered: [
      {
        level: 3,
        pd: Array of PagerDuty instances that get notified for incidents with level 3 or greater
      }
    ]
  }
  */

  this._alerters = {
    pd: [],
    filtered: []
  } ;

  opts.serviceKeys.forEach( function(obj) {
    if( typeof obj === 'string') {
      this._alerters.pd.push( new PagerDuty({ serviceKey: obj}) ) ;
    }
    else if( typeof obj === 'object' && 'level' in obj && 'keys' in obj ) {
      obj.keys = (typeof obj.keys === 'string' ? [obj.keys] : obj.keys) ;
      this._alerters.filtered.push({
        level: obj.level,
        pd: _.map( obj.keys, function(key) { return new PagerDuty({ serviceKey: obj}); })
      }) ;
    }
  }, this) ;

  this._errorHistory = {} ;
  this._incidents = {} ;

}
util.inherits(Alerter, Emitter) ;

/**
 * Options governing the creation of an Alerter
 * @typedef {Object} Alerter~createOptions
 * @property {Array} events - array of known events
 * @property {Array} serviceKeys - array of pagerduty service keys
 *
 * ex:
 * {
 *   events: [
 *     {
 *        name: 'LOST_CONNECTION', 
 *        description: 'lost connection to sip server',
 *        level: 1
 *        throttle: '5 mins',
 *        resolvedBy: 'GAINED_CONNECTION'
 *     },
 *     {
 *       name: 'GAINED_CONNECTION',
 *       description: 'gained connection to sip server',
 *       level: 2
 *     }
 *   ],
 *   serviceKeys: [
 *     {
 *       level: 0,
 *       keys: ['xxxxxx', 'yyyyyy']
 *     },
 *     {
 *       level: 1,
 *       keys: ['zzzzzz']
 *     }
 *   ]
 * } 
 * 
 */


Alerter.prototype.alert = function(name, level, details) {
    assert.ok(typeof name === 'string', 'Alerter#alert: \'name\' is a required parameter') ;

    var throttle = false ;
    var severity = 0 ;
    var now = (new Date()).getTime() ;

    if( typeof level === 'number') {
      severity = level ;
    }
    else {
      details = level || {} ;
    }
    details.hostname = os.hostname() ;


    var event = _.find( this._knownEvents, function(el) { return el.name === name; }) || {} ;

    // check to see if this alert should be throttled
    if( event.throttle ) {
      if( !(name in this._errorHistory ) ) {
          this._errorHistory[name] = (new Date()).getTime() ;
      }
      else  {
          var then = this._errorHistory[name] ;
          var secsSinceLastAlert = (now-then) / (1000) ;

          if(  secsSinceLastAlert < error.throttle ) {
              throttle = true ;
              this._errorHistory[name] = (new Date()).getTime() ;
          }
      }
    }

    //automatically resolve any earlier incidents that this event fixes
    if( event.resolves && event.resolves in this._incidents ) {
      this._incidents[event.resolves].forEach( function(resolver) { 
        resolver(); 
      }, this) ;
      delete this._incidents[event.resolves];
    }
    

    // send the alerts if we are not throttling and this event is configured to generate an alert
    if( event.notify === true && !throttle ) {

      // send to those pagerduty accounts that get all alerts 
      this._alerters.pd.forEach( function(pd) {
        pd.create({
          description: (event.description || name),
          details: details,
          callback: this._onCreateIncident.bind( this, name, event, pd ) 
        }) ;
      }, this) ;

      // send to any filtered clients that want this severity level 
      this._alerters.filtered.forEach( function(obj) {
        if( level >= obj.level ) {
          obj.pd.forEach( function(pd) {
            pd.create({
              description: (event.description || name),
              details: details,
              callback: this._onCreateIncident.bind( this, name, event, pd ) 
            }) ;
          }, this) ;
        }
      }, this) ;
    }
}

Alerter.prototype._onCreateIncident = function( name, event, pd, err, response ) {
    if( err ) {
      this.emit('error', err) ;
    }
    else if( event.resolvedBy ) {
      this._incidents[name] = this._incidents[name] || [] ;
      var resolver = pd.resolve.bind( null, {
        incidentKey: response.incident_key,
        description: `resolved automatically due to ${event.resolvedBy}`,
        details: {
          hostname: os.hostname()
        }
      }) ;
      this._incidents[name].push( resolver ) ;
    }
}


