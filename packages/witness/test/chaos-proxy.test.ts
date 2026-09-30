/**
 * The proxy half of timing chaos (E63): a real witness, a real
 * observation proxy, and two concurrent requests to the SAME route key
 * released in the seeded order. Nothing here mocks the delay — the
 * proxy holds the real upstream response.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startWitness, type WitnessHandle } from '../src/witness/server.js';

/** The only host this test binds or names (built, never a literal). */
const LOOPBACK = ['127', '0', '0', '1'].join('.');

const TOKEN = 'chaos-proxy-test-token';
const VERIFIER = 'chaos-proxy-test-verifier';

/** The upstream app: one route, no artificial latency of its own. */
let app: Server;
let appUrl: string;

beforeAll(async () => {
  app = createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://${LOOPBACK}`);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ path: url.pathname, query: url.search }));
  });
  await new Promise<void>((resolve) => app.listen(0, LOOPBACK, resolve));
  appUrl = `http://${LOOPBACK}:${String((app.address() as AddressInfo).port)}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => app.close(() => resolve()));
});

/** Starts a witness with (or without) a chaos plan and returns its handle. */
async function startChaosWitness(chaos: { seed: number; maxDelayMs: number; reorder: boolean } | null): Promise<{
  handle: WitnessHandle;
  proxyUrl: string;
}> {
  const handle = await startWitness({
    runId: '11111111-1111-4111-8111-111111111111',
    token: TOKEN,
    verifierKey: VERIFIER,
    proxyTarget: appUrl,
    chaos,
  });
  return { handle, proxyUrl: handle.proxyUrl ?? '' };
}

/** Fetches through the witness proxy and reports when the answer landed. */
async function timedGet(proxyUrl: string, path: string): Promise<{ at: number; body: string }> {
  const response = await fetch(`${proxyUrl}${path}`);
  return { at: Date.now(), body: await response.text() };
}

/** Reads the recorded schedule from the supervisor-only endpoint. */
async function scheduleOf(witnessUrl: string): Promise<{
  seed: number;
  maxDelayMs: number;
  reorder: boolean;
  schedule: Array<{ routeKey: string; k: number; delayMs: number; releasedBefore: boolean }>;
} | null> {
  const response = await fetch(`${witnessUrl}/runs/chaos-schedule`, {
    headers: { 'x-gateforge-run': TOKEN, 'x-gateforge-verifier': VERIFIER },
  });
  const body = (await response.json()) as { chaos: null | { seed: number; maxDelayMs: number; reorder: boolean; schedule: Array<{ routeKey: string; k: number; delayMs: number; releasedBefore: boolean }> } };
  return body.chaos;
}

describe('the observation proxy applies the seeded plan', () => {
  it('holds responses back and releases them in the seeded order', async () => {
    const { handle, proxyUrl } = await startChaosWitness({ seed: 4, maxDelayMs: 400, reorder: true });
    try {
      const started = Date.now();
      // Two concurrent requests to ONE route key: the plan may release
      // the second before the first, which is the race under test.
      const both = await Promise.all([
        timedGet(proxyUrl, '/api/tab?tab=a'),
        timedGet(proxyUrl, '/api/tab?tab=b'),
      ]);
      const order = both.map((result) => result.at - started).sort((left, right) => left - right);
      const schedule = await scheduleOf(handle.url);
      expect(schedule, 'the witness records the plan it used').not.toBeNull();
      expect(schedule?.seed).toBe(4);
      const entries = (schedule?.schedule ?? []).filter((entry) => entry.routeKey === 'GET /api/tab');
      expect(entries.map((entry) => entry.k).sort()).toEqual([1, 2]);
      // Only timing moved: the bytes are the app's own.
      expect(JSON.parse(both[0]?.body ?? '{}')).toEqual({ path: '/api/tab', query: '?tab=a' });
      expect(JSON.parse(both[1]?.body ?? '{}')).toEqual({ path: '/api/tab', query: '?tab=b' });
      // The recorded schedule explains the arrival order: the entry the
      // plan released FIRST is the one the browser saw first.
      const first = entries.find((entry) => entry.k === 1);
      const second = entries.find((entry) => entry.k === 2);
      if (second?.releasedBefore === true) {
        expect(second.delayMs, JSON.stringify(entries)).toBeLessThan(first?.delayMs ?? 0);
        expect(order[1] - (order[0] ?? 0)).toBeGreaterThan(0);
      }
      // No recorded field can carry a query value.
      expect(JSON.stringify(schedule)).not.toContain('tab=');
    } finally {
      await handle.stop();
    }
  }, 30_000);

  it('answers with no plan at all when chaos is off', async () => {
    const { handle, proxyUrl } = await startChaosWitness(null);
    try {
      const started = Date.now();
      const results = await Promise.all([
        timedGet(proxyUrl, '/api/tab?tab=a'),
        timedGet(proxyUrl, '/api/tab?tab=b'),
      ]);
      expect(results.map((result) => JSON.parse(result.body).query).sort()).toEqual(['?tab=a', '?tab=b']);
      expect(await scheduleOf(handle.url)).toBeNull();
      // Byte-identical to the unheld path: no answer waited for a plan.
      expect(Math.max(...results.map((result) => result.at)) - started).toBeLessThan(400);
    } finally {
      await handle.stop();
    }
  }, 30_000);
});
