/**
 * Flaky-test quarantine at the CLI boundary (plan 20260925_2013
 * Phase 2): the owner-only write command, its refusals, its place in
 * the pinned trusted policy, the blocking finding an expired quarantine
 * produces, and the rule that a quarantined test's evidence proves
 * nothing.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig, recordIdOf, withTempRepo, type TempRepo } from '@gate-forge/core';
import { expiredQuarantineBlocking } from '../src/commands/test-gates.js';
import { evaluateRun } from '../src/evaluate.js';
import { trustedPolicyDigestForConfig } from '../src/execution.js';
import { runPipeline } from '../src/pipeline.js';
import { resolveStateDir } from '../src/state.js';
import {
  configYml,
  currentInputDigest,
  installFixture,
  OBLIGATION_ACCOUNTS,
  runCli,
  writeV2Manifest,
} from './helpers.js';

// The catalog's derived logical key: `runner:project:file:title path`.
const TEST_KEY = 'playwright:-:tests/accounts.spec.ts:Accounts>reads accounts';
const REASON = 'flaky in CI: seeded clock race';

/** Quarantine flags for the fixture test key. */
function quarantineArgs(): string[] {
  return [
    'quarantine',
    TEST_KEY,
    '--owner', 'team-accounts',
    '--approver', 'lead@example.invalid',
    '--reason', REASON,
    '--expires', '2026-01-08',
  ];
}

/**
 * Installs the fixture plus one catalog test, so the quarantine command
 * can resolve a real logical key.
 */
function installQuarantinableFixture(repo: TempRepo): void {
  installFixture(repo, { include: "['src/**/*.txt', 'tests/**/*.spec.ts']" });
  repo.writeFiles({
    'playwright.config.mjs': 'export default { testDir: "tests" };\n',
    'tests/accounts.spec.ts':
      "import { test } from '@playwright/test';\n" +
      "test.describe('Accounts', () => { test('reads accounts', async () => {}); });\n",
    'tests/orders.spec.ts':
      "import { test } from '@playwright/test';\n" +
      "test.describe('Orders', () => { test('lists orders', async () => {}); });\n",
  });
}

describe('gateforge quarantine', () => {
  it('writes one attributed, expiring quarantine', async () => {
    await withTempRepo({}, async (repo) => {
      installQuarantinableFixture(repo);
      const result = await runCli(repo, quarantineArgs());
      expect(result.code, `${result.stdout}\n${result.stderr}`).toBe(0);
      expect(result.stdout).toContain('quarantine written: .gateforge/quarantine/');
      expect(result.stdout).toContain(`  test: ${TEST_KEY}`);
      expect(result.stdout).toContain('its evidence is never used');
      expect(existsSync(join(repo.root, '.gateforge/quarantine'))).toBe(true);
    });
  });

  it('refuses to overwrite an existing quarantine and offers no --force', async () => {
    await withTempRepo({}, async (repo) => {
      installQuarantinableFixture(repo);
      expect((await runCli(repo, quarantineArgs())).code).toBe(0);
      const again = await runCli(repo, quarantineArgs());
      expect(again.code).toBe(2);
      expect(again.stderr).toContain('refusing to overwrite');
      expect(again.stderr).toContain('no --force');
      const forced = await runCli(repo, [...quarantineArgs(), '--force', 'true']);
      expect(forced.code).toBe(2);
      expect(forced.stderr).toContain("unknown flag '--force'");
    });
  });

  it('refuses an expiry beyond the 14-day ceiling', async () => {
    await withTempRepo({}, async (repo) => {
      installQuarantinableFixture(repo);
      const result = await runCli(repo, [
        ...quarantineArgs().slice(0, -1),
        '2026-02-01',
      ]);
      expect(result.code).toBe(2);
      expect(result.stderr).toContain('more than 14 days out');
    });
  });

  it('refuses an expiry in the past', async () => {
    await withTempRepo({}, async (repo) => {
      installQuarantinableFixture(repo);
      const result = await runCli(repo, [...quarantineArgs().slice(0, -1), '2025-01-01']);
      expect(result.code).toBe(2);
      expect(result.stderr).toContain('is not in the future');
    });
  });

  it('refuses a test key the catalog does not report', async () => {
    await withTempRepo({}, async (repo) => {
      installQuarantinableFixture(repo);
      const result = await runCli(repo, [
        ...quarantineArgs().slice(0, 1),
        'playwright:-:tests/accounts.spec.ts:Accounts>reads account',
        ...quarantineArgs().slice(2),
      ]);
      expect(result.code).toBe(2);
      expect(result.stderr).toContain('no test resolves');
    });
  });

  it('refuses a missing attribution flag', async () => {
    await withTempRepo({}, async (repo) => {
      installQuarantinableFixture(repo);
      const result = await runCli(repo, [
        'quarantine',
        TEST_KEY,
        '--owner', 'team-accounts',
        '--reason', REASON,
        '--expires', '2026-01-08',
      ]);
      expect(result.code).toBe(2);
      expect(result.stderr).toContain("quarantine requires '--approver'");
    });
  });

  it('enters the pinned trusted policy, so an agent cannot write one itself', async () => {
    await withTempRepo({}, async (repo) => {
      installQuarantinableFixture(repo);
      const before = trustedPolicyDigestForConfig(
        repo.root,
        loadConfig(join(repo.root, '.gateforge.yml')),
      );
      repo.writeFiles({
        '.gateforge/quarantine/agent-authored.yml': [
          'schemaVersion: 1',
          `testKey: ${TEST_KEY}`,
          'owner: the-agent',
          'approver: the-agent',
          'reason: I would rather not fix the flake',
          'expiresAt: "2026-01-08T00:00:00.000Z"',
          '',
        ].join('\n'),
      });
      const after = trustedPolicyDigestForConfig(
        repo.root,
        loadConfig(join(repo.root, '.gateforge.yml')),
      );
      expect(after).not.toBe(before);
    });
  });
});

describe('expired quarantine', () => {
  it('produces a blocking finding that names the test and its expiry', async () => {
    const findings = expiredQuarantineBlocking([
      {
        file: 'accounts.yml',
        quarantine: {
          schemaVersion: 1,
          testKey: TEST_KEY,
          owner: 'team-accounts',
          approver: 'lead@example.invalid',
          reason: REASON,
          expiresAt: '2026-01-01T00:00:00.000Z',
        },
      },
    ]);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.cause).toBe('QUARANTINE_EXPIRED');
    expect(findings[0]?.name).toBe(TEST_KEY);
    expect(findings[0]?.detail).toContain(TEST_KEY);
    expect(findings[0]?.detail).toContain('2026-01-01T00:00:00.000Z');
    expect(findings[0]?.nextAction).toContain('gateforge quarantine');
  });

  it('produces nothing for an unexpired population', () => {
    expect(expiredQuarantineBlocking([])).toEqual([]);
  });
});

describe('a quarantined test proves nothing', () => {
  it('drops its records, so an obligation it alone covered stays missing', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      const runId = '00000000-0000-4000-8000-000000000009';
      const verifierKey = 'verifier-secret-the-suite-never-sees';
      const flakyTestId = 'flaky-test';
      const actionPayload = { operation: 'read', entityId: 'acc-1' };
      const persistencePayload = {
        entityId: 'acc-1',
        found: true,
        fields: { status: 'active' },
        expectFields: { status: 'active' },
      };
      const visiblePayload = { entityId: 'acc-1', fields: { status: 'active' } };
      const records = [
        {
          kind: 'ui.action',
          testId: flakyTestId,
          origin: 'suite-submitted' as const,
          payload: actionPayload,
          trust: 'witnessed' as const,
        },
        {
          kind: 'persistence.entity',
          testId: flakyTestId,
          origin: 'engine-observed' as const,
          payload: persistencePayload,
          trust: 'witnessed' as const,
        },
        {
          kind: 'ui.visible-result',
          testId: flakyTestId,
          origin: 'suite-submitted' as const,
          payload: visiblePayload,
          trust: 'claimed' as const,
        },
      ].map((row) => ({
        schemaVersion: 1,
        recordId: recordIdOf({
          runId,
          obligationId: OBLIGATION_ACCOUNTS,
          kind: row.kind,
          testId: row.testId,
          origin: row.origin,
          payload: row.payload,
        }),
        runId,
        obligationId: OBLIGATION_ACCOUNTS,
        ...row,
      }));
      const claimInventory = [
        {
          schemaVersion: 1 as const,
          obligationId: OBLIGATION_ACCOUNTS,
          testId: flakyTestId,
          testFile: 'tests/accounts.spec.ts',
        },
      ];
      repo.writeFiles({
        // orders is waived so the accounts obligation alone decides.
        '.gateforge/waivers/orders.json': `${JSON.stringify({
          schemaVersion: 1,
          owner: 'team-orders',
          justificationUrl: 'https://example.invalid/j',
          approver: 'lead@example.invalid',
          scope: {
            kind: 'exact',
            resourceId: 'tenant.orders',
            fingerprint: '4e539aba96c0b60d682ac4a70f4c011c85600263d283c89f640c5557601a10f3',
          },
          expiresAt: '2027-01-01T00:00:00.000Z',
        })}\n`,
        '.gateforge/test-gates/claims.json': JSON.stringify(claimInventory),
        '.gateforge/test-gates/records.json': JSON.stringify(records),
      });
      await writeV2Manifest(repo, {
        runId,
        verifierKey,
        recordIds: records.map((row) => row.recordId),
      });
      const inputDigest = await currentInputDigest(repo);

      const config = loadConfig(join(repo.root, '.gateforge.yml'));
      const previousCwd = process.cwd();
      if (previousCwd !== repo.root) process.chdir(repo.root);
      try {
        const stateDir = resolveStateDir(repo.root);
        const pipeline = await runPipeline({
          cwd: repo.root,
          env: { ...process.env },
          config,
          provider: 'all-files',
          stateDir,
        });
        const grade = (excludedTestIds?: readonly string[]) =>
          evaluateRun({
            cwd: repo.root,
            config,
            graph: pipeline.graph,
            obligations: pipeline.policy.obligations,
            blocking: pipeline.policy.blocking,
            stateDir,
            now: pipeline.now,
            changedFiles: null,
            claimInventory,
            ...(excludedTestIds === undefined ? {} : { excludedTestIds }),
            witnessVerifierKey: verifierKey,
            witnessVerifierKeys: [verifierKey],
            evidenceContext: {
              expectedInputDigest: inputDigest,
              snapshotUnavailable: false,
              requireInvocationId: false,
              changedInputs: false,
            },
          }).verdicts.find((verdict) => verdict.obligation.resourceId === 'tenant.accounts')?.verdict;
        // Genuine witnessed evidence from the flaky test satisfies…
        expect(grade()).toBe('satisfied');
        // …and the owner's quarantine takes exactly that proof away.
        expect(grade([flakyTestId])).toBe('missing');
      } finally {
        if (previousCwd !== repo.root) process.chdir(previousCwd);
      }
    });
  });
});

describe('quarantine and the default config', () => {
  it('leaves a repository that never adopted quarantine behaving exactly as before', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      repo.writeFiles({ '.gateforge.yml': configYml() });
      const result = await runCli(repo, ['check', '--format', 'json']);
      expect(result.code).toBe(1);
      const report = JSON.parse(result.stdout) as Record<string, unknown>;
      expect(report['quarantine']).toBeUndefined();
      expect(report['strictness']).toBeUndefined();
    });
  });
});

describe('check reports the quarantine population', () => {
  it('lists owner-quarantined tests and stays unchanged without any', async () => {
    await withTempRepo({}, async (repo) => {
      installQuarantinableFixture(repo);
      const empty = await runCli(repo, ['check', '--format', 'json']);
      expect((JSON.parse(empty.stdout) as Record<string, unknown>)['quarantine']).toBeUndefined();
      repo.writeFiles({
        '.gateforge/quarantine/accounts.yml': [
          'schemaVersion: 1',
          `testKey: ${TEST_KEY}`,
          'owner: team-accounts',
          'approver: lead@example.invalid',
          'reason: flaky in CI',
          'expiresAt: "2026-01-08T00:00:00.000Z"',
          '',
        ].join('\n'),
      });
      const result = await runCli(repo, ['check', '--format', 'json']);
      expect(result.code).toBe(1);
      const report = JSON.parse(result.stdout) as {
        quarantine: { count: number; tests: Array<{ testKey: string; expiresAt: string }> };
      };
      expect(report.quarantine.count).toBe(1);
      expect(report.quarantine.tests[0]?.testKey).toBe(TEST_KEY);
      const text = await runCli(repo, ['check']);
      expect(text.stdout).toContain('quarantined: 1 (expires');
    });
  });
});
