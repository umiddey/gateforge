/**
 * Hook-scope setup exchanges, witness side (0.13.9): the fixture reports
 * the app-origin calls a hook-created (or module-scope) API context made
 * — traffic that never rides any session proxy and is never credited —
 * so a claim whose call went through such a context can NAME the cause.
 *
 * The report is session-AUTHENTICATED (the fixture can only report for
 * the session whose credential it holds) but RUN-SCOPED in the witness:
 * it binds to no session's evidence and can never satisfy anything. The
 * observe finalize stamps it into ONE witnessed `http.observed` record
 * carrying `channel: 'setup'`, once per run — the only way it reaches
 * the verdict engine, which reads it purely for the diagnosis.
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
const TEST_ID = 'tests/widgets.spec.js#reads-a-widget';
/** The loopback host this suite names (built, never copied from output). */
const LOOPBACK = [127, 0, 0, 1].join('.');

let witness: WitnessHandle;
let adaptersDir: string;

/** The fixture app: exists only to satisfy the attestation surface. */
const app: Server = createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
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

/** Opens one supervisor session carrying the transport claim. */
async function openSession(): Promise<SessionCredential> {
  const answer = await post('/sessions/open', { runId: RUN_ID, testId: TEST_ID, workerIndex: 0, claims: [CLAIM] }, true);
  if (answer.status !== 200) throw new Error(`session open failed: ${JSON.stringify(answer.body)}`);
  return answer.body as unknown as SessionCredential;
}

/** Registers the observe declaration set (supervisor, before the run). */
async function declareObserve(): Promise<void> {
  const answer = await post('/runs/observe-declarations', { obligations: [CLAIM] }, true);
  if (answer.status !== 200) throw new Error(`observe declarations failed: ${JSON.stringify(answer.body)}`);
}

/** Reports one hook-scope exchange through the session credential. */
async function reportSetupExchanges(
  session: SessionCredential,
  exchanges: ReadonlyArray<{ method: string; url: string; status: number }>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  return post('/sessions/setup-exchanges', {
    sessionId: session.sessionId,
    sessionToken: session.sessionToken,
    exchanges: [...exchanges],
  });
}

/** The one setup-channel record in the ledger, if any. */
function setupRecordOf(records: ReadonlyArray<Record<string, unknown>>): Record<string, unknown> | null {
  return (
    records.find(
      (candidate) =>
        candidate['kind'] === 'http.observed' &&
        typeof candidate['payload'] === 'object' &&
        candidate['payload'] !== null &&
        (candidate['payload'] as Record<string, unknown>)['channel'] === 'setup',
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

describe('POST /sessions/setup-exchanges', () => {
  it('records hook-scope exchanges and the finalize stamps one witnessed setup record', async () => {
    await declareObserve();
    const session = await openSession();
    const report = await reportSetupExchanges(session, [
      { method: 'GET', url: `${appBaseUrl}/api/widgets/77`, status: 200 },
    ]);
    expect(report.status).toBe(200);

    const finalize = await post('/observe/finalize', { sessionId: session.sessionId }, true);
    expect(finalize.status).toBe(200);

    const record = setupRecordOf(await getRecords());
    expect(record).not.toBeNull();
    expect(record?.['trust']).toBe('witnessed');
    expect(record?.['testId']).toBe(TEST_ID);
    const payload = record?.['payload'] as Record<string, unknown>;
    expect(payload['exchanges']).toEqual([
      { method: 'GET', url: `${appBaseUrl}/api/widgets/77`, status: 200 },
    ]);
  });

  it('issues the setup record once per run, never per finalize', async () => {
    await declareObserve();
    const session = await openSession();
    await reportSetupExchanges(session, [
      { method: 'GET', url: `${appBaseUrl}/api/widgets/77`, status: 200 },
    ]);
    await post('/observe/finalize', { sessionId: session.sessionId }, true);
    // A second session finalizing the same run must not duplicate.
    const second = await post('/sessions/open', { runId: RUN_ID, testId: `${TEST_ID}-second`, workerIndex: 1, claims: [CLAIM] }, true);
    expect(second.status).toBe(200);
    await post('/observe/finalize', { sessionId: (second.body as Record<string, unknown>)['sessionId'] }, true);
    const records = await getRecords();
    expect(records.filter((candidate) => setupRecordOf([candidate]) !== null)).toHaveLength(1);
  });

  it('keeps a bounded, deduplicated exchange set', async () => {
    await declareObserve();
    const session = await openSession();
    const many = Array.from({ length: 12 }, (_unused, index) => ({
      method: 'GET',
      url: `${appBaseUrl}/api/widgets/${String(index)}`,
      status: 200,
    }));
    const first = await reportSetupExchanges(session, many);
    expect(first.status).toBe(200);
    // A repeat is dropped (same exchange), not duplicated.
    const repeat = await reportSetupExchanges(session, [many[0] as { method: string; url: string; status: number }]);
    expect(repeat.status).toBe(200);
    await post('/observe/finalize', { sessionId: session.sessionId }, true);
    const payload = setupRecordOf(await getRecords())?.['payload'] as Record<string, unknown>;
    const exchanges = payload['exchanges'] as Array<unknown>;
    expect(exchanges.length).toBeLessThanOrEqual(8);
    expect(new Set(exchanges).size).toBe(exchanges.length);
  });

  it('refuses a foreign credential, a sealed session, and a malformed report', async () => {
    await declareObserve();
    const session = await openSession();
    const foreign = await post('/sessions/setup-exchanges', {
      sessionId: session.sessionId,
      sessionToken: 'not-the-issued-token',
      exchanges: [{ method: 'GET', url: `${appBaseUrl}/x`, status: 200 }],
    });
    expect(foreign.status).toBe(403);
    const malformed = await reportSetupExchanges(session, []);
    expect(malformed.status).toBe(400);
    const notAnExchange = await post('/sessions/setup-exchanges', {
      sessionId: session.sessionId,
      sessionToken: session.sessionToken,
      exchanges: [{ method: 'GET', url: 42, status: 'two-hundred' }],
    });
    expect(notAnExchange.status).toBe(400);
    // Seal, then report: post-close injection is refused like every
    // other submission.
    const close = await post('/sessions/close', { sessionId: session.sessionId, outcome: 'passed' }, true);
    expect(close.status).toBe(200);
    const late = await reportSetupExchanges(session, [
      { method: 'GET', url: `${appBaseUrl}/x`, status: 200 },
    ]);
    expect(late.status).toBe(409);
  });

  it('issues no setup record when nothing was reported', async () => {
    await declareObserve();
    const session = await openSession();
    await post('/observe/finalize', { sessionId: session.sessionId }, true);
    expect(setupRecordOf(await getRecords())).toBeNull();
  });
});
