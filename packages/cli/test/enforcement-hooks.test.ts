/**
 * Active pre-commit hook (plan 2026-09-13 Phase 5 items 1–2, ADR 0005
 * D1/D3): `init --blocking` installs AND verifies an ACTIVE hook, an
 * existing hook is preserved, the generated hook invokes the same strict
 * gate as CI against the EXACT staged candidate, and a REAL `git commit`
 * is blocked BEFORE commit creation without proof — and authorized with a
 * valid receipt for the exact bytes. Real git throughout; the commit legs
 * run the actual compiled CLI binary through the hook.
 */
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { withTempRepo, type TempRepo } from '@gate-forge/core';
import { runCli, installFixture } from './helpers.js';
import { mintCompleteRunReceipt } from './gate-receipts.js';
import {
  installCommitHook,
  PRE_COMMIT_HOOK_NAME,
  probeHookExecution,
  STAGED_GATE_SCRIPT_BASENAME,
  verifyHookActivation,
} from '../src/git-hooks.js';

/** The verifier key minting + verifying receipts in this suite. */
const VERIFIER_KEY = 'hook-suite-verifier-key';

/** Sanitized env for direct module calls. */
function gitEnv(): NodeJS.ProcessEnv {
  return { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
}

/** Absolute path of the compiled CLI bin (the hook's engine). */
function cliBinPath(): string {
  return fileURLToPath(new URL('../bin/gateforge.js', import.meta.url));
}

/** Fixed-identity env for REAL `git commit` runs that execute the hook. */
function commitEnv(extra: Record<string, string>): Record<string, string | undefined> {
  return {
    ...process.env,
    GIT_AUTHOR_NAME: 'gateforge fixtures',
    GIT_AUTHOR_EMAIL: 'fixtures@gateforge.invalid',
    GIT_COMMITTER_NAME: 'gateforge fixtures',
    GIT_COMMITTER_EMAIL: 'fixtures@gateforge.invalid',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    ...extra,
  };
}

interface CommitResult {
  status: number;
  stdout: string;
  stderr: string;
}

/** Runs a real `git commit` (hook executes) and returns combined output. */
function realCommit(repo: TempRepo, message: string, env: Record<string, string>): CommitResult {
  const result = spawnSync(
    'git',
    ['-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', message],
    { cwd: repo.root, env: commitEnv(env), encoding: 'utf8' },
  );
  return {
    status: result.status ?? -1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

/** Commit count on the current branch (`rev-list --count HEAD`). */
function commitCount(repo: TempRepo): number {
  const result = repo.git(['rev-list', '--count', 'HEAD'], { allowFailure: true });
  return result.status === 0 ? Number.parseInt(result.stdout.trim(), 10) : 0;
}

describe('installCommitHook (install AND verify an ACTIVE hook)', () => {
  it('installs into the resolved hooks dir, exec bit + marker + verified self-check', () =>
    withTempRepo({}, (repo) => {
      const outcome = installCommitHook(repo.root, gitEnv());
      expect(outcome.status).toBe('installed');
      const hookPath = join(repo.path('.git/hooks'), PRE_COMMIT_HOOK_NAME);
      expect(outcome.hookPath).toBe(hookPath);
      expect(existsSync(hookPath)).toBe(true);
      expect(statSync(hookPath).mode & 0o111).not.toBe(0);
      expect(readFileSync(hookPath, 'utf8')).toContain('check --staged --require-e2e');
      expect(verifyHookActivation(hookPath).ok).toBe(true);
      expect(probeHookExecution(hookPath).ok).toBe(true);
    }));

  it('is idempotent: a rerun verifies the same hook without rewriting it', () =>
    withTempRepo({}, (repo) => {
      const first = installCommitHook(repo.root, gitEnv());
      expect(first.status).toBe('installed');
      const hookPath = join(repo.path('.git/hooks'), PRE_COMMIT_HOOK_NAME);
      const before = readFileSync(hookPath, 'utf8');
      const second = installCommitHook(repo.root, gitEnv());
      expect(second.status).toBe('verified');
      expect(readFileSync(hookPath, 'utf8')).toBe(before);
    }));

  it('NEVER clobbers a foreign hook: typed conflict naming the exact chaining action', () =>
    withTempRepo({}, (repo) => {
      const hookPath = join(repo.path('.git/hooks'), PRE_COMMIT_HOOK_NAME);
      writeFileSync(hookPath, '#!/bin/sh\necho foreign hook runs\n', 'utf8');
      chmodSync(hookPath, 0o755);
      const outcome = installCommitHook(repo.root, gitEnv());
      expect(outcome.status).toBe('conflict');
      expect(readFileSync(hookPath, 'utf8')).toBe('#!/bin/sh\necho foreign hook runs\n');
      if (outcome.status === 'conflict') {
        expect(outcome.action).toContain(STAGED_GATE_SCRIPT_BASENAME);
        expect(outcome.action).toContain('|| exit 1');
      }
      // Not active: the foreign hook does not chain the gate yet.
      expect(verifyHookActivation(hookPath).ok).toBe(false);
    }));

  it('honors core.hooksPath when resolving the hooks directory', () =>
    withTempRepo({}, (repo) => {
      repo.git(['config', 'core.hooksPath', '.githooks']);
      const outcome = installCommitHook(repo.root, gitEnv());
      expect(outcome.status).toBe('installed');
      if (outcome.status !== 'incomplete' && outcome.hookPath !== null) {
        expect(outcome.hookPath).toBe(repo.path('.githooks/pre-commit'));
        expect(verifyHookActivation(outcome.hookPath).ok).toBe(true);
      }
    }));

  it('reports typed incomplete outside a Git repository', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'gateforge-nohook-'));
    try {
      const outcome = installCommitHook(scratch, gitEnv());
      expect(outcome.status).toBe('incomplete');
      expect(outcome.hookPath).toBeNull();
      if (outcome.status === 'incomplete') {
        expect(outcome.action).toContain('Git repository');
      }
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});

describe('init --blocking (CLI wiring of the active hook)', () => {
  it('installs and verifies the active hook; rerun is idempotent', () =>
    withTempRepo({}, async (repo) => {
      const first = await runCli(repo, ['init', '--blocking']);
      expect(first.code).toBe(0);
      expect(first.stdout).toContain('installed:');
      expect(first.stdout).toContain('--no-verify'); // the honest limit is stated
      const hookPath = join(repo.path('.git/hooks'), PRE_COMMIT_HOOK_NAME);
      expect(verifyHookActivation(hookPath).ok).toBe(true);

      const second = await runCli(repo, ['init', '--blocking']);
      expect(second.code).toBe(0);
      expect(second.stdout).toContain('verified:');
      // Still exactly one gateforge block in the hook file.
      const body = readFileSync(hookPath, 'utf8');
      expect(body.split('>>> gateforge pre-commit v1 >>>').length - 1).toBe(1);
    }));

  it('refuses with a typed incomplete installation when a foreign hook exists', () =>
    withTempRepo({}, async (repo) => {
      const hookPath = join(repo.path('.git/hooks'), PRE_COMMIT_HOOK_NAME);
      writeFileSync(hookPath, '#!/bin/sh\necho custom gate\n', 'utf8');
      chmodSync(hookPath, 0o755);
      const result = await runCli(repo, ['init', '--blocking']);
      expect(result.code).toBe(2);
      expect(result.stdout).toContain('incomplete installation');
      expect(result.stdout).toContain(STAGED_GATE_SCRIPT_BASENAME);
      expect(result.stderr).toContain('hook installation incomplete');
      // The foreign hook is untouched.
      expect(readFileSync(hookPath, 'utf8')).toBe('#!/bin/sh\necho custom gate\n');
    }));
});

describe('the hook gates real commits (end to end, real git + compiled CLI)', () => {
  it(
    'blocks a commit without proof BEFORE creation; authorizes the exact bytes with a receipt',
    async () => {
      await withTempRepo({}, async (repo) => {
        installFixture(repo);
        // A genuinely clean base: no resources (empty source files) and no
        // adapters, so nothing blocks the gate except the missing receipt.
        repo.writeFiles({ 'src/accounts.txt': '', 'src/orders.txt': '' });
        rmSync(repo.path('.gateforge/adapters/accounts.mjs'));
        rmSync(repo.path('.gateforge/adapters/orders.mjs'));
        repo.stage();
        repo.commit('base');
        const outcome = installCommitHook(repo.root, gitEnv());
        expect(outcome.status).toBe('installed');
        const env = { GATEFORGE_CLI: cliBinPath(), GATEFORGE_WITNESS_VERIFIER_KEY: VERIFIER_KEY };

        // One staged change, NO receipt: the hook runs the strict staged
        // gate (`check --staged --require-e2e`), which blocks with
        // RUN_INCOMPLETE — and the commit is never created.
        repo.writeFiles({ 'docs/note.md': '# notes\n' });
        repo.stage(['docs/note.md']);
        const headBefore = repo.headSha();
        const blocked = realCommit(repo, 'unauthorized change', env);
        expect(blocked.status).not.toBe(0);
        expect(blocked.stdout + blocked.stderr).toContain('RUN_INCOMPLETE');
        expect(commitCount(repo)).toBe(1);
        expect(repo.headSha()).toBe(headBefore);
        expect(repo.stagedFiles()).toEqual(['docs/note.md']); // index untouched by the block

        // Mint a REAL complete-run receipt for EXACTLY these bytes (the
        // trusted issuance machinery `test-gates --changed` uses).
        const minted = await mintCompleteRunReceipt(repo, { verifierKey: VERIFIER_KEY });
        expect(minted.receiptPath).toBeTruthy();

        // Same staged candidate, valid receipt: the hook authorizes and
        // the commit IS created.
        const authorized = realCommit(repo, 'authorized change', env);
        expect(authorized.status).toBe(0);
        expect(commitCount(repo)).toBe(2);
        expect(repo.git(['log', '-1', '--format=%s']).stdout.trim()).toBe('authorized change');
        expect(repo.git(['show', 'HEAD:docs/note.md']).stdout).toBe('# notes\n');
      });
    },
    120_000,
  );

  it(
    'a missing engine blocks the commit fail-closed (engine-not-found)',
    () => {
      withTempRepo({}, (repo) => {
        installFixture(repo);
        repo.writeFiles({ 'src/accounts.txt': '', 'src/orders.txt': '' });
        rmSync(repo.path('.gateforge/adapters/accounts.mjs'));
        rmSync(repo.path('.gateforge/adapters/orders.mjs'));
        repo.stage();
        repo.commit('base');
        installCommitHook(repo.root, gitEnv());
        repo.writeFiles({ 'docs/other.md': '# x\n' });
        repo.stage(['docs/other.md']);

        // No GATEFORGE_CLI, minimal PATH (gateforge is not on it): the
        // hook must block instead of letting the commit through.
        const blocked = realCommit(repo, 'no engine', { GATEFORGE_CLI: '', PATH: '/usr/bin:/bin' });
        expect(blocked.status).not.toBe(0);
        expect(blocked.stdout + blocked.stderr).toContain('CLI engine not found');
        expect(commitCount(repo)).toBe(1);
      });
    },
    60_000,
  );
});
