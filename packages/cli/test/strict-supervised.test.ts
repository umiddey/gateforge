/**
 * Strict supervised end-to-end (plan 2026-09-13 Phase 4 + Phase 1 item 4,
 * the REQUIRED positive case): a genuine browser journey passes through
 * the real application, the engine-owned browser observer, the strict
 * supervised CLI (`test-gates --changed`), receipt verification
 * (`check --changed --require-e2e`), and the exact-candidate commit
 * check — while fabricated executions fail at every layer.
 *
 * Everything is real: temp fixture repo (git), the example app + the
 * attestation proxy, the witness the CLI spawns itself, the pinned
 * Playwright with trusted-config synthesis, and the engine Chromium the
 * witness drives. No mocks in the evidence path.
 */
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { withTempRepo, type TempRepo } from '@gate-forge/core';
import { startAttestationProxy, startWitnessProcess } from '@gate-forge/pack-playwright';
import { trustedPolicyDigestForConfig } from '../src/execution.js';
import { loadConfigAt, VERIFIER_KEY_FILE_ENV } from '../src/commands/common.js';
import { currentInputDigest, runCli as runWorkspaceCli } from './helpers.js';
import { computeCandidateTreeId, resolveGitDir } from '../src/candidate-tree.js';
import { loadDocsExclusions } from '../src/docs-exclusions.js';

/** Repo root (example app + surface descriptor live here). */
const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
/** The env fingerprint the attestation proxy stamps. */
const FINGERPRINT = 'example-v1';
const verifierKeyDirectories: string[] = [];

/**
 * Computes the SHA-256 digest of one persisted state file.
 *
 * Args:
 *   path: absolute path to the file.
 *
 * Returns:
 *   string: lowercase SHA-256 hexadecimal digest.
 */
function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/** Runs the workspace CLI in-process or an explicitly provisioned physical CLI package.
 *
 * Args:
 *   repo: disposable Git repository used by the test.
 *   argv: CLI command and arguments.
 *   env: operator values to add or remove from the child environment.
 *
 * Returns:
 *   Promise<{ code: number; stdout: string; stderr: string }>: process result.
 */
async function runSupervisedCli(
  repo: TempRepo,
  argv: readonly string[],
  env: Record<string, string | undefined> = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  const physicalBin = process.env['GATEFORGE_PHYSICAL_CLI_BIN'];
  if (physicalBin === undefined) return runWorkspaceCli(repo, argv, env);
  const childEnv: NodeJS.ProcessEnv = { ...process.env };
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete childEnv[key];
    else childEnv[key] = value;
  }
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [physicalBin, ...argv], {
      cwd: repo.root,
      env: childEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.once('error', reject);
    child.once('exit', (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

afterEach(() => {
  for (const directory of verifierKeyDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const DETECTOR = `// Fixture detector: the accounts business resource plus the
// compiled http.endpoint inventory the crud route attribution needs.
export default {
  async discover() {
    const routes = [
      ['POST /accounts', 'POST', '/accounts'],
      ['POST /accounts/{}', 'POST', '/accounts/{}'],
      ['POST /accounts/{}/archive', 'POST', '/accounts/{}/archive'],
      ['GET /accounts/{}/edit', 'GET', '/accounts/{}/edit'],
    ];
    const resources = [{
      schemaVersion: 1,
      id: 'accounts',
      kind: 'fixture.entity',
      source: 'src/accounts.js',
      location: { file: 'src/accounts.js', line: 1, col: 0 },
      detectorVersion: '1.0.0',
      attributes: { resourceName: 'accounts', updateableFields: ['first_name', 'last_name', 'status'] },
    }];
    const classificationSignals = [
      { schemaVersion: 1, target: { resourceName: "accounts" }, dimension: "plane", assertion: "tenant", basis: "declaration", source: "gateforge.fixture", location: { file: "src/accounts.js", line: 1, col: 0 }, detector: { id: "gateforge.fixture", version: "1.0.0" } },
      { schemaVersion: 1, target: { resourceName: "accounts" }, dimension: "identity", assertion: ["id"], basis: "declaration", source: "gateforge.fixture", location: { file: "src/accounts.js", line: 1, col: 0 }, detector: { id: "gateforge.fixture", version: "1.0.0" } },
      { schemaVersion: 1, target: { resourceName: "accounts" }, dimension: "adapter-binding", assertion: "tenant.accounts", basis: "declaration", source: "gateforge.fixture", location: { file: "src/accounts.js", line: 1, col: 0 }, detector: { id: "gateforge.fixture", version: "1.0.0" } },
      { schemaVersion: 1, target: { resourceName: "accounts" }, dimension: "lifecycle.create", assertion: true, basis: "declaration", source: "gateforge.fixture", location: { file: "src/accounts.js", line: 1, col: 0 }, detector: { id: "gateforge.fixture", version: "1.0.0" } },
      { schemaVersion: 1, target: { resourceName: "accounts" }, dimension: "lifecycle.read", assertion: true, basis: "declaration", source: "gateforge.fixture", location: { file: "src/accounts.js", line: 1, col: 0 }, detector: { id: "gateforge.fixture", version: "1.0.0" } },
      { schemaVersion: 1, target: { resourceName: "accounts" }, dimension: "lifecycle.update", assertion: true, basis: "declaration", source: "gateforge.fixture", location: { file: "src/accounts.js", line: 1, col: 0 }, detector: { id: "gateforge.fixture", version: "1.0.0" } },
      { schemaVersion: 1, target: { resourceName: "accounts" }, dimension: "lifecycle.delete", assertion: true, basis: "declaration", source: "gateforge.fixture", location: { file: "src/accounts.js", line: 1, col: 0 }, detector: { id: "gateforge.fixture", version: "1.0.0" } },
      { schemaVersion: 1, target: { resourceName: "accounts" }, dimension: "delete-semantics", assertion: "archive", basis: "declaration", source: "gateforge.fixture", location: { file: "src/accounts.js", line: 1, col: 0 }, detector: { id: "gateforge.fixture", version: "1.0.0" } },
      { schemaVersion: 1, target: { resourceName: "accounts" }, dimension: "archive-state", assertion: { status: "archived" }, basis: "declaration", source: "gateforge.fixture", location: { file: "src/accounts.js", line: 1, col: 0 }, detector: { id: "gateforge.fixture", version: "1.0.0" } },
    ];
    for (const [name, method, canonicalPath] of routes) {
      resources.push({
        schemaVersion: 1,
        id: 'http.endpoint:' + name,
        kind: 'http.endpoint',
        source: 'src/accounts.js',
        location: { file: 'src/accounts.js', line: 1, col: 0 },
        detectorVersion: '1.0.0',
        attributes: { resourceName: name, method, canonicalPath, identity: method + ' ' + canonicalPath, linkedResourceName: 'accounts' },
      });
      classificationSignals.push(
        { schemaVersion: 1, target: { resourceName: name }, dimension: "identity", assertion: ["method", "path"], basis: "declaration", source: "gateforge.fixture", location: { file: "src/accounts.js", line: 1, col: 0 }, detector: { id: "gateforge.fixture", version: "1.0.0" } },
      );
    }
    return { resources, unresolved: [], findings: [], classificationSignals };
  },
};
`;

const ADAPTER = `// Reviewed evidence adapter for tenant.accounts (GET-only).
export default {
  async read(ctx, id) {
    const res = await ctx.get('/api/accounts/' + encodeURIComponent(String(id)));
    if (res.status === 404) return null;
    if (res.status !== 200) throw new Error('adapter read failed: HTTP ' + res.status);
    return res.json();
  },
  async list(ctx) {
    const res = await ctx.get('/api/accounts');
    if (res.status !== 200) throw new Error('adapter list failed: HTTP ' + res.status);
    const body = await res.json();
    return body.accounts;
  },
  normalize(body) {
    return {
      entityId: body.id,
      fields: { first_name: body.first_name, last_name: body.last_name, status: body.status },
    };
  },
  deletion: 'archive',
  environmentFingerprint: '${FINGERPRINT}',
};
`;

const SPEC = `import { test as gateforgeTest, expect } from '@gate-forge/pack-playwright';
import { accountsSurface } from './accounts-surface.js';

const test = gateforgeTest.extend({ surface: accountsSurface });

test.beforeEach(() => {
  expect(process.env.GATEFORGE_WITNESS_VERIFIER_KEY).toBeUndefined();
  expect(process.env.GATEFORGE_WITNESS_VERIFIER_KEY_FILE).toBeUndefined();
});

let createdId = '';

test('creates an account through the rendered UI', {
  annotation: { type: 'gateforge', description: 'tenant.accounts:crud:create' },
}, async ({ evidence }) => {
  const receipt = await evidence.ui.create({ fields: { first_name: 'Ada', last_name: 'Lovelace' } });
  createdId = receipt.entityId;
  await evidence.visible.confirm(receipt);
  await evidence.http.observe({ method: 'POST', path: '/accounts' });
  const outcome = await evidence.persistence.verify(receipt);
  expect(outcome.verdictRelevant.fieldsMatch, JSON.stringify(outcome.verdictRelevant)).toBe(true);
  await evidence.finalize();
});

test('updates the account through the rendered UI', {
  annotation: { type: 'gateforge', description: 'tenant.accounts:crud:update' },
}, async ({ evidence }) => {
  const receipt = await evidence.ui.update({ entityId: createdId, fields: { first_name: 'Ada King', last_name: 'Lovelace' } });
  await evidence.visible.confirm(receipt);
  await evidence.http.observe({ method: 'POST', path: '/accounts/' + createdId });
  const outcome = await evidence.persistence.verify(receipt);
  expect(outcome.verdictRelevant.fieldsMatch, JSON.stringify(outcome.verdictRelevant)).toBe(true);
  await evidence.finalize();
});

test('archives the account through the rendered UI', {
  annotation: { type: 'gateforge', description: 'tenant.accounts:crud:delete' },
}, async ({ evidence }) => {
  const receipt = await evidence.ui.archive({ entityId: createdId });
  await evidence.visible.confirm(receipt);
  await evidence.http.observe({ method: 'POST', path: '/accounts/' + createdId + '/archive' });
  const outcome = await evidence.persistence.verify(receipt);
  expect(outcome.verdictRelevant.fieldsMatch, JSON.stringify(outcome.verdictRelevant)).toBe(true);
  await evidence.finalize();
});
`;

/**
 * E02 fixture: the SAME three journeys, but the UI flow is hidden behind
 * local helpers and NO test carries a gateforge annotation. Static
 * inference can see the browser fixture but can never derive the claims
 * — only the agent's `.gateforge/test-map.yml` declaration (written by
 * the real `tests mark`) names what these existing tests cover.
 */
const JOURNEYS_SPEC = `import { test as gateforgeTest } from '@gate-forge/pack-playwright';
import { accountsSurface } from './accounts-surface.js';
import { createJourney, updateJourney, archiveJourney } from './journey-helpers.js';

const test = gateforgeTest.extend({ surface: accountsSurface });

let createdId = '';

test('creates accounts rows through the shared journey helper', async ({ evidence }) => {
  createdId = await createJourney(evidence, { first_name: 'Grace', last_name: 'Hopper' });
});

test('updates accounts rows through the shared journey helper', async ({ evidence }) => {
  await updateJourney(evidence, createdId, { first_name: 'Grace Lee', last_name: 'Hopper' });
});

test('archives accounts rows through the shared journey helper', async ({ evidence }) => {
  await archiveJourney(evidence, createdId);
});
`;

const JOURNEY_HELPERS = `// The UI flow lives here: static inference sees no claims and no UI
// operations — only a mapping declaration (and then the witnessed run)
// can say what these journeys cover. The assertions below are the
// journeys' own; the helpers are ordinary consumer test code.
export async function createJourney(evidence, fields) {
  const receipt = await evidence.ui.create({ fields });
  await evidence.visible.confirm(receipt);
  await evidence.http.observe({ method: 'POST', path: '/accounts' });
  const outcome = await evidence.persistence.verify(receipt);
  if (!outcome.verdictRelevant.fieldsMatch) {
    throw new Error('persisted fields do not echo the entered input: ' + JSON.stringify(outcome.verdictRelevant));
  }
  await evidence.finalize();
  return receipt.entityId;
}

export async function updateJourney(evidence, entityId, fields) {
  const receipt = await evidence.ui.update({ entityId, fields });
  await evidence.visible.confirm(receipt);
  await evidence.http.observe({ method: 'POST', path: '/accounts/' + entityId });
  const outcome = await evidence.persistence.verify(receipt);
  if (!outcome.verdictRelevant.fieldsMatch) {
    throw new Error('persisted fields do not echo the entered input: ' + JSON.stringify(outcome.verdictRelevant));
  }
  await evidence.finalize();
}

export async function archiveJourney(evidence, entityId) {
  const receipt = await evidence.ui.archive({ entityId });
  await evidence.visible.confirm(receipt);
  await evidence.http.observe({ method: 'POST', path: '/accounts/' + entityId + '/archive' });
  const outcome = await evidence.persistence.verify(receipt);
  if (!outcome.verdictRelevant.fieldsMatch) {
    throw new Error('archive did not persist the expected state: ' + JSON.stringify(outcome.verdictRelevant));
  }
  await evidence.finalize();
}
`;

/**
 * The E05 Phase-B suite: the SAME fixture suite plus one REAL new journey
 * covering the previously uncovered read behavior — it drives the
 * rendered UI through the engine browser (row → edit link click →
 * rendered form readback), confirms the visible result, observes the
 * real GET exchange, and verifies persistence on the same entity.
 */
const SPEC_WITH_READ = `import { test as gateforgeTest, expect } from '@gate-forge/pack-playwright';
import { accountsSurface } from './accounts-surface.js';

const test = gateforgeTest.extend({ surface: accountsSurface });

let createdId = '';

test('creates an account through the rendered UI', {
  annotation: { type: 'gateforge', description: 'tenant.accounts:crud:create' },
}, async ({ evidence }) => {
  const receipt = await evidence.ui.create({ fields: { first_name: 'Ada', last_name: 'Lovelace' } });
  createdId = receipt.entityId;
  await evidence.visible.confirm(receipt);
  await evidence.http.observe({ method: 'POST', path: '/accounts' });
  const outcome = await evidence.persistence.verify(receipt);
  expect(outcome.verdictRelevant.fieldsMatch, JSON.stringify(outcome.verdictRelevant)).toBe(true);
  await evidence.finalize();
});

test('reads the account through the rendered UI', {
  annotation: { type: 'gateforge', description: 'tenant.accounts:crud:read' },
}, async ({ evidence }) => {
  const receipt = await evidence.ui.read({ entityId: createdId });
  await evidence.visible.confirm(receipt);
  await evidence.http.observe({ method: 'GET', path: '/accounts/' + createdId + '/edit' });
  const outcome = await evidence.persistence.verify(receipt);
  expect(outcome.verdictRelevant.fieldsMatch, JSON.stringify(outcome.verdictRelevant)).toBe(true);
  await evidence.finalize();
});

test('updates the account through the rendered UI', {
  annotation: { type: 'gateforge', description: 'tenant.accounts:crud:update' },
}, async ({ evidence }) => {
  const receipt = await evidence.ui.update({ entityId: createdId, fields: { first_name: 'Ada King', last_name: 'Lovelace' } });
  await evidence.visible.confirm(receipt);
  await evidence.http.observe({ method: 'POST', path: '/accounts/' + createdId });
  const outcome = await evidence.persistence.verify(receipt);
  expect(outcome.verdictRelevant.fieldsMatch, JSON.stringify(outcome.verdictRelevant)).toBe(true);
  await evidence.finalize();
});

test('archives the account through the rendered UI', {
  annotation: { type: 'gateforge', description: 'tenant.accounts:crud:delete' },
}, async ({ evidence }) => {
  const receipt = await evidence.ui.archive({ entityId: createdId });
  await evidence.visible.confirm(receipt);
  await evidence.http.observe({ method: 'POST', path: '/accounts/' + createdId + '/archive' });
  const outcome = await evidence.persistence.verify(receipt);
  expect(outcome.verdictRelevant.fieldsMatch, JSON.stringify(outcome.verdictRelevant)).toBe(true);
  await evidence.finalize();
});
`;

/**
 * Explicit sidecar mapping for the staged/full pre-commit fixture: the
 * three annotated journeys are ALSO declared through the tracked sidecar
 * so changed-scope planning can resolve a testable slice BEFORE any run
 * (scoped planning binds declared sidecar/native bindings only — a fresh
 * materialized checkout has no prior-run claims to borrow).
 */
const TEST_MAP_YML = `schemaVersion: 1
tests:
  - key: playwright:chromium:specs/crud.spec.js:creates an account through the rendered UI
    selector:
      runner: playwright
      project: chromium
      file: specs/crud.spec.js
      titlePath:
        - creates an account through the rendered UI
    kind: browser-e2e
    categories:
      - persistence.create
    claims:
      - tenant.accounts:crud:create
    reason: The journey creates an account through the rendered UI and verifies persistence.
  - key: playwright:chromium:specs/crud.spec.js:updates the account through the rendered UI
    selector:
      runner: playwright
      project: chromium
      file: specs/crud.spec.js
      titlePath:
        - updates the account through the rendered UI
    kind: browser-e2e
    categories:
      - persistence.update
    claims:
      - tenant.accounts:crud:update
    reason: The journey updates the account through the rendered UI and verifies persistence.
  - key: playwright:chromium:specs/crud.spec.js:archives the account through the rendered UI
    selector:
      runner: playwright
      project: chromium
      file: specs/crud.spec.js
      titlePath:
        - archives the account through the rendered UI
    kind: browser-e2e
    categories:
      - persistence.delete
    claims:
      - tenant.accounts:crud:delete
    reason: The journey archives the account through the rendered UI and verifies persistence.
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

const GATEFORGE_YML = `schemaVersion: 1
project:
  languages: [javascript]
  paths: { include: ['src/**', 'specs/**'], exclude: [] }
plugins:
  - id: gateforge.fixture
    version: 1.0.0
    transport: in-process
    module: ./.gateforge/fixture-detector.mjs
policies: .gateforge/policies.yml
classificationPolicy: .gateforge/classification-policy.yml
adapters: .gateforge/adapters
waivers: .gateforge/waivers
baselines: .gateforge/baselines/obligations.json
changed: { provider: auto }
witness: { maxDurationSeconds: 5 }
clock: { mode: fixed, fixedAt: '2026-01-01T00:00:00.000Z' }
`;

const POLICIES_YML = `schemaVersion: 1
policies:
  - id: crud
    when: {}
    require: [crud:create, crud:update, crud:delete]
`;

const CLASSIFICATION_POLICY_YML = `schemaVersion: 1
scanRoots: ['src/**']
trustedInternalEntryPoints: []
internalRules: []
declarations:
  internality: gateforge:internal
volatileFields: []
`;

/** Starts the example app as a child; resolves its loopback URL. */
async function startApp(): Promise<{ url: string; stop: () => void }> {
  const child = spawn(process.execPath, [join(ROOT, 'example/server.js')], {
    cwd: join(ROOT, 'example'),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  const url = await new Promise<string>((resolveUrl, rejectUrl) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      rejectUrl(new Error('example app did not report its URL in time'));
    }, 15_000);
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
      const match = /listening on (http:\/\/\S+)/.exec(stdout);
      if (match !== null) {
        clearTimeout(timer);
        resolveUrl(match[1] as string);
      }
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      rejectUrl(error);
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      rejectUrl(new Error(`example app exited early (code ${String(code)}): ${stdout}`));
    });
  });
  return { url, stop: () => child.kill('SIGTERM') };
}

/** Installs the strict supervised fixture into a fresh repo. */
function installStrictFixture(
  repo: TempRepo,
  specFiles: Record<string, string> = { 'specs/crud.spec.js': SPEC },
): void {
  repo.writeFiles({
    '.gateforge.yml': GATEFORGE_YML,
    '.gateforge/fixture-detector.mjs': DETECTOR,
    '.gateforge/policies.yml': POLICIES_YML,
    '.gateforge/classification-policy.yml': CLASSIFICATION_POLICY_YML,
    '.gateforge/adapters/tenant.accounts.mjs': ADAPTER,
    '.gateforge/baselines/obligations.json': `${JSON.stringify({ schemaVersion: 1, fingerprints: [] }, null, 2)}\n`,
    'src/accounts.js': '// fixture source: the accounts resource lives here.\n',
    'specs/accounts-surface.js': readFileSync(join(ROOT, 'example/e2e/accounts-surface.js'), 'utf8'),
    'playwright.config.mjs': PLAYWRIGHT_CONFIG,
    'package.json': `${JSON.stringify({ type: 'module' }, null, 2)}\n`,
    '.gitignore': ['node_modules', 'test-results', 'playwright-report', '.playwright', '.gateforge/test-gates', ''].join('\n'),
    ...specFiles,
  });
  // Specs resolve the workspace pack + playwright through the monorepo
  // modules (consumers would install them; the fixture links them).
  symlinkSync(
    process.env['GATEFORGE_PHYSICAL_NODE_MODULES'] ?? join(ROOT, 'node_modules'),
    join(repo.root, 'node_modules'),
    'dir',
  );
}

describe('strict supervised gate (test-gates --changed + receipt + check)', () => {
  it('a genuine engine-browser journey passes the strict gate and seals a verifying receipt', async () => {
    // The OPERATOR environment (external verifier key ring + approved pin + app base)
    // lives outside the candidate and is inherited by hooks: set it on
    // process.env BEFORE the repo exists so every git child inherits it,
    // and restore it after (production shells provide it the same way).
    const keyDirectory = mkdtempSync(join(tmpdir(), 'gateforge-strict-verifier-'));
    verifierKeyDirectories.push(keyDirectory);
    const keyFile = join(keyDirectory, 'keys.json');
    const verifierKey = 'strict-supervised-verifier-key';
    writeFileSync(
      keyFile,
      `${JSON.stringify({ schemaVersion: 1, activeKeyId: 'strict-key', keys: { 'strict-key': verifierKey } })}\n`,
      { mode: 0o600 },
    );
    const operatorEnv: Record<string, string> = {
      [VERIFIER_KEY_FILE_ENV]: keyFile,
      GATEFORGE_APPROVED_POLICY_DIGEST: 'pending-pin-computation',
    };
    const savedOperator: Record<string, string | undefined> = {};
    const setOperator = (values: Record<string, string>): void => {
      for (const [key, value] of Object.entries(values)) {
        if (!(key in savedOperator)) savedOperator[key] = process.env[key];
        process.env[key] = value;
      }
    };
    const restoreOperator = (): void => {
      for (const [key, value] of Object.entries(savedOperator)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    };
    setOperator(operatorEnv);
    try {
      await withTempRepo({}, async (repo) => {
        repo.writeFiles({
          'docs/guide.md': '# approved content version: 1\n',
          'manuals/guide.md': '# unapproved content version: 1\n',
        });
        const documentReadingSpec = `import { readFileSync } from 'node:fs';\n${SPEC}`.replace(
          "test.beforeEach(() => {",
          "test.beforeEach(() => {\n  expect(readFileSync('docs/guide.md', 'utf8')).toContain('approved content version: 1');",
        );
        installStrictFixture(repo, { 'specs/crud.spec.js': documentReadingSpec });
        repo.git(['add', '-A']);
        repo.git(['commit', '--no-gpg-sign', '--quiet', '-m', 'strict fixture']);
        // The blocking hook is installed after the base commit (the base
        // itself carries no receipt yet) but BEFORE the run, so its own
        // files are part of the tree the receipt later binds.
        const initEnv: Record<string, string> = {
          [VERIFIER_KEY_FILE_ENV]: keyFile,
        };
        setOperator(initEnv);
        const hooked = await runSupervisedCli(repo, ['init', '--blocking', '--docs-exclude', 'docs'], initEnv);
        expect(hooked.code, `init stdout:\n${hooked.stdout}\nstderr:\n${hooked.stderr}`).toBe(0);
        // The genuine candidate change under test (a comment-only edit to
        // the resource source — obligations still bind it).
        repo.writeFiles({ 'src/accounts.js': '// fixture source: the accounts resource lives here.\n// change: audited comment.\n' });
        const app = await startApp();
      const proxy = await startAttestationProxy(app.url, FINGERPRINT);
      try {
        // The owner-approved policy pin: computed from the trusted
        // revision OUTSIDE the candidate flow and provisioned as the
        // protected variable (deployment: CI protected variable).
        const config = loadConfigAt(repo.root);
        const pin = trustedPolicyDigestForConfig(repo.root, config);
        const docsExclusions = loadDocsExclusions(repo.root, config);
        expect(docsExclusions).toEqual(['docs']);
        const env: Record<string, string> = {
          [VERIFIER_KEY_FILE_ENV]: keyFile,
          GATEFORGE_APP_BASE_URL: proxy.url,
          GATEFORGE_TARGET_BASE_URL: proxy.url,
          GATEFORGE_TARGET_FINGERPRINT: FINGERPRINT,
          GATEFORGE_APPROVED_POLICY_DIGEST: pin,
        };
        setOperator(env);
        const wrongPin = await runSupervisedCli(repo, ['test-gates', '--changed', '--format', 'json'], {
          [VERIFIER_KEY_FILE_ENV]: keyFile,
          GATEFORGE_APPROVED_POLICY_DIGEST: '0'.repeat(64),
        });
        expect(wrongPin.code).toBe(1);
        expect(wrongPin.stderr).toContain('ENFORCEMENT_UNTRUSTED');
        expect(existsSync(join(repo.root, '.gateforge/test-gates/receipt.json'))).toBe(false);
        const gated = await runSupervisedCli(repo, ['test-gates', '--changed', '--format', 'json'], env);
        expect(gated.code, `test-gates stdout:\n${gated.stdout}\nstderr:\n${gated.stderr}`).toBe(0);
        const report = JSON.parse(gated.stdout) as {
          summary: { obligations: number; blocking: number };
          verdicts: Array<{ obligationId: string; verdict: string }>;
          diagnosticContext: {
            docsExclusions: {
              folders: string[];
              approvalDigest: string | null;
              approvalStatus: string;
              guarantee: string;
            };
          };
        };
        expect(report.summary.blocking).toBe(0);
        expect(report.diagnosticContext.docsExclusions).toEqual({
          folders: ['docs'],
          approvalDigest: pin,
          approvalStatus: 'matched',
          guarantee: expect.stringContaining('app/test read can make old evidence look valid'),
        });
        for (const id of [
          'tenant.accounts:crud:create',
          'tenant.accounts:crud:update',
          'tenant.accounts:crud:delete',
        ]) {
          expect(report.verdicts.find((entry) => entry.obligationId === id)?.verdict).toBe('satisfied');
        }
        // The sealed receipt exists and verifies under the same pin.
        const receiptRaw = readFileSync(join(repo.root, '.gateforge/test-gates/receipt.json'), 'utf8');
        expect(receiptRaw).toContain('"approvedPolicyDigest"');
        const originalReceipt = JSON.parse(receiptRaw) as {
          receiptId: string;
          runId: string;
          inputDigest: string;
          candidateTreeId: string;
        };
        const rotated = await runSupervisedCli(repo, ['key', 'rotate', '--file', keyFile, '--confirm'], env);
        expect(rotated.code, `key rotate stderr:\n${rotated.stderr}`).toBe(0);
        const persistentKeyCheck = await runSupervisedCli(repo, ['check', '--require-e2e', '--format', 'json'], env);
        expect(persistentKeyCheck.code, `rotated-key check:\n${persistentKeyCheck.stdout}`).toBe(0);
        const missingKeyCheck = await runSupervisedCli(repo, ['check', '--require-e2e', '--format', 'json'], {
          [VERIFIER_KEY_FILE_ENV]: undefined,
          GATEFORGE_WITNESS_VERIFIER_KEY: undefined,
        });
        expect(missingKeyCheck.code).toBe(1);
        expect(missingKeyCheck.stdout).toContain('ENFORCEMENT_UNTRUSTED');
        const savedStateDirectory = join(repo.root, '.gateforge/test-gates');
        const savedState = readdirSync(savedStateDirectory, { withFileTypes: true })
          .filter((entry) => entry.isFile())
          .map((entry) => readFileSync(join(savedStateDirectory, entry.name), 'utf8'))
          .join('\n');
        expect(savedState).not.toContain(verifierKey);
        expect(savedState).not.toContain(keyFile);
        const gitDir = resolveGitDir(repo.root, process.env);
        if (gitDir === null) throw new Error('test repository has no Git directory');
        const originalTree = computeCandidateTreeId(
          gitDir,
          repo.root,
          process.env,
          join(repo.root, '.gateforge/test-gates'),
          'record',
          [],
          docsExclusions,
        );
        expect(originalReceipt.candidateTreeId).toBe(originalTree);

        const unapprovedDocPath = 'manuals/guide.md';
        repo.writeFiles({ [unapprovedDocPath]: '# unapproved content version: 2\n' });
        const unapprovedDigest = await currentInputDigest(repo, docsExclusions);
        expect(unapprovedDigest).not.toBe(originalReceipt.inputDigest);
        const unapprovedCheck = await runSupervisedCli(
          repo,
          ['check', '--changed', '--require-e2e', '--format', 'json'],
          env,
        );
        expect(unapprovedCheck.code).toBe(1);
        expect(unapprovedCheck.stdout).toContain('EVIDENCE_STALE');
        expect(unapprovedCheck.stdout).toContain(unapprovedDocPath);
        repo.writeFiles({ [unapprovedDocPath]: '# unapproved content version: 1\n' });
        const restoredCheck = await runSupervisedCli(
          repo,
          ['check', '--changed', '--require-e2e', '--format', 'json'],
          env,
        );
        expect(restoredCheck.code).toBe(0);

        const approvedDocPath = 'docs/guide.md';
        repo.writeFiles({ [approvedDocPath]: '# approved content version: 2\n' });
        const unchangedDigest = await currentInputDigest(repo, docsExclusions);
        expect(unchangedDigest).toBe(originalReceipt.inputDigest);
        const unchangedTree = computeCandidateTreeId(
          gitDir,
          repo.root,
          process.env,
          join(repo.root, '.gateforge/test-gates'),
          'record',
          [],
          docsExclusions,
        );
        expect(unchangedTree).toBe(originalTree);
        const receiptBeforeDocsCheck = readFileSync(join(repo.root, '.gateforge/test-gates/receipt.json'), 'utf8');
        const approvedDocCheck = await runSupervisedCli(
          repo,
          ['check', '--changed', '--require-e2e', '--format', 'json'],
          env,
        );
        expect(approvedDocCheck.code, `check stdout:\n${approvedDocCheck.stdout}\nstderr:\n${approvedDocCheck.stderr}`).toBe(0);
        const approvedReport = JSON.parse(approvedDocCheck.stdout) as {
          diagnosticContext: {
            docsExclusions: {
              folders: string[];
              approvalDigest: string | null;
              approvalStatus: string;
              guarantee: string;
            };
          };
        };
        expect(approvedReport.diagnosticContext.docsExclusions).toEqual({
          folders: ['docs'],
          approvalDigest: pin,
          approvalStatus: 'matched',
          guarantee: expect.stringContaining('app/test read can make old evidence look valid'),
        });
        expect(readFileSync(join(repo.root, '.gateforge/test-gates/receipt.json'), 'utf8')).toBe(receiptBeforeDocsCheck);

        for (const unsafeDocumentationPath of ['docs/component.mdx', 'docs/module.wasm']) {
          repo.writeFiles({ [unsafeDocumentationPath]: 'executable content is not documentation-only\n' });
          const unsafeDocumentationCheck = await runSupervisedCli(
            repo,
            ['check', '--changed', '--require-e2e', '--format', 'json'],
            env,
          );
          expect(unsafeDocumentationCheck.code, `${unsafeDocumentationCheck.stdout}\n${unsafeDocumentationCheck.stderr}`).toBe(2);
          expect(`${unsafeDocumentationCheck.stdout}\n${unsafeDocumentationCheck.stderr}`).toContain(unsafeDocumentationPath);
          rmSync(repo.path(unsafeDocumentationPath));
        }

        const approvedDeclarationPath = repo.path('.gateforge/docs-exclusions.yml');
        const approvedDeclaration = readFileSync(approvedDeclarationPath, 'utf8');
        repo.writeFiles({ '.gateforge/docs-exclusions.yml': `${approvedDeclaration}# approval changed\n` });
        const approvalDriftCheck = await runSupervisedCli(
          repo,
          ['check', '--changed', '--require-e2e', '--format', 'json'],
          env,
        );
        expect(approvalDriftCheck.code).toBe(1);
        expect(approvalDriftCheck.stdout).toContain('ENFORCEMENT_UNTRUSTED');
        expect(approvalDriftCheck.stdout).toContain('"approvalStatus":"mismatch"');
        repo.writeFiles({ '.gateforge/docs-exclusions.yml': approvedDeclaration });
        const approvalRestoredCheck = await runSupervisedCli(
          repo,
          ['check', '--changed', '--require-e2e', '--format', 'json'],
          env,
        );
        expect(approvalRestoredCheck.code).toBe(0);

        // The browser tests read docs/guide.md and would fail if Gateforge
        // ran them again. The owner assertion deliberately accepts this risk.
        repo.writeFiles({ 'src/accounts.js': '// fixture source changed after evidence.\n' });
        const changedSourceCheck = await runSupervisedCli(
          repo,
          ['check', '--changed', '--require-e2e', '--format', 'json'],
          env,
        );
        expect(changedSourceCheck.code).toBe(1);
        expect(changedSourceCheck.stdout).toContain('EVIDENCE_STALE');
        repo.writeFiles({
          'src/accounts.js': '// fixture source: the accounts resource lives here.\n// change: audited comment.\n',
        });

        const originalPolicies = readFileSync(repo.path('.gateforge/policies.yml'), 'utf8');
        repo.writeFiles({ '.gateforge/policies.yml': `${originalPolicies}\n# gate policy changed\n` });
        const changedPolicyCheck = await runSupervisedCli(
          repo,
          ['check', '--changed', '--require-e2e', '--format', 'json'],
          env,
        );
        expect(changedPolicyCheck.code).toBe(1);
        expect(changedPolicyCheck.stdout).toContain('ENFORCEMENT_UNTRUSTED');
        repo.writeFiles({ '.gateforge/policies.yml': originalPolicies });

        const finalCheck = await runSupervisedCli(
          repo,
          ['check', '--changed', '--require-e2e', '--format', 'json'],
          env,
        );
        expect(finalCheck.code).toBe(0);

        // check --require-e2e accepts only the newly sealed exact candidate.
        const checked = await runSupervisedCli(repo, ['check', '--changed', '--require-e2e', '--format', 'json'], env);
        expect(checked.code, `check stdout:\n${checked.stdout}\nstderr:\n${checked.stderr}`).toBe(0);
        // Exact-candidate commit check: the check-only hook must reject
        // this worktree receipt when the staged Git tree differs.
        repo.git(['add', '-A']);
        const committed = repo.git(
          ['commit', '--no-gpg-sign', '--quiet', '-m', 'genuine engine-browser change'],
          { allowFailure: true, env: { GATEFORGE_APPROVED_POLICY_DIGEST: pin } },
        );
        expect(committed.status, `commit stderr:\n${committed.stderr}`).not.toBe(0);
        expect(committed.stderr).toContain('EVIDENCE_STALE');
      } finally {
        await proxy.stop();
        app.stop();
      }
      });
    } finally {
      restoreOperator();
    }
  }, 600_000);

  it('a helper-based journey mapped through the sidecar passes the strict gate (E02)', async () => {
    // The OPERATOR environment (verifier key + approved pin + app base)
    // lives outside the candidate (same provisioning as the native test).
    const operatorEnv: Record<string, string> = {
      GATEFORGE_WITNESS_VERIFIER_KEY: 'strict-supervised-verifier-key',
      GATEFORGE_APPROVED_POLICY_DIGEST: 'pending-pin-computation',
    };
    const savedOperator: Record<string, string | undefined> = {};
    const setOperator = (values: Record<string, string>): void => {
      for (const [key, value] of Object.entries(values)) {
        if (!(key in savedOperator)) savedOperator[key] = process.env[key];
        process.env[key] = value;
      }
    };
    const restoreOperator = (): void => {
      for (const [key, value] of Object.entries(savedOperator)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    };
    setOperator(operatorEnv);
    const JOURNEYS = [
      {
        title: 'creates accounts rows through the shared journey helper',
        category: 'persistence.create',
        obligation: 'tenant.accounts:crud:create',
      },
      {
        title: 'updates accounts rows through the shared journey helper',
        category: 'persistence.update',
        obligation: 'tenant.accounts:crud:update',
      },
      {
        title: 'archives accounts rows through the shared journey helper',
        category: 'persistence.delete',
        obligation: 'tenant.accounts:crud:delete',
      },
    ];
    try {
      await withTempRepo({}, async (repo) => {
        installStrictFixture(repo, {
          'specs/journeys.spec.js': JOURNEYS_SPEC,
          'specs/journey-helpers.js': JOURNEY_HELPERS,
        });
        repo.git(['add', '-A']);
        repo.git(['commit', '--no-gpg-sign', '--quiet', '-m', 'helper fixture']);
        // The genuine candidate change under test.
        repo.writeFiles({ 'src/accounts.js': '// fixture source: the accounts resource lives here.\n// change: audited comment.\n' });
        const app = await startApp();
        const proxy = await startAttestationProxy(app.url, FINGERPRINT);
        try {
          const config = loadConfigAt(repo.root);
          const env: Record<string, string> = {
            GATEFORGE_WITNESS_VERIFIER_KEY: 'strict-supervised-verifier-key',
            GATEFORGE_APP_BASE_URL: proxy.url,
            GATEFORGE_TARGET_BASE_URL: proxy.url,
            GATEFORGE_TARGET_FINGERPRINT: FINGERPRINT,
          };
          setOperator(env);

          // (1) UNRESOLVED DISCOVERY: the helper-based journeys are
          // enumerated (the original tests exist) but no annotation and
          // no code signal names what they cover — coverage is unresolved.
          const discovered = await runSupervisedCli(repo, ['tests', 'discover', '--json'], env);
          expect(discovered.code, `discover stdout:\n${discovered.stdout}\nstderr:\n${discovered.stderr}`).toBe(0);
          const catalog = JSON.parse(discovered.stdout) as {
            inventoryComplete: boolean;
            entries: Array<{ logicalKey: string; file: string; titlePath: string[]; discoveryStatus: string; annotations?: unknown }>;
          };
          expect(catalog.inventoryComplete).toBe(true);
          const journeyRows = catalog.entries.filter((entry) => entry.file === 'specs/journeys.spec.js');
          expect(journeyRows).toHaveLength(3);
          for (const row of journeyRows) {
            expect(row.discoveryStatus).toBe('discovered');
          }

          // The suggestion surface orders REUSE first: every obligation is
          // TEST_MAPPING_MISSING, the existing journeys are candidates, and
          // no new test is recommended.
          const suggested = await runSupervisedCli(repo, ['tests', 'suggest', '--json'], env);
          expect(suggested.code, `suggest stdout:\n${suggested.stdout}\nstderr:\n${suggested.stderr}`).toBe(0);
          const suggestions = JSON.parse(suggested.stdout).suggestions as Array<{
            obligationId: string;
            cause: string;
            newTestNeeded: boolean;
            candidates: Array<{ file: string }>;
          }>;
          for (const journey of JOURNEYS) {
            const row = suggestions.find((entry) => entry.obligationId === journey.obligation);
            expect(row?.cause).toBe('TEST_MAPPING_MISSING');
            expect(row?.newTestNeeded).toBe(false);
            expect(row?.candidates.some((candidate) => candidate.file === 'specs/journeys.spec.js')).toBe(true);
          }

          // The gate BLOCKS before the declaration exists: over all files
          // every required obligation grades TEST_MAPPING_MISSING.
          const preMark = await runSupervisedCli(repo, ['check', '--format', 'json'], env);
          expect(preMark.code, `pre-mark check stdout:\n${preMark.stdout}\nstderr:\n${preMark.stderr}`).toBe(1);
          const preMarkReport = JSON.parse(preMark.stdout) as {
            verdicts: Array<{ obligationId: string; verdict: string; cause: string | null }>;
          };
          for (const journey of JOURNEYS) {
            const verdict = preMarkReport.verdicts.find((entry) => entry.obligationId === journey.obligation);
            expect(verdict?.verdict).toBe('missing');
            expect(verdict?.cause).toBe('TEST_MAPPING_MISSING');
          }

          // (2) MANUAL MAPPING: the agent marks the EXISTING helper-based
          // tests (the real `tests mark` command; test files untouched).
          for (const journey of JOURNEYS) {
            const key = journeyRows.find((row) => row.titlePath[row.titlePath.length - 1] === journey.title)?.logicalKey;
            expect(key, `catalog row for '${journey.title}'`).toBeTruthy();
            const marked = await runSupervisedCli(
              repo,
              [
                'tests', 'mark',
                '--test', key as string,
                '--kind', 'browser-e2e',
                '--category', journey.category,
                '--obligation', journey.obligation,
                '--reason', 'Existing helper-based journey drives the rendered UI through shared helpers; the declaration names what the journey already covers.',
              ],
              env,
            );
            expect(marked.code, `mark stdout:\n${marked.stdout}\nstderr:\n${marked.stderr}`).toBe(0);
          }
          // The sidecar carries exactly the three journey declarations;
          // the journeys themselves are unchanged.
          const sidecar = readFileSync(join(repo.root, '.gateforge/test-map.yml'), 'utf8');
          expect(sidecar.match(/kind: browser-e2e/g)?.length).toBe(3);
          for (const journey of JOURNEYS) {
            expect(sidecar).toContain(journey.obligation);
          }
          expect(readFileSync(join(repo.root, 'specs/journeys.spec.js'), 'utf8')).toBe(JOURNEYS_SPEC);

          // (3)+(4) EXECUTION of the original tests + ACCEPTED BROWSER
          // EVIDENCE. Mapping declarations are part of the OWNER-APPROVED
          // trusted revision (test-map.yml is hashed into the trusted
          // policy digest): the owner provisions the pin for the revision
          // that includes the migration's declarations, then the strict
          // run executes under it (a candidate cannot weaken its own
          // checks under that pin — E17 covers the rejection).
          const pin = trustedPolicyDigestForConfig(repo.root, config);
          setOperator({ GATEFORGE_APPROVED_POLICY_DIGEST: pin });
          const gated = await runSupervisedCli(repo, ['test-gates', '--changed', '--format', 'json'], env);
          expect(gated.code, `test-gates stdout:\n${gated.stdout}\nstderr:\n${gated.stderr}`).toBe(0);
          const report = JSON.parse(gated.stdout) as {
            summary: { obligations: number; blocking: number };
            verdicts: Array<{ obligationId: string; verdict: string }>;
          };
          expect(report.summary.blocking).toBe(0);
          for (const journey of JOURNEYS) {
            expect(report.verdicts.find((entry) => entry.obligationId === journey.obligation)?.verdict).toBe('satisfied');
          }

          // (5) VALID STRICT RECEIPT: the sealed receipt verifies for the
          // exact candidate state.
          const receiptRaw = readFileSync(join(repo.root, '.gateforge/test-gates/receipt.json'), 'utf8');
          expect(receiptRaw).toContain('"approvedPolicyDigest"');
          const checked = await runSupervisedCli(repo, ['check', '--changed', '--require-e2e', '--format', 'json'], env);
          expect(checked.code, `check stdout:\n${checked.stdout}\nstderr:\n${checked.stderr}`).toBe(0);

          // This fixture has only the three selected account obligations, so
          // a full check must pass too. The separate E05 fixture adds hundreds
          // of unrelated obligations and checks that full scope stays blocking.
          const fullCheck = await runSupervisedCli(repo, ['check', '--format', 'json'], env);
          expect(fullCheck.code, `full check stdout:\n${fullCheck.stdout}\nstderr:\n${fullCheck.stderr}`).toBe(0);
          const fullReport = JSON.parse(fullCheck.stdout) as {
            summary: { obligations: number; blocking: number; missing: number; stale: number };
            verdicts: Array<{ obligationId: string; verdict: string }>;
          };
          expect(fullReport.summary.obligations).toBe(3);
          expect(fullReport.summary.blocking).toBe(0);
          expect(fullReport.summary.missing).toBe(0);
          expect(fullReport.summary.stale).toBe(0);
          for (const id of [
            'tenant.accounts:crud:create',
            'tenant.accounts:crud:update',
            'tenant.accounts:crud:delete',
          ]) {
            expect(fullReport.verdicts.find((entry) => entry.obligationId === id)?.verdict).toBe('satisfied');
          }
        } finally {
          await proxy.stop();
          app.stop();
        }
      });
    } finally {
      restoreOperator();
    }
  }, 600_000);

  it('an uncovered behavior reports through an external witness without changing gate authority (E05)', async () => {
    // The OPERATOR environment (same provisioning as the native test).
    const verifierKey = 'strict-supervised-verifier-key';
    const operatorEnv: Record<string, string> = {
      GATEFORGE_WITNESS_VERIFIER_KEY: verifierKey,
      GATEFORGE_APPROVED_POLICY_DIGEST: 'pending-pin-computation',
    };
    const savedOperator: Record<string, string | undefined> = {};
    const setOperator = (values: Record<string, string>): void => {
      for (const [key, value] of Object.entries(values)) {
        if (!(key in savedOperator)) savedOperator[key] = process.env[key];
        process.env[key] = value;
      }
    };
    const restoreOperator = (): void => {
      for (const [key, value] of Object.entries(savedOperator)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    };
    setOperator(operatorEnv);
    try {
      await withTempRepo({}, async (repo) => {
        installStrictFixture(repo);
        const debtDetector = DETECTOR.replace(
          'return { resources, unresolved: [], findings: [], classificationSignals };',
          `for (let index = 0; index < 512; index += 1) {
      const name = 'unclaimed_' + String(index);
      resources.push({ schemaVersion: 1, id: name, kind: 'fixture.entity', source: 'src/unrelated.js', location: { file: 'src/unrelated.js', line: 1, col: 0 }, detectorVersion: '1.0.0', attributes: { resourceName: name, updateableFields: ['name'] } });
      for (const [dimension, assertion] of Object.entries({ plane: 'tenant', identity: ['id'], 'adapter-binding': 'tenant.accounts', 'lifecycle.create': true, 'lifecycle.update': true, 'lifecycle.delete': true, 'delete-semantics': 'archive', 'archive-state': { status: 'archived' } })) {
        classificationSignals.push({ schemaVersion: 1, target: { resourceName: name }, dimension, assertion, basis: 'declaration', source: 'gateforge.fixture', location: { file: 'src/unrelated.js', line: 1, col: 0 }, detector: { id: 'gateforge.fixture', version: '1.0.0' } });
      }
    }
    return { resources, unresolved: [], findings: [], classificationSignals };`,
        );
        const readPolicies = `schemaVersion: 1
policies:
  - id: crud
    when: {}
    require: [crud:create, crud:read, crud:update, crud:delete]
`;
        // The owner REQUIRES the read behavior too (the detector already
        // declares lifecycle.read, and the app renders it). The existing
        // suite has NO test covering reads.
        repo.writeFiles({
          '.gateforge/fixture-detector.mjs': debtDetector,
          '.gateforge/policies.yml': readPolicies,
          '.gateforge/test-gates/claims.json': JSON.stringify([
            {
              schemaVersion: 1,
              obligationId: 'tenant.accounts:crud:read',
              testId: 'stale-read-claim',
              testFile: 'specs/crud.spec.js',
              location: { file: 'specs/crud.spec.js', line: 1, col: 0 },
            },
          ]),
          'src/unrelated.js': '// 512 unrelated user-facing resources create full-repository debt.\n',
        });
        repo.git(['add', '-A']);
        repo.git(['commit', '--no-gpg-sign', '--quiet', '-m', 'read-required fixture']);
        // The genuine candidate change under test.
        repo.writeFiles({ 'src/accounts.js': '// fixture source: the accounts resource lives here.\n// change: audited comment.\n' });
        repo.git(['add', 'src/accounts.js']);
        const app = await startApp();
        const proxy = await startAttestationProxy(app.url, FINGERPRINT);
        try {
          const config = loadConfigAt(repo.root);
          const pin = trustedPolicyDigestForConfig(repo.root, config);
          const env: Record<string, string> = {
            GATEFORGE_WITNESS_VERIFIER_KEY: 'strict-supervised-verifier-key',
            GATEFORGE_APP_BASE_URL: proxy.url,
            GATEFORGE_TARGET_BASE_URL: proxy.url,
            GATEFORGE_TARGET_FINGERPRINT: FINGERPRINT,
            GATEFORGE_APPROVED_POLICY_DIGEST: pin,
          };
          setOperator(env);

          // ---- Phase A: the uncovered behavior BLOCKS the gate ----
          // (a) The gap is explained: the suggestion names the missing
          // coverage and, with no candidate existing test, says a new
          // test is needed (reuse-first ordering; no false reuse claim).
          const suggested = await runSupervisedCli(repo, ['tests', 'suggest', '--json'], env);
          expect(suggested.code, `suggest stdout:\n${suggested.stdout}\nstderr:\n${suggested.stderr}`).toBe(0);
          const suggestions = JSON.parse(suggested.stdout).suggestions as Array<{
            obligationId: string;
            cause: string;
            newTestNeeded: boolean;
            candidates: unknown[];
          }>;
          const gap = suggestions.find((entry) => entry.obligationId === 'tenant.accounts:crud:read');
          expect(gap?.cause).toBe('TEST_MAPPING_MISSING');
          expect(gap?.newTestNeeded).toBe(true);

          // (b) The strict gate blocks EVEN THOUGH every existing journey
          // passes: a green suite without the behavior's proof is not a
          // green gate. The covered obligations satisfy; the read
          // obligation must remain an explicit changed-scope blocker.
          const gatedA = await runSupervisedCli(repo, ['test-gates', '--changed', '--scope', 'changed', '--format', 'json'], env);
          expect(gatedA.code, `test-gates (phase A) stdout:\n${gatedA.stdout}\nstderr:\n${gatedA.stderr}`).toBe(1);
          const reportA = JSON.parse(gatedA.stdout) as {
            verdicts: Array<{ obligationId: string; verdict: string; cause: string | null }>;
            blocking: Array<{ name: string | null; cause: string | null }>;
          };
          expect(
            reportA.blocking,
          ).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                name: 'tenant.accounts:crud:read',
                cause: 'EVIDENCE_SCOPE_INCOMPLETE',
              }),
            ]),
          );
          for (const id of ['tenant.accounts:crud:create', 'tenant.accounts:crud:update', 'tenant.accounts:crud:delete']) {
            expect(reportA.verdicts.find((entry) => entry.obligationId === id)?.verdict).toBe('satisfied');
          }
          const fullGateA = await runSupervisedCli(repo, ['test-gates', '--changed', '--scope', 'full', '--format', 'json'], env);
          expect(fullGateA.code, `full test-gates (phase A) stdout:\n${fullGateA.stdout}\nstderr:\n${fullGateA.stderr}`).toBe(1);
          const fullReportA = JSON.parse(fullGateA.stdout) as {
            execution: {
              scope: string;
              selectedClaims: { blocking: number };
              repositoryDebt: { blocking: number; unclaimed: number };
            };
            diagnosticContext: {
              scope: string;
              candidateTreeId: string | null;
              inputDigest: string | null;
              evidenceState: string;
            };
          };
          expect(fullReportA.execution.scope).toBe('full');
          expect(fullReportA.execution.selectedClaims.blocking).toBeGreaterThan(0);
          expect(fullReportA.execution.repositoryDebt.blocking).toBeGreaterThan(0);
          expect(fullReportA.execution.repositoryDebt.unclaimed).toBeGreaterThan(500);
          expect(fullReportA.diagnosticContext).toMatchObject({
            scope: 'full',
            evidenceState: 'witness-attestation-unavailable',
          });
          expect(fullReportA.diagnosticContext.candidateTreeId).toMatch(/^[0-9a-f]{40}$/);
          expect(fullReportA.diagnosticContext.inputDigest).toMatch(/^[0-9a-f]{64}$/);

          // A changed test file selects its three declared claims. The
          // unrelated full-repository read gap remains visible in the
          // result, but it does not make this non-authoritative query red.
          repo.writeFiles({ '.gateforge/policies.yml': POLICIES_YML });
          const selectedPolicyPin = trustedPolicyDigestForConfig(repo.root, loadConfigAt(repo.root));
          env['GATEFORGE_APPROVED_POLICY_DIGEST'] = selectedPolicyPin;
          setOperator(env);
          const selectedGate = await runSupervisedCli(
            repo,
            ['test-gates', '--changed', '--scope', 'changed', '--format', 'json'],
            env,
          );
          expect(selectedGate.code, `selected gate stdout:\n${selectedGate.stdout}\nstderr:\n${selectedGate.stderr}`).toBe(0);
          const receiptPath = join(repo.root, '.gateforge/test-gates/receipt.json');
          const receiptBefore = readFileSync(receiptPath, 'utf8');
          const selectedGateReport = JSON.parse(selectedGate.stdout) as {
            execution: {
              selectedClaims: { selected: number; satisfied: number; blocking: number };
              repositoryDebt: { unclaimed: number };
            };
          };
          expect(selectedGateReport.execution.selectedClaims).toMatchObject({ selected: 3, satisfied: 3, blocking: 0 });
          expect(selectedGateReport.execution.repositoryDebt.unclaimed).toBeGreaterThan(500);
          const selectedResult = await runSupervisedCli(
            repo,
            ['test-gates', '--changed', '--scope', 'changed', '--result-only', '--format', 'json'],
            env,
          );
          expect(
            selectedResult.code,
            `selected result stdout:\n${selectedResult.stdout}\nstderr:\n${selectedResult.stderr}`,
          ).toBe(0);
          const selectedReport = JSON.parse(selectedResult.stdout) as {
            outcome: string;
            engine: { version: string; source: string; unpublished: boolean };
            diagnosticContext: { scope: string; authority: string };
            execution: {
              selectedTests: { selected: number; passed: number };
              selectedClaims: { selected: number; satisfied: number; blocking: number };
              repositoryDebt: { blocking: number; unclaimed: number };
            };
          };
          expect(selectedReport.outcome).toBe('partial-selection');
          expect(selectedReport.engine.version).toMatch(/^\d+\.\d+\.\d+$/);
          expect(selectedReport.engine.source).toMatch(/^(registry|local path )/);
          expect(typeof selectedReport.engine.unpublished).toBe('boolean');
          expect(selectedReport.diagnosticContext).toMatchObject({ scope: 'changed', authority: 'non-authoritative' });
          expect(selectedReport.execution.selectedTests).toMatchObject({ selected: 3, passed: 3 });
          expect(selectedReport.execution.selectedClaims).toMatchObject({ selected: 3, satisfied: 3, blocking: 0 });
          expect(selectedReport.execution.repositoryDebt.blocking).toBeGreaterThan(0);
          expect(selectedReport.execution.repositoryDebt.unclaimed).toBeGreaterThan(500);
          expect(`${selectedResult.stdout}\n${selectedResult.stderr}`).toContain('non-authoritative');
          // The app starts its witness before invoking test-gates. Keep
          // that process on its own state path and route the real browser
          // through its observation proxy.
          const externalStateDir = mkdtempSync(join(tmpdir(), 'gateforge-result-only-external-'));
          const externalRunToken = randomUUID();
          copyFileSync(
            join(repo.root, '.gateforge/test-gates/classifications.json'),
            join(externalStateDir, 'classifications.json'),
          );
          const externalWitness = await startWitnessProcess({
            GATEFORGE_RUN_ID: randomUUID(),
            GATEFORGE_RUN_TOKEN: externalRunToken,
            GATEFORGE_STATE_DIR: externalStateDir,
            GATEFORGE_CLASSIFICATIONS: join(externalStateDir, 'classifications.json'),
            GATEFORGE_ADAPTERS_DIR: join(repo.root, '.gateforge/adapters'),
            GATEFORGE_TARGET_BASE_URL: proxy.url,
            GATEFORGE_ADAPTER_BASE_URL: proxy.url,
            GATEFORGE_TARGET_FINGERPRINT: FINGERPRINT,
            GATEFORGE_PROXY_TARGET: proxy.url,
            GATEFORGE_WITNESS_VERIFIER_KEY: verifierKey,
          });
          try {
            expect(externalWitness.proxyUrl).not.toBeNull();
            const externalEnv = {
              ...env,
              GATEFORGE_APP_BASE_URL: externalWitness.proxyUrl ?? '',
            };
            setOperator(externalEnv);
            const authoritativeStateDir = join(repo.root, '.gateforge/test-gates');
            const receiptPath = join(authoritativeStateDir, 'receipt.json');
            const attestationPath = join(authoritativeStateDir, 'manifest.json');
            const receiptHashBefore = sha256File(receiptPath);
            const attestationHashBefore = sha256File(attestationPath);
            expect(JSON.parse(readFileSync(attestationPath, 'utf8')).attestation).toBeDefined();
            const externalResult = await runSupervisedCli(
              repo,
              [
                'test-gates',
                '--changed',
                '--scope',
                'changed',
                '--result-only',
                '--format',
                'json',
                '--witness-url',
                externalWitness.url,
                '--out',
                externalStateDir,
                '--run-token',
                externalRunToken,
              ],
              externalEnv,
            );
            expect(
              externalResult.code,
              `external selected result stdout:\n${externalResult.stdout}\nstderr:\n${externalResult.stderr}`,
            ).toBe(0);
            const externalReport = JSON.parse(externalResult.stdout) as {
              diagnosticContext: { scope: string; authority: string };
              execution: {
                selectedTests: { selected: number; passed: number };
                selectedClaims: { selected: number; satisfied: number; blocking: number };
                repositoryDebt: { blocking: number; unclaimed: number };
              };
            };
            expect(externalReport.diagnosticContext).toMatchObject({
              scope: 'changed',
              authority: 'non-authoritative',
            });
            expect(externalReport.execution.selectedTests).toMatchObject({ selected: 3, passed: 3 });
            expect(externalReport.execution.selectedClaims).toMatchObject({ selected: 3, satisfied: 3, blocking: 0 });
            expect(externalReport.execution.repositoryDebt.blocking).toBeGreaterThan(0);
            expect(externalReport.execution.repositoryDebt.unclaimed).toBeGreaterThan(500);
            expect(existsSync(join(externalStateDir, 'receipt.json'))).toBe(false);
            expect(sha256File(receiptPath)).toBe(receiptHashBefore);
            expect(sha256File(attestationPath)).toBe(attestationHashBefore);

            const authoritativeOut = await runSupervisedCli(
              repo,
              [
                'test-gates',
                '--changed',
                '--scope',
                'changed',
                '--result-only',
                '--witness-url',
                externalWitness.url,
                '--out',
                authoritativeStateDir,
                '--run-token',
                externalRunToken,
              ],
              externalEnv,
            );
            expect(authoritativeOut.code).toBe(2);
            expect(authoritativeOut.stderr).toContain('separate non-authoritative state directory');
            expect(sha256File(receiptPath)).toBe(receiptHashBefore);
            expect(sha256File(attestationPath)).toBe(attestationHashBefore);
          } finally {
            if (externalWitness.child.exitCode === null && externalWitness.child.signalCode === null) {
              externalWitness.child.kill('SIGTERM');
              await once(externalWitness.child, 'exit');
            }
            rmSync(externalStateDir, { recursive: true, force: true });
          }
          const rejectedHookMode = await runSupervisedCli(
            repo,
            ['pre-commit', '--scope', 'staged', '--result-only'],
            env,
          );
          expect(rejectedHookMode.code).toBe(2);
          expect(rejectedHookMode.stderr).toContain("unknown flag '--result-only'");
          // A selected result uses isolated state: it cannot create,
          // replace, or clear the prior authenticated slice receipt.
          expect(readFileSync(receiptPath, 'utf8')).toBe(receiptBefore);
          const fullCheck = await runSupervisedCli(
            repo,
            ['check', '--require-e2e', '--format', 'json'],
            env,
          );
          expect(fullCheck.code, `check stdout:\n${fullCheck.stdout}\nstderr:\n${fullCheck.stderr}`).toBe(1);
          const fullCheckReport = JSON.parse(fullCheck.stdout) as {
            summary: { blocking: number };
            diagnosticContext: { scope: string; evidenceState: string };
          };
          expect(fullCheckReport.summary.blocking).toBeGreaterThan(0);
          expect(fullCheckReport.diagnosticContext).toMatchObject({
            scope: 'full',
            evidenceState: 'receipt-verified-with-blocking-entry',
          });

          // ---- Phase B: a REAL new browser journey covers the behavior ----
          // The journey drives the rendered UI through the engine (clicks
          // the row's edit control, reads the rendered form), confirms the
          // visible result, observes the real GET exchange, and verifies
          // persistence — then the strict gate passes end to end.
          repo.writeFiles({
            '.gateforge.yml': GATEFORGE_YML.replace(
              './.gateforge/fixture-detector.mjs',
              './.gateforge/fixture-detector-phase-b.mjs',
            ),
            '.gateforge/fixture-detector-phase-b.mjs': DETECTOR,
          });
          rmSync(join(repo.root, 'src/unrelated.js'));
          repo.writeFiles({ '.gateforge/policies.yml': readPolicies });
          env['GATEFORGE_APPROVED_POLICY_DIGEST'] = trustedPolicyDigestForConfig(repo.root, loadConfigAt(repo.root));
          setOperator(env);
          repo.writeFiles({ 'specs/crud.spec.js': SPEC_WITH_READ });
          const gatedB = await runSupervisedCli(repo, ['test-gates', '--changed', '--format', 'json'], env);
          expect(gatedB.code, `test-gates (phase B) stdout:\n${gatedB.stdout}\nstderr:\n${gatedB.stderr}`).toBe(0);
          const reportB = JSON.parse(gatedB.stdout) as {
            summary: { obligations: number; blocking: number };
            verdicts: Array<{ obligationId: string; verdict: string }>;
          };
          expect(reportB.summary.obligations).toBe(4);
          expect(reportB.summary.blocking).toBe(0);
          for (const id of [
            'tenant.accounts:crud:create',
            'tenant.accounts:crud:read',
            'tenant.accounts:crud:update',
            'tenant.accounts:crud:delete',
          ]) {
            expect(reportB.verdicts.find((entry) => entry.obligationId === id)?.verdict).toBe('satisfied');
          }
          // The strict receipt seals and verifies for the exact candidate.
          const receiptRaw = readFileSync(join(repo.root, '.gateforge/test-gates/receipt.json'), 'utf8');
          expect(receiptRaw).toContain('"approvedPolicyDigest"');
          const checked = await runSupervisedCli(repo, ['check', '--changed', '--require-e2e', '--format', 'json'], env);
          expect(checked.code, `check stdout:\n${checked.stdout}\nstderr:\n${checked.stderr}`).toBe(0);
        } finally {
          await proxy.stop();
          app.stop();
        }
      });
    } finally {
      restoreOperator();
    }
  }, 600_000);

  it('a candidate that weakens its own required checks is rejected under the approved pin (E17)', async () => {
    await withTempRepo({}, async (repo) => {
      installStrictFixture(repo);
      repo.git(['add', '-A']);
      repo.git(['commit', '--no-gpg-sign', '--quiet', '-m', 'strict fixture']);
      const config = loadConfigAt(repo.root);
      const pin = trustedPolicyDigestForConfig(repo.root, config);
      // The candidate weakens its own policy: crud:delete no longer
      // required. The trusted digest no longer matches the
      // owner-approved pin, so the gate refuses before any test runs.
      repo.writeFiles({
        '.gateforge/policies.yml': `schemaVersion: 1
policies:
  - id: crud
    when: {}
    require: [crud:create, crud:update]
`,
      });
      const env: Record<string, string> = {
        GATEFORGE_WITNESS_VERIFIER_KEY: 'strict-supervised-verifier-key',
        GATEFORGE_APPROVED_POLICY_DIGEST: pin,
      };
      const gated = await runSupervisedCli(repo, ['test-gates', '--changed', '--format', 'json'], env);
      expect(gated.code).toBe(1);
      expect(gated.stderr).toMatch(/approved|policy|weakened|ENFORCEMENT_UNTRUSTED/i);
    });
  }, 120_000);

  it('runs staged-scope and full witnessed pre-commit gates against the frozen index', async () => {
    // Candidate-owned app bytes: the example app is committed INTO the
    // fixture (app/), and the tracked runtime document starts it from
    // the materialized checkout. The build marker appended to the app's
    // module makes the executed build observable: staged and unstaged
    // variants log different markers, and the runtime log (an audit
    // artifact copied back from the checkout) proves WHICH bytes served.
    const appServer = readFileSync(join(ROOT, 'example/server.js'), 'utf8');
    const appLib = readFileSync(join(ROOT, 'example/lib/app.js'), 'utf8');
    const marker = (variant: string): string => `\nconsole.log('APP_BUILD_MARKER: ${variant}');\n`;
    await withTempRepo({}, async (repo) => {
      installStrictFixture(repo);
      repo.writeFiles({
        'docs/guide.md': '# approved staged guide: version 1\n',
        '.gateforge/docs-exclusions.yml': 'schemaVersion: 1\nfolders:\n  - docs\n',
      });
      // The explicit mapping is tracked BEFORE the base commit, so the
      // frozen candidate carries it and the owner pin (computed below)
      // covers this trusted declaration (test-map.yml is policy input).
      repo.writeFiles({ '.gateforge/test-map.yml': TEST_MAP_YML });
      // Candidate-owned application + staged-runtime declaration (both
      // tracked → both materialized into the checkout; runtime.yml is
      // hashed into the trusted policy digest the pin covers). The
      // fixture config gains ONLY the runtime declaration — the shared
      // fixture keeps its exact bytes for the other legs.
      repo.writeFiles({
        '.gitignore': 'node_modules\n',
        'app/server.js': appServer,
        'app/lib/app.js': `${appLib}${marker('base')}`,
        'app/package.json': `${JSON.stringify({ type: 'module' }, null, 2)}\n`,
        '.gateforge.yml': `${GATEFORGE_YML}runtime: .gateforge/runtime.yml\n`,
        '.gateforge/runtime.yml': `schemaVersion: 1
prepare:
  reuse:
    - node_modules
    - specs/node_modules
  command: node -e "const fs = require('node:fs'); if (fs.readFileSync('node_modules/fixture/index.js', 'utf8') !== 'root-ok\\n' || fs.readFileSync('specs/node_modules/fixture/index.js', 'utf8') !== 'nested-ok\\n') process.exit(2); console.log('reuse-ok')"
services:
  - id: app
    command: node app/server.js --port ${'${service:app:port}'}
    attested: true
    fingerprint: ${FINGERPRINT}
    target: true
    ready:
      log: listening on
      timeoutSeconds: 30
envAllowlist: []
`,
        // An UNRELATED test: claims no obligation. Full scope (the
        // complete relevant mapped suite) plans every catalog row and
        // runs it; changed scope (the affected slice) must NOT run it.
        'specs/unrelated.spec.js': `import { test as gateforgeTest, expect } from '@gate-forge/pack-playwright';

const test = gateforgeTest.extend({});

test('unrelated smoke test claims no obligation', async () => {
  expect(1 + 1).toBe(2);
});
`,
      });
      repo.git(['add', '-A']);
      repo.git(['commit', '--no-gpg-sign', '--quiet', '-m', 'strict fixture']);
      mkdirSync(join(repo.root, 'node_modules', 'fixture'), { recursive: true });
      mkdirSync(join(repo.root, 'specs', 'node_modules', 'fixture'), { recursive: true });
      writeFileSync(join(repo.root, 'node_modules', 'fixture', 'index.js'), 'root-ok\n');
      writeFileSync(join(repo.root, 'specs', 'node_modules', 'fixture', 'index.js'), 'nested-ok\n');

      // The staged candidate: the app's module bytes carry the STAGED
      // marker. The worktree then holds UNSTAGED bytes with a different
      // marker — only the staged bytes may ever execute or be served.
      const stagedAppLib = `${appLib}${marker('staged-candidate-app')}`;
      const unstagedAppLib = `${appLib}${marker('unstaged-worktree-app')}`;
      repo.writeFiles({ 'app/lib/app.js': stagedAppLib });
      repo.git(['add', 'app/lib/app.js']);
      repo.writeFiles({ 'app/lib/app.js': unstagedAppLib });
      repo.writeFiles({
        'src/accounts.js': '// fixture source: staged candidate.\n',
      });
      repo.git(['add', 'src/accounts.js']);
      repo.writeFiles({
        'src/accounts.js': '// unstaged worktree bytes must not enter the witnessed candidate.\n',
      });
      const stagedPaths = repo.git(['diff', '--cached', '--name-only', 'HEAD']).stdout.trim().split('\n').sort();
      expect(stagedPaths).toEqual(['app/lib/app.js', 'src/accounts.js']);
      expect(repo.git(['show', ':.gateforge/test-map.yml']).stdout).toBe(TEST_MAP_YML);
      expect(repo.git(['show', ':.gateforge/runtime.yml']).stdout).toContain('reuse:');
      expect(repo.git(['show', ':.gateforge.yml']).stdout).toContain('runtime: .gateforge/runtime.yml');

      // NO external app/proxy: the candidate runtime owns the attested
      // target (started from the checkout by the gate itself). The key
      // ring stays outside the repository and is absent from runner env.
      const config = loadConfigAt(repo.root);
      const keyDirectory = mkdtempSync(join(tmpdir(), 'gateforge-precommit-keyring-'));
      verifierKeyDirectories.push(keyDirectory);
      const keyFile = join(keyDirectory, 'keys.json');
      writeFileSync(
        keyFile,
        `${JSON.stringify({ schemaVersion: 1, activeKeyId: 'precommit-key', keys: { 'precommit-key': 'pre-commit-witness-verifier-key' } })}\n`,
        { mode: 0o600 },
      );
      const env: Record<string, string> = {
        GATEFORGE_WITNESS_VERIFIER_KEY_FILE: keyFile,
        GATEFORGE_APPROVED_POLICY_DIGEST: trustedPolicyDigestForConfig(repo.root, config),
      };

      expect(repo.git(['ls-files', '--stage', '--', 'node_modules', 'specs/node_modules']).stdout.trim()).toBe('');
      const staged = await runSupervisedCli(repo, ['pre-commit', '--scope', 'staged'], env);
      expect(staged.code, `staged stdout:\n${staged.stdout}\nstderr:\n${staged.stderr}`).toBe(0);
      expect(staged.stdout).toContain('execution: changed scope, executed; 3 test(s) run in this invocation');
      expect(staged.stdout).toContain('selected tests: 3 passed, 0 failed (selected 3; 0 skipped; 0 expected failures)');
      expect(staged.stdout).toContain('selected claims: 3 satisfied, 0 blocking');
      expect(staged.stdout).toContain('repository debt: 0 blocking / 3 obligations');
      expect(staged.stdout).toMatch(/diagnostic context: scope=changed candidateTreeId=[0-9a-f]{40} inputDigest=[0-9a-f]{64}/);
      const stagedReport = JSON.parse(
        readFileSync(join(repo.root, '.gateforge/test-gates/report.json'), 'utf8'),
      ) as {
        diagnosticContext: {
          scope: string;
          candidateTreeId: string | null;
          inputDigest: string | null;
        };
      };
      expect(stagedReport.diagnosticContext.scope).toBe('changed');
      expect(stagedReport.diagnosticContext.candidateTreeId).toMatch(/^[0-9a-f]{40}$/);
      expect(stagedReport.diagnosticContext.inputDigest).toMatch(/^[0-9a-f]{64}$/);
      expect(`${staged.stdout}\n${staged.stderr}`).not.toContain('pre-commit-witness-verifier-key');
      expect(`${staged.stdout}\n${staged.stderr}`).not.toContain(keyFile);
      const stagedReceipt = JSON.parse(
        readFileSync(join(repo.root, '.gateforge/test-gates/receipt.json'), 'utf8'),
      ) as { scope?: string; coveredObligationFingerprints?: string[]; verifierKeyId?: string };
      expect(stagedReceipt.scope).toBe('changed');
      expect(stagedReceipt.verifierKeyId).toBe('precommit-key');
      expect(stagedReceipt.coveredObligationFingerprints?.length).toBeGreaterThan(0);
      // The worktree bytes were never touched by the gate.
      expect(readFileSync(join(repo.root, 'src/accounts.js'), 'utf8')).toContain('unstaged worktree bytes');
      expect(readFileSync(join(repo.root, 'app/lib/app.js'), 'utf8')).toContain('unstaged-worktree-app');
      // Runtime audit artifacts copied back from the checkout: the
      // candidate-owned app ran and logged the STAGED build marker.
      const runtimeLog = readFileSync(join(repo.root, '.gateforge/test-gates/runtime/app.log'), 'utf8');
      expect(runtimeLog).toContain('APP_BUILD_MARKER: staged-candidate-app');
      expect(runtimeLog).not.toContain('unstaged-worktree-app');
      expect(runtimeLog).toContain('listening on');
      expect(readFileSync(join(repo.root, '.gateforge/test-gates/runtime/prepare.log'), 'utf8')).toContain('reuse-ok');
      // Browser witness records were created during pre-commit.
      const stagedRecords = JSON.parse(
        readFileSync(join(repo.root, '.gateforge/test-gates/records.json'), 'utf8'),
      ) as unknown[];
      expect(stagedRecords.length).toBeGreaterThan(0);
      // Changed scope executed ONLY the affected mapped spec — the
      // unrelated catalog row did not run.
      const stagedOutcomes = JSON.parse(
        readFileSync(join(repo.root, '.gateforge/test-gates/runner-outcomes.json'), 'utf8'),
      ) as { outcomes?: Array<{ file?: string }> };
      const stagedFiles = new Set((stagedOutcomes.outcomes ?? []).map((row) => row.file ?? ''));
      expect(stagedFiles.has('specs/crud.spec.js')).toBe(true);
      expect(stagedFiles.has('specs/unrelated.spec.js')).toBe(false);

      const full = await runSupervisedCli(repo, ['pre-commit', '--scope', 'full'], env);
      const fullManifest = JSON.parse(
        readFileSync(join(repo.root, '.gateforge/test-gates/manifest.json'), 'utf8'),
      ) as { runId: string };
      const fullSpoolPath = join(repo.root, '.gateforge/test-gates/spool', fullManifest.runId, 'events.jsonl');
      const fullSpool = existsSync(fullSpoolPath) ? readFileSync(fullSpoolPath, 'utf8') : '<missing>';
      const fullOutcomesRaw = readFileSync(join(repo.root, '.gateforge/test-gates/runner-outcomes.json'), 'utf8');
      expect(
        full.code,
        `full stdout:\n${full.stdout}\nstderr:\n${full.stderr}\nspool events:\n${fullSpool}\nrunner outcomes:\n${fullOutcomesRaw}`,
      ).toBe(0);
      expect(full.stdout).toContain('execution: full scope, executed; 4 test(s) run in this invocation');
      expect(full.stdout).toContain('selected tests: 4 passed, 0 failed (selected 4; 0 skipped; 0 expected failures)');
      expect(full.stdout).toContain('selected claims: 3 satisfied, 0 blocking');
      expect(full.stdout).toContain('repository debt: 0 blocking / 3 obligations');
      expect(full.stdout).toContain('documentation exclusions: folders=docs approvalStatus=matched');
      const fullReceipt = JSON.parse(
        readFileSync(join(repo.root, '.gateforge/test-gates/receipt.json'), 'utf8'),
      ) as { scope?: string };
      expect(fullReceipt.scope === undefined || fullReceipt.scope === 'full').toBe(true);
      // Full scope runs the complete relevant mapped suite: affected AND
      // unrelated rows both executed.
      const fullOutcomes = JSON.parse(
        readFileSync(join(repo.root, '.gateforge/test-gates/runner-outcomes.json'), 'utf8'),
      ) as { outcomes?: Array<{ file?: string }> };
      const fullFiles = new Set((fullOutcomes.outcomes ?? []).map((row) => row.file ?? ''));
      expect(fullFiles.has('specs/crud.spec.js')).toBe(true);
      expect(fullFiles.has('specs/unrelated.spec.js')).toBe(true);

      // A staged docs edit stays under the owner assertion in both tree
      // identity and input identity. This check reuses the original full
      // receipt; it does not run the product tests again.
      const fullReceiptBytes = readFileSync(join(repo.root, '.gateforge/test-gates/receipt.json'), 'utf8');
      repo.writeFiles({ 'docs/guide.md': '# approved staged guide: version 2\n' });
      repo.git(['add', 'docs/guide.md']);
      const checked = await runSupervisedCli(repo, ['check', '--staged', '--require-e2e'], env);
      expect(checked.code, `check stdout:\n${checked.stdout}\nstderr:\n${checked.stderr}`).toBe(0);
      expect(readFileSync(join(repo.root, '.gateforge/test-gates/receipt.json'), 'utf8')).toBe(fullReceiptBytes);
    });
  }, 600_000);

  it('blocks when a witnessed suite changes bytes under a declared reuse mount', async () => {
    const mutationSpec = `import { test, expect } from '@gate-forge/pack-playwright';
import { writeFileSync } from 'node:fs';

test('mutates a reused dependency during execution', async () => {
  writeFileSync('specs/node_modules/fixture/index.js', 'changed-during-run\\n');
  expect(1 + 1).toBe(2);
});
`;
    await withTempRepo({}, async (repo) => {
      installStrictFixture(repo, { 'specs/mutate.spec.js': mutationSpec });
      repo.writeFiles({
        '.gateforge.yml': `${GATEFORGE_YML}runtime: .gateforge/runtime.yml\n`,
        '.gateforge/runtime.yml': `schemaVersion: 1
prepare:
  reuse:
    - node_modules
    - specs/node_modules
`,
      });
      repo.stage();
      repo.commit('strict reuse mutation fixture');
      mkdirSync(join(repo.root, 'specs', 'node_modules', 'fixture'), { recursive: true });
      writeFileSync(join(repo.root, 'specs', 'node_modules', 'fixture', 'index.js'), 'unchanged-before-run\n');

      const config = loadConfigAt(repo.root);
      const env: Record<string, string> = {
        GATEFORGE_WITNESS_VERIFIER_KEY: 'reuse-mutation-verifier-key',
        GATEFORGE_APPROVED_POLICY_DIGEST: trustedPolicyDigestForConfig(repo.root, config),
      };
      const result = await runSupervisedCli(repo, ['pre-commit', '--scope', 'full'], env);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('reused dependency bytes changed during the run');
      expect(readFileSync(join(repo.root, 'specs', 'node_modules', 'fixture', 'index.js'), 'utf8')).toBe(
        'changed-during-run\n',
      );
    });
  }, 180_000);
  it('requires a matching owner pin and reports exact Python bytecode exclusions', async () => {
    await withTempRepo({}, async (repo) => {
      const cacheFile = 'generated/__pycache__/accounts.cpython-313.pyc';
      installStrictFixture(repo);
      repo.writeFiles({
        '.gitignore': 'node_modules\ntest-results\nplaywright-report\n.playwright\n.gateforge/test-gates\ngenerated/__pycache__/\n',
        '.gateforge/cache-exclusions.yml': `schemaVersion: 1\nfiles:\n  - \"${cacheFile}\"\n`,
        [cacheFile]: 'first-bytecode\n',
      });
      repo.git(['add', '-A']);
      repo.git(['commit', '--no-gpg-sign', '--quiet', '-m', 'cache exclusion fixture']);
      const config = loadConfigAt(repo.root);
      const pin = trustedPolicyDigestForConfig(repo.root, config);
      const args = ['check', '--require-e2e', '--format', 'json'];

      const unpinned = await runWorkspaceCli(repo, args, { GATEFORGE_APPROVED_POLICY_DIGEST: '' });
      expect(unpinned.code, `${unpinned.stdout}\n${unpinned.stderr}`).toBe(1);
      const unpinnedReport = JSON.parse(unpinned.stdout) as {
        diagnosticContext: { cacheExclusions?: { files: string[]; approvalStatus: string } };
      };
      expect(unpinnedReport.diagnosticContext.cacheExclusions).toMatchObject({
        files: [cacheFile],
        approvalStatus: 'missing',
      });

      const approved = await runWorkspaceCli(repo, args, { GATEFORGE_APPROVED_POLICY_DIGEST: pin });
      expect(approved.code).toBe(1);
      const approvedReport = JSON.parse(approved.stdout) as {
        diagnosticContext: {
          candidateTreeId: string | null;
          inputDigest: string | null;
          cacheExclusions?: { files: string[]; approvalStatus: string; approvalDigest: string | null };
        };
      };
      expect(approvedReport.diagnosticContext.cacheExclusions).toMatchObject({
        files: [cacheFile],
        approvalStatus: 'matched',
        approvalDigest: pin,
      });
      const approvedInput = approvedReport.diagnosticContext.inputDigest;
      const approvedTree = approvedReport.diagnosticContext.candidateTreeId;

      repo.writeFiles({ [cacheFile]: 'rewritten-bytecode\n' });
      const changedCache = await runWorkspaceCli(repo, args, { GATEFORGE_APPROVED_POLICY_DIGEST: pin });
      expect(changedCache.code).toBe(1);
      const changedReport = JSON.parse(changedCache.stdout) as {
        diagnosticContext: { candidateTreeId: string | null; inputDigest: string | null };
      };
      expect(changedReport.diagnosticContext.inputDigest).toBe(approvedInput);
      expect(changedReport.diagnosticContext.candidateTreeId).toBe(approvedTree);
    });
  });

});
