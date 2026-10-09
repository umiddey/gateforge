/**
 * Each proxied exchange whose route declares a JSON response schema for
 * its status is checked against that schema, and the verdict travels on
 * the exchange in the session's `http.exchanges` record (0.14 WP4 step
 * 3). The witness validates against the document it fetched at bind;
 * a body is buffered for validation only when a schema applies, and a
 * body over the cap is a refusal for that exchange alone. Every other
 * case is `unchecked` with a reason and never fails. A run that did not
 * ask for response shapes carries no `shape` field at all.
 */
import { createServer, get, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { HTTP_EXCHANGES_KIND, RUN_HEADER, VERIFIER_HEADER } from '../src/constants.js';
import { startWitness, type WitnessHandle } from '../src/witness/server.js';
import { buildResponseShapeIndex, judgeEngineExchange } from '../src/witness/response-shape.js';
import type { SessionCredential } from '../src/witness/types.js';

const RUN_ID = 'd4e5f6a7-0000-4000-8000-000000000005';
const INVOCATION_ID = 'd4e5f6a7-0000-4000-8000-000000000006';
const INPUT_DIGEST = 'b'.repeat(64);
const RUN_TOKEN = 'response-shape-run-token';
const VERIFIER_KEY = 'response-shape-verifier-key';
const TEST_ID = 'tests/shape#checked';
/** The IPv4 loopback host this suite names (built, never copied from output). */
const LOOPBACK = [127, 0, 0, 1].join('.');
const ONE_MIB = 1024 * 1024;

/** The fixture document: one integer field, one nullable string, one free route. */
const OPENAPI_DOCUMENT = JSON.stringify({
  openapi: '3.0.3',
  info: { title: 'fixture', version: '1' },
  paths: {
    '/items/{id}': {
      get: {
        responses: {
          '200': {
            description: 'ok',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['count'],
                  properties: {
                    count: { type: 'integer' },
                    note: { type: 'string', nullable: true },
                  },
                },
              },
            },
          },
        },
      },
    },
    '/free': {
      get: { responses: { '200': { description: 'no body declared' } } },
    },
  },
});

/** What the fixture app answers for `/items/*`; each test sets it. */
let itemReply = { status: 200, contentType: 'application/json', body: '' };
let serveOpenApi = true;
let adaptersDir: string;
let witness: WitnessHandle;
let appBaseUrl: string;
let app: Server;

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

/** The fixture app: the OpenAPI document, the configured item reply, and 200 `/free`. */
function handleAppRequest(req: IncomingMessage, res: ServerResponse): void {
  const url = req.url ?? '';
  if (url === '/openapi.json') {
    if (serveOpenApi) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(OPENAPI_DOCUMENT);
    } else {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
    }
    return;
  }
  if (url.startsWith('/items/')) {
    res.writeHead(itemReply.status, { 'content-type': itemReply.contentType });
    res.end(itemReply.body);
    return;
  }
  if (url === '/free') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"anything":true}');
    return;
  }
  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('no route');
}

beforeAll(async () => {
  app = createServer(handleAppRequest);
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
  itemReply = { status: 200, contentType: 'application/json', body: '{"count":1}' };
  serveOpenApi = true;
  adaptersDir = mkdtempSync(join(tmpdir(), 'gateforge-response-shape-'));
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

/** Binds the run context, optionally asking for the response-shape plan. */
async function bind(options: Record<string, unknown> | undefined): Promise<number> {
  const response = await fetch(`${witness.url}/run-context`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      [RUN_HEADER]: RUN_TOKEN,
      [VERIFIER_HEADER]: VERIFIER_KEY,
    },
    body: JSON.stringify({
      runId: RUN_ID,
      invocationId: INVOCATION_ID,
      inputDigest: INPUT_DIGEST,
      ...(options === undefined ? {} : { options }),
    }),
  });
  return response.status;
}

/** Opens one UNCLAIMED session (no claims) and returns its credential. */
async function openSession(): Promise<SessionCredential> {
  const answer = await post('/sessions/open', { runId: RUN_ID, testId: TEST_ID, workerIndex: 0, claims: [] });
  if (answer.status !== 200) throw new Error(`session open failed: ${JSON.stringify(answer.body)}`);
  return answer.body as unknown as SessionCredential;
}

