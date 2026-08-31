/**
 * Witness-service tests (GF-10, GF-11, GF-13, GF-14 witness-side, pin
 * #7): loopback auth, record issuance + provenance, unknown-primitive
 * rejection, env-fingerprint attestation, manifest recordIds append,
 * and the classification surface. Real loopback HTTP; no mocks.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { startWitness, WitnessStartupError, recordIdOf } from '../src/witness/server.js';
import { writeHonestAdapter, writeFixtureProject, makeTempProject } from './helpers.js';
import { AttestationError } from '../src/witness/env-attestation.js';
import { ENV_FINGERPRINT_HEADER, RUN_HEADER } from '../src/constants.js';
import { startAttestationProxy } from '../src/attestation/proxy.js';
import { startMarkerServer } from './marker-server.js';

const RUN_ID = '6f1c3f90-2d5e-4b1a-9c6d-0f0e2b8a1c9d';
const TOKEN = 'run-token-abc-123';
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
}) {
  const project = makeTempProject('witness');
  writeFixtureProject(project);
  writeHonestAdapter(project, options.adapterFingerprint ?? 'example-v1');
  const target = await startMarkerServer(options.fingerprint);
  const stateDir = options.stateDir === undefined ? join(project, '.gateforge/test-gates') : options.stateDir;
  if (stateDir !== null) {
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(
      join(stateDir, 'manifest.json'),
      `${JSON.stringify({ schemaVersion: 1, runId: RUN_ID, startedAt: '2026-08-30T12:00:00.000Z' })}\n`,
    );
  }
  const witness = await startWitness({
    runId: RUN_ID,
    token: TOKEN,
    stateDir,
    adaptersDir: join(project, '.gateforge/adapters'),
    classificationsPath: join(project, '.gateforge/classifications.yml'),
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

describe('record issuance (pin #7)', () => {
  it('issues a witnessed record with service-computed provenance', async () => {
    const fixture = await startFixturedWitness({ fingerprint: 'example-v1' });
    try {
      const res = await fetch(`${fixture.witness.url}/records`, {
        method: 'POST',
        headers: { [RUN_HEADER]: TOKEN, 'content-type': 'application/json' },
        body: JSON.stringify({
          claimId: OBLIGATION,
          kind: 'ui.action',
          payload: { operation: 'update', entityId: 'acc-1', fields: { first_name: 'Ada' } },
          testId: TEST_ID,
        }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        recordId: string;
        trust: string;
        runId: string;
      };
      expect(body.trust).toBe('witnessed');
      expect(body.runId).toBe(RUN_ID);
      expect(body.recordId).toMatch(/^[0-9a-f]{64}$/);
      expect(body.recordId).toBe(
        recordIdOf({
          runId: RUN_ID,
          obligationId: OBLIGATION,
          kind: 'ui.action',
          testId: TEST_ID,
          payload: { operation: 'update', entityId: 'acc-1', fields: { first_name: 'Ada' } },
        }),
      );
      const ledger = (await (
        await fetch(`${fixture.witness.url}/records`, {
          headers: { [RUN_HEADER]: TOKEN },
        })
      ).json()) as { records: Array<{ recordId: string; trust: string; payload: unknown }> };
      expect(ledger.records).toHaveLength(1);
      expect(ledger.records[0]?.trust).toBe('witnessed');
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
      const res = await fetch(`${fixture.witness.url}/witness/persistence`, {
        method: 'POST',
        headers: { [RUN_HEADER]: TOKEN, 'content-type': 'application/json' },
        body: JSON.stringify({
          resourceId: 'tenant.accounts',
          entityId: 'acc-1',
          expectFields: { first_name: 'Ada', last_name: 'Lovelace' },
          testId: TEST_ID,
          claimId: OBLIGATION,
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
      ).json()) as { records: Array<{ kind: string; payload: { entityId: string } }> };
      const persistence = ledger.records.find((record) => record.kind === 'persistence.entity');
      expect(persistence?.payload.entityId).toBe('acc-1');
    } finally {
      await fixture.witness.stop();
      await fixture.target.stop();
    }
  });

  it('rejects a persistence request for a resource with no adapter (400)', async () => {
    const fixture = await startFixturedWitness({ fingerprint: 'example-v1' });
    try {
      const res = await fetch(`${fixture.witness.url}/witness/persistence`, {
        method: 'POST',
        headers: { [RUN_HEADER]: TOKEN, 'content-type': 'application/json' },
        body: JSON.stringify({
          resourceId: 'tenant.ghosts',
          entityId: 'x',
          testId: TEST_ID,
          claimId: 'tenant.ghosts:crud:update',
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
        adaptersDir: join(project, '.gateforge/adapters'),
        targetBaseUrl: proxy.url, // attested subject HAS the marker
        targetFingerprint: 'example-v1',
        adapterBaseUrl: raw.url, // adapter reads the UNMARKED env
      });
      try {
        const res = await fetch(`${witness.url}/witness/persistence`, {
          method: 'POST',
          headers: { [RUN_HEADER]: TOKEN, 'content-type': 'application/json' },
          body: JSON.stringify({
            resourceId: 'tenant.accounts',
            entityId: 'acc-1',
            expectFields: { first_name: 'Ada' },
            testId: TEST_ID,
            claimId: OBLIGATION,
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
        adaptersDir: join(project, '.gateforge/adapters'),
        targetBaseUrl: target.url,
        targetFingerprint: 'example-v1',
        adapterBaseUrl: target.url, // marker example-v1 ≠ adapter's declared fingerprint
      });
      try {
        const res = await fetch(`${witness.url}/witness/persistence`, {
          method: 'POST',
          headers: { [RUN_HEADER]: TOKEN, 'content-type': 'application/json' },
          body: JSON.stringify({
            resourceId: 'tenant.accounts',
            entityId: 'acc-1',
            testId: TEST_ID,
            claimId: OBLIGATION,
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
        adaptersDir: join(project, '.gateforge/adapters'),
        targetBaseUrl: target.url,
        targetFingerprint: 'example-v1',
      });
      try {
        const res = await fetch(`${witness.url}/witness/persistence`, {
          method: 'POST',
          headers: { [RUN_HEADER]: TOKEN, 'content-type': 'application/json' },
          body: JSON.stringify({
            resourceId: 'tenant.accounts',
            entityId: 'acc-1',
            testId: TEST_ID,
            claimId: OBLIGATION,
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
});

describe('run-manifest append (pin #4/#7)', () => {
  it('appends the issued recordIds to manifest.json at shutdown', async () => {
    const stateDir = join(mkdtempSync(join(tmpdir(), 'gateforge-manifest-')), 'state');
    const fixture = await startFixturedWitness({ fingerprint: 'example-v1', stateDir });
    try {
      await fetch(`${fixture.witness.url}/records`, {
        method: 'POST',
        headers: { [RUN_HEADER]: TOKEN, 'content-type': 'application/json' },
        body: JSON.stringify({
          claimId: OBLIGATION,
          kind: 'ui.action',
          payload: { operation: 'update', entityId: 'acc-1', fields: {} },
          testId: TEST_ID,
        }),
      });
      await fixture.witness.stop(); // shutdown appends
      const manifest = JSON.parse(readFileSync(join(stateDir, 'manifest.json'), 'utf8')) as {
        runId: string;
        recordIds?: string[];
      };
      expect(manifest.runId).toBe(RUN_ID);
      expect(manifest.recordIds).toHaveLength(1);
      expect(manifest.recordIds?.[0]).toMatch(/^[0-9a-f]{64}$/);
    } finally {
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