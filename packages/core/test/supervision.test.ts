/**
 * Trusted-supervision unit tests (plan 2026-09-13 Phase 4 item 4, ADR
 * 0005 D2): the expected set is fixed before the run and every deviation
 * — zero tests, `.only`/`.skip`/`.fixme`, retry-assisted attempts,
 * missing/extra instances, failures, expected failures, teardown errors,
 * incomplete shards, nonzero exit — is a typed blocking cause
 * (TEST_NOT_EXECUTED / TEST_FAILED / RUN_INCOMPLETE). There is no
 * selective pass out of a failed required suite. Engine class per
 * TESTING_POLICY.md.
 */
import { describe, expect, it } from 'vitest';
import {
  superviseExecution,
  type ExecutedOutcomeInput,
  type PlannedInstanceInput,
  type SupervisionEnvelopeInput,
  type TracedTestInput as TracedTest,
} from '../src/index.js';

const FILE = 'e2e/accounts.spec.ts';
const KEY = 'playwright:chromium:e2e/accounts.spec.ts:Accounts>deletes an account';
const KEY2 = 'playwright:chromium:e2e/accounts.spec.ts:Accounts>creates an account';

/** One planned instance (overrides allowed). */
function planned(overrides: Partial<PlannedInstanceInput> = {}): PlannedInstanceInput {
  return {
    logicalKey: KEY,
    project: 'chromium',
    file: FILE,
    titlePath: ['Accounts', 'deletes an account'],
    blockingAnnotations: [],
    ...overrides,
  };
}

/** One executed outcome (overrides allowed; first-attempt pass default). */
function executed(overrides: Partial<ExecutedOutcomeInput> = {}): ExecutedOutcomeInput {
  return {
    logicalKey: KEY,
    project: 'chromium',
    file: FILE,
    titlePath: ['Accounts', 'deletes an account'],
    status: 'passed',
    attempt: 1,
    expectedFailure: false,
    ...overrides,
  };
}

/** The complete-run envelope all deviations start from. */
function envelope(overrides: Partial<SupervisionEnvelopeInput> = {}): SupervisionEnvelopeInput {
  return {
    processExit: 0,
    complete: true,
    outcomes: [executed()],
    fixtureOutcome: 'passed',
    shards: null,
    retriesDetected: false,
    ...overrides,
  };
}

/** The cause list of a supervision result (order as produced). */
function causes(findings: readonly { cause: string }[]): string[] {
  return findings.map((finding) => finding.cause);
}

describe('superviseExecution: the complete expected set passing on first attempts is complete', () => {
  it('a clean multi-instance run produces zero findings', () => {
    const result = superviseExecution([planned(), planned({ logicalKey: KEY2, titlePath: ['Accounts', 'creates an account'] })], {
      ...envelope(),
      outcomes: [executed(), executed({ logicalKey: KEY2, titlePath: ['Accounts', 'creates an account'] })],
    });
    expect(result.complete).toBe(true);
    expect(result.findings).toEqual([]);
  });

  it('the verdict is pure: identical inputs produce identical results', () => {
    const first = superviseExecution([planned()], envelope());
    const second = superviseExecution([planned()], envelope());
    expect(second).toEqual(first);
  });
});

describe('superviseExecution: zero tests and unenumerable cases (E08/E16)', () => {
  it('an empty expected set is TEST_NOT_EXECUTED — an empty run never proves coverage', () => {
    const result = superviseExecution([], envelope({ outcomes: [] }));
    expect(result.complete).toBe(false);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.cause).toBe('TEST_NOT_EXECUTED');
    expect(result.findings[0]?.detail).toMatch(/zero tests/i);
  });

  it('`.only`, `.skip`, and `.fixme` in the required selection are each blocking', () => {
    const result = superviseExecution(
      [planned({ blockingAnnotations: ['only', 'skip', 'fixme'] })],
      envelope(),
    );
    expect(result.complete).toBe(false);
    expect(causes(result.findings).filter((cause) => cause === 'TEST_NOT_EXECUTED')).toHaveLength(3);
    expect(result.findings.map((finding) => finding.detail).join('\n')).toMatch(/'only'/);
    expect(result.findings.map((finding) => finding.detail).join('\n')).toMatch(/'skip'/);
    expect(result.findings.map((finding) => finding.detail).join('\n')).toMatch(/'fixme'/);
  });

  it('a case the runner never enumerated blocks as RUN_INCOMPLETE', () => {
    const result = superviseExecution(
      [planned({ unenumeratedReason: 'unresolved-call: removeAccount(page)' })],
      envelope(),
    );
    expect(result.complete).toBe(false);
    expect(result.findings.some((finding) => finding.cause === 'RUN_INCOMPLETE' && /enumerate/i.test(finding.detail))).toBe(true);
  });
});

describe('superviseExecution: planned versus executed (ADR 0005 D2)', () => {
  it('a planned instance that never executed is RUN_INCOMPLETE (E12 missing case)', () => {
    const result = superviseExecution(
      [planned(), planned({ logicalKey: KEY2, titlePath: ['Accounts', 'creates an account'] })],
      envelope(),
    );
    expect(result.complete).toBe(false);
    expect(
      result.findings.some(
        (finding) => finding.cause === 'RUN_INCOMPLETE' && /never executed/.test(finding.detail) && finding.logicalKey === KEY2,
      ),
    ).toBe(true);
  });

  it('an executed instance outside the expected set is RUN_INCOMPLETE — no selective narrowing', () => {
    const result = superviseExecution(
      [planned()],
      envelope({ outcomes: [executed(), executed({ logicalKey: ' smuggled', titlePath: ['Accounts', 'smuggled'] })] }),
    );
    expect(result.complete).toBe(false);
    expect(
      result.findings.some((finding) => /outside the planned expected set/.test(finding.detail)),
    ).toBe(true);
  });

  it('a passed instance on attempt 2 is retry-assisted: RUN_INCOMPLETE even though it passed (E08)', () => {
    const result = superviseExecution([planned()], envelope({ outcomes: [executed({ attempt: 2 })], retriesDetected: true, retriesDetail: 'attempt 2 observed' }));
    expect(result.complete).toBe(false);
    expect(result.findings.some((finding) => finding.cause === 'RUN_INCOMPLETE' && /retr/i.test(finding.detail))).toBe(true);
  });

  it('an attempt-2 outcome blocks even when the adapter failed to raise its retry flag (fail closed)', () => {
    const result = superviseExecution([planned()], envelope({ outcomes: [executed({ attempt: 3 })], retriesDetected: false }));
    expect(result.complete).toBe(false);
    expect(
      result.findings.some(
        (finding) => finding.cause === 'RUN_INCOMPLETE' && /attempt 3/.test(finding.detail) && finding.logicalKey === KEY,
      ),
    ).toBe(true);
  });
});

describe('superviseExecution: failures, exemptions, teardown, shards, exit (E07/E08/E12)', () => {
  it('a failed instance is TEST_FAILED and fails the whole run even though its sibling passed (no selective pass out of a failed suite)', () => {
    const result = superviseExecution(
      [planned(), planned({ logicalKey: KEY2, titlePath: ['Accounts', 'creates an account'] })],
      {
        ...envelope(),
        outcomes: [
          executed(),
          executed({ logicalKey: KEY2, titlePath: ['Accounts', 'creates an account'], status: 'failed' }),
        ],
      },
    );
    expect(result.complete).toBe(false);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.cause).toBe('TEST_FAILED');
    expect(result.findings[0]?.logicalKey).toBe(KEY2);
  });

  it('an expected failure is TEST_NOT_EXECUTED — an exemption never proves behavior', () => {
    const result = superviseExecution([planned()], envelope({ outcomes: [executed({ expectedFailure: true })] }));
    expect(result.complete).toBe(false);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.cause).toBe('TEST_NOT_EXECUTED');
    expect(result.findings[0]?.detail).toMatch(/expected failure/i);
  });

  it('a failed instance marked expected-failure still blocks (the exemption is the cause)', () => {
    const result = superviseExecution([planned()], envelope({ outcomes: [executed({ status: 'failed', expectedFailure: true })] }));
    expect(result.complete).toBe(false);
    expect(causes(result.findings)).toEqual(['TEST_NOT_EXECUTED']);
  });

  it('skipped, fixme, and not-run outcomes are TEST_NOT_EXECUTED — a skip is never coverage', () => {
    for (const status of ['skipped', 'fixme', 'not-run'] as const) {
      const result = superviseExecution([planned()], envelope({ outcomes: [executed({ status })] }));
      expect(result.complete, `status ${status}`).toBe(false);
      expect(causes(result.findings), `status ${status}`).toEqual(['TEST_NOT_EXECUTED']);
    }
  });

  it('a teardown/setup failure is RUN_INCOMPLETE (E07 teardown leg)', () => {
    const result = superviseExecution([planned()], envelope({ fixtureOutcome: 'failed' }));
    expect(result.complete).toBe(false);
    expect(result.findings.some((finding) => finding.cause === 'RUN_INCOMPLETE' && /teardown/i.test(finding.detail))).toBe(true);
  });

  it('a lost fixture/teardown outcome (crash, lost reporter contact) fails closed', () => {
    const result = superviseExecution([planned()], envelope({ fixtureOutcome: 'unknown' }));
    expect(result.complete).toBe(false);
    expect(result.findings.some((finding) => /fail closed/.test(finding.detail))).toBe(true);
  });

  it('an incomplete shard is RUN_INCOMPLETE (E12)', () => {
    const result = superviseExecution([planned()], envelope({ shards: { complete: false, detail: 'TEST_SHARD reported 1/2' } }));
    expect(result.complete).toBe(false);
    expect(result.findings.some((finding) => /incomplete shards/.test(finding.detail))).toBe(true);
  });

  it('an adapter-judged incomplete run (timeout, crash) is RUN_INCOMPLETE with the adapter detail', () => {
    const result = superviseExecution(
      [planned()],
      envelope({ complete: false, incompleteDetail: 'supervised run exceeded its bound and was killed' }),
    );
    expect(result.complete).toBe(false);
    expect(result.findings.some((finding) => /exceeded its bound/.test(finding.detail))).toBe(true);
  });

  it('an adapter-judged incomplete run without detail still fails closed', () => {
    const result = superviseExecution([planned()], envelope({ complete: false }));
    expect(result.complete).toBe(false);
    expect(result.findings.some((finding) => /fail closed/.test(finding.detail))).toBe(true);
  });

  it('a nonzero runner exit is RUN_INCOMPLETE even when every reported row passed', () => {
    const result = superviseExecution([planned()], envelope({ processExit: 1 }));
    expect(result.complete).toBe(false);
    expect(result.findings.some((finding) => /exited with status 1/.test(finding.detail))).toBe(true);
  });
});

