// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
//
// This function will be invoked from a step function and passed:
// * The Arn of a Snapshot to check
// * The type of snapshot (Cluster will be true)
// * An iterator object for use in the step function
const AWS = require('aws-sdk');
const rds = new AWS.RDS({apiVersion: '2014-10-31'});

exports.handler = async (event) => {
  console.debug("Raw Event: "+JSON.stringify(event));
  let snapshot_arn = event.SourceArn;
  let count = event.iterator.count + 1;
  let exhausted = (count == event.iterator.maxcount);
  try {
    if (!snapshot_arn) throw "SourceArn not provided";
    let rsp = event.Cluster ?
      await rds.describeDBClusterSnapshots({DBClusterSnapshotIdentifier: snapshot_arn}).promise():
      await rds.describeDBSnapshots({DBSnapshotIdentifier: snapshot_arn}).promise();
    let info = event.Cluster ? rsp.DBClusterSnapshots[0]: rsp.DBSnapshots[0];
    console.log("snapshot "+snapshot_arn+" status: " + info.Status);
    var status = 200;
    var output = {
      "iterator": {
        "count": count,
        "maxcount": event.iterator.maxcount,
        "exhausted": exhausted
      },
      "status": info.Status,
      "info": info
    };
  } catch (e) {
    let notfound = event.Cluster? "DBClusterSnapshotNotFound": "DBSnapshotNotFound";
    status = (e.name == notfound) ? 404: 500;
    console.log("status: "+status);
    console.error(e);
    output = {"status": null, "error": e};
  }
  return { statusCode: status, body: output };
};
// vim: sts=2 et sw=2:
