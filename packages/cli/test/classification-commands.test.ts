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

  it('previews and explicitly appends a reviewed plane rule without replacing existing rules', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      const existing = { match: 'src/accounts.txt', plane: 'tenant', reason: 'Existing reviewed rule.' };
      repo.writeFiles({ '.gateforge/planes.json': JSON.stringify({ rules: [existing] }) });
      const args = [
        'classify',
        'plane',
        'src/new-route.js',
        'master',
        '--reason',
        'This route serves operator-managed records.',
      ];

      const preview = await runCli(repo, args);
      expect(preview.code).toBe(0);
      expect(preview.stdout).toContain('"match": "src/new-route.js"');
      expect(preview.stdout).toContain('owner-reviewed classification input');
      expect(preview.stdout).toContain('approved policy pin is in use');
      expect(preview.stdout).toContain('rerun this command with --confirm');
      expect(JSON.parse(readFileSync(repo.path('.gateforge/planes.json'), 'utf8'))).toEqual({
        rules: [existing],
      });

      const confirmed = await runCli(repo, [...args, '--confirm']);
      expect(confirmed.code).toBe(0);
      expect(JSON.parse(readFileSync(repo.path('.gateforge/planes.json'), 'utf8'))).toEqual({
        rules: [
          existing,
          {
            match: 'src/new-route.js',
            plane: 'master',
            reason: 'This route serves operator-managed records.',
          },
        ],
      });
    });
  });

  it('does not create a new plane trust file', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      const result = await runCli(repo, [
        'classify',
        'plane',
        'src/new-route.js',
        'master',
        '--reason',
        'Owner-confirmed isolation boundary.',
        '--confirm',
      ]);
      expect(result.code).toBe(2);
      expect(result.stderr).toContain('.gateforge/planes.json');
      expect(existsSync(repo.path('.gateforge/planes.json'))).toBe(false);
    });
  });
  it('refuses a plane rule that conflicts with an existing matching declaration', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      const existing = { match: 'src/**', plane: 'tenant', reason: 'Owner-reviewed tenant data.' };
      repo.writeFiles({ '.gateforge/planes.json': JSON.stringify({ rules: [existing] }) });
      const result = await runCli(repo, [
        'classify',
        'plane',
        'src/new-route.js',
        'master',
        '--reason',
        'Owner-reviewed operator data.',
        '--confirm',
      ]);
      expect(result.code).toBe(2);
      expect(result.stderr).toContain('will not add a conflicting rule');
      expect(JSON.parse(readFileSync(repo.path('.gateforge/planes.json'), 'utf8'))).toEqual({
        rules: [existing],
      });
    });
  });

  it('names the conflicting rule and the key to change when it refuses', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      const existing = { match: 'src/**', plane: 'tenant', reason: 'Owner-reviewed tenant data.' };
      repo.writeFiles({ '.gateforge/planes.json': JSON.stringify({ rules: [existing] }) });
      const result = await runCli(repo, [
        'classify',
        'plane',
        'src/new-route.js',
        'master',
        '--reason',
        'Owner-reviewed operator data.',
        '--confirm',
      ]);
      expect(result.code).toBe(2);
      // The refusal named the FILE but not the rule, so the owner had to
      // go hunting through the document to undo a wrong answer the
      // product itself offered no way back from.
      expect(result.stderr).toContain("match 'src/**'");
      expect(result.stderr).toContain('`plane`');
      expect(result.stderr).toContain('master');
      // Nothing is written and the exit code is unchanged.
      expect(JSON.parse(readFileSync(repo.path('.gateforge/planes.json'), 'utf8'))).toEqual({
        rules: [existing],
      });
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
