/**
 * Per-session adapter identity, witness side (plan 2026-09-25 Phase 4b
 * item 3b).
 *
 * The kit resolves a seat by the session the read belongs to
 * (`session-identity.test.ts`); this file covers the witness half:
 *
 * - the engine's own read runs under the identity THAT session
 *   registered (the adapter states which account it read as);
 * - a registration for a foreign or already-ended session is refused;
 * - without a registration the read runs as the process-global seat, so
 *   one session's identity is never a fallback for another;
 * - the credential appears in NO record, the ledger, or the trace.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { RUN_HEADER, VERIFIER_HEADER } from '../src/constants.js';
import { startWitness, type WitnessHandle } from '../src/witness/server.js';
import type { SessionCredential } from '../src/witness/types.js';

const RUN_ID = '7f7f7f7f-1c1c-4d4d-8e8e-999999999999';
const RUN_TOKEN = 'session-identity-run-token';
const VERIFIER_KEY = 'session-identity-verifier-key';
const RESOURCE = 'tenant.ledger_entries';
const APP_FINGERPRINT = 'identity-fixture-v1';
const USER_ENV = 'GATEFORGE_TEST_TENANT_USER';
const PASSWORD_ENV = 'GATEFORGE_TEST_TENANT_PASSWORD';
/** The loopback host this suite names (built, never copied from output). */
const LOOPBACK = [127, 0, 0, 1].join('.');
/** A credential built at runtime, so no literal can ever be scanned for. */
const RUNTIME_SECRET = `rt-${Math.random().toString(36).slice(2)}-${Date.now()}`;

/** The adapter the witness loads: it reports WHICH account it read as. */
const ADAPTER_SOURCE = `
/**
 * A reviewed evidence adapter that states the account the engine read
 * as, so a session-bound read is observable instead of inferred.
 */
export default {
  resourceId: ${JSON.stringify(RESOURCE)},
  async read(ctx) {
    const identity = ctx.sessionIdentity ?? null;
    return {
      id: 'entry-1',
      tenant: identity === null ? 'env-seat' : String(identity.values[${JSON.stringify(USER_ENV)}]),
    };
  },
  normalize(body) {
    return { entityId: body.id, fields: { id: body.id, tenant: body.tenant } };
  },
  deletion: 'hard',
  environmentFingerprint: ${JSON.stringify(APP_FINGERPRINT)},
};
`;

/** One HTTP answer from the witness. */
interface Answer {
  status: number;
  body: Record<string, unknown>;
}

let witness: WitnessHandle;
let adaptersDir: string;

/**
 * The attested fixture app: it exists to answer with the GF-13
 * environment-fingerprint marker the witness insists on before it seals
 * a persistence record (the fixture adapter reads no HTTP itself).
 */
const app: Server = createServer((_req, res) => {
  res.writeHead(200, {
    'content-type': 'application/json; charset=utf-8',
    'x-gateforge-env-fingerprint': APP_FINGERPRINT,
  });
  res.end('{}');
});
/** The app's loopback base (the read base the witness is pointed at). */
let appBaseUrl: string;

beforeAll(async () => {
  await new Promise<void>((resolve) => app.listen(0, LOOPBACK, resolve));
  appBaseUrl = `http://${LOOPBACK}:${String((app.address() as AddressInfo).port)}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => app.close(() => resolve()));
});

/** Posts JSON to one witness endpoint. */
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

/** Reads JSON from one witness endpoint. */
async function get(path: string, verifier = false): Promise<Answer> {
  const response = await fetch(`${witness.url}${path}`, {
    headers: { [RUN_HEADER]: RUN_TOKEN, ...(verifier ? { [VERIFIER_HEADER]: VERIFIER_KEY } : {}) },
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

/** Opens one supervisor session (the only channel that can open one). */
async function openSession(testId: string, workerIndex: number): Promise<SessionCredential> {
  const answer = await post(
    '/sessions/open',
    { runId: RUN_ID, testId, workerIndex },
    true,
  );
  if (answer.status !== 200) throw new Error(`session open failed: ${JSON.stringify(answer.body)}`);
  return answer.body as unknown as SessionCredential;
}

/** Registers this session's tenant login for its own session. */
function registerIdentity(session: SessionCredential, user: string): Promise<Answer> {
  return post('/sessions/identity', {
    sessionId: session.sessionId,
    sessionToken: session.sessionToken,
    seat: 'tenant-seat',
    values: { [USER_ENV]: user, [PASSWORD_ENV]: RUNTIME_SECRET },
  });
}

/** Performs the engine's read for one session and returns its answer. */
async function readAs(session: SessionCredential, entityId: string): Promise<Answer> {
  const answer = await post('/witness/persistence', {
    sessionId: session.sessionId,
    sessionToken: session.sessionToken,
    resourceId: RESOURCE,
    entityId,
    testId: session.testId,
    claimId: `${RESOURCE}:persistence:read`,
  });
  if (answer.status !== 200) throw new Error(`read failed: ${JSON.stringify(answer.body)}`);
  return answer;
}

beforeEach(async () => {
  adaptersDir = mkdtempSync(join(tmpdir(), 'gateforge-identity-'));
  writeFileSync(join(adaptersDir, `${RESOURCE}.mjs`), ADAPTER_SOURCE, 'utf8');
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

describe('POST /sessions/identity: the engine reads as the registering session', () => {
  it('reads under that session identity, and never as another one', async () => {
    const first = await openSession('tests/ledger#first', 0);
    const second = await openSession('tests/ledger#second', 1);
    expect((await registerIdentity(first, 'user-a')).status).toBe(200);

    // The engine's own read, made through the witness, under session one.
    expect((await readAs(first, 'entry-1')).body['verdictRelevant']).toEqual({
      found: true,
      fieldsMatch: true,
    });
    const firstRecord = (await get('/records')).body['records'] as Array<Record<string, unknown>>;
    expect(JSON.stringify(firstRecord)).toContain('user-a');

    // Session two registered nothing: it reads as the process-global
    // seat, never as session one's identity.
    await readAs(second, 'entry-1');
    const records = (await get('/records')).body['records'] as Array<Record<string, unknown>>;
    expect(JSON.stringify(records)).toContain('env-seat');
    expect(JSON.stringify(records)).not.toContain('user-b');
  });

  it('refuses a registration for a session the caller is not', async () => {
    const first = await openSession('tests/ledger#first', 0);
    const second = await openSession('tests/ledger#second', 1);
    // Session one presenting session two's id with its own token.
    expect((await registerIdentity(first, 'user-a')).status).toBe(200);
    const foreign = await post('/sessions/identity', {
      sessionId: second.sessionId,
      sessionToken: first.sessionToken,
      seat: 'tenant-seat',
      values: { [USER_ENV]: 'user-b', [PASSWORD_ENV]: RUNTIME_SECRET },
    });
    expect(foreign.status).toBe(403);
    // …and the reverse: second's id, first's token, is equally refused.
    const alsoForeign = await post('/sessions/identity', {
      sessionId: first.sessionId,
      sessionToken: second.sessionToken,
      seat: 'tenant-seat',
      values: { [USER_ENV]: 'user-b', [PASSWORD_ENV]: RUNTIME_SECRET },
    });
    expect(alsoForeign.status).toBe(403);
  });

  it('refuses a registration for a session that already ended', async () => {
    const first = await openSession('tests/ledger#first', 0);
    expect((await registerIdentity(first, 'user-a')).status).toBe(200);
    expect((await post('/sessions/close', { sessionId: first.sessionId }, true)).status).toBe(200);
    const afterClose = await registerIdentity(first, 'user-a');
    expect(afterClose.status).toBe(409);
    expect(String(afterClose.body['error'] ?? '')).toMatch(/sealed/);
  });

  it('drops the identity with the session: a fresh session reads as the env seat', async () => {
    const first = await openSession('tests/ledger#first', 0);
    await registerIdentity(first, 'user-a');
    await post('/sessions/close', { sessionId: first.sessionId }, true);
    // The same (worker, testId) pair opens a NEW session: it inherits
    // nothing, because the identity died with the one that registered it.
    const again = await openSession('tests/ledger#first', 0);
    expect(again.sessionId).not.toBe(first.sessionId);
    await readAs(again, 'entry-1');
    const records = (await get('/records')).body['records'] as Array<Record<string, unknown>>;
    expect(JSON.stringify(records)).toContain('env-seat');
  });

  it('keeps the credential out of every record, the ledger, and the trace', async () => {
    const session = await openSession('tests/ledger#first', 0);
    const registration = await registerIdentity(session, 'user-a');
    expect(JSON.stringify(registration.body)).not.toContain(RUNTIME_SECRET);
    await readAs(session, 'entry-1');
    const records = JSON.stringify((await get('/records')).body);
    const trace = JSON.stringify((await get('/runs/execution-trace', true)).body);
    expect(records).not.toContain(RUNTIME_SECRET);
    expect(trace).not.toContain(RUNTIME_SECRET);
    // The username is the app's own data and DOES reach the record —
    // the credential does not.
    expect(records).toContain('user-a');
  });

  it('rejects a malformed registration instead of storing a half credential', async () => {
    const session = await openSession('tests/ledger#first', 0);
    for (const body of [
      { seat: 'tenant-seat', values: {} },
      { seat: '', values: { [USER_ENV]: 'user-a' } },
      { seat: 'tenant-seat', values: { [USER_ENV]: 'user-a', [PASSWORD_ENV]: 7 } },
      { seat: 'tenant-seat', values: [] },
      { seat: 'tenant-seat' },
    ]) {
      const answer = await post('/sessions/identity', {
        sessionId: session.sessionId,
        sessionToken: session.sessionToken,
        ...body,
      });
      expect(answer.status).toBe(400);
    }
    await readAs(session, 'entry-1');
    expect(JSON.stringify((await get('/records')).body)).toContain('env-seat');
  });
});