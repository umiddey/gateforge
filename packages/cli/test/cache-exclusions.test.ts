/** Owner-declared Python bytecode exclusion validation. */
import { symlinkSync, unlinkSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { loadConfig, withTempRepo } from '@gate-forge/core';
import { loadCacheExclusions } from '../src/cache-exclusions.js';
import { configYml, installFixture } from './helpers.js';

describe('Python bytecode exclusions', () => {
  it('accepts exact cache files and rejects broad, escaped, or non-bytecode paths', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      const valid = 'src/pkg/__pycache__/account.cpython-313.pyc';
      repo.writeFiles({
        '.gateforge/cache-exclusions.yml': `schemaVersion: 1\nfiles:\n  - "${valid}"\n`,
      });
      const config = loadConfig(repo.path('.gateforge.yml'));
      expect(loadCacheExclusions(repo.root, config)).toEqual([valid]);

      for (const invalid of [
        '../src/__pycache__/account.pyc',
        'src/**/__pycache__/account.pyc',
        'src/__pycache__/account.py',
        'src/__pycache__/nested/account.pyc',
      ]) {
        repo.writeFiles({
          '.gateforge/cache-exclusions.yml': `schemaVersion: 1\nfiles:\n  - "${invalid}"\n`,
        });
        expect(() => loadCacheExclusions(repo.root, config)).toThrow(/exact repo-relative|must not contain|must name/);
      }
    });
  });

  it('rejects symlinked cache files and configured gate inputs', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      const cacheFile = 'src/__pycache__/account.cpython-313.pyc';
      repo.writeFiles({
        'src/accounts.txt': 'source fixture.table\n',
        [cacheFile]: 'bytecode\n',
        '.gateforge/cache-exclusions.yml': `schemaVersion: 1\nfiles:\n  - "${cacheFile}"\n`,
      });
      const config = loadConfig(repo.path('.gateforge.yml'));
      unlinkSync(repo.path(cacheFile));
      symlinkSync(repo.path('src/accounts.txt'), repo.path(cacheFile));
      expect(() => loadCacheExclusions(repo.root, config)).toThrow(/rejects symlink/);

      unlinkSync(repo.path(cacheFile));
      repo.writeFiles({ [cacheFile]: 'bytecode\n' });
      repo.writeFiles({ '.gateforge.yml': configYml({ include: `['${cacheFile}']` }) });
      const configuredInput = loadConfig(repo.path('.gateforge.yml'));
      expect(() => loadCacheExclusions(repo.root, configuredInput)).toThrow(/cannot exclude configured scan or gate input/);
    });
  });

  it('allows an exact cache path to be absent before it is generated', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      const cacheFile = 'src/__pycache__/account.cpython-313.pyc';
      repo.writeFiles({
        '.gateforge/cache-exclusions.yml': `schemaVersion: 1\nfiles:\n  - "${cacheFile}"\n`,
      });
      const config = loadConfig(repo.path('.gateforge.yml'));
      expect(loadCacheExclusions(repo.root, config)).toEqual([cacheFile]);
    });
  });
});
