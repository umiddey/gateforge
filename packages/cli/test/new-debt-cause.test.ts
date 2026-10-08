/**
 * THE `[NEW_DEBT]` ENTRY MUST NAME WHY A COMMIT IS BLOCKED (0.11.0).
 *
 * A diff-scoped report ends with one footer that answers a single
 * question: what does THIS change still have to prove, and which command
 * settles it? After `gateforge adopt`, a DEPENDENCY UPGRADE — `package.json`
 * and the lockfile, the two gate-defining inputs, and nothing else —
 * carries no product behaviour, so the debt `adopt` recorded is forgiven
 * and no obligation newly owes proof. The entry used to say exactly that:
 *
 *   this change adds 0 unproven obligations: <none>.
 *   Run `gateforge test-gates --changed`. [NEW_DEBT]
 *
 * …while the commit was BLOCKED, for a completely different reason: the
 * receipt the previous run sealed was sealed against the OLD manifest
 * bytes, so its evidence-context `inputDigest` no longer matches the
 * current input snapshot, and old evidence cannot certify changed
 * configuration. The entry therefore blocked the commit while its whole
 * text said there was nothing to prove, and pointed at a command for a
 * problem it never described.
 *
 * What must hold (nothing here relaxes what blocks):
 * - the commit is STILL blocked, on the evidence-context cause;
 * - the `[NEW_DEBT]` entry names THAT cause and the command that fixes
 *   it (`gateforge test-gates --changed`, which re-seals);
 * - the string `0 unproven obligations: <none>` never reaches a report;
 * - running exactly that command, and nothing else, makes the SAME
 *   staged change pass — the entry names the one command that works;
 * - the JSON `newDebt` document is untouched: the count of newly-unproven
 *   obligations really is 0, and that is a fact, not a message.
 */
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

/** The resources whose specs and mapping the adoption commit adds. */
const ADOPTED_NAMES = ['accounts', 'orders'] as const;

/** The obligation no test claims and adoption records as debt. */
const UNTOUCHED_DEBT = 'tenant.refunds:persistence:read';

/** The dependency the manifest and the lockfile agree on. */
function dependencyFiles(version: string): Record<string, string> {
  return {
    'package.json': `${JSON.stringify(
      { name: 'fixture', private: true, devDependencies: { '@playwright/test': version } },
      null,
      2,
    )}\n`,
    'package-lock.json': `${JSON.stringify(
      {
        name: 'fixture',
        lockfileVersion: 3,
        packages: {
          '': { name: 'fixture', devDependencies: { '@playwright/test': version } },
          'node_modules/@playwright/test': { version },
        },
      },
      null,
      2,
    )}\n`,
  };
}

/** The environment a scoped run and the staged gate share. */
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

/**
 * A repository at HEAD with a gate, a pinned policy, an adopted baseline
 * and a receipt sealed over its bytes: the state of every repository the
 * day after setup. `adopt` records `tenant.refunds` as forgiven debt, so
 * a later neutral commit owes no NEW proof — the exact shape of the
 * defect this file covers.
 */
async function installAdoptedRepository(repo: TempRepo, appUrl: string): Promise<void> {
  repo.writeFiles({
    // `node_modules/` is deliberately NOT ignored: the stub runner is a
    // committed fixture file, as it is in every other evidence fixture.
    '.gitignore': '.gateforge/test-gates/\n',

    '.gateforge.yml': `mode: changed\nenforcement:\n  strictE2E: true\n${configYml()}`,
    '.gateforge/policies.yml': POLICIES_YML,
    '.gateforge/classification-policy.yml': CLASSIFICATION_POLICY_YML,
    'plugin.mjs': PLUGIN_SOURCE,
    'src/refunds.txt': 'refunds fixture.table\n',
    '.gateforge/adapters/refunds.mjs': evidenceAdapter(appUrl),
    ...Object.fromEntries(ADOPTED_NAMES.map((name) => [`src/${name}.txt`, `${name} fixture.table\n`])),
    ...Object.fromEntries(ADOPTED_NAMES.map((name) => [`.gateforge/adapters/${name}.mjs`, evidenceAdapter(appUrl)])),
    'node_modules/playwright/cli.js': evidenceStubCli(ADOPTED_NAMES),
  });
  repo.commitFiles({}, 'existing product code, no gate yet');

  // The ADOPTION COMMIT: the generated gate wiring, the specs, the mapping
  // sidecar, the runner configuration and the manifest — plus the two
  // documents this release moved owner answers into, so the adoption
  // commit is a 0.11-shaped repository from the start.
  repo.writeFiles({
    [HOOK_PATH]: '// generated by gateforge\nexport default {};\n',
    '.gateforge/ci/gitlab-gateforge.yml': '# generated by gateforge\n',
    '.gitlab-ci.yml': CI_WIRING,
    ...dependencyFiles('1.0.0'),
    ...evidenceSpecs(ADOPTED_NAMES, true),
    '.gateforge/test-map.yml': evidenceTestMap(ADOPTED_NAMES),
    'playwright.config.mjs': "export default { testDir: 'e2e', projects: [{ name: 'chromium' }] };\n",
  });
  const adopted = await runCli(repo, ['adopt']);
  expect(adopted.code, `${adopted.stdout}\n${adopted.stderr}`).toBe(0);
  repo.stage();
  const env = gateEnv(pinFor(repo));
  await sealScopedReceipt(repo, env);
  const first = await runCli(repo, ['check', '--staged', '--require-e2e', '--format', 'json'], env);
  expect(first.code, `${first.stdout}\n${first.stderr}`).toBe(0);
  repo.commitFiles({}, 'adopt the gate');
}

/**
 * THE COMMIT: upgrade the dependency and change NOTHING else. The
 * manifest and the lockfile are gate-defining inputs — so the change set
 * carries no product behaviour and the adopted debt is forgiven — and
 * they are exactly the bytes the sealed receipt's inputDigest bound.
 */
function writeDependencyUpgrade(repo: TempRepo): void {
  repo.writeFiles(dependencyFiles('1.0.1'));
  repo.stage();
}

describe('0.11.0 the [NEW_DEBT] entry names the cause instead of claiming there is nothing to prove', () => {
  it('a dependency-upgrade commit stays blocked, and the entry names the stale receipt', async () => {
    const app = await startEvidenceApp();
    try {
      await withTempRepo({}, async (repo) => {
        await installAdoptedRepository(repo, app.url);

        // The receipt above was sealed against `1.0.0`; this commit makes
        // it stale. Nothing is re-sealed, which is the whole point.
        writeDependencyUpgrade(repo);
        const env = gateEnv(pinFor(repo));

        const blocked = await runCli(repo, ['check', '--staged', '--require-e2e'], env);
        const output = `${blocked.stdout}\n${blocked.stderr}`;

        // 1. NOT relaxed: the commit is still refused, on the real cause.
        expect(blocked.code, output).not.toBe(0);
        expect(output).toContain('evidence-context');
        expect(output).toContain('inputDigest does not match the current input snapshot');

        // 2. The entry says what is actually wrong, and how to fix it.
        const entry = output.split('\n').find((line) => line.includes('[NEW_DEBT]'));
        expect(entry, output).toBeDefined();
        expect(entry as string).not.toContain('0 unproven obligations: <none>');
        expect(entry as string).toContain('no NEW unproven obligations');
        expect(entry as string).toContain('evidence-context');
        expect(entry as string).toContain('inputDigest does not match the current input snapshot');
        expect(entry as string).toContain('gateforge test-gates --changed');

        // 3. Running exactly the command the entry names — and nothing
        //    else — makes the SAME staged change pass. (`--scope changed`
        //    is not that command: the changed set holds no product
        //    source, so a changed-scoped run has no runnable slice.)
        const resealed = await runCli(repo, ['test-gates', '--changed'], env);
        expect(resealed.code, `${resealed.stdout}\n${resealed.stderr}`).toBe(0);
        const after = await runCli(repo, ['check', '--staged', '--require-e2e'], env);
        const afterOutput = `${after.stdout}\n${after.stderr}`;
        expect(after.code, afterOutput).toBe(0);
        expect(afterOutput).not.toContain('[NEW_DEBT]');
      });
    } finally {
      await app.close();
    }
  }, 240_000);

  it('the structured newDebt count is still the honest 0 on that same commit', async () => {
    const app = await startEvidenceApp();
    try {
      await withTempRepo({}, async (repo) => {
        await installAdoptedRepository(repo, app.url);
        writeDependencyUpgrade(repo);
        const env = gateEnv(pinFor(repo));

        // The message changed; the machine-readable document did not. The
        // count really is zero — no obligation newly owes proof, the
        // adopted debt is forgiven — and the blocking is carried by the
        // evidence-context entry beside it.
        const json = await runCli(repo, ['check', '--staged', '--require-e2e', '--format', 'json'], env);
        const output = `${json.stdout}\n${json.stderr}`;
        expect(json.code, output).not.toBe(0);
        const document = JSON.parse(json.stdout) as {
          newDebt?: { count: number; obligationIds: string[] };
          blocking: Array<{ detail: string }>;
          verdicts: Array<{ obligationId: string; verdict: string }>;
        };
        expect(document.newDebt).toEqual({ count: 0, obligationIds: [] });
        expect(
          document.blocking.some((entry) => entry.detail.startsWith('evidence-context:')),
          output,
        ).toBe(true);
        // The adopted debt is named, and forgiven — not silently absent.
        expect(
          document.verdicts.find((verdict) => verdict.obligationId === UNTOUCHED_DEBT)?.verdict,
          output,
        ).toBe('waived');
      });
    } finally {
      await app.close();
    }
  }, 240_000);
});