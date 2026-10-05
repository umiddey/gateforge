/**
 * 0.10.2: the docs-only slice seals a ZERO-RECORD receipt.
 *
 * The defect this replaces: after a repository's first witnessed adoption
 * commit, a commit whose WHOLE changed set is `docs/**.md` could not pass.
 * `check --staged` refused with `evidence-context: durable attestation
 * inputDigest does not match the current input snapshot` (the previous run's
 * envelope is bound to the previous bytes), and the prescribed repair
 * `test-gates --changed --scope changed` refused with
 * `--scope changed produced no runnable slice` — nothing ran, so no receipt
 * was sealed, so the next check saw the same stale envelope. The only other
 * route was a full-scope run.
 *
 * What the engine now does: the docs-only exemption (engine-owned, the
 * narrow decision in `scope.ts`) extends to EVIDENCE. When it is the scope
 * decision, `test-gates --changed --scope changed` seals a receipt for the
 * CURRENT candidate with zero records, `scope: 'changed'`, marked as the
 * docs-only slice and bound to the current input digest, candidate tree and
 * trusted policy digest exactly as any receipt. `check --staged` then finds a
 * current receipt.
 *
 * What it must NOT become: the empty receipt satisfies NO obligation. A later
 * product change still needs its own evidence, and any non-docs file in the
 * change keeps today's refusal byte-for-byte.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig, withTempRepo, type TempRepo } from '@gate-forge/core';
import {
  CLASSIFICATION_POLICY_YML,
  PLUGIN_SOURCE,
  POLICIES_YML,
  configYml,
  installFixture,
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
import { computeEvaluationScope } from '../src/scope.js';

/** The generated pre-commit hook `init --blocking` installs. */
const HOOK_PATH = '.gateforge/hooks/gateforge-check.mjs';

/** The pre-existing obligation no test claims and adoption never touches. */
const UNTOUCHED_DEBT = 'tenant.refunds:persistence:read';

/** The resources whose specs and mapping the adoption commit adds. */
const ADOPTED_NAMES = ['accounts', 'orders'] as const;

/** One product source whose bytes a later commit changes. */
const ADOPTED_SOURCE = `src/${ADOPTED_NAMES[0]}.txt`;

/**
 * The fixture plugin plus one detector FINDING — non-obligation policy
 * debt. A finding lands in the RAW policy blocking list (`kind:
 * 'finding'`) and never in any verdict, so `gateforge adopt` records it
 * in the baseline exactly as it records a verdict fingerprint while the
 * raw list stays non-empty for the rest of the repository's life. That
 * is the shape a real adopted repository has.
 */
const FINDING_PLUGIN_SOURCE = PLUGIN_SOURCE.replace(
  'return { resources, unresolved: [], findings: [], classificationSignals, scannedPaths };',
  'return { resources, unresolved: [], findings: [{ code: "PARTIAL_DISCOVERY", detail: "fixture finding: one route unverified", locations: [{ file: "src/accounts.txt", line: 1, col: 0 }] }], classificationSignals, scannedPaths };',
);

interface Report {
  summary: { blocking: number };
  verdicts: Array<{ obligationId: string; verdict: string; reason: string | null; cause: string | null }>;
  blocking: Array<{ name: string | null; cause?: string | null; detail: string }>;
}

interface SealedReceipt {
  scope?: 'full' | 'changed';
  docsOnly?: boolean;
  coveredObligationFingerprints?: string[];
  inputDigest: string;
  candidateTreeId: string | null;
  verdictSummary: { total: number; satisfied: number; waived: number; blocking: number };
}

/** The gate environment a scoped run and the staged check share. */
function gateEnv(pin: string): Record<string, string> {
  return { GATEFORGE_WITNESS_VERIFIER_KEY: VERIFIER_KEY, GATEFORGE_APPROVED_POLICY_DIGEST: pin };
}

/**
 * The owner pin for the STAGED bytes, taken LAST (after `git add`) because
 * `check --staged` digests the index while `test-gates` digests the worktree.
 */
function pinFor(repo: TempRepo): Record<string, string> {
  return gateEnv(trustedPolicyDigestForConfig(repo.root, loadConfig(repo.path('.gateforge.yml'))));
}

