/**
 * Programmatic upstream sync for the prettier-sb fork.
 *
 * Merges an upstream ref into the current branch and resolves the conflicts
 * this fork always produces:
 *   - .github/workflows  → the fork keeps it deleted
 *   - package.json       → upstream versions win, fork extras are re-injected
 *   - yarn.lock          → never hand-merged; upstream's is taken and regenerated
 *
 * Then it verifies the lockfile, builds and tests second-brain, and commits the
 * merge. Every step is skippable, and the whole thing is callable from code.
 *
 * CLI:
 *   node scripts/tools/update-from-upstream.mjs [options]
 *   yarn update:upstream [options]
 *   just update [options]
 *
 * API (synchronous):
 *   import { updateFromUpstream } from "./scripts/tools/update-from-upstream.mjs";
 *   const result = updateFromUpstream({ test: false });
 *   if (!result.ok) throw new Error(result.error);
 *
 * Expected failures (merge conflicts it cannot resolve, failing tests, ...) are
 * reported as `{ ok: false, error }` rather than thrown, so callers and `--json`
 * consumers always get a report.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import {
  countForkOnly,
  mergePackageJsonFromGit,
  serializePackageJson,
} from "./merge-package-json.mjs";

/** Paths the fork intentionally keeps deleted even though upstream tracks them. */
export const KEEP_DELETED = [".github/workflows"];

/** Conflicts this script resolves on its own; anything else stops the run. */
export const AUTO_RESOLVABLE = ["package.json", "yarn.lock"];

export const DEFAULT_OPTIONS = {
  /** Upstream ref to merge. */
  ref: "upstream/main",
  /** Remote to fetch from. */
  remote: "upstream",
  /** `git fetch` before merging. */
  fetch: true,
  /** Regenerate + verify the lockfile and link node_modules. */
  install: true,
  /** Run `build:second-brain` before committing. */
  build: true,
  /** Run `test:second-brain` before committing. */
  test: true,
  /** Commit the merge once everything passes. */
  commit: true,
  /** Drop node_modules before installing (slow, pristine). */
  clean: false,
  /** Report what would happen without touching the working tree. */
  dryRun: false,
  /** Print a JSON result on stdout and logs on stderr. */
  json: false,
  /** Finish a merge that is already in progress instead of aborting it. */
  resume: false,
  /** Branch to update; defaults to the current one. */
  branch: null,
  /** Allow tracked local modifications to be carried into the merge. */
  allowDirty: false,
  /** Print usage. */
  help: false,
};

const BOOLEAN_FLAGS = new Set([
  "fetch",
  "install",
  "build",
  "test",
  "commit",
  "clean",
  "dryRun",
  "json",
  "resume",
  "allowDirty",
  "help",
]);
const VALUE_FLAGS = ["ref", "remote", "branch"];
const FLAG_ALIASES = { h: "help", n: "dryRun" };

/** `--dry-run` and `dryRun` both resolve to the `dryRun` option. */
const FLAG_TO_KEY = new Map(
  [...BOOLEAN_FLAGS, ...VALUE_FLAGS].map((key) => [toKebabCase(key), key]),
);

function toKebabCase(name) {
  return name.replaceAll(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
}

class UsageError extends Error {}

const USAGE = `Usage: node scripts/tools/update-from-upstream.mjs [options]

Merges upstream into this fork, auto-resolves the known conflicts, verifies the
lockfile, then builds/tests before committing.

  --ref <ref>        Upstream ref to merge        (default: ${DEFAULT_OPTIONS.ref})
  --remote <name>    Git remote to fetch          (default: ${DEFAULT_OPTIONS.remote})
  --branch <name>    Branch to update             (default: current branch)
  --no-fetch         Skip \`git fetch\`
  --no-install       Skip lockfile regeneration and install
  --no-build         Skip \`build:second-brain\`
  --no-test          Skip \`test:second-brain\`
  --no-commit        Leave the resolved merge staged and stop
  --clean            Remove node_modules before installing
  --allow-dirty      Merge with tracked local modifications present
  --resume           Finish the merge already in progress
  --dry-run, -n      Predict the merge; change nothing
  --json             Print a JSON result on stdout (logs go to stderr)
  -h, --help         Show this message

Exit code: 0 on success, 1 on failure, 2 on bad usage.`;

/** Turn argv into an options object, or throw a usage error. */
export function parseArgs(argv) {
  const options = {};

  for (let index = 0; index < argv.length; index++) {
    const token = argv[index];
    if (!token.startsWith("-")) {
      throw new UsageError(`Unexpected argument: ${token}`);
    }

    const [rawName, inlineValue] = splitFlag(token);
    const negated = rawName.startsWith("no-");
    const name = negated ? rawName.slice(3) : rawName;
    const key = FLAG_ALIASES[name] ?? FLAG_TO_KEY.get(toKebabCase(name));

    if (!key) {
      throw new UsageError(`Unknown option: ${token}`);
    }

    if (negated) {
      if (inlineValue !== undefined) {
        throw new UsageError(`Option ${token} does not take a value`);
      }
      if (!BOOLEAN_FLAGS.has(key)) {
        throw new UsageError(
          `Option --no-${name} is not a flag that can be turned off`,
        );
      }
      options[key] = false;
      continue;
    }

    if (BOOLEAN_FLAGS.has(key)) {
      options[key] =
        inlineValue === undefined ? true : parseBoolean(inlineValue, token);
      continue;
    }

    const value = inlineValue ?? argv[++index];
    if (value === undefined) {
      throw new UsageError(`Option ${token} needs a value`);
    }
    options[key] = value;
  }

  return options;
}

function splitFlag(token) {
  const stripped = token.replace(/^--?/, "");
  const separator = stripped.indexOf("=");
  if (separator === -1) {
    return [stripped, undefined];
  }
  return [stripped.slice(0, separator), stripped.slice(separator + 1)];
}

function parseBoolean(value, token) {
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  throw new UsageError(`Option ${token} expects true or false`);
}

/** Run a command to completion. Captured output is returned, not printed. */
function spawn(
  command,
  args,
  { cwd, capture = false, allowFailure = false, env } = {},
) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
    env: { ...process.env, ...env },
    maxBuffer: 64 * 1024 * 1024,
  });

  if (result.error && !allowFailure) {
    throw new Error(
      `Could not run \`${command} ${args.join(" ")}\`: ${result.error.message}`,
    );
  }

  const outcome = {
    status: result.error ? 1 : (result.status ?? 1),
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? result.error?.message ?? "",
  };

  if (outcome.status !== 0 && !allowFailure) {
    throw new Error(
      `\`${command} ${args.join(" ")}\` exited with ${outcome.status}` +
        (firstLine(outcome.stderr || outcome.stdout)
          ? `: ${firstLine(outcome.stderr || outcome.stdout)}`
          : ""),
    );
  }

  return outcome;
}

function firstLine(text) {
  return (text ?? "").trim().split("\n", 1)[0] ?? "";
}

function indent(text) {
  return text
    .split("\n")
    .map((line) => `    ${line}`)
    .join("\n");
}

function findRepoRoot(cwd) {
  const result = spawnSync("git", ["rev-parse", "--show-toplevel"], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    throw new Error(`${cwd} is not inside a git repository`);
  }
  return result.stdout.trim();
}

function createLogger({ json, dryRun }) {
  const prefix = dryRun ? "[dry-run] " : "";
  const stream = json ? process.stderr : process.stdout;
  const write = (target, text) => target.write(`${text}\n`);

  return {
    step: (message) => write(stream, `${prefix}→ ${message}`),
    note: (message) => write(stream, `  ${message}`),
    warn: (message) => write(process.stderr, `${prefix}⚠ ${message}`),
    fail: (message) => write(process.stderr, `${prefix}✗ ${message}`),
  };
}

function gitRunner(root) {
  const call = (args, { capture = false, allowFailure = false, env } = {}) =>
    spawn("git", args, { cwd: root, capture, allowFailure, env });

  return {
    call,
    /** Run and return trimmed stdout. */
    out: (args, options = {}) =>
      call(args, { ...options, capture: true }).stdout.trim(),
    /** Run for the boolean answer only. */
    ok: (args, options = {}) =>
      call(args, { ...options, capture: true, allowFailure: true }).status ===
      0,
    lines: (args, options = {}) =>
      call(args, { ...options, capture: true })
        .stdout.split("\n")
        .map((line) => line.trim())
        .filter(Boolean),
    mergeHeadPath: () =>
      path.resolve(
        root,
        call(["rev-parse", "--git-path", "MERGE_HEAD"], {
          capture: true,
        }).stdout.trim(),
      ),
  };
}

/** Prefer the repo's pinned yarn release so the wrapper on PATH cannot drift. */
function yarnRunner(root) {
  const releases = path.join(root, ".yarn", "releases");
  const pinned = fs.existsSync(releases)
    ? fs
        .readdirSync(releases)
        .filter((file) => /^yarn-.*\.cjs$/.test(file))
        .sort()
        .at(-1)
    : null;

  const command = pinned ? process.execPath : "yarn";
  const baseArgs = pinned ? [path.join(releases, pinned)] : [];

  return (args, options = {}) =>
    spawn(command, [...baseArgs, ...args], { cwd: root, ...options });
}

/** Run package.json scripts through bun when available, else yarn. */
function scriptRunner(root) {
  const hasBun =
    spawnSync("bun", ["--version"], { encoding: "utf8", stdio: "ignore" })
      .status === 0;
  if (hasBun) {
    return {
      label: "bun run",
      call: (args, options = {}) =>
        spawn("bun", ["run", ...args], { cwd: root, ...options }),
    };
  }
  const yarn = yarnRunner(root);
  return { label: "yarn", call: (args, options = {}) => yarn(args, options) };
}

function createContext(options) {
  const root = findRepoRoot(process.cwd());
  const git = gitRunner(root);
  const mergeHeadPath = git.mergeHeadPath();
  return {
    options,
    root,
    git,
    mergeHeadPath,
    /** Is a merge in progress right now? */
    inMerge: () => fs.existsSync(mergeHeadPath),
    yarn: yarnRunner(root),
    scripts: scriptRunner(root),
    log: createLogger(options),
  };
}

/** Delete `target` from the index and the worktree; true when there was something to delete. */
function removePath(ctx, target) {
  const { git, root } = ctx;
  const tracked = git.out(["ls-files", "--", target]);
  const onDisk = fs.existsSync(path.join(root, target));
  if (!tracked && !onDisk) {
    return false;
  }

  git.call(["rm", "-r", "-f", "--cached", "--ignore-unmatch", "--", target], {
    capture: true,
    allowFailure: true,
  });
  fs.rmSync(path.join(root, target), { recursive: true, force: true });
  return true;
}

function unresolvedConflicts(git) {
  return git.lines(["diff", "--name-only", "--diff-filter=U"]);
}

function isAutoResolvable(filePath) {
  return (
    AUTO_RESOLVABLE.includes(filePath) ||
    KEEP_DELETED.some(
      (deletedPath) =>
        filePath === deletedPath || filePath.startsWith(`${deletedPath}/`),
    )
  );
}

/** Fetch, check the ref resolves, and make sure we start from a sane state. */
function prepare(ctx, result, resuming) {
  const { git, log, options } = ctx;

  result.branch = git.out(["rev-parse", "--abbrev-ref", "HEAD"]);

  if (resuming) {
    log.warn("Finishing the merge already in progress (--resume)");
  } else {
    if (ctx.inMerge()) {
      log.warn("Aborting an incomplete merge left over from an earlier run");
      git.call(["merge", "--abort"], { allowFailure: true, capture: true });
    }

    if (!options.allowDirty) {
      const dirty = git.out(["status", "--porcelain", "--untracked-files=no"]);
      if (dirty) {
        throw new Error(
          `Working tree has tracked changes; commit or stash them, or pass --allow-dirty.\n${indent(dirty)}`,
        );
      }
    }

    if (options.branch && options.branch !== result.branch) {
      log.step(`Switching to ${options.branch}`);
      git.call(["switch", options.branch]);
      result.branch = options.branch;
    }
  }

  if (options.fetch) {
    log.step(`Fetching ${options.remote}`);
    const fetched = git.call(["fetch", options.remote], {
      capture: true,
      allowFailure: true,
      env: { GIT_TERMINAL_PROMPT: "0" },
    });
    if (fetched.status !== 0) {
      log.warn(
        `git fetch ${options.remote} failed, continuing with the local ref: ${firstLine(fetched.stderr)}`,
      );
    }
  } else {
    log.note(`Skipping fetch (--no-fetch), using local ${options.ref}`);
  }

  if (
    !git.ok(["rev-parse", "--verify", "--quiet", `${options.ref}^{commit}`])
  ) {
    throw new Error(`Cannot resolve ref ${options.ref}`);
  }

  result.behind = Number(
    git.out(["rev-list", "--count", `HEAD..${options.ref}`]) || 0,
  );
}

/** Merge the ref, recording conflicts on `result`. */
function mergeRef(ctx, result) {
  const { git, log, options } = ctx;

  if (result.behind === 0) {
    log.step(`Already up to date with ${options.ref}`);
    result.upToDate = true;
    return;
  }

  log.step(
    `Merging ${options.ref} (${result.behind} commit${result.behind === 1 ? "" : "s"})`,
  );
  const merged = git.call(["merge", options.ref, "--no-edit"], {
    capture: true,
    allowFailure: true,
    env: { GIT_EDITOR: "true" },
  });

  if (merged.status === 0) {
    log.note("Merged cleanly");
    result.merged = true;
    return;
  }

  const conflicts = unresolvedConflicts(git);
  if (conflicts.length === 0) {
    throw new Error(
      `git merge failed: ${firstLine(merged.stderr || merged.stdout)}`,
    );
  }

  result.merged = true;
  result.conflicts = conflicts;
}

/** Resolve the conflicts we know about, and stop on anything else. */
function resolveConflicts(ctx, result) {
  const { git, log, root } = ctx;
  const theirsRef = ctx.inMerge() ? "MERGE_HEAD" : ctx.options.ref;

  log.warn(`Conflicts in: ${result.conflicts.join(", ")}`);

  if (result.conflicts.includes("package.json")) {
    const merged = mergePackageJsonFromGit({ oursRef: "HEAD", theirsRef });
    fs.writeFileSync(
      path.join(root, "package.json"),
      serializePackageJson(merged.packageJson),
    );
    git.call(["add", "package.json"]);
    result.resolved.push("package.json");
    log.note(
      `package.json: upstream versions + ${countForkOnly(merged.ours, merged.theirs, "devDependencies", merged.base)} fork devDeps` +
        ` + ${countForkOnly(merged.ours, merged.theirs, "scripts", merged.base)} fork scripts`,
    );
  }

  if (result.conflicts.includes("yarn.lock")) {
    // Hand-merging a lockfile is a losing game: take upstream's whole file, then
    // let `yarn install --mode=update-lockfile` re-add the fork's entries.
    const lockfile = git.call(["show", `${theirsRef}:yarn.lock`], {
      capture: true,
    });
    fs.writeFileSync(path.join(root, "yarn.lock"), lockfile.stdout);
    git.call(["add", "yarn.lock"]);
    result.resolved.push("yarn.lock");
    log.note("yarn.lock: took upstream's file, regenerating below");
  }

  for (const deletedPath of KEEP_DELETED) {
    const conflicted = result.conflicts.some(
      (filePath) =>
        filePath === deletedPath || filePath.startsWith(`${deletedPath}/`),
    );
    if (conflicted && removePath(ctx, deletedPath)) {
      result.resolved.push(deletedPath);
      result.removedPaths.push(deletedPath);
      log.note(`${deletedPath}: kept deleted`);
    }
  }

  result.unexpectedConflicts = unresolvedConflicts(git);
  if (result.unexpectedConflicts.length > 0) {
    throw new Error(
      `Cannot auto-resolve these conflicts:\n${indent(result.unexpectedConflicts.join("\n"))}\n` +
        "Resolve them by hand, then re-run with --resume.",
    );
  }
}

/** Make sure the fork's deletions survive even when the merge was clean. */
function finalizeDeletedPaths(ctx, result) {
  for (const deletedPath of KEEP_DELETED) {
    if (removePath(ctx, deletedPath)) {
      result.removedPaths.push(deletedPath);
      ctx.log.note(`${deletedPath}: removed (the fork keeps it deleted)`);
    }
  }
}

/** Regenerate the lockfile from the merged manifest, then verify it. */
function updateLockfile(ctx, result) {
  const { git, log, options, root, yarn } = ctx;

  if (!options.install) {
    log.note("Skipping install (--no-install)");
    return;
  }

  if (options.clean) {
    log.step("Removing node_modules");
    fs.rmSync(path.join(root, "node_modules"), {
      recursive: true,
      force: true,
    });
    fs.rmSync(path.join(root, ".yarn", "install-state.gz"), { force: true });
  }

  const hashBefore = git.out(["hash-object", "yarn.lock"], {
    allowFailure: true,
  });
  log.step("Regenerating the lockfile");
  yarn(["install", "--mode=update-lockfile"]);
  git.call(["add", "yarn.lock"], { allowFailure: true, capture: true });
  result.lockfileUpdated =
    hashBefore !==
    git.out(["hash-object", "yarn.lock"], { allowFailure: true });

  log.step("Verifying the lockfile (yarn install --immutable)");
  yarn(["install", "--immutable"]);
  result.installed = true;
}

function buildAndTest(ctx, result) {
  const { log, options, scripts } = ctx;

  if (options.build) {
    log.step(`Building second-brain (${scripts.label} build:second-brain)`);
    scripts.call(["build:second-brain"]);
    result.built = true;
  } else {
    log.note("Skipping build (--no-build)");
  }

  if (options.test) {
    log.step(`Testing second-brain (${scripts.label} test:second-brain)`);
    scripts.call(["test:second-brain"]);
    result.tested = true;
  } else {
    log.note("Skipping tests (--no-test)");
  }
}

function commitMerge(ctx, result) {
  const { git, log, options } = ctx;

  if (!options.commit) {
    log.note("Leaving the result staged (--no-commit)");
    return;
  }

  if (ctx.inMerge()) {
    log.step("Committing the merge");
    git.call(["commit", "--no-edit"]);
    result.committed = true;
  } else {
    const staged = git.out(["diff", "--cached", "--name-only"]);
    if (staged) {
      log.step("Committing the fork-only cleanup");
      git.call([
        "commit",
        "-m",
        `chore: keep ${KEEP_DELETED.join(", ")} deleted`,
      ]);
      result.committed = true;
    } else {
      log.note("Nothing to commit");
    }
  }

  if (result.committed) {
    result.commit = git.out(["rev-parse", "HEAD"]);
    log.note(`commit ${result.commit.slice(0, 9)}`);
  }
}

/** Read-only prediction of what a merge would do. */
function dryRun(ctx, result) {
  const { git, log, options } = ctx;

  if (options.fetch) {
    log.step(`Fetching ${options.remote}`);
    const fetched = git.call(["fetch", options.remote], {
      capture: true,
      allowFailure: true,
      env: { GIT_TERMINAL_PROMPT: "0" },
    });
    if (fetched.status !== 0) {
      log.warn(
        `git fetch ${options.remote} failed, continuing with the local ref: ${firstLine(fetched.stderr)}`,
      );
    }
  }

  log.step(`${result.branch} vs ${options.ref}`);
  result.behind = Number(
    git.out(["rev-list", "--count", `HEAD..${options.ref}`]) || 0,
  );

  if (result.behind === 0) {
    log.note("Already up to date");
    result.upToDate = true;
    result.ok = true;
    return result;
  }

  log.note(`${result.behind} commit${result.behind === 1 ? "" : "s"} to merge`);

  const tree = git.call(
    ["merge-tree", "--write-tree", "--name-only", options.ref, "HEAD"],
    {
      capture: true,
      allowFailure: true,
    },
  );
  if (tree.status !== 0 && tree.stdout.trim() === "") {
    log.warn(
      "git merge-tree could not predict this merge; run without --dry-run to find out",
    );
    result.ok = true;
    return result;
  }

  result.conflicts = parseMergeTreeConflicts(tree.stdout);
  result.unexpectedConflicts = result.conflicts.filter(
    (filePath) => !isAutoResolvable(filePath),
  );

  if (result.conflicts.length === 0) {
    log.note("Merge would be clean");
  } else {
    log.note(`Conflicts: ${result.conflicts.length}`);
    for (const filePath of result.conflicts) {
      log.note(
        `  ${isAutoResolvable(filePath) ? "auto " : "MANUAL"} ${filePath}`,
      );
    }
  }

  result.ok = result.unexpectedConflicts.length === 0;
  if (!result.ok) {
    result.error = `Manual conflicts predicted: ${result.unexpectedConflicts.join(", ")}`;
  }
  return result;
}

/** First line of `--name-only --write-tree` output is the tree oid; the rest are paths. */
export function parseMergeTreeConflicts(stdout) {
  const [header] = stdout.split(/\n[ \t]*\n/, 1);
  return header
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !/^[0-9a-f]{40,64}$/.test(line));
}

/**
 * Sync the fork from upstream.
 * @returns a JSON-serializable report; `ok` is false when the run failed.
 */
export function updateFromUpstream(options = {}) {
  const resolved = { ...DEFAULT_OPTIONS, ...options };
  const ctx = createContext(resolved);
  const { git, log } = ctx;

  const result = {
    ok: false,
    dryRun: resolved.dryRun,
    ref: resolved.ref,
    branch: null,
    behind: 0,
    upToDate: false,
    merged: false,
    conflicts: [],
    resolved: [],
    unexpectedConflicts: [],
    removedPaths: [],
    lockfileUpdated: false,
    installed: false,
    built: false,
    tested: false,
    committed: false,
    commit: null,
    error: null,
  };

  try {
    result.branch = git.out(["rev-parse", "--abbrev-ref", "HEAD"]);

    if (resolved.dryRun) {
      return dryRun(ctx, result);
    }

    const resuming = resolved.resume && ctx.inMerge();

    prepare(ctx, result, resuming);

    if (resuming) {
      result.conflicts = unresolvedConflicts(git);
      if (result.conflicts.length === 0) {
        log.note("No unresolved paths left; finishing up");
      }
    } else {
      mergeRef(ctx, result);
    }

    if (result.conflicts.length > 0) {
      resolveConflicts(ctx, result);
    }
    finalizeDeletedPaths(ctx, result);
    updateLockfile(ctx, result);
    buildAndTest(ctx, result);
    commitMerge(ctx, result);

    result.ok = true;
    log.step(`Done on ${result.branch}`);
  } catch (error) {
    result.error = error.message;
    log.fail(error.message);
  }

  return result;
}

function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n\n${USAGE}\n`);
    return 2;
  }

  if (options.help) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }

  const merged = { ...DEFAULT_OPTIONS, ...options };
  const result = updateFromUpstream(merged);

  if (merged.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else if (!result.ok) {
    process.stdout.write(`✗ Upstream sync failed: ${result.error}\n`);
  } else if (result.dryRun) {
    process.stdout.write(
      result.upToDate
        ? `✓ ${result.branch} is up to date with ${result.ref}\n`
        : `✓ ${result.branch} would merge ${result.behind} commit(s) from ${result.ref}` +
            ` (${result.conflicts.length} conflict${result.conflicts.length === 1 ? "" : "s"}, all auto-resolvable)\n`,
    );
  } else {
    process.stdout.write(`✓ Upstream sync finished on ${result.branch}\n`);
    if (!result.committed) {
      process.stdout.write(
        "  Merge is staged, not committed. Finish with: git commit --no-edit\n",
      );
    }
  }

  return result.ok ? 0 : 1;
}

if (import.meta.main) {
  process.exitCode = main();
}
