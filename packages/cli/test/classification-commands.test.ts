import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { installFixture, runCli, withTempRepo } from './helpers.js';

describe('automatic classification commands', () => {
  it('classify emits deterministic effective decisions and a derived snapshot', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      const first = await runCli(repo, ['classify', '--json', '--write-snapshot', '.gateforge/effective.yml']);
      const second = await runCli(repo, ['classify', '--json']);
      expect(first.code).toBe(0);
      expect(first.stdout.replace(/snapshot written[^\n]*\n?$/, '')).toBe(second.stdout);
      expect(existsSync(repo.path('.gateforge/effective.yml'))).toBe(true);
      expect(readFileSync(repo.path('.gateforge/effective.yml'), 'utf8')).toContain('tenant.accounts');
    });
  });

  it('explain exposes the decision trace and generated obligation', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      const result = await runCli(repo, ['explain', 'tenant.accounts']);
      expect(result.code).toBe(0);
      expect(result.stdout).toContain('decisionFingerprint:');
      expect(result.stdout).toContain('rules:');
      expect(result.stdout).toContain('tenant.accounts:persistence:read');
    });
  });
});
