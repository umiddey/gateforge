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
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { withTempRepo, type TempRepo } from '@gate-forge/core';
import { ChaosScheduler } from '@gate-forge/witness';
import { startAttestationProxy, startWitnessProcess } from '@gate-forge/pack-playwright';
import { trustedPolicyDigestForConfig } from '../src/execution.js';
import { loadConfigAt, VERIFIER_KEY_FILE_ENV } from '../src/commands/common.js';
import { runCli } from './helpers.js';
import { cleanupWitnessedFixture, installStrictFixture, operatorEnvironment, ROOT, FINGERPRINT } from './witnessed-run-fixture.js';

/** The route the racy page's two list requests share (query ignored). */
const TAB_ROUTE = 'GET /api/tab';

/** The racy page's own assertion message (streamed by the run on red). */
const RACY_ASSERTION = 'tab B rows must win even when the tab A response lands last';

/** How much slower the fixture app's beta tab is (see the fixture app). */
const BETA_BACKEND_DELAY_MS = 5;

/**
 * The smallest seed whose plan holds the FIRST tab request open past
 * the second one, for the session identity a given run reports.
 *
 * The plan is a pure function of (seed, session identity, route key,
 * k), so the seed is not guessed: the run below reports the session it
 * released under, this recomputes the schedule for that session, and
 * the first seed that genuinely reorders the two requests is the one
 * the run uses. Found this way it is seed 4 for the fixture's racy
 * test; recomputing it keeps the case honest if the fixture's test
 * identity ever moves.
 */
function reorderingSeedFor(session: string): number {
  for (let seed = 0; seed < 1_000; seed += 1) {
    const scheduler = new ChaosScheduler({ seed, maxDelayMs: 400, reorder: true }, session);
    const first = scheduler.reserve(TAB_ROUTE, 0);
    const second = scheduler.reserve(TAB_ROUTE, 1);
    // The first request must still be held when the second one is due,
    // or the reorder is a plan on paper with no effect on the page.
    if (second.releasedBefore && first.delayMs > BETA_BACKEND_DELAY_MS + 1) return seed;
  }
  throw new Error(`no seed under 1000 reorders '${TAB_ROUTE}' for session '${session}'`);
}

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
const RACY_ASSERTION = '${RACY_ASSERTION}';
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
  // Both list answers have landed before the page is judged: asserting
  // while the stale one is still in flight would pass by accident.
  await page.waitForFunction(() => window.__settled === 2);
  // The named message is what a chaos finding is read from: the run
  // streams it when the stale answer wins the race.
  await expect(page.locator('#rows'), RACY_ASSERTION).toContainText('beta-row');
});

// The twin: the same two requests against a page that renders by
// request id. No timing may ever turn this red.
test('tab B rows win the list without a stale response', async ({ page }) => {
  await page.goto(appBase + '/twin');
  await page.locator('#tab-a').click();
  await page.locator('#tab-b').click();
  await page.waitForFunction(() => window.__settled === 2);
  await expect(page.locator('#rows'), 'the race-free twin must never show a stale tab').toContainText('beta-row');
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
  session: string;
  routeKey: string;
  k: number;
  plannedDelayMs: number;
  delayMs: number;
  releasedBefore: boolean;
}

/**
 * The half of a schedule that is a pure function of (seed, session,
 * route key, k): the plan. Two runs of one seed must agree on it
 * exactly; the applied hold may be a little smaller when a concurrent
 * request arrived late.
 */
function plannedSchedule(schedule: readonly ChaosEntry[]): unknown[] {
  return schedule.map((entry) => [entry.session, entry.routeKey, entry.k, entry.plannedDelayMs, entry.releasedBefore]);
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

/**
 * The seed a given test's run must use: one probe run reports the
 * session identity the witness released that test's traffic under, and
 * the plan is then recomputed from it (see {@link reorderingSeedFor}).
 */
async function seedForRepo(
  repo: TempRepo,
  env: Record<string, string>,
  testKey: string,
): Promise<number> {
  const probe = await runCli(
    repo,
    ['test-gates', '--test', testKey, '--result-only', '--chaos', '0', '--format', 'json'],
    env,
  );
  const session = parseReport(probe).chaos?.schedule?.[0]?.session ?? '';
  expect(session, `the probe run must name its session\nstdout:\n${probe.stdout}\nstderr:\n${probe.stderr}`).not.toBe('');
  return reorderingSeedFor(session);
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

  it('fails the racy page under a computed seed and replays the identical schedule', async () => {
    await withTempRepo({}, async (repo) => {
      installRepo(repo);
      const app = await startRaceApp();
      const proxy = await startAttestationProxy(app.url, FINGERPRINT);
      try {
        const { env } = operatorEnv(proxy.url);
        const runEnv = { ...env, GATEFORGE_APPROVED_POLICY_DIGEST: approvedPin(repo) };
        // The probe run answers one question the test cannot know
        // before the run: which session identity the witness released
        // this test's traffic under. The plan is a pure function of it,
        // so the seed that reorders the two tab requests is computed,
        // not guessed.
        const probe = await runCli(
          repo,
          ['test-gates', '--test', RACY_KEY, '--result-only', '--chaos', '0', '--format', 'json'],
          runEnv,
        );
        const probeEntries = parseReport(probe).chaos?.schedule ?? [];
        const session = probeEntries[0]?.session ?? '';
        expect(session, `the schedule must name the session it released under
${probe.stderr}`).not.toBe('');
        const seed = reorderingSeedFor(session);

        const first = await runCli(
          repo,
          [
            'test-gates',
            '--test',
            RACY_KEY,
            '--result-only',
            '--chaos',
            String(seed),
            '--progress',
            'stderr',
            '--format',
            'json',
          ],
          runEnv,
        );
        const firstReport = parseReport(first);
        expect(
          first.code,
          `seed ${String(seed)} must surface the race\nstdout:\n${first.stdout}\nstderr:\n${first.stderr}`,
        ).toBe(1);
        expect(firstReport.chaos?.seed, first.stderr).toBe(seed);
        expect(firstReport.chaos?.reorder, first.stderr).toBe(true);
        expect(firstReport.execution?.selectedTests?.failed, first.stderr).toBe(1);

        // The schedule is the explanation: the FIRST tab request is
        // held open past the moment the second one is due, so the stale
        // response lands last and the page renders the wrong tab.
        const schedule = firstReport.chaos?.schedule ?? [];
        const tabEntries = schedule.filter((entry) => entry.routeKey === TAB_ROUTE);
        expect(tabEntries.map((entry) => entry.k).sort(), JSON.stringify(schedule)).toEqual([1, 2]);
        const firstTab = tabEntries.find((entry) => entry.k === 1);
        const secondTab = tabEntries.find((entry) => entry.k === 2);
        expect(secondTab?.releasedBefore, JSON.stringify(tabEntries)).toBe(true);
        expect(firstTab?.delayMs ?? 0, JSON.stringify(tabEntries)).toBeGreaterThan(secondTab?.delayMs ?? 0);
        expect(firstTab?.delayMs ?? 0).toBeGreaterThan(BETA_BACKEND_DELAY_MS);
        // The released order in the record IS the order the page saw.
        expect(tabEntries[0]?.k, JSON.stringify(tabEntries)).toBe(2);
        // The failure is the page's own assertion, streamed by the
        // runner: the expected row never arrived, the stale one did.
        // What the run actually streams for a red test: the failing
        // test and the assertion it died on.
        expect(first.stderr, 'the run must name the test that failed').toContain(
          `tab B rows win the list — Error: ${RACY_ASSERTION}`,
        );

        // No recorded field can carry a query value or a credential.
        expect(JSON.stringify(schedule)).not.toContain('tab=');
        expect(JSON.stringify(schedule)).not.toContain('token');

        // Replay: the SAME seed runs the SAME schedule and fails the
        // same way. A finding nobody can reproduce is a ghost.
        const second = await runCli(
          repo,
          ['test-gates', '--test', RACY_KEY, '--result-only', '--chaos', String(seed), '--format', 'json'],
          runEnv,
        );
        const secondReport = parseReport(second);
        expect(second.code, `replay stdout:\n${second.stdout}\nstderr:\n${second.stderr}`).toBe(1);
        expect(
          plannedSchedule(secondReport.chaos?.schedule ?? []),
          'the same seed must plan the same schedule',
        ).toEqual(plannedSchedule(schedule));
        // The replay failed the same way, not merely with the same plan.
        expect(secondReport.execution?.selectedTests?.failed, second.stderr).toBe(1);
        // Apart from the timing fields themselves, the two runs are the
        // same run: same verdicts, same claims, same failures.
        const { chaos: _firstChaos, ...firstWithoutChaos } = firstReport;
        const { chaos: _secondChaos, ...secondWithoutChaos } = secondReport;
        expect(stableReport(secondWithoutChaos as ChaosReport)).toEqual(stableReport(firstWithoutChaos as ChaosReport));
        // A chaos run is a finding: it seals nothing.
        expect(existsSync(repo.path('.gateforge/test-gates/receipt.json'))).toBe(false);
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
        const seed = await seedForRepo(repo, { ...env, GATEFORGE_APPROVED_POLICY_DIGEST: approvedPin(repo) }, TWIN_KEY);
        const run = await runCli(
          repo,
          ['test-gates', '--test', TWIN_KEY, '--result-only', '--chaos', String(seed), '--format', 'json'],
          { ...env, GATEFORGE_APPROVED_POLICY_DIGEST: approvedPin(repo) },
        );
        const report = parseReport(run);
        expect(
          run.code,
          `the race-free twin must stay green under seed ${String(seed)}\nstdout:\n${run.stdout}\nstderr:\n${run.stderr}`,
        ).toBe(0);
        expect(report.chaos?.seed).toBe(seed);
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
        const seed = reorderingSeedFor(
          parseReport(
            await runCli(
              repo,
              ['test-gates', '--test', RACY_KEY, '--result-only', '--chaos', '0', '--format', 'json'],
              runEnv,
            ),
          ).chaos?.schedule?.[0]?.session ?? '',
        );
        const chaosRun = await runCli(
          repo,
          ['test-gates', '--test', CREATE_KEY, '--result-only', '--chaos', String(seed), '--format', 'json'],
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
      const noResultOnly = await runCli(repo, ['test-gates', '--changed', '--chaos', '4'], env);
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
        const chaosEnv = { ...env, GATEFORGE_APPROVED_POLICY_DIGEST: approvedPin(repo) };
        const seed = await seedForRepo(repo, chaosEnv, RACY_KEY);
        const chaosRun = await runCli(
          repo,
          ['test-gates', '--test', RACY_KEY, '--result-only', '--chaos', String(seed), '--format', 'json'],
          chaosEnv,
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

/** The verifier key the external-witness cases share with their witness. */
const EXTERNAL_KEY = 'external-chaos-verifier-key';

/** An external witness the TEST owns — exactly how a repository starts it. */
interface ExternalWitness {
  /** The supervisor origin passed to `--witness-url`. */
  url: string;
  /** The observation proxy the suite's browser is routed through. */
  proxyUrl: string;
  /** The non-authoritative state directory shared with `--out`. */
  stateDir: string;
  /** The run token shared with `--run-token`. */
  token: string;
  /** Stops the witness process and removes its state directory. */
  stop: () => Promise<void>;
}

/**
 * Starts a witness the way a repository's own script does: the chaos
 * plan is handed over in the ENVIRONMENT at boot, and the witness
 * reads it exactly once. A null seed starts a witness with no plan.
 */
async function startExternalWitness(
  repo: TempRepo,
  targetUrl: string,
  chaosSeed: number | null,
): Promise<ExternalWitness> {
  const stateDir = mkdtempSync(join(tmpdir(), 'gateforge-external-chaos-'));
  const token = randomUUID();
  // The witness reads the classifications a repository's own script
  // hands it: the file one previous real run produced.
  copyFileSync(
    join(repo.root, '.gateforge/test-gates/classifications.json'),
    join(stateDir, 'classifications.json'),
  );
  const witness = await startWitnessProcess({
    GATEFORGE_RUN_ID: randomUUID(),
    GATEFORGE_RUN_TOKEN: token,
    GATEFORGE_STATE_DIR: stateDir,
    GATEFORGE_CLASSIFICATIONS: join(stateDir, 'classifications.json'),
    GATEFORGE_ADAPTERS_DIR: join(repo.root, '.gateforge/adapters'),
    GATEFORGE_TARGET_BASE_URL: targetUrl,
    GATEFORGE_ADAPTER_BASE_URL: targetUrl,
    GATEFORGE_TARGET_FINGERPRINT: FINGERPRINT,
    GATEFORGE_PROXY_TARGET: targetUrl,
    GATEFORGE_WITNESS_VERIFIER_KEY: EXTERNAL_KEY,
    ...(chaosSeed === null ? {} : { GATEFORGE_CHAOS_SEED: String(chaosSeed) }),
  });
  if (witness.proxyUrl === null) throw new Error('the external witness started no observation proxy');
  return {
    url: witness.url,
    proxyUrl: witness.proxyUrl,
    stateDir,
    token,
    stop: async () => {
      if (witness.child.exitCode === null && witness.child.signalCode === null) {
        witness.child.kill('SIGTERM');
        await once(witness.child, 'exit');
      }
      rmSync(stateDir, { recursive: true, force: true });
    },
  };
}

/**
 * The operator environment an external-witness run needs. The run
 * reads the same key the witness boots with, through a key FILE (the
 * CLI accepts exactly one verifier-key source).
 */
function externalOperatorEnv(witness: ExternalWitness): Record<string, string> {
  const directory = mkdtempSync(join(tmpdir(), 'gateforge-external-chaos-keys-'));
  keyDirectories.push(directory);
  const keyFile = join(directory, 'keys.json');
  writeFileSync(
    keyFile,
    `${JSON.stringify({ schemaVersion: 1, activeKeyId: 'external-chaos-key', keys: { 'external-chaos-key': EXTERNAL_KEY } })}\n`,
    { mode: 0o600 },
  );
  return {
    [VERIFIER_KEY_FILE_ENV]: keyFile,
    GATEFORGE_APP_BASE_URL: witness.proxyUrl,
  };
}

/** The `--witness-url` argv prefix every external run shares. */
function externalPrefix(witness: ExternalWitness): string[] {
  return ['--witness-url', witness.url, '--out', witness.stateDir, '--run-token', witness.token];
}

describe('timing chaos with your own witness: the run owns the plan', () => {
  it('perturbs through a bound plan, replays it, and never seals against a perturbed witness', async () => {
    await withTempRepo({}, async (repo) => {
      installRepo(repo);
      const app = await startRaceApp();
      const proxy = await startAttestationProxy(app.url, FINGERPRINT);
      // One real run first, so the classifications an external witness
      // needs exist exactly as a repository's own script provides them.
      const bootstrap = await runCli(repo, ['test-gates', '--changed', '--format', 'json'], {
        ...operatorEnv(proxy.url).env,
        GATEFORGE_APPROVED_POLICY_DIGEST: approvedPin(repo),
      });
      expect(bootstrap.code, `bootstrap stdout:\n${bootstrap.stdout}\nstderr:\n${bootstrap.stderr}`).toBe(0);
      const receiptBefore = readFileSync(repo.path('.gateforge/test-gates/receipt.json'), 'utf8');
      try {
        // An external witness serves exactly ONE invocation (its bound
        // run context is never relabelled), so each case gets its own
        // — which is also what a repository's own script does.
        const withWitness = async (
          envChaosSeed: number | null,
          run: (witness: ExternalWitness) => Promise<void>,
        ): Promise<void> => {
          const witness = await startExternalWitness(repo, proxy.url, envChaosSeed);
          try {
            await run(witness);
          } finally {
            await witness.stop();
          }
        };

        // Which seed reorders the two tab requests is a pure function
        // of the session identity the witness releases under, so the
        // seed is COMPUTED from a probe, never guessed.
        let agreed = 0;
        await withWitness(null, async (witness) => {
          const probeRun = await runCli(
            repo,
            ['test-gates', '--test', RACY_KEY, '--result-only', '--chaos', '0', '--format', 'json', ...externalPrefix(witness)],
            externalOperatorEnv(witness),
          );
          const session =
            (parseReport(probeRun).chaos?.schedule as Array<{ session: string }> | undefined)?.[0]?.session ?? '';
          expect(
            session,
            `the probe must name the session it released under\nstdout:\n${probeRun.stdout}\nstderr:\n${probeRun.stderr}`,
          ).not.toBe('');
          agreed = reorderingSeedFor(session);
        });

        // ---- (a) the run binds the plan; the race surfaces, labelled ----
        // Nothing is configured on the witness side: the seed travels
        // with the run context, and the report carries the plan that
        // actually ran.
        const chaosArgv = (witness: ExternalWitness): string[] => [
          'test-gates',
          '--test',
          RACY_KEY,
          '--result-only',
          '--chaos',
          String(agreed),
          '--format',
          'json',
          ...externalPrefix(witness),
        ];
        let schedule: unknown[] = [];
        await withWitness(null, async (witness) => {
          const chaos = await runCli(
            repo,
            chaosArgv(witness),
            { ...externalOperatorEnv(witness), GATEFORGE_APPROVED_POLICY_DIGEST: approvedPin(repo) },
          );
          const report = parseReport(chaos);
          expect(
            chaos.code,
            `seed ${String(agreed)} must surface the race through the external witness\nstdout:\n${chaos.stdout}\nstderr:\n${chaos.stderr}`,
          ).toBe(1);
          expect(report.chaos?.seed, chaos.stderr).toBe(agreed);
          expect(report.chaos?.maxDelayMs, JSON.stringify(report.chaos)).toBe(400);
          expect(report.chaos?.reorder, JSON.stringify(report.chaos)).toBe(true);
          expect(report.chaos?.schedule?.length, JSON.stringify(report.chaos)).toBeGreaterThan(0);
          expect(report.execution?.selectedTests?.failed, chaos.stderr).toBe(1);
          expect(chaos.stderr).toContain(RACY_ASSERTION);
          // A chaos run is a finding: the sealed receipt is untouched.
          expect(readFileSync(repo.path('.gateforge/test-gates/receipt.json'), 'utf8')).toBe(receiptBefore);
          schedule = report.chaos?.schedule ?? [];
        });

        // The same seed against a FRESH witness replays the identical
        // plan: a finding nobody can reproduce is a ghost.
        await withWitness(null, async (witness) => {
          const replay = await runCli(
            repo,
            chaosArgv(witness),
            { ...externalOperatorEnv(witness), GATEFORGE_APPROVED_POLICY_DIGEST: approvedPin(repo) },
          );
          const replayed = parseReport(replay).chaos?.schedule ?? [];
          expect(replay.code, `replay stdout:\n${replay.stdout}\nstderr:\n${replay.stderr}`).toBe(1);
          expect(plannedSchedule(replayed as ChaosEntry[]), 'the same seed must plan the same schedule').toEqual(
            plannedSchedule(schedule as ChaosEntry[]),
          );
        });

        // ---- (b) a witness STARTED with a plan cannot seal a run ----
        await withWitness(agreed, async (witness) => {
          const normal = await runCli(
            repo,
            ['test-gates', '--test', RACY_KEY, '--result-only', '--format', 'json', ...externalPrefix(witness)],
            { ...externalOperatorEnv(witness), GATEFORGE_APPROVED_POLICY_DIGEST: approvedPin(repo) },
          );
          expect(normal.code, `normal-vs-chaos stdout:\n${normal.stdout}\nstderr:\n${normal.stderr}`).toBe(2);
          expect(normal.stdout, 'a refused run prints no report').toBe('');
          expect(normal.stderr).toContain('never serve a run that seals');
          expect(normal.stderr, 'the fix names the environment to unset').toContain('GATEFORGE_CHAOS_SEED');
          expect(readFileSync(repo.path('.gateforge/test-gates/receipt.json'), 'utf8')).toBe(receiptBefore);
        });

        // ---- (c) a normal run against a normal external witness ----
        await withWitness(null, async (witness) => {
          const run = await runCli(
            repo,
            ['test-gates', '--test', RACY_KEY, '--result-only', '--format', 'json', ...externalPrefix(witness)],
            { ...externalOperatorEnv(witness), GATEFORGE_APPROVED_POLICY_DIGEST: approvedPin(repo) },
          );
          expect(run.code, `plain external stdout:\n${run.stdout}\nstderr:\n${run.stderr}`).toBe(0);
          const plainReport = parseReport(run);
          // Byte-identical to a run with no chaos anywhere: no label,
          // no extra output, and the racy page passes unperturbed.
          expect(Object.keys(plainReport)).not.toContain('chaos');
          expect(JSON.stringify(plainReport)).not.toContain('timing chaos');
          expect(run.stderr).not.toContain('GATEFORGE_CHAOS_SEED');
          expect(plainReport.execution?.selectedTests?.passed, run.stderr).toBe(1);
        });
      } finally {
        await proxy.stop();
        app.stop();
      }
    });
  }, 900_000);
});
