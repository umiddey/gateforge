/**
 * One repository-debt number for one run (plan §2, "One blocking
 * number"): a real consumer run printed `412 known (baselined), 87 new
 * blocking` from the in-runner reporter and `396 known (baselined), 0
 * new blocking` from the CLI for the SAME run, and the CLI's own JSON
 * contradicted its own text.
 *
 * The fixture is deliberately the shape that produces the disagreement:
 * the adopted baseline covers a CLAIMED and an UNCLAIMED obligation, a
 * WAIVER covers another, and the rest blocks. The reporter grades claims
 * only; it has no waivers, no scope and no baseline, so it must not
 * print a debt split at all. The gate's split has exactly ONE
 * definition (`repositoryDebtOf`) over the graded verdicts, and its
 * "new blocking" number is the count the gate actually blocks on — the
 * frozen `blocking` total, never a subtraction of the baselined count.
 */
import { describe, expect, it, vi } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig, repositoryDebtOf, renderRun, runExitCode, withTempRepo, type TempRepo } from '@gate-forge/core';
import { GateforgeReporter } from '@gate-forge/pack-playwright';
import { FIXED_AT, installFixture } from './helpers.js';
import { resolveAdoptedBaseline } from '../src/adopted-baseline.js';
import { evaluateRun, obligationFingerprint } from '../src/evaluate.js';
import { runPipeline } from '../src/pipeline.js';
import { resolveStateDir, stateObligations, writeObligations } from '../src/state.js';

const KEY = 'debt-one-number-verifier-key';
const RUN_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

/** Read+delete policy: two obligations per resource. */
const READ_DELETE_POLICIES =
  'schemaVersion: 1\npolicies:\n  - id: user-facing-crud\n    when:\n      exposure: user-facing\n    require:\n      - persistence:read\n      - persistence:delete\n';

/** Verdict values that block a run (exit 1). */
const BLOCKING = ['missing', 'invalid', 'unclassified', 'unresolved', 'stale'] as const;

/** One resource's two obligation ids. */
function obligationsOf(resourceId: string): { read: string; delete: string } {
  return { read: `${resourceId}:persistence:read`, delete: `${resourceId}:persistence:delete` };
}

/** Pin-#2 fingerprint of one read/delete obligation. */
function fingerprintOf(resourceId: string, contract: 'persistence:read' | 'persistence:delete'): string {
  return obligationFingerprint({
    schemaVersion: 1,
    id: `${resourceId}:${contract}`,
    resourceId,
    contract,
    policyId: 'user-facing-crud',
    lifecycle: { create: true, read: true, update: true, delete: true, deleteSemantics: 'hard' },
  });
}

/** Four resources x (read+delete) = eight obligations. */
function installEightObligationFixture(repo: TempRepo): void {
  installFixture(repo);
  repo.writeFiles({
    '.gateforge/policies.yml': READ_DELETE_POLICIES,
    'src/cache.txt': 'cache fixture.table\n',
    'src/queue.txt': 'queue fixture.table\n',
    '.gateforge/adapters/cache.mjs': 'export default {};\n',
    '.gateforge/adapters/queue.mjs': 'export default {};\n',
  });
}

/**
 * The adopted baseline forgives THREE obligations: one CLAIMED
 * (accounts:read) and two UNCLAIMED (accounts:delete, orders:delete).
 */
function writeAdoption(repo: TempRepo): void {
  const fingerprints = [
    fingerprintOf('tenant.accounts', 'persistence:read'),
    fingerprintOf('tenant.accounts', 'persistence:delete'),
    fingerprintOf('tenant.orders', 'persistence:delete'),
  ].sort();
  repo.writeFiles({
    '.gateforge/baselines/obligations.json': `${JSON.stringify({ schemaVersion: 1, fingerprints })}\n`,
    '.gateforge/baselines/adoption.json': `${JSON.stringify({
      schemaVersion: 1,
      adoptedAt: FIXED_AT,
      gitSha: null,
      adopted: fingerprints.length,
      proven: 0,
    })}\n`,
  });
}

/** A time-bounded waiver for ONE unclaimed obligation (cache:read). */
function writeWaiver(repo: TempRepo): void {
  repo.writeFiles({
    '.gateforge/waivers/cache.json': `${JSON.stringify({
      schemaVersion: 1,
      owner: 'team-cache',
      justificationUrl: 'https://example.invalid/justification',
      approver: 'approver@example.invalid',
      scope: {
        kind: 'exact',
        resourceId: 'tenant.cache',
        fingerprint: fingerprintOf('tenant.cache', 'persistence:read'),
      },
      expiresAt: '2027-01-01T00:00:00.000Z',
    })}\n`,
  });
}

/** The obligations the suite CLAIMS (two tests, one claim each). */
const CLAIMED = [obligationsOf('tenant.accounts').read, obligationsOf('tenant.orders').read] as const;

/** Runs the REAL in-suite reporter over the run state the CLI publishes. */
async function runReporter(stateDir: string, obligationsPath: string): Promise<string> {
  const output: string[] = [];
  const log = vi.spyOn(console, 'log').mockImplementation((...values: unknown[]) => {
    output.push(values.map(String).join(' '));
  });
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    const reporter = new GateforgeReporter({
      stateDir,
      runId: RUN_ID,
      outcomesPath: join(stateDir, 'runner-outcomes.json'),
      obligationsPath,
    });
    for (const [index, obligationId] of CLAIMED.entries()) {
      reporter.onTestEnd(
        {
          id: `spec.js > claim ${String(index)}`,
          title: `claim ${String(index)}`,
          annotations: [{ type: 'gateforge', description: obligationId }],
        } as never,
        { status: 'passed', workerIndex: 0, retry: 0 },
      );
    }
    await reporter.onEnd({ status: 'passed' });
  } finally {
    log.mockRestore();
    warn.mockRestore();
  }
  return output.join('\n');
}

describe('repository debt: one definition, one number, one run', () => {
  it('the gate grades one blocking number and the in-runner reporter defers', async () => {
    await withTempRepo({}, async (repo) => {
      installEightObligationFixture(repo);
      writeAdoption(repo);
      writeWaiver(repo);
      const stateDir = resolveStateDir(repo.root);
      const config = loadConfig(join(repo.root, '.gateforge.yml'));
      // In-process plugins resolve repo-relative paths against the
      // process cwd (the production contract) — mirror it.
      const previousCwd = process.cwd();
      if (previousCwd !== repo.root) process.chdir(repo.root);
      try {
        const pipeline = await runPipeline({
          cwd: repo.root,
          env: { ...process.env },
          config,
          provider: 'all-files',
          stateDir,
        });
        const obligationsPath = join(stateDir, 'obligations.json');
        writeObligations(stateDir, stateObligations(pipeline.policy.obligations, pipeline.graph));
        // The CLI publishes the graded scope, and (before the fix) the
        // adopted-baseline id view. The reporter is handed BOTH: a
        // baseline view is not the gate's grading, so it may not print a
        // debt split from it.
        writeFileSync(
          join(stateDir, 'run-scope.json'),
          `${JSON.stringify({ schemaVersion: 1, scope: 'full' })}\n`,
        );
        writeFileSync(
          join(stateDir, 'debt-baseline.json'),
          `${JSON.stringify({
            schemaVersion: 1,
            obligationIds: [
              obligationsOf('tenant.accounts').read,
              obligationsOf('tenant.accounts').delete,
              obligationsOf('tenant.orders').delete,
            ],
          })}\n`,
        );

        // The in-suite half of the run: the reporter writes
        // claims.json, records.json and run-summary.json.
        const stdout = await runReporter(stateDir, obligationsPath);

        // The reporter defers: it never names a debt number it cannot
        // own, so a run can never show two different counts — not even
        // when handed the CLI's baseline id view.
        expect(stdout).toContain('repository debt: graded by gateforge after the run');
        expect(stdout).not.toMatch(/known \(baselined\)/);
        expect(stdout).not.toMatch(/new blocking/);

        // The legacy run-summary keys stay exactly as they were; the
        // unreleased split is gone rather than guessed at.
        const summary = JSON.parse(readFileSync(join(stateDir, 'run-summary.json'), 'utf8')) as {
          repositoryDebt: Record<string, number>;
        };
        expect(summary.repositoryDebt).toEqual({ obligations: 8, unclaimed: 6, blocking: 8 });

        // The gate half of the SAME run: the graded verdicts every
        // surface must report from.
        const evaluated = evaluateRun({
          cwd: repo.root,
          config,
          graph: pipeline.graph,
          obligations: pipeline.policy.obligations,
          blocking: pipeline.policy.blocking,
          stateDir,
          now: pipeline.now,
          changedFiles: null,
          witnessVerifierKey: KEY,
          baseline: resolveAdoptedBaseline(repo.root, config.baselines),
          evidenceContext: {
            expectedInputDigest: null,
            snapshotUnavailable: true,
            requireInvocationId: false,
            changedInputs: false,
          },
        });
        const claims = JSON.parse(readFileSync(join(stateDir, 'claims.json'), 'utf8')) as Array<{
          obligationId: string;
        }>;
        const claimedIds = new Set(claims.map((row) => row.obligationId));
        const debt = repositoryDebtOf({
          verdicts: evaluated.verdicts,
          findings: evaluated.blocking,
          unclaimed: evaluated.verdicts.filter((entry) => !claimedIds.has(entry.obligation.id)).length,
        });

        // 8 obligations: 3 baselined (1 claimed, 2 unclaimed), 1 waived,
        // 4 still blocking. ONE number names what the gate blocks on.
        expect(debt.obligations).toBe(8);
        expect(debt.unclaimed).toBe(6);
        expect(debt.baselined).toBe(3);
        expect(debt.blocking).toBe(4);
        expect(debt.newlyBlocking).toBe(4);
        // The gate really does block on exactly that many obligations:
        // the reported number and the exit decision are one fact.
        const blockingCount =
          evaluated.verdicts.filter((entry) => (BLOCKING as readonly string[]).includes(entry.verdict)).length +
          evaluated.blocking.length;
        expect(blockingCount).toBe(debt.newlyBlocking);
        expect(runExitCode({ verdicts: evaluated.verdicts, blocking: evaluated.blocking })).toBe(1);

        // Text and JSON carry the same numbers.
        const options = {
          scope: 'full',
          mode: 'executed',
          testsPerformedThisInvocation: 2,
          selectedTests: { selected: 2, passed: 2, failed: 0, skipped: 0, expectedFailures: 0 },
          selectedClaims: { selected: 2, satisfied: 0, blocking: 2, blockingEntries: 0, waived: 0 },
          repositoryDebt: debt,
        };
        expect(
          renderRun([], { format: 'text', execution: options } as unknown as Parameters<typeof renderRun>[1]),
        ).toContain(
          'repository debt: 3 known (baselined), 4 new blocking / 8 obligations (6 unclaimed; 0 blocking entries)',
        );
        const json = JSON.parse(
          renderRun([], { format: 'json', execution: options } as unknown as Parameters<typeof renderRun>[1]),
        ) as { execution: { repositoryDebt: { baselined: number; newlyBlocking: number; blocking: number } } };
        expect(json.execution.repositoryDebt).toMatchObject({ baselined: 3, newlyBlocking: 4, blocking: 4 });
      } finally {
        if (process.cwd() !== previousCwd) process.chdir(previousCwd);
      }
    });
  });
});
