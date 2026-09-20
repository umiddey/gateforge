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
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { withTempRepo, type TempRepo } from '@gate-forge/core';
import { startAttestationProxy } from '@gate-forge/pack-playwright';
import { trustedPolicyDigestForConfig } from '../src/execution.js';
import { loadConfigAt } from '../src/commands/common.js';
import { runCli } from './helpers.js';

/** Repo root (example app + surface descriptor live here). */
const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
/** The env fingerprint the attestation proxy stamps. */
const FINGERPRINT = 'example-v1';

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
  symlinkSync(join(ROOT, 'node_modules'), join(repo.root, 'node_modules'), 'dir');
}

describe('strict supervised gate (test-gates --changed + receipt + check)', () => {
  it('a genuine engine-browser journey passes the strict gate and seals a verifying receipt', async () => {
    // The OPERATOR environment (verifier key + approved pin + app base)
    // lives outside the candidate and is inherited by hooks: set it on
    // process.env BEFORE the repo exists so every git child inherits it,
    // and restore it after (production shells provide it the same way).
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
    try {
      await withTempRepo({}, async (repo) => {
        installStrictFixture(repo);
        repo.git(['add', '-A']);
        repo.git(['commit', '--no-gpg-sign', '--quiet', '-m', 'strict fixture']);
        // The blocking hook is installed after the base commit (the base
        // itself carries no receipt yet) but BEFORE the run, so its own
        // files are part of the tree the receipt later binds.
        const initEnv: Record<string, string> = {
          GATEFORGE_WITNESS_VERIFIER_KEY: 'strict-supervised-verifier-key',
        };
        setOperator(initEnv);
        const hooked = await runCli(repo, ['init', '--blocking'], initEnv);
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
        const env: Record<string, string> = {
          GATEFORGE_WITNESS_VERIFIER_KEY: 'strict-supervised-verifier-key',
          GATEFORGE_APP_BASE_URL: proxy.url,
          GATEFORGE_TARGET_BASE_URL: proxy.url,
          GATEFORGE_TARGET_FINGERPRINT: FINGERPRINT,
          GATEFORGE_APPROVED_POLICY_DIGEST: pin,
        };
        setOperator(env);
        const gated = await runCli(repo, ['test-gates', '--changed', '--format', 'json'], env);
        expect(gated.code, `test-gates stdout:\n${gated.stdout}\nstderr:\n${gated.stderr}`).toBe(0);
        const report = JSON.parse(gated.stdout) as {
          summary: { obligations: number; blocking: number };
          verdicts: Array<{ obligationId: string; verdict: string }>;
        };
        expect(report.summary.blocking).toBe(0);
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
        // check --require-e2e reuses the receipt for the exact candidate.
        const checked = await runCli(repo, ['check', '--changed', '--require-e2e', '--format', 'json'], env);
        expect(checked.code, `check stdout:\n${checked.stdout}\nstderr:\n${checked.stderr}`).toBe(0);
        // Exact-candidate commit check: stage the exact verified bytes
        // and commit for real — the hook's check --staged authorizes the
        // commit for the frozen tree (the hook inherits the OPERATOR
        // environment already set on process.env).
        repo.git(['add', '-A']);
        const committed = repo.git(
          ['commit', '--no-gpg-sign', '--quiet', '-m', 'genuine engine-browser change'],
          { allowFailure: true },
        );
        expect(committed.status, `commit stderr:\n${committed.stderr}`).toBe(0);
        const log = repo.git(['log', '--oneline', '-1']);
        expect(log.stdout).toContain('genuine engine-browser change');
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
          const discovered = await runCli(repo, ['tests', 'discover', '--json'], env);
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
          const suggested = await runCli(repo, ['tests', 'suggest', '--json'], env);
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
          const preMark = await runCli(repo, ['check', '--format', 'json'], env);
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
            const marked = await runCli(
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
          const gated = await runCli(repo, ['test-gates', '--changed', '--format', 'json'], env);
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
          const checked = await runCli(repo, ['check', '--changed', '--require-e2e', '--format', 'json'], env);
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

  it('an uncovered behavior blocks the gate until a real journey covers it (E05)', async () => {
    // The OPERATOR environment (same provisioning as the native test).
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
    try {
      await withTempRepo({}, async (repo) => {
        installStrictFixture(repo);
        // The owner REQUIRES the read behavior too (the detector already
        // declares lifecycle.read, and the app renders it). The existing
        // suite has NO test covering reads.
        repo.writeFiles({
          '.gateforge/policies.yml': `schemaVersion: 1
policies:
  - id: crud
    when: {}
    require: [crud:create, crud:read, crud:update, crud:delete]
`,
        });
        repo.git(['add', '-A']);
        repo.git(['commit', '--no-gpg-sign', '--quiet', '-m', 'read-required fixture']);
        // The genuine candidate change under test.
        repo.writeFiles({ 'src/accounts.js': '// fixture source: the accounts resource lives here.\n// change: audited comment.\n' });
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
          const suggested = await runCli(repo, ['tests', 'suggest', '--json'], env);
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
          // obligation stays blocking with the mapping-missing cause.
          const gatedA = await runCli(repo, ['test-gates', '--changed', '--format', 'json'], env);
          expect(gatedA.code, `test-gates (phase A) stdout:\n${gatedA.stdout}\nstderr:\n${gatedA.stderr}`).toBe(1);
          const reportA = JSON.parse(gatedA.stdout) as {
            verdicts: Array<{ obligationId: string; verdict: string; cause: string | null }>;
          };
          const readA = reportA.verdicts.find((entry) => entry.obligationId === 'tenant.accounts:crud:read');
          expect(readA?.verdict).toBe('missing');
          expect(readA?.cause).toBe('TEST_MAPPING_MISSING');
          for (const id of ['tenant.accounts:crud:create', 'tenant.accounts:crud:update', 'tenant.accounts:crud:delete']) {
            expect(reportA.verdicts.find((entry) => entry.obligationId === id)?.verdict).toBe('satisfied');
          }
          // (c) No receipt was sealed for the blocked run.
          expect(existsSync(join(repo.root, '.gateforge/test-gates/receipt.json'))).toBe(false);

          // ---- Phase B: a REAL new browser journey covers the behavior ----
          // The journey drives the rendered UI through the engine (clicks
          // the row's edit control, reads the rendered form), confirms the
          // visible result, observes the real GET exchange, and verifies
          // persistence — then the strict gate passes end to end.
          repo.writeFiles({ 'specs/crud.spec.js': SPEC_WITH_READ });
          const gatedB = await runCli(repo, ['test-gates', '--changed', '--format', 'json'], env);
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
          const checked = await runCli(repo, ['check', '--changed', '--require-e2e', '--format', 'json'], env);
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
      const gated = await runCli(repo, ['test-gates', '--changed', '--format', 'json'], env);
      expect(gated.code).toBe(1);
      expect(gated.stderr).toMatch(/approved|policy|weakened|ENFORCEMENT_UNTRUSTED/i);
    });
  }, 120_000);
});
