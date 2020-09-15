// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
//
const AWS = require('aws-sdk');
const ec2 = new AWS.EC2({apiVersion: '2016-11-15'});
const kms = new AWS.KMS({apiVersion: '2014-11-01'});
const rds = new AWS.RDS({apiVersion: '2014-10-31'});
const s3 = new AWS.S3({apiVersion: '2006-03-01'});
const sf = new AWS.StepFunctions({apiVersion: '2016-11-23'});
const sns = new AWS.SNS({apiVersion: '2010-03-31'});
const sts = new AWS.STS({apiVersion: '2011-06-15'});
const producer_topic_arn = process.env.PRODUCER_TOPIC_ARN;
const state_machine_arn = process.env.STATE_MACHINE_ARN;
const retention = require('./retention.js');
const DEBUG = process.env.DEBUG;

exports.handler = async (incoming, context) => {
  var output = 'nothing';
  var status = 200;

  try {
    if (DEBUG) console.debug(`Raw Event: ${JSON.stringify(incoming)}`);
    if (!("Records" in incoming)) throw 'No records!';
    let record = incoming.Records[0];
    if (record.EventSource != "aws:sns") throw "Cannot handle source: " + record.EventSource;
    if (record.Sns.Subject != "DRACO Event") throw "Invalid subject: " + record.Sns.Subject;
    let evt = JSON.parse(record.Sns.Message);

    if (DEBUG) console.debug(`DRACO Event: ${JSON.stringify(evt)}`);
    switch (evt.EventType) {

      /*
       * This message takes a normalized event representing the production
       * snapshot and decides whether it should be copied to DR. If not then it
       * returns a 'snapshot-no-copy' message. If it should then it determines
       * which KMS encryption key should be used and returns the original
       * message with the added field TargetKmsId.
       *
       * This was done so that the producer would encrypt the snapshot with the
       * DR key directly rather than use a transit key. However I could not set
       * permissions to allow this to work, receiving error: KMSKeyNotAccessibleFault
       * The key id now remains in the message for use later.
       */

      case 'snapshot-copy-request': {
        if (await doNotCopy(evt)) break;
        let key_id = await getEncryptionKey(evt.SourceName, evt.TagList);
        evt.EventType = "snapshot-copy-initiate";
        evt.TargetKmsId = key_id;
        let p2 = {
          TopicArn: producer_topic_arn,
          Subject: "DRACO Event",
          Message: JSON.stringify(evt)
        };
        output = await sns.publish(p2).promise();
        if (DEBUG) console.debug(`SNS Publish: ${JSON.stringify(output)}`);
        console.log(`Published: ${JSON.stringify(evt)}`);
        break;
      }
      case 'snapshot-copy-shared': { // Transit Copy -> DR Copy
        let drcopy_id, drcopy_arn;
        let params = { };
        try {
          console.log(`Copying $${evt.SnapshotType} Snapshot ${evt.TransitArn} ...`);
          evt.TagList[process.env.TAG_KEY] = process.env.TAG_VALUE;
          switch (evt.SnapshotType) {
            case 'RDS Cluster': // Can only encrypt if original was
              params.CopyTags = false;
              params.Tags  = evt.TagList;
              drcopy_id = evt.SourceId.replace(':','-');
              if (evt.SourceKmsId !== undefined) params.KmsKeyId = evt.TargetKmsId;
              else console.warn (`${evt.SnapshotType} Snapshot ${evt.TransitArn} will be unencrypted!`);
              params.SourceDBClusterSnapshotIdentifier = evt.TransitArn;
              params.TargetDBClusterSnapshotIdentifier = drcopy_id;
              output = await rds.copyDBClusterSnapshot(params).promise();
              drcopy_arn = output.DBClusterSnapshot.DBClusterSnapshotArn;
              break;
            case 'RDS': // Always encrypt
              params.CopyTags = false;
              params.Tags  = evt.TagList;
              drcopy_id = evt.SourceId.replace(':','-');
              params.SourceDBSnapshotIdentifier = evt.TransitArn;
              params.TargetDBSnapshotIdentifier = drcopy_id;
              params.KmsKeyId = evt.TargetKmsId;
              output = await rds.copyDBSnapshot(params).promise();
              drcopy_arn = output.DBSnapshot.DBSnapshotArn;
              break;
            case 'EBS':// Always encrypt
              params.SourceSnapshotId = evt.TransitArn.split(':snapshot/')[1];
              params.Description  = `Draco snapshot of ${evt.SourceName}`;
              params.SourceRegion = evt.TransitArn.split(':')[4];
              params.DestinationRegion = params.SourceRegion;
              params.Encrypted = true;
              params.KmsKeyId = evt.TargetKmsId;
              if (evt.TagList.length > 0) {
                let TagSpec = {
                  ResourceType: "snapshot",
                  Tags: evt.TagList
                };
                params.TagSpecifications = [TagSpec];
              }
              output = await ec2.copySnapshot(params).promise();
              drcopy_id = output.SnapshotId;
              drcopy_arn = `arn:aws:ec2::${params.DestinationRegion}:snapshot/${drcopy_id}`;
              break;
            default:
              throw "Invalid Snapshot Type"+evt.SnapshotType;
          }
          console.log(`Copy started from ${evt.TransitArn} to ${drcopy_id}`);
          evt.EventType = "snapshot-copy-completed";
          evt.ArnToCheck = drcopy_arn;
          let sfparams = {
            stateMachineArn: state_machine_arn,
            name: context.awsRequestId,
            input: JSON.stringify({ "event": evt}),
          };
          output = await sf.startExecution(sfparams).promise();
          if (DEBUG) console.debug(`Starting wait4copy: ${JSON.stringify(evt)}`);
          } catch (e) {
            evt.Error = `Copy failed (${e.name}: ${e.message})`;
            console.error(`${evt.Error}, removing transit snapshot ${evt.TransitArn} ...`);
            await deleteTransitSnapshot(evt);
          }
          break;
      }
      // Tell the owning account to delete
      case 'snapshot-copy-completed': {
        await deleteTransitSnapshot(evt);
        try {
          await lifeCycle(evt.SnapshotType);
        } catch (e) {
          console.error(e);
        }
        break;
      }
      default:
        output = 'Event not handled';
        break;
    }
    status = 200;
  } catch (e) {
    console.error(e);
    console.error(`Raw Event: ${JSON.stringify(incoming)}`);
    output = e;
    status = 500;
  }
  return { statusCode: status, body: JSON.stringify(output), };
};
/*
 * Check whether the copy should proceed
 * If not then send a no-copy message back to the producer
 * returns true or false
 */
