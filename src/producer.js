// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
//
const AWS = require('aws-sdk');
const ec2 = new AWS.EC2({apiVersion: '2016-11-15'});
const rds = new AWS.RDS({apiVersion: '2014-10-31'});
const sf = new AWS.StepFunctions({apiVersion: '2016-11-23'});
const sns = new AWS.SNS({apiVersion: '2010-03-31'});
const dr_acct = process.env.DR_ACCT;
const dr_topic_arn = process.env.DR_TOPIC_ARN;
const sm_copy_arn = process.env.SM_COPY_ARN;
const common = require('./common.js');

exports.handler = async (incoming, context) => {
  var output;
  var message;
  var status = 200;
  var rsp = {};

  try {
    if (process.env.DEBUG) console.debug(`Incoming Event: ${JSON.stringify(incoming)}`);
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
          evt.SourceId = evt.SourceArn.split(':')[6];
          break;
        default:
          throw "Unhandled subject: " + record.Sns.Subject;
      }
    } else {
      if(!("version" in incoming) || incoming.version != "0") throw 'Unrecognized input format!';
      evt = incoming;
      evt.EventType = incoming["source"] + "." + incoming.detail["event"];
      evt.SourceId = incoming.detail.snapshot_id;
    }
    // 'incoming' is now normalized into 'evt'
    if (process.env.DEBUG) console.debug(`Normalized Event: ${JSON.stringify(evt)}`);
    switch (evt.EventType) {
      case 'RDS-EVENT-0091': // Automated Snapshot Created (with rds: prefix)
      case 'RDS-EVENT-0042': // Manual Snapshot Created
        evt.SourceKmsId = await common.getSnapshotKmsId("RDS", rds, evt.SourceId);
        evt.Encrypted = (evt.SourceKmsId === undefined);
        evt.SourceName = (evt.EventType == 'RDS-EVENT-0091') ?  evt.SourceId.split(':')[1]: evt.SourceId;
        evt.TargetId = evt.SourceName + '-dr';
        evt.SourceArn = `${evt.ArnPrefix}:snapshot:${evt.SourceId}`;
        rsp = await rds.listTagsForResource({"ResourceName": evt.SourceArn}).promise();
        evt.TagList = rsp.TagList;
        requestCopy(evt);
        break;

      case 'RDS-EVENT-0169': // Automated Cluster Snapshot Created (with rds: prefix)
      case 'RDS-EVENT-0075': // Manual Cluster Snapshot Created
        evt.SourceKmsId = await common.getSnapshotKmsId("RDS Cluster", rds, evt.SourceId);
        evt.Encrypted = (evt.SourceKmsId === undefined);
        evt.SourceName = (evt.EventType == 'RDS-EVENT-0169') ?  evt.SourceId.split(':')[1]: evt.SourceId;
        evt.TargetId = evt.SourceName + '-dr';
        evt.SourceArn = `${evt.ArnPrefix}:cluster-snapshot:${evt.SourceId}`;
        rsp = await rds.listTagsForResource({"ResourceName": evt.SourceArn}).promise();
        evt.TagList = rsp.TagList;
        requestCopy(evt);
        break;


      case 'aws.ec2.createSnapshot': { // AWS backup or manual creation of a snapshot
        evt.SourceKmsId = await common.getSnapshotKmsId("EBS", ec2, evt.SourceId);
        evt.Encrypted = (evt.SourceKmsId === undefined);
        evt.SnapshotType = 'EBS';
        evt.SourceId = evt.detail.snapshot_id.split(':snapshot/')[1];
        evt.TagList = await common.getEC2SnapshotTags(ec2, evt.SourceId);
        evt.SourceName = evt.detail.source;
        evt.Region = evt.detail.snapshot_id.split(':')[4];
        evt.EndTime = evt.detail.endTime;
        requestCopy(evt);
        break;
      }

      case 'snapshot-copy-initiate': { // Consumer says to copy the snapshot...
        console.debug(`snapshot-copy-initiate: ${JSON.stringify(evt)}`);
        switch (evt.SnapshotType) {
          case 'RDS': {
            let p0 = {
              SourceDBSnapshotIdentifier: evt.SourceId,
              TargetDBSnapshotIdentifier: evt.TargetId,
              CopyTags: true,
              KmsKeyId: evt.TargetKmsId
            };
            rsp = await rds.copyDBSnapshot(p0).promise();
            evt.TargetArn = rsp.DBSnapshot.DBSnapshotArn;
            break;
          }
          case 'RDS Cluster': {
            let p0 = {
              SourceDBClusterSnapshotIdentifier: evt.SourceId,
              TargetDBClusterSnapshotIdentifier: evt.TargetId,
              CopyTags: true,
            };
            if (evt.Encrypted) {
              p0.KmsKeyId = evt.TargetKmsId;
            }
            rsp = await rds.copyDBClusterSnapshot(p0).promise();
            evt.TargetArn = rsp.DBClusterSnapshot.DBClusterSnapshotArn;
            break;
          }
          case 'EBS': {
            var p0 = {
              Description: `Draco transient snapshot of ${evt.SourceName} at ${evt.endTime}`,
              DestinationRegion: evt.Region,
              SourceRegion: evt.Region,
              SourceSnapshotId: evt.SourceId,
              Encrypted: evt.Encrypted,
              KmsKeyId: evt.TargetKmsId,
            };
            if (evt.TagList.length > 0) {
              let TagSpec = {
                ResourceType: "snapshot",
                Tags: evt.TagList
              };
              p0.TagSpecifications = [TagSpec];
            }
            rsp = await ec2.copySnapshot(p0).promise();
            evt.TargetId = rsp.SnapshotId;
            evt.TargetArn = `arn:aws:ec2::${evt.Region}:snapshot/${evt.TargetId}`;
            break;
          }
        }
        console.log(`Initiated ${evt.SnapshotType} Snapshot Copy from ${evt.SourceId} to ${evt.TargetId}`);

        let sfinput = {
          "event": {
            "EventType": "snapshot-copy-completed",
            "SnapshotType": evt.SnapshotType,
            "SourceArn": evt.TargetArn,
            "SourceName": evt.SourceName,
            "Encrypted": evt.Encrypted
          }
        };
        let p1 = {
          stateMachineArn: sm_copy_arn,
          name: context.awsRequestId,
          input: JSON.stringify(sfinput),
        };
        output = await sf.startExecution(p1).promise();
        console.log(`Started wait4copy: ${JSON.stringify(sfinput)}`);
        break;
      }

      case 'snapshot-copy-completed': { // share a previously created copy
        console.debug(`snapshot-copy-completed: ${JSON.stringify(evt)}`);
        let p2 = {
          AttributeName: 'restore',
          ValuesToAdd: [ dr_acct ]
        };
        let taglist = [];
        switch (evt.SnapshotType) {
          case 'RDS Cluster':
            p2.DBClusterSnapshotIdentifier = evt.SourceId;
            await rds.modifyDBClusterSnapshotAttribute(p2).promise();
            rsp = await rds.listTagsForResource({"ResourceName": evt.SourceArn}).promise();
            taglist = rsp.TagList;
            break;
          case 'RDS':
            p2.DBSnapshotIdentifier = evt.SourceId;
            await rds.modifyDBSnapshotAttribute(p2).promise();
            rsp = await rds.listTagsForResource({"ResourceName": evt.SourceArn}).promise();
            taglist = rsp.TagList;
            break;
          case 'EBS':
            p2 = {
              Attribute: 'createVolumePermission',
              OperationType: 'add',
              SnapshotId: evt.SourceArn.split(':snapshot/')[1],
              UserIds: [ dr_acct ]
            };
            await ec2.modifySnapshotAttribute(p2).promise();
            taglist = await common.getEC2SnapshotTags(ec2, p2.SnapshotId);
            break;
          default:
            throw `Invalid Snapshot Type: ${evt.SnapshotType}`;
        }
        console.log(`Shared ${evt.SourceArn} with ${dr_acct}`);
        var snsevent = {
          "EventType": "snapshot-copy-shared",
          "SourceArn": evt.SourceArn,
          "SnapshotType": evt.SnapshotType,
          "Encrypted": evt.Encrypted,
          "SourceName": evt.SourceName,
          "TagList": taglist
        };
        let p3 = {
          TopicArn: dr_topic_arn,
          Subject: "DRACO Event",
          Message: JSON.stringify(snsevent)
        };
        output = await sns.publish(p3).promise();
        console.log(`Published: ${JSON.stringify(snsevent)}`);
        break;
      }

      case 'snapshot-delete-shared': { // delete the previously shared copy
        console.debug(`snapshot-delete-shared: ${JSON.stringify(evt)}`);
        switch (evt.SnapshotType) {
          case 'RDS Cluster':
            output = await rds.deleteDBClusterSnapshot({
              DBClusterSnapshotIdentifier: evt.SourceArn.split(':')[6]
            }).promise();
            break;
          case 'RDS':
            output = await rds.deleteDBSnapshot({
              DBSnapshotIdentifier: evt.SourceArn.split(':')[6]
            }).promise();
            break;
          case 'EBS':
            output = await ec2.deleteSnapshot({
              SnapshotId: evt.SourceArn.split(':snapshot/')[1]
            }).promise();
            break;
          default:
            throw "Invalid Snapshot Type"+evt.SnapshotType;
        }
        if (evt.Error) console.error(`In DR account ${dr_acct}: ${evt.Error}`);
        console.log(`Deleting ${evt.SnapshotType} Snapshot ${evt.SourceArn}`);
        break;
      }


      default:
        output = 'Unhandled event: ' + evt.EventType;
        console.log(`Unhandled Event: ${JSON.stringify(evt)}`);
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
  let p3 = {
    TopicArn: dr_topic_arn,
    Subject: "DRACO Event",
    Message: JSON.stringify(evt)
  };
  let output = await sns.publish(p3).promise();
  console.info(`Published: ${JSON.stringify(evt)}`);
  console.debug(`Publish response: ${JSON.stringify(output)}`);
}
// vim: sts=2 et sw=2:
