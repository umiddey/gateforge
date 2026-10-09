/**
 * The witness fetches the attested backend's OpenAPI document ONCE, at
 * run-context binding, and seals ONE `http.openapi` record carrying its
 * digest and the route list it declares (0.14 WP4 step 2). The witness
 * fetches only when the bound run asks for it (`responseShape`), so a
 * run with no response-shape request makes no request and issues no
 * record. An unreachable or non-JSON document is a TYPED note on the
 * record, never a refused bind: the run continues with every shape
 * unchecked.
 */
import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { RUN_HEADER, VERIFIER_HEADER } from '../src/constants.js';
import { startWitness, type WitnessHandle } from '../src/witness/server.js';

const RUN_ID = 'c3d4e5f6-0000-4000-8000-000000000003';
const INVOCATION_ID = 'c3d4e5f6-0000-4000-8000-000000000004';
const INPUT_DIGEST = 'a'.repeat(64);
const RUN_TOKEN = 'openapi-at-bind-run-token';
const VERIFIER_KEY = 'openapi-at-bind-verifier-key';
const HTTP_OPENAPI_KIND = 'http.openapi';
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

let serveOpenApi = true;
let openApiHits = 0;
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

/** The fixture app: serves the OpenAPI document (or 404) and 200 for the rest. */
function handleAppRequest(req: IncomingMessage, res: ServerResponse): void {
  if (req.url === '/openapi.json') {
    openApiHits += 1;
    if (serveOpenApi) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(OPENAPI_DOCUMENT);
    } else {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
    }
    return;
  }
  res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
  res.end('openapi-at-bind-app');
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
  serveOpenApi = true;
  openApiHits = 0;
  adaptersDir = mkdtempSync(join(tmpdir(), 'gateforge-openapi-at-bind-'));
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

/** Binds the run context, optionally asking for the response-shape plan. */
async function bind(options: Record<string, unknown> | undefined): Promise<{ status: number; body: Record<string, unknown> }> {
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
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

/** The http.openapi records in the ledger, if any. */
async function openApiRecords(): Promise<Array<Record<string, unknown>>> {
  const response = await fetch(`${witness.url}/records`, { headers: { [RUN_HEADER]: RUN_TOKEN } });
  const body = (await response.json()) as { records?: Array<Record<string, unknown>> };
  return (body.records ?? []).filter((record) => record['kind'] === HTTP_OPENAPI_KIND);
}

describe('POST /run-context — the OpenAPI document is fetched once and sealed', () => {
  it('fetches <attested backend>/openapi.json and seals its digest and declared routes', async () => {
    const answer = await bind({ responseShape: { openapiPath: '/openapi.json' } });
    expect(answer.status).toBe(200);
    expect(openApiHits).toBe(1);

    const records = await openApiRecords();
    expect(records).toHaveLength(1);
    const payload = records[0]?.['payload'] as Record<string, unknown>;
    expect(payload['status']).toBe('fetched');
    expect(payload['path']).toBe('/openapi.json');
    expect(payload['digest']).toBe(createHash('sha256').update(OPENAPI_DOCUMENT).digest('hex'));
    expect(payload['bytes']).toBe(Buffer.byteLength(OPENAPI_DOCUMENT));
    expect(payload['routes']).toEqual([
      { method: 'GET', path: '/items/{id}' },
      { method: 'POST', path: '/items' },
    ]);
  });

  it('an unreachable document is a typed note; the bind still succeeds and nothing is refused', async () => {
    serveOpenApi = false;
    const answer = await bind({ responseShape: { openapiPath: '/openapi.json' } });
    expect(answer.status).toBe(200);
    expect(openApiHits).toBe(1);

    const records = await openApiRecords();
    expect(records).toHaveLength(1);
    const payload = records[0]?.['payload'] as Record<string, unknown>;
    expect(payload['status']).toBe('unavailable');
    expect(String(payload['reason'])).toContain('404');
    expect(payload['routes']).toBeUndefined();
  });

  it('a run that does not ask for response shapes makes no request and seals no record', async () => {
    const answer = await bind(undefined);
    expect(answer.status).toBe(200);
    expect(openApiHits).toBe(0);
    expect(await openApiRecords()).toHaveLength(0);
  });
});
