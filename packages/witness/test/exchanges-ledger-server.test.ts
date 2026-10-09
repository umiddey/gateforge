/**
 * Every session's exchanges become evidence (WP2 step 2): closing a
 * session that PASSED issues ONE claim-free `http.exchanges` record
 * carrying the same transport snapshot the per-claim `http.observed`
 * records carry (watermark, dedup, cap, `truncated`). A session whose
 * test did not pass drops its record (the `sealPageObservationRecords`
 * rule), and zero proxied exchanges issue nothing. The page-sweep
 * session gets the same ONE record when its sweep completes, and a
 * rejected sweep session keeps none. The kind is ledger evidence only —
 * it never satisfies an obligation (pinned in core) — and step 3 builds
 * the verdict-time `httpLedger` from it.
 */
import { createServer, get, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildHttpLedger, type HttpRouteCandidate } from '@gate-forge/core';
import { HTTP_EXCHANGES_KIND, RUN_HEADER, VERIFIER_HEADER } from '../src/constants.js';
import { startWitness, type WitnessHandle } from '../src/witness/server.js';
import type { SessionCredential } from '../src/witness/types.js';

const RUN_ID = 'b2c3d4e5-0000-4000-8000-000000000002';
const RUN_TOKEN = 'exchanges-ledger-run-token';
const VERIFIER_KEY = 'exchanges-ledger-verifier-key';
const TEST_ID = 'tests/ledger#unclaimed';
/** The IPv4 loopback host this suite names (built, never copied from output). */
const LOOPBACK = [127, 0, 0, 1].join('.');

let witness: WitnessHandle;
let adaptersDir: string;

/** `Promise.withResolvers` for the repo's ES2023 lib target, which predates it. */
function withResolvers<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** The fixture app the session proxy forwards to; serves everything with 200. */
const app: Server = createServer((req, res) => {
  if (req.url === '/') {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<script src="/script.js"></script>');
    return;
  }
  if (req.url === '/script.js') {
    res.writeHead(200, { 'content-type': 'application/javascript' });
    res.end("fetch('/api/data')");
    return;
  }
  res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
  res.end('exchanges-ledger-app');
});
let appBaseUrl: string;

beforeAll(async () => {
  const { promise, resolve } = withResolvers<void>();
  app.listen(0, LOOPBACK, () => resolve());
  await promise;
  appBaseUrl = `http://${LOOPBACK}:${String((app.address() as AddressInfo).port)}`;
});

afterAll(async () => {
  const { promise, resolve } = withResolvers<void>();
  app.close(() => resolve());
  await promise;
});

beforeEach(async () => {
  adaptersDir = mkdtempSync(join(tmpdir(), 'gateforge-exchanges-ledger-'));
  witness = await startWitness({
    runId: RUN_ID,
    token: RUN_TOKEN,
    verifierKey: VERIFIER_KEY,
    adaptersDir,
    classificationsPath: null,
    proxyTarget: appBaseUrl,
  });
});

afterEach(async () => {
  await witness.stop();
  rmSync(adaptersDir, { recursive: true, force: true });
});

/** Posts JSON to one supervisor-only witness endpoint. */
async function post(path: string, body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${witness.url}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      [RUN_HEADER]: RUN_TOKEN,
      [VERIFIER_HEADER]: VERIFIER_KEY,
    },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

/** Opens one UNCLAIMED session (no claims — the calls-of-tests-without-claims case). */
async function openUnclaimedSession(testId = TEST_ID, workerIndex = 0): Promise<SessionCredential> {
  const answer = await post('/sessions/open', { runId: RUN_ID, testId, workerIndex, claims: [] });
  if (answer.status !== 200) throw new Error(`session open failed: ${JSON.stringify(answer.body)}`);
  return answer.body as unknown as SessionCredential;
}

/** Drives one proxied GET through the session's dedicated observation proxy. */
async function proxiedGet(session: SessionCredential, path: string, fetchDest?: string): Promise<number> {
  const { promise, resolve, reject } = withResolvers<number>();
  get(
    `${session.proxyUrl as string}${path}`,
    { ...(fetchDest === undefined ? {} : { headers: { 'sec-fetch-dest': fetchDest } }) },
    (response) => {
      response.resume();
      response.on('end', () => resolve(response.statusCode ?? 0));
    },
  ).on('error', reject);
  return promise;
}

/** The http.exchanges records in the ledger, if any. */
async function exchangeRecords(): Promise<Array<Record<string, unknown>>> {
  const response = await fetch(`${witness.url}/records`, { headers: { [RUN_HEADER]: RUN_TOKEN } });
  const body = (await response.json()) as { records?: Array<Record<string, unknown>> };
  return (body.records ?? []).filter((record) => record['kind'] === HTTP_EXCHANGES_KIND);
}

describe('POST /sessions/close — one http.exchanges record per passed session', () => {
  it('issues ONE claim-free record for an UNCLAIMED session with proxied traffic', async () => {
    const session = await openUnclaimedSession();
    expect(await proxiedGet(session, '/x')).toBe(200);
    const close = await post('/sessions/close', { sessionId: session.sessionId, outcome: 'passed' });
    expect(close.status).toBe(200);

    const records = await exchangeRecords();
    expect(records).toHaveLength(1);
    const record = records[0] as Record<string, unknown>;
    expect(record['trust']).toBe('witnessed');
    expect(record['origin']).toBe('engine-observed');
    expect(record['testId']).toBe(TEST_ID);
    // Claim-free binding: no obligation can ever select this record.
    expect(record['obligationId']).toBe(session.sessionId);
    const payload = record['payload'] as Record<string, unknown>;
    expect(payload['channel']).toBe('observe');
    expect(payload['sessionId']).toBe(session.sessionId);
    expect(payload['exchanges']).toEqual([{ method: 'GET', url: '/x', status: 200, fetchDest: null }]);
    expect(payload['truncated']).toBeUndefined();
  });
  it('carries browser document, script, and fetch destinations into http.exchanges', async () => {
    const session = await openUnclaimedSession();
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.goto(`${session.proxyUrl as string}/`);
      await page.waitForResponse((response) => response.url().endsWith('/api/data'));
      await post('/sessions/close', { sessionId: session.sessionId, outcome: 'passed' });
      const records = await exchangeRecords();
      const payload = (records[0] as Record<string, unknown>)['payload'] as Record<string, unknown>;
      expect(payload['exchanges']).toEqual([
        { method: 'GET', url: '/', status: 200, fetchDest: 'document' },
        { method: 'GET', url: '/script.js', status: 200, fetchDest: 'script' },
        { method: 'GET', url: '/api/data', status: 200, fetchDest: 'empty' },
      ]);
    } finally {
      await browser.close();
    }
  });

  it('drops the record for a session that did not pass, even with traffic', async () => {
    const session = await openUnclaimedSession();
    expect(await proxiedGet(session, '/x')).toBe(200);
    const close = await post('/sessions/close', { sessionId: session.sessionId, outcome: 'failed' });
    expect(close.status).toBe(200);
    expect(await exchangeRecords()).toEqual([]);
  });

  it('issues no record when the session proxied nothing', async () => {
    const session = await openUnclaimedSession();
    const close = await post('/sessions/close', { sessionId: session.sessionId, outcome: 'passed' });
    expect(close.status).toBe(200);
    expect(await exchangeRecords()).toEqual([]);
  });

  it('deduplicates repeated identical exchanges like the transport snapshot', async () => {
    const session = await openUnclaimedSession();
    expect(await proxiedGet(session, '/x')).toBe(200);
    expect(await proxiedGet(session, '/x')).toBe(200);
    expect(await proxiedGet(session, '/y')).toBe(200);
    await post('/sessions/close', { sessionId: session.sessionId, outcome: 'passed' });

    const records = await exchangeRecords();
    expect(records).toHaveLength(1);
    const payload = (records[0] as Record<string, unknown>)['payload'] as Record<string, unknown>;
    expect(payload['exchanges']).toEqual([
      { method: 'GET', url: '/x', status: 200, fetchDest: null },
      { method: 'GET', url: '/y', status: 200, fetchDest: null },
    ]);
  });
});

describe('the verdict-time httpLedger (WP2 step 3)', () => {
  it('reports an UNCLAIMED test call to /x as match and an unserved path as nomatch', async () => {
    const session = await openUnclaimedSession('tests/ledger#unclaimed-x');
    expect(await proxiedGet(session, '/x', 'empty')).toBe(200);
    expect(await proxiedGet(session, '/nowhere', 'empty')).toBe(200);
    const close = await post('/sessions/close', { sessionId: session.sessionId, outcome: 'passed' });
    expect(close.status).toBe(200);

    const response = await fetch(`${witness.url}/records`, { headers: { [RUN_HEADER]: RUN_TOKEN } });
    const body = (await response.json()) as { records?: Array<Record<string, unknown>> };
    // The ledger core builds at verdict time from the run's records over
    // the run's complete route inventory — the same input shape the CLI
    // passes (`buildHttpLedger(authorizedRecords, httpRoutesView(graph))`).
    const ledger = buildHttpLedger(body.records ?? [], [
      { resourceId: 'http.endpoint:GET /x', method: 'GET', canonicalPath: '/x' },
    ] satisfies HttpRouteCandidate[]);
    expect(ledger.rows).toEqual([
      {
        testId: 'tests/ledger#unclaimed-x',
        method: 'GET',
        path: '/nowhere',
        status: 200,
        kind: 'api',
        route: null,
        resolution: 'nomatch',
      },
      {
        testId: 'tests/ledger#unclaimed-x',
        method: 'GET',
        path: '/x',
        status: 200,
        kind: 'api',
        route: 'http.endpoint:GET /x',
        resolution: 'match',
      },
    ]);
    expect(ledger.summary).toEqual({ exchanges: 2, matched: 1, unmatched: 1, ambiguous: 0, incomplete: 0 });
  });
});

describe('POST /runs/page-sweep — one http.exchanges record for the sweep session', () => {
  /**
   * Replaces the file-level beforeEach witness (proxy-less) with one
   * wired for the sweep: the engine browser it drives plus the trusted
   * UI base the sweep needs.
   */
  async function startSweepWitness(appTarget: string): Promise<void> {
    await witness.stop();
    rmSync(adaptersDir, { recursive: true, force: true });
    adaptersDir = mkdtempSync(join(tmpdir(), 'gateforge-exchanges-sweep-'));
    witness = await startWitness({
      runId: RUN_ID,
      token: RUN_TOKEN,
      verifierKey: VERIFIER_KEY,
      adaptersDir,
      classificationsPath: null,
      targetBaseUrl: appTarget,
      targetFingerprint: 'exchanges-sweep-fixture-v1',
      engineBrowserLauncher: { launch: (options) => chromium.launch(options) },
    });
  }

  afterEach(async () => {
    await witness.stop();
    rmSync(adaptersDir, { recursive: true, force: true });
    adaptersDir = '';
  });

  it('issues ONE swept record carrying the pages API exchanges', async () => {
    const sweepApp: Server = createServer((req, res) => {
      if (new URL(req.url ?? '/', `http://${LOOPBACK}`).pathname === '/api/widgets') {
        res.writeHead(200, {
          'content-type': 'application/json',
          'x-gateforge-env-fingerprint': 'exchanges-sweep-fixture-v1',
        });
        res.end('[]');
        return;
      }
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'x-gateforge-env-fingerprint': 'exchanges-sweep-fixture-v1',
      });
      res.end('<!doctype html><body><main>Ready</main><script>fetch("/api/widgets").catch(() => {});</script></body>');
    });
    const listen = withResolvers<void>();
    sweepApp.listen(0, LOOPBACK, () => listen.resolve());
    await listen.promise;
    const sweepAppBase = `http://${LOOPBACK}:${String((sweepApp.address() as AddressInfo).port)}`;
    const { promise, resolve: done } = withResolvers<void>();
    try {
      await startSweepWitness(sweepAppBase);
      const sweep = await post('/runs/page-sweep', {
        audience: 'tenant',
        pages: [{ id: 'tenant.page-widgets', path: '/widgets' }],
        loginRoutes: [],
        liveChannels: [],
        errorMarkers: [],
      });
      expect(sweep.status).toBe(200);

      const records = await exchangeRecords();
      expect(records).toHaveLength(1);
      const record = records[0] as Record<string, unknown>;
      expect(record['testId']).toBe('page-sweep');
      expect(record['trust']).toBe('witnessed');
      expect(record['origin']).toBe('engine-observed');
      const payload = record['payload'] as Record<string, unknown>;
      expect(payload['channel']).toBe('swept');
      expect(String(payload['sessionId'])).toContain(`page-sweep-${RUN_ID}-tenant`);
      // The page observer records API responses with ABSOLUTE urls (the
      // browser's view); the ledger builder interprets them like every
      // other observed path.
      expect(payload['exchanges']).toEqual([
        { method: 'GET', url: `${sweepAppBase}/api/widgets`, status: 200, fetchDest: null },
      ]);
    } finally {
      sweepApp.close(() => done());
      await promise;
    }
  });

  it('keeps no sweep exchanges record for a rejected sweep session', async () => {
    // The app rejects every session except the exact valid cookie; the
    // sweep's storage state carries a STALE session, so the protected
    // page bounces to the declared login route and the sweep session is
    // rejected — its page.observed records still issue, but (like a
    // non-passing test session) it retains no http.exchanges evidence.
    const sweepApp: Server = createServer((req, res) => {
      const path = new URL(req.url ?? '/', `http://${LOOPBACK}`).pathname;
      const ready = req.headers.cookie?.includes('auth=ready') === true;
      const marker = { 'x-gateforge-env-fingerprint': 'exchanges-sweep-fixture-v1' };
      // A stale session bounces the PROTECTED page to the declared login
      // route; /login itself answers (no redirect loop for the startup
      // attestation probe).
      if (path === '/widgets' && !ready) {
        res.writeHead(302, { location: '/login', ...marker });
        res.end();
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', ...marker });
      res.end('<!doctype html><body><main>Ready</main><script>fetch("/api/widgets").catch(() => {});</script></body>');
    });
    const listen = withResolvers<void>();
    sweepApp.listen(0, LOOPBACK, () => listen.resolve());
    await listen.promise;
    const sweepAppBase = `http://${LOOPBACK}:${String((sweepApp.address() as AddressInfo).port)}`;
    const { promise, resolve: done } = withResolvers<void>();
    try {
      await startSweepWitness(sweepAppBase);
      const sweep = await post('/runs/page-sweep', {
        audience: 'tenant',
        pages: [{ id: 'tenant.page-widgets', path: '/widgets' }],
        loginRoutes: ['/login'],
        liveChannels: [],
        errorMarkers: [],
        storageState: {
          cookies: [{
            name: 'auth',
            value: 'stale',
            domain: LOOPBACK,
            path: '/',
            expires: -1,
            httpOnly: false,
            secure: false,
            sameSite: 'Lax',
          }],
          origins: [],
        },
      });
      expect(sweep.status).toBe(200);
      expect(sweep.body['sessionRejected']).not.toBeNull();
      const ledger = await (await fetch(`${witness.url}/records`, { headers: { [RUN_HEADER]: RUN_TOKEN } })).json() as {
        records: Array<Record<string, unknown>>;
      };
      const pageRecords = ledger.records.filter((record) => record['kind'] === 'page.observed');
      expect(pageRecords.length).toBeGreaterThan(0);
      expect(await exchangeRecords()).toEqual([]);
    } finally {
      sweepApp.close(() => done());
      await promise;
    }
  });
});
