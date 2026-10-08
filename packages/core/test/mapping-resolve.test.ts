/**
 * Mapping-resolver unit tests (plan 2026-09-13 §5.2/§5.3, Phase 3):
 * every rule — sidecar/native binding, exact-duplicate dedup, ambiguity
 * with both locations, staleness (delete/rename/title change/unknown
 * obligation id), wildcard rejection, kind-unknown, inference that never
 * grades, prior-run hints, grading-claim projection, and deterministic
 * ordering under shuffled inputs. Engine class per TESTING_POLICY.md.
 */
import { describe, expect, it } from 'vitest';
import {
  CAUSE_NEXT_ACTIONS,
  mappingGradingClaims,
  mappingSuggestions,
  type SuggestionCandidate,
  resolveTestMappings,
  type PriorRunHint,
  type ResolvedMappings,
  type TestCatalog,
  type TestCatalogEntry,
  type TestMap,
  type TestMapEntry,
} from '../src/index.js';
import type { Claim } from '../src/schemas/claim.js';

const OBLIGATION = 'tenant.accounts:persistence:read';
const OTHER_OBLIGATION = 'tenant.orders:persistence:read';
const KEY = 'playwright:chromium:e2e/accounts.spec.js:deletes an account';
const CREATE_KEY = 'playwright:chromium:e2e/accounts.spec.js:Accounts>creates an account';

/** One catalog row (tests override single fields). */
function row(overrides: Partial<TestCatalogEntry> & { logicalKey: string }): TestCatalogEntry {
  return {
    runner: 'playwright',
    project: 'chromium',
    file: 'e2e/accounts.spec.js',
    titlePath: ['deletes an account'],
    title: 'deletes an account',
    sourceLocation: { file: 'e2e/accounts.spec.js', line: 7, col: 0 },
    parameterIdentity: null,
    sourceDigest: 'aa'.repeat(32),
    discoveryStatus: 'discovered',
    reconciliation: 'matched',
    inferredKind: 'unknown',
    kindSignals: [],
    weakSignals: [],
    rulesFired: [],
    categorySignals: [],
    suppressionSignals: [],
    ...overrides,
  };
}

/** A validated catalog with the given rows. */
function catalog(entries: TestCatalogEntry[]): TestCatalog {
  return {
    schemaVersion: 1,
    entries,
    unresolved: [],
    parseErrors: [],
    inventoryComplete: true,
    runnerSummaries: [],
  };
}

/** One sidecar entry (tests override single fields). */
function sidecarEntry(overrides: Partial<TestMapEntry> = {}): TestMapEntry {
  return {
    key: KEY,
    selector: {
      runner: 'playwright',
      project: 'chromium',
      file: 'e2e/accounts.spec.js',
      titlePath: ['deletes an account'],
    },
    claims: [OBLIGATION],
    reason: 'The existing journey deletes the selected account.',
    ...overrides,
  };
}

/** A sidecar document with the given entries. */
function sidecar(tests: TestMapEntry[]): TestMap {
  return { schemaVersion: 1, tests };
}

/** One native annotation claim (reporter shape). */
function nativeClaim(overrides: Partial<Claim> = {}): Claim {
  return {
    schemaVersion: 1,
    obligationId: OBLIGATION,
    testId: 'e2e/accounts.spec.js:deletes-an-account',
    testFile: 'e2e/accounts.spec.js',
    location: { file: 'e2e/accounts.spec.js', line: 7, col: 2 },
    ...overrides,
  };
}

/** Resolver input with sensible defaults. */
function resolveInput(overrides: {
  catalog?: TestCatalog;
  nativeClaims?: Claim[];
  sidecar?: TestMap;
  obligationIds?: string[];
  priorRunHints?: PriorRunHint[];
  nativeErrorFiles?: string[];
  nativeEnumerationFailed?: boolean;
} = {}): Parameters<typeof resolveTestMappings>[0] {
  return {
    catalog: overrides.catalog ?? catalog([row({ logicalKey: KEY })]),
    nativeClaims: overrides.nativeClaims ?? [],
    sidecar: overrides.sidecar ?? { schemaVersion: 1, tests: [] },
    obligationIds: overrides.obligationIds ?? [OBLIGATION, OTHER_OBLIGATION],
    ...(overrides.priorRunHints !== undefined ? { priorRunHints: overrides.priorRunHints } : {}),
    ...(overrides.nativeErrorFiles !== undefined ? { nativeErrorFiles: overrides.nativeErrorFiles } : {}),
    ...(overrides.nativeEnumerationFailed !== undefined
      ? { nativeEnumerationFailed: overrides.nativeEnumerationFailed }
      : {}),
  };
}

/** The bindings resolved for one obligation. */
function bindingsFor(resolution: ResolvedMappings, obligationId: string) {
  return resolution.obligations.find((entry) => entry.obligationId === obligationId)?.bindings ?? [];
}

/** The DECLARED (grading-eligible) bindings for one obligation. */
function declaredBindingsFor(resolution: ResolvedMappings, obligationId: string) {
  return bindingsFor(resolution, obligationId).filter(
    (binding) => binding.origin === 'native' || binding.origin === 'sidecar',
  );
}

describe('resolveTestMappings — binding', () => {
  it('refuses a sidecar claim on a runner-identified setup project', () => {
    const setup = row({ logicalKey: KEY, project: 'setup', setupProjectDependents: ['chromium'] });
    const resolution = resolveTestMappings(
      resolveInput({
        catalog: catalog([setup]),
        sidecar: sidecar([sidecarEntry({ selector: { runner: 'playwright', project: 'setup', file: setup.file, titlePath: setup.titlePath }, kind: 'browser-e2e' })]),
      }),
    );
    expect(bindingsFor(resolution, OBLIGATION)).toEqual([]);
    expect(resolution.problems).toContainEqual(
      expect.objectContaining({
        cause: 'TEST_MAPPING_AMBIGUOUS',
        detail:
          "test 'playwright:chromium:e2e/accounts.spec.js:deletes an account' belongs to setup project 'setup' " +
          "(a dependency of 'chromium'); setup tests prepare state and never carry claims — move the claim to a test that drives the product",
      }),
    );
  });

  it('keeps existing mapping behavior when no runner graph marked setup projects', () => {
    const resolution = resolveTestMappings(
      resolveInput({ sidecar: sidecar([sidecarEntry({ kind: 'browser-e2e' })]) }),
    );
    expect(resolution.problems).toEqual([]);
    expect(bindingsFor(resolution, OBLIGATION)).toHaveLength(1);
  });

  it('binds a sidecar entry to its catalog instances with origin sidecar', () => {
    const resolution = resolveTestMappings(resolveInput({ sidecar: sidecar([sidecarEntry({ kind: 'browser-e2e' })]) }));
    expect(resolution.problems).toEqual([]);
    const bindings = bindingsFor(resolution, OBLIGATION);
    expect(bindings).toHaveLength(1);
    const binding = bindings[0];
    expect(binding?.origin).toBe('sidecar');
    expect(binding?.logicalKey).toBe(KEY);
    expect(binding?.instances).toEqual([
      {
        runner: 'playwright',
        project: 'chromium',
        file: 'e2e/accounts.spec.js',
        titlePath: ['deletes an account'],
        parameterIdentity: null,
      },
    ]);
    expect(binding?.sourceDigest).toBe('aa'.repeat(32));
    expect(binding?.declaredKind).toBe('browser-e2e');
    expect(binding?.reason).toContain('deletes the selected account');
    expect(binding?.sourceLocation).toEqual({ file: 'e2e/accounts.spec.js', line: 7, col: 0 });
    // The unclaimed obligation stays present with zero bindings.
    expect(bindingsFor(resolution, OTHER_OBLIGATION)).toEqual([]);
  });

  it('binds a native annotation claim with origin native', () => {
    const resolution = resolveTestMappings(resolveInput({ nativeClaims: [nativeClaim()] }));
    const bindings = bindingsFor(resolution, OBLIGATION);
    expect(bindings).toHaveLength(1);
    expect(bindings[0]?.origin).toBe('native');
    expect(bindings[0]?.logicalKey).toBe('e2e/accounts.spec.js:deletes-an-account');
    expect(bindings[0]?.instances[0]?.file).toBe('e2e/accounts.spec.js');
  });

  it('dedupes an exact native+sidecar duplicate idempotently (§5.3)', () => {
    const input = resolveInput({
      nativeClaims: [nativeClaim()],
      sidecar: sidecar([sidecarEntry({ kind: 'browser-e2e' })]),
    });
    const first = resolveTestMappings(input);
    const bindings = bindingsFor(first, OBLIGATION);
    expect(bindings).toHaveLength(1);
    expect(bindings[0]?.origin).toBe('sidecar'); // the superset declaration stands
    // Idempotent: resolving the same inputs again yields identical output.
    expect(resolveTestMappings(input)).toEqual(first);
  });

  it('keeps many-to-many mappings (one test, two obligations; two tests, one obligation)', () => {
    const resolution = resolveTestMappings(
      resolveInput({
        catalog: catalog([row({ logicalKey: KEY }), row({ logicalKey: CREATE_KEY, titlePath: ['Accounts', 'creates an account'], title: 'creates an account' })]),
        sidecar: sidecar([
          sidecarEntry({ kind: 'browser-e2e', claims: [OBLIGATION, OTHER_OBLIGATION] }),
          sidecarEntry({
            key: CREATE_KEY,
            selector: { runner: 'playwright', project: 'chromium', file: 'e2e/accounts.spec.js', titlePath: ['Accounts', 'creates an account'] },
            kind: 'browser-e2e',
            claims: [OBLIGATION],
            reason: 'The create journey covers the same resource.',
          }),
        ]),
      }),
    );
    expect(resolution.problems).toEqual([]);
    expect(declaredBindingsFor(resolution, OBLIGATION)).toHaveLength(2);
    expect(declaredBindingsFor(resolution, OTHER_OBLIGATION)).toHaveLength(1);
  });
});

describe('resolveTestMappings — ambiguity (both locations)', () => {
  it('flags two entries claiming one obligation with conflicting kinds', () => {
    const resolution = resolveTestMappings(
      resolveInput({
        catalog: catalog([row({ logicalKey: KEY }), row({ logicalKey: CREATE_KEY, titlePath: ['Accounts', 'creates an account'], title: 'creates an account' })]),
        sidecar: sidecar([
          sidecarEntry({ kind: 'browser-e2e' }),
          sidecarEntry({
            key: CREATE_KEY,
            selector: { runner: 'playwright', project: 'chromium', file: 'e2e/accounts.spec.js', titlePath: ['Accounts', 'creates an account'] },
            kind: 'unit',
            claims: [OBLIGATION],
            reason: 'Marked as a unit check by mistake.',
          }),
        ]),
      }),
    );
    const ambiguous = resolution.problems.filter((problem) => problem.cause === 'TEST_MAPPING_AMBIGUOUS');
    expect(ambiguous).toHaveLength(1);
    const problem = ambiguous[0];
    expect(problem?.obligationId).toBe(OBLIGATION);
    expect(problem?.detail).toContain(`'${KEY}'`);
    expect(problem?.detail).toContain(`'${CREATE_KEY}'`);
    expect(problem?.detail).toContain("'browser-e2e'");
    expect(problem?.detail).toContain("'unit'");
    expect(problem?.locations).toHaveLength(2); // BOTH locations
  });

  it('refuses a declared e2e kind against observed mocking (§5.3)', () => {
    const mocked = catalog([
      row({
        logicalKey: KEY,
        inferredKind: 'unit',
        kindSignals: [{ ruleId: 'http-client-call', kind: 'unit', evidence: 'requests through a client', location: { file: 'e2e/accounts.spec.js', line: 3, col: 2 } }],
        suppressionSignals: [{ kind: 'mock', detail: 'page.route interception inside the test body', location: { file: 'e2e/accounts.spec.js', line: 4, col: 2 } }],
      }),
    ]);
    const resolution = resolveTestMappings(
      resolveInput({ catalog: mocked, sidecar: sidecar([sidecarEntry({ kind: 'browser-e2e' })]) }),
    );
    const ambiguous = resolution.problems.filter((problem) => problem.cause === 'TEST_MAPPING_AMBIGUOUS');
    expect(ambiguous).toHaveLength(1);
    expect(ambiguous[0]?.detail).toContain('cannot override observed mocking');
    expect(ambiguous[0]?.detail).toContain('page.route');
    expect(ambiguous[0]?.locations).toEqual([{ file: 'e2e/accounts.spec.js', line: 4, col: 2 }]);
  });

  it('refuses a declared kind that contradicts strong code signals', () => {
    const strongly = catalog([
      row({
        logicalKey: KEY,
        inferredKind: 'browser-e2e',
        kindSignals: [
          {
            ruleId: 'browser-fixture',
            kind: 'browser-e2e',
            evidence: 'test consumes the page fixture',
            location: { file: 'e2e/accounts.spec.js', line: 7, col: 2 },
          },
        ],
      }),
    ]);
    const resolution = resolveTestMappings(
      resolveInput({ catalog: strongly, sidecar: sidecar([sidecarEntry({ kind: 'unit' })]) }),
    );
    const ambiguous = resolution.problems.filter((problem) => problem.cause === 'TEST_MAPPING_AMBIGUOUS');
    expect(ambiguous).toHaveLength(1);
    expect(ambiguous[0]?.detail).toContain("declares kind 'unit'");
    expect(ambiguous[0]?.detail).toContain("resolved 'browser-e2e'");
    expect(ambiguous[0]?.locations).toContainEqual({ file: 'e2e/accounts.spec.js', line: 7, col: 2 });
  });
  it('explains API-only fixture chains when an E2E mapping contradicts them', () => {
    const apiFixture = catalog([
      row({
        logicalKey: KEY,
        inferredKind: 'api-e2e',
        kindSignals: [
          {
            ruleId: 'api-request-fixture',
            kind: 'api-e2e',
            evidence: 'test uses API fixture chain: apiAs → Api.login → request.newContext()',
            location: { file: 'e2e/accounts.spec.js', line: 7, col: 2 },
          },
        ],
      }),
    ]);
    const resolution = resolveTestMappings(
      resolveInput({ catalog: apiFixture, sidecar: sidecar([sidecarEntry({ kind: 'browser-e2e' })]) }),
    );
    const ambiguous = resolution.problems.filter((problem) => problem.cause === 'TEST_MAPPING_AMBIGUOUS');
    expect(ambiguous).toHaveLength(1);
    expect(ambiguous[0]?.detail).toContain(
      'test uses only an API client (apiAs → Api.login → request.newContext()); it is not an E2E test',
    );
  });


  it('allows observed-e2e over an inferred browser-e2e (Observe refinement, not a contradiction)', () => {
    const browserDriven = catalog([
      row({
        logicalKey: KEY,
        inferredKind: 'browser-e2e',
        kindSignals: [
          {
            ruleId: 'browser-fixture',
            kind: 'browser-e2e',
            evidence: 'test signature declares browser fixture(s): page',
            location: { file: 'e2e/accounts.spec.js', line: 1, col: 0 },
          },
        ],
      }),
    ]);
    const resolution = resolveTestMappings(
      resolveInput({ catalog: browserDriven, sidecar: sidecar([sidecarEntry({ kind: 'observed-e2e' })]) }),
    );
    const ambiguous = resolution.problems.filter((problem) => problem.cause === 'TEST_MAPPING_AMBIGUOUS');
    expect(ambiguous).toEqual([]);
    expect(declaredBindingsFor(resolution, OBLIGATION)).toHaveLength(1);
    expect(declaredBindingsFor(resolution, OBLIGATION)[0]?.declaredKind).toBe('observed-e2e');
  });

  it('still refuses observed-e2e over an inferred api-e2e (Node traffic never transits the proxy)', () => {
    const apiDriven = catalog([
      row({
        logicalKey: KEY,
        inferredKind: 'api-e2e',
        kindSignals: [
          {
            ruleId: 'api-request-fixture',
            kind: 'api-e2e',
            evidence: 'test signature declares API fixture(s): request',
            location: { file: 'e2e/accounts.spec.js', line: 1, col: 0 },
          },
        ],
      }),
    ]);
    const resolution = resolveTestMappings(
      resolveInput({ catalog: apiDriven, sidecar: sidecar([sidecarEntry({ kind: 'observed-e2e' })]) }),
    );
    const ambiguous = resolution.problems.filter((problem) => problem.cause === 'TEST_MAPPING_AMBIGUOUS');
    expect(ambiguous).toHaveLength(1);
    expect(ambiguous[0]?.detail).toContain("declares kind 'observed-e2e'");
    expect(ambiguous[0]?.detail).toContain("resolved 'api-e2e'");
  });

  it('refuses observed-e2e when the catalog observed mocking (mocking disqualifies E2E proof)', () => {
    const mocked = catalog([
      row({
        logicalKey: KEY,
        inferredKind: 'browser-e2e',
        kindSignals: [
          {
            ruleId: 'browser-fixture',
            kind: 'browser-e2e',
            evidence: 'test signature declares browser fixture(s): page',
            location: { file: 'e2e/accounts.spec.js', line: 1, col: 0 },
          },
        ],
        suppressionSignals: [{ kind: 'mock', detail: 'page.route interception inside the test body', location: { file: 'e2e/accounts.spec.js', line: 4, col: 2 } }],
      }),
    ]);
    const resolution = resolveTestMappings(
      resolveInput({ catalog: mocked, sidecar: sidecar([sidecarEntry({ kind: 'observed-e2e' })]) }),
    );
    const ambiguous = resolution.problems.filter((problem) => problem.cause === 'TEST_MAPPING_AMBIGUOUS');
    expect(ambiguous).toHaveLength(1);
    expect(ambiguous[0]?.detail).toContain('cannot override observed mocking');
  });

  it('rejects a file-level selector as the prohibited wildcard (binds nothing)', () => {
    const resolution = resolveTestMappings(
      resolveInput({
        sidecar: sidecar([
          sidecarEntry({ selector: { runner: 'playwright', file: 'e2e/accounts.spec.js' } }),
        ]),
      }),
    );
    const ambiguous = resolution.problems.filter((problem) => problem.cause === 'TEST_MAPPING_AMBIGUOUS');
    expect(ambiguous).toHaveLength(1);
    expect(ambiguous[0]?.detail).toContain('file-level selector');
    expect(ambiguous[0]?.detail).toContain('wildcard');
    // The unsafe declaration binds nothing — only inference may remain.
    expect(declaredBindingsFor(resolution, OBLIGATION)).toEqual([]);
  });
});

describe('resolveTestMappings — staleness', () => {
  it('flags a deleted test (selector matches no catalog row) naming the selector', () => {
    const resolution = resolveTestMappings(
      resolveInput({ catalog: catalog([]), sidecar: sidecar([sidecarEntry()]) }),
    );
    const stale = resolution.problems.filter((problem) => problem.cause === 'TEST_MAPPING_STALE');
    expect(stale).toHaveLength(1);
    expect(stale[0]?.detail).toContain(`'${KEY}'`);
    expect(stale[0]?.detail).toContain('no catalog rows anymore');
    expect(bindingsFor(resolution, OBLIGATION)).toEqual([]);
  });
  it('suppresses stale selectors only for files with native load errors', () => {
    const resolution = resolveTestMappings(
      resolveInput({
        catalog: catalog([
          row({ logicalKey: KEY, reconciliation: 'static-only' }),
          row({
            logicalKey: 'playwright:chromium:e2e/healthy.spec.js:still exists',
            file: 'e2e/healthy.spec.js',
            title: 'still exists',
            titlePath: ['still exists'],
            sourceLocation: { file: 'e2e/healthy.spec.js', line: 3, col: 0 },
          }),
        ]),
        sidecar: sidecar([
          sidecarEntry({
            key: 'load-error',
            selector: {
              runner: 'playwright',
              project: 'chromium',
              file: 'e2e/accounts.spec.js',
              titlePath: ['vanished'],
            },
          }),
          sidecarEntry({
            key: 'healthy-stale',
            selector: {
              runner: 'playwright',
              project: 'chromium',
              file: 'e2e/healthy.spec.js',
              titlePath: ['vanished'],
            },
            claims: [OTHER_OBLIGATION],
          }),
        ]),
        nativeErrorFiles: ['e2e/accounts.spec.js'],
        nativeEnumerationFailed: false,
      }),
    );
    const stale = resolution.problems.filter((problem) => problem.cause === 'TEST_MAPPING_STALE');
    expect(stale).toHaveLength(1);
    expect(stale[0]?.obligationId).toBe(OTHER_OBLIGATION);
    expect(stale[0]?.detail).toContain('e2e/healthy.spec.js');
    expect(declaredBindingsFor(resolution, OBLIGATION)).toEqual([]);
  });


  it('flags a changed title path and suggests the migration target on a rename', () => {
    // Project renamed: the same file/title now lives under a firefox key.
    const renamed = catalog([
      row({ logicalKey: 'playwright:firefox:e2e/accounts.spec.js:deletes an account', project: 'firefox' }),
    ]);
    const resolution = resolveTestMappings(
      resolveTestMappingsRenameFixture(renamed),
    );
    const stale = resolution.problems.filter((problem) => problem.cause === 'TEST_MAPPING_STALE');
    expect(stale).toHaveLength(1);
    expect(stale[0]?.detail).toContain('playwright:firefox:e2e/accounts.spec.js:deletes an account');
    expect(stale[0]?.detail).toContain('migrate the declaration');
    // Never a silent transfer: no DECLARED binding was created for the
    // new key (inference may still suggest it — suggestions only).
    expect(declaredBindingsFor(resolution, OBLIGATION)).toEqual([]);
  });

  it('flags claims referencing an unknown obligation id (§5.4 stale row)', () => {
    const resolution = resolveTestMappings(
      resolveInput({ sidecar: sidecar([sidecarEntry({ claims: ['tenant.ghost:persistence:read'] })]) }),
    );
    const stale = resolution.problems.filter((problem) => problem.cause === 'TEST_MAPPING_STALE');
    expect(stale).toHaveLength(1);
    expect(stale[0]?.detail).toContain("'tenant.ghost:persistence:read'");
    expect(stale[0]?.detail).toContain('not in the current obligation registry');
    expect(declaredBindingsFor(resolution, OBLIGATION)).toEqual([]);
  });

  it('flags a native annotation claim whose obligation vanished', () => {
    const resolution = resolveTestMappings(
      resolveInput({
        nativeClaims: [nativeClaim({ obligationId: 'tenant.gone:persistence:read' })],
      }),
    );
    const stale = resolution.problems.filter((problem) => problem.cause === 'TEST_MAPPING_STALE');
    expect(stale).toHaveLength(1);
    expect(stale[0]?.detail).toContain("'tenant.gone:persistence:read'");
    expect(stale[0]?.locations).toEqual([{ file: 'e2e/accounts.spec.js', line: 7, col: 2 }]);
  });
});

/** Sidecar bound to the chromium key while the catalog only has firefox. */
function resolveTestMappingsRenameFixture(renamed: TestCatalog): Parameters<typeof resolveTestMappings>[0] {
  return resolveInput({ catalog: renamed, sidecar: sidecar([sidecarEntry()]) });
}

describe('resolveTestMappings — kind unknown + inference', () => {
  it('flags a relevant unclassified test with TEST_KIND_UNKNOWN when no kind is declared', () => {
    const resolution = resolveTestMappings(resolveInput({ sidecar: sidecar([sidecarEntry()]) }));
    const unknown = resolution.problems.filter((problem) => problem.cause === 'TEST_KIND_UNKNOWN');
    expect(unknown).toHaveLength(1);
    expect(unknown[0]?.obligationId).toBe(OBLIGATION);
    expect(unknown[0]?.detail).toContain('could not classify');
  });

  it('a declared kind resolves unknown without a problem (§5.3)', () => {
    const resolution = resolveTestMappings(
      resolveInput({ sidecar: sidecar([sidecarEntry({ kind: 'browser-e2e' })]) }),
    );
    expect(resolution.problems).toEqual([]);
  });

  it('inference NEVER auto-writes a mapping: inferred bindings exist but never grade', () => {
    const resolution = resolveTestMappings(resolveInput());
    const bindings = bindingsFor(resolution, OBLIGATION);
    expect(bindings).toHaveLength(1);
    expect(bindings[0]?.origin).toBe('inferred');
    expect(bindings[0]?.reason ?? '').toContain('never auto-declared');
    // Inference is suggestions-only: nothing projects into grading claims.
    expect(mappingGradingClaims(resolution, [])).toEqual([]);
  });

  it('inference does not run for obligations with a declared mapping', () => {
    const resolution = resolveTestMappings(
      resolveInput({ sidecar: sidecar([sidecarEntry({ kind: 'browser-e2e' })]) }),
    );
    expect(bindingsFor(resolution, OBLIGATION).map((binding) => binding.origin)).toEqual(['sidecar']);
  });
});

describe('resolveTestMappings — prior-run hints', () => {
  it('adds prior-run bindings for known keys/obligations, never for grading', () => {
    const resolution = resolveTestMappings(
      resolveInput({ priorRunHints: [{ logicalKey: KEY, obligationId: OBLIGATION }] }),
    );
    const bindings = bindingsFor(resolution, OBLIGATION);
    expect(bindings.some((binding) => binding.origin === 'prior-run')).toBe(true);
    const hint = bindings.find((binding) => binding.origin === 'prior-run');
    expect(hint?.reason).toContain('never satisfies a new run');
    expect(mappingGradingClaims(resolution, [])).toEqual([]);
  });

  it('a hint for an unknown key or obligation is ignored (registry/catalog govern)', () => {
    const resolution = resolveTestMappings(
      resolveInput({
        priorRunHints: [
          { logicalKey: 'playwright:ghost', obligationId: OBLIGATION },
          { logicalKey: KEY, obligationId: 'tenant.ghost:persistence:read' },
        ],
      }),
    );
    expect(bindingsFor(resolution, OBLIGATION).some((binding) => binding.origin === 'prior-run')).toBe(false);
    expect(resolution.problems).toEqual([]);
  });
});

describe('mappingGradingClaims — projection', () => {
  it('projects sidecar bindings into declared claims keyed by logical key', () => {
    const resolution = resolveTestMappings(
      resolveInput({ sidecar: sidecar([sidecarEntry({ kind: 'browser-e2e' })]) }),
    );
    const claims = mappingGradingClaims(resolution, []);
    expect(claims).toHaveLength(1);
    expect(claims[0]?.obligationId).toBe(OBLIGATION);
    expect(claims[0]?.testId).toBe(KEY);
    expect(claims[0]?.testFile).toBe('e2e/accounts.spec.js');
  });

  it('drops exact duplicates of existing run-state claims (idempotent)', () => {
    const resolution = resolveTestMappings(
      resolveInput({
        nativeClaims: [nativeClaim()],
        sidecar: sidecar([sidecarEntry({ kind: 'browser-e2e' })]),
      }),
    );
    // The native claim (testId = runner id) is already the run state's;
    // the dedupe is by (obligationId, testId): the sidecar binding has a
    // different testId, so it projects — but resolving twice changes
    // nothing (same inputs, same claims).
    const claims = mappingGradingClaims(resolution, [nativeClaim()]);
    expect(claims.map((claim) => claim.testId)).toEqual([KEY]);
    expect(mappingGradingClaims(resolution, [nativeClaim(), ...claims])).toEqual([]);
  });
});

describe('mappingSuggestions — reuse ordering', () => {
  it('reports TEST_MAPPING_MISSING with inference candidates and newTestNeeded=unverified', () => {
    const resolution = resolveTestMappings(resolveInput());
    const suggestions = mappingSuggestions({
      catalog: resolveInput().catalog,
      obligationIds: [OBLIGATION, OTHER_OBLIGATION],
      resolution,
    });
    expect(suggestions).toHaveLength(2);
    const missing = suggestions.find((suggestion) => suggestion.obligationId === OBLIGATION);
    expect(missing?.cause).toBe('TEST_MAPPING_MISSING');
    // ONE signal carries this candidate — the title's resource token — and
    // the run offers no route to check it against, so nothing here proves
    // the test drives the request. `unverified` is the honest answer.
    expect(missing?.newTestNeeded).toBe('unverified');
    expect(missing?.candidates[0]?.logicalKey).toBe(KEY);
    expect(missing?.candidates[0]?.why.join(' ')).toContain("resource token 'accounts'");
    // orders: nothing matches 'orders' → genuinely uncovered
    const orders = suggestions.find((suggestion) => suggestion.obligationId === OTHER_OBLIGATION);
    expect(orders?.candidates).toEqual([]);
    expect(orders?.newTestNeeded).toBe('yes');
  });

  it('guides suite-driven browser candidates to observed-e2e and fixture tests to the overlay path', () => {
    const driven = catalog([
      row({
        logicalKey: KEY,
        inferredKind: 'browser-e2e',
        kindSignals: [
          { ruleId: 'browser-fixture', kind: 'browser-e2e', evidence: 'test signature declares browser fixture(s): page', location: { file: 'e2e/accounts.spec.js', line: 1, col: 0 } },
        ],
      }),
      row({
        logicalKey: CREATE_KEY,
        file: 'e2e/accounts-overlay.spec.js',
        titlePath: ['creates an account'],
        title: 'creates an account',
        sourceLocation: { file: 'e2e/accounts-overlay.spec.js', line: 3, col: 0 },
        inferredKind: 'browser-e2e',
        kindSignals: [
          { ruleId: 'browser-fixture', kind: 'browser-e2e', evidence: 'test signature declares browser fixture(s): evidence', location: { file: 'e2e/accounts-overlay.spec.js', line: 1, col: 0 } },
          { ruleId: 'gateforge-fixture', kind: 'browser-e2e', evidence: 'test takes the gateforge evidence fixture', location: { file: 'e2e/accounts-overlay.spec.js', line: 1, col: 0 } },
        ],
      }),
    ]);
    const resolution = resolveTestMappings(resolveInput({ catalog: driven }));
    const suggestions = mappingSuggestions({
      catalog: driven,
      obligationIds: [OBLIGATION],
      resolution,
    });
    expect(suggestions).toHaveLength(1);
    const byKey = new Map((suggestions[0]?.candidates ?? []).map((candidate) => [candidate.logicalKey, candidate]));
    expect(byKey.get(KEY)?.why.join(' ')).toContain('declare kind observed-e2e');
    expect(byKey.get(CREATE_KEY)?.why.join(' ')).toContain('overlay path');
  });

  it('reports TEST_MAPPING_STALE for a stale declaration (never a silent transfer)', () => {
    const resolution = resolveTestMappings(resolveTestMappingsRenameFixture(catalog([])));
    const suggestions = mappingSuggestions({
      catalog: catalog([]),
      obligationIds: [OBLIGATION],
      resolution,
    });
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]?.cause).toBe('TEST_MAPPING_STALE');
    expect(suggestions[0]?.newTestNeeded).toBe('yes');
  });

  it('reports TEST_MAPPING_AMBIGUOUS first in reuse order, with no candidates', () => {
    const resolution = resolveTestMappings(
      resolveInput({
        catalog: catalog([row({ logicalKey: KEY }), row({ logicalKey: CREATE_KEY, titlePath: ['Accounts', 'creates an account'], title: 'creates an account' })]),
        sidecar: sidecar([
          sidecarEntry({ kind: 'browser-e2e' }),
          sidecarEntry({
            key: CREATE_KEY,
            selector: { runner: 'playwright', project: 'chromium', file: 'e2e/accounts.spec.js', titlePath: ['Accounts', 'creates an account'] },
            kind: 'unit',
            claims: [OBLIGATION],
            reason: 'Marked as a unit check by mistake.',
          }),
        ]),
      }),
    );
    const suggestions = mappingSuggestions({
      catalog: catalog([]),
      obligationIds: [OBLIGATION],
      resolution,
    });
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]?.cause).toBe('TEST_MAPPING_AMBIGUOUS');
    expect(suggestions[0]?.nextAction).toBe('Correct the exact mapping');
    expect(suggestions[0]?.newTestNeeded).toBe('no');
  });

  it('produces no suggestion for an obligation with a clean declared mapping', () => {
    const resolution = resolveTestMappings(
      resolveInput({ sidecar: sidecar([sidecarEntry({ kind: 'browser-e2e' })]) }),
    );
    const suggestions = mappingSuggestions({
      catalog: resolveInput().catalog,
      obligationIds: [OBLIGATION],
      resolution,
    });
    expect(suggestions).toEqual([]);
  });
});

describe('mappingSuggestions — evidence ranking (0.9.0 adoption fix)', () => {
  /** A catalog whose only candidate evidence is a category label. */
  const WEAK_KEY = 'playwright:chromium:e2e/account_bank_details.spec.js:probes the account endpoint';
  /** A catalog row that names the resource, the route, and an unmocked folder. */
  const STRONG_KEY =
    'playwright:chromium:tests/e2e/real/accounts_create_matrix.spec.js:@crud(accounts)>company tenant persists';

  const ranked = catalog([
    row({
      logicalKey: WEAK_KEY,
      file: 'e2e/account_bank_details.spec.js',
      titlePath: ['probes the account endpoint'],
      title: 'probes the account endpoint',
      sourceLocation: { file: 'e2e/account_bank_details.spec.js', line: 4, col: 0 },
      categorySignals: [
        { label: 'accounts', ruleId: 'category-keywords', location: { file: 'e2e/account_bank_details.spec.js', line: 4, col: 0 } },
      ],
    }),
    row({
      logicalKey: STRONG_KEY,
      file: 'tests/e2e/real/accounts_create_matrix.spec.js',
      titlePath: ['@crud(accounts)', 'company tenant persists'],
      title: 'company tenant persists',
      sourceLocation: { file: 'tests/e2e/real/accounts_create_matrix.spec.js', line: 11, col: 0 },
    }),
  ]);

  it('ranks the resource+route candidate first instead of the alphabetically earlier one', () => {
    // On 0.8.x the list came back in logical-key order, so the row under
    // `e2e/` sorted ahead of the row that actually exercises the route.
    expect(WEAK_KEY < STRONG_KEY).toBe(true);
    const resolution = resolveTestMappings(resolveInput({ catalog: ranked }));
    const suggestions = mappingSuggestions({
      catalog: ranked,
      obligationIds: [OBLIGATION],
      resolution,
      routeHints: new Map([[OBLIGATION, ['GET /api/v2/accounts']]]),
    });
    const candidates = suggestions[0]?.candidates ?? [];
    expect(candidates.map((candidate) => candidate.logicalKey)).toEqual([STRONG_KEY, WEAK_KEY]);
    expect(candidates.map((candidate) => candidate.rank)).toEqual([1, 2]);
    expect(candidates[0]?.score ?? 0).toBeGreaterThan(candidates[1]?.score ?? 0);
  });

  it('explains the winning rank with the signals that produced it', () => {
    const resolution = resolveTestMappings(resolveInput({ catalog: ranked }));
    const suggestions = mappingSuggestions({
      catalog: ranked,
      obligationIds: [OBLIGATION],
      resolution,
      routeHints: new Map([[OBLIGATION, ['GET /api/v2/accounts']]]),
    });
    expect(suggestions[0]?.candidates[0]?.why.join(' ')).toContain('explicit tag');
  });

  it('tells you to mark the existing test observed-e2e, never to write an overlay as well', () => {
    const resolution = resolveTestMappings(resolveInput({ catalog: ranked }));
    const suggestions = mappingSuggestions({
      catalog: ranked,
      obligationIds: [OBLIGATION],
      resolution,
    });
    const action = suggestions[0]?.nextAction ?? '';
    expect(action).toContain('observed-e2e');
    expect(action).toContain('gateforge test-gates --changed');
    expect(action).not.toContain('Overlay: write');
    expect(action).not.toContain('Do not `tests mark`');
  });

  it('keeps the overlay instruction for an obligation no existing test fits', () => {
    const resolution = resolveTestMappings(resolveInput({ catalog: catalog([]) }));
    const suggestions = mappingSuggestions({
      catalog: catalog([]),
      obligationIds: [OBLIGATION],
      resolution,
    });
    expect(suggestions[0]?.newTestNeeded).toBe('yes');
    expect(suggestions[0]?.nextAction).toBe(CAUSE_NEXT_ACTIONS['TEST_MAPPING_MISSING']);
  });
});

describe('mappingSuggestions — token boundaries (0.9.2 adoption fix)', () => {
  /**
   * A generated endpoint obligation: the plane, the `http-` prefix, the
   * method word, the `api`/`v1` route furniture and the trailing id hash
   * are resource STRUCTURE, not the resource's name. Only
   * `notifications` may be matched against a test.
   */
  const NOTIFICATION_OBLIGATION =
    'tenant.http-get-api-v1-notifications-27cb390c:http:request-observed';
  /** A test tagged with ANOTHER resource's plane-qualified identity. */
  const MATRIX_KEY =
    'playwright:chromium:tests/e2e/account_matrix.spec.js:ACCOUNT matrix';
  /** The test that actually exercises the route. */
  const NOTIFICATION_KEY =
    'playwright:chromium:tests/e2e/real/notifications.spec.js:notifications list shows unread items';
  /** A test naming the resource only as a PREFIX of a longer word. */
  const NEAR_MISS_KEY =
    'playwright:chromium:tests/e2e/notification_center.spec.js:supersedes the notification center';

  const ranked = catalog([
    row({
      logicalKey: MATRIX_KEY,
      file: 'tests/e2e/account_matrix.spec.js',
      titlePath: ['ACCOUNT matrix', '@crud(tenant.accounts:create)', 'the reference admin is findable'],
      title: 'the reference admin is findable',
      sourceLocation: { file: 'tests/e2e/account_matrix.spec.js', line: 9, col: 0 },
    }),
    row({
      logicalKey: NOTIFICATION_KEY,
      file: 'tests/e2e/real/notifications.spec.js',
      titlePath: ['notifications list shows unread items'],
      title: 'notifications list shows unread items',
      sourceLocation: { file: 'tests/e2e/real/notifications.spec.js', line: 4, col: 0 },
    }),
    row({
      logicalKey: NEAR_MISS_KEY,
      file: 'tests/e2e/notification_center.spec.js',
      titlePath: ['supersedes the notification center'],
      title: 'supersedes the notification center',
      sourceLocation: { file: 'tests/e2e/notification_center.spec.js', line: 2, col: 0 },
    }),
  ]);

  const suggestionsFor = (): SuggestionCandidate[] =>
    mappingSuggestions({
      catalog: ranked,
      obligationIds: [NOTIFICATION_OBLIGATION],
      resolution: resolveTestMappings(
        resolveInput({ catalog: ranked, obligationIds: [NOTIFICATION_OBLIGATION] }),
      ),
      routeHints: new Map([[NOTIFICATION_OBLIGATION, ['GET /api/v1/notifications']]]),
    })[0]?.candidates ?? [];

  it("scores 0 a tag that names another resource's plane, not this obligation's", () => {
    // `@crud(tenant.accounts:create)` names the PLANE of every tenant
    // obligation, so the plane token `tenant` scored +100 "explicit tag"
    // for every one of them — the account matrix ranked first for a
    // notifications route it never touches.
    expect(MATRIX_KEY < NOTIFICATION_KEY).toBe(true);
    expect(suggestionsFor().map((candidate) => candidate.logicalKey)).toEqual([NOTIFICATION_KEY]);
  });

  it('keeps the real test ranked by its one distinctive signal', () => {
    const [first] = suggestionsFor();
    expect(first?.logicalKey).toBe(NOTIFICATION_KEY);
    expect(first?.score ?? 0).toBeGreaterThan(0);
    const why = first?.why.join(' ') ?? '';
    expect(why).toContain("resource token 'notifications' matches the test title path");
    // One word, one signal: the resource-token match already counted
    // 'notifications', so the route segment of the same name adds nothing.
    expect(why).not.toContain("title mentions the obligation's route segment 'notifications'");
  });

  it('never matches a token inside a longer word (no `read` in `reference`/`unread`)', () => {
    // `notification` is not `notifications`, and `reference`/`unread` do
    // not contain a standalone word any token can name.
    const candidates = suggestionsFor();
    expect(candidates.map((candidate) => candidate.logicalKey)).not.toContain(NEAR_MISS_KEY);

    expect(candidates.every((candidate) => !candidate.why.join(' ').includes('read'))).toBe(true);
  });
});

