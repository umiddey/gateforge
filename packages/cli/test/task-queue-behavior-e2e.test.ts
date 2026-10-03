/**
 * Engine-level end-to-end proof for the `task` namespace: the real
 * CLI over a real fixture
 * repository, a REAL BullMQ application (queue + worker processes over
 * a real Redis), the witness `test-gates` spawns itself, and post-suite
 * verdict evaluation through `check --require-e2e`.
 *
 * The point of this suite is the engine's own read. A task contract
 * (retry bound, idempotency, terminal outcome) is a claim about a
 * background job, so every case here is graded from the queue state the
 * WITNESS read — the engine produces the delivery itself, stamps the
 * attempt bound, and samples the transitions until every job settles.
 * A test body only names one approved case id; it cannot assert its own
 * way to a green gate.
 *
 * Three contracts, three fail variants, one application each:
 *   - retry-policy-enforced — a flaky delivery fails twice and completes
 *     on the third attempt (the declared bound), never exceeding it;
 *   - duplicate-delivery-handled — two engine deliveries of ONE
 *     idempotency key leave exactly ONE side effect in the engine-read
 *     outbox scope;
 *   - terminal-handled — a worker lost mid-job is reclaimed by the
 *     queue (active → non-terminal, unchanged attempts) and the
 *     delivery still ends terminally.
 *
 * The fail variants run the SAME fixture with one documented defect:
 * a worker that never recovers, an application that repeats side
 * effects, and a supervisor that never replaces the lost worker. Each
 * must be blocked, and the blocked reason must come from the engine's
 * read — never from the test's word.
 *
 * The suite skips unless GATEFORGE_TEST_REDIS_URL names a real Redis
 * (a `redis:7-alpine` container is enough): the engine's queue reader
 * needs a live queue, and a fake one would be a mock as proof.
 */
import { createServer, type Server } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { sha256Canonical, withTempRepo, type TempRepo } from '@gate-forge/core';
import { trustedPolicyDigestForConfig } from '../src/execution.js';
import { loadConfigAt, VERIFIER_KEY_FILE_ENV } from '../src/commands/common.js';
import { runCli } from './helpers.js';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const FINGERPRINT = 'example-task-bullmq-v1';
/** The detector-emitted task resource the three contracts sit on. */
const TASK_RESOURCE = 'global.email-send';
/** The outbox scope the reviewed adapter witnesses. */
const OUTBOX = 'global.outbox';
/** A discovered health route: the catalog bind requires one endpoint. */
const HEALTH = 'global.http-get-health';
/** The engine's delivery identity prefix per case (one row per key). */
const FLAKY_KEY = 'welcome-flaky';
const DUPLICATE_KEY = 'welcome-duplicate';
const STALL_KEY = 'welcome-stall';

const REDIS_URL = process.env['GATEFORGE_TEST_REDIS_URL'] ?? '';

const tempDirectories: string[] = [];

/**
 * A deliberately inert subject origin: a delivery case drives no HTTP at
 * all, but the Playwright harness still needs an attested app base to
 * route through. This server answers nothing interesting and is never
 * asked for the proof.
 *
 * Returns:
 *   Promise<{url, stop}>: the loopback origin and its stop.
 */
async function startStubApp(): Promise<{ url: string; stop: () => Promise<void> }> {
  const server: Server = createServer((_req, res) => {
    res.writeHead(204).end();
  });
  await new Promise<void>((resolveListen) =>
    server.listen(0, ['127', '0', '0', '1'].join('.'), resolveListen),
  );
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no stub app port');
  return {
    url: `http://${['127', '0', '0', '1'].join('.')}:${String(address.port)}`,
    stop: async () => {
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    },
  };
}

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const taskQueueApp = (await import(pathToFileURL(join(ROOT, 'example/task-bullmq/app.js')).href)) as {
  startTaskQueueApp: (options: {
    connection: { url: string };
    scopeFile: string;
    breakRetry?: boolean;
    breakIdempotency?: boolean;
    restartWorker?: boolean;
  }) => Promise<{ queueName: string; stop: () => Promise<void> }>;
};

function gateforgeYml(queueName: string): string {
  return `schemaVersion: 1
project:
  languages: [javascript]
  paths:
    include: ['src/**', 'specs/**']
    exclude: []
plugins:
  - id: gateforge.task-fixture
    version: 1.0.0
    transport: in-process
    module: ./.gateforge/fixture-detector.mjs
policies: .gateforge/policies.yml
classificationPolicy: .gateforge/classification-policy.yml
adapters: .gateforge/adapters
waivers: .gateforge/waivers
baselines: .gateforge/baselines/obligations.json
behaviorPolicy: .gateforge/behavior.yml
queueObserver:
  kind: bullmq
  connection:
    urlEnv: GATEFORGE_TEST_REDIS_URL
  queues:
    - name: ${queueName}
      taskResourceId: ${TASK_RESOURCE}
  pollIntervalMs: 100
  terminalTimeoutMs: 30000
changed: { provider: auto }
witness: { maxDurationSeconds: 60 }
clock: { mode: fixed, fixedAt: '2026-01-01T00:00:00.000Z' }
`;
}

const POLICIES_YML = `schemaVersion: 1
policies:
  - id: background-task-guarantees
    when:
      kind: task.resource
    require:
      - task:retry-policy-enforced
      - task:duplicate-delivery-handled
      - task:terminal-handled
`;

const CLASSIFICATION_POLICY_YML = `schemaVersion: 1
scanRoots: ['src/**']
trustedInternalEntryPoints: []
internalRules: []
declarations:
  internality: gateforge:internal
volatileFields: []
`;

/** The fixture detector: the task resource plus the outbox it writes. */
const DETECTOR = `const SOURCE = 'src/mailer.js';
const LOCATION = { file: SOURCE, line: 1, col: 0 };
const DETECTOR = { id: 'gateforge.task-fixture', version: '1.0.0' };
const TASK = ${JSON.stringify(TASK_RESOURCE)};
const OUTBOX = ${JSON.stringify(OUTBOX)};
const HEALTH = ${JSON.stringify(HEALTH)};

function signal(resourceName, dimension, assertion) {
  return {
    schemaVersion: 1,
    target: { resourceName },
    dimension,
    assertion,
    basis: 'declaration',
    source: 'gateforge.task-fixture',
    location: LOCATION,
    detector: DETECTOR,
  };
}

export default {
  async discover() {
    return {
      resources: [
        {
          schemaVersion: 1,
          id: HEALTH,
          kind: 'http.endpoint',
          source: SOURCE,
          location: LOCATION,
          detectorVersion: DETECTOR.version,
          attributes: {
            resourceName: 'http-get-health',
            method: 'GET',
            canonicalPath: '/health',
            identity: 'GET /health',
          },
        },
        {
          schemaVersion: 1,
          id: TASK,
          kind: 'task.resource',
          source: SOURCE,
          location: LOCATION,
          detectorVersion: DETECTOR.version,
          attributes: { resourceName: 'email-send', queue: 'mailer' },
        },
        {
          schemaVersion: 1,
          id: OUTBOX,
          kind: 'fixture.entity',
          source: SOURCE,
          location: LOCATION,
          detectorVersion: DETECTOR.version,
          attributes: { resourceName: 'outbox', updateableFields: ['id', 'key'] },
        },
      ],
      unresolved: [],
      findings: [],
      classificationSignals: [
        signal('http-get-health', 'plane', 'global'),
        signal('http-get-health', 'identity', ['method', 'path']),
        signal('email-send', 'plane', 'global'),
        signal('email-send', 'identity', ['id']),
        signal('email-send', 'adapter-binding', OUTBOX),
        signal('email-send', 'lifecycle.create', true),
        signal('email-send', 'lifecycle.read', true),
        signal('email-send', 'lifecycle.update', true),
        signal('email-send', 'lifecycle.delete', false),
        signal('email-send', 'delete-semantics', 'hard'),
        signal('outbox', 'plane', 'global'),
        signal('outbox', 'identity', ['id']),
        signal('outbox', 'adapter-binding', OUTBOX),
        signal('outbox', 'lifecycle.create', true),
        signal('outbox', 'lifecycle.read', true),
        signal('outbox', 'lifecycle.update', true),
        signal('outbox', 'delete-semantics', 'hard'),
      ],
    };
  },
};
`;

/**
 * The reviewed evidence adapter: the SCOPE snapshot the engine compares
 * before/after a case is read from the trusted file the harness mirrors
 * out of the application — the witness deliberately refuses the
 * candidate GET transport there, so a scope can never be the app's own
 * account of itself.
 *
 * Args:
 *   scopeFile: absolute path of the mirrored outbox.
 *
 * Returns:
 *   string: the adapter module source.
 */
function adapterSource(scopeFile: string): string {
  return `import { existsSync, readFileSync } from 'node:fs';
const FINGERPRINT = ${JSON.stringify(FINGERPRINT)};
const SCOPE_FILE = ${JSON.stringify(scopeFile)};

export default {
  async read() {
    throw new Error('the outbox scope is file-mediated; entity reads are not part of this fixture');
  },
  async list() {
    return [];
  },
  normalize(body) {
    return { entityId: body.id, fields: { id: body.id, key: body.key } };
  },
  deletion: 'hard',
  environmentFingerprint: FINGERPRINT,
  async snapshotScope(ctx, input) {
    const stored = existsSync(SCOPE_FILE)
      ? JSON.parse(readFileSync(SCOPE_FILE, 'utf8'))
      : { checkpoint: 'c0', rows: [] };
    // Canonical identity order: the witness refuses an unordered scope.
    const entities = stored.rows
      .map((row) => ({ entityId: row.id, fields: { id: row.id, key: row.key } }))
      .sort((a, b) => (String(a.entityId) < String(b.entityId) ? -1 : 1));
    return {
      scope: input.scope,
      fixtureNamespace: input.fixtureNamespace,
      complete: true,
      checkpoint: stored.checkpoint,
      entities,
      exhausted: true,
    };
  },
};
`;
}

/** One delivery case: engine-produced payload plus its attempts rule. */
function deliveryCase(input: {
  id: string;
  contract: string;
  key: string;
  count: number;
  attempts: Record<string, unknown>;
  payload: Record<string, unknown>;
}): string {
  return `      - id: ${input.id}
        contract: ${input.contract}
        channel: engine-task
        fixture: mail-outbox
        actor: system
        action:
          kind: deliver
          resourceId: ${TASK_RESOURCE}
          payload:
            from: literal
            value:
${Object.entries(input.payload)
  .map(([key, value]) => `              ${key}: ${JSON.stringify(value)}`)
  .join('\n')}
          idempotencyKey:
            from: literal
            value: ${input.key}
          deliveryId:
            from: literal
            value: ${input.key}
          count: ${String(input.count)}
          schedule: serial
        expect:
          statuses: []
          response: []
          state:
            - kind: attempts
              resourceId: ${TASK_RESOURCE}
${Object.entries(input.attempts)
  .map(([key, value]) => `              ${key}: ${String(value)}`)
  .join('\n')}
            - kind: created
              scope: outbox
              rows:
                - fields:
                    id:
                      from: fixture
                      key: expectedRowId
`;
}

/**
 * The owner-declared behavior document: three engine-task deliveries on
 * the one task resource. The outbox row each case expects is resolved
 * from the fixture provider's generated identity, so the case never
 * hard-codes a row id it did not mint.
 *
 * Returns:
 *   string: the `.gateforge/behavior.yml` source.
 */
function behaviorYml(): string {
  return `schemaVersion: 1
endpoints:
  - resourceId: ${HEALTH}
    # The health route is discovered only so the catalog bind has one
    # endpoint to attribute against; it carries no behavioral guarantee.
    effects: []
    cases: []
    disposition:
      kind: out-of-scope
      reason: a liveness probe carries no owner-promised behavior; it is declared only so the catalog bind has an endpoint binding
resources:
  - resourceId: ${TASK_RESOURCE}
    effects:
      - id: outbox
        resourceId: ${OUTBOX}
        adapter: email-send
        scope: outbox
        identityFields: [id]
        fields: [id, key]
        completion: immediate
    cases:
${deliveryCase({
  id: 'flaky-delivery',
  contract: 'task:retry-policy-enforced',
  key: FLAKY_KEY,
  count: 1,
  attempts: { count: 3, terminal: "'succeeded'", minAttempts: 3 },
  payload: { scenario: 'flaky', succeedOn: 3 },
})}${deliveryCase({
  id: 'duplicate-delivery',
  contract: 'task:duplicate-delivery-handled',
  key: DUPLICATE_KEY,
  count: 2,
  attempts: { count: 3, terminal: "'succeeded'" },
  payload: { scenario: 'idempotent' },
})}${deliveryCase({
  id: 'stalled-delivery',
  contract: 'task:terminal-handled',
  key: STALL_KEY,
  count: 1,
  attempts: { count: 3, terminal: "'succeeded'", recoveredFromStall: true },
  payload: { scenario: 'stall', kill: true, holdMs: 600 },
})}`;
}

/** The operator-provided fixture provider (engine-side case identities). */
function fixtureProviderMjs(): string {
  return `import { randomUUID } from 'node:crypto';

// The provider is given the COMPILED case id (a digest), so the row
// identity it mints is keyed by that digest.
const KEYS = ${JSON.stringify({ [CASES['flaky-delivery']]: FLAKY_KEY, [CASES['duplicate-delivery']]: DUPLICATE_KEY, [CASES['stalled-delivery']]: STALL_KEY })};
const live = new Map();
let counter = 0;

export default {
  prepare(input) {
    counter += 1;
    const leaseId = randomUUID();
    const key = KEYS[input.caseId] ?? 'unknown';
    live.set(leaseId, {});
    return {
      leaseId,
      namespace: ('fixture-' + input.runId + '-' + input.caseId + '-' + String(counter)).toLowerCase().replace(/[^a-z0-9-]/g, '-'),
      subjects: { expectedRowId: key + '-1' },
      actors: { system: { principalId: 'system', tenantId: null, roles: [], credentialRef: 'credref:' + leaseId + ':system' } },
    };
  },
  release(leaseId) {
    live.delete(leaseId);
  },
  resolveCredential() {
    return { headers: {} };
  },
};
`;
}

const PLAYWRIGHT_CONFIG = `import { defineConfig } from 'playwright/test';
export default defineConfig({
  testDir: 'specs',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: true,
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
  use: { headless: true, trace: 'off' },
  timeout: 120_000,
});
`;

/** Canonical case id (same recipe the compiler uses). */
function caseIdOf(slug: string): string {
  return sha256Canonical({ domain: 'gateforge.case.v1', resourceId: TASK_RESOURCE, id: slug });
}

const CASES = {
  'flaky-delivery': caseIdOf('flaky-delivery'),
  'duplicate-delivery': caseIdOf('duplicate-delivery'),
  'stalled-delivery': caseIdOf('stalled-delivery'),
} as const;

const CASE_TITLES = {
  'flaky-delivery': 'a flaky delivery retries within its bound and completes',
  'duplicate-delivery': 'a duplicate idempotency key leaves one side effect',
  'stalled-delivery': 'a delivery lost with its worker is reclaimed and settles',
} as const;

const SPEC = `import { test as gateforgeTest, expect } from '@gate-forge/pack-playwright';
import { CASES } from './case-ids.js';

const test = gateforgeTest;

// A test names one approved case id; the engine produced the delivery,
// read the queue back, and sealed the observation.
${Object.entries(CASES)
  .map(
    ([slug, caseId]) => `test('${CASE_TITLES[slug as keyof typeof CASE_TITLES]}', async ({ evidence }) => {
  const sealed = await evidence.prove(CASES['${slug}']);
  expect(sealed.state).toBe('sealed');
  expect(sealed.recordIds.length).toBeGreaterThan(0);
});`,
  )
  .join('\n\n')}
`;

const CASE_IDS_JS = `export const CASES = ${JSON.stringify(CASES, null, 2)};
`;

const TEST_MAP_YML = `schemaVersion: 1
tests:
${Object.entries(CASES)
  .map(
    ([slug, caseId]) => `  - key: playwright:chromium:specs/queue.spec.js:${CASE_TITLES[slug as keyof typeof CASE_TITLES]}
    selector:
      runner: playwright
      project: chromium
      file: specs/queue.spec.js
      titlePath:
        - ${CASE_TITLES[slug as keyof typeof CASE_TITLES]}
    kind: browser-e2e
    claims:
      - ${TASK_RESOURCE}:${slug === 'flaky-delivery' ? 'task:retry-policy-enforced' : slug === 'duplicate-delivery' ? 'task:duplicate-delivery-handled' : 'task:terminal-handled'}
    caseIds:
      - ${caseId}
    reason: the engine delivers and reads the queue itself; the test only names the case`,
  )
  .join('\n')}
`;

/** The three task obligation ids. */
const TASK_IDS: readonly string[] = [
  `${TASK_RESOURCE}:task:retry-policy-enforced`,
  `${TASK_RESOURCE}:task:duplicate-delivery-handled`,
  `${TASK_RESOURCE}:task:terminal-handled`,
];

/**
 * Installs the fixture repository: the scanned source, the detector,
 * the reviewed adapter, the queue observer declaration, the behavior
 * document, and the suite that names one approved case per test.
 *
 * Args:
 *   repo: the temporary candidate repository.
 *   scopeFile: absolute path of the mirrored outbox.
 *   queueName: the queue the engine delivers to.
 */
function installFixture(repo: TempRepo, scopeFile: string, queueName: string): void {
  mkdirSync(join(repo.root, 'src'), { recursive: true });
  repo.writeFiles({
    'src/mailer.js': readFileSync(join(ROOT, 'example/task-bullmq/worker.js'), 'utf8'),
    '.gateforge.yml': gateforgeYml(queueName),
    '.gateforge/fixture-detector.mjs': DETECTOR,
    '.gateforge/policies.yml': POLICIES_YML,
    '.gateforge/classification-policy.yml': CLASSIFICATION_POLICY_YML,
    '.gateforge/behavior.yml': behaviorYml(),
    '.gateforge/adapters/email-send.mjs': adapterSource(scopeFile),
    '.gateforge/adapters/outbox.mjs': adapterSource(scopeFile),
    '.gateforge/baselines/obligations.json': `${JSON.stringify({ schemaVersion: 1, fingerprints: [] }, null, 2)}\n`,
    '.gateforge/test-map.yml': TEST_MAP_YML,
    '.gateforge/fixture-provider.mjs': fixtureProviderMjs(),
    'specs/queue.spec.js': SPEC,
    'specs/case-ids.js': CASE_IDS_JS,
    'playwright.config.mjs': PLAYWRIGHT_CONFIG,
    'package.json': `${JSON.stringify({ type: 'module' }, null, 2)}\n`,
    '.gitignore': ['node_modules', 'test-results', 'playwright-report', '.playwright', '.gateforge/test-gates', ''].join('\n'),
  });
  symlinkSync(
    process.env['GATEFORGE_PHYSICAL_NODE_MODULES'] ?? join(ROOT, 'node_modules'),
    join(repo.root, 'node_modules'),
    'dir',
  );
}

/** A verifier key ring outside the candidate. */
function provisionVerifierKey(): string {
  const directory = mkdtempSync(join(tmpdir(), 'gateforge-task-verifier-'));
  tempDirectories.push(directory);
  const keyFile = join(directory, 'keys.json');
  writeFileSync(
    keyFile,
    `${JSON.stringify({ schemaVersion: 1, activeKeyId: 'task-key', keys: { 'task-key': 'task-engine-e2e-verifier-key' } })}\n`,
    { mode: 0o600 },
  );
  return keyFile;
}

interface BehaviorReport {
  summary: { obligations: number; blocking: number };
  verdicts: Array<{ obligationId: string; verdict: string; reason?: string }>;
}

function parseReport(run: { code: number; stdout: string; stderr: string }): BehaviorReport {
  if (!run.stdout.trimStart().startsWith('{')) {
    throw new Error(`test-gates exited ${String(run.code)} without a report\nstdout:\n${run.stdout}\nstderr:\n${run.stderr}`);
  }
  return JSON.parse(run.stdout) as BehaviorReport;
}

/** The engine-read queue observation for one sealed case. */
function engineReadObservation(
  records: string,
  caseId: string,
): { state: string; attemptsMade: number }[] {
  const sealed = JSON.parse(records) as Array<{
    payload?: {
      caseId?: string;
      queueObservation?: { jobs?: Array<{ jobId: string; state: string; attemptsMade: number }> };
    };
  }>;
  const payload = sealed.find((record) => record.payload?.caseId === caseId)?.payload;
  const jobs = payload?.queueObservation?.jobs;
  if (jobs === undefined) throw new Error(`case ${caseId} sealed no engine-read queue observation`);
  return jobs.map((job) => ({ state: job.state, attemptsMade: job.attemptsMade }));
}

/**
 * Runs one full gate over a freshly installed fixture repository with
 * the named application defect.
 *
 * Args:
 *   defect: which application behaviour to break (none for the pass run).
 *
 * Returns:
 *   the test-gates result, its parsed report, the check result and the
 *   sealed record ledger.
 */
