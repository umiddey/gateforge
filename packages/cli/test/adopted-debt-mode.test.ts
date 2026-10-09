/**
 * ADOPTED DEBT AFTER ADOPTION (0.10.4, REFERENCE "Adopted debt after
 * adoption") — the owner-pinned `enforcement.adoptedDebt` setting.
 *
 * The wall this removes, measured on a real repository running 0.10.3:
 * after the adoption commit lands, the FIRST commit that adds tests, the
 * mapping sidecar and runner configuration — no product code at all —
 * expands the evaluation to every obligation, and under
 * `enforcement.strictE2E` every adopted `verdict:missing` obligation is
 * re-graded blocking (`strict E2E mode: baselined: adopted as forgiven
 * (was missing) …`). That commit therefore had to prove ALL the debt
 * `gateforge adopt` had just recorded, which no scoped run can do.
 *
 * The setting is owner-pinned and lives in `.gateforge.yml`, so its bytes
 * are inside the owner-approved policy digest: flipping it is a policy
 * revision change the owner re-approves, and a candidate cannot grant
 * itself forgiveness. ABSENT is `lenient`; `strict` keeps the 0.10.3
 * condition byte for byte (only an ADOPTION COMMIT — computed from the
 * base revision, never declared — keeps the forgiveness).
 *
 * Covered here, all through the REAL CLI (`test-gates` seals a real
 * receipt against a stub runner and the real witness; `check --staged`
 * verifies it):
 * - the positive case — the default (no key) forgives the adopted debt
 *   on that post-adoption commit, exit 0, debt still NAMED;
 * - `adoptedDebt: strict` on the same change set re-grades it, exit 1;
 * - ONE product source in the change set re-grades it either way;
 * - NO owner pin means no forgiveness at all;
 * - a NEWLY CLAIMED obligation without evidence still blocks;
 * - flipping the key moves the owner-pinned digest.
 */
import { stubPlaywrightFiles } from './helpers.js';
import { describe, expect, it } from 'vitest';
import { loadConfig, withTempRepo, type TempRepo } from '@gate-forge/core';
import {
  CLASSIFICATION_POLICY_YML,
  PLUGIN_SOURCE,
  POLICIES_YML,
  configYml,
  runCli,
} from './helpers.js';
import {
  VERIFIER_KEY,
  evidenceAdapter,
  evidenceSpecs,
  evidenceStubCli,
  evidenceTestMap,
  startEvidenceApp,
} from './reseal-e2e-fixture.js';
import { trustedPolicyDigestForConfig } from '../src/execution.js';

/** The generated pre-commit hook `init --blocking` installs. */
const HOOK_PATH = '.gateforge/hooks/gateforge-check.mjs';

/** The generated CI wiring `init --blocking` installs. */
const CI_WIRING = "include:\n  - local: '.gateforge/ci/gitlab-gateforge.yml'\n";

/** The pre-existing obligation no test claims and adoption never touches. */
const UNTOUCHED_DEBT = 'tenant.refunds:persistence:read';

/** The resources whose specs and mapping the adoption commit adds. */
const ADOPTED_NAMES = ['accounts', 'orders'] as const;

/** One product source whose bytes a LATER commit may change. */
const ADOPTED_SOURCE = `src/${ADOPTED_NAMES[0]}.txt`;

/** The enforcement header the fixture config carries, per adopted-debt value. */
function enforcementBlock(adoptedDebt: 'absent' | 'lenient' | 'strict'): string {
  const key = adoptedDebt === 'absent' ? '' : `  adoptedDebt: ${adoptedDebt}\n`;
  return `mode: changed\nenforcement:\n  strictE2E: true\n${key}`;
}

/** The fixture config for one adopted-debt value. */
function fixtureConfig(adoptedDebt: 'absent' | 'lenient' | 'strict'): string {
  return `${enforcementBlock(adoptedDebt)}${configYml()}`;
}

/** The install manifest the adoption commit writes (a gate-defining input). */
function manifest(version: string): string {
  return `${JSON.stringify({ name: 'fixture', private: true, devDependencies: { '@playwright/test': version } }, null, 2)}\n`;
}

interface Report {
  summary: { blocking: number };
  verdicts: Array<{ obligationId: string; verdict: string; reason: string | null; cause: string | null }>;
  blocking: Array<{ name: string | null; cause?: string | null; detail: string }>;
}

/** The verdict one obligation carries in a report, or `'absent'`. */
function verdictOf(report: Report, obligationId: string): string {
  return report.verdicts.find((entry) => entry.obligationId === obligationId)?.verdict ?? 'absent';
}

