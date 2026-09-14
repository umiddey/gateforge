/**
 * Staged-candidate verification (plan 2026-09-13 Phase 5 items 3–4, ADR
 * 0005 D1): `check --staged` gates the EXACT staged bytes — never the
 * working tree, never a fallback. Real git throughout (no git mocks):
 *
 * - THE plan example: staged broken change + unstaged fixed working copy
 *   → the gate runs the staged bytes and BLOCKS; the repaired staged
 *   bytes pass; the user's worktree/index are never touched.
 * - index mutation during the run → typed ENFORCEMENT_UNTRUSTED block.
 * - partial staging gates exactly the staged byte set.
 * - filenames with spaces/newlines (NUL-delimited git data), staged
 *   deletions and renames.
 * - initial commits (unborn HEAD) and in-progress merge commits.
 * - symlinks in the candidate → explicit typed block.
 */
import { existsSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { withTempRepo, type TempRepo } from '@gateforge/core';
import { fixtureFingerprint, runCli, installFixture, PLUGIN_SOURCE } from './helpers.js';
import {
  freezeStagedCandidate,
  materializeStagedCandidate,
  recheckStagedCandidate,
  releaseStagedCandidate,
} from '../src/staged-candidate.js';

/** Sanitized env for direct staged-candidate module calls. */
function gitEnv(): NodeJS.ProcessEnv {
  return { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
}

/** Fixture repo with both source resources present at HEAD. */
function installCommittedFixture(repo: TempRepo): void {
  installFixture(repo);
  repo.stage();
  repo.commit('base');
}

describe('freezeStagedCandidate / recheckStagedCandidate (identity, parents, drift)', () => {
  it('freezes the index tree id (matching git write-tree), HEAD parent, and rechecks clean', () =>
    withTempRepo({}, (repo) => {
      installCommittedFixture(repo);
      repo.writeFiles({ 'src/accounts.txt': 'accounts fixture.table\n# staged edit\n' });
      repo.stage(['src/accounts.txt']);

      const frozen = freezeStagedCandidate(repo.root, gitEnv());
      try {
        const expectedTree = repo.git(['write-tree']).stdout.trim();
        expect(frozen.treeId).toBe(expectedTree);
        expect(frozen.headSha).toBe(repo.headSha());
        expect(frozen.parentShas).toEqual([repo.headSha()]);
        expect(frozen.mergeHeadSha).toBeNull();
        expect(frozen.changed.map((change) => change.path)).toEqual(['src/accounts.txt']);
        expect(frozen.changedPaths).toEqual(['src/accounts.txt']);
        expect(recheckStagedCandidate(repo.root, gitEnv(), frozen)).toEqual({ ok: true });
      } finally {
        releaseStagedCandidate(frozen);
      }
    }));

  it('detects index mutation during the run as a typed ENFORCEMENT_UNTRUSTED drift', () =>
    withTempRepo({}, (repo) => {
      installCommittedFixture(repo);
      const frozen = freezeStagedCandidate(repo.root, gitEnv());
      try {
        expect(recheckStagedCandidate(repo.root, gitEnv(), frozen)).toEqual({ ok: true });
        // The candidate moves UNDER the frozen gate: a new file is staged.
        repo.writeFiles({ 'src/late.txt': 'late fixture.table\n' });
        repo.stage(['src/late.txt']);
        const recheck = recheckStagedCandidate(repo.root, gitEnv(), frozen);
        expect(recheck.ok).toBe(false);
        if (recheck.ok === false) {
          expect(recheck.detail).toContain('changed during verification');
        }
      } finally {
        releaseStagedCandidate(frozen);
      }
    }));

  it('records MERGE_HEAD as the second parent of an in-progress merge', () =>
    withTempRepo({}, (repo) => {
      installCommittedFixture(repo);
      repo.git(['checkout', '-b', 'feature']);
      repo.commitFiles({ 'feature.txt': 'feature\n' }, 'feature work');
      repo.git(['checkout', 'main']);
      repo.commitFiles({ 'main-only.txt': 'main\n' }, 'main work');
      repo.git(['merge', '--no-commit', '--no-ff', 'feature']);
      const mergeHead = repo.git(['rev-parse', 'feature']).stdout.trim();

      const frozen = freezeStagedCandidate(repo.root, gitEnv());
      try {
        expect(frozen.headSha).toBe(repo.headSha());
        expect(frozen.mergeHeadSha).toBe(mergeHead);
        expect(frozen.parentShas).toEqual([repo.headSha(), mergeHead]);
        expect(recheckStagedCandidate(repo.root, gitEnv(), frozen)).toEqual({ ok: true });
      } finally {
        releaseStagedCandidate(frozen);
      }
    }));

  it('handles staged deletions, renames, and NUL-unsafe filenames (spaces, newlines)', () =>
    withTempRepo({}, (repo) => {
      installCommittedFixture(repo);
      repo.writeFiles({ 'src/doomed.txt': 'doomed fixture.table\n' });
      repo.stage(['src/doomed.txt']);
      repo.commit('add doomed');
      repo.git(['mv', 'src/orders.txt', 'src/orders renamed.txt']);
      writeFileSync(repo.path('src/with space.txt'), 'spacey fixture.table\n');
      writeFileSync(repo.path('src/multi\nline.txt'), 'multiline fixture.table\n');
      repo.git(['add', 'src/with space.txt', 'src/multi\nline.txt']);
      repo.git(['rm', '--cached', '--quiet', 'src/doomed.txt']);

      const frozen = freezeStagedCandidate(repo.root, gitEnv());
      try {
        const byPath = new Map(frozen.changed.map((change) => [change.path, change]));
        expect(byPath.get('src/orders renamed.txt')).toMatchObject({
          status: 'R',
          oldPath: 'src/orders.txt',
        });
        expect(byPath.get('src/doomed.txt')).toMatchObject({ status: 'D' });
        expect(byPath.get('src/with space.txt')).toMatchObject({ status: 'A' });
        expect(byPath.get('src/multi\nline.txt')).toMatchObject({ status: 'A' });
        expect(frozen.changedPaths).toEqual(
          expect.arrayContaining([
            'src/orders.txt',
            'src/orders renamed.txt',
            'src/with space.txt',
            'src/multi\nline.txt',
          ]),
        );
        // Materialization carries the exact bytes to the isolated checkout.
        const checkout = materializeStagedCandidate(repo.root, gitEnv(), frozen);
        expect(existsSync(join(checkout, 'src', 'with space.txt'))).toBe(true);
        expect(existsSync(join(checkout, 'src', 'multi\nline.txt'))).toBe(true);
        expect(existsSync(join(checkout, 'src', 'orders renamed.txt'))).toBe(true);
        expect(existsSync(join(checkout, 'src', 'doomed.txt'))).toBe(false);
        expect(readFileSync(join(checkout, 'src', 'with space.txt'), 'utf8')).toBe('spacey fixture.table\n');
        expect(recheckStagedCandidate(repo.root, gitEnv(), frozen)).toEqual({ ok: true });
      } finally {
        releaseStagedCandidate(frozen);
      }
    }));

  it('supports initial commits: unborn HEAD freezes the empty-tree base with no parents', () =>
    withTempRepo({}, (repo) => {
      installFixture(repo);
      repo.stage();
      expect(repo.headSha()).toBeNull();

      const frozen = freezeStagedCandidate(repo.root, gitEnv());
      try {
        expect(frozen.headSha).toBeNull();
        expect(frozen.mergeHeadSha).toBeNull();
        expect(frozen.parentShas).toEqual([]);
        expect(frozen.changedPaths).toEqual(expect.arrayContaining(['.gateforge.yml', 'src/accounts.txt']));
        const checkout = materializeStagedCandidate(repo.root, gitEnv(), frozen);
        expect(existsSync(join(checkout, '.gateforge.yml'))).toBe(true);
      } finally {
        releaseStagedCandidate(frozen);
      }
    }));

  it('blocks symlink candidates with a typed error (explicit block, never a fallback)', () =>
    withTempRepo({}, (repo) => {
      installCommittedFixture(repo);
      symlinkSync('/etc/hostname', repo.path('src/link.txt'));
      repo.git(['add', 'src/link.txt']);

      expect(() => freezeStagedCandidate(repo.root, gitEnv())).toThrowError(/symlink/);
    }));
});

describe('check --staged gates the exact staged candidate (CLI)', () => {
  /** A valid, unexpired owner waiver for one fixture obligation. */
  function waiverJson(resourceId: string): string {
    return JSON.stringify({
      schemaVersion: 1,
      owner: 'team-' + resourceId.split('.')[1],
      justificationUrl: 'https://example.invalid/justification',
      approver: 'approver@example.invalid',
      scope: { kind: 'exact', resourceId, fingerprint: fixtureFingerprint(resourceId) },
      expiresAt: '2027-01-01T00:00:00.000Z',
    });
  }

  /**
   * Single-resource fixture (accounts only) whose base state is CLEAN
   * (the resource is present, adapted, and owner-waived) — so the only
   * thing that can move the gate is WHICH bytes it evaluates.
   */
  function installCleanSingleResourceFixture(repo: TempRepo): void {
    installFixture(repo);
    rmSync(repo.path('src/orders.txt'));
    rmSync(repo.path('.gateforge/adapters/orders.mjs'));
    repo.writeFiles({ '.gateforge/waivers/accounts.json': waiverJson('tenant.accounts') });
    repo.stage();
    repo.commit('base');
  }

  it('THE plan example: staged broken bytes block while the unstaged fixed worktree passes', () =>
    withTempRepo({}, async (repo) => {
      installCleanSingleResourceFixture(repo);
      const base = await runCli(repo, ['check']);
      expect(base.code).toBe(0); // sanity: the base state is clean

      // STAGED: broken bytes (the resource line vanishes — the analog of a
      // broken delete function). UNSTAGED: the fixed working copy
      // (restored line). Two different candidates, one index.
      repo.writeFiles({ 'src/accounts.txt': '# temporarily broken\n' });
      repo.stage(['src/accounts.txt']);
      repo.writeFiles({ 'src/accounts.txt': 'accounts fixture.table\n' });
      expect(repo.git(['status', '--porcelain']).stdout.trim()).toBe('MM src/accounts.txt');

      // The gate runs the STAGED bytes (resource gone → the adapter
      // reference is stale) and BLOCKS…
      const blocked = await runCli(repo, ['check', '--staged']);
      expect(blocked.code).toBe(1);
      expect(blocked.stdout).toContain("stale adapter reference 'accounts'");
      // …grading staged bytes only: the missing obligation of the fixed
      // WORKTREE bytes is nowhere in the staged gate's verdicts.
      expect(blocked.stdout).not.toContain('[missing]');
      // …even though the working tree (different bytes) is clean.
      const worktree = await runCli(repo, ['check']);
      expect(worktree.code).toBe(0);

      // The gate never touched the user's worktree or index.
      expect(readFileSync(repo.path('src/accounts.txt'), 'utf8')).toBe('accounts fixture.table\n');
      expect(repo.git(['diff', '--cached', '--name-only']).stdout.trim()).toBe('src/accounts.txt');

      // Repair the STAGED bytes: the same candidate now passes.
      repo.stage(['src/accounts.txt']);
      const repaired = await runCli(repo, ['check', '--staged']);
      expect(repaired.code).toBe(0);
    }));

  it('blocks with a typed cause when the index mutates during the run', () =>
    withTempRepo({}, async (repo) => {
      // The fixture plugin mutates the USER's index mid-gate (git add of a
      // new file) — exactly the concurrent-staging adversary.
      const mutatingPlugin = PLUGIN_SOURCE.replace(
        "import { readFileSync } from 'node:fs';",
        "import { readFileSync } from 'node:fs';\nimport { spawnSync } from 'node:child_process';",
      ).replace(
        'export default {',
        `export default {\n  drift: spawnSync('git', ['add', 'src/extra.txt'], { cwd: ${JSON.stringify(repo.root)} }),`,
      );
      installFixture(repo);
      repo.writeFiles({ 'plugin.mjs': mutatingPlugin });
      repo.stage();
      repo.commit('base');
      // A staged change so the candidate is non-trivial; the extra file is
      // untracked at freeze time and joins the index only DURING the run.
      repo.writeFiles({ 'src/accounts.txt': 'accounts fixture.table\n# staged edit\n' });
      repo.writeFiles({ 'src/extra.txt': 'extra fixture.table\n' });
      repo.stage(['src/accounts.txt']);

      const result = await runCli(repo, ['check', '--staged']);
      expect(repo.stagedFiles()).toContain('src/extra.txt'); // the mutation happened
      expect(result.code).toBe(1);
      expect(result.stdout).toContain('staged-candidate gate: BLOCKED');
      expect(result.stdout).toContain('ENFORCEMENT_UNTRUSTED');
      expect(result.stdout).toContain('changed during verification');
    }));

  it('gates exactly the partially staged byte set (worktree-only changes are invisible)', () =>
    withTempRepo({}, async (repo) => {
      installFixture(repo);
      rmSync(repo.path('src/orders.txt'));
      rmSync(repo.path('.gateforge/adapters/orders.mjs'));
      repo.stage();
      repo.commit('base');
      // STAGED: a comment-only touch (same resource set as HEAD).
      // WORKTREE: adds a whole new accounts2 resource — which the gate
      // must NEVER see, because only the accounts file is staged.
      repo.writeFiles({ 'src/accounts.txt': 'accounts fixture.table\n# staged touch\n' });
      repo.stage(['src/accounts.txt']);
      repo.writeFiles({
        'src/accounts.txt': 'accounts fixture.table\n# staged touch\naccounts2 fixture.table\n',
      });

      const result = await runCli(repo, ['check', '--staged', '--format', 'json']);
      expect(result.code).toBe(1);
      const report = JSON.parse(result.stdout) as {
        verdicts: Array<{ obligationId: string; verdict: string }>;
      };
      // Exactly the staged candidate's obligation is graded…
      expect(report.verdicts.map((verdict) => verdict.obligationId)).toEqual([
        'tenant.accounts:persistence:read',
      ]);
      // …and NEVER the worktree-only accounts2 bytes (different candidate).
      expect(result.stdout).not.toContain('accounts2');
    }));

  it('gates an initial-commit candidate (unborn HEAD) end to end', () =>
    withTempRepo({}, async (repo) => {
      installFixture(repo);
      repo.stage();
      const result = await runCli(repo, ['check', '--staged']);
      // Every file is new: the gate-defining inputs expand the scope and
      // the unwaived fixture obligations block (exit 1, never a pass).
      expect(result.code).toBe(1);
      expect(result.stdout).toContain('tenant.accounts:persistence:read');
      expect(result.stdout).toContain('tenant.orders:persistence:read');
    }));

  it('blocks symlink candidates via the CLI with cause + next action', () =>
    withTempRepo({}, async (repo) => {
      installCommittedFixture(repo);
      symlinkSync('/etc/hostname', repo.path('src/link.txt'));
      repo.git(['add', 'src/link.txt']);
      const result = await runCli(repo, ['check', '--staged']);
      expect(result.code).toBe(1);
      expect(result.stdout).toContain('staged-candidate gate: BLOCKED');
      expect(result.stdout).toContain('ENFORCEMENT_UNTRUSTED');
      expect(result.stdout).toContain('symlink');
      expect(result.stdout).toContain('next action:');
    }));
});
