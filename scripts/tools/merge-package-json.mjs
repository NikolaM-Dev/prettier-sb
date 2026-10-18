// Merge package.json from upstream (MERGE_HEAD or upstream/main) with fork-only
// extras from HEAD (ours). Keeps upstream versions for shared deps, re-injects
// only the extras the fork actually added, and drops what upstream retired.
//
// Two ways in:
//   CLI          node ./scripts/tools/merge-package-json.mjs
//   programmatic import { mergePackageJsonFromGit } from "./merge-package-json.mjs"
//
// "Fork-only" is judged against the merge base, not just against upstream:
//   in ours, not in theirs, not in base → the fork added it      → keep
//   in ours, not in theirs, in base     → upstream retired it    → drop
// Without the base check, every dep upstream ever removes comes back on the next
// merge and then looks like a permanent fork-only extra.
//
// `ours` is read from HEAD (git's stage 2 during a merge), so commit fork-side
// package.json edits before merging or they will not survive the merge.

import { execFileSync } from "node:child_process";
import fs from "node:fs";

/** Refs tried for the "theirs" side, in order, when MERGE_HEAD is absent. */
export const THEIRS_FALLBACK_REFS = [
  "upstream/main",
  "origin/upstream",
  "FETCH_HEAD",
];

/** Fields holding key→value maps that get a union merge. */
const MAP_FIELDS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
  "resolutions",
];

/** Read `<ref>:<file>` from git as parsed JSON, or null when unavailable. */
export function readPackageJsonFromRef(ref, file = "package.json") {
  try {
    const content = execFileSync("git", ["show", `${ref}:${file}`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return JSON.parse(content);
  } catch {
    return null;
  }
}

/** Read package.json at the merge base of two refs, or null when there is none. */
export function readMergeBasePackageJson(oursRef, theirsRef) {
  try {
    const baseRef = execFileSync("git", ["merge-base", oursRef, theirsRef], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    return readPackageJsonFromRef(baseRef);
  } catch {
    return null;
  }
}

/** Resolve the upstream side: MERGE_HEAD during a merge, then the known refs. */
export function resolveTheirsPackageJson() {
  for (const ref of ["MERGE_HEAD", ...THEIRS_FALLBACK_REFS]) {
    const packageJson = readPackageJsonFromRef(ref);
    if (packageJson) {
      return { ref, packageJson };
    }
  }
  return null;
}

/**
 * Union-merge `ours` onto upstream's `theirs`.
 * Upstream wins for shared keys and ordering; ours contributes only additions the
 * fork made itself, judged against `base` (the merge base).
 * Returns a new object, mutating neither argument.
 */
export function mergePackageJson({ ours, theirs, base }) {
  // Start from theirs (upstream) as base — it has bumped versions we want
  const merged = structuredClone(theirs);

  for (const field of MAP_FIELDS) {
    const oursMap = ours[field];
    const theirsMap = theirs[field] ?? {};
    const baseMap = base?.[field] ?? {};
    if (!oursMap) {
      continue;
    }
    merged[field] ??= {};

    for (const [key, value] of Object.entries(oursMap)) {
      // shared key → keep upstream's version
      if (key in theirsMap) {
        continue;
      }
      // upstream retired it since the merge base → let it go
      if (key in baseMap) {
        continue;
      }
      // fork-only addition → re-inject
      merged[field][key] = value;
    }
  }

  // Preserve top-level keys the fork added (e.g. a custom field upstream lacks)
  for (const [key, value] of Object.entries(ours)) {
    if (!(key in theirs) && !(key in (base ?? {}))) {
      merged[key] = value;
    }
  }

  // dependencies/devDependencies: restore the alphabetical order upstream keeps.
  for (const field of ["dependencies", "devDependencies"]) {
    if (merged[field]) {
      const sorted = {};
      for (const key of Object.keys(merged[field]).sort()) {
        sorted[key] = merged[field][key];
      }
      merged[field] = sorted;
    }
  }

  // scripts: keep upstream order and slot fork-only scripts after their
  // predecessor in ours, so the diff stays small instead of dumping them at the end.
  if (merged.scripts && ours.scripts) {
    const oursKeys = Object.keys(ours.scripts);
    const theirsScripts = theirs.scripts ?? {};
    const baseScripts = base?.scripts ?? {};
    const forkOnly = oursKeys.filter(
      (key) => !(key in theirsScripts) && !(key in baseScripts),
    );

    for (const key of forkOnly) {
      const idxInOurs = oursKeys.indexOf(key);
      let insertAfter = null;
      for (let i = idxInOurs - 1; i >= 0; i--) {
        const predecessor = oursKeys[i];
        if (predecessor in merged.scripts) {
          insertAfter = predecessor;
          break;
        }
      }

      const value = ours.scripts[key];
      if (!insertAfter) {
        merged.scripts[key] = value;
        continue;
      }

      const rebuilt = {};
      for (const [existing, existingValue] of Object.entries(merged.scripts)) {
        rebuilt[existing] = existingValue;
        if (existing === insertAfter) {
          rebuilt[key] = value;
        }
      }
      if (!(key in rebuilt)) {
        rebuilt[key] = value;
      }
      merged.scripts = rebuilt;
    }
  }

  return merged;
}

/** Count the fork-only additions in a map field, for reporting. */
export function countForkOnly(ours, theirs, field, base) {
  const theirsMap = theirs[field] ?? {};
  const baseMap = base?.[field] ?? {};
  return Object.keys(ours[field] ?? {}).filter(
    (key) => !(key in theirsMap) && !(key in baseMap),
  ).length;
}

/**
 * Read both sides from git and merge them.
 * @returns {{packageJson: object, ours: object, theirs: object, base: object|null, theirsRef: string}}
 */
export function mergePackageJsonFromGit({ oursRef = "HEAD", theirsRef } = {}) {
  const ours = readPackageJsonFromRef(oursRef);
  if (!ours) {
    throw new Error(`Could not read ${oursRef}:package.json`);
  }

  const theirsEntry = theirsRef
    ? { ref: theirsRef, packageJson: readPackageJsonFromRef(theirsRef) }
    : resolveTheirsPackageJson();
  if (!theirsEntry?.packageJson) {
    throw new Error(
      `Could not read the upstream package.json (tried MERGE_HEAD, ${THEIRS_FALLBACK_REFS.join(", ")})`,
    );
  }

  const base = readMergeBasePackageJson(oursRef, theirsEntry.ref);

  return {
    packageJson: mergePackageJson({
      ours,
      theirs: theirsEntry.packageJson,
      base,
    }),
    ours,
    theirs: theirsEntry.packageJson,
    base,
    theirsRef: theirsEntry.ref,
  };
}

/** Serialize the way the repo's formatter expects (2-space indent, trailing newline). */
export function serializePackageJson(packageJson) {
  return `${JSON.stringify(packageJson, null, 2)}\n`;
}

function main() {
  const result = mergePackageJsonFromGit();
  fs.writeFileSync("package.json", serializePackageJson(result.packageJson));
  const baseRef = result.base ? "merge base" : "no merge base";
  console.log(
    `Merged package.json (theirs: ${result.theirsRef}, ${baseRef}): kept upstream shared versions, ` +
      `re-injected ${countForkOnly(result.ours, result.theirs, "devDependencies", result.base)} fork-only devDeps ` +
      `and ${countForkOnly(result.ours, result.theirs, "scripts", result.base)} fork-only scripts.`,
  );
}

if (import.meta.main) {
  main();
}
