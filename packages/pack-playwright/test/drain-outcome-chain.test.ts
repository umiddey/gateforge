/**
 * The drain's outcome-end scheduling (plan
 * 20261020_1800_gf_drain_begin_not_behind_finalize): a PASSED test's
 * observe finalize can take seconds (adapter reads over HTTP). While it
 * ran, the fully-serial drain delayed EVERY later spool event —
 * including the next test's `testBegin` — long enough for that test's
 * worker to give up its 5 s session wait ("No supervisor-issued witness
 * session"). These tests pin the contract after the fix:
 *
 * - the next test's session open happens while the previous test's
 *   finalize is still in flight (the red→green edge);
 * - finalize still precedes seal for the same session;
 * - `stop()` returns only after every off-path chain settled, and the
 *   report carries the chain's observe notes;
 * - a failed outcome never finalizes (unchanged);
 * - lifecycle conflicts still fail closed (unchanged).
 *
 * The witness transport (`SupervisorClient`) is the unit boundary here:
 * the claim under test is the DRAIN's event scheduling, not the HTTP
 * layer, so the client is a recording fake and everything the drain
 * does around it — spool reads, slot bookkeeping, chain ordering — is
 * the real implementation.
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
  /** Every fake client call in order, `verb:testId` shaped. */
  calls: string[];
  /** When armed, test A's finalizeObserve blocks until opened. */
  gateA: { promise: Promise<void>; open: () => void } | null;
  /** When set, closeSession for this testId throws a plain Error. */
  failCloseFor: string | null;
  /** When set, openSession for this testId throws a plain Error. */
  failOpenFor: string | null;
  /** The fake client's per-path timing snapshot (plan …P3). */
  timing: Array<{ path: string; count: number; maxMs: number; nearBudget: number; budgetMs: number }>;
}

const harness = vi.hoisted(() => {
  const state: ClientHarness = {
    calls: [],
    gateA: null,
    failCloseFor: null,
    failOpenFor: null,
    timing: [],
  };
  return state;
});

vi.mock('../src/supervisor/client.js', () => {
  const testIdOf = (sessionId: string): string => sessionId.slice('sess-'.length);
  class SupervisorClient {
    async registerObserveDeclarations(): Promise<unknown> {
      harness.calls.push('register:observe');
      return {};
    }
    async registerServerE2eDeclarations(): Promise<unknown> {
      harness.calls.push('register:server');
      return {};
    }
    async openSession(request: { testId: string }): Promise<{ sessionId: string }> {
      harness.calls.push(`open:${request.testId}`);
      if (harness.failOpenFor === request.testId) throw new Error('open exploded');
      return { sessionId: `sess-${request.testId}` };
    }
    async releaseSession(request: { sessionId: string }): Promise<unknown> {
      harness.calls.push(`release:${testIdOf(request.sessionId)}`);
      return {};
    }
    async finalizeObserve(request: {
      sessionId: string;
    }): Promise<{ finalized: never[]; notes: string[] }> {
      const testId = testIdOf(request.sessionId);
      harness.calls.push(`finalize:${testId}`);
      if (testId === 'A' && harness.gateA !== null) await harness.gateA.promise;
      return { finalized: [], notes: [`finalize ran for '${testId}'`] };
    }
    async closeSession(request: { sessionId: string }): Promise<unknown> {
      const testId = testIdOf(request.sessionId);
      harness.calls.push(`close:${testId}`);
      if (harness.failCloseFor === testId) throw new Error('close exploded');
      return {};
    }
    async verifyServerPersistence(): Promise<unknown> {
      harness.calls.push('verify:persist');
      return {};
    }
    // Plan 20261021_0030_gf_infra_visibility P3: the drain reads its
    // client's per-path timing snapshot in `stop()`.
    timingSnapshot(): Array<{ path: string; count: number; maxMs: number; nearBudget: number; budgetMs: number }> {
      return [...harness.timing];
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
  stateDir: string;
  dispose: () => Promise<void>;
}

const startDrain = (): StartedDrain => {
  harness.calls.length = 0;
  harness.failCloseFor = null;
  harness.failOpenFor = null;
  harness.timing = [];
  let openGate: () => void = () => undefined;
  const gatePromise = new Promise<void>((resolve) => {
    openGate = resolve;
  });
  harness.gateA = { promise: gatePromise, open: openGate };
  const stateDir = mkdtempSync(join(tmpdir(), 'gf-drain-chain-'));
  const runId = randomUUID();
  const spoolFile = spoolPathFor(stateDir, runId);
  const drain = startSupervisorSpoolDrain({
    stateDir,
    runId,
    witnessUrl: 'http://127.0.0.1:1',
    runToken: 'run-token',
    verifierKey: 'verifier-key',
    pollMs: 5,
    observeObligations: ['res:contract'],
  });
  let stopped = false;
  return {
    drain,
    spoolFile,
    stateDir,
    dispose: async () => {
      // A blocked finalize must never wedge disposal: open the gate,
      // then stop exactly once so the chain settles like stop() demands.
      harness.gateA?.open();
      if (!stopped) {
        stopped = true;
        await drain.stop();
      }
      rmSync(stateDir, { recursive: true, force: true });
    },
  };
};

describe('supervisor drain: outcome chains off the session-open critical path', () => {
  it('opens the next test session while the previous test finalize is still in flight', async () => {
    const started = startDrain();
    try {
      // Serial project, one worker: A begins; A's WORKER-side end
      // releases the slot; A's runner outcome end arrives BEFORE B's
      // begin in the spool (the runner main process reported while the
      // worker had not begun the next test yet — the loaded-machine
      // ordering from PM CI job 17319067092).
      appendSpoolEvent(started.spoolFile, event({ kind: 'testBegin', testId: 'A' }));
      appendSpoolEvent(started.spoolFile, event({ kind: 'testEnd', testId: 'A' }));
      appendSpoolEvent(
        started.spoolFile,
        event({ kind: 'testEnd', testId: 'A', outcome: 'passed', attempt: 1 }),
      );
      appendSpoolEvent(started.spoolFile, event({ kind: 'testBegin', testId: 'B' }));

      // A's finalize starts and blocks on the gate.
      await vi.waitFor(() => expect(harness.calls).toContain('finalize:A'), { timeout: 5_000 });
      // The gate is still closed, so A's finalize has NOT resolved. B's
      // open must happen anyway — behind the old serial drain this
      // bounded wait elapsed with B still unopened, which is exactly
      // the fixture's "No supervisor-issued witness session" failure.
      await vi.waitFor(() => expect(harness.calls).toContain('open:B'), { timeout: 2_000 });
      // Release A's finalize: the seal must still FOLLOW it.
      harness.gateA?.open();
      const stopped = await started.drain.stop();
      expect(harness.calls.indexOf('finalize:A')).toBeLessThan(harness.calls.indexOf('close:A'));
      // B's open also preceded A's seal: B's whole session open ran
      // inside A's finalize→seal window instead of behind it.
      expect(harness.calls.indexOf('open:B')).toBeLessThan(harness.calls.indexOf('close:A'));
      // stop() awaited the chain: the report carries the chain's
      // observe note, and the release path recorded no conflict.
      expect(stopped.observeNotes).toHaveLength(1);
      expect(stopped.observeNotes[0]).toContain("test 'A'");
      expect(stopped.conflicts).toEqual([]);
    } finally {
      await started.dispose();
    }
  });

  it('never finalizes a failed outcome and still seals it', async () => {
    const started = startDrain();
    try {
      appendSpoolEvent(started.spoolFile, event({ kind: 'testBegin', testId: 'F' }));
      appendSpoolEvent(started.spoolFile, event({ kind: 'testEnd', testId: 'F' }));
      appendSpoolEvent(
        started.spoolFile,
        event({ kind: 'testEnd', testId: 'F', outcome: 'failed', attempt: 1 }),
      );
      const stopped = await started.drain.stop();
      expect(harness.calls).toContain('close:F');
      expect(harness.calls).not.toContain('finalize:F');
      expect(stopped.observeNotes).toEqual([]);
      expect(stopped.conflicts).toEqual([]);
    } finally {
      await started.dispose();
    }
  });

  it('still fails closed on an end whose begin never arrived', async () => {
    const started = startDrain();
    try {
      appendSpoolEvent(
        started.spoolFile,
        event({ kind: 'testEnd', testId: 'lonely', workerIndex: 3, outcome: 'passed' }),
      );
      const stopped = await started.drain.stop();
      expect(stopped.conflicts.length).toBeGreaterThan(0);
      expect(stopped.conflicts[0]).toContain("'lonely'");
    } finally {
      await started.dispose();
    }
  });
});

describe('supervisor drain: per-path call timing exposure (plan 20261021_0030_gf_infra_visibility P3)', () => {
  it('stop() returns the drain client per-path timing snapshot', async () => {
    const started = startDrain();
    harness.timing = [{ path: '/sessions/open', count: 3, maxMs: 4600, nearBudget: 3, budgetMs: 5000 }];
    try {
      appendSpoolEvent(started.spoolFile, event({ kind: 'testBegin', testId: 'T' }));
      appendSpoolEvent(started.spoolFile, event({ kind: 'testEnd', testId: 'T' }));
      appendSpoolEvent(
        started.spoolFile,
        event({ kind: 'testEnd', testId: 'T', outcome: 'passed', attempt: 1 }),
      );
      const stopped = await started.drain.stop();
      expect(stopped.supervisorTiming).toEqual(harness.timing);
    } finally {
      await started.dispose();
    }
  });
});

describe('supervisor drain: infra event counting (plan 20261021_0030_gf_infra_visibility P2)', () => {
  it('counts an unprocessable lifecycle event as a lifecycle-event infra event', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const started = startDrain();
    harness.failOpenFor = 'L';
    try {
      appendSpoolEvent(started.spoolFile, event({ kind: 'testBegin', testId: 'L' }));
      await vi.waitFor(() => expect(harness.calls).toContain('open:L'), { timeout: 5_000 });
      const stopped = await started.drain.stop();
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("could not process a 'testBegin' event for 'L'"),
      );
      expect(stopped.infraEvents).toEqual([{ kind: 'lifecycle-event', count: 1 }]);
      expect(stopped.conflicts).toEqual([]);
    } finally {
      warn.mockRestore();
      await started.dispose();
    }
  });

  it('counts a failed session seal as a session-close infra event', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const started = startDrain();
    harness.failCloseFor = 'C';
    try {
      appendSpoolEvent(started.spoolFile, event({ kind: 'testBegin', testId: 'C' }));
      appendSpoolEvent(started.spoolFile, event({ kind: 'testEnd', testId: 'C' }));
      appendSpoolEvent(
        started.spoolFile,
        event({ kind: 'testEnd', testId: 'C', outcome: 'failed', attempt: 1 }),
      );
      await vi.waitFor(() => expect(harness.calls).toContain('close:C'), { timeout: 5_000 });
      const stopped = await started.drain.stop();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('supervisor session close failed'));
      expect(stopped.infraEvents).toEqual([{ kind: 'session-close', count: 1 }]);
      expect(stopped.observeNotes).toEqual([]);
    } finally {
      warn.mockRestore();
      await started.dispose();
    }
  });
});
