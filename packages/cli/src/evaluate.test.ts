/**
 * The strict-E2E coverage-policy presence rule (plan 2026-10-18): with
 * `enforcement.strictE2E: true` a missing or empty owner `coveragePolicy`
 * adds exactly ONE setup-wide blocking `COVERAGE_POLICY_ABSENT` entry
 * (the owner-written list is the only gate input the code cannot shrink);
 * a ZERO-table inventory is exempt — no user-facing table, nothing
 * undeclared — and with strict E2E off the absence stays silent. These
 * tests drive the REAL shared evaluate path through `check --format json`
 * on fixture repositories — the same path `test-gates` and `next` run.
 */
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CAUSE_NEXT_ACTIONS, fingerprint, withTempRepo, type TempRepo } from '@gate-forge/core';
import { installFixture, LIFECYCLE, POLICY_ID, runCli } from '../test/helpers.js';

interface Report {
  summary: { blocking: number };
  excused?: Array<{ obligationId: string; reason: string; kind: string; surface: string }>;
  blocking: Array<{
    kind: string;
    name: string | null;
    cause?: string | null;
    detail: string;
    nextAction?: string | null;
  }>;
}

const STRICT = 'enforcement:\n  mode: standard\n  strictE2E: true\n';

const COVERAGE_POLICY_SECTION = `coveragePolicy:
  tables:
    - name: accounts
      requiredOperations: [create, read, update, delete]
      disposition:
        kind: not-user-facing
    - name: orders
      requiredOperations: [read]
      disposition:
        kind: read-only-surface
        note: orders are read-only in the UI
`;

/**
 * A valid, unexpired waiver for one fixture persistence:read obligation
 * (the same pin-2 scope strict-e2e.test.ts uses to keep fixtures green).
 */
function waiverJson(resourceId: string): string {
  return JSON.stringify({
    schemaVersion: 1,
    owner: 'team-' + resourceId.split('.')[1],
    justificationUrl: 'https://example.invalid/justification',
    approver: 'approver@example.invalid',
    scope: {
      kind: 'exact',
      resourceId,
      fingerprint: fingerprint({ resourceId, contract: 'persistence:read', policyId: POLICY_ID, lifecycle: LIFECYCLE }),
    },
    expiresAt: '2027-01-01T00:00:00.000Z',
  });
}

/** Appends a top-level YAML section to the fixture `.gateforge.yml`. */
function withConfigSection(repo: TempRepo, section: string): void {
  const path = repo.path('.gateforge.yml');
  writeFileSync(path, readFileSync(path, 'utf8') + section, 'utf8');
}

describe('strict E2E refuses a missing coverage policy (plan 2026-10-18)', () => {
  it('strictE2E + absent policy: exactly one blocking COVERAGE_POLICY_ABSENT entry naming the inventory size', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      withConfigSection(repo, STRICT);
      const { code, stdout } = await runCli(repo, ['check', '--format', 'json']);
      expect(code).toBe(1);
      const report = JSON.parse(stdout) as Report;
      const absent = report.blocking.filter((entry) => entry.cause === 'COVERAGE_POLICY_ABSENT');
      expect(absent).toHaveLength(1);
      const entry = absent[0] as NonNullable<(typeof absent)[number]>;
      expect(entry.kind).toBe('finding');
      expect(entry.name).toBe('coveragePolicy');
      expect(entry.detail).toContain('strictE2E is on');
      expect(entry.detail).toContain('absent');
      expect(entry.detail).toContain('2 user-facing table(s)');
      expect(entry.nextAction).toBe(CAUSE_NEXT_ACTIONS['COVERAGE_POLICY_ABSENT']);
      expect(entry.nextAction).toContain('gateforge coverage draft');
    });
  });

  it('strictE2E + absent policy + zero user-facing tables: nothing undeclared, no entry', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      // Remove both fixture resources and their adapters: the inventory
      // drops to zero user-facing tables, so there is nothing a policy
      // could declare and the presence rule must stay silent.
      rmSync(repo.path('src/accounts.txt'));
      rmSync(repo.path('src/orders.txt'));
      rmSync(repo.path('.gateforge/adapters/accounts.mjs'));
      rmSync(repo.path('.gateforge/adapters/orders.mjs'));
      withConfigSection(repo, STRICT);
      const { code, stdout } = await runCli(repo, ['check', '--format', 'json']);
      expect(code).toBe(0);
      const report = JSON.parse(stdout) as Report;
      expect(report.blocking.some((entry) => entry.cause === 'COVERAGE_POLICY_ABSENT')).toBe(false);
      expect(report.summary.blocking).toBe(0);
    });
  });

  it('strictE2E + declared policy: no COVERAGE_POLICY_ABSENT entry from this rule', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      withConfigSection(repo, STRICT + COVERAGE_POLICY_SECTION);
      const { code, stdout } = await runCli(repo, ['check', '--format', 'json']);
      // The active table dispositions withhold the persistence obligations
      // (plan 2026-10-19 P5) — each named as an excused row with the owner
      // reason, never silently dropped — so the gate is clean.
      expect(code).toBe(0);
      const report = JSON.parse(stdout) as Report;
      expect(report.blocking.some((entry) => entry.cause === 'COVERAGE_POLICY_ABSENT')).toBe(false);
      // The dispositioned policy grades clean: no coverage findings either.
      expect(report.blocking.some((entry) => entry.cause === 'CRUD_COVERAGE_MISSING')).toBe(false);
      const excused = report.excused ?? [];
      expect(excused.map((entry) => entry.obligationId).sort()).toEqual([
        'tenant.accounts:persistence:read',
        'tenant.orders:persistence:read',
      ]);
      const byId = new Map(excused.map((entry) => [entry.obligationId, entry]));
      expect(byId.get('tenant.orders:persistence:read')?.reason).toBe('orders are read-only in the UI');
      expect(byId.get('tenant.accounts:persistence:read')?.reason).toBe(
        "coverage disposition 'not-user-facing' (no reason recorded)",
      );
      expect(byId.get('tenant.accounts:persistence:read')?.kind).toBe('not-user-facing');
      expect(byId.get('tenant.accounts:persistence:read')?.surface).toBe('table');
    });
  });

  it('strictE2E off + absent policy: behaviour unchanged, no entry from this rule', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      repo.writeFiles({
        '.gateforge/waivers/accounts.json': waiverJson('tenant.accounts'),
        '.gateforge/waivers/orders.json': waiverJson('tenant.orders'),
      });
      const { code, stdout } = await runCli(repo, ['check', '--format', 'json']);
      expect(code).toBe(0);
      const report = JSON.parse(stdout) as Report;
      expect(report.blocking.some((entry) => entry.cause === 'COVERAGE_POLICY_ABSENT')).toBe(false);
      expect(report.summary.blocking).toBe(0);
    });
  });
});
