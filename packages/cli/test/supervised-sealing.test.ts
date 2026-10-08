/**
 * Supervised-execution CLI-side unit tests (plan 2026-09-13 Phase 4,
 * ADR 0005 D2): planning the expected set BEFORE the run, claim
 * injections from resolved mappings, executed-outcome normalization,
 * execution-result sealing (with typed causes fed into blocking entries),
 * and the failure-after-evidence leg — a later failing test fails the
 * seal and can never be receipted.
 */
import { describe, expect, it } from 'vitest';
import type { ResolvedMappings, RunnerExecutionEnvelope, TestCatalog, TestCatalogEntry, TracedTestInput } from '@gate-forge/core';
import type { RunnerOutcomesDocument } from '@gate-forge/pack-playwright';
import {
  claimInjectionsFor,
  executedOutcomesOf,
  planExpectedSet,
  plannedProjectScopes,
  plannedRowsWithProjectDependencies,
  sealExecutionResult,
  supervisionBlocking,
  type PlannedRow,
} from '../src/execution.js';

const FILE = 'e2e/accounts.spec.ts';
const TITLE = ['Accounts', 'deletes an account'];
const KEY = 'playwright:chromium:e2e/accounts.spec.ts:Accounts>deletes an account';
const RUN_ID = '11111111-2222-4333-8444-555555555555';
const INVOCATION_ID = '66666666-7777-4888-8999-000000000000';
const HEX = (seed: number): string => String(seed).repeat(64);

/** One catalog row (overrides allowed). */
function row(overrides: Partial<TestCatalogEntry> = {}): TestCatalogEntry {
  return {
    logicalKey: KEY,
    runner: 'playwright',
    project: 'chromium',
    file: FILE,
    titlePath: TITLE,
    title: 'deletes an account',
    sourceLocation: { file: FILE, line: 3, col: 0 },
    parameterIdentity: null,
    sourceDigest: 'aa'.repeat(32),
    discoveryStatus: 'discovered',
    reconciliation: 'matched',
    inferredKind: 'browser-e2e',
    kindSignals: [],
    weakSignals: [],
    rulesFired: [],
    categorySignals: [],
    suppressionSignals: [],
    ...overrides,
  };
}

function catalog(entries: TestCatalogEntry[]): TestCatalog {
  return { schemaVersion: 1, entries, unresolved: [], parseErrors: [], inventoryComplete: true, runnerSummaries: [] };
}

/** A passing first-attempt outcomes document for the single planned row. */
function passingDoc(): RunnerOutcomesDocument {
  return {
    schemaVersion: 1,
    runStatus: 'passed',
    runnerErrors: [],
    shard: null,
    outcomes: [
      { testId: 'spec-1', file: FILE, titlePath: TITLE, project: 'chromium', status: 'passed', attempt: 1, expectedFailure: false },
    ],
  };
}

function plannedRow(overrides: Partial<PlannedRow['input']> = {}): PlannedRow {
  return {
    planned: {
      logicalKey: KEY,
      project: 'chromium',
      file: FILE,
      titlePath: [...TITLE],
      frameworkId: null,
    },
    input: {
      logicalKey: KEY,
      project: 'chromium',
      file: FILE,
      titlePath: [...TITLE],
      blockingAnnotations: [],
      ...overrides,
    },
  };
}

const COMPLETE_ENVELOPE: RunnerExecutionEnvelope = {
  processExit: 0,
  complete: true,
  outcomes: [],
  fixtureOutcome: 'passed',
  shards: null,
  retriesDetected: false,
  engines: { node: 'v22.0.0' },
  browsers: { chromium: '131.0.0.0' },
};

/** Seal helper with the single-instance defaults. */
function seal(overrides: {
  plannedRows?: PlannedRow[];
  envelope?: RunnerExecutionEnvelope;
  outcomesDoc?: RunnerOutcomesDocument | null;
  logicalKeys?: string[];
  sessionTrace?: readonly TracedTestInput[] | null;
  enumerationDigest?: string;
} = {}) {
  return sealExecutionResult({
    runId: RUN_ID,
    invocationId: INVOCATION_ID,
    inputDigest: HEX(1),
    trustedPolicyDigest: HEX(2),
    runner: 'playwright',
    logicalKeys: overrides.logicalKeys ?? [KEY],
    catalog: catalog([row()]),
    plannedRows: overrides.plannedRows ?? [plannedRow()],
    envelope: overrides.envelope ?? COMPLETE_ENVELOPE,
    outcomesDoc: overrides.outcomesDoc === undefined ? passingDoc() : overrides.outcomesDoc,
    ...(overrides.sessionTrace !== undefined ? { sessionTrace: overrides.sessionTrace } : {}),
    ...(overrides.enumerationDigest !== undefined ? { enumerationDigest: overrides.enumerationDigest } : {}),
    startedAt: '2026-09-13T00:00:00.000Z',
    finishedAt: '2026-09-13T00:01:00.000Z',
  });
}

describe('planExpectedSet (expected set fixed BEFORE the run)', () => {
  it('plans one row per playwright catalog instance, sorted by logical key', () => {
    const second = row({ logicalKey: 'aaa-first', file: 'e2e/a.spec.ts', titlePath: ['first'], title: 'first' });
    const rows = planExpectedSet(catalog([row(), second]));
    expect(rows.map((entry) => entry.planned.logicalKey)).toEqual(['aaa-first', KEY]);
    expect(rows[1]?.planned.project).toBe('chromium');
  });

  it('carries .only/.skip/.fixme as blocking annotations; mocks are not annotations', () => {
    const rows = planExpectedSet(
      catalog([
        row({
          suppressionSignals: [
            { kind: 'skip', detail: 'test.skip', location: { file: FILE, line: 2, col: 0 } },
            { kind: 'only', detail: 'test.only', location: { file: FILE, line: 2, col: 0 } },
            { kind: 'fixme', detail: 'test.fixme', location: { file: FILE, line: 2, col: 0 } },
            { kind: 'mock', detail: 'page.route', location: { file: FILE, line: 4, col: 0 } },
          ],
        }),
      ]),
    );
    expect(rows[0]?.input.blockingAnnotations).toEqual(['fixme', 'only', 'skip']);
  });

  it('carries the unenumerated reason for unresolved rows', () => {
    const rows = planExpectedSet(
      catalog([
        row({
          discoveryStatus: 'unresolved',
          unresolvedReason: { code: 'unresolved-call', detail: 'removeAccount(page)' },
        }),
      ]),
    );
    expect(rows[0]?.input.unenumeratedReason).toBe('unresolved-call: removeAccount(page)');
  });

  it('never plans a row carrying the informational runner note (0.13.9)', () => {
    // The runner's own enumeration is the authority on what executes: a
    // call site it provably never registers (conditional or unreached
    // branch) stays catalog data but plans nothing — demanding it would
    // seal an expected case no session can ever open (0.13.9 consumer
    // run: 92 false RUN_INCOMPLETE).
    const rows = planExpectedSet(
      catalog([
        row({
          discoveryStatus: 'unresolved',
          unresolvedReason: { code: 'dynamic-title', detail: 'test title is computed and cannot be resolved statically' },
          informationalNote: 'call site never registered by the runner: conditional or unreached',
        }),
      ]),
    );
    expect(rows).toEqual([]);
  });
});

describe('claimInjectionsFor (session-open obligation claims; Phase 3 gap closure)', () => {
  it('injects sidecar bindings only; native/prior-run/inferred and stale bindings inject nothing', () => {
    const resolution: ResolvedMappings = {
      obligations: [
        {
          obligationId: 'tenant.accounts:persistence:delete',
          bindings: [
            {
              logicalKey: KEY,
              origin: 'sidecar',
              instances: [
                { runner: 'playwright', project: 'chromium', file: FILE, titlePath: [...TITLE], parameterIdentity: null },
                // Stale: the catalog no longer enumerates this file.
                { runner: 'playwright', project: 'chromium', file: 'e2e/deleted.spec.ts', titlePath: ['x'], parameterIdentity: null },
              ],
              sourceDigest: null,
              declaredKind: 'browser-e2e',
              categories: [],
              reason: null,
              sourceLocation: null,
            },
            {
              logicalKey: KEY,
              origin: 'inferred',
              instances: [{ runner: 'playwright', project: 'chromium', file: FILE, titlePath: [...TITLE], parameterIdentity: null }],
              sourceDigest: null,
              declaredKind: null,
              categories: [],
              reason: null,
              sourceLocation: null,
            },
          ],
        },
        {
          obligationId: 'tenant.accounts:persistence:create',
          bindings: [
            {
              logicalKey: KEY,
              origin: 'native',
              instances: [{ runner: 'playwright', project: 'chromium', file: FILE, titlePath: [...TITLE], parameterIdentity: null }],
              sourceDigest: null,
              declaredKind: null,
              categories: [],
              reason: null,
              sourceLocation: null,
            },
          ],
        },
        {
          obligationId: 'tenant.accounts:persistence:read',
          bindings: [
            {
              logicalKey: KEY,
              origin: 'prior-run',
              instances: [{ runner: 'playwright', project: 'chromium', file: FILE, titlePath: [...TITLE], parameterIdentity: null }],
              sourceDigest: null,
              declaredKind: null,
              categories: [],
              reason: null,
              sourceLocation: null,
            },
          ],
        },
      ],
      ruleBindings: [],
      problems: [],
    };
    const injections = claimInjectionsFor(resolution, catalog([row()]));
    // ONLY the sidecar binding injects. Native annotations ride the
    // current run's reporter (the resolver's native origin is the PRIOR
    // run's claims.json — injecting it would re-attach another run's
    // file-wide claims onto this run's tests, cross-attributing
    // evidence); inferred and prior-run rows are never declarations.
    expect(injections).toEqual({
      [`${FILE}#${TITLE.join('>')}`]: ['tenant.accounts:persistence:delete'],
    });
  });
});

describe('executedOutcomesOf (reporter rows join the planned set; rows outside keep their identity)', () => {
  it('normalizes joined rows to the planned logical key and clamps attempts to ≥1', () => {
    const rows = executedOutcomesOf(passingDoc(), [plannedRow()]);
    expect(rows).toEqual([
      {
        logicalKey: KEY,
        project: 'chromium',
        file: FILE,
        titlePath: TITLE,
        status: 'passed',
        attempt: 1,
        expectedFailure: false,
        runnerTestId: 'spec-1',
      },
    ]);
  });

  it('a row outside the plan keeps its framework-side identity so supervision names it', () => {
    const doc = passingDoc();
    doc.outcomes.push({
      testId: 'spec-2',
      file: 'e2e/other.spec.ts',
      titlePath: ['smuggled'],
      project: null,
      status: 'passed',
      attempt: 1,
      expectedFailure: false,
    });
    const rows = executedOutcomesOf(doc, [plannedRow()]);
    expect(rows[1]?.logicalKey).toBe('e2e/other.spec.ts#smuggled');
  });

  it('an unknown status normalizes to failed (never silently a pass)', () => {
    const doc = passingDoc();
    (doc.outcomes[0] as { status: string }).status = 'interrupted';
    expect(executedOutcomesOf(doc, [plannedRow()])[0]?.status).toBe('failed');
  });

  it('a missing outcomes document yields no executed rows (supervision blocks)', () => {
    expect(executedOutcomesOf(null, [plannedRow()])).toEqual([]);
  });
});

