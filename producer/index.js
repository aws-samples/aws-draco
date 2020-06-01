// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
//
const AWS = require('aws-sdk');
const ec2 = new AWS.EC2({apiVersion: '2016-11-15'});
const rds = new AWS.RDS({apiVersion: '2014-10-31'});
const sf = new AWS.StepFunctions({apiVersion: '2016-11-23'});
const sns = new AWS.SNS({apiVersion: '2010-03-31'});
const key_arn = process.env.KEY_ARN;
const dr_acct = process.env.DR_ACCT;
const dr_topic_arn = process.env.DR_TOPIC_ARN;
const sm_copy_arn = process.env.SM_COPY_ARN;

exports.handler = async (incoming) => {
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
      case 'RDS-EVENT-0042': { // Manual Snapshot Created
        let target_id = ((evt.EventType == 'RDS-EVENT-0091')?  evt.SourceId.split(':')[1]: evt.SourceId) + '-dr';
        console.log(`Copying RDS Snapshot ${evt.SourceId} to ${target_id}`);
        let p0 = {
          SourceDBSnapshotIdentifier: evt.SourceId,
          TargetDBSnapshotIdentifier: target_id,
          CopyTags: true,
          KmsKeyId: key_arn
        };
        rsp = await rds.copyDBSnapshot(p0).promise();
        let target_arn = rsp.DBSnapshot.DBSnapshotArn;
        let sfinput = {
          "event": {
            "EventType": "snapshot-copy-completed",
            "SnapshotType": "RDS",
            "SourceArn": target_arn,
            "Encrypted": ('KmsKeyId' in p0)
          }
        };
        let p1 = {
          stateMachineArn: sm_copy_arn,
          name: "wait4snapshot_copy_" + target_id,
          input: JSON.stringify(sfinput),
        };
        output = await sf.startExecution(p1).promise();
        console.log(`Started wait4copy: ${JSON.stringify(sfinput)}`);
        break;
      }

      case 'RDS-EVENT-0169': // Automated Cluster Snapshot Created (with rds: prefix)
      case 'RDS-EVENT-0075': { // Manual Cluster Snapshot Created
        let target_id = ((evt.EventType == 'RDS-EVENT-0169')?  evt.SourceId.split(':')[1]: evt.SourceId) + '-dr';
        console.log(`Copying RDS Cluster Snapshot ${evt.SourceId} to ${target_id}`);
        let p0 = {
          SourceDBClusterSnapshotIdentifier: evt.SourceId,
          TargetDBClusterSnapshotIdentifier: target_id,
          CopyTags: true,
          KmsKeyId: key_arn
        };
        try {
          rsp = await rds.copyDBClusterSnapshot(p0).promise();
        } catch (e) {
          if (e.name == 'InvalidParameterValue') {
            console.log(`Copy error: ${e.message}, retrying...`);
            delete p0.KmsKeyId;
            rsp = await rds.copyDBClusterSnapshot(p0).promise();
          } else throw e;
        }
        let target_arn = rsp.DBClusterSnapshot.DBClusterSnapshotArn;
        let sfinput = {
          "event": {
            "EventType": "snapshot-copy-completed",
            "SnapshotType": "RDS Cluster",
            "SourceArn": target_arn,
            "Encrypted": ('KmsKeyId' in p0)
          }
        };
        let p1 = {
          stateMachineArn: sm_copy_arn,
          name: "wait4snapshot_copy_" + target_id,
          input: JSON.stringify(sfinput),
        };
        output = await sf.startExecution(p1).promise();
        console.log(`Started wait4copy: ${JSON.stringify(sfinput)}`);
        break;
      }

      case 'aws.ec2.createSnapshot': { // AWS backup or manual creation of a snapshot
        evt.SnapshotType = 'EBS';
        let source_id = evt.detail.snapshot_id.split(':snapshot/')[1];
        let taglist = await getEC2SnapshotTags(source_id);
        let region = evt.detail.snapshot_id.split(':')[4];
        var p0 = {
          Description: `Draco transient snapshot of ${evt.detail.source} at ${evt.detail.endTime}`,
          DestinationRegion: region,
          SourceRegion: region,
          SourceSnapshotId: source_id,
          Encrypted: true,
          KmsKeyId: key_arn,
        };
        if (taglist.length > 0) {
          let TagSpec = {
            ResourceType: "snapshot",
            Tags: taglist
          };
          p0.TagSpecifications = [TagSpec];
        }
        rsp = await ec2.copySnapshot(p0).promise();
        console.log(`Copying ${evt.SnapshotType} Snapshot ${source_id} to ${rsp.SnapshotId}`);

        let sfinput = {
          "event": {
            "EventType": "snapshot-copy-completed",
            "SnapshotType": "EBS",
            "SourceArn": `arn:aws:ec2::${region}:snapshot/${rsp.SnapshotId}`,
            "Encrypted": ('KmsKeyId' in p0),
            "SourceVol": evt.detail.source
          }
        };
        let p1 = {
          stateMachineArn: sm_copy_arn,
          name: "wait4snapshot_copy_" + source_id,
          input: JSON.stringify(sfinput),
        };
        output = await sf.startExecution(p1).promise();
        console.log(`Started wait4copy: ${JSON.stringify(sfinput)}`);
        break;
      }

      case 'snapshot-copy-completed': { // share a previously created copy
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
            taglist = await getEC2SnapshotTags(p2.SnapshotId);
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
          "SourceVol": evt.SourceVol,
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

/* EC2 Snapshot Tags have extra baggage
 */
async function getEC2SnapshotTags(snap_id) {
  let p = {
    Filters: [ { Name: "resource-id", Values: [ snap_id ] } ],
    MaxResults: 500
  }
  let rsp = await ec2.describeTags(p).promise();
  let taglist = rsp.Tags.filter(t => !t.Key.startsWith('aws:')).map(e => ({ Key: e.Key, Value: e.Value } ))
  if (process.env.DEBUG) console.debug(`Tags for ${snap_id}: ${JSON.stringify(taglist)}`);
  return taglist;
}

// vim: sts=2 et sw=2:
