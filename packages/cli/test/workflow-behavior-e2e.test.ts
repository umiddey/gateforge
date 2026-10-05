/**
 * Engine-level end-to-end proof for the `workflow` namespace (plan
 * 2026-09-25 Phase 2): the real CLI over a real fixture repository,
 * the pack's own example workflow server (`example/workflow/server.js`)
 * behind the loopback attestation proxy, the witness `test-gates`
 * spawns itself, and post-suite verdict evaluation through
 * `check --require-e2e`.
 *
 * The point of this suite is the PATH, not the pack: nothing here
 * exercises the detector or the example server's own tests. Every case
 * is driven by the witness from the owner-declared behavior document,
 * and the only thing a test body does is name one approved case id. A
 * test cannot assert its own way to a green gate.
 *
 * The rejection pair this phase adds (both graded, both on the one
 * transition endpoint):
 *   - transition-rejected  — an illegal event is rejected (409) and the
 *     engine-read contract snapshot is UNCHANGED (no state moved);
 *   - terminal-immutable   — a write against a terminal contract is
 *     rejected (409) and the snapshot is UNCHANGED.
 * Both ride on a positive control the engine also drives (a legal
 * transition that DOES move the state), so "unchanged" can never be
 * satisfied by an app that simply never moves anything.
 *
 * This suite ships a pass variant and a fail variant. The fail variant
 * runs the SAME example server with one documented defect patched into
 * the copy the engine scans: the transition guards are gone, so every
 * event advances the contract. The engine must block it.
 */
import type { Server } from 'node:http';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { sha256Canonical, withTempRepo, type TempRepo } from '@gate-forge/core';
import { startAttestationProxy } from '@gate-forge/pack-playwright';
import { trustedPolicyDigestForConfig } from '../src/execution.js';
import { loadConfigAt, VERIFIER_KEY_FILE_ENV } from '../src/commands/common.js';
import { runCli } from './helpers.js';

/** Repo root (the example workflow server lives here). */
const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
/** The fingerprint the harness pins for the example server's environment. */
const FINGERPRINT = 'example-workflow-v1';
/** The detector-emitted resource id of the transition endpoint. */
const ENDPOINT = 'global.http-post-contracts-transitions-2b7d41ea';
/** The contract-store entity the reviewed adapter witnesses. */
const CONTRACTS = 'global.contracts';

const tempDirectories: string[] = [];

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

/**
 * The example server reads its audit path at MODULE LOAD, so the
 * redirect into a temporary directory has to happen before the import
 * (a static import would already have bound `example/workflow/audit.json`).
 * That directory therefore has to outlive every test in this file.
 */
const AUDIT_FILE = join(mkdtempSync(join(tmpdir(), 'gateforge-workflow-audit-')), 'audit.json');
const AUDIT_DIRECTORY = join(AUDIT_FILE, '..');
process.env['AUDIT_FILE'] = AUDIT_FILE;
afterAll(() => {
  rmSync(AUDIT_DIRECTORY, { recursive: true, force: true });
});

// The example receiver is an untyped checked-in fixture (not a workspace package).
// @ts-expect-error: no declaration file for the example fixture
const exampleWorkflow = (await import('../../../example/workflow/server.js')) as {
  createApp: (options?: unknown) => { server: Server; store: { contracts: Map<string, Record<string, unknown>> } };
};

const GATEFORGE_YML = `schemaVersion: 1
project:
  languages: [javascript]
  paths:
    include: ['src/**', 'specs/**']
    exclude: []
plugins:
  - id: gateforge.workflow-fixture
    version: 1.0.0
    transport: in-process
    module: ./.gateforge/fixture-detector.mjs
policies: .gateforge/policies.yml
classificationPolicy: .gateforge/classification-policy.yml
adapters: .gateforge/adapters
waivers: .gateforge/waivers
baselines: .gateforge/baselines/obligations.json
scan:
  scanRoots: ['src/**']
  declarations:
    internality: gateforge:internal
  volatileFields: []
behaviorPolicy: .gateforge/behavior.yml
changed: { provider: auto }
witness: { maxDurationSeconds: 5 }
clock: { mode: fixed, fixedAt: '2026-01-01T00:00:00.000Z' }
`;

