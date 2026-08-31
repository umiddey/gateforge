/**
 * Changed-file providers (pin #5): local staged diff and the two CI
 * providers over real temp git repos, plus `auto` resolution.
 */
import { describe, expect, it } from 'vitest';
import { normalizeChangedFiles, withTempRepo } from '@gateforge/core';
import {
  githubPrProvider,
  gitlabMrProvider,
  localStagedProvider,
  providerFor,
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