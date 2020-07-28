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
const tagkey = process.env.TAG_KEY;
const tagval = process.env.TAG_VALUE;
const producer_topic_arn = process.env.PRODUCER_TOPIC_ARN;
const state_machine_arn = process.env.STATE_MACHINE_ARN;
const retention = require('./retention.js');
const common = require('./common.js');

exports.handler = async (incoming, context) => {
  var output = 'nothing';
  var status = 200;

  try {
    if (process.env.DEBUG) console.debug(`Incoming Event: ${JSON.stringify(incoming)}`);
    if (!("Records" in incoming)) throw 'No records!';
    let record = incoming.Records[0];
    if (record.EventSource != "aws:sns") throw "Cannot handle source: " + record.EventSource;
    if (record.Sns.Subject != "DRACO Event") throw "Invalid subject: " + record.Sns.Subject;
    let evt = JSON.parse(record.Sns.Message);
    if (process.env.DEBUG) console.debug(`Normalized Event: ${JSON.stringify(evt)}`);

    // cannot copy tags on shared (or public) RDS snapshots or on EBS so use ones passed in message
    let taglist = evt.TagList || [];
    taglist.push({ Key: tagkey, Value: tagval });
    let target_arn, target_id;
    let copyfailed = undefined;

    switch (evt.EventType) {
      case 'snapshot-copy-shared': { // copy it
        let params = { };
        let enc;
        if (evt.Encrypted) {
          params.KmsKeyId = key_arn;
          enc = "Encrypted";
        } else {
          enc = "Plaintext";
        }
        try {
          switch (evt.SnapshotType) {
            case 'RDS Cluster':
            case 'RDS':
              params.CopyTags = false;
              params.Tags  = taglist;
              target_id = evt.SourceArn.split(':')[6].slice(0,-3); // remove '-dr'
              if (evt.SnapshotType == 'RDS') {
                params.SourceDBSnapshotIdentifier = evt.SourceArn;
                params.TargetDBSnapshotIdentifier = target_id;
                output = await rds.copyDBSnapshot(params).promise();
                target_arn = output.DBSnapshot.DBSnapshotArn;
              }
              else {
                params.SourceDBClusterSnapshotIdentifier = evt.SourceArn;
                params.TargetDBClusterSnapshotIdentifier = target_id;
                output = await rds.copyDBClusterSnapshot(params).promise();
                target_arn = output.DBClusterSnapshot.DBClusterSnapshotArn;
              }
              break;
            case 'EBS':
              params.SourceSnapshotId = evt.SourceArn.split(':snapshot/')[1];
              params.Description  = `Draco snapshot of ${evt.SourceVol}`;
              params.SourceRegion = evt.SourceArn.split(':')[4];
              params.DestinationRegion = params.SourceRegion;
              params.Encrypted = ('KmsKeyId' in params);
              if (taglist.length > 0) {
                let TagSpec = {
                  ResourceType: "snapshot",
                  Tags: taglist
                };
                params.TagSpecifications = [TagSpec];
              }
              output = await ec2.copySnapshot(params).promise();
              target_id = output.SnapshotId;
              target_arn = `arn:aws:ec2::${params.DestinationRegion}:snapshot/${target_id}`;
              break;
            default:
              throw "Invalid Snapshot Type"+evt.SnapshotType;
          }
          console.log(`Copying ${enc} ${evt.SnapshotType} Snapshot ${evt.SourceArn} to ${target_id}`);
          let sfinput = {
            "event": {
              "EventType": "snapshot-copy-completed",
              "SnapshotType": evt.SnapshotType,
              "Encrypted": evt.Encrypted,
              "SourceArn": target_arn,
              "TargetArn": evt.SourceArn,
              "TagList": taglist
            }
          };
          let sfparams = {
            stateMachineArn: state_machine_arn,
            name: context.awsRequestId,
            input: JSON.stringify(sfinput),
          };
          output = await sf.startExecution(sfparams).promise();
          console.log(`Starting wait4copy: ${JSON.stringify(sfinput)}`);
          break;
          } catch (e) {
            copyfailed = `Copy failed (${e.name}: ${e.message})`;
            console.error(`${copyfailed}, removing source...`);
            // Fall through the case to the next one
          }
      }
      // Tell the owning account to delete
      case 'snapshot-copy-completed': // eslint-disable-line no-fallthrough
        // Wait4Copy always uses SourceArn for the snapshot being created,
        // and the one being copied from is the target_arn
        //
        var snsevent = {
          "EventType": "snapshot-delete-shared",
          "SnapshotType": evt.SnapshotType,
          "SourceArn": evt.TargetArn,
          "Error": copyfailed
        };
        var p2 = {
          TopicArn: producer_topic_arn,
          Subject: "DRACO Event",
          Message: JSON.stringify(snsevent)
        };
        output = await sns.publish(p2).promise();
        console.log(`Published: ${JSON.stringify(snsevent)}`);
        try {
          await lifeCycle(evt.SnapshotType);
        } catch (e) {
          console.error(e);
        }
        break;
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
 * Retrieve a list of all the snapshots of this type that Draco has taken,
 * check the lifecycle policy and delete if necessary.
 */
async function lifeCycle(snapshot_type) {
  console.log(`Performing Lifecycle Management for: ${snapshot_type}`);
  let rsp = {};
  let snapshots = {};
  let sources = {};

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
        params.OwnerIds = [ dr_acct ];
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
        case 'EBS':
          taglist = await common.getEC2SnapshotTags(ec2, youngest.id);
          break;
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
      let dry_run = (process.env.NO_DRY_RUN ? "": "(Dry Run) ");
      let deletions = (await retention.implementPolicy(snapshots, lifecycle)).filter(f => f.retain == false);
      for (const snap of deletions) {
        console.log(`${dry_run}Deleting: ${snap.id}`);
        if (dry_run.length == 0) {
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
  console.log("That's all folks");
}

// vim: sts=2 et sw=2:
