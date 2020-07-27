# Testing

## Events for use in the Console

The folder `events` contains samples of events that are useful when testing Lambda
functions from the console. This is an alternative to using the `rake event:` tasks.

## Command Line Unit Testing

First run `npm install`

Then run `bundle exec rake test` to invoke the unit tests for the various lifecycle policies.

These use [Mocha](https://mochajs.org) with [Chai](https://www.chaijs.com).

### Generate Test Snapshot data

The `Policy()` function in file `retention.js` has been designed with testing in mind. It accepts a list of
snapshots and return the same list with a flag `retain` set to `true` or `false` depending
on the policy. You can generate test data fixtures using the script `scripts/gen.rb`.
These should be stored in `test/fixtures`.

### Seeing the effect of a Retention Policy

If you run the unit tests with the environment variable DEBUG=1 then each Policy test will
output the snapshots it will preserve from a synthetic set of dailies. It labels each one
with the appropriate day, date, week, month and year. Execute the tests like so:

    DEBUG=1 bundle exec rake test

A sample output for the _SemiMonthly_ policy:

```
pgdracotest-2020-05-03-22-20: Day: 0, Date: 3, Week: 18, Month: 4
pgdracotest-2020-05-02-22-20: Day: 6, Date: 2, Week: 18, Month: 4
pgdracotest-2020-05-01-22-20: Day: 5, Date: 1, Week: 18, Month: 4
pgdracotest-2020-04-30-22-20: Day: 4, Date: 30, Week: 18, Month: 3
pgdracotest-2020-04-29-22-20: Day: 3, Date: 29, Week: 18, Month: 3
pgdracotest-2020-04-28-22-20: Day: 2, Date: 28, Week: 18, Month: 3
pgdracotest-2020-04-27-22-20: Day: 1, Date: 27, Week: 18, Month: 3
pgdracotest-2020-04-26-22-20: Day: 0, Date: 26, Week: 17, Month: 3
pgdracotest-2020-04-25-22-20: Day: 6, Date: 25, Week: 17, Month: 3
pgdracotest-2020-04-24-22-20: Day: 5, Date: 24, Week: 17, Month: 3
pgdracotest-2020-04-23-22-20: Day: 4, Date: 23, Week: 17, Month: 3
pgdracotest-2020-04-22-22-20: Day: 3, Date: 22, Week: 17, Month: 3
pgdracotest-2020-04-21-22-20: Day: 2, Date: 21, Week: 17, Month: 3
pgdracotest-2020-04-20-22-20: Day: 1, Date: 20, Week: 17, Month: 3
pgdracotest-2020-04-19-22-20: Day: 0, Date: 19, Week: 16, Month: 3
pgdracotest-2020-04-12-22-20: Day: 0, Date: 12, Week: 15, Month: 3
    ✓ should delete according to SemiMonthly policy
```
