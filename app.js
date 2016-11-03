'use strict' ;

var PagerDuty = require('pagerduty');
var Emitter = require('events').EventEmitter ;
var util = require('util') ;
var assert = require('assert') ;
var _ = require('lodash') ;
var os = require('os') ;

module.exports = exports = Alerter ;

/**
 * A PagerDuty service capable of notifying multiple accounts, throttling and filtering alerts
 * @constructor
 * @param {Alerter~createOptions} opts - configuration options
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
      resolves: (optional) Array| string name(s) of (a) related event(s) that this event resolves (e.g. 'connection established' may resolve 'connection lost')
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
      resolves: typeof ev.resolves === 'string' ? [ev.resolves] : (_.isArray(ev.resolves) ? ev.resolves : []),
      notify: (false === ev.notify ? false : true)
    } ;

    if( !!ev.throttle ) {
      var arr ;
      if( arr = /(\d+)\s*(mins|min|secs|sec)/.exec( ev.throttle )  ) {
        obj.throttle = parseInt( arr[1] ) * ( arr[2].indexOf('min') !== -1 ? 60 : 1) ;
      }
    }

    if( !!ev.resolves ) {
      resolves[ev.name] = typeof ev.resolves === 'string' ? [ev.resolves] : ev.resolves ;
    }

    this._knownEvents[ev.name] = obj ;

  }, this) ;

  // point back to which event resolves this one (if any)
  _.each( resolves, function( arr, key ) {
    arr.forEach( function(eventName) {
      if( eventName in this._knownEvents ) {
        this._knownEvents[eventName].resolvedBy = this._knownEvents[eventName].resolvedBy || [] ;
        this._knownEvents[eventName].resolvedBy.push( key ) ;
      }
    }, this) ;
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

  // this is to allow our tests tp mock the PagerDuty service
  var PagerDutyService = Alerter.PagerDutyService || PagerDuty ;

  opts.serviceKeys.forEach( function(obj) {
    if( typeof obj === 'string') {
      this._alerters.pd.push( new PagerDutyService({ serviceKey: obj}) ) ;
    }
    else if( typeof obj === 'object' && 'level' in obj && 'keys' in obj ) {
      obj.keys = (typeof obj.keys === 'string' ? [obj.keys] : obj.keys) ;
      this._alerters.filtered.push({
        level: obj.level,
        pd: _.map( obj.keys, function(key) { return new PagerDutyService({ serviceKey: obj}); })
      }) ;
    }
  }, this) ;

  this._errorHistory = {} ;
  this._incidents = {} ;

}
util.inherits(Alerter, Emitter) ;


/**
 * invoked when an event has occurred; depending on the situation this may result in pagerduty incidents being created or resolved
 * @param  {string}   name     name of event that has occurred
 * @param  {Alerter~alertOptions}   [opts]  options
 * @param  {Alerter~alertCallback} [callback] callback that receives information about the operation 
 */