async function runTaskGate(defect: 'none' | 'retry' | 'idempotency' | 'stall'): Promise<{
  run: { code: number; stdout: string; stderr: string };
  report: BehaviorReport;
  check: { code: number; stdout: string; stderr: string };
  records: string;
}> {
  const keyFile = provisionVerifierKey();
  const scopeDirectory = mkdtempSync(join(tmpdir(), 'gateforge-task-scope-'));
  tempDirectories.push(scopeDirectory);
  const scopeFile = join(scopeDirectory, 'outbox.json');
  const stub = await startStubApp();
  const app = await taskQueueApp.startTaskQueueApp({
    connection: { url: REDIS_URL },
    scopeFile,
    breakRetry: defect === 'retry',
    breakIdempotency: defect === 'idempotency',
    restartWorker: defect !== 'stall',
  });
  const saved = new Map<string, string | undefined>();
  const setEnv = (values: Record<string, string>): void => {
    for (const [key, value] of Object.entries(values)) {
      if (!saved.has(key)) saved.set(key, process.env[key]);
      process.env[key] = value;
    }
  };
  try {
    return await withTempRepo({}, async (repo) => {
      installFixture(repo, scopeFile, app.queueName);
      repo.git(['add', '-A']);
      repo.git(['commit', '--no-gpg-sign', '--quiet', '-m', 'task fixture']);
      const config = loadConfigAt(repo.root);
      const env: Record<string, string> = {
        [VERIFIER_KEY_FILE_ENV]: keyFile,
        GATEFORGE_APP_BASE_URL: stub.url,
        GATEFORGE_APPROVED_POLICY_DIGEST: trustedPolicyDigestForConfig(repo.root, config),
        // The approved fixture/actor provider is engine-side input.
        GATEFORGE_FIXTURE_PROVIDER: join(repo.root, '.gateforge/fixture-provider.mjs'),
        // The engine-owned queue observer resolves this URL privately
        // inside the witness process.
        GATEFORGE_TEST_REDIS_URL: REDIS_URL,
      };
      setEnv(env);
      const run = await runCli(repo, ['test-gates', '--changed', '--format', 'json'], env);
      const report = parseReport(run);
      const check = await runCli(repo, ['check', '--require-e2e'], env);
      const records = readFileSync(join(repo.root, '.gateforge/test-gates/records.json'), 'utf8');
      return { run, report, check, records };
    });
  } finally {
    await app.stop();
    await stub.stop();
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function truthOf(report: BehaviorReport): string {
  return report.verdicts.map((entry) => `${entry.obligationId} -> ${entry.verdict}: ${entry.reason ?? ''}`).join('\n');
}

describe.skipIf(REDIS_URL === '')('task namespace: engine-level end-to-end (plan 2026-09-25 Phase 3)', () => {
  it(
    'seals all three task obligations from the queue the engine read',
    async () => {
      const { run, report, check, records } = await runTaskGate('none');
      const truth = truthOf(report);
      expect(run.code, `stdout:\n${run.stdout}\nstderr:\n${run.stderr}`).toBe(0);
      for (const id of TASK_IDS) {
        const verdict = report.verdicts.find((entry) => entry.obligationId === id);
        expect(verdict, `${id} is missing from the report:\n${truth}`).toBeDefined();
        expect(verdict?.verdict, truth).toBe('satisfied');
      }
      // The engine read the queue: the flaky delivery really used the
      // whole declared bound, and the reclaimed job settled.
      expect(engineReadObservation(records, CASES['flaky-delivery'])).toEqual([
        { state: 'completed', attemptsMade: 3 },
      ]);
      expect(engineReadObservation(records, CASES['stalled-delivery'])).toEqual([
        { state: 'completed', attemptsMade: 1 },
      ]);
      expect(check.code, `stdout:\n${check.stdout}\nstderr:\n${check.stderr}`).toBe(0);
    },
    300_000,
  );

  it(
    'blocks the retry bound when the delivery never recovers',
    async () => {
      const { run, report, check, records } = await runTaskGate('retry');
      const truth = truthOf(report);
      const flaky = report.verdicts.find((entry) => entry.obligationId === TASK_IDS[0]);
      expect(flaky, truth).toBeDefined();
      expect(flaky?.verdict, truth).toBe('invalid');
      expect(flaky?.reason, truth).toContain("not 'completed'");
      // The engine read the failure itself: the job ended `failed`.
      expect(engineReadObservation(records, CASES['flaky-delivery'])).toEqual([
        { state: 'failed', attemptsMade: 3 },
      ]);
      expect(report.summary.blocking, truth).toBeGreaterThan(0);
      expect(run.code, truth).not.toBe(0);
      expect(check.code, `stdout:\n${check.stdout}\nstderr:\n${check.stderr}`).not.toBe(0);
    },
    300_000,
  );

  it(
    'blocks idempotency when a repeated key writes a second side effect',
    async () => {
      const { run, report, check } = await runTaskGate('idempotency');
      const truth = truthOf(report);
      const duplicate = report.verdicts.find((entry) => entry.obligationId === TASK_IDS[1]);
      expect(duplicate, truth).toBeDefined();
      expect(duplicate?.verdict, truth).toBe('invalid');
      expect(duplicate?.reason, truth).toMatch(/BEHAVIOR_EFFECT_MISMATCH|BEHAVIOR_UNEXPECTED_EFFECT/);
      expect(report.summary.blocking, truth).toBeGreaterThan(0);
      expect(run.code, truth).not.toBe(0);
      expect(check.code, `stdout:\n${check.stdout}\nstderr:\n${check.stderr}`).not.toBe(0);
    },
    300_000,
  );

  it(
    'blocks the terminal outcome when a lost worker is never replaced',
    async () => {
      const { run, report, check } = await runTaskGate('stall');
      const truth = truthOf(report);
      const stalled = report.verdicts.find((entry) => entry.obligationId === TASK_IDS[2]);
      expect(stalled, truth).toBeDefined();
      // A delivery whose worker is never replaced never reaches a
      // terminal state, so the engine seals no settled observation: the
      // obligation blocks, and it blocks from the engine's own read
      // rather than from anything the test claimed.
      expect(stalled?.verdict, truth).not.toBe('satisfied');
      expect(stalled?.reason, truth).toMatch(
        /BEHAVIOR_CASE_MISSING|OBSERVATION_SCOPE_INCOMPLETE|never reached a terminal state/,
      );
      expect(report.summary.blocking, truth).toBeGreaterThan(0);
      expect(run.code, truth).not.toBe(0);
      expect(check.code, `stdout:\n${check.stdout}\nstderr:\n${check.stderr}`).not.toBe(0);
    },
    300_000,
  );
});