/** Drives one proxied GET through the session's dedicated observation proxy. */
async function proxiedGet(session: SessionCredential, path: string): Promise<number> {
  const { promise, resolve, reject } = withResolvers<number>();
  get(
    `${session.proxyUrl as string}${path}`,
    { headers: { 'sec-fetch-dest': 'empty' } },
    (response) => {
      response.resume();
      response.on('end', () => resolve(response.statusCode ?? 0));
    },
  ).on('error', reject);
  return promise;
}

/** Closes the session as passed and returns its exchanges as the record carries them. */
async function closedExchanges(session: SessionCredential): Promise<Array<Record<string, unknown>>> {
  const close = await post('/sessions/close', { sessionId: session.sessionId, outcome: 'passed' });
  expect(close.status).toBe(200);
  const response = await fetch(`${witness.url}/records`, { headers: { [RUN_HEADER]: RUN_TOKEN } });
  const body = (await response.json()) as { records?: Array<Record<string, unknown>> };
  const records = (body.records ?? []).filter((record) => record['kind'] === HTTP_EXCHANGES_KIND);
  expect(records).toHaveLength(1);
  const payload = records[0]?.['payload'] as { exchanges: Array<Record<string, unknown>> };
  return payload.exchanges;
}

const SHAPED = { responseShape: { openapiPath: '/openapi.json' } };

describe('proxied exchanges — each body checked against its declared response schema', () => {
  it('a wrong field type is a mismatch that names the first JSON pointer error', async () => {
    expect(await bind(SHAPED)).toBe(200);
    itemReply = { status: 200, contentType: 'application/json', body: '{"count":"one"}' };
    const session = await openSession();
    expect(await proxiedGet(session, '/items/1')).toBe(200);
    const [exchange] = await closedExchanges(session);
    const shape = exchange?.['shape'] as Record<string, unknown>;
    expect(shape['verdict']).toBe('mismatch');
    const errors = shape['errors'] as Array<{ pointer: string; message: string }>;
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.length).toBeLessThanOrEqual(3);
    expect(errors[0]?.pointer).toBe('/count');
    expect(typeof errors[0]?.message).toBe('string');
  });

  it('a body that matches the schema is ok', async () => {
    expect(await bind(SHAPED)).toBe(200);
    itemReply = { status: 200, contentType: 'application/json', body: '{"count":1,"note":"hi"}' };
    const session = await openSession();
    expect(await proxiedGet(session, '/items/1')).toBe(200);
    const [exchange] = await closedExchanges(session);
    expect(exchange?.['shape']).toEqual({ verdict: 'ok' });
  });

  it('OpenAPI 3.0 nullable: a null for a nullable field is ok', async () => {
    expect(await bind(SHAPED)).toBe(200);
    itemReply = { status: 200, contentType: 'application/json', body: '{"count":1,"note":null}' };
    const session = await openSession();
    expect(await proxiedGet(session, '/items/1')).toBe(200);
    const [exchange] = await closedExchanges(session);
    expect(exchange?.['shape']).toEqual({ verdict: 'ok' });
  });

  it('a body over 1 MiB is refused with HTTP_BODY_TOO_LARGE for that exchange', async () => {
    expect(await bind(SHAPED)).toBe(200);
    itemReply = {
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ count: 1, pad: 'x'.repeat(ONE_MIB + 16) }),
    };
    const session = await openSession();
    expect(await proxiedGet(session, '/items/1')).toBe(200);
    const [exchange] = await closedExchanges(session);
    expect(exchange?.['shape']).toEqual({ verdict: 'refused', why: 'HTTP_BODY_TOO_LARGE' });
  });

  it('a declared route with no response schema is unchecked, never a failure', async () => {
    expect(await bind(SHAPED)).toBe(200);
    const session = await openSession();
    expect(await proxiedGet(session, '/free')).toBe(200);
    const [exchange] = await closedExchanges(session);
    expect(exchange?.['shape']).toEqual({ verdict: 'unchecked', why: 'no-response-schema' });
  });

  it('a route the document does not declare is unchecked with no-route', async () => {
    expect(await bind(SHAPED)).toBe(200);
    const session = await openSession();
    expect(await proxiedGet(session, '/nowhere')).toBe(404);
    const [exchange] = await closedExchanges(session);
    expect(exchange?.['shape']).toEqual({ verdict: 'unchecked', why: 'no-route' });
  });

  it('a status the document does not declare for the route is unchecked', async () => {
    expect(await bind(SHAPED)).toBe(200);
    itemReply = { status: 500, contentType: 'application/json', body: '{"error":true}' };
    const session = await openSession();
    expect(await proxiedGet(session, '/items/1')).toBe(500);
    const [exchange] = await closedExchanges(session);
    expect(exchange?.['shape']).toEqual({ verdict: 'unchecked', why: 'status-undeclared' });
  });

  it('a non-JSON response on a JSON route is unchecked, never a mismatch', async () => {
    expect(await bind(SHAPED)).toBe(200);
    itemReply = { status: 200, contentType: 'text/plain', body: 'hello' };
    const session = await openSession();
    expect(await proxiedGet(session, '/items/1')).toBe(200);
    const [exchange] = await closedExchanges(session);
    expect(exchange?.['shape']).toEqual({ verdict: 'unchecked', why: 'non-json-response' });
  });

  it('a JSON-typed body that does not parse is unchecked, never a mismatch', async () => {
    expect(await bind(SHAPED)).toBe(200);
    itemReply = { status: 200, contentType: 'application/json', body: '{"count":' };
    const session = await openSession();
    expect(await proxiedGet(session, '/items/1')).toBe(200);
    const [exchange] = await closedExchanges(session);
    expect(exchange?.['shape']).toEqual({ verdict: 'unchecked', why: 'unparseable-json' });
  });

  it('an unreachable document leaves every exchange unchecked with openapi-unavailable', async () => {
    serveOpenApi = false;
    expect(await bind(SHAPED)).toBe(200);
    const session = await openSession();
    expect(await proxiedGet(session, '/items/1')).toBe(200);
    const [exchange] = await closedExchanges(session);
    expect(exchange?.['shape']).toEqual({ verdict: 'unchecked', why: 'openapi-unavailable' });
  });

  it('two exchanges with the same method, url and status keep the WORST shape through the dedup', async () => {
    expect(await bind(SHAPED)).toBe(200);
    const session = await openSession();
    itemReply = { status: 200, contentType: 'application/json', body: '{"count":1}' };
    expect(await proxiedGet(session, '/items/1')).toBe(200);
    itemReply = { status: 200, contentType: 'application/json', body: '{"count":"bad"}' };
    expect(await proxiedGet(session, '/items/1')).toBe(200);
    const exchanges = await closedExchanges(session);
    expect(exchanges).toHaveLength(1);
    expect((exchanges[0]?.['shape'] as Record<string, unknown>)['verdict']).toBe('mismatch');
  });

  it('a run that did not ask for response shapes carries no shape field on any exchange', async () => {
    expect(await bind(undefined)).toBe(200);
    itemReply = { status: 200, contentType: 'application/json', body: '{"count":"bad"}' };
    const session = await openSession();
    expect(await proxiedGet(session, '/items/1')).toBe(200);
    const exchanges = await closedExchanges(session);
    expect(exchanges).toEqual([{ method: 'GET', url: '/items/1', status: 200, fetchDest: 'empty', resourceType: null }]);
  });
});

const HTTP_REQUEST_KIND = 'http.request';
/** Opens a UI-action observation interval on the session (witness clock). */
async function openInterval(session: SessionCredential): Promise<string> {
  const response = await fetch(`${witness.url}/sessions/intervals/open`, {
    method: 'POST',
    headers: { [RUN_HEADER]: RUN_TOKEN, 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId: session.sessionId, sessionToken: session.sessionToken, operation: 'read' }),
  });
  expect(response.status).toBe(200);
  const answer = (await response.json()) as { intervalId: string };
  return answer.intervalId;
}

/** Seals the UI-action observation interval. */
async function closeInterval(session: SessionCredential, intervalId: string): Promise<void> {
  const response = await fetch(`${witness.url}/sessions/intervals/close`, {
    method: 'POST',
    headers: { [RUN_HEADER]: RUN_TOKEN, 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId: session.sessionId, sessionToken: session.sessionToken, intervalId }),
  });
  expect(response.status).toBe(200);
}

describe('engine-observed http.request records carry the exchange response shape', () => {
  it('a claimed exchange whose body mismatches its schema issues an http.request record carrying the mismatch', async () => {
    expect(await bind(SHAPED)).toBe(200);
    itemReply = { status: 200, contentType: 'application/json', body: '{"count":"one"}' };
    const session = await openSession();
    const intervalId = await openInterval(session);
    expect(await proxiedGet(session, '/items/1')).toBe(200);
    await closeInterval(session, intervalId);
    const consumed = await post('/witness/http-observation', {
      claimIds: ['http:response-matches-model:items'],
      testId: TEST_ID,
      method: 'GET',
      path: '/items/1',
      sessionId: session.sessionId,
      sessionToken: session.sessionToken,
    });
    expect(consumed.status).toBe(200);
    const response = await fetch(`${witness.url}/records`, { headers: { [RUN_HEADER]: RUN_TOKEN } });
    const body = (await response.json()) as { records?: Array<Record<string, unknown>> };
    const records = (body.records ?? []).filter((record) => record['kind'] === HTTP_REQUEST_KIND);
    expect(records).toHaveLength(1);
    const payload = records[0]?.['payload'] as Record<string, unknown>;
    const shape = payload['shape'] as Record<string, unknown>;
    expect(shape['verdict']).toBe('mismatch');
    const errors = shape['errors'] as Array<{ pointer: string }>;
    expect(errors[0]?.pointer).toBe('/count');
  });
});

describe('engine-captured exchanges are judged exactly like proxied ones', () => {
  const index = buildResponseShapeIndex(JSON.parse(OPENAPI_DOCUMENT) as unknown);
  const json = 'application/json';

  it('a body that mismatches the declared schema is a mismatch naming the JSON pointer', () => {
    const body = Buffer.from('{"count":"one"}');
    const shape = judgeEngineExchange(index, {
      method: 'GET',
      path: '/items/1',
      status: 200,
      contentType: json,
      totalBytes: body.length,
      shapeBody: body,
    });
    expect(shape.verdict).toBe('mismatch');
    expect(shape.verdict === 'mismatch' && shape.errors[0]?.pointer).toBe('/count');
  });

  it('a body that matches the declared schema is ok', () => {
    const body = Buffer.from('{"count":1}');
    expect(
      judgeEngineExchange(index, { method: 'GET', path: '/items/1', status: 200, contentType: json, totalBytes: body.length, shapeBody: body }),
    ).toEqual({ verdict: 'ok' });
  });

  it('a body the engine could not read is unchecked, never a failure', () => {
    expect(
      judgeEngineExchange(index, { method: 'GET', path: '/items/1', status: 200, contentType: json, totalBytes: null, shapeBody: Buffer.alloc(0) }),
    ).toEqual({ verdict: 'unchecked', why: 'body-unavailable' });
  });

  it('a body over the 1 MiB cap is refused for that exchange', () => {
    const total = 1024 * 1024 + 1;
    expect(
      judgeEngineExchange(index, { method: 'GET', path: '/items/1', status: 200, contentType: json, totalBytes: total, shapeBody: Buffer.alloc(0) }),
    ).toEqual({ verdict: 'refused', why: 'HTTP_BODY_TOO_LARGE' });
  });

  it('a non-JSON response on a JSON route is unchecked, never a mismatch', () => {
    const body = Buffer.from('<html/>');
    expect(
      judgeEngineExchange(index, { method: 'GET', path: '/items/1', status: 200, contentType: 'text/html', totalBytes: body.length, shapeBody: body }),
    ).toEqual({ verdict: 'unchecked', why: 'non-json-response' });
  });

  it('no OpenAPI document leaves the exchange unchecked with openapi-unavailable', () => {
    const body = Buffer.from('{"count":"one"}');
    expect(
      judgeEngineExchange(null, { method: 'GET', path: '/items/1', status: 200, contentType: json, totalBytes: body.length, shapeBody: body }),
    ).toEqual({ verdict: 'unchecked', why: 'openapi-unavailable' });
  });
});
