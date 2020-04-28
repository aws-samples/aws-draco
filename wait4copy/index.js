// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
//
// This function will be invoked from a step function and passed:
// * The Arn of a Snapshot to check
// * An iterator object for use in the step function
const AWS = require('aws-sdk');
const rds = new AWS.RDS({apiVersion: '2014-10-31'});

exports.handler = async (event) => {
  console.debug("Raw Event: "+JSON.stringify(event));
  let snapshot_arn = event.SourceArn;
  let count = event.iterator.count + 1;
  let exhausted = (count == event.iterator.maxcount);
  console.log("Checking snapshot "+snapshot_arn);
  try {
    if (!snapshot_arn) throw "SourceArn not provided";
    var params = {
      DBSnapshotIdentifier: snapshot_arn, // works even though it's an ARN not an Id
    }
    var rsp = await rds.describeDBSnapshots(params).promise();
    console.log("rsp: " + JSON.stringify(rsp));
    let info = rsp.DBSnapshots[0];
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
    status = (e.name == "DBSnapshotNotFound") ? 404: 500;
    console.log("status: "+status);
    console.error(e);
    output = {"status": null, "error": e};
  }
  return { statusCode: status, body: output };
};
// vim: sts=2 et sw=2:
