/**
 * The witnessed API request channel through the actual CLI: API tests
 * that use Playwright's APIRequestContext — the fixture `request`, and
 * `request.newContext()` from the fixture module — get their endpoint
 * exchanges proxied through the test's session (host swap, exactly the
 * page channel's rewrite), so mapped `observed-e2e` claims for
 * `http:request-observed` / `http:response-status-ok` prove. A call made
 * in `beforeAll` (no test running, no session) goes to the app DIRECTLY
 * and stays uncredited — proven by the app seeing the app's own Host,
 * never the proxy's.
 */
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { endpointResourceName } from '@gate-forge/http-contract';
import { withTempRepo } from '@gate-forge/core';
import { trustedPolicyDigestForConfig } from '../src/execution.js';
import { loadConfigAt } from '../src/commands/common.js';
import {
  cleanupWitnessedFixture,
  installStrictFixture,
  operatorEnvironment,
  ROOT,
  FINGERPRINT,
  GATEFORGE_YML,
} from './witnessed-run-fixture.js';

const TITLE_FIXTURE = 'fixture request witnesses endpoint traffic';
const TITLE_IMPORTED = 'imported new context witnesses in-test traffic';

/** The endpoint the witness must observe (resource name is deterministic). */
const ITEMS_RESOURCE = endpointResourceName('GET', '/api/items');
const ITEMS_REQUEST = `tenant.${ITEMS_RESOURCE}:http:request-observed`;
const ITEMS_STATUS = `tenant.${ITEMS_RESOURCE}:http:response-status-ok`;

const PLAYWRIGHT_CONFIG = `import { defineConfig } from 'playwright/test';
export default defineConfig({
  testDir: 'specs',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: true,
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
  use: { headless: true, trace: 'off', baseURL: process.env.TEST_SERVICE_URL },
  timeout: 30_000,
});
`;

const SPEC = `import { test as base, expect, request } from '@gate-forge/pack-playwright';

// Suites usually build their own runner on the fixture's: its hooks are
// setup traffic exactly like the base runner's.
const test = base.extend({});

test.beforeEach(async () => {
  // A hook, not the test: this call runs inside the test's session window
  // yet must go straight to the app and stay uncredited (the app sees the
  // app's own Host, never the proxy's).
  const api = await request.newContext();
  const setup = await api.get('/api/setup');
  expect(setup.status()).toBe(200);
  await api.dispose();
});

test('${TITLE_FIXTURE}', async ({ request }) => {
  const response = await request.get('/api/items');
  expect(response.status()).toBe(200);
});

test('${TITLE_IMPORTED}', async () => {
  const api = await request.newContext();
  const response = await api.get('/api/items');
  expect(response.status()).toBe(200);
  await api.dispose();
});
`;

/** The endpoint inventory: GET /api/items classified tenant, with its two observation obligations owed. */
const API_DETECTOR = `import { endpointResourceName } from '@gate-forge/http-contract';

export default {
  async discover() {
    const at = (file, line) => ({ file, line, col: 0 });
    const resources = [];
    const classificationSignals = [];
    const route = (name, method, canonicalPath, line) => {
      const resourceName = endpointResourceName(method, canonicalPath);
      resources.push({
        schemaVersion: 1,
        id: 'http.endpoint:' + name,
        kind: 'http.endpoint',
        source: 'src/api-routes.js',
        location: at('src/api-routes.js', line),
        detectorVersion: '1.0.0',
        attributes: { resourceName, method, canonicalPath, identity: method + ' ' + canonicalPath },
      });
      for (const signal of [
        { dimension: 'plane', assertion: 'tenant' },
        { dimension: 'identity', assertion: [method, canonicalPath] },
      ]) {
        classificationSignals.push({
          schemaVersion: 1,
          target: { resourceName },
          ...signal,
          basis: 'declaration',
          source: 'gateforge.fixture',
          location: at('src/api-routes.js', line),
          detector: { id: 'gateforge.fixture', version: '1.0.0' },
        });
      }
    };
    route('items_get', 'GET', '/api/items', 10);
    return { resources, unresolved: [], findings: [], classificationSignals };
  },
};
`;

/** The fixture app: two GET endpoints, counting the requests each receives. */
async function startApiApp(): Promise<{
  url: string;
  requestsByPath: Map<string, number>;
  stop: () => Promise<void>;
}> {
  const requestsByPath = new Map<string, number>();
  const app = createServer((request, response) => {
    const path = (request.url ?? '/').split('?')[0] ?? '/';
    requestsByPath.set(path, (requestsByPath.get(path) ?? 0) + 1);
    response.setHeader('content-type', 'application/json');
    response.setHeader('x-gateforge-env-fingerprint', FINGERPRINT);
    if (request.method === 'GET' && (path === '/api/items' || path === '/api/setup')) {
      response.end(JSON.stringify({ ok: true }));
      return;
    }
    response.statusCode = 404;
    response.end('{}');
  });
  await new Promise<void>((resolve) => app.listen(0, 'localhost', resolve));
  const address = app.address() as AddressInfo;
  return {
    url: `http://localhost:${String(address.port)}`,
    requestsByPath,
    stop: () => new Promise<void>((resolve) => app.close(() => resolve())),
  };
}

async function runCliProcess(cwd: string, env: Record<string, string>, args: readonly string[]) {
  const child = spawn(process.execPath, [join(ROOT, 'packages/cli/bin/gateforge.js'), ...args], {
    cwd,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
  child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
  const code = await new Promise<number | null>((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`test-gates child timed out\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    }, 180_000);
    child.once('error', (error) => { clearTimeout(timeout); reject(error); });
    child.once('close', (exitCode) => { clearTimeout(timeout); resolve(exitCode); });
  });
  return { code: code ?? 1, stdout, stderr };
}

/** One ledger record shape (the witness's issued record). */
interface LedgerRecord {
  kind?: string;
  testId?: string;
  payload?: { exchanges?: Array<{ url?: string }> };
}

/**
 * The recorded exchange paths of the session ledger — of
 * ONE test when its test id is given, of every test
 * otherwise (a path is the exchange URL's pathname).
 */
function recordedExchangePaths(records: LedgerRecord[], testId?: string): string[] {
  return records
    .filter(
      (record) =>
        record.kind === 'http.observed' &&
        (testId === undefined || record.testId === testId),
    )
    .flatMap((record) => record.payload?.exchanges ?? [])
    .map((exchange) => {
      try {
        return new URL(exchange.url ?? '').pathname;
      } catch {
        return exchange.url ?? '';
      }
    });
}

describe('witnessed API request channel through the actual CLI', () => {
  it('witnesses APIRequestContext traffic and keeps hook setup uncredited on an extended runner', async () => {
    const app = await startApiApp();
    try {
      await withTempRepo({}, async (repo) => {
        installStrictFixture(repo, { 'specs/api.spec.js': SPEC });
        repo.writeFiles({
          // This fixture claims transport contracts only: the strict
          // fixture's accounts adapter would be a stale reference, so the
          // config points at an EMPTY adapters directory instead.
          '.gateforge.yml': `${GATEFORGE_YML.replace('adapters: .gateforge/adapters', 'adapters: .gateforge/adapters-api')}runtime: .gateforge/runtime.yml\n`,
          '.gateforge/adapters-api/.gitkeep': '',
          '.gateforge/runtime.yml': 'schemaVersion: 1\nenvAllowlist: [TEST_SERVICE_URL]\n',
          '.gateforge/fixture-detector.mjs': API_DETECTOR,
          '.gateforge/policies.yml':
            'schemaVersion: 1\npolicies:\n  - id: items-observed\n    when:\n      kind: http.endpoint\n    require: [http:request-observed, http:response-status-ok]\n',
          'src/api-routes.js': '// fixture source: the items endpoint lives here.\n',
          'playwright.config.mjs': PLAYWRIGHT_CONFIG,
          '.gateforge/test-map.yml': `schemaVersion: 1
tests:
  - key: playwright:chromium:specs/api.spec.js:${TITLE_FIXTURE}
    selector:
      runner: playwright
      project: chromium
      file: specs/api.spec.js
      titlePath: ['${TITLE_FIXTURE}']
    kind: observed-e2e
    claims: ['${ITEMS_REQUEST}', '${ITEMS_STATUS}']
    reason: The fixture request context drives GET /api/items through the session proxy.
  - key: playwright:chromium:specs/api.spec.js:${TITLE_IMPORTED}
    selector:
      runner: playwright
      project: chromium
      file: specs/api.spec.js
      titlePath: ['${TITLE_IMPORTED}']
    kind: observed-e2e
    claims: ['${ITEMS_REQUEST}', '${ITEMS_STATUS}']
    reason: An imported request.newContext drives GET /api/items through the session proxy inside the test.
`,
        });
        repo.git(['add', '-A']);
        repo.git(['commit', '--no-gpg-sign', '--quiet', '-m', 'neutral api request fixture']);
        // The supervised --changed run (a --result-only run discards its
        // private state directory, and the witnessed ledger is exactly
        // what the uncredited-setup assertion reads).
        repo.writeFiles({ 'src/api-routes.js': '// fixture source: the items endpoint lives here.\n// changed source\n' });
        repo.git(['add', 'src/api-routes.js']);
        const { env } = operatorEnvironment();
        const runEnv = {
          ...env,
          TEST_SERVICE_URL: app.url,
          GATEFORGE_APP_BASE_URL: app.url,
          GATEFORGE_TARGET_BASE_URL: app.url,
          GATEFORGE_TARGET_FINGERPRINT: FINGERPRINT,
          GATEFORGE_APPROVED_POLICY_DIGEST: trustedPolicyDigestForConfig(repo.root, loadConfigAt(repo.root)),
        };
        const run = await runCliProcess(repo.root, runEnv, ['test-gates', '--changed', '--format', 'json']);
        const observed = `${run.stdout}\n${run.stderr}`;
        const report = JSON.parse(run.stdout) as {
          verdicts: Array<{ obligationId: string; verdict: string }>;
          execution: { selectedTests: { selected: number; passed: number; failed: number } };
        };
        // Both claims prove through the session proxy — for BOTH tests.
        for (const obligationId of [ITEMS_REQUEST, ITEMS_STATUS]) {
          expect(report.verdicts.find((verdict) => verdict.obligationId === obligationId), observed).toMatchObject({
            verdict: 'satisfied',
          });
        }
        expect(run.code, observed).toBe(0);
        expect(report.execution.selectedTests).toMatchObject({ selected: 2, passed: 2, failed: 0 });
        // The beforeEach setup call reached the app once per test, and the
        // witnessed ledger proves CREDIT stayed honest: the session
        // snapshot carries /api/items but never /api/setup (a direct
        // setup call never rides any session proxy).
        expect(app.requestsByPath.get('/api/setup')).toBe(2);
        const records = JSON.parse(readFileSync(repo.path('.gateforge/test-gates/records.json'), 'utf8')) as LedgerRecord[];
        const recordedPaths = recordedExchangePaths(records);
        expect(recordedPaths.some((path) => path.endsWith('/api/items'))).toBe(true);
        expect(recordedPaths.some((path) => path.endsWith('/api/setup'))).toBe(false);
        // Per-test attribution: each test's OWN session ledger
        // carries its /api/items exchange — the `request`
        // fixture AND the imported `request.newContext()` each
        // ride their own session's proxy, not any other path.
        // The runner-outcomes document joins each test's title
        // to the runner test id its session (and therefore its
        // records) were opened under.
        const outcomesDoc = JSON.parse(readFileSync(repo.path('.gateforge/test-gates/runner-outcomes.json'), 'utf8')) as {
          outcomes?: Array<{ testId?: string; titlePath?: string[] }>;
        };
        const outcomes = outcomesDoc.outcomes ?? [];
        for (const title of [TITLE_FIXTURE, TITLE_IMPORTED]) {
          const row = outcomes.find((candidate) => (candidate.titlePath ?? []).includes(title));
          const testId = row?.testId;
          // A missing row (or id) means the test never ran under
          // a session at all: the join below must not pass
          // vacuously, so it filters on an id no record carries.
          expect(testId, `runner test id for '${title}'`).toBeDefined();
          expect(
            recordedExchangePaths(records, testId ?? '').some((path) => path.endsWith('/api/items')),
            `session ledger for runner test ${String(testId)}`,
          ).toBe(true);
        }
      });
    } finally {
      await app.stop();
    }
  }, 240_000);
});
