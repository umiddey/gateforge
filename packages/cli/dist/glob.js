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
/** Directories that are never scanned, whatever the globs say. */
const ALWAYS_SKIP = new Set(['.git', 'node_modules']);
/** True when at least one compiled pattern matches the path. */
function matchesAny(path, matchers) {
    return matchers.some((matcher) => matcher(path));
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
export function expandIncludePaths(include, exclude, root, errors) {
    const includeMatchers = include.map((pattern) => picomatch(pattern, { dot: true }));
    const excludeMatchers = exclude.map((pattern) => picomatch(pattern, { dot: true }));
    const files = [];
    const walk = (dir, segments) => {
        let entries;
        try {
            entries = readdirSync(dir);
        }
        catch (cause) {
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
            if (ALWAYS_SKIP.has(entry))
                continue;
            const absolute = join(dir, entry);
            const relative = [...segments, entry].join('/');
            let stat;
            try {
                stat = statSync(absolute);
            }
            catch (cause) {
                errors?.push({
                    path: relative,
                    detail: `could not stat path: ${cause instanceof Error ? cause.message : String(cause)}`,
                });
                continue;
            }
            if (stat.isDirectory()) {
                walk(absolute, [...segments, entry]);
            }
            else if (stat.isFile() && matchesAny(relative, includeMatchers) && !matchesAny(relative, excludeMatchers)) {
                files.push(relative);
            }
        }
    };
    walk(root, []);
    return files;
}
//# sourceMappingURL=glob.js.map