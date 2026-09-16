/**
 * `gateforge waive`: the ONLY CLI path that writes waiver files —
 * happy-path write (schema-valid + loadable through the production
 * loader), obligation resolution with close-match suggestions,
 * duplicate-scope all-or-nothing rollback, and fail-closed flag/expiry
 * validation (GF-15/16). Every case runs through `main` (runCli), so the
 * cli.ts registry dispatch is exercised on each test.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadWaivers, WaiverSchema, withTempRepo } from '@gate-forge/core';
import { FIXED_AT, fixtureFingerprint, installFixture, runCli } from './helpers.js';

const WAIVERS_DIR = '.gateforge/waivers';
/** The deterministic target for tenant.accounts:persistence:read. */
const TARGET = `${WAIVERS_DIR}/tenant.accounts-persistence-read.json`;
const ACCOUNTS_FP = fixtureFingerprint('tenant.accounts');

/**
 * Builds a `waive` argv for the fixture's accounts obligation.
 * `omit` drops flags (GF-15 failures); `values` replaces a flag's value
 * (bad-URL / bad-expiry failures).
 */
function waiveArgv(
  options: {
    target?: string;
    omit?: string[];
    values?: Record<string, string>;
    extra?: string[];
  } = {},
): string[] {
  const defaults: Array<[string, string]> = [
    ['--owner', 'alice'],
    ['--approver', 'bob'],
    ['--justification-url', 'https://issues.example.com/T-1'],
    ['--expires', '2027-01-01'],
  ];
  const omit = new Set(options.omit ?? []);
  const flags = defaults
    .filter(([name]) => !omit.has(name))
    .map(([name, value]) => [name, options.values?.[name] ?? value] as [string, string]);
  return [
    'waive',
    options.target ?? 'tenant.accounts:persistence:read',
    ...flags.flat(),
    ...(options.extra ?? []),
  ];
}

/** A valid hand-written pre-existing waiver (different file, same scope). */
function existingWaiver(owner: string): string {
  return `${JSON.stringify(
    {
      schemaVersion: 1,
      owner,
      justificationUrl: 'https://issues.example.com/T-0',
      approver: 'dave',
      scope: { kind: 'exact', resourceId: 'tenant.accounts', fingerprint: ACCOUNTS_FP },
      expiresAt: '2027-06-01T00:00:00.000Z',
    },
    null,
    2,
  )}\n`;
}

describe('gateforge waive', () => {
  it('writes a schema-valid waiver the production loader accepts, and prints a reviewable summary', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      const { code, stdout } = await runCli(repo, waiveArgv());
      expect(code).toBe(0);

      const document = JSON.parse(readFileSync(repo.path(TARGET), 'utf8')) as unknown;
      expect(document).toMatchObject({
        schemaVersion: 1,
        owner: 'alice',
        approver: 'bob',
        justificationUrl: 'https://issues.example.com/T-1',
        scope: { kind: 'exact', resourceId: 'tenant.accounts', fingerprint: ACCOUNTS_FP },
        // Bare date normalized to UTC midnight, printed in the summary.
        expiresAt: '2027-01-01T00:00:00.000Z',
      });
      expect(WaiverSchema.safeParse(document).success).toBe(true);

      // The directory loads cleanly alongside the new file (all-or-nothing
      // proof ran inside the command; re-proven here against the loader).
      const loaded = loadWaivers(join(repo.root, WAIVERS_DIR), { now: FIXED_AT });
      expect(loaded.waivers).toHaveLength(1);
      expect(loaded.waivers[0]?.owner).toBe('alice');

      // Reviewable summary: short + full fingerprint, absolute expiry AND
      // remaining days, plus the honest strict-E2E limit and the renewal path.
      expect(stdout).toContain(`waiver written: ${TARGET}`);
      expect(stdout).toContain('obligation: tenant.accounts:persistence:read');
      expect(stdout).toContain(`fingerprint: ${ACCOUNTS_FP.slice(0, 12)} (${ACCOUNTS_FP})`);
      expect(stdout).toContain('owner: alice / approver: bob');
      expect(stdout).toContain('expires: 2027-01-01T00:00:00.000Z (in 365 days)');
      expect(stdout).toContain('enforcement.strictE2E');
      expect(stdout).toContain('hand-edit');
    });
  });

  it('fails closed for an unknown resource and suggests same-contract obligations', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      const { code, stderr } = await runCli(
        repo,
        waiveArgv({ target: 'tenant.unknown:persistence:read' }),
      );
      expect(code).toBe(2);
      expect(stderr).toContain("no obligation resolves for 'tenant.unknown:persistence:read'");
      expect(stderr).toContain('tenant.orders:persistence:read');
      expect(existsSync(repo.path(TARGET))).toBe(false);
    });
  });

  it('fails closed for an unknown contract on a known resource and suggests the real id', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      const { code, stderr } = await runCli(
        repo,
        waiveArgv({ target: 'tenant.accounts:crud:update' }),
      );
      expect(code).toBe(2);
      expect(stderr).toContain("no obligation resolves for 'tenant.accounts:crud:update'");
      expect(stderr).toContain('tenant.accounts:persistence:read');
      expect(existsSync(repo.path(TARGET))).toBe(false);
    });
  });

  it('rolls back all-or-nothing on a duplicate exact scope, leaving a loadable directory', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      repo.writeFiles({ [`${WAIVERS_DIR}/existing.json`]: existingWaiver('carol') });

      const { code, stderr } = await runCli(repo, waiveArgv());
      expect(code).toBe(2);
      expect(stderr).toContain('duplicate exact scope');
      expect(stderr).toContain(`rolled back '${TARGET}'`);

      // No partial state: the just-written file is gone, the pre-existing
      // waiver is untouched, and the directory still loads (1 waiver).
      expect(existsSync(repo.path(TARGET))).toBe(false);
      expect(existsSync(repo.path(`${WAIVERS_DIR}/existing.json`))).toBe(true);
      const loaded = loadWaivers(join(repo.root, WAIVERS_DIR), { now: FIXED_AT });
      expect(loaded.waivers).toHaveLength(1);
      expect(loaded.waivers[0]?.owner).toBe('carol');
    });
  });

  it('rejects a non-URL justification before anything is written', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      const { code, stderr } = await runCli(
        repo,
        waiveArgv({ values: { '--justification-url': 'not-a-url' } }),
      );
      expect(code).toBe(2);
      expect(stderr).toContain('--justification-url: Invalid URL');
      expect(existsSync(repo.path(TARGET))).toBe(false);
    });
  });

  it('rejects an expiry in the past of the injected clock', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      const { code, stderr } = await runCli(
        repo,
        waiveArgv({ values: { '--expires': '2025-06-01' } }),
      );
      expect(code).toBe(2);
      expect(stderr).toContain('not in the future');
      expect(stderr).toContain(FIXED_AT);
      expect(existsSync(repo.path(TARGET))).toBe(false);
    });
  });

  it('rejects an expiry that is not an ISO datetime', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      const { code, stderr } = await runCli(
        repo,
        waiveArgv({ values: { '--expires': 'not-a-date' } }),
      );
      expect(code).toBe(2);
      expect(stderr).toContain('--expires: Invalid ISO datetime');
      expect(existsSync(repo.path(TARGET))).toBe(false);
    });
  });

  it('prints usage for --help and rejects unknown flags and missing mandatory flags', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      const help = await runCli(repo, ['waive', '--help']);
      expect(help.code).toBe(0);
      expect(help.stdout).toContain('usage: gateforge waive <resourceId:contract>');
      expect(help.stdout).toContain('No --force');
      expect(help.stdout).toContain('hand-edit');

      // Registry dispatch rejected the undeclared flag (no --force by design).
      // `=1` gives the flag a value so the parser reaches flag rejection
      // (a bare `--force` dies earlier, at 'requires a value' — also exit 2).
      const unknownFlag = await runCli(repo, [...waiveArgv(), '--force=1']);
      expect(unknownFlag.code).toBe(2);
      expect(unknownFlag.stderr).toContain("unknown flag '--force'");

      const missingFlag = await runCli(repo, waiveArgv({ omit: ['--approver'] }));
      expect(missingFlag.code).toBe(2);
      expect(missingFlag.stderr).toContain("'--approver'");
      expect(existsSync(repo.path(TARGET))).toBe(false);
    });
  });
});
