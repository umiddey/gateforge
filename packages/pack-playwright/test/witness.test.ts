/**
 * Witness-service tests (GF-10, GF-11, GF-13, GF-14 witness-side, pin
 * #7): loopback auth, record issuance + provenance, unknown-primitive
 * rejection, env-fingerprint attestation, manifest recordIds append,
 * and the classification surface. Real loopback HTTP; no mocks.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { startWitness, WitnessStartupError, recordIdOf } from '../src/witness/server.js';
import { RunManifestSchema, attestationMac, ledgerMac, verifyAttestationMac, ClassificationSchema, type Classification } from '@gateforge/core';
import { toClassificationView } from '../src/witness/classifications.js';
import {
  beginJourneyInterval,
  closeSupervisorSession,
  endJourneyInterval,
  makeTempProject,
  openSupervisorSession,
  writeFixtureProject,
  writeHonestAdapter,
} from './helpers.js';
import { AttestationError } from '../src/witness/env-attestation.js';
import { ENV_FINGERPRINT_HEADER, RUN_HEADER, VERIFIER_HEADER } from '../src/constants.js';
import { startAttestationProxy } from '../src/attestation/proxy.js';
import { startMarkerServer } from './marker-server.js';

const RUN_ID = '6f1c3f90-2d5e-4b1a-9c6d-0f0e2b8a1c9d';
const TOKEN = 'run-token-abc-123';
const VERIFIER_KEY = 'verifier-secret-the-suite-never-sees';
const TEST_ID = 'spec-file.js > test title';
const OBLIGATION = 'tenant.accounts:crud:update';

/** Starts a witness bound to a temp fixture project + marker target. */
async function startFixturedWitness(options: {
  fingerprint: string | null;
  adapterFingerprint?: string;
  targetFingerprint?: string | null;
  targetBaseUrl?: string;
  stateDir?: string | null;
  classifier?: boolean;
  verifierKey?: string | null;
}) {
  const project = makeTempProject('witness');
  writeFixtureProject(project);
  writeHonestAdapter(project, options.adapterFingerprint ?? 'example-v1');
  const target = await startMarkerServer(options.fingerprint);
  const stateDir = options.stateDir === undefined ? join(project, '.gateforge/test-gates') : options.stateDir;
  if (stateDir !== null) {
    mkdirSync(stateDir, { recursive: true });
    // A full RunManifestSchema-valid manifest, as the real CLI writes it.
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
  }
  const witness = await startWitness({
    runId: RUN_ID,
    token: TOKEN,
    verifierKey: options.verifierKey === undefined ? VERIFIER_KEY : options.verifierKey,
    stateDir,
    adaptersDir: join(project, '.gateforge/adapters'),
    classificationsPath: join(project, '.gateforge/effective-classifications.yml'),
    targetBaseUrl: options.targetBaseUrl ?? target.url,
    targetFingerprint: options.targetFingerprint === undefined ? 'example-v1' : options.targetFingerprint,
    adapterBaseUrl: target.url,
    now: () => '2026-08-30T12:00:01.000Z',
  });
  return { witness, target, project, stateDir };
}

afterEach(async () => {
  // nothing global; each test stops its own servers
});

describe('witness auth (pin #7)', () => {
  it('401 without the run token on every endpoint', async () => {
    const fixture = await startFixturedWitness({ fingerprint: 'example-v1' });
    try {
      const response = await fetch(`${fixture.witness.url}/health`);
      expect(response.status).toBe(401);
      const records = await fetch(`${fixture.witness.url}/records`, {
        headers: { [RUN_HEADER]: 'wrong-token' },
      });
      expect(records.status).toBe(401);
    } finally {
      await fixture.witness.stop();
      await fixture.target.stop();
    }
  });
});

