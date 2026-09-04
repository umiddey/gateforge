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
 */
import { lstatSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { compareStrings } from '@gateforge/core';
import picomatch from 'picomatch';
import type { Matcher } from 'picomatch';

/** Directories that are never scanned, whatever the globs say. */
const ALWAYS_SKIP = new Set(['.git', 'node_modules']);

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
 * Expands include globs minus exclude globs into concrete repo-root-
 * relative file paths.
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
 * repository file — so no error is reported and none is needed.
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
      } else if (stat.isFile() && matchesAny(relative, includeMatchers) && !matchesAny(relative, excludeMatchers)) {
        files.push(relative);
      }
    }
  };
  walk(root, []);
  return files;
}