/**
 * Observe-channel tests (witness side, Phase 2): the
 * `POST /runs/observe-declarations` + `POST /observe/finalize`
 * supervisor surface over real loopback HTTP. Suite-driven browser
 * traffic through the session proxy plus the witness's own adapter
 * reads resolve into witnessed `persistence.observed` records. Proves:
 * - the supervisor authority gate (verifier key required) and the
 *   pre-run bind-once declaration contract;
 * - create/update/read/delete resolution with witness-held
 *   before-snapshots (open-time list) and the list-diff new-id rule;
 * - exact request-body echo capture (JSON + form) stamped for the
 *   engine to grade;
 * - typed notes (never satisfaction) for missing traffic, ambiguity,
 *   unparsable/oversized/unsupported bodies, unknown entities, missing
 *   bindings/lists, undeclared claims, and sealed sessions;
 * - single-use exchange consumption;
 * - collection reads: a read binding that declares `collection`
 *   resolves the rows its own proxied response returned against the
 *   session-open snapshot — wrapped or root-array, deterministic
 *   across several rows, and a typed note for every body that names
 *   no usable row;
 * - one route claimed by two resources with DIFFERENT declared shapes
 *   credits neither and names both declarations; with the SAME shape
 *   the one exchange still credits exactly one claim;
 * - a returned row that is gone by finalize time is stamped as the
 *   absence the engine's own read observed, and grades as such;
 * - declared `volatileFields` on a real observed record: the engine
 *   skips a server-rewritten field the adapter declared and still
 *   blocks one it did not.
 * - proxy-bypass traffic is invisible to finalize.
 */
import { describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { startWitness } from '../src/witness/server.js';
import {
  evaluateObligation,
  ObligationSchema,
  volatileEchoSkips,
  volatileFieldsOf,
  recordIdOf,
  type Obligation,
  type VerdictOutcome,
} from '@gate-forge/core';
import {
  makeTempProject,
  writeFixtureProject,
  writeObserveAdapter,
  openSupervisorSession,
  closeSupervisorSession,
  writeSecondCollectionAdapter,
  type SupervisorSession,
} from './helpers.js';
import { startMarkerServer } from './marker-server.js';
import { RUN_HEADER, VERIFIER_HEADER } from '../src/constants.js';

const TOKEN = 'run-token-abc-123';
const VERIFIER_KEY = 'verifier-secret-the-suite-never-sees';
const TEST_ID = 'playwright:chromium:e2e/accounts.spec.js:creates an account';
const CREATE_CLAIM = 'tenant.accounts:persistence:create';
const READ_CLAIM = 'tenant.accounts:persistence:read';
const UPDATE_CLAIM = 'tenant.accounts:persistence:update';
const DELETE_CLAIM = 'tenant.accounts:persistence:delete';
const ORDERS_READ_CLAIM = 'tenant.orders:persistence:read';

function supervisorHeaders(): Record<string, string> {
  return { [RUN_HEADER]: TOKEN, [VERIFIER_HEADER]: VERIFIER_KEY, 'content-type': 'application/json' };
}

async function post(
  url: string,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${url}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

/** Starts a witness bound to a temp fixture project + stateful marker target. */
async function startFixturedWitness(
  options: Parameters<typeof writeObserveAdapter>[1] & {
    /** A SECOND resource's collection read over the SAME list route. */
    ordersCollection?: { rowsKey: string; idKey: string };
  } = {},
) {
  const { ordersCollection, ...adapterOptions } = options;
  const runId = randomUUID();
  const project = makeTempProject('observe-finalize');
  writeFixtureProject(project);
  writeObserveAdapter(project, adapterOptions);
  if (ordersCollection !== undefined) writeSecondCollectionAdapter(project, ordersCollection);
  const target = await startMarkerServer('example-v1');
  const stateDir = join(project, '.gateforge/test-gates');
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(
    join(stateDir, 'manifest.json'),
    `${JSON.stringify({
      schemaVersion: 1,
      runId,
      startedAt: '2026-08-30T12:00:00.000Z',
      gitSha: null,
      provider: 'local-staged',
      plugins: [],
      attestationScope: null,
    })}\n`,
  );
  const witness = await startWitness({
    runId,
    token: TOKEN,
    verifierKey: VERIFIER_KEY,
    stateDir,
    adaptersDir: join(project, '.gateforge/adapters'),
    classificationsPath: join(project, '.gateforge/effective-classifications.yml'),
    targetBaseUrl: target.url,
    targetFingerprint: 'example-v1',
    adapterBaseUrl: target.url,
    proxyTarget: target.url,
    now: () => '2026-08-30T12:00:01.000Z',
  });
  return { witness, target, runId };
}

async function declare(
  url: string,
  obligations: string[],
  headers: Record<string, string> = supervisorHeaders(),
): Promise<{ status: number; body: Record<string, unknown> }> {
  return post(url, '/runs/observe-declarations', { obligations }, headers);
}

async function finalize(
  url: string,
  sessionId: string,
  headers: Record<string, string> = supervisorHeaders(),
): Promise<{ status: number; body: Record<string, unknown> }> {
  return post(url, '/observe/finalize', { sessionId }, headers);
}

async function openClaimedSession(
  url: string,
  claims: string[],
  testId = TEST_ID,
  workerIndex = 0,
): Promise<SupervisorSession> {
  return openSupervisorSession(url, TOKEN, testId, workerIndex, VERIFIER_KEY, claims);
}

/** Sends one HTTP exchange through a session's dedicated proxy port. */
async function proxyExchange(
  proxyUrl: string,
  method: string,
  path: string,
  body: string | null = null,
  contentType = 'application/json',
): Promise<{ status: number; text: string }> {
  const response = await fetch(`${proxyUrl}${path}`, {
    method,
    headers: body === null ? {} : { 'content-type': contentType, 'content-length': String(Buffer.byteLength(body)) },
    body,
  });
  return { status: response.status, text: await response.text() };
}

async function ledgerRecords(url: string): Promise<Array<Record<string, unknown>>> {
  const response = await fetch(`${url}/records`, { headers: { [RUN_HEADER]: TOKEN } });
  return ((await response.json()) as { records: Array<Record<string, unknown>> }).records;
}

describe('observe declarations (supervisor authority + pre-run binding)', () => {
  it('refuses the run token alone; binds with the verifier key; identical re-bind is idempotent', async () => {
    const fixture = await startFixturedWitness();
    try {
      const denied = await declare(fixture.witness.url, [CREATE_CLAIM], { [RUN_HEADER]: TOKEN, 'content-type': 'application/json' });
      expect(denied.status).toBe(401);
      const bound = await declare(fixture.witness.url, [CREATE_CLAIM]);
      expect(bound.status).toBe(200);
      expect(bound.body).toMatchObject({ bound: true, count: 1, obligations: [CREATE_CLAIM] });
      const again = await declare(fixture.witness.url, [CREATE_CLAIM]);
      expect(again.status).toBe(200);
    } finally {
      await fixture.witness.stop();
      await fixture.target.stop();
    }
  });

  it('refuses a changed set and late registration after sessions opened', async () => {
    const fixture = await startFixturedWitness();
    try {
      expect((await declare(fixture.witness.url, [CREATE_CLAIM])).status).toBe(200);
      const changed = await declare(fixture.witness.url, [CREATE_CLAIM, READ_CLAIM]);
      expect(changed.status).toBe(409);
      const session = await openClaimedSession(fixture.witness.url, [CREATE_CLAIM]);
      expect(session.proxyUrl).not.toBe(null);
      const late = await declare(fixture.witness.url, [CREATE_CLAIM]);
      expect(late.status).toBe(200); // identical re-bind stays idempotent
      const lateChanged = await declare(fixture.witness.url, [READ_CLAIM]);
      expect(lateChanged.status).toBe(409);
      await closeSupervisorSession(fixture.witness.url, TOKEN, session.sessionId, 'passed', VERIFIER_KEY);
    } finally {
      await fixture.witness.stop();
      await fixture.target.stop();
    }
  });

  it('refuses declarations once the witness holds open sessions (fresh witness)', async () => {
    const fixture = await startFixturedWitness();
    try {
      const session = await openClaimedSession(fixture.witness.url, []);
      const late = await declare(fixture.witness.url, [CREATE_CLAIM]);
      expect(late.status).toBe(409);
      await closeSupervisorSession(fixture.witness.url, TOKEN, session.sessionId, 'passed', VERIFIER_KEY);
    } finally {
      await fixture.witness.stop();
      await fixture.target.stop();
    }
  });
});

describe('observe finalize (create)', () => {
  it('resolves a proxied JSON create into a witnessed persistence.observed record', async () => {
    const fixture = await startFixturedWitness();
    try {
      expect((await declare(fixture.witness.url, [CREATE_CLAIM])).status).toBe(200);
      const session = await openClaimedSession(fixture.witness.url, [CREATE_CLAIM]);
      const proxyUrl = session.proxyUrl as string;
      const sent = await proxyExchange(proxyUrl, 'POST', '/api/accounts', JSON.stringify({ first_name: 'Grace', last_name: 'Hopper' }));
      expect(sent.status).toBe(200);
      const done = await finalize(fixture.witness.url, session.sessionId);
      expect(done.status).toBe(200);
      const finalized = done.body['finalized'] as Array<Record<string, unknown>>;
      expect(finalized).toHaveLength(1);
      expect(finalized[0]).toMatchObject({ obligationId: CREATE_CLAIM, operation: 'create' });
      // The entity id is witness-resolved (marker mints '2' on a fresh instance).
      expect(finalized[0]?.['entityId']).toBe('2');
      const records = await ledgerRecords(fixture.witness.url);
      const observed = records.filter((entry) => entry['kind'] === 'persistence.observed');
      expect(observed).toHaveLength(1);
      const record = observed[0] as Record<string, unknown>;
      expect(record['trust']).toBe('witnessed');
      expect(record['origin']).toBe('engine-observed');
      expect(record['testId']).toBe(TEST_ID);
      const payload = record['payload'] as Record<string, unknown>;
      expect(payload['channel']).toBe('observe');
      expect(payload['entityId']).toBe('2');
      expect(payload['found']).toBe(true);
      expect(payload['fields']).toMatchObject({ first_name: 'Grace', last_name: 'Hopper' });
      expect(payload['before']).toEqual({ entityAbsent: true });
      expect(payload['observedFields']).toMatchObject({ first_name: 'Grace', last_name: 'Hopper' });
      expect(payload['exchange']).toMatchObject({ method: 'POST', path: '/api/accounts', status: 200 });
      // Provenance recomputes from the record's own contents (pin #7).
      expect(
        recordIdOf({
          runId: record['runId'] as string,
          obligationId: record['obligationId'] as string,
          kind: record['kind'] as string,
          testId: record['testId'] as string,
          origin: record['origin'] as 'engine-observed',
          payload: record['payload'],
        }),
      ).toBe(record['recordId']);
      await closeSupervisorSession(fixture.witness.url, TOKEN, session.sessionId, 'passed', VERIFIER_KEY);
    } finally {
      await fixture.witness.stop();
      await fixture.target.stop();
    }
  });

  it('consumes the exchange single-use: a second finalize finds no traffic', async () => {
    const fixture = await startFixturedWitness();
    try {
      await declare(fixture.witness.url, [CREATE_CLAIM]);
      const session = await openClaimedSession(fixture.witness.url, [CREATE_CLAIM]);
      await proxyExchange(session.proxyUrl as string, 'POST', '/api/accounts', JSON.stringify({ first_name: 'A', last_name: 'B' }));
      expect(((await finalize(fixture.witness.url, session.sessionId)).body['finalized'] as unknown[])).toHaveLength(1);
      const second = await finalize(fixture.witness.url, session.sessionId);
      expect(second.status).toBe(200);
      expect(second.body['finalized']).toEqual([]);
      expect(JSON.stringify(second.body['notes'])).toContain('no POST /api/accounts exchange');
      await closeSupervisorSession(fixture.witness.url, TOKEN, session.sessionId, 'passed', VERIFIER_KEY);
    } finally {
      await fixture.witness.stop();
      await fixture.target.stop();
    }
  });

  it('notes missing traffic and proxy bypass instead of satisfying', async () => {
    const fixture = await startFixturedWitness();
    try {
      await declare(fixture.witness.url, [CREATE_CLAIM]);
      const session = await openClaimedSession(fixture.witness.url, [CREATE_CLAIM]);
      const empty = await finalize(fixture.witness.url, session.sessionId);
      expect(empty.body['finalized']).toEqual([]);
      expect(JSON.stringify(empty.body['notes'])).toContain('no POST /api/accounts exchange');
      // Direct-to-target traffic bypasses every session channel: invisible.
      await proxyExchange(fixture.target.url, 'POST', '/api/accounts', JSON.stringify({ first_name: 'X', last_name: 'Y' }));
      const bypassed = await finalize(fixture.witness.url, session.sessionId);
      expect(bypassed.body['finalized']).toEqual([]);
      expect((await ledgerRecords(fixture.witness.url)).filter((entry) => entry['kind'] === 'persistence.observed')).toEqual([]);
      await closeSupervisorSession(fixture.witness.url, TOKEN, session.sessionId, 'passed', VERIFIER_KEY);
    } finally {
      await fixture.witness.stop();
      await fixture.target.stop();
    }
  });

  it('notes ambiguity when two creates match instead of picking one', async () => {
    const fixture = await startFixturedWitness();
    try {
      await declare(fixture.witness.url, [CREATE_CLAIM]);
      const session = await openClaimedSession(fixture.witness.url, [CREATE_CLAIM]);
      const proxyUrl = session.proxyUrl as string;
      await proxyExchange(proxyUrl, 'POST', '/api/accounts', JSON.stringify({ first_name: 'A', last_name: 'One' }));
      await proxyExchange(proxyUrl, 'POST', '/api/accounts', JSON.stringify({ first_name: 'B', last_name: 'Two' }));
      const done = await finalize(fixture.witness.url, session.sessionId);
      expect(done.body['finalized']).toEqual([]);
      expect(JSON.stringify(done.body['notes'])).toContain('ambiguous');
      expect((await ledgerRecords(fixture.witness.url)).filter((entry) => entry['kind'] === 'persistence.observed')).toEqual([]);
      await closeSupervisorSession(fixture.witness.url, TOKEN, session.sessionId, 'passed', VERIFIER_KEY);
    } finally {
      await fixture.witness.stop();
      await fixture.target.stop();
    }
  });

  it('resolves a form-encoded create (echo mismatch is grader-side, the record still stamps)', async () => {
    const fixture = await startFixturedWitness();
    try {
      await declare(fixture.witness.url, [CREATE_CLAIM]);
      const session = await openClaimedSession(fixture.witness.url, [CREATE_CLAIM]);
      // The marker only understands JSON: it mints empty names, so the
      // observed fields will NOT echo — the witness still stamps what it
      // saw; the verdict engine grades the mismatch invalid.
      await proxyExchange(
        session.proxyUrl as string,
        'POST',
        '/api/accounts',
        'first_name=Ada&last_name=Lovelace',
        'application/x-www-form-urlencoded',
      );
      const done = await finalize(fixture.witness.url, session.sessionId);
      const finalized = done.body['finalized'] as Array<Record<string, unknown>>;
      expect(finalized).toHaveLength(1);
      const records = await ledgerRecords(fixture.witness.url);
      const payload = (records.find((entry) => entry['kind'] === 'persistence.observed')?.['payload']) as Record<string, unknown>;
      expect(payload['observedFields']).toMatchObject({ first_name: 'Ada', last_name: 'Lovelace' });
      expect(payload['fields']).toMatchObject({ first_name: '', last_name: '' });
      await closeSupervisorSession(fixture.witness.url, TOKEN, session.sessionId, 'passed', VERIFIER_KEY);
    } finally {
      await fixture.witness.stop();
      await fixture.target.stop();
    }
  });

  it('notes unsupported content-types and oversized bodies instead of echoing guesses', async () => {
    const fixture = await startFixturedWitness();
    try {
      await declare(fixture.witness.url, [CREATE_CLAIM]);
      const session = await openClaimedSession(fixture.witness.url, [CREATE_CLAIM]);
      const proxyUrl = session.proxyUrl as string;
      await proxyExchange(proxyUrl, 'POST', '/api/accounts', 'hello', 'text/plain');
      const unsupported = await finalize(fixture.witness.url, session.sessionId);
      expect(unsupported.body['finalized']).toEqual([]);
      expect(JSON.stringify(unsupported.body['notes'])).toContain('unsupported request content-type');
      const big = JSON.stringify({ first_name: 'X'.repeat(70000), last_name: 'Y' });
      await proxyExchange(proxyUrl, 'POST', '/api/accounts', big);
      const oversized = await finalize(fixture.witness.url, session.sessionId);
      // Two exchanges now match (text + big): ambiguity fires before body
      // parsing — still a note, still no record. Send a lone oversized
      // exchange on a fresh session to prove the size note.
      expect(oversized.body['finalized']).toEqual([]);
      await closeSupervisorSession(fixture.witness.url, TOKEN, session.sessionId, 'passed', VERIFIER_KEY);
      const session2 = await openClaimedSession(fixture.witness.url, [CREATE_CLAIM], `${TEST_ID}-big`);
      await proxyExchange(session2.proxyUrl as string, 'POST', '/api/accounts', big);
      const alone = await finalize(fixture.witness.url, session2.sessionId);
      expect(alone.body['finalized']).toEqual([]);
      expect(JSON.stringify(alone.body['notes'])).toContain('exceeds');
      await closeSupervisorSession(fixture.witness.url, TOKEN, session2.sessionId, 'passed', VERIFIER_KEY);
    } finally {
      await fixture.witness.stop();
      await fixture.target.stop();
    }
  });
});

describe('observe finalize (update / read / delete)', () => {
  it('resolves an update with the witness-held before-state', async () => {
    const fixture = await startFixturedWitness();
    try {
      await declare(fixture.witness.url, [UPDATE_CLAIM]);
      const session = await openClaimedSession(fixture.witness.url, [UPDATE_CLAIM]);
      await proxyExchange(
        session.proxyUrl as string,
        'PATCH',
        '/api/accounts/acc-1',
        JSON.stringify({ first_name: 'Augusta' }),
      );
      const done = await finalize(fixture.witness.url, session.sessionId);
      const finalized = done.body['finalized'] as Array<Record<string, unknown>>;
      expect(finalized).toHaveLength(1);
      expect(finalized[0]).toMatchObject({ obligationId: UPDATE_CLAIM, operation: 'update', entityId: 'acc-1' });
      const records = await ledgerRecords(fixture.witness.url);
      const payload = (records.find((entry) => entry['kind'] === 'persistence.observed')?.['payload']) as Record<string, unknown>;
      expect(payload['before']).toMatchObject({ found: true, fields: { first_name: 'Ada' } });
      expect(payload['fields']).toMatchObject({ first_name: 'Augusta' });
      expect(payload['observedFields']).toMatchObject({ first_name: 'Augusta' });
      await closeSupervisorSession(fixture.witness.url, TOKEN, session.sessionId, 'passed', VERIFIER_KEY);
    } finally {
      await fixture.witness.stop();
      await fixture.target.stop();
    }
  });

  it('notes an update for an entity created after the open snapshot', async () => {
    const fixture = await startFixturedWitness();
    try {
      await declare(fixture.witness.url, [UPDATE_CLAIM]);
      const session = await openClaimedSession(fixture.witness.url, [UPDATE_CLAIM]);
      const created = await fetch(`${fixture.target.url}/api/accounts`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ first_name: 'Zed', last_name: 'Unknown' }),
      });
      expect(created.status).toBe(200);
      const entity = (await created.json()) as { id: string };
      await proxyExchange(
        session.proxyUrl as string,
        'PATCH',
        `/api/accounts/${entity.id}`,
        JSON.stringify({ first_name: 'Updated' }),
      );
      const done = await finalize(fixture.witness.url, session.sessionId);
      expect(done.body['finalized']).toEqual([]);
      expect(JSON.stringify(done.body['notes'])).toContain('was not in the session-open snapshot');
      await closeSupervisorSession(fixture.witness.url, TOKEN, session.sessionId, 'passed', VERIFIER_KEY);
    } finally {
      await fixture.witness.stop();
      await fixture.target.stop();
    }
  });

  it('resolves a read and an archive-delete from proxied traffic', async () => {
    const fixture = await startFixturedWitness();
    try {
      await declare(fixture.witness.url, [READ_CLAIM, DELETE_CLAIM]);
      const session = await openClaimedSession(fixture.witness.url, [READ_CLAIM, DELETE_CLAIM]);
      const proxyUrl = session.proxyUrl as string;
      const got = await proxyExchange(proxyUrl, 'GET', '/api/accounts/acc-1');
      expect(got.status).toBe(200);
      const archived = await proxyExchange(proxyUrl, 'POST', '/api/accounts/acc-1/archive', JSON.stringify({}));
      expect(archived.status).toBe(200);
      const done = await finalize(fixture.witness.url, session.sessionId);
      const finalized = done.body['finalized'] as Array<Record<string, unknown>>;
      expect(finalized).toHaveLength(2);
      const records = await ledgerRecords(fixture.witness.url);
      const byObligation = new Map(records.filter((entry) => entry['kind'] === 'persistence.observed').map((entry) => [entry['obligationId'], entry['payload']]));
      expect((byObligation.get(READ_CLAIM) as Record<string, unknown>)?.['found']).toBe(true);
      expect((byObligation.get(DELETE_CLAIM) as Record<string, unknown>)?.['fields']).toMatchObject({ status: 'archived' });
      await closeSupervisorSession(fixture.witness.url, TOKEN, session.sessionId, 'passed', VERIFIER_KEY);
    } finally {
      await fixture.witness.stop();
      await fixture.target.stop();
    }
  });
});

describe('observe finalize (gates)', () => {
  it('skips undeclared claims and contracts the Observe channel cannot prove, with typed notes', async () => {
    const fixture = await startFixturedWitness();
    try {
      const AUTH_CLAIM = 'tenant.accounts:auth:role-denied';
      await declare(fixture.witness.url, [CREATE_CLAIM, AUTH_CLAIM]);
      // UPDATE is bound on the adapter but never declared: skipped
      // silently. CREATE is declared but saw no POST: a typed note.
      const session = await openClaimedSession(fixture.witness.url, [CREATE_CLAIM, UPDATE_CLAIM]);
      await proxyExchange(session.proxyUrl as string, 'PATCH', '/api/accounts/acc-1', JSON.stringify({ first_name: 'Zed' }));
      const done = await finalize(fixture.witness.url, session.sessionId);
      expect(done.body['finalized']).toEqual([]);
      expect(done.body['notes']).toHaveLength(1);
      expect(JSON.stringify(done.body['notes'])).toContain('no POST /api/accounts exchange');
      await closeSupervisorSession(fixture.witness.url, TOKEN, session.sessionId, 'passed', VERIFIER_KEY);
      // A declared contract the Observe channel proves nothing at all is
      // noted, never proven. The transport contracts DO have a channel
      // now (plan 0.9.2 item D) and are covered by their own block below.
      const session2 = await openClaimedSession(fixture.witness.url, [AUTH_CLAIM], `${TEST_ID}-auth`);
      const done2 = await finalize(fixture.witness.url, session2.sessionId);
      expect(done2.body['finalized']).toEqual([]);
      expect(JSON.stringify(done2.body['notes'])).toContain('http:request-observed');
      expect(JSON.stringify(done2.body['notes'])).toContain('persistence:*');
      await closeSupervisorSession(fixture.witness.url, TOKEN, session2.sessionId, 'passed', VERIFIER_KEY);
    } finally {
      await fixture.witness.stop();
      await fixture.target.stop();
    }
  });

  it('notes a missing observe binding and a missing list() instead of satisfying', async () => {
    const noBinding = await startFixturedWitness({ observe: false });
    try {
      await declare(noBinding.witness.url, [CREATE_CLAIM]);
      const session = await openClaimedSession(noBinding.witness.url, [CREATE_CLAIM]);
      await proxyExchange(session.proxyUrl as string, 'POST', '/api/accounts', JSON.stringify({ first_name: 'A', last_name: 'B' }));
      const done = await finalize(noBinding.witness.url, session.sessionId);
      expect(done.body['finalized']).toEqual([]);
      expect(JSON.stringify(done.body['notes'])).toContain('no observe binding');
      await closeSupervisorSession(noBinding.witness.url, TOKEN, session.sessionId, 'passed', VERIFIER_KEY);
    } finally {
      await noBinding.witness.stop();
      await noBinding.target.stop();
    }
    const noList = await startFixturedWitness({ list: false });
    try {
      await declare(noList.witness.url, [CREATE_CLAIM]);
      const session = await openClaimedSession(noList.witness.url, [CREATE_CLAIM]);
      await proxyExchange(session.proxyUrl as string, 'POST', '/api/accounts', JSON.stringify({ first_name: 'A', last_name: 'B' }));
      const done = await finalize(noList.witness.url, session.sessionId);
      expect(done.body['finalized']).toEqual([]);
      expect(JSON.stringify(done.body['notes'])).toContain('before-snapshot');
      await closeSupervisorSession(noList.witness.url, TOKEN, session.sessionId, 'passed', VERIFIER_KEY);
    } finally {
      await noList.witness.stop();
      await noList.target.stop();
    }
  });

  it('refuses finalize on sealed/unknown sessions and without bound declarations', async () => {
    const fixture = await startFixturedWitness();
    try {
      await declare(fixture.witness.url, [CREATE_CLAIM]);
      const session = await openClaimedSession(fixture.witness.url, [CREATE_CLAIM]);
      await closeSupervisorSession(fixture.witness.url, TOKEN, session.sessionId, 'passed', VERIFIER_KEY);
      const sealed = await finalize(fixture.witness.url, session.sessionId);
      expect(sealed.status).toBe(409);
      const unknown = await finalize(fixture.witness.url, '00000000-0000-4000-8000-000000000000');
      expect(unknown.status).toBe(400);
    } finally {
      await fixture.witness.stop();
      await fixture.target.stop();
    }
    const bare = await startFixturedWitness();
    try {
      const session = await openClaimedSession(bare.witness.url, [CREATE_CLAIM]);
      const unbound = await finalize(bare.witness.url, session.sessionId);
      expect(unbound.status).toBe(409);
      await closeSupervisorSession(bare.witness.url, TOKEN, session.sessionId, 'passed', VERIFIER_KEY);
    } finally {
      await bare.witness.stop();
      await bare.target.stop();
    }
  });
});

/**
 * Plan 0.9.2 item D, witness side: the observe finalize also serves the
 * transport contracts. For a claim the SUPERVISOR registered
 * observed-e2e it stamps ONE `http.observed` record carrying the
 * session's own proxied exchanges (deduped, capped), and the engine
 * grades them through the same endpoint matcher the `http.request`
 * path uses. I2 pins the declaration gate; I5 pins which exchanges
 * travel.
 */
describe('observe finalize (transport obligations)', () => {
  const HTTP_CLAIM = 'tenant.accounts:http:request-observed';
  const HTTP_STATUS_CLAIM = 'tenant.accounts:http:response-status-ok';

  /** The witnessed `http.observed` records the finalize issued. */
  async function observedRecords(url: string): Promise<Array<Record<string, unknown>>> {
    return (await ledgerRecords(url)).filter((entry) => entry['kind'] === 'http.observed');
  }

  it('stamps one http.observed record per claim carrying the session\'s deduped, normalized exchanges', async () => {
    const fixture = await startFixturedWitness();
    try {
      expect((await declare(fixture.witness.url, [HTTP_CLAIM, HTTP_STATUS_CLAIM])).status).toBe(200);
      const session = await openClaimedSession(fixture.witness.url, [HTTP_CLAIM, HTTP_STATUS_CLAIM]);
      const proxyUrl = session.proxyUrl as string;
      await proxyExchange(proxyUrl, 'GET', '/api/accounts');
      await proxyExchange(proxyUrl, 'GET', '/api/accounts/acc-1');
      // The same exchange twice, and the same path with a query string:
      // deduplicated by (method, url, status) after normalization.
      await proxyExchange(proxyUrl, 'GET', '/api/accounts/acc-1');
      await proxyExchange(proxyUrl, 'GET', '/api/accounts?shape=summary');
      const done = await finalize(fixture.witness.url, session.sessionId);
      expect(done.status).toBe(200);
      expect(done.body['notes']).toEqual([]);
      const finalized = done.body['finalized'] as Array<Record<string, unknown>>;
      expect(finalized.map((entry) => entry['obligationId']).sort()).toEqual([HTTP_CLAIM, HTTP_STATUS_CLAIM]);
      const observed = await observedRecords(fixture.witness.url);
      expect(observed).toHaveLength(2);
      for (const entry of observed) {
        expect(entry['trust']).toBe('witnessed');
        expect(entry['origin']).toBe('engine-observed');
        expect(entry['testId']).toBe(TEST_ID);
        // Provenance recomputes from the record's own contents (pin #7).
        expect(
          recordIdOf({
            runId: entry['runId'] as string,
            obligationId: entry['obligationId'] as string,
            kind: entry['kind'] as string,
            testId: entry['testId'] as string,
            origin: entry['origin'] as 'engine-observed',
            payload: entry['payload'],
          }),
        ).toBe(entry['recordId']);
      }
      const payload = observed[0]?.['payload'] as Record<string, unknown>;
      expect(payload['channel']).toBe('observe');
      expect(payload['sessionId']).toBe(session.sessionId);
      expect(payload['truncated']).toBeUndefined();
      expect(payload['exchanges']).toEqual([
        { method: 'GET', url: '/api/accounts', status: 200 },
        { method: 'GET', url: '/api/accounts/acc-1', status: 200 },
      ]);
      await closeSupervisorSession(fixture.witness.url, TOKEN, session.sessionId, 'passed', VERIFIER_KEY);
    } finally {
      await fixture.witness.stop();
      await fixture.target.stop();
    }
  });

  it('I2: a claim the supervisor did not register observed-e2e never gets a record', async () => {
    const fixture = await startFixturedWitness();
    try {
      await declare(fixture.witness.url, [HTTP_CLAIM]);
      const session = await openClaimedSession(fixture.witness.url, [HTTP_CLAIM, HTTP_STATUS_CLAIM]);
      await proxyExchange(session.proxyUrl as string, 'GET', '/api/accounts');
      const done = await finalize(fixture.witness.url, session.sessionId);
      const finalized = done.body['finalized'] as Array<Record<string, unknown>>;
      expect(finalized).toHaveLength(1);
      expect(finalized[0]?.['obligationId']).toBe(HTTP_CLAIM);
      // The undeclared claim is skipped silently, exactly like an
      // undeclared persistence claim: never a record, never a note.
      expect(done.body['notes']).toEqual([]);
      const observed = await observedRecords(fixture.witness.url);
      expect(observed.map((entry) => entry['obligationId'])).toEqual([HTTP_CLAIM]);
      await closeSupervisorSession(fixture.witness.url, TOKEN, session.sessionId, 'passed', VERIFIER_KEY);
    } finally {
      await fixture.witness.stop();
      await fixture.target.stop();
    }
  });

  it('I5: only this session\'s proxied exchanges travel, and a released session still finalizes', async () => {
    const fixture = await startFixturedWitness();
    try {
      await declare(fixture.witness.url, [HTTP_CLAIM]);
      const other = await openClaimedSession(fixture.witness.url, [HTTP_CLAIM], `${TEST_ID}-other`, 1);
      await proxyExchange(other.proxyUrl as string, 'GET', '/api/accounts/acc-1');
      const session = await openClaimedSession(fixture.witness.url, [HTTP_CLAIM]);
      await proxyExchange(session.proxyUrl as string, 'GET', '/api/accounts');
      // The release only unbinds the worker slot and kills the proxy:
      // the traffic it did observe is exactly what an open session holds,
      // so the drain can still finalize before it closes the session.
      const released = await post(
        fixture.witness.url,
        '/sessions/release',
        { sessionId: session.sessionId },
        supervisorHeaders(),
      );
      expect(released.status).toBe(200);
      const done = await finalize(fixture.witness.url, session.sessionId);
      expect(done.body['notes']).toEqual([]);
      const observed = await observedRecords(fixture.witness.url);
      expect(observed).toHaveLength(1);
      const payload = observed[0]?.['payload'] as Record<string, unknown>;
      expect(payload['exchanges']).toEqual([{ method: 'GET', url: '/api/accounts', status: 200 }]);
      await closeSupervisorSession(fixture.witness.url, TOKEN, session.sessionId, 'passed', VERIFIER_KEY);
      await closeSupervisorSession(fixture.witness.url, TOKEN, other.sessionId, 'passed', VERIFIER_KEY);
    } finally {
      await fixture.witness.stop();
      await fixture.target.stop();
    }
  });

  it('notes missing traffic instead of stamping a record with no exchanges', async () => {
    const fixture = await startFixturedWitness();
    try {
      await declare(fixture.witness.url, [HTTP_CLAIM]);
      const other = await openClaimedSession(fixture.witness.url, [HTTP_CLAIM], `${TEST_ID}-other`, 1);
      const session = await openClaimedSession(fixture.witness.url, [HTTP_CLAIM]);
      // Another session's channel, and traffic bypassing every proxy.
      await proxyExchange(other.proxyUrl as string, 'GET', '/api/accounts');
      await proxyExchange(fixture.target.url, 'GET', '/api/accounts');
      const done = await finalize(fixture.witness.url, session.sessionId);
      expect(done.body['finalized']).toEqual([]);
      expect(JSON.stringify(done.body['notes'])).toContain('no HTTP exchange');
      expect(await observedRecords(fixture.witness.url)).toEqual([]);
      await closeSupervisorSession(fixture.witness.url, TOKEN, session.sessionId, 'passed', VERIFIER_KEY);
      await closeSupervisorSession(fixture.witness.url, TOKEN, other.sessionId, 'passed', VERIFIER_KEY);
    } finally {
      await fixture.witness.stop();
      await fixture.target.stop();
    }
  });
});

describe('observe finalize (concurrent observed creates)', () => {
  /**
   * Two sessions whose before-snapshots both predate BOTH creates: each
   * after-list therefore reports two new entities, and each session
   * can only be credited with the one its OWN proxied response named.
   * Finalized in reverse creation order, so a witness that dropped a
   * consumed exchange's attribution would fail the second finalize.
   */
  it('resolves both sessions when their observed creates overlap in one witness window', async () => {
    const fixture = await startFixturedWitness();
    const secondTestId = `${TEST_ID}#second-worker`;
    try {
      await declare(fixture.witness.url, [CREATE_CLAIM]);
      const first = await openClaimedSession(fixture.witness.url, [CREATE_CLAIM]);
      const second = await openSupervisorSession(
        fixture.witness.url,
        TOKEN,
        secondTestId,
        1,
        VERIFIER_KEY,
        [CREATE_CLAIM],
      );
      const created = await Promise.all([
        proxyExchange(
          first.proxyUrl as string,
          'POST',
          '/api/accounts',
          JSON.stringify({ first_name: 'Grace', last_name: 'Hopper' }),
        ),
        proxyExchange(
          second.proxyUrl as string,
          'POST',
          '/api/accounts',
          JSON.stringify({ first_name: 'Alan', last_name: 'Turing' }),
        ),
      ]);
      expect(created.map((exchange) => exchange.status)).toEqual([200, 200]);
      // The LATER create finalizes first: the earlier finalize consumes
      // its own exchange, and the second one must still attribute its
      // own entity from witness-held response facts.
      const secondDone = await finalize(fixture.witness.url, second.sessionId);
      const firstDone = await finalize(fixture.witness.url, first.sessionId);
      expect(secondDone.body['notes']).toEqual([]);
      expect(firstDone.body['notes']).toEqual([]);
      expect(secondDone.body['finalized']).toHaveLength(1);
      expect(firstDone.body['finalized']).toHaveLength(1);
      const records = (await ledgerRecords(fixture.witness.url)).filter(
        (entry) => entry['kind'] === 'persistence.observed',
      );
      expect(records).toHaveLength(2);
      // Each test is credited with ITS OWN entity: the record's
      // adapter-read fields match the request that test sent, and the
      // two records never carry the same id.
      const byTest = new Map<string, Record<string, unknown>>();
      for (const record of records) {
        byTest.set(record['testId'] as string, record['payload'] as Record<string, unknown>);
      }
      expect([...byTest.keys()].sort()).toEqual([TEST_ID, secondTestId].sort());
      const payloads = [...byTest.values()];
      expect(
        payloads
          .map((payload) => (payload['observedFields'] as Record<string, unknown>)['first_name'])
          .sort(),
      ).toEqual(['Alan', 'Grace']);
      for (const payload of payloads) {
        expect(payload['fields']).toMatchObject(
          (payload['observedFields'] as Record<string, unknown>)['first_name'] === 'Grace'
            ? { first_name: 'Grace', last_name: 'Hopper' }
            : { first_name: 'Alan', last_name: 'Turing' },
        );
        expect(payload['before']).toEqual({ entityAbsent: true });
      }
      expect(new Set(payloads.map((payload) => payload['entityId'])).size).toBe(2);
      await closeSupervisorSession(fixture.witness.url, TOKEN, first.sessionId, 'passed', VERIFIER_KEY);
      await closeSupervisorSession(fixture.witness.url, TOKEN, second.sessionId, 'passed', VERIFIER_KEY);
    } finally {
      await fixture.witness.stop();
      await fixture.target.stop();
    }
  });

  it('stays ambiguous when a writer outside the observation proxy creates in the same window', async () => {
    const fixture = await startFixturedWitness();
    try {
      await declare(fixture.witness.url, [CREATE_CLAIM]);
      const session = await openClaimedSession(fixture.witness.url, [CREATE_CLAIM]);
      // Bypasses every session channel: the witness never proxied it, so
      // no observed response names the entity it leaves behind.
      const unobserved = await fetch(`${fixture.target.url}/api/accounts`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ first_name: 'Outside', last_name: 'The Proxy' }),
      });
      expect(unobserved.status).toBe(200);
      await proxyExchange(
        session.proxyUrl as string,
        'POST',
        '/api/accounts',
        JSON.stringify({ first_name: 'Grace', last_name: 'Hopper' }),
      );
      const done = await finalize(fixture.witness.url, session.sessionId);
      expect(done.body['finalized']).toEqual([]);
      expect(done.body['notes']).toHaveLength(1);
      expect(String((done.body['notes'] as string[])[0])).toContain(
        'no observed POST /api/accounts response names it',
      );
      const observed = (await ledgerRecords(fixture.witness.url)).filter(
        (entry) => entry['kind'] === 'persistence.observed',
      );
      expect(observed).toEqual([]);
      await closeSupervisorSession(fixture.witness.url, TOKEN, session.sessionId, 'passed', VERIFIER_KEY);
    } finally {
      await fixture.witness.stop();
      await fixture.target.stop();
    }
  });
});

/** A collection read binding over the marker app's wrapped list route. */
const WRAPPED_COLLECTION_READ = {
  path: '/api/accounts',
  collection: { rowsKey: 'accounts', idKey: 'id' },
} as const;

/** The same route with no rowsKey: the response ROOT is the row array. */
const ROOT_ARRAY_READ = { path: '/api/accounts', collection: { idKey: 'id' } } as const;

const LIFECYCLE = {
  create: true,
  read: true,
  update: true,
  delete: true,
  deleteSemantics: 'hard',
  updateableFields: ['first_name', 'last_name', 'status'],
} as const;

const CLASSIFICATION = {
  exposure: 'user-facing',
  plane: 'tenant',
  lifecycle: LIFECYCLE,
  primaryKey: ['id'],
  evidenceAdapter: 'tenant.accounts',
} as const;

/** The obligation the real engine grades one witnessed record against. */
function obligationFor(claimId: string, contract: string): Obligation {
  return ObligationSchema.parse({
    schemaVersion: 1,
    id: claimId,
    resourceId: 'tenant.accounts',
    contract,
    policyId: 'user-facing-lifecycle',
    lifecycle: LIFECYCLE,
  });
}

/** Grades witnessed records through the real verdict engine, as the gate does. */
function gradeClaim(
  obligation: Obligation,
  records: Array<Record<string, unknown>>,
): VerdictOutcome {
  return evaluateObligation(obligation, {
    claims: [{ schemaVersion: 1, obligationId: obligation.id, testId: TEST_ID }],
    records,
    waivers: [],
    classification: CLASSIFICATION,
    now: '2026-08-30T12:00:01.000Z',
  });
}

/** Seeds one account straight into the app (no proxy, no witness record). */
async function seedAccount(targetUrl: string, firstName: string): Promise<string> {
  const response = await fetch(`${targetUrl}/api/accounts`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ first_name: firstName, last_name: 'Seeded' }),
  });
  expect(response.status).toBe(200);
  return ((await response.json()) as { id: string }).id;
}

describe('observe finalize (collection read)', () => {
  it('resolves a read from the rows a wrapped collection actually returned', async () => {
    const fixture = await startFixturedWitness({ read: WRAPPED_COLLECTION_READ });
    try {
      await declare(fixture.witness.url, [READ_CLAIM]);
      const session = await openClaimedSession(fixture.witness.url, [READ_CLAIM]);
      const got = await proxyExchange(session.proxyUrl as string, 'GET', '/api/accounts');
      expect(got.status).toBe(200);
      const done = await finalize(fixture.witness.url, session.sessionId);
      expect(done.body['notes']).toEqual([]);
      expect(done.body['finalized']).toEqual([
        { obligationId: READ_CLAIM, recordId: expect.any(String), operation: 'read', entityId: 'acc-1' },
      ]);
      const records = await ledgerRecords(fixture.witness.url);
      const payload = (records.find((entry) => entry['kind'] === 'persistence.observed')?.['payload']) as Record<string, unknown>;
      // The entity came from the RETURNED row, and its fields from the
      // independent adapter read — never from the response body.
      expect(payload['entityId']).toBe('acc-1');
      expect(payload['found']).toBe(true);
      expect(payload['fields']).toMatchObject({ first_name: 'Ada', last_name: 'Lovelace' });
      expect(payload['exchange']).toMatchObject({ method: 'GET', path: '/api/accounts', status: 200 });
      await closeSupervisorSession(fixture.witness.url, TOKEN, session.sessionId, 'passed', VERIFIER_KEY);
    } finally {
      await fixture.witness.stop();
      await fixture.target.stop();
    }
  });

  it('resolves the same read from a root-array response (no rowsKey declared)', async () => {
    const fixture = await startFixturedWitness({ read: ROOT_ARRAY_READ });
    try {
      await declare(fixture.witness.url, [READ_CLAIM]);
      const session = await openClaimedSession(fixture.witness.url, [READ_CLAIM]);
      const got = await proxyExchange(session.proxyUrl as string, 'GET', '/api/accounts?shape=array');
      expect(got.status).toBe(200);
      expect(JSON.parse(got.text)).toEqual([
        { id: 'acc-1', first_name: 'Ada', last_name: 'Lovelace', status: 'active' },
      ]);
      const done = await finalize(fixture.witness.url, session.sessionId);
      expect(done.body['notes']).toEqual([]);
      expect(done.body['finalized']).toMatchObject([{ operation: 'read', entityId: 'acc-1' }]);
      await closeSupervisorSession(fixture.witness.url, TOKEN, session.sessionId, 'passed', VERIFIER_KEY);
    } finally {
      await fixture.witness.stop();
      await fixture.target.stop();
    }
  });

  it('picks the target deterministically when the app returned several rows', async () => {
    const fixture = await startFixturedWitness({ read: WRAPPED_COLLECTION_READ });
    try {
      const bea = await seedAccount(fixture.target.url, 'Bea');
      const cleo = await seedAccount(fixture.target.url, 'Cleo');
      await declare(fixture.witness.url, [READ_CLAIM]);
      const session = await openClaimedSession(fixture.witness.url, [READ_CLAIM]);
      // The app answered newest-first — the opposite of the order the
      // resolution uses to pick its target.
      const got = await proxyExchange(session.proxyUrl as string, 'GET', '/api/accounts?shape=reversed');
      expect(got.status).toBe(200);
      const rows = (JSON.parse(got.text) as { accounts: Array<{ id: string }> }).accounts;
      expect(rows.map((row) => row.id)).toEqual([cleo, bea, 'acc-1']);
      const done = await finalize(fixture.witness.url, session.sessionId);
      expect(done.body['notes']).toEqual([]);
      // Canonical-key order decides the target, not response order: the
      // first row returned was '3', and the entity actually read is the
      // canonically-first id among the rows the app returned.
      expect(done.body['finalized']).toMatchObject([{ operation: 'read', entityId: '2' }]);
      await closeSupervisorSession(fixture.witness.url, TOKEN, session.sessionId, 'passed', VERIFIER_KEY);
    } finally {
      await fixture.witness.stop();
      await fixture.target.stop();
    }
  });
  it('resolves a read from a list response past the 16 KB response-snapshot cap', async () => {
    // A real app's list grows with its own data: past 16 KB the body used
    // to name no complete row, so the claim stayed EVIDENCE_NOT_COLLECTED
    // with no way out. A DECLARED collection read is parsed from its own
    // wider bounded copy, so a big list still proves — and the entity it
    // proves is a row the session-open snapshot really held, never one of
    // the filler rows that only made the body big.
    const fixture = await startFixturedWitness({ read: WRAPPED_COLLECTION_READ });
    try {
      await declare(fixture.witness.url, [READ_CLAIM]);
      const session = await openClaimedSession(fixture.witness.url, [READ_CLAIM]);
      const got = await proxyExchange(session.proxyUrl as string, 'GET', '/api/accounts?shape=large');
      expect(got.status).toBe(200);
      // Past the 16 KB tap, so this body genuinely could not be read from it.
      expect(Buffer.byteLength(got.text)).toBeGreaterThan(16384);
      const done = await finalize(fixture.witness.url, session.sessionId);
      expect(done.body['notes']).toEqual([]);
      expect(done.body['finalized']).toMatchObject([{ operation: 'read', entityId: 'acc-1' }]);
      const records = await ledgerRecords(fixture.witness.url);
      const payload = (records.find((entry) => entry['kind'] === 'persistence.observed')?.['payload']) as Record<
        string,
        unknown
      >;
      expect(payload['entityId']).toBe('acc-1');
      expect(payload['fields']).toMatchObject({ first_name: 'Ada', last_name: 'Lovelace' });
      // The record payload is unchanged: nothing from the body rides in it.
      expect(payload['exchange']).toMatchObject({ method: 'GET', path: '/api/accounts', status: 200 });
      await closeSupervisorSession(fixture.witness.url, TOKEN, session.sessionId, 'passed', VERIFIER_KEY);
    } finally {
      await fixture.witness.stop();
      await fixture.target.stop();
    }
  });

  it('keeps create attribution on the 16 KB tap for a body the collection read reads whole', async () => {
    // The wider buffer is the collection parse's alone. A create response
    // past 16 KB is still unreadable to attribution, so a second entity
    // appearing in the same window stays ambiguous instead of being
    // attributed from bytes the attribution log never saw.
    const fixture = await startFixturedWitness();
    try {
      await declare(fixture.witness.url, [CREATE_CLAIM]);
      const session = await openClaimedSession(fixture.witness.url, [CREATE_CLAIM]);
      // Two new entities in the window, one of them written outside the
      // proxy — attribution cannot separate them without a readable body.
      await fetch(`${fixture.target.url}/api/accounts`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ first_name: 'Outside', last_name: 'Proxy' }),
      });
      await proxyExchange(
        session.proxyUrl as string,
        'POST',
        '/api/accounts?shape=large',
        JSON.stringify({ first_name: 'Big', last_name: 'Body' }),
      );
      const done = await finalize(fixture.witness.url, session.sessionId);
      expect(done.body['finalized']).toEqual([]);
      expect(String((done.body['notes'] as string[])[0])).toContain('16384');
      await closeSupervisorSession(fixture.witness.url, TOKEN, session.sessionId, 'passed', VERIFIER_KEY);
    } finally {
      await fixture.witness.stop();
      await fixture.target.stop();
    }
  });

  it('notes a collection read whose body named no usable row', async () => {
    const refusals: ReadonlyArray<{ shape: string; expected: string }> = [
      { shape: 'summary', expected: "no row array at the declared rowsKey 'accounts'" },
      { shape: 'empty', expected: 'returned no rows' },
      { shape: 'malformed', expected: "row 0 carries no usable 'id' id" },
      { shape: 'duplicate', expected: "names 'acc-1' more than once" },
      { shape: 'notjson', expected: 'not parseable JSON' },
      { shape: 'foreign', expected: 'named no entity that existed when this session opened' },
      // Past the collection-read BODY bound and past its ROW bound: still
      // refused, still with no record — a bigger bound never means a
      // partial page read as a whole one.
      { shape: 'huge', expected: 'witness collection-read bound' },
      { shape: 'manyrows', expected: 'row witness collection-read bound' },
    ];
    for (const refusal of refusals) {
      const fixture = await startFixturedWitness({ read: WRAPPED_COLLECTION_READ });
      try {
        await declare(fixture.witness.url, [READ_CLAIM]);
        const session = await openClaimedSession(fixture.witness.url, [READ_CLAIM]);
        const got = await proxyExchange(
          session.proxyUrl as string,
          'GET',
          `/api/accounts?shape=${refusal.shape}`,
        );
        expect(got.status).toBe(200);
        const done = await finalize(fixture.witness.url, session.sessionId);
        expect(done.body['finalized']).toEqual([]);
        expect(String((done.body['notes'] as string[])[0])).toContain(refusal.expected);
        const observed = (await ledgerRecords(fixture.witness.url)).filter(
          (entry) => entry['kind'] === 'persistence.observed',
        );
        expect(observed).toEqual([]);
        await closeSupervisorSession(fixture.witness.url, TOKEN, session.sessionId, 'passed', VERIFIER_KEY);
      } finally {
        await fixture.witness.stop();
        await fixture.target.stop();
      }
    }
  });

  it('notes a collection that returned only a row created after the session opened', async () => {
    const fixture = await startFixturedWitness({ read: WRAPPED_COLLECTION_READ });
    try {
      await declare(fixture.witness.url, [READ_CLAIM]);
      const session = await openClaimedSession(fixture.witness.url, [READ_CLAIM]);
      await seedAccount(fixture.target.url, 'Late');
      await proxyExchange(session.proxyUrl as string, 'GET', '/api/accounts?shape=newest');
      const done = await finalize(fixture.witness.url, session.sessionId);
      expect(done.body['finalized']).toEqual([]);
      expect(String((done.body['notes'] as string[])[0])).toContain(
        'named no entity that existed when this session opened',
      );
      await closeSupervisorSession(fixture.witness.url, TOKEN, session.sessionId, 'passed', VERIFIER_KEY);
    } finally {
      await fixture.witness.stop();
      await fixture.target.stop();
    }
  });

  it('notes traffic on another route, another session, or outside the proxy entirely', async () => {
    const fixture = await startFixturedWitness({ read: WRAPPED_COLLECTION_READ });
    try {
      await declare(fixture.witness.url, [READ_CLAIM]);
      const mine = await openClaimedSession(fixture.witness.url, [READ_CLAIM]);
      const other = await openClaimedSession(fixture.witness.url, [READ_CLAIM], `${TEST_ID} second`, 1);
      // A by-id route is not the declared collection route.
      await proxyExchange(mine.proxyUrl as string, 'GET', '/api/accounts/acc-1');
      // Another session's list read never joins this one's traffic.
      await proxyExchange(other.proxyUrl as string, 'GET', '/api/accounts');
      // And a direct call never reaches any session channel at all.
      await fetch(`${fixture.target.url}/api/accounts`);
      const done = await finalize(fixture.witness.url, mine.sessionId);
      expect(done.body['finalized']).toEqual([]);
      expect(String((done.body['notes'] as string[])[0])).toContain(
        'no GET /api/accounts exchange (2xx) for this session',
      );
      await closeSupervisorSession(fixture.witness.url, TOKEN, other.sessionId, 'passed', VERIFIER_KEY);
      await closeSupervisorSession(fixture.witness.url, TOKEN, mine.sessionId, 'passed', VERIFIER_KEY);
    } finally {
      await fixture.witness.stop();
      await fixture.target.stop();
    }
  });

  it('consumes the matched collection exchange single-use', async () => {
    const fixture = await startFixturedWitness({ read: WRAPPED_COLLECTION_READ });
    try {
      await declare(fixture.witness.url, [READ_CLAIM]);
      const session = await openClaimedSession(fixture.witness.url, [READ_CLAIM]);
      await proxyExchange(session.proxyUrl as string, 'GET', '/api/accounts');
      const first = await finalize(fixture.witness.url, session.sessionId);
      expect(first.body['finalized']).toHaveLength(1);
      const second = await finalize(fixture.witness.url, session.sessionId);
      expect(second.body['finalized']).toEqual([]);
      expect(String((second.body['notes'] as string[])[0])).toContain(
        'no GET /api/accounts exchange (2xx) for this session',
      );
      const observed = (await ledgerRecords(fixture.witness.url)).filter(
        (entry) => entry['kind'] === 'persistence.observed',
      );
      expect(observed).toHaveLength(1);
      await closeSupervisorSession(fixture.witness.url, TOKEN, session.sessionId, 'passed', VERIFIER_KEY);
    } finally {
      await fixture.witness.stop();
      await fixture.target.stop();
    }
  });

  it('keeps the by-id read binding unchanged beside a collection adapter', async () => {
    const fixture = await startFixturedWitness();
    try {
      await declare(fixture.witness.url, [READ_CLAIM]);
      const session = await openClaimedSession(fixture.witness.url, [READ_CLAIM]);
      // The list route is NOT declared for this adapter, so only the
      // by-id exchange can credit the read.
      await proxyExchange(session.proxyUrl as string, 'GET', '/api/accounts');
      await proxyExchange(session.proxyUrl as string, 'GET', '/api/accounts/acc-1');
      const done = await finalize(fixture.witness.url, session.sessionId);
      expect(done.body['notes']).toEqual([]);
      expect(done.body['finalized']).toMatchObject([{ operation: 'read', entityId: 'acc-1' }]);
      await closeSupervisorSession(fixture.witness.url, TOKEN, session.sessionId, 'passed', VERIFIER_KEY);
    } finally {
      await fixture.witness.stop();
      await fixture.target.stop();
    }
  });

  it('credits NEITHER claim when two resources declare different shapes for one route', async () => {
    const fixture = await startFixturedWitness({
      read: WRAPPED_COLLECTION_READ,
      ordersCollection: { rowsKey: 'items', idKey: 'itemId' },
    });
    try {
      await declare(fixture.witness.url, [READ_CLAIM, ORDERS_READ_CLAIM]);
      const session = await openClaimedSession(fixture.witness.url, [READ_CLAIM, ORDERS_READ_CLAIM]);
      const got = await proxyExchange(session.proxyUrl as string, 'GET', '/api/accounts');
      expect(got.status).toBe(200);
      const done = await finalize(fixture.witness.url, session.sessionId);
      expect(done.body['finalized']).toEqual([]);
      const notes = (done.body['notes'] as string[]).join(' | ');
      // Every refusal NAMES the two declarations that disagreed, so the
      // owner sees which rowsKey/idKey pair to make consistent.
      expect(notes.match(/DIFFERENT collection shapes/g)).toHaveLength(2);
      expect(notes).toContain('tenant.accounts (rowsKey="accounts", idKey="id")');
      expect(notes).toContain('tenant.orders (rowsKey="items", idKey="itemId")');
      const observed = (await ledgerRecords(fixture.witness.url)).filter(
        (entry) => entry['kind'] === 'persistence.observed',
      );
      expect(observed).toEqual([]);
      await closeSupervisorSession(fixture.witness.url, TOKEN, session.sessionId, 'passed', VERIFIER_KEY);
    } finally {
      await fixture.witness.stop();
      await fixture.target.stop();
    }
  });

  it('credits exactly one claim when two resources declare the SAME shape for one route', async () => {
    const fixture = await startFixturedWitness({
      read: WRAPPED_COLLECTION_READ,
      ordersCollection: { rowsKey: 'accounts', idKey: 'id' },
    });
    try {
      await declare(fixture.witness.url, [READ_CLAIM, ORDERS_READ_CLAIM]);
      const session = await openClaimedSession(fixture.witness.url, [READ_CLAIM, ORDERS_READ_CLAIM]);
      await proxyExchange(session.proxyUrl as string, 'GET', '/api/accounts');
      const done = await finalize(fixture.witness.url, session.sessionId);
      // ONE proxied exchange credits ONE claim: the second claim finds
      // it already consumed, exactly like any other single-use match.
      expect(done.body['finalized']).toMatchObject([
        { obligationId: READ_CLAIM, operation: 'read', entityId: 'acc-1' },
      ]);
      expect(done.body['notes']).toHaveLength(1);
      expect(String((done.body['notes'] as string[])[0])).toContain(
        'no GET /api/accounts exchange (2xx) for this session',
      );
      const observed = (await ledgerRecords(fixture.witness.url)).filter(
        (entry) => entry['kind'] === 'persistence.observed',
      );
      expect(observed).toHaveLength(1);
      await closeSupervisorSession(fixture.witness.url, TOKEN, session.sessionId, 'passed', VERIFIER_KEY);
    } finally {
      await fixture.witness.stop();
      await fixture.target.stop();
    }
  });

  it('stamps the honest absence when the row disappears before the read finalizes', async () => {
    const fixture = await startFixturedWitness({ read: WRAPPED_COLLECTION_READ });
    try {
      await declare(fixture.witness.url, [READ_CLAIM]);
      const session = await openClaimedSession(fixture.witness.url, [READ_CLAIM]);
      await proxyExchange(session.proxyUrl as string, 'GET', '/api/accounts');
      // The app loses the row AFTER the session opened and AFTER the
      // read the suite observed, outside every session channel.
      const removed = await fetch(`${fixture.target.url}/api/accounts/acc-1`, { method: 'DELETE' });
      expect(removed.status).toBe(200);
      const done = await finalize(fixture.witness.url, session.sessionId);
      expect(done.body['notes']).toEqual([]);
      expect(done.body['finalized']).toMatchObject([{ obligationId: READ_CLAIM, operation: 'read' }]);
      const record = (await ledgerRecords(fixture.witness.url)).find(
        (entry) => entry['kind'] === 'persistence.observed',
      ) as Record<string, unknown>;
      const payload = record['payload'] as Record<string, unknown>;
      // The returned row named the entity, but the engine's OWN read
      // proves it is gone — so the record stamps that absence rather
      // than a presence the engine cannot back.
      expect(payload['entityId']).toBe('acc-1');
      expect(payload['found']).toBe(false);
      expect(payload['fields']).toBe(undefined);
      const outcome = gradeClaim(obligationFor(READ_CLAIM, 'persistence:read'), [record]);
      expect(outcome.verdict).toBe('invalid');
      expect(outcome.reason).toContain('entity absent');
      await closeSupervisorSession(fixture.witness.url, TOKEN, session.sessionId, 'passed', VERIFIER_KEY);
    } finally {
      await fixture.witness.stop();
      await fixture.target.stop();
    }
  });
});

