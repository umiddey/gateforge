/**
 * Supervisor stress e2e through the real CLI (plan
 * 20261021_0030_gf_infra_visibility, P4): two witnessed Playwright runs
 * whose observe adapters delay their `list()` by an environment-read
 * delay, so the supervisor→witness session machinery runs under real
 * time pressure.
 *
 * Every run is real: a temp fixture repo, `gateforge test-gates
 * --changed` spawned as a child (the CLI spawns its own witness), a
 * real Chromium suite at `workers: 2, fullyParallel: true`, an example
 * app reached only through the attestation proxy and the per-session
 * observation proxies, and adapters the witness calls ITSELF for the
 * session-open before-snapshots. No mocks anywhere in the evidence
 * path.
 *
 * Cases:
 *  - green stress: 3 observe resources × 300 ms adapter list delay,
 *    8 tests claiming all three resources → every session open takes
 *    three concurrent snapshots, all 8 tests pass, the finish line
 *    counts `0 infra`, and the run writes its per-path supervisor
 *    timing summary (`supervisor-timing.json`) with no near-budget
 *    call.
 *  - over-budget (plan rework per Main's 08:5x review bullet): one
 *    resource's adapter delay (6 s) exceeds the 5 s supervisor request
 *    budget, and a SECOND test follows on the SAME worker after the
 *    over-budget one → the affected test fails with the stable
 *    `[gateforge:infra]` marker, the finish line counts the failure as
 *    infra (never as a test failure), `failures.json` records
 *    `kind: 'infra'` with the marker, the timing warning line names
 *    `/sessions/open` against its 5 s budget — and the follower still
 *    opens, runs and passes: never 409-refused by the abandoned
 *    session, never "No supervisor-issued witness session" (the
 *    orphan-session regression the rework exists to prevent).
 *
 * What counts as proof does not change: an infra failure still fails
 * its test and still blocks; no budget is raised or lowered. The
 * deliberate real-timer waits here (the adapter delay itself and the
 * bounded app-readiness poll) are the subject under test, not a way to
 * make a red run green.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, afterAll } from 'vitest';
import { withTempRepo, type TempRepo } from '@gate-forge/core';
import { startAttestationProxy, stripGateforgeAmbient } from '@gate-forge/pack-playwright';
import { trustedPolicyDigestForConfig } from '../src/execution.js';
import { loadConfigAt, VERIFIER_KEY_FILE_ENV } from '../src/commands/common.js';
import {
  cleanupWitnessedFixture,
  FINGERPRINT,
  GATEFORGE_YML,
  operatorEnvironment,
  ROOT,
} from './witnessed-run-fixture.js';

/** Repo root (the CLI bin and workspace modules resolve from here). */
const CLI_BIN = join(ROOT, 'packages/cli/bin/gateforge.js');
/** The environment name every stress adapter reads its list delay from. */
const DELAY_ENV = 'GATEFORGE_STRESS_LIST_DELAY_MS';
/** The per-resource delay env: each adapter reads its OWN resource's variable. */
function delayEnv(resource: string): string {
  return `${DELAY_ENV}_${resource.toUpperCase()}`;
}
/** The observe resources the stress fixture declares. */
const RESOURCES = ['accounts', 'orders', 'invoices'] as const;
/** All three observe obligations, in resource order. */
const READ_CLAIMS = RESOURCES.map((resource) => `tenant.${resource}:persistence:read`);
const STATE_DIR = '.gateforge/test-gates';

/** Temporary directories and children removed after the suite. */
const TEMP_DIRS: string[] = [];
const CHILDREN: ChildProcess[] = [];

afterAll(() => {
  for (const child of CHILDREN.splice(0)) child.kill('SIGKILL');
  for (const dir of TEMP_DIRS.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface GateReport {
  summary?: { obligations: number; blocking: number };
  verdicts?: Array<{ obligationId: string; verdict: string; reason: string | null }>;
}

interface SupervisorTimingDocument {
  schemaVersion: number;
  paths: Array<{ path: string; count: number; maxMs: number; nearBudget: number; budgetMs: number }>;
}

interface FailuresDocument {
  schemaVersion: number;
  failures: Array<{ logicalKey: string; title: string; message: string; kind: 'infra' | 'test' }>;
}

/** One OS-assigned free loopback port. */
function freePort(): Promise<number> {
  // Executor form: this package's lib predates Promise.withResolvers.
  let settleFreePort!: (port: number) => void;
  let failFreePort!: (error: Error) => void;
  const promise = new Promise<number>((settle, fail) => {
    settleFreePort = settle;
    failFreePort = fail;
  });
  const server = createServer();
  server.once('error', failFreePort);
  server.listen(0, '127.0.0.1', () => {
    const address = server.address();
    if (address === null || typeof address === 'string') {
      server.close();
      failFreePort(new Error('no free loopback port'));
      return;
    }
    const port = address.port;
    server.close(() => settleFreePort(port));
  });
  return promise;
}

/** One fresh temp directory, removed after the suite. */
function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  TEMP_DIRS.push(dir);
  return dir;
}

/**
 * The fixture detector: three business resources, each with the full
 * declaration signal set (plane, identity, adapter binding, lifecycle,
 * delete semantics) so the persistence:read policy resolves one
 * obligation per resource.
 */
const DETECTOR = `export default {
  async discover() {
    const resources = [];
    const classificationSignals = [];
    for (const [resourceName, file] of ${JSON.stringify(RESOURCES.map((resource) => [resource, `src/${resource}.js`]))}) {
      resources.push({
        schemaVersion: 1,
        id: resourceName,
        kind: 'fixture.entity',
        source: file,
        location: { file, line: 1, col: 0 },
        detectorVersion: '1.0.0',
        attributes: { resourceName, updateableFields: ['status'] },
      });
      const signals = [
        ['plane', 'tenant'],
        ['identity', ['id']],
        ['adapter-binding', 'tenant.' + resourceName],
        ['lifecycle.create', true],
        ['lifecycle.read', true],
        ['lifecycle.update', true],
        ['lifecycle.delete', true],
        ['delete-semantics', 'archive'],
        ['archive-state', { status: 'archived' }],
      ];
      for (const [dimension, assertion] of signals) {
        classificationSignals.push({
          schemaVersion: 1,
          target: { resourceName },
          dimension,
          assertion,
          basis: 'declaration',
          source: 'gateforge.fixture',
          location: { file, line: 1, col: 0 },
          detector: { id: 'gateforge.fixture', version: '1.0.0' },
        });
      }
    }
    return { resources, unresolved: [], findings: [], classificationSignals };
  },
};
`;

/** Policies document: one persistence:read obligation per resource. */
const POLICIES_YML = `schemaVersion: 1
policies:
  - id: observe-read
    when: {}
    require: [persistence:read]
`;

/** Classification policy for the fixture's complete source scan. */
const CLASSIFICATION_POLICY_YML = `schemaVersion: 1
trustedInternalEntryPoints: []
internalRules: []
`;

/**
 * One evidence adapter module for `resource`. Its `list()` waits for
 * the resource's environment-read delay BEFORE listing — the witness
 * runs this adapter itself for the session-open before-snapshot, so
 * the delay is exactly what the supervisor's session machinery must
 * survive (green case) or honestly report (over-budget case). Each
 * resource reads its OWN variable, so the over-budget case slows one
 * resource only and the follower test's open stays fast.
 */
function adapterSource(resource: string): string {
  return `// Reviewed evidence adapter for tenant.${resource} (GET-only). The
// list delay reads the resource's environment variable: the stress
// suite slows the witness's own session-open snapshot on purpose (plan
// 20261021_0030_gf_infra_visibility P4).
const DELAY_MS = Number(process.env[${JSON.stringify(delayEnv(resource))}] ?? '0');
export default {
  async read(ctx, id) {
    const res = await ctx.get('/api/${resource}/' + encodeURIComponent(String(id)));
    if (res.status === 404) return null;
    if (res.status !== 200) throw new Error('adapter read failed: HTTP ' + res.status);
    return res.json();
  },
  async list(ctx) {
    // Deliberate real-timer wait: the delay under test arrives from the
    // environment (300 ms in the green stress case, past the 5 s
    // supervisor budget in the over-budget case).
    if (DELAY_MS > 0) await new Promise((resolveSleep) => setTimeout(resolveSleep, DELAY_MS));
    const res = await ctx.get('/api/${resource}');
    if (res.status !== 200) throw new Error('adapter list failed: HTTP ' + res.status);
    const body = await res.json();
    return body.${resource};
  },
  normalize(body) {
    return { entityId: body.id, fields: { status: body.status } };
  },
  deletion: 'archive',
  environmentFingerprint: '${FINGERPRINT}',
  observe: {
    read: { method: 'GET', path: '/api/${resource}', collection: { rowsKey: '${resource}', idKey: 'id' } },
  },
};
`;
}

/** The example backend: static seed rows behind a real UI that reads them. */
const APP = `const http = require('node:http');
const SEED = {
${RESOURCES.map((resource) => `  ${resource}: [{ id: '${resource.slice(0, 3)}-1', status: 'open' }, { id: '${resource.slice(0, 3)}-2', status: 'open' }],`).join('\n')}
};
const PAGE = ['<html><body>', ...Object.keys(SEED).map((name) => '<button data-load="' + name + '">Load ' + name + '</button>'), '<div id="result"></div>', '<script>', 'document.querySelectorAll("button[data-load]").forEach((button) => {', '  button.onclick = async () => {', '    const response = await fetch("/api/" + button.dataset.load);', '    document.getElementById("result").textContent = button.dataset.load + ":" + response.status;', '  };', '});', '</script>', '</body></html>'].join('');
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (req.method === 'GET' && url.pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(PAGE);
    return;
  }
  const match = /^\\/api\\/(accounts|orders|invoices)$/.exec(url.pathname);
  if (req.method === 'GET' && match !== null) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ [match[1]]: SEED[match[1]] }));
    return;
  }
  const single = /^\\/api\\/(accounts|orders|invoices)\\/([^/]+)$/.exec(url.pathname);
  if (req.method === 'GET' && single !== null) {
    const row = SEED[single[1]].find((entry) => entry.id === decodeURIComponent(single[2]));
    if (row === undefined) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'absent' }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(row));
    return;
  }
  res.writeHead(404);
  res.end();
});
server.listen(Number(process.env.APP_PORT), '127.0.0.1');
`;

/**
 * The Playwright config the stress suite runs under. The green stress
 * case keeps `workers: 2, fullyParallel: true` — the parallelism the
 * supervisor machinery must hold while every session open waits for
 * delayed adapter snapshots. The over-budget case runs ONE worker: its
 * second test must follow the over-budget one ON THE SAME WORKER (plan
 * 20261021_0030_gf_infra_visibility P4 rework), which only a single
 * worker guarantees.
 */
function playwrightConfig(workers: number): string {
  return `export default {
  testDir: 'specs',
  fullyParallel: true,
  workers: ${workers},
  retries: 0,
  forbidOnly: true,
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
  use: { headless: true, trace: 'off' },
  timeout: 60_000,
};
`;
}

/** One stress test body: three UI-driven collection reads. */
function stressSpec(titles: readonly string[]): string {
  const body = titles
    .map(
      (title) => `test('${title}', async ({ page }) => {
  const base = process.env.GATEFORGE_APP_BASE_URL;
  await page.goto(base + '/');
  for (const resource of ['accounts', 'orders', 'invoices']) {
    await page.getByRole('button', { name: 'Load ' + resource }).click();
    await expect(page.getByText(resource + ':200')).toBeVisible();
  }
});`,
    )
    .join('\n');
  return `import { test, expect } from '@gate-forge/pack-playwright/fixture';\n${body}\n`;
}

/**
 * The sidecar binding each mapped stress test to ITS OWN claim set:
 * the over-budget case scopes the slow resource to the affected test
 * so the follower's session snapshots stay fast.
 */
function testMapYml(mapped: ReadonlyArray<{ title: string; claims: readonly string[] }>): string {
  const body = mapped
    .map(
      (entry) => `  - key: playwright:chromium:specs/stress.spec.js:${entry.title}
    selector: { runner: playwright, project: chromium, file: specs/stress.spec.js, titlePath: ['${entry.title}'] }
    kind: observed-e2e
    claims: [${entry.claims.map((claim) => `'${claim}'`).join(', ')}]
    reason: Stress test proving its observe resources through one witnessed session.`,
    )
    .join('\n');
  return `schemaVersion: 1
tests:
${body}
`;
}

/** Installs the stress fixture repository (three resources, N tests). */
function installStressFixture(
  repo: TempRepo,
  specText: string,
  testMap: string | null,
  workers: number,
): void {
  repo.writeFiles({
    '.gateforge.yml': GATEFORGE_YML,
    '.gateforge/fixture-detector.mjs': DETECTOR,
    '.gateforge/policies.yml': POLICIES_YML,
    '.gateforge/classification-policy.yml': CLASSIFICATION_POLICY_YML,
    ...Object.fromEntries(RESOURCES.map((resource) => [`.gateforge/adapters/tenant.${resource}.mjs`, adapterSource(resource)])),
    '.gateforge/baselines/obligations.json': `${JSON.stringify({ schemaVersion: 1, fingerprints: [] }, null, 2)}\n`,
    ...(testMap === null ? {} : { '.gateforge/test-map.yml': testMap }),
    ...Object.fromEntries(RESOURCES.map((resource) => [`src/${resource}.js`, `// fixture source: the ${resource} resource lives here.\n`])),
    'app.cjs': APP,
    'playwright.config.mjs': playwrightConfig(workers),
    'specs/stress.spec.js': specText,
    'package.json': `${JSON.stringify({ type: 'module', private: true }, null, 2)}\n`,
    '.gitignore': ['node_modules', 'test-results', 'playwright-report', '.playwright', STATE_DIR, ''].join('\n'),
  });
  // Specs resolve the workspace pack + playwright through the monorepo
  // modules (consumers would install them; the fixture links them).
  symlinkWorkspaceModules(repo);
}

/** Symlinks the workspace node_modules into the temp repo. */
function symlinkWorkspaceModules(repo: TempRepo): void {
  symlinkSync(
    process.env['GATEFORGE_PHYSICAL_NODE_MODULES'] ?? join(ROOT, 'node_modules'),
    join(repo.root, 'node_modules'),
    'dir',
  );
}

/**
 * Starts the stress app on a free loopback port and waits until it
 * answers its accounts route.
 *
 * Polling a REAL child process on a bounded deadline is the awaited
 * condition here (the child offers no readiness signal beyond answering
 * its own route), so this is one of the deliberate real-timer waits.
 */
async function startStressApp(): Promise<{ url: string; stop: () => void }> {
  const port = await freePort();
  const root = tempDir('gateforge-supervisor-stress-app-');
  writeFileSync(join(root, 'app.cjs'), APP);
  const child = spawn(process.execPath, [join(root, 'app.cjs')], {
    env: { ...process.env, APP_PORT: String(port) },
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  CHILDREN.push(child);
  const url = `http://127.0.0.1:${String(port)}`;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`the stress app exited early (code ${String(child.exitCode)})`);
    try {
      const response = await fetch(`${url}/api/accounts`);
      if (response.ok) return { url, stop: () => child.kill('SIGKILL') };
    } catch {
      // not up yet
    }
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 50));
  }
  child.kill('SIGKILL');
  throw new Error(`the stress app never answered ${url}/api/accounts`);
}

/**
 * Spawns the real CLI (`gateforge test-gates --changed --format json`)
 * as a child — the CLI spawns and owns its witness, whose adapter
 * modules inherit this environment (the delay env reaches them).
 *
 * Args:
 *   repo: the fixture repository.
 *   env: the operator environment (verifier key ring, app wiring, delay).
 *
 * Returns:
 *   { code, stdout, stderr }: the child's exit status and captured output.
 */
async function runGates(
  repo: TempRepo,
  env: Record<string, string>,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  // Executor form: this package's lib predates Promise.withResolvers.
  let settleRun!: (outcome: { code: number | null; stdout: string; stderr: string }) => void;
  const promise = new Promise<{ code: number | null; stdout: string; stderr: string }>((settle) => {
    settleRun = settle;
  });
  const child = spawn(
    process.execPath,
    [CLI_BIN, 'test-gates', '--changed', '--format', 'json'],
    {
      cwd: repo.root,
      env: { ...stripGateforgeAmbient(process.env), ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  child.on('error', (error) => {
    settleRun({ code: null, stdout, stderr: `${stderr}\nspawn error: ${String(error)}` });
  });
  child.on('exit', (code) => {
    settleRun({ code, stdout, stderr });
  });
  return promise;
}

/** One witnessed stress run end to end; returns everything assertions read. */
async function runStressCase(options: {
  titles: readonly string[];
  mappedTitles: ReadonlyArray<{ title: string; claims: readonly string[] }> | null;
  delays: Record<(typeof RESOURCES)[number], number>;
  workers: number;
}): Promise<{
  code: number | null;
  stdout: string;
  stderr: string;
  report: GateReport;
  /** Raw state documents, read while the temp repo still exists. */
  supervisorTimingJson: string | null;
  failuresJson: string | null;
}> {
  const app = await startStressApp();
  const proxy = await startAttestationProxy(app.url, FINGERPRINT);
  const { keyFile, env: keyEnv } = operatorEnvironment();
  try {
    return await withTempRepo({}, async (repo) => {
      const specText = stressSpec(options.titles);
      const testMap = options.mappedTitles === null ? null : testMapYml(options.mappedTitles);
      installStressFixture(repo, specText, testMap, options.workers);
      repo.git(['add', '-A']);
      repo.git(['commit', '--no-gpg-sign', '--quiet', '-m', 'supervisor stress fixture']);
      // The --changed selection needs one tracked change to seed from.
      repo.writeFiles({ 'src/accounts.js': '// changed stress source\n' });
      repo.git(['add', 'src/accounts.js']);
      const run = await runGates(repo, {
        ...keyEnv,
        ...Object.fromEntries(RESOURCES.map((resource) => [delayEnv(resource), String(options.delays[resource])])),
        GATEFORGE_APP_BASE_URL: proxy.url,
        GATEFORGE_TARGET_BASE_URL: proxy.url,
        GATEFORGE_TARGET_FINGERPRINT: FINGERPRINT,
        GATEFORGE_APPROVED_POLICY_DIGEST: trustedPolicyDigestForConfig(repo.root, loadConfigAt(repo.root)),
      });
      const evidence = `stdout:\n${run.stdout}\nstderr:\n${run.stderr}`;
      if (!run.stdout.trimStart().startsWith('{')) {
        throw new Error(`test-gates printed no report\n${evidence}`);
      }
      const report = JSON.parse(run.stdout) as GateReport;
      // State documents are read HERE — withTempRepo removes the repo
      // the moment this callback returns.
      const readState = (file: string): string | null => {
        try {
          return readFileSync(repo.path(join(STATE_DIR, file)), 'utf8');
        } catch {
          return null;
        }
      };
      return {
        code: run.code,
        stdout: run.stdout,
        stderr: run.stderr,
        report,
        supervisorTimingJson: readState('supervisor-timing.json'),
        failuresJson: readState('failures.json'),
      };
    });
  } finally {
    proxy.stop();
    app.stop();
    cleanupWitnessedFixture();
  }
}

describe('supervisor stress e2e through the real CLI (plan 20261021_0030_gf_infra_visibility P4)', () => {
  it('holds the session machinery at 2 workers with 3 observe resources delayed 300 ms (all green, 0 infra, timing summary)', { timeout: 240_000 }, async () => {
    const titles = Array.from({ length: 8 }, (_entry, index) => `stress ${String(index + 1)} reads three resources`);
    const run = await runStressCase({
      titles,
      mappedTitles: titles.map((title) => ({ title, claims: READ_CLAIMS })),
      delays: { accounts: 300, orders: 300, invoices: 300 },
      workers: 2,
    });
    const evidence = `stdout:\n${run.stdout}\nstderr:\n${run.stderr}`;
    // Fully green gate: every observed claim satisfied, nothing blocking.
    expect(run.code, evidence).toBe(0);
    expect(run.report.summary?.blocking, evidence).toBe(0);
    expect(run.stderr, evidence).toContain('gateforge: run finished — 8 passed, 0 failed (0 infra, 0 test)');
    const satisfied = (run.report.verdicts ?? [])
      .filter((verdict) => verdict.verdict === 'satisfied')
      .map((verdict) => verdict.obligationId)
      .sort();
    expect(satisfied, evidence).toEqual([...READ_CLAIMS].sort());
    // The timing summary is present and healthy: every session open was
    // timed, and none came near its 5 s budget (so no warning printed).
    expect(run.supervisorTimingJson, evidence).not.toBeNull();
    const timing = JSON.parse(run.supervisorTimingJson as string) as SupervisorTimingDocument;
    expect(timing.schemaVersion, evidence).toBe(1);
    const open = timing.paths.find((entry) => entry.path === '/sessions/open');
    expect(open, evidence).toBeDefined();
    expect(open?.count, evidence).toBe(8);
    expect(open?.nearBudget, evidence).toBe(0);
    expect(open?.budgetMs, evidence).toBe(5000);
    expect(run.stderr, evidence).not.toMatch(/warning: \/sessions\/open/);
  });

  it('fails the over-budget test as infra and the same-worker follower still opens (plan P4 rework)', { timeout: 240_000 }, async () => {
    const slowTitle = 'slow adapter stalls the supervisor session';
    const followerTitle = 'next test on the same worker opens after the stall';
    const followerClaims = READ_CLAIMS.slice(1);
    const run = await runStressCase({
      titles: [slowTitle, followerTitle],
      // The slow resource is claimed by the over-budget test ONLY: its
      // snapshot round exceeds the 5 s budget, while the follower's own
      // claims snapshot fast (plan P4 rework: the follower runs on the
      // SAME worker, after the over-budget one — hence workers: 1).
      mappedTitles: [
        { title: slowTitle, claims: READ_CLAIMS.slice(0, 1) },
        { title: followerTitle, claims: followerClaims },
      ],
      delays: { accounts: 6_000, orders: 300, invoices: 300 },
      workers: 1,
    });
    const evidence = `stdout:\n${run.stdout}\nstderr:\n${run.stderr}`;
    // The affected test fails and counts as INFRA on the finish line —
    // never as a test failure — and the follower PASSES: the finish
    // line counts exactly one failed (infra) test and one passed.
    // Expectation updated by plan 20261021_0030_gf_infra_visibility P4
    // rework: the second test was added to prove the abandoned-open
    // recovery, so the line now also counts its pass.
    expect(run.code, evidence).not.toBe(0);
    expect(run.stderr, evidence).toContain('gateforge: run finished — 1 passed, 1 failed (1 infra, 0 test)');
    // The follower was never 409-refused by the abandoned over-budget
    // session and never lost its own session credential.
    expect(run.stderr, evidence).not.toContain('already carries an open session');
    expect(run.stderr, evidence).not.toContain(`No supervisor-issued witness session for ${followerTitle}`);
    // The failure record carries the stable infra marker and kind —
    // and belongs to the over-budget test ALONE: any follower failure
    // (409 orphan refusal, missing session) is the regression this
    // rework exists to prevent.
    expect(run.failuresJson, evidence).not.toBeNull();
    const failures = JSON.parse(run.failuresJson as string) as FailuresDocument;
    expect(failures.schemaVersion, evidence).toBe(2);
    expect(failures.failures, evidence).toHaveLength(1);
    expect(failures.failures[0]?.kind, evidence).toBe('infra');
    expect(failures.failures[0]?.message, evidence).toContain('[gateforge:infra]');
    expect(failures.failures[0]?.logicalKey, evidence).toContain(slowTitle);
    // The follower's own obligations are satisfied by its own session.
    const satisfied = (run.report.verdicts ?? [])
      .filter((verdict) => verdict.verdict === 'satisfied')
      .map((verdict) => verdict.obligationId)
      .sort();
    expect(satisfied, evidence).toEqual([...followerClaims].sort());
    // The near/over-budget warning names the path and its 5 s budget.
    expect(run.stderr, evidence).toMatch(
      /test-gates: warning: \/sessions\/open slowest \d+\.\d s of 5 s budget \(\d+ calls ≥ 80 %\)/,
    );
    // The timing summary counts exactly three opens: the over-budget
    // call (recorded at its full budget), the drain's idempotent
    // re-open recovery of it, and the follower's own open.
    expect(run.supervisorTimingJson, evidence).not.toBeNull();
    const timing = JSON.parse(run.supervisorTimingJson as string) as SupervisorTimingDocument;
    const open = timing.paths.find((entry) => entry.path === '/sessions/open');
    expect(open, evidence).toBeDefined();
    expect(open?.count, evidence).toBe(3);
    expect(open?.nearBudget, evidence).toBe(1);
    expect(open?.maxMs, evidence).toBeGreaterThanOrEqual(5_000);
  });
});
