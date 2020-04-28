## License
This code is licensed under the MIT-0 License. See the LICENSE file.

# Copyright

Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: Apache-2.0

Author: Nick Townsend (nicktown@amazon.com)

# Notes

The DR Account Copying system (DRACO) is a skeleton application built to address a common need - that of moving
copies of database snapshots to a separate DR account. Although this problem has been
addressed before (see [this AWSLabs Project](https://github.com/awslabs/rds-snapshot-tool)) there are benefits to implementing an event-based and fully serverless solution:

* You can add other types of snapshots to be backed up by listening for the appropriate events.
* You can easily parallelize these long running tasks in a way that is difficult with
  `cron` type solutions.

On the down side not all important events are currently published (for example the "copy
complete" status in an RDS event). Given that event driven and serverless applications are
a core part of the future AWS strategy we expect this situation to change. Where an event
is not available you can write a polling mechanism to generate them artificially. DRACO
illustrates this approach using the `wait4copy` state machine.

## Diagram

![Enter the Dragon](https://github.com/aws-samples/aws-draco/raw/master/doc/Draco.png "The
DRACO Event Flow")

## Note on CloudFormation Templates

The names of the Producer and Consumer SNS topics are hardcoded within the account and
region as 'DracoProducer' and 'DracoConsumer'. This is to avoid a circular dependency
between the producer and consumer stacks.

### KMS Permissions

Note that the KMS permissions used in the code are not minimalist. You may wish to curtail
them further.

## Tags

DRACO makes use of tags in two ways:

* To determine the lifecycle policy on the consumer side DRACO relies on tagging the
  database instance with the tag 'Draco_Lifecycle'. The value of this tag determines the
  code path in the consumer lambda function that deletes previous snapshots.
* In the ordinary way you can specify a tag key and value to add to the snapshots in the
  consumer (DR) account.

Note that database tags are copied to a snapshot by default. However tags cannot be copied
from a shared (or public) snapshot so the DR copy of the snapshot obtains it's tags via
the SNS message `snapshot-copy-shared`. When creating the DR copy it adds the configured
Draco key and value.

## The Code

The code is written in NodeJS. There is a Ruby Rakefile that simplifies the development
process with tasks to set the environment and upload the code to an S3 bucket for
deployment using the CloudFormation console.

## Quickstart

Here's the quickest way to start:

* After checking out the repository create your own configuration file by copying
  `config.yaml.sample` to `config.yaml`. Edit this file as appropriate. Note that the
  variables in this file can be overridden using environment variables of the same name.

* Setup the Ruby Environment:

```bash
    sudo gem install bundle
    bundle config set path .bundle
    bundle install
```

* If you want to be able to modify the functions, then create an S3 bucket to hold your copies of the code.
  Otherwise use the existing bucket. When creating a bucket make sure that the bucket policy
  allows access for both the source (Producer) and target (Disaster Recovery) accounts.
  Assuming you've created `config.yaml` you can use the following command to do this:

```bash
    bundle exec rake create_bucket
```

* Upload the code to the bucket:

```bash
    bundle exec rake upload
```

* Sign in to the CloudFormation console __in the source account__ and create a stack using the
  `producer.yaml` template.

* Sign in to the CloudFormation console __in the disaster recovery account__ and create a
  stack using the `consumer.yaml` template.

* Alternatively, instead of using the console to creat the CloudFormation Stacks, you can
  use the command line. Make sure that you have correctly configured `config.yaml` (or the
  environment) to set the appropriate AWS_PROFILE and accounts. Then issue the command:
    `bundle exec rake create:producer`
  Switch to the DR Account (by changing AWS_PROFILE) and issue the command:
    `bundle exec rake create:consumer`

* Watch the DR copies accumulate!

## Advanced Use

### Dry Run

The code will not actually delete any snapshots until the environment variable NO_DRY_RUN
is set in the Lambda function. This must be done manually, after checking the logs to make
sure that no vital snapshots would be removed!

### Rake Tasks

The `Rakefile` contains other tasks for installing, testing and debugging the system. You
can see a list of these with the following command:

```bash
    bundle exec rake -T
```

Some of them rely on a configuration variable 'Role' in `config.yaml`. This should be set
to either 'Producer' or 'Consumer' depending which test messages you wish to send.