/** A repository with product code and NO gate at HEAD. */
async function installUngated(
  repo: TempRepo,
  appUrl: string,
  pluginSource: string = PLUGIN_SOURCE,
): Promise<void> {
  repo.writeFiles({
    '.gitignore': '.gateforge/test-gates/\n',
    '.gateforge.yml': configYml(),
    '.gateforge/policies.yml': POLICIES_YML,
    '.gateforge/classification-policy.yml': CLASSIFICATION_POLICY_YML,
    'plugin.mjs': pluginSource,
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
 * wires tests to. Returns the owner pin for the staged bytes.
 */
async function stageAdoptionCommit(repo: TempRepo): Promise<Record<string, string>> {
  repo.writeFiles({
    [HOOK_PATH]: '// generated by gateforge\nexport default {};\n',
    '.gateforge/ci/gitlab-gateforge.yml': '# generated by gateforge\n',
    '.gateforge.yml': `mode: changed\nenforcement:\n  strictE2E: true\n${configYml()}`,
    'package.json': `${JSON.stringify({ name: 'fixture', private: true, devDependencies: { '@playwright/test': '1.0.0' } }, null, 2)}\n`,
    ...evidenceSpecs(ADOPTED_NAMES),
    '.gateforge/test-map.yml': evidenceTestMap(ADOPTED_NAMES),
    'playwright.config.mjs': "export default { testDir: 'e2e', projects: [{ name: 'chromium' }] };\n",
  });
  const adopted = await runCli(repo, ['adopt']);
  expect(adopted.code, `${adopted.stdout}\n${adopted.stderr}`).toBe(0);
  repo.stage();
  return pinFor(repo);
}

/** Seals the authoritative changed-slice receipt for the current worktree. */
async function sealScopedReceipt(repo: TempRepo, env: Record<string, string>): Promise<void> {
  const run = await runCli(repo, ['test-gates', '--changed', '--scope', 'changed', '--format', 'json'], env);
  expect(run.code, `${run.stdout}\n${run.stderr}`).toBe(0);
}

/** The command the generated commit hook runs, on the exact staged bytes. */
async function runStagedCheck(repo: TempRepo, env: Record<string, string>) {
  return runCli(repo, ['check', '--staged', '--require-e2e', '--format', 'json'], env);
}

/** The sealed receipt document in the run state, or null. */
function sealedReceipt(repo: TempRepo): SealedReceipt | null {
  try {
    return JSON.parse(
      readFileSync(join(repo.root, '.gateforge/test-gates/receipt.json'), 'utf8'),
    ) as SealedReceipt;
  } catch {
    return null;
  }
}

describe('0.10.2 the docs-only slice seals a zero-record receipt', () => {
  it('a docs-only staged change re-seals and commits through the real hook', async () => {
    const app = await startEvidenceApp();
    try {
      await withTempRepo({}, async (repo) => {
        await installUngated(repo, app.url);
        const env = await stageAdoptionCommit(repo);
        await sealScopedReceipt(repo, env);
        // The adoption commit lands: from here HEAD carries the gate.
        repo.commitFiles({}, 'adopt the gate');

        // A later commit whose WHOLE changed set is one `docs/**.md` file.
        repo.writeFiles({ 'docs/gateforge-notes.md': '# Notes\n\nA later documentation-only edit.\n' });
        repo.stage();

        // The prescribed repair now works: it exits 0 and seals a
        // zero-record receipt bound to the CURRENT candidate.
        const seal = await runCli(repo, ['test-gates', '--changed', '--scope', 'changed'], env);
        const sealOutput = `${seal.stdout}\n${seal.stderr}`;
        expect(seal.code, sealOutput).toBe(0);
        expect(sealOutput).not.toContain('EVIDENCE_SCOPE_INCOMPLETE');

        const receipt = sealedReceipt(repo);
        expect(receipt, sealOutput).not.toBeNull();
        expect(receipt?.scope).toBe('changed');
        // Marked as the docs-only slice, and it covers NOTHING.
        expect(receipt?.docsOnly).toBe(true);
        expect(receipt?.coveredObligationFingerprints ?? []).toEqual([]);
        // Bound to the current inputs exactly as any receipt.
        expect(receipt?.verdictSummary).toEqual({ total: 0, satisfied: 0, waived: 0, blocking: 0 });
        expect(receipt?.candidateTreeId).toMatch(/^[0-9a-f]{40}$/);

        // And the commit gate accepts it.
        const run = await runStagedCheck(repo, env);
        const output = `${run.stdout}\n${run.stderr}`;
        const report = JSON.parse(run.stdout) as Report;

        expect(output).not.toContain('evidence-context');
        expect(report.summary.blocking, output).toBe(0);
        expect(run.code, output).toBe(0);
      });
    } finally {
      await app.close();
    }
  }, 240_000);

  it('seals over an adopted baseline that also holds non-obligation policy debt', async () => {
    const app = await startEvidenceApp();
    try {
      await withTempRepo({}, async (repo) => {
        // A repository whose adopted debt is NOT only missing obligations:
        // the detector finding is a blocking ENTRY, so the RAW policy
        // blocking list stays non-empty after adoption, forever.
        await installUngated(repo, app.url, FINDING_PLUGIN_SOURCE);
        const env = await stageAdoptionCommit(repo);
        await sealScopedReceipt(repo, env);
        repo.commitFiles({}, 'adopt the gate');

        repo.writeFiles({ 'docs/gateforge-notes.md': '# Notes\n\nA later documentation-only edit.\n' });
        repo.stage();

        const seal = await runCli(repo, ['test-gates', '--changed', '--scope', 'changed'], env);
        const sealOutput = `${seal.stdout}\n${seal.stderr}`;
        expect(seal.code, sealOutput).toBe(0);
        expect(sealOutput).toContain('sealed for the docs-only slice');
        expect(sealOutput).not.toContain('EVIDENCE_SCOPE_INCOMPLETE');

        const receipt = sealedReceipt(repo);
        expect(receipt, sealOutput).not.toBeNull();
        expect(receipt?.docsOnly, sealOutput).toBe(true);
        expect(receipt?.coveredObligationFingerprints ?? []).toEqual([]);
        expect(receipt?.verdictSummary).toEqual({ total: 0, satisfied: 0, waived: 0, blocking: 0 });

        // The commit gate accepts it: the adopted policy debt is graded
        // against the baseline, exactly as for every other commit.
        const run = await runStagedCheck(repo, env);
        const output = `${run.stdout}\n${run.stderr}`;
        const report = JSON.parse(run.stdout) as Report;

        expect(output).not.toContain('evidence-context');
        expect(report.summary.blocking, output).toBe(0);
        expect(run.code, output).toBe(0);
      });
    } finally {
      await app.close();
    }
  }, 240_000);

  it('a docs change plus one non-docs file is judged exactly as today', async () => {
    const app = await startEvidenceApp();
    try {
      await withTempRepo({}, async (repo) => {
        await installUngated(repo, app.url);
        const env = await stageAdoptionCommit(repo);
        await sealScopedReceipt(repo, env);
        repo.commitFiles({}, 'adopt the gate');

        // MIXED: the docs-only exemption is denied as soon as ONE
        // non-docs file is in the change (candidate-controlled
        // suppression must stay impossible), so this is an ordinary
        // scoped slice — it runs its one affected test and seals a
        // receipt that covers a real obligation.
        repo.writeFiles({
          'docs/gateforge-notes.md': '# Notes\n',
          [ADOPTED_SOURCE]: `${ADOPTED_NAMES[0]} fixture.table\n# the model gained a column\n`,
        });
        repo.stage();

        const seal = await runCli(repo, ['test-gates', '--changed', '--scope', 'changed'], env);
        const sealOutput = `${seal.stdout}\n${seal.stderr}`;
        expect(seal.code, sealOutput).toBe(0);
        expect(sealOutput).not.toContain('EVIDENCE_SCOPE_INCOMPLETE');

        // The docs-only marking must NOT leak into a mixed change: the
        // receipt is an ordinary scoped one covering the affected
        // obligation, exactly as before the fix.
        const receipt = sealedReceipt(repo);
        expect(receipt?.docsOnly, sealOutput).toBeUndefined();
        expect(receipt?.scope).toBe('changed');
        expect(receipt?.coveredObligationFingerprints ?? []).not.toEqual([]);
      });
    } finally {
      await app.close();
    }
  }, 240_000);

  it("a documentation file outside `docs/` keeps today's refusal", async () => {
    const app = await startEvidenceApp();
    try {
      await withTempRepo({}, async (repo) => {
        await installUngated(repo, app.url);
        const env = await stageAdoptionCommit(repo);
        await sealScopedReceipt(repo, env);
        repo.commitFiles({}, 'adopt the gate');

        // Markdown at the repository root is NOT the engine-owned docs
        // exemption: only `docs/**.md` is, and the decision must not widen.
        repo.writeFiles({ 'README.md': '# Fixture\n\nA root README edit.\n' });
        repo.stage();

        const seal = await runCli(repo, ['test-gates', '--changed', '--scope', 'changed'], env);
        const sealOutput = `${seal.stdout}\n${seal.stderr}`;
        expect(seal.code, sealOutput).not.toBe(0);
        expect(sealOutput).toContain('--scope changed produced no runnable slice');
        expect(sealOutput).toContain('README.md');
        expect(sealedReceipt(repo)).toBeNull();
      });
    } finally {
      await app.close();
    }
  }, 240_000);

  it('the empty receipt satisfies no obligation in a later product change', async () => {
    const app = await startEvidenceApp();
    try {
      await withTempRepo({}, async (repo) => {
        await installUngated(repo, app.url);
        const env = await stageAdoptionCommit(repo);
        await sealScopedReceipt(repo, env);
        repo.commitFiles({}, 'adopt the gate');

        // Seal the docs-only receipt for this candidate.
        repo.writeFiles({ 'docs/gateforge-notes.md': '# Notes\n' });
        repo.stage();
        const docsSeal = await runCli(repo, ['test-gates', '--changed', '--scope', 'changed'], env);
        expect(docsSeal.code, `${docsSeal.stdout}\n${docsSeal.stderr}`).toBe(0);
        repo.commitFiles({}, 'a documentation-only edit');

        // A LATER product change touches a real resource source. The
        // zero-record receipt covers nothing, so it cannot stand in for the
        // evidence this change needs.
        repo.writeFiles({
          [ADOPTED_SOURCE]: `${ADOPTED_NAMES[0]} fixture.table\n# the model gained a column\n`,
        });
        repo.stage();
        const pin = pinFor(repo);

        const run = await runStagedCheck(repo, pin);
        const output = `${run.stdout}\n${run.stderr}`;
        const report = JSON.parse(run.stdout) as Report;

        // The docs-only receipt is bound to the previous bytes, so it is
        // stale here; and even a current one would cover no obligation.
        expect(report.blocking.map((entry) => entry.cause ?? ''), output).toContain('EVIDENCE_STALE');
        expect(report.verdicts.find((entry) => entry.obligationId === UNTOUCHED_DEBT)?.verdict).not.toBe(
          'satisfied',
        );
        expect(run.code, output).not.toBe(0);
      });
    } finally {
      await app.close();
    }
  }, 240_000);
});

describe('0.10.2 the docs-only decision is engine-owned and narrow', () => {
  it('`docs/**.md` alone is the exemption; nothing else joins it', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      const config = loadConfig(`${repo.root}/.gateforge.yml`);
      const decision = (changedFiles: string[]) =>
        computeEvaluationScope({ config, changedFiles, strictE2E: true });

      // The WHOLE changed set is `docs/**.md`: the exemption.
      expect(decision(['docs/a.md']).docsOnly).toBe(true);
      expect(decision(['docs/a.md', 'docs/nested/b.md']).docsOnly).toBe(true);
      // Anything else denies it — Markdown outside `docs/`, a
      // non-Markdown file under `docs/`, a mixed change, and an empty
      // change set (which is not a docs-only change at all).
      expect(decision(['README.md']).docsOnly).toBe(false);
      expect(decision(['docs/a.txt']).docsOnly).toBe(false);
      expect(decision(['docs/a.md', 'README.md']).docsOnly).toBe(false);
      expect(decision([]).docsOnly).toBe(false);
    });
  });
});