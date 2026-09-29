/**
 * The deterministic worker slot of one Vitest test FILE (plan
 * 2026-09-25 follow-up): the supervisor's session model is "one open
 * session per worker slot", and Vitest runs FILES in parallel while
 * running the tests inside a file one at a time.
 *
 * The pack's reporter (vitest's MAIN process) and the in-test helper
 * (the worker that runs the test) must therefore agree on the slot of
 * a test, because both spool lifecycle events for it and the helper
 * resolves its session by `(workerIndex, testId)`. Vitest exposes no
 * worker identity to a reporter, so the slot is DERIVED from the
 * identity both sides already compute — the repo-relative posix test
 * file — with the same pure function in both processes.
 *
 * Deriving it (rather than sharing a runtime counter) is what makes
 * the reporter's late main-process events land on the SAME slot the
 * worker already opened: no ordering assumption, no extra channel, and
 * a project running files in parallel never claims one slot twice.
 * The digest is 53-bit, so it stays an exact integer in JSON. Two
 * different files colliding is vanishingly unlikely, and a collision
 * can only make the witness refuse the second session open (fail
 * closed) — it can never credit one test with another test's evidence.
 */

/** The 21 high bits kept (2²¹ × 2³² = 2⁵³: the JSON-safe range). */
const HIGH_MASK = 0x1f_ffff;

/**
 * The worker slot both sides assign to one test file.
 *
 * Args:
 *   file: the repo-relative posix test file (the same string the
 *     reconciliation identity is keyed by).
 *
 * Returns:
 *   number: a positive integer worker slot (never 0: slot 0 stays free
 *     for runners that really do run everything in one worker).
 */
export function vitestWorkerSlot(file: string): number {
  // FNV-1a over UTF-16 code units. The high lane keeps 21 bits, so the
  // result is an exact integer below 2^53 (never a float, never a
  // negative one: the witness refuses a negative workerIndex).
  let low = 0x811c9dc5;
  let high = 0x01000193;
  for (let index = 0; index < file.length; index += 1) {
    const code = file.charCodeAt(index);
    low = Math.imul(low ^ code, 0x01000193) >>> 0;
    high = Math.imul(high ^ (code + index), 0x85ebca6b) >>> 0;
  }
  const slot = (high & HIGH_MASK) * 2 ** 32 + low;
  return slot === 0 ? 1 : slot;
}
