/**
 * Timing chaos end-to-end (E63): the reported bug — an older list
 * response landing after a newer one, so the UI shows the wrong tab's
 * rows — reproduced ON PURPOSE through the real CLI and the real
 * witness, and reproduced AGAIN with the same seed.
 *
 * Everything here is real: a temp Git fixture repository, the fixture
 * app (the example accounts UI plus a racy and a race-free tab page),
 * the attestation proxy, the witness the CLI spawns itself, the pinned
 * Playwright, and the engine Chromium. The racy page is the bug; the
 * twin page is the same requests with the stale answer dropped, and it
 * must stay green under any timing the proxy can produce.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { withTempRepo, type TempRepo } from '@gate-forge/core';
import { startAttestationProxy } from '@gate-forge/pack-playwright';
import { trustedPolicyDigestForConfig } from '../src/execution.js';
import { loadConfigAt, VERIFIER_KEY_FILE_ENV } from '../src/commands/common.js';
import { runCli } from './helpers.js';
import { cleanupWitnessedFixture, installStrictFixture, operatorEnvironment, ROOT, FINGERPRINT } from './witnessed-run-fixture.js';

/**
 * The pinned seed. Its schedule is what makes the red run replayable:
 * the same integer reproduces the same delays, so the failure below is
 * a finding the owner can reproduce instead of a ghost.
 */
const SEED = 11;

/** The racy page's test: the stale-response bug, on purpose. */
const RACY_KEY = 'playwright:chromium:specs/tabs.spec.js:tab B rows win the list';
/** The twin page's test: the same requests, no stale answer. */
const TWIN_KEY =
  'playwright:chromium:specs/tabs.spec.js:tab B rows win the list without a stale response';
/** The evidenced journey: the run's witness records live here. */
const CREATE_KEY = 'playwright:chromium:specs/tabs.spec.js:creates an account through the rendered UI';

const keyDirectories: string[] = [];

/** The fixture spec: the witnessed CRUD journey plus the two tab pages. */
const SPEC = `import { test as gateforgeTest, expect } from '@gate-forge/pack-playwright';
import { accountsSurface } from './accounts-surface.js';

const test = gateforgeTest.extend({ surface: accountsSurface });
const appBase = process.env.GATEFORGE_APP_BASE_URL;

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

// The racy page renders whichever list response lands LAST. On a fast
// network the newer request wins, so this is green; the moment the older
// request is slower, the wrong tab's rows are on screen.
test('tab B rows win the list', async ({ page }) => {
  await page.goto(appBase + '/race');
  await page.locator('#tab-a').click();
  await page.locator('#tab-b').click();
  await expect(page.locator('#rows')).toContainText('beta-row');
});

// The twin: the same two requests against a page that renders by
// request id. No timing may ever turn this red.
test('tab B rows win the list without a stale response', async ({ page }) => {
  await page.goto(appBase + '/twin');
  await page.locator('#tab-a').click();
  await page.locator('#tab-b').click();
  await expect(page.locator('#rows')).toContainText('beta-row');
});
`;

/** The fixture app process, once started. */
interface FixtureApp {
  /** Its loopback origin. */
  url: string;
  /** Stops the process. */
  stop: () => void;
}

/** Starts the timing-chaos fixture app as a child; resolves its origin. */
async function startRaceApp(): Promise<FixtureApp> {
  const child = spawn(process.execPath, [join(ROOT, 'packages/cli/test/fixtures/race-app/server.mjs')], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  const url = await new Promise<string>((resolveUrl, rejectUrl) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      rejectUrl(new Error('the race fixture app did not report its URL in time'));
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
      rejectUrl(new Error(`the race fixture app exited early (code ${String(code)}): ${stdout}`));
    });
  });
  return { url, stop: () => child.kill('SIGTERM') };
}

/** The json report `test-gates --format json` printed. */
interface ChaosReport {
  summary: { obligations: number; blocking: number };
  verdicts: Array<{ obligationId: string; verdict: string; recordIds: string[] }>;
  execution?: { selectedTests?: { selected: number; passed: number; failed: number } };
  outcome?: string;
  chaos?: { seed: number; maxDelayMs: number; reorder: boolean; schedule?: ChaosEntry[] };
  [key: string]: unknown;
}

/** One recorded chaos release decision, as the report carries it. */
interface ChaosEntry {
  routeKey: string;
  k: number;
  delayMs: number;
  releasedBefore: boolean;
}

/** The execution result a run sealed (or, for a chaos run, would explain). */
interface ExecutionDocument {
  chaos?: { seed: number; maxDelayMs: number; reorder: boolean; schedule: ChaosEntry[] };
  [key: string]: unknown;
}

/**
 * Parses a json run, failing with both streams when the CLI answered
 * with a diagnostic instead (a config error must never read as a
 * verdict).
 */
function parseReport(run: { stdout: string; stderr: string }): ChaosReport {
  if (!run.stdout.trimStart().startsWith('{')) {
    throw new Error(`test-gates printed no report\nstdout:\n${run.stdout}\nstderr:\n${run.stderr}`);
  }
  return JSON.parse(run.stdout) as ChaosReport;
}

/**
 * The part of a report that must NOT move when only the timing does:
 * run identities, digests and the witness-issued record ids are fresh
 * per invocation, everything else is the run's honest account of what
 * it observed. Record COUNTS are kept — only the opaque ids go.
 */
function stableReport(report: ChaosReport): unknown {
  return {
    ...report,
    run: undefined,
    diagnosticContext: undefined,
    verdicts: report.verdicts.map((verdict) => ({ ...verdict, recordIds: verdict.recordIds.length })),
    execution: report.execution === undefined ? undefined : { ...report.execution },
  };
}

/** The operator environment a witnessed run needs, per temp repo. */
function operatorEnv(appUrl: string): { keyFile: string; env: Record<string, string> } {
  const { keyFile, env } = operatorEnvironment();
  return {
    keyFile,
    env: {
      ...env,
      GATEFORGE_APP_BASE_URL: appUrl,
      GATEFORGE_TARGET_BASE_URL: appUrl,
      GATEFORGE_TARGET_FINGERPRINT: FINGERPRINT,
    },
  };
}

/** Installs the fixture repository (Git-clean, one committed tree). */
function installRepo(repo: TempRepo): void {
  installStrictFixture(repo, { 'specs/tabs.spec.js': SPEC });
  repo.git(['add', '-A']);
  repo.git(['commit', '--no-gpg-sign', '--quiet', '-m', 'timing chaos fixture']);
  // The change under test: one comment line in the resource source, so
  // the scoped provider has something real to report.
  repo.writeFiles({ 'src/accounts.js': '// fixture source: the accounts resource lives here.\n// change: audited.\n' });
}

/** The owner-approved policy pin, computed outside the candidate flow. */
function approvedPin(repo: TempRepo): string {
  return trustedPolicyDigestForConfig(repo.root, loadConfigAt(repo.root));
}

afterEach(() => {
  for (const directory of keyDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
  cleanupWitnessedFixture();
});

describe('timing chaos (E63): a stale-response race, on purpose', () => {
  it('a normal run is green and its report carries no chaos label at all', async () => {
    await withTempRepo({}, async (repo) => {
      installRepo(repo);
      const app = await startRaceApp();
      const proxy = await startAttestationProxy(app.url, FINGERPRINT);
      try {
        const { keyFile, env } = operatorEnv(proxy.url);
        const run = await runCli(repo, ['test-gates', '--test', RACY_KEY, '--result-only', '--format', 'json'], {
          ...env,
          GATEFORGE_APPROVED_POLICY_DIGEST: approvedPin(repo),
        });
        const report = parseReport(run);
        expect(
          run.code,
          `the racy page must pass in a normal run\nstdout:\n${run.stdout}\nstderr:\n${run.stderr}`,
        ).toBe(0);
        expect(report.execution?.selectedTests?.passed, run.stderr).toBe(1);
        // Without the flag there is no chaos label anywhere: a normal
        // run's document keeps exactly the keys it always had.
        expect(Object.keys(report)).not.toContain('chaos');
        expect(JSON.stringify(report)).not.toContain('timing chaos');
        // And a normal run seals nothing (a named run never does).
        expect(existsSync(repo.path('.gateforge/test-gates/receipt.json'))).toBe(false);
      } finally {
        await proxy.stop();
        app.stop();
      }
    });
  }, 300_000);

  it('fails the racy page under a fixed seed and replays the identical schedule', async () => {
    await withTempRepo({}, async (repo) => {
      installRepo(repo);
      const app = await startRaceApp();
      const proxy = await startAttestationProxy(app.url, FINGERPRINT);
      try {
        const { keyFile, env } = operatorEnv(proxy.url);
        const runEnv = { ...env, GATEFORGE_APPROVED_POLICY_DIGEST: approvedPin(repo) };
        const first = await runCli(
          repo,
          ['test-gates', '--test', RACY_KEY, '--result-only', '--chaos', String(SEED), '--format', 'json'],
          runEnv,
        );
        const firstReport = parseReport(first);
        expect(
          first.code,
          `the seeded run must surface the race\nstdout:\n${first.stdout}\nstderr:\n${first.stderr}`,
        ).toBe(1);
        expect(firstReport.chaos?.seed, first.stderr).toBe(SEED);
        expect(firstReport.chaos?.reorder, first.stderr).toBe(true);
        // The failure is the page's own assertion: the stale response
        // won and the wrong tab's rows are on screen.
        const text = await runCli(repo, ['test-gates', '--test', RACY_KEY, '--result-only', '--chaos', String(SEED)], runEnv);
        expect(text.stdout, text.stderr).toContain(`timing chaos: seed ${String(SEED)} (max delay 400 ms, reorder on)`);
        expect(text.stdout).toContain('replay with --chaos ' + String(SEED));
        expect(first.stderr, 'the run must name the assertion the racy page failed').toContain('beta-row');
        expect(first.stderr).toContain('alpha-row');
        // The schedule explains the failure and never carries a secret.
        const schedule = firstReport.chaos?.schedule ?? [];
        const tabEntries = schedule.filter((entry) => entry.routeKey === 'GET /api/tab');
        expect(tabEntries.length, JSON.stringify(schedule)).toBeGreaterThanOrEqual(2);
        expect(tabEntries[0]?.k).toBe(1);
        expect(tabEntries[1]?.k).toBe(2);
        expect(tabEntries[1]?.releasedBefore, JSON.stringify(tabEntries)).toBe(true);
        expect(JSON.stringify(schedule)).not.toContain('tab=');

        // Replay: the SAME seed runs the SAME schedule and fails the
        // same way. A finding nobody can reproduce is a ghost.
        const second = await runCli(
          repo,
          ['test-gates', '--test', RACY_KEY, '--result-only', '--chaos', String(SEED), '--format', 'json'],
          runEnv,
        );
        const secondReport = parseReport(second);
        expect(second.code, `replay stdout:\n${second.stdout}\nstderr:\n${second.stderr}`).toBe(1);
        expect(secondReport.chaos?.schedule).toEqual(schedule);
        expect(stableReport(secondReport)).toEqual(stableReport(firstReport));
        expect(existsSync(repo.path('.gateforge/test-gates/receipt.json'))).toBe(false);
        expect(keyFile).not.toBe('');
      } finally {
        await proxy.stop();
        app.stop();
      }
    });
  }, 600_000);

  it('leaves the race-free twin green under the same seed', async () => {
    await withTempRepo({}, async (repo) => {
      installRepo(repo);
      const app = await startRaceApp();
      const proxy = await startAttestationProxy(app.url, FINGERPRINT);
      try {
        const { env } = operatorEnv(proxy.url);
        const run = await runCli(
          repo,
          ['test-gates', '--test', TWIN_KEY, '--result-only', '--chaos', String(SEED), '--format', 'json'],
          { ...env, GATEFORGE_APPROVED_POLICY_DIGEST: approvedPin(repo) },
        );
        const report = parseReport(run);
        expect(
          run.code,
          `the race-free twin must stay green under seed ${String(SEED)}\nstdout:\n${run.stdout}\nstderr:\n${run.stderr}`,
        ).toBe(0);
        expect(report.chaos?.seed).toBe(SEED);
        // The same seed really did perturb the twin's traffic — it is
        // the page, not the timing, that made the difference.
        expect((report.chaos?.schedule ?? []).length, JSON.stringify(report.chaos?.schedule)).toBeGreaterThan(0);
      } finally {
        await proxy.stop();
        app.stop();
      }
    });
  }, 300_000);

  it('changes only the timing: the witnessed evidence is identical', async () => {
    await withTempRepo({}, async (repo) => {
      installRepo(repo);
      const app = await startRaceApp();
      const proxy = await startAttestationProxy(app.url, FINGERPRINT);
      try {
        const { env } = operatorEnv(proxy.url);
        const runEnv = { ...env, GATEFORGE_APPROVED_POLICY_DIGEST: approvedPin(repo) };
        const normal = await runCli(repo, ['test-gates', '--test', CREATE_KEY, '--result-only', '--format', 'json'], runEnv);
        const normalReport = parseReport(normal);
        expect(normal.code, `normal stdout:\n${normal.stdout}\nstderr:\n${normal.stderr}`).toBe(0);
        const chaosRun = await runCli(
          repo,
          ['test-gates', '--test', CREATE_KEY, '--result-only', '--chaos', String(SEED), '--format', 'json'],
          runEnv,
        );
        const chaosReport = parseReport(chaosRun);
        expect(chaosRun.code, `chaos stdout:\n${chaosRun.stdout}\nstderr:\n${chaosRun.stderr}`).toBe(0);

        // The graded evidence is the same run's evidence: the same
        // obligations, the same verdicts, the same number of
        // witness-issued records. Only the timing label is new.
        const verdicts = (report: ChaosReport): Array<{ obligationId: string; verdict: string; records: number }> =>
          report.verdicts
            .filter((verdict) => verdict.obligationId.startsWith('tenant.accounts:'))
            .map((verdict) => ({
              obligationId: verdict.obligationId,
              verdict: verdict.verdict,
              records: verdict.recordIds.length,
            }));
        expect(verdicts(chaosReport)).toEqual(verdicts(normalReport));
        expect(verdicts(normalReport).length, JSON.stringify(verdicts(normalReport))).toBeGreaterThan(0);
        const { chaos: _dropped, ...withoutChaos } = chaosReport;
        expect(stableReport(withoutChaos as ChaosReport)).toEqual(stableReport(normalReport));
      } finally {
        await proxy.stop();
        app.stop();
      }
    });
  }, 600_000);

  it('refuses --chaos without --result-only and any seed that is not an integer', async () => {
    await withTempRepo({}, async (repo) => {
      installRepo(repo);
      const { env } = operatorEnv('http://unused.invalid');
      const noResultOnly = await runCli(repo, ['test-gates', '--changed', '--chaos', String(SEED)], env);
      expect(noResultOnly.code, noResultOnly.stderr).toBe(2);
      expect(noResultOnly.stderr.trim().split('\n')).toHaveLength(1);
      expect(noResultOnly.stderr).toContain('--chaos requires --result-only');
      for (const seed of ['abc', '-1', '1.5', '']) {
        const bad = await runCli(repo, ['test-gates', '--test', RACY_KEY, '--result-only', '--chaos', seed], env);
        expect(bad.code, `--chaos '${seed}' stdout:\n${bad.stdout}\nstderr:\n${bad.stderr}`).toBe(2);
        expect(bad.stderr.trim().split('\n'), `--chaos '${seed}' printed more than one line`).toHaveLength(1);
        expect(bad.stderr).toContain('non-negative integer seed');
      }
      // A usage error costs seconds: no witness, no receipt, no report.
      expect(existsSync(repo.path('.gateforge/test-gates/receipt.json'))).toBe(false);
    });
  }, 120_000);

  it('labels a chaos run in the sealed execution result and never in a normal one', async () => {
    await withTempRepo({}, async (repo) => {
      installRepo(repo);
      const app = await startRaceApp();
      const proxy = await startAttestationProxy(app.url, FINGERPRINT);
      try {
        const { env } = operatorEnv(proxy.url);
        // The authoritative run (no --chaos) seals into the repo's own
        // state directory, which is where its execution result lands.
        const authoritative = await runCli(repo, ['test-gates', '--changed', '--format', 'json'], {
          ...env,
          GATEFORGE_APPROVED_POLICY_DIGEST: approvedPin(repo),
        });
        expect(
          authoritative.code,
          `authoritative stdout:\n${authoritative.stdout}\nstderr:\n${authoritative.stderr}`,
        ).toBe(0);
        const sealed = JSON.parse(
          readFileSync(repo.path('.gateforge/test-gates/execution-result.json'), 'utf8'),
        ) as ExecutionDocument;
        expect(Object.keys(sealed), 'a normal run has no chaos key at all').not.toContain('chaos');

        // The chaos run writes the same document shape plus the label
        // and the schedule it used, and seals no receipt.
        const chaosRun = await runCli(
          repo,
          ['test-gates', '--test', RACY_KEY, '--result-only', '--chaos', String(SEED), '--format', 'json'],
          { ...env, GATEFORGE_APPROVED_POLICY_DIGEST: approvedPin(repo) },
        );
        expect(chaosRun.code, `chaos stdout:\n${chaosRun.stdout}\nstderr:\n${chaosRun.stderr}`).toBe(1);
        const report = parseReport(chaosRun);
        expect(Object.keys(report).sort().filter((key) => key === 'chaos')).toEqual(['chaos']);
        expect(report.chaos?.schedule?.length, JSON.stringify(report.chaos)).toBeGreaterThan(0);
        // The authoritative receipt from the normal run is untouched.
        expect(existsSync(repo.path('.gateforge/test-gates/receipt.json'))).toBe(true);
        expect(JSON.parse(readFileSync(repo.path('.gateforge/test-gates/execution-result.json'), 'utf8'))).toEqual(
          sealed,
        );
      } finally {
        await proxy.stop();
        app.stop();
      }
    });
  }, 600_000);
});
