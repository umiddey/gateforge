/**
 * Phase 0 strict-E2E + coverage-policy + cause wiring at the CLI
 * boundary (plan 2026-09-13 Phase 0, ADR 0005): the strict-setup
 * preflight fails closed with a precise capability error, waived E2E
 * obligations block with ENFORCEMENT_UNTRUSTED under strict mode, the
 * coverage policy blocks with CRUD_COVERAGE_MISSING (unknown tables exit
 * 2), and one small consumer shows three different blocking causes with
 * useful next actions.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fingerprint, withTempRepo, type TempRepo } from '@gateforge/core';
import {
  installFixture,
  LIFECYCLE,
  OBLIGATION_ACCOUNTS,
  OBLIGATION_ORDERS,
  POLICY_ID,
  runCli,
} from './helpers.js';

/** Pin-2 fingerprint for one fixture obligation (helper parity with check.test.ts). */
function fixtureFingerprint(resourceId: string): string {
  return fingerprint({ resourceId, contract: 'persistence:read', policyId: POLICY_ID, lifecycle: LIFECYCLE });
}

/** A valid, unexpired waiver for one fixture obligation. */
function waiverJson(resourceId: string): string {
  return JSON.stringify({
    schemaVersion: 1,
    owner: 'team-' + resourceId.split('.')[1],
    justificationUrl: 'https://example.invalid/justification',
    approver: 'approver@example.invalid',
    scope: { kind: 'exact', resourceId, fingerprint: fixtureFingerprint(resourceId) },
    expiresAt: '2027-01-01T00:00:00.000Z',
  });
}

/** Appends a top-level YAML section to the fixture `.gateforge.yml`. */
function withConfigSection(repo: TempRepo, section: string): void {
  const path = join(repo.root, '.gateforge.yml');
  writeFileSync(path, `${readFileSync(path, 'utf8')}${section}`, 'utf8');
}

/** Policies document adding an unsupported auth contract on top of persistence:read. */
const AUTH_POLICY_YML = `\
schemaVersion: 1
policies:
  - id: user-facing-crud
    when:
      exposure: user-facing
    require:
      - persistence:read
  - id: user-facing-auth
    when:
      exposure: user-facing
    require:
      - auth:role-denied
`;

describe('init strict-setup preflight (plan Phase 0 item 4)', () => {
  it('init --strict-e2e fails closed: the starter policy needs a browser observer no pack provides', async () => {
    await withTempRepo({}, async (repo) => {
      const { code, stderr } = await runCli(repo, ['init', '--strict-e2e']);
      expect(code).toBe(2);
      expect(stderr).toContain('strict E2E setup is incomplete');
      expect(stderr).toContain("'http:frontend-request-observed'");
      expect(stderr).toContain('no independent browser/test observation channel');
      expect(stderr).toContain('Required observer:');
      expect(stderr).toContain('do not add duplicate tests');
      // Fail closed BEFORE writing: no half setup must exist.
      expect(existsSync(join(repo.root, '.gateforge.yml'))).toBe(false);
      expect(existsSync(join(repo.root, '.gateforge', 'policies.yml'))).toBe(false);
    });
  });

  it('init without --strict-e2e keeps the default (no enforcement section)', async () => {
    await withTempRepo({}, async (repo) => {
      const { code } = await runCli(repo, ['init']);
      expect(code).toBe(0);
      expect(readFileSync(join(repo.root, '.gateforge.yml'), 'utf8')).not.toContain('enforcement:');
    });
  });
});