/** The environment a scoped run and the staged check share. */
function gateEnv(pin: string): Record<string, string> {
  return { GATEFORGE_WITNESS_VERIFIER_KEY: VERIFIER_KEY, GATEFORGE_APPROVED_POLICY_DIGEST: pin };
}

/** The owner pin for the candidate's CURRENT bytes (taken after staging). */
function pinFor(repo: TempRepo): string {
  return trustedPolicyDigestForConfig(repo.root, loadConfig(repo.path('.gateforge.yml')));
}

/** Seals the authoritative changed-slice receipt for the current worktree. */
async function sealScopedReceipt(repo: TempRepo, env: Record<string, string>): Promise<void> {
  const run = await runCli(repo, ['test-gates', '--changed', '--scope', 'changed', '--format', 'json'], env);
  expect(run.code, `${run.stdout}\n${run.stderr}`).toBe(0);
}

/** Runs the command the generated commit hook runs. */
function runStagedCheck(repo: TempRepo, env: Record<string, string>) {
  return runCli(repo, ['check', '--staged', '--require-e2e', '--format', 'json'], env);
}

/**
 * A repository with product code and NO gate at HEAD: the state of every
 * repository the day before it adopts. The `tenant.refunds` obligation is
 * pre-existing debt no test claims and no commit ever touches.
 */
async function installUngated(repo: TempRepo, appUrl: string): Promise<void> {
  repo.writeFiles({
    '.gitignore': '.gateforge/test-gates/\n',
    // NO `enforcement` block at all: that is what "no gate at HEAD" means
    // to the computed adoption verdict, and the whole point of the fixture.
    '.gateforge.yml': configYml(),
    '.gateforge/policies.yml': POLICIES_YML,
    '.gateforge/classification-policy.yml': CLASSIFICATION_POLICY_YML,
    'plugin.mjs': PLUGIN_SOURCE,
    'src/refunds.txt': 'refunds fixture.table\n',
    '.gateforge/adapters/refunds.mjs': evidenceAdapter(appUrl),
    ...Object.fromEntries(ADOPTED_NAMES.map((name) => [`src/${name}.txt`, `${name} fixture.table\n`])),
    ...Object.fromEntries(ADOPTED_NAMES.map((name) => [`.gateforge/adapters/${name}.mjs`, evidenceAdapter(appUrl)])),
    ...stubPlaywrightFiles(evidenceStubCli(ADOPTED_NAMES)),
  });
  repo.commitFiles({}, 'existing product code, no gate yet');
}

/**
 * The ADOPTION COMMIT: the gate wiring plus the specs, the sidecar, the
 * runner configuration and the manifest that give the two pre-existing
 * resources their proof. `adopt` records the untouched third obligation as
 * debt. Returns the owner pin for the staged bytes (taken LAST, after
 * `git add`, because `check --staged` digests the index while `test-gates`
 * digests the worktree).
 */
async function stageAdoptionCommit(
  repo: TempRepo,
  adoptedDebt: 'absent' | 'lenient' | 'strict',
): Promise<Record<string, string>> {
  repo.writeFiles({
    [HOOK_PATH]: '// generated by gateforge\nexport default {};\n',
    '.gateforge/ci/gitlab-gateforge.yml': '# generated by gateforge\n',
    '.gitlab-ci.yml': CI_WIRING,
    '.gateforge.yml': fixtureConfig(adoptedDebt),
    'package.json': manifest('1.0.0'),
    ...evidenceSpecs(ADOPTED_NAMES, true),
    '.gateforge/test-map.yml': evidenceTestMap(ADOPTED_NAMES),
    'playwright.config.mjs': "export default { testDir: 'e2e', projects: [{ name: 'chromium' }] };\n",
  });
  const adopted = await runCli(repo, ['adopt']);
  expect(adopted.code, `${adopted.stdout}\n${adopted.stderr}`).toBe(0);
  repo.stage();
  return gateEnv(pinFor(repo));
}

/**
 * THE COMMIT 0.10.3 COULD NOT MAKE: a LATER commit whose WHOLE changed
 * set is neutral — a manifest bump, the mapping sidecar, the runner
 * configuration and the catalog specs, with the comment lines the stub
 * runner ignores — and NOT one discovered resource's source. Adoption mode
 * is one-shot, so from here this commit is judged like every later one.
 */
function writeNeutralLaterCommit(repo: TempRepo, extra: Record<string, string> = {}): void {
  repo.writeFiles({
    'package.json': manifest('1.0.1'),
    '.gateforge/test-map.yml': `${evidenceTestMap(ADOPTED_NAMES)}# reviewed with the runner config\n`,
    'playwright.config.mjs':
      "export default { testDir: 'e2e', projects: [{ name: 'chromium' }] };\n// the headed wrapper\n",
    ...extra,
  });
  for (const [file, body] of Object.entries(evidenceSpecs(ADOPTED_NAMES, true))) {
    repo.writeFiles({ [file]: `${body}\n// reviewed\n` });
  }
  repo.stage();
}

/**
 * Runs the adoption commit through the real hook and LANDS it, so HEAD
 * carries a gate and every later commit is judged like every later one.
 */
async function landAdoptionCommit(
  repo: TempRepo,
  appUrl: string,
  adoptedDebt: 'absent' | 'lenient' | 'strict',
): Promise<void> {
  await installUngated(repo, appUrl);
  const env = await stageAdoptionCommit(repo, adoptedDebt);
  await sealScopedReceipt(repo, env);
  const first = await runStagedCheck(repo, env);
  expect(first.code, `${first.stdout}\n${first.stderr}`).toBe(0);
  repo.commitFiles({}, 'adopt the gate');
}

describe('0.10.4 the default (no key) forgives adopted debt on a neutral post-adoption commit', () => {
  it('exits 0 with the debt named and forgiven', async () => {
    const app = await startEvidenceApp();
    try {
      await withTempRepo({}, async (repo) => {
        await landAdoptionCommit(repo, app.url, 'absent');

        // The commit this release exists for: tests, sidecar and runner
        writeNeutralLaterCommit(repo);
        // The sidecar is a policy input, so the owner re-approves the
        // revision this commit introduces, exactly as they must.
        const env = gateEnv(pinFor(repo));
        await sealScopedReceipt(repo, env);

        const run = await runStagedCheck(repo, env);
        const output = `${run.stdout}\n${run.stderr}`;
        const report = JSON.parse(run.stdout) as Report;

        // Nothing is hidden: the adopted debt is still reported, and it is
        // no longer re-graded blocking.
        expect(output).toContain(UNTOUCHED_DEBT);
        expect(verdictOf(report, UNTOUCHED_DEBT), output).toBe('waived');
        expect(report.summary.blocking, output).toBe(0);
        expect(
          report.blocking.map((entry) => entry.cause ?? ''),
          output,
        ).not.toContain('EVIDENCE_SCOPE_INCOMPLETE');
        expect(run.code, output).toBe(0);
      });
    } finally {
      await app.close();
    }
  }, 240_000);

  it('writes no key for `adoptedDebt: lenient` either — absent and explicit lenient agree', async () => {
    const app = await startEvidenceApp();
    try {
      await withTempRepo({}, async (repo) => {
        await landAdoptionCommit(repo, app.url, 'lenient');
        writeNeutralLaterCommit(repo);
        const env = gateEnv(pinFor(repo));
        await sealScopedReceipt(repo, env);

        const run = await runStagedCheck(repo, env);
        const output = `${run.stdout}\n${run.stderr}`;
        const report = JSON.parse(run.stdout) as Report;

        expect(verdictOf(report, UNTOUCHED_DEBT), output).toBe('waived');
        expect(run.code, output).toBe(0);
      });
    } finally {
      await app.close();
    }
  }, 240_000);
});

describe('0.10.4 adoptedDebt: strict keeps the 0.10.3 re-grade', () => {
  it('the same change set re-grades the adopted debt, exit 1', async () => {
    const app = await startEvidenceApp();
    try {
      await withTempRepo({}, async (repo) => {
        await landAdoptionCommit(repo, app.url, 'strict');
        writeNeutralLaterCommit(repo);
        const env = gateEnv(pinFor(repo));
        await sealScopedReceipt(repo, env);

        const run = await runStagedCheck(repo, env);
        const output = `${run.stdout}\n${run.stderr}`;
        const report = JSON.parse(run.stdout) as Report;

        // Exactly 0.10.3: adoption mode is one-shot, so this commit is
        // judged like every later one — the expanded scope demands
        // full-scope coverage and the adopted debt is re-graded blocking.
        expect(
          report.blocking.map((entry) => entry.cause ?? ''),
          output,
        ).toContain('EVIDENCE_SCOPE_INCOMPLETE');
        expect(verdictOf(report, UNTOUCHED_DEBT), output).toBe('missing');
        expect(run.code, output).not.toBe(0);
      });
    } finally {
      await app.close();
    }
  }, 240_000);
});

describe('0.10.4 the leniency is exactly as narrow as the neutrality', () => {
  it('ONE product source in the change set re-grades the debt, exit 1', async () => {
    const app = await startEvidenceApp();
    try {
      await withTempRepo({}, async (repo) => {
        await landAdoptionCommit(repo, app.url, 'absent');
        // The same neutral commit plus ONE changed product resource
        // source: a discovered resource's own source IS product
        // behaviour, so the change set is no longer neutral and the
        // strict re-grade returns in either value of the setting.
        writeNeutralLaterCommit(repo, {
          [ADOPTED_SOURCE]: `${ADOPTED_NAMES[0]} fixture.table\n# touched by a later commit\n`,
        });
        const env = gateEnv(pinFor(repo));
        await sealScopedReceipt(repo, env);

        const run = await runStagedCheck(repo, env);
        const output = `${run.stdout}\n${run.stderr}`;
        const report = JSON.parse(run.stdout) as Report;

        expect(verdictOf(report, UNTOUCHED_DEBT), output).toBe('missing');
        expect(report.summary.blocking, output).toBeGreaterThan(0);
        expect(run.code, output).not.toBe(0);
      });
    } finally {
      await app.close();
    }
  }, 240_000);

  it('without the owner pin there is no forgiveness at all', async () => {
    const app = await startEvidenceApp();
    try {
      await withTempRepo({}, async (repo) => {
        await landAdoptionCommit(repo, app.url, 'absent');
        writeNeutralLaterCommit(repo);
        // The receipt is sealed UNDER the pin; the CHECK that follows runs
        // with none, so the only difference is the pin the forgiveness is
        // conditioned on.
        await sealScopedReceipt(repo, gateEnv(pinFor(repo)));

        // The very same neutral change set, judged with no owner-approved
        // pin. The forgiveness is conditioned on the same
        // `evaluateApprovedPolicy(...).status === 'enforced'` the 0.9.0
        // rule used, so with no pin nothing is forgiven and the candidate
        // is refused before it is graded.
        const run = await runStagedCheck(repo, { GATEFORGE_WITNESS_VERIFIER_KEY: VERIFIER_KEY });
        const output = `${run.stdout}\n${run.stderr}`;

        expect(run.code, output).not.toBe(0);
        expect(output).toContain('ENFORCEMENT_UNTRUSTED');
        expect(output).toContain('no owner-approved policy digest is provisioned');
      });
    } finally {
      await app.close();
    }
  }, 240_000);
});

describe('0.10.4 the forgiveness covers adopted-baseline entries only', () => {
  it('a newly claimed obligation without sealed evidence still blocks', async () => {
    const app = await startEvidenceApp();
    try {
      await withTempRepo({}, async (repo) => {
        await landAdoptionCommit(repo, app.url, 'absent');

        // A NEUTRAL change set that makes a policy claim the fixtures do
        // not carry: a second policy adds `persistence:delete` to every
        // user-facing resource. Those obligations arise AFTER adoption,
        // so no baseline entry forgives them and nothing proves them. The
        // run is graded directly (no receipt demanded), which isolates the
        // VERDICT the forgiveness must not touch.
        repo.writeFiles({
          '.gateforge/policies.yml':
            `${POLICIES_YML}  - id: fixture.delete\n    when:\n      exposure: user-facing\n    require:\n      - persistence:delete\n`,
        });
        repo.stage();

        const run = await runCli(repo, ['check', '--staged', '--format', 'json'], gateEnv(pinFor(repo)));
        const output = `${run.stdout}\n${run.stderr}`;
        const report = JSON.parse(run.stdout) as Report;

        // The adopted debt is still forgiven on this neutral change set,
        // and the obligation that arose after adoption still blocks: the
        // forgiveness covers adopted-baseline entries only.
        expect(verdictOf(report, UNTOUCHED_DEBT), output).toBe('waived');
        expect(verdictOf(report, `${UNTOUCHED_DEBT.split(':')[0]}:persistence:delete`), output).toBe('missing');
        expect(run.code, output).not.toBe(0);
      });
    } finally {
      await app.close();
    }
  }, 240_000);
});

describe('0.10.4 the key is inside the owner-pinned digest', () => {
  it('changing enforcement.adoptedDebt moves the trusted policy digest', async () => {
    await withTempRepo({}, async (repo) => {
      repo.writeFiles({
        '.gateforge.yml': fixtureConfig('absent'),
        '.gateforge/policies.yml': POLICIES_YML,
        '.gateforge/classification-policy.yml': CLASSIFICATION_POLICY_YML,
        'plugin.mjs': PLUGIN_SOURCE,
      });
      const absent = pinFor(repo);
      repo.writeFiles({ '.gateforge.yml': fixtureConfig('lenient') });
      const lenient = pinFor(repo);
      repo.writeFiles({ '.gateforge.yml': fixtureConfig('strict') });
      const strict = pinFor(repo);

      // The bytes of the key are hashed like every other owner decision in
      // `.gateforge.yml`, so granting leniency is a policy revision the
      // owner must re-approve — a candidate cannot pin itself.
      expect(lenient).not.toBe(absent);
      expect(strict).not.toBe(absent);
      expect(strict).not.toBe(lenient);
    });
  });
});