// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
//
const AWS = require('aws-sdk');
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

exports.handler = async (incoming) => {
  var target_id;
  var output = 'nothing';
  var status = 200;

  try {
    if (process.env.DEBUG) console.log(`Incoming Event: ${JSON.stringify(incoming)}`);
    if (!("Records" in incoming)) throw 'No records!';
    let record = incoming.Records[0];
    if (record.EventSource != "aws:sns") throw "Cannot handle source: " + record.EventSource;
    if (record.Sns.Subject != "DRACO Event") throw "Invalid subject: " + record.Sns.Subject;
    let evt = JSON.parse(record.Sns.Message);

    let source_arn = evt.SourceArn;
    let target_arn = evt.TargetArn;
    // cannot copy tags on shared (or public) snapshots so use ones passed in message
    let taglist = evt.TagList || [];
    taglist.push({ Key: tagkey, Value: tagval });
    switch (evt.EventType) {
      case 'snapshot-copy-shared': { // copy it
        target_id = source_arn.split(':')[6].slice(0,-3); // remove '-dr'
        let params = { CopyTags: false, Tags: taglist };
        let enc;
        if (evt.Encrypted) {
          params.KmsKeyId = key_arn;
          enc = "Encrypted";
        } else {
          enc = "Plaintext";
        }
        console.log(`Copying ${enc} ${evt.SnapshotType} Snapshot ${source_arn} to ${target_id}`);
        try {
          switch (evt.SnapshotType) {
            case 'RDS Cluster':
              params.SourceDBClusterSnapshotIdentifier = source_arn;
              params.TargetDBClusterSnapshotIdentifier = target_id;
              output = await rds.copyDBClusterSnapshot(params).promise();
              target_arn = output.DBClusterSnapshot.DBClusterSnapshotArn;
              break;
            case 'RDS':
              params.SourceDBSnapshotIdentifier = source_arn;
              params.TargetDBSnapshotIdentifier = target_id;
              output = await rds.copyDBSnapshot(params).promise();
              target_arn = output.DBSnapshot.DBSnapshotArn;
              break;
            default:
              throw "Invalid Snapshot Type"+evt.SnapshotType;
          }
          let sfinput = {
            "event": {
              "EventType": "snapshot-copy-completed",
              "SnapshotType": evt.SnapshotType,
              "Encrypted": evt.Encrypted,
              "SourceArn": target_arn,
              "TargetArn": source_arn,
              "TagList": taglist
            }
          };
          let sfparams = {
            stateMachineArn: state_machine_arn,
            name: "wait4snapshot_copy_" + target_id,
            input: JSON.stringify(sfinput),
          };
          output = await sf.startExecution(sfparams).promise();
          console.log(`Starting wait4copy: ${JSON.stringify(sfinput)}`);
          break;
          } catch (e) {
            console.log(`FATAL: Copy failed (${e.name}: ${e.message}), removing source...`);
            target_arn = source_arn;
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
          "SourceArn": target_arn
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
    console.log(`Raw Event: ${JSON.stringify(incoming)}`);
    console.error(e);
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

  let params = {
    SnapshotType: 'manual',
  };

  do {
    switch (snapshot_type) {
      case 'RDS Cluster':
        rsp = await rds.describeDBClusterSnapshots(params).promise();
        snapshots = rsp.DBClusterSnapshots;
        break;
      case 'RDS':
        rsp = await rds.describeDBSnapshots(params).promise();
        snapshots = rsp.DBSnapshots;
        break;
      default:
        throw "Invalid Snapshot Type: "+snapshot_type;
    }
    if ('Marker' in rsp) params.Marker = rsp.Marker;
    else delete params.Marker;

    for (const snapshot of snapshots) {
      if (snapshot.Status != "available") continue;

      var source_id, snapshot_id, snapshot_arn;
      switch(snapshot_type) {
        case 'RDS Cluster':
          source_id = snapshot.DBClusterIdentifier;
          snapshot_id = snapshot.DBClusterSnapshotIdentifier;
          snapshot_arn = snapshot.DBClusterSnapshotArn;
          break;
        case 'RDS':
          source_id = snapshot.DBInstanceIdentifier;
          snapshot_id = snapshot.DBSnapshotIdentifier;
          snapshot_arn = snapshot.DBSnapshotArn;
          break;
        default:
          throw "Invalid Snapshot Type: "+snapshot_type;
      }
      if (!(source_id in sources)) {
        sources[source_id] = new Array();
      }
      let snapshot_date = new Date(snapshot.SnapshotCreateTime);
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
      rsp = await rds.listTagsForResource({"ResourceName": youngest.arn}).promise();
      let tags = {};
      for (let tag of rsp.TagList) {
        tags[tag.Key] = tag.Value;
      }
      const lifecycle = tags["Draco_Lifecycle"];
      console.log(`Source: ${source} has lifecycle '${lifecycle}' with ${snapshots.length} snapshots. Youngest: ${JSON.stringify(youngest)}`);
      let dry_run = (process.env.NO_DRY_RUN ? "": "(Dry Run) ");
      let deletions = (await retention.Policy(snapshots, lifecycle)).filter(f => f.retain == false);
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
              default:
                throw "Invalid Snapshot Type: "+snapshot_type;
            }
        }
      }
    }
  console.log("That's all folks");
}

// vim: sts=2 et sw=2:
