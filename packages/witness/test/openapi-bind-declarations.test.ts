/**
 * The PRE-run declaration gates must not count the bind-time run-level
 * OpenAPI metadata record as evidence. Binding a run context that asks
 * for response shapes seals ONE `http.openapi` record (0.14 WP4) BEFORE
 * the supervisor drain registers its observe / server-e2e declarations
 * (test-gates binds the context first, the drain declares second), so a
 * fresh witness used to refuse both declaration sets with 409 — and a
 * response-shape run witnessed zero authorized HTTP records. That
 * record is run metadata, not test evidence: both declaration sets must
 * bind 200 after it. Real test evidence still refuses — an open test
 * session, or an issued `http.exchanges` record in the ledger.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildHttpLedger, type HttpRouteCandidate } from '@gate-forge/core';
import { RUN_HEADER, VERIFIER_HEADER } from '../src/constants.js';
import { startWitness, type WitnessHandle } from '../src/witness/server.js';
import type { SessionCredential } from '../src/witness/types.js';

const RUN_ID = 'd4e5f6a7-0000-4000-8000-000000000005';
const INVOCATION_ID = 'd4e5f6a7-0000-4000-8000-000000000006';
const INPUT_DIGEST = 'b'.repeat(64);
const RUN_TOKEN = 'openapi-bind-declarations-run-token';
const VERIFIER_KEY = 'openapi-bind-declarations-verifier-key';
const TEST_ID = 'tests/openapi-bind#declarations';
const HTTP_OPENAPI_KIND = 'http.openapi';
const HTTP_EXCHANGES_KIND = 'http.exchanges';
const SERVER_E2E_CLAIM = 'tenant.accounts:persistence:create';
const OBSERVE_CLAIM = 'tenant.widgets:http:request-observed';
/** The IPv4 loopback host this suite names (built, never copied from output). */
const LOOPBACK = [127, 0, 0, 1].join('.');

/** A small OpenAPI 3.0 document the fixture app serves at /openapi.json. */
const OPENAPI_DOCUMENT = JSON.stringify({
  openapi: '3.0.3',
  info: { title: 'fixture', version: '1' },
  paths: {
    '/items/{id}': {
      get: {
        responses: {
          '200': {
            description: 'ok',
            content: { 'application/json': { schema: { type: 'object' } } },
          },
        },
      },
    },
    '/items': {
      post: { responses: { '201': { description: 'created' } } },
    },
  },
});

let adaptersDir: string;
let witness: WitnessHandle;
let appBaseUrl: string;
const app: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
  if (req.url === '/openapi.json') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(OPENAPI_DOCUMENT);
    return;
  }
  if (req.url === '/items/7') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: '7' }));
    return;
  }
  res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
  res.end('openapi-bind-declarations-app');
});

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
  adaptersDir = mkdtempSync(join(tmpdir(), 'gateforge-openapi-bind-declarations-'));
  witness = await startWitness({
    runId: RUN_ID,
    token: RUN_TOKEN,
    verifierKey: VERIFIER_KEY,
    adaptersDir,
    classificationsPath: null,
    proxyTarget: appBaseUrl,
    targetBaseUrl: appBaseUrl,
  });
});

afterEach(async () => {
  await witness.stop();
  rmSync(adaptersDir, { recursive: true, force: true });
});

/** Posts JSON to the witness with the run token AND the verifier key. */
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

/** Binds the run context WITH the response-shape plan (seals the http.openapi record at bind). */
async function bindResponseShapeContext(): Promise<void> {
  const answer = await post('/run-context', {
    runId: RUN_ID,
    invocationId: INVOCATION_ID,
    inputDigest: INPUT_DIGEST,
    options: { responseShape: { openapiPath: '/openapi.json' } },
  });
  expect(answer.status).toBe(200);
}

/** The ledger records of one kind. */
async function recordsOfKind(kind: string): Promise<Array<Record<string, unknown>>> {
  const response = await fetch(`${witness.url}/records`, { headers: { [RUN_HEADER]: RUN_TOKEN } });
  const body = (await response.json()) as { records?: Array<Record<string, unknown>> };
  return (body.records ?? []).filter((record) => record['kind'] === kind);
}

/** Every ledger record the witness has issued. */
async function allRecords(): Promise<Array<Record<string, unknown>>> {
  const response = await fetch(`${witness.url}/records`, { headers: { [RUN_HEADER]: RUN_TOKEN } });
  const body = (await response.json()) as { records?: Array<Record<string, unknown>> };
  return body.records ?? [];
}

/** Opens one UNCLAIMED session (no claims — the declaration-gate case). */
async function openUnclaimedSession(): Promise<SessionCredential> {
  const opened = await post('/sessions/open', { runId: RUN_ID, testId: TEST_ID, workerIndex: 0, claims: [] });
  expect(opened.status).toBe(200);
  return opened.body as unknown as SessionCredential;
}