describe('strict E2E mode via check (plan §3.3, ADR 0005 D4)', () => {
  it('a waived E2E obligation is NOT proof: blocking missing with ENFORCEMENT_UNTRUSTED', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      repo.writeFiles({
        '.gateforge/waivers/accounts.json': waiverJson('tenant.accounts'),
        '.gateforge/waivers/orders.json': waiverJson('tenant.orders'),
      });
      withConfigSection(repo, 'enforcement:\n  mode: standard\n  strictE2E: true\n');
      const { code, stdout } = await runCli(repo, ['check', '--format', 'json']);
      expect(code).toBe(1);
      const report = JSON.parse(stdout) as {
        summary: { blocking: number; waived: number };
        verdicts: Array<{ obligationId: string; verdict: string; cause: string | null; nextAction: string | null; reason: string | null }>;
      };
      expect(report.summary.waived).toBe(0);
      expect(report.summary.blocking).toBe(2);
      expect(report.verdicts.every((v) => v.verdict === 'missing' && v.cause === 'ENFORCEMENT_UNTRUSTED')).toBe(true);
      expect(report.verdicts.every((v) => v.nextAction === 'Repair enforcement setup')).toBe(true);
      // The declined waiver stays explicit in the reason (legacy/reporting use).
      expect(report.verdicts.every((v) => (v.reason ?? '').includes("waived by 'team-"))).toBe(true);
      expect(report.verdicts.every((v) => (v.reason ?? '').includes('not proof'))).toBe(true);
    });
  });

  it('the same waivers stay clean when strict E2E mode is off (opt-in)', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      repo.writeFiles({
        '.gateforge/waivers/accounts.json': waiverJson('tenant.accounts'),
        '.gateforge/waivers/orders.json': waiverJson('tenant.orders'),
      });
      const { code, stdout } = await runCli(repo, ['check', '--format', 'json']);
      expect(code).toBe(0);
      const report = JSON.parse(stdout) as { verdicts: Array<{ verdict: string; cause: string | null }> };
      expect(report.verdicts.every((v) => v.verdict === 'waived' && v.cause === null)).toBe(true);
    });
  });

  it('strict mode preflight: an unavailable contract becomes a precise blocking capability error', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      repo.writeFiles({
        '.gateforge/policies.yml': AUTH_POLICY_YML,
        '.gateforge/waivers/accounts.json': waiverJson('tenant.accounts'),
        '.gateforge/waivers/orders.json': waiverJson('tenant.orders'),
      });
      withConfigSection(repo, 'enforcement:\n  mode: standard\n  strictE2E: true\n');
      const { code, stdout } = await runCli(repo, ['check', '--format', 'json']);
      expect(code).toBe(1);
      const report = JSON.parse(stdout) as {
        blocking: Array<{ kind: string; cause?: string | null; nextAction?: string | null; detail: string }>;
      };
      const capability = report.blocking.filter((entry) => entry.cause === 'VERIFIER_UNSUPPORTED');
      expect(capability).toHaveLength(2); // one per auth obligation (accounts + orders)
      expect(capability.every((entry) => entry.detail.includes('auth:role-denied'))).toBe(true);
      expect(capability.every((entry) => entry.detail.includes('identity/role material'))).toBe(true);
      expect(capability.every((entry) => entry.detail.includes('Required observer:'))).toBe(true);
      expect(
        capability.every(
          (entry) => entry.nextAction === 'Implement/configure the observer; do not add duplicate tests',
        ),
      ).toBe(true);
    });
  });
});

describe('coverage policy via check (plan §3.6, ADR 0005 D5)', () => {
  it('an enabled policy blocks uncovered tables with CRUD_COVERAGE_MISSING; dispositioned tables pass', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      repo.writeFiles({
        '.gateforge/waivers/accounts.json': waiverJson('tenant.accounts'),
        '.gateforge/waivers/orders.json': waiverJson('tenant.orders'),
      });
      withConfigSection(
        repo,
        `coveragePolicy:
  tables:
    - name: accounts
      requiredOperations: [create, read, update, delete]
    - name: orders
      requiredOperations: [read]
      disposition:
        kind: read-only-surface
        note: orders are read-only in the UI
`,
      );
      const { code, stdout } = await runCli(repo, ['check', '--format', 'json']);
      expect(code).toBe(1);
      const report = JSON.parse(stdout) as {
        blocking: Array<{ name: string | null; cause?: string | null; detail: string; nextAction?: string | null }>;
      };
      const coverage = report.blocking.filter((entry) => entry.cause === 'CRUD_COVERAGE_MISSING');
      // Every accounts operation is uncovered/undispositioned; orders is
      // enumerated and dispositioned, so it contributes nothing.
      expect(coverage).toHaveLength(4);
      expect(coverage.every((entry) => entry.name === 'accounts')).toBe(true);
      expect(coverage.some((entry) => entry.detail.includes("'create'"))).toBe(true);
      expect(coverage.some((entry) => entry.detail.includes("'delete'"))).toBe(true);
      expect(
        coverage.every(
          (entry) =>
            entry.nextAction ===
            'Connect/mark existing journeys, add the missing journey, or record an owner disposition',
        ),
      ).toBe(true);
    });
  });

  it('an unknown table name is a configuration error (exit 2)', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      withConfigSection(
        repo,
        `coveragePolicy:
  tables:
    - name: ghosts
      requiredOperations: [read]
`,
      );
      const { code, stderr } = await runCli(repo, ['check']);
      expect(code).toBe(2);
      expect(stderr).toContain('ghosts');
      expect(stderr).toContain('resource inventory');
    });
  });

  it('the feature is off without the section: no coverage findings', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      repo.writeFiles({
        '.gateforge/waivers/accounts.json': waiverJson('tenant.accounts'),
        '.gateforge/waivers/orders.json': waiverJson('tenant.orders'),
      });
      const { code, stdout } = await runCli(repo, ['check', '--format', 'json']);
      expect(code).toBe(0);
      const report = JSON.parse(stdout) as { blocking: Array<{ cause?: string | null }> };
      expect(report.blocking.some((entry) => entry.cause === 'CRUD_COVERAGE_MISSING')).toBe(false);
    });
  });
});

