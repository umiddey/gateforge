/**
 * `gateforge next`: the single blocking next action (Phase 1 item 2) —
 * navigation, not the gate. Exit 0 clean, 1 next action, 2 config/usage.
 */
import { describe, expect, it } from 'vitest';
import { fingerprint, withTempRepo } from '@gate-forge/core';
import {
  installFixture,
  LIFECYCLE,
  OBLIGATION_ACCOUNTS,
  OBLIGATION_ORDERS,
  POLICY_ID,
  runCli,
} from './helpers.js';

/** A valid, unexpired waiver for one fixture obligation. */
function waiverJson(resourceId: string): string {
  return JSON.stringify({
    schemaVersion: 1,
    owner: 'team-' + resourceId.split('.')[1],
    justificationUrl: 'https://example.invalid/justification',
    approver: 'approver@example.invalid',
    scope: {
      kind: 'exact',
      resourceId,
      fingerprint: fingerprint({
        resourceId,
        contract: 'persistence:read',
        policyId: POLICY_ID,
        lifecycle: LIFECYCLE,
      }),
    },
    expiresAt: '2027-01-01T00:00:00.000Z',
  });
}

describe('gateforge next', () => {
  it('no config → exit 2 directing to init', async () => {
    await withTempRepo({}, async (repo) => {
      const { code, stderr } = await runCli(repo, ['next']);
      expect(code).toBe(2);
      expect(stderr).toContain('gateforge init');
    });
  });

  it('unsatisfied persistence obligations → exit 1 with one overlay next action', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      const { code, stdout } = await runCli(repo, ['next']);
      expect(code).toBe(1);
      // Exactly one action: the lowest obligation id wins the rank.
      expect(stdout).toContain(`next: ${OBLIGATION_ACCOUNTS}`);
      expect(stdout).toContain('cause: TEST_MAPPING_MISSING');
      expect(stdout).toContain('do:');
      expect(stdout).toContain('tests/e2e/gateforge');
      expect(stdout).not.toContain(OBLIGATION_ORDERS);
    });
  });

  it('ranks missing evidence (rank 6) above unmapped intent (rank 8)', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      repo.writeFiles({
        '.gateforge/test-gates/claims.json': JSON.stringify([
          {
            schemaVersion: 1,
            obligationId: OBLIGATION_ORDERS,
            testId: 'suite-test',
            testFile: 'tests/orders.spec.ts',
          },
        ]),
      });
      const { code, stdout } = await runCli(repo, ['next']);
      expect(code).toBe(1);
      expect(stdout).toContain(`next: ${OBLIGATION_ORDERS}`);
      expect(stdout).toContain('cause: EVIDENCE_NOT_COLLECTED');
      expect(stdout).toContain('tests/e2e/gateforge');
    });
  });

  it('--json is parseable with a remainingBlocking count', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      const { code, stdout } = await runCli(repo, ['next', '--json']);
      expect(code).toBe(1);
      const parsed = JSON.parse(stdout) as {
        next: string;
        cause: string;
        why: string;
        do: string;
        remainingBlocking: number;
      };
      expect(parsed.next).toBe(OBLIGATION_ACCOUNTS);
      expect(parsed.cause).toBe('TEST_MAPPING_MISSING');
      expect(typeof parsed.why).toBe('string');
      expect(parsed.do).toContain('tests/e2e/gateforge');
      expect(parsed.remainingBlocking).toBe(1);
    });
  });

  it('--changed honors the diff scope like check', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      repo.git(['add', '-A']);
      const { code, stdout } = await runCli(repo, ['next', '--changed']);
      expect(code).toBe(1);
      expect(stdout).toContain('next:');
      expect(stdout).toContain('cause:');
      expect(stdout).toContain('do:');
    });
  });

  it('waived obligations → exit 0 clean', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      repo.writeFiles({
        '.gateforge/waivers/accounts.json': waiverJson('tenant.accounts'),
        '.gateforge/waivers/orders.json': waiverJson('tenant.orders'),
      });
      const { code, stdout } = await runCli(repo, ['next']);
      expect(code).toBe(0);
      expect(stdout).toContain('clean');
      const json = await runCli(repo, ['next', '--json']);
      expect(json.code).toBe(0);
      const parsed = JSON.parse(json.stdout) as { next: null; remainingBlocking: number };
      expect(parsed.next).toBeNull();
      expect(parsed.remainingBlocking).toBe(0);
    });
  });
});
