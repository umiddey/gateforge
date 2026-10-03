/**
 * Git-ignore awareness for the DETECTOR-INPUT walk (owner decision D5,
 * release 0.9.0).
 *
 * A consumer working copy holds whole gitignored trees the repository
 * never owns as source: the minified trace-viewer bundles a Playwright
 * run writes into `playwright-report/`, build output, local caches. The
 * scan walked them exactly like committed code, so every minified call
 * in them became detector evidence — hundreds of
 * `FRONTEND_CALL_TARGET_UNRESOLVED` entries the owner then had to
 * `adopt` away. A clean clone of the same commit scanned none of it.
 * The set Git already knows is the one honest answer to "what is source
 * here", so the scan asks Git once and skips exactly that.
 *
 * Properties this module guarantees:
 *
 * - **Deterministic across machines.** `core.excludesFile` is
 *   overridden to empty on the command line, so the user's global
 *   excludes file cannot change which files one repository's scan sees.
 *   `.gitignore` at any depth and `.git/info/exclude` still count —
 *   they are repository state, not machine state.
 * - **Tracked files are never skipped.** `ls-files --others` reports
 *   UNTRACKED paths only, so a committed file that matches an ignore
 *   pattern stays in the scan (git's own semantics, and the same rule
 *   the static test scanner in `@gate-forge/pack-playwright` follows).
 * - **Absence of an answer is not an answer.** Outside a work tree, or
 *   when git is missing, unreadable, or too slow, the scope reports
 *   `known: false` and both predicates are false — the caller keeps
 *   exactly today's behaviour and skips nothing. Nothing is printed: a
 *   repository without usable Git inventory is already surfaced by the
 *   input snapshot's `snapshot-unavailable` diagnostic, and the scan
 *   must not invent a second warning channel for it.
 * - **Whole ignored directories arrive collapsed.** `--directory` makes
 *   Git report an entirely-ignored directory as one `dir/` entry, so the
 *   walk skips the subtree without descending into it. A directory
 *   holding a TRACKED file is never collapsed — Git reports the ignored
 *   files inside it individually — so collapsing can never hide a
 *   committed byte.
 */
import { spawnSync } from 'node:child_process';

/**
 * One run's answer to "which paths does Git ignore here". The two
 * predicates are the contract callers use, so no caller can ask the
 * file set a directory question or read past the `known: false` answer.
 */
export interface GitIgnoredScope {
  /** False when Git could not answer; then both predicates are false. */
  readonly known: boolean;
  /** Whether the walk must not descend into this repo-relative directory. */
  skipsDirectory(relativeDirectory: string): boolean;
  /** Whether this repo-relative file is skipped by the walk. */
  skipsFile(relativeFile: string): boolean;
}

/** Hard cap on the ignore query's output buffer. */
const MAX_IGNORE_OUTPUT_BYTES = 64 * 1024 * 1024;

/** The ignore query's deadline; a slower git answers nothing (today's behaviour). */
const IGNORE_QUERY_TIMEOUT_MS = 20_000;

/**
 * Asks Git which UNTRACKED paths this repository ignores. Callers
 * compute this ONCE per run and hand it to every enumeration that must
 * agree on the scan scope.
 *
 * Args:
 *   root: absolute repository root (the directory the walk starts at).
 *
 * Returns:
 *   GitIgnoredScope: the skip rules when Git answered; a `known: false`
 *   scope that skips nothing when there was no usable work tree.
 */
export function gitIgnoredPaths(root: string): GitIgnoredScope {
  const result = spawnSync(
    'git',
    [
      '-c',
      'core.excludesFile=',
      'ls-files',
      '--others',
      '--ignored',
      '--exclude-standard',
      '--directory',
      '-z',
    ],
    {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: MAX_IGNORE_OUTPUT_BYTES,
      timeout: IGNORE_QUERY_TIMEOUT_MS,
    },
  );
  if (result.error !== undefined) {
    return { known: false, skipsDirectory: () => false, skipsFile: () => false };
  }
  // Non-zero is "not a repository" (128) or an unreadable work tree —
  // both mean no answer, and an unanswered query skips nothing.
  if (result.status !== 0) {
    return { known: false, skipsDirectory: () => false, skipsFile: () => false };
  }
  const files = new Set<string>();
  const directories = new Set<string>();
  for (const entry of (result.stdout ?? '').split('\0')) {
    if (entry.length === 0) continue;
    if (entry.endsWith('/')) {
      directories.add(entry.slice(0, -1));
    } else {
      files.add(entry);
    }
  }
  if (files.size === 0 && directories.size === 0) {
    return { known: true, skipsDirectory: () => false, skipsFile: () => false };
  }
  return {
    known: true,
    skipsDirectory: (relativeDirectory) => directories.has(relativeDirectory),
    skipsFile: (relativeFile) => files.has(relativeFile),
  };
}