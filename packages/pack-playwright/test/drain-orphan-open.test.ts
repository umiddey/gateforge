/**
 * The drain's open-recovery contract (plan
 * 20261020_1800_gf_drain_begin_not_behind_finalize, P9): a session
 * open whose supervisor call ABORTS after the witness already minted
 * the session must not orphan it. PM witnessed CI (0.18.0 baseline and
 * the 0.18.1 rc1 alike): test 28's `/sessions/open` aborted at the 5 s
 * supervisor client timeout while the witness held the minted session
 * open; the drain recorded no worker slot (`openByWorker` is set only
 * when `client.openSession` resolves), so the test's own ends closed
 * nothing and the NEXT test's begin on that worker was 409-refused
 * with "worker 1 already carries an open session for testId
 * '<prev>'" — "No supervisor-issued witness session" for an innocent
 * test.
 *
 * The witness answers an identical (worker, testId) re-open
 * idempotently with the SAME session, so the drain can recover the
 * session it lost with ONE further open call. The fake below models
 * the witness's server-side rule exactly: at most one open session per
 * worker, an identical (worker, testId) re-open returns the same
 * session, and a different testId over a bound worker is refused 409.
 *
 * The witness transport (`SupervisorClient`) is the unit boundary
 * here, exactly as in drain-outcome-chain.test.ts: the claim under
 * test is the DRAIN's slot bookkeeping, not the HTTP layer.
 */
import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { appendSpoolEvent, spoolPathFor, type SpoolEvent } from '../src/supervisor/spool.js';
import { startSupervisorSpoolDrain, type SpoolDrainHandle } from '../src/supervisor/drain.js';

/** Mutable state shared with the hoisted client mock. */
interface ClientHarness {
  /** Every fake client call in order (`open:` attempts, `opened:` successes). */
  calls: string[];
  /** Open attempts per `worker\0testId` — the no-blind-loop proof. */
  attempts: Map<string, number>;
  /**
   * When armed, the FIRST open of this (worker, testId) commits the
   * session server-side and then throws the transport abort — the
   * witness minted the session and the response was lost.
   */
  abortOpen: { workerIndex: number; testId: string; spent: boolean } | null;
  /** When set, EVERY open throws the transport error and commits nothing. */
  witnessUnreachable: boolean;
  /** The fake witness's server-side sessions, keyed by sessionId. */
  sessions: Map<
    string,
    { sessionId: string; testId: string; workerIndex: number; released: boolean }
  >;
  /** The fake witness's worker bindings: workerIndex -> sessionId. */
  slots: Map<number, string>;
}

const harness = vi.hoisted(() => {
  const state = {
    calls: [] as string[],
    attempts: new Map<string, number>(),
    abortOpen: null as { workerIndex: number; testId: string; spent: boolean } | null,
    witnessUnreachable: false,
    sessions: new Map<
      string,
      { sessionId: string; testId: string; workerIndex: number; released: boolean }
    >(),
    slots: new Map<number, string>(),
  };
  return state;
});

vi.mock('../src/supervisor/client.js', async () => {
  // The REAL error class: the drain recovers only a transport-level
  // failure (`status === 0`, outcome unknown), so the fake must throw
  // what the drain's `instanceof` recognizes. Dynamic import is
  // required here: `vi.mock` hoists this factory above every static
  // import in the file, so a top-level static import of
  // witness-client.js is not initialized when the factory runs.
  const { WitnessRequestError } = await import('../src/fixture/witness-client.js');
  const mint = (testId: string, workerIndex: number): string => {
    const sessionId = `sess-${testId}`;
    harness.sessions.set(sessionId, {
      sessionId,
      testId,
      workerIndex,
      released: false,
    });
    harness.slots.set(workerIndex, sessionId);
    return sessionId;
  };
  class SupervisorClient {
    // Plan 20261021_0030_gf_infra_visibility P3: the drain reads its
    // client's per-path timing snapshot in `stop()`.
    timingSnapshot(): Array<{ path: string; count: number; maxMs: number; nearBudget: number; budgetMs: number }> {
      return [];
    }
    async registerObserveDeclarations(): Promise<unknown> {
      harness.calls.push('register:observe');
      return {};
    }
    async registerServerE2eDeclarations(): Promise<unknown> {
      harness.calls.push('register:server');
      return {};
    }
    async openSession(request: {
      testId: string;
      workerIndex: number;
    }): Promise<{ sessionId: string }> {
      const key = `${String(request.workerIndex)}\u0000${request.testId}`;
      harness.attempts.set(key, (harness.attempts.get(key) ?? 0) + 1);
      harness.calls.push(`open:${request.testId}`);
      if (harness.witnessUnreachable) {
        throw new WitnessRequestError(0, 'supervisor call to /sessions/open failed: The operation was aborted');
      }
      // Armed abort: the witness mints and binds the session, the
      // response never reaches the supervisor (the 5 s client timeout
      // fired first) — the exact PM r2 witness-log sequence.
      if (
        harness.abortOpen !== null &&
        !harness.abortOpen.spent &&
        harness.abortOpen.workerIndex === request.workerIndex &&
        harness.abortOpen.testId === request.testId
      ) {
        harness.abortOpen.spent = true;
        mint(request.testId, request.workerIndex);
        throw new WitnessRequestError(0, 'supervisor call to /sessions/open failed: The operation was aborted');
      }
      const bound = harness.slots.get(request.workerIndex);
      if (bound !== undefined) {
        const open = harness.sessions.get(bound);
        if (open !== undefined && open.testId === request.testId && !open.released) {
          // Idempotent re-open of the identical (worker, testId) —
          // the witness answers it with the SAME session.
          harness.calls.push(`opened:${request.testId}`);
          return { sessionId: open.sessionId };
        }
        throw new WitnessRequestError(
          409,
          `worker ${String(request.workerIndex)} already carries an open session for testId ` +
            `'${open === undefined ? bound : open.testId}'; a worker runs one test ` +
            'at a time — close the session before opening another',
        );
      }
      const sessionId = mint(request.testId, request.workerIndex);
      harness.calls.push(`opened:${request.testId}`);
      return { sessionId };
    }
    async releaseSession(request: { sessionId: string }): Promise<unknown> {
      harness.calls.push(`release:${request.sessionId.slice('sess-'.length)}`);
      const record = harness.sessions.get(request.sessionId);
      if (record !== undefined) {
        record.released = true;
        if (harness.slots.get(record.workerIndex) === request.sessionId) {
          harness.slots.delete(record.workerIndex);
        }
      }
      return {};
    }
    async finalizeObserve(): Promise<{ finalized: never[]; notes: string[] }> {
      harness.calls.push('finalize:?');
      return { finalized: [], notes: [] };
    }
    async closeSession(request: { sessionId: string }): Promise<unknown> {
      harness.calls.push(`close:${request.sessionId.slice('sess-'.length)}`);
      harness.sessions.delete(request.sessionId);
      return {};
    }
    async verifyServerPersistence(): Promise<unknown> {
      harness.calls.push('verify:persist');
      return {};
    }
  }
  return { SupervisorClient };
});

const event = (over: Pick<SpoolEvent, 'kind' | 'testId'> & Partial<SpoolEvent>): SpoolEvent => ({
  workerIndex: 0,
  file: 'serial.spec.ts',
  titlePath: ['suite', over.testId],
  project: 'chromium',
  ...over,
});

interface StartedDrain {
  drain: SpoolDrainHandle;
  spoolFile: string;
  dispose: () => Promise<void>;
}

const startDrain = (): StartedDrain => {
  harness.calls.length = 0;
  harness.attempts.clear();
  harness.abortOpen = null;
  harness.witnessUnreachable = false;
  harness.sessions.clear();
  harness.slots.clear();
  const stateDir = mkdtempSync(join(tmpdir(), 'gf-drain-orphan-'));
  const runId = randomUUID();
  const spoolFile = spoolPathFor(stateDir, runId);
  const drain = startSupervisorSpoolDrain({
    stateDir,
    runId,
    witnessUrl: 'http://127.0.0.1:1',
    runToken: 'run-token',
    verifierKey: 'verifier-key',
    pollMs: 5,
  });
  let stopped = false;
  return {
    drain,
    spoolFile,
    dispose: async () => {
      if (!stopped) {
        stopped = true;
        await drain.stop();
      }
      rmSync(stateDir, { recursive: true, force: true });
    },
  };
};

