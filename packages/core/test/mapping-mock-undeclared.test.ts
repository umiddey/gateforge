/**
 * Undeclared-kind mock bypass (plan 20261024_1500, §5.3 parity): a
 * sidecar entry that DECLARED an E2E kind on a mocked test is refused
 * (TEST_MAPPING_AMBIGUOUS, and the CLI refuses the declaration itself),
 * but the SAME row with the kind left OUT of the entry binds silently:
 * inference keeps the row `browser-e2e`, the binding reaches
 * `mappingGradingClaims`, and the mocked test's evidence grades the
 * obligation. The refusal must key on the EFFECTIVE kind (declared or
 * inferred), not only on a declared one.
 */
import { describe, expect, it } from 'vitest';
import {
  mappingGradingClaims,
  resolveTestMappings,
  type TestCatalogEntry,
  type TestMap,
} from '../src/index.js';

const OBLIGATION = 'tenant.accounts:persistence:create';
const FILE = 'e2e/accounts.spec.ts';
const TITLE_PATH = ['Accounts', 'creates an account'];
const LOGICAL_KEY = `playwright:chromium:${FILE}:${TITLE_PATH.join('>')}`;
const MOCK_SIGNAL = {
  kind: 'mock' as const,
  detail: 'page.route intercepts **/api/v2/accounts',
  location: { file: FILE, line: 12, col: 4 },
};
const BROWSER_SIGNAL = {
  ruleId: 'browser-fixture',
  kind: 'browser-e2e' as const,
  evidence: 'test uses the page fixture',
  location: { file: FILE, line: 10, col: 2 },
};

/** A catalog row inference classified browser-e2e, with observed mocking. */
function mockedBrowserRow(): TestCatalogEntry {
  return {
    logicalKey: LOGICAL_KEY,
    runner: 'playwright',
    project: 'chromium',
    file: FILE,
    titlePath: TITLE_PATH,
    title: 'creates an account',
    sourceLocation: { file: FILE, line: 10, col: 2 },
    parameterIdentity: null,
    sourceDigest: 'a'.repeat(64),
    discoveryStatus: 'discovered',
    reconciliation: 'matched',
    inferredKind: 'browser-e2e',
    kindSignals: [BROWSER_SIGNAL],
    weakSignals: [],
    rulesFired: [BROWSER_SIGNAL],
    categorySignals: [],
    suppressionSignals: [MOCK_SIGNAL],
  };
}

function catalogOf(...entries: TestCatalogEntry[]) {
  return {
    schemaVersion: 1 as const,
    entries,
    unresolved: [],
    parseErrors: [],
    inventoryComplete: true,
    runnerSummaries: [],
  };
}

function sidecarOf(entries: TestMap['tests']): TestMap {
  return { schemaVersion: 1 as const, tests: entries };
}

function entryOf(overrides: Partial<TestMap['tests'][number]> = {}): TestMap['tests'][number] {
  return {
    key: LOGICAL_KEY,
    selector: { runner: 'playwright', project: 'chromium', file: FILE, titlePath: TITLE_PATH },
    claims: [OBLIGATION],
    reason: 'the account creation journey drives this obligation in the browser',
    ...overrides,
  };
}

function resolveFor(entry: TestMap['tests'][number], row: TestCatalogEntry = mockedBrowserRow()) {
  return resolveTestMappings({
    catalog: catalogOf(row),
    nativeClaims: [],
    sidecar: sidecarOf([entry]),
    obligationIds: [OBLIGATION],
  });
}

describe('mocked rows with an undeclared E2E kind (§5.3 parity)', () => {
  it('refuses a mocked browser-e2e row whose sidecar entry omits the kind', () => {
    const resolution = resolveFor(entryOf());
    const ambiguous = resolution.problems.filter(
      (problem) => problem.cause === 'TEST_MAPPING_AMBIGUOUS' && problem.obligationId === OBLIGATION,
    );
    expect(ambiguous).toHaveLength(1);
    expect(ambiguous[0]?.locations.some((location) => location.file === MOCK_SIGNAL.location.file)).toBe(true);
  });

  it('refuses the same row when the kind is declared honestly (the twin the omission hides behind)', () => {
    const resolution = resolveFor(entryOf({ kind: 'browser-e2e' }));
    expect(
      resolution.problems.some(
        (problem) => problem.cause === 'TEST_MAPPING_AMBIGUOUS' && problem.obligationId === OBLIGATION,
      ),
    ).toBe(true);
  });

  it('routes the undeclared mocked row claim into the grading seam — the proof the refusal must interrupt', () => {
    const resolution = resolveFor(entryOf());
    const binding = resolution.obligations
      .find((group) => group.obligationId === OBLIGATION)
      ?.bindings.find((candidate) => candidate.logicalKey === LOGICAL_KEY);
    expect(binding?.origin).toBe('sidecar');
    // The grading seam: sidecar bindings project into declared claims,
    // so the mocked test's witnessed evidence grades the obligation.
    const claims = mappingGradingClaims(resolution, []);
    expect(claims.some((claim) => claim.obligationId === OBLIGATION && claim.testId === LOGICAL_KEY)).toBe(true);
  });
});

describe('rows the effective-kind mock refusal must not touch', () => {
  it('keeps an unmocked undeclared browser-e2e row binding and grading with no problems', () => {
    const row = { ...mockedBrowserRow(), suppressionSignals: [] };
    const resolution = resolveFor(entryOf(), row);
    expect(resolution.problems).toEqual([]);
    const binding = resolution.obligations
      .find((group) => group.obligationId === OBLIGATION)
      ?.bindings.find((candidate) => candidate.logicalKey === LOGICAL_KEY);
    expect(binding?.origin).toBe('sidecar');
    expect(mappingGradingClaims(resolution, []).map((claim) => claim.testId)).toContain(LOGICAL_KEY);
  });

  it('leaves a mocked undeclared non-E2E row unchanged', () => {
    const row = { ...mockedBrowserRow(), inferredKind: 'integration' as const, kindSignals: [] };
    const resolution = resolveFor(entryOf(), row);
    expect(resolution.problems).toEqual([]);
    expect(
      resolution.obligations
        .find((group) => group.obligationId === OBLIGATION)
        ?.bindings.some((candidate) => candidate.logicalKey === LOGICAL_KEY),
    ).toBe(true);
  });

  it('still reports TEST_KIND_UNKNOWN for an undeclared unknown-kind mocked row', () => {
    const row = { ...mockedBrowserRow(), inferredKind: 'unknown' as const, kindSignals: [] };
    const resolution = resolveFor(entryOf(), row);
    expect(
      resolution.problems.some(
        (problem) => problem.cause === 'TEST_KIND_UNKNOWN' && problem.obligationId === OBLIGATION,
      ),
    ).toBe(true);
  });
});
