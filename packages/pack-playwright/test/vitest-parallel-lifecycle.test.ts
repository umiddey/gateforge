/**
 * Non-Playwright lifecycle tests for a REAL multi-test project (the
 * two defects a real vitest run hits and a one-test fixture never
 * does). Both live on the runner side of the channel, so they are
 * pinned here:
 *
 * 1. PARALLEL FILES, ONE FLAT SLOT. Vitest runs test FILES in parallel
 *    while running the tests inside a file one at a time, and the pack
 *    used to announce every test on worker slot 0 — so a second file
 *    beginning while the first was still running was failed closed as a
 *    forged lifecycle. The slot is now derived from the test file
 *    (`vitestWorkerSlot`), identically in the reporter's main process
 *    and in the worker's helper.
 *
 * 2. A LATE END. Even on ONE slot the running test announces its own
 *    begin promptly (the main-process reporter lags), so the next test's
 *    begin can arrive before the previous test's end has travelled
 *    back. Such a begin now waits for the slot and opens the moment it
 *    frees — both tests still hold a sealed passed session, and the
 *    lifecycle-conflict checks stay exactly as strict as before.
 *
 * Real loopback HTTP (a stub witness is only the drain's wire
 * contract), real spool files, no mocks of the code under test.
 */
import { describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { startSupervisorSpoolDrain } from '../src/supervisor/drain.js';
import { appendSpoolEvent, spoolPathFor } from '../src/supervisor/index.js';
import { vitestWorkerSlot } from '../src/vitest/worker-slot.js';

/** One wire call the stub witness recorded. */
interface StubCall {
  path: string;
  body: Record<string, unknown>;
}

/**
 * A stub witness: the drain's contract under test is the WIRE it
 * speaks (which session it opens, for which test and worker slot, and
 * what it seals), so the calls it records ARE the observable. Real
 * loopback HTTP, no mocking of the code under test.
 */
async function startStubWitness(): Promise<{
  url: string;
  calls: StubCall[];
  stop: () => Promise<void>;
}> {
  const calls: StubCall[] = [];
  let sessions = 0;
  const server: Server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk: Buffer) => {
      raw += chunk.toString();
    });
    req.on('end', () => {
      const url = req.url ?? '/';
      const body = (raw.length > 0 ? JSON.parse(raw) : {}) as Record<string, unknown>;
      calls.push({ path: url, body });
      const answer = (status: number, payload: unknown): void => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(payload));
      };
      if (url === '/sessions/open') {
        sessions += 1;
        // The minted id is recorded on the call too: a later seal names
        // the SESSION, so the calls alone must say which test it was.
        const recorded = calls[calls.length - 1];
        if (recorded !== undefined) recorded.body['sessionId'] = `session-${sessions}`;
        answer(200, {
          sessionId: `session-${sessions}`,
          sessionToken: `token-${sessions}`,
          testId: body['testId'],
          workerIndex: body['workerIndex'],
          openedTick: sessions,
          proxyUrl: null,
          claims: [],
        });
        return;
      }
      if (url === '/sessions/close') {
        answer(200, { sealed: true });
        return;
      }
      answer(404, { error: 'stub: unknown path' });
    });
  });
  await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', () => resolveListen()));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('stub witness failed to bind');
  return {
    url: `http://127.0.0.1:${address.port}`,
    calls,
    stop: () => new Promise<void>((resolveClose) => server.close(() => resolveClose())),
  };
}

/**
 * Waits until the stub witness has recorded `count` calls to `path`.
 *
 * Args:
 *   calls: the recorded calls.
 *   path: the wire path to count.
 *   count: how many calls must have arrived.
 *
 * Returns:
 *   Promise<void>: resolves once the count is reached.
 *
 * Throws:
 *   Error: when the count is not reached in time.
 */
async function waitForCalls(calls: readonly StubCall[], path: string, count: number): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (calls.filter((call) => call.path === path).length >= count) return;
    await new Promise((resolveTick) => setTimeout(resolveTick, 5));
  }
  if (count > 0) throw new Error(`timed out waiting for ${String(count)}x ${path}`);
}

/** One lifecycle event pair a stub witness records. */
function lifecycle(testId: string, workerIndex: number): {
  begin: Parameters<typeof appendSpoolEvent>[1];
  end: Parameters<typeof appendSpoolEvent>[1];
} {
  return {
    begin: {
      kind: 'testBegin',
      testId,
      workerIndex,
      file: testId.split('#')[0] ?? '',
      titlePath: [testId],
      project: null,
    },
    end: {
      kind: 'testEnd',
      testId,
      workerIndex,
      file: testId.split('#')[0] ?? '',
      titlePath: [testId],
      project: null,
      outcome: 'passed',
      attempt: 1,
    },
  };
}

/** The (testId, workerIndex) pairs the stub witness was asked to open. */
function openedSessions(calls: readonly StubCall[]): Array<[string, number]> {
  return calls
    .filter((call) => call.path === '/sessions/open')
    .map((call) => [String(call.body['testId']), Number(call.body['workerIndex'])] as [string, number]);
}

/**
 * The (testId, outcome) pairs the stub witness was asked to seal, in
 * seal order. A seal names the SESSION, so the session→test mapping
 * recorded at open time is what identifies the sealed test.
 */
function sealedSessions(calls: readonly StubCall[]): Array<[string, unknown]> {
  const testIdBySession = new Map<string, string>();
  for (const call of calls) {
    if (call.path !== '/sessions/open') continue;
    testIdBySession.set(String(call.body['sessionId']), String(call.body['testId']));
  }
  return calls
    .filter((call) => call.path === '/sessions/close')
    .map((call) => [
      testIdBySession.get(String(call.body['sessionId'])) ?? '',
      call.body['outcome'],
    ] as [string, unknown]);
}

describe('the derived vitest worker slot', () => {
  it('is a positive JSON-safe integer and never zero', () => {
    const slot = vitestWorkerSlot('tests/accounts.test.mjs');
    expect(Number.isSafeInteger(slot)).toBe(true);
    expect(slot).toBeGreaterThan(0);
  });

  it('is stable across processes (both sides derive the same slot)', () => {
    // The reporter (vitest's main process) and the in-test helper (the
    // worker) compute this independently; a drift between them is
    // exactly the session mismatch this slot exists to prevent.
    expect(vitestWorkerSlot('tests/accounts.test.mjs')).toBe(vitestWorkerSlot('tests/accounts.test.mjs'));
  });

  it('gives two files of one parallel run different slots', () => {
    expect(vitestWorkerSlot('tests/first.test.mjs')).not.toBe(vitestWorkerSlot('tests/second.test.mjs'));
  });

  it('distinguishes files whose names differ only in a suffix', () => {
    expect(vitestWorkerSlot('tests/accounts.test.mjs')).not.toBe(vitestWorkerSlot('tests/accounts.spec.mjs'));
  });
});