describe('supervisor drain: recovery of an open aborted after the witness minted the session', () => {
  it('reclaims the orphaned session so the next test on the worker still opens', async () => {
    const started = startDrain();
    try {
      // A's open aborts AFTER the fake witness bound sess-A to worker 0.
      harness.abortOpen = { workerIndex: 0, testId: 'A', spent: false };
      // Full serial lifecycle for A (whose open aborted) and B (the
      // innocent next test on the same worker).
      appendSpoolEvent(started.spoolFile, event({ kind: 'testBegin', testId: 'A' }));
      appendSpoolEvent(started.spoolFile, event({ kind: 'testEnd', testId: 'A' }));
      appendSpoolEvent(
        started.spoolFile,
        event({ kind: 'testEnd', testId: 'A', outcome: 'passed', attempt: 1 }),
      );
      appendSpoolEvent(started.spoolFile, event({ kind: 'testBegin', testId: 'B' }));
      appendSpoolEvent(started.spoolFile, event({ kind: 'testEnd', testId: 'B' }));
      appendSpoolEvent(
        started.spoolFile,
        event({ kind: 'testEnd', testId: 'B', outcome: 'passed', attempt: 1 }),
      );
      const stopped = await started.drain.stop();
      // The drain reclaimed the committed session with ONE idempotent
      // re-open — never a retry loop.
      expect(harness.attempts.get('0\u0000A')).toBe(2);
      expect(harness.calls).toContain('opened:A');
      // The reclaimed session is the witness's own: A's ends released
      // and sealed IT, so the worker binding died with the run.
      expect(harness.calls).toContain('release:A');
      expect(harness.calls).toContain('close:A');
      // B's begin was not 409-refused by A's orphan: B opened, ran and
      // sealed — the innocent next test keeps its session.
      expect(harness.calls).toContain('opened:B');
      expect(harness.calls).toContain('close:B');
      expect(stopped.conflicts).toEqual([]);
    } finally {
      await started.dispose();
    }
  });

  it('still fails closed when the recovery attempt fails too, with no retry loop', async () => {
    const started = startDrain();
    try {
      // The witness never answers: every open attempt throws the
      // transport error and commits nothing (unreachable witness).
      harness.witnessUnreachable = true;
      appendSpoolEvent(started.spoolFile, event({ kind: 'testBegin', testId: 'A' }));
      appendSpoolEvent(started.spoolFile, event({ kind: 'testEnd', testId: 'A' }));
      appendSpoolEvent(
        started.spoolFile,
        event({ kind: 'testEnd', testId: 'A', outcome: 'passed', attempt: 1 }),
      );
      const stopped = await started.drain.stop();
      // Exactly ONE recovery attempt after the first failure — never a
      // blind retry loop.
      expect(harness.attempts.get('0\u0000A')).toBe(2);
      expect(harness.calls).not.toContain('opened:A');
      // The test never got a session: no slot, no release, no seal, and
      // no lifecycle conflict — it fails closed downstream (unchanged).
      expect(harness.calls).not.toContain('release:A');
      expect(harness.calls).not.toContain('close:A');
      expect(stopped.conflicts).toEqual([]);
    } finally {
      await started.dispose();
    }
  });

  it('never retries a definite refusal (a busy worker slot stays 409)', async () => {
    const started = startDrain();
    try {
      // An orphan already bound on the witness (produced elsewhere — an
      // older run or a double transport failure): a new test's open
      // over it is a DEFINITE refusal, its outcome is known, so the
      // drain must not spend a second call on it.
      harness.sessions.set('sess-PREV', {
        sessionId: 'sess-PREV',
        testId: 'PREV',
        workerIndex: 0,
        released: false,
      });
      harness.slots.set(0, 'sess-PREV');
      appendSpoolEvent(started.spoolFile, event({ kind: 'testBegin', testId: 'NEXT' }));
      appendSpoolEvent(started.spoolFile, event({ kind: 'testEnd', testId: 'NEXT' }));
      appendSpoolEvent(
        started.spoolFile,
        event({ kind: 'testEnd', testId: 'NEXT', outcome: 'passed', attempt: 1 }),
      );
      const stopped = await started.drain.stop();
      expect(harness.attempts.get('0\u0000NEXT')).toBe(1);
      expect(harness.calls).not.toContain('opened:NEXT');
      // The refused begin's ends are not lifecycle conflicts (the begin
      // was seen; the witness-side refusal is the enforcement) —
      // unchanged fail-closed surface.
      expect(stopped.conflicts).toEqual([]);
    } finally {
      await started.dispose();
    }
  });
});
