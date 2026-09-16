/**
 * Server-witnessed persistence channel tests (witness side): the
 * `POST /runs/server-e2e-declarations` + `POST /witness/server-persistence`
 * supervisor surface. Real loopback HTTP; no mocks. Proves:
 * - the supervisor authority gate (run token + verifier key — the run
 *   token alone never forwards an intent);
 * - the kind gate (obligations not registered `server-e2e` are refused
 *   typed — a browser-kind claim can never ride the channel);
 * - the probe runs WITNESS-side against the app's real state and the
 *   stamped record carries `channel: 'server'` + the before-state;
 * - replay/sequence and missing-pre intents fail closed;
 * - a missing `probeServer` export resolves typed
 *   SERVER_PROBE_UNAVAILABLE (never satisfaction);
 * - server-channel records are covered by the v2 ledger attestation
 *   exactly like every witnessed record.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { startWitness } from '../src/witness/server.js';
import { verifyAttestationMac, recordIdOf } from '@gateforge/core';
import { makeTempProject, writeFixtureProject, writeHonestAdapter, writeProbeAdapter } from './helpers.js';
import { startMarkerServer } from './marker-server.js';
import { RUN_HEADER, VERIFIER_HEADER } from '../src/constants.js';

const RUN_ID = randomUUID();
const TOKEN = 'run-token-abc-123';
const VERIFIER_KEY = 'verifier-secret-the-suite-never-sees';
const TEST_ID = 'pytest:outbox:backend/tests/integration/test_x.py:test_commits';
const CREATE_CLAIM = 'tenant.accounts:persistence:create';

/** A supervisor-grade intent the drain would forward. */
function intent(overrides: Record<string, unknown> = {}) {
  return {
    resourceId: 'tenant.accounts',
    claimId: CREATE_CLAIM,
    operation: 'create',
    phase: 'post',
    intent: 'expect-present',
    // The marker server mints '2' next on a fresh instance; pre and post
    // must name the SAME entity key for the before-state to join.
    key: '2',
    sequence: 2,
    testId: TEST_ID,
    ...overrides,
  };
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
async function startFixturedWitness(options: { probeAdapter?: boolean } = {}) {
  const project = makeTempProject('server-persistence');
  writeFixtureProject(project, {
    create: true,
    read: true,
    update: true,
    delete: true,
    deleteSemantics: 'archive',
  });
  if (options.probeAdapter === false) writeHonestAdapter(project);
  else writeProbeAdapter(project);
  const target = await startMarkerServer('example-v1');
  const stateDir = join(project, '.gateforge/test-gates');
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(
    join(stateDir, 'manifest.json'),
    `${JSON.stringify({
      schemaVersion: 1,
      runId: RUN_ID,
      startedAt: '2026-08-30T12:00:00.000Z',
      gitSha: null,
      provider: 'local-staged',
      plugins: [],
      attestationScope: null,
    })}\n`,
  );
  const witness = await startWitness({
    runId: RUN_ID,
    token: TOKEN,
    verifierKey: VERIFIER_KEY,
    stateDir,
    adaptersDir: join(project, '.gateforge/adapters'),
    classificationsPath: join(project, '.gateforge/effective-classifications.yml'),
    targetBaseUrl: target.url,
    targetFingerprint: 'example-v1',
    adapterBaseUrl: target.url,
    now: () => '2026-08-30T12:00:01.000Z',
  });
  return {
    witness,
    target,
    project,
    stateDir,
    // App-side mutation the "suite" performs between pre and post.
    createAccount: async (): Promise<string> => {
      const response = await fetch(`${target.url}/api/accounts`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ first_name: 'Grace', last_name: 'Hopper' }),
      });
      const created = (await response.json()) as { id: string };
      return created.id;
    },
  };
}

afterEach(async () => {
  // each test stops its own servers
});

describe('server persistence supervisor surface (auth)', () => {
  it('refuses the run token alone on both routes (the verifier key is required)', async () => {
    const fixture = await startFixturedWitness();
    try {
      // The witness HAS a verifier key: a missing or wrong header is a
      // 401 (requireSupervisor); 403 is reserved for a witness started
      // with NO verifier key at all.
      const declarations = await post(fixture.witness.url, '/runs/server-e2e-declarations', {
        obligations: [CREATE_CLAIM],
      }, { [RUN_HEADER]: TOKEN });
      expect(declarations.status).toBe(401);
      const forward = await post(fixture.witness.url, '/witness/server-persistence', intent(), {
        [RUN_HEADER]: TOKEN,
      });
      expect(forward.status).toBe(401);
      const wrongKey = await post(fixture.witness.url, '/witness/server-persistence', intent(), {
        [RUN_HEADER]: TOKEN,
        [VERIFIER_HEADER]: 'not-the-key',
      });
      expect(wrongKey.status).toBe(401);
      // And nothing is served without the run token either.
      const noToken = await post(fixture.witness.url, '/witness/server-persistence', intent(), {
        [VERIFIER_HEADER]: VERIFIER_KEY,
      });
      expect(noToken.status).toBe(401);
    } finally {
      await fixture.witness.stop();
      await fixture.target.stop();
    }
  });
});

describe('server-e2e declarations gate', () => {
  it('refuses intents before registration with the typed kind cause', async () => {
    const fixture = await startFixturedWitness();
    try {
      const refused = await post(fixture.witness.url, '/witness/server-persistence', intent(), {
        [RUN_HEADER]: TOKEN,
        [VERIFIER_HEADER]: VERIFIER_KEY,
      });
      expect(refused.status).toBe(409);
      expect(refused.body['detail']).toBe('TEST_KIND_UNKNOWN');
      expect(String(refused.body['error'])).toContain('kind: server-e2e');
    } finally {
      await fixture.witness.stop();
      await fixture.target.stop();
    }
  });

  it('binds once, idempotently; a different set is refused', async () => {
    const fixture = await startFixturedWitness();
    try {
      const headers = { [RUN_HEADER]: TOKEN, [VERIFIER_HEADER]: VERIFIER_KEY };
      const first = await post(fixture.witness.url, '/runs/server-e2e-declarations', {
        obligations: [CREATE_CLAIM],
      }, headers);
      expect(first.status).toBe(200);
      expect(first.body).toMatchObject({ bound: true, count: 1 });
      const identical = await post(fixture.witness.url, '/runs/server-e2e-declarations', {
        obligations: [CREATE_CLAIM],
      }, headers);
      expect(identical.status).toBe(200);
      const changed = await post(fixture.witness.url, '/runs/server-e2e-declarations', {
        obligations: ['tenant.accounts:persistence:read'],
      }, headers);
      expect(changed.status).toBe(409);
    } finally {
      await fixture.witness.stop();
      await fixture.target.stop();
    }
  });

  it('refuses intents for obligations outside the registered set', async () => {
    const fixture = await startFixturedWitness();
    try {
      const headers = { [RUN_HEADER]: TOKEN, [VERIFIER_HEADER]: VERIFIER_KEY };
      await post(fixture.witness.url, '/runs/server-e2e-declarations', {
        obligations: [CREATE_CLAIM],
      }, headers);
      const foreign = await post(fixture.witness.url, '/witness/server-persistence', intent({
        claimId: 'tenant.accounts:persistence:delete',
        resourceId: 'tenant.accounts',
        operation: 'delete',
        phase: 'post',
        intent: 'expect-absent',
      }), headers);
      expect(foreign.status).toBe(409);
      expect(foreign.body['detail']).toBe('TEST_KIND_UNKNOWN');
    } finally {
      await fixture.witness.stop();
      await fixture.target.stop();
    }
  });
});

describe('witness-side probe + witnessed stamping', () => {
  it('runs the probe witness-side and stamps channel=server with the before-state', async () => {
    const fixture = await startFixturedWitness();
    try {
      const headers = { [RUN_HEADER]: TOKEN, [VERIFIER_HEADER]: VERIFIER_KEY };
      await post(fixture.witness.url, '/runs/server-e2e-declarations', { obligations: [CREATE_CLAIM] }, headers);
      // The suite's app-side mutation happens BETWEEN pre and post; the
      // witness observed both sides itself.
      const pre = await post(fixture.witness.url, '/witness/server-persistence', intent({
        phase: 'pre',
        intent: 'expect-absent',
        sequence: 1,
      }), headers);
      expect(pre.status).toBe(200);
      expect(pre.body).toMatchObject({ resolved: 'pre', found: false });
      const createdId = await fixture.createAccount();
      const post_ = await post(fixture.witness.url, '/witness/server-persistence', intent({
        key: createdId,
        sequence: 2,
      }), headers);
      expect(post_.status).toBe(200);
      expect(post_.body).toMatchObject({ trust: 'witnessed', channel: 'server' });
      // The ledger record: witnessed, channel-stamped, before-bound,
      // provenance-verifying — exactly the browser-path record contract.
      const recordsResponse = await fetch(`${fixture.witness.url}/records`, {
        headers: { [RUN_HEADER]: TOKEN },
      });
      const { records } = (await recordsResponse.json()) as { records: Array<Record<string, unknown>> };
      expect(records).toHaveLength(1);
      const record = records[0] as Record<string, unknown>;
      expect(record['trust']).toBe('witnessed');
      expect(record['obligationId']).toBe(CREATE_CLAIM);
      expect(record['testId']).toBe(TEST_ID);
      const payload = record['payload'] as Record<string, unknown>;
      expect(payload['channel']).toBe('server');
      expect(payload['declaredKind']).toBe('server-e2e');
      expect(payload['found']).toBe(true);
      expect(payload['before']).toEqual({ entityAbsent: true });
      expect(payload['fields']).toMatchObject({ first_name: 'Grace' });
      expect(record['recordId']).toBe(
        recordIdOf({
          runId: record['runId'] as string,
          obligationId: record['obligationId'] as string,
          kind: record['kind'] as string,
          testId: record['testId'] as string,
          origin: 'engine-observed',
          payload,
        }),
      );
    } finally {
      await fixture.witness.stop();
      await fixture.target.stop();
    }
  });

  it('covers the server-channel record with the v2 ledger attestation MAC', async () => {
    const fixture = await startFixturedWitness();
    try {
      const headers = { [RUN_HEADER]: TOKEN, [VERIFIER_HEADER]: VERIFIER_KEY };
      await post(fixture.witness.url, '/runs/server-e2e-declarations', { obligations: [CREATE_CLAIM] }, headers);
      // Trusted bind FIRST (the CLI does this before any observation).
      const bind = await post(fixture.witness.url, '/run-context', {
        runId: RUN_ID,
        invocationId: randomUUID(),
        inputDigest: 'a'.repeat(64),
      }, headers);
      expect(bind.status).toBe(200);
      await post(fixture.witness.url, '/witness/server-persistence', intent({
        phase: 'pre', intent: 'expect-absent', sequence: 1,
      }), headers);
      const createdId = await fixture.createAccount();
      const post_ = await post(fixture.witness.url, '/witness/server-persistence', intent({
        key: createdId, sequence: 2,
      }), headers);
      expect(post_.status).toBe(200);
      const attestationResponse = await fetch(`${fixture.witness.url}/ledger-attestation`, {
        headers,
      });
      const attestation = (await attestationResponse.json()) as Record<string, unknown>;
      expect(attestationResponse.status).toBe(200);
      const recordIds = attestation['recordIds'] as string[];
      expect(recordIds).toContain(post_.body['recordId']);
      expect(
        verifyAttestationMac(
          VERIFIER_KEY,
          attestation as unknown as { runId: unknown; invocationId: unknown; inputDigest: unknown; recordIds: unknown },
          attestation['mac'],
        ),
      ).toBe(true);
    } finally {
      await fixture.witness.stop();
      await fixture.target.stop();
    }
  });
});

