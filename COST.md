# What does it Cost?

The cost of implementing this framework can be broken into the following
parts:

* The cost of the producer and consumer functions
* The cost of the snapshots themselves

When you have a DB instance, the cost of snapshots up to the size of the database storage
is included. However, since the DR account will not have any DB instances, the snapshots
will be charged at $0.10 per GiB-month. This far outweighs the cost of the DRACO
framework, as the following calculation shows:

# Framework Costs

The following was calculated using the default 5m poll interval when waiting for copies.

## wait4copy

This Step Function is invoked by the Producer and Consumer Lambda functions in order to
wait for the snapshot copy jobs to complete. It polls the status of the copy every 5
minutes and sends an SNS notification when it is complete. The poll itself is done by a
Lambda function, so the cost of executing this has two parts:

cost = $6.2e-6 + $0.675e-3 = $0.681e-3

### Lambda

The Lambda function uses minimal RAM (~90MB comfortably less than the default allocation
of 128MB) and takes from 200mS to 800mS per invocation. So if a copy takes 10-15 minutes
then at worst there are three iterations for a total execution time of 3000mS

Per 100mS it's $2.083e-7 (ie. $0.0000002083) so 3S is $6.2e-6

### Step Functions

Although there is a free tier per account of 4,000 state transitions. We'll disregard that for the
purposes of this calculation. The cost otherwise is $25e-6 per transition.

A single iteration takes nine transitions so a 15m copy will incur 27 transitions at a cost of $0.675e-3

## Producer

The producer is a Lambda function subscribed to an SNS topic. Each snapshot notification
causes 4 invocations. The function calls average 600mS - 700mS in duration and take less
than the default 128MB of RAM (currently ~85MB).

In addition one `wait4copy` invocation is required.

Producer Cost = (4 * 750mS)/100mS) * $2.083e-7 +  $0.681e-3  = $0.687e-3

## Consumer

The consumer is a Lambda function subscribed to an SNS topic. Each snapshot notification
causes 2 invocations. The function calls average 1600mS (peak 2S) and take less
than the default 128MB of RAM (currently ~85MB).

In addition one `wait4copy` invocation is required.

Consumer Cost = (2 * 1600mS)/100mS) * $2.083e-7 +  $0.681e-3  = $0.688e-3

# Total

So the total is: 0.687e-3 + 0.688e-3 = $1.375e-3 per day.

Which means that 10 databases snapshotting daily for a year would cost ~ $5
