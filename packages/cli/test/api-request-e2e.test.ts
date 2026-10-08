/**
 * Real CLI coverage that distinguishes direct test-code Playwright API
 * calls from browser traffic: direct calls never satisfy observed claims,
 * while a page request triggered by the UI is credited to that test.
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

const TITLE_FIXTURE = 'fixture request uses direct API transport';
const TITLE_IMPORTED = 'imported new context uses direct API transport';
const TITLE_UI = 'API seed followed by browser UI request';
const TITLE_SEED_ONLY = 'direct seed alone is not UI evidence';
const TITLE_PAGE_REQUEST = 'page.request alone is not UI evidence';
const TITLE_CONTEXT_REQUEST = 'context.request alone is not UI evidence';
const TITLE_EVALUATE_FETCH = 'page evaluate fetch is not UI evidence';
const TITLE_EVALUATE_APP = 'page evaluate app function is not UI evidence';
const TITLE_EVALUATE_HIDDEN = 'computed page evaluate fetch is not UI evidence';
const TITLE_APP_ASYNC = 'app async handler remains UI evidence';

/** The endpoint the witness must observe (resource name is deterministic). */
const ITEMS_RESOURCE = endpointResourceName('GET', '/api/items');
const ITEMS_REQUEST = `tenant.${ITEMS_RESOURCE}:http:request-observed`;
const ITEMS_STATUS = `tenant.${ITEMS_RESOURCE}:http:response-status-ok`;
const UI_RESOURCE = endpointResourceName('GET', '/api/ui-items');
const UI_REQUEST = `tenant.${UI_RESOURCE}:http:request-observed`;
const UI_STATUS = `tenant.${UI_RESOURCE}:http:response-status-ok`;
const SEED_ONLY_RESOURCE = endpointResourceName('GET', '/api/seed-only');
const SEED_ONLY_REQUEST = `tenant.${SEED_ONLY_RESOURCE}:http:request-observed`;
const SEED_ONLY_STATUS = `tenant.${SEED_ONLY_RESOURCE}:http:response-status-ok`;
const PAGE_RESOURCE = endpointResourceName('GET', '/api/page-request');
const PAGE_REQUEST = `tenant.${PAGE_RESOURCE}:http:request-observed`;
const PAGE_STATUS = `tenant.${PAGE_RESOURCE}:http:response-status-ok`;
const CONTEXT_RESOURCE = endpointResourceName('GET', '/api/context-request');
const CONTEXT_REQUEST = `tenant.${CONTEXT_RESOURCE}:http:request-observed`;
const CONTEXT_STATUS = `tenant.${CONTEXT_RESOURCE}:http:response-status-ok`;
const EVAL_RESOURCE = endpointResourceName('GET', '/api/eval-fetch');
const EVAL_REQUEST = `tenant.${EVAL_RESOURCE}:http:request-observed`;
const EVAL_STATUS = `tenant.${EVAL_RESOURCE}:http:response-status-ok`;
const EVAL_APP_RESOURCE = endpointResourceName('GET', '/api/eval-app');
const EVAL_APP_REQUEST = `tenant.${EVAL_APP_RESOURCE}:http:request-observed`;
const EVAL_APP_STATUS = `tenant.${EVAL_APP_RESOURCE}:http:response-status-ok`;
const EVAL_HIDDEN_RESOURCE = endpointResourceName('GET', '/api/eval-hidden');
const EVAL_HIDDEN_REQUEST = `tenant.${EVAL_HIDDEN_RESOURCE}:http:request-observed`;
const EVAL_HIDDEN_STATUS = `tenant.${EVAL_HIDDEN_RESOURCE}:http:response-status-ok`;
const UNREADABLE_RESOURCE = endpointResourceName('GET', '/api/unreadable');
const UNREADABLE_REQUEST = `tenant.${UNREADABLE_RESOURCE}:http:request-observed`;
const UNREADABLE_STATUS = `tenant.${UNREADABLE_RESOURCE}:http:response-status-ok`;
const ASYNC_RESOURCE = endpointResourceName('GET', '/api/app-async');
const ASYNC_REQUEST = `tenant.${ASYNC_RESOURCE}:http:request-observed`;
const ASYNC_STATUS = `tenant.${ASYNC_RESOURCE}:http:response-status-ok`;

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

const test = base.extend({});

test.beforeEach(async () => {
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

test('${TITLE_UI}', async ({ page }) => {
  const api = await request.newContext();
  const seeded = await api.post('/api/seed');
  expect(seeded.status()).toBe(201);
  await api.dispose();
  await page.goto('/');
  await page.getByRole('button', { name: 'Load items' }).click();
  await expect(page.getByText('Items loaded')).toBeVisible();
});

test('${TITLE_SEED_ONLY}', async () => {
  const api = await request.newContext();
  const response = await api.get('/api/seed-only');
  expect(response.status()).toBe(200);
  await api.dispose();
});

test('${TITLE_PAGE_REQUEST}', async ({ page }) => {
  const response = await page.request.get('/api/page-request');
  expect(response.status()).toBe(200);
});

test('${TITLE_CONTEXT_REQUEST}', async ({ page, context }) => {
  const response = await context.request.get('/api/context-request');
  expect(response.status()).toBe(200);
});
`;

const EVALUATE_FETCH_SPEC = `const { test } = require('./support/test.cjs');
test('${TITLE_EVALUATE_FETCH}', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => fetch('/api/eval-fetch'));
});
`;

const EVALUATE_APP_SPEC = `const { test } = require('./support/test.cjs');
test('${TITLE_EVALUATE_APP}', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => window.appAsync());
});
`;

const EVALUATE_HIDDEN_SPEC = `const { test } = require('./support/test.cjs');
test('${TITLE_EVALUATE_HIDDEN}', async ({ page }) => {
  await page.goto('/');
  const run = 'evaluate';
  await page[run]("fetch('/api/eval-hidden')");
});
`;

const APP_ASYNC_SPEC = `import { test } from '@gate-forge/pack-playwright';
test('${TITLE_APP_ASYNC}', async ({ page }) => {
  await page.goto('/');
  await Promise.all([
    page.waitForResponse((response) => new URL(response.url()).pathname === '/api/app-async'),
    page.getByRole('button', { name: 'Load async' }).click(),
  ]);
});
`;
const TEST_WRAPPER = `const { test: base, expect } = require('@gate-forge/pack-playwright/fixture');
exports.test = base.extend({});
exports.expect = expect;
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
    route('ui_items_get', 'GET', '/api/ui-items', 11);
    route('seed_only_get', 'GET', '/api/seed-only', 12);
    route('page_request_get', 'GET', '/api/page-request', 13);
    route('context_request_get', 'GET', '/api/context-request', 14);
    route('eval_get', 'GET', '/api/eval-fetch', 15);
    route('eval_app_get', 'GET', '/api/eval-app', 16);
    route('eval_hidden_get', 'GET', '/api/eval-hidden', 17);
    route('unreadable_get', 'GET', '/api/unreadable', 18);
    route('async_get', 'GET', '/api/app-async', 19);
    return { resources, unresolved: [], findings: [], classificationSignals };
  },
};

