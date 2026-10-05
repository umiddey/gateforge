/**
 * ADOPTION MODE (0.10.2, REFERENCE "Adoption mode").
 *
 * The wall this removes: the commit that wires the gate is the one
 * commit the gate cannot judge. A first adoption commit always touches
 * `.gateforge.yml`, the runner config and the specs, every one of them a
 * gate-defining input, so `computeEvaluationScope` expands to ALL
 * obligations — while the only affordable proof of a large repository is
 * `test-gates --changed --scope changed`. The hook (`check --staged`)
 * refused that receipt as a scope mismatch, so every adopting repository
 * had to bypass the hook exactly once.
 *
 * Adoption mode is COMPUTED FROM HEAD, never declared: no flag, no
 * config key, nothing a candidate can set. It moves WHICH obligations
 * must be proven (the ones this commit newly claims), never WHO may
 * approve the policy, and it is one-shot: once a gate exists at HEAD the
 * condition can never hold again.
 *
 * The fixture carries what makes the difference visible. At HEAD there
 * is already product code with an obligation, no test and no gate
 * (`tenant.refunds`). The adoption commit never touches it: it is
 * pre-existing debt, `adopt` baselines it, and it is exactly what a
 * slice receipt can never certify — and exactly what adoption mode
 * stops demanding. The two other resources exist at HEAD too, and the
 * adoption commit gives them their specs, their mapping, the runner
 * configuration, the manifest and the gate wiring — every one of them
 * an attribution that cannot carry product behaviour. That is the
 * product-behaviour-neutral change set the adopted baseline's survival
 * under strict E2E now reads, and it is why the FIRST commit that wires
 * the gate exits 0 instead of accepting the receipt and then failing.
 *
 * Covered here:
 * - the positive case — the adoption commit passes `check --staged` on a
 *   scoped receipt for the same candidate tree, exit 0;
 * - the three negatives the forgiveness needs: ONE changed product
 *   resource source re-grades the debt (while the obligation that change
 *   newly claims stays covered), the same neutral change set in a LATER
 *   commit is judged exactly as today, and without the owner pin there is
 *   no forgiveness at all;
 * - R7 — a repository whose HEAD ALREADY has a gate still demands full
 *   scope, and deleting the generated hook is a policy-input change the
 *   owner must re-approve (§9's last paragraph);
 * - R8 — a newly claimed obligation with no sealed evidence is refused;
 * - R9 — an unstaged weakening in the worktree is refused by the pin;
 * - R10 — the guide and the generated hook name the same command.
 *
 * Everything below runs through the REAL CLI: `test-gates` seals a real
 * receipt against a stub runner and the real witness, `check --staged`
 * verifies it.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
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
import { gateforgeOwnedInput } from '../src/gateforge-owned.js';

/** The generated pre-commit hook `init --blocking` installs. */
const HOOK_PATH = '.gateforge/hooks/gateforge-check.mjs';

/** The generated CI wiring `init --blocking` installs. */
const CI_WIRING = "include:\n  - local: '.gateforge/ci/gitlab-gateforge.yml'\n";

/** A product change no discovered resource claims — an unmapped file. */
const UNMAPPED_PRODUCT_FILE = 'src/loyalty.js';

/** The pre-existing obligation no test claims and adoption never touches. */
const UNTOUCHED_DEBT = 'tenant.refunds:persistence:read';

/** The resources whose specs and mapping the adoption commit adds. */
const ADOPTED_NAMES = ['accounts', 'orders'] as const;

/**
 * One product source whose bytes the ADOPTION COMMIT changes. The
 * forgiveness reads the attribution of this file: a discovered
 * resource's own source is product behaviour, so a commit that touches
 * one is judged exactly like every later commit.
 */
const ADOPTED_SOURCE = `src/${ADOPTED_NAMES[0]}.txt`;


/**
 * The enforcement headers the fixture writes. The gated ones declare
 * `mode: changed`, which is the owner's own choice: debt outside the
 * change set is reported and does not block, so the adoption commit is
 * judged on what it claims.
 */
const ENFORCEMENT_BLOCKS = {
  '': '',
  strict: 'mode: changed\nenforcement:\n  strictE2E: true\n',
  off: 'enforcement:\n  strictE2E: false\n',
} as const;
/**
 * The fixture config. `enforcement` is the block verbatim — `''` is a
 * repository with configuration and NO gate, which is what HEAD looks
 * like the day before adoption.
 */
