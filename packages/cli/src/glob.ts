/**
 * Repo-root-relative path expansion for the `project.paths` include /
 * exclude globs (pin #6).
 *
 * Deterministic and dependency-light: walks the tree from the repo root
 * in sorted order, tests every repo-relative posix path against the
 * include patterns (any match wins) minus the exclude patterns (any
 * match drops it) with picomatch, and returns files only. `.git` and
 * `node_modules` directories are always skipped (never scanned, never
 * reported). No symlink following, no network, no wall clock.
 *
 * The result is the exact path list handed to every plugin's `discover`
 * request, so include/exclude edits change what detectors see — and
 * nothing else.
 */
import { readdirSync, statSync } from 'node:fs';
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

/**
 * Expands include globs minus exclude globs into concrete repo-root-
 * relative file paths.
 *
 * Args:
 *   include: include globs (at least one, schema-enforced).
 *   exclude: exclude globs (possibly empty).
 *   root: absolute repo root to walk.
 *
 * Returns:
 *   string[]: deduplicated, codepoint-sorted posix paths. Empty when no
 *   included file exists.
 */
export function expandIncludePaths(
  include: readonly string[],
  exclude: readonly string[],
  root: string,
): string[] {
  const includeMatchers = include.map((pattern) => picomatch(pattern, { dot: true }));
  const excludeMatchers = exclude.map((pattern) => picomatch(pattern, { dot: true }));
  const files: string[] = [];
  const walk = (dir: string, segments: readonly string[]): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return; // unreadable directory: not part of the scan
    }
    entries.sort(compareStrings);
    for (const entry of entries) {
      if (ALWAYS_SKIP.has(entry)) continue;
      const absolute = join(dir, entry);
      const relative = [...segments, entry].join('/');
      let stat;
      try {
        stat = statSync(absolute);
      } catch {
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