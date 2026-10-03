/**
 * Repo-root-relative path expansion for the `project.paths` include /
 * exclude globs (pin #6).
 *
 * Deterministic and dependency-light: walks the tree from the repo root
 * in sorted order, tests every repo-relative posix path against the
 * include patterns (any match wins) minus the exclude patterns (any
 * match drops it) with picomatch, and returns files only. `.git` and
 * `node_modules` directories are always skipped (never scanned, never
 * reported). Symbolic links are SKIPPED silently (never followed, never
 * collected, never reported — see the walk loop for why that closes no
 * scan-scope hole). No network, no wall clock.
 *
 * The result is the exact path list handed to every plugin's `discover`
 * request, so include/exclude edits change what detectors see — and
 * nothing else.
 *
 * TWO SCOPES, deliberately not one:
 *
 * - {@link expandScanPaths} is the SCAN scope. It additionally skips
 *   the untracked-and-ignored paths Git reports (owner decision D5,
 *   release 0.9.0): a minified `playwright-report/` bundle in a
 *   consumer working copy is not source, and scanning it produced
 *   hundreds of bogus `FRONTEND_CALL_TARGET_UNRESOLVED` entries that
 *   the owner then had to adopt away. A TRACKED file matching an ignore
 *   pattern is still scanned — Git never reports tracked paths as
 *   `--others`, so git semantics give that for free.
 * - {@link expandIncludePaths} is the IDENTITY scope and stays exactly
 *   as it was: every glob match, gitignored or not. The input snapshot
 *   hashes a deliberate SUPERSET of what the scan reads (its own
 *   documented invariant, and the same list `assertOutputDisjoint`
 *   refuses an `--out` overlap against), so it must never learn to skip
 *   anything. Two names over one implementation, so no caller can
 *   narrow the identity scope by accident.
 */
import { lstatSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { compareStrings } from '@gate-forge/core';
import picomatch from 'picomatch';
import type { Matcher } from 'picomatch';
import type { GitIgnoredScope } from './git-ignored.js';

/** Directories that are never scanned, whatever the globs say. */
const ALWAYS_SKIP = new Set(['.git', 'node_modules']);

/** The scope that excludes nothing — the identity walk's ignore rules. */
const NOTHING_IGNORED: GitIgnoredScope = {
  known: false,
  skipsDirectory: () => false,
  skipsFile: () => false,
};

/** True when at least one compiled pattern matches the path. */
function matchesAny(path: string, matchers: readonly Matcher[]): boolean {
  return matchers.some((matcher) => matcher(path));
}

/** One filesystem failure encountered while expanding the scan. */
export interface ExpandError {
  /** The repo-root-relative path that could not be read. */
  path: string;
  /** What failed (readdir vs stat) and the OS cause. */
  detail: string;
}

/**
 * The one walk behind both exported scopes.
 *
 * FAIL-CLOSED (red-team F3): filesystem failures are never silent. An
 * unreadable directory or a failed stat means files MAY exist that the
 * scan could not see — they are collected in `errors` so the pipeline
 * can block the gate and invalidate closed-world proofs instead of
 * letting them vanish from both the requested and scanned sets.
 *
 * SYMBOLIC LINKS are the one deliberate silent skip: they are never
 * followed and never collected (files or directories). A link's target
 * is outside the repository's real source tree, so scanning it would
 * attribute foreign content to the repo and invalidate closed-world
 * proofs; a dangling link hides nothing (no target content exists).
 * Unlike unreadable directories, a skipped symlink can never conceal a
 * repository file — so no error is reported and none is needed. The
 * same argument covers a Git-IGNORED path: it is out of scope by the
 * owner's own declaration, not a hole the scan failed to see.
 *
 * Args:
 *   include: include globs (at least one, schema-enforced).
 *   exclude: exclude globs (possibly empty).
 *   root: absolute repo root to walk.
 *   gitIgnored: the run's Git-ignore scope (see `./git-ignored.ts`).
 *   errors: out-array collecting every unreadable path.
 *
 * Returns:
 *   string[]: deduplicated, codepoint-sorted posix paths. Empty when no
 *   included file exists.
 */
function expand(
  include: readonly string[],
  exclude: readonly string[],
  root: string,
  gitIgnored: GitIgnoredScope,
  errors?: ExpandError[],
): string[] {
  const includeMatchers = include.map((pattern) => picomatch(pattern, { dot: true }));
  const excludeMatchers = exclude.map((pattern) => picomatch(pattern, { dot: true }));
  const files: string[] = [];
  const walk = (dir: string, segments: readonly string[]): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch (cause) {
      // Unreadable directory: NOT silently skippable — files inside may
      // exist and must not vanish from the scan's knowledge.
      errors?.push({
        path: segments.join('/') || '.',
        detail: `could not read directory: ${cause instanceof Error ? cause.message : String(cause)}`,
      });
      return;
    }
    entries.sort(compareStrings);
    for (const entry of entries) {
      if (ALWAYS_SKIP.has(entry)) continue;
      const absolute = join(dir, entry);
      const relative = [...segments, entry].join('/');
      if (gitIgnored.skipsDirectory(relative)) {
        // Git reports a wholly-ignored directory as one collapsed entry,
        // so the whole subtree leaves the scan without being walked. A
        // directory holding a TRACKED file is never collapsed, so this
        // can never skip a committed byte.
        continue;
      }
      let stat;
      try {
        // lstat (NOT stat): the entry itself is inspected without
        // following a final symlink, so a link is recognizable as a link.
        stat = lstatSync(absolute);
      } catch (cause) {
        errors?.push({
          path: relative,
          detail: `could not stat path: ${cause instanceof Error ? cause.message : String(cause)}`,
        });
        continue;
      }
      if (stat.isSymbolicLink()) {
        // SKIP silently — this is not a scan-scope hole. A symlink is by
        // definition outside the repository's real source tree: following
        // one would scan content the repository does not own (files the
        // repo's VCS never tracked), invalidating closed-world proofs.
        // A dangling link cannot hide repository files either — there is
        // no target content behind it. Skipping therefore shrinks the
        // scan to exactly the real tree, unlike an unreadable directory,
        // which MAY hide files and must keep failing closed above.
        continue;
      }
      if (stat.isDirectory()) {
        walk(absolute, [...segments, entry]);
        continue;
      }
      // An ignored file is out of scope by the owner's declaration, and a
      // TRACKED file is never reported by `ls-files --others`, so it can
      // never land here. Neither conceals anything, so neither collects
      // an ExpandError.
      if (!stat.isFile() || gitIgnored.skipsFile(relative)) continue;
      if (matchesAny(relative, includeMatchers) && !matchesAny(relative, excludeMatchers)) {
        files.push(relative);
      }
    }
  };
  walk(root, []);
  return files;
}