function fixtureConfig(enforcement: '' | 'strict' | 'off', testTooling?: readonly string[]): string {
  return `${ENFORCEMENT_BLOCKS[enforcement]}${configYml(testTooling === undefined ? {} : { testTooling })}`;
}


interface Report {
  summary: { blocking: number; baselinedObligations?: number };
  verdicts: Array<{ obligationId: string; verdict: string; reason: string | null; cause: string | null }>;
  blocking: Array<{ name: string | null; cause?: string | null; detail: string }>;
}

/** The verdict one obligation carries in a report, or `'absent'`. */
function verdictOf(report: Report, obligationId: string): string {
  return report.verdicts.find((entry) => entry.obligationId === obligationId)?.verdict ?? 'absent';
}

/**
 * A repository with product code and NO gate at HEAD: `.gateforge.yml`
 * carries no `enforcement` block and the generated hook does not exist
 * yet — the state of every repository the day before it adopts.
 */
async function installUngated(repo: TempRepo, appUrl: string): Promise<void> {
  repo.writeFiles({
    // The stub runner is TRACKED: the materialized staged checkout holds
    // tracked bytes only, so an ignored dependency directory would leave
    // the candidate's own specs unenumerable there.
    '.gitignore': '.gateforge/test-gates/\n',
    '.gateforge.yml': fixtureConfig(''),
    '.gateforge/policies.yml': POLICIES_YML,
    '.gateforge/classification-policy.yml': CLASSIFICATION_POLICY_YML,
    'plugin.mjs': PLUGIN_SOURCE,
    // Existing product code with no test and no gate: the debt this
    // repository carries into adoption and never touches again. Its
    // sources are NOT touched by the adoption commit either — the
    // adoption commit adds the gate wiring, the specs, the runner
    // configuration, the mapping and the manifest, which is exactly the
    // product-behaviour-neutral change set the forgiveness reads. The debt
    // is recorded with `adopt` (a shrink-only statement), never with an
    // owner waiver: an owner waiver is not forgiveness and strict E2E
    // re-grades it whatever the change set contains.
    'src/refunds.txt': 'refunds fixture.table\n',
    '.gateforge/adapters/refunds.mjs': evidenceAdapter(appUrl),
    ...Object.fromEntries(ADOPTED_NAMES.map((name) => [`src/${name}.txt`, `${name} fixture.table\n`])),
    ...Object.fromEntries(ADOPTED_NAMES.map((name) => [`.gateforge/adapters/${name}.mjs`, evidenceAdapter(appUrl)])),
    'node_modules/playwright/cli.js': evidenceStubCli(ADOPTED_NAMES),
  });
  repo.commitFiles({}, 'existing product code, no gate yet');
}

/**
 * The adoption commit: the gate wiring plus the product code and specs it
 * wires tests to. Returns the owner pin for the staged bytes — taken
 * LAST, after `git add`, because `check --staged` digests the index while
 * `test-gates` digests the worktree.
 */
async function stageAdoptionCommit(
  repo: TempRepo,
  extra: Record<string, string> = {},
): Promise<Record<string, string>> {
  repo.writeFiles({
    [HOOK_PATH]: '// generated by gateforge\nexport default {};\n',
    '.gateforge/ci/gitlab-gateforge.yml': '# generated by gateforge\n',
    '.gitlab-ci.yml': CI_WIRING,
    '.gateforge.yml': fixtureConfig('strict'),
    // The dependency manifest the install writes. A manifest is a
    // gate-defining input, so it expands the evaluation exactly like the
    // runner configuration and the mapping sidecar do.
    'package.json': `${JSON.stringify({ name: 'fixture', private: true, devDependencies: { '@playwright/test': '1.0.0' } }, null, 2)}\n`,
    // The specs and the sidecar rows that give the two pre-existing
    // resources their proof. Every file here is a gate-defining input, a
    // policy input, a catalog test file or test infrastructure: none of
    // them is a product resource source, which is what makes the whole
    // change set product-behaviour-neutral.
    ...evidenceSpecs(ADOPTED_NAMES),
    '.gateforge/test-map.yml': evidenceTestMap(ADOPTED_NAMES),
    'playwright.config.mjs': "export default { testDir: 'e2e', projects: [{ name: 'chromium' }] };\n",
    ...extra,
  });
  // `adopt` baselines the debt that already exists (the untouched third
  // obligation): a shrink-only record, never a waiver.
  const adopted = await runCli(repo, ['adopt']);
  expect(adopted.code, `${adopted.stdout}\n${adopted.stderr}`).toBe(0);
  repo.stage();
  return gateEnv(trustedPolicyDigestForConfig(repo.root, loadConfig(repo.path('.gateforge.yml'))));
}

