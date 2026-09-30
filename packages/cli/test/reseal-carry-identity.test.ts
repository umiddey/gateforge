/**
 * Which parent evidence a test-only re-seal carries: a carried test's
 * records are found by the identity they were stamped with. Natively
 * claimed evidence carries the id the RUNNER gave the test while it ran,
 * which is not the enumerated catalog id when the trusted config lives in
 * another directory (Playwright hashes the file path relative to the
 * config). Found on a real consumer: every carried record was dropped, the
 * re-sealed receipt said `carriedEvidence: true`, and `check
 * --require-e2e` then reported the carried tests' obligations missing.
 */
import { describe, expect, it } from 'vitest';
import type { ExecutionResult } from '@gate-forge/core';
import { executedOutcomesOf } from '../src/execution.js';
import { carriedEvidenceDocuments, carriedTestIdentities } from '../src/reseal-evidence.js';

const CARRIED = 'e2e/orders.spec.ts';
const AFFECTED = 'e2e/faqs.spec.ts';

function planned(file: string, title: string) {
  return {
    file,
    // The enumerated catalog id: a different hash than the runtime id.
    frameworkId: `catalog-${file}#chromium`,
    logicalKey: `playwright:chromium:${file}:${title}`,
    project: 'chromium',
    titlePath: [title],
  };
}

function parentExecution(): ExecutionResult {
  const rows = [planned(CARRIED, 'orders'), planned(AFFECTED, 'faqs')];
  const outcomes = executedOutcomesOf(
    {
      schemaVersion: 1,
      runStatus: 'passed',
      runnerErrors: [],
      shard: null,
      outcomes: rows.map((row) => ({
        testId: `runtime-${row.file}`,
        file: row.file,
        titlePath: row.titlePath,
        project: 'chromium',
        status: 'passed',
        attempt: 1,
        expectedFailure: false,
      })),
    },
    rows.map((row) => ({ planned: row })) as never,
  );
  return { planned: rows, outcomes } as unknown as ExecutionResult;
}

describe('the evidence a test-only re-seal carries', () => {
  it('attributes a natively claimed record by the id the runner gave the carried test', () => {
    const execution = parentExecution();
    expect(execution.outcomes.map((row) => row.runnerTestId)).toEqual([`runtime-${CARRIED}`, `runtime-${AFFECTED}`]);

    const identities = carriedTestIdentities(execution, [AFFECTED]);
    const carried = carriedEvidenceDocuments(
      {
        records: [
          { recordId: 'r1', runId: 'parent', testId: `runtime-${CARRIED}` },
          { recordId: 'r2', runId: 'parent', testId: `runtime-${AFFECTED}` },
        ],
        claims: [
          { testId: `runtime-${CARRIED}`, obligationId: 'tenant.orders:persistence:create' },
          { testId: `runtime-${AFFECTED}`, obligationId: 'tenant.faqs:persistence:create' },
        ],
      },
      identities,
    );
    // The carried test's record survives; the re-run (affected) test's
    // parent record never does, under either of its identities.
    expect(carried.records).toEqual([{ recordId: 'r1', runId: 'parent', testId: `runtime-${CARRIED}` }]);
    expect(carried.claims).toHaveLength(1);
    expect(identities.has(`runtime-${AFFECTED}`)).toBe(false);
  });
});
