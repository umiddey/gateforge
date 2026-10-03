/**
 * Owner-chosen gate strictness: the
 * optional `mode` key on `check`, its additive report fields, its
 * interaction with the trusted policy digest, and the doctor signal.
 *
 * The frozen contract is the point of most of these: a repository
 * WITHOUT the key must keep today's exact behavior, byte for byte.
 */
import { cpSync, mkdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadConfig, withTempRepo } from '@gate-forge/core';
import { trustedPolicyDigestForConfig } from '../src/execution.js';
import { configYml, installFixture, OBLIGATION_ACCOUNTS, OBLIGATION_ORDERS, runCli } from './helpers.js';

const EXAMPLE_ROOT = fileURLToPath(new URL('../../../example/', import.meta.url));
const WORKSPACE_NODE_MODULES = join(EXAMPLE_ROOT, '..', 'node_modules');

/** Fixture config with the strictness mode the test needs (or none). */
function configWithMode(mode?: string): string {
  return mode === undefined ? configYml() : `${configYml()}mode: ${mode}\n`;
}

/** Parses the json-format check report. */
function parseReport(stdout: string): {
  summary: { blocking: number; missing: number; obligations: number };
  verdicts: Array<{ obligationId: string; verdict: string }>;
  scope: { mode: string };
  strictness?: { mode: string; wouldBlock: boolean; blockingInScope: number; blockingTotal: number };
  [key: string]: unknown;
} {
  return JSON.parse(stdout);
}

describe('gate strictness: default is today', () => {
  it('blocks and adds no strictness fields without the mode key', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      const strict = await runCli(repo, ['check', '--format', 'json']);
      expect(strict.code).toBe(1);
      const explicit = await runCli(repo, ['check', '--format', 'json'], {});
      expect(explicit.code).toBe(1);
      const report = parseReport(strict.stdout);
      expect(report.strictness).toBeUndefined();
      expect(report.summary.blocking).toBe(2);
      expect(report.scope.mode).toBe('all');
    });
  });

  it('behaves identically with an explicit mode: strict', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      repo.writeFiles({ '.gateforge.yml': configWithMode('strict') });
      const result = await runCli(repo, ['check', '--format', 'json']);
      expect(result.code).toBe(1);
      expect(parseReport(result.stdout).strictness).toBeUndefined();
    });
  });

  it('names the active mode in the text report', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      const result = await runCli(repo, ['check']);
      expect(result.stdout).toContain('mode: strict');
    });
  });
});

describe('gate strictness: warn', () => {
  it('exits 0, reports everything, and admits what it would block', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      repo.writeFiles({ '.gateforge.yml': configWithMode('warn') });
      const result = await runCli(repo, ['check', '--format', 'json']);
      expect(result.code).toBe(0);
      const report = parseReport(result.stdout);
      // Counts are unchanged: a JSON consumer still sees the debt.
      expect(report.summary.blocking).toBe(2);
      expect(report.summary.missing).toBe(2);
      expect(report.verdicts.map((v) => v.obligationId).sort()).toEqual([
        OBLIGATION_ACCOUNTS,
        OBLIGATION_ORDERS,
      ]);
      expect(report.strictness).toEqual({
        mode: 'warn',
        wouldBlock: true,
        blockingInScope: 0,
        blockingTotal: 2,
      });
    });
  });

  it('says so on stderr and in the text report', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      repo.writeFiles({ '.gateforge.yml': configWithMode('warn') });
      const result = await runCli(repo, ['check']);
      expect(result.code).toBe(0);
      expect(result.stdout).toContain('mode: warn (would block: 2)');
      expect(result.stderr).toContain('mode: warn (would block: 2)');
    });
  });

  it('never prints a bare `exit code:` line it is not exiting with (F11)', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      repo.writeFiles({ '.gateforge.yml': configWithMode('warn') });
      const result = await runCli(repo, ['check']);
      expect(result.code).toBe(0);
      // The process exits 0, so a report line reading `exit code: 1`
      // contradicts it. The softened value is named as what it is.
      expect(result.stdout).not.toMatch(/^exit code: \d+$/m);
      expect(result.stdout).toContain('would exit 1 in blocking mode');
      // Strict mode still prints the real exit code, unchanged.
      repo.writeFiles({ '.gateforge.yml': configWithMode('strict') });
      const strict = await runCli(repo, ['check']);
      expect(strict.code).toBe(1);
      expect(strict.stdout).toMatch(/^exit code: 1$/m);
      expect(strict.stdout).not.toContain('would exit 1 in blocking mode');
    });
  });

  it('stays clean — and reports no would-block — when the debt is forgiven', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      repo.writeFiles({ '.gateforge.yml': configWithMode('warn') });
      for (const [obligation, team] of [
        [OBLIGATION_ACCOUNTS, 'team-accounts'],
        [OBLIGATION_ORDERS, 'team-orders'],
      ] as const) {
        const waived = await runCli(repo, [
          'waive',
          obligation,
          '--owner', team,
          '--approver', 'lead@example.invalid',
          '--justification-url', 'https://example.invalid/j',
          '--expires', '2027-01-01',
        ]);
        expect(waived.code, waived.stderr).toBe(0);
      }
      const result = await runCli(repo, ['check', '--format', 'json']);
      expect(result.code).toBe(0);
      expect(parseReport(result.stdout).strictness?.wouldBlock).toBe(false);
    });
  });

  it('reports the mode through the doctor', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      repo.writeFiles({ '.gateforge.yml': configWithMode('warn') });
      const doctor = await runCli(repo, ['enforcement', 'doctor']);
      expect(doctor.code).toBe(0);
      expect(doctor.stdout).toContain('[WARN] strictness-mode');
      expect(doctor.stdout).toContain('gate strictness: warn');
    });
  });

  it('reports strict as ok through the doctor', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      const doctor = await runCli(repo, ['enforcement', 'doctor']);
      expect(doctor.stdout).toContain('[OK] strictness-mode');
    });
  });
});

describe('gate strictness: changed', () => {
  it('passes a change that touches none of the debt, and keeps reporting it', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      repo.writeFiles({ '.gateforge.yml': configWithMode('changed') });
      repo.stage();
      repo.commit('fixture base');
      repo.writeFiles({ 'README.md': 'documentation only\n' });
      repo.stage();
      const result = await runCli(repo, ['check', '--format', 'json']);
      expect(result.code).toBe(0);
      const report = parseReport(result.stdout);
      expect(report.summary.blocking).toBe(2);
      expect(report.verdicts.every((verdict) => verdict.verdict === 'missing')).toBe(true);
      expect(report.strictness).toEqual({
        mode: 'changed',
        wouldBlock: true,
        blockingInScope: 0,
        blockingTotal: 2,
      });
    });
  });

  it('blocks when the change touches the unproven resource', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      repo.writeFiles({ '.gateforge.yml': configWithMode('changed') });
      repo.stage();
      repo.commit('fixture base');
      repo.writeFiles({ 'src/accounts.txt': 'accounts fixture.table extra\n' });
      repo.stage();
      const result = await runCli(repo, ['check', '--format', 'json']);
      expect(result.code).toBe(1);
      expect(parseReport(result.stdout).strictness?.blockingInScope).toBe(1);
    });
  });
});

describe('gate strictness and the trusted policy digest', () => {
  it('changes the digest when the owner changes the mode', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      const strictDigest = trustedPolicyDigestForConfig(repo.root, loadConfig(join(repo.root, '.gateforge.yml')));
      repo.writeFiles({ '.gateforge.yml': configWithMode('warn') });
      const warnDigest = trustedPolicyDigestForConfig(repo.root, loadConfig(join(repo.root, '.gateforge.yml')));
      expect(warnDigest).not.toBe(strictDigest);
    });
  });

  it('leaves the digest of a repository without quarantine files untouched', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      const digest = trustedPolicyDigestForConfig(repo.root, loadConfig(join(repo.root, '.gateforge.yml')));
      expect(digest).toMatch(/^[0-9a-f]{64}$/);
    });
  });
});

describe('strictness on a copy of the example project', () => {
  for (const mode of ['strict', 'changed', 'warn'] as const) {
    it(`runs the example first-run flow in mode ${mode}`, async () => {
      await withTempRepo({}, async (repo) => {
        cpSync(EXAMPLE_ROOT, repo.root, {
          recursive: true,
          filter: (source) => {
            const path = relative(EXAMPLE_ROOT, source);
            return (
              path === '' ||
              (!path.split(sep).includes('.git') && !path.split(sep).includes('node_modules'))
            );
          },
        });
        const behaviorModules = repo.path('behavior/node_modules');
        mkdirSync(join(behaviorModules, '@gate-forge'), { recursive: true });
        const packages = [
          [join(EXAMPLE_ROOT, '..', 'packages', 'pack-playwright'), join(behaviorModules, '@gate-forge', 'pack-playwright')],
          [join(EXAMPLE_ROOT, '..', 'packages', 'core'), join(behaviorModules, '@gate-forge', 'core')],
          ...['playwright', 'playwright-core', 'typescript', 'yaml', 'zod'].map((name) => [
            join(WORKSPACE_NODE_MODULES, name),
            join(behaviorModules, name),
          ]),
        ];
        for (const [source, destination] of packages) {
          cpSync(source as string, destination as string, { recursive: true, dereference: true });
        }
        const init = await runCli(repo, ['init', '--no-ci', '--no-blocking']);
        expect(init.code).toBe(0);
        const initialized = readFileSync(join(repo.root, '.gateforge.yml'), 'utf8');
        repo.writeFiles({ '.gateforge.yml': `${initialized}mode: ${mode}\n` });
        const check = await runCli(repo, ['check']);
        expect(check.code, `${check.stdout}\n${check.stderr}`).toBe(0);
        expect(check.stdout).toContain('gateforge run: 0 obligation(s) — 0 satisfied, 0 waived, 0 blocking');
        expect(check.stdout).toContain(`mode: ${mode}`);
      });
    }, 120_000);
  }
});
