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
/** A page that exercises one GET and one POST app data call. */
const DUAL_PAGE_HTML = `<!doctype html><html><body><main>Dual calls</main><script>
fetch('/api/items').then((response) => response.json()).catch(() => {});
fetch('/api/orders', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
  .then((response) => response.json())
  .catch(() => {});
</script></body></html>`;

const app = createHttpServer((request, response) => {
  const path = new URL(request.url ?? '/', `http://${LOOPBACK}`).pathname;
  if (path === '/api/items' || path === '/api/orders') {
    response.writeHead(200, {
      'content-type': 'application/json',
      'x-gateforge-env-fingerprint': APP_FINGERPRINT,
    });
    response.end(JSON.stringify({ ok: true }));
    return;
  }
  response.writeHead(200, {
    'content-type': 'text/html',
    'x-gateforge-env-fingerprint': APP_FINGERPRINT,
  });
  response.end(path.startsWith('/broken')
    ? '<!doctype html><html><body><main>Something went wrong</main></body></html>'
    : path.startsWith('/dual')
      ? DUAL_PAGE_HTML
      : '<!doctype html><html><body><main>Orders are ready</main></body></html>');
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

/** The untyped JSON payload of one ledger record (witness-issued object). */
function recordPayload(record: Record<string, unknown>): Record<string, unknown> {
  const payload = record['payload'];
  // Named boundary cast: ledger payloads are witness-issued JSON objects;
  // anything else reads as an empty record so field reads stay honest.
  return typeof payload === 'object' && payload !== null ? (payload as Record<string, unknown>) : {};
}

/** The spec identity every session in this file opens under. */
const SPEC_FILE = 'specs/orders.spec.ts';
const TITLE_PATH = ['opens the orders page'];

async function openSession(testId: string): Promise<SessionCredential> {
  const response = await post('/sessions/open', {
    runId: RUN_ID,
    testId,
    workerIndex: 0,
    file: SPEC_FILE,
    titlePath: TITLE_PATH,
  }, true);
  if (response.status !== 200) throw new Error(`session open failed: ${JSON.stringify(response.body)}`);
  return response.body as unknown as SessionCredential;
}

/**
 * Registers the controller-held page-observation context with the
 * expected set (verifier-authenticated; MUST run before any session
 * opens — the expected set is a pre-run fact).
 */
async function registerPageContext(context: {
  pages: Array<{ id: string; path: string; anonymous?: boolean }>;
  loginRoutes?: string[];
  errorMarkers?: string[];
  appOrigins?: string[];
  tamperRisks?: Array<{ testId: string | null; file: string; locationFile: string; line: number }>;
}): Promise<void> {
  const registration = await post('/runs/expected-set', {
    tests: [{ testId: null, project: null, file: SPEC_FILE, titlePath: TITLE_PATH }],
    pageObservation: {
      pages: context.pages,
      loginRoutes: context.loginRoutes ?? ['/login'],
      errorMarkers: context.errorMarkers ?? [],
      appOrigins: context.appOrigins ?? [new URL(appBaseUrl).origin],
      tamperRisks: context.tamperRisks ?? [],
    },
  }, true);
  if (registration.status !== 200) {
    throw new Error(`page context registration failed: ${JSON.stringify(registration.body)}`);
  }
}

/** The only suite-side observer registration: session credentials + port. */
function registerObserver(session: SessionCredential, debuggingPort: number, extra: Record<string, unknown> = {}): Promise<Answer> {
  return post('/sessions/page-observer', {
    sessionId: session.sessionId,
    sessionToken: session.sessionToken,
    testId: session.testId,
    debuggingPort,
    ...extra,
  });
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
    // The controller flag rides the registered route table: an audience
    // without a configured login marks its pages anonymous (401-friendly).
    await registerPageContext({ pages: [{ id: 'tenant.page-orders', path: '/orders/:id', anonymous: true }] });
    const session = await openSession(`tests/orders-${outcome}`);
    const debuggingPort = await freePort();
    const browser = await chromium.launch({ args: [`--remote-debugging-port=${debuggingPort}`] });
    try {
      const registration = await registerObserver(session, debuggingPort);
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
      expect(records.map((record) => recordPayload(record)['apiRequestsSettled'])).toEqual([true, true]);
      expect(records.every((record) => Number.isInteger(recordPayload(record)['observationSequence']))).toBe(true);
      const closed = await post('/sessions/close', { sessionId: session.sessionId, outcome }, true);
      expect(closed.status).toBe(200);
      expect((await getRecords()).filter((record) => record['kind'] === 'page.observed')).toHaveLength(retained ? 2 : 0);
    } finally {
      await browser.close();
    }
  });

  it('records nothing for an out-of-table visit while the declared page still proves', async () => {
    await registerPageContext({ pages: [{ id: 'tenant.page-orders', path: '/orders/:id' }] });
    const session = await openSession('tests/orders-out-of-table');
    const debuggingPort = await freePort();
    const browser = await chromium.launch({ args: [`--remote-debugging-port=${debuggingPort}`] });
    try {
      const registration = await registerObserver(session, debuggingPort);
      expect(registration.status).toBe(200);
      const page = await (await browser.newContext()).newPage();
      await page.goto(`${appBaseUrl}/bootstrap`);
      await page.goto(`${appBaseUrl}/orders/42`);
      await expect.poll(async () => (await getRecords()).filter((record) => record['kind'] === 'page.observed').length).toBe(2);
      const records = (await getRecords()).filter((record) => record['kind'] === 'page.observed');
      expect(records.map((record) => record['obligationId']).sort()).toEqual([
        'tenant.page-orders:page:data-ok',
        'tenant.page-orders:page:loads',
      ]);
    } finally {
      await browser.close();
    }
  });

  it('retains refused records for a matched failing page', async () => {
    await registerPageContext({
      pages: [{ id: 'tenant.page-broken', path: '/broken/:id' }],
      errorMarkers: ['Something went wrong'],
    });
    const session = await openSession('tests/orders-broken');
    const debuggingPort = await freePort();
    const browser = await chromium.launch({ args: [`--remote-debugging-port=${debuggingPort}`] });
    try {
      const registration = await registerObserver(session, debuggingPort);
      expect(registration.status).toBe(200);
      const page = await (await browser.newContext()).newPage();
      await page.goto(`${appBaseUrl}/broken/7`);
      await expect.poll(async () => (await getRecords()).filter((record) => record['kind'] === 'page.observed').length).toBe(2);
      const records = (await getRecords()).filter((record) => record['kind'] === 'page.observed');
      expect(records.map((record) => record['obligationId']).sort()).toEqual([
        'tenant.page-broken:page:data-ok',
        'tenant.page-broken:page:loads',
      ]);
      const loads = records.find((record) => record['obligationId'] === 'tenant.page-broken:page:loads')!;
      const loadsPayload = loads['payload'] as { loads: { refusalReasons: string[] } };
      expect(loadsPayload.loads.refusalReasons).toContain('PAGE_ERROR_MARKER');
      const closed = await post('/sessions/close', { sessionId: session.sessionId, outcome: 'passed' }, true);
      expect(closed.status).toBe(200);
      expect((await getRecords()).filter((record) => record['kind'] === 'page.observed')).toHaveLength(2);
    } finally {
      await browser.close();
    }
  });

  it('stamps increasing observation sequences across fresh navigation windows', async () => {
    await registerPageContext({ pages: [{ id: 'tenant.page-orders', path: '/orders/:id' }] });
    const session = await openSession('tests/orders-sequence');
    const debuggingPort = await freePort();
    const browser = await chromium.launch({ args: [`--remote-debugging-port=${debuggingPort}`] });
    try {
      const registration = await registerObserver(session, debuggingPort);
      expect(registration.status).toBe(200);
      const page = await (await browser.newContext()).newPage();
      await page.goto(`${appBaseUrl}/orders/42`);
      await expect.poll(async () => (await getRecords()).filter((record) => record['kind'] === 'page.observed').length).toBe(2);
      // A genuinely new navigation after the window emitted starts a fresh
      // window and bumps the sequence; the emitted window is not re-issued.
      await page.goto(`${appBaseUrl}/orders/43`);
      await expect.poll(async () => (await getRecords()).filter((record) => record['kind'] === 'page.observed').length).toBe(4);
      const records = (await getRecords()).filter((record) => record['kind'] === 'page.observed');
      const sequences = records
        .map((record) => Number(recordPayload(record)['observationSequence']))
        .sort((a, b) => a - b);
      expect(sequences).toEqual([0, 0, 1, 1]);
      expect(records.map((record) => recordPayload(record)['apiRequestsSettled'])).toEqual([true, true, true, true]);
      const closed = await post('/sessions/close', { sessionId: session.sessionId, outcome: 'passed' }, true);
      expect(closed.status).toBe(200);
    } finally {
      await browser.close();
    }
  });

  it('records the method of every API call the page made (GET and POST)', async () => {
    await registerPageContext({ pages: [{ id: 'tenant.page-dual', path: '/dual' }] });
    const session = await openSession('tests/orders-dual-methods');
    const debuggingPort = await freePort();
    const browser = await chromium.launch({ args: [`--remote-debugging-port=${debuggingPort}`] });
    try {
      expect((await registerObserver(session, debuggingPort)).status).toBe(200);
      const page = await (await browser.newContext()).newPage();
      await page.goto(`${appBaseUrl}/dual`);
      await expect.poll(async () => (await getRecords()).filter((record) => record['kind'] === 'page.observed').length).toBe(2);
      const records = (await getRecords()).filter((record) => record['kind'] === 'page.observed');
      expect(records).toHaveLength(2);
      for (const record of records) {
        expect(record['testId']).toBe('tests/orders-dual-methods');
        const apiStatuses = recordPayload(record)['apiStatuses'] as Array<Record<string, unknown>>;
        expect(apiStatuses).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ method: 'GET', status: 200, url: expect.stringContaining('/api/items') }),
            expect.objectContaining({ method: 'POST', status: 200, url: expect.stringContaining('/api/orders') }),
          ]),
        );
      }
    } finally {
      await browser.close();
    }
  });
});

describe('page observation authority (controller-held context)', () => {
  it('refuses page observation when no controller context is registered', async () => {
    const session = await openSession('tests/orders-unbound');
    const registration = await registerObserver(session, await freePort());
    expect(registration.status).toBe(409);
    expect(String(registration.body['error'])).toContain('no controller-registered page-observation context');
    expect((await getRecords()).filter((record) => record['kind'] === 'page.observed')).toHaveLength(0);
  });

  it('ignores suite-supplied grading configuration and grades with the controller table only', async () => {
    await registerPageContext({ pages: [{ id: 'tenant.page-orders', path: '/orders/:id' }] });
    const session = await openSession('tests/orders-forged-fields');
    const debuggingPort = await freePort();
    const browser = await chromium.launch({ args: [`--remote-debugging-port=${debuggingPort}`] });
    try {
      // Legacy suite body fields ride along and are ignored: the forged
      // route proves nothing, the controller route still grades.
      const registration = await registerObserver(session, debuggingPort, {
        pages: [{ id: 'tenant.page-evil', path: '/evil' }],
        appOrigins: ['https://evil.example'],
      });
      expect(registration.status).toBe(200);
      const page = await (await browser.newContext()).newPage();
      await page.goto(`${appBaseUrl}/evil`);
      await page.goto(`${appBaseUrl}/orders/42`);
      await expect.poll(async () => (await getRecords()).filter((record) => record['kind'] === 'page.observed').length).toBe(2);
      const records = (await getRecords()).filter((record) => record['kind'] === 'page.observed');
      expect(records.map((record) => record['obligationId']).sort()).toEqual([
        'tenant.page-orders:page:data-ok',
        'tenant.page-orders:page:loads',
      ]);
    } finally {
      await browser.close();
    }
  });

  it('refuses matched wrong-origin content with PAGE_APP_ORIGIN_MISMATCH', async () => {
    await registerPageContext({ pages: [{ id: 'tenant.page-orders', path: '/orders/:id' }] });
    const session = await openSession('tests/orders-wrong-origin');
    const debuggingPort = await freePort();
    const browser = await chromium.launch({ args: [`--remote-debugging-port=${debuggingPort}`] });
    // A SECOND HTTP server on its own origin serving the same path shape:
    // the route matches the controller table, the origin never does.
    const secondApp = createHttpServer((request, response) => {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end('<!doctype html><html><body><main>Orders are ready</main></body></html>');
    });
    await new Promise<void>((resolve) => secondApp.listen(0, LOOPBACK, resolve));
    const secondAddress = secondApp.address() as AddressInfo;
    const secondBase = `http://${LOOPBACK}:${String(secondAddress.port)}`;
    try {
      expect((await registerObserver(session, debuggingPort)).status).toBe(200);
      const page = await (await browser.newContext()).newPage();
      await page.goto(`${secondBase}/orders/42`);
      await expect.poll(async () => (await getRecords()).filter((record) => record['kind'] === 'page.observed').length).toBe(2);
      const records = (await getRecords()).filter((record) => record['kind'] === 'page.observed');
      expect(records).toHaveLength(2);
      for (const record of records) {
        const payload = recordPayload(record) as {
          loads: { satisfied: boolean; refusalReasons: string[] };
          dataOk: { satisfied: boolean; refusalReasons: string[] };
        };
        expect(payload.loads.satisfied).toBe(false);
        expect(payload.dataOk.satisfied).toBe(false);
        expect(payload.loads.refusalReasons).toContain('PAGE_APP_ORIGIN_MISMATCH');
        expect(payload.dataOk.refusalReasons).toContain('PAGE_APP_ORIGIN_MISMATCH');
      }
    } finally {
      await browser.close();
      await new Promise<void>((resolve) => secondApp.close(() => resolve()));
    }
  });

  it('refuses a session whose registered identity carries a static tamper risk', async () => {
    await registerPageContext({
      pages: [{ id: 'tenant.page-orders', path: '/orders/:id' }],
      tamperRisks: [{ testId: null, file: SPEC_FILE, locationFile: 'specs/tamper.spec.ts', line: 4 }],
    });
    const session = await openSession('tests/orders-tampered');
    const registration = await registerObserver(session, await freePort());
    expect(registration.status).toBe(403);
    expect(String(registration.body['error'])).toContain('PAGE_OBSERVATION_TAMPER_RISK');
    expect(String(registration.body['error'])).toContain('specs/tamper.spec.ts:4');
    expect((await getRecords()).filter((record) => record['kind'] === 'page.observed')).toHaveLength(0);
  });
});