describe('sealExecutionResult (the trusted supervisor record)', () => {
  it('a complete first-attempt run seals complete with zero causes and a stable digest', () => {
    const sealed = seal();
    expect(sealed.result.complete).toBe(true);
    expect(sealed.result.causes).toEqual([]);
    expect(sealed.result.outcomes[0]?.status).toBe('passed');
    expect(sealed.result.maxAttemptObserved).toBe(1);
    expect(sealed.digest).toBe(seal().digest);
    expect(sealed.result.engines).toEqual({ node: 'v22.0.0' });
    expect(sealed.result.browsers).toEqual({ chromium: '131.0.0.0' });
  });

  it('planned versus executed mismatch: a planned instance that never ran is RUN_INCOMPLETE', () => {
    const sealed = seal({ outcomesDoc: null });
    expect(sealed.result.complete).toBe(false);
    expect(sealed.result.causes.some((cause) => cause.cause === 'RUN_INCOMPLETE' && /never executed/.test(cause.detail))).toBe(true);
  });

  it('an executed instance outside the plan is RUN_INCOMPLETE (no selective narrowing)', () => {
    const doc = passingDoc();
    doc.outcomes.push({
      testId: 'spec-2',
      file: 'e2e/other.spec.ts',
      titlePath: ['smuggled'],
      project: null,
      status: 'passed',
      attempt: 1,
      expectedFailure: false,
    });
    const sealed = seal({ outcomesDoc: doc });
    expect(sealed.result.complete).toBe(false);
    expect(sealed.result.causes.some((cause) => /outside the planned expected set/.test(cause.detail))).toBe(true);
  });

  it('a failed instance seals TEST_FAILED and the run is incomplete (E07)', () => {
    const doc = passingDoc();
    (doc.outcomes[0] as { status: string }).status = 'failed';
    const sealed = seal({ outcomesDoc: doc });
    expect(sealed.result.complete).toBe(false);
    expect(sealed.result.causes.map((cause) => cause.cause)).toEqual(['TEST_FAILED']);
  });

  it('retry-assisted execution (attempt 2) seals RUN_INCOMPLETE and the observed max attempt', () => {
    const doc = passingDoc();
    (doc.outcomes[0] as { attempt: number }).attempt = 2;
    const sealed = seal({ outcomesDoc: doc });
    expect(sealed.result.complete).toBe(false);
    expect(sealed.result.maxAttemptObserved).toBe(2);
    expect(sealed.result.causes.some((cause) => cause.cause === 'RUN_INCOMPLETE')).toBe(true);
  });

  it('pre-run honesty signals seal as typed causes without consulting the runner', () => {
    const sealed = seal({
      plannedRows: [plannedRow({ blockingAnnotations: ['skip'] })],
      outcomesDoc: null,
    });
    expect(sealed.result.complete).toBe(false);
    expect(sealed.result.causes.some((cause) => cause.cause === 'TEST_NOT_EXECUTED' && /'skip'/.test(cause.detail))).toBe(true);
  });

  it('a zero-test selection seals TEST_NOT_EXECUTED (never clean)', () => {
    const sealed = seal({
      plannedRows: [],
      logicalKeys: [],
      envelope: { ...COMPLETE_ENVELOPE, outcomes: [] },
      outcomesDoc: { schemaVersion: 1, runStatus: 'passed', runnerErrors: [], shard: null, outcomes: [] },
    });
    expect(sealed.result.complete).toBe(false);
    expect(sealed.result.causes.map((cause) => cause.cause)).toEqual(['TEST_NOT_EXECUTED']);
  });

  it('a teardown failure seals RUN_INCOMPLETE even when every instance passed (E07 teardown leg)', () => {
    const sealed = seal({
      envelope: { ...COMPLETE_ENVELOPE, fixtureOutcome: 'failed' },
    });
    expect(sealed.result.complete).toBe(false);
    expect(sealed.result.causes.some((cause) => cause.cause === 'RUN_INCOMPLETE' && /teardown/i.test(cause.detail))).toBe(true);
  });

  it('an adapter-judged incomplete run (timeout) seals RUN_INCOMPLETE with the detail', () => {
    const sealed = seal({
      envelope: { ...COMPLETE_ENVELOPE, complete: false, incompleteDetail: 'supervised run exceeded its bound and was killed' },
      outcomesDoc: null,
    });
    expect(sealed.result.causes.some((cause) => /exceeded its bound/.test(cause.detail))).toBe(true);
  });
});

/**
 * The witness-side execution authority + expected-set binding
 * (enforcement-review fixes 2b/2d): the sealed record carries the
 * session trace and the enumeration digest, its digest BINDS both (a
 * receipt names exactly the corroborated trace and the enforced expected
 * set), and a fabricated green outcomes document with no sealed
 * sessions seals typed RUN_INCOMPLETE.
 */
describe('sealExecutionResult: session trace + enumeration digest binding (fixes 2b/2d)', () => {
  const SEALED_PASSED: readonly TracedTestInput[] = [
    {
      testId: 'spec-1',
      project: 'chromium',
      file: FILE,
      titlePath: [...TITLE],
      sessions: [{ sessionId: '0f9e8d7c-0000-4000-8000-000000000001', openedTick: 1, sealedTick: 2, outcome: 'passed' , activity: 5 }],
    },
  ];

  it('THE review attack: a fabricated passing outcomes file + exit 0 with no sealed sessions seals RUN_INCOMPLETE', () => {
    // The runner's own account claims a full pass; the witness recorded
    // NO session for the expected test (nothing executed). The sealed
    // result must be incomplete with the typed trace cause — never a
    // receiptable green.
    const sealed = seal({ sessionTrace: [] });
    expect(sealed.result.complete).toBe(false);
    const cause = sealed.result.causes.find((entry) => entry.logicalKey === KEY);
    expect(cause?.cause).toBe('RUN_INCOMPLETE');
    expect(cause?.detail).toContain('has no sealed session in the witness trace');
  });

  it('an unfetchable trace (null) seals RUN_INCOMPLETE — a missing authority is never success', () => {
    const sealed = seal({ sessionTrace: null });
    expect(sealed.result.complete).toBe(false);
    expect(
      sealed.result.causes.some((cause) => /execution trace is unavailable/.test(cause.detail)),
    ).toBe(true);
  });

  it('a corroborating trace (sealed passed sessions) seals complete', () => {
    const sealed = seal({ sessionTrace: SEALED_PASSED });
    expect(sealed.result.complete).toBe(true);
    expect(sealed.result.causes).toEqual([]);
    // The trace is sealed INTO the record (receipts bind the
    // corroborated execution, not the runner's account).
    expect(sealed.result.sessionTrace).toEqual(SEALED_PASSED);
  });

  it('the execution-result digest binds the session trace: any trace change moves the digest', () => {
    const withTrace = seal({ sessionTrace: SEALED_PASSED });
    const otherTrace = seal({
      sessionTrace: [
        {
          testId: 'spec-1',
          project: 'chromium',
          file: FILE,
          titlePath: [...TITLE],
          sessions: [{ sessionId: '0f9e8d7c-0000-4000-8000-000000000009', openedTick: 1, sealedTick: 3, outcome: 'passed' , activity: 5 }],
        },
      ],
    });
    const withoutTrace = seal();
    expect(withTrace.digest).not.toBe(otherTrace.digest);
    expect(withTrace.digest).not.toBe(withoutTrace.digest);
    expect(withoutTrace.result.sessionTrace).toBeUndefined();
  });

  it('the enumeration digest is sealed in and bound: it is present, and changing it moves the record digest', () => {
    const enumerationDigest = HEX(3);
    const sealed = seal({ enumerationDigest, sessionTrace: SEALED_PASSED });
    expect(sealed.result.enumerationDigest).toBe(enumerationDigest);
    const other = seal({ enumerationDigest: HEX(4), sessionTrace: SEALED_PASSED });
    expect(other.result.enumerationDigest).toBe(HEX(4));
    expect(other.digest).not.toBe(sealed.digest);
    // Absent registration (legacy/standalone witness) seals no field.
    const unregistered = seal({ sessionTrace: SEALED_PASSED });
    expect(unregistered.result.enumerationDigest).toBeUndefined();
  });
});

describe('supervisionBlocking (findings become gate blocking entries)', () => {
  it('projects each typed cause with its next action and is never waived away', () => {
    const entries = supervisionBlocking([
      { cause: 'TEST_FAILED', detail: "instance 'k' failed on attempt 1", logicalKey: 'k' },
      { cause: 'RUN_INCOMPLETE', detail: 'incomplete shards: 1/2', logicalKey: null },
    ]);
    expect(entries.map((entry) => entry.cause)).toEqual(['TEST_FAILED', 'RUN_INCOMPLETE']);
    expect(entries.every((entry) => entry.kind === 'finding')).toBe(true);
    expect(entries.every((entry) => typeof entry.nextAction === 'string' && entry.nextAction.length > 0)).toBe(true);
    expect(entries[0]?.name).toBe('k');
    expect(entries[1]?.name).toBeNull();
  });
});

