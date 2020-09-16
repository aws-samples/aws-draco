// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
//
/*
/* Merge Tags
 * Tags are in the form of an array of {key:, value:} hashes.
 */
exports.mergeTags = (primaryTags, secondaryTags) => {
  let result = new Map();
  for (let f of primaryTags) {
    if (!result.has(f.Key)) result.set(f.Key, f.Value);
  }
  for (let s of secondaryTags) {
    if (!result.has(s.Key)) result.set(s.Key, s.Value);
  }
  let list = Array.from(result);
  return list.map(e => ({ Key: e[0], Value: e[1] }));
}

// vim: sts=2 et sw=2:
