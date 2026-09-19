/**
 * Observe-channel tests (drain side, Phase 2): the trusted CLI drain
 * registers the observe declarations pre-run and finalizes PASSED
 * sessions before sealing them. Stub witness HTTP (the drain's
 * contract is the wire, not the witness): proves registration happens
 * before any session opens, finalize fires exactly once per passed
 * test (before its seal), failed tests never finalize, and finalize
 * notes surface on stop — never run-fatal.
 */
import { describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { startSupervisorSpoolDrain } from '../src/supervisor/drain.js';
import { appendSpoolEvent, spoolPathFor } from '../src/supervisor/index.js';

const CREATE_CLAIM = 'tenant.accounts:persistence:create';

interface StubCall {
  path: string;
  body: Record<string, unknown>;
}

async function startStubWitness(options: { finalizeNotes?: string[] } = {}): Promise<{
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
      if (url === '/runs/observe-declarations') {
        answer(200, { bound: true, count: (body['obligations'] as unknown[]).length, obligations: body['obligations'] });
        return;
      }
      if (url === '/sessions/open') {
        sessions += 1;
        answer(200, {
          sessionId: `session-${sessions}`,
          sessionToken: `token-${sessions}`,
          testId: body['testId'],
          workerIndex: body['workerIndex'],
          openedTick: sessions,
          proxyUrl: null,
          claims: body['claims'] ?? [],
        });
        return;
      }
      if (url === '/observe/finalize') {
        answer(200, {
          finalized: [{ obligationId: CREATE_CLAIM, recordId: 'a'.repeat(64), operation: 'create', entityId: '2' }],
          notes: options.finalizeNotes ?? [],
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

async function waitFor(calls: StubCall[], path: string, count: number): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (calls.filter((call) => call.path === path).length >= count) return;
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 10));
  }
  throw new Error(`timed out waiting for ${count}x ${path}`);
}

describe('supervisor drain observe wiring', () => {
  it('registers declarations pre-run, finalizes passed tests before seal, skips failed tests', async () => {
    const stub = await startStubWitness();
    const stateDir = mkdtempSync(join(tmpdir(), 'observe-drain-'));
    const runId = randomUUID();
    const spoolFile = spoolPathFor(stateDir, runId);
    const drain = startSupervisorSpoolDrain({
      stateDir,
      runId,
      witnessUrl: stub.url,
      runToken: 'token',
      verifierKey: 'verifier',
      pollMs: 5,
      observeObligations: [CREATE_CLAIM],
    });
    try {
      const begin = (testId: string, workerIndex: number): void => {
        appendSpoolEvent(spoolFile, {
          kind: 'testBegin',
          testId,
          workerIndex,
          file: 'e2e/accounts.spec.js',
          titlePath: [testId],
          project: 'chromium',
          claims: [CREATE_CLAIM],
        });
      };
      begin('passed-test', 0);
      await waitFor(stub.calls, '/sessions/open', 1);
      appendSpoolEvent(spoolFile, {
        kind: 'testEnd',
        testId: 'passed-test',
        workerIndex: 0,
        file: 'e2e/accounts.spec.js',
        titlePath: ['passed-test'],
        project: 'chromium',
        outcome: 'passed',
      });
      await waitFor(stub.calls, '/observe/finalize', 1);
      begin('failed-test', 0);
      await waitFor(stub.calls, '/sessions/open', 2);
      appendSpoolEvent(spoolFile, {
        kind: 'testEnd',
        testId: 'failed-test',
        workerIndex: 0,
        file: 'e2e/accounts.spec.js',
        titlePath: ['failed-test'],
        project: 'chromium',
        outcome: 'failed',
      });
      // Let the failed end drain through (its seal lands, no finalize).
      await waitFor(stub.calls, '/sessions/close', 2);
      const stopped = await drain.stop();
      expect(stopped.conflicts).toEqual([]);
      expect(stopped.observeNotes).toEqual([]);
      const finalizeCalls = stub.calls.filter((call) => call.path === '/observe/finalize');
      expect(finalizeCalls).toHaveLength(1);
      expect(finalizeCalls[0]?.body).toMatchObject({ sessionId: 'session-1' });
      // Registration preceded every session open (pre-run fact).
      const openedAt = stub.calls.findIndex((call) => call.path === '/sessions/open');
      const declaredAt = stub.calls.findIndex((call) => call.path === '/runs/observe-declarations');
      expect(declaredAt).toBeGreaterThanOrEqual(0);
      expect(declaredAt).toBeLessThan(openedAt);
      // Finalize preceded its session's seal.
      const finalizedAt = stub.calls.findIndex((call) => call.path === '/observe/finalize');
      const firstSealAt = stub.calls.findIndex((call) => call.path === '/sessions/close');
      expect(finalizedAt).toBeLessThan(firstSealAt);
    } finally {
      await stub.stop();
    }
  });

  it('surfaces finalize notes on stop without failing the run', async () => {
    const stub = await startStubWitness({ finalizeNotes: ['observe notes the miss'] });
    const stateDir = mkdtempSync(join(tmpdir(), 'observe-drain-notes-'));
    const runId = randomUUID();
    const spoolFile = spoolPathFor(stateDir, runId);
    const drain = startSupervisorSpoolDrain({
      stateDir,
      runId,
      witnessUrl: stub.url,
      runToken: 'token',
      verifierKey: 'verifier',
      pollMs: 5,
      observeObligations: [CREATE_CLAIM],
    });
    try {
      appendSpoolEvent(spoolFile, {
        kind: 'testBegin',
        testId: 'lonely-test',
        workerIndex: 0,
        file: 'e2e/accounts.spec.js',
        titlePath: ['lonely-test'],
        project: 'chromium',
        claims: [CREATE_CLAIM],
      });
      await waitFor(stub.calls, '/sessions/open', 1);
      appendSpoolEvent(spoolFile, {
        kind: 'testEnd',
        testId: 'lonely-test',
        workerIndex: 0,
        file: 'e2e/accounts.spec.js',
        titlePath: ['lonely-test'],
        project: 'chromium',
        outcome: 'passed',
      });
      await waitFor(stub.calls, '/observe/finalize', 1);
      const stopped = await drain.stop();
      // Notes collected, no conflicts, no intent failures: diagnostics,
      // never run-fatal (the obligation stays blocking via verdicts).
      expect(stopped.conflicts).toEqual([]);
      expect(stopped.intentFailures).toEqual([]);
      expect(stopped.observeNotes).toHaveLength(1);
      expect(stopped.observeNotes[0]).toContain('lonely-test');
    } finally {
      await stub.stop();
    }
  });
});