describe('a parallel vitest project holds one session per running test', () => {
  it('opens both files concurrently and seals both as passed, with no conflict', async () => {
    const stub = await startStubWitness();
    const stateDir = mkdtempSync(join(tmpdir(), 'vitest-parallel-drain-'));
    const runId = randomUUID();
    const spoolFile = spoolPathFor(stateDir, runId);
    const drain = startSupervisorSpoolDrain({
      stateDir,
      runId,
      witnessUrl: stub.url,
      runToken: 'token',
      verifierKey: 'verifier',
      pollMs: 5,
    });
    try {
      const first = lifecycle('tests/first.test.mjs#first', vitestWorkerSlot('tests/first.test.mjs'));
      const second = lifecycle('tests/second.test.mjs#second', vitestWorkerSlot('tests/second.test.mjs'));
      // Both files run at the same time: the second begin arrives while
      // the first session is open.
      appendSpoolEvent(spoolFile, first.begin);
      appendSpoolEvent(spoolFile, second.begin);
      await waitForCalls(stub.calls, '/sessions/open', 2);
      appendSpoolEvent(spoolFile, second.end);
      appendSpoolEvent(spoolFile, first.end);
      await waitForCalls(stub.calls, '/sessions/close', 2);
      const { conflicts } = await drain.stop();
      expect(conflicts).toEqual([]);
      expect(sealedSessions(stub.calls).map(([testId]) => testId).sort()).toEqual([
        'tests/first.test.mjs#first',
        'tests/second.test.mjs#second',
      ]);
      expect(sealedSessions(stub.calls).every(([, outcome]) => outcome === 'passed')).toBe(true);
    } finally {
      await stub.stop();
    }
  });

  it('queues a begin that arrives before the previous test on the slot ends', async () => {
    const stub = await startStubWitness();
    const stateDir = mkdtempSync(join(tmpdir(), 'vitest-late-end-drain-'));
    const runId = randomUUID();
    const spoolFile = spoolPathFor(stateDir, runId);
    const drain = startSupervisorSpoolDrain({
      stateDir,
      runId,
      witnessUrl: stub.url,
      runToken: 'token',
      verifierKey: 'verifier',
      pollMs: 5,
    });
    try {
      const slot = vitestWorkerSlot('tests/one-file.test.mjs');
      const first = lifecycle('tests/one-file.test.mjs#first', slot);
      const second = lifecycle('tests/one-file.test.mjs#second', slot);
      // The serial reality inside ONE file: the worker announces the
      // second test's begin before the reporter's end for the first
      // test has travelled back to the drain.
      appendSpoolEvent(spoolFile, first.begin);
      await waitForCalls(stub.calls, '/sessions/open', 1);
      appendSpoolEvent(spoolFile, second.begin);
      await new Promise((resolveSettle) => setTimeout(resolveSettle, 120));
      // The queued begin opened NOTHING yet: one worker slot carries
      // one session at a time, so nothing is credited early.
      expect(openedSessions(stub.calls)).toHaveLength(1);
      appendSpoolEvent(spoolFile, first.end);
      await waitForCalls(stub.calls, '/sessions/open', 2);
      appendSpoolEvent(spoolFile, second.end);
      await waitForCalls(stub.calls, '/sessions/close', 2);
      const { conflicts } = await drain.stop();
      expect(conflicts).toEqual([]);
      expect(sealedSessions(stub.calls).map(([testId]) => testId).sort()).toEqual([
        'tests/one-file.test.mjs#first',
        'tests/one-file.test.mjs#second',
      ]);
    } finally {
      await stub.stop();
    }
  });

  it('still fails closed on a re-begun ended test and on a lone end', async () => {
    const stub = await startStubWitness();
    const stateDir = mkdtempSync(join(tmpdir(), 'vitest-conflict-drain-'));
    const runId = randomUUID();
    const spoolFile = spoolPathFor(stateDir, runId);
    const drain = startSupervisorSpoolDrain({
      stateDir,
      runId,
      witnessUrl: stub.url,
      runToken: 'token',
      verifierKey: 'verifier',
      pollMs: 5,
    });
    try {
      const test = lifecycle('tests/one-file.test.mjs#only', 7);
      // A lone end first: it never opens or seals anything.
      appendSpoolEvent(spoolFile, test.end);
      await waitForCalls(stub.calls, '/sessions/open', 0).catch(() => undefined);
      appendSpoolEvent(spoolFile, test.begin);
      await waitForCalls(stub.calls, '/sessions/open', 1);
      appendSpoolEvent(spoolFile, test.end);
      await waitForCalls(stub.calls, '/sessions/close', 1);
      // A second lifecycle for the SAME test is never genuine.
      appendSpoolEvent(spoolFile, test.begin);
      await new Promise((resolveSettle) => setTimeout(resolveSettle, 120));
      const { conflicts } = await drain.stop();
      expect(conflicts.join('\n')).toMatch(/lone end/);
      expect(conflicts.join('\n')).toMatch(/re-began already-ended test/);
      // The forged re-begin minted no second session.
      expect(openedSessions(stub.calls)).toHaveLength(1);
    } finally {
      await stub.stop();
    }
  });
});