Alerter.prototype.alert = function(name, opts, callback ) {
    assert.ok(typeof name === 'string', 'Alerter#alert: \'name\' is a required parameter') ;

    if( typeof opts === 'function' ) {
      callback = opts ;
      opts = {} ;
    }
    opts = opts || {} ;

    var level = opts.level  ;
    var details = opts.details || {} ;
    var target = opts.target || 'default' ;
    var throttle = false ;
    var sent = 0 ;
    var resolved = 0 ;
    var now = (new Date()).getTime() ;

    details.hostname = os.hostname() ;


    var event = _.find( this._knownEvents, function(obj, key) { return key === name; }) || {notify: true, resolves: []} ;

    // check to see if this alert should be throttled
    if( event.throttle ) {
      if( !(name in this._errorHistory ) ) {
          this._errorHistory[name] = (new Date()).getTime() ;
      }
      else  {
          var then = this._errorHistory[name] ;
          var secsSinceLastAlert = (now-then) / (1000) ;

          if(  secsSinceLastAlert < event.throttle ) {
              throttle = true ;
              this._errorHistory[name] = (new Date()).getTime() ;
          }
      }
    }

    //automatically resolve any earlier incidents that this event fixes
   // if( event.resolves && event.resolves in this._incidents && target in this._incidents[event.resolves] ) {
   if( event.resolves.length > 0 ) {

      event.resolves.forEach( function(resolvedEventName) {
        if( resolvedEventName in this._incidents && target in this._incidents[resolvedEventName] ) {
          this._incidents[resolvedEventName][target].forEach( function(resolver) { 
            resolved++ ;
            resolver(); 
          }, this) ;
          delete this._incidents[resolvedEventName][target];
        }
      }, this) ;
   }

    // send the alerts if we are not throttling and this event is configured to generate an alert
    if( event.notify === true && !throttle ) {

      // send to those pagerduty accounts that get all alerts 
      this._alerters.pd.forEach( function(pd) {
        sent++ ;
        pd.create({
          description: (event.description || name),
          details: details,
          callback: this._onCreateIncident.bind( this, name, event, pd, target ) 
        }) ;
      }, this) ;

      // send to any filtered clients that want this severity level 
      this._alerters.filtered.forEach( function(obj) {
        if( level >= obj.level ) {
          obj.pd.forEach( function(pd) {
            sent++ ;
            pd.create({
              description: (event.description || name),
              details: details,
              callback: this._onCreateIncident.bind( this, name, event, pd, target ) 
            }) ;
          }, this) ;
        }
      }, this) ;
    }

    if( callback ) {
      process.nextTick( function() {
        callback( null, {
          event: event,
          throttled: throttle,
          sent: sent,
          resolved: resolved
        }) ;
      }) ;
    }
}

Alerter.prototype._onCreateIncident = function( name, event, pd, target, err, response ) {
    if( err ) {
      this.emit('error', err) ;
    }
    else if( event.resolvedBy && event.resolvedBy.length > 0 ) {

      // create the structure for saved incidents of this name if necessary
      var incidents = this._incidents[name] = (this._incidents[name] || {}) ;
      incidents[target] = incidents[target] || [] ;

      var resolver = pd.resolve.bind( pd, {
        incidentKey: response.incident_key,
        description: `resolved automatically due to ${event.resolvedBy}`,
        details: {
          hostname: os.hostname(),
          target: target
        }
      }) ;
      incidents[target].push( resolver ) ;
    }
}

/**
 * This callback is invoked to return information when <code>Alerter#alert</code> is invoked.
 * @callback Alerter~alertCallback
 * @param {Error} err - if an error occurred while attempting to create an incident on pagerduty
 * @param {Object} event - the defined event that was alerted
 * @param {boolean} throttled - true if the event was throttled and no pagerduty incident was created
 * @param {number} sent - number of pagerduty incidents created
 * @param {number} resolved - number of pagerduty incidents resolved
 */

/**
 * Constructor options
 * @typedef {Object} Alerter~createOptions
 * @property {Alerter~definedEvents} [events] - Array of events
 * @property {Alerter~serviceKeys} serviceKeys - Array of service keys
 */
 
/**
 * Array of information about pagerduty service keys
 * @typedef {Array} Alerter~serviceKeys
 * @property {string|Object}  key - either a single pagerduty service key, or an object with a 'level' and 'keys' property -- in the latter case, 'level' indicates the minimum severity level for which pagerduty alerts will be generated for these keys; keys is an array of pagerduty service keys
 */

 /**
  * Array of event definitions
  * @typedef {Array} Alerter~definedEvents
  * @property {string} name event name
  * @property {string} [description] event description
  * @property {number} [level] severity level (non-negative integer; higher values infer greater severity) - default: highest severity
  * @property {boolean} [notify] whether or not to send an alert to pagerduty (default: true)
  * @property {Array|string} [resolves] name(s) of events that this event should resolve on pagerduty
  * @property {string} [throttle] minimum interval between successive pagerduty alerts (format: "45 secs" or "5 mins"); default is no throttling
  */
/**
 * options passed to the <code>Alerter#alert</code> method
 * @typedef {Object} Alerter~alertOptions
 * @property {string} [target] - identifier for a specific instance of an event of a given name (e.g. 'LOST-DB-CONNECTION' may have targets 'primary-db' and 'backup-db').  The target property is only needed to disambiguate when resolving incidents pertaining to a specific resource.
 * @property {number} [level] - severity level for this alert
 * @property {Object} [details] - any details to pass on to pagerduty when creating an incident
 */
