import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { withTempRepo } from '@gate-forge/core';
import { endpointResourceName } from '@gate-forge/http-contract';
import { autoSessionNodeOptions, defaultPlaywrightCommand } from '@gate-forge/pack-playwright';
import { trustedPolicyDigestForConfig } from '../src/execution.js';
import { loadConfigAt } from '../src/commands/common.js';
import { cleanupWitnessedFixture, installStrictFixture, operatorEnvironment, ROOT, FINGERPRINT, GATEFORGE_YML } from './witnessed-run-fixture.js';

const cases = [
  ['plain.spec.ts', "import { test, expect } from '@playwright/test';", 'test'],
  ['commonjs.spec.cjs', "const { test, expect } = require('@playwright/test');", 'test'],
  ['esm.spec.mjs', "import { test, expect } from '@playwright/test';", 'test'],
  ['module.spec.mts', "import { test, expect } from '@playwright/test';", 'test'],
  ['extended.spec.ts', "import { test as base, expect } from '@playwright/test';\nconst test = base.extend({ own: async ({}, use) => { await use(7); } });\ntest.beforeEach(async ({ page }) => { await page.goto('/'); });", 'test'],
  ['root.spec.ts', "import { test as base, expect } from '@playwright/test';\nconst test = base;", 'base.test'],
  ['explicit.spec.ts', "import { test as plain } from '@playwright/test';\nimport { test, expect } from '@gate-forge/pack-playwright/fixture';", 'test'],
] as const;

const ROUTE_SPEC = `import { test, expect } from '@playwright/test';
test('context stub keeps its outcome', async ({ page, context }) => {
  await page.goto('/');
  await context.unroute('**/*');
  await context.route('**/*', route => route.fulfill({ json: { message: 'Stubbed' } }));
  await page.getByRole('button', { name: 'Load' }).click();
  await expect(page.getByText('Stubbed')).toBeVisible();
});
test('context continue keeps the session rewrite', async ({ page, context }) => {
  await page.goto('/');
  const urls = [];
  await context.route('**/*', route => { urls.push(route.request().url()); return route.continue(); });
  await page.getByRole('button', { name: 'Load' }).click();
  await expect(page.getByText('Loaded')).toBeVisible();
  expect(urls).toHaveLength(1);
  expect(new URL(urls[0]).origin).not.toBe(new URL(process.env.TEST_SERVICE_URL).origin);
});
test('later page continue keeps its outcome', async ({ page }) => {
  await page.goto('/');
  const urls = [];
  await page.route('**/*', route => { urls.push(route.request().url()); return route.continue(); });
  await page.getByRole('button', { name: 'Load' }).click();
  await expect(page.getByText('Loaded')).toBeVisible();
  expect(urls).toHaveLength(1);
  expect(new URL(urls[0]).origin).toBe(new URL(process.env.TEST_SERVICE_URL).origin);
});
`;

const PROCESS_PROBE = `JSON.stringify({
  fixtureLoaded: Object.keys(require.cache).some(file => file.replaceAll('\\\\', '/').endsWith('/fixture/fixture.js')),
  playwrightModule: require.resolve('@playwright/test'),
  nodeOptions: process.env.NODE_OPTIONS,
})`;

describe('automatic witnessed Playwright sessions', () => {
  it('attributes every unchanged import shape, preserves extension hooks and direct API boundaries', async () => {
    const app = createServer((req, res) => {
      res.setHeader('x-gateforge-env-fingerprint', FINGERPRINT);
      if (req.url === '/') {
        res.setHeader('content-type', 'text/html');
        res.end('<button>Load</button><div id="result"></div><script>document.querySelector("button").onclick=async()=>{const response=await fetch("/api/items");const body=await response.json();document.querySelector("#result").textContent=body.message||"Loaded"}</script>');
      } else { res.setHeader('content-type', 'application/json'); res.end('{}'); }
    });
    await new Promise<void>((resolve) => app.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
    try {
      const reservation = createServer();
      await new Promise<void>(resolve => reservation.listen(0, '127.0.0.1', resolve));
      const probePort = (reservation.address() as AddressInfo).port;
      await new Promise<void>((resolve, reject) => reservation.close(error => error ? reject(error) : resolve()));
      await withTempRepo({}, async (repo) => {
        installStrictFixture(repo, {});
        const specs: Record<string, string> = {};
        for (const [file, imports, call] of cases) {
          specs[`specs/${file}`] = `${imports}\n${call}('${file}', async ({ page }) => {\n${file === 'root.spec.ts' ? "const api = await test.request.newContext(); await api.get('/api/direct'); await api.dispose();" : ''}\n${file === 'explicit.spec.ts' ? "expect(plain.request.newContext).toBeDefined(); expect(plain.chromium).toBeDefined(); expect(test.request).toBeUndefined(); expect(test.chromium).toBeUndefined(); expect(test.test).toBeUndefined();" : ''}\nawait page.goto('/'); await page.getByRole('button', { name: 'Load' }).click(); await expect(page.getByText('Loaded')).toBeVisible();\n});\n`;
        }
        specs['specs/direct.spec.ts'] = "import { test, request, expect } from '@playwright/test';\ntest('direct only', async () => { const api = await request.newContext(); expect((await api.get('/api/direct')).status()).toBe(200); await api.dispose(); });\n";
        specs['specs/routes.spec.ts'] = ROUTE_SPEC;
        specs['specs/processes.spec.cjs'] = `const { test, expect } = require('@playwright/test');
const { spawnSync } = require('node:child_process');
const { readFileSync, writeFileSync } = require('node:fs');
test('inherited hook stays out of application processes', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Load' }).click();
  await expect(page.getByText('Loaded')).toBeVisible();
  const server = JSON.parse(readFileSync('server-process.json', 'utf8'));
  const child = spawnSync(process.execPath, ['-e', ${JSON.stringify(`console.log(${PROCESS_PROBE})`)}], { encoding: 'utf8' });
  expect(child.status, child.stderr).toBe(0);
  const grandchild = JSON.parse(child.stdout);
  writeFileSync('grandchild-process.json', JSON.stringify(grandchild));
  for (const probe of [server, grandchild]) {
    expect.soft(probe.nodeOptions).toContain('auto-session.cjs');
    expect.soft(probe.fixtureLoaded).toBe(false);
    expect.soft(probe.playwrightModule).not.toContain('auto-session-wrapper');
    expect.soft(probe.playwrightModule.replaceAll('\\\\', '/')).toContain('/node_modules/@playwright/test/');
  }
});
`;
        repo.writeFiles({
          ...specs,
          'probe-server.cjs': `const { createServer } = require('node:http');
const { writeFileSync } = require('node:fs');
const probe = ${PROCESS_PROBE};
writeFileSync('server-process.json', probe);
createServer((req, res) => { res.setHeader('content-type', 'application/json'); res.end(probe); }).listen(${probePort}, '127.0.0.1');
`,
          '.gateforge.yml': `${GATEFORGE_YML.replace('adapters: .gateforge/adapters', 'adapters: .gateforge/adapters-api')}runtime: .gateforge/runtime.yml\n`,
          '.gateforge/adapters-api/.gitkeep': '',
          '.gateforge/runtime.yml': 'schemaVersion: 1\nenvAllowlist: [TEST_SERVICE_URL]\n',
          '.gateforge/fixture-detector.mjs': "import { endpointResourceName } from '@gate-forge/http-contract';\nexport default { async discover() { const resourceName = endpointResourceName('GET', '/api/items'); return { resources: [{ schemaVersion: 1, id: 'items', kind: 'http.endpoint', source: 'src/accounts.js', location: { file: 'src/accounts.js', line: 1, col: 0 }, detectorVersion: '1.0.0', attributes: { resourceName, method: 'GET', canonicalPath: '/api/items', identity: 'GET /api/items' } }], unresolved: [], findings: [], classificationSignals: ['plane', 'identity'].map(dimension => ({ schemaVersion: 1, target: { resourceName }, dimension, assertion: dimension === 'plane' ? 'tenant' : ['GET', '/api/items'], basis: 'declaration', source: 'gateforge.fixture', location: { file: 'src/accounts.js', line: 1, col: 0 }, detector: { id: 'gateforge.fixture', version: '1.0.0' } })) }; } };\n",
          '.gateforge/policies.yml': 'schemaVersion: 1\npolicies:\n  - id: observed\n    when: { kind: http.endpoint }\n    require: [http:request-observed, http:response-status-ok]\n',
          'playwright.config.mjs': `export default { testDir: 'specs', workers: 1, retries: 0, webServer: { command: 'node probe-server.cjs', url: 'http://127.0.0.1:${probePort}', reuseExistingServer: false }, projects: [{ name: 'chromium', use: { browserName: 'chromium' } }], use: { headless: true, baseURL: process.env.TEST_SERVICE_URL } };\n`,
          '.gateforge/test-map.yml': 'schemaVersion: 1\ntests:\n' + [...cases.map(([file]) => ({ file, title: file })), { file: 'processes.spec.cjs', title: 'inherited hook stays out of application processes' }, ...['context continue keeps the session rewrite', 'later page continue keeps its outcome'].map(title => ({ file: 'routes.spec.ts', title }))].map(({ file, title }) => `  - key: playwright:chromium:specs/${file}:${title}\n    selector: { runner: playwright, project: chromium, file: specs/${file}, titlePath: ['${title}'] }\n    kind: observed-e2e\n    claims: ['tenant.${endpointResourceName('GET', '/api/items')}:http:request-observed', 'tenant.${endpointResourceName('GET', '/api/items')}:http:response-status-ok']\n    reason: Browser action loads items.\n`).join(''),
        });
        repo.git(['add', '-A']);
        repo.git(['commit', '--no-gpg-sign', '--quiet', '-m', 'neutral automatic session fixture']);
        repo.writeFiles({ 'src/accounts.js': '// changed endpoint source\n' });
        repo.git(['add', 'src/accounts.js']);
        // Witnessed execution intentionally excludes consumer webServer hooks.
        // First exercise native Playwright's actual server child with the same preload.
        const [executable, ...command] = defaultPlaywrightCommand(repo.root);
        const native = spawn(executable!, [...command, 'test', 'processes.spec.cjs', '--reporter=line'], {
          cwd: repo.root,
          env: { ...process.env, TEST_SERVICE_URL: url, NODE_OPTIONS: autoSessionNodeOptions(process.env.NODE_OPTIONS) },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let nativeOutput = '';
        native.stdout.on('data', chunk => { nativeOutput += String(chunk); });
        native.stderr.on('data', chunk => { nativeOutput += String(chunk); });
        const nativeCode = await new Promise<number | null>((resolve, reject) => { native.once('error', reject); native.once('close', resolve); });
        expect.soft(nativeCode, nativeOutput).toBe(0);
        const { env } = operatorEnvironment();
        const child = spawn(process.execPath, [join(ROOT, 'packages/cli/bin/gateforge.js'), 'test-gates', '--changed', '--format', 'json'], {
          cwd: repo.root,
          env: { ...process.env, ...env, TEST_SERVICE_URL: url, GATEFORGE_APP_BASE_URL: url, GATEFORGE_TARGET_BASE_URL: url, GATEFORGE_TARGET_FINGERPRINT: FINGERPRINT, GATEFORGE_APPROVED_POLICY_DIGEST: trustedPolicyDigestForConfig(repo.root, loadConfigAt(repo.root)) },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stdout = ''; let stderr = '';
        child.stdout.on('data', chunk => { stdout += String(chunk); });
        child.stderr.on('data', chunk => { stderr += String(chunk); });
        await new Promise<void>((resolve, reject) => { child.once('error', reject); child.once('close', () => resolve()); });
        const report = JSON.parse(stdout);
        expect(existsSync(repo.path('.gateforge/test-gates/records.json')), `${stdout}\n${stderr}`).toBe(true);
        const records = JSON.parse(readFileSync(repo.path('.gateforge/test-gates/records.json'), 'utf8')) as Array<{ kind: string; testId?: string; payload?: { channel?: string; exchanges?: Array<{ url: string }> } }>;
        const result = JSON.parse(readFileSync(repo.path('.gateforge/test-gates/execution-result.json'), 'utf8'));
        const evidence = `${stdout}\n${stderr}`;
        expect.soft(result.outcomes, evidence).toHaveLength(cases.length + 5);
        expect.soft(result.outcomes.every((row: { status: string }) => row.status === 'passed'), evidence).toBe(true);
        for (const [file] of cases) {
          const outcome = result.outcomes.find((row: { titlePath: string[] }) => row.titlePath.includes(file));
          expect.soft(outcome?.status, evidence).toBe('passed');
          const observed = records.filter(row => row.kind === 'http.observed' && row.testId === outcome?.runnerTestId && row.payload?.channel !== 'direct');
          expect.soft(observed.flatMap(row => row.payload?.exchanges ?? []).some(exchange => exchange.url.endsWith('/api/items')), file + evidence).toBe(true);
          expect.soft(result.sessionTrace.find((row: { titlePath: string[] }) => row.titlePath.includes(file))?.sessions.length, file + evidence).toBe(1);
        }
        for (const title of ['context stub keeps its outcome', 'context continue keeps the session rewrite', 'later page continue keeps its outcome']) {
          const outcome = result.outcomes.find((row: { titlePath: string[] }) => row.titlePath.includes(title));
          expect.soft(outcome?.status, title + evidence).toBe('passed');
          const hasItemsExchange = records.some(row => row.kind === 'http.observed' && row.testId === outcome?.runnerTestId && row.payload?.channel !== 'direct' && row.payload?.exchanges?.some(exchange => exchange.url.endsWith('/api/items')));
          expect.soft(hasItemsExchange, title + evidence).toBe(title === 'context continue keeps the session rewrite');
        }
        const processTitle = 'inherited hook stays out of application processes';
        const processOutcome = result.outcomes.find((row: { titlePath: string[] }) => row.titlePath.includes(processTitle));
        expect.soft(processOutcome?.status, processTitle + evidence).toBe('passed');
        expect.soft(records.some(row => row.kind === 'http.observed' && row.testId === processOutcome?.runnerTestId && row.payload?.channel !== 'direct' && row.payload?.exchanges?.some(exchange => exchange.url.endsWith('/api/items'))), processTitle + evidence).toBe(true);
        for (const file of ['server-process.json', 'grandchild-process.json']) {
          const probe = JSON.parse(readFileSync(repo.path(file), 'utf8'));
          expect.soft(probe.nodeOptions, file).toContain('auto-session.cjs');
          expect.soft(probe.fixtureLoaded, file).toBe(false);
          expect.soft(probe.playwrightModule, file).not.toContain('auto-session-wrapper');
          expect.soft(probe.playwrightModule.replaceAll('\\', '/'), file).toContain('/node_modules/@playwright/test/');
        }
        expect.soft(records.filter(row => row.kind === 'http.observed' && row.payload?.channel !== 'direct').flatMap(row => row.payload?.exchanges ?? []).some(exchange => exchange.url.endsWith('/api/direct')), evidence).toBe(false);
        expect.soft(records.filter(row => row.kind === 'http.observed' && row.testId && row.payload?.channel === 'direct').flatMap(row => row.payload?.exchanges ?? []).some(exchange => exchange.url.endsWith('/api/direct')), evidence).toBe(true);
        expect.soft(result.measuredTests, evidence).toBe(cases.length + 5);
        expect.soft(result.executedTests, evidence).toBe(cases.length + 5);
        expect.soft(result.measuredTests, evidence).toBe(result.executedTests);
        expect.soft(report.execution.measuredTests, evidence).toBe(cases.length + 5);
        expect.soft(report.execution.executedTests, evidence).toBe(cases.length + 5);
      });
    } finally {
      await new Promise<void>((resolve, reject) => app.close(error => error ? reject(error) : resolve()));
      cleanupWitnessedFixture();
    }
  }, 240_000);
});
