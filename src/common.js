// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
//
/*
/* EC2 Snapshot Tags have extra baggage that causes CreateTags to barf
 * Remove them.
 */
exports.getEC2SnapshotTags = async (ec2, snap_id) => {
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
