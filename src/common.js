// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
//
/*
/* Determine the source of a snapshot and whether it is encrypted.
 * Returns a two-element array: [name, KmsId] (undefined if not encrypted)
 */
exports.querySnapshotInfo = async (snapshot_type, service, snap_id) => {
  let params = {};
  let rsp, snapshots, encrypted, sourcename;
  switch (snapshot_type) {
    case 'RDS Cluster':
      params.Filters = [ { Name: "db-cluster-snapshot-id", Values: [ snap_id ] } ];
      rsp = await service.describeDBClusterSnapshots(params).promise();
      snapshots = rsp.DBClusterSnapshots;
      encrypted = snapshots[0].StorageEncrypted;
      sourcename = snapshots[0].DBClusterIdentifier;
      break;
    case 'RDS':
      params.Filters = [ { Name: "db-snapshot-id", Values: [ snap_id ] } ];
      rsp = await service.describeDBSnapshots(params).promise();
      snapshots = rsp.DBSnapshots;
      encrypted = snapshots[0].Encrypted;
      sourcename = snapshots[0].DBInstanceIdentifier;
      break;
    case 'EBS':
      params.SnapshotIds = [ snap_id ];
      rsp = await service.describeSnapshots(params).promise();
      snapshots = rsp.Snapshots;
      encrypted = snapshots[0].Encrypted;
      sourcename = snapshots[0].VolumeId;
      break;
    default:
      throw "Invalid Snapshot Type: "+snapshot_type;
  }
  if (process.env.DEBUG) console.debug(`Snapshot ${snap_id}: ${JSON.stringify(snapshots[0])}`);
  let kms_id = encrypted ? snapshots[0].KmsKeyId: undefined;
  console.info(`${snapshot_type} Snapshot: ${snap_id}, source: ${sourcename}, kms_id: ${kms_id}`);
  return [sourcename, kms_id];
}
// vim: sts=2 et sw=2:
