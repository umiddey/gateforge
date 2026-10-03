/** Regression coverage for the pre-commit policy gate ordering. */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { withTempRepo } from '@gate-forge/core';
import { readLastFullRunSummary, resolveStateDir, writeLastFullRunSummary, writeReport } from '../src/state.js';
import { formatCommitCostHint, writeCommitCostHint } from '../src/commands/pre-commit.js';
import { CaptureStream } from '../src/io.js';
import { installFixture, runCli } from './helpers.js';

describe('witnessed pre-commit trust ordering', () => {
  it('reports current test count and the last full-run duration', () => {
    expect(
      formatCommitCostHint(
        { execution: { selectedTests: { selected: 3 } } },
        { testCount: 20, durationMs: 90_000 },
      ),
    ).toBe('this commit needs 3 tests; last full run took 1.5 minutes.');
  });
  it('uses a safe fallback when no full-run duration is recorded', () => {
    expect(
      formatCommitCostHint({ execution: { selectedTests: { selected: 1 } } }, null),
    ).toBe('this commit needs 1 test; no full-run duration is recorded yet.');
    expect(formatCommitCostHint({}, null)).toBeNull();
  });

  it('stores parseable advisory full-run cost data', async () => {
    await withTempRepo({}, async (repo) => {
      const stateDir = resolveStateDir(repo.root);
      writeLastFullRunSummary(stateDir, { testCount: 20, durationMs: 90_000 });
      expect(readLastFullRunSummary(stateDir)).toEqual({ testCount: 20, durationMs: 90_000 });
    });
  });
  it('prints advisory cost context from the stored gate report', async () => {
    await withTempRepo({}, async (repo) => {
      const stateDir = resolveStateDir(repo.root);
      const stdout = new CaptureStream();
      writeReport(stateDir, JSON.stringify({ execution: { selectedTests: { selected: 3 } } }));
      writeLastFullRunSummary(stateDir, { testCount: 20, durationMs: 90_000 });
      writeCommitCostHint(
        { cwd: repo.root, env: {}, stdout, stderr: new CaptureStream() },
        stateDir,
      );
      expect(stdout.text()).toBe('this commit needs 3 tests; last full run took 1.5 minutes.\n');
    });
  });



  it('does not execute a staged prepare command when the policy pin mismatches', async () => {
    await withTempRepo({}, async (repo) => {
      const marker = repo.path('prepare-ran.out');
      installFixture(repo);
      repo.writeFiles({
        '.gateforge.yml': `${readFileSync(join(repo.root, '.gateforge.yml'), 'utf8')}runtime: .gateforge/runtime.yml\n`,
        '.gateforge/runtime.yml': [
          'schemaVersion: 1',
          'prepare:',
          '  command: node -e "require(\'fs\').writeFileSync(process.env.GATEFORGE_MARKER, \'ran\\n\')"',
          'envAllowlist: [GATEFORGE_MARKER]',
        ].join('\n'),
      });
      repo.git(['add', '-A']);
      repo.commit('runtime base');
      repo.writeFiles({ 'src/accounts.txt': 'accounts fixture.table\nchanged\n' });
      repo.git(['add', 'src/accounts.txt']);

      const result = await runCli(repo, ['pre-commit', '--scope', 'staged'], {
        GATEFORGE_MARKER: marker,
        GATEFORGE_APPROVED_POLICY_DIGEST: 'f'.repeat(64),
        GATEFORGE_WITNESS_VERIFIER_KEY: 'trust-order-test-key',
      });

      expect(result.code).toBe(1);
      expect(result.stdout + result.stderr).toContain('ENFORCEMENT_UNTRUSTED');
      expect(existsSync(marker)).toBe(false);
    });
  });

  it('does not execute a staged prepare command when check policy pin mismatches', async () => {
    await withTempRepo({}, async (repo) => {
      const marker = repo.path('check-prepare-ran.out');
      installFixture(repo);
      repo.writeFiles({
        '.gateforge.yml': `${readFileSync(join(repo.root, '.gateforge.yml'), 'utf8')}runtime: .gateforge/runtime.yml\n`,
        '.gateforge/runtime.yml': [
          'schemaVersion: 1',
          'prepare:',
          '  command: node -e "require(\'fs\').writeFileSync(process.env.GATEFORGE_MARKER, \'ran\\n\')"',
          'envAllowlist: [GATEFORGE_MARKER]',
        ].join('\n'),
      });
      repo.git(['add', '-A']);
      repo.commit('runtime base');
      repo.writeFiles({ 'src/accounts.txt': 'accounts fixture.table\nchanged\n' });
      repo.git(['add', 'src/accounts.txt']);

      const result = await runCli(repo, ['check', '--staged', '--require-e2e'], {
        GATEFORGE_MARKER: marker,
        GATEFORGE_APPROVED_POLICY_DIGEST: 'f'.repeat(64),
        GATEFORGE_WITNESS_VERIFIER_KEY: 'trust-order-test-key',
      });

      expect(result.code).toBe(1);
      expect(result.stdout + result.stderr).toContain('ENFORCEMENT_UNTRUSTED');
      expect(existsSync(marker)).toBe(false);
    });
  });
});