describe('fail-closed intent resolution', () => {
  it('refuses a create-post without its pre and a replayed sequence', async () => {
    const fixture = await startFixturedWitness();
    try {
      const headers = { [RUN_HEADER]: TOKEN, [VERIFIER_HEADER]: VERIFIER_KEY };
      await post(fixture.witness.url, '/runs/server-e2e-declarations', { obligations: [CREATE_CLAIM] }, headers);
      // A post without the paired pre: no witness-side before-state, no
      // record (the engine grades before/after from its OWN observations).
      const missingPre = await post(fixture.witness.url, '/witness/server-persistence', intent({
        sequence: 1,
      }), headers);
      expect(missingPre.status).toBe(409);
      expect(String(missingPre.body['error'])).toContain('pre-observation');
      // Sequences are strictly increasing PER claim whether the intent
      // resolved or not: a replayed line is never re-driven.
      const pre = await post(fixture.witness.url, '/witness/server-persistence', intent({
        phase: 'pre', intent: 'expect-absent', sequence: 2,
      }), headers);
      expect(pre.status).toBe(200);
      const replay = await post(fixture.witness.url, '/witness/server-persistence', intent({
        phase: 'pre', intent: 'expect-absent', sequence: 2,
      }), headers);
      expect(replay.status).toBe(409);
      expect(String(replay.body['error'])).toContain('strictly increasing');
    } finally {
      await fixture.witness.stop();
      await fixture.target.stop();
    }
  });

  it('resolves a missing probeServer export as typed SERVER_PROBE_UNAVAILABLE', async () => {
    const fixture = await startFixturedWitness({ probeAdapter: false });
    try {
      const headers = { [RUN_HEADER]: TOKEN, [VERIFIER_HEADER]: VERIFIER_KEY };
      await post(fixture.witness.url, '/runs/server-e2e-declarations', { obligations: [CREATE_CLAIM] }, headers);
      const refused = await post(fixture.witness.url, '/witness/server-persistence', intent({
        phase: 'pre', intent: 'expect-absent', sequence: 1,
      }), headers);
      expect(refused.status).toBe(409);
      expect(refused.body['detail']).toBe('SERVER_PROBE_UNAVAILABLE');
      expect(String(refused.body['error'])).toContain('probeServer');
      // No record was ever issued: the intent never resolves to
      // satisfaction on probe trouble.
      const recordsResponse = await fetch(`${fixture.witness.url}/records`, {
        headers: { [RUN_HEADER]: TOKEN },
      });
      expect(((await recordsResponse.json()) as { records: unknown[] }).records).toHaveLength(0);
    } finally {
      await fixture.witness.stop();
      await fixture.target.stop();
    }
  });

  it('refuses intent shapes that would steer evidence onto another obligation', async () => {
    const fixture = await startFixturedWitness();
    try {
      const headers = { [RUN_HEADER]: TOKEN, [VERIFIER_HEADER]: VERIFIER_KEY };
      await post(fixture.witness.url, '/runs/server-e2e-declarations', { obligations: [CREATE_CLAIM] }, headers);
      const mismatched = await post(fixture.witness.url, '/witness/server-persistence', intent({
        claimId: 'tenant.accounts:persistence:read',
        operation: 'create',
      }), headers);
      expect(mismatched.status).toBe(400);
      expect(String(mismatched.body['error'])).toContain('must agree');
    } finally {
      await fixture.witness.stop();
      await fixture.target.stop();
    }
  });
});
