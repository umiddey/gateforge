/**
 * Real-CLI runner e2e: `test-gates --changed` drives the CONFIGURED
 * runner end to end — the CLI spawns the witness, fixes the expected
 * set BEFORE the run through the runner adapter, executes the runner
 * child, enforces planned-vs-executed completeness, seals the
 * execution result and issues the authenticated receipt, and
 * `check --changed --require-e2e` then verifies that receipt.
 *
 * Nothing is mocked: a real example app answers on loopback, the real
 * runner (vitest, pytest+httpx, Cypress) executes real test files
 * against it, and every byte of evidence comes from the witness.
 *
 * The RED case is the point of the whole surface: the runner's own
 * green is never authority. A test that calls the app in-process or
 * outside its session proxy produces no observed record, so the
 * obligation stays blocking and no receipt is issued.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { withTempRepo, type TempRepo } from '@gate-forge/core';
import { trustedPolicyDigestForConfig } from '../src/execution.js';
import { loadConfigAt, VERIFIER_KEY_FILE_ENV } from '../src/commands/common.js';
import { runCli } from './helpers.js';

/** Repo root (workspace modules the fixture links resolve from). */
const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
/** The environment fingerprint the example app stamps and the witness attests. */
const FINGERPRINT = 'example-v1';
/** The one obligation every variant proves. */
const CREATE_CLAIM = 'tenant.accounts:persistence:create';
/** The verifier key operator-side; the runner child never sees it. */
const VERIFIER_KEY = 'runner-cli-e2e-verifier-key';

/** The absolute pytest interpreter of the pytest variant (empty = skip). */
const PYTHON = process.env['GATEFORGE_PYTEST_TEST_PYTHON'] ?? '';
/** The absolute Cypress CLI of the Cypress variant (empty = skip). */
const CYPRESS_BIN = process.env['GATEFORGE_CYPRESS_TEST_BIN'] ?? '';

/** Temp dirs and children removed after the suite. */
const TEMP_DIRS: string[] = [];
const CHILDREN: ChildProcess[] = [];
/** Operator key directories removed after the suite. */
const KEY_DIRS: string[] = [];

afterAll(() => {
  for (const child of CHILDREN.splice(0)) child.kill('SIGKILL');
  for (const dir of TEMP_DIRS.splice(0)) rmSync(dir, { recursive: true, force: true });
  for (const dir of KEY_DIRS.splice(0)) rmSync(dir, { recursive: true, force: true });
});
/** One fresh temp directory, removed after the suite. */
function tempDir(prefix: string): string {
// Polling a REAL child process on a bounded deadline is the awaited
// condition here (the child offers no readiness signal beyond answering
// its own route), so this is one of the deliberate real-timer waits.
  const dir = mkdtempSync(join(tmpdir(), prefix));
  TEMP_DIRS.push(dir);
  return dir;
}

/** Symlinks `target` at `link` unless the link already exists. */
function linkIfAbsent(target: string, link: string): void {
  if (!existsSync(link)) symlinkSync(target, link, 'dir');
}

/** One OS-assigned free loopback port. */
function freePort(): Promise<number> {
  return new Promise((resolvePort, rejectPort) => {
    const server = createServer();
    server.once('error', rejectPort);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        server.close();
        rejectPort(new Error('no free loopback port'));
        return;
      }
      const { port } = address;
      server.close(() => resolvePort(port));
    });
  });
}

/**
 * Waits until the example app answers its list route.
 *
 * Args:
 *   url: the app base URL.
 *
 * Returns:
 *   Promise<void>: resolves once the app answers, rejects on timeout.
 */
async function waitForApp(url: string): Promise<void> {
  // Polling a REAL child process on a bounded deadline is the awaited
  // condition here (the child offers no readiness signal beyond
  // answering its own route), so this is a deliberate real-timer wait.
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      const response = await fetch(`${url}/api/accounts`);
      if (response.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 50));
  }
  throw new Error(`the example app never answered ${url}/api/accounts`);
}

/**
 * The fixture detector: the accounts business resource plus the
 * compiled http.endpoint inventory the crud route attribution needs.
 */
const DETECTOR = `export default {
  async discover() {
    const routes = [
      ['POST /accounts', 'POST', '/accounts'],
      ['GET /accounts/{}', 'GET', '/accounts/{}'],
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
      { schemaVersion: 1, target: { resourceName: 'accounts' }, dimension: 'plane', assertion: 'tenant', basis: 'declaration', source: 'gateforge.fixture', location: { file: 'src/accounts.js', line: 1, col: 0 }, detector: { id: 'gateforge.fixture', version: '1.0.0' } },
      { schemaVersion: 1, target: { resourceName: 'accounts' }, dimension: 'identity', assertion: ['id'], basis: 'declaration', source: 'gateforge.fixture', location: { file: 'src/accounts.js', line: 1, col: 0 }, detector: { id: 'gateforge.fixture', version: '1.0.0' } },
      { schemaVersion: 1, target: { resourceName: 'accounts' }, dimension: 'adapter-binding', assertion: 'tenant.accounts', basis: 'declaration', source: 'gateforge.fixture', location: { file: 'src/accounts.js', line: 1, col: 0 }, detector: { id: 'gateforge.fixture', version: '1.0.0' } },
      { schemaVersion: 1, target: { resourceName: 'accounts' }, dimension: 'lifecycle.create', assertion: true, basis: 'declaration', source: 'gateforge.fixture', location: { file: 'src/accounts.js', line: 1, col: 0 }, detector: { id: 'gateforge.fixture', version: '1.0.0' } },
      { schemaVersion: 1, target: { resourceName: 'accounts' }, dimension: 'delete-semantics', assertion: 'archive', basis: 'declaration', source: 'gateforge.fixture', location: { file: 'src/accounts.js', line: 1, col: 0 }, detector: { id: 'gateforge.fixture', version: '1.0.0' } },
      { schemaVersion: 1, target: { resourceName: 'accounts' }, dimension: 'archive-state', assertion: { status: 'archived' }, basis: 'declaration', source: 'gateforge.fixture', location: { file: 'src/accounts.js', line: 1, col: 0 }, detector: { id: 'gateforge.fixture', version: '1.0.0' } },
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
        { schemaVersion: 1, target: { resourceName: name }, dimension: 'identity', assertion: ['method', 'path'], basis: 'declaration', source: 'gateforge.fixture', location: { file: 'src/accounts.js', line: 1, col: 0 }, detector: { id: 'gateforge.fixture', version: '1.0.0' } },
      );
    }
    return {
      resources, unresolved: [], findings: [], classificationSignals };
  },
};
`;

/** Policies document: the one user-facing create contract under test. */
const POLICIES_YML = `schemaVersion: 1
policies:
  - id: crud
    when: {}
    require: [persistence:create]
`;

/** Classification policy for the fixture's complete source scan. */
const CLASSIFICATION_POLICY_YML = `schemaVersion: 1
trustedInternalEntryPoints: []
internalRules: []
`;

/** Reviewed evidence adapter for tenant.accounts (the witness binds it). */
const ADAPTER = `export default {
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
  observe: {
    create: { method: 'POST', path: '/api/accounts' },
    read: { method: 'GET', path: '/api/accounts/{id}' },
  },
};
`;

/**
 * The example backend (plain node http; the surface the observe adapter
 * binds, stamping the attested environment fingerprint).
 */
const APP = `
const http = require('node:http');
const ACCOUNTS = new Map();
let seq = 0;
const server = http.createServer((req, res) => {
  res.setHeader('x-gateforge-env-fingerprint', '${FINGERPRINT}');
  const url = new URL(req.url, 'http://127.0.0.1');
  if (req.method === 'POST' && url.pathname === '/api/accounts') {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      const fields = JSON.parse(body || '{}');
      const id = 'acc-' + String(++seq);
      const record = { id, first_name: fields.first_name ?? '', last_name: fields.last_name ?? '', status: 'active' };
      ACCOUNTS.set(id, record);
      res.writeHead(201, { 'content-type': 'application/json' });
      res.end(JSON.stringify(record));
    });
    return;
  }
  if (req.method === 'GET' && url.pathname === '/api/accounts') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ accounts: [...ACCOUNTS.values()] }));
    return;
  }
  const match = /^\\/api\\/accounts\\/([^/]+)$/.exec(url.pathname);
  if (req.method === 'GET' && match !== null) {
    const record = ACCOUNTS.get(decodeURIComponent(match[1]));
    if (record === undefined) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'absent' }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(record));
    return;
  }
  res.writeHead(404);
  res.end();
});
server.listen(Number(process.env.APP_PORT), '127.0.0.1');
`;

/** One CLI config with the configured runner and the fixed clock. */
function gateforgeYml(runner: string, extra = ''): string {
  return `schemaVersion: 1
project:
  languages: [javascript]
  paths: { include: ['src/**'], exclude: [] }
runner: ${runner}
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
scan:
  scanRoots: ['src/**']
  declarations:
    internality: gateforge:internal
  volatileFields: []
changed: { provider: auto }
witness: { maxDurationSeconds: 5 }
clock: { mode: fixed, fixedAt: '2026-01-01T00:00:00.000Z' }
${extra}`;
}

/**
 * The sidecar binding several runner tests to the create obligation, as
 * ONE yaml document (concatenating two documents would duplicate the
 * top-level `schemaVersion`/`tests` keys and the map would not parse).
 *
 * Args:
 *   runner: the configured runner name.
 *   entries: the runner tests to declare (file plus title path).
 *
 * Returns:
 *   string: the full sidecar text.
 */
function testMapYmlMany(
  runner: string,
  entries: ReadonlyArray<{ file: string; titlePath: readonly string[] }>,
): string {
  const body = entries
    .map(({ file, titlePath }) => {
      const titles = titlePath.map((title) => `        - ${title}`).join('\n');
      return `  - key: ${file}#${titlePath.join('>')}
    selector:
      runner: ${runner}
      file: ${file}
      titlePath:
${titles}
    kind: observed-e2e
    categories:
      - persistence.create
    claims:
      - ${CREATE_CLAIM}
    reason: The test creates an account through the observed HTTP route and the witness confirms persistence.`;
    })
    .join('\n');
  return `schemaVersion: 1
tests:
${body}
`;
}

/** The sidecar binding one runner test to the create obligation. */
function testMapYml(runner: string, file: string, titlePath: readonly string[]): string {
  return testMapYmlMany(runner, [{ file, titlePath }]);
}

/**
 * Installs the shared fixture files into a fresh temp repository.
 *
 * Args:
 *   repo: the disposable repository.
 *   runner: the configured runner name.
 *   config: the full `.gateforge.yml` text.
 *   files: extra repo-relative files (the app and the runner suite).
 *   testMap: the tracked sidecar text.
 *
 * Returns:
 *   void: nothing; the repository is populated on return.
 */
function installRepo(
  repo: TempRepo,
  runner: string,
  config: string,
  files: Record<string, string>,
  testMap: string,
  policies: string = POLICIES_YML,
): void {
  void runner;
  repo.writeFiles({
    '.gateforge.yml': config,
    '.gateforge/fixture-detector.mjs': DETECTOR,
    '.gateforge/policies.yml': policies,
    '.gateforge/classification-policy.yml': CLASSIFICATION_POLICY_YML,
    '.gateforge/adapters/tenant.accounts.mjs': ADAPTER,
    '.gateforge/baselines/obligations.json': `${JSON.stringify({ schemaVersion: 1, fingerprints: [] }, null, 2)}\n`,
    '.gateforge/test-map.yml': testMap,
    'src/accounts.js': '// fixture source: the accounts resource lives here.\n',
    'package.json': `${JSON.stringify({ type: 'module', private: true }, null, 2)}\n`,
    '.gitignore': ['node_modules', '.gateforge/test-gates', '', ''].join('\n'),
    ...files,
  });
}

/** The operator key ring file (external to the candidate, as in production). */
function provisionKeyRing(): string {
  const directory = mkdtempSync(join(tmpdir(), 'gateforge-runner-e2e-verifier-'));
  KEY_DIRS.push(directory);
  const keyFile = join(directory, 'keys.json');
  writeFileSync(
    keyFile,
    `${JSON.stringify({ schemaVersion: 1, activeKeyId: 'runner-key', keys: { 'runner-key': VERIFIER_KEY } })}\n`,
    { mode: 0o600 },
  );
  return keyFile;
}

/**
 * Starts the example app on a free loopback port.
 *
 * Args:
 *   port: the port the app listens on.
 *   root: the directory holding `app.cjs`.
 *
 * Returns:
 *   Promise<string>: the app base URL (already reachable).
 */
