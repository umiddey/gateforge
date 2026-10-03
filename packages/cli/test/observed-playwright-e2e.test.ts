import { afterEach, describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withTempRepo } from '@gate-forge/core';
import { trustedPolicyDigestForConfig } from '../src/execution.js';
import { loadConfigAt } from '../src/commands/common.js';
import { cleanupWitnessedFixture, installStrictFixture, operatorEnvironment, ROOT, FINGERPRINT, ADAPTER, GATEFORGE_YML } from './witnessed-run-fixture.js';

/**
 * The candidate's own Playwright config plus ONE added statement: the
 * module records that it was genuinely loaded, which is exactly what a
 * reserved control request must be refused BEFORE. The marker lives
 * OUTSIDE the candidate repository, so observing it can never dirty or
 * drift the graded input tree.
 *
 * Args:
 *   markerPath: absolute path the loaded config records itself at.
 *
 * Returns:
 *   string: the config module source.
 */
function configLoadMarkerSource(markerPath: string): string {
  return `import { writeFileSync } from 'node:fs';
import { defineConfig } from 'playwright/test';
writeFileSync(${JSON.stringify(markerPath)}, 'candidate config loaded');
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
}

const TITLE = 'creates an account through a native browser form';
const CLAIM = 'tenant.accounts:persistence:create';
const SPEC = `import { test, expect } from '@gate-forge/pack-playwright';
test('${TITLE}', async ({ page }) => {
  expect(process.env.GATEFORGE_WITNESS_VERIFIER_KEY).toBeUndefined();
  expect(process.env.GATEFORGE_WITNESS_VERIFIER_KEY_FILE).toBeUndefined();
  expect(process.env.GATEFORGE_STATE_DIR).toBeUndefined();
  expect(process.env.UNLISTED_SERVICE_URL).toBeUndefined();
  await page.goto(process.env.TEST_SERVICE_URL);
  await page.locator('[name="first_name"]').fill('Ada');
  await page.locator('[name="last_name"]').fill('Lovelace');
  await page.locator('button').click();
  await expect(page.locator('#saved')).toHaveText('saved');
});`;

/** The app owns the write; the witness's adapter performs independent reads. */
async function startApp() {
  const rows = new Map<string, { id: string; first_name: string; last_name: string; status: string }>();
  const server = createServer((req, res) => {
    res.setHeader('x-gateforge-env-fingerprint', FINGERPRINT);
    if (req.method === 'GET' && req.url === '/') {
      res.setHeader('content-type', 'text/html');
      res.end(`<form><input name="first_name"><input name="last_name"><input type="hidden" name="status" value="pending"><button>Create</button></form><p id="saved"></p>
<script>document.querySelector('form').onsubmit = async event => {
  event.preventDefault();
  const form = new FormData(event.target);
  const result = await fetch('/api/accounts', { method: 'POST', headers: {'content-type':'application/json'},
    body: JSON.stringify({first_name: form.get('first_name'), last_name: form.get('last_name'), status: form.get('status')}) });
  if (result.status === 201) document.getElementById('saved').textContent = 'saved';
};</script>`);
      return;
    }
    if (req.method === 'POST' && req.url === '/api/accounts') {
      let body = '';
      req.on('data', chunk => { body += chunk.toString(); });
      req.on('end', () => {
        const fields = JSON.parse(body) as { first_name: string; last_name: string };
        const row = { id: `account-${rows.size + 1}`, ...fields, status: 'active' };
        rows.set(row.id, row);
        res.writeHead(201, { 'content-type': 'application/json' });
        res.end(JSON.stringify(row));
      });
      return;
    }
    res.setHeader('content-type', 'application/json');
    if (req.method === 'GET' && req.url === '/api/accounts') {
      res.end(JSON.stringify({ accounts: [...rows.values()] }));
      return;
    }
    const row = rows.get((req.url ?? '').slice('/api/accounts/'.length));
    res.statusCode = row === undefined ? 404 : 200;
    res.end(JSON.stringify(row ?? { error: 'not found' }));
  });
  await new Promise<void>(resolve => server.listen(0, 'localhost', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no app port');
  return {
    url: `http://localhost:${address.port}`,
    rows,
    stop: () => new Promise<void>(resolve => server.close(() => resolve())),
  };
}

/** A separate CLI process proves the published command boundary, not a forwarded mock. */
async function runCliProcess(cwd: string, env: Record<string, string>, args = ['test-gates', '--test', TITLE, '--result-only', '--format', 'json']) {
  const entry = process.env['GATEFORGE_TEST_BASELINE_CLI'] ?? `${ROOT}/packages/cli/bin/gateforge.js`;
  const child = spawn(process.execPath, [entry, ...args], {
    cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk.toString(); });
  child.stderr.on('data', chunk => { stderr += chunk.toString(); });
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  return { code, stdout, stderr };
}

afterEach(cleanupWitnessedFixture);

describe('Playwright Observe declarations through the actual CLI', () => {
  it('observes a native localhost UI write without chaos or twin options and independently verifies the row', async () => {
    const app = await startApp();
    try {
      await withTempRepo({}, async repo => {
        installStrictFixture(repo, { 'specs/native.spec.js': SPEC });
        repo.writeFiles({
          '.gateforge.yml': `${GATEFORGE_YML}runtime: .gateforge/runtime.yml\n`,
          '.gateforge/runtime.yml': 'schemaVersion: 1\nenvAllowlist: [TEST_SERVICE_URL]\n',
          '.gateforge/policies.yml': 'schemaVersion: 1\npolicies:\n  - id: persistence\n    when: {}\n    require: [persistence:create]\n',
          '.gateforge/adapters/tenant.accounts.mjs': ADAPTER.replace('  deletion:', "  observe: { create: { method: 'POST', path: '/api/accounts' } },\n  volatileFields: ['status'],\n  deletion:"),
          '.gateforge/test-map.yml': `schemaVersion: 1\ntests:\n  - key: playwright:chromium:specs/native.spec.js:${TITLE}\n    selector:\n      runner: playwright\n      project: chromium\n      file: specs/native.spec.js\n      titlePath: ['${TITLE}']\n    kind: observed-e2e\n    claims: ['${CLAIM}']\n    reason: Native UI writes an account; independent engine reads verify its persisted fields.\n`,
        });
        repo.git(['add', '-A']);
        repo.git(['commit', '--no-gpg-sign', '--quiet', '-m', 'native observed UI fixture']);
        repo.writeFiles({ 'src/accounts.js': '// accounts resource\n// changed source\n' });
        repo.git(['add', 'src/accounts.js']);
        const { env } = operatorEnvironment();
        const runEnv = {
          ...env,
          TEST_SERVICE_URL: app.url,
          UNLISTED_SERVICE_URL: app.url,
          GATEFORGE_APP_BASE_URL: app.url,
          GATEFORGE_TARGET_BASE_URL: app.url,
          GATEFORGE_TARGET_FINGERPRINT: FINGERPRINT,
          GATEFORGE_APPROVED_POLICY_DIGEST: trustedPolicyDigestForConfig(repo.root, loadConfigAt(repo.root)),
        };
        const run = await runCliProcess(repo.root, runEnv, ['test-gates', '--changed', '--format', 'json']);
        const report = JSON.parse(run.stdout) as { verdicts: Array<{ obligationId: string; verdict: string }>; execution: { selectedTests: { passed: number; failed: number } } };
        expect(report.verdicts.find(verdict => verdict.obligationId === CLAIM), `${run.stdout}\n${run.stderr}`).toMatchObject({ verdict: 'satisfied' });
        expect(run.code, `${run.stdout}\n${run.stderr}`).toBe(0);
        expect(report.execution.selectedTests).toMatchObject({ passed: 1, failed: 0 });
        expect([...app.rows.values()]).toEqual([{ id: 'account-1', first_name: 'Ada', last_name: 'Lovelace', status: 'active' }]);
        const checked = await runCliProcess(repo.root, runEnv, ['check', '--changed', '--require-e2e', '--format', 'json']);
        expect(checked.code, `${checked.stdout}\n${checked.stderr}`).toBe(0);
        const checkReport = JSON.parse(checked.stdout) as { advisories?: Array<{ cause: string; resourceId: string; detail: string }> };
        // The declared skip is disclosed by NAME only: one advisory for
        // this resource, naming the skipped key, never a value.
        expect(
          checkReport.advisories?.filter(entry => entry.cause === 'ADAPTER_VOLATILE_FIELD_SKIPPED'),
          `${checked.stdout}\n${checked.stderr}`,
        ).toEqual([
          expect.objectContaining({ resourceId: 'tenant.accounts', detail: expect.stringContaining('status') }),
        ]);
      });
    } finally {
      await app.stop();
    }
  }, 180_000);

  // The refused repo is the SAME repository the positive case observes,
  // with its mapping, so the named selector resolves. The candidate's own
  // config records its load outside the repository: the refusal is then
  // observed as a real side effect that never happened — not as a
  // sentence, a mock, or a timeout.
  it.each(['GATEFORGE_WITNESS_VERIFIER_KEY_FILE', 'NODE_OPTIONS'])(
    'refuses an owner envAllowlist request for reserved control %s before candidate configuration runs',
    async name => {
      const markerDir = mkdtempSync(join(tmpdir(), 'gateforge-reserved-env-'));
      const markerPath = join(markerDir, 'native-config-loaded.marker');
      try {
        await withTempRepo({}, async repo => {
          installStrictFixture(repo, { 'specs/native.spec.js': SPEC });
          repo.writeFiles({
            'playwright.config.mjs': configLoadMarkerSource(markerPath),
            '.gateforge.yml': `${GATEFORGE_YML}runtime: .gateforge/runtime.yml\n`,
            '.gateforge/runtime.yml': `schemaVersion: 1\nenvAllowlist: ['${name}']\n`,
            '.gateforge/policies.yml': 'schemaVersion: 1\npolicies:\n  - id: persistence\n    when: {}\n    require: [persistence:create]\n',
            '.gateforge/adapters/tenant.accounts.mjs': ADAPTER.replace('  deletion:', "  observe: { create: { method: 'POST', path: '/api/accounts' } },\n  volatileFields: ['status'],\n  deletion:"),
            '.gateforge/test-map.yml': `schemaVersion: 1\ntests:\n  - key: playwright:chromium:specs/native.spec.js:${TITLE}\n    selector:\n      runner: playwright\n      project: chromium\n      file: specs/native.spec.js\n      titlePath: ['${TITLE}']\n    kind: observed-e2e\n    claims: ['${CLAIM}']\n    reason: Native UI writes an account; independent engine reads verify its persisted fields.\n`,
          });
          repo.git(['add', '-A']);
          repo.git(['commit', '--no-gpg-sign', '--quiet', '-m', 'reserved runner environment fixture']);
          const { env } = operatorEnvironment();
          const run = await runCliProcess(repo.root, {
            ...env,
            GATEFORGE_APPROVED_POLICY_DIGEST: trustedPolicyDigestForConfig(repo.root, loadConfigAt(repo.root)),
          });
          const observed = `${run.stdout}\n${run.stderr}`;
          expect(run.code, observed).toBe(2);
          // The candidate's own configuration module never executed.
          expect(
            existsSync(markerPath),
            'candidate Playwright configuration was loaded before the reserved control was refused',
          ).toBe(false);
        });
      } finally {
        rmSync(markerDir, { recursive: true, force: true });
      }
    }, 180_000,
  );
});
