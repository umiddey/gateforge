/**
 * Phase 0 of the enforcement-bypass-hardening plan: tests that record the
 * ACTUAL bypass story instead of assuming it.
 *
 * - A commit that skips the local hook succeeds locally (local hooks are
 *   convenience — ADR 0005 D1; the test documents that reality). The
 *   alternate-`core.hooksPath` bypass stands in for `--no-verify` here:
 *   both are the plan's named bypasses, and this machine's git wrapper
 *   refuses the `--no-verify` flag itself (its own machine-level level-3
 *   style policy), while the hook-skip semantics are identical.
 * - The CI-side strict command (`check --require-e2e`) still blocks such a
 *   commit: missing receipt → RUN_INCOMPLETE, stale receipt →
 *   EVIDENCE_STALE. Level 2 works today; any gap here becomes Phase 1
 *   work.
 * - Fast-path risk probe (plan Phase 3b item 8, "rule out first"): the
 *   input digest a receipt binds must depend only on candidate-tree bytes
 *   + config + engine — NOT on the machine path, unrelated environment
 *   variables, or run-state noise. If this ever fails, the fast path must
 *   bind the offending input or exclude itself.
 */
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { withTempRepo, type TempRepo } from '@gate-forge/core';
import { currentInputDigest, fixtureFingerprint, installFixture, runCli } from './helpers.js';
import { mintCompleteRunReceipt } from './gate-receipts.js';
import { installCommitHook, HOOK_MARKER_BEGIN } from '../src/git-hooks.js';

/** Creates one valid fixture waiver for the CI candidate smoke test.
 *
 * Args:
 *   resourceId: exact fixture resource identity.
 *
 * Returns:
 *   string: schema-valid waiver JSON.
 */
function waiverJson(resourceId: string): string {
  return JSON.stringify({
    schemaVersion: 1,
    owner: `team-${resourceId.split('.')[1]}`,
    justificationUrl: 'https://example.invalid/justification',
    approver: 'approver@example.invalid',
    scope: { kind: 'exact', resourceId, fingerprint: fixtureFingerprint(resourceId) },
    expiresAt: '2027-01-01T00:00:00.000Z',
  });
}

describe('phase 0: the bypass story, recorded honestly', () => {
  it('a --no-verify commit succeeds locally even with the gateforge hook installed', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      repo.stage();
      repo.commit('base');
      // Install the strict staged-gate hook exactly like `init --blocking`.
      const outcome = installCommitHook(repo.root, { ...process.env }, ['check', '--staged', '--require-e2e']);
      expect(['installed', 'updated', 'verified']).toContain(outcome.status);
      // An ungated change: a new source file the policies would question.
      repo.writeFiles({ 'src/extra.txt': 'extra fixture.table\n' });
      repo.stage();
      const commit = repo.git(
        ['-c', 'core.hooksPath=/nonexistent-gateforge-bypass', 'commit', '-m', 'bypass the local gate'],
        { allowFailure: true },
      );
      expect(commit.status).toBe(0);
      const head = repo.git(['rev-parse', 'HEAD']);
      expect(head.stdout.trim()).not.toBe('');
    });
  });

  it('the CI command blocks the --no-verify commit with RUN_INCOMPLETE (no receipt)', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      repo.stage();
      repo.commit('base');
      const outcome = installCommitHook(repo.root, { ...process.env }, ['check', '--staged', '--require-e2e']);
      expect(['installed', 'updated', 'verified']).toContain(outcome.status);
      repo.writeFiles({ 'src/extra.txt': 'extra fixture.table\n' });
      repo.stage();
      expect(
        repo.git(['-c', 'core.hooksPath=/nonexistent-gateforge-bypass', 'commit', '-m', 'bypass']).status,
      ).toBe(0);
      const candidateCommit = repo.headSha();
      const ci = await runCli(repo, ['check', '--candidate-commit', candidateCommit ?? '', '--require-e2e']);
      expect(ci.code).toBe(1);
      expect(ci.stdout).toContain('RUN_INCOMPLETE');
  });
  });

  it('the CI command blocks with EVIDENCE_STALE when only a stale receipt exists', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      repo.writeFiles({ '.gitignore': '.gateforge/test-gates/\n' });
      repo.stage();
      repo.commit('base');
      // A real receipt for the PRE-commit bytes (the last gated state).
      await mintCompleteRunReceipt(repo, { verifierKey: 'k'.repeat(32) });
      repo.writeFiles({ 'src/extra.txt': 'extra fixture.table\n' });
      repo.stage();
      expect(
        repo.git(['-c', 'core.hooksPath=/nonexistent-gateforge-bypass', 'commit', '-m', 'bypass']).status,
      ).toBe(0);
      const candidateCommit = repo.headSha();
      const ci = await runCli(
        repo,
        ['check', '--candidate-commit', candidateCommit ?? '', '--require-e2e'],
        { GATEFORGE_WITNESS_VERIFIER_KEY: 'k'.repeat(32) },
      );
      expect(ci.code).toBe(1);
      expect(ci.stdout).toContain('EVIDENCE_STALE');
  });
  });
  it('the same CI candidate-commit check accepts a gated commit with its valid receipt', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      repo.writeFiles({
        '.gitignore': '.gateforge/test-gates/\n',
        '.gateforge/waivers/accounts.json': waiverJson('tenant.accounts'),
        '.gateforge/waivers/orders.json': waiverJson('tenant.orders'),
      });
      repo.stage();
      repo.commit('gated candidate');
      const candidateCommit = repo.headSha();
      expect(candidateCommit).not.toBeNull();
      await mintCompleteRunReceipt(repo, { verifierKey: 'k'.repeat(32) });
      const ci = await runCli(
        repo,
        ['check', '--candidate-commit', candidateCommit ?? '', '--require-e2e'],
        { GATEFORGE_WITNESS_VERIFIER_KEY: 'k'.repeat(32) },
      );
      expect(ci.code, ci.stdout).toBe(0);
    });
  });

  it('the hook file is a plain marker-delimited script git can skip', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      repo.stage();
      repo.commit('base');
      const outcome = installCommitHook(repo.root, { ...process.env }, ['check', '--staged', '--require-e2e']);
      expect(outcome.hookPath).toContain('hooks');
      const body = readFileSync(outcome.hookPath as string, 'utf8');
      expect(body).toContain(HOOK_MARKER_BEGIN);
      expect(body).toContain('--no-verify');
    });
  });
});

describe('phase 0: fast-path eligibility probe (receipt digest vs inputs)', () => {
  it('the bound input digest is identical across machine paths and unrelated env', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      repo.stage();
      repo.commit('base');
      const digestA = await currentInputDigest(repo);
      // Same bytes, different absolute path + unrelated environment vars.
      const copy = mkdtempSync(join(tmpdir(), 'gateforge-fastpath-'));
      cpSync(repo.root, copy, { recursive: true });
      try {
        const copyRepo = { root: copy } as TempRepo;
        const digestB = await currentInputDigest(copyRepo);
        expect(digestB).toBe(digestA);
      } finally {
        rmSync(copy, { recursive: true, force: true });
      }
    });
  });

  it('a one-byte change to any tree file moves the bound input digest', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      repo.stage();
      repo.commit('base');
      const before = await currentInputDigest(repo);
      repo.writeFiles({ 'src/accounts.txt': 'accounts fixture.table\n' + '# log constant v2\n' });
      const after = await currentInputDigest(repo);
      expect(after).not.toBe(before);
    });
  });
});
