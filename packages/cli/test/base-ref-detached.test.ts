/**
 * The `github-pr` diff surface in a DETACHED pull-request checkout.
 *
 * `actions/checkout` of the PR head SHA leaves the base branch existing only
 * as `refs/remotes/origin/<base>` — there is no local `<base>` ref (proven in
 * CI runs 38683243458 / 38685125557: `git merge-base HEAD main` exits 128
 * with `fatal: Not a valid object name main`). Both consumers of
 * `GITHUB_BASE_REF` must therefore resolve the base through the fetched
 * remote-tracking ref:
 *
 * - the changed-file provider (`providers.ts` `githubPrProvider`),
 * - the `test-gates` carry-forward base resolver
 *   (`commands/test-gates.ts` `resolveCarryForwardBaseSha`).
 */
import { describe, expect, it } from 'vitest';
import { withTempRepo, type TempRepo } from '@gate-forge/core';
import { githubPrProvider } from '../src/providers.js';
import { UsageError } from '../src/errors.js';
import { resolveCarryForwardBaseSha } from '../src/commands/test-gates.js';
import type { Io } from '../src/io.js';

/**
 * Builds the detached-checkout fixture: a base commit on `main`, a PR branch
 * with one change, the base published ONLY as the remote-tracking ref
 * `refs/remotes/origin/main`, and the local `main` branch deleted — exactly
 * what a PR checkout of the head SHA looks like.
 */
function makeDetachedCheckout(repo: TempRepo): void {
  repo.commitFiles({ 'src/base.txt': 'base\n' }, 'base commit');
  repo.git(['checkout', '-b', 'feature/pr']);
  repo.commitFiles({ 'src/pr-change.txt': 'change\n' }, 'pr change');
  const baseSha = repo.git(['rev-parse', 'main']).stdout.trim();
  repo.git(['update-ref', 'refs/remotes/origin/main', baseSha]);
  repo.git(['branch', '-D', 'main']);
}

/** Sanity: the fixture really has no local `main` to resolve. */
function expectNoLocalMain(repo: TempRepo): void {
  const local = repo.git(['rev-parse', '--verify', '--quiet', 'main^{commit}'], {
    allowFailure: true,
  });
  expect(local.status).not.toBe(0);
  expect(
    repo.git(['rev-parse', '--verify', '--quiet', 'refs/remotes/origin/main^{commit}']).status,
  ).toBe(0);
}

/**
 * Builds the SHADOWING fixture: the base is published as
 * `refs/remotes/origin/main`, but a stale local `main` exists at a
 * different commit forked off the root — a local ref must never win over
 * the fetched remote-tracking ref (review finding M1).
 */
function makeShadowedCheckout(repo: TempRepo): void {
  repo.commitFiles({ 'src/root.txt': 'root\n' }, 'root commit');
  repo.commitFiles({ 'src/base.txt': 'base\n' }, 'base commit');
  const baseSha = repo.git(['rev-parse', 'main']).stdout.trim();
  repo.git(['update-ref', 'refs/remotes/origin/main', baseSha]);
  repo.git(['checkout', '-b', 'feature/pr']);
  repo.commitFiles({ 'src/pr-change.txt': 'change\n' }, 'pr change');
  repo.git(['checkout', 'main']);
  repo.git(['reset', '--hard', 'HEAD~1']);
  repo.commitFiles({ 'src/stale.txt': 'stale\n' }, 'stale local main commit');
  repo.git(['checkout', 'feature/pr']);
}

function io(repo: TempRepo, baseRef: string): Io {
  return { cwd: repo.root, env: { GITHUB_BASE_REF: baseRef }, stdout: process.stdout, stderr: process.stderr };
}

describe('github-pr base ref in a detached PR checkout', () => {
  it('provider diffs the PR change via refs/remotes/origin/<base>', () => {
    withTempRepo({}, (repo) => {
      makeDetachedCheckout(repo);
      expectNoLocalMain(repo);
      const files = githubPrProvider(repo.root, { GITHUB_BASE_REF: 'main' }).changedFiles();
      expect(files).toEqual(['src/pr-change.txt']);
    });
  });

  it('provider fails closed naming BOTH candidate refs when the base resolves nowhere', () => {
    withTempRepo({}, (repo) => {
      makeDetachedCheckout(repo);
      expect(() => githubPrProvider(repo.root, { GITHUB_BASE_REF: 'nope' }).changedFiles()).toThrow(
        /'nope'.*'refs\/remotes\/origin\/nope'/s,
      );
    });
  });

  it('provider keeps rejecting a base ref with a leading dash', () => {
    withTempRepo({}, (repo) => {
      makeDetachedCheckout(repo);
      expect(() => githubPrProvider(repo.root, { GITHUB_BASE_REF: '-main' }).changedFiles()).toThrow(
        UsageError,
      );
    });
  });

  it('carry-forward resolver resolves the base sha via refs/remotes/origin/<base>', () => {
    withTempRepo({}, (repo) => {
      makeDetachedCheckout(repo);
      expectNoLocalMain(repo);
      const sha = resolveCarryForwardBaseSha(io(repo, 'main'), 'github-pr');
      expect(sha).toMatch(/^[0-9a-f]{40}$/);
      expect(repo.git(['rev-parse', 'refs/remotes/origin/main']).stdout.trim()).toBe(sha);
    });
  });

  it('carry-forward resolver returns null when the base resolves nowhere', () => {
    withTempRepo({}, (repo) => {
      makeDetachedCheckout(repo);
      expect(resolveCarryForwardBaseSha(io(repo, 'nope'), 'github-pr')).toBeNull();
    });
  });

  it('carry-forward resolver rejects a base ref with a leading dash', () => {
    withTempRepo({}, (repo) => {
      makeDetachedCheckout(repo);
      expect(resolveCarryForwardBaseSha(io(repo, '-main'), 'github-pr')).toBeNull();
      expect(resolveCarryForwardBaseSha(io(repo, 'has space'), 'github-pr')).toBeNull();
    });
  });

  it('provider prefers refs/remotes/origin/<base> over a stale local <base>', () => {
    withTempRepo({}, (repo) => {
      makeShadowedCheckout(repo);
      // Pre-fix the unqualified `main` resolved first: the merge base with
      // the stale local `main` landed at the fork root, so the diff was
      // `root..HEAD` — src/base.txt and src/pr-change.txt (src/root.txt and
      // src/stale.txt were not in it).
      const files = githubPrProvider(repo.root, { GITHUB_BASE_REF: 'main' }).changedFiles();
      expect(files).toEqual(['src/pr-change.txt']);
    });
  });

  it('carry-forward resolver prefers refs/remotes/origin/<base> over a stale local <base>', () => {
    withTempRepo({}, (repo) => {
      makeShadowedCheckout(repo);
      const sha = resolveCarryForwardBaseSha(io(repo, 'main'), 'github-pr');
      expect(sha).toBe(repo.git(['rev-parse', 'refs/remotes/origin/main']).stdout.trim());
    });
  });

  it('provider rejects revision syntax such as HEAD or a ref expression', () => {
    withTempRepo({}, (repo) => {
      makeDetachedCheckout(repo);
      expect(() => githubPrProvider(repo.root, { GITHUB_BASE_REF: 'HEAD' }).changedFiles()).toThrow(
        UsageError,
      );
      expect(() =>
        githubPrProvider(repo.root, { GITHUB_BASE_REF: 'main~1' }).changedFiles(),
      ).toThrow(UsageError);
      expect(resolveCarryForwardBaseSha(io(repo, 'main@{1}'), 'github-pr')).toBeNull();
    });
  });

  it('provider rejects a base ref with surrounding whitespace instead of trimming it', () => {
    withTempRepo({}, (repo) => {
      makeDetachedCheckout(repo);
      expect(() =>
        githubPrProvider(repo.root, { GITHUB_BASE_REF: ' main ' }).changedFiles(),
      ).toThrow(UsageError);
      expect(resolveCarryForwardBaseSha(io(repo, ' main'), 'github-pr')).toBeNull();
    });
  });

  it('provider ignores a replace ref that would redirect the base commit', () => {
    withTempRepo({}, (repo) => {
      makeDetachedCheckout(repo);
      expectNoLocalMain(repo);
      const baseSha = repo.git(['rev-parse', 'refs/remotes/origin/main']).stdout.trim();
      // A graft: refs/replace/<base> points the base commit at an ORPHAN
      // commit (same tree as the PR head plus one extra file) that shares
      // no ancestry with HEAD. Any base-object read WITHOUT
      // --no-replace-objects lands on that graft instead of the real
      // fetched base, so the merge base and the diff both change; the
      // real PR diff must stay exactly the one file.
      repo.git(['checkout', '--orphan', 'graft-src']);
      repo.commitFiles({ 'src/replaced.txt': 'redirected\n' }, 'graft commit');
      const graft = repo.git(['rev-parse', 'HEAD']).stdout.trim();
      repo.git(['checkout', '-q', 'feature/pr']);
      repo.git(['branch', '-q', '-D', 'graft-src']);
      repo.git(['replace', baseSha, graft]);
      const files = githubPrProvider(repo.root, { GITHUB_BASE_REF: 'main' }).changedFiles();
      expect(files).toEqual(['src/pr-change.txt']);
      expect(resolveCarryForwardBaseSha(io(repo, 'main'), 'github-pr')).toBe(baseSha);
    });
  });
});