describe('project dependency closure (a narrowed run still runs the setup it depends on)', () => {
  const SETUP_FILE = 'e2e/auth.setup.ts';
  const SETUP_KEY = 'playwright:setup:e2e/auth.setup.ts:authenticate';
  const setupRow = (): PlannedRow => ({
    planned: {
      logicalKey: SETUP_KEY,
      project: 'setup',
      file: SETUP_FILE,
      titlePath: ['authenticate'],
      frameworkId: null,
    },
    input: {
      logicalKey: SETUP_KEY,
      project: 'setup',
      file: SETUP_FILE,
      titlePath: ['authenticate'],
      blockingAnnotations: [],
    },
  });

  it('pulls the setup project tests into a plan that selected only a dependent test', () => {
    const rows = plannedRowsWithProjectDependencies([plannedRow()], [plannedRow(), setupRow()], {
      chromium: ['setup'],
    });
    // Playwright runs a dependency project's tests before the dependent
    // test's own; a plan that dropped them registers identities the run
    // executes with no bound session and fails on the missing artifact.
    expect(rows.map((entry) => entry.planned.logicalKey).sort()).toEqual([KEY, SETUP_KEY]);
  });

  it('closes transitively and keeps the plan sorted by logical key', () => {
    const middle: PlannedRow = {
      planned: {
        logicalKey: 'playwright:middle:e2e/middle.spec.ts:middle',
        project: 'middle',
        file: 'e2e/middle.spec.ts',
        titlePath: ['middle'],
        frameworkId: null,
      },
      input: {
        logicalKey: 'playwright:middle:e2e/middle.spec.ts:middle',
        project: 'middle',
        file: 'e2e/middle.spec.ts',
        titlePath: ['middle'],
        blockingAnnotations: [],
      },
    };
    const rows = plannedRowsWithProjectDependencies([plannedRow()], [plannedRow(), setupRow(), middle], {
      chromium: ['middle'],
      middle: ['setup'],
    });
    // Sorted by logical key (the plan's own order), so a narrowed run's
    // row order stays as deterministic as a full run's.
    expect(rows.map((entry) => entry.planned.project)).toEqual(['chromium', 'middle', 'setup']);
  });

  it('leaves a single-project plan byte-identical', () => {
    const rows = plannedRowsWithProjectDependencies([plannedRow()], [plannedRow(), setupRow()], {});
    expect(rows).toEqual([plannedRow()]);
    expect(plannedProjectScopes(rows)).toEqual([
      { name: 'chromium', files: [FILE] },
    ]);
  });

  it('never pulls back a file neighbour of the selected test', () => {
    const sibling: PlannedRow = {
      planned: {
        logicalKey: 'playwright:chromium:e2e/accounts.spec.ts:Accounts>lists accounts',
        project: 'chromium',
        file: FILE,
        titlePath: ['Accounts', 'lists accounts'],
        frameworkId: null,
      },
      input: {
        logicalKey: 'playwright:chromium:e2e/accounts.spec.ts:Accounts>lists accounts',
        project: 'chromium',
        file: FILE,
        titlePath: ['Accounts', 'lists accounts'],
        blockingAnnotations: [],
      },
    };
    // The selected test's own project contributes NOTHING new: a `--test`
    // run that named one journey must not have the file's other journeys
    // restored "because they share a project". Only a project reached
    // through a dependency edge brings its tests along.
    const rows = plannedRowsWithProjectDependencies([plannedRow()], [plannedRow(), sibling, setupRow()], {
      chromium: ['setup'],
    });
    expect(rows.map((entry) => entry.planned.logicalKey).sort()).toEqual([KEY, SETUP_KEY]);
  });

  it('emits the dependency edge the enumeration captured, filtered to planned projects', () => {
    const scopes = plannedProjectScopes(plannedRowsWithProjectDependencies([plannedRow()], [plannedRow(), setupRow()], {
      chromium: ['setup'],
    }), { chromium: ['setup'] });
    expect(scopes).toEqual([
      { name: 'chromium', files: [FILE], dependencies: ['setup'] },
      // A project with no edges carries NO `dependencies` key at all, so
      // a single-project run's scopes stay byte-identical to before.
      { name: 'setup', files: [SETUP_FILE] },
    ]);
  });

  it('carries the runner-reported per-project timeout onto the planned scope as data', () => {
    const scopes = plannedProjectScopes(
      plannedRowsWithProjectDependencies([plannedRow()], [plannedRow(), setupRow()], { chromium: ['setup'] }),
      { chromium: ['setup'] },
      undefined,
      { chromium: 180_000, unrelated: 90_000 },
    );
    expect(scopes).toEqual([
      { name: 'chromium', files: [FILE], dependencies: ['setup'], timeoutMs: 180_000 },
      { name: 'setup', files: [SETUP_FILE] },
    ]);
  });
});
