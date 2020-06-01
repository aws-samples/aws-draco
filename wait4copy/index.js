// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
//
// This function will be invoked from a step function and passed:
// * The Arn of a Snapshot to check
// * The type of snapshot (Cluster will be true)
// * An iterator object for use in the step function
const AWS = require('aws-sdk');
const rds = new AWS.RDS({apiVersion: '2014-10-31'});
const ec2 = new AWS.EC2({apiVersion: '2016-11-15'});

exports.handler = async (incoming) => {
  if (process.env.DEBUG) console.debug("Raw Event: "+JSON.stringify(incoming));
  let count = incoming.iterator.count + 1;
  let exhausted = (count == incoming.iterator.maxcount);
  try {
    var info, rsp, notfound;
    switch (incoming.SnapshotType) {
      case 'RDS Cluster':
        notfound = "DBClusterSnapshotNotFound";
        rsp = await rds.describeDBClusterSnapshots({DBClusterSnapshotIdentifier: incoming.SourceArn}).promise();
        info = rsp.DBClusterSnapshots[0];
        break;
      case 'RDS':
        notfound = "DBSnapshotNotFound";
        rsp = await rds.describeDBSnapshots({DBSnapshotIdentifier: incoming.SourceArn}).promise();
        info = rsp.DBSnapshots[0];
        break;
      case 'EBS':
        notfound = "SnapshotNotFound";
        rsp = await ec2.describeSnapshots({SnapshotIds: [ incoming.SourceArn.split(':snapshot/')[1] ] }).promise();
        info = rsp.Snapshots[0];
        info.Status = (info.State == "completed") ? "available" : info.Progress;
        break;
      default:
        throw `Invalid Snapshot Type '${incoming.SnapshotType}'`;
    }
    console.log(`${info.Status}: ${incoming.SourceArn}`);
    if (process.env.DEBUG) console.debug("Info: "+JSON.stringify(info));
    var status = 200;
    var output = {
      "iterator": {
        "count": count,
        "maxcount": incoming.iterator.maxcount,
        "exhausted": exhausted
      },
      "status": info.Status,
      "info": info
    };
  } catch (e) {
    status = (e.name == notfound) ? 404: 500;
    console.error("status: "+status);
    console.error(e);
    output = {"status": null, "error": e};
  }
  return { statusCode: status, body: output };
};
// vim: sts=2 et sw=2:
