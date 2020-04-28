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

// Returns the ISO week of the date.
Date.prototype.getWeek = function() {
  var date = new Date(this.getTime());
  date.setHours(0, 0, 0, 0);
  // Thursday in current week decides the year.
  date.setDate(date.getDate() + 3 - (date.getDay() + 6) % 7);
  // January 4 is always in week 1.
  var week1 = new Date(date.getFullYear(), 0, 4);
  // Adjust to Thursday in week 1 and count number of weeks from date to week1.
  return 1 + Math.round(((date.getTime() - week1.getTime()) / 86400000
                        - 3 + (week1.getDay() + 6) % 7) / 7);
};

// Returns the four-digit year corresponding to the ISO week of the date.
Date.prototype.getWeekYear = function() {
  var date = new Date(this.getTime());
  date.setDate(date.getDate() + 3 - (date.getDay() + 6) % 7);
  return date.getFullYear();
};

exports.handler = async (event) => {
  var target_id;
  var output = 'nothing';
  var status = 200;

  try {
    if (!("Records" in event)) throw 'No records!';
    let record = event.Records[0];
    if (record.EventSource != "aws:sns") throw "Cannot handle source: " + record.EventSource;
    if (record.Sns.Subject != "DRACO Event") throw "Invalid subject: " + record.Sns.Subject;
    let message = JSON.parse(record.Sns.Message);
    console.log("Incoming Event: " + JSON.stringify(message));

    let source_arn = message.SourceArn;
    let target_arn = message.TargetArn;
    // cannot copy tags on shared (or public) snapshots so use ones passed in message
    let taglist = message.TagList || [];
    taglist.push({ Key: tagkey, Value: tagval });
    switch (message.EventType) {
      case 'snapshot-copy-shared': // copy it
        target_id = source_arn.split(':')[6].slice(0,-3); // remove '-dr'
        var params = {
          SourceDBSnapshotIdentifier: source_arn,
          TargetDBSnapshotIdentifier: target_id,
          CopyTags: false,
          KmsKeyId: key_arn,
          Tags: taglist
        };
        output = await rds.copyDBSnapshot(params).promise();
        target_arn = output.DBSnapshot.DBSnapshotArn;
        console.log("Copy initiated: " + source_arn + " to "+target_arn);
        var sfinput = {
          "PollInterval": 60,
          "event": {
            "EventType": "snapshot-copy-completed",
            "SourceArn": target_arn,
            "TargetArn": source_arn,
            "TagList": taglist
          }
        };
        var sfparams = {
          stateMachineArn: state_machine_arn,
          name: "wait4snapshot_copy_" + target_id,
          input: JSON.stringify(sfinput),
        };
        output = await sf.startExecution(sfparams).promise();
        console.log("wait4copy: " + JSON.stringify(sfinput));
        break;

      case 'snapshot-copy-completed': // Tell the owning account to delete
        // Wait4Copy always uses SourceArn for the snapshot being created,
        // and the one being copied from is the target_arn
        //
        var snsevent = {
          "EventType": "snapshot-delete-shared",
          "SourceArn": target_arn
        };
        var p2 = {
          TopicArn: producer_topic_arn,
          Subject: "DRACO Event",
          Message: JSON.stringify(snsevent)
        };
        output = await sns.publish(p2).promise();
        console.log("Published: " + JSON.stringify(snsevent));
        try {
          await lifeCycle(source_arn);
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
    output = e;
    status = 500;
  }
  return { statusCode: status, body: JSON.stringify(output), };
};
/*
 * Retrieve a list of all the snapshots that Draco has taken, check the lifecycle policy and delete if necessary
 */
async function lifeCycle(snapshot_arn) {
  console.log("Performing Lifecycle Management: " + snapshot_arn);
  let instances = {};
  let rsp = {};

  // Collect all current snapshots and determine their age

  let params = {
    SnapshotType: 'manual',
  };

  const start = Date.now();

  do {
    rsp = await rds.describeDBSnapshots(params).promise();
    if ('Marker' in rsp) params.Marker = rsp.Marker;
    else delete params.Marker;

    for (const dbs of rsp.DBSnapshots) {
      if (dbs.Status != "available") continue;
      let instance_id = dbs.DBInstanceIdentifier;
      if (!(instance_id in instances)) {
        instances[instance_id] = new Array();
      }
      let snapshot_date = new Date(dbs.SnapshotCreateTime);

      let snapshot_age = (start - snapshot_date.valueOf()) / (24  * 3600 * 1000.0);
      instances[instance_id].push ({
        age:  snapshot_age,
        id:   dbs.DBSnapshotIdentifier,
        arn:  dbs.DBSnapshotArn,
        date: dbs.SnapshotCreateTime,
        day: snapshot_date.getDay(), // 0-Sun
        week: snapshot_date.getWeek(),
        month: snapshot_date.getMonth(),
        year: snapshot_date.getWeekYear()
      });
    }
  }
  while ('Marker' in params);

  // Now decide whether to retain or delete them, according to the rules

  for (const instance in instances) {
      const snapshots = instances[instance].sort((a,b) => a.age - b.age); // youngest first
      console.log("Instance: "+instance+", Snapshots: "+JSON.stringify(snapshots));
      // Get the Tags on the most recent Snapshot
      let youngest = snapshots[0];
      console.log("Youngest snapshot is: "+youngest.arn);
      rsp = await rds.listTagsForResource({"ResourceName": youngest.arn}).promise();
      let tags = {};
      for (let tag of rsp.TagList) {
        tags[tag.Key] = tag.Value;
      }
      const lifecycle = tags["Draco_Lifecycle"];
      console.log("Instance: "+instance+" has "+lifecycle+" lifecycle");
      switch (lifecycle) {
        // Keep one per day for a week, weekly for a month, monthly for a year
        case 'Standard': {
          const MAX_YEARS = 7;
          // -1 means not yet taken, undefined means stop taking
          let day = -1;
          let week = -1;
          let month = -1;
          let year = -1;
          let yearlies = 0;
          for (const s of snapshots) {
            if (day && s.day != day) {
              day = s.day;
              week = s.week;
              month = s.month;
              year = s.year;
              console.log("Retaining daily: "+s.id);
              continue;
            }
            if (week && s.week != week) {
              day = undefined; // no more dailies
              week = s.week;
              month = s.month;
              year = s.year;
              console.log("Retaining weekly: "+s.id);
              continue;
            }
            if (month && s.month != month) {
              week = undefined;
              month = s.month;
              year = s.year;
              console.log("Retaining monthly: "+s.id);
              continue;
            }
            if (s.year != year) {
              yearlies += 1;
              if (yearlies < MAX_YEARS) {
                month = undefined;
                year = s.year;
                console.log("Retaining yearly: "+s.id);
                continue;
              }
            }
            await deleteIt(s);
          }
          break;
        }
        case 'Test': { // Delete older than 5 days but always leave at least 3
          let old = snapshots.filter( s => s.age > 5 );
          if (snapshots.length - old.length >= 3) {
            for (var s of old) {
              await deleteIt(s);
            }
          }
          break;
        }
        default:
          console.log("Lifecycle '"+lifecycle+"' not supported for instance: " + instance);
      }
    }
  console.log("That's all folks");
}

async function deleteIt(snap) {
  let dry_run = (process.env.NO_DRY_RUN ? "": "(Dry Run) ");
  console.log(dry_run+"Deleting: "+snap.arn+" Y:"+snap.year+" M:"+snap.month+" W:"+snap.week+" D:"+snap.day);
  if (dry_run.length == 0) {
    await rds.deleteDBSnapshot({ DBSnapshotIdentifier: snap.id }).promise();
  }
}

// vim: sts=2 et sw=2:
