/**
 * 0.10 clean cutover: the 0.9 evidence-exclusion files are REFUSED, not
 * read. One refusal helper covers both files, every gate surface, and
 * the loaders themselves (so no code path can quietly fall back to the
 * old source). The refusal always names the way out.
 */
import { describe, expect, it } from 'vitest';
import { loadConfig, withTempRepo } from '@gate-forge/core';
import { loadCacheExclusions } from '../src/cache-exclusions.js';
import { loadDocsExclusions } from '../src/docs-exclusions.js';
import { installFixture, runCli } from './helpers.js';

describe('pre-0.10 evidence-exclusion files', () => {
  it('make check and test-gates refuse with the migrate instruction', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      repo.writeFiles({
        'docs/readme.md': '# Guide\n',
        '.gateforge/docs-exclusions.yml': 'schemaVersion: 1\nfolders:\n  - docs\n',
      });

      const check = await runCli(repo, ['check']);
      expect(check.code).toBe(2);
      expect(check.stderr).toContain('found .gateforge/docs-exclusions.yml');
      expect(check.stderr).toContain('evidence.exclude');
      expect(check.stderr).toContain('gateforge migrate');

      const gates = await runCli(repo, ['test-gates']);
      expect(gates.code).toBe(2);
      expect(gates.stderr).toContain('found .gateforge/docs-exclusions.yml');
      expect(gates.stderr).toContain('gateforge migrate');
    });
  });

  it('make the old cache file refuse the same way, in both loaders', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      const cacheFile = 'src/__pycache__/accounts.cpython-313.pyc';
      repo.writeFiles({
        [cacheFile]: 'bytecode\n',
        '.gateforge/cache-exclusions.yml': `schemaVersion: 1\nfiles:\n  - "${cacheFile}"\n`,
      });
      const config = loadConfig(repo.path('.gateforge.yml'));
      expect(() => loadCacheExclusions(repo.root, config)).toThrow(/found \.gateforge\/cache-exclusions\.yml/);
      expect(() => loadDocsExclusions(repo.root, config)).toThrow(/gateforge migrate/);

      const next = await runCli(repo, ['next']);
      expect(next.code).toBe(2);
      expect(next.stderr).toContain('found .gateforge/cache-exclusions.yml');
    });
  });

  it('never read the old file even when it is a valid declaration', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      repo.writeFiles({
        'docs/readme.md': '# Guide\n',
        '.gateforge/docs-exclusions.yml': 'schemaVersion: 1\nfolders:\n  - docs\n',
      });
      const config = loadConfig(repo.path('.gateforge.yml'));
      expect(() => loadDocsExclusions(repo.root, config)).toThrow(/since 0\.10/);
    });
  });
});
