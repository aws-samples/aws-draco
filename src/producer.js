// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
//
const AWS = require('aws-sdk');
const ec2 = new AWS.EC2({apiVersion: '2016-11-15'});
const rds = new AWS.RDS({apiVersion: '2014-10-31'});
const sf = new AWS.StepFunctions({apiVersion: '2016-11-23'});
const sns = new AWS.SNS({apiVersion: '2010-03-31'});
const sts = new AWS.STS({apiVersion: '2011-06-15'});
const key_arn = process.env.TRANSIT_KEY_ARN;
const dr_acct = process.env.DR_ACCT;
const dr_topic_arn = process.env.DR_TOPIC_ARN;
const sm_copy_arn = process.env.SM_COPY_ARN;
const common = require('./common.js');
const DEBUG = process.env.DEBUG;

exports.handler = async (incoming, context) => {
  var output;
  var message;
  var status = 200;
  var rsp = {};

  try {
    if (DEBUG) console.debug(`Raw Event: ${JSON.stringify(incoming)}`);
    let evt = {};
    if ("Records" in incoming) {
      let record = incoming.Records[0];
      if (record.EventSource != "aws:sns") throw "Unhandled source: " + record.EventSource;
      switch (record.Sns.Subject) {
        case "RDS Notification Message": {
          if (record.Sns.Message.startsWith("This")) {
            evt.EventType = "rds-startup";
            evt.Message = record.Sns.Message;
            break;
          }
          message = JSON.parse(record.Sns.Message);
          let event_type = message["Event ID"].split('#',2)[1];
          if (!event_type.match(/[0-9]{4}$/)) throw "Unhandled event type: " + event_type;
          evt.EventType = event_type;
          evt.SourceId = message["Source ID"];
          let arnbits = record.Sns.TopicArn.split(':');
          evt.ArnPrefix = `arn:aws:rds:${arnbits[3]}:${arnbits[4]}`;
          break;
        }
        case "DRACO Event":
          evt = JSON.parse(record.Sns.Message);
          break;
        default:
          throw "Unhandled subject: " + record.Sns.Subject;
      }
    } else { /* the ec2 event */
      if(!("version" in incoming) || incoming.version != "0") throw 'Unrecognized input format!';
      evt = incoming;
      evt.EventType = incoming["source"] + "." + incoming.detail["event"];
      evt.SourceId = incoming.detail.snapshot_id;
    }
    // 'incoming' is now normalized into 'evt'
    if (DEBUG) console.debug(`DRACO Event: ${JSON.stringify(evt)}`);
    switch (evt.EventType) {
      // Ignore the 'creating' events...
      case 'RDS-EVENT-0040':
      case 'RDS-EVENT-0074':
      case 'RDS-EVENT-0090':
      case 'RDS-EVENT-0168':
        break;

      /*
       * Cannot copy tags on shared (or public) RDS snapshots or on EBS so store them in event
       */
      case 'RDS-EVENT-0091': // Automated Snapshot Created (with rds: prefix)
      case 'RDS-EVENT-0042': // Manual Snapshot Created
        evt.SnapshotType = 'RDS';
        [ evt.SourceName, evt.SourceKmsId] = await common.querySnapshotInfo("RDS", rds, evt.SourceId);
        evt.Encrypted = (evt.SourceKmsId !== undefined);
        evt.TransitId = evt.SourceName + '-dr';
        evt.SourceArn = `${evt.ArnPrefix}:snapshot:${evt.SourceId}`;
        rsp = await rds.listTagsForResource({"ResourceName": evt.SourceArn}).promise();
        evt.TagList = rsp.TagList;
        await requestCopy(evt);
        break;

      case 'RDS-EVENT-0169': // Automated Cluster Snapshot Created (with rds: prefix)
      case 'RDS-EVENT-0075': // Manual Cluster Snapshot Created
        evt.SnapshotType = 'RDS Cluster';
        [evt.SourceName, evt.SourceKmsId] = await common.querySnapshotInfo("RDS Cluster", rds, evt.SourceId);
        evt.Encrypted = (evt.SourceKmsId !== undefined);
        evt.TransitId = evt.SourceName + '-dr';
        evt.SourceArn = `${evt.ArnPrefix}:cluster-snapshot:${evt.SourceId}`;
        rsp = await rds.listTagsForResource({"ResourceName": evt.SourceArn}).promise();
        evt.TagList = rsp.TagList;
        await requestCopy(evt);
        break;


      case 'aws.ec2.createSnapshot': { // AWS backup or manual creation of a snapshot
        evt.SnapshotType = 'EBS';
        [evt.SourceName, evt.SourceKmsId] = await common.querySnapshotInfo("EBS", ec2, evt.SourceId);
        evt.Encrypted = (evt.SourceKmsId !== undefined);
        evt.SourceId = evt.detail.snapshot_id.split(':snapshot/')[1];
        evt.TagList = await common.getEC2SnapshotTags(ec2, evt.SourceId);
        evt.Region = evt.detail.snapshot_id.split(':')[4];
        evt.EndTime = evt.detail.endTime;
        await requestCopy(evt);
        break;
      }

      case 'snapshot-copy-initiate': { // Source -> Transit
        switch (evt.SnapshotType) {
          case 'RDS': {
            let p0 = {
              SourceDBSnapshotIdentifier: evt.SourceId,
              TargetDBSnapshotIdentifier: evt.TransitId,
              CopyTags: true,
              KmsKeyId: key_arn
            };
            rsp = await rds.copyDBSnapshot(p0).promise();
            evt.TransitArn = rsp.DBSnapshot.DBSnapshotArn;
            break;
          }
          case 'RDS Cluster': {
            let p0 = {
              SourceDBClusterSnapshotIdentifier: evt.SourceId,
              TargetDBClusterSnapshotIdentifier: evt.TransitId,
              CopyTags: true,
            };
            if (evt.Encrypted) {
              p0.KmsKeyId = key_arn
            }
            rsp = await rds.copyDBClusterSnapshot(p0).promise();
            evt.TransitArn = rsp.DBClusterSnapshot.DBClusterSnapshotArn;
            break;
          }
          case 'EBS': {
            var p0 = {
              Description: `Draco transient snapshot of ${evt.SourceName} at ${evt.endTime}`,
              DestinationRegion: evt.Region,
              SourceRegion: evt.Region,
              SourceSnapshotId: evt.SourceId,
              Encrypted: evt.Encrypted,
              KmsKeyId: key_arn
            };
            if (evt.TagList.length > 0) {
              let TagSpec = {
                ResourceType: "snapshot",
                Tags: evt.TagList
              };
              p0.TagSpecifications = [TagSpec];
            }
            rsp = await ec2.copySnapshot(p0).promise();
            evt.TransitId = rsp.SnapshotId;
            evt.TransitArn = `arn:aws:ec2::${evt.Region}:snapshot/${evt.TransitId}`;
            break;
          }
        }
        console.log(`Initiated ${evt.SnapshotType} Snapshot Copy from ${evt.SourceId} to ${evt.TransitId}`);

        evt.EventType = "snapshot-copy-completed";
        evt.ArnToCheck = evt.TransitArn;
        let p1 = {
          stateMachineArn: sm_copy_arn,
          name: context.awsRequestId,
          input: JSON.stringify({ "event": evt }),
        };
        output = await sf.startExecution(p1).promise();
        if (DEBUG) console.debug(`Started wait4copy: ${JSON.stringify(output)}`);
        break;
      }

      case 'snapshot-copy-completed': { // share Transit
        let p2 = { AttributeName: 'restore', ValuesToAdd: [ dr_acct ] };
        switch (evt.SnapshotType) {
          case 'RDS Cluster':
            p2.DBClusterSnapshotIdentifier = evt.TransitId;
            await rds.modifyDBClusterSnapshotAttribute(p2).promise();
            break;
          case 'RDS':
            p2.DBSnapshotIdentifier = evt.TransitId;
            await rds.modifyDBSnapshotAttribute(p2).promise();
            break;
          case 'EBS':
            p2 = {
              Attribute: 'createVolumePermission',
              OperationType: 'add',
              SnapshotId: evt.TransitArn.split(':snapshot/')[1],
              UserIds: [ dr_acct ]
            };
            await ec2.modifySnapshotAttribute(p2).promise();
            break;
          default:
            throw `Invalid Snapshot Type: ${evt.SnapshotType}`;
        }
        evt.EventType = "snapshot-copy-shared";
        let p3 = {
          TopicArn: dr_topic_arn,
          Subject: "DRACO Event",
          Message: JSON.stringify(evt)
        };
        output = await sns.publish(p3).promise();
        if (DEBUG) console.log(`Published: ${JSON.stringify(output)}`);
        console.log(`Shared ${evt.TransitArn} with ${dr_acct}`);
        break;
      }

      case 'snapshot-delete-shared': { // delete the previously shared copy
        switch (evt.SnapshotType) {
          case 'RDS Cluster':
            output = await rds.deleteDBClusterSnapshot({
              DBClusterSnapshotIdentifier: evt.TransitArn.split(':')[6]
            }).promise();
            break;
          case 'RDS':
            output = await rds.deleteDBSnapshot({
              DBSnapshotIdentifier: evt.TransitArn.split(':')[6]
            }).promise();
            break;
          case 'EBS':
            output = await ec2.deleteSnapshot({
              SnapshotId: evt.TransitArn.split(':snapshot/')[1]
            }).promise();
            break;
          default:
            throw "Invalid Snapshot Type"+evt.SnapshotType;
        }
        if (evt.Error) console.error(`In DR account ${dr_acct}: ${evt.Error}`);
        console.log(`Deleting ${evt.SnapshotType} Snapshot ${evt.TransitArn}`);
        break;
      }

      case 'snapshot-no-copy':
        console.warn(`${evt.SnapshotType} Snapshot ${evt.SourceId} not copied: ${evt.Reason}`);
        break;

      default:
        output = 'Unhandled event: ' + evt.EventType;
        console.warn(`Unhandled Event: ${JSON.stringify(evt)}`);
        break;
    }
    status = 200;
  } catch (e) {
    console.error(e);
    console.error(`Raw Event: ${JSON.stringify(incoming)}`);
    output = e;
    status = 500;
  }
  return { statusCode: status, body: JSON.stringify(output) };
};

/*
 * Send a snapshot-copy-request to the consumer
 */
async function requestCopy(evt) {
  evt.EventType = "snapshot-copy-request";
  let data = await sts.getCallerIdentity({}).promise();
  if (DEBUG) console.debug(`STS Caller Identity: ${JSON.stringify(data)}`);
  evt.SourceAcct = data.Account;
  let p3 = {
    TopicArn: dr_topic_arn,
    Subject: "DRACO Event",
    Message: JSON.stringify(evt)
  };
  let output = await sns.publish(p3).promise();
  console.info(`Published: ${JSON.stringify(evt)}`);
  if (DEBUG) console.debug(`Publish response: ${JSON.stringify(output)}`);
}
// vim: sts=2 et sw=2:
