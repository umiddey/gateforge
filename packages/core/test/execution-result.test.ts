/**
 * Execution-result record tests (plan 2026-09-13 §5.1 row "Execution
 * result", Phase 4 item 3, ADR 0005 D2): the strict schema's internal
 * consistency (complete ⇔ zero causes) and the domain-separated digests
 * the gate receipt binds — an execution-result digest is never a plain
 * canonical hash, and a selection digest is order/duplicate insensitive
 * but binds runner, mode, and the exact logical-key set.
 */
import { describe, expect, it } from 'vitest';
import {
  ExecutionResultSchema,
  EXECUTION_RESULT_DOMAIN,
  SELECTION_DOMAIN,
  executionResultDigestOf,
  selectionDigestOf,
  sha256Canonical,
  type ExecutionResult,
} from '../src/index.js';

const RUN_ID = '11111111-2222-4333-8444-555555555555';
const INVOCATION_ID = '66666666-7777-4888-8999-000000000000';
const HEX = (seed: number): string => String(seed).repeat(64);

/** A minimal complete execution result (overrides allowed). */
function result(overrides: Partial<ExecutionResult> = {}): ExecutionResult {
  const selection = {
    runner: 'playwright',
    mode: 'full-relevant-suite' as const,
    logicalKeys: ['playwright:chromium:e2e/a.spec.ts:deletes'],
  };
  return {
    schemaVersion: 1,
    runId: RUN_ID,
    invocationId: INVOCATION_ID,
    inputDigest: HEX(1),
    trustedPolicyDigest: HEX(2),
    selection,
    selectionDigest: selectionDigestOf(selection),
    catalogDigest: HEX(3),
    planned: [
      {
        logicalKey: 'playwright:chromium:e2e/a.spec.ts:deletes',
        project: 'chromium',
        file: 'e2e/a.spec.ts',
        titlePath: ['deletes'],
        frameworkId: null,
      },
    ],
    outcomes: [
      {
        logicalKey: 'playwright:chromium:e2e/a.spec.ts:deletes',
        project: 'chromium',
        file: 'e2e/a.spec.ts',
        titlePath: ['deletes'],
        status: 'passed',
        attempt: 1,
        expectedFailure: false,
      },
    ],
    runnerExit: 0,
    complete: true,
    causes: [],
    fixtureOutcome: 'passed',
    shardCompleteness: { complete: true, detail: '' },
    maxAttemptObserved: 1,
    engines: { node: 'v22.0.0', playwright: '1.49.0' },
    browsers: { chromium: '131.0.0.0' },
    environmentIdentity: HEX(4),
    startedAt: '2026-09-13T00:00:00.000Z',
    finishedAt: '2026-09-13T00:01:00.000Z',
    ...overrides,
  };
}

describe('ExecutionResultSchema internal consistency', () => {
  it('a complete run with zero causes parses', () => {
    expect(ExecutionResultSchema.safeParse(result()).success).toBe(true);
  });

  it('a "complete" run carrying causes is a rejected contradiction (fail closed)', () => {
    const contradictory = result({
      complete: true,
      causes: [{ cause: 'TEST_FAILED', detail: 'x failed', logicalKey: 'k' }],
    });
    expect(ExecutionResultSchema.safeParse(contradictory).success).toBe(false);
  });

  it('an incomplete run without causes is rejected (every failure is typed)', () => {
    expect(ExecutionResultSchema.safeParse(result({ complete: false, causes: [] })).success).toBe(false);
  });

  it('an incomplete run with at least one typed cause parses', () => {
    const incomplete = result({
      complete: false,
      causes: [{ cause: 'RUN_INCOMPLETE', detail: 'shard 2/3 missing', logicalKey: null }],
    });
    expect(ExecutionResultSchema.safeParse(incomplete).success).toBe(true);
  });

  it('unknown keys are rejected (a hostile run-state edit cannot smuggle authority in)', () => {
    const smuggled = { ...result(), approvedByAgent: true };
    expect(ExecutionResultSchema.safeParse(smuggled).success).toBe(false);
  });

  it('a first-attempt floor holds: attempt 0 and maxAttemptObserved 0 are rejected', () => {
    const zeroAttempt = result({
      outcomes: [
        {
          logicalKey: 'k',
          project: null,
          file: 'e2e/a.spec.ts',
          titlePath: ['deletes'],
          status: 'passed',
          attempt: 0,
          expectedFailure: false,
        },
      ],
    });
    expect(ExecutionResultSchema.safeParse(zeroAttempt).success).toBe(false);
    expect(ExecutionResultSchema.safeParse(result({ maxAttemptObserved: 0 })).success).toBe(false);
  });
});

describe('executionResultDigestOf (the receipt binds THIS digest)', () => {
  it('is deterministic for identical records', () => {
    expect(executionResultDigestOf(result())).toBe(executionResultDigestOf(result()));
  });

  it('changes when any executed outcome changes (a swapped record is detectable)', () => {
    const swapped = result({
      outcomes: [
        {
          logicalKey: 'playwright:chromium:e2e/a.spec.ts:deletes',
          project: 'chromium',
          file: 'e2e/a.spec.ts',
          titlePath: ['deletes'],
          status: 'failed',
          attempt: 1,
          expectedFailure: false,
        },
      ],
      complete: false,
      causes: [{ cause: 'TEST_FAILED', detail: 'x', logicalKey: 'k' }],
    });
    expect(executionResultDigestOf(swapped)).not.toBe(executionResultDigestOf(result()));
  });

  it('is domain-separated: never equal to the plain canonical hash of the record', () => {
    const record = result();
    expect(executionResultDigestOf(record)).not.toBe(sha256Canonical(record as unknown as Record<string, never>));
    expect(EXECUTION_RESULT_DOMAIN).toBe('gateforge.execution-result.v1');
  });
});

describe('selectionDigestOf (the expected set, hashed before the run)', () => {
  it('is insensitive to order and duplicates', () => {
    const base = { runner: 'playwright', mode: 'mapped-selection' as const };
    expect(selectionDigestOf({ ...base, logicalKeys: ['b', 'a'] })).toBe(
      selectionDigestOf({ ...base, logicalKeys: ['a', 'b', 'a'] }),
    );
  });

  it('binds the runner, the mode, and the exact key set', () => {
    const base = { runner: 'playwright', mode: 'full-relevant-suite' as const, logicalKeys: ['a'] };
    const digest = selectionDigestOf(base);
    expect(selectionDigestOf({ ...base, runner: 'pytest' })).not.toBe(digest);
    expect(selectionDigestOf({ ...base, mode: 'mapped-selection' })).not.toBe(digest);
    expect(selectionDigestOf({ ...base, logicalKeys: ['a', 'b'] })).not.toBe(digest);
  });

  it('is domain-separated from every other hash', () => {
    expect(SELECTION_DOMAIN).toBe('gateforge.selection.v1');
    const selection = { runner: 'playwright', mode: 'full-relevant-suite' as const, logicalKeys: ['a'] };
    expect(selectionDigestOf(selection)).not.toBe(sha256Canonical(selection));
  });
});