describe('PRE-run declarations after a response-shape bind — bind-time OpenAPI metadata is not evidence', () => {
  it('binds run context WITH responseShape, then both declaration sets bind 200 on the fresh witness', async () => {
    await bindResponseShapeContext();
    // The bind sealed the run-level metadata record this fix is about.
    expect(await recordsOfKind(HTTP_OPENAPI_KIND)).toHaveLength(1);

    const serverE2e = await post('/runs/server-e2e-declarations', {
      obligations: [SERVER_E2E_CLAIM],
    });
    expect(serverE2e.status).toBe(200);
    expect(serverE2e.body).toMatchObject({ bound: true, count: 1 });

    const observe = await post('/runs/observe-declarations', {
      obligations: [OBSERVE_CLAIM],
    });
    expect(observe.status).toBe(200);
    expect(observe.body).toMatchObject({ bound: true, count: 1 });
  });

  it('still refuses both declaration sets while a test session is open', async () => {
    await bindResponseShapeContext();
    await openUnclaimedSession();

    const serverE2e = await post('/runs/server-e2e-declarations', {
      obligations: [SERVER_E2E_CLAIM],
    });
    expect(serverE2e.status).toBe(409);

    const observe = await post('/runs/observe-declarations', {
      obligations: [OBSERVE_CLAIM],
    });
    expect(observe.status).toBe(409);
  });

  it('still refuses both declaration sets after real test evidence is issued', async () => {
    await bindResponseShapeContext();
    const session = await openUnclaimedSession();
    await fetch(`${session.proxyUrl as string}/items/7`);
    expect((await post('/sessions/close', { sessionId: session.sessionId, outcome: 'passed' })).status).toBe(200);
    // Real test evidence now sits in the ledger NEXT TO the bind metadata.
    expect(await recordsOfKind(HTTP_EXCHANGES_KIND)).toHaveLength(1);

    const serverE2e = await post('/runs/server-e2e-declarations', {
      obligations: [SERVER_E2E_CLAIM],
    });
    expect(serverE2e.status).toBe(409);

    const observe = await post('/runs/observe-declarations', {
      obligations: [OBSERVE_CLAIM],
    });
    expect(observe.status).toBe(409);
  });
});

describe('FULL sequence — bind with responseShape, declarations, suite, verdict', () => {
  it('binds, accepts both declaration sets, and credits the suite HTTP call as a trusted ledger row', async () => {
    // 1. bind: the OpenAPI document is fetched once and sealed as run metadata.
    await bindResponseShapeContext();
    const openApi = await recordsOfKind(HTTP_OPENAPI_KIND);
    expect(openApi).toHaveLength(1);
    expect(openApi[0]).toMatchObject({ trust: 'witnessed', payload: { status: 'fetched', path: '/openapi.json' } });

    // 2. the supervisor drain registers both PRE-run declaration sets.
    const serverE2e = await post('/runs/server-e2e-declarations', { obligations: [SERVER_E2E_CLAIM] });
    expect(serverE2e.status, `server-e2e declarations refused: ${JSON.stringify(serverE2e.body)}`).toBe(200);
    expect(serverE2e.body).toMatchObject({ bound: true, count: 1, obligations: [SERVER_E2E_CLAIM] });
    const observe = await post('/runs/observe-declarations', { obligations: [OBSERVE_CLAIM] });
    expect(observe.status, `observe declarations refused: ${JSON.stringify(observe.body)}`).toBe(200);
    expect(observe.body).toMatchObject({ bound: true, count: 1, obligations: [OBSERVE_CLAIM] });

    // 3. the suite runs: a claimed session drives the app through its proxy.
    const opened = await post('/sessions/open', {
      runId: RUN_ID,
      testId: TEST_ID,
      workerIndex: 0,
      claims: [OBSERVE_CLAIM],
    });
    expect(opened.status).toBe(200);
    const session = opened.body as unknown as SessionCredential;
    // Browser fetches carry Sec-Fetch-Dest; the exchange classifies as an API call.
    expect(await fetch(`${session.proxyUrl as string}/items/7`, { headers: { 'sec-fetch-dest': 'empty' } }))
      .toMatchObject({ status: 200 });
    expect((await post('/observe/finalize', { sessionId: session.sessionId })).status).toBe(200);
    expect((await post('/sessions/close', { sessionId: session.sessionId, outcome: 'passed' })).status).toBe(200);

    // 4. verdict: the call is a TRUSTED ledger row credited to a declared
    //    route — the httpLedger the CLI builds at verdict time from the
    //    run's authorized records.
    const records = await allRecords();
    const exchanges = records.filter((record) => record['kind'] === HTTP_EXCHANGES_KIND);
    expect(exchanges).toHaveLength(1);
    expect(exchanges[0]).toMatchObject({ trust: 'witnessed', origin: 'engine-observed', testId: TEST_ID });
    const ledger = buildHttpLedger(records, [
      { resourceId: 'http.endpoint:GET /items/{id}', method: 'GET', canonicalPath: '/items/{id}' },
    ] satisfies HttpRouteCandidate[]);
    expect(ledger.rows).toEqual([
      {
        testId: TEST_ID,
        method: 'GET',
        path: '/items/7',
        status: 200,
        kind: 'api',
        route: 'http.endpoint:GET /items/{id}',
        resolution: 'match',
        shape: 'ok',
      },
    ]);
    expect(ledger.summary).toEqual({ exchanges: 1, matched: 1, unmatched: 0, ambiguous: 0, incomplete: 0 });
  });
});
