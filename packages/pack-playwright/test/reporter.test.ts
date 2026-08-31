/**
 * Reporter tests (GF-23 enforcement + GF-24 left side):
 *
 * - claims.json is extracted from annotations (claim registry);
 * - records.json contains ONLY the witness-issued ledger — a fabricated
 *   bundle never enters it (GF-23);
 * - per-claim ledger verdicts come from the REAL engine for honest
 *   records (satisfied) and for fabricated bundles LACKING service
 *   provenance (claimed ⇒ invalid/missing, never satisfied — GF-23);
 * - obligations without any claim are flagged (GF-24).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { GateforgeReporter } from '../src/reporter/reporter.js';
import { startWitness } from '../src/witness/server.js';
import { startMarkerServer } from './marker-server.js';
import { makeTempProject, writeFixtureProject, writeHonestAdapter, FINGERPRINT } from './helpers.js';
import { WitnessClient } from '../src/fixture/witness-client.js';

const RUN_ID = '6f1c3f90-2d5e-4b1a-9c6d-0f0e2b8a1c9d';
const TOKEN = 'reporter-token';
const CREATE = 'tenant.accounts:crud:create';
const UPDATE = 'tenant.accounts:crud:update';
const TEST_ID = 'spec.js > honest create';

const ORIGINAL_ENV: Record<string, string | undefined> = {};

afterEach(() => {
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  Object.keys(ORIGINAL_ENV).forEach((key) => delete ORIGINAL_ENV[key]);
});

function saveEnv(...keys: string[]): void {
  for (const key of keys) ORIGINAL_ENV[key] = process.env[key];
}

/** Full fixture run: witness + target + temp project + state dir. */
async function setupRun(options: { adapterFingerprint?: string } = {}) {
  const project = makeTempProject('reporter');
  writeFixtureProject(project);
  writeHonestAdapter(project, options.adapterFingerprint ?? FINGERPRINT);
  const target = await startMarkerServer(FINGERPRINT);
  const stateDir = join(project, 'state');
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(
    join(project, '.gateforge/test-gates/obligations.json'),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        obligations: [
          {
            id: CREATE,
            resourceId: 'tenant.accounts',
            contract: 'crud:create',
            policyId: 'crud',
            lifecycle: { create: true, read: true, update: true, delete: true, deleteSemantics: 'archive' },
            fingerprint: 'f-create',
            source: 'src/accounts.js',
            location: { file: 'src/accounts.js', line: 1, col: 0 },
          },
          {
            id: UPDATE,
            resourceId: 'tenant.accounts',
            contract: 'crud:update',
            policyId: 'crud',
            lifecycle: { create: true, read: true, update: true, delete: true, deleteSemantics: 'archive' },
            fingerprint: 'f-update',
            source: 'src/accounts.js',
            location: { file: 'src/accounts.js', line: 1, col: 0 },
          },
        ],
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(
    join(stateDir, 'manifest.json'),
    `${JSON.stringify({ schemaVersion: 1, runId: RUN_ID, startedAt: '2026-08-30T12:00:00.000Z' })}\n`,
  );
  const witness = await startWitness({
    runId: RUN_ID,
    token: TOKEN,
    stateDir,
    adaptersDir: join(project, '.gateforge/adapters'),
    classificationsPath: join(project, '.gateforge/classifications.yml'),
    targetBaseUrl: target.url,
    targetFingerprint: FINGERPRINT,
    adapterBaseUrl: target.url,
    now: () => '2026-08-30T12:00:01.000Z',
  });
  return { project, target, witness, stateDir };
}

/** Posts one honest create flow's records through the real witness. */
async function postHonestCreate(client: WitnessClient): Promise<void> {
  await client.postRecords({
    claimId: CREATE,
    kind: 'ui.action',
    payload: { operation: 'create', entityId: 'acc-1', fields: { first_name: 'Ada', last_name: 'Lovelace' } },
    testId: TEST_ID,
  });
  await client.postRecords({
    claimId: CREATE,
    kind: 'ui.visible-result',
    payload: {
      entityId: 'acc-1',
      fields: { first_name: 'Ada', last_name: 'Lovelace', status: 'active' },
    },
    testId: TEST_ID,
  });
  await client.verifyPersistence({
    resourceId: 'tenant.accounts',
    entityId: 'acc-1',
    expectFields: { first_name: 'Ada', last_name: 'Lovelace' },
    testId: TEST_ID,
    claimId: CREATE,
  });
}

function runReporter(
  stateDir: string,
  testRows: Array<{
    id: string;
    annotations: Array<{ type: string; description?: string }>;
    location?: { file: string; line: number; column: number };
    status?: string;
  }>,
): Promise<void> {
  const reporter = new GateforgeReporter({});
  for (const row of testRows) {
    const result = { status: row.status ?? 'passed' };
    const test = {
      id: row.id,
      annotations: row.annotations,
      location: row.location,
    };
    reporter.onTestEnd(test as never, result as never);
  }
	return reporter.onEnd();
}

describe('reporter artifacts (claims.json / records.json)', () => {
  it('writes claims from annotations and records ONLY from the witness ledger (GF-23)', async () => {
    saveEnv('GATEFORGE_WITNESS_URL', 'GATEFORGE_RUN_TOKEN', 'GATEFORGE_STATE_DIR', 'GATEFORGE_OBLIGATIONS');
    const run = await setupRun();
    try {
      process.env.GATEFORGE_WITNESS_URL = run.witness.url;
      process.env.GATEFORGE_RUN_TOKEN = TOKEN;
      process.env.GATEFORGE_STATE_DIR = run.stateDir;
      process.env.GATEFORGE_OBLIGATIONS = join(run.project, '.gateforge/test-gates/obligations.json');
      const client = new WitnessClient(run.witness.url, TOKEN);
      await postHonestCreate(client);

      // Adversarial: try to plant a fabricated consistent bundle in the
      // state dir BEFORE the reporter writes (the reporter must
      // OVERWRITE records.json with the witness ledger only).
      const fabricated = [
        {
          schemaVersion: 1,
          recordId: 'fabricated'.padEnd(64, '0'),
          runId: RUN_ID,
          trust: 'witnessed',
          obligationId: CREATE,
          kind: 'ui.action',
          testId: TEST_ID,
          payload: { operation: 'create', entityId: 'acc-1', fields: { first_name: 'Ada' } },
        },
      ];
      writeFileSync(join(run.stateDir, 'records.json'), `${JSON.stringify(fabricated)}\n`);

      await runReporter(run.stateDir, [
        {
          id: TEST_ID,
          annotations: [{ type: 'gateforge', description: CREATE }],
          location: { file: 'spec.js', line: 1, column: 4 },
        },
      ]);

      const claims = JSON.parse(readFileSync(join(run.stateDir, 'claims.json'), 'utf8')) as Array<{
        obligationId: string;
        testId: string;
      }>;
      expect(claims).toEqual([
        { schemaVersion: 1, obligationId: CREATE, testId: TEST_ID, testFile: 'spec.js', location: { file: 'spec.js', line: 1, col: 4 } },
      ]);

      const records = JSON.parse(readFileSync(join(run.stateDir, 'records.json'), 'utf8')) as Array<{
        recordId: string;
        kind: string;
      }>;
      expect(records.length).toBeGreaterThan(0);
      expect(records.some((record) => record.recordId === 'fabricated'.padEnd(64, '0'))).toBe(false);
      expect(records.every((record) => /^[0-9a-f]{64}$/.test(record.recordId))).toBe(true);
      const ledger = JSON.parse(readFileSync(join(run.stateDir, 'ledger.json'), 'utf8')) as Array<{
        verdict: string;
      }>;
      expect(ledger).toHaveLength(1);
      expect(ledger[0]?.verdict).toBe('satisfied');
    } finally {
      await run.witness.stop();
      await run.target.stop();
    }
  });
});

describe('GF-23: fabricated bundles never satisfy', () => {
  it('engine verdict: a consistent bundle LACKING service-issued recordIds is invalid/missing', async () => {
    const run = await setupRun();
    try {
      // The fabricated bundle has NO service-issued provenance (either
      // no recordId at all or non-hex ids — demoted to claimed by the
      // engine's GF-23 rule).
      const fabricated = [
        {
          schemaVersion: 1,
          recordId: 'made-up-id-not-issued-by-the-witness',
          runId: RUN_ID,
          trust: 'witnessed',
          obligationId: UPDATE,
          kind: 'ui.action',
          testId: 'attack-test',
          payload: { operation: 'update', entityId: 'acc-1', fields: { first_name: 'Mallory' } },
        },
        {
          schemaVersion: 1,
          trust: 'witnessed',
          obligationId: UPDATE,
          kind: 'persistence.entity',
          testId: 'attack-test',
          payload: { resourceId: 'tenant.accounts', entityId: 'acc-1', fields: { first_name: 'Mallory', status: 'active' } },
        },
      ];
      saveEnv('GATEFORGE_WITNESS_URL', 'GATEFORGE_RUN_TOKEN', 'GATEFORGE_STATE_DIR', 'GATEFORGE_OBLIGATIONS');
      process.env.GATEFORGE_WITNESS_URL = run.witness.url;
      process.env.GATEFORGE_RUN_TOKEN = TOKEN;
      process.env.GATEFORGE_STATE_DIR = run.stateDir;
      process.env.GATEFORGE_OBLIGATIONS = join(run.project, '.gateforge/test-gates/obligations.json');
      writeFileSync(join(run.stateDir, 'records.json'), `${JSON.stringify(fabricated)}\n`);
      await runReporter(run.stateDir, [
        {
          id: 'attack-test',
          annotations: [{ type: 'gateforge', description: UPDATE }],
          location: { file: 'attack.spec.js', line: 1, column: 0 },
        },
      ]);
      const ledger = JSON.parse(readFileSync(join(run.stateDir, 'ledger.json'), 'utf8')) as Array<{
        verdict: string;
        reason: string | null;
      }>;
      expect(ledger).toHaveLength(1);
      expect(ledger[0]?.verdict).not.toBe('satisfied');
      expect(['invalid', 'missing']).toContain(ledger[0]?.verdict);
      expect(ledger[0]?.reason ?? '').toMatch(/claimed|provenance|service-witnessed/i);
    } finally {
      await run.witness.stop();
      await run.target.stop();
    }
  });

  it('a bundle with no recordId at all cannot satisfy either (GF-23)', async () => {
    const run = await setupRun();
    try {
      saveEnv('GATEFORGE_WITNESS_URL', 'GATEFORGE_RUN_TOKEN', 'GATEFORGE_STATE_DIR', 'GATEFORGE_OBLIGATIONS');
      process.env.GATEFORGE_WITNESS_URL = run.witness.url;
      process.env.GATEFORGE_RUN_TOKEN = TOKEN;
      process.env.GATEFORGE_STATE_DIR = run.stateDir;
      process.env.GATEFORGE_OBLIGATIONS = join(run.project, '.gateforge/test-gates/obligations.json');
      writeFileSync(
        join(run.stateDir, 'records.json'),
        `${JSON.stringify([
          {
            schemaVersion: 1,
            trust: 'witnessed',
            obligationId: UPDATE,
            kind: 'ui.action',
            testId: 'attack-2',
            payload: { operation: 'update', entityId: 'acc-1', fields: {} },
          },
        ])}\n`,
      );
      await runReporter(run.stateDir, [
        {
          id: 'attack-2',
          annotations: [{ type: 'gateforge', description: UPDATE }],
        },
      ]);
      const ledger = JSON.parse(readFileSync(join(run.stateDir, 'ledger.json'), 'utf8')) as Array<{
        verdict: string;
      }>;
      expect(ledger[0]?.verdict).not.toBe('satisfied');
    } finally {
      await run.witness.stop();
      await run.target.stop();
    }
  });
});

describe('GF-24 registry mismatch', () => {
  it('flags obligations that nobody claimed (claim registry vs records)', async () => {
    const run = await setupRun();
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (message: unknown) => {
      warnings.push(String(message));
    };
    try {
      saveEnv('GATEFORGE_WITNESS_URL', 'GATEFORGE_RUN_TOKEN', 'GATEFORGE_STATE_DIR', 'GATEFORGE_OBLIGATIONS');
      process.env.GATEFORGE_WITNESS_URL = run.witness.url;
      process.env.GATEFORGE_RUN_TOKEN = TOKEN;
      process.env.GATEFORGE_STATE_DIR = run.stateDir;
      process.env.GATEFORGE_OBLIGATIONS = join(run.project, '.gateforge/test-gates/obligations.json');
      // The run obligations include crud:create + crud:update; the suite
      // only claims crud:update → crud:create is unclaimed.
      await runReporter(run.stateDir, [
        {
          id: 'other-test',
          annotations: [{ type: 'gateforge', description: UPDATE }],
        },
      ]);
      expect(warnings.join('\n')).toMatch(/obligations without any claim/);
      expect(warnings.join('\n')).toContain(CREATE);
    } finally {
      console.warn = originalWarn;
      await run.witness.stop();
      await run.target.stop();
    }
  });

  it('flags witness records that no claim references (orphans)', async () => {
    const run = await setupRun();
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (message: unknown) => {
      warnings.push(String(message));
    };
    try {
      const client = new WitnessClient(run.witness.url, TOKEN);
      // A record submitted under a test that declares NO gateforge claim.
      await client.postRecords({
        claimId: UPDATE,
        kind: 'ui.action',
        payload: { operation: 'update', entityId: 'acc-1', fields: {} },
        testId: 'bypass-test-no-claim',
      });
      saveEnv('GATEFORGE_WITNESS_URL', 'GATEFORGE_RUN_TOKEN', 'GATEFORGE_STATE_DIR', 'GATEFORGE_OBLIGATIONS');
      process.env.GATEFORGE_WITNESS_URL = run.witness.url;
      process.env.GATEFORGE_RUN_TOKEN = TOKEN;
      process.env.GATEFORGE_STATE_DIR = run.stateDir;
      process.env.GATEFORGE_OBLIGATIONS = join(run.project, '.gateforge/test-gates/obligations.json');
      await runReporter(run.stateDir, [
        {
          id: 'some-other-test',
          annotations: [{ type: 'gateforge', description: CREATE }],
        },
      ]);
      expect(warnings.join('\n')).toMatch(/no matching claim/);
      expect(warnings.join('\n')).toContain('bypass-test-no-claim');
    } finally {
      console.warn = originalWarn;
      await run.witness.stop();
      await run.target.stop();
    }
  });
});

describe('reporter ledger grading', () => {
  it('grades an honest satisfied claim via the real engine', async () => {
    const run = await setupRun();
    try {
      saveEnv('GATEFORGE_WITNESS_URL', 'GATEFORGE_RUN_TOKEN', 'GATEFORGE_STATE_DIR', 'GATEFORGE_OBLIGATIONS');
      process.env.GATEFORGE_WITNESS_URL = run.witness.url;
      process.env.GATEFORGE_RUN_TOKEN = TOKEN;
      process.env.GATEFORGE_STATE_DIR = run.stateDir;
      process.env.GATEFORGE_OBLIGATIONS = join(run.project, '.gateforge/test-gates/obligations.json');
      const client = new WitnessClient(run.witness.url, TOKEN);
      await postHonestCreate(client);
      await runReporter(run.stateDir, [
        {
          id: TEST_ID,
          annotations: [{ type: 'gateforge', description: CREATE }],
        },
      ]);
      const ledger = JSON.parse(readFileSync(join(run.stateDir, 'ledger.json'), 'utf8')) as Array<{
        verdict: string;
        trustTier: string;
        recordIds: string[];
      }>;
      expect(ledger[0]?.verdict).toBe('satisfied');
      expect(ledger[0]?.trustTier).toBe('witnessed');
      expect(ledger[0]?.recordIds.length).toBeGreaterThanOrEqual(2);
    } finally {
      await run.witness.stop();
      await run.target.stop();
    }
});
})
