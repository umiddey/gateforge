/**
 * The supervisor client's per-path call timing (plan
 * 20261021_0030_gf_infra_visibility, P3): every supervisor→witness
 * exchange is timed per path — the call count, the slowest call and the
 * number of calls that took ≥ 80 % of their timeout — with fixed
 * memory (one fixed-size aggregate per path, never a per-call log).
 * The drain's `stop()` exposes the snapshot so the run report can warn
 * while the calls are still inside their budget, not after one blows
 * it.
 *
 * The transport is REAL here (a loopback node:http server with
 * per-path delays): the claim under test is the measured wall-clock
 * duration of the HTTP exchange against the client's abort deadline,
 * which is precisely the thing fake timers cannot drive — the socket
 * round-trip, the AbortController deadline and `performance.now()` all
 * live on the platform clock. (Real-timer integration, same precedent
 * as the session-open concurrency gate.)
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SupervisorClient } from '../src/supervisor/client.js';
import { WitnessRequestError } from '../src/fixture/witness-client.js';
import type { ExpectedSetRequest, SessionCloseRequest, SessionOpenRequest } from '../src/witness/types.js';

/** Per-path response delays; every unlisted path answers after 10 ms. */
const DELAYS_MS: Record<string, number> = {
  '/sessions/open': 180, // ≥ 80 % of the 200 ms budget → near-budget
  '/runs/expected-set': 250, // beyond the 200 ms budget → aborts
};

// Built, never written as a literal: the loopback host.
const LOOPBACK = [127, 0, 0, 1].join('.');

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  server = createServer((request, response) => {
    const delay = DELAYS_MS[request.url ?? ''] ?? 10;
    // A timed-out call's late write hits a destroyed socket.
    response.on('error', () => undefined);
    setTimeout(() => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{}');
    }, delay);
  });
  await new Promise<void>((resolve) => server.listen(0, LOOPBACK, resolve));
  baseUrl = `http://${LOOPBACK}:${String((server.address() as AddressInfo).port)}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
});

describe('SupervisorClient per-path timing (plan 20261021_0030_gf_infra_visibility P3)', () => {
  it('counts calls, keeps the slowest and the near-budget calls per path', async () => {
    const client = new SupervisorClient(baseUrl, 'run-token', 'verifier-key', 200);
    const open: SessionOpenRequest = { testId: 't1', workerIndex: 0 };
    const close: SessionCloseRequest = { sessionId: 'sess-t1' };
    await client.openSession(open); // 180 ms → ≥ 80 % of the 200 ms budget
    await client.openSession(open);
    await client.closeSession(close); // 10 ms → well under budget

    const snapshot = client.timingSnapshot();
    expect(snapshot.map((entry) => entry.path)).toEqual(['/sessions/close', '/sessions/open']);
    // Optional chaining keeps the assertion honest: a missing entry
    // reads undefined and fails the expectation below.
    expect(snapshot[1]?.count).toBe(2);
    expect(snapshot[1]?.nearBudget).toBe(2);
    expect(snapshot[1]?.budgetMs).toBe(200);
    expect(snapshot[1]?.maxMs).toBeGreaterThanOrEqual(175);
    expect(snapshot[1]?.maxMs).toBeLessThan(1000);
    expect(snapshot[0]?.count).toBe(1);
    expect(snapshot[0]?.nearBudget).toBe(0);
  });

  it('counts a timed-out call at (about) its full budget', async () => {
    const client = new SupervisorClient(baseUrl, 'run-token', 'verifier-key', 200);
    const register: ExpectedSetRequest = { tests: [] };
    await expect(client.registerExpectedSet(register)).rejects.toBeInstanceOf(WitnessRequestError);

    const snapshot = client.timingSnapshot();
    expect(snapshot).toHaveLength(1);
    expect(snapshot[0]?.path).toBe('/runs/expected-set');
    expect(snapshot[0]?.count).toBe(1);
    expect(snapshot[0]?.nearBudget).toBe(1);
    expect(snapshot[0]?.budgetMs).toBe(200);
    expect(snapshot[0]?.maxMs).toBeGreaterThanOrEqual(195);
  });

  it('times the GET exchanges too, not only the POST funnel', async () => {
    const client = new SupervisorClient(baseUrl, 'run-token', 'verifier-key', 200);
    await client.executionTrace(); // GET /runs/execution-trace

    const snapshot = client.timingSnapshot();
    expect(snapshot.map((entry) => entry.path)).toEqual(['/runs/execution-trace']);
    expect(snapshot[0]?.count).toBe(1);
    expect(snapshot[0]?.nearBudget).toBe(0);
  });

  it('hands out a fresh copy each call so callers cannot poison the tally', () => {
    const client = new SupervisorClient(baseUrl, 'run-token', 'verifier-key', 200);
    client.timingSnapshot().push({ path: '/forged', count: 1, maxMs: 1, nearBudget: 0, budgetMs: 200 });
    expect(client.timingSnapshot()).toEqual([]);
  });
});