const POLICIES_YML = `schemaVersion: 1
policies:
  - id: workflow-state-machine
    when:
      kind: http.endpoint
    require:
      - workflow:transition-allowed
      - workflow:transition-rejected
      - workflow:terminal-immutable
`;

const CLASSIFICATION_POLICY_YML = `schemaVersion: 1
trustedInternalEntryPoints: []
internalRules: []
`;

/**
 * The fixture detector: the transition endpoint the principal drives
 * plus the contract store the reviewed adapter witnesses.
 */
const DETECTOR = `const SOURCE = 'src/workflow-server.js';
const LOCATION = { file: SOURCE, line: 1, col: 0 };
const DETECTOR = { id: 'gateforge.workflow-fixture', version: '1.0.0' };
const ENDPOINT = ${JSON.stringify(ENDPOINT)};
const CONTRACTS = ${JSON.stringify(CONTRACTS)};

function signal(resourceName, dimension, assertion) {
  return {
    schemaVersion: 1,
    target: { resourceName },
    dimension,
    assertion,
    basis: 'declaration',
    source: 'gateforge.workflow-fixture',
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
          id: ENDPOINT,
          kind: 'http.endpoint',
          source: SOURCE,
          location: LOCATION,
          detectorVersion: DETECTOR.version,
          attributes: {
            resourceName: 'http-post-contracts-transitions-2b7d41ea',
            method: 'POST',
            canonicalPath: '/contracts/{id}/transitions',
            identity: 'POST /contracts/{id}/transitions',
          },
        },
        {
          schemaVersion: 1,
          id: 'contracts',
          kind: 'fixture.entity',
          source: SOURCE,
          location: LOCATION,
          detectorVersion: DETECTOR.version,
          attributes: { resourceName: 'contracts', updateableFields: ['status', 'title'] },
        },
      ],
      unresolved: [],
      findings: [],
      classificationSignals: [
        signal('http-post-contracts-transitions-2b7d41ea', 'plane', 'global'),
        signal('http-post-contracts-transitions-2b7d41ea', 'identity', ['method', 'path']),
        signal('contracts', 'plane', 'global'),
        signal('contracts', 'identity', ['id']),
        signal('contracts', 'adapter-binding', CONTRACTS),
        signal('contracts', 'lifecycle.create', true),
        signal('contracts', 'lifecycle.read', true),
        signal('contracts', 'lifecycle.update', true),
        signal('contracts', 'lifecycle.delete', true),
        signal('contracts', 'delete-semantics', 'hard'),
      ],
    };
  },
};
`;

/**
 * Reviewed evidence adapter. Entity reads use the app's own read-only
 * endpoint; the SCOPE snapshot the engine compares before/after a case
 * is read from the trusted file the harness mirrors out of the
 * contract store — the witness deliberately refuses the candidate GET
 * transport there, so a scope can never be the app's own answer.
 *
 * Args:
 *   scopeFile: absolute path of the mirrored contract store.
 *
 * Returns:
 *   string: the adapter module source.
 */
function adapterSource(scopeFile: string): string {
  return `import { existsSync, readFileSync } from 'node:fs';
const FINGERPRINT = ${JSON.stringify(FINGERPRINT)};
const SCOPE_FILE = ${JSON.stringify(scopeFile)};

export default {
  async read(ctx, id) {
    const res = await ctx.get('/contracts/' + encodeURIComponent(String(id)));
    if (res.status === 404) return null;
    if (res.status !== 200) throw new Error('adapter read failed: HTTP ' + res.status);
    return res.json();
  },
  async list(ctx) {
    const res = await ctx.get('/contracts');
    if (res.status !== 200) throw new Error('adapter list failed: HTTP ' + res.status);
    return (await res.json()).contracts;
  },
  normalize(body) {
    return {
      entityId: body.id,
      fields: { id: body.id, status: body.status, title: body.title },
    };
  },
  deletion: 'hard',
  environmentFingerprint: FINGERPRINT,
  async snapshotScope(ctx, input) {
    const stored = existsSync(SCOPE_FILE)
      ? JSON.parse(readFileSync(SCOPE_FILE, 'utf8'))
      : { checkpoint: 'c0', entities: [] };
    return {
      scope: input.scope,
      fixtureNamespace: input.fixtureNamespace,
      complete: true,
      checkpoint: stored.checkpoint,
      entities: stored.entities,
      exhausted: true,
    };
  },
};
`;
}

/**
 * The owner-declared behavior document: three cases on the transition
 * endpoint, all engine-http. The legal transition is the positive
 * control for the rejection case; the terminal write is immutable.
 */
const BEHAVIOR_YML = `schemaVersion: 1
endpoints:
  - resourceId: ${ENDPOINT}
    effects:
      - id: contracts
        resourceId: ${CONTRACTS}
        adapter: contracts
        scope: contracts
        identityFields: [id]
        fields: [id, status, title]
        completion: immediate
    cases:
      - id: legal-transition
        contract: workflow:transition-allowed
        channel: engine-http
        fixture: workflow-contracts
        actor: operator
        action:
          kind: request
          method: POST
          pathTemplate: /contracts/{id}/transitions
          path:
            id: {from: literal, value: wf-1}
          query: {}
          body:
            encoding: json
            fields:
              actor: {from: literal, value: engine}
              event: {from: literal, value: sign}
          credentialVariant: valid
        expect:
          statuses: [200]
          response: []
          state:
            - kind: transition
              scope: contracts
              subject: {from: literal, value: wf-1}
              field: status
              from: {from: literal, value: pending}
              to: {from: literal, value: signed}
      - id: illegal-transition
        contract: workflow:transition-rejected
        controlCase: legal-transition
        channel: engine-http
        fixture: workflow-contracts
        actor: operator
        action:
          kind: request
          method: POST
          pathTemplate: /contracts/{id}/transitions
          path:
            id: {from: literal, value: wf-1}
          query: {}
          body:
            encoding: json
            fields:
              actor: {from: literal, value: engine}
              event: {from: literal, value: submit}
          credentialVariant: valid
        expect:
          statuses: [409]
          response: []
          state:
            - kind: unchanged
              scope: contracts
      - id: terminal-write
        contract: workflow:terminal-immutable
        channel: engine-http
        fixture: workflow-contracts
        actor: operator
        action:
          kind: request
          method: POST
          pathTemplate: /contracts/{id}/transitions
          path:
            id: {from: literal, value: wf-2}
          query: {}
          body:
            encoding: json
            fields:
              actor: {from: literal, value: engine}
              event: {from: literal, value: terminate}
          credentialVariant: valid
        expect:
          statuses: [409]
          response: []
          state:
            - kind: unchanged
              scope: contracts
resources: []
`;

/**
 * The operator-provided trusted fixture/actor provider
 * (`GATEFORGE_FIXTURE_PROVIDER`): the engine-side-only source of case
 * subjects. The workflow endpoint needs no credential, so the actor
 * carries an empty header set the driver sends verbatim.
 */
const FIXTURE_PROVIDER_MJS = `import { randomUUID } from 'node:crypto';

const ACTORS = { operator: { principalId: 'operator', tenantId: null, roles: [] } };
const live = new Map();
let counter = 0;

export default {
  prepare(input) {
    counter += 1;
    const leaseId = randomUUID();
    const actors = {};
    for (const [name, template] of Object.entries(ACTORS)) {
      actors[name] = { ...template, roles: [...template.roles], credentialRef: 'credref:' + leaseId + ':' + name };
    }
    live.set(leaseId, { subjects: {} });
    return {
      leaseId,
      namespace: ('fixture-' + input.runId + '-' + input.caseId + '-' + String(counter)).toLowerCase().replace(/[^a-z0-9-]/g, '-'),
      subjects: {},
      actors,
    };
  },
  release(leaseId) {
    live.delete(leaseId);
  },
  resolveCredential(credentialRef) {
    const match = /^credref:([^:]+):(.+)$/.exec(credentialRef);
    if (match === null || !live.has(match[1])) return null;
    return { headers: {} };
  },
};
`;

const PLAYWRIGHT_CONFIG = `import { defineConfig } from 'playwright/test';
export default defineConfig({
  testDir: 'specs',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: true,
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
  use: { headless: true, trace: 'off' },
  timeout: 60_000,
});
`;

/** Canonical case id (same recipe the compiler uses). */
function caseIdOf(slug: string): string {
  return sha256Canonical({ domain: 'gateforge.case.v1', resourceId: ENDPOINT, id: slug });
}

const SPEC = `import { test as gateforgeTest, expect } from '@gate-forge/pack-playwright';
import { CASES } from './case-ids.js';

const test = gateforgeTest;

// The order IS the state machine: the legal transition runs first (it
// is the rejection case's positive control), then the illegal event,
// then the write against the terminal contract.
test('a legal transition is accepted and the state moves', async ({ evidence }) => {
  const sealed = await evidence.prove(CASES['legal-transition']);
  expect(sealed.state).toBe('sealed');
  expect(sealed.recordIds.length).toBeGreaterThan(0);
});

test('an illegal transition is rejected and moves nothing', async ({ evidence }) => {
  const sealed = await evidence.prove(CASES['illegal-transition']);
  expect(sealed.state).toBe('sealed');
  expect(sealed.recordIds.length).toBeGreaterThan(0);
});

test('a terminal contract cannot be written', async ({ evidence }) => {
  const sealed = await evidence.prove(CASES['terminal-write']);
  expect(sealed.state).toBe('sealed');
  expect(sealed.recordIds.length).toBeGreaterThan(0);
});
`;

const CASE_IDS_JS = `export const CASES = ${JSON.stringify(
  {
    'legal-transition': caseIdOf('legal-transition'),
    'illegal-transition': caseIdOf('illegal-transition'),
    'terminal-write': caseIdOf('terminal-write'),
  },
  null,
  2,
)};
`;

const TEST_MAP_YML = `schemaVersion: 1
tests:
  - key: playwright:chromium:specs/workflow.spec.js:a legal transition is accepted and the state moves
    selector:
      runner: playwright
      project: chromium
      file: specs/workflow.spec.js
      titlePath:
        - a legal transition is accepted and the state moves
    kind: browser-e2e
    claims:
      - ${ENDPOINT}:workflow:transition-allowed
    caseIds:
      - ${caseIdOf('legal-transition')}
    reason: the engine drives the legal transition and reads the contract store back itself
  - key: playwright:chromium:specs/workflow.spec.js:an illegal transition is rejected and moves nothing
    selector:
      runner: playwright
      project: chromium
      file: specs/workflow.spec.js
      titlePath:
        - an illegal transition is rejected and moves nothing
    kind: browser-e2e
    claims:
      - ${ENDPOINT}:workflow:transition-rejected
    caseIds:
      - ${caseIdOf('illegal-transition')}
    reason: the engine drives the illegal event; the contract store must be unchanged
  - key: playwright:chromium:specs/workflow.spec.js:a terminal contract cannot be written
    selector:
      runner: playwright
      project: chromium
      file: specs/workflow.spec.js
      titlePath:
        - a terminal contract cannot be written
    kind: browser-e2e
    claims:
      - ${ENDPOINT}:workflow:terminal-immutable
    caseIds:
      - ${caseIdOf('terminal-write')}
    reason: the engine drives a write against the terminal contract; the store must be unchanged
`;

/** The three obligations the behavior document compiles. */
const WORKFLOW_IDS: readonly string[] = [
  `${ENDPOINT}:workflow:transition-allowed`,
  `${ENDPOINT}:workflow:transition-rejected`,
  `${ENDPOINT}:workflow:terminal-immutable`,
];

/**
 * Patches the transition guards out of the example server: the
 * fail-variant application under test. This is the defect class the
 * workflow pack exists to catch — an event the state machine does not
 * define still advances the contract, and a terminal contract is not
 * terminal.
 *
 * Args:
 *   source: the pristine example server source.
 *
 * Returns:
 *   string: the same server with both rejection guards removed.
 */
function withoutTransitionGuards(source: string): string {
  const guards = [
    `  if (TERMINAL.includes(contract.status)) {
    return { ok: false, status: 409, body: { error: 'terminal-state', currentStatus: contract.status } };
  }
`,
    `  if (found === undefined) {
    return { ok: false, status: 409, body: { error: 'invalid-transition', currentStatus: contract.status, event } };
  }
`,
  ];
  const permissive = `  const found = TRANSITIONS.find((t) => t.from === contract.status && t.event === event) ?? {
    from: contract.status,
    event,
    to: STATUSES[(STATUSES.indexOf(contract.status) + 1) % STATUSES.length],
  };
`;
  const lookup = `  const found = TRANSITIONS.find((t) => t.from === contract.status && t.event === event);
`;
  let patched = source;
  for (const guard of guards) {
    if (!patched.includes(guard)) throw new Error('the example workflow server no longer holds the guard under test');
    patched = patched.replace(guard, '');
  }
  if (!patched.includes(lookup)) throw new Error('the example workflow server no longer holds the transition lookup');
  return patched.replace(lookup, permissive);
}

/**
 * Boots the workflow app over a harness-owned contract store whose
 * every write mirrors into the trusted scope file the reviewed adapter
 * snapshots (the file-mediated trust boundary: the engine never reads
 * a scope back out of the app it is grading).
 *
 * Args:
 *   scopeFile: absolute path the mirrored store is written to.
 *   defective: when true, boot the guard-less copy instead.
 *
 * Returns:
 *   Promise<{url, stop, drive}>: the running server, its stop, and the
 *   fixture-setup driver that puts the world in its pre-case state.
 */
async function startWorkflowApp(
  scopeFile: string,
  defective: boolean,
): Promise<{ url: string; stop: () => Promise<void> }> {
  let createApp: (options?: unknown) => { server: Server; store: { contracts: Map<string, Record<string, unknown>> } };
  if (defective) {
    const directory = mkdtempSync(join(tmpdir(), 'gateforge-workflow-defect-'));
    tempDirectories.push(directory);
    const file = join(directory, 'workflow-server.mjs');
    writeFileSync(file, withoutTransitionGuards(readFileSync(join(ROOT, 'example/workflow/server.js'), 'utf8')));
    createApp = ((await import(pathToFileURL(file).href)) as { createApp: typeof createApp }).createApp;
  } else {
    createApp = exampleWorkflow.createApp;
  }
  const { server, store } = createApp();
  const mirror = (contracts: Map<string, Record<string, unknown>>): void => {
    const entities = [...contracts.values()]
      .map((row) => ({ entityId: row['id'], fields: { id: row['id'], status: row['status'], title: row['title'] } }))
      .sort((a, b) => (String(a.entityId) < String(b.entityId) ? -1 : 1));
    writeFileSync(scopeFile, `${JSON.stringify({ checkpoint: `c${String(entities.length)}`, entities })}\n`);
  };
  // A Map SUBCLASS (Map internals reject a proxied receiver) that
  // mirrors every create, wrapping each contract so a status write
  // mirrors BEFORE the handler answers — the engine's after-snapshot
  // can never race the mirror.
  class MirroredContracts extends Map<string, Record<string, unknown>> {
    override set(key: string, value: Record<string, unknown>): this {
      const result = super.set(key, value);
      mirror(this);
      return result;
    }
    override get(key: string): Record<string, unknown> | undefined {
      const found = super.get(key);
      if (found === undefined) return undefined;
      const owner = this;
      return new Proxy(found, {
        set(target, property, value) {
          const done = Reflect.set(target, property, value);
          mirror(owner);
          return done;
        },
      });
    }
  }
  store.contracts = new MirroredContracts() as unknown as Map<string, Record<string, unknown>>;
  // The handler captured `store`, not `store.contracts`, so the swap
  // above is visible to it.
  mirror(store.contracts);
  await new Promise<void>((resolveListen) => server.listen(0, ['127', '0', '0', '1'].join('.'), resolveListen));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no workflow server port');
  const url = `http://${['127', '0', '0', '1'].join('.')}:${String(address.port)}`;
  // Fixture setup runs through the app's OWN API and state machine, so
  // the pre-case world is a world the app itself produced.
  const post = async (path: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> => {
    const response = await fetch(`${url}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: response.status, json: (await response.json()) as Record<string, unknown> };
  };
  const created = await post('/contracts', { actor: 'ops', title: 'alpha' });
  if (created.status !== 201) throw new Error(`fixture setup could not create a contract (HTTP ${String(created.status)})`);
  await post(`/contracts/${String(created.json['id'])}/transitions`, { actor: 'ops', event: 'submit' });
  const terminal = await post('/contracts', { actor: 'ops', title: 'beta' });
  if (terminal.status !== 201) throw new Error(`fixture setup could not create the terminal contract (HTTP ${String(terminal.status)})`);
  for (const event of ['submit', 'sign', 'terminate']) {
    await post(`/contracts/${String(terminal.json['id'])}/transitions`, { actor: 'ops', event });
  }
  return {
    url,
    stop: async () => {
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    },
  };
}

/**
 * Writes the fixture repository: the example server as the scanned
 * source, the detector, the reviewed adapter, the behavior document and
 * the suite that names one approved case per test.
 *
 * Args:
 *   repo: the temporary candidate repository.
 *   scopeFile: absolute path of the mirrored contract store.
 *   defective: install the guard-less copy of the example server.
 */
function installFixture(repo: TempRepo, scopeFile: string, defective: boolean): void {
  mkdirSync(join(repo.root, 'src'), { recursive: true });
  const source = readFileSync(join(ROOT, 'example/workflow/server.js'), 'utf8');
  cpSync(join(ROOT, 'example/workflow/server.js'), join(repo.root, 'src', 'workflow-server.js'));
  repo.writeFiles({
    '.gateforge.yml': GATEFORGE_YML,
    '.gateforge/fixture-detector.mjs': DETECTOR,
    '.gateforge/policies.yml': POLICIES_YML,
    '.gateforge/classification-policy.yml': CLASSIFICATION_POLICY_YML,
    '.gateforge/behavior.yml': BEHAVIOR_YML,
    '.gateforge/adapters/contracts.mjs': adapterSource(scopeFile),
    '.gateforge/baselines/obligations.json': `${JSON.stringify({ schemaVersion: 1, fingerprints: [] }, null, 2)}\n`,
    '.gateforge/test-map.yml': TEST_MAP_YML,
    '.gateforge/fixture-provider.mjs': FIXTURE_PROVIDER_MJS,
    'specs/workflow.spec.js': SPEC,
    'specs/case-ids.js': CASE_IDS_JS,
    'playwright.config.mjs': PLAYWRIGHT_CONFIG,
    'package.json': `${JSON.stringify({ type: 'module' }, null, 2)}\n`,
    '.gitignore': ['node_modules', 'test-results', 'playwright-report', '.playwright', '.gateforge/test-gates', ''].join('\n'),
  });
  if (defective) {
    repo.writeFiles({ 'src/workflow-server.js': withoutTransitionGuards(source) });
  }
  symlinkSync(
    process.env['GATEFORGE_PHYSICAL_NODE_MODULES'] ?? join(ROOT, 'node_modules'),
    join(repo.root, 'node_modules'),
    'dir',
  );
}

/** A verifier key ring outside the candidate, with its key id. */
function provisionVerifierKey(): { keyFile: string } {
  const directory = mkdtempSync(join(tmpdir(), 'gateforge-workflow-verifier-'));
  tempDirectories.push(directory);
  const keyFile = join(directory, 'keys.json');
  writeFileSync(
    keyFile,
    `${JSON.stringify({ schemaVersion: 1, activeKeyId: 'workflow-key', keys: { 'workflow-key': 'workflow-engine-e2e-verifier-key' } })}\n`,
    { mode: 0o600 },
  );
  return { keyFile };
}

interface BehaviorReport {
  summary: { obligations: number; blocking: number };
  verdicts: Array<{ obligationId: string; verdict: string; reason?: string }>;
}

/**
 * Parses the run's JSON report, failing with both streams when the CLI
 * answered with a diagnostic instead (a config error must never read as
 * a verdict).
 */
function parseReport(run: { code: number; stdout: string; stderr: string }): BehaviorReport {
  if (!run.stdout.trimStart().startsWith('{')) {
    throw new Error(
      `test-gates exited ${String(run.code)} without a report\nstdout:\n${run.stdout}\nstderr:\n${run.stderr}`,
    );
  }
  return JSON.parse(run.stdout) as BehaviorReport;
}

/** One sealed scope snapshot as the engine read it. */
interface SealedSnapshot {
  scope: string;
  entities: Array<{ entityId: unknown; fields: Record<string, unknown> }>;
}

/**
 * The contract status the ENGINE read before and after one case — the
 * snapshot the grader compared, not the app's own account of itself.
 *
 * Args:
 *   records: the run's sealed record ledger.
 *   caseId: the compiled case id whose snapshots are wanted.
 *   entityId: the contract the case acted on.
 *
 * Returns:
 *   {before, after}: the two observed statuses.
 */
function engineReadStatus(
  records: string,
  caseId: string,
  entityId: string,
): { before: unknown; after: unknown } {
  const sealed = JSON.parse(records) as Array<{
    payload?: { caseId?: string; before?: SealedSnapshot[]; after?: SealedSnapshot[] };
  }>;
  const payload = sealed.find((record) => record.payload?.caseId === caseId)?.payload;
  const statusOf = (snapshot: SealedSnapshot[] | undefined): unknown =>
    snapshot?.[0]?.entities.find((entity) => entity.entityId === entityId)?.fields['status'];
  const before = statusOf(payload?.before);
  const after = statusOf(payload?.after);
  if (before === undefined || after === undefined) {
    throw new Error(`case ${caseId} sealed no engine-read snapshot for ${entityId}`);
  }
  return { before, after };
}

/**
 * Runs one full gate over a freshly installed fixture repository: the
 * witnessed suite, then the post-suite `check --require-e2e` that
 * loads the sealed receipt.
 *
 * Args:
 *   defective: install and boot the guard-less application variant.
 *
 * Returns:
 *   Promise<{run, report, check}>: the test-gates result, its parsed
 *   report, and the check result.
 */
async function runWorkflowGate(
  defective: boolean,
): Promise<{
  run: { code: number; stdout: string; stderr: string };
  report: BehaviorReport;
  check: { code: number; stdout: string; stderr: string };
  records: string;
}> {
  const { keyFile } = provisionVerifierKey();
  const scopeDirectory = mkdtempSync(join(tmpdir(), 'gateforge-workflow-scope-'));
  tempDirectories.push(scopeDirectory);
  const scopeFile = join(scopeDirectory, 'contracts.json');
  const saved = new Map<string, string | undefined>();
  const setEnv = (values: Record<string, string>): void => {
    for (const [key, value] of Object.entries(values)) {
      if (!saved.has(key)) saved.set(key, process.env[key]);
      process.env[key] = value;
    }
  };
  try {
    return await withTempRepo({}, async (repo) => {
      installFixture(repo, scopeFile, defective);
      repo.git(['add', '-A']);
      repo.git([
        'commit',
        '--no-gpg-sign',
        '--quiet',
        '-m',
        defective ? 'workflow fixture (defective app)' : 'workflow fixture',
      ]);
      const app = await startWorkflowApp(scopeFile, defective);
      const proxy = await startAttestationProxy(app.url, FINGERPRINT);
      try {
        const config = loadConfigAt(repo.root);
        const env: Record<string, string> = {
          [VERIFIER_KEY_FILE_ENV]: keyFile,
          GATEFORGE_APP_BASE_URL: proxy.url,
          GATEFORGE_TARGET_BASE_URL: proxy.url,
          GATEFORGE_TARGET_FINGERPRINT: FINGERPRINT,
          GATEFORGE_APPROVED_POLICY_DIGEST: trustedPolicyDigestForConfig(repo.root, config),
          // The approved fixture/actor provider is engine-side input:
          // without it every strong case blocks fail-closed.
          GATEFORGE_FIXTURE_PROVIDER: join(repo.root, '.gateforge/fixture-provider.mjs'),
        };
        setEnv(env);
        // The change under test: one audited line of the server source.
        repo.writeFiles({
          'src/workflow-server.js': `${readFileSync(join(repo.root, 'src', 'workflow-server.js'), 'utf8')}\n// audited change: the state machine is unchanged.\n`,
        });
        const run = await runCli(repo, ['test-gates', '--changed', '--format', 'json'], env);
        const report = parseReport(run);
        const check = await runCli(repo, ['check', '--require-e2e'], env);
        const records = readFileSync(join(repo.root, '.gateforge/test-gates/records.json'), 'utf8');
        return { run, report, check, records };
      } finally {
        await proxy.stop();
        await app.stop();
      }
    });
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

describe('workflow namespace: engine-level end-to-end (plan 2026-09-25 Phase 2)', () => {
  it('seals the workflow obligations through the real CLI run when the app rejects the illegal write', async () => {
    const { run, report, check, records } = await runWorkflowGate(false);
    const byId = new Map(report.verdicts.map((entry) => [entry.obligationId, entry]));
    const truth = WORKFLOW_IDS.map(
      (id) => `${id} -> ${byId.get(id)?.verdict ?? '<absent>'}: ${byId.get(id)?.reason ?? '<no verdict>'}`,
    );
    expect(run.code, `stdout:\n${run.stdout}\nstderr:\n${run.stderr}`).toBe(0);
    // The engine drove all three cases itself and read the contract
    // store back through the reviewed adapter: the legal transition
    // moved the state, the illegal event and the terminal write were
    // both rejected with the store UNCHANGED.
    for (const id of WORKFLOW_IDS) {
      expect(byId.get(id), `${id} is missing from the report:\n${truth.join('\n')}`).toBeDefined();
      expect(byId.get(id)?.verdict, truth.join('\n')).toBe('satisfied');
    }
    // The engine-read snapshot, not the app's word: the rejected write
    // left the contract exactly where the legal transition put it, and
    // the terminal contract is still terminal.
    const illegal = engineReadStatus(records, caseIdOf('illegal-transition'), 'wf-1');
    expect(illegal).toEqual({ before: 'signed', after: 'signed' });
    const terminal = engineReadStatus(records, caseIdOf('terminal-write'), 'wf-2');
    expect(terminal).toEqual({ before: 'terminated', after: 'terminated' });
    expect(run.stdout).not.toContain('RUN_INCOMPLETE');
    // The sealed receipt is exactly what `check --require-e2e` loads.
    expect(check.code, `stdout:\n${check.stdout}\nstderr:\n${check.stderr}`).toBe(0);
  }, 300_000);

  it('blocks the workflow obligations when the app accepts the illegal write', async () => {
    const { run, report, check, records } = await runWorkflowGate(true);
    const byId = new Map(report.verdicts.map((entry) => [entry.obligationId, entry]));
    const truth = WORKFLOW_IDS.map(
      (id) => `${id} -> ${byId.get(id)?.verdict ?? '<absent>'}: ${byId.get(id)?.reason ?? '<no verdict>'}`,
    );
    // The positive control still passes — the app still moves state on a
    // legal transition — so what blocks is exactly the two rejections.
    expect(byId.get(`${ENDPOINT}:workflow:transition-allowed`)?.verdict, truth.join('\n')).toBe('satisfied');
    for (const id of [`${ENDPOINT}:workflow:transition-rejected`, `${ENDPOINT}:workflow:terminal-immutable`]) {
      const verdict = byId.get(id);
      expect(verdict, `${id} is missing from the report:\n${truth.join('\n')}`).toBeDefined();
      expect(verdict?.verdict, truth.join('\n')).toBe('invalid');
      expect(verdict?.reason, truth.join('\n')).toContain('BEHAVIOR_EFFECT_MISMATCH');
    }
    // …and the engine's own after-snapshot shows the state DID move: the
    // guard-less app advanced the signed contract and resurrected the
    // terminated one. The block is not a status quibble.
    const illegal = engineReadStatus(records, caseIdOf('illegal-transition'), 'wf-1');
    expect(illegal.before).toBe('signed');
    expect(illegal.after).not.toBe(illegal.before);
    const terminal = engineReadStatus(records, caseIdOf('terminal-write'), 'wf-2');
    expect(terminal.before).toBe('terminated');
    expect(terminal.after).not.toBe('terminated');
    expect(report.summary.blocking, truth.join('\n')).toBeGreaterThan(0);
    expect(run.code, `stdout:\n${run.stdout}\nstderr:\n${run.stderr}`).not.toBe(0);
    expect(check.code, `stdout:\n${check.stdout}\nstderr:\n${check.stderr}`).not.toBe(0);
  }, 300_000);
});
