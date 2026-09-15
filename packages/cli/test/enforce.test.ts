/**
 * `gateforge enforce`: retroactive blocking wiring for already-initialized
 * repos — idempotent, and refuses to run without a gateforge config.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { withTempRepo } from '@gateforge/core';
import { runCli } from './helpers.js';

describe('gateforge enforce', () => {
  it('wires the blocking gate into an initialized repo, idempotently', async () => {
    await withTempRepo({}, async (repo) => {
      expect((await runCli(repo, ['init'])).code).toBe(0);
      const first = await runCli(repo, ['enforce']);
      expect(first.code).toBe(0);
      const hook = repo.path('.gateforge/hooks/gateforge-check.sh');
      expect(existsSync(hook)).toBe(true);
      expect(readFileSync(repo.path('.pre-commit-config.yaml'), 'utf8')).toContain('gateforge-check');
      expect(existsSync(repo.path('.gateforge/ci/gitlab-gateforge.yml'))).toBe(true);
      expect(readFileSync(repo.path('.gitlab-ci.yml'), 'utf8')).toContain('gitlab-gateforge.yml');
      // idempotent: a second enforce must not duplicate the hook entry
      const again = await runCli(repo, ['enforce']);
      expect(again.code).toBe(0);
      expect(again.stdout).toContain('exists, leaving untouched');
      const count = readFileSync(repo.path('.pre-commit-config.yaml'), 'utf8').split('id: gateforge-check').length - 1;
      expect(count).toBe(1);
    });
  });

  it('refuses to run without a gateforge config', async () => {
    await withTempRepo({}, async (repo) => {
      const { code, stderr } = await runCli(repo, ['enforce']);
      expect(code).toBe(2);
      expect(stderr).toContain('gateforge init');
      expect(existsSync(repo.path('.pre-commit-config.yaml'))).toBe(false);
    });
  });
});