/** The environment a scoped run and the staged check share. */
function gateEnv(pin: string): Record<string, string> {
  return { GATEFORGE_WITNESS_VERIFIER_KEY: VERIFIER_KEY, GATEFORGE_APPROVED_POLICY_DIGEST: pin };
}

/** Seals the authoritative changed-slice receipt for the current worktree. */
async function sealScopedReceipt(repo: TempRepo, env: Record<string, string>): Promise<void> {
  const run = await runCli(repo, ['test-gates', '--changed', '--scope', 'changed', '--format', 'json'], env);
  expect(run.code, `${run.stdout}\n${run.stderr}`).toBe(0);
}

/** Runs the command the generated commit hook runs. */
async function runStagedCheck(repo: TempRepo, env: Record<string, string>) {
  return runCli(repo, ['check', '--staged', '--require-e2e', '--format', 'json'], env);
}

describe('F2 adoption mode: the first commit that wires the gate', () => {
  it('commits through the real hook on a scoped receipt for the same candidate tree', async () => {
    const app = await startEvidenceApp();
    try {
      await withTempRepo({}, async (repo) => {
        await installUngated(repo, app.url);
        const env = await stageAdoptionCommit(repo);
        await sealScopedReceipt(repo, env);

        const run = await runStagedCheck(repo, env);
        const output = `${run.stdout}\n${run.stderr}`;

        const report = JSON.parse(run.stdout) as Report;
        // F2 delivers exactly this: the scoped receipt for the SAME
        // candidate tree is accepted, where it was refused as a scope
        // mismatch before.
        expect(
          report.blocking.map((entry) => entry.cause ?? ''),
          output,
        ).not.toContain('EVIDENCE_SCOPE_INCOMPLETE');
        expect(output).toContain('receipt-verified');
        // The adopted debt is still REPORTED — nothing is hidden — and it
        // is no longer re-graded blocking: this change set is
        // product-behaviour-neutral (gate wiring, config, manifest, runner
        // configuration, mapping sidecar, specs — no resource source), the
        // candidate IS an adoption commit, and the owner pin is enforced.
        expect(output).toContain(UNTOUCHED_DEBT);
        expect(verdictOf(report, UNTOUCHED_DEBT), output).toBe('waived');
        expect(report.summary.blocking).toBe(0);
        // The whole point of the fix: the first commit that wires the gate
        // commits through the generated hook, with no bypass.
        expect(run.code, output).toBe(0);
      });
    } finally {
      await app.close();
    }
  }, 240_000);

  it('one changed product source re-grades the adopted debt, and its own obligation stays covered', async () => {
    const app = await startEvidenceApp();
    try {
      await withTempRepo({}, async (repo) => {
        await installUngated(repo, app.url);
        // The same adoption commit plus ONE changed product resource
        // source. The added comment line is one the fixture plugin skips,
        // so the resource — and the proof the sealed receipt carries for
        // it — is exactly as it was. The ONLY difference is the
        // attribution: a discovered resource's own source is product
        // behaviour, so the change set is no longer neutral.
        const env = await stageAdoptionCommit(repo, {
          [ADOPTED_SOURCE]: `${ADOPTED_NAMES[0]} fixture.table\n# touched by the adoption commit\n`,
        });
        await sealScopedReceipt(repo, env);

        const run = await runStagedCheck(repo, env);
        const output = `${run.stdout}\n${run.stderr}`;
        const report = JSON.parse(run.stdout) as Report;

        // The obligation the change DOES newly claim is covered — the
        // scoped receipt proves it, so no scope blocker is raised for it.
        expect(
          report.blocking.map((entry) => entry.cause ?? ''),
          output,
        ).not.toContain('EVIDENCE_SCOPE_INCOMPLETE');
        // What blocks is the adopted debt, re-graded by strict E2E.
        expect(verdictOf(report, UNTOUCHED_DEBT), output).toBe('missing');
        expect(report.summary.blocking).toBeGreaterThan(0);
        expect(run.code, output).not.toBe(0);
      });
    } finally {
      await app.close();
    }
  }, 240_000);

  it('the same neutral change set in a LATER commit is judged exactly as today', async () => {
    const app = await startEvidenceApp();
    try {
      await withTempRepo({}, async (repo) => {
        await installUngated(repo, app.url);
        await stageAdoptionCommit(repo);
        await sealScopedReceipt(repo, gateEnv(trustedPolicyDigestForConfig(repo.root, loadConfig(repo.path('.gateforge.yml')))));
        // The adoption commit lands. From here HEAD has a gate, so the
        // condition can never hold again.
        repo.commitFiles({}, 'adopt the gate');

        // A later commit with the SAME neutral kinds — a manifest, the
        // mapping sidecar, the runner configuration and a catalog spec,
        // no product source. The comment appended to the spec is one the
        // runner ignores, so the proof is unchanged: the change set is
        // still product-behaviour-neutral.
        repo.writeFiles({
          'package.json': `${JSON.stringify({ name: 'fixture', private: true, devDependencies: { '@playwright/test': '1.0.1' } }, null, 2)}\n`,
          '.gateforge/test-map.yml': `${evidenceTestMap(ADOPTED_NAMES)}# reviewed together with the runner config\n`,
          'playwright.config.mjs':
            "export default { testDir: 'e2e', projects: [{ name: 'chromium' }] };\n// the headed wrapper\n",
        });
        for (const [file, body] of Object.entries(evidenceSpecs(ADOPTED_NAMES))) {
          repo.writeFiles({ [file]: `${body}\n// reviewed\n` });
        }
        repo.stage();
        // The mapping sidecar is a policy input: the owner re-approves the
        // revision this commit introduces, exactly as they must.
        const env = gateEnv(
          trustedPolicyDigestForConfig(repo.root, loadConfig(repo.path('.gateforge.yml'))),
        );
        await sealScopedReceipt(repo, env);

        const run = await runStagedCheck(repo, env);
        const output = `${run.stdout}\n${run.stderr}`;
        const report = JSON.parse(run.stdout) as Report;

        // Unchanged behaviour: adoption mode is one-shot, so this commit is
        // judged like every later one — the expanded scope demands
        // full-scope coverage, and the adopted debt is re-graded blocking.
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

  it('without the owner pin there is no forgiveness at all', async () => {
    const app = await startEvidenceApp();
    try {
      await withTempRepo({}, async (repo) => {
        await installUngated(repo, app.url);
        await stageAdoptionCommit(repo);
        // The very same neutral adoption commit, judged with no
        // owner-approved pin. The forgiveness is conditioned on the same
        // `evaluateApprovedPolicy(...).status === 'enforced'` the 0.9.0
        // rule used, so with no pin nothing is forgiven and the candidate
        // is refused before it is graded.
        const run = await runCli(repo, ['check', '--staged', '--require-e2e', '--format', 'json'], {
          GATEFORGE_WITNESS_VERIFIER_KEY: VERIFIER_KEY,
        });
        const output = `${run.stdout}\n${run.stderr}`;

        expect(run.code, output).not.toBe(0);
        expect(output).toContain('ENFORCEMENT_UNTRUSTED');
        expect(output).toContain('no owner-approved policy digest is provisioned');
      });
    } finally {
      await app.close();
    }
  }, 240_000);

  it('still refuses a changed file no obligation or gate input explains', async () => {
    const app = await startEvidenceApp();
    try {
      await withTempRepo({}, async (repo) => {
        await installUngated(repo, app.url);
        // Adoption mode narrows which obligations must be PROVEN. It never
        // excuses an unmapped product change.
        const env = await stageAdoptionCommit(repo, { [UNMAPPED_PRODUCT_FILE]: 'export const tier = 1;\n' });
        await sealScopedReceipt(repo, env);

        const run = await runStagedCheck(repo, env);
        const report = JSON.parse(run.stdout) as Report;
        const output = `${run.stdout}\n${run.stderr}`;

        expect(
          report.blocking.filter((entry) => entry.cause === 'CHANGE_UNMAPPED').map((entry) => entry.name),
          output,
        ).toEqual([UNMAPPED_PRODUCT_FILE]);
        expect(run.code, output).not.toBe(0);
      });
    } finally {
      await app.close();
    }
  }, 240_000);
});

describe('R7 adoption mode is one-shot: a repository that already has a gate keeps full scope', () => {
  it('a scoped receipt is refused once HEAD carries the gate', async () => {
    const app = await startEvidenceApp();
    try {
      await withTempRepo({}, async (repo) => {
        await installUngated(repo, app.url);
        const env = await stageAdoptionCommit(repo);
        await sealScopedReceipt(repo, env);
        // The adoption commit lands. From here HEAD has a gate.
        repo.commitFiles({}, 'adopt the gate');

        // A later commit touches a gate-defining input (`package.json`) and
        // a product source, so the scope expands to every obligation while
        // the affordable run still proves only the affected one.
        repo.writeFiles({
          'package.json': `${JSON.stringify({ name: 'fixture', private: true, devDependencies: { '@playwright/test': '1.0.1' } }, null, 2)}\n`,
          [ADOPTED_SOURCE]: `${ADOPTED_NAMES[0]} fixture.table\n# the model gained a column\n`,
        });
        repo.stage();
        await sealScopedReceipt(repo, env);

        const run = await runStagedCheck(repo, env);
        const output = `${run.stdout}\n${run.stderr}`;

        expect(run.code, output).not.toBe(0);
        expect(output).toMatch(/EVIDENCE_SCOPE_INCOMPLETE|scoped receipt covers/);
        // The obligation the slice cannot reach is the one that was
        // already there before adoption.
        expect(output).toContain(UNTOUCHED_DEBT);
      });
    } finally {
      await app.close();
    }
  }, 240_000);

  it('deleting the generated hook is a policy-input change the owner must re-approve', async () => {
    // §9: the escape hatch "commit the deletion of your own hook, then
    // re-enter adoption mode" must not exist. Two facts make it not
    // exist: the hook is a Gateforge-owned policy input (so deleting it
    // is a governed change, never an unmapped one), and it sits inside
    // the trusted policy digest, so removing it moves the approved
    // revision and the owner's pin stops matching.
    await withTempRepo({}, async (repo) => {
      repo.writeFiles({
        '.gateforge.yml': configYml(),
        '.gateforge/policies.yml': POLICIES_YML,
        '.gateforge/classification-policy.yml': CLASSIFICATION_POLICY_YML,
        'plugin.mjs': PLUGIN_SOURCE,
        [HOOK_PATH]: '// generated by gateforge\n',
      });
      const config = loadConfig(repo.path('.gateforge.yml'));
      expect(gateforgeOwnedInput(HOOK_PATH, config)?.kind).toBe('wiring');

      const withHook = trustedPolicyDigestForConfig(repo.root, config);
      repo.writeFiles({ [HOOK_PATH]: '' });
      expect(trustedPolicyDigestForConfig(repo.root, config)).not.toBe(withHook);
    });
  });
});

describe('R8 a newly claimed obligation without sealed evidence is refused', () => {
  it('an adoption commit that introduces an obligation nothing proves cannot commit', async () => {
    const app = await startEvidenceApp();
    try {
      await withTempRepo({}, async (repo) => {
        await installUngated(repo, app.url);
        // A THIRD resource joins the adoption commit with no spec and no
        // sidecar row: the commit newly claims an obligation that nothing
        // sealed proves.
        const env = await stageAdoptionCommit(repo, {
          'src/invoices.txt': 'invoices fixture.table\n',
          '.gateforge/adapters/invoices.mjs': evidenceAdapter(app.url),
        });

        const seal = await runCli(repo, ['test-gates', '--changed', '--scope', 'changed', '--format', 'json'], env);
        const sealOutput = `${seal.stdout}\n${seal.stderr}`;
        expect(seal.code, sealOutput).not.toBe(0);
        expect(sealOutput).toContain('tenant.invoices:persistence:read');

        const run = await runStagedCheck(repo, env);
        const output = `${run.stdout}\n${run.stderr}`;
        expect(run.code, output).not.toBe(0);
        expect(output).toMatch(/RUN_INCOMPLETE|no gate receipt/);
      });
    } finally {
      await app.close();
    }
  }, 240_000);
});

describe('R9 the owner pin still governs the adoption commit', () => {
  it('an unstaged weakening of the staged policy is refused', async () => {
    const app = await startEvidenceApp();
    try {
      await withTempRepo({}, async (repo) => {
        await installUngated(repo, app.url);
        const env = await stageAdoptionCommit(repo);
        // The worktree weakens the policy AFTER the index was frozen. The
        // run digests the worktree, the check digests the index: the two
        // disagree, and the receipt the run sealed is bound to neither.
        repo.writeFiles({ '.gateforge.yml': fixtureConfig('off') });
        const seal = await runCli(repo, ['test-gates', '--changed', '--scope', 'changed', '--format', 'json'], env);
        // The run digests the WORKTREE and refuses before it spends a
        // suite on a candidate the owner never approved.
        expect(seal.code, `${seal.stdout}\n${seal.stderr}`).not.toBe(0);
        expect(`${seal.stdout}\n${seal.stderr}`).toContain('ENFORCEMENT_UNTRUSTED');

        const run = await runStagedCheck(repo, env);
        const output = `${run.stdout}\n${run.stderr}`;
        // The commit gate is refused as well, and it never reaches a
        // verified receipt: the run that would have sealed one refused the
        // owner pin, so there is no receipt for this candidate at all
        // (`RUN_INCOMPLETE`). Nothing about the unstaged weakening is
        // forgiven, and the debt forgiveness never applies either.
        expect(run.code, output).not.toBe(0);
        expect(output).toContain('RUN_INCOMPLETE');
        expect(output).not.toContain('receipt-verified');
      });
    } finally {
      await app.close();
    }
  }, 240_000);
});

describe('R10 the guide and the generated hook name the same command', () => {
  it('TEST-ENVIRONMENT.md points a commit at check --staged, the command the hook runs', () => {
    const guides = fileURLToPath(new URL('../guides/', import.meta.url));
    const guide = readFileSync(join(guides, 'TEST-ENVIRONMENT.md'), 'utf8');
    // The contradiction this replaces: the guide told the reader to verify
    // a commit with `check --changed --require-e2e` while the generated
    // hook runs `check --staged`.
    expect(guide).toContain('check --staged');
    expect(guide).not.toContain('Then run `gateforge check --changed --require-e2e` on the same inputs.');
  });

  it('QUICKSTART.md commits the first gate through the hook, with no bypass', () => {
    const guides = fileURLToPath(new URL('../guides/', import.meta.url));
    const quickstart = readFileSync(join(guides, 'QUICKSTART.md'), 'utf8');
    expect(quickstart).toMatch(/gateforge check --staged/);
    expect(quickstart).toMatch(/without (?:a )?bypass|without --no-verify/i);
  });
});

describe('0.10.2: an adoption commit may carry the tooling the runner configuration names', () => {
  it('a config-named reporter and a declared tool script commit with exit 0', async () => {
    const app = await startEvidenceApp();
    try {
      await withTempRepo({}, async (repo) => {
        await installUngated(repo, app.url);
        // The two files a real first adoption commit carried and 0.10.1
        // refused: a custom reporter the runner configuration NAMES but
        // no test imports, and a developer script under `scripts/e2e/`
        // that only `package.json` names. Neither is a policy input, a
        // test file or test infrastructure, so before this fix both were
        // `CHANGE_UNMAPPED` and the owner had to bypass the hook.
        const env = await stageAdoptionCommit(repo, {
          '.gateforge.yml': fixtureConfig('strict', ['scripts/e2e/**']),
          'playwright.config.mjs':
            "export default { testDir: 'e2e', projects: [{ name: 'chromium' }], reporter: [['./reporting/adoption-reporter.js']] };\n",
          // Outside every test directory on purpose: only the runner
          // configuration's own `reporter:` path can attribute this file,
          // and `scripts/e2e/guard.sh` only the declared glob can.
          'reporting/adoption-reporter.js': 'export default (result) => result;\n',
          'scripts/e2e/guard.sh': '#!/bin/sh\nexit 0\n',
        });
        await sealScopedReceipt(repo, env);

        const run = await runStagedCheck(repo, env);
        const output = `${run.stdout}\n${run.stderr}`;
        const report = JSON.parse(run.stdout) as Report;

        expect(report.blocking.map((entry) => entry.cause ?? ''), output).not.toContain('CHANGE_UNMAPPED');
        expect(report.summary.blocking, output).toBe(0);
        expect(run.code, output).toBe(0);
      });
    } finally {
      await app.close();
    }
  }, 240_000);
});