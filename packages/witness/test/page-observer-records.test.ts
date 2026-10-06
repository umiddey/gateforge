import { createServer as createHttpServer } from 'node:http';
import { createServer as createTcpServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { RUN_HEADER, VERIFIER_HEADER } from '../src/constants.js';
import { startWitness, type WitnessHandle } from '../src/witness/server.js';
import type { SessionCredential } from '../src/witness/types.js';

const RUN_ID = '4d813a14-807d-42e7-a6b4-3264f1645790';
const RUN_TOKEN = 'page-observer-records-run-token';
const VERIFIER_KEY = 'page-observer-records-verifier-key';
const APP_FINGERPRINT = 'orders-fixture-v1';
const LOOPBACK = [127, 0, 0, 1].join('.');
const app = createHttpServer((_request, response) => {
  response.writeHead(200, {
    'content-type': 'text/html',
    'x-gateforge-env-fingerprint': APP_FINGERPRINT,
  });
  response.end('<!doctype html><html><body><main>Orders are ready</main></body></html>');
});
let appBaseUrl: string;
let witness: WitnessHandle;
let adaptersDir: string;

interface Answer {
  status: number;
  body: Record<string, unknown>;
}

async function freePort(): Promise<number> {
  const server = createTcpServer();
  server.listen(0, LOOPBACK);
  await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('TCP server did not bind');
  const { port } = address;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function post(path: string, body: unknown, verifier = false): Promise<Answer> {
  const response = await fetch(`${witness.url}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      [RUN_HEADER]: RUN_TOKEN,
      ...(verifier ? { [VERIFIER_HEADER]: VERIFIER_KEY } : {}),
    },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

async function getRecords(): Promise<Array<Record<string, unknown>>> {
  const response = await fetch(`${witness.url}/records`, { headers: { [RUN_HEADER]: RUN_TOKEN } });
  const body = (await response.json()) as { records: Array<Record<string, unknown>> };
  return body.records;
}

async function openSession(testId: string): Promise<SessionCredential> {
  const response = await post('/sessions/open', { runId: RUN_ID, testId, workerIndex: 0 }, true);
  if (response.status !== 200) throw new Error(`session open failed: ${JSON.stringify(response.body)}`);
  return response.body as unknown as SessionCredential;
}

beforeAll(async () => {
  await new Promise<void>((resolve) => app.listen(0, LOOPBACK, resolve));
  const address = app.address() as AddressInfo;
  appBaseUrl = `http://${LOOPBACK}:${String(address.port)}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => app.close(() => resolve()));
});

beforeEach(async () => {
  adaptersDir = mkdtempSync(join(tmpdir(), 'gateforge-page-observer-records-'));
  witness = await startWitness({
    runId: RUN_ID,
    token: RUN_TOKEN,
    verifierKey: VERIFIER_KEY,
    adaptersDir,
    classificationsPath: null,
    adapterBaseUrl: appBaseUrl,
    targetBaseUrl: appBaseUrl,
    targetFingerprint: APP_FINGERPRINT,
  });
});

afterEach(async () => {
  await witness.stop();
  rmSync(adaptersDir, { recursive: true, force: true });
});

describe('page.observed record retention', () => {
  it.each([
    { outcome: 'passed', retained: true },
    { outcome: 'failed', retained: false },
  ])('retains proof only when the test $outcome', async ({ outcome, retained }) => {
    const session = await openSession(`tests/orders-${outcome}`);
    const debuggingPort = await freePort();
    const browser = await chromium.launch({ args: [`--remote-debugging-port=${debuggingPort}`] });
    try {
      const registration = await post('/sessions/page-observer', {
        sessionId: session.sessionId,
        sessionToken: session.sessionToken,
        testId: session.testId,
        debuggingPort,
        pages: [{ id: 'tenant.page-orders', path: '/orders/:id' }],
        loginRoutes: ['/login'],
        errorMarkers: [],
        appOrigins: [new URL(appBaseUrl).origin],
      });
      expect(registration.status).toBe(200);
      const page = await (await browser.newContext()).newPage();
      await page.goto(`${appBaseUrl}/orders/42`);
      await expect.poll(async () => (await getRecords()).filter((record) => record['kind'] === 'page.observed').length).toBe(2);
      const records = (await getRecords()).filter((record) => record['kind'] === 'page.observed');
      expect(records).toHaveLength(2);
      expect(records.every((record) => record['origin'] === 'engine-observed' && record['trust'] === 'witnessed')).toBe(true);
      expect(records.map((record) => record['obligationId']).sort()).toEqual([
        'tenant.page-orders:page:data-ok',
        'tenant.page-orders:page:loads',
      ]);
      const closed = await post('/sessions/close', { sessionId: session.sessionId, outcome }, true);
      expect(closed.status).toBe(200);
      expect((await getRecords()).filter((record) => record['kind'] === 'page.observed')).toHaveLength(retained ? 2 : 0);
    } finally {
      await browser.close();
    }
  });
});
