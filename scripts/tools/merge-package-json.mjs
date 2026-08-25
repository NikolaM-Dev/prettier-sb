#!/usr/bin/env node
// Merge package.json from upstream (MERGE_HEAD or upstream/main) with fork-only
// extras from HEAD (ours). Keeps upstream versions for shared deps, re-injects
// fork-only deps/scripts.

import { execSync } from "node:child_process";
import fs from "node:fs";

function gitShow(ref, file) {
  try {
    return execSync(`git show ${ref}:${file}`, { encoding: "utf8" });
  } catch {
    return null;
  }
}

function loadJson(ref, file) {
  const content = gitShow(ref, file);
  if (!content) return null;
  return JSON.parse(content);
}

// Resolve refs
let ours = loadJson("HEAD", "package.json");
let theirs = null;

// Prefer MERGE_HEAD during a merge conflict
if (gitShow("MERGE_HEAD", "package.json")) {
  theirs = loadJson("MERGE_HEAD", "package.json");
} else {
  // Fallback to upstream/main or origin candidate
  for (const ref of ["upstream/main", "MERGE_HEAD", "origin/upstream", "FETCH_HEAD"]) {
    const c = gitShow(ref, "package.json");
    if (c) {
      theirs = JSON.parse(c);
      break;
    }
  }
}

if (!ours) {
  console.error("Could not read HEAD:package.json");
  process.exit(1);
}
if (!theirs) {
  console.error("Could not read theirs (MERGE_HEAD or upstream/main) package.json");
  process.exit(1);
}

// Start from theirs (upstream) as base — it has bumped versions we want
const merged = structuredClone(theirs);

// Fields that contain key→value maps to union-merge.
// For those, keep upstream values for shared keys, add fork-only keys from ours.
const mapFields = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies", "resolutions"];

for (const field of mapFields) {
  const oursMap = ours[field];
  const theirsMap = theirs[field] || {};
  if (!oursMap) continue;
  if (!merged[field]) merged[field] = {};

  for (const [key, value] of Object.entries(oursMap)) {
    if (!(key in theirsMap)) {
      // fork-only key → re-inject
      merged[field][key] = value;
    }
    // else: shared key → keep theirs (upstream) version, do not override
  }
}
// scripts handled separately below for ordered insertion

// Also preserve any top-level fork-only keys that upstream does not have
// (e.g., if you ever add a custom field)
for (const [key, value] of Object.entries(ours)) {
  if (!(key in theirs)) {
    // Fork-only top-level field — keep it
    merged[key] = value;
  }
}

// For dependencies/devDependencies: keep upstream order but ensure fork-only keys are inserted
// alphabetically (upstream keeps them sorted). For scripts: preserve upstream order entirely
// and append fork-only scripts – sorting would create noisy diffs.
for (const field of ["dependencies", "devDependencies"]) {
  if (merged[field]) {
    const sorted = {};
    for (const k of Object.keys(merged[field]).sort()) {
      sorted[k] = merged[field][k];
    }
    merged[field] = sorted;
  }
}
// scripts: keep upstream order + insert fork-only keys near their original position in ours
// to minimise diff noise. For each fork-only script, try to insert after its predecessor
// in ours that also exists in theirs; otherwise append.
if (merged.scripts && ours.scripts) {
  const oursKeys = Object.keys(ours.scripts);
  const theirsKeys = Object.keys(theirs.scripts || {});
  const forkOnly = oursKeys.filter(k => !theirsKeys.includes(k));
  for (const key of forkOnly) {
    // Find predecessor in ours that exists in merged (theirs order)
    const idxInOurs = oursKeys.indexOf(key);
    let insertAfter = null;
    for (let i = idxInOurs - 1; i >= 0; i--) {
      const pred = oursKeys[i];
      if (pred in merged.scripts) {
        insertAfter = pred;
        break;
      }
    }
    const value = ours.scripts[key];
    if (insertAfter) {
      // Rebuild ordered object inserting after predecessor
      const rebuilt = {};
      for (const k of Object.keys(merged.scripts)) {
        rebuilt[k] = merged.scripts[k];
        if (k === insertAfter) rebuilt[key] = value;
      }
      // If not inserted (predecessor at end, already handled) ensure present
      if (!(key in rebuilt)) rebuilt[key] = value;
      merged.scripts = rebuilt;
    } else {
      merged.scripts[key] = value;
    }
  }
}

// Write back
fs.writeFileSync("package.json", JSON.stringify(merged, null, 2) + "\n");
console.log(`Merged package.json: kept upstream shared versions, re-injected ${Object.keys(ours.devDependencies || {}).filter(k => !(k in (theirs.devDependencies||{}))).length} fork-only devDeps and ${Object.keys(ours.scripts || {}).filter(k => !(k in (theirs.scripts||{}))).length} fork-only scripts.`);