async function doNotCopy(evt) {
  let copy = true;
  let lifecycleTag = evt.TagList.find(tag => tag.Key == 'Draco_Lifecycle')
  if (lifecycleTag === undefined) {
    evt.Reason = 'No Draco_Lifecycle tag';
    copy = false;
  }
  else if (lifecycleTag.Value.toLowerCase() == 'ignore') {
    evt.Reason = 'Ignored';
    copy = false;
  }
  if (!copy) {
    evt.EventType = 'snapshot-no-copy'
    let p2 = {
      TopicArn: producer_topic_arn,
      Subject: "DRACO Event",
      Message: JSON.stringify(evt)
    };
    let output = await sns.publish(p2).promise();
    console.warn(`Not Copying ${evt.SnapshotType} Snapshot ${evt.SourceId}: ${evt.Reason}`);
    if (DEBUG) console.debug(`Publish response: ${JSON.stringify(output)}`);
  }
  return !copy;
}

/*
 * Retrieve the encryption key for the source.
 *
 * It uses the SourceName (the name of the Database or EBS Volume) to
 * lookup the key used to encrypt the snapshots. These keys are held
 * in the Regional Draco S3 Bucket as objects with the name
 * 'keys/{SourceName}' containing the key id. If the key doesn't exist
 * one is created.
 *
 * Returns the KMS Id of the key
 */
async function getEncryptionKey(sourceName, taglist) {
  let identity = await sts.getCallerIdentity({}).promise();
  let bucket = `draco-${identity.Account}-${process.env.AWS_REGION}`;
  let key = `keys/${sourceName}`;
  let s3params = { Bucket: bucket, Key: key };
  let key_id;
  try {
    if (DEBUG) console.debug(`Getting key for resource '${sourceName}'...`);
    let rsp = await s3.getObject(s3params).promise();
    key_id = rsp.Body.toString('utf-8');
    if (DEBUG) console.debug(`Found existing key ${key_id}`);
  } catch (e) {
    if (DEBUG) console.debug(`Key not found, allocating...`);

    let policy = {
      Version: '2012-10-17',
      Id: 'dr_key_policy',
      Statement:
        [
          {
            Sid: "DR Root account full access",
            Effect: "Allow",
            Principal: {
              AWS: `arn:aws:iam::${identity.Account}:root`
            },
            Action: "kms:*",
            Resource: '*'
          },
          {
            Sid: "Allow this Lambda to encrypt with the key",
            Effect: "Allow",
            Principal: {
              AWS: identity.Arn
            },
            Action: [
              'kms:Encrypt',
              'kms:ReEncrypt*',
              'kms:GenerateDataKey*',
              'kms:DescribeKey'
            ],
            Resource: '*'
          },
          {
            Sid: "Allow this Lambda to use this key with RDS and EC2",
            Effect: "Allow",
            Principal: {
              AWS: identity.Arn
            },
            Action: [
              "kms:CreateGrant",
              "kms:ListGrants",
              "kms:RevokeGrant"
            ],
            Resource: "*",
            Condition: {
              Bool: { "kms:GrantIsForAWSResource": "true"} }
          }
        ]
    }
    if (DEBUG) console.debug(`Key Policy: ${JSON.stringify(policy)}`);
    let kmstags = taglist.filter(t => !t.Key.startsWith('Draco_Lifecycle')).map(e => ({ TagKey: e.Key, TagValue: e.Value } ))

    let p1 = {
      Policy: JSON.stringify(policy),
      Description: `DRACO key for ${sourceName}`,
      BypassPolicyLockoutSafetyCheck: true,
      Tags: kmstags
    };
    let rsp = await kms.createKey(p1).promise();
    if (DEBUG) console.debug(`createKey: ${JSON.stringify(rsp)}`);
    key_id = rsp.KeyMetadata.KeyId;
    s3params.Body = Buffer.from(key_id, "utf-8");
    rsp = await s3.putObject(s3params).promise();
    if (DEBUG) console.debug(`putObject: ${JSON.stringify(rsp)}`);
  }
  return key_id
}

/*
 * Ask the producer to delete the transit snapshot
 */
async function deleteTransitSnapshot(evt) {
  evt.EventType = "snapshot-delete-shared";
  let p2 = {
    TopicArn: producer_topic_arn,
    Subject: "DRACO Event",
    Message: JSON.stringify(evt)
  };
  let output = await sns.publish(p2).promise();
  if (DEBUG) console.debug(`Publish response: ${JSON.stringify(output)}`);
  console.info(`Published: ${JSON.stringify(evt)}`);
}

/*
 * Retrieve a list of all the snapshots of this type that Draco has taken,
 * check the lifecycle policy and delete if necessary.
 */
async function lifeCycle(snapshot_type) {
  console.log(`Performing Lifecycle Management for: ${snapshot_type}`);
  let rsp = {};
  let snapshots = {};
  let sources = {};
  let identity = await sts.getCallerIdentity({}).promise();

  const start = Date.now();

  // Collect all current snapshots and determine their age

  let params = { };

  do {
    switch (snapshot_type) {
      case 'RDS Cluster':
        params.SnapshotType = 'manual';
        rsp = await rds.describeDBClusterSnapshots(params).promise();
        snapshots = rsp.DBClusterSnapshots;
        break;
      case 'RDS':
        params.SnapshotType = 'manual';
        rsp = await rds.describeDBSnapshots(params).promise();
        snapshots = rsp.DBSnapshots;
        break;
      case 'EBS': // Request all the snapshots owned by the DR account (no pagination)
        params.OwnerIds = [ identity.Account ];
        rsp = await ec2.describeSnapshots(params).promise();
        snapshots = rsp.Snapshots;
        break;
      default:
        throw "Invalid Snapshot Type: "+snapshot_type;
    }
    if ('Marker' in rsp) params.Marker = rsp.Marker;
    else delete params.Marker;

    for (const snapshot of snapshots) {
      if (snapshot_type.startsWith('RDS') && snapshot.Status != "available") continue;
      if (snapshot_type.startsWith('EBS') && snapshot.State != "completed") continue;

      let source_id, snapshot_id, snapshot_arn, snapshot_date;
      switch(snapshot_type) {
        case 'RDS Cluster':
          source_id = snapshot.DBClusterIdentifier;
          snapshot_id = snapshot.DBClusterSnapshotIdentifier;
          snapshot_arn = snapshot.DBClusterSnapshotArn;
          snapshot_date = new Date(snapshot.SnapshotCreateTime);
          break;
        case 'RDS':
          source_id = snapshot.DBInstanceIdentifier;
          snapshot_id = snapshot.DBSnapshotIdentifier;
          snapshot_arn = snapshot.DBSnapshotArn;
          snapshot_date = new Date(snapshot.SnapshotCreateTime);
          break;
        case 'EBS':
          source_id = snapshot.Description.split(':volume/')[1];
          snapshot_id = snapshot.SnapshotId;
          snapshot_date = new Date(snapshot.StartTime);
          break;
      }
      if (!(source_id in sources)) {
        sources[source_id] = new Array();
      }
      sources[source_id].push ({
        age: (start - snapshot_date.valueOf()) / (24  * 3600 * 1000.0),
        id:   snapshot_id,
        arn:  snapshot_arn,
        date: snapshot.SnapshotCreateTime,
      });
    }
  }
  while ('Marker' in params);


  for (const source in sources) {
    const snapshots = sources[source].sort((a,b) => a.age - b.age); // youngest first
    // Get the Tags on the most recent Snapshot
    let youngest = snapshots[0];
    let taglist;
    switch (snapshot_type) {
      case 'RDS Cluster':
      case 'RDS':
        rsp = await rds.listTagsForResource({"ResourceName": youngest.arn}).promise();
        taglist = rsp.TagList;
        break;
      case 'EBS': {
        let p = {
          Filters: [ { Name: "resource-id", Values: [ youngest.id ] } ],
          MaxResults: 500
        }
        let rsp = await ec2.describeTags(p).promise();
        taglist = rsp.Tags.filter(t => !t.Key.startsWith('aws:')).map(e => ({ Key: e.Key, Value: e.Value } ))
        break;
      }
    }
    let tags = {};
    for (let tag of taglist) {
      tags[tag.Key] = tag.Value;
    }
    if (typeof tags.Draco_Lifecycle === 'undefined') {
      console.warn(`Source: ${source} has no Draco_Lifecycle tag. Skipped`);
      continue;
    }
    const lifecycle = tags["Draco_Lifecycle"];
    console.log(`Source: ${source} has lifecycle '${lifecycle}' with ${snapshots.length} snapshots. Youngest: ${JSON.stringify(youngest)}`);
    let dry_run = (typeof process.env.DRY_RUN !== 'undefined' && process.env.DRY_RUN != "false")
    let deletions = retention.implementPolicy(snapshots, lifecycle).filter(f => f.retain == false);
    for (const snap of deletions) {
      console.log(`${dry_run ? "Dry Run - Not ":""}Deleting: ${snap.id}`);
      if (!dry_run) {
          switch(snapshot_type) {
            case 'RDS Cluster':
              rsp = await rds.deleteDBClusterSnapshot({ DBClusterSnapshotIdentifier: snap.id }).promise();
              break;
            case 'RDS':
              rsp =await rds.deleteDBSnapshot({ DBSnapshotIdentifier: snap.id }).promise();
              break;
            case 'EBS':
              rsp =await ec2.deleteSnapshot({ SnapshotId: snap.id }).promise();
              break;
          }
      }
    }
  }
}

// vim: sts=2 et sw=2:
