# Introduction

The DR Account Copying system (DRACO) is a skeleton application built to address a common
need - that of moving copies of EBS and RDS snapshots (including RDS Aurora Clusters) to a
separate DR account (within the same Region). Although this problem has been partially
addressed before (see [this AWSLabs
Project](https://github.com/awslabs/rds-snapshot-tool)) there are benefits to implementing
an extensible, event-driven and fully serverless solution:

* You can add other types of snapshots to be backed up by listening for the appropriate events.
* You can easily parallelize these long running tasks in a way that is difficult with
  `cron` type solutions.

On the down side not all important events are currently published (for example the "copy
complete" status in an RDS snapshot copy event). Given that event driven and serverless
applications are a core part of the future AWS strategy we expect this situation to
change. Where an event is not available you can write a polling mechanism to generate them
artificially. DRACO illustrates this approach using the `wait4copy` state machine.

## License
This code is licensed under the MIT-0 License. See the LICENSE file.

## Copyright

Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: Apache-2.0

Author: Nick Townsend (nicktown@amazon.com)

## Diagram

![The DRACO Event Flow](doc/Draco.png)

## Usage

Once installed DRACO will copy every EBS Volume and RDS Database snapshot taken in the designated
'Production' account that is tagged with `Draco_Lifecycle` across to the designated
'Disaster Recovery' account and re-encrypt them with a key known only to the DR account
(subject to Limitations - see below).
There they will accumulate continuously, subject to a retention policy. The retention
policy for a snapshot is determined by the value of the tag `Draco_Lifecycle` which must
take on one of several predetermined values:

* `Ignore`: No action will be taken. Useful to suppress the warning messages that would
   otherwise be produced.
* `Test`: This retains the most recent 3 copies, irrespective of time.
* `Weekly`: this retains a rolling 7 days,
* `Fortnightly`: this retains a rolling 14 days,
* `Biweekly`: this retains two: a weekly for the previous week and the most recent daily
   for the current week,
* `SemiMonthly`: this retains 16: the last two weeks of daily snapshots and two weekly
   snapshots (for weeks 3 and 4),
* `Monthly`: this retains a rolling month of daily snapshots,
* `CurrentMonth`: this retains only those snapshots in the current month,
* `Extreme`: This retains the most recent daily for a week, the most recent weeklies for
  a month, the most recent monthlies for a year, and the most recent yearly for 7 years.

Note that these names are not case-sensitive. If an unknown policy is used then no
snapshots will be deleted.

After a snapshot is copied to DR, all of the snapshots of that type in the DR account are
reviewed and the **current** policy for the source database or volume is applied. This
allows the retention policy to be altered and automatically propagate to the DR account.

To see examples of the policies follow the instructions in [Testing](test/README.md)

## Transit Copy


There are several issues with snapshots, their creation and copying:
* Snapshots encrypted with the default CMK cannot be shared. This means a temporary transit
  copy has to be made.
* Snapshots encrypted with a CMK could be shared, but then they'd need to be permissioned
  to allow the DR account to use them. They'd also need to be permissioned to allow the
  production account to use them. Using a transit copy with a transit key avoids the
  latter permission, but the CMK does need the former. See below for a sample.
* Copying unencrypted RDS Cluster snapshots with encryption is not supported, so
  these will be copied across and stored as-is in plaintext.
* EBS Volume snapshots don't inherit the tags of the underlying volume so DRACO copies the
  tags from the original volume and merges them with those of the snapshot.
* RDS Database snapshots can be set to inherit the tags of the underlying database so the
  above isn't necessary for them.

The transit copy is encrypted with a fixed KMS key which is shared with the DR account.
This allows the DR account to copy the encrypted transit snapshots to the DR (or _target_)
copy which is encrypted with an individual key per sourcename. These keys are dynamically
allocated when the DR copy is made and are identified by an alias name of
`alias/DRACO-<sourcename>`. As best practice Automatic Rotation is enabled. They are used
for all subsequent snapshots of the source.

### Sample CMK Policy

If the source snapshot is encrypted with a specific CMK, the CMK must have the appropriate
permissions to allow DRACO to copy the snapshot and re-encrypt with the transit key.

```json
{
    "Sid": "Allow the DRACO Lambda to ReEncrypt with the key",
    "Effect": "Allow",
    "Principal": {
        "AWS": "...ARN of draco-consumer-SnapshotHandlerLambda Role..."
    },
    "Action": [
        "kms:Decrypt",
        "kms:Encrypt",
        "kms:ReEncrypt*",
        "kms:GenerateDataKey*",
        "kms:DescribeKey"
    ],
    "Resource": "*"
},
{
    "Sid": "Allow this Lambda to use this key with RDS and EC2",
    "Effect": "Allow",
    "Principal": {
        "AWS": "...ARN of draco-consumer-SnapshotHandlerLambda Role..."
    },
    "Action": [
        "kms:CreateGrant",
        "kms:ListGrants",
        "kms:RevokeGrant"
    ],
    "Resource": "*",
    "Condition": {
        "Bool": {
            "kms:GrantIsForAWSResource": "true"
        }
    }
}
```

The ARN of the Lambda role can be obtained from the CloudFormation stack Resources tab
in the `LambdaExecutionRole`.

## Costs

Minimal. See the approximate [cost calculation](COST.md)

## Limitations

Your DR account must have the snapshot limit set so that all the desired snapshots can be
retained. The default limit is 50. If this limit is exceeded DRACO cannot function and
will log an ERROR message to CloudWatch logs.

# Installation

First clone the repository and change into the directory:

```bash
git clone https://github.com/aws-samples/aws-draco.git
cd aws-draco
```

## Setup the Environment:

### Ruby

```bash
sudo gem install bundle
bundle config set path .bundle
bundle install
```

### Cloudformation Linting

Before uploading the CloudFormation templates the Rakefile will call the 'cfn_lint' task,
for this to succeed, install the [AWS CloudFormation
Linter](https://github.com/aws-cloudformation/cfn-python-lint).

On a MacOS system use the command: `brew install cfn-lint`

## Configuration

After cloning the repository create your own configuration file by copying
`config.yaml.sample` to `config.yaml`. Edit this file as appropriate. Note that the
variables in this file will be overridden if an environment variable exists with the same
name.

### S3 Bucket Usage

The code for the producer and consumer must be sourced from an S3 bucket in order to be
used by the CloudFormation template. The current master code is kept in an S3 bucket in
the AWS London Region named `draco`. CloudFormation requires that the code be in an S3
bucket in the hosting region, which is an issue when installing Draco in regions other
than London. In addition, customizing the code (eg. to add a new Retention policy), needs
a separate (writable!) S3 bucket.

To solve these two problems the _consumer_ CloudFormation template creates a new
Draco-specific bucket (owned by the DR account) in the target region and copies the code
into it using a Custom resource. The name of this bucket is `draco-<account
number>-<region>`.  The source bucket and prefix are given as parameters to the templates,
with the defaults being the master code bucket. These can be overridden to deploy
customized code.

For security reasons only the DR account has write access to the Draco-specific bucket,
upon which a bucket policy gives the Production account readonly access to the Draco
artifacts. Since these are different accounts, the role or user executing the creation of
the Producer stack **must have permissions granted on the Draco-specific bucket in the DR
account**. Here is an example of an appropriate policy that must be manually attached:

```json
{
    "Version": "2012-10-17",
    "Statement": [
        {
            "Sid": "ListBucket",
            "Effect": "Allow",
            "Action": "s3:ListBucket",
            "Resource": "arn:aws:s3:::draco-<account number>-<region>"
        },
        {
            "Sid": "GetDRACOObjects",
            "Effect": "Allow",
            "Action": [
                "s3:GetObject",
                "s3:GetObjectVersion"
            ],
            "Resource": "arn:aws:s3:::draco-<account number>-<region>/draco/*"
        }
    ]
}
```

The Draco-specific bucket has versioning enabled, which simplifies the CloudFormation
update of the Lambda function code and also allows a record to be kept of code changes.

## Updating the Lambda function code (optional)

If you want to be able to modify the Lambda functions then you can use the Draco S3 bucket
created during the install (which is owned by the DR account). The name of this bucket is
provided as an output parameter from the stack and is of the form `draco-<account
number>-<region>`. You may also use any other bucket with appropriate permissions.

If using the command line interface, update the name of the bucket in `config.yaml` (which
by default is the master bucket 'draco').  Then upload code changes with the command:


```bash
bundle exec rake upload
```

## Create the CloudFormation Stacks

Note the DR account stack must be created first, as it creates the S3 bucket that
holds the code.

The names of the Producer and Consumer SNS topics are hardcoded within the account and
region as 'DracoProducer' and 'DracoConsumer'. This is to avoid a circular dependency
between the producer and consumer stacks. Create them either from the console or the
command line as follows:

### From the Console

* Sign in to the CloudFormation console __in the disaster recovery account__ and create a
  stack using the `consumer.yaml` template.

* Sign in to the CloudFormation console __in the source account__ and create a stack using the
  `producer.yaml` template.

In both cases that you will have to change the default input parameters if you have made
any changes.

Note that due to limitations within CloudFormation there is a parameter "DeployTimestamp"
that must be updated if you wish new code to be automatically deployed. The value is not
used, it must just be different to the previous deployment.

### From the Command Line

Make sure that `config.yaml` is correctly configured. Note that you can change
`AWS_PROFILE` either by exporting it directly using the shell (`export AWS_PROFILE=zzzz`)
or by updating `config.yaml`. Then:

* Switch `AWS_PROFILE` to the DR Account
* Issue the command: `bundle exec rake create:consumer`
* Ensure that `AWS_PROFILE` is set to the producer account
* Issue the command: `bundle exec rake create:producer`

Note that if you are developing new Lambda functions that you can upload code changes as
described above, and then update the stacks with `bundle exec rake update:<stackname>`.
Typically only the consumer stack is updated when developing lifecycle policies.

## Operation

DRACO uses a tag on the database instance or EBS volume to set the lifecycle policy. In
the RDS case you must ensure that the copying of tags to snapshots is enabled for the
database so that DRACO can propagate the chosen lifecycle. With AWS EBS Backups this
happens automatically. The tag `Draco_Lifecycle` must be present on a snapshot before
DRACO will automatically copy it. Remember to do this when creating Manual EBS snapshots.
The value used to determine the lifecycle is taken from the most recent snapshot, and so
the retention policy can be altered subsequently.

Note that you can specify an additional tag key and value (in `config.yaml`) that will be
added to the snapshots created in the consumer (DR) account.

As soon as the stacks are created, the appropriate EBS and RDS events will be subscribed to, and
so any __new__ snapshots taken in the production account will copy across to the DR
account if appropriately tagged.

When a new snapshot is copied all snapshots of the same type are subject to the lifecycle
policy and potentially deleted.

### Deletion and Dry Run

As a safety measure, the code __will not actually delete any snapshots__ until the
environment variable `DRY_RUN` is either removed or set to 'false' in the Lambda function.
This should be done manually via the console, after checking the CloudWatch logs to make
sure that no vital snapshots would be removed!

### Monitoring

The CloudFormation template sets up Custom Metrics for the number of Errors and Warnings
generated by DRACO. The namespace is "Draco/SnapshotHandler" and the metrics are
`ErrorCount` and `WarnCount` respectively. Typically Errors are caused by failure to copy
snapshots due to insufficient limits (the default number of manual snapshots allowed per
account is 50 at time of writing). Warnings are issued when a snapshot is detected that
does not contain a `Draco_Lifecycle` tag. To suppress these warnings set the tag to the
value `Ignore`.

## Note on Tags

Normally tags cannot be copied from a shared (or public) RDS snapshot. However DRACO sends
the source tags via the SNS message `snapshot-copy-shared`, from where they are added to
the DR snapshot along with the Draco specific tag specified in `config.yaml`.

## Advanced Use

The code is written in NodeJS. There is a Ruby Rakefile that simplifies the development
process with tasks to set the environment and upload the code to an S3 bucket for
deployment using the CloudFormation console.

### Debugging

Set the environment variable DEBUG manually in the Lambda functions. This is a numerical
level:

* 0: (or any other non-numeric value) No debugging
* 1: control flow tracing
* 2: API call responses
* 3: Full details

Numerically higher levels include the lower levels.

### Rake Tasks

The `Rakefile` contains other tasks for installing, testing and debugging the system. You
can see a list of these with the following command:

```bash
    bundle exec rake -T
```

Some of them rely on a configuration variable 'Role' in `config.yaml`. This should be set
to either 'Producer' or 'Consumer' depending which test messages you wish to send.

### Testing

See the README file in the `test` directory.