/**
 * Expands the configured include/exclude globs into the DETECTOR-INPUT
 * scope: every match minus the paths this run's Git-ignore scope
 * excludes. This is the list handed to every plugin's `discover`
 * request, and the classifier's coverage check compares its requested
 * paths against what detectors actually scanned — so an ignored tree
 * must leave BOTH sides, or the closed-world check would compare sets
 * the walk never intended to describe.
 *
 * The caller computes the scope ONCE per run (`gitIgnoredPaths` in
 * `./git-ignored.ts`) and passes the same object here every time, so
 * every enumeration of the scan scope agrees on one answer.
 *
 * Args:
 *   include: include globs (at least one, schema-enforced).
 *   exclude: exclude globs (possibly empty).
 *   root: absolute repo root to walk.
 *   gitIgnored: the run's Git-ignore scope; a `known: false` scope skips
 *     nothing, which is exactly today's behaviour outside a work tree.
 *   errors: out-array collecting every unreadable path.
 *
 * Returns:
 *   string[]: deduplicated, codepoint-sorted posix paths.
 */
export function expandScanPaths(
  include: readonly string[],
  exclude: readonly string[],
  root: string,
  gitIgnored: GitIgnoredScope,
  errors?: ExpandError[],
): string[] {
  return expand(include, exclude, root, gitIgnored, errors);
}

/**
 * Expands include globs minus exclude globs into concrete repo-root-
 * relative file paths, consulting no ignore rules: the IDENTITY scope.
 * Every glob match is returned, gitignored or not.
 *
 * `collectDeclaredInputs` (input snapshot) calls this and must keep
 * hashing a superset of the scan — a gitignored configured input still
 * moves the receipt digest, which is the conservative direction and the
 * behaviour `assertOutputDisjoint` relies on when it refuses an `--out`
 * that would hide a declared input.
 *
 * Args:
 *   include: include globs (at least one, schema-enforced).
 *   exclude: exclude globs (possibly empty).
 *   root: absolute repo root to walk.
 *   errors: out-array collecting every unreadable path.
 *
 * Returns:
 *   string[]: deduplicated, codepoint-sorted posix paths. Empty when no
 *   included file exists.
 */
export function expandIncludePaths(
  include: readonly string[],
  exclude: readonly string[],
  root: string,
  errors?: ExpandError[],
): string[] {
  return expand(include, exclude, root, NOTHING_IGNORED, errors);
}