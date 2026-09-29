/**
 * `gateforge run` on the example app (managed-run plan, Part B).
 *
 * The whole point of the command is that ONE invocation reproduces a
 * witnessed proof locally: preflight, the app's own recipe, the
 * supervised suite, the strict receipt check, and the teardown. The
 * fixture is shared with the witnessed CI job template test.
 */
import { readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { withTempRepo } from '@gate-forge/core';
import { startAttestationProxy } from '@gate-forge/pack-playwright';
import { trustedPolicyDigestForConfig } from '../src/execution.js';
import { loadConfigAt } from '../src/commands/common.js';
import { runCli } from './helpers.js';
import {
  cleanupWitnessedFixture,
  FINGERPRINT,
  installStrictFixture,
  operatorEnvironment,
  recipeSteps,
  startApp,
  writeTinyRecipe,
} from './witnessed-run-fixture.js';

afterEach(() => {
  cleanupWitnessedFixture();
});

describe('gateforge run (the whole local proof, in order)', () => {
  it('sequences preflight, the recipe, the supervised suite and the strict check to a green receipt', async () => {
    const { env } = operatorEnvironment();
    await withTempRepo({}, async (repo) => {
      writeTinyRecipe(repo);
      installStrictFixture(repo);
      repo.git(['add', '-A']);
      repo.git(['commit', '--no-gpg-sign', '--quiet', '-m', 'managed run fixture']);
      // The genuine candidate change under test (obligations still bind it).
      repo.writeFiles({ 'src/accounts.js': '// fixture source: the accounts resource lives here.\n// change: audited comment.\n' });
      const app = await startApp();
      const proxy = await startAttestationProxy(app.url, FINGERPRINT);
      try {
        const config = loadConfigAt(repo.root);
        const runEnv = {
          ...env,
          GATEFORGE_APP_BASE_URL: proxy.url,
          GATEFORGE_TARGET_BASE_URL: proxy.url,
          GATEFORGE_TARGET_FINGERPRINT: FINGERPRINT,
          GATEFORGE_APPROVED_POLICY_DIGEST: trustedPolicyDigestForConfig(repo.root, config),
        };
        const result = await runCli(repo, ['run', '--', '--changed'], runEnv);
        expect(result.code, `run stdout:\n${result.stdout}\nstderr:\n${result.stderr}`).toBe(0);
        // One plain line per step, in lifecycle order, with a duration.
        const steps = result.stdout
          .split('\n')
          .filter((line) => line.startsWith('  [step] '))
          .map((line) => line.replace('  [step] ', '').replace(/: [\d.]+m?s$/, ''));
        expect(steps).toEqual(['preflight', 'reset', 'test-gates', 'check --require-e2e', 'services_down']);
        expect(result.stdout).toContain('gateforge run: complete');
        expect(recipeSteps(repo)).toEqual(['reset', 'services_down']);
        // The receipt is the engine's, not the sequencer's: the strict
        // check inside the run verified it, and it landed in the
        // user's own worktree.
        const receipt = JSON.parse(readFileSync(join(repo.root, '.gateforge/test-gates/receipt.json'), 'utf8')) as {
          approvedPolicyDigest: string;
          verifierKeyId: string;
        };
        expect(receipt.approvedPolicyDigest).toBe(runEnv.GATEFORGE_APPROVED_POLICY_DIGEST);
        expect(receipt.verifierKeyId).toBe('managed-run-key');
      } finally {
        await proxy.stop();
        app.stop();
      }
    });
  }, 600_000);

  it('stops at a failing recipe step with that step\'s own exit code, and still tears down', async () => {
    const { env } = operatorEnvironment();
    await withTempRepo({}, async (repo) => {
      installStrictFixture(repo);
      writeTinyRecipe(repo, 7);
      repo.git(['add', '-A']);
      repo.git(['commit', '--no-gpg-sign', '--quiet', '-m', 'managed run fixture']);
      const result = await runCli(repo, ['run'], { ...env });
      expect(result.code).toBe(7);
      expect(result.stderr).toContain("recipe step 'reset' failed with exit 7");
      expect(result.stdout).toContain('[step] services_down:');
      expect(recipeSteps(repo)).toEqual(['reset', 'services_down']);
      // The supervised run never started, so there is no receipt to trust.
      expect(existsSync(join(repo.root, '.gateforge/test-gates/receipt.json'))).toBe(false);
    });
  });

  it('a failing preflight stops the run before any recipe step executes', async () => {
    const { env } = operatorEnvironment();
    await withTempRepo({}, async (repo) => {
      installStrictFixture(repo);
      writeTinyRecipe(repo);
      const result = await runCli(repo, ['run'], { ...env, GATEFORGE_APPROVED_POLICY_DIGEST: '0'.repeat(64) });
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('run: preflight failed');
      expect(result.stderr).toContain('approved-policy');
      expect(recipeSteps(repo)).toEqual([]);
    });
  });
});
