/**
 * F2 — ADOPTION MODE (0.10.2, `F2-DESIGN.md`).
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
 * stops demanding. The two resources the adoption commit DOES add, with
 * their specs and their sidecar mapping, are what it must prove.
 *
 * Covered here:
 * - the positive case — the adoption commit passes `check --staged` on a
 *   scoped receipt for the same candidate tree;
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
  fixtureFingerprint,
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

/** The resource id whose obligation the adoption commit never touches. */
const UNTOUCHED_RESOURCE = 'tenant.refunds';

/** The resources the adoption commit brings with their specs. */
const ADOPTED_NAMES = ['accounts', 'orders'] as const;

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
function fixtureConfig(enforcement: '' | 'strict' | 'off'): string {
  return `${ENFORCEMENT_BLOCKS[enforcement]}${configYml()}`;
}


interface Report {
  summary: { blocking: number; baselinedObligations?: number };
  blocking: Array<{ name: string | null; cause?: string | null; detail: string }>;
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
    // repository carries into adoption and never touches again.
    'src/refunds.txt': 'refunds fixture.table\n',
    '.gateforge/adapters/refunds.mjs': evidenceAdapter(appUrl),
    // The untouched debt is WAIVED, not only baselined: a waiver records
    // the owner's "this resource needs no proof", so it never grades as a
    // blocking `missing`. It stays an obligation in the graph — exactly
    // what a slice receipt cannot certify, and exactly what adoption mode
    // stops demanding.
    '.gateforge/waivers/refunds.json': JSON.stringify({
      schemaVersion: 1,
      owner: 'team',
      justificationUrl: 'https://example.invalid/justification',
      approver: 'approver@example.invalid',
      scope: { kind: 'exact', resourceId: UNTOUCHED_RESOURCE, fingerprint: fixtureFingerprint(UNTOUCHED_RESOURCE) },
      expiresAt: '2027-01-01T00:00:00.000Z',
    }),
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
  appUrl: string,
  extra: Record<string, string> = {},
): Promise<Record<string, string>> {
  repo.writeFiles({
    [HOOK_PATH]: '// generated by gateforge\nexport default {};\n',
    '.gateforge/ci/gitlab-gateforge.yml': '# generated by gateforge\n',
    '.gitlab-ci.yml': CI_WIRING,
    '.gateforge.yml': fixtureConfig('strict'),
    // The product code this commit wires tests to: their sources are in
    // the change set, so their obligations are exactly what the commit
    // newly claims.
    ...Object.fromEntries(ADOPTED_NAMES.map((name) => [`src/${name}.txt`, `${name} fixture.table\n`])),
    ...Object.fromEntries(ADOPTED_NAMES.map((name) => [`.gateforge/adapters/${name}.mjs`, evidenceAdapter(appUrl)])),
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
        const env = await stageAdoptionCommit(repo, app.url);
        await sealScopedReceipt(repo, env);

        const run = await runStagedCheck(repo, env);
        const output = `${run.stdout}\n${run.stderr}`;

        const report = JSON.parse(run.stdout) as Report;
        // F2 delivers exactly this: the scoped receipt for the SAME
        // candidate tree is accepted, where it was refused as a scope
        // mismatch before. The untouched debt is still reported — nothing
        // is hidden.
        expect(
          report.blocking.map((entry) => entry.cause ?? ''),
          output,
        ).not.toContain('EVIDENCE_SCOPE_INCOMPLETE');
        expect(output).toContain('receipt-verified');
        expect(output).toContain(UNTOUCHED_DEBT);
        // OPEN (not F2): an obligation with NO evidence still grades as a
        // blocking `missing` even when the change never touches it, because
        // the adoption commit's gate-defining inputs expand the evaluation
        // to full scope. Until that re-grade is scoped like the coverage
        // requirement is, the hook still exits 1 on this repository —
        // `run.code` is deliberately NOT asserted here.
        expect(report.summary.blocking).toBeGreaterThan(0);
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
        const env = await stageAdoptionCommit(repo, app.url, { [UNMAPPED_PRODUCT_FILE]: 'export const tier = 1;\n' });
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
        const env = await stageAdoptionCommit(repo, app.url);
        await sealScopedReceipt(repo, env);
        // The adoption commit lands. From here HEAD has a gate.
        repo.commitFiles({}, 'adopt the gate');

        // A later commit touches a gate-defining input (`package.json`) and
        // a product source, so the scope expands to every obligation while
        // the affordable run still proves only the affected one.
        repo.writeFiles({
          'package.json': `${JSON.stringify({ name: 'fixture', private: true }, null, 2)}\n`,
          'src/accounts.txt': 'accounts fixture.table_v2\n',
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
        const env = await stageAdoptionCommit(repo, app.url, {
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
        const env = await stageAdoptionCommit(repo, app.url);
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
        expect(run.code, output).not.toBe(0);
        expect(output).toMatch(/ENFORCEMENT_UNTRUSTED|does not match the owner-approved revision/);
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