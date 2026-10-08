/**
 * Direct API exchanges, witness side: reports are session-authenticated
 * but run-scoped, diagnostic only, and can never satisfy a claim. Finalize
 * stamps one witnessed `http.observed` record carrying `channel: 'direct'`.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { RUN_HEADER, VERIFIER_HEADER } from '../src/constants.js';
import { startWitness, type WitnessHandle } from '../src/witness/server.js';
import type { SessionCredential } from '../src/witness/types.js';

const RUN_ID = '4f4f4f4f-2c2c-4d4d-8e8e-888888888888';
const RUN_TOKEN = 'setup-exchanges-run-token';
const VERIFIER_KEY = 'setup-exchanges-verifier-key';
const RESOURCE = 'tenant.widgets';
const CLAIM = `${RESOURCE}:http:request-observed`;
const CLAIM_STATUS = `${RESOURCE}:http:response-status-ok`;
const TEST_ID = 'tests/widgets.spec.js#reads-a-widget';
/** The loopback host this suite names (built, never copied from output). */
const LOOPBACK = [127, 0, 0, 1].join('.');

let witness: WitnessHandle;
let adaptersDir: string;

/** The fixture app: exists only to satisfy the attestation surface. */
const app: Server = createServer((_req, res) => {
  res.writeHead(200, {
    'content-type': 'application/json; charset=utf-8',
    'x-gateforge-env-fingerprint': 'setup-exchanges-fixture-v1',
  });
  res.end('{}');
});
let appBaseUrl: string;

beforeAll(async () => {
  await new Promise<void>((resolve) => app.listen(0, LOOPBACK, resolve));
  appBaseUrl = `http://${LOOPBACK}:${String((app.address() as AddressInfo).port)}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => app.close(() => resolve()));
});

/** Posts JSON to one witness endpoint. */
async function post(path: string, body: unknown, verifier = false): Promise<{ status: number; body: Record<string, unknown> }> {
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

/** Reads JSON from one witness endpoint. */
async function getRecords(): Promise<Array<Record<string, unknown>>> {
  const response = await fetch(`${witness.url}/records`, {
    headers: { [RUN_HEADER]: RUN_TOKEN },
  });
  const body = (await response.json()) as { records?: Array<Record<string, unknown>> };
  return body.records ?? [];
}

/** Opens one supervisor session with its transport claims. */
async function openSession(testId = TEST_ID, workerIndex = 0, claims = [CLAIM, CLAIM_STATUS]): Promise<SessionCredential> {
  const answer = await post('/sessions/open', { runId: RUN_ID, testId, workerIndex, claims }, true);
  if (answer.status !== 200) throw new Error(`session open failed: ${JSON.stringify(answer.body)}`);
  return answer.body as unknown as SessionCredential;
}

/** Registers the observe declaration set (supervisor, before the run). */
async function declareObserve(): Promise<void> {
  const answer = await post('/runs/observe-declarations', { obligations: [CLAIM, CLAIM_STATUS] }, true);
  if (answer.status !== 200) throw new Error(`observe declarations failed: ${JSON.stringify(answer.body)}`);
}

/** Reports direct API exchanges through the session credential. */
async function reportDirectExchanges(
  session: SessionCredential,
  exchanges: ReadonlyArray<{ method: string; url: string; status: number }>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  return post('/sessions/direct-exchanges', {
    sessionId: session.sessionId,
    sessionToken: session.sessionToken,
    exchanges: [...exchanges],
  });
}

/** The one direct-channel record in the ledger, if any. */
function directRecordOf(records: ReadonlyArray<Record<string, unknown>>): Record<string, unknown> | null {
  return (
    records.find(
      (candidate) =>
        candidate['kind'] === 'http.observed' &&
        typeof candidate['payload'] === 'object' &&
        candidate['payload'] !== null &&
        (candidate['payload'] as Record<string, unknown>)['channel'] === 'direct',
    ) ?? null
  );
}

beforeEach(async () => {
  adaptersDir = mkdtempSync(join(tmpdir(), 'gateforge-setup-exchanges-'));
  witness = await startWitness({
    runId: RUN_ID,
    token: RUN_TOKEN,
    verifierKey: VERIFIER_KEY,
    adaptersDir,
    classificationsPath: null,
    adapterBaseUrl: appBaseUrl,
    targetBaseUrl: appBaseUrl,
    targetFingerprint: 'setup-exchanges-fixture-v1',
  });
});

afterEach(async () => {
  await witness.stop();
  rmSync(adaptersDir, { recursive: true, force: true });
});

describe('POST /sessions/direct-exchanges', () => {
  it('records direct API exchanges and stamps them as diagnostic-only records', async () => {
    await declareObserve();
    const session = await openSession();
    const report = await reportDirectExchanges(session, [
      { method: 'GET', url: `${appBaseUrl}/api/widgets/77`, status: 200 },
    ]);
    expect(report.status).toBe(200);

    const finalize = await post('/observe/finalize', { sessionId: session.sessionId }, true);
    expect(finalize.status).toBe(200);

    const record = directRecordOf(await getRecords());
    expect(record).not.toBeNull();
    expect(record?.['trust']).toBe('witnessed');
    expect(record?.['testId']).toBe(TEST_ID);
    const payload = record?.['payload'] as Record<string, unknown>;
    expect(payload['exchanges']).toEqual([
      { method: 'GET', url: `${appBaseUrl}/api/widgets/77`, status: 200 },
    ]);
  });

  it('stamps each session direct exchanges for every claim exactly once', async () => {
    await declareObserve();
    const first = await openSession();
    const firstExchanges = [
      { method: 'GET', url: `${appBaseUrl}/api/widgets/77`, status: 200 },
    ];
    await reportDirectExchanges(first, firstExchanges);
    await post('/observe/finalize', { sessionId: first.sessionId }, true);

    const secondTestId = `${TEST_ID}-second`;
    const second = await openSession(secondTestId, 1);
    const secondExchanges = [
      { method: 'GET', url: `${appBaseUrl}/api/widgets/88`, status: 200 },
    ];
    await reportDirectExchanges(second, secondExchanges);
    await post('/observe/finalize', { sessionId: second.sessionId }, true);
    await post('/observe/finalize', { sessionId: second.sessionId }, true);

    const directRecords = (await getRecords()).filter((candidate) => directRecordOf([candidate]) !== null);
    expect(directRecords).toHaveLength(4);
    expect(directRecords.filter((candidate) => candidate['testId'] === TEST_ID)).toHaveLength(2);
    expect(directRecords.filter((candidate) => candidate['testId'] === secondTestId)).toHaveLength(2);
    expect(directRecords.filter((candidate) => candidate['obligationId'] === CLAIM)).toHaveLength(2);
    expect(directRecords.filter((candidate) => candidate['obligationId'] === CLAIM_STATUS)).toHaveLength(2);
    for (const candidate of directRecords) {
      const expected = candidate['testId'] === TEST_ID ? firstExchanges : secondExchanges;
      expect((candidate['payload'] as Record<string, unknown>)['exchanges']).toEqual(expected);
    }
  });

  it('keeps a bounded, deduplicated exchange set', async () => {
    await declareObserve();
    const session = await openSession();
    const many = Array.from({ length: 12 }, (_unused, index) => ({
      method: 'GET',
      url: `${appBaseUrl}/api/widgets/${String(index)}`,
      status: 200,
    }));
    const first = await reportDirectExchanges(session, many);
    expect(first.status).toBe(200);
    // A repeat is dropped (same exchange), not duplicated.
    const repeat = await reportDirectExchanges(session, [many[0] as { method: string; url: string; status: number }]);
    expect(repeat.status).toBe(200);
    await post('/observe/finalize', { sessionId: session.sessionId }, true);
    const payload = directRecordOf(await getRecords())?.['payload'] as Record<string, unknown>;
    const exchanges = payload['exchanges'] as Array<unknown>;
    expect(exchanges.length).toBeLessThanOrEqual(8);
    expect(new Set(exchanges).size).toBe(exchanges.length);
  });

  it('refuses a foreign credential, a sealed session, and a malformed report', async () => {
    await declareObserve();
    const session = await openSession();
    const foreign = await post('/sessions/direct-exchanges', {
      sessionId: session.sessionId,
      sessionToken: 'not-the-issued-token',
      exchanges: [{ method: 'GET', url: `${appBaseUrl}/x`, status: 200 }],
    });
    expect(foreign.status).toBe(403);
    const malformed = await reportDirectExchanges(session, []);
    expect(malformed.status).toBe(400);
    const notAnExchange = await post('/sessions/direct-exchanges', {
      sessionId: session.sessionId,
      sessionToken: session.sessionToken,
      exchanges: [{ method: 'GET', url: 42, status: 'two-hundred' }],
    });
    expect(notAnExchange.status).toBe(400);
    // Seal, then report: post-close injection is refused like every
    // other submission.
    const close = await post('/sessions/close', { sessionId: session.sessionId, outcome: 'passed' }, true);
    expect(close.status).toBe(200);
    const late = await reportDirectExchanges(session, [
      { method: 'GET', url: `${appBaseUrl}/x`, status: 200 },
    ]);
    expect(late.status).toBe(409);
  });

  it('issues no setup record when nothing was reported', async () => {
    await declareObserve();
    const session = await openSession();
    await post('/observe/finalize', { sessionId: session.sessionId }, true);
    expect(directRecordOf(await getRecords())).toBeNull();
  });
});