describe('observe records (declared volatile fields)', () => {
  const CREATE_OBLIGATION = obligationFor(CREATE_CLAIM, 'persistence:create');

  /**
 * Drives one real create through the proxy where the app REWRITES the
 * submitted `status` (the marker app computes it), and returns the
 * witnessed record the finalize issued.
 */
  async function createWithRewrittenStatus(
    volatileFields: readonly string[] | undefined,
  ): Promise<Record<string, unknown>> {
    const fixture = await startFixturedWitness(
      volatileFields === undefined ? {} : { volatileFields },
    );
    try {
      await declare(fixture.witness.url, [CREATE_CLAIM]);
      const session = await openClaimedSession(fixture.witness.url, [CREATE_CLAIM]);
      const created = await proxyExchange(
        session.proxyUrl as string,
        'POST',
        '/api/accounts',
        JSON.stringify({ first_name: 'Zed', last_name: 'Unknown', status: 'pending' }),
      );
      expect(created.status).toBe(200);
      const done = await finalize(fixture.witness.url, session.sessionId);
      expect(done.body['notes']).toEqual([]);
      expect(done.body['finalized']).toHaveLength(1);
      const observed = (await ledgerRecords(fixture.witness.url)).filter(
        (entry) => entry['kind'] === 'persistence.observed',
      );
      expect(observed).toHaveLength(1);
      const payload = (observed[0] as Record<string, unknown>)['payload'] as Record<string, unknown>;
      expect(payload['observedFields']).toMatchObject({ status: 'pending' });
      expect(payload['fields']).toMatchObject({ status: 'active' });
      await closeSupervisorSession(fixture.witness.url, TOKEN, session.sessionId, 'passed', VERIFIER_KEY);
      return observed[0] as Record<string, unknown>;
    } finally {
      await fixture.witness.stop();
      await fixture.target.stop();
    }
  }

  it('skips a declared server-computed field and reports the skip', async () => {
    const record = await createWithRewrittenStatus(['status']);
    expect(gradeClaim(CREATE_OBLIGATION, [record])).toMatchObject({ verdict: 'satisfied' });
    expect(volatileFieldsOf(record)).toEqual(['status']);
    // The journey's entered values, paired with the record exactly as
    // the report does: the skip is a visible fact, never a silent one.
    const payload = record['payload'] as Record<string, unknown>;
    expect(volatileEchoSkips({ payload: { fields: payload['observedFields'] } }, record)).toEqual([
      { field: 'status', entered: 'pending', persisted: 'active' },
    ]);
  });

  it('still blocks an ordinary field the adapter did not declare', async () => {
    const record = await createWithRewrittenStatus(undefined);
    const outcome = gradeClaim(CREATE_OBLIGATION, [record]);
    expect(outcome.verdict).toBe('invalid');
    expect(outcome.reason).toContain('EVIDENCE_VALUE_MISMATCH');
    expect(outcome.reason).toContain('status');
    expect(volatileFieldsOf(record)).toEqual([]);
  });
});
