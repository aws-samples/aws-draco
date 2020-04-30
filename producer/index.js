// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
//
const AWS = require('aws-sdk');
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
    if (!("Records" in incoming)) throw 'No records!';
    let record = incoming.Records[0];
    if (record.EventSource != "aws:sns") throw "Unhandled source: " + record.EventSource;
    let evt = {};
    var event_type;
    switch (record.Sns.Subject) {
      case "RDS Notification Message":
        if (record.Sns.Message.startsWith("This")) {
          evt.EventType = "rds-startup";
          evt.Message = record.Sns.Message;
          break;
        }
        message = JSON.parse(record.Sns.Message);
        event_type = message["Event ID"].split('#',2)[1];
        if (!event_type.match(/[0-9]{4}$/)) throw "Unhandled event type: " + event_type;
        evt.EventType = event_type;
        evt.SourceId = message["Source ID"];
        break;
      case "DRACO Event":
        message = JSON.parse(record.Sns.Message);
        evt.EventType = message["EventType"];
        evt.SnapshotType   = message["SnapshotType"];
        evt.SourceArn = message["SourceArn"];
        evt.SourceId = evt.SourceArn.split(':')[6];
        break;
      default:
        throw "Unhandled subject: " + record.Sns.Subject;
    }
    if (process.env.DEBUG) console.log(`Incoming Event: ${JSON.stringify(evt)}`);
    switch (evt.EventType) {
      case 'RDS-EVENT-0091': // Automated Snapshot Created (with rds: prefix)
      case 'RDS-EVENT-0042': { // Manual Snapshot Created
        let target_id = ((evt.EventType == 'RDS-EVENT-0091')?  evt.SourceId.split(':')[1]: evt.SourceId) + '-dr';
        console.log(`Copying ${evt.SourceId} to ${target_id}`);
        let p0 = {
          SourceDBSnapshotIdentifier: evt.SourceId,
          TargetDBSnapshotIdentifier: target_id,
          CopyTags: true,
          KmsKeyId: key_arn
        };
        rsp = await rds.copyDBSnapshot(p0).promise();
        let target_arn = rsp.DBSnapshot.DBSnapshotArn;
        let sfinput = {
          "PollInterval": 60,
          "event": {
            "EventType": "snapshot-copy-completed",
            "SnapshotType": "RDS",
            "SourceArn": target_arn
          }
        };
        let p1 = {
          stateMachineArn: sm_copy_arn,
          name: "wait4snapshot_copy_" + target_id,
          input: JSON.stringify(sfinput),
        };
        output = await sf.startExecution(p1).promise();
        console.log(`wait4copy: ${JSON.stringify(sfinput)}`);
        break;
      }

      case 'RDS-EVENT-0169': // Automated Cluster Snapshot Created (with rds: prefix)
      case 'RDS-EVENT-0075': { // Manual Cluster Snapshot Created
        let target_id = ((evt.EventType == 'RDS-EVENT-0169')?  evt.SourceId.split(':')[1]: evt.SourceId) + '-dr';
        console.log(`Copying RDS Cluster ${evt.SourceId} to ${target_id}`);
        let p0 = {
          SourceDBClusterSnapshotIdentifier: evt.SourceId,
          TargetDBClusterSnapshotIdentifier: target_id,
          CopyTags: true,
          KmsKeyId: key_arn
        };
        rsp = await rds.copyDBClusterSnapshot(p0).promise();
        let target_arn = rsp.DBClusterSnapshot.DBClusterSnapshotArn;
        let sfinput = {
          "PollInterval": 60,
          "event": {
            "EventType": "snapshot-copy-completed",
            "SnapshotType": "RDS Cluster",
            "SourceArn": target_arn
          }
        };
        let p1 = {
          stateMachineArn: sm_copy_arn,
          name: "wait4snapshot_copy_" + target_id,
          input: JSON.stringify(sfinput),
        };
        output = await sf.startExecution(p1).promise();
        console.log(`wait4copy: ${JSON.stringify(sfinput)}`);
        break;
      }

      case 'snapshot-copy-completed': { // share a previously created copy
        let p2 = {
          AttributeName: 'restore',
          ValuesToAdd: [ dr_acct ]
        };
        switch (evt.SnapshotType) {
          case 'RDS Cluster':
            p2.DBClusterSnapshotIdentifier = evt.SourceId;
            await rds.modifyDBClusterSnapshotAttribute(p2).promise();
            break;
          case 'RDS':
            p2.DBSnapshotIdentifier = evt.SourceId;
            await rds.modifyDBSnapshotAttribute(p2).promise();
            break;
          default:
            throw "Invalid Snapshot Type"+evt.SnapshotType;
        }
        console.log(`Shared ${evt.SourceId} with ${dr_acct}`);
        rsp = await rds.listTagsForResource({"ResourceName": evt.SourceArn}).promise();
        var snsevent = {
          "EventType": "snapshot-copy-shared",
          "SourceArn": evt.SourceArn,
          "SnapshotType": evt.SnapshotType,
          "TagList": rsp.TagList
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
            output = await rds.deleteDBClusterSnapshot({ DBClusterSnapshotIdentifier: evt.SourceId }).promise();
            break;
          case 'RDS':
            output = await rds.deleteDBSnapshot({ DBSnapshotIdentifier: evt.SourceId }).promise();
            break;
          default:
            throw "Invalid Snapshot Type"+evt.SnapshotType;
        }
        console.log(`Deleting ${evt.SnapshotType} Snapshot ${evt.SourceArn}`);
        break;
      }

      default:
        output = 'Unhandled event: ' + event_type;
        break;
    }
    status = 200;
  } catch (e) {
    console.error(e);
    console.log(`Raw Event: ${JSON.stringify(incoming)}`);
    output = e;
    status = 500;
  }
  return { statusCode: status, body: JSON.stringify(output) };
};
// vim: sts=2 et sw=2:
