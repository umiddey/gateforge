/**
 * Changed-file providers (pin #5): local staged diff and the two CI
 * providers over real temp git repos, plus `auto` resolution.
 */
import { describe, expect, it } from 'vitest';
import { normalizeChangedFiles, withTempRepo } from '@gate-forge/core';
import {
  githubPrProvider,
  gitlabMrProvider,
  localStagedProvider,
  providerFor,
  mergeRequestScopePreflight,
  resolveProvider,
} from '../src/providers.js';

describe('local-staged provider', () => {
  it('reports staged files normalized; unstaged changes are invisible', async () => {
    await withTempRepo({}, (repo) => {
      repo.commitFiles({ 'a.txt': 'a\n', 'b/c.txt': 'c\n' }, 'base');
      repo.writeFiles({ 'a.txt': 'a changed\n', 'new.txt': 'new\n' });
      const provider = localStagedProvider(repo.root, {});
      expect(provider.provider).toBe('local-staged');
      expect(provider.changedFiles()).toEqual([]); // nothing staged yet
      repo.stage(['a.txt']);
      expect(provider.changedFiles()).toEqual(['a.txt']);
    });
  });
});

describe('gitlab-mr provider', () => {
  it('diffs the merge-base sha against HEAD', async () => {
    await withTempRepo({}, (repo) => {
      repo.commitFiles({ 'a.txt': 'a\n' }, 'base');
      const baseSha = repo.headSha();
      repo.commitFiles({ 'b.txt': 'b\n' }, 'change');
      const provider = gitlabMrProvider(repo.root, {
        CI_MERGE_REQUEST_DIFF_BASE_SHA: baseSha ?? '',
      });
      expect(provider.provider).toBe('gitlab-mr');
      expect(provider.changedFiles()).toEqual(['b.txt']);
    });
  });

  it('fails closed without the env variable', async () => {
    await withTempRepo({}, (repo) => {
      const provider = gitlabMrProvider(repo.root, {});
      expect(() => provider.changedFiles()).toThrow(/CI_MERGE_REQUEST_DIFF_BASE_SHA/);
    });
  });
});

describe('github-pr provider', () => {
  it('diffs the merge-base of HEAD and the base ref', async () => {
    await withTempRepo({}, (repo) => {
      repo.commitFiles({ 'a.txt': 'a\n' }, 'base');
      repo.git(['checkout', '-b', 'feature']);
      repo.commitFiles({ 'b.txt': 'b\n' }, 'feature change');
      const provider = githubPrProvider(repo.root, { GITHUB_BASE_REF: 'main' });
      expect(provider.provider).toBe('github-pr');
      expect(provider.changedFiles()).toEqual(['b.txt']);
    });
  });

  it('fails closed without the env variable', async () => {
    await withTempRepo({}, (repo) => {
      const provider = githubPrProvider(repo.root, {});
      expect(() => provider.changedFiles()).toThrow(/GITHUB_BASE_REF/);
    });
  });
});

describe('resolveProvider (auto)', () => {
  it('prefers GHA, then GitLab, then local', () => {
    expect(resolveProvider('auto', '/tmp', { GITHUB_BASE_REF: 'main' }).provider).toBe('github-pr');
    expect(
      resolveProvider('auto', '/tmp', { CI_MERGE_REQUEST_DIFF_BASE_SHA: 'abc' }).provider,
    ).toBe('gitlab-mr');
    expect(resolveProvider('auto', '/tmp', {}).provider).toBe('local-staged');
    expect(resolveProvider('local-staged', '/tmp', { GITHUB_BASE_REF: 'main' }).provider).toBe(
      'local-staged',
    );
  });

  it('normalizes identical raw outputs across providers (GF-09 parity basis)', () => {
    expect(normalizeChangedFiles(['b.txt', 'a.txt', 'b.txt'])).toEqual(['a.txt', 'b.txt']);
    expect(normalizeChangedFiles(['dir\\x.txt'])).toEqual(['dir/x.txt']);
  });

  it('all-files provider reports no diff scope', () => {
    const provider = providerFor('all-files', '/tmp', {});
    expect(provider.provider).toBe('all-files');
    expect(provider.changedFiles()).toEqual([]);
  });
});
/**
 * The CI merge-request scope preflight: in a merge-request pipeline the
 * `auto` provider resolves to the LOCAL staged diff when the platform
 * exposes no base commit, so a `--scope changed` run silently checks
 * zero changed files and fails forty minutes later. The preflight turns
 * that into an exit 2 in seconds, and only in that exact case.
 */
describe('the CI merge-request scope preflight', () => {
  const autoConfig = { changed: { provider: 'auto' } } as unknown as Parameters<
    typeof mergeRequestScopePreflight
  >[0];

  it('refuses a merge-request pipeline with no base commit', () => {
    expect(
      mergeRequestScopePreflight(autoConfig, { CI: 'true', CI_MERGE_REQUEST_IID: '94' }),
    ).toMatch(/CI merge-request pipeline without a base commit/);
    expect(
      mergeRequestScopePreflight(autoConfig, {
        CI: 'true',
        GITHUB_EVENT_NAME: 'pull_request',
        GITHUB_BASE_REF: '',
      }),
    ).toMatch(/--scope full/);
  });

  it('says nothing outside that exact case', () => {
    // A base commit is present: the provider resolves properly.
    expect(
      mergeRequestScopePreflight(autoConfig, {
        CI: 'true',
        CI_MERGE_REQUEST_IID: '94',
        CI_MERGE_REQUEST_DIFF_BASE_SHA: 'a'.repeat(40),
      }),
    ).toBeNull();
    // A GitHub pull request with its base ref.
    expect(
      mergeRequestScopePreflight(autoConfig, {
        CI: 'true',
        GITHUB_EVENT_NAME: 'pull_request',
        GITHUB_BASE_REF: 'main',
      }),
    ).toBeNull();
    // A plain CI pipeline (not a merge request).
    expect(mergeRequestScopePreflight(autoConfig, { CI: 'true' })).toBeNull();
    // The same pipeline outside CI.
    expect(
      mergeRequestScopePreflight(autoConfig, { CI_MERGE_REQUEST_IID: '94' }),
    ).toBeNull();
    // An explicitly configured provider never falls back to auto.
    expect(
      mergeRequestScopePreflight(
        { changed: { provider: 'local-staged' } } as unknown as Parameters<
          typeof mergeRequestScopePreflight
        >[0],
        { CI: 'true', CI_MERGE_REQUEST_IID: '94' },
      ),
    ).toBeNull();
  });
});
