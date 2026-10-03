/**
 * The WORKER-SIDE end: a test's end reaches the drain from the worker
 * that ran it, in the same order as that worker's own begin, so the
 * NEXT test of the same file never waits for the runner's main process
 * to report the previous one.
 *
 * These tests drive the real drain against the real witness and assert
 * both halves of the contract:
 * - the worker's outcome-less end frees the worker slot immediately
 *   (the next test's session opens at once), and the runner's later
 *   `testEnd` still seals the released session with the outcome ONLY
 *   the runner observed;
 * - the release credits nothing: an outcome that never arrives leaves
 *   the session outcome-less (which grades not-passed), and two
 *   different outcomes for one test are a lifecycle conflict.
 */
import { describe, expect, it, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startWitness } from '../../pack-playwright/src/witness/server.js';
import { startSupervisorSpoolDrain } from '../../pack-playwright/src/supervisor/drain.js';
import { appendSpoolEvent, spoolPathFor } from '../../pack-playwright/src/supervisor/spool.js';
import { SupervisorClient } from '../../pack-playwright/src/supervisor/client.js';
import { vitestWorkerSlot } from '../../pack-playwright/src/vitest/worker-slot.js';

const FILE = 'tests/accounts.test.mjs';
const FIRST = 'tests/accounts.test.mjs#creates an account';
const SECOND = 'tests/accounts.test.mjs#creates a second account';
const RUN_ID = '5b5b5b5b-8f8f-4333-8444-555555555555';
const VERIFIER_KEY = 'worker-end-release-verifier-key';

/** The worker slot both channels derive from the file (see vitest/worker-slot.ts). */
const SLOT = vitestWorkerSlot(FILE);

const TEMP_DIRS: string[] = [];

afterEach(() => {
  for (const dir of TEMP_DIRS.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** One disposable state directory, removed after the test. */
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'worker-end-'));
  TEMP_DIRS.push(dir);
  return dir;
}

/** One drained lifecycle event (the shape the runner side appends). */
function event(
  kind: 'testBegin' | 'testEnd',
  testId: string,
  outcome?: string,
): Parameters<typeof appendSpoolEvent>[1] {
  return {
    kind,
    testId,
    workerIndex: SLOT,
    file: FILE,
    titlePath: [testId.slice(FILE.length + 1)],
    project: null,
    ...(outcome === undefined ? {} : { outcome }),
  };
}

/** The witness's own view of one expected test's sessions after a drain. */
interface TracedSession {
  sessionId: string;
  outcome: string | null;
}

/**
 * Runs the real drain over the real witness with BOTH tests registered,
 * appending the given events and stopping the drain (its final sweep
 * processes every appended event before it answers).
 *
 * Args:
 *   events: the spool events the (simulated) runner appended.
 *
 * Returns:
 *   Promise<{ conflicts: string[]; sessions: Map<string, TracedSession[]> }>:
 *     the drain's conflicts and the witness trace, per test id.
 */
async function drainWith(
  events: ReadonlyArray<Parameters<typeof appendSpoolEvent>[1]>,
): Promise<{ conflicts: string[]; sessions: Map<string, TracedSession[]> }> {
  const stateDir = tempDir();
  const witness = await startWitness({ runId: RUN_ID, token: 'suite-token', verifierKey: VERIFIER_KEY });
  const supervisor = new SupervisorClient(witness.url, 'suite-token', VERIFIER_KEY);
  await supervisor.registerExpectedSet({
    tests: [
      { testId: FIRST, project: null, file: FILE, titlePath: ['creates an account'] },
      { testId: SECOND, project: null, file: FILE, titlePath: ['creates a second account'] },
    ],
  });
  const spoolFile = spoolPathFor(stateDir, RUN_ID);
  const drain = startSupervisorSpoolDrain({
    stateDir,
    runId: RUN_ID,
    witnessUrl: witness.url,
    runToken: 'suite-token',
    verifierKey: VERIFIER_KEY,
    pollMs: 5,
  });
  try {
    const stopped = await (async () => {
      for (const one of events) appendSpoolEvent(spoolFile, one);
      return drain.stop();
    })();
    const trace = await supervisor.executionTrace();
    const sessions = new Map<string, TracedSession[]>();
    for (const entry of trace?.tests ?? []) {
      if (entry.testId === null) continue;
      sessions.set(
        entry.testId,
        entry.sessions.map((session) => ({ sessionId: session.sessionId, outcome: session.outcome })),
      );
    }
    return { conflicts: stopped.conflicts, sessions };
  } finally {
    await witness.stop();
  }
}

describe('the worker-side end releases the slot without crediting anything', () => {
  it('opens the next test of the same file while the runner still owes the first one its outcome', async () => {
    // The real serial order, with the runner's main process lagging:
    // worker begin/end for test 1, worker begin for test 2 — and only
    // then the runner's own ends, which carry the observed outcomes.
    const { conflicts, sessions } = await drainWith([
      event('testBegin', FIRST),
      event('testEnd', FIRST),
      event('testBegin', SECOND),
      event('testEnd', FIRST, 'passed'),
      event('testEnd', SECOND, 'passed'),
    ]);
    expect(conflicts).toEqual([]);
    // BOTH tests hold their own session: test 2's session exists only
    // because the worker's end of test 1 freed the shared worker slot.
    expect(sessions.get(FIRST)).toHaveLength(1);
    expect(sessions.get(SECOND)).toHaveLength(1);
    // And the outcome is the RUNNER's, recorded when its own end
    // arrived: a release never states a verdict.
    expect(sessions.get(FIRST)?.[0]?.outcome).toBe('passed');
    expect(sessions.get(SECOND)?.[0]?.outcome).toBe('passed');
  });

  it('leaves the session outcome-less when the runner never reports the outcome', async () => {
    const { conflicts, sessions } = await drainWith([
      event('testBegin', FIRST),
      event('testEnd', FIRST),
      event('testBegin', SECOND),
      event('testEnd', SECOND, 'passed'),
    ]);
    expect(conflicts).toEqual([]);
    // The second test still ran (the release worked)...
    expect(sessions.get(SECOND)?.[0]?.outcome).toBe('passed');
    // ...but the first test's outcome was never confirmed, and an
    // unconfirmed session can never read as passed.
    expect(sessions.get(FIRST)?.[0]?.outcome).toBeNull();
  });

  it('refuses two different outcomes for the same released test', async () => {
    const { conflicts, sessions } = await drainWith([
      event('testBegin', FIRST),
      event('testEnd', FIRST),
      event('testEnd', FIRST, 'passed'),
      event('testEnd', FIRST, 'failed'),
    ]);
    expect(conflicts.join('\n')).toMatch(/ended twice with different outcomes/);
    // The FIRST outcome stands; a confused lifecycle never overwrites it.
    expect(sessions.get(FIRST)?.[0]?.outcome).toBe('passed');
  });

  it('never opens a session for an outcome with no begin', async () => {
    const { conflicts, sessions } = await drainWith([
      event('testEnd', SECOND, 'passed'),
      event('testBegin', FIRST),
      event('testEnd', FIRST, 'passed'),
    ]);
    expect(conflicts.join('\n')).toMatch(/lone end|no matching open begin/);
    expect(sessions.get(SECOND) ?? []).toEqual([]);
  });
});
