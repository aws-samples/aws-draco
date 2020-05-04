# Testing

## Events for use in the Console

The folder `events` contains samples of events that are useful when testing Lambda
functions from the console. This is an alternative to using the `rake event:` tasks.

## Command Line Unit Testing

`npm install`

Run `bundle exec rake test` to invoke the unit tests for the various lifecycle policies.

These use [Mocha](https://mochajs.org) with [Chai](https://www.chaijs.com).

### Generate Test Snapshot data

The `Policy()` function in file `retention.js` has been designed to facilitate testing. It accepts a list of
snapshots and return the same list with a flag `retain` set to `true` or `false` depending
on the policy. You can generate of test data fixtures using the script `scripts/gen.rb`.
These should be stored in `test/fixtures`.
