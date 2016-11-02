'use strict' ;
var uuid = require('node-uuid');
var _ = require('lodash') ;

exports = module.exports = PagerDuty ;


function PagerDuty(opts) {
  this._serviceKey = opts.serviceKey ;
  this._incidents = {} ;
}

PagerDuty.prototype.create = function(opts) {
  var callback = opts.callback || _.noop ;
  var incidentKey =  uuid.v1()  ;
  this._incidents[incidentKey] = true ;

  // return success ;
  process.nextTick( function() {
    callback( null, {
      incidentKey: incidentKey
    }) ;
  }) ;
}


PagerDuty.prototype.resolve = function(opts) {
  var callback = opts.callback || _.noop ;
  var incidentKey = opts.incidentKey ;

  if( !(incidentKey in this._incidents) ) {
    throw new Error(`incidentKey ${incidentKey} can not be resolved because there no incident was opened with that key`) ;

    process.nextTick( function() {
      callback(null) ;
    }) ;
  }
}
