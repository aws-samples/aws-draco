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

/*
/* Determine whether the snapshot is encrypted and if so return it's KMS key
 * Returns undefined if not encrypted
 */
exports.getSnapshotKmsId = async (snapshot_type, service, snap_id) => {
  let params = {};
  let rsp, snapshots, encrypted;
  switch (snapshot_type) {
    case 'RDS Cluster':
      params.Filters = [ { Name: "db-cluster-snapshot-id", Values: [ snap_id ] } ];
      rsp = await service.describeDBClusterSnapshots(params).promise();
      snapshots = rsp.DBClusterSnapshots;
      encrypted = snapshots[0].Encrypted;
      break;
    case 'RDS':
      params.Filters = [ { Name: "db-snapshot-id", Values: [ snap_id ] } ];
      rsp = await service.describeDBSnapshots(params).promise();
      snapshots = rsp.DBSnapshots;
      encrypted = snapshots[0].StorageEncrypted;
      break;
    case 'EBS':
      params.SnapshotIds = [ snap_id ];
      rsp = await service.describeSnapshots(params).promise();
      snapshots = rsp.Snapshots;
      encrypted = snapshots[0].Encrypted;
      break;
    default:
      throw "Invalid Snapshot Type: "+snapshot_type;
  }
  if (process.env.DEBUG) console.debug(`Snapshot ${snap_id}: ${JSON.stringify(snapshots[0])}`);
  let kms_id = encrypted ? snapshots[0].KmsKeyId: undefined;
  console.info(`#{snapshot_type} Snapshot ${snap_id} has kms_id '${kms_id}'`);
  return kms_id;
}
// vim: sts=2 et sw=2:
