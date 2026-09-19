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
  mappingGradingClaims,
  mappingSuggestions,
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
} = {}): Parameters<typeof resolveTestMappings>[0] {
  return {
    catalog: overrides.catalog ?? catalog([row({ logicalKey: KEY })]),
    nativeClaims: overrides.nativeClaims ?? [],
    sidecar: overrides.sidecar ?? { schemaVersion: 1, tests: [] },
    obligationIds: overrides.obligationIds ?? [OBLIGATION, OTHER_OBLIGATION],
    ...(overrides.priorRunHints !== undefined ? { priorRunHints: overrides.priorRunHints } : {}),
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
  it('reports TEST_MAPPING_MISSING with inference candidates and newTestNeeded=false', () => {
    const resolution = resolveTestMappings(resolveInput());
    const suggestions = mappingSuggestions({
      catalog: resolveInput().catalog,
      obligationIds: [OBLIGATION, OTHER_OBLIGATION],
      resolution,
    });
    expect(suggestions).toHaveLength(2);
    const missing = suggestions.find((suggestion) => suggestion.obligationId === OBLIGATION);
    expect(missing?.cause).toBe('TEST_MAPPING_MISSING');
    expect(missing?.newTestNeeded).toBe(false);
    expect(missing?.candidates[0]?.logicalKey).toBe(KEY);
    expect(missing?.candidates[0]?.why.join(' ')).toContain("resource token 'accounts'");
    // orders: nothing matches 'orders' → genuinely uncovered
    const orders = suggestions.find((suggestion) => suggestion.obligationId === OTHER_OBLIGATION);
    expect(orders?.candidates).toEqual([]);
    expect(orders?.newTestNeeded).toBe(true);
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
    expect(suggestions[0]?.newTestNeeded).toBe(true);
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
    expect(suggestions[0]?.newTestNeeded).toBe(false);
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