describe('Phase 0 acceptance: three different blocking causes with useful actions', () => {
  it('unmapped test, missing observation, and unsupported verifier show distinct causes', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      repo.writeFiles({
        '.gateforge/policies.yml': AUTH_POLICY_YML,
        '.gateforge/test-gates/claims.json': JSON.stringify([
          {
            schemaVersion: 1,
            obligationId: OBLIGATION_ORDERS,
            testId: 'suite-test',
            testFile: 'tests/orders.spec.ts',
          },
        ]),
      });
      const { code, stdout } = await runCli(repo, ['check', '--format', 'json']);
      expect(code).toBe(1);
      const report = JSON.parse(stdout) as {
        verdicts: Array<{
          obligationId: string;
          verdict: string;
          cause: string | null;
          nextAction: string | null;
        }>;
      };
      const byId = new Map(report.verdicts.map((v) => [v.obligationId, v]));
      // Unmapped: no claim is connected to the accounts persistence obligation.
      expect(byId.get(OBLIGATION_ACCOUNTS)?.cause).toBe('TEST_MAPPING_MISSING');
      expect(byId.get(OBLIGATION_ACCOUNTS)?.nextAction).toBe(
        'Run `gateforge tests suggest`, mark the matching test (`gateforge tests mark` / .gateforge/test-map.yml), ' +
          'map backend-only tables server-e2e, or waive it (`gateforge waive`) — docs/guides/new-table-playbook.md',
      );
      // Missing observation: the orders claim exists but collected nothing.
      expect(byId.get(OBLIGATION_ORDERS)?.cause).toBe('EVIDENCE_NOT_COLLECTED');
      expect(byId.get(OBLIGATION_ORDERS)?.nextAction).toBe('Add observation hooks to that test');
      // Unsupported verifier: the auth contracts have no honest proof channel.
      const auth = report.verdicts.filter((v) => v.cause === 'VERIFIER_UNSUPPORTED');
      expect(auth).toHaveLength(2);
      expect(
        auth.every((v) => v.nextAction === 'Implement/configure the observer; do not add duplicate tests'),
      ).toBe(true);
      // Everything stays blocking (exit 1 asserted above).
      expect(report.verdicts.every((v) => v.verdict !== 'satisfied' && v.verdict !== 'waived')).toBe(true);
    });
  });
});

describe('E17 (plan Phase 7): agent edits to the CI gate wiring cannot self-authorize', () => {
  it('a candidate that deletes the CI gate job is an unclassified change: scope expands and CHANGE_UNMAPPED blocks', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      // The enforcement wiring a strict setup ships: the CI include plus
      // the generated gateforge job file (init --blocking writes these).
      repo.writeFiles({
        '.gitlab-ci.yml': "include:\n  - local: '.gateforge/ci/gitlab-gateforge.yml'\n",
        '.gateforge/ci/gitlab-gateforge.yml': '# gateforge strict gate job\n',
      });
      withConfigSection(repo, 'enforcement:\n  mode: standard\n  strictE2E: true\n');
      repo.commitFiles({}, 'base');
      // The agent's weakening candidate: strip the gate job from the CI
      // wiring and commit through a fresh green pipeline of its own.
      repo.writeFiles({
        '.gitlab-ci.yml': '# gate job removed by the candidate\nkeep_green:\n  script: ["echo green"]\n',
      });
      repo.stage(['.gitlab-ci.yml']);
      const { code, stdout } = await runCli(repo, ['check', '--changed']);
      expect(code).toBe(1);
      expect(stdout).toMatch(/unclassified:\.gitlab-ci\.yml/);
      expect(stdout).toMatch(/CHANGE_UNMAPPED/);
      expect(stdout).toMatch(/\.gitlab-ci\.yml/);
    });
  });
});
