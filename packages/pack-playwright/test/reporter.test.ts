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
import { createServer } from 'node:http';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { recordIdOf } from '@gate-forge/core';
import { gateSummaryLine, GateforgeReporter } from '../src/reporter/reporter.js';
import { ledgerRowFor, type LedgerRow } from '../src/reporter/ledger.js';
import { startWitness } from '../src/witness/server.js';
import { startMarkerServer } from './marker-server.js';
import {
  makeTempProject,
  writeFixtureProject,
  writeHonestAdapter,
  openSupervisorSession,
  beginJourneyInterval,
  endJourneyInterval,
  FINGERPRINT,
  type SupervisorSession,
} from './helpers.js';
import { WitnessClient } from '../src/fixture/witness-client.js';

const RUN_ID = '6f1c3f90-2d5e-4b1a-9c6d-0f0e2b8a1c9d';
const TOKEN = 'reporter-token';
// The supervisor capability (enforcement-review fix 3): session open/close
// is verifier-key authenticated; tests acting as the supervisor present it.
const VERIFIER_KEY = 'reporter-verifier-secret';
const CREATE = 'tenant.accounts:persistence:create';
const UPDATE = 'tenant.accounts:persistence:update';
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
            contract: 'persistence:create',
            policyId: 'crud',
            lifecycle: { create: true, read: true, update: true, delete: true, deleteSemantics: 'archive', archiveFields: { status: 'archived' } },
            fingerprint: 'f-create',
            source: 'src/accounts.js',
            location: { file: 'src/accounts.js', line: 1, col: 0 },
          },
          {
            id: UPDATE,
            resourceId: 'tenant.accounts',
            contract: 'persistence:update',
            policyId: 'crud',
            lifecycle: { create: true, read: true, update: true, delete: true, deleteSemantics: 'archive', archiveFields: { status: 'archived' } },
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
    verifierKey: VERIFIER_KEY,
    stateDir,
    adaptersDir: join(project, '.gateforge/adapters'),
    classificationsPath: join(project, '.gateforge/effective-classifications.yml'),
    targetBaseUrl: target.url,
    targetFingerprint: FINGERPRINT,
    adapterBaseUrl: target.url,
    now: () => '2026-08-30T12:00:01.000Z',
  });
  return { project, target, witness, stateDir };
}

/**
 * Posts one honest create flow's records through the real witness:
 * engine-side pre-observation (entity absent), the app-side create, then
 * the UI-action/visible assertions and the persistence verify bound to
 * the pre-observation (create postcondition, audit round 4). Phase 1:
 * every submission carries the supervisor-opened session credential.
 */
async function postHonestCreate(client: WitnessClient, appBase: string, session: SupervisorSession): Promise<string> {
  const channel = { sessionId: session.sessionId, sessionToken: session.sessionToken };
  // 1. Engine-side "before": the marker target's observed id set.
  const pre = await client.preObserve({
    resourceId: 'tenant.accounts',
    testId: TEST_ID,
    claimId: CREATE,
    ...channel,
  });
  // 2. The app-side effect of the UI create (mints the entity).
  const created = (await (
    await fetch(`${appBase}/api/accounts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ first_name: 'Ada', last_name: 'Lovelace' }),
    })
  ).json()) as { id: string; status: string };
  const entityId = created.id;
  // 3. The suite-asserted UI action + visible result (claimed tier).
  await client.postRecords({
    claimId: CREATE,
    kind: 'ui.action',
    payload: { operation: 'create', entityId, fields: { first_name: 'Ada', last_name: 'Lovelace' } },
    testId: TEST_ID,
    ...channel,
  });
  await client.postRecords({
    claimId: CREATE,
    kind: 'ui.visible-result',
    payload: {
      entityId,
      fields: { first_name: 'Ada', last_name: 'Lovelace', status: created.status },
    },
    testId: TEST_ID,
    ...channel,
  });
  // 4. Engine-observed persistence, bound to the pre-observation.
  await client.verifyPersistence({
    resourceId: 'tenant.accounts',
    entityId,
    testId: TEST_ID,
    claimId: CREATE,
    ...channel,
    preObservationId: pre.observationId,
  });
  return entityId;
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
      const session = await openSupervisorSession(run.witness.url, TOKEN, TEST_ID, 0, VERIFIER_KEY);
      await postHonestCreate(client, run.target.url, session);

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
  const CLASSIFICATION = {
    exposure: 'user-facing' as const,
    plane: 'tenant' as const,
    lifecycle: {
      create: true,
      read: true,
      update: true,
      delete: true,
      deleteSemantics: 'archive' as const,
      archiveFields: { status: 'archived' },
    },
    primaryKey: ['id'],
    evidenceAdapter: 'accounts',
  };
  const obligationsDoc = {
    schemaVersion: 1,
    obligations: [
      {
        id: UPDATE,
        resourceId: 'tenant.accounts',
        contract: 'persistence:update',
        policyId: 'crud',
        lifecycle: CLASSIFICATION.lifecycle,
        fingerprint: 'f-update',
        source: 'src/accounts.js',
        location: null,
      },
    ],
  };

  /** The internally-consistent bundle a hostile test process fabricates. */
  function fabricatedBundle(): unknown[] {
    return [
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
  }

  it('reporter path: a fabricated records.json is overwritten by the witness ledger, never graded', async () => {
    const run = await setupRun();
    try {
      saveEnv('GATEFORGE_WITNESS_URL', 'GATEFORGE_RUN_TOKEN', 'GATEFORGE_STATE_DIR', 'GATEFORGE_OBLIGATIONS');
      process.env.GATEFORGE_WITNESS_URL = run.witness.url;
      process.env.GATEFORGE_RUN_TOKEN = TOKEN;
      process.env.GATEFORGE_STATE_DIR = run.stateDir;
      process.env.GATEFORGE_OBLIGATIONS = join(run.project, '.gateforge/test-gates/obligations.json');
      // The witness ledger is EMPTY: the attacker plants their bundle in
      // records.json before the reporter runs. The reporter must replace
      // it with GET /records verbatim (GF-23), so the fabrication never
      // reaches the engine and the claim grades `missing`.
      writeFileSync(join(run.stateDir, 'records.json'), `${JSON.stringify(fabricatedBundle())}\n`);
      await runReporter(run.stateDir, [
        {
          id: 'attack-test',
          annotations: [{ type: 'gateforge', description: UPDATE }],
          location: { file: 'attack.spec.js', line: 1, column: 0 },
        },
      ]);
      const records = JSON.parse(readFileSync(join(run.stateDir, 'records.json'), 'utf8')) as Array<{
        recordId: string;
      }>;
      expect(
        records.some((record) => record.recordId === 'made-up-id-not-issued-by-the-witness'),
      ).toBe(false);
      const ledger = JSON.parse(readFileSync(join(run.stateDir, 'ledger.json'), 'utf8')) as Array<{
        verdict: string;
        reason: string | null;
      }>;
      expect(ledger).toHaveLength(1);
      expect(ledger[0]?.verdict).toBe('missing');
      expect(ledger[0]?.reason ?? '').toContain('no evidence records');
    } finally {
      await run.witness.stop();
      await run.target.stop();
    }
  });

  it('engine verdict: a consistent bundle LACKING service-issued recordIds is claimed-tier → invalid', () => {
    // Fed DIRECTLY to the engine (bypassing the reporter's ledger copy):
    // fabricated ids are not service-issued, so the records demote to
    // claimed-tier, which can never satisfy (GF-23).
    const row = ledgerRowFor(
      { obligationId: UPDATE, testId: 'attack-test', testFile: 'attack.spec.js', location: null },
      obligationsDoc,
      { 'tenant.accounts': CLASSIFICATION },
      fabricatedBundle() as never,
      '2026-08-30T12:00:02.000Z',
    );
    expect(row.verdict).toBe('invalid');
    expect(row.trustTier).toBe('claimed');
    expect(row.reason ?? '').toMatch(/claimed|provenance|service-witnessed/i);
  });

  it('engine verdict: a bundle with no recordId at all cannot satisfy either (GF-23)', () => {
    const row = ledgerRowFor(
      { obligationId: UPDATE, testId: 'attack-2', testFile: 'attack.spec.js', location: null },
      obligationsDoc,
      { 'tenant.accounts': CLASSIFICATION },
      [
        {
          schemaVersion: 1,
          trust: 'witnessed',
          obligationId: UPDATE,
          kind: 'ui.action',
          testId: 'attack-2',
          payload: { operation: 'update', entityId: 'acc-1', fields: {} },
        },
      ] as never,
      '2026-08-30T12:00:02.000Z',
    );
    expect(row.verdict).toBe('invalid');
    expect(row.trustTier).toBe('claimed');
    expect(row.verdict).not.toBe('satisfied');
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
      const session = await openSupervisorSession(run.witness.url, TOKEN, 'bypass-test-no-claim', 0, VERIFIER_KEY);
      await client.postRecords({
        claimId: UPDATE,
        kind: 'ui.action',
        payload: { operation: 'update', entityId: 'acc-1', fields: {} },
        testId: 'bypass-test-no-claim',
        sessionId: session.sessionId,
        sessionToken: session.sessionToken,
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
      const session = await openSupervisorSession(run.witness.url, TOKEN, TEST_ID, 0, VERIFIER_KEY);
      await postHonestCreate(client, run.target.url, session);
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

  it('a claims-lane (evidenceLane: claims) resource grades satisfied, never unclassified', async () => {
    // The phase-7 witnessed-run blocker: an http.endpoint resource is
    // user-facing WITHOUT an adapter. The witness classification view
    // used to drop `evidenceLane`, so the reporter-side engine
    // re-validation failed ("user-facing resources require an
    // 'evidenceAdapter'") and the claim graded unclassified. The full
    // real path must now round-trip: witness view → reporter fetch →
    // engine classification → witnessed http observation satisfies the
    // explicit transport contract (plan §8 / D1: the frontend contract
    // stays blocking missing on the same ledger).
    const HTTP_CLAIM = 'tenant.http-frontend-errors:http:request-observed';
    const FRONTEND_CLAIM = 'tenant.http-frontend-errors:http:frontend-request-observed';
    const project = makeTempProject('reporter-lane');
    const stateDir = join(project, 'state');
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(
      join(project, '.gateforge/test-gates/obligations.json'),
      `${JSON.stringify({
        schemaVersion: 1,
        obligations: [
          {
            id: HTTP_CLAIM,
            resourceId: 'tenant.http-frontend-errors',
            contract: 'http:request-observed',
            policyId: 'crud',
            lifecycle: { create: false, read: false, update: false, delete: false },
            fingerprint: 'f-http',
            source: 'src/http.ts',
            location: { file: 'src/http.ts', line: 1, col: 0 },
          },
        ],
      })}\n`,
    );
    writeFileSync(
      join(stateDir, 'manifest.json'),
      `${JSON.stringify({ schemaVersion: 1, runId: RUN_ID, startedAt: '2026-08-30T12:00:00.000Z' })}\n`,
    );
    // Advisory route inventory (plan §9, D2): the CLI-derived
    // `http-routes.json` the reporter threads into its advisory rows.
    // The authoritative CLI recomputes this from source.
    writeFileSync(
      join(stateDir, 'http-routes.json'),
      `${JSON.stringify({
        schemaVersion: 1,
        routes: [
          {
            resourceId: 'tenant.http-frontend-errors',
            method: 'POST',
            canonicalPath: '/ops/frontend-errors',
          },
        ],
      })}\n`,
    );
    // Claims-lane classification: user-facing, NO evidenceAdapter.
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
    /** Minimal loopback target: every POST answers 201 (observed path echoed). */
    const target = await new Promise<{ url: string; stop: () => Promise<void> }>((resolve) => {
      const server = createServer((req, res) => {
        res.writeHead(201, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, path: req.url }));
      });
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        if (address === null || typeof address === 'string') throw new Error('no target port');
        resolve({
          url: `http://127.0.0.1:${address.port}`,
          stop: async () => {
            await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
          },
        });
      });
    });
    const witness = await startWitness({
      runId: RUN_ID,
      token: TOKEN,
      verifierKey: VERIFIER_KEY,
      stateDir,
      classificationsPath: join(project, '.gateforge/claims-classifications.yml'),
      proxyTarget: target.url,
      now: () => '2026-08-30T12:00:01.000Z',
    });
    try {
      saveEnv('GATEFORGE_WITNESS_URL', 'GATEFORGE_RUN_TOKEN', 'GATEFORGE_STATE_DIR', 'GATEFORGE_OBLIGATIONS');
      process.env.GATEFORGE_WITNESS_URL = witness.url;
      process.env.GATEFORGE_RUN_TOKEN = TOKEN;
      process.env.GATEFORGE_STATE_DIR = stateDir;
      process.env.GATEFORGE_OBLIGATIONS = join(project, '.gateforge/test-gates/obligations.json');

      // Real proxied traffic (a witness-observed HTTP exchange)… — under
      // the supervisor-opened session, through its observation channel,
      // inside a recorded action interval (Phase 1).
      const session = await openSupervisorSession(witness.url, TOKEN, TEST_ID, 0, VERIFIER_KEY);
      expect(session.proxyUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      const intervalId = await beginJourneyInterval(witness.url, TOKEN, session, 'create');
      const forward = await fetch(`${session.proxyUrl as string}/ops/frontend-errors`, {
        method: 'POST',
      });
      expect(forward.status).toBe(201);
      // …consumed once as a witnessed http.request record…
      const client = new WitnessClient(witness.url, TOKEN);
      await client.observeHttp({
        obligationId: HTTP_CLAIM,
        testId: TEST_ID,
        claimId: HTTP_CLAIM,
        method: 'POST',
        path: '/ops/frontend-errors',
        sessionId: session.sessionId,
        sessionToken: session.sessionToken,
      });
      await endJourneyInterval(witness.url, TOKEN, session, intervalId);
      // …plus the provenanced claimed ui.action anchor.
      await client.postRecords({
        claimId: HTTP_CLAIM,
        kind: 'ui.action',
        payload: { operation: 'create', entityId: 'frontend-error-1', fields: {} },
        testId: TEST_ID,
        sessionId: session.sessionId,
        sessionToken: session.sessionToken,
      });

      await runReporter(stateDir, [
        {
          id: TEST_ID,
          annotations: [{ type: 'gateforge', description: HTTP_CLAIM }],
        },
      ]);
      const ledger = JSON.parse(readFileSync(join(stateDir, 'ledger.json'), 'utf8')) as Array<{
        verdict: string;
        reason: string | null;
        trustTier: string;
      }>;
      expect(ledger).toHaveLength(1);
      expect(ledger[0]?.verdict).not.toBe('unclassified');
      expect(ledger[0]?.reason ?? '').not.toContain('evidenceAdapter');
      expect(ledger[0]?.verdict).toBe('satisfied');
      expect(ledger[0]?.trustTier).toBe('witnessed');
      expect(JSON.stringify(ledger)).not.toMatch(/browser verified/i);

      // The same ledger through the frontend contract stays blocking
      // missing (plan §8 / D1): grade the identical records against a
      // frontend obligation via the real engine.
      const frontendDoc = {
        schemaVersion: 1,
        obligations: [
          {
            id: FRONTEND_CLAIM,
            resourceId: 'tenant.http-frontend-errors',
            contract: 'http:frontend-request-observed',
            policyId: 'crud',
            lifecycle: { create: false, read: false, update: false, delete: false },
            fingerprint: 'f-http',
            source: 'src/http.ts',
            location: { file: 'src/http.ts', line: 1, col: 0 },
          },
        ],
      };
      const frontendRow = ledgerRowFor(
        { obligationId: FRONTEND_CLAIM, testId: TEST_ID, testFile: 'spec.js', location: null },
        frontendDoc,
        {
          'tenant.http-frontend-errors': {
            exposure: 'user-facing',
            plane: 'tenant',
            lifecycle: { create: false, read: false, update: false, delete: false },
            primaryKey: ['method', 'path'],
            evidenceLane: 'claims',
          },
        },
        [],
        '2026-08-30T12:00:02.000Z',
      );
      expect(frontendRow.verdict).toBe('missing');
      expect(frontendRow.reason ?? '').toContain('no independent browser/test observation channel');
      expect(frontendRow.reason ?? '').not.toMatch(/browser verified/i);
    } finally {
      await witness.stop();
      await target.stop();
    }
  });

  it('F4: an HTTP row without route context blocks missing — never an advisory pass', async () => {
    // The reporter is advisory and suite-writable (plan §9): when the
    // CLI-derived `http-routes.json` is absent it must surface the
    // core missing-context block, never display an authoritative pass
    // merely because it lacked the inventory.
    const HTTP_CLAIM = 'tenant.http-frontend-errors:http:request-observed';
    const doc = {
      schemaVersion: 1,
      obligations: [
        {
          id: HTTP_CLAIM,
          resourceId: 'tenant.http-frontend-errors',
          contract: 'http:request-observed',
          policyId: 'crud',
          lifecycle: { create: false, read: false, update: false, delete: false },
          fingerprint: 'f-http',
          source: 'src/http.ts',
          location: null,
        },
      ],
    };
    // A provenanced claimed anchor (so grading reaches the route
    // stage) plus a witnessed exchange-shaped record — still no
    // advisory pass without the inventory.
    const anchorPayload = { operation: 'create', entityId: 'frontend-error-1', fields: {} };
    const exchangePayload = { method: 'POST', url: '/ops/frontend-errors', status: 201 };
    const issued = (
      kind: string,
      origin: 'engine-observed' | 'suite-submitted',
      trust: string,
      payload: Record<string, unknown>,
    ): Record<string, unknown> => ({
      schemaVersion: 1,
      runId: RUN_ID,
      trust,
      obligationId: HTTP_CLAIM,
      testId: TEST_ID,
      kind,
      origin,
      payload,
      recordId: recordIdOf({
        runId: RUN_ID,
        obligationId: HTTP_CLAIM,
        kind,
        testId: TEST_ID,
        origin,
        payload,
      }),
    });
    const anchor = issued('ui.action', 'suite-submitted', 'claimed', anchorPayload);
    const exchange = issued('http.request', 'engine-observed', 'witnessed', exchangePayload);
    const row = ledgerRowFor(
      { obligationId: HTTP_CLAIM, testId: TEST_ID, testFile: 'spec.js', location: null },
      doc,
      {
        'tenant.http-frontend-errors': {
          exposure: 'user-facing',
          plane: 'tenant',
          lifecycle: { create: false, read: false, update: false, delete: false },
          primaryKey: ['method', 'path'],
          evidenceLane: 'claims',
        },
      },
      [anchor, exchange] as never,
      '2026-08-30T12:00:02.000Z',
    );
    expect(row.verdict).toBe('missing');
    expect(row.verdict).not.toBe('satisfied');
    expect(row.reason ?? '').toContain('no route inventory context');
  });
});

describe('aggregate honesty (plan Phase 4 item 7): the reporter is never the final gate', () => {
  const row = (verdict: LedgerRow['verdict']): LedgerRow => ({
    claim: CREATE,
    testId: TEST_ID,
    testFile: 'e2e/accounts.spec.ts',
    verdict,
    reason: null,
    recordIds: [],
    trustTier: 'witnessed',
  });

  it('satisfied claimed rows with UNCLAIMED obligations print NOT PASSED, never PASS', () => {
    const line = gateSummaryLine([row('satisfied')], 1);
    expect(line).toMatch(/GATEFORGE GATE: NOT PASSED/);
    expect(line).toMatch(/1 unclaimed obligation\(s\) still block/);
    expect(line).not.toMatch(/GATEFORGE GATE: PASS/);
  });

  it('every summary line names the CLI as the only final gate result', () => {
    for (const line of [
      gateSummaryLine([row('satisfied')], 0),
      gateSummaryLine([row('satisfied')], 2),
      gateSummaryLine([row('missing')], 0),
      gateSummaryLine([], 0),
      gateSummaryLine([], 3),
    ]) {
      expect(line).toMatch(/final gate result: the gateforge CLI \(test-gates\/check\), never this reporter/);
    }
  });

  it('a blocking claimed row prints FAIL even when unclaimed obligations exist', () => {
    const line = gateSummaryLine([row('missing')], 2);
    expect(line).toMatch(/GATEFORGE GATE: FAIL/);
    expect(line).not.toMatch(/PASS \(|NOT PASSED/);
  });

  it('zero claims with zero unclaimed prints NO CLAIMS (no silent all-clear)', () => {
    expect(gateSummaryLine([], 0)).toMatch(/GATEFORGE GATE: NO CLAIMS/);
  });

  it('fully claimed + satisfied + zero unclaimed is the only PASS — still CLI-authority-scoped', () => {
    const line = gateSummaryLine([row('satisfied'), row('satisfied')], 0);
    expect(line).toMatch(/GATEFORGE GATE: PASS \(2\/2 claimed obligations satisfied/);
    expect(line).toMatch(/never this reporter/);
  });
});
