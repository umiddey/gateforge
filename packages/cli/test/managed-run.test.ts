/**
 * `gateforge run` on the example app (managed-run plan, Part B).
 *
 * The whole point of the command is that ONE invocation reproduces a
 * witnessed proof locally: preflight, the app's own recipe, the
 * supervised suite, the strict receipt check, and the teardown. The
 * fixture is the same genuine one the supervised gate uses — real
 * browser journeys through the real example app behind the real
 * attestation proxy, no mocks in the evidence path — with a tiny recipe
 * that only records what ran.
 */
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { withTempRepo, type TempRepo } from '@gate-forge/core';
import { startAttestationProxy } from '@gate-forge/pack-playwright';
import { trustedPolicyDigestForConfig } from '../src/execution.js';
import { loadConfigAt, VERIFIER_KEY_FILE_ENV } from '../src/commands/common.js';
import { runCli } from './helpers.js';

/** Repo root (example app + surface descriptor live here). */
const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
/** The env fingerprint the attestation proxy stamps. */
const FINGERPRINT = 'example-v1';
/** Temporary verifier key rings to clean up. */
const keyDirectories: string[] = [];

afterEach(() => {
  for (const directory of keyDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
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


/**
 * Writes an external owner-only verifier key ring and returns the
 * operator environment a witnessed run needs.
 *
 * Returns:
 *   { keyFile, env }: the key file and the operator environment.
 */
function operatorEnvironment(): { keyFile: string; env: Record<string, string> } {
  const directory = mkdtempSync(join(tmpdir(), 'gateforge-managed-run-'));
  keyDirectories.push(directory);
  const keyFile = join(directory, 'keys.json');
  writeFileSync(
    keyFile,
    `${JSON.stringify({ schemaVersion: 1, activeKeyId: 'managed-run-key', keys: { 'managed-run-key': 'managed-run-verifier-key' } })}\n`,
    { mode: 0o600 },
  );
  return { keyFile, env: { [VERIFIER_KEY_FILE_ENV]: keyFile } };
}

/**
 * Writes the tiny recipe the managed run executes: a reset that only
 * records itself, and the teardown that must run after a failure too.
 *
 * Args:
 *   repo: the fixture repository.
 *   resetExitCode: exit code the reset step exits with.
 */
function writeTinyRecipe(repo: TempRepo, resetExitCode = 0): void {
  repo.writeFiles({
    '.gateforge/runtime.yml': `schemaVersion: 1
reset:
  commands:
    - ['${process.execPath}', '-e', "require('fs').writeFileSync('recipe-ran.txt','reset\\\\n');process.exit(${String(resetExitCode)})"]
services_down:
  commands:
    - ['${process.execPath}', '-e', "require('fs').writeFileSync('recipe-ran.txt','reset\\\\nservices_down\\\\n')"]
`,
  });
}

/**
 * Reads the recipe steps that executed, in order.
 *
 * Args:
 *   repo: the fixture repository.
 *
 * Returns:
 *   string[]: the recorded step names.
 */
function recipeSteps(repo: TempRepo): string[] {
  const path = join(repo.root, 'recipe-ran.txt');
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').filter((line) => line.length > 0);
}

describe('gateforge run (the whole local proof, in order)', () => {
  it('sequences preflight, the recipe, the supervised suite and the strict check to a green receipt', async () => {
    const { env } = operatorEnvironment();
    await withTempRepo({}, async (repo) => {
      writeTinyRecipe(repo);
      installStrictFixture(repo);
      repo.git(['add', '-A']);
      repo.git(['commit', '--no-gpg-sign', '--quiet', '-m', 'managed run fixture']);
      // The genuine candidate change under test (obligations still bind it).
      repo.writeFiles({ 'src/accounts.js': '// fixture source: the accounts resource lives here.\n// change: audited comment.\n' });
      const app = await startApp();
      const proxy = await startAttestationProxy(app.url, FINGERPRINT);
      try {
        const config = loadConfigAt(repo.root);
        const runEnv = {
          ...env,
          GATEFORGE_APP_BASE_URL: proxy.url,
          GATEFORGE_TARGET_BASE_URL: proxy.url,
          GATEFORGE_TARGET_FINGERPRINT: FINGERPRINT,
          GATEFORGE_APPROVED_POLICY_DIGEST: trustedPolicyDigestForConfig(repo.root, config),
        };
        const result = await runCli(repo, ['run', '--', '--changed'], runEnv);
        expect(result.code, `run stdout:\n${result.stdout}\nstderr:\n${result.stderr}`).toBe(0);
        // One plain line per step, in lifecycle order, with a duration.
        const steps = result.stdout
          .split('\n')
          .filter((line) => line.startsWith('  [step] '))
          .map((line) => line.replace('  [step] ', '').replace(/: [\d.]+m?s$/, ''));
        expect(steps).toEqual(['preflight', 'reset', 'test-gates', 'check --require-e2e', 'services_down']);
        expect(result.stdout).toContain('gateforge run: complete');
        expect(recipeSteps(repo)).toEqual(['reset', 'services_down']);
        // The receipt is the engine's, not the sequencer's: the strict
        // check inside the run verified it, and it landed in the
        // user's own worktree.
        const receipt = JSON.parse(readFileSync(join(repo.root, '.gateforge/test-gates/receipt.json'), 'utf8')) as {
          approvedPolicyDigest: string;
          verifierKeyId: string;
        };
        expect(receipt.approvedPolicyDigest).toBe(runEnv.GATEFORGE_APPROVED_POLICY_DIGEST);
        expect(receipt.verifierKeyId).toBe('managed-run-key');
      } finally {
        await proxy.stop();
        app.stop();
      }
    });
  }, 600_000);

  it('stops at a failing recipe step with that step\'s own exit code, and still tears down', async () => {
    const { env } = operatorEnvironment();
    await withTempRepo({}, async (repo) => {
      installStrictFixture(repo);
      writeTinyRecipe(repo, 7);
      repo.git(['add', '-A']);
      repo.git(['commit', '--no-gpg-sign', '--quiet', '-m', 'managed run fixture']);
      const result = await runCli(repo, ['run'], { ...env });
      expect(result.code).toBe(7);
      expect(result.stderr).toContain("recipe step 'reset' failed with exit 7");
      expect(result.stdout).toContain('[step] services_down:');
      expect(recipeSteps(repo)).toEqual(['reset', 'services_down']);
      // The supervised run never started, so there is no receipt to trust.
      expect(existsSync(join(repo.root, '.gateforge/test-gates/receipt.json'))).toBe(false);
    });
  });

  it('a failing preflight stops the run before any recipe step executes', async () => {
    const { env } = operatorEnvironment();
    await withTempRepo({}, async (repo) => {
      installStrictFixture(repo);
      writeTinyRecipe(repo);
      const result = await runCli(repo, ['run'], { ...env, GATEFORGE_APPROVED_POLICY_DIGEST: '0'.repeat(64) });
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('run: preflight failed');
      expect(result.stderr).toContain('approved-policy');
      expect(recipeSteps(repo)).toEqual([]);
    });
  });
});
