/**
 * Git-ignore awareness for STATIC discovery candidates.
 *
 * The static scanner walks the filesystem with include/exclude globs and
 * pruned build/dep directories only. A path the repository IGNORES —
 * the built, git-ignored bundle a frontend build writes into the tree —
 * is not source the owner runs or intends to change, and the runner can
 * never enumerate a test inside it. Rows from such a file can only ever
 * become `unenumeratedReason` gaps and permanent RUN_INCOMPLETE
 * incompleteness, so an ignored file must never become a static row.
 *
 * The filter asks GIT, in ONE batched call, which of the candidate paths
 * git ignores. Two deliberate properties:
 *
 * - **Untracked is not ignored.** `git check-ignore` without `--no-index`
 *   never reports a TRACKED file, so a committed spec that matches an
 *   ignore pattern is still scanned (and still fail-closed as
 *   unresolved when its shape is unresolvable), while a brand-new
 *   uncommitted spec — untracked, not ignored — is still planned.
 * - **Absence of an answer is not an answer.** Outside a work tree
 *   (plain fixture directories), or when git is missing, unreadable, or
 *   too slow, the helper reports `null` and the caller keeps exactly
 *   today's behavior. Git ignore rules are only consulted where they
 *   actually exist.
 */
import { spawnSync } from 'node:child_process';

/** Hard cap on the batched ignore query's output buffer. */
const MAX_IGNORE_OUTPUT_BYTES = 64 * 1024 * 1024;

/** The ignore query's deadline; a slower git answers nothing (today's behavior). */
const IGNORE_QUERY_TIMEOUT_MS = 20_000;

/**
 * The subset of `paths` git ignores, or null when git cannot answer.
 *
 * Args:
 *   cwd: absolute directory the relative paths are resolved against (the scan root).
 *   paths: repo-relative posix paths, already filtered to scan candidates.
 *
 * Returns:
 *   Set<string> | null: the ignored subset when git answered (possibly
 *   empty), or null outside a work tree / when the query was unavailable.
 */
export function gitIgnoredPaths(cwd: string, paths: readonly string[]): Set<string> | null {
  if (paths.length === 0) return new Set();
  const result = spawnSync('git', ['--no-replace-objects', 'check-ignore', '--stdin', '-z'], {
    cwd,
    encoding: 'utf8',
    input: `${paths.join('\0')}\0`,
    maxBuffer: MAX_IGNORE_OUTPUT_BYTES,
    timeout: IGNORE_QUERY_TIMEOUT_MS,
  });
  if (result.error !== undefined) return null; // git missing, killed, or timed out
  // 0: at least one path is ignored. 1: none are (status 128: not a
  // repository — "no work tree", which also means no filter).
  if (result.status !== 0 && result.status !== 1) return null;
  return new Set(
    (result.stdout ?? '')
      .split('\0')
      .filter((path) => path.length > 0),
  );
}