describe('superviseExecution: deterministic output', () => {
  it('findings are sorted by (cause, logicalKey, detail) regardless of input order', () => {
    const result = superviseExecution(
      [
        planned({ logicalKey: 'b', titlePath: ['b'], blockingAnnotations: ['skip'] }),
        planned({ logicalKey: 'a', titlePath: ['a'], blockingAnnotations: ['skip'] }),
      ],
      envelope({
        outcomes: [
          executed({ logicalKey: 'c', titlePath: ['c'], status: 'failed' }),
          executed({ logicalKey: 'd', titlePath: ['d'], status: 'skipped' }),
        ],
      }),
    );
    const ordered = result.findings.map((finding) => `${finding.cause}|${finding.logicalKey ?? ''}`);
    expect(ordered).toEqual([...ordered].sort());
    expect(result.complete).toBe(false);
  });
});

/**
 * The execution authority (enforcement-review fix 2): when the
 * supervisor supplies the witness-side session trace, completeness is
 * graded from IT — the runner-reported outcomes document is
 * suite-writable and is demoted to detail input. These cases pin the
 * review's fabricated-outcome attack and the trace vocabulary.
 */
describe('superviseExecution: the witness-side session trace is the execution authority (fix 2)', () => {
  /** A sealed passing session for the default planned instance. */
  function sealedPassed(sessionId = '0f9e8d7c-0000-4000-8000-000000000001'): TracedTest {
    return {
      testId: 'spec-1',
      project: 'chromium',
      file: FILE,
      titlePath: ['Accounts', 'deletes an account'],
      sessions: [{ sessionId, openedTick: 1, sealedTick: 2, outcome: 'passed' , activity: 3 }],
    };
  }

  it('THE review attack: a fabricated passing outcomes document + exit 0 with no sealed sessions is typed RUN_INCOMPLETE', () => {
    // The hostile runner wrote a fully green outcomes file and exited 0
    // before any spec executed (the reviewed probe). The adapter alone
    // cannot see through it — but the witness recorded NO session for
    // the expected test, and supervision grades from the trace.
    const result = superviseExecution([planned()], {
      ...envelope(),
      sessionTrace: [], // the witness holds zero sessions for this run
    });
    expect(result.complete).toBe(false);
    const finding = result.findings.find((entry) => entry.logicalKey === KEY);
    expect(finding?.cause).toBe('RUN_INCOMPLETE');
    expect(finding?.detail).toContain('has no sealed session in the witness trace');
    expect(finding?.detail).toContain('never proves execution');
  });

  it('a trace the supervisor could not fetch (null) blocks outright — a missing authority is never success', () => {
    const result = superviseExecution([planned()], { ...envelope(), sessionTrace: null });
    expect(result.complete).toBe(false);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.cause).toBe('RUN_INCOMPLETE');
    expect(result.findings[0]?.detail).toContain('execution trace is unavailable');
  });

  it('every sealed session must have passed: unsealed or non-passed sessions block', () => {
    const unsealed = superviseExecution([planned()], {
      ...envelope(),
      sessionTrace: [
        {
          testId: 'spec-1',
          project: 'chromium',
          file: FILE,
          titlePath: ['Accounts', 'deletes an account'],
          sessions: [{ sessionId: 's-1', openedTick: 1, sealedTick: null, outcome: null , activity: 3 }],
        },
      ],
    });
    expect(unsealed.complete).toBe(false);
    expect(unsealed.findings.some((finding) => /unsealed session/.test(finding.detail))).toBe(true);

    const failedOutcome = superviseExecution([planned()], {
      ...envelope(),
      sessionTrace: [
        {
          testId: 'spec-1',
          project: 'chromium',
          file: FILE,
          titlePath: ['Accounts', 'deletes an account'],
          sessions: [{ sessionId: 's-2', openedTick: 1, sealedTick: 2, outcome: 'failed' , activity: 3 }],
        },
      ],
    });
    expect(failedOutcome.complete).toBe(false);
    expect(
      failedOutcome.findings.some((finding) => /sealed session .* with outcome 'failed'/.test(finding.detail)),
    ).toBe(true);
  });

  it('a session for a test outside the expected set blocks (nothing hides outside supervision)', () => {
    const result = superviseExecution([planned()], {
      ...envelope(),
      sessionTrace: [
        sealedPassed(),
        {
          testId: 'smuggled',
          project: null,
          file: 'e2e/smuggled.spec.ts',
          titlePath: ['Smuggled'],
          sessions: [{ sessionId: 's-3', openedTick: 3, sealedTick: 4, outcome: 'passed' , activity: 3 }],
        },
      ],
    });
    expect(result.complete).toBe(false);
    expect(
      result.findings.some((finding) => /outside the expected set/.test(finding.detail)),
    ).toBe(true);
  });

  it('REGRESSION (authority moved): a sealed-passed session with ZERO activity still grades complete', () => {
    // Execution-authority fix: session fabrication is defeated at the
    // trusted reporter channel (trusted-config synthesis + unknown
    // run-state paths + lifecycle-conflict detection), NOT by counting
    // activity. A genuine passing test that never touches the witness
    // still executed — the supervisor observed its begin/end — so zero
    // activity is corroboration detail, never a block. (The old
    // fabricated-spool attack is dead because the hostile config never
    // loads; see execution-authority.test.ts for the real-runner proof.)
    const result = superviseExecution([planned()], {
      ...envelope(),
      sessionTrace: [
        {
          testId: 'spec-1',
          project: 'chromium',
          file: FILE,
          titlePath: ['Accounts', 'deletes an account'],
          sessions: [{ sessionId: 's-9', openedTick: 1, sealedTick: 2, outcome: 'passed', activity: 0 }],
        },
      ],
    });
    expect(result.complete).toBe(true);
    expect(result.findings).toHaveLength(0);
  });

  it('REGRESSION: witness-observed activity (>=1) corroborates the sealed-passed session', () => {
    const result = superviseExecution([planned()], {
      ...envelope(),
      sessionTrace: [
        {
          testId: 'spec-1',
          project: 'chromium',
          file: FILE,
          titlePath: ['Accounts', 'deletes an account'],
          sessions: [{ sessionId: 's-10', openedTick: 1, sealedTick: 2, outcome: 'passed', activity: 4 }],
        },
      ],
    });
    expect(result.complete).toBe(true);
    expect(result.findings).toHaveLength(0);
  });

  it('a complete trace (every expected test sealed passing) grades complete despite hostile-looking outcomes', () => {
    // The positive control: sealed passed sessions for every expected
    // test — runner-reported detail cannot break it, and the authority
    // agreeing with the plan yields zero findings.
    const result = superviseExecution(
      [planned(), planned({ logicalKey: KEY2, titlePath: ['Accounts', 'creates an account'] })],
      {
        ...envelope({
          outcomes: [
            executed(),
            executed({ logicalKey: KEY2, titlePath: ['Accounts', 'creates an account'] }),
          ],
        }),
        sessionTrace: [
          sealedPassed(),
          {
            testId: 'spec-2',
            project: 'chromium',
            file: FILE,
            titlePath: ['Accounts', 'creates an account'],
            sessions: [{ sessionId: '0f9e8d7c-0000-4000-8000-000000000002', openedTick: 5, sealedTick: 6, outcome: 'passed' , activity: 3 }],
          },
        ],
      },
    );
    expect(result.complete).toBe(true);
    expect(result.findings).toEqual([]);
  });
});
