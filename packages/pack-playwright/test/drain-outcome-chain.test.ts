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
}

const harness = vi.hoisted(() => {
  const state: ClientHarness = { calls: [], gateA: null };
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
      harness.calls.push(`close:${testIdOf(request.sessionId)}`);
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
  stateDir: string;
  dispose: () => Promise<void>;
}

const startDrain = (): StartedDrain => {
  harness.calls.length = 0;
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