async function startApp(port: number, root: string): Promise<string> {
  const child = spawn(process.execPath, [join(root, 'app.cjs')], {
    env: { ...process.env, APP_PORT: String(port) },
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  CHILDREN.push(child);
  const url = `http://127.0.0.1:${String(port)}`;
  await waitForApp(url);
  return url;
}

/** The JSON report shape `test-gates --changed --format json` prints. */
interface GateReport {
  summary: { obligations: number; blocking: number };
  verdicts: Array<{ obligationId: string; verdict: string }>;
  execution?: { runner?: string; complete?: boolean };
}

/**
 * The operator environment of one gated run (external key ring, the
 * owner-approved policy pin, and the app wiring the witness fronts).
 *
 * Args:
 *   repo: the repository being gated.
 *   keyFile: the external key ring file.
 *   appUrl: the example app base URL.
 *
 * Returns:
 *   Record<string, string>: the environment for every CLI invocation.
 */
function operatorEnv(repo: TempRepo, keyFile: string, appUrl: string): Record<string, string> {
  const config = loadConfigAt(repo.root);
  return {
    [VERIFIER_KEY_FILE_ENV]: keyFile,
    GATEFORGE_APP_BASE_URL: appUrl,
    GATEFORGE_TARGET_BASE_URL: appUrl,
    GATEFORGE_TARGET_FINGERPRINT: FINGERPRINT,
    GATEFORGE_APPROVED_POLICY_DIGEST: trustedPolicyDigestForConfig(repo.root, config),
  };
}

/** The GREEN vitest suite: supertest through the per-test session proxy. */
const VITEST_GREEN = `import { test, expect } from 'vitest';
import request from 'supertest';
import { gateforgeSupertest } from '@gate-forge/pack-playwright/vitest';

const gate = gateforgeSupertest(request);

test('creates account through the session proxy', async () => {
  const app = process.env.GATEFORGE_APP_BASE_URL;
  const response = await (await gate(app)).post('/api/accounts').send({ first_name: 'Grace', last_name: 'Hopper' });
  expect(response.status).toBe(201);
});
`;

/** The RED vitest suite: a raw supertest call that bypasses the proxy. */
const VITEST_RED = `import { test, expect } from 'vitest';
import request from 'supertest';

test('creates account outside the session proxy', async () => {
  const app = process.env.GATEFORGE_APP_BASE_URL;
  const response = await request(app).post('/api/accounts').send({ first_name: 'Direct', last_name: 'Untagged' });
  expect(response.status).toBe(201);
});
`;

/**
 * The MULTI-TEST vitest suite: TWO `test()` cases in ONE file, each
 * driving the observed route through its own per-test session proxy.
 * A real project never has one test per file, so the supervised
 * channel has to hold for every test the file declares.
 */
const VITEST_MULTI_FIRST = `import { test, expect } from 'vitest';
import request from 'supertest';
import { gateforgeSupertest } from '@gate-forge/pack-playwright/vitest';

const gate = gateforgeSupertest(request);

test('creates account through the session proxy', async () => {
  const app = process.env.GATEFORGE_APP_BASE_URL;
  const response = await (await gate(app)).post('/api/accounts').send({ first_name: 'Grace', last_name: 'Hopper' });
  expect(response.status).toBe(201);
});

test('creates a second account in the same file', async () => {
  const app = process.env.GATEFORGE_APP_BASE_URL;
  const response = await (await gate(app)).post('/api/accounts').send({ first_name: 'Ada', last_name: 'Lovelace' });
  expect(response.status).toBe(201);
});
`;

/** The SECOND vitest file of the multi-test project (one more test). */
const VITEST_MULTI_SECOND = `import { test, expect } from 'vitest';
import request from 'supertest';
import { gateforgeSupertest } from '@gate-forge/pack-playwright/vitest';

const gate = gateforgeSupertest(request);

test('creates an account from the second file', async () => {
  const app = process.env.GATEFORGE_APP_BASE_URL;
  const response = await (await gate(app)).post('/api/accounts').send({ first_name: 'Alan', last_name: 'Turing' });
  expect(response.status).toBe(201);
});
`;

/**
 * The LAGGING-REPORTER vitest suite: ONE file, TWO tests, and the
 * pack reporter's `testEnd` held behind a barrier file that only the
 * SECOND test lifts — after it has resolved its own session.
 *
 * This is the real race, made deterministic: the runner's MAIN process
 * (where the reporter lives) is the one that lags, so test 2's
 * lifecycle must not depend on test 1's end travelling back through
 * it. No sleep, no CPU load, no timing guess: the barrier is a file.
 */
const VITEST_LAGGING_REPORTER = `import { test, expect } from 'vitest';
import { writeFileSync } from 'node:fs';
import request from 'supertest';
import { gateforgeSupertest } from '@gate-forge/pack-playwright/vitest';

const gate = gateforgeSupertest(request);

test('creates account through the session proxy', async () => {
  const app = process.env.GATEFORGE_APP_BASE_URL;
  const response = await (await gate(app)).post('/api/accounts').send({ first_name: 'Grace', last_name: 'Hopper' });
  expect(response.status).toBe(201);
});

test('creates a second account while the reporter still owes the first end', async () => {
  const app = process.env.GATEFORGE_APP_BASE_URL;
  // Resolving this test's own session is the whole point: the previous
  // test's end is still held by the barrier, so nothing the runner's
  // main process has said can open it.
  const api = await gate(app);
  writeFileSync(process.env.GATEFORGE_VITEST_END_BARRIER, 'lifted');
  const response = await api.post('/api/accounts').send({ first_name: 'Ada', last_name: 'Lovelace' });
  expect(response.status).toBe(201);
});
`;

/** The multi-test pytest module: TWO tests in ONE file. */
const PYTEST_MULTI_FIRST = `def test_creates_account(gateforge_http):
    response = gateforge_http.post(
        "/api/accounts", json={"first_name": "Grace", "last_name": "Hopper"}
    )
    assert response.status_code == 201, response.text


def test_creates_a_second_account(gateforge_http):
    response = gateforge_http.post(
        "/api/accounts", json={"first_name": "Ada", "last_name": "Lovelace"}
    )
    assert response.status_code == 201, response.text
`;

/** The SECOND pytest module of the multi-test project. */
const PYTEST_MULTI_SECOND = `def test_creates_an_account_from_the_second_file(gateforge_http):
    response = gateforge_http.post(
        "/api/accounts", json={"first_name": "Alan", "last_name": "Turing"}
    )
    assert response.status_code == 201, response.text
`;

/** The multi-test Cypress spec: TWO `it` cases in ONE spec. */
const CYPRESS_MULTI_FIRST = `describe('accounts', () => {
  it('creates account through the session proxy', () => {
    cy.request({
      method: 'POST',
      url: Cypress.env('appBaseUrl') + '/api/accounts',
      body: { first_name: 'Grace', last_name: 'Hopper' },
    }).its('status').should('eq', 201);
  });

  it('creates a second account in the same spec', () => {
    cy.request({
      method: 'POST',
      url: Cypress.env('appBaseUrl') + '/api/accounts',
      body: { first_name: 'Ada', last_name: 'Lovelace' },
    }).its('status').should('eq', 201);
  });
});
`;

/** The SECOND Cypress spec of the multi-test project. */
const CYPRESS_MULTI_SECOND = `describe('accounts', () => {
  it('creates an account from the second spec', () => {
    cy.request({
      method: 'POST',
      url: Cypress.env('appBaseUrl') + '/api/accounts',
      body: { first_name: 'Alan', last_name: 'Turing' },
    }).its('status').should('eq', 201);
  });
});
`;

/** The vitest config the runner reads (never the consumer's own defaults). */
const VITEST_CONFIG = `import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    include: ['tests/**/*.test.mjs'],
    testTimeout: 30000,
    retry: 0,
  },
});
`;

/**
 * The RED vitest suite a local operator hits on a machine whose
 * browser cannot start: four failing tests, each with the runner's own
 * error message, and one green test so the run has both outcomes.
 */
const VITEST_FAILING = `import { test, expect } from 'vitest';

test('opens the storefront', () => {
  expect(1).toBe(1);
});

test('adds a card', () => {
  expect('card added').toBe('card declined');
});

test('charges the card', () => {
  expect('charged').toBe('declined');
});

test('emails the receipt', () => {
  expect('sent').toBe('queued');
});

test('shows the receipt', () => {
  expect('shown').toBe('hidden');
});
`;

/** Links the workspace modules the vitest suite imports. */
function linkVitestModules(repo: TempRepo): void {
  const modules = join(repo.root, 'node_modules');
  mkdirSync(join(modules, '@gate-forge'), { recursive: true });
  linkIfAbsent(join(ROOT, 'node_modules', 'vitest'), join(modules, 'vitest'));
  linkIfAbsent(join(ROOT, 'node_modules', 'supertest'), join(modules, 'supertest'));
  linkIfAbsent(join(ROOT, 'packages', 'pack-playwright'), join(modules, '@gate-forge', 'pack-playwright'));
}

/**
 * The runner child's own failure text (the state dir is removed with the
 * repository, so a failing gate must carry the cause in its message).
 *
 * Args:
 *   repo: the disposable repository.
 *
 * Returns:
 *   string: the assertion message tail, or '' when the child passed.
 */
function runnerFailures(repo: TempRepo): string {
  const root = repo.path('.gateforge/test-gates/vitest');
  if (!existsSync(root)) return '';
  const messages: string[] = [];
  for (const run of readdirSync(root)) {
    const report = join(root, run, 'report.json');
    if (!existsSync(report)) continue;
    const document = JSON.parse(readFileSync(report, 'utf8')) as {
      testResults?: Array<{ assertionResults?: Array<{ title?: string; status?: string; failureMessages?: string[] }> }>;
    };
    for (const suite of document.testResults ?? []) {
      for (const row of suite.assertionResults ?? []) {
        if (row.status === 'passed') continue;
        messages.push(`${String(row.title)}: ${(row.failureMessages ?? []).join(' | ').slice(0, 2000)}`);
      }
    }
  }
  const timingPath = repo.path('.gateforge/test-gates/diagnostics/child-timing.jsonl');
  const timing = existsSync(timingPath) ? `\nchild timing:\n${readFileSync(timingPath, 'utf8')}` : '';
  return messages.length === 0 ? '' : `runner failures:\n${messages.join('\n')}${timing}\n`;
}

describe('vitest+supertest through the real CLI', () => {
  it('seals a receipt for the observed create and refuses to credit a bypassed request', async () => {
    const keyFile = provisionKeyRing();
    await withTempRepo({}, async (repo) => {
      installRepo(
        repo,
        'vitest',
        gateforgeYml('vitest'),
        {
          'app.cjs': APP,
          'vitest.config.mjs': VITEST_CONFIG,
          'tests/green.test.mjs': VITEST_GREEN,
        },
        testMapYml('vitest', 'tests/green.test.mjs', ['creates account through the session proxy']),
      );
      linkVitestModules(repo);
      repo.git(['add', '-A']);
      repo.git(['commit', '--no-gpg-sign', '--quiet', '-m', 'vitest runner fixture']);
      // The genuine candidate change: a comment-only edit to the
      // resource source (the obligation still binds it).
      repo.writeFiles({ 'src/accounts.js': '// fixture source: the accounts resource lives here.\n// change: audited.\n' });
      const port = await freePort();
      const appUrl = await startApp(port, repo.root);
      const env = operatorEnv(repo, keyFile, appUrl);

      const gated = await runCli(repo, ['test-gates', '--changed', '--format', 'json'], env);
      const why = `${runnerFailures(repo)}test-gates stdout:\n${gated.stdout}\nstderr:\n${gated.stderr}`;
      expect(gated.code, why).toBe(0);
      const report = JSON.parse(gated.stdout) as GateReport;
      expect(report.summary.blocking, why).toBe(0);
      expect(report.verdicts.find((entry) => entry.obligationId === CREATE_CLAIM)?.verdict).toBe('satisfied');
      // The sealed execution result — not the stdout projection — is the
      // artifact that names the runner the gate actually executed.
      const sealed = JSON.parse(
        readFileSync(repo.path('.gateforge/test-gates/execution-result.json'), 'utf8'),
      ) as { selection?: { runner?: string } };
      expect(sealed.selection?.runner).toBe('vitest');
      expect(existsSync(repo.path('.gateforge/test-gates/receipt.json'))).toBe(true);

      const checked = await runCli(repo, ['check', '--changed', '--require-e2e', '--format', 'json'], env);
      expect(checked.code, `check stdout:\n${checked.stdout}\nstderr:\n${checked.stderr}`).toBe(0);
      expect(checked.stdout).toContain('receipt-verified');
    });

    // RED first in source order matters not: the same obligation stays
    // blocking when the mapped test never drove the observed route.
    await withTempRepo({}, async (repo) => {
      installRepo(
        repo,
        'vitest',
        gateforgeYml('vitest'),
        {
          'app.cjs': APP,
          'vitest.config.mjs': VITEST_CONFIG,
          'tests/red.test.mjs': VITEST_RED,
        },
        testMapYml('vitest', 'tests/red.test.mjs', ['creates account outside the session proxy']),
      );
      linkVitestModules(repo);
      repo.git(['add', '-A']);
      repo.git(['commit', '--no-gpg-sign', '--quiet', '-m', 'vitest bypass fixture']);
      repo.writeFiles({ 'src/accounts.js': '// fixture source: the accounts resource lives here.\n// change: audited.\n' });
      const port = await freePort();
      const appUrl = await startApp(port, repo.root);
      const env = operatorEnv(repo, keyFile, appUrl);

      const gated = await runCli(repo, ['test-gates', '--changed', '--format', 'json'], env);
      expect(gated.code, `test-gates stdout:\n${gated.stdout}\nstderr:\n${gated.stderr}`).toBe(1);
      const report = JSON.parse(gated.stdout) as GateReport;
      expect(report.verdicts.find((entry) => entry.obligationId === CREATE_CLAIM)?.verdict).not.toBe('satisfied');
      expect(report.summary.blocking).toBeGreaterThan(0);
      expect(existsSync(repo.path('.gateforge/test-gates/receipt.json'))).toBe(false);

      const checked = await runCli(repo, ['check', '--changed', '--require-e2e', '--format', 'json'], env);
      expect(checked.code).toBe(1);
      expect(checked.stdout).not.toContain('"evidenceState":"receipt-verified"');
    });
  }, 300_000);
});

/**
 * The runner child's own failure text for a pytest run (the state dir is
 * removed with the repository, so a failing gate must carry the cause).
 *
 * Args:
 *   repo: the disposable repository.
 *
 * Returns:
 *   string: the junit failure messages, or '' when the child passed.
 */
function pytestRunnerFailures(repo: TempRepo): string {
  const root = repo.path('.gateforge/test-gates/pytest');
  if (!existsSync(root)) return '';
  const messages: string[] = [];
  for (const run of readdirSync(root)) {
    const report = join(root, run, 'report.xml');
    if (!existsSync(report)) continue;
    for (const match of readFileSync(report, 'utf8').matchAll(/<testcase[^>]*name="([^"]*)"[\s\S]*?<\/testcase>/g)) {
      const body = match[0];
      if (!body.includes('<failure')) continue;
      messages.push(`${match[1] ?? ''}: ${(body.match(/<failure[^>]*message="([^"]*)"/)?.[1] ?? 'failed').slice(0, 2000)}`);
    }
  }
  return messages.length === 0 ? '' : `runner failures:\n${messages.join('\n')}\n`;
}

/** The GREEN pytest suite: httpx through the per-test session proxy. */
const PYTEST_GREEN = `def test_creates_account(gateforge_http):
    response = gateforge_http.post(
        "/api/accounts", json={"first_name": "Grace", "last_name": "Hopper"}
    )
    assert response.status_code == 201, response.text
    assert response.json()["first_name"] == "Grace"
`;

/** The RED pytest suite: a direct urllib call that bypasses the proxy. */
const PYTEST_RED = `import json
import os
import urllib.request


def test_calls_app_directly():
    request = urllib.request.Request(
        os.environ["GATEFORGE_APP_BASE_URL"] + "/api/accounts",
        data=json.dumps({"first_name": "Direct", "last_name": "Untagged"}).encode(),
        headers={"content-type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(request) as response:
        assert response.status == 201
`;

/**
 * The pytest variant's `.gateforge.yml` extra block: the one configured
 * suite the adapter composes its runs from. `witnessed: true` keeps the
 * suite out of the advisory diagnostic window — under `runner: pytest`
 * the adapter's supervised execution IS that suite, so a second pass
 * would run it twice.
 *
 * Args:
 *   python: the absolute interpreter of the pytest variant.
 *
 * Returns:
 *   string: the YAML block appended to the shared fixture config.
 */
function pytestSuiteYml(python: string): string {
  return `diagnostics:
  suites:
    - name: accounts-httpx
      runner: pytest
      cwd: .
      argv: ["${python}", "-m", "pytest", "-p", "no:cacheprovider"]
      testPaths: ["tests"]
      timeoutMs: 120000
      witnessed: true
`;
}

describe.skipIf(PYTHON === '')('pytest+httpx through the real CLI', () => {
  it('seals a receipt for the observed create and refuses to credit a bypassed request', async () => {
    const keyFile = provisionKeyRing();
    await withTempRepo({}, async (repo) => {
      installRepo(
        repo,
        'pytest',
        gateforgeYml('pytest', pytestSuiteYml(PYTHON)),
        {
          'app.cjs': APP,
          'tests/test_green.py': PYTEST_GREEN,
        },
        testMapYml('pytest', 'tests/test_green.py', ['test_creates_account']),
      );
      repo.git(['add', '-A']);
      repo.git(['commit', '--no-gpg-sign', '--quiet', '-m', 'pytest runner fixture']);
      repo.writeFiles({ 'src/accounts.js': '// fixture source: the accounts resource lives here.\n// change: audited.\n' });
      const port = await freePort();
      const appUrl = await startApp(port, repo.root);
      const env = operatorEnv(repo, keyFile, appUrl);

      const gated = await runCli(repo, ['test-gates', '--changed', '--format', 'json'], env);
      const why = `${pytestRunnerFailures(repo)}test-gates stdout:\n${gated.stdout}\nstderr:\n${gated.stderr}`;
      expect(gated.code, why).toBe(0);
      const report = JSON.parse(gated.stdout) as GateReport;
      expect(report.summary.blocking, why).toBe(0);
      expect(report.verdicts.find((entry) => entry.obligationId === CREATE_CLAIM)?.verdict).toBe('satisfied');
      const sealed = JSON.parse(
        readFileSync(repo.path('.gateforge/test-gates/execution-result.json'), 'utf8'),
      ) as { selection?: { runner?: string } };
      expect(sealed.selection?.runner).toBe('pytest');
      expect(existsSync(repo.path('.gateforge/test-gates/receipt.json'))).toBe(true);

      const checked = await runCli(repo, ['check', '--changed', '--require-e2e', '--format', 'json'], env);
      expect(checked.code, `check stdout:\n${checked.stdout}\nstderr:\n${checked.stderr}`).toBe(0);
      expect(checked.stdout).toContain('receipt-verified');
    });

    await withTempRepo({}, async (repo) => {
      installRepo(
        repo,
        'pytest',
        gateforgeYml('pytest', pytestSuiteYml(PYTHON)),
        {
          'app.cjs': APP,
          'tests/test_red.py': PYTEST_RED,
        },
        testMapYml('pytest', 'tests/test_red.py', ['test_calls_app_directly']),
      );
      repo.git(['add', '-A']);
      repo.git(['commit', '--no-gpg-sign', '--quiet', '-m', 'pytest bypass fixture']);
      repo.writeFiles({ 'src/accounts.js': '// fixture source: the accounts resource lives here.\n// change: audited.\n' });
      const port = await freePort();
      const appUrl = await startApp(port, repo.root);
      const env = operatorEnv(repo, keyFile, appUrl);

      const gated = await runCli(repo, ['test-gates', '--changed', '--format', 'json'], env);
      expect(gated.code, `${pytestRunnerFailures(repo)}test-gates stdout:\n${gated.stdout}\nstderr:\n${gated.stderr}`).toBe(1);
      const report = JSON.parse(gated.stdout) as GateReport;
      expect(report.verdicts.find((entry) => entry.obligationId === CREATE_CLAIM)?.verdict).not.toBe('satisfied');
      expect(report.summary.blocking).toBeGreaterThan(0);
      expect(existsSync(repo.path('.gateforge/test-gates/receipt.json'))).toBe(false);

      const checked = await runCli(repo, ['check', '--changed', '--require-e2e', '--format', 'json'], env);
      expect(checked.code).toBe(1);
      expect(checked.stdout).not.toContain('"evidenceState":"receipt-verified"');
    });
  }, 300_000);
});

/**
 * The runner child's own failure text for a Cypress run (the state dir
 * is removed with the repository, so a failing gate must carry the
 * cause).
 *
 * Args:
 *   repo: the disposable repository.
 *
 * Returns:
 *   string: the mocha failure messages, or '' when the child passed.
 */
function cypressRunnerFailures(repo: TempRepo): string {
  const root = repo.path('.gateforge/test-gates/cypress');
  if (!existsSync(root)) return '';
  const messages: string[] = [];
  for (const run of readdirSync(root)) {
    const report = join(root, run, 'report.json');
    if (!existsSync(report)) continue;
    const document = JSON.parse(readFileSync(report, 'utf8')) as {
      specs?: Array<{ file?: string; tests?: Array<{ titlePath?: string[]; state?: string }> }>;
    };
    for (const spec of document.specs ?? []) {
      for (const row of spec.tests ?? []) {
        if (row.state === 'passed') continue;
        messages.push(`${String(spec.file)}#${(row.titlePath ?? []).join('>')}: ${String(row.state)}`);
      }
    }
  }
  return messages.length === 0 ? '' : `runner failures:\n${messages.join('\n')}\n`;
}

/** The GREEN Cypress spec: `cy.request` at the app origin (the tagged channel). */
const CYPRESS_GREEN = `describe('accounts', () => {
  it('creates account through the session proxy', () => {
    cy.request({
      method: 'POST',
      url: Cypress.env('appBaseUrl') + '/api/accounts',
      body: { first_name: 'Grace', last_name: 'Hopper' },
    }).its('status').should('eq', 201);
  });
});
`;

/**
 * The RED Cypress spec: a raw browser `fetch` at the same origin. The
 * runner is green, but nothing about it crosses the session proxy, so
 * the witness credits it to nothing.
 */
const CYPRESS_RED = `describe('accounts', () => {
  it('bypasses the session proxy', () => {
    cy.window().then((win) =>
      win
        .fetch(Cypress.env('appBaseUrl') + '/api/accounts', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ first_name: 'Direct', last_name: 'Untagged' }),
        })
        .then((response) => {
          expect(response.status).to.eq(201);
        }),
    );
  });
});
`;
/**
 * The FAILING Cypress spec: a real `cy.request` at the app origin
 * whose own assertion is wrong. The request crosses the session
 * proxy, but the test fails — so the gate must report the test
 * failure, and nothing the run leaves behind may be mistaken for it.
 */
const CYPRESS_FAILING = `describe('accounts', () => {
  it('asserts the wrong status and fails', () => {
    cy.request({
      method: 'POST',
      url: Cypress.env('appBaseUrl') + '/api/accounts',
      body: { first_name: 'Alan', last_name: 'Turing' },
    }).its('status').should('eq', 418);
  });
});
`;

/**
 * The project's own Cypress config — an ordinary CommonJS config with
 * no knowledge of gateforge. Whatever the run must not leave behind
 * in the candidate (videos, screenshots, downloads) is the ADAPTER's
 * job, not the fixture's.
 */
const CYPRESS_CONFIG = `module.exports = {
  e2e: {
    specPattern: 'cypress/e2e/**/*.cy.js',
    retries: 0,
    env: { appBaseUrl: process.env.GATEFORGE_APP_BASE_URL },
  },
};
`;

/**
 * Makes the real Cypress CLI resolvable in the disposable project (the
 * adapter resolves the project's own CLI first).
 *
 * Args:
 *   repo: the disposable repository.
 *
 * Returns:
 *   void: nothing; the project gains a `node_modules/.bin/cypress`.
 */
function linkCypressCli(repo: TempRepo): void {
  mkdirSync(join(repo.root, 'node_modules', '.bin'), { recursive: true });
  linkIfAbsent(CYPRESS_BIN, join(repo.root, 'node_modules', '.bin', 'cypress'));
}

describe.skipIf(CYPRESS_BIN === '')('cypress through the real CLI', () => {
  it('seals a receipt for the observed create and refuses to credit a bypassed request', async () => {
    const keyFile = provisionKeyRing();
    await withTempRepo({}, async (repo) => {
      installRepo(
        repo,
        'cypress',
        gateforgeYml('cypress'),
        {
          'app.cjs': APP,
          'cypress.config.cjs': CYPRESS_CONFIG,
          'cypress/e2e/green.cy.js': CYPRESS_GREEN,
        },
        testMapYml('cypress', 'cypress/e2e/green.cy.js', ['accounts', 'creates account through the session proxy']),
      );
      linkCypressCli(repo);
      repo.git(['add', '-A']);
      repo.git(['commit', '--no-gpg-sign', '--quiet', '-m', 'cypress runner fixture']);
      repo.writeFiles({ 'src/accounts.js': '// fixture source: the accounts resource lives here.\n// change: audited.\n' });
      const port = await freePort();
      const appUrl = await startApp(port, repo.root);
      const env = operatorEnv(repo, keyFile, appUrl);

      const gated = await runCli(repo, ['test-gates', '--changed', '--format', 'json'], env);
      const why = `${cypressRunnerFailures(repo)}test-gates stdout:\n${gated.stdout}\nstderr:\n${gated.stderr}`;
      expect(gated.code, why).toBe(0);
      const report = JSON.parse(gated.stdout) as GateReport;
      expect(report.summary.blocking, why).toBe(0);
      expect(report.verdicts.find((entry) => entry.obligationId === CREATE_CLAIM)?.verdict).toBe('satisfied');
      const sealed = JSON.parse(
        readFileSync(repo.path('.gateforge/test-gates/execution-result.json'), 'utf8'),
      ) as { selection?: { runner?: string } };
      expect(sealed.selection?.runner).toBe('cypress');
      expect(existsSync(repo.path('.gateforge/test-gates/receipt.json'))).toBe(true);

      const checked = await runCli(repo, ['check', '--changed', '--require-e2e', '--format', 'json'], env);
      expect(checked.code, `check stdout:\n${checked.stdout}\nstderr:\n${checked.stderr}`).toBe(0);
      expect(checked.stdout).toContain('receipt-verified');
    });

    // RED: the same obligation stays blocking when the mapped test
    // never crossed the session proxy, even though Cypress is green.
    await withTempRepo({}, async (repo) => {
      installRepo(
        repo,
        'cypress',
        gateforgeYml('cypress'),
        {
          'app.cjs': APP,
          'cypress.config.cjs': CYPRESS_CONFIG,
          'cypress/e2e/red.cy.js': CYPRESS_RED,
        },
        testMapYml('cypress', 'cypress/e2e/red.cy.js', ['accounts', 'bypasses the session proxy']),
      );
      linkCypressCli(repo);
      repo.git(['add', '-A']);
      repo.git(['commit', '--no-gpg-sign', '--quiet', '-m', 'cypress bypass fixture']);
      repo.writeFiles({ 'src/accounts.js': '// fixture source: the accounts resource lives here.\n// change: audited.\n' });
      const port = await freePort();
      const appUrl = await startApp(port, repo.root);
      const env = operatorEnv(repo, keyFile, appUrl);

      const gated = await runCli(repo, ['test-gates', '--changed', '--format', 'json'], env);
      expect(gated.code, `${cypressRunnerFailures(repo)}test-gates stdout:\n${gated.stdout}\nstderr:\n${gated.stderr}`).toBe(1);
      const report = JSON.parse(gated.stdout) as GateReport;
      expect(report.verdicts.find((entry) => entry.obligationId === CREATE_CLAIM)?.verdict).not.toBe('satisfied');
      expect(report.summary.blocking).toBeGreaterThan(0);
      expect(existsSync(repo.path('.gateforge/test-gates/receipt.json'))).toBe(false);

      const checked = await runCli(repo, ['check', '--changed', '--require-e2e', '--format', 'json'], env);
      expect(checked.code).toBe(1);
      expect(checked.stdout).not.toContain('"evidenceState":"receipt-verified"');
    });
  }, 900_000);
});

describe.skipIf(CYPRESS_BIN === '')('cypress failure reporting through the real CLI', () => {
  it('reports the failing test itself and leaves no artifacts in the candidate', async () => {
    const keyFile = provisionKeyRing();
    await withTempRepo({}, async (repo) => {
      installRepo(
        repo,
        'cypress',
        gateforgeYml('cypress'),
        {
          'app.cjs': APP,
          'cypress.config.cjs': CYPRESS_CONFIG,
          'cypress/e2e/failing.cy.js': CYPRESS_FAILING,
        },
        testMapYml('cypress', 'cypress/e2e/failing.cy.js', ['accounts', 'asserts the wrong status and fails']),
      );
      linkCypressCli(repo);
      repo.git(['add', '-A']);
      repo.git(['commit', '--no-gpg-sign', '--quiet', '-m', 'cypress failing fixture']);
      repo.writeFiles({ 'src/accounts.js': '// fixture source: the accounts resource lives here.\n// change: audited.\n' });
      const port = await freePort();
      const appUrl = await startApp(port, repo.root);
      const env = operatorEnv(repo, keyFile, appUrl);

      const gated = await runCli(repo, ['test-gates', '--changed', '--format', 'json'], env);
      const why = `test-gates stdout:\n${gated.stdout}\nstderr:\n${gated.stderr}`;
      expect(gated.code, why).toBe(1);
      // A failing Cypress test writes screenshots and videos by
      // default. If those land in the candidate, the drift gate
      // reports the run changing its own inputs and hides the real
      // failure behind it.
      expect(gated.stdout).not.toContain('changed its own source or configuration inputs');
      const report = JSON.parse(gated.stdout) as GateReport;
      expect(report.summary.blocking, why).toBeGreaterThan(0);
      expect(report.verdicts.find((entry) => entry.obligationId === CREATE_CLAIM)?.verdict).not.toBe('satisfied');
      expect(existsSync(repo.path('cypress/screenshots'))).toBe(false);
      expect(existsSync(repo.path('cypress/videos'))).toBe(false);
      expect(existsSync(repo.path('cypress/downloads'))).toBe(false);
      expect(existsSync(repo.path('.gateforge/test-gates/receipt.json'))).toBe(false);
    });
  }, 900_000);
});

/** The JSON projection of a named `--test --result-only` run. */
interface NamedReport {
  outcome?: string;
  selectors?: Array<{ selector: string; logicalKeys: string[] }>;
  blocking?: Array<{ cause: string; detail: string }>;
  execution?: {
    scope?: string;
    testsPerformedThisInvocation?: number;
    selectedTests?: { selected: number; passed: number; failed?: number };
    selectedClaims?: { selected: number; satisfied: number; blocking: number };
  };
  diagnosticContext?: { scope?: string };
  summary: { blocking: number };
  verdicts: Array<{ obligationId: string; verdict: string }>;
}

/** The sealed execution result a `--result-only` run leaves in its own state dir. */
interface NamedExecutionResult {
  selection?: { mode?: string; logicalKeys?: string[] };
  outcomes?: Array<{ logicalKey: string; status: string }>;
}

describe('witnessed single test through the real CLI', () => {
  it('reports the honest failure of a named test that bypasses the witness', async () => {
    const keyFile = provisionKeyRing();
    await withTempRepo({}, async (repo) => {
      installRepo(
        repo,
        'vitest',
        gateforgeYml('vitest'),
        {
          'app.cjs': APP,
          'vitest.config.mjs': VITEST_CONFIG,
          'tests/green.test.mjs': VITEST_GREEN,
          'tests/red.test.mjs': VITEST_RED,
        },
        testMapYmlMany('vitest', [
          { file: 'tests/green.test.mjs', titlePath: ['creates account through the session proxy'] },
          { file: 'tests/red.test.mjs', titlePath: ['creates account outside the session proxy'] },
        ]),
      );
      linkVitestModules(repo);
      repo.git(['add', '-A']);
      repo.git(['commit', '--no-gpg-sign', '--quiet', '-m', 'green plus bypass fixture']);
      repo.writeFiles({ 'src/accounts.js': '// fixture source: the accounts resource lives here.\n// change: audited.\n' });
      const port = await freePort();
      const appUrl = await startApp(port, repo.root);
      const env = operatorEnv(repo, keyFile, appUrl);

      // Naming only the bypassing test shows its real verdict: the
      // runner's own green is never authority, so the obligation the
      // selected test claims stays blocking.
      const bypassKey = 'tests/red.test.mjs#creates account outside the session proxy';
      const named = await runCli(
        repo,
        ['test-gates', '--test', bypassKey, '--result-only', '--format', 'json'],
        env,
      );
      const why = `${runnerFailures(repo)}named run stdout:\n${named.stdout}\nstderr:\n${named.stderr}`;
      expect(named.code, why).toBe(1);
      const report = JSON.parse(named.stdout) as NamedReport;
      expect(report.selectors, why).toEqual([{ selector: bypassKey, logicalKeys: [bypassKey] }]);
      expect(report.verdicts.find((entry) => entry.obligationId === CREATE_CLAIM)?.verdict, why).not.toBe('satisfied');
      expect(report.summary.blocking, why).toBeGreaterThan(0);
      // A failing named run still seals nothing.
      expect(existsSync(repo.path('.gateforge/test-gates/receipt.json'))).toBe(false);
    });
  }, 600_000);
});

describe('a named run never touches the sealed receipt', () => {
  it('seals a full receipt, runs one named test, and leaves the receipt byte-identical', async () => {
    const keyFile = provisionKeyRing();
    await withTempRepo({}, async (repo) => {
      installRepo(
        repo,
        'vitest',
        gateforgeYml('vitest'),
        {
          'app.cjs': APP,
          'vitest.config.mjs': VITEST_CONFIG,
          'tests/green.test.mjs': VITEST_GREEN,
          'tests/red.test.mjs': VITEST_RED,
        },
        testMapYmlMany('vitest', [
          { file: 'tests/green.test.mjs', titlePath: ['creates account through the session proxy'] },
          { file: 'tests/red.test.mjs', titlePath: ['creates account outside the session proxy'] },
        ]),
      );
      linkVitestModules(repo);
      repo.git(['add', '-A']);
      repo.git(['commit', '--no-gpg-sign', '--quiet', '-m', 'named receipt identity fixture']);
      repo.writeFiles({ 'src/accounts.js': '// fixture source: the accounts resource lives here.\n// change: audited.\n' });
      const port = await freePort();
      const appUrl = await startApp(port, repo.root);
      const env = operatorEnv(repo, keyFile, appUrl);
      const receiptPath = repo.path('.gateforge/test-gates/receipt.json');
      const receiptDigest = (): string =>
        createHash('sha256').update(readFileSync(receiptPath)).digest('hex');

      // The authoritative seal FIRST: this is the receipt the named run
      // must leave untouched, byte for byte.
      const sealed = await runCli(repo, ['test-gates', '--changed', '--format', 'json'], env);
      const sealWhy = `${runnerFailures(repo)}test-gates stdout:\n${sealed.stdout}\nstderr:\n${sealed.stderr}`;
      expect(sealed.code, sealWhy).toBe(0);
      expect(existsSync(receiptPath)).toBe(true);
      const before = receiptDigest();

      const greenKey = 'tests/green.test.mjs#creates account through the session proxy';
      const named = await runCli(
        repo,
        ['test-gates', '--test', greenKey, '--result-only', '--format', 'json'],
        env,
      );
      const why = `${runnerFailures(repo)}named run stdout:\n${named.stdout}\nstderr:\n${named.stderr}`;
      // The named test is honest and green, so the named run reports a
      // real pass — and it seals NOTHING.
      expect(named.code, why).toBe(0);
      const report = JSON.parse(named.stdout) as NamedReport;
      expect(report.selectors, why).toEqual([{ selector: greenKey, logicalKeys: [greenKey] }]);
      expect(report.execution?.selectedTests?.selected, why).toBe(1);
      expect(report.verdicts.find((entry) => entry.obligationId === CREATE_CLAIM)?.verdict, why).toBe('satisfied');
      expect(report.execution?.selectedTests?.passed, why).toBe(1);
      expect(report.outcome, why).toBe('partial-selection');
      // The run names its own slice: `scope: named (1 tests)` is how a
      // hand-picked selection says out loud that it is not a whole run.
      const namedText = await runCli(repo, ['test-gates', '--test', greenKey, '--result-only'], env);
      expect(namedText.stdout, `named text stdout:\n${namedText.stdout}`).toContain('scope: named (1 tests)');
      expect(namedText.stdout).toContain('a hand-picked test list never seals a receipt');
      // The receipt is byte-identical: a named run can never replace,
      // refresh or clear the owner's seal.
      expect(receiptDigest(), `the named run changed the sealed receipt\n${named.stderr}`).toBe(before);

      // A named run of the FAILING test shows its real verdict and
      // still leaves the same receipt bytes.
      const bypassKey = 'tests/red.test.mjs#creates account outside the session proxy';
      const namedFailing = await runCli(
        repo,
        ['test-gates', '--test', bypassKey, '--result-only', '--format', 'json'],
        env,
      );
      const failingWhy = `${runnerFailures(repo)}named failing run stdout:\n${namedFailing.stdout}\nstderr:\n${namedFailing.stderr}`;
      expect(namedFailing.code, failingWhy).toBe(1);
      const failingReport = JSON.parse(namedFailing.stdout) as NamedReport;
      expect(failingReport.selectors, failingWhy).toEqual([{ selector: bypassKey, logicalKeys: [bypassKey] }]);
      expect(
        failingReport.verdicts.find((entry) => entry.obligationId === CREATE_CLAIM)?.verdict,
        failingWhy,
      ).not.toBe('satisfied');
      expect(receiptDigest(), `the failing named run changed the sealed receipt\n${namedFailing.stderr}`).toBe(before);

      // And the authoritative check is unaffected by both named runs.
      const checked = await runCli(repo, ['check', '--changed', '--require-e2e', '--format', 'json'], env);
      expect(checked.code, `check stdout:\n${checked.stdout}\nstderr:\n${checked.stderr}`).toBe(0);
      expect(checked.stdout).toContain('receipt-verified');
    });
  }, 600_000);
});

describe('a named run executes exactly the named test', () => {
  it('runs one test of a two-test file, not the whole file', async () => {
    const keyFile = provisionKeyRing();
    await withTempRepo({}, async (repo) => {
      installRepo(
        repo,
        'vitest',
        gateforgeYml('vitest'),
        {
          'app.cjs': APP,
          'vitest.config.mjs': VITEST_CONFIG,
          'tests/first.test.mjs': VITEST_MULTI_FIRST,
          'tests/second.test.mjs': VITEST_MULTI_SECOND,
        },
        testMapYmlMany('vitest', [
          { file: 'tests/first.test.mjs', titlePath: ['creates account through the session proxy'] },
          { file: 'tests/first.test.mjs', titlePath: ['creates a second account in the same file'] },
          { file: 'tests/second.test.mjs', titlePath: ['creates an account from the second file'] },
        ]),
      );
      linkVitestModules(repo);
      repo.git(['add', '-A']);
      repo.git(['commit', '--no-gpg-sign', '--quiet', '-m', 'vitest named-narrowing fixture']);
      repo.writeFiles({ 'src/accounts.js': '// fixture source: the accounts resource lives here.\n// change: audited.\n' });
      const port = await freePort();
      const appUrl = await startApp(port, repo.root);
      const env = operatorEnv(repo, keyFile, appUrl);

      // Both tests live in ONE file: naming either of them must execute
      // exactly that one, never its file neighbour and never the second
      // file's test.
      for (const title of ['creates account through the session proxy', 'creates a second account in the same file']) {
        const key = `tests/first.test.mjs#${title}`;
        const named = await runCli(
          repo,
          ['test-gates', '--test', key, '--result-only', '--format', 'json'],
          env,
        );
        const why = `${runnerFailures(repo)}named run ${title} stdout:\n${named.stdout}\nstderr:\n${named.stderr}`;
        // Exactly one test ran: the unselected tests of the same file
        // are neither executed nor graded, so nothing unplanned and no
        // lifecycle conflict can appear. Whether the whole named run
        // exits 0 is the selection-only grading contract, a separate one.
        const report = JSON.parse(named.stdout) as NamedReport;
        expect(report.execution?.testsPerformedThisInvocation, why).toBe(1);
        expect(report.execution?.selectedTests?.passed, why).toBe(1);
        expect(report.execution?.selectedTests?.selected, why).toBe(1);
        expect(report.blocking, why).toEqual([]);
      }
    });
  }, 600_000);
});

describe('vitest multi-test project through the real CLI', () => {
  it('witnesses every test of a two-test file and a second file', async () => {
    const keyFile = provisionKeyRing();
    await withTempRepo({}, async (repo) => {
      installRepo(
        repo,
        'vitest',
        gateforgeYml('vitest'),
        {
          'app.cjs': APP,
          'vitest.config.mjs': VITEST_CONFIG,
          'tests/first.test.mjs': VITEST_MULTI_FIRST,
          'tests/second.test.mjs': VITEST_MULTI_SECOND,
        },
        testMapYmlMany('vitest', [
          { file: 'tests/first.test.mjs', titlePath: ['creates account through the session proxy'] },
          { file: 'tests/first.test.mjs', titlePath: ['creates a second account in the same file'] },
          { file: 'tests/second.test.mjs', titlePath: ['creates an account from the second file'] },
        ]),
      );
      linkVitestModules(repo);
      repo.git(['add', '-A']);
      repo.git(['commit', '--no-gpg-sign', '--quiet', '-m', 'vitest multi-test fixture']);
      repo.writeFiles({ 'src/accounts.js': '// fixture source: the accounts resource lives here.\n// change: audited.\n' });
      const port = await freePort();
      const appUrl = await startApp(port, repo.root);
      const env = operatorEnv(repo, keyFile, appUrl);

      const gated = await runCli(repo, ['test-gates', '--changed', '--format', 'json'], env);
      const why = `${runnerFailures(repo)}test-gates stdout:\n${gated.stdout}\nstderr:\n${gated.stderr}`;
      expect(gated.code, why).toBe(0);
      const report = JSON.parse(gated.stdout) as GateReport;
      expect(report.summary.blocking, why).toBe(0);
      expect(report.verdicts.find((entry) => entry.obligationId === CREATE_CLAIM)?.verdict, why).toBe('satisfied');
      // All THREE planned tests must hold a supervisor-sealed passed
      // session: the completeness check is per test, so a green exit is
      // the proof that every test of the project was witnessed.
      const sealed = JSON.parse(
        readFileSync(repo.path('.gateforge/test-gates/execution-result.json'), 'utf8'),
      ) as { selection?: { logicalKeys?: string[] }; outcomes?: unknown[] };
      expect(sealed.selection?.logicalKeys, why).toHaveLength(3);
      expect(sealed.outcomes, why).toHaveLength(3);

      const checked = await runCli(repo, ['check', '--changed', '--require-e2e', '--format', 'json'], env);
      expect(checked.code, `check stdout:\n${checked.stdout}\nstderr:\n${checked.stderr}`).toBe(0);
      expect(checked.stdout, why).toContain('receipt-verified');
    });
  }, 600_000);
});

describe('a lagging runner reporter never strands the next test of the same file', () => {
  it("opens the second test's session while the reporter still owes the first test its end", async () => {
    const keyFile = provisionKeyRing();
    await withTempRepo({}, async (repo) => {
      try {
        installRepo(
          repo,
          'vitest',
          gateforgeYml('vitest'),
          {
            'app.cjs': APP,
            'vitest.config.mjs': VITEST_CONFIG,
            'tests/first.test.mjs': VITEST_LAGGING_REPORTER,
          },
          testMapYmlMany('vitest', [
            { file: 'tests/first.test.mjs', titlePath: ['creates account through the session proxy'] },
            {
              file: 'tests/first.test.mjs',
              titlePath: ['creates a second account while the reporter still owes the first end'],
            },
          ]),
        );
        linkVitestModules(repo);
        repo.git(['add', '-A']);
        repo.git(['commit', '--no-gpg-sign', '--quiet', '-m', 'vitest lagging-reporter fixture']);
        repo.writeFiles({ 'src/accounts.js': '// fixture source: the accounts resource lives here.\n// change: audited.\n' });
        const port = await freePort();
        const appUrl = await startApp(port, repo.root);
        // The pack reporter holds EVERY testEnd until this file exists;
        // the fixture lifts it from inside the second test, after that
        // test holds its own session. The first test's end therefore
        // cannot open the second test's session — only the worker's own
        // lifecycle can. The seam is ambient wiring the adapter
        // forwards; the CLI runs in-process here, so it is set on
        // process.env and cleared again below. The barrier file lives
        // OUTSIDE the candidate repository: a file appearing in the
        // repository mid-run is candidate drift, which the run must (and
        // does) refuse.
        process.env['GATEFORGE_VITEST_END_BARRIER'] = join(tempDir('gf-end-barrier-'), 'release');
        const env = operatorEnv(repo, keyFile, appUrl);

        const gated = await runCli(repo, ['test-gates', '--changed', '--format', 'json'], env);
        const why = `${runnerFailures(repo)}test-gates stdout:\n${gated.stdout}\nstderr:\n${gated.stderr}`;
        expect(gated.code, why).toBe(0);
        const report = JSON.parse(gated.stdout) as GateReport;
        expect(report.summary.blocking, why).toBe(0);
        expect(report.verdicts.find((entry) => entry.obligationId === CREATE_CLAIM)?.verdict, why).toBe('satisfied');
        // BOTH tests hold a sealed, supervisor-confirmed `passed`
        // session: the worker-side end opened the second test's session,
        // and only the runner's own later outcome sealed the first one.
        const sealed = JSON.parse(
          readFileSync(repo.path('.gateforge/test-gates/execution-result.json'), 'utf8'),
        ) as { outcomes?: unknown[] };
        expect(sealed.outcomes, why).toHaveLength(2);

        const checked = await runCli(repo, ['check', '--changed', '--require-e2e', '--format', 'json'], env);
        expect(checked.code, `check stdout:\n${checked.stdout}\nstderr:\n${checked.stderr}`).toBe(0);
        expect(checked.stdout, why).toContain('receipt-verified');
      } finally {
        delete process.env['GATEFORGE_VITEST_END_BARRIER'];
      }
    });
  }, 600_000);
});

describe.skipIf(PYTHON === '')('pytest multi-test project through the real CLI', () => {
  it('witnesses every test of a two-test file and a second file', async () => {
    const keyFile = provisionKeyRing();
    await withTempRepo({}, async (repo) => {
      installRepo(
        repo,
        'pytest',
        gateforgeYml('pytest', pytestSuiteYml(PYTHON)),
        {
          'app.cjs': APP,
          'tests/test_first.py': PYTEST_MULTI_FIRST,
          'tests/test_second.py': PYTEST_MULTI_SECOND,
        },
        testMapYmlMany('pytest', [
          { file: 'tests/test_first.py', titlePath: ['test_creates_account'] },
          { file: 'tests/test_first.py', titlePath: ['test_creates_a_second_account'] },
          { file: 'tests/test_second.py', titlePath: ['test_creates_an_account_from_the_second_file'] },
        ]),
      );
      repo.git(['add', '-A']);
      repo.git(['commit', '--no-gpg-sign', '--quiet', '-m', 'pytest multi-test fixture']);
      repo.writeFiles({ 'src/accounts.js': '// fixture source: the accounts resource lives here.\n// change: audited.\n' });
      const port = await freePort();
      const appUrl = await startApp(port, repo.root);
      const env = operatorEnv(repo, keyFile, appUrl);

      const gated = await runCli(repo, ['test-gates', '--changed', '--format', 'json'], env);
      const why = `${pytestRunnerFailures(repo)}test-gates stdout:\n${gated.stdout}\nstderr:\n${gated.stderr}`;
      expect(gated.code, why).toBe(0);
      const report = JSON.parse(gated.stdout) as GateReport;
      expect(report.summary.blocking, why).toBe(0);
      expect(report.verdicts.find((entry) => entry.obligationId === CREATE_CLAIM)?.verdict, why).toBe('satisfied');
      const sealed = JSON.parse(
        readFileSync(repo.path('.gateforge/test-gates/execution-result.json'), 'utf8'),
      ) as { selection?: { logicalKeys?: string[] }; outcomes?: unknown[] };
      expect(sealed.selection?.logicalKeys, why).toHaveLength(3);
      expect(sealed.outcomes, why).toHaveLength(3);

      const checked = await runCli(repo, ['check', '--changed', '--require-e2e', '--format', 'json'], env);
      expect(checked.code, `check stdout:\n${checked.stdout}\nstderr:\n${checked.stderr}`).toBe(0);
      expect(checked.stdout, why).toContain('receipt-verified');
    });
  }, 600_000);
});

describe.skipIf(CYPRESS_BIN === '')('cypress multi-test project through the real CLI', () => {
  it('witnesses every test of a two-test spec and a second spec', async () => {
    const keyFile = provisionKeyRing();
    await withTempRepo({}, async (repo) => {
      installRepo(
        repo,
        'cypress',
        gateforgeYml('cypress'),
        {
          'app.cjs': APP,
          'cypress.config.cjs': CYPRESS_CONFIG,
          'cypress/e2e/first.cy.js': CYPRESS_MULTI_FIRST,
          'cypress/e2e/second.cy.js': CYPRESS_MULTI_SECOND,
        },
        testMapYmlMany('cypress', [
          { file: 'cypress/e2e/first.cy.js', titlePath: ['accounts', 'creates account through the session proxy'] },
          { file: 'cypress/e2e/first.cy.js', titlePath: ['accounts', 'creates a second account in the same spec'] },
          { file: 'cypress/e2e/second.cy.js', titlePath: ['accounts', 'creates an account from the second spec'] },
        ]),
      );
      linkCypressCli(repo);
      repo.git(['add', '-A']);
      repo.git(['commit', '--no-gpg-sign', '--quiet', '-m', 'cypress multi-test fixture']);
      repo.writeFiles({ 'src/accounts.js': '// fixture source: the accounts resource lives here.\n// change: audited.\n' });
      const port = await freePort();
      const appUrl = await startApp(port, repo.root);
      const env = operatorEnv(repo, keyFile, appUrl);

      const gated = await runCli(repo, ['test-gates', '--changed', '--format', 'json'], env);
      const why = `${cypressRunnerFailures(repo)}test-gates stdout:\n${gated.stdout}\nstderr:\n${gated.stderr}`;
      expect(gated.code, why).toBe(0);
      const report = JSON.parse(gated.stdout) as GateReport;
      expect(report.summary.blocking, why).toBe(0);
      expect(report.verdicts.find((entry) => entry.obligationId === CREATE_CLAIM)?.verdict, why).toBe('satisfied');
      const sealed = JSON.parse(
        readFileSync(repo.path('.gateforge/test-gates/execution-result.json'), 'utf8'),
      ) as { selection?: { logicalKeys?: string[] }; outcomes?: unknown[] };
      expect(sealed.selection?.logicalKeys, why).toHaveLength(3);
      expect(sealed.outcomes, why).toHaveLength(3);

      const checked = await runCli(repo, ['check', '--changed', '--require-e2e', '--format', 'json'], env);
      expect(checked.code, `check stdout:\n${checked.stdout}\nstderr:\n${checked.stderr}`).toBe(0);
      expect(checked.stdout, why).toContain('receipt-verified');
    });
  }, 900_000);
});

/**
 * A policy that requires one more operation than any fixture test
 * declares: the extra obligation is real, unclaimed, and stays missing
 * in every run of this repository.
 */
const POLICIES_WITH_UNCLAIMED_READ = `schemaVersion: 1
policies:
  - id: crud
    when: {}
    require: [persistence:create, persistence:read]
`;

describe('a named run grades only its selection', () => {
  it('exits 0 on a green selection while an unrelated obligation stays missing', async () => {
    const keyFile = provisionKeyRing();
    await withTempRepo({}, async (repo) => {
      installRepo(
        repo,
        'vitest',
        gateforgeYml('vitest'),
        {
          'app.cjs': APP,
          'vitest.config.mjs': VITEST_CONFIG,
          'tests/green.test.mjs': VITEST_GREEN,
          'tests/red.test.mjs': VITEST_RED,
        },
        testMapYmlMany('vitest', [
          { file: 'tests/green.test.mjs', titlePath: ['creates account through the session proxy'] },
          { file: 'tests/red.test.mjs', titlePath: ['creates account outside the session proxy'] },
        ]),
        POLICIES_WITH_UNCLAIMED_READ,
      );
      linkVitestModules(repo);
      repo.git(['add', '-A']);
      repo.git(['commit', '--no-gpg-sign', '--quiet', '-m', 'named grading fixture']);
      repo.writeFiles({ 'src/accounts.js': '// fixture source: the accounts resource lives here.\n// change: audited.\n' });
      const port = await freePort();
      const appUrl = await startApp(port, repo.root);
      const env = operatorEnv(repo, keyFile, appUrl);

      const greenKey = 'tests/green.test.mjs#creates account through the session proxy';
      const named = await runCli(
        repo,
        ['test-gates', '--test', greenKey, '--result-only', '--format', 'json'],
        env,
      );
      const why = `${runnerFailures(repo)}named run stdout:\n${named.stdout}\nstderr:\n${named.stderr}`;
      // The selection is honest and green, and it is a REPORT: it exits
      // 0 even though the repository still owes an unclaimed read.
      expect(named.code, why).toBe(0);
      const report = JSON.parse(named.stdout) as NamedReport;
      // Only the selected test's claims are graded — the unrelated
      // obligation is reported as repository debt, never as a verdict.
      expect(report.verdicts.map((entry) => entry.obligationId), why).toEqual([CREATE_CLAIM]);
      expect(report.summary.blocking, why).toBe(0);
      expect(report.execution?.scope, why).toBe('named');
      expect(report.diagnosticContext?.scope, why).toBe('named');
      expect(report.execution?.selectedClaims, why).toMatchObject({ selected: 1, satisfied: 1, blocking: 0 });

      // The text report says the same thing out loud, in both halves.
      const text = await runCli(repo, ['test-gates', '--test', greenKey, '--result-only'], env);
      const textWhy = `named text stdout:\n${text.stdout}\nstderr:\n${text.stderr}`;
      expect(text.code, textWhy).toBe(0);
      expect(text.stdout, textWhy).toContain('execution: named scope');
      expect(text.stdout, textWhy).toContain('diagnostic context: scope=named');
      expect(text.stdout, textWhy).toMatch(/not graded in a named run: 1 obligation/);
      expect(text.stdout, textWhy).toContain('2 obligations');

      // The failing selection is still honest: exit 1, with its OWN
      // claim unproven, and the ungraded read never joins the verdict.
      const bypassKey = 'tests/red.test.mjs#creates account outside the session proxy';
      const failing = await runCli(
        repo,
        ['test-gates', '--test', bypassKey, '--result-only', '--format', 'json'],
        env,
      );
      const failingWhy = `${runnerFailures(repo)}named failing run stdout:\n${failing.stdout}\nstderr:\n${failing.stderr}`;
      expect(failing.code, failingWhy).toBe(1);
      const failingReport = JSON.parse(failing.stdout) as NamedReport;
      expect(failingReport.verdicts.map((entry) => entry.obligationId), failingWhy).toEqual([CREATE_CLAIM]);
      expect(
        failingReport.verdicts.find((entry) => entry.obligationId === CREATE_CLAIM)?.verdict,
        failingWhy,
      ).not.toBe('satisfied');
      // A named run seals nothing, so the repository is untouched.
      expect(existsSync(repo.path('.gateforge/test-gates/receipt.json')), failingWhy).toBe(false);
    });
  }, 600_000);
});

describe.skipIf(PYTHON === '')('a named pytest run executes exactly the named test', () => {
  it('runs one test of a two-test module, not the whole module', async () => {
    const keyFile = provisionKeyRing();
    await withTempRepo({}, async (repo) => {
      installRepo(
        repo,
        'pytest',
        gateforgeYml('pytest', pytestSuiteYml(PYTHON)),
        {
          'app.cjs': APP,
          'tests/test_first.py': PYTEST_MULTI_FIRST,
        },
        testMapYmlMany('pytest', [
          { file: 'tests/test_first.py', titlePath: ['test_creates_account'] },
          { file: 'tests/test_first.py', titlePath: ['test_creates_a_second_account'] },
        ]),
      );
      repo.git(['add', '-A']);
      repo.git(['commit', '--no-gpg-sign', '--quiet', '-m', 'pytest named-narrowing fixture']);
      repo.writeFiles({ 'src/accounts.js': '// fixture source: the accounts resource lives here.\n// change: audited.\n' });
      const port = await freePort();
      const appUrl = await startApp(port, repo.root);
      const env = operatorEnv(repo, keyFile, appUrl);

      const named = await runCli(
        repo,
        ['test-gates', '--test', 'tests/test_first.py#test_creates_account', '--result-only', '--format', 'json'],
        env,
      );
      const why = `${pytestRunnerFailures(repo)}named pytest run stdout:\n${named.stdout}\nstderr:\n${named.stderr}`;
      // The node id narrowed the module down to ONE test, and the run
      // graded exactly that test's claim.
      expect(named.code, why).toBe(0);
      const report = JSON.parse(named.stdout) as NamedReport;
      expect(report.execution?.testsPerformedThisInvocation, why).toBe(1);
      expect(report.execution?.selectedTests, why).toMatchObject({ selected: 1, passed: 1, failed: 0 });
      expect(report.execution?.scope, why).toBe('named');
      expect(report.verdicts.map((entry) => entry.obligationId), why).toEqual([CREATE_CLAIM]);
      expect(report.blocking, why).toEqual([]);
    });
  }, 900_000);
});

describe.skipIf(CYPRESS_BIN === '')('a named cypress run grades only the named test', () => {
  it('runs the whole spec but grades and reports only the selection', async () => {
    const keyFile = provisionKeyRing();
    await withTempRepo({}, async (repo) => {
      installRepo(
        repo,
        'cypress',
        gateforgeYml('cypress'),
        {
          'app.cjs': APP,
          'cypress.config.cjs': CYPRESS_CONFIG,
          'cypress/e2e/first.cy.js': CYPRESS_MULTI_FIRST,
        },
        testMapYmlMany('cypress', [
          { file: 'cypress/e2e/first.cy.js', titlePath: ['accounts', 'creates account through the session proxy'] },
          { file: 'cypress/e2e/first.cy.js', titlePath: ['accounts', 'creates a second account in the same spec'] },
        ]),
      );
      linkCypressCli(repo);
      repo.git(['add', '-A']);
      repo.git(['commit', '--no-gpg-sign', '--quiet', '-m', 'cypress named-narrowing fixture']);
      repo.writeFiles({ 'src/accounts.js': '// fixture source: the accounts resource lives here.\n// change: audited.\n' });
      const port = await freePort();
      const appUrl = await startApp(port, repo.root);
      const env = operatorEnv(repo, keyFile, appUrl);

      const named = await runCli(
        repo,
        [
          'test-gates',
          '--test',
          'cypress/e2e/first.cy.js#accounts>creates account through the session proxy',
          '--result-only',
          '--format',
          'json',
        ],
        env,
      );
      const why = `${cypressRunnerFailures(repo)}named cypress run stdout:\n${named.stdout}\nstderr:\n${named.stderr}`;
      expect(named.code, why).toBe(0);
      const report = JSON.parse(named.stdout) as NamedReport;
      // Cypress cannot filter below the spec, so the whole spec ran —
      // and the operator is told exactly how much of it was not graded.
      // Only the selection counts as performed work: the ungraded test's
      // outcome is dropped before the seal, never graded, never evidence.
      expect(named.stderr, why).toContain('also ran 1 other test(s) in the same file — not graded');
      expect(report.execution?.testsPerformedThisInvocation, why).toBe(1);
      // The grading is the selection's alone.
      expect(report.execution?.selectedTests, why).toMatchObject({ selected: 1, passed: 1, failed: 0 });
      expect(report.execution?.scope, why).toBe('named');
      expect(report.verdicts.map((entry) => entry.obligationId), why).toEqual([CREATE_CLAIM]);
      expect(report.summary.blocking, why).toBe(0);
    });
  }, 900_000);
});

/**
 * A local run has no progress stream: `auto` is OFF unless CI is set,
 * so before this a red local run printed a count of failures and not
 * one word about WHY. The final report now names the failing tests
 * with their first error line, from the same credential-screened
 * records the stream itself uses — never from runner output.
 */
describe('a local red run names its failures in the report', () => {
  it('names three failures with their first error line and points at the rest', async () => {
    const keyFile = provisionKeyRing();
    await withTempRepo({}, async (repo) => {
      installRepo(
        repo,
        'vitest',
        gateforgeYml('vitest'),
        { 'app.cjs': APP, 'vitest.config.mjs': VITEST_CONFIG, 'tests/failing.test.mjs': VITEST_FAILING },
        testMapYmlMany('vitest', [
          { file: 'tests/failing.test.mjs', titlePath: ['opens the storefront'] },
          { file: 'tests/failing.test.mjs', titlePath: ['adds a card'] },
          { file: 'tests/failing.test.mjs', titlePath: ['charges the card'] },
          { file: 'tests/failing.test.mjs', titlePath: ['emails the receipt'] },
          { file: 'tests/failing.test.mjs', titlePath: ['shows the receipt'] },
        ]),
      );
      linkVitestModules(repo);
      repo.git(['add', '-A']);
      repo.git(['commit', '--no-gpg-sign', '--quiet', '-m', 'failing vitest fixture']);
      repo.writeFiles({ 'src/accounts.js': '// fixture source: the accounts resource lives here.\n// change: audited.\n' });
      const port = await freePort();
      const appUrl = await startApp(port, repo.root);
      // CI unset: this IS the local default, where the stream is off.
      const env = { ...operatorEnv(repo, keyFile, appUrl), CI: undefined };

      const gated = await runCli(repo, ['test-gates', '--changed'], env);
      const why = `${runnerFailures(repo)}test-gates stdout:\n${gated.stdout}\nstderr:\n${gated.stderr}`;
      expect(gated.code, why).not.toBe(0);
      // The stream itself stayed off — this is the report, not a log.
      expect(gated.stderr, why).not.toMatch(/^gateforge: /m);
      expect(gated.stdout, why).toContain("failed test: adds a card — expected 'card added' to be 'card declined'");
      expect(gated.stdout, why).toContain("failed test: charges the card — expected 'charged' to be 'declined'");
      expect(gated.stdout, why).toContain("failed test: emails the receipt — expected 'sent' to be 'queued'");
      // The fourth failure is named by count, and the line that replaces
      // it is the command that prints every failure as it happens.
      expect(gated.stdout, why).toContain(
        '… 1 more — run with `--progress stderr` to print every failure as it happens',
      );
      expect(gated.stdout, why).not.toContain('failed test: shows the receipt');
      // The local state directory is left exactly as the run found it.
      expect(existsSync(repo.path('.gateforge/test-gates/failures.json'))).toBe(false);
    });
  }, 600_000);
});
