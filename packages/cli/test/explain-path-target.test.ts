/**
 * 0.9.0 problem 26: `gateforge explain <path>` explains what a non-resource
 * file IS and what governs it.
 *
 * What the bug was: a `CHANGE_UNMAPPED` blocker on `.gateforge/behavior.yml`
 * told the owner to "Run `gateforge explain .gateforge/behavior.yml`" — and
 * that command answered "no discovered resource matches", because it only
 * knew resource ids and names. The remediation pointed at a dead end.
 *
 * The fix: a repo-relative path is a first-class target. For a Gateforge
 * policy file the answer is the governed input; for an unclassified product
 * file it names the steps that actually attribute it. An unknown target
 * stays unknown (exit 1) — a path answer is never invented.
 */
import { describe, expect, it } from 'vitest';
import { withTempRepo } from '@gate-forge/core';
import { installFixture, runCli } from './helpers.js';

describe('explain on a repo-relative path', () => {
  it('explains a Gateforge policy file as a governed policy input', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      repo.commitFiles({}, 'base');

      const run = await runCli(repo, ['explain', '.gateforge/policies.yml']);

      expect(run.code, `${run.stdout}\n${run.stderr}`).toBe(0);
      expect(run.stdout).toContain('Gateforge-owned policy input');
      expect(run.stdout).toContain('owner-approved policy digest');
      // Never the old dead end.
      expect(run.stdout).not.toContain('no discovered resource matches');
    });
  }, 240_000);

  it('explains an unclassified product file with the steps that attribute it', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      repo.writeFiles({ 'src/orders/loyalty.js': 'export const tier = 1;\n' });
      repo.commitFiles({}, 'base');

      const run = await runCli(repo, ['explain', 'src/orders/loyalty.js']);

      expect(run.code, `${run.stdout}\n${run.stderr}`).toBe(0);
      expect(run.stdout).toContain('unclassified product file');
      expect(run.stdout).toContain('CHANGE_UNMAPPED');
      expect(run.stdout).toContain('gateforge init --docs-exclude <folders>');
      // 0.10.2: developer/CI tooling the repository declares in
      // `project.paths.testTooling` is the third route, and the remedy
      // has to name it — an owner cannot find a key nobody printed.
      expect(run.stdout).toContain('project.paths.testTooling');
    });
  }, 240_000);

  it('names the resources that read a known source file', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      repo.commitFiles({}, 'base');

      const run = await runCli(repo, ['explain', 'src/accounts.txt']);

      expect(run.code, `${run.stdout}\n${run.stderr}`).toBe(0);
      expect(run.stdout).toContain('known source of: accounts');
    });
  }, 240_000);

  it('still reports an unknown target as unknown', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      repo.commitFiles({}, 'base');

      const run = await runCli(repo, ['explain', 'no-such-thing']);

      expect(run.code).toBe(1);
      expect(run.stderr).toContain("no discovered resource matches 'no-such-thing'");
    });
  }, 240_000);
});