/**
 * Twin path coverage end-to-end (E64): the reported bug was GREEN.
 *
 * A raw test and its witnessed twin shared a helper whose parameter
 * defaults sent them down different paths — the list call carried
 * `?tab=all` in one and `?tab=open` in the other — so "green three
 * times" proved nothing about the path the witnessed twin covered, and
 * nothing in the run said so.
 *
 * These runs are real: the real CLI, a spawned witness, a real
 * Chromium, and an app whose two pages share one helper. The catalog
 * enumerates the suite from the repository's own Playwright config
 * while the supervised run drives the engine's trusted one, so the ids
 * the two sides hold genuinely differ — a run that compared twins by
 * runner test id would compare nothing and report silence.
 */
import { spawn } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { withTempRepo, type TempRepo } from '@gate-forge/core';
import { startAttestationProxy, startWitnessProcess } from '@gate-forge/pack-playwright';
import { trustedPolicyDigestForConfig } from '../src/execution.js';
import { loadConfigAt, VERIFIER_KEY_FILE_ENV } from '../src/commands/common.js';
import { runCli } from './helpers.js';
import {
  cleanupWitnessedFixture,
  installStrictFixture,
  operatorEnvironment,
  ROOT,
  FINGERPRINT,
  SPEC as CRUD_SPEC,
} from './witnessed-run-fixture.js';

/** The witnessed twin: its page overrides the shared helper's default. */
const WITNESSED_TITLE = 'lists open items [witnessed]';
/** The raw twin the title convention links to it. */
const RAW_TITLE = 'lists open items raw';
/** The raw twin that takes the shared helper's default (`?tab=all`). */
const DIVERGENT_RAW_PATH = '/items#all';
/** The raw twin that passes the same tab the witnessed twin passes. */
const AGREEING_RAW_PATH = '/items#open';
/** A raw test whose title no convention links (a link that is missing). */
const UNLINKED_TITLE = 'lists open items fast';

/**
 * The fixture spec: the twins, with the titles the run is proving.
 *
 * The titles are LITERALS on purpose — they are what the catalog reads
 * to link the pair, and a title built from an environment variable is
 * not a title any enumeration can see.
 */
function twinSpec(witnessedTitle: string, rawTitle: string, rawPath: string, rawPlain = false, rawUnhooked = false): string {
  return `import { test as gateforgeTest, expect } from '@gate-forge/pack-playwright';
import { test as plainTest } from '${rawUnhooked ? '../node_modules/playwright/test.mjs' : 'playwright/test'}';

const test = gateforgeTest;
// Plain package imports are auto-session witnessed; a direct module path
// bypasses specifier interception and retains the uninstrumented case.
const rawTest = ${rawPlain || rawUnhooked ? 'plainTest' : 'gateforgeTest'};
const appBase = process.env.GATEFORGE_APP_BASE_URL;
const rawPath = '${rawPath}';

// The witnessed twin: its page overrides the shared helper's default, so
// its list call carries ?tab=open while the raw twin's carries ?tab=all.
test('${witnessedTitle}', async ({ page }) => {
  await page.goto(appBase + '/items#open');
  await page.waitForFunction(() => window.__loaded !== undefined);
  await expect(page.locator('#rows')).toContainText('open-row');
});

rawTest('${rawTitle}', async ({ page }) => {
  await page.goto(appBase + rawPath);
  await page.waitForFunction(() => window.__loaded !== undefined);
  await expect(page.locator('#rows')).toContainText('open-row');
});
`;
}

/** The fixture app process, once started. */
interface FixtureApp {
  /** Its loopback origin. */
  url: string;
  /** Stops the process. */
  stop: () => Promise<void>;
}

/** Starts the twin fixture app as a child; resolves its loopback origin. */
async function startTwinApp(): Promise<FixtureApp> {
  const child = spawn(process.execPath, [join(ROOT, 'packages/cli/test/fixtures/twin-app/server.mjs')], {
    cwd: ROOT,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  const url = await new Promise<string>((resolveUrl, rejectUrl) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      rejectUrl(new Error('the twin fixture app did not report its URL in time'));
    }, 15_000);
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
      const match = /listening on (http:\/\/\S+)/.exec(stdout);
      if (match !== null) {
        clearTimeout(timer);
        resolveUrl(match[1] as string);
      }
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      rejectUrl(new Error(`the twin fixture app exited early (code ${String(code)}): ${stdout}`));
    });
  });
  return {
    url,
    stop: async () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = once(child, 'exit');
      child.kill('SIGTERM');
      await exited;
    },
  };
}

/** The json report `test-gates --format json` printed. */
interface TwinReport {
  summary: { obligations: number; blocking: number };
  advisories?: Array<{ cause: string | null; detail: string }>;
  blocking?: Array<{ cause: string; detail: string }>;
  verdicts?: Array<{ obligationId: string; verdict: string; recordIds: string[] }>;
  execution?: { selectedTests?: { selected: number; passed: number; failed: number } };
  [key: string]: unknown;
}

/**
 * Parses a json run, failing with both streams when the CLI answered
 * with a diagnostic instead (a config error must never read as a
 * verdict).
 */
function parseReport(run: { stdout: string; stderr: string }): TwinReport {
  if (!run.stdout.trimStart().startsWith('{')) {
    throw new Error(`test-gates printed no report\nstdout:\n${run.stdout}\nstderr:\n${run.stderr}`);
  }
  return JSON.parse(run.stdout) as TwinReport;
}

/**
 * The part of a report that must NOT move when only the twin check is
 * switched on: run identities, digests and the witness-issued record ids
 * are fresh per invocation, everything else is the run's honest account
 * of what it observed. Record COUNTS are kept — only the opaque ids go.
 */
function stableReport(report: TwinReport): unknown {
  return {
    ...report,
    run: undefined,
    diagnosticContext: undefined,
    verdicts: report.verdicts?.map((verdict) => ({ ...verdict, recordIds: verdict.recordIds.length })),
    uiLedger: stableUiLedger(report['uiLedger'] as { rows: Array<{ testId: string; step: string }>; truncatedTestIds?: string[] } | undefined),
  };
}

/**
 * The UI ledger keyed by each test's step sequence instead of its runner
 * id: the unlinked run renames the raw twin, and Playwright derives the id
 * from the title, so only that id may differ — every test's steps may not.
 */
function stableUiLedger(ledger: { rows: Array<{ testId: string; step: string }>; truncatedTestIds?: string[] } | undefined): unknown {
  if (ledger === undefined) return undefined;
  const byTest = new Map<string, string[]>();
  for (const row of ledger.rows) byTest.set(row.testId, [...(byTest.get(row.testId) ?? []), row.step]);
  return { tests: [...byTest.values()].map((steps) => steps.join('\n')).sort(), truncated: ledger.truncatedTestIds?.length ?? 0 };
}

/** The state directory a run wrote (the fixture's, gitignored). */
function stateDir(repo: TempRepo): string {
  return repo.path('.gateforge/test-gates');
}

/**
 * Every file below a directory as `dir-relative name`, sorted, with the
 * lifecycle spool's per-run UUID directories folded to their fixed name:
 * that directory is named by a fresh id on every run, so a byte-identical
 * comparison must not read it as a difference.
 */
function filesUnder(directory: string, prefix = ''): string[] {
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      return entry.isDirectory() ? filesUnder(join(directory, entry.name), relative) : [relative];
    })
    .sort();
}

/**
 * The same listing with the lifecycle spool's per-run UUID directories
 * folded to one name: each run names its own, so a byte-identical
 * comparison must not read that id as a difference.
 */
function foldedStateFiles(names: readonly string[]): string[] {
  return [...new Set(names.map((name) => name.replace(/spool\/[0-9a-f-]{36}\//, 'spool/<run>/')))].sort();
}

/** The recorded twin shapes a run left behind. */
interface TwinShapesDocument {
  twins: Array<{
    logicalKey: string;
    observationOnly: boolean;
    shapes: Array<{ method: string; route: string; query?: Record<string, string> }>;
  }>;
}

/** What one run of the fixture repository needs to be shaped a certain way. */
interface RunShape {
  /** The `enforcement` block, or null to configure none at all. */
  enforcement: string | null;
  /** The page the raw twin opens. */
  rawPath: string;
  /** The raw twin's own title. */
  rawTitle: string;
  /** The witnessed twin's own title. */
  witnessedTitle: string;
  /** Whether the raw twin uses a plain package import (auto-session witnessed). */
  rawPlain?: boolean;
  /** Whether the raw twin bypasses interception with a direct module path. */
  rawUnhooked?: boolean;
}

/** `advisory` twin coverage: the reported finding, exit code untouched. */
const ADVISORY_COVERAGE = '  twinPaths: advisory\n  twinQueryKeys: [tab]';
/** The same coverage, made blocking. */
const BLOCKING_COVERAGE = '  twinPaths: block\n  twinQueryKeys: [tab]';

/** The fixture config, with the run's own enforcement block appended. */
function configYaml(enforcement: string | null): string {
  return `schemaVersion: 1
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
scan:
  scanRoots: ['src/**']
  declarations:
    internality: gateforge:internal
  volatileFields: []
changed: { provider: auto }
witness: { maxDurationSeconds: 5 }
clock: { mode: fixed, fixedAt: '2026-01-01T00:00:00.000Z' }
${enforcement === null ? '' : `enforcement:\n${enforcement}\n`}`;
}

/**
 * Installs the fixture repository with the twins' titles, and commits
 * the tree so the change under test is a real one.
 */
function installRepo(repo: TempRepo, shape: RunShape): void {
  installStrictFixture(repo, {
    'specs/crud.spec.js': CRUD_SPEC,
    'specs/items.spec.js': twinSpec(shape.witnessedTitle, shape.rawTitle, shape.rawPath, shape.rawPlain, shape.rawUnhooked),
  });
  repo.git(['add', '-A']);
  repo.git(['commit', '--no-gpg-sign', '--quiet', '-m', 'twin path fixture']);
  // The change under test: one comment line in the resource source, so
  // the scoped provider has something real to report.
  repo.writeFiles({ 'src/accounts.js': '// fixture source: the accounts resource lives here.\n// change: audited.\n' });
}

/**
 * Re-shapes an ALREADY installed repository for another run in it: the
 * config's enforcement block and the twins' own titles are the two
 * things a case changes, and both are inputs of the run.
 */
function reshapeRepo(repo: TempRepo, shape: RunShape): void {
  repo.writeFiles({
    '.gateforge.yml': configYaml(shape.enforcement),
    'specs/items.spec.js': twinSpec(shape.witnessedTitle, shape.rawTitle, shape.rawPath, shape.rawPlain, shape.rawUnhooked),
  });
}

/** Runs the whole fixture suite once, in the shape the case asks for. */
async function runFixture(
  repo: TempRepo,
  appUrl: string,
  shape: RunShape,
): Promise<{ code: number; stdout: string; stderr: string }> {
  reshapeRepo(repo, shape);
  const { keyFile, env } = operatorEnvironment();
  try {
    return await runCli(repo, ['test-gates', '--changed', '--format', 'json'], {
      ...env,
      GATEFORGE_APP_BASE_URL: appUrl,
      GATEFORGE_TARGET_BASE_URL: appUrl,
      GATEFORGE_TARGET_FINGERPRINT: FINGERPRINT,
      GATEFORGE_APPROVED_POLICY_DIGEST: trustedPolicyDigestForConfig(repo.root, loadConfigAt(repo.root)),
    });
  } finally {
    rmSync(join(keyFile, '..'), { recursive: true, force: true });
  }
}

/** Every TWIN_PATH_DIVERGENT entry a report carries, from either surface. */
function divergences(report: TwinReport): Array<{ cause: string | null; detail: string }> {
  return [...(report.advisories ?? []), ...(report.blocking ?? [])].filter(
    (entry) => entry.cause === 'TWIN_PATH_DIVERGENT',
  );
}

/** The divergent shape every case that must FIND a divergence runs in. */
const DIVERGENT: RunShape = {
  enforcement: ADVISORY_COVERAGE,
  rawPath: DIVERGENT_RAW_PATH,
  rawTitle: RAW_TITLE,
  witnessedTitle: WITNESSED_TITLE,
};

describe('twin path coverage (E64): a green run that covered a different path', () => {
  it('names the exact differing query value and both tests, and marks the raw twin observation-only', async () => {
    await withTempRepo({}, async (repo) => {
      installRepo(repo, DIVERGENT);
      const app = await startTwinApp();
      const proxy = await startAttestationProxy(app.url, FINGERPRINT);
      try {
        const run = await runFixture(repo, proxy.url, DIVERGENT);
        const report = parseReport(run);
        expect(run.code, `the run must stay green\nstdout:\n${run.stdout}\nstderr:\n${run.stderr}`).toBe(0);
        const details = divergences(report).map((entry) => entry.detail);
        // The finding names BOTH tests and the exact differing value:
        // the raw twin asked for every tab, the witnessed twin only the
        // open ones, and neither side's assertion ever noticed.
        // One finding per side, and together they name BOTH values.
        expect(details.some((detail) => detail.includes('tab=open')), JSON.stringify(details)).toBe(true);
        expect(details.some((detail) => detail.includes('tab=all')), JSON.stringify(details)).toBe(true);
        expect(details.every((detail) => !detail.includes('nonce')), JSON.stringify(details)).toBe(true);
        expect(details.some((detail) => detail.includes(WITNESSED_TITLE)), JSON.stringify(details)).toBe(true);
        expect(details.some((detail) => detail.includes(RAW_TITLE)), JSON.stringify(details)).toBe(true);
        // Advisory mode reports it and leaves the verdict alone.
        expect(report.blocking ?? [], JSON.stringify(report.blocking)).toEqual([]);
        expect(report.summary.blocking).toBe(0);
        // The recorded shapes are the run's own account of the two sides,
        // and only the raw twin is observation-only.
        const shapes = JSON.parse(readFileSync(join(stateDir(repo), 'twin-shapes.json'), 'utf8')) as TwinShapesDocument;
        const raw = shapes.twins.find((twin) => twin.logicalKey.endsWith(RAW_TITLE));
        const witnessed = shapes.twins.find((twin) => twin.logicalKey.endsWith(WITNESSED_TITLE));
        expect(raw?.observationOnly, JSON.stringify(shapes)).toBe(true);
        expect(witnessed?.observationOnly, JSON.stringify(shapes)).toBe(false);
        // The list call each side actually made: a method, a route
        // template and the one allowlisted value that differs. The page
        // navigations are recorded too — a navigation is a request.
        expect(raw?.shapes, JSON.stringify(shapes)).toContainEqual({
          method: 'GET',
          route: '/api/items',
          query: { tab: 'all' },
        });
        expect(witnessed?.shapes, JSON.stringify(shapes)).toContainEqual({
          method: 'GET',
          route: '/api/items',
          query: { tab: 'open' },
        });
      } finally {
        await proxy.stop();
        await app.stop();
      }
    });
  }, 600_000);

  it('finds nothing when the twins exercised the same path', async () => {
    await withTempRepo({}, async (repo) => {
      installRepo(repo, DIVERGENT);
      const app = await startTwinApp();
      const proxy = await startAttestationProxy(app.url, FINGERPRINT);
      try {
        const run = await runFixture(repo, proxy.url, {
          ...DIVERGENT,
          rawPath: AGREEING_RAW_PATH,
        });
        const report = parseReport(run);
        expect(run.code, `the run must stay green\nstdout:\n${run.stdout}\nstderr:\n${run.stderr}`).toBe(0);
        expect(divergences(report), JSON.stringify(report.advisories ?? [])).toEqual([]);
        // The comparison really happened: both sides were observed and
        // their shapes recorded, they simply agree.
        const shapes = JSON.parse(readFileSync(join(stateDir(repo), 'twin-shapes.json'), 'utf8')) as TwinShapesDocument;
        expect(shapes.twins.length, JSON.stringify(shapes)).toBeGreaterThan(1);
        expect(shapes.twins.filter((twin) => twin.shapes.length > 0).length, JSON.stringify(shapes)).toBeGreaterThan(1);
      } finally {
        await proxy.stop();
        await app.stop();
      }
    });
  }, 600_000);

  it('compares a plain-import raw twin and finds its divergent path', async () => {
    const plain: RunShape = { ...DIVERGENT, rawPlain: true };
    await withTempRepo({}, async (repo) => {
      installRepo(repo, plain);
      const app = await startTwinApp();
      const proxy = await startAttestationProxy(app.url, FINGERPRINT);
      try {
        const run = await runFixture(repo, proxy.url, plain);
        const report = parseReport(run);
        expect(run.code, `${run.stdout}\n${run.stderr}`).toBe(0);
        expect(divergences(report)).toHaveLength(2);
        expect(run.stderr).not.toContain('twin pair not compared');
        const shapes = JSON.parse(readFileSync(join(stateDir(repo), 'twin-shapes.json'), 'utf8')) as TwinShapesDocument;
        expect(shapes.twins.find((twin) => twin.logicalKey.endsWith(`:${RAW_TITLE}`))).toMatchObject({
          observationOnly: true,
          shapes: expect.arrayContaining([{ method: 'GET', route: '/api/items', query: { tab: 'all' } }]),
        });
      } finally {
        await proxy.stop();
        await app.stop();
      }
    });
  }, 600_000);

  it('says a pair was not compared when its raw twin bypasses auto-session interception', async () => {
    const plain: RunShape = { ...DIVERGENT, rawUnhooked: true };
    await withTempRepo({}, async (repo) => {
      installRepo(repo, plain);
      const app = await startTwinApp();
      const proxy = await startAttestationProxy(app.url, FINGERPRINT);
      try {
        const run = await runFixture(repo, proxy.url, plain);
        const report = parseReport(run);
        expect(run.code, `the run must stay green\nstdout:\n${run.stdout}\nstderr:\n${run.stderr}`).toBe(0);
        // No finding, because nothing was compared — and the run says so
        // instead of letting "no divergence" read as "the twins agree".
        expect(divergences(report)).toEqual([]);
        expect(run.stderr).toContain(
          `test-gates: twin pair not compared: the raw test 'playwright:chromium:specs/items.spec.js:${RAW_TITLE}' sent no request through the witness`,
        );
        expect(run.stderr).toContain('use a supported Playwright test import');
        const shapes = JSON.parse(readFileSync(join(stateDir(repo), 'twin-shapes.json'), 'utf8')) as TwinShapesDocument;
        expect(shapes.twins.some((twin) => twin.logicalKey.endsWith(`:${RAW_TITLE}`))).toBe(false);
        expect(shapes.twins.some((twin) => twin.logicalKey.endsWith(`:${WITNESSED_TITLE}`) && twin.shapes.length > 0)).toBe(true);
      } finally {
        await proxy.stop();
        await app.stop();
      }
    });
  }, 600_000);

  it('is byte-identical with the option off and with no twin linked', async () => {
    await withTempRepo({}, async (repo) => {
      installRepo(repo, DIVERGENT);
      let app = await startTwinApp();
      let proxy = await startAttestationProxy(app.url, FINGERPRINT);
      try {
        // (1) the option is not configured at all.
        const off = await runFixture(repo, proxy.url, { ...DIVERGENT, enforcement: null });
        const offReport = parseReport(off);
        const offFiles = filesUnder(stateDir(repo));
        // Reset the stateful fixture app so both runs observe identical app
        // state; the ledger faithfully retains document paths it sees.
        proxy.stop();
        await app.stop();
        app = await startTwinApp();
        proxy = await startAttestationProxy(app.url, FINGERPRINT);
        const unlinked = await runFixture(repo, proxy.url, { ...DIVERGENT, rawTitle: UNLINKED_TITLE });
        const unlinkedReport = parseReport(unlinked);
        const unlinkedFiles = filesUnder(stateDir(repo));

        expect(off.code, off.stderr).toBe(0);
        expect(unlinked.code, unlinked.stderr).toBe(0);
        expect(divergences(unlinkedReport), JSON.stringify(unlinkedReport.advisories ?? [])).toEqual([]);
        expect(stableReport(unlinkedReport)).toEqual(stableReport(offReport));
        expect(foldedStateFiles(unlinkedFiles)).toEqual(foldedStateFiles(offFiles));
        expect(offFiles.filter((name) => name.startsWith('twin-'))).toEqual([]);
        expect(unlinkedFiles.filter((name) => name.startsWith('twin-'))).toEqual([]);
        expect(offReport.advisories ?? []).toEqual([]);
        expect(unlinkedReport.advisories ?? []).toEqual([]);
      } finally {
        proxy.stop();
        await app.stop();
      }
    });
  }, 900_000);

  it('blocks the run when the owner asked twin divergence to be blocking', async () => {
    await withTempRepo({}, async (repo) => {
      installRepo(repo, DIVERGENT);
      const app = await startTwinApp();
      const proxy = await startAttestationProxy(app.url, FINGERPRINT);
      try {
        const run = await runFixture(repo, proxy.url, { ...DIVERGENT, enforcement: BLOCKING_COVERAGE });
        const report = parseReport(run);
        expect(run.code, `a blocking twin divergence must fail the run\nstdout:\n${run.stdout}`).toBe(1);
        expect(divergences(report), JSON.stringify(report.blocking)).not.toEqual([]);
        expect(
          report.advisories?.every(
            (entry) => entry.cause === null && entry.detail.includes('HTTP_ROUTE_NOT_INVENTORIED'),
          ),
        ).toBe(true);
        // The tests themselves still passed: what failed is the claim
        // that they covered the same path.
        expect(report.execution?.selectedTests?.failed, run.stderr).toBe(0);
      } finally {
        await proxy.stop();
        await app.stop();
      }
    });
  }, 600_000);

  it('keeps a runtime query value the owner never allowlisted out of the report and the whole state dir', async () => {
    await withTempRepo({}, async (repo) => {
      installRepo(repo, DIVERGENT);
      const app = await startTwinApp();
      const proxy = await startAttestationProxy(app.url, FINGERPRINT);
      try {
        // The run finds the divergence (`tab` is allowlisted) while the
        // page's runtime `nonce` — never allowlisted — goes nowhere.
        const run = await runFixture(repo, proxy.url, DIVERGENT);
        const report = parseReport(run);
        expect(run.code, `the run must stay green\nstdout:\n${run.stdout}\nstderr:\n${run.stderr}`).toBe(0);
        const details = divergences(report).map((entry) => entry.detail);
        expect(details.some((detail) => detail.includes('tab=open')), JSON.stringify(details)).toBe(true);
        expect(details.every((detail) => !detail.includes('nonce')), JSON.stringify(details)).toBe(true);
        // The value the app actually served, asked of the app itself so
        // the expectation is not a guess.
        const nonce = (await (await fetch(`${app.url}/__nonce`)).json()) as { nonce: string };
        expect(nonce.nonce.length).toBeGreaterThan(3);
        const stateText = filesUnder(stateDir(repo))
          .map((name) => readFileSync(join(stateDir(repo), name), 'utf8'))
          .join('\n');
        expect(run.stdout, 'the report must not name a value the owner never allowlisted').not.toContain(nonce.nonce);
        expect(stateText, 'no state file may name a value the owner never allowlisted').not.toContain(nonce.nonce);
      } finally {
        await proxy.stop();
        await app.stop();
      }
    });
  }, 600_000);

  it('compares the twins through a witness the repository started itself', async () => {
    await withTempRepo({}, async (repo) => {
      installRepo(repo, DIVERGENT);
      const app = await startTwinApp();
      const proxy = await startAttestationProxy(app.url, FINGERPRINT);
      // The classifications a repository's own witness reads: the file
      // one real run produced.
      const bootstrap = await runFixture(repo, proxy.url, { ...DIVERGENT, enforcement: null });
      expect(bootstrap.code, `bootstrap stdout:\n${bootstrap.stdout}\nstderr:\n${bootstrap.stderr}`).toBe(0);
      const externalDir = mkdtempSync(join(tmpdir(), 'gateforge-external-twins-'));
      const token = randomUUID();
      copyFileSync(join(stateDir(repo), 'classifications.json'), join(externalDir, 'classifications.json'));
      const { keyFile } = operatorEnvironment();
      const keyring = JSON.parse(readFileSync(keyFile, 'utf8')) as { activeKeyId: string; keys: Record<string, string> };
      const witness = await startWitnessProcess({
        GATEFORGE_RUN_ID: randomUUID(),
        GATEFORGE_RUN_TOKEN: token,
        GATEFORGE_STATE_DIR: externalDir,
        GATEFORGE_CLASSIFICATIONS: join(externalDir, 'classifications.json'),
        GATEFORGE_ADAPTERS_DIR: join(repo.root, '.gateforge/adapters'),
        GATEFORGE_TARGET_BASE_URL: proxy.url,
        GATEFORGE_ADAPTER_BASE_URL: proxy.url,
        GATEFORGE_TARGET_FINGERPRINT: FINGERPRINT,
        GATEFORGE_PROXY_TARGET: proxy.url,
        GATEFORGE_WITNESS_VERIFIER_KEY: keyring.keys[keyring.activeKeyId] as string,
      });
      try {
        expect(witness.proxyUrl, 'the external witness started no observation proxy').not.toBeNull();
        reshapeRepo(repo, DIVERGENT);
        // NOTHING is configured on the witness side: the shape plan
        // travels with the run context, so a repository's own witness
        // needs no twin environment at all.
        const run = await runCli(repo, ['test-gates', '--changed', '--format', 'json', '--witness-url', witness.url, '--out', externalDir, '--run-token', token], {
          [VERIFIER_KEY_FILE_ENV]: keyFile,
          GATEFORGE_APP_BASE_URL: witness.proxyUrl as string,
          GATEFORGE_TARGET_BASE_URL: witness.proxyUrl as string,
          GATEFORGE_TARGET_FINGERPRINT: FINGERPRINT,
          GATEFORGE_APPROVED_POLICY_DIGEST: trustedPolicyDigestForConfig(repo.root, loadConfigAt(repo.root)),
        });
        const report = parseReport(run);
        expect(run.code, `the run must stay green\nstdout:\n${run.stdout}\nstderr:\n${run.stderr}`).toBe(0);
        expect(run.stderr, 'a witness that accepted the options says nothing').not.toContain('pairs were not compared');
        const details = divergences(report).map((entry) => entry.detail);
        expect(details.some((detail) => detail.includes('tab=open')), JSON.stringify(details)).toBe(true);
        expect(details.some((detail) => detail.includes('tab=all')), JSON.stringify(details)).toBe(true);
        expect(details.some((detail) => detail.includes(WITNESSED_TITLE)), JSON.stringify(details)).toBe(true);
        expect(details.some((detail) => detail.includes(RAW_TITLE)), JSON.stringify(details)).toBe(true);
        const shapes = JSON.parse(readFileSync(join(externalDir, 'twin-shapes.json'), 'utf8')) as TwinShapesDocument;
        expect(shapes.twins.length, JSON.stringify(shapes)).toBeGreaterThan(0);
      } finally {
        if (witness.child.exitCode === null && witness.child.signalCode === null) {
          witness.child.kill('SIGTERM');
          await once(witness.child, 'exit');
        }
        rmSync(externalDir, { recursive: true, force: true });
        rmSync(join(keyFile, '..'), { recursive: true, force: true });
        await proxy.stop();
        await app.stop();
      }
    });
  }, 600_000);
});