`;

/** Fixture API with direct-only routes and a button-driven UI request. */
async function startApiApp(): Promise<{
  url: string;
  requestsByPath: Map<string, number>;
  stop: () => Promise<void>;
}> {
  const requestsByPath = new Map<string, number>();
  let seeded = false;
  const app = createServer((request, response) => {
    const path = (request.url ?? '/').split('?')[0] ?? '/';
    requestsByPath.set(path, (requestsByPath.get(path) ?? 0) + 1);
    response.setHeader('x-gateforge-env-fingerprint', FINGERPRINT);
    if (request.method === 'GET' && path === '/') {
      response.setHeader('content-type', 'text/html');
      response.end('<button>Load items</button><button>Load async</button><div id="result"></div><script>window.appAsync=async()=>{await new Promise(r=>setTimeout(r,0));await fetch("/api/eval-app")};document.querySelectorAll("button")[0].onclick=async()=>{await fetch("/api/ui-items");document.querySelector("#result").textContent="Items loaded"};document.querySelectorAll("button")[1].onclick=async()=>{await new Promise(r=>setTimeout(r,0));await fetch("/api/app-async")}</script>');
      return;
    }
    if (request.method === 'POST' && path === '/api/seed') {
      seeded = true;
      response.writeHead(201, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ seeded: true }));
      return;
    }
    if (
      request.method === 'GET' &&
      (path === '/api/items' ||
        path === '/api/setup' ||
        path === '/api/ui-items' ||
        path === '/api/seed-only' ||
        path === '/api/page-request' ||
        path === '/api/context-request' ||
        path === '/api/eval-fetch' ||
        path === '/api/eval-app' ||
        path === '/api/eval-hidden' ||
        path === '/api/unreadable' ||
        path === '/api/app-async')
    ) {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ ok: true, seeded }));
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
  payload?: {
    channel?: string;
    exchanges?: Array<{ method?: string; url?: string; status?: number; initiator?: string }>;
  };
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
        record.payload?.channel !== 'direct' &&
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
  it('credits only browser UI traffic, not test-code API requests', async () => {
    const app = await startApiApp();
    try {
      await withTempRepo({}, async (repo) => {
        installStrictFixture(repo, { 'specs/api.spec.js': SPEC });
        repo.writeFiles({
          // This fixture claims transport contracts only: the strict
          // fixture's accounts adapter would be a stale reference, so the
          // config points at an EMPTY adapters directory instead.
          '.gateforge.yml': `${GATEFORGE_YML.replace('adapters: .gateforge/adapters', 'adapters: .gateforge/adapters-api').replace('exclude: []', "exclude: ['specs/unreadable.spec.js']")}runtime: .gateforge/runtime.yml\n`,
          '.gateforge/adapters-api/.gitkeep': '',
          '.gateforge/runtime.yml': 'schemaVersion: 1\nenvAllowlist: [TEST_SERVICE_URL]\n',
          'specs/support/test.cjs': TEST_WRAPPER,
          'specs/eval-fetch.spec.cjs': EVALUATE_FETCH_SPEC,
          'specs/eval-app.spec.cjs': EVALUATE_APP_SPEC,
          'specs/eval-hidden.spec.cjs': EVALUATE_HIDDEN_SPEC,
          'specs/app-async.spec.js': APP_ASYNC_SPEC,
          'specs/unreadable.spec.js':
            `import { test } from '@gate-forge/pack-playwright/fixture';\ntest('unreadable list-only claim', async ({ page }) => { await page.goto('/'); });\n`,
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
    kind: api-e2e
    claims: ['${ITEMS_REQUEST}', '${ITEMS_STATUS}']
    reason: API-only test; direct calls are not observed E2E evidence.
  - key: playwright:chromium:specs/api.spec.js:${TITLE_IMPORTED}
    selector:
      runner: playwright
      project: chromium
      file: specs/api.spec.js
      titlePath: ['${TITLE_IMPORTED}']
    kind: api-e2e
    claims: ['${ITEMS_REQUEST}', '${ITEMS_STATUS}']
    reason: API-only test; direct calls are not observed E2E evidence.
  - key: playwright:chromium:specs/api.spec.js:${TITLE_UI}
    selector:
      runner: playwright
      project: chromium
      file: specs/api.spec.js
      titlePath: ['${TITLE_UI}']
    kind: observed-e2e
    claims: ['${UI_REQUEST}', '${UI_STATUS}']
    reason: The UI action makes the claimed browser request after direct seeding.
  - key: playwright:chromium:specs/api.spec.js:${TITLE_SEED_ONLY}
    selector:
      runner: playwright
      project: chromium
      file: specs/api.spec.js
      titlePath: ['${TITLE_SEED_ONLY}']
    kind: observed-e2e
    claims: ['${SEED_ONLY_REQUEST}', '${SEED_ONLY_STATUS}']
    reason: A direct API request alone is not E2E evidence.
  - key: playwright:chromium:specs/api.spec.js:${TITLE_PAGE_REQUEST}
    selector:
      runner: playwright
      project: chromium
      file: specs/api.spec.js
      titlePath: ['${TITLE_PAGE_REQUEST}']
    kind: observed-e2e
    claims: ['${PAGE_REQUEST}', '${PAGE_STATUS}']
    reason: page.request is a direct API call, not a UI action.
  - key: playwright:chromium:specs/api.spec.js:${TITLE_CONTEXT_REQUEST}
    selector:
      runner: playwright
      project: chromium
      file: specs/api.spec.js
      titlePath: ['${TITLE_CONTEXT_REQUEST}']
    kind: observed-e2e
    claims: ['${CONTEXT_REQUEST}', '${CONTEXT_STATUS}']
    reason: context.request is a direct API call, not a UI action.
  - key: playwright:chromium:specs/eval-fetch.spec.cjs:${TITLE_EVALUATE_FETCH}
    selector:
      runner: playwright
      project: chromium
      file: specs/eval-fetch.spec.cjs
      titlePath: ['${TITLE_EVALUATE_FETCH}']
    kind: observed-e2e
    claims: ['${EVAL_REQUEST}', '${EVAL_STATUS}']
    reason: page.evaluate requests are not app UI actions.
  - key: playwright:chromium:specs/eval-app.spec.cjs:${TITLE_EVALUATE_APP}
    selector:
      runner: playwright
      project: chromium
      file: specs/eval-app.spec.cjs
      titlePath: ['${TITLE_EVALUATE_APP}']
    kind: observed-e2e
    claims: ['${EVAL_APP_REQUEST}', '${EVAL_APP_STATUS}']
    reason: page.evaluate requests are not app UI actions.
  - key: playwright:chromium:specs/eval-hidden.spec.cjs:${TITLE_EVALUATE_HIDDEN}
    selector:
      runner: playwright
      project: chromium
      file: specs/eval-hidden.spec.cjs
      titlePath: ['${TITLE_EVALUATE_HIDDEN}']
    kind: observed-e2e
    claims: ['${EVAL_HIDDEN_REQUEST}', '${EVAL_HIDDEN_STATUS}']
    reason: Computed page evaluation starts test-code traffic, not an app UI action.
  - key: playwright:chromium:specs/unreadable.spec.js:unreadable list-only claim
    selector:
      runner: playwright
      project: chromium
      file: specs/unreadable.spec.js
      titlePath: ['unreadable list-only claim']
    kind: observed-e2e
    claims: ['${UNREADABLE_REQUEST}', '${UNREADABLE_STATUS}']
    reason: This excluded source fixture must not be trusted as scanned.
  - key: playwright:chromium:specs/app-async.spec.js:${TITLE_APP_ASYNC}
    selector:
      runner: playwright
      project: chromium
      file: specs/app-async.spec.js
      titlePath: ['${TITLE_APP_ASYNC}']
    kind: observed-e2e
    claims: ['${ASYNC_REQUEST}', '${ASYNC_STATUS}']
    reason: The app UI handler owns this request.
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
        const report = JSON.parse(run.stdout) as {
          verdicts: Array<{ obligationId: string; verdict: string; reason?: string }>;
          execution: { selectedTests: { selected: number; passed: number; failed: number } };
          blocking?: Array<{ cause?: string; detail?: string; name?: string }>;
        };
        const observed = `${run.stdout}\n${run.stderr}`;
        const records = JSON.parse(readFileSync(repo.path('.gateforge/test-gates/records.json'), 'utf8')) as LedgerRecord[];
        const evalHiddenExchange = records
          .filter((record) => record.kind === 'http.observed' && record.payload?.channel === 'observe')
          .flatMap((record) => record.payload?.exchanges ?? [])
          .find((exchange) => exchange.url?.endsWith('/api/eval-hidden'));
        expect(evalHiddenExchange?.initiator, observed).toBe('test-code');
        const appAsyncExchange = records
          .filter((record) => record.kind === 'http.observed' && record.payload?.channel === 'observe')
          .flatMap((record) => record.payload?.exchanges ?? [])
          .find((exchange) => exchange.url?.endsWith('/api/app-async'));
        expect(appAsyncExchange, observed).toMatchObject({
          method: 'GET',
          url: '/api/app-async',
          status: 200,
        });
        expect(appAsyncExchange?.initiator, JSON.stringify(appAsyncExchange)).toBeUndefined();
        for (const obligationId of [ITEMS_REQUEST, ITEMS_STATUS]) {
          expect(report.verdicts.find((item) => item.obligationId === obligationId), observed).toMatchObject({
            verdict: 'missing',
          });
        }
        for (const obligationId of [UI_REQUEST, UI_STATUS]) {
          expect(report.verdicts.find((item) => item.obligationId === obligationId), observed).toMatchObject({
            verdict: 'satisfied',
          });
        }
        const directClaims = [
          [SEED_ONLY_REQUEST, SEED_ONLY_STATUS],
          [PAGE_REQUEST, PAGE_STATUS],
          [CONTEXT_REQUEST, CONTEXT_STATUS],
        ].flat();
        for (const obligationId of directClaims) {
          const verdict = report.verdicts.find((item) => item.obligationId === obligationId);
          expect(verdict, observed).toMatchObject({ verdict: 'missing' });
        }
        for (const obligationId of [ITEMS_REQUEST, ITEMS_STATUS, SEED_ONLY_REQUEST, SEED_ONLY_STATUS]) {
          const verdict = report.verdicts.find((item) => item.obligationId === obligationId);
          expect(verdict?.reason ?? '', obligationId).toContain('the test called this endpoint directly from test code');
        }
        for (const obligationId of [EVAL_REQUEST, EVAL_STATUS, EVAL_APP_REQUEST, EVAL_APP_STATUS]) {
          const verdict = report.verdicts.find((item) => item.obligationId === obligationId);
          expect(verdict, observed).toMatchObject({ verdict: 'missing' });
          const refusal = report.blocking?.find(
            (entry) => entry.cause === 'TEST_MAPPING_AMBIGUOUS' && entry.name === obligationId,
          );
          expect(refusal?.detail ?? '', observed).toContain('PAGE_OBSERVATION_TAMPER_RISK');
        }
        const unreadableProblem = report.blocking?.find(
          (entry) => entry.cause === 'TEST_KIND_UNKNOWN' && entry.name === UNREADABLE_REQUEST,
        );
        const unreadableDetail = "Gateforge could not read the code of test 'playwright:chromium:specs/unreadable.spec.js:unreadable list-only claim'";
        expect(unreadableProblem?.detail ?? '', observed).toContain(unreadableDetail);
        for (const obligationId of [UNREADABLE_REQUEST, UNREADABLE_STATUS]) {
          const verdict = report.verdicts.find((item) => item.obligationId === obligationId);
          expect(verdict, observed).toMatchObject({ verdict: 'missing' });
          expect(verdict?.reason ?? '', observed).toContain(unreadableDetail);
          expect(verdict?.reason ?? '', observed).not.toContain('no claim declares');
        }
        for (const obligationId of [EVAL_HIDDEN_REQUEST, EVAL_HIDDEN_STATUS]) {
          const verdict = report.verdicts.find((item) => item.obligationId === obligationId);
          expect(verdict, observed).toMatchObject({ verdict: 'missing' });
          expect(verdict?.reason ?? '', observed).toContain('the request was started by test code running in the page');
        }
        for (const obligationId of [ASYNC_REQUEST, ASYNC_STATUS]) {
          expect(report.verdicts.find((item) => item.obligationId === obligationId), observed)
            .toMatchObject({ verdict: 'satisfied' });
        }
        expect(run.code, observed).toBe(1);
        expect(report.execution.selectedTests).toMatchObject({ selected: 11, passed: 11, failed: 0 });
        expect(app.requestsByPath.get('/api/items')).toBe(2);
        expect(app.requestsByPath.get('/api/setup')).toBe(6);
        expect(app.requestsByPath.get('/api/seed')).toBe(1);
        expect(app.requestsByPath.get('/api/seed-only')).toBe(1);
        expect(app.requestsByPath.get('/api/page-request')).toBe(1);
        expect(app.requestsByPath.get('/api/context-request')).toBe(1);
        expect(app.requestsByPath.get('/api/eval-fetch')).toBe(1);
        expect(app.requestsByPath.get('/api/eval-app')).toBe(1);
        expect(app.requestsByPath.get('/api/eval-hidden')).toBe(1);
        expect(app.requestsByPath.get('/api/app-async')).toBe(1);
        expect(app.requestsByPath.get('/api/ui-items')).toBe(1);
        const recordedPaths = recordedExchangePaths(records);
        for (const path of ['/api/items', '/api/seed-only', '/api/page-request', '/api/context-request']) {
          expect(recordedPaths.some((exchangePath) => exchangePath.endsWith(path))).toBe(false);
        }
        expect(recordedPaths.some((path) => path.endsWith('/api/ui-items'))).toBe(true);
        expect(recordedPaths.some((path) => path.endsWith('/api/eval-fetch'))).toBe(true);
        expect(recordedPaths.some((path) => path.endsWith('/api/eval-app'))).toBe(true);
        expect(recordedPaths.some((path) => path.endsWith('/api/eval-hidden'))).toBe(true);
        expect(recordedPaths.some((path) => path.endsWith('/api/app-async'))).toBe(true);
        const outcomesDoc = JSON.parse(readFileSync(repo.path('.gateforge/test-gates/runner-outcomes.json'), 'utf8')) as {
          outcomes?: Array<{ testId?: string; titlePath?: string[] }>;
        };
        const uiTestId = outcomesDoc.outcomes?.find((item) => (item.titlePath ?? []).includes(TITLE_UI))?.testId;
        expect(uiTestId, 'browser UI test id').toBeDefined();
        expect(
          recordedExchangePaths(records.filter((record) => record.testId === uiTestId)).some((path) =>
            path.endsWith('/api/ui-items'),
          ),
          'claimed endpoint record is the browser exchange from the UI test',
        ).toBe(true);
      });
    } finally {
      await app.stop();
    }
  }, 240_000);
});