describe('record issuance (pin #7, Phase 1 session-bound)', () => {
  it('stamps a submitted ui.action claimed-tier with suite-submitted origin (GF-23 round 3)', async () => {
    const fixture = await startFixturedWitness({ fingerprint: 'example-v1' });
    try {
      // Phase 1: submissions exist only under the supervisor-opened
      // session of the declaring test.
      const session = await openSupervisorSession(fixture.witness.url, TOKEN, TEST_ID, 0, VERIFIER_KEY);
      const payload = {
        operation: 'update',
        entityId: 'acc-1',
        fields: { first_name: 'Ada' },
        sessionId: session.sessionId, // witness-stamped channel binding
      };
      const res = await fetch(`${fixture.witness.url}/records`, {
        method: 'POST',
        headers: { [RUN_HEADER]: TOKEN, 'content-type': 'application/json' },
        body: JSON.stringify({
          claimId: OBLIGATION,
          kind: 'ui.action',
          payload: { operation: 'update', entityId: 'acc-1', fields: { first_name: 'Ada' } },
          testId: TEST_ID,
          sessionId: session.sessionId,
          sessionToken: session.sessionToken,
        }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        recordId: string;
        trust: string;
        runId: string;
      };
      // The suite owns the browser and holds the run token, so a
      // submitted payload proves only that the suite ASSERTED it: the
      // witness stamps it claimed-tier (attestation proves receipt,
      // never occurrence).
      expect(body.trust).toBe('claimed');
      expect(body.runId).toBe(RUN_ID);
      expect(body.recordId).toMatch(/^[0-9a-f]{64}$/);
      expect(body.recordId).toBe(
        recordIdOf({
          runId: RUN_ID,
          obligationId: OBLIGATION,
          kind: 'ui.action',
          testId: TEST_ID,
          origin: 'suite-submitted',
          payload,
        }),
      );
      const ledger = (await (
        await fetch(`${fixture.witness.url}/records`, {
          headers: { [RUN_HEADER]: TOKEN },
        })
      ).json()) as {
        records: Array<{ recordId: string; trust: string; origin: string; payload: unknown }>;
      };
      expect(ledger.records).toHaveLength(1);
      expect(ledger.records[0]?.trust).toBe('claimed');
      expect(ledger.records[0]?.origin).toBe('suite-submitted');
      // The record self-describes the session channel it was minted through.
      expect(ledger.records[0]?.payload).toMatchObject({ sessionId: session.sessionId });
    } finally {
      await fixture.witness.stop();
      await fixture.target.stop();
    }
  });

  it('rejects a submission without a valid open session (fail closed, Phase 1)', async () => {
    const fixture = await startFixturedWitness({ fingerprint: 'example-v1' });
    try {
      const attempts = [
        // No session credential at all.
        {
          claimId: OBLIGATION,
          kind: 'ui.action',
          payload: { operation: 'update', entityId: 'acc-1', fields: {} },
          testId: TEST_ID,
        },
        // Unknown sessionId.
        {
          claimId: OBLIGATION,
          kind: 'ui.action',
          payload: { operation: 'update', entityId: 'acc-1', fields: {} },
          testId: TEST_ID,
          sessionId: '00000000-0000-4000-8000-000000000000',
          sessionToken: 'guessed',
        },
      ];
      for (const [label, expectedStatus] of [
        ['missing credential', 400],
        ['unknown session', 403],
      ] as const) {
        const res = await fetch(`${fixture.witness.url}/records`, {
          method: 'POST',
          headers: { [RUN_HEADER]: TOKEN, 'content-type': 'application/json' },
          body: JSON.stringify(attempts[expectedStatus === 400 ? 0 : 1]),
        });
        expect(
          res.status,
          `a submission without a valid open session must be rejected (${label})`,
        ).toBe(expectedStatus);
      }
      const ledger = (await (
        await fetch(`${fixture.witness.url}/records`, { headers: { [RUN_HEADER]: TOKEN } })
      ).json()) as { records: unknown[] };
      expect(ledger.records).toHaveLength(0);
    } finally {
      await fixture.witness.stop();
      await fixture.target.stop();
    }
  });

  it('rejects a submission whose testId differs from the supervisor-registered session test', async () => {
    const fixture = await startFixturedWitness({ fingerprint: 'example-v1' });
    try {
      const session = await openSupervisorSession(fixture.witness.url, TOKEN, TEST_ID, 0, VERIFIER_KEY);
      const res = await fetch(`${fixture.witness.url}/records`, {
        method: 'POST',
        headers: { [RUN_HEADER]: TOKEN, 'content-type': 'application/json' },
        body: JSON.stringify({
          claimId: OBLIGATION,
          kind: 'ui.action',
          payload: { operation: 'update', entityId: 'acc-1', fields: {} },
          testId: 'a-different-test',
          sessionId: session.sessionId,
          sessionToken: session.sessionToken,
        }),
      });
      expect(res.status).toBe(403);
      const body = (await res.json()) as { error: string };
      expect(body.error).toMatch(/does not match the open session's supervisor-registered testId/);
    } finally {
      await fixture.witness.stop();
      await fixture.target.stop();
    }
  });

  it('rejects an unknown primitive kind with 400 (GF-11, GF-14)', async () => {
    const fixture = await startFixturedWitness({ fingerprint: 'example-v1' });
    try {
      for (const kind of ['prove', 'persistence', 'audit.event']) {
        const res = await fetch(`${fixture.witness.url}/records`, {
          method: 'POST',
          headers: { [RUN_HEADER]: TOKEN, 'content-type': 'application/json' },
          body: JSON.stringify({
            claimId: OBLIGATION,
            kind,
            payload: { anything: true },
            testId: TEST_ID,
          }),
        });
        expect(res.status, `kind '${kind}' must be rejected`).toBe(400);
      }
    } finally {
      await fixture.witness.stop();
      await fixture.target.stop();
    }
  });

  it('rejects malformed request bodies with 400', async () => {
    const fixture = await startFixturedWitness({ fingerprint: 'example-v1' });
    try {
      const bad = [
        { kind: 'ui.action', payload: {}, testId: 't' }, // no claimId
        { claimId: 'no-colon-id', kind: 'ui.action', payload: {}, testId: 't' }, // bad id
        { claimId: OBLIGATION, kind: 'ui.action', testId: 't' }, // no payload
      ];
      for (const body of bad) {
        const res = await fetch(`${fixture.witness.url}/records`, {
          method: 'POST',
          headers: { [RUN_HEADER]: TOKEN, 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
        expect(res.status).toBe(400);
      }
    } finally {
      await fixture.witness.stop();
      await fixture.target.stop();
    }
  });
});

describe('persistence endpoint (pin #7)', () => {
  it('runs the adapter engine-side and returns verdictRelevant', async () => {
    const fixture = await startFixturedWitness({ fingerprint: 'example-v1' });
    try {
      const session = await openSupervisorSession(fixture.witness.url, TOKEN, TEST_ID, 0, VERIFIER_KEY);
      const res = await fetch(`${fixture.witness.url}/witness/persistence`, {
        method: 'POST',
        headers: { [RUN_HEADER]: TOKEN, 'content-type': 'application/json' },
        body: JSON.stringify({
          resourceId: 'tenant.accounts',
          entityId: 'acc-1',
          expectFields: { first_name: 'Ada', last_name: 'Lovelace' },
          testId: TEST_ID,
          claimId: OBLIGATION,
          sessionId: session.sessionId,
          sessionToken: session.sessionToken,
        }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        recordId: string;
        runId: string;
        verdictRelevant: { found: boolean; fieldsMatch: boolean };
      };
      expect(body.runId).toBe(RUN_ID);
      expect(body.verdictRelevant.found).toBe(true);
      expect(body.verdictRelevant.fieldsMatch).toBe(true);
      expect(body.recordId).toMatch(/^[0-9a-f]{64}$/);
      const ledger = (await (
        await fetch(`${fixture.witness.url}/records`, {
          headers: { [RUN_HEADER]: TOKEN },
        })
      ).json()) as {
        records: Array<{ recordId: string; trust: string; origin: string; kind: string; payload: { entityId: string } }>;
      };
      const persistence = ledger.records.find((record) => record.kind === 'persistence.entity');
      expect(persistence?.payload.entityId).toBe('acc-1');
      // Engine-side observation: the only witnessed origin (GF-23 round 3).
      expect(persistence?.trust).toBe('witnessed');
      expect(persistence?.origin).toBe('engine-observed');
    } finally {
      await fixture.witness.stop();
      await fixture.target.stop();
    }
  });

  it('rejects a persistence request for a resource with no adapter (400)', async () => {
    const fixture = await startFixturedWitness({ fingerprint: 'example-v1' });
    try {
      const session = await openSupervisorSession(fixture.witness.url, TOKEN, TEST_ID, 0, VERIFIER_KEY);
      const res = await fetch(`${fixture.witness.url}/witness/persistence`, {
        method: 'POST',
        headers: { [RUN_HEADER]: TOKEN, 'content-type': 'application/json' },
        body: JSON.stringify({
          resourceId: 'tenant.ghosts',
          entityId: 'x',
          testId: TEST_ID,
          claimId: 'tenant.ghosts:crud:update',
          sessionId: session.sessionId,
          sessionToken: session.sessionToken,
        }),
      });
      expect(res.status).toBe(400);
    } finally {
      await fixture.witness.stop();
      await fixture.target.stop();
    }
  });
});

describe('environment attestation (GF-10, GF-13)', () => {
  it('blocks a non-loopback attestation subject at startup (GF-10)', async () => {
    const project = makeTempProject('attest');
    writeFixtureProject(project);
    writeHonestAdapter(project);
    await expect(
      startWitness({
        runId: RUN_ID,
        token: TOKEN,
        adaptersDir: join(project, '.gateforge/adapters'),
        targetBaseUrl: 'http://prod.example.com:8080',
      }),
    ).rejects.toThrow(AttestationError);
  });

  it('rejects persistence records when the adapter target lacks the marker (GF-13)', async () => {
    // Adapter base = raw markerless server; the marker probe sees nothing.
    const project = makeTempProject('attest');
    writeFixtureProject(project);
    writeHonestAdapter(project);
    const raw = await startMarkerServer(null); // no marker header
    const proxy = await startAttestationProxy(raw.url, 'example-v1');
    try {
      const witness = await startWitness({
        runId: RUN_ID,
        token: TOKEN,
        verifierKey: VERIFIER_KEY, // the test acts as the supervisor (fix 3)
        adaptersDir: join(project, '.gateforge/adapters'),
        targetBaseUrl: proxy.url, // attested subject HAS the marker
        targetFingerprint: 'example-v1',
        adapterBaseUrl: raw.url, // adapter reads the UNMARKED env
      });
      try {
        const session = await openSupervisorSession(witness.url, TOKEN, TEST_ID, 0, VERIFIER_KEY);
        const res = await fetch(`${witness.url}/witness/persistence`, {
          method: 'POST',
          headers: { [RUN_HEADER]: TOKEN, 'content-type': 'application/json' },
          body: JSON.stringify({
            resourceId: 'tenant.accounts',
            entityId: 'acc-1',
            expectFields: { first_name: 'Ada' },
            testId: TEST_ID,
            claimId: OBLIGATION,
            sessionId: session.sessionId,
            sessionToken: session.sessionToken,
          }),
        });
        expect(res.status).toBe(409);
        const ledger = (await (
          await fetch(`${witness.url}/records`, { headers: { [RUN_HEADER]: TOKEN } })
        ).json()) as { records: unknown[] };
        expect(ledger.records).toHaveLength(0); // rejected: never issued
      } finally {
        await witness.stop();
      }
    } finally {
      await proxy.stop();
      await raw.stop();
    }
  });

  it('rejects persistence records when the adapter fingerprint differs from the run (GF-13)', async () => {
    const project = makeTempProject('attest');
    writeFixtureProject(project);
    writeHonestAdapter(project, 'other-env-v9'); // adapter declares another env
    const target = await startMarkerServer('example-v1');
    try {
      const witness = await startWitness({
        runId: RUN_ID,
        token: TOKEN,
        verifierKey: VERIFIER_KEY, // the test acts as the supervisor (fix 3)
        adaptersDir: join(project, '.gateforge/adapters'),
        targetBaseUrl: target.url,
        targetFingerprint: 'example-v1',
        adapterBaseUrl: target.url, // marker example-v1 ≠ adapter's declared fingerprint
      });
      try {
        const session = await openSupervisorSession(witness.url, TOKEN, TEST_ID, 0, VERIFIER_KEY);
        const res = await fetch(`${witness.url}/witness/persistence`, {
          method: 'POST',
          headers: { [RUN_HEADER]: TOKEN, 'content-type': 'application/json' },
          body: JSON.stringify({
            resourceId: 'tenant.accounts',
            entityId: 'acc-1',
            testId: TEST_ID,
            claimId: OBLIGATION,
            sessionId: session.sessionId,
            sessionToken: session.sessionToken,
          }),
        });
        expect(res.status).toBe(409);
      } finally {
        await witness.stop();
      }
    } finally {
      await target.stop();
    }
  });

  it('rejects adapter reads whose base is not loopback (GF-10 mediation)', async () => {
    const project = makeTempProject('attest');
    writeFixtureProject(project);
    writeFileSync(
      join(project, '.gateforge/adapters/tenant.accounts.mjs'),
      [
        'export default {',
        '  baseUrl: "http://10.0.0.5:8080",',
        '  async read(ctx, id) { return { id }; },',
        '  normalize(body) { return { entityId: body.id, fields: {} }; },',
        "  deletion: 'archive',",
        "  environmentFingerprint: 'example-v1',",
        '};',
        '',
      ].join('\n'),
    );
    const target = await startMarkerServer('example-v1');
    try {
      const witness = await startWitness({
        runId: RUN_ID,
        token: TOKEN,
        verifierKey: VERIFIER_KEY, // the test acts as the supervisor (fix 3)
        adaptersDir: join(project, '.gateforge/adapters'),
        targetBaseUrl: target.url,
        targetFingerprint: 'example-v1',
      });
      try {
        const session = await openSupervisorSession(witness.url, TOKEN, TEST_ID, 0, VERIFIER_KEY);
        const res = await fetch(`${witness.url}/witness/persistence`, {
          method: 'POST',
          headers: { [RUN_HEADER]: TOKEN, 'content-type': 'application/json' },
          body: JSON.stringify({
            resourceId: 'tenant.accounts',
            entityId: 'acc-1',
            testId: TEST_ID,
            claimId: OBLIGATION,
            sessionId: session.sessionId,
            sessionToken: session.sessionToken,
          }),
        });
        expect(res.status).toBe(409);
      } finally {
        await witness.stop();
      }
    } finally {
      await target.stop();
    }
  });
});

describe('classifications surface', () => {
  it('exposes primaryKey per resource (reporter ledger needs it)', async () => {
    const fixture = await startFixturedWitness({ fingerprint: 'example-v1' });
    try {
      const res = await fetch(`${fixture.witness.url}/classifications`, {
        headers: { [RUN_HEADER]: TOKEN },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { resources: Record<string, { primaryKey: string[] }> };
      expect(body.resources['tenant.accounts']?.primaryKey).toEqual(['id']);
    } finally {
      await fixture.witness.stop();
      await fixture.target.stop();
    }
  });

  it('carries evidenceLane through the view: a claims-lane entry round-trips intact', async () => {
    // The claims lane (http.endpoint resources): user-facing WITHOUT an
    // adapter — exactly the entry the reporter's engine-side validation
    // used to reject when the view dropped `evidenceLane` ("user-facing
    // resources require an 'evidenceAdapter'").
    const project = makeTempProject('witness-lane');
    writeFileSync(
      join(project, '.gateforge/claims-classifications.yml'),
      [
        'schemaVersion: 1',
        'resources:',
        '  tenant.http-frontend-errors:',
        '    exposure: user-facing',
        '    plane: tenant',
        '    lifecycle: { create: false, read: false, update: false, delete: false }',
        '    primaryKey: [method, path]',
        '    evidenceLane: claims',
        '',
      ].join('\n'),
    );
    const witness = await startWitness({
      runId: RUN_ID,
      token: TOKEN,
      classificationsPath: join(project, '.gateforge/claims-classifications.yml'),
    });
    try {
      const res = await fetch(`${witness.url}/classifications`, {
        headers: { [RUN_HEADER]: TOKEN },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        resources: Record<string, Record<string, unknown>>;
      };
      const entry = body.resources['tenant.http-frontend-errors'];
      expect(entry).toBeDefined();
      // The lane survived the serialization round-trip…
      expect(entry?.['evidenceLane']).toBe('claims');
      expect(entry?.['exposure']).toBe('user-facing');
      // …and the projected view re-validates against the frozen core
      // schema (the exact check `evaluateObligation` applies), so the
      // reporter cannot grade the claim unclassified.
      const view = toClassificationView(
        ClassificationSchema.parse({
          exposure: entry?.['exposure'],
          plane: entry?.['plane'],
          lifecycle: entry?.['lifecycle'],
          primaryKey: entry?.['primaryKey'],
          ...(entry?.['evidenceAdapter'] !== undefined
            ? { evidenceAdapter: entry?.['evidenceAdapter'] }
            : {}),
          ...(entry?.['evidenceLane'] !== undefined
            ? { evidenceLane: entry?.['evidenceLane'] }
            : {}),
        }) as Classification,
      );
      expect(view.evidenceLane).toBe('claims');
    } finally {
      await witness.stop();
    }
  });

  it('an adapter-lane entry stays adapter-lane (no evidenceLane in the view)', async () => {
    const fixture = await startFixturedWitness({ fingerprint: 'example-v1' });
    try {
      const res = await fetch(`${fixture.witness.url}/classifications`, {
        headers: { [RUN_HEADER]: TOKEN },
      });
      const body = (await res.json()) as {
        resources: Record<string, Record<string, unknown>>;
      };
      expect(body.resources['tenant.accounts']?.['evidenceAdapter']).toBe('tenant.accounts');
      expect(body.resources['tenant.accounts']?.['evidenceLane']).toBeUndefined();
    } finally {
      await fixture.witness.stop();
      await fixture.target.stop();
    }
  });
});

/** Trusted run-context binding body (plan §11.4): fixed valid UUIDs + digest. */
const INVOCATION_ID = 'aaaaaaaa-0000-4000-8000-000000000001';
const INPUT_DIGEST = 'b'.repeat(64);

/** Binds the trusted context; asserts 200 and echoes the frozen copy. */
async function bindContext(
  url: string,
  body: { runId: string; invocationId: string; inputDigest: string } = {
    runId: RUN_ID,
    invocationId: INVOCATION_ID,
    inputDigest: INPUT_DIGEST,
  },
  verifierKey: string | null = VERIFIER_KEY,
): Promise<{ runId: string; invocationId: string; inputDigest: string }> {
  const headers: Record<string, string> = { [RUN_HEADER]: TOKEN, 'content-type': 'application/json' };
  if (verifierKey !== null) headers[VERIFIER_HEADER] = verifierKey;
  const res = await fetch(`${url}/run-context`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as { runId: string; invocationId: string; inputDigest: string };
}

describe('run-context binding (plan §11.4)', () => {
  it('binds the trusted context before observation; identical rebind is idempotent', async () => {
    const fixture = await startFixturedWitness({ fingerprint: 'example-v1' });
    try {
      const bound = await bindContext(fixture.witness.url);
      expect(bound).toEqual({ bound: true, runId: RUN_ID, invocationId: INVOCATION_ID, inputDigest: INPUT_DIGEST });
      // Identical rebind: 200, same frozen copy.
      const rebound = await bindContext(fixture.witness.url);
      expect(rebound).toEqual(bound);
    } finally {
      await fixture.witness.stop();
      await fixture.target.stop();
    }
  });

  it('suite with the run token only gets 401 and the context is unchanged', async () => {
    const fixture = await startFixturedWitness({ fingerprint: 'example-v1' });
    try {
      // No verifier header at all (what the stripped suite can send).
      const tokenOnly = await fetch(`${fixture.witness.url}/run-context`, {
        method: 'POST',
        headers: { [RUN_HEADER]: TOKEN, 'content-type': 'application/json' },
        body: JSON.stringify({ runId: RUN_ID, invocationId: INVOCATION_ID, inputDigest: INPUT_DIGEST }),
      });
      expect(tokenOnly.status).toBe(401);
      const wrongKey = await fetch(`${fixture.witness.url}/run-context`, {
        method: 'POST',
        headers: { [RUN_HEADER]: TOKEN, [VERIFIER_HEADER]: 'wrong-verifier-key', 'content-type': 'application/json' },
        body: JSON.stringify({ runId: RUN_ID, invocationId: INVOCATION_ID, inputDigest: INPUT_DIGEST }),
      });
      expect(wrongKey.status).toBe(401);
      // Nothing stuck: the trusted bind still works afterwards.
      await bindContext(fixture.witness.url);
      // ...but a *changed* rebind is 409: bound state is never relabeled.
      const changed = await fetch(`${fixture.witness.url}/run-context`, {
        method: 'POST',
        headers: { [RUN_HEADER]: TOKEN, [VERIFIER_HEADER]: VERIFIER_KEY, 'content-type': 'application/json' },
        body: JSON.stringify({ runId: RUN_ID, invocationId: INVOCATION_ID, inputDigest: 'c'.repeat(64) }),
      });
      expect(changed.status).toBe(409);
    } finally {
      await fixture.witness.stop();
      await fixture.target.stop();
    }
  });

  it('rejects malformed bodies with 400 and mismatched run ids with 409', async () => {
    const fixture = await startFixturedWitness({ fingerprint: 'example-v1' });
    try {
      const headers = { [RUN_HEADER]: TOKEN, [VERIFIER_HEADER]: VERIFIER_KEY, 'content-type': 'application/json' };
      for (const bad of [
        { runId: RUN_ID, invocationId: INVOCATION_ID },
        { runId: 'not-a-uuid', invocationId: INVOCATION_ID, inputDigest: INPUT_DIGEST },
        { runId: RUN_ID, invocationId: INVOCATION_ID, inputDigest: 'xyz' },
        'just-a-string',
      ]) {
        const res = await fetch(`${fixture.witness.url}/run-context`, {
          method: 'POST',
          headers,
          body: JSON.stringify(bad),
        });
        expect(res.status).toBe(400);
      }
      const foreign = await fetch(`${fixture.witness.url}/run-context`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          runId: '00000000-0000-4000-8000-000000000099',
          invocationId: INVOCATION_ID,
          inputDigest: INPUT_DIGEST,
        }),
      });
      expect(foreign.status).toBe(409);
    } finally {
      await fixture.witness.stop();
      await fixture.target.stop();
    }
  });

  it('rejects binding to a used witness (issued, observed, or in flight) with 409', async () => {
    const fixture = await startFixturedWitness({ fingerprint: 'example-v1' });
    try {
      const session = await openSupervisorSession(fixture.witness.url, TOKEN, TEST_ID, 0, VERIFIER_KEY);
      await fetch(`${fixture.witness.url}/records`, {
        method: 'POST',
        headers: { [RUN_HEADER]: TOKEN, 'content-type': 'application/json' },
        body: JSON.stringify({
          claimId: OBLIGATION,
          kind: 'ui.action',
          payload: { operation: 'update', entityId: 'acc-1', fields: {} },
          testId: TEST_ID,
          sessionId: session.sessionId,
          sessionToken: session.sessionToken,
        }),
      });
      const res = await fetch(`${fixture.witness.url}/run-context`, {
        method: 'POST',
        headers: { [RUN_HEADER]: TOKEN, [VERIFIER_HEADER]: VERIFIER_KEY, 'content-type': 'application/json' },
        body: JSON.stringify({ runId: RUN_ID, invocationId: INVOCATION_ID, inputDigest: INPUT_DIGEST }),
      });
      expect(res.status).toBe(409);
    } finally {
      await fixture.witness.stop();
      await fixture.target.stop();
    }
  });

  it('without a verifier key, binding is refused (never the suite run token as signing key)', async () => {
    const fixture = await startFixturedWitness({ fingerprint: 'example-v1', verifierKey: null });
    try {
      const res = await fetch(`${fixture.witness.url}/run-context`, {
        method: 'POST',
        headers: { [RUN_HEADER]: TOKEN, [VERIFIER_HEADER]: VERIFIER_KEY, 'content-type': 'application/json' },
        body: JSON.stringify({ runId: RUN_ID, invocationId: INVOCATION_ID, inputDigest: INPUT_DIGEST }),
      });
      expect(res.status).toBe(409);
    } finally {
      await fixture.witness.stop();
      await fixture.target.stop();
    }
  });

  it('a proxy exchange in flight at bind time refuses binding (bind/observe race)', async () => {
    // Upstream holds its response open until released, so the proxy
    // exchange stays in flight across the bind attempt.
    let releaseUpstream!: () => void;
    const upstreamGate = new Promise<void>((resolve) => {
      releaseUpstream = resolve;
    });
    let signalArrival!: () => void;
    const arrivalGate = new Promise<void>((resolve) => {
      signalArrival = resolve;
    });
    const upstream: Server = createServer((_req, res) => {
      signalArrival();
      void upstreamGate.then(() => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ held: true }));
      });
    });
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', () => resolve()));
    const address = upstream.address();
    if (address === null || typeof address === 'string') throw new Error('no upstream port');
    const witness = await startWitness({
      runId: RUN_ID,
      token: TOKEN,
      verifierKey: VERIFIER_KEY,
      proxyTarget: `http://127.0.0.1:${address.port}`,
    });
    try {
      if (witness.proxyUrl === null) throw new Error('proxy did not start');
      const pending = fetch(`${witness.proxyUrl}/held`);
      await arrivalGate; // the exchange is now in flight (response open)
      const during = await fetch(`${witness.url}/run-context`, {
        method: 'POST',
        headers: { [RUN_HEADER]: TOKEN, [VERIFIER_HEADER]: VERIFIER_KEY, 'content-type': 'application/json' },
        body: JSON.stringify({ runId: RUN_ID, invocationId: INVOCATION_ID, inputDigest: INPUT_DIGEST }),
      });
      // Binding while older-invocation traffic is in flight is refused:
      // it must never be signed under the new context.
      expect(during.status).toBe(409);
      releaseUpstream();
      const held = await pending;
      expect(held.status).toBe(200);
      // The observation completed (response ended) while unbound: the
      // witness is used, binding stays refused, and no attestation can
      // ever cover the pre-bind exchange on this witness.
      const after = await fetch(`${witness.url}/run-context`, {
        method: 'POST',
        headers: { [RUN_HEADER]: TOKEN, [VERIFIER_HEADER]: VERIFIER_KEY, 'content-type': 'application/json' },
        body: JSON.stringify({ runId: RUN_ID, invocationId: INVOCATION_ID, inputDigest: INPUT_DIGEST }),
      });
      expect(after.status).toBe(409);
      const attestation = await fetch(`${witness.url}/ledger-attestation`, {
        headers: { [RUN_HEADER]: TOKEN, [VERIFIER_HEADER]: VERIFIER_KEY },
      });
      expect(attestation.status).toBe(409);
    } finally {
      await witness.stop();
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
    }
  });
});

describe('ledger attestation surface (pin #7, GF-23, plan §11.3)', () => {
  it('serves the versioned v2 envelope for the bound context only', async () => {
    const fixture = await startFixturedWitness({ fingerprint: 'example-v1' });
    try {
      // Unbound: no authenticated attestation, even with the right key.
      const unbound = await fetch(`${fixture.witness.url}/ledger-attestation`, {
        headers: { [RUN_HEADER]: TOKEN, [VERIFIER_HEADER]: VERIFIER_KEY },
      });
      expect(unbound.status).toBe(409);

      await bindContext(fixture.witness.url);
      // Phase 1: the record exists only under a supervisor-opened session
      // (opened AFTER the trusted bind, the real orchestrator order).
      const session = await openSupervisorSession(fixture.witness.url, TOKEN, TEST_ID, 0, VERIFIER_KEY);
      const post = await fetch(`${fixture.witness.url}/records`, {
        method: 'POST',
        headers: { [RUN_HEADER]: TOKEN, 'content-type': 'application/json' },
        body: JSON.stringify({
          claimId: OBLIGATION,
          kind: 'ui.action',
          payload: { operation: 'update', entityId: 'acc-1', fields: {} },
          testId: TEST_ID,
          sessionId: session.sessionId,
          sessionToken: session.sessionToken,
        }),
      });
      expect(post.status).toBe(200);
      const issued = (await post.json()) as { recordId: string };

      // Run token alone is NOT enough: the suite can never read the
      // attestation.
      const tokenOnly = await fetch(`${fixture.witness.url}/ledger-attestation`, {
        headers: { [RUN_HEADER]: TOKEN },
      });
      expect(tokenOnly.status).toBe(401);
      const wrongKey = await fetch(`${fixture.witness.url}/ledger-attestation`, {
        headers: { [RUN_HEADER]: TOKEN, [VERIFIER_HEADER]: 'wrong-verifier-key' },
      });
      expect(wrongKey.status).toBe(401);

      const ok = await fetch(`${fixture.witness.url}/ledger-attestation`, {
        headers: { [RUN_HEADER]: TOKEN, [VERIFIER_HEADER]: VERIFIER_KEY },
      });
      expect(ok.status).toBe(200);
      const body = (await ok.json()) as {
        attestationVersion: number;
        runId: string;
        invocationId: string;
        inputDigest: string;
        recordIds: string[];
        mac: string;
      };
      expect(body.attestationVersion).toBe(2);
      expect(body.runId).toBe(RUN_ID);
      expect(body.invocationId).toBe(INVOCATION_ID);
      expect(body.inputDigest).toBe(INPUT_DIGEST);
      expect(body.recordIds).toEqual([issued.recordId]);
      expect(
        verifyAttestationMac(
          VERIFIER_KEY,
          {
            runId: body.runId,
            invocationId: body.invocationId,
            inputDigest: body.inputDigest,
            recordIds: body.recordIds,
          },
          body.mac,
        ),
      ).toBe(true);
      // A tampered set never verifies (the hostile-suite attack).
      expect(
        verifyAttestationMac(
          VERIFIER_KEY,
          {
            runId: body.runId,
            invocationId: body.invocationId,
            inputDigest: body.inputDigest,
            recordIds: [...body.recordIds, 'a'.repeat(64)],
          },
          body.mac,
        ),
      ).toBe(false);
      // A legacy v1 MAC over the same ids never verifies as v2 (F2: old
      // evidence cannot pass changed code — different signed bytes).
      expect(
        verifyAttestationMac(
          VERIFIER_KEY,
          { runId: body.runId, invocationId: body.invocationId, inputDigest: body.inputDigest, recordIds: body.recordIds },
          ledgerMac(VERIFIER_KEY, body.runId, body.recordIds),
        ),
      ).toBe(false);
      // The producer is deterministic: the same body re-mints the same MAC.
      expect(
        attestationMac(VERIFIER_KEY, {
          runId: body.runId,
          invocationId: body.invocationId,
          inputDigest: body.inputDigest,
          recordIds: [...body.recordIds].reverse(),
        }),
      ).toBe(body.mac);
    } finally {
      await fixture.witness.stop();
      await fixture.target.stop();
    }
  });

  it('answers 409 when no verifier key is configured (no unauthenticated attestation)', async () => {
    const fixture = await startFixturedWitness({ fingerprint: 'example-v1', verifierKey: null });
    try {
      const res = await fetch(`${fixture.witness.url}/ledger-attestation`, {
        headers: { [RUN_HEADER]: TOKEN, [VERIFIER_HEADER]: VERIFIER_KEY },
      });
      expect(res.status).toBe(409);
    } finally {
      await fixture.witness.stop();
      await fixture.target.stop();
    }
  });
});

describe('run-manifest append (pin #4/#7, plan §11.3)', () => {
  it('appends the v2 attestation from the frozen bound context at shutdown', async () => {
    const stateDir = join(mkdtempSync(join(tmpdir(), 'gateforge-manifest-')), 'state');
    const fixture = await startFixturedWitness({ fingerprint: 'example-v1', stateDir });
    try {
      // Bind BEFORE any observation (the trusted CLI order), then issue
      // under the supervisor-opened session.
      await bindContext(fixture.witness.url);
      const session = await openSupervisorSession(fixture.witness.url, TOKEN, TEST_ID, 0, VERIFIER_KEY);
      await fetch(`${fixture.witness.url}/records`, {
        method: 'POST',
        headers: { [RUN_HEADER]: TOKEN, 'content-type': 'application/json' },
        body: JSON.stringify({
          claimId: OBLIGATION,
          kind: 'ui.action',
          payload: { operation: 'update', entityId: 'acc-1', fields: {} },
          testId: TEST_ID,
          sessionId: session.sessionId,
          sessionToken: session.sessionToken,
        }),
      });
      await fixture.witness.stop(); // shutdown appends
      const manifest = JSON.parse(readFileSync(join(stateDir, 'manifest.json'), 'utf8')) as {
        runId: string;
        recordIds?: string[];
        recordIdsMac?: string;
        invocationId?: string;
        inputDigest?: string;
        attestation?: {
          attestationVersion: number;
          runId: string;
          invocationId: string;
          inputDigest: string;
          recordIds: string[];
          mac: string;
        };
      };
      expect(manifest.runId).toBe(RUN_ID);
      expect(manifest.recordIds).toHaveLength(1);
      expect(manifest.recordIds?.[0]).toMatch(/^[0-9a-f]{64}$/);
      // No legacy MAC is written: v1 never authorizes evidence.
      expect(manifest.recordIdsMac).toBeUndefined();
      const parsed = RunManifestSchema.parse(manifest);
      expect(parsed.recordIds).toEqual(manifest.recordIds);
      // The append carries the SAME signed v2 object the live endpoint
      // serves: frozen bound context + exactly the issued ids. A hostile
      // suite editing manifest.json cannot re-mint the MAC.
      expect(manifest.invocationId).toBe(INVOCATION_ID);
      expect(manifest.inputDigest).toBe(INPUT_DIGEST);
      expect(manifest.attestation?.attestationVersion).toBe(2);
      expect(manifest.attestation?.runId).toBe(RUN_ID);
      expect(manifest.attestation?.invocationId).toBe(INVOCATION_ID);
      expect(manifest.attestation?.inputDigest).toBe(INPUT_DIGEST);
      expect(manifest.attestation?.recordIds).toEqual(manifest.recordIds);
      expect(
        verifyAttestationMac(
          VERIFIER_KEY,
          {
            runId: manifest.attestation?.runId,
            invocationId: manifest.attestation?.invocationId,
            inputDigest: manifest.attestation?.inputDigest,
            recordIds: manifest.attestation?.recordIds,
          },
          manifest.attestation?.mac,
        ),
      ).toBe(true);
      expect(
        verifyAttestationMac(
          VERIFIER_KEY,
          {
            runId: manifest.attestation?.runId,
            invocationId: manifest.attestation?.invocationId,
            inputDigest: manifest.attestation?.inputDigest,
            recordIds: [...(manifest.attestation?.recordIds ?? []), 'a'.repeat(64)],
          },
          manifest.attestation?.mac,
        ),
      ).toBe(false);
    } finally {
      await fixture.target.stop();
    }
  });

  it('an unbound witness appends bare ids with no attestation (fail closed downstream)', async () => {
    const stateDir = join(mkdtempSync(join(tmpdir(), 'gateforge-manifest-')), 'state');
    const fixture = await startFixturedWitness({ fingerprint: 'example-v1', stateDir });
    try {
      const session = await openSupervisorSession(fixture.witness.url, TOKEN, TEST_ID, 0, VERIFIER_KEY);
      await fetch(`${fixture.witness.url}/records`, {
        method: 'POST',
        headers: { [RUN_HEADER]: TOKEN, 'content-type': 'application/json' },
        body: JSON.stringify({
          claimId: OBLIGATION,
          kind: 'ui.action',
          payload: { operation: 'update', entityId: 'acc-1', fields: {} },
          testId: TEST_ID,
          sessionId: session.sessionId,
          sessionToken: session.sessionToken,
        }),
      });
      await fixture.witness.stop(); // shutdown appends
      const manifest = JSON.parse(readFileSync(join(stateDir, 'manifest.json'), 'utf8')) as {
        recordIds?: string[];
        recordIdsMac?: string;
        attestation?: unknown;
      };
      expect(manifest.recordIds).toHaveLength(1);
      expect(manifest.attestation).toBeUndefined();
      expect(manifest.recordIdsMac).toBeUndefined();
    } finally {
      await fixture.target.stop();
    }
  });

  it('never signs ids it did not issue: pre-seeded forged ids are discarded (GF-23 round 3)', async () => {
    const stateDir = join(mkdtempSync(join(tmpdir(), 'gateforge-manifest-')), 'state');
    const fixture = await startFixturedWitness({ fingerprint: 'example-v1', stateDir });
    try {
      await bindContext(fixture.witness.url);
      // The hostile suite plants a hash-consistent forged id in the
      // suite-writable manifest BEFORE the witness shuts down, hoping the
      // append will merge — and thereby sign — it into the issued set.
      const forgedId = recordIdOf({
        runId: RUN_ID,
        obligationId: OBLIGATION,
        kind: 'persistence.entity',
        testId: 'attack',
        origin: 'engine-observed',
        payload: { resourceId: 'tenant.accounts', entityId: 'acc-1', fields: {} },
      });
      const manifestPath = join(stateDir, 'manifest.json');
      const seeded = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
      writeFileSync(
        manifestPath,
        `${JSON.stringify({ ...seeded, recordIds: [forgedId] })}\n`,
      );

      // The witness issues exactly ONE record (never the forged one),
      // under the supervisor-opened session.
      const session = await openSupervisorSession(fixture.witness.url, TOKEN, TEST_ID, 0, VERIFIER_KEY);
      await fetch(`${fixture.witness.url}/records`, {
        method: 'POST',
        headers: { [RUN_HEADER]: TOKEN, 'content-type': 'application/json' },
        body: JSON.stringify({
          claimId: OBLIGATION,
          kind: 'ui.action',
          payload: { operation: 'update', entityId: 'acc-1', fields: {} },
          testId: TEST_ID,
          sessionId: session.sessionId,
          sessionToken: session.sessionToken,
        }),
      });
      await fixture.witness.stop(); // shutdown appends

      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
        recordIds?: string[];
        recordIdsMac?: string;
        attestation?: {
          runId: string;
          invocationId: string;
          inputDigest: string;
          recordIds: string[];
          mac: string;
        };
      };
      // The appended set is EXACTLY the ledger: the forged id was
      // discarded, not merged — and the v2 MAC covers exactly that set
      // under the frozen bound context, so the gate can never trust the
      // forgery.
      expect(manifest.recordIds).toHaveLength(1);
      expect(manifest.recordIds).not.toContain(forgedId);
      expect(manifest.recordIdsMac).toBeUndefined();
      expect(
        verifyAttestationMac(
          VERIFIER_KEY,
          {
            runId: manifest.attestation?.runId,
            invocationId: manifest.attestation?.invocationId,
            inputDigest: manifest.attestation?.inputDigest,
            recordIds: manifest.attestation?.recordIds,
          },
          manifest.attestation?.mac,
        ),
      ).toBe(true);
      expect(
        verifyAttestationMac(
          VERIFIER_KEY,
          {
            runId: manifest.attestation?.runId,
            invocationId: manifest.attestation?.invocationId,
            inputDigest: manifest.attestation?.inputDigest,
            recordIds: [...(manifest.attestation?.recordIds ?? []), forgedId],
          },
          manifest.attestation?.mac,
        ),
      ).toBe(false);
    } finally {
      await fixture.target.stop();
    }
  });
});

/**
 * Phase 1 — supervisor-issued test-session identity (work order item 1)
 * and its negative probes: sessions exist only by supervisor opening,
 * resolve answers only for the exact open (worker, testId) pair, closing
 * seals (late submissions rejected), and proxy exchanges are credited
 * ONLY to the open session whose channel they traversed, inside one of
 * its recorded action intervals.
 */
describe('test sessions (Phase 1 supervisor binding)', () => {
  it('open → resolve → submit works; closing seals (late submission rejected)', async () => {
    const fixture = await startFixturedWitness({ fingerprint: 'example-v1' });
    try {
      const session = await openSupervisorSession(fixture.witness.url, TOKEN, TEST_ID, 0, VERIFIER_KEY);
      expect(session.testId).toBe(TEST_ID);
      expect(session.workerIndex).toBe(0);
      expect(session.proxyUrl).toBeNull(); // no observation proxy wired

      // The worker resolves by the exact pair while the session is open.
      const resolve = await fetch(`${fixture.witness.url}/sessions/resolve`, {
        method: 'POST',
        headers: { [RUN_HEADER]: TOKEN, 'content-type': 'application/json' },
        body: JSON.stringify({ testId: TEST_ID, workerIndex: 0 }),
      });
      expect(resolve.status).toBe(200);

      const interval = await beginJourneyInterval(fixture.witness.url, TOKEN, session, 'update');
      await endJourneyInterval(fixture.witness.url, TOKEN, session, interval);

      // The supervisor closes with the observed outcome → SEALED.
      await closeSupervisorSession(fixture.witness.url, TOKEN, session.sessionId, 'passed', VERIFIER_KEY);

      // Resolve no longer answers (404), and late submissions are rejected.
      const lateResolve = await fetch(`${fixture.witness.url}/sessions/resolve`, {
        method: 'POST',
        headers: { [RUN_HEADER]: TOKEN, 'content-type': 'application/json' },
        body: JSON.stringify({ testId: TEST_ID, workerIndex: 0 }),
      });
      expect(lateResolve.status).toBe(404);
      const lateSubmission = await fetch(`${fixture.witness.url}/records`, {
        method: 'POST',
        headers: { [RUN_HEADER]: TOKEN, 'content-type': 'application/json' },
        body: JSON.stringify({
          claimId: OBLIGATION,
          kind: 'ui.action',
          payload: { operation: 'update', entityId: 'acc-1', fields: {} },
          testId: TEST_ID,
          sessionId: session.sessionId,
          sessionToken: session.sessionToken,
        }),
      });
      expect(lateSubmission.status).toBe(409);
      const lateBody = (await lateSubmission.json()) as { error: string };
      expect(lateBody.error).toMatch(/sealed|late submissions/);
      const lateInterval = await fetch(`${fixture.witness.url}/sessions/intervals/open`, {
        method: 'POST',
        headers: { [RUN_HEADER]: TOKEN, 'content-type': 'application/json' },
        body: JSON.stringify({
          sessionId: session.sessionId,
          sessionToken: session.sessionToken,
          operation: 'update',
        }),
      });
      expect(lateInterval.status).toBe(409);
      const ledger = (await (
        await fetch(`${fixture.witness.url}/records`, { headers: { [RUN_HEADER]: TOKEN } })
      ).json()) as { records: unknown[] };
      expect(ledger.records).toHaveLength(0);
    } finally {
      await fixture.witness.stop();
      await fixture.target.stop();
    }
  });

  it('resolve answers only for the exact (workerIndex, testId) pair; one open session per worker', async () => {
    const fixture = await startFixturedWitness({ fingerprint: 'example-v1' });
    try {
      await openSupervisorSession(fixture.witness.url, TOKEN, TEST_ID, 0, VERIFIER_KEY);
      // Wrong testId on the same worker → 404.
      const wrongTest = await fetch(`${fixture.witness.url}/sessions/resolve`, {
        method: 'POST',
        headers: { [RUN_HEADER]: TOKEN, 'content-type': 'application/json' },
        body: JSON.stringify({ testId: 'another-test', workerIndex: 0 }),
      });
      expect(wrongTest.status).toBe(404);
      // A different worker has no session → 404.
      const otherWorker = await fetch(`${fixture.witness.url}/sessions/resolve`, {
        method: 'POST',
        headers: { [RUN_HEADER]: TOKEN, 'content-type': 'application/json' },
        body: JSON.stringify({ testId: TEST_ID, workerIndex: 1 }),
      });
      expect(otherWorker.status).toBe(404);
      // Opening a DIFFERENT test on the same worker while open → 409
      // (the supervisor key is presented: the test acts as the supervisor;
      // the run token alone would answer 401 — pinned below).
      const overlap = await fetch(`${fixture.witness.url}/sessions/open`, {
        method: 'POST',
        headers: { [RUN_HEADER]: TOKEN, [VERIFIER_HEADER]: VERIFIER_KEY, 'content-type': 'application/json' },
        body: JSON.stringify({ testId: 'another-test', workerIndex: 0 }),
      });
      expect(overlap.status).toBe(409);
      // Identical re-open is idempotent (double onTestBegin safety).
      const again = await openSupervisorSession(fixture.witness.url, TOKEN, TEST_ID, 0, VERIFIER_KEY);
      expect(again.sessionId).toBeDefined();
    } finally {
      await fixture.witness.stop();
      await fixture.target.stop();
    }
  });

  it('PROBE (E11/E12): another worker/test supplies the HTTP request — never credited', async () => {
    // Minimal loopback upstream: every exchange answers 201 JSON.
    const upstream: Server = createServer((_req, res) => {
      res.writeHead(201, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', () => resolve()));
    const address = upstream.address();
    if (address === null || typeof address === 'string') throw new Error('no upstream port');
    const witness = await startWitness({
      runId: RUN_ID,
      token: TOKEN,
      verifierKey: VERIFIER_KEY,
      proxyTarget: `http://127.0.0.1:${address.port}`,
    });
    try {
      // Two sessions: the CLAIMING test (worker 0) and the test that
      // actually drives the traffic (worker 1).
      const claimer = await openSupervisorSession(witness.url, TOKEN, 'claiming-test', 0, VERIFIER_KEY);
      const driver = await openSupervisorSession(witness.url, TOKEN, 'driving-test', 1, VERIFIER_KEY);
      // The OTHER test's browser fires the exchange through ITS channel,
      // inside ITS interval.
      const driverInterval = await beginJourneyInterval(witness.url, TOKEN, driver, 'create');
      await fetch(`${driver.proxyUrl as string}/api/contracts`, {
        method: 'POST',
      });
      await endJourneyInterval(witness.url, TOKEN, driver, driverInterval);

      // The claiming test tries to consume it: refused — the exchange
      // traversed ANOTHER session's channel (session interval mismatch).
      const stolen = await fetch(`${witness.url}/witness/http-observation`, {
        method: 'POST',
        headers: { [RUN_HEADER]: TOKEN, 'content-type': 'application/json' },
        body: JSON.stringify({
          claimId: 'tenant.http-post-api-contracts-x1:http:request-observed',
          testId: 'claiming-test',
          method: 'POST',
          path: '/api/contracts',
          sessionId: claimer.sessionId,
          sessionToken: claimer.sessionToken,
        }),
      });
      expect(stolen.status).toBe(409);
      const stolenBody = (await stolen.json()) as { error: string };
      expect(stolenBody.error).toMatch(/ANOTHER session's channel/);
      // Interval rule (setup-traffic separation): the driver's OWN
      // session may consume the exchange inside its interval…
      const legitimate = await fetch(`${witness.url}/witness/http-observation`, {
        method: 'POST',
        headers: { [RUN_HEADER]: TOKEN, 'content-type': 'application/json' },
        body: JSON.stringify({
          claimId: 'tenant.http-post-api-contracts-x1:http:request-observed',
          testId: 'driving-test',
          method: 'POST',
          path: '/api/contracts',
          sessionId: driver.sessionId,
          sessionToken: driver.sessionToken,
        }),
      });
      expect(legitimate.status).toBe(200);
      // …but an exchange observed OUTSIDE every recorded interval (after
      // the interval closed — i.e. plain setup traffic) is never credited.
      await fetch(`${driver.proxyUrl as string}/api/contracts`, {
        method: 'POST',
      });
      const outsideInterval = await fetch(`${witness.url}/witness/http-observation`, {
        method: 'POST',
        headers: { [RUN_HEADER]: TOKEN, 'content-type': 'application/json' },
        body: JSON.stringify({
          claimId: 'tenant.http-post-api-contracts-x1:http:request-observed',
          testId: 'driving-test',
          method: 'POST',
          path: '/api/contracts',
          sessionId: driver.sessionId,
          sessionToken: driver.sessionToken,
        }),
      });
      expect(outsideInterval.status).toBe(409);
      const outsideBody = (await outsideInterval.json()) as { error: string };
      expect(outsideBody.error).toMatch(/outside every recorded UI-action observation interval/);
    } finally {
      await witness.stop();
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
    }
  });

  it('PROBE: unattributed traffic (no session channel) is never consumable', async () => {
    const upstream: Server = createServer((_req, res) => {
      res.writeHead(201, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', () => resolve()));
    const address = upstream.address();
    if (address === null || typeof address === 'string') throw new Error('no upstream port');
    const witness = await startWitness({
      runId: RUN_ID,
      token: TOKEN,
      verifierKey: VERIFIER_KEY,
      proxyTarget: `http://127.0.0.1:${address.port}`,
    });
    try {
      const session = await openSupervisorSession(witness.url, TOKEN, TEST_ID, 0, VERIFIER_KEY);
      const interval = await beginJourneyInterval(witness.url, TOKEN, session, 'create');
      // Traffic WITHOUT the session prefix: bypasses every session channel.
      await fetch(`${witness.proxyUrl as string}/api/contracts`, { method: 'POST' });
      const consume = await fetch(`${witness.url}/witness/http-observation`, {
        method: 'POST',
        headers: { [RUN_HEADER]: TOKEN, 'content-type': 'application/json' },
        body: JSON.stringify({
          claimId: 'tenant.http-post-api-contracts-x1:http:request-observed',
          testId: TEST_ID,
          method: 'POST',
          path: '/api/contracts',
          sessionId: session.sessionId,
          sessionToken: session.sessionToken,
        }),
      });
      expect(consume.status).toBe(409);
      const body = (await consume.json()) as { error: string };
      expect(body.error).toMatch(/no engine-observed request matches/);
      await endJourneyInterval(witness.url, TOKEN, session, interval);
    } finally {
      await witness.stop();
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
    }
  });
});

/**
 * Enforcement-review fix 3 + fix 2a negative pins (the three review
 * attacks, leg c): the suite's run token NEVER authorizes session
 * lifecycle, expected-set registration, or the execution trace — only
 * the verifier key (the supervisor capability the tested suite never
 * receives) does — and a supervisor-registered expected set refuses
 * invented test identities.
 */
describe('supervisor authority + expected set (enforcement-review fixes 2a/3)', () => {
  /** Supervisor-grade POST helper (run token + verifier key). */
  async function supervisorPost(
    url: string,
    path: string,
    body: unknown,
    key: string | null = VERIFIER_KEY,
  ): Promise<Response> {
    const headers: Record<string, string> = { [RUN_HEADER]: TOKEN, 'content-type': 'application/json' };
    if (key !== null) headers[VERIFIER_HEADER] = key;
    return fetch(`${url}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
  }

  it('run-token-only /sessions/open and /sessions/close are refused (the suite cannot mint or seal sessions)', async () => {
    const fixture = await startFixturedWitness({ fingerprint: 'example-v1' });
    try {
      // Open with the run token alone → 401 typed (key configured).
      const tokenOpen = await fetch(`${fixture.witness.url}/sessions/open`, {
        method: 'POST',
        headers: { [RUN_HEADER]: TOKEN, 'content-type': 'application/json' },
        body: JSON.stringify({ testId: TEST_ID, workerIndex: 0 }),
      });
      expect(tokenOpen.status).toBe(401);
      expect(((await tokenOpen.json()) as { error: string }).error).toMatch(/run token never authorizes session lifecycle/);

      // A keyless witness answers 403 typed instead of degrading.
      const keyless = await startFixturedWitness({ fingerprint: 'example-v1', verifierKey: null });
      try {
        const keylessOpen = await fetch(`${keyless.witness.url}/sessions/open`, {
          method: 'POST',
          headers: { [RUN_HEADER]: TOKEN, 'content-type': 'application/json' },
          body: JSON.stringify({ testId: TEST_ID, workerIndex: 0 }),
        });
        expect(keylessOpen.status).toBe(403);
        expect(((await keylessOpen.json()) as { error: string }).error).toMatch(/supervisor authorization required/);
      } finally {
        await keyless.witness.stop();
        await keyless.target.stop();
      }

      // The suite also cannot SEAL: a run-token-only close is refused…
      const session = await openSupervisorSession(fixture.witness.url, TOKEN, TEST_ID, 0, VERIFIER_KEY);
      const tokenClose = await fetch(`${fixture.witness.url}/sessions/close`, {
        method: 'POST',
        headers: { [RUN_HEADER]: TOKEN, 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: session.sessionId, outcome: 'passed' }),
      });
      expect(tokenClose.status).toBe(401);
      // …and the session is still OPEN afterwards (nothing was sealed):
      // a submission under the live credential still works.
      const submit = await fetch(`${fixture.witness.url}/records`, {
        method: 'POST',
        headers: { [RUN_HEADER]: TOKEN, 'content-type': 'application/json' },
        body: JSON.stringify({
          claimId: OBLIGATION,
          kind: 'ui.action',
          payload: { operation: 'update', entityId: 'acc-1', fields: {} },
          testId: TEST_ID,
          sessionId: session.sessionId,
          sessionToken: session.sessionToken,
        }),
      });
      expect(submit.status).toBe(200);
    } finally {
      await fixture.witness.stop();
      await fixture.target.stop();
    }
  });

  it('an invented testId is refused once the expected set is registered (fix 2a)', async () => {
    const fixture = await startFixturedWitness({ fingerprint: 'example-v1' });
    try {
      const registered = await supervisorPost(fixture.witness.url, '/runs/expected-set', {
        tests: [{ testId: TEST_ID, project: null, file: 'specs/accounts.spec.js', titlePath: ['Accounts', 'deletes an account'] }],
      });
      expect(registered.status).toBe(200);
      const bound = (await registered.json()) as { bound: boolean; enumerationDigest: string; count: number };
      expect(bound.bound).toBe(true);
      expect(bound.count).toBe(1);
      expect(bound.enumerationDigest).toMatch(/^[0-9a-f]{64}$/);

      // The registered test opens (identity join = project+file+titlePath).
      const ok = await supervisorPost(fixture.witness.url, '/sessions/open', {
        testId: TEST_ID,
        workerIndex: 0,
        file: 'specs/accounts.spec.js',
        titlePath: ['Accounts', 'deletes an account'],
      });
      expect(ok.status).toBe(200);

      // An INVENTED testId with an unregistered identity → typed refusal.
      const invented = await supervisorPost(fixture.witness.url, '/sessions/open', {
        testId: 'invented-by-test-code',
        workerIndex: 1,
        file: 'specs/invented.spec.js',
        titlePath: ['Invented'],
      });
      expect(invented.status).toBe(403);
      expect(((await invented.json()) as { error: string }).error).toMatch(/not in the registered expected set/);

      // Identical re-registration is idempotent (200, same digest)…
      const again = await supervisorPost(fixture.witness.url, '/runs/expected-set', {
        tests: [{ testId: TEST_ID, project: null, file: 'specs/accounts.spec.js', titlePath: ['Accounts', 'deletes an account'] }],
      });
      expect(again.status).toBe(200);
      expect(((await again.json()) as { enumerationDigest: string }).enumerationDigest).toBe(bound.enumerationDigest);
      // …any change is 409 — the expected set is a PRE-run fact, never relabeled.
      const changed = await supervisorPost(fixture.witness.url, '/runs/expected-set', {
        tests: [
          { testId: TEST_ID, project: null, file: 'specs/accounts.spec.js', titlePath: ['Accounts', 'deletes an account'] },
          { testId: 'extra', project: null, file: 'specs/extra.spec.js', titlePath: ['Extra'] },
        ],
      });
      expect(changed.status).toBe(409);
    } finally {
      await fixture.witness.stop();
      await fixture.target.stop();
    }
  });

  it('the execution trace is supervisor-only and grades from witness-kept sessions (fix 2b)', async () => {
    const fixture = await startFixturedWitness({ fingerprint: 'example-v1' });
    try {
      await supervisorPost(fixture.witness.url, '/runs/expected-set', {
        tests: [{ testId: TEST_ID, project: null, file: 'specs/accounts.spec.js', titlePath: ['Accounts', 'deletes an account'] }],
      });
      const opened = (await (
        await supervisorPost(fixture.witness.url, '/sessions/open', {
          testId: TEST_ID,
          workerIndex: 0,
          file: 'specs/accounts.spec.js',
          titlePath: ['Accounts', 'deletes an account'],
        })
      ).json()) as { sessionId: string };
      await closeSupervisorSession(fixture.witness.url, TOKEN, opened.sessionId, 'passed', VERIFIER_KEY);

      // Run token alone / wrong key → refused.
      const tokenOnly = await fetch(`${fixture.witness.url}/runs/execution-trace`, {
        headers: { [RUN_HEADER]: TOKEN },
      });
      expect(tokenOnly.status).toBe(401);
      const wrongKey = await fetch(`${fixture.witness.url}/runs/execution-trace`, {
        headers: { [RUN_HEADER]: TOKEN, [VERIFIER_HEADER]: 'wrong-verifier-key' },
      });
      expect(wrongKey.status).toBe(401);

      // With the key: the trace is the witness-side record supervision
      // grades from — registered identity, seal tick, observed outcome.
      const trace = await fetch(`${fixture.witness.url}/runs/execution-trace`, {
        headers: { [RUN_HEADER]: TOKEN, [VERIFIER_HEADER]: VERIFIER_KEY },
      });
      expect(trace.status).toBe(200);
      const body = (await trace.json()) as {
        enumerationDigest: string | null;
        tests: Array<{ testId: string | null; file: string; titlePath: string[]; sessions: Array<{ sessionId: string; sealedTick: number | null; outcome: string | null }> }>;
      };
      expect(body.enumerationDigest).toMatch(/^[0-9a-f]{64}$/);
      expect(body.tests).toHaveLength(1);
      expect(body.tests[0]).toMatchObject({ testId: TEST_ID, file: 'specs/accounts.spec.js' });
      expect(body.tests[0]?.sessions).toHaveLength(1);
      expect(body.tests[0]?.sessions[0]?.sessionId).toBe(opened.sessionId);
      expect(body.tests[0]?.sessions[0]?.sealedTick).not.toBeNull();
      expect(body.tests[0]?.sessions[0]?.outcome).toBe('passed');
    } finally {
      await fixture.witness.stop();
      await fixture.target.stop();
    }
  });
});

describe('witness startup validation', () => {
  it('fails closed without a runId or token', async () => {
    await expect(
      startWitness({ runId: '', token: TOKEN }),
    ).rejects.toThrow(WitnessStartupError);
    await expect(
      startWitness({ runId: RUN_ID, token: '' }),
    ).rejects.toThrow(WitnessStartupError);
  });

  it('fails closed on an invalid adapter module', async () => {
    const project = makeTempProject('badadapter');
    writeFixtureProject(project);
    writeFileSync(
      join(project, '.gateforge/adapters/tenant.accounts.mjs'),
      'export default { read: () => null };\n', // missing normalize/deletion/fingerprint
    );
    await expect(
      startWitness({
        runId: RUN_ID,
        token: TOKEN,
        adaptersDir: join(project, '.gateforge/adapters'),
      }),
    ).rejects.toThrow(/adapter 'tenant.accounts' violates the adapter contract/);
  });

  it('fails closed on a syntactically broken adapter module', async () => {
    const project = makeTempProject('badadapter');
    writeFixtureProject(project);
    writeFileSync(
      join(project, '.gateforge/adapters/tenant.accounts.mjs'),
      'export default { this is not javascript }\n',
    );
    await expect(
      startWitness({
        runId: RUN_ID,
        token: TOKEN,
        adaptersDir: join(project, '.gateforge/adapters'),
      }),
    ).rejects.toThrow(/could not be imported/);
  });
});

describe('witness startup attestation probe', () => {
  it('blocks startup when the pinned target fingerprint is absent (GF-13 startup)', async () => {
    const project = makeTempProject('attest');
    writeFixtureProject(project);
    writeHonestAdapter(project);
    const raw = await startMarkerServer(null); // no marker
    try {
      await expect(
        startWitness({
          runId: RUN_ID,
          token: TOKEN,
          adaptersDir: join(project, '.gateforge/adapters'),
          targetBaseUrl: raw.url,
          targetFingerprint: 'example-v1',
        }),
      ).rejects.toThrow(/failed startup attestation/);
    } finally {
      await raw.stop();
    }
  });
});

describe('health', () => {
  it('reports the attestation scope', async () => {
    const fixture = await startFixturedWitness({ fingerprint: 'example-v1' });
    try {
      const body = (await (
        await fetch(`${fixture.witness.url}/health`, { headers: { [RUN_HEADER]: TOKEN } })
      ).json()) as { ok: boolean; attestationScope: string };
      expect(body.ok).toBe(true);
      expect(body.attestationScope).toBe('loopback+env-fingerprint');
    } finally {
      await fixture.witness.stop();
      await fixture.target.stop();
    }
  });
});

void randomUUID;