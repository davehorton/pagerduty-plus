# pagerduty-plus [![Build Status](https://travis-ci.org/davehorton/pagerduty-plus.svg?branch=master)](http://travis-ci.org/davehorton/pagerduty-plus) 
a wrapper for nodejs [pagerduty](https://github.com/skomski/node-pagerduty) moddule that adds throttling, filtering and automatic incident resolution

```js
var Alerter = require('pagerduty-plus') ;
var alerter = new Alerter({
  serviceKeys: ['service-key1', 'service-key2'], 
  events: [
    {
      name: 'DNS-FAILED',
      description: 'unable to resolve hostname'
    },
    {
      name: 'DNS-SUCCESS',
      description: 'successfully resolved hostname',
      resolves: 'DNS-FAILED',
      notify: false
    }        
  ]
}) ;

alerter.alert('DNS-FAILED') ; // sends two pager duty alerts

//time passes...

alerter.alert('DNS-SUCCESS'); // resolves the two incidents
```

## Constructor

Most of the configuration happens when the Alerter object is constructed, via the arguments passed.  In the simplest possible implementation, you need only pass an object with a 'serviceKeys' property, which should be an array of one or more pagerduty service keys:

### Simple constructor
```js
var Alerter = require('pagerduty-plus') ;
var alerter = new Alerter({
  serviceKeys: ['myservice-key']
}) ;

alerter.alert('something went wrong..', { details: {...} } ) ;
```

### More complex scenarios

Of course, you don't gain much from simply using the underlying [pagerduty](https://github.com/skomski/node-pagerduty) module in this case:  the code above simply creates a pager duty incident with the string provided as the description and whatever additional details you provide.

To get the benefits of throttling, etc, you need to provide some information about the events you will triggering alerts on.  For instance, in the first example above, we configured two events ('DNS-FAILED' and 'DNS-SUCCESS'), and indicated they are related in that an occurrence of one event should resolve a previous occurrence of the other.  

#### Filtering recipients based on severity

Similarly, we can assign events severity levels, and have the alerts sent to different groups depending on severity.  Severity levels are represented by non-negative integer values, with higher values representing more severe events.  When configuring service keys, you can associate a level with a service key, in which case it will receive an alert for any event with a severity greater than or equal to that level.  If you configure a service key with no associated level, it receives all alerts.

```js
var Alerter = require('pagerduty-plus') ;
var alerter = new Alerter({
  serviceKeys: ['my-service-key', 
    {level: 3, keys: 'your-sevice-key2'}, 
    {level: 8, keys: ['customer-service-key1', 'customer-service-key2']}
  ], 
  events: [
    {
      name: 'SYSTEM-DOWN',
      description: 'system is down or unresponsive',
      level: 10
    },
    {
      name: 'SERVICE-DEGRADED',
      description: 'system is working but slowly',
      level: 5
    },
    {
      name: 'INFORMATIONAL-EVENT',
      description: 'something of interest happened, but I don\'t want to worry you...',
      level: 1
    }        
  ]
}) ;
alerter.alert('SYSTEM-DOWN');              // everyone gets this

alerter.alert('SERVICE-DEGRADED');         // you and I get this; customer doesn't

alerter.alert('INFORMATIONAL-ALERT');      // only I get this..
```

#### Automatically resolving pagerduty incidents

This was mentioned above, but let's go into a bit more detail.  Often, you may have "bookend" type of events, where the occurrence of one event signifies the start of a problem, and a later occurrence of another event signifies the problem has been resolved -- think: "I lost my database connection" and "I regained my database connection".

When you have these bookend type of events, you can automatically cause an incident that has been opened to be automatically resolved with the paired event occurs.  In order to do so, you need to use the 'resolves' property of when defining the event that resolves an incident opened by the other event.  So, as in the database connection example, you would define:

```js
var Alerter = require('pagerduty-plus') ;
var alerter = new Alerter({
  serviceKeys: [...], 
  events: [
    {
      name: 'db-connection-lost',
      description: 'lost connection to database'
    },
    {
      name: 'db-connection-established',
      description: 'gained connection to database',
      resolves: 'db-connection-lost'
    }        
  ]
}) ;
```
Then, when a 'database-connection-gained' event is recorded, it will automatically close the pagerduty incident opened if an earlier 'db-connection-lost' event was recorded.

```js
alerter.alert('db-connection-lost');          // incident created on pagerduty

alerter.alert('db-connection-established');   // incident resolved on pagerduty
```
However, imagine that you have two databases that you are monitoring.  You need to make sure that the the lost/re-gained pairs of events "match", in the sense of applying to the same database.  In that use case, you would supply a 'target' property in the object passed to <code>Alerter#alert</code> to identify which database instance the event pertains to.  The value for target can be anything you want, as long as it identifies the resource about which the event is being generated.
```js
var Alerter = require('pagerduty-plus') ;
var alerter = new Alerter({
  serviceKeys: [...], 
  events: [
    {
      name: 'db-connection-lost',
      description: 'lost connection to database'
    },
    {
      name: 'db-connection-established',
      description: 'gained connection to database',
      resolves: 'db-connection-lost'
    }        
  ]
}) ;

alerter.alert('db-connection-lost', {target: 'database-url-1'}); //lost connection to database 1

alerter.alert('db-connection-lost', {target: 'database-url-2'}); //lost connection to database 2

alerter.alert('db-connection-established', {target: 'database-url-1'}); //incident for db 1 resolved; incident for db2 stays open
```
## API
API documentation [can be found here](http://davehorton.github.io/pagerduty-plus/api/Alerter.html).

