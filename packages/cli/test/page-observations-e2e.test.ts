import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { once } from 'node:events';
import { existsSync, readFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { withTempRepo, type TempRepo } from '@gate-forge/core';
import { startAttestationProxy } from '@gate-forge/pack-playwright';
import { loadConfigAt } from '../src/commands/common.js';
import { trustedPolicyDigestForConfig } from '../src/execution.js';
import { cleanupWitnessedFixture, FINGERPRINT, operatorEnvironment, ROOT } from './witnessed-run-fixture.js';
import { configYml } from './helpers.js';

const PAGE_PLUGIN = `  - id: gateforge.pack-react-router
    version: '0.13.0'
    transport: in-process
    module: '@gate-forge/pack-react-router'`;
const PAGE_COVERAGE = "coverage: [{ capability: pages.react-router, detector: gateforge.pack-react-router, appliesTo: ['src/**/*.tsx'] }]";
const PAGE_CONFIG = `pages:
  router: react-router
  audiences:
    - name: tenant
      loginRoute: /login
      guard: TenantGuard
  errorMarkers: ['Something went wrong']
  params: {}
  exclude: []
  sweep: false
`;
const ROUTES = `import { Route } from 'react-router-dom';

export const routes = <>
  <Route path="/orders/:id" element={<TenantGuard><Orders /></TenantGuard>} />
  <Route path="/secret" element={<TenantGuard><Secret /></TenantGuard>} />
  <Route path="/customers" element={<TenantGuard><Customers /></TenantGuard>} />
  <Route path="/crash" element={<TenantGuard><Crash /></TenantGuard>} />
  <Route path="/broken" element={<TenantGuard><Broken /></TenantGuard>} />
  <Route path="/bad" element={<TenantGuard><Bad /></TenantGuard>} />
 </>;
`;
const ORDER_ROUTES = `import { Route } from 'react-router-dom';

export const routes = <>
  <Route path="/orders/:id" element={<TenantGuard><Orders /></TenantGuard>} />
</>;
`;
const SWEEP_ROUTES = `import { Route } from 'react-router-dom';

export const routes = <>
  <Route path="/orders/:id" element={<TenantGuard><Orders /></TenantGuard>} />
  <Route path="/unopened" element={<TenantGuard><Customers /></TenantGuard>} />
  <Route path="/unbound/:id" element={<TenantGuard><Customers /></TenantGuard>} />
  <Route path="/bound/:id" element={<TenantGuard><Customers /></TenantGuard>} />
  <Route path="/secret" element={<TenantGuard><Secret /></TenantGuard>} />
  <Route path="/crash" element={<TenantGuard><Crash /></TenantGuard>} />
  <Route path="/broken" element={<TenantGuard><Broken /></TenantGuard>} />
  <Route path="/bad" element={<TenantGuard><Bad /></TenantGuard>} />
  <Route path="/slow" element={<TenantGuard><Customers /></TenantGuard>} />
 </>;
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
  timeout: 30000,
});
`;
const PAGE_SPECS: Record<string, string> = {
  'specs/orders.spec.ts': `import { expect, test } from '@gate-forge/pack-playwright';
const app = process.env.GATEFORGE_APP_BASE_URL!;
test('loads an order detail page', async ({ page }) => {
  await page.goto(app + '/orders/42');
  await expect(page.locator('main')).toHaveText('Orders ready');
});
`,
  'specs/secret.spec.ts': `import { expect, test } from '@gate-forge/pack-playwright';
const app = process.env.GATEFORGE_APP_BASE_URL!;
test('secret page bounces to login', async ({ page }) => {
  await page.goto(app + '/secret');
  await expect(page).toHaveURL(/\\/login$/);
  await expect(page.locator('main')).toHaveText('Login');
});
`,
  'specs/tamper.spec.ts': `import { expect, test } from '@gate-forge/pack-playwright';
const app = process.env.GATEFORGE_APP_BASE_URL!;
test('does not trust a locally fulfilled API response', async ({ page }) => {
  await page.route('**/api/orders', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{"label":"Orders ready"}' }));
  await page.goto(app + '/orders/42');
  await expect(page.locator('main')).toHaveText('Orders ready');
});
`,
  'specs/crash.spec.ts': `import { expect, test } from '@gate-forge/pack-playwright';
const app = process.env.GATEFORGE_APP_BASE_URL!;
test('order route throws during render', async ({ page }) => {
  await page.goto(app + '/crash');
  await expect(page.locator('main')).toHaveText('Loading');
});
`,
  'specs/broken.spec.ts': `import { expect, test } from '@gate-forge/pack-playwright';
const app = process.env.GATEFORGE_APP_BASE_URL!;
test('order route shows the configured error screen', async ({ page }) => {
  await page.goto(app + '/broken');
  await expect(page.locator('main')).toHaveText('Something went wrong');
});
`,
  'specs/bad.spec.ts': `import { expect, test } from '@gate-forge/pack-playwright';
const app = process.env.GATEFORGE_APP_BASE_URL!;
test('order page handles the failed API response', async ({ page }) => {
  await page.goto(app + '/bad');
  await expect(page.locator('main')).toHaveText('Bad data');
});
`,
  'specs/customers-fail.spec.ts': `import { expect, test } from '@gate-forge/pack-playwright';
const app = process.env.GATEFORGE_APP_BASE_URL!;
test.fail();
test('customers visit fails after loading', async ({ page }) => {
  await page.goto(app + '/customers');
  await expect(page.locator('main')).toHaveText('Customers ready');
  await expect(page.locator('main')).toHaveText('intentionally wrong');
});
`,
  'specs/plain.spec.ts': `import { expect, test } from 'playwright/test';
const app = process.env.GATEFORGE_APP_BASE_URL!;
test('opens a page without the Gateforge fixture', async ({ page }) => {
  await page.goto(app + '/orders/42');
  await expect(page.locator('main')).toHaveText('Orders ready');
});
`,
};

const SEALED_PAGE_SPECS: Record<string, string> = {
  'specs/orders.spec.ts': PAGE_SPECS['specs/orders.spec.ts']!,
  'specs/tamper.spec.ts': PAGE_SPECS['specs/tamper.spec.ts']!,
  'specs/plain.spec.ts': PAGE_SPECS['specs/plain.spec.ts']!,
};

interface Verdict {
  obligationId: string;
  contract?: string;
  verdict: string;
  reason: string | null;
  recordIds: string[];
}
interface GateReport {
  advisories?: Array<{ detail: string }>;
  pages?: Array<{
    pageId: string;
    path: string;
    channel: 'observed' | 'swept' | null;
    test: string | null;
    status: string;
    reason: string | null;
  }>;
  verdicts?: Verdict[];
  execution?: {
    selectedTests?: {
      selected?: number;
      passed?: number;
      failed?: number;
      expectedFailures?: number;
    };
  };
  [key: string]: unknown;
}

function installPagesRepo(
  repo: TempRepo,
  routes: string = ROUTES,
  specs: Record<string, string> = PAGE_SPECS,
  sweep = false,
  params = '{}',
): void {
  const options = {
    include: "['src/**/*.tsx', 'specs/**/*.ts']",
    plugins: PAGE_PLUGIN,
    scan: { scanRoots: "['src/**/*.tsx']", coverage: PAGE_COVERAGE },
  };
  repo.writeFiles({
    '.gateforge.yml': `${configYml(options).replace('languages: [python]', 'languages: [javascript]')}${PAGE_CONFIG.replace('sweep: false', `sweep: ${String(sweep)}`).replace('params: {}', `params: ${params}`)}`,
    '.gateforge/policies.yml':
      'schemaVersion: 1\npolicies:\n  - id: unrelated-table-fixture\n    when:\n      kind: sql.table\n    require:\n      - persistence:read\n',
    '.gateforge/classification-policy.yml': 'schemaVersion: 1\ntrustedInternalEntryPoints: []\ninternalRules: []\n',
    '.gateforge/baselines/obligations.json': '{"schemaVersion":1,"fingerprints":[]}\n',
    'package.json': `${JSON.stringify({ type: 'module' }, null, 2)}\n`,
    '.gitignore': '.gateforge/test-gates/\nnode_modules\ntest-results\nplaywright-report\n',
    'playwright.config.mjs': PLAYWRIGHT_CONFIG,
    'src/routes.tsx': routes,
    ...specs,
  });
  symlinkSync(
    process.env['GATEFORGE_PHYSICAL_NODE_MODULES'] ?? join(ROOT, 'node_modules'),
    repo.path('node_modules'),
    'dir',
  );
}

async function startPagesApp(): Promise<{ server: Server; url: string }> {
  const app = createServer((request, response) => {
    const path = new URL(request.url ?? '/', 'http://fixture.invalid').pathname;
    if (path.startsWith('/api/')) {
      const status = path === '/api/bad' ? 500 : 200;
      const label =
        path === '/api/orders'
          ? 'Orders ready'
          : path === '/api/customers'
            ? 'Customers ready'
            : path === '/api/bad'
              ? 'Bad data'
              : 'Unknown';
      const sendApiResponse = (): void => {
        response.writeHead(status, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ label }));
      };
      // Both proof channels must wait for data, not credit the initial loading screen.
      if (path === '/api/bad' || path === '/api/orders') setTimeout(sendApiResponse, 1_200);
      else sendApiResponse();
      return;
    }
    const sendPage = (): void => {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(`<!doctype html><html><body><main>Loading</main><script>
const path = location.pathname;
if (path === '/secret') {
  history.replaceState({}, '', '/login');
  document.querySelector('main').textContent = 'Login';
} else if (path === '/crash') {
  setTimeout(() => { throw new Error('render crashed'); }, 0);
} else if (path === '/broken') {
  document.querySelector('main').textContent = 'Something went wrong';
} else {
  const api = path.startsWith('/orders/') ? '/api/orders' : path === '/bad' ? '/api/bad' : '/api/customers';
  fetch(api).then((response) => response.json()).then(({ label }) => {
    document.querySelector('main').textContent = label;
  });
}
</script></body></html>`);
    };
    // Cross-process deadline regression: fake timers cannot advance the spawned supervisor's RPC clock.
    if (path === '/slow') setTimeout(sendPage, 6_000);
    else sendPage();
  });
  app.listen(0, [127, 0, 0, 1].join('.'));
  await once(app, 'listening');
  const address = app.address() as AddressInfo;
  return { server: app, url: `http://${[127, 0, 0, 1].join('.')}:${String(address.port)}` };
}
async function runCliProcess(
  cwd: string,
  args: readonly string[],
  env: Record<string, string>,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, [join(ROOT, 'packages/cli/bin/gateforge.js'), ...args], {
    cwd,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const code = await new Promise<number | null>((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`test-gates child timed out\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    }, 120_000);
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('close', (exitCode) => {
      clearTimeout(timeout);
      resolve(exitCode);
    });
  });
  return { code: code ?? 1, stdout, stderr };
}

function parseReport(output: string, streams: { stdout: string; stderr: string }): GateReport {
  if (!output.trimStart().startsWith('{')) {
    throw new Error(`expected a JSON report\nstdout:\n${streams.stdout}\nstderr:\n${streams.stderr}`);
  }
  return JSON.parse(output) as GateReport;
}

function verdictFor(report: GateReport, prefix: string, contract: string): Verdict {
  const verdict = report.verdicts?.find(
    (entry) => entry.obligationId.startsWith(prefix) && entry.contract === contract,
  );
  if (verdict === undefined) throw new Error(`missing ${contract} verdict for ${prefix}: ${JSON.stringify(report.verdicts)}`);
  return verdict;
}

afterAll(() => cleanupWitnessedFixture());

describe('page observations through a sealed test-gates run', () => {
  it('seals clean dynamic-route proof and refuses tampered and non-fixture tests', async () => {
    await withTempRepo({}, async (repo) => {
      installPagesRepo(repo, ORDER_ROUTES, SEALED_PAGE_SPECS);
      repo.git(['add', '-A']);
      repo.git(['commit', '--no-gpg-sign', '--quiet', '-m', 'neutral page fixture']);
      const app = await startPagesApp();
      const proxy = await startAttestationProxy(app.url, FINGERPRINT);
      try {
        const keyring = operatorEnvironment();
        const env = {
          ...keyring.env,
          GATEFORGE_APP_BASE_URL: proxy.url,
          GATEFORGE_TARGET_BASE_URL: proxy.url,
          GATEFORGE_TARGET_FINGERPRINT: FINGERPRINT,
          GATEFORGE_APPROVED_POLICY_DIGEST: trustedPolicyDigestForConfig(repo.root, loadConfigAt(repo.root)),
        };
        const run = await runCliProcess(
          repo.root,
          ['test-gates', '--changed', '--scope', 'full', '--format', 'json'],
          env,
        );
        const runReport = parseReport(run.stdout, run);
        expect(run.stderr, run.stdout).toContain('PAGE_OBSERVATION_FIXTURE_REQUIRED');
        expect(run.stderr, run.stdout).toContain('PAGE_OBSERVATION_TAMPER_RISK');
        expect(run.stderr, run.stdout).toContain('specs/tamper.spec.ts:4');
        expect(runReport.verdicts?.length, run.stdout).toBeGreaterThan(0);
        const receipt = repo.path('.gateforge/test-gates/receipt.json');
        expect(existsSync(receipt), `${run.stdout}\n${run.stderr}`).toBe(true);
        const records = JSON.parse(readFileSync(repo.path('.gateforge/test-gates/records.json'), 'utf8')) as Array<{
          kind?: string;
          origin?: string;
          trust?: string;
          obligationId?: string;
        }>;
        const pageRecords = records.filter((record) => record.kind === 'page.observed');
        expect(pageRecords).toHaveLength(2);
        expect(pageRecords.every((record) => record.origin === 'engine-observed' && record.trust === 'witnessed')).toBe(true);
        expect(pageRecords.map((record) => record.obligationId?.split(':').slice(-2).join(':')).sort()).toEqual([
          'page:data-ok',
          'page:loads',
        ]);

        const check = await runCliProcess(repo.root, ['check', '--require-e2e', '--format', 'json'], env);
        const checked = parseReport(check.stdout, check);
        expect(verdictFor(checked, 'tenant.page-orders-', 'page:loads').verdict).toBe('satisfied');
        expect(verdictFor(checked, 'tenant.page-orders-', 'page:data-ok').verdict).toBe('satisfied');
        expect(run.code).toBe(0);
        expect(check.code).toBe(0);
      } finally {
        await proxy.stop();
        await new Promise<void>((resolve) => app.server.close(() => resolve()));
      }
    });
  }, 240_000);
  it('cannot prove another route by rewriting suite-side page observation configuration', async () => {
    await withTempRepo({}, async (repo) => {
      installPagesRepo(repo, ORDER_ROUTES, {
        'specs/config-forgery.spec.ts': `import { createHash } from 'node:crypto';
import { expect, test } from '@gate-forge/pack-playwright';
const app = process.env.GATEFORGE_APP_BASE_URL;
// Genuine old/new authority regression: ALWAYS forge the legacy env
// bridge input when the app env exists. Scrubbed --list inventories have
// no app env, so the forgery stays a registered test there without an
// inventory crash.
if (app !== undefined) {
  // The page id the stable detector algorithm derives for the DECLARED
  // orders route (audience 'tenant', path '/orders/:id').
  const ordersId =
    'tenant.page-orders-id-' + createHash('sha256').update('tenant:/orders/:id').digest('hex').slice(0, 8);
  const forged = {
    pages: [{ id: ordersId, path: '/customers' }],
    loginRoutes: [],
    errorMarkers: [],
    appOrigins: [new URL(app).origin],
    tamperRisks: [],
  };
  if (process.env.GATEFORGE_PAGE_OBSERVATION_CONFIG !== undefined) {
    // Old authority: the fixture grades this config, so rewriting it in
    // place falsely proves the orders page from the customers visit.
    const configured = JSON.parse(process.env.GATEFORGE_PAGE_OBSERVATION_CONFIG) as typeof forged;
    configured.pages = forged.pages;
    process.env.GATEFORGE_PAGE_OBSERVATION_CONFIG = JSON.stringify(configured);
  } else {
    // Cutover authority: the bridge is gone, so CONSTRUCT the full
    // legacy payload anyway — new code must receive it and ignore it.
    process.env.GATEFORGE_PAGE_OBSERVATION_CONFIG = JSON.stringify(forged);
  }
}
test('visits customers instead of the promised orders page', async ({ page }) => {
  await page.goto(app! + '/customers');
  await expect(page.locator('main')).toHaveText('Customers ready');
});
`,
      });
      repo.git(['add', '-A']);
      repo.git(['commit', '--no-gpg-sign', '--quiet', '-m', 'neutral page forgery fixture']);
      const app = await startPagesApp();
      const proxy = await startAttestationProxy(app.url, FINGERPRINT);
      try {
        const keyring = operatorEnvironment();
        const env = {
          ...keyring.env,
          GATEFORGE_APP_BASE_URL: proxy.url,
          GATEFORGE_TARGET_BASE_URL: proxy.url,
          GATEFORGE_TARGET_FINGERPRINT: FINGERPRINT,
          GATEFORGE_APPROVED_POLICY_DIGEST: trustedPolicyDigestForConfig(repo.root, loadConfigAt(repo.root)),
        };
        const run = await runCliProcess(
          repo.root, ['test-gates', '--changed', '--scope', 'full', '--format', 'json'], env,
        );
        const report = parseReport(run.stdout, run);
        expect(verdictFor(report, 'tenant.page-orders-', 'page:loads').verdict).not.toBe('satisfied');
        expect(verdictFor(report, 'tenant.page-orders-', 'page:data-ok').verdict).not.toBe('satisfied');
        expect(run.code).toBe(1);
        // The forged test itself ran green: the refusal is the authority's
        // verdict, never a broken enumeration or a crashed test.
        expect(report.execution?.selectedTests).toMatchObject({ selected: 1, passed: 1, failed: 0 });
      } finally {
        await proxy.stop();
        await new Promise<void>((resolve) => app.server.close(() => resolve()));
      }
    });
  }, 240_000);
  it('refuses bounced, crashed, error-screen, API-500, tampered, and failing visits', async () => {
    await withTempRepo({}, async (repo) => {
      installPagesRepo(repo);
      repo.git(['add', '-A']);
      repo.git(['commit', '--no-gpg-sign', '--quiet', '-m', 'neutral page fixture']);
      const app = await startPagesApp();
      const proxy = await startAttestationProxy(app.url, FINGERPRINT);
      try {
        const keyring = operatorEnvironment();
        const env = {
          ...keyring.env,
          GATEFORGE_APP_BASE_URL: proxy.url,
          GATEFORGE_TARGET_BASE_URL: proxy.url,
          GATEFORGE_TARGET_FINGERPRINT: FINGERPRINT,
          GATEFORGE_APPROVED_POLICY_DIGEST: trustedPolicyDigestForConfig(repo.root, loadConfigAt(repo.root)),
        };
        const selectors = [
          'secret page bounces to login',
          'order route throws during render',
          'order route shows the configured error screen',
          'order page handles the failed API response',
          'does not trust a locally fulfilled API response',
          'customers visit fails after loading',
          'opens a page without the Gateforge fixture',
        ];
        const args = [
          'test-gates',
          ...selectors.flatMap((selector) => ['--test', selector]),
          '--result-only',
          '--format',
          'json',
        ];
        const run = await runCliProcess(repo.root, args, env);
        const report = parseReport(run.stdout, run);
        expect(run.stderr, run.stdout).toContain('PAGE_OBSERVATION_FIXTURE_REQUIRED');
        expect(report.execution?.selectedTests).toMatchObject({ selected: 7, expectedFailures: 1 });
        const bounced = verdictFor(report, 'tenant.page-secret-', 'page:loads');
        expect(bounced.verdict).not.toBe('satisfied');
        expect(bounced.reason).toContain('PAGE_BOUNCED_TO_LOGIN');
        const crashed = verdictFor(report, 'tenant.page-crash-', 'page:loads');
        expect(crashed.verdict).not.toBe('satisfied');
        expect(crashed.reason).toContain('PAGE_UNCAUGHT_EXCEPTION');
        const errorScreen = verdictFor(report, 'tenant.page-broken-', 'page:loads');
        expect(errorScreen.verdict).not.toBe('satisfied');
        expect(errorScreen.reason).toContain('PAGE_ERROR_MARKER');
        const badData = verdictFor(report, 'tenant.page-bad-', 'page:data-ok');
        expect(badData.verdict).not.toBe('satisfied');
        expect(badData.reason).toContain('PAGE_API_ERROR');
        expect(verdictFor(report, 'tenant.page-bad-', 'page:loads').verdict).toBe('satisfied');
        const failedCustomer = verdictFor(report, 'tenant.page-customers-', 'page:loads');
        expect(failedCustomer.verdict).not.toBe('satisfied');
        expect(failedCustomer.reason).toContain('no clean witness-observed page visit from a passing test');
        expect(run.stderr, run.stdout).not.toContain('page sweep visited');
      } finally {
        await proxy.stop();
        await new Promise<void>((resolve) => app.server.close(() => resolve()));
      }
    });
  }, 240_000);
  it('sweeps a page gap after the existing witnessed test run', async () => {
    await withTempRepo({}, async (repo) => {
      installPagesRepo(repo, SWEEP_ROUTES, SEALED_PAGE_SPECS, true, '{ "/bound/:id": { id: "43" } }');
      repo.git(['add', '-A']);
      repo.git(['commit', '--no-gpg-sign', '--quiet', '-m', 'neutral page sweep fixture']);
      const app = await startPagesApp();
      const proxy = await startAttestationProxy(app.url, FINGERPRINT);
      try {
        const keyring = operatorEnvironment();
        const env = {
          ...keyring.env,
          GATEFORGE_APP_BASE_URL: proxy.url,
          GATEFORGE_TARGET_BASE_URL: proxy.url,
          GATEFORGE_TARGET_FINGERPRINT: FINGERPRINT,
          GATEFORGE_APPROVED_POLICY_DIGEST: trustedPolicyDigestForConfig(repo.root, loadConfigAt(repo.root)),
        };
        const run = await runCliProcess(repo.root, ['test-gates', '--changed', '--scope', 'full', '--format', 'json'], env);
        const report = parseReport(run.stdout, run);
        expect(run.stderr, run.stdout).toContain('PAGE_PARAM_UNBOUND: /unbound/:id');
        expect(report.advisories?.some((entry) => entry.detail.includes('PAGE_PARAM_UNBOUND: /unbound/:id'))).toBe(true);
        expect(verdictFor(report, 'tenant.page-bound-', 'page:loads').verdict).toBe('satisfied');
        expect(verdictFor(report, 'tenant.page-unbound-', 'page:loads').verdict).not.toBe('satisfied');
        expect(verdictFor(report, 'tenant.page-secret-', 'page:loads').reason).toContain('PAGE_BOUNCED_TO_LOGIN');
        expect(verdictFor(report, 'tenant.page-crash-', 'page:loads').reason).toContain('PAGE_UNCAUGHT_EXCEPTION');
        expect(verdictFor(report, 'tenant.page-broken-', 'page:loads').reason).toContain('PAGE_ERROR_MARKER');
        expect(verdictFor(report, 'tenant.page-bad-', 'page:data-ok').reason).toContain('PAGE_API_ERROR');
        const records = JSON.parse(readFileSync(repo.path('.gateforge/test-gates/records.json'), 'utf8')) as Array<{
          obligationId?: string;
          payload?: { channel?: string };
        }>;
        expect(records.find((record) => record.obligationId?.startsWith('tenant.page-orders-'))?.payload?.channel).toBe('observed');
        expect(records.find((record) => record.obligationId?.startsWith('tenant.page-unopened-'))?.payload?.channel).toBe('swept');
        expect(records.find((record) => record.obligationId?.startsWith('tenant.page-bound-'))?.payload?.channel).toBe('swept');
        expect(report.pages?.find((entry) => entry.path === '/unopened')).toMatchObject({
          channel: 'swept',
          test: 'referee',
          status: 'satisfied',
        });
        expect(report.pages?.find((entry) => entry.path === '/slow')).toMatchObject({
          channel: 'swept',
          test: 'referee',
          status: 'satisfied',
        });
        expect(report.pages?.find((entry) => entry.path === '/unbound/:id')).toMatchObject({
          channel: null,
          test: null,
          status: 'missing',
        });
        const unboundPage = report.pages?.find((entry) => entry.path === '/unbound/:id');
        expect(unboundPage).toBeDefined();
        const explanation = await runCliProcess(
          repo.root,
          ['explain', `${String(unboundPage?.pageId)}:page:loads`],
          env,
        );
        expect(explanation.code, `${explanation.stdout}\n${explanation.stderr}`).toBe(0);
        expect(explanation.stdout).toContain('page proof (last test-gates report)');
        expect(explanation.stdout).toContain('channel=none; test=none; status=missing');
        const next = await runCliProcess(repo.root, ['next', '--json'], env);
        expect(next.code, `${next.stdout}\n${next.stderr}`).toBe(1);
        const guidance = JSON.parse(next.stdout) as { do?: string; pageGuidance?: string[] };
        expect(guidance.pageGuidance).toContain(
          'If PAGE_OBSERVATION_TAMPER_RISK is reported, remove page.evaluate, route interception, route.fulfill, or direct CDP use from the test or its helpers.',
        );
        expect(guidance.do).toMatch(/no test opens \/|resolve PAGE_/);
      } finally {
        await proxy.stop();
        await new Promise<void>((resolve) => app.server.close(() => resolve()));
      }
    });
  }, 240_000);
  it('leaves unopened pages unproven when sweeping is disabled', async () => {
    await withTempRepo({}, async (repo) => {
      installPagesRepo(repo, SWEEP_ROUTES, SEALED_PAGE_SPECS, false);
      repo.git(['add', '-A']);
      repo.git(['commit', '--no-gpg-sign', '--quiet', '-m', 'neutral disabled page sweep fixture']);
      const app = await startPagesApp();
      const proxy = await startAttestationProxy(app.url, FINGERPRINT);
      try {
        const keyring = operatorEnvironment();
        const env = {
          ...keyring.env,
          GATEFORGE_APP_BASE_URL: proxy.url,
          GATEFORGE_TARGET_BASE_URL: proxy.url,
          GATEFORGE_TARGET_FINGERPRINT: FINGERPRINT,
          GATEFORGE_APPROVED_POLICY_DIGEST: trustedPolicyDigestForConfig(repo.root, loadConfigAt(repo.root)),
        };
        const run = await runCliProcess(repo.root, ['test-gates', '--changed', '--scope', 'full', '--format', 'json'], env);
        const report = parseReport(run.stdout, run);
        expect(verdictFor(report, 'tenant.page-unopened-', 'page:loads').verdict).not.toBe('satisfied');
        expect(run.stderr, run.stdout).not.toContain('page sweep visited');
        const records = JSON.parse(readFileSync(repo.path('.gateforge/test-gates/records.json'), 'utf8')) as Array<{
          payload?: { channel?: string };
        }>;
        expect(records.some((record) => record.payload?.channel === 'swept')).toBe(false);
      } finally {
        await proxy.stop();
        await new Promise<void>((resolve) => app.server.close(() => resolve()));
      }
    });
  }, 240_000);
});
