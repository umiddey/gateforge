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
 * - proxy-bypass traffic is invisible to finalize.
 */
import { describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { startWitness } from '../src/witness/server.js';
import { recordIdOf } from '@gate-forge/core';
import {
  makeTempProject,
  writeFixtureProject,
  writeObserveAdapter,
  openSupervisorSession,
  closeSupervisorSession,
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
async function startFixturedWitness(options: { list?: boolean; observe?: boolean } = {}) {
  const runId = randomUUID();
  const project = makeTempProject('observe-finalize');
  writeFixtureProject(project);
  writeObserveAdapter(project, options);
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
): Promise<SupervisorSession> {
  return openSupervisorSession(url, TOKEN, testId, 0, VERIFIER_KEY, claims);
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

  it('notes an update of an entity absent from the open snapshot', async () => {
    const fixture = await startFixturedWitness();
    try {
      await declare(fixture.witness.url, [UPDATE_CLAIM]);
      const session = await openClaimedSession(fixture.witness.url, [UPDATE_CLAIM]);
      // acc-9 does not exist — but the marker stamps headers before it
      // can downgrade the status, so the exchange arrives 2xx-shaped and
      // matches the template; the snapshot check then refuses it (the id
      // was never witness-observed before the test).
      await proxyExchange(session.proxyUrl as string, 'PATCH', '/api/accounts/acc-9', JSON.stringify({ first_name: 'Zed' }));
      const done = await finalize(fixture.witness.url, session.sessionId);
      expect(done.body['finalized']).toEqual([]);
      expect(JSON.stringify(done.body['notes'])).toContain("was not in the session-open snapshot");
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
  it('skips undeclared claims and non-persistence contracts with typed notes', async () => {
    const fixture = await startFixturedWitness();
    try {
      const HTTP_CLAIM = 'tenant.accounts:http:request-observed';
      await declare(fixture.witness.url, [CREATE_CLAIM, HTTP_CLAIM]);
      // UPDATE is bound on the adapter but never declared: skipped
      // silently. CREATE is declared but saw no POST: a typed note.
      const session = await openClaimedSession(fixture.witness.url, [CREATE_CLAIM, UPDATE_CLAIM]);
      await proxyExchange(session.proxyUrl as string, 'PATCH', '/api/accounts/acc-1', JSON.stringify({ first_name: 'Zed' }));
      const done = await finalize(fixture.witness.url, session.sessionId);
      expect(done.body['finalized']).toEqual([]);
      expect(done.body['notes']).toHaveLength(1);
      expect(JSON.stringify(done.body['notes'])).toContain('no POST /api/accounts exchange');
      await closeSupervisorSession(fixture.witness.url, TOKEN, session.sessionId, 'passed', VERIFIER_KEY);
      // A declared non-persistence contract is noted, never proven.
      const session2 = await openClaimedSession(fixture.witness.url, [HTTP_CLAIM], `${TEST_ID}-http`);
      const done2 = await finalize(fixture.witness.url, session2.sessionId);
      expect(done2.body['finalized']).toEqual([]);
      expect(JSON.stringify(done2.body['notes'])).toContain('persistence:* contracts only');
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