describe('mappingSuggestions — tag text is not a title word (0.9.2 follow-up)', () => {
  /**
   * The real adoption case: a generated endpoint resource whose name
   * carries the route's literal `read` segment and the `param` marker
   * that stands in for `{notification_id}`.
   */
  const OBLIGATION =
    'tenant.http-patch-api-v1-notifications-param-read-68ff3585:http:request-observed';
  /**
   * A test tagged for a DIFFERENT resource. Its file is NOT in a `real/`
   * folder, so nothing but name/tag/route evidence could ever score it.
   */
  const ACCOUNT_KEY =
    'playwright:chromium:tests/e2e/account_crud.spec.js:ACCOUNT-CRUD @real-e2e @p1>happy — @crud(tenant.accounts:read) the accounts directory renders and the reference admin is findable';
  /** The test that actually drives the route. */
  const NOTIFICATION_KEY =
    'playwright:chromium:tests/e2e/real/notifications.spec.js:notifications mark one as read';

  const ranked = catalog([
    row({
      logicalKey: ACCOUNT_KEY,
      file: 'tests/e2e/account_crud.spec.js',
      titlePath: [
        'ACCOUNT-CRUD @real-e2e @p1',
        'happy — @crud(tenant.accounts:read) the accounts directory renders and the reference admin is findable',
      ],
      title: 'the accounts directory renders and the reference admin is findable',
      sourceLocation: { file: 'tests/e2e/account_crud.spec.js', line: 12, col: 0 },
    }),
    row({
      logicalKey: NOTIFICATION_KEY,
      file: 'tests/e2e/real/notifications.spec.js',
      titlePath: ['notifications mark one as read'],
      title: 'notifications mark one as read',
      sourceLocation: { file: 'tests/e2e/real/notifications.spec.js', line: 5, col: 0 },
    }),
  ]);

  const suggestionsFor = (): SuggestionCandidate[] =>
    mappingSuggestions({
      catalog: ranked,
      obligationIds: [OBLIGATION],
      resolution: resolveTestMappings(
        resolveInput({ catalog: ranked, obligationIds: [OBLIGATION] }),
      ),
      routeHints: new Map([[OBLIGATION, ['PATCH /api/v1/notifications/{notification_id}/read']]]),
    })[0]?.candidates ?? [];

  it('scores 0 a tag that only repeats the route segment, never a candidate', () => {
    // `@crud(tenant.accounts:read)` names another resource: the part after
    // `:` is an OPERATION, not a resource name, and tag text is not prose —
    // neither may answer "which test exercises PATCH .../read".
    expect(suggestionsFor().map((candidate) => candidate.logicalKey)).toEqual([NOTIFICATION_KEY]);
  });

  it('keeps the real test ranked by its one distinctive signal', () => {
    const [first] = suggestionsFor();
    expect(first?.score ?? 0).toBeGreaterThan(0);
    const why = first?.why.join(' ') ?? '';
    expect(why).toContain("resource token 'notifications' matches the test title path");
    // One word, one signal (see above).
    expect(why).not.toContain("title mentions the obligation's route segment 'notifications'");
  });
});

/**
 * Plan 0.9.2 item (i): an explicit tag counts for an `http:*`
 * obligation only when the operation it DECLARES fits the route's
 * method. `@crud(tenant.accounts:create)` says the test CREATES an
 * account; it is no evidence that the test reads
 * `GET /api/v2/accounts`, and answering `new test needed: no` from it
 * sent an owner to mark a create test as the proof of a read.
 */
describe('mappingSuggestions — an explicit tag must fit the route method (0.9.2 item i)', () => {
  const HTTP_OBLIGATION = 'tenant.accounts:http:request-observed';
  const ROUTE = 'GET /api/v2/accounts';

  /**
   * A test whose title and file never name the resource, so the ONLY
   * thing that could make it a candidate is its `@crud(...)` tag.
   */
  const tagged = (operation: string | null): TestCatalogEntry =>
    row({
      logicalKey: `playwright:chromium:tests/e2e/real/admin.spec.js:the reference admin is findable (${operation ?? 'unqualified'})`,
      file: 'tests/e2e/real/admin.spec.js',
      titlePath: [
        `@crud(tenant.accounts${operation === null ? '' : `:${operation}`})`,
        'the reference admin is findable',
      ],
      title: 'the reference admin is findable',
      sourceLocation: { file: 'tests/e2e/real/admin.spec.js', line: 6, col: 0 },
    });

  /** The suggestion for the transport obligation, with no mapping present. */
  const suggestionFor = (entries: TestCatalogEntry[]) => {
    const entries0 = catalog(entries);
    return mappingSuggestions({
      catalog: entries0,
      obligationIds: [HTTP_OBLIGATION],
      resolution: resolveTestMappings(resolveInput({ catalog: entries0, obligationIds: [HTTP_OBLIGATION] })),
      routeHints: new Map([[HTTP_OBLIGATION, [ROUTE]]]),
    })[0];
  };

  it('gives no credit to `@crud(tenant.accounts:create)` for a GET route', () => {
    // Before the gate this answered `new test needed: no` — "mark this
    // create test as the proof of a read". With the tag carrying no
    // evidence the honest verdict is the three-state `unverified`: a
    // candidate exists and NOTHING HERE PROVES IT.
    const suggestion = suggestionFor([tagged('create')]);
    expect(suggestion?.newTestNeeded).not.toBe('no');
    expect(suggestion?.newTestNeeded).toBe('unverified');
    // The tag scores nothing here. (The resolver's own route-blind
    // inference still names the row as a candidate — it has no route
    // hints to fit the method against — but it contributes no score and
    // it settles nothing.)
    expect(suggestion?.candidates?.[0]?.score ?? 0).toBe(0);
  });

  it('still credits the tag whose operation fits the method', () => {
    // GET reads: `:read` fits, and the positive case must not regress
    // with the gate above.
    const suggestion = suggestionFor([tagged('read')]);
    expect(suggestion?.newTestNeeded).toBe('no');
    expect(suggestion?.candidates?.[0]?.why.join(' ')).toContain(
      "explicit tag names this obligation's resource 'accounts'",
    );
  });

  it('still credits a tag that declares NO operation on a transport obligation', () => {
    // `@crud(tenant.accounts)` names the resource and stops there: it
    // asserts the test exercises accounts, and says nothing about which
    // verb. The route-method gate exists to stop `:create` answering a
    // GET route, not to throw away a tag that never named an
    // operation — so an operation-less tag keeps its full credit.
    const suggestion = suggestionFor([tagged(null)]);
    expect(suggestion?.newTestNeeded).toBe('no');
    expect(suggestion?.candidates?.[0]?.why.join(' ')).toContain(
      "explicit tag names this obligation's resource 'accounts'",
    );
  });

  it('leaves a non-transport obligation judged on the resource alone', () => {
    // `:persistence:read` has no route method to fit: the tag's resource
    // part is still the evidence it always was.
    const entries0 = catalog([tagged('create')]);
    const persistence = 'tenant.accounts:persistence:read';
    const suggestion = mappingSuggestions({
      catalog: entries0,
      obligationIds: [persistence],
      resolution: resolveTestMappings(resolveInput({ catalog: entries0, obligationIds: [persistence] })),
      routeHints: new Map(),
    })[0];
    expect(suggestion?.newTestNeeded).toBe('no');
  });
});

describe('resolveTestMappings — determinism', () => {
  it('shuffled inputs produce byte-identical output', () => {
    const rows = [
      row({ logicalKey: KEY }),
      row({ logicalKey: CREATE_KEY, titlePath: ['Accounts', 'creates an account'], title: 'creates an account' }),
    ];
    const entries = [
      sidecarEntry({ kind: 'browser-e2e' }),
      sidecarEntry({
        key: CREATE_KEY,
        selector: { runner: 'playwright', project: 'chromium', file: 'e2e/accounts.spec.js', titlePath: ['Accounts', 'creates an account'] },
        claims: [OBLIGATION],
        reason: 'The create journey covers the same resource.',
      }),
    ];
    const claims = [nativeClaim(), nativeClaim({ obligationId: OTHER_OBLIGATION })];
    const forward = resolveTestMappings(
      resolveInput({ catalog: catalog(rows), sidecar: sidecar(entries), nativeClaims: claims }),
    );
    const reversed = resolveTestMappings(
      resolveInput({
        catalog: catalog([...rows].reverse()),
        sidecar: sidecar([...entries].reverse()),
        nativeClaims: [...claims].reverse(),
      }),
    );
    expect(JSON.stringify(reversed)).toBe(JSON.stringify(forward));
  });
});

describe('mappingSuggestions — eligibility, not just ranking (0.9.2 follow-up)', () => {
  const OBLIGATION =
    'tenant.http-patch-api-v1-notifications-param-read-68ff3585:http:request-observed';
  const HINTS = new Map([[OBLIGATION, ['PATCH /api/v1/notifications/{notification_id}/read']]]);

  function suggestionsFor(entries: TestCatalogEntry[]) {
    const ranked = catalog(entries);
    const suggestion = mappingSuggestions({
      catalog: ranked,
      obligationIds: [OBLIGATION],
      resolution: resolveTestMappings(
        resolveInput({ catalog: ranked, obligationIds: [OBLIGATION] }),
      ),
      routeHints: HINTS,
    })[0];
    return { candidates: suggestion?.candidates ?? [], suggestion };
  }

  it('never offers a row the runner did not enumerate (static-only)', () => {
    // A Vitest jsdom test is not a Playwright test: `tests discover`
    // records it as `[reconciliation-static-only]`, and it can never
    // produce the witnessed evidence a mark would promise.
    const { candidates, suggestion } = suggestionsFor([
      row({
        logicalKey: 'playwright:-:frontend/src/components/dashboard/__tests__/Dashboard.test.jsx:Dashboard (TanStack migration)>marks all notifications read via the mutation',
        file: 'frontend/src/components/dashboard/__tests__/Dashboard.test.jsx',
        titlePath: [
          'Dashboard (TanStack migration)',
          'marks all notifications read via the mutation',
        ],
        title: 'marks all notifications read via the mutation',
        sourceLocation: { file: 'frontend/src/components/dashboard/__tests__/Dashboard.test.jsx', line: 8, col: 0 },
        project: null,
        reconciliation: 'static-only',
      }),
      row({
        logicalKey: 'playwright:-:tests/e2e/real/notifications.spec.js:notifications mark one as read',
        file: 'tests/e2e/real/notifications.spec.js',
        titlePath: ['notifications mark one as read'],
        title: 'notifications mark one as read',
        sourceLocation: { file: 'tests/e2e/real/notifications.spec.js', line: 5, col: 0 },
      }),
    ]);
    expect(candidates.map((candidate) => candidate.logicalKey)).toEqual([
      'playwright:-:tests/e2e/real/notifications.spec.js:notifications mark one as read',
    ]);
    // The surviving row is a real e2e spec whose title names the resource
    // and whose FILE names the route: two signals, so reuse is settled.
    expect(suggestion?.newTestNeeded).toBe('no');
  });

  it('asks for a NEW test when every candidate mocks the system under test', () => {
    // A mocked candidate can never witness the claim, so listing it as
    // the reuse answer (and printing a `tests mark` for it) is a dead end.
    const { candidates, suggestion } = suggestionsFor([
      row({
        logicalKey: 'playwright:-:tests/e2e/real/notifications.spec.js:notifications mark one as read (mocked)',
        file: 'tests/e2e/real/notifications.spec.js',
        titlePath: ['notifications mark one as read (mocked)'],
        title: 'notifications mark one as read (mocked)',
        sourceLocation: { file: 'tests/e2e/real/notifications.spec.js', line: 5, col: 0 },
        suppressionSignals: [
          {
            kind: 'mock',
            detail: 'the api client is mocked for the jsdom render',
            location: { file: 'tests/e2e/real/notifications.spec.js', line: 3, col: 0 },
          },
        ],
      }),
    ]);
    // Still listed, as context.
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.why.join(' ')).toContain('mocks the system under test');
    expect(suggestion?.newTestNeeded).toBe('yes');
    expect(suggestion?.missingEvidence).toContain('only mocked candidates');
    // No `tests mark` next action for a mocked candidate.
    expect(suggestion?.nextAction).not.toContain('mark the existing test');
    expect(suggestion?.nextAction).toContain('Overlay: write');
  });

  it('asks for a NEW test when the only candidate mocks via a file-scope helper (0.9.2)', () => {
    // The real-world shape: `page.route` lives in a helper the test
    // CALLS, so the body-scoped scan saw nothing and the spec was offered
    // as reusable proof. The file-level fact and the `mocked/` folder
    // rule now give this row the mock signal it always had.
    const { candidates, suggestion } = suggestionsFor([
      row({
        logicalKey: 'playwright:-:tests/e2e/mocked/notification_foundation.spec.js:notifications foundation lists the inbox',
        file: 'tests/e2e/mocked/notification_foundation.spec.js',
        titlePath: ['notifications foundation lists the inbox'],
        title: 'notifications foundation lists the inbox',
        sourceLocation: { file: 'tests/e2e/mocked/notification_foundation.spec.js', line: 10, col: 0 },
        inferredKind: 'browser-e2e',
        suppressionSignals: [
          {
            kind: 'mock',
            detail:
              'network interception (page.route/context.route/route.fulfill) somewhere in the test file — a shared helper every test calls intercepts for all of them',
            location: { file: 'tests/e2e/mocked/notification_foundation.spec.js', line: 3, col: 2 },
          },
        ],
      }),
    ]);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.why.join(' ')).toContain('mocks the system under test');
    expect(suggestion?.newTestNeeded).toBe('yes');
    expect(suggestion?.missingEvidence).toContain('only mocked candidates');
    expect(suggestion?.nextAction).not.toContain('mark the existing test');
    expect(suggestion?.nextAction).toContain('Overlay: write');
  });
});

describe('mappingSuggestions — candidates must be distinctive (0.9.2 follow-up)', () => {
  const OBLIGATION =
    'tenant.http-patch-api-v1-notifications-param-read-68ff3585:http:request-observed';
  const HINTS = new Map([[OBLIGATION, ['PATCH /api/v1/notifications/{notification_id}/read']]]);

  /** A real e2e test whose only match is the operation word `read`. */
  function readOnlyRow(logicalKey: string, file: string, title: string): TestCatalogEntry {
    return row({
      logicalKey,
      file,
      titlePath: [title],
      title,
      sourceLocation: { file, line: 4, col: 0 },
      inferredKind: 'browser-e2e',
    });
  }

  const ERP = 'playwright:-:tests/e2e/real/erp_token.spec.js:tenant-plane ERP token cannot read the platform tier API';
  const ACCOUNTS_UI =
    'playwright:chromium:tests/e2e/real/accounts_ui.spec.js:read tenant.accounts through UI';
  const BILLING_UI =
    'playwright:chromium:tests/e2e/real/billing_ui.spec.js:read tenant.billing_documents through UI';
  const DASHBOARD =
    'vitest:-:frontend/src/components/dashboard/__tests__/Dashboard.test.jsx:Dashboard (TanStack migration)>marks all notifications read via the mutation';
  const NOTIFICATIONS =
    'playwright:-:tests/e2e/real/notifications.spec.js:notifications mark one as read';

  function suggestionsFor(entries: TestCatalogEntry[]) {
    const ranked = catalog(entries);
    const suggestion = mappingSuggestions({
      catalog: ranked,
      obligationIds: [OBLIGATION],
      resolution: resolveTestMappings(
        resolveInput({ catalog: ranked, obligationIds: [OBLIGATION] }),
      ),
      routeHints: HINTS,
    })[0];
    return { candidates: suggestion?.candidates ?? [], suggestion };
  }

  const realRows = (): TestCatalogEntry[] => [
    readOnlyRow(ERP, 'tests/e2e/real/erp_token.spec.js', 'tenant-plane ERP token cannot read the platform tier API'),
    readOnlyRow(ACCOUNTS_UI, 'tests/e2e/real/accounts_ui.spec.js', 'read tenant.accounts through UI'),
    readOnlyRow(BILLING_UI, 'tests/e2e/real/billing_ui.spec.js', 'read tenant.billing_documents through UI'),
    row({
      logicalKey: DASHBOARD,
      runner: 'vitest',
      file: 'frontend/src/components/dashboard/__tests__/Dashboard.test.jsx',
      titlePath: [
        'Dashboard (TanStack migration)',
        'marks all notifications read via the mutation',
      ],
      title: 'marks all notifications read via the mutation',
      sourceLocation: { file: 'frontend/src/components/dashboard/__tests__/Dashboard.test.jsx', line: 8, col: 0 },
      inferredKind: 'unit',
      suppressionSignals: [
        {
          kind: 'mock',
          detail: 'the api client is mocked for the jsdom render',
          location: { file: 'frontend/src/components/dashboard/__tests__/Dashboard.test.jsx', line: 3, col: 0 },
        },
      ],
    }),
  ];

  it('offers only the test with a distinctive match, never an operation word or a unit suite', () => {
    // `read` is the CONTRACT's operation and a route segment, not this
    // route's resource: an obligation for `…/notifications/…/read` is not
    // satisfied by "read tenant.accounts through UI". A unit suite can
    // never witness it either.
    const { candidates, suggestion } = suggestionsFor([
      ...realRows(),
      row({
        logicalKey: NOTIFICATIONS,
        file: 'tests/e2e/real/notifications.spec.js',
        titlePath: ['notifications mark one as read'],
        title: 'notifications mark one as read',
        sourceLocation: { file: 'tests/e2e/real/notifications.spec.js', line: 5, col: 0 },
        inferredKind: 'browser-e2e',
      }),
    ]);
    expect(candidates.map((candidate) => candidate.logicalKey)).toEqual([NOTIFICATIONS]);
    expect(candidates[0]?.why.join(' ')).toContain("resource token 'notifications'");
    expect(suggestion?.newTestNeeded).toBe('no');
  });

  it('reports no candidate and a new test when nothing distinctive matches', () => {
    const { candidates, suggestion } = suggestionsFor(realRows());
    expect(candidates).toEqual([]);
    expect(suggestion?.newTestNeeded).toBe('yes');
    expect(suggestion?.nextAction).toContain('Overlay: write');
  });

  /** The admin login request these two candidates could answer for. */
  const LOGIN_OBLIGATION = 'master.http-post-admin-auth-login-4e84d21a:http:request-observed';
  const LOGIN_HINTS = new Map([[LOGIN_OBLIGATION, ['POST /admin/auth/login']]]);
  const AUTH_RBAC =
    'playwright:-:tests/e2e/real/auth_rbac_and_token_refresh.spec.js:' +
    'AUTH-TOKEN-PORTALS @real-e2e @p0>permission — an anonymous visit to the admin plane redirects to login';
  const ADMIN_LOGIN =
    'playwright:-:tests/e2e/real/admin_login.spec.js:' +
    'admin login with valid credentials reaches the admin dashboard';

  /** The same construction as {@link suggestionsFor}, for the login route. */
  function loginSuggestionsFor(entries: TestCatalogEntry[]) {
    const ranked = catalog(entries);
    const suggestion = mappingSuggestions({
      catalog: ranked,
      obligationIds: [LOGIN_OBLIGATION],
      resolution: resolveTestMappings(
        resolveInput({ catalog: ranked, obligationIds: [LOGIN_OBLIGATION] }),
      ),
      routeHints: LOGIN_HINTS,
    })[0];
    return { candidates: suggestion?.candidates ?? [], suggestion };
  }

  it('reports reuse as unverified while ONE signal carries the candidate', () => {
    // The title names the resource and the file shares exactly ONE route
    // word (`auth`). That is not proof the spec posts to
    // `/admin/auth/login`, so the verdict is the third state and the next
    // action is the check — never a `tests mark` command to run.
    const { candidates, suggestion } = loginSuggestionsFor([
      readOnlyRow(
        AUTH_RBAC,
        'tests/e2e/real/auth_rbac_and_token_refresh.spec.js',
        'AUTH-TOKEN-PORTALS @real-e2e @p0>permission — an anonymous visit to the admin plane redirects to login',
      ),
    ]);
    expect(candidates.map((candidate) => candidate.logicalKey)).toEqual([AUTH_RBAC]);
    expect(suggestion?.newTestNeeded).toBe('unverified');
    expect(suggestion?.nextAction).toContain('POST /admin/auth/login');
    expect(suggestion?.nextAction).not.toContain('tests mark');
  });

  it('reports reuse as proven when the file itself names the route', () => {
    // `admin_login.spec.js` IS the `POST /admin/auth/login` route: the
    // title names the resource and the file names two of the route's
    // segments, so no confirmation is owed before marking.
    const { candidates, suggestion } = loginSuggestionsFor([
      readOnlyRow(
        ADMIN_LOGIN,
        'tests/e2e/real/admin_login.spec.js',
        'admin login with valid credentials reaches the admin dashboard',
      ),
    ]);
    expect(candidates.map((candidate) => candidate.logicalKey)).toEqual([ADMIN_LOGIN]);
    expect(suggestion?.newTestNeeded).toBe('no');
  });
});
