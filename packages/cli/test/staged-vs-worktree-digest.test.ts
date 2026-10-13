/**
 * R6 (0.10.2, U2): `check --staged` and `test-gates` digest DIFFERENT
 * trees. The commit gate digests the staged INDEX; `test-gates` digests the
 * WORKING TREE. While a policy input is modified-but-unstaged the two
 * compute different digests, so the single owner-approved pin that
 * satisfies the commit gate is refused here — and the remedy the commit
 * gate prints ("Run `gateforge test-gates --changed`") is exactly the
 * command this refusal blocks.
 *
 * What the fix owes the owner: the refusal must name the files that cause
 * it and a remedy that actually clears it. This test drives the real CLI
 * in exactly that state and asserts the diagnostic.
 *
 * `engine` class: real CLI in-process against a temp repository; the run
 * stops at the policy gate, before any test executes.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { loadConfig, withTempRepo, type TempRepo } from '@gate-forge/core';
import { configYml, installFixture, runCli, stubPlaywrightFiles } from './helpers.js';
import { ADAPTER, SPECS, STUB_CLI } from './reseal-e2e-fixture.js';
import { trustedPolicyDigestForConfig } from '../src/execution.js';

/** The policy input this test leaves modified-but-unstaged. */
const POLICY_INPUT = '.gateforge.yml';

/**
 * Installs a strict-E2E repository whose policy inputs are committed, so
 * the only difference left is the one each test creates.
 *
 * Args:
 *   repo: the fixture repository.
 */
function installStrictRepository(repo: TempRepo): void {
  installFixture(repo);
  repo.writeFiles({
    ...SPECS,
    '.gateforge/adapters/accounts.mjs': ADAPTER,
    '.gateforge/adapters/orders.mjs': ADAPTER,
    '.gateforge.yml': `enforcement:\n  strictE2E: true\n${configYml()}`,
    'playwright.config.mjs': "export default { testDir: 'e2e', projects: [{ name: 'chromium' }] };\n",
    ...stubPlaywrightFiles(STUB_CLI),
  });
  repo.commitFiles({}, 'base');
}

/** The digest of the committed (and therefore staged) policy revision. */
function committedDigest(repo: TempRepo): string {
  return trustedPolicyDigestForConfig(repo.root, loadConfig(repo.path(POLICY_INPUT)));
}

/**
 * Appends a comment to the policy input IN THE WORKING TREE only: the
 * index keeps the committed bytes, which is the exact split U2 reports.
 *
 * Args:
 *   repo: the fixture repository.
 */
function writeUnstaged(repo: TempRepo): void {
  const configPath = repo.path(POLICY_INPUT);
  writeFileSync(configPath, `${readFileSync(configPath, 'utf8')}# reviewed, not yet staged\n`, 'utf8');
}

describe('the two trees of one pipeline (U2)', () => {
  it('names the unstaged policy inputs and a remedy that clears the refusal', async () => {
    await withTempRepo({}, async (repo) => {
      installStrictRepository(repo);
      // The pin the owner approved: the INDEX revision (what
      // `check --staged` digests).
      const pin = committedDigest(repo);

      // The working tree moves on — a policy input edited but NOT staged.
      // `test-gates` digests these bytes, so no single pin satisfies both
      // commands from here on.
      writeUnstaged(repo);

      const run = await runCli(repo, ['test-gates', '--changed'], {
        GATEFORGE_APPROVED_POLICY_DIGEST: pin,
      });
      const output = `${run.stdout}\n${run.stderr}`;

      expect(run.code, output).toBe(1);
      expect(output).toContain('ENFORCEMENT_UNTRUSTED');
      // The cause, in the words of the two commands: which tree each one
      // digests, and therefore why one pin cannot satisfy both.
      expect(output).toContain('WORKING TREE');
      expect(output).toContain('STAGED INDEX');
      // The offending file is named — a pointer at the cause, not a loop
      // of "re-pin".
      expect(output).toContain(POLICY_INPUT);
      // And the remedy is one the owner can actually take in this state.
      expect(output).toMatch(/git add|commit or restore/);
    });
  }, 240_000);

  it('stays silent about the two trees when nothing policy-relevant is unstaged', async () => {
    await withTempRepo({}, async (repo) => {
      installStrictRepository(repo);
      const pin = committedDigest(repo);
      // A worktree edit to an ordinary product file: the policy revision
      // is the same in both trees, so an index/worktree split is not the
      // cause of anything this run reports.
      repo.writeFiles({ 'src/accounts/note.txt': 'a note\n' });

      const run = await runCli(repo, ['test-gates', '--changed'], {
        GATEFORGE_APPROVED_POLICY_DIGEST: pin,
      });
      const output = `${run.stdout}\n${run.stderr}`;

      // Whether the run itself blocks is beside the point; the diagnostic
      // must not blame a split that does not exist.
      expect(output).not.toContain('STAGED INDEX');
    });
  }, 240_000);
});