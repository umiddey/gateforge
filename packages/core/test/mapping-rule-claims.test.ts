/**
 * The BUSINESS RULE claim namespace inside the ONE mapping resolver
 * (plan 2026-10-05 D3, WP2).
 *
 * What these tests hold, and why each is a real failure mode rather
 * than a restatement of the code:
 * - a `business-rule:<ruleId>/<caseId>` claim resolves through the SAME
 *   resolver and lands in `ruleBindings`, never in `obligations` (a rule
 *   is a declaration graded by its own evaluator; letting it into an
 *   obligation set would mint an obligation that has no resource);
 * - the unclaimed case stays present with zero bindings, exactly as an
 *   unclaimed obligation does — the evaluator is what turns "no
 *   binding" into `unmapped`;
 * - an unknown rule or case is TEST_MAPPING_STALE and the message names
 *   the OWNER's `rules:` section, not an obligation registry;
 * - wildcard prohibition, kind contradictions and quarantine apply to a
 *   rule claim unchanged;
 * - no rules declared means an empty `ruleBindings` and byte-identical
 *   obligation output (plan invariant 1);
 * - `mappingGradingClaims` (the obligation grading projection) never
 *   sees a rule binding.
 *
 * Engine class per TESTING_POLICY.md.
 */
import { describe, expect, it } from 'vitest';
import {
  businessRuleClaimId,
  mappingGradingClaims,
  resolveTestMappings,
  type Claim,
  type ResolvedMappings,
  type TestCatalog,
  type TestCatalogEntry,
  type TestMap,
  type TestMapEntry,
} from '../src/index.js';

const OBLIGATION = 'tenant.invoices:persistence:delete';
const OTHER_OBLIGATION = 'tenant.accounts:persistence:read';
const RULE_ID = 'invoice-cancel-only-unpaid';
const UNPAID_CASE = 'unpaid-can-cancel';
const PAID_CASE = 'paid-cannot-cancel';
const UNPAID_CLAIM = businessRuleClaimId(RULE_ID, UNPAID_CASE);
const PAID_CLAIM = businessRuleClaimId(RULE_ID, PAID_CASE);
const KEY = 'playwright:chromium:e2e/invoices.spec.js:Invoices>cancels a paid invoice';
const UNPAID_KEY = 'playwright:chromium:e2e/invoices.spec.js:Invoices>cancels an unpaid invoice';

/** One catalog row (tests override single fields). */
function row(overrides: Partial<TestCatalogEntry> & { logicalKey: string }): TestCatalogEntry {
  return {
    runner: 'playwright',
    project: 'chromium',
    file: 'e2e/invoices.spec.js',
    titlePath: ['Invoices', 'cancels a paid invoice'],
    title: 'cancels a paid invoice',
    sourceLocation: { file: 'e2e/invoices.spec.js', line: 9, col: 0 },
    parameterIdentity: null,
    sourceDigest: 'bb'.repeat(32),
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

/** One sidecar entry claiming a rule case (tests override single fields). */
function ruleEntry(overrides: Partial<TestMapEntry> = {}): TestMapEntry {
  return {
    key: KEY,
    selector: {
      runner: 'playwright',
      project: 'chromium',
      file: 'e2e/invoices.spec.js',
      titlePath: ['Invoices', 'cancels a paid invoice'],
    },
    kind: 'observed-e2e',
    claims: [PAID_CLAIM],
    reason: 'The journey asserts a paid invoice cannot be cancelled.',
    ...overrides,
  };
}

/** A sidecar document with the given entries. */
function sidecar(tests: TestMapEntry[]): TestMap {
  return { schemaVersion: 1, tests };
}

/** Resolver input with sensible defaults; rules are opt-in. */
function resolveInput(
  overrides: {
    catalog?: TestCatalog;
    sidecar?: TestMap;
    nativeClaims?: Claim[];
    obligationIds?: string[];
    businessRuleClaimIds?: string[];
  } = {},
): Parameters<typeof resolveTestMappings>[0] {
  return {
    catalog: overrides.catalog ?? catalog([row({ logicalKey: KEY })]),
    nativeClaims: overrides.nativeClaims ?? [],
    sidecar: overrides.sidecar ?? { schemaVersion: 1, tests: [] },
    obligationIds: overrides.obligationIds ?? [OBLIGATION, OTHER_OBLIGATION],
    ...(overrides.businessRuleClaimIds !== undefined
      ? { businessRuleClaimIds: overrides.businessRuleClaimIds }
      : {}),
  };
}

/** The bindings resolved for one rule case claim. */
function ruleBindingsFor(resolution: ResolvedMappings, claimId: string) {
  return resolution.ruleBindings.find((entry) => entry.claimId === claimId)?.bindings ?? [];
}

/** The DECLARED (grading-eligible) bindings for one rule case claim. */
function declaredRuleBindings(resolution: ResolvedMappings, claimId: string) {
  return ruleBindingsFor(resolution, claimId).filter(
    (binding) => binding.origin === 'native' || binding.origin === 'sidecar',
  );
}

describe('resolveTestMappings — the business-rule claim namespace', () => {
  it('binds a sidecar rule claim into ruleBindings, never into obligations', () => {
    const resolution = resolveTestMappings(
      resolveInput({
        sidecar: sidecar([ruleEntry()]),
        businessRuleClaimIds: [UNPAID_CLAIM, PAID_CLAIM],
      }),
    );
    expect(resolution.problems).toEqual([]);
    const bindings = declaredRuleBindings(resolution, PAID_CLAIM);
    expect(bindings).toHaveLength(1);
    expect(bindings[0]?.origin).toBe('sidecar');
    expect(bindings[0]?.logicalKey).toBe(KEY);
    expect(bindings[0]?.declaredKind).toBe('observed-e2e');
    // The rule claim is not an obligation: it appears nowhere in the
    // obligation surface, and no obligation gained a DECLARED binding
    // from it (inference over the catalog is a separate, suggestion-only
    // surface, which is why the check is on declared origins).
    expect(resolution.obligations.map((entry) => entry.obligationId)).toEqual([
      OTHER_OBLIGATION,
      OBLIGATION,
    ]);
    for (const obligation of resolution.obligations) {
      expect(obligation.bindings.filter((binding) => binding.origin !== 'inferred')).toEqual([]);
    }
    expect(resolution.obligations.some((entry) => entry.obligationId === PAID_CLAIM)).toBe(false);
  });

  it('keeps the unclaimed case present with zero bindings', () => {
    const resolution = resolveTestMappings(
      resolveInput({
        sidecar: sidecar([ruleEntry()]),
        businessRuleClaimIds: [UNPAID_CLAIM, PAID_CLAIM],
      }),
    );
    // Sorted by claim id, so `paid-cannot-cancel` precedes `unpaid-can-cancel`.
    expect(resolution.ruleBindings.map((entry) => entry.claimId)).toEqual([PAID_CLAIM, UNPAID_CLAIM]);
    expect(ruleBindingsFor(resolution, UNPAID_CLAIM)).toEqual([]);
    expect(ruleBindingsFor(resolution, PAID_CLAIM)).toHaveLength(1);
  });

  it('binds a native annotation claiming a rule case', () => {
    const resolution = resolveTestMappings(
      resolveInput({
        businessRuleClaimIds: [PAID_CLAIM],
        nativeClaims: [
          {
            schemaVersion: 1,
            obligationId: PAID_CLAIM,
            testId: 'invoices-cancels-paid',
            testFile: 'e2e/invoices.spec.js',
            location: { file: 'e2e/invoices.spec.js', line: 9, col: 2 },
          },
        ],
      }),
    );
    expect(resolution.problems).toEqual([]);
    const bindings = declaredRuleBindings(resolution, PAID_CLAIM);
    expect(bindings).toHaveLength(1);
    expect(bindings[0]?.origin).toBe('native');
  });

  it('reports an unknown rule case as stale and names the rules section', () => {
    const resolution = resolveTestMappings(
      resolveInput({
        sidecar: sidecar([ruleEntry({ claims: ['business-rule:invoice-cancel-only-unpaid/gone-case'] })]),
        businessRuleClaimIds: [UNPAID_CLAIM],
      }),
    );
    const stale = resolution.problems.filter((problem) => problem.cause === 'TEST_MAPPING_STALE');
    expect(stale).toHaveLength(1);
    expect(stale[0]?.obligationId).toBe('business-rule:invoice-cancel-only-unpaid/gone-case');
    expect(stale[0]?.detail).toContain("business rule 'invoice-cancel-only-unpaid' case 'gone-case'");
    expect(stale[0]?.detail).toContain('rules: section');
    // It must NOT send the reader to an obligation registry.
    expect(stale[0]?.detail).not.toContain('obligation registry');
    expect(ruleBindingsFor(resolution, UNPAID_CLAIM)).toEqual([]);
  });

  it('reports an unknown rule id as stale, naming the rule that vanished', () => {
    const resolution = resolveTestMappings(
      resolveInput({
        sidecar: sidecar([ruleEntry({ claims: ['business-rule:deleted-rule/paid-cannot-cancel'] })]),
        businessRuleClaimIds: [UNPAID_CLAIM],
      }),
    );
    const stale = resolution.problems.filter((problem) => problem.cause === 'TEST_MAPPING_STALE');
    expect(stale).toHaveLength(1);
    expect(stale[0]?.detail).toContain("business rule 'deleted-rule' case 'paid-cannot-cancel'");
  });

  it('refuses a file-level rule claim the same way it refuses an obligation one', () => {
    const resolution = resolveTestMappings(
      resolveInput({
        sidecar: sidecar([
          ruleEntry({ selector: { runner: 'playwright', project: 'chromium', file: 'e2e/invoices.spec.js' } }),
        ]),
        businessRuleClaimIds: [PAID_CLAIM],
      }),
    );
    const ambiguous = resolution.problems.filter((problem) => problem.cause === 'TEST_MAPPING_AMBIGUOUS');
    expect(ambiguous).toHaveLength(1);
    expect(ambiguous[0]?.obligationId).toBe(PAID_CLAIM);
    expect(ambiguous[0]?.detail).toContain('wildcard declarations are prohibited');
    expect(ruleBindingsFor(resolution, PAID_CLAIM)).toEqual([]);
  });

  it('refuses a declared kind the catalog contradicts, on a rule claim', () => {
    const resolution = resolveTestMappings(
      resolveInput({
        sidecar: sidecar([ruleEntry({ kind: 'unit' })]),
        catalog: catalog([
          row({
            logicalKey: KEY,
            inferredKind: 'browser-e2e',
            kindSignals: [
              {
                ruleId: 'playwright-browser-journey',
                detail: 'the test drives the browser through the fixture',
                location: { file: 'e2e/invoices.spec.js', line: 9, col: 0 },
              },
            ],
          }),
        ]),
        businessRuleClaimIds: [PAID_CLAIM],
      }),
    );
    const ambiguous = resolution.problems.filter((problem) => problem.cause === 'TEST_MAPPING_AMBIGUOUS');
    expect(ambiguous).toHaveLength(1);
    expect(ambiguous[0]?.detail).toContain("declares kind 'unit'");
  });

  it('reports a renamed test on a rule claim as stale naming the new key', () => {
    const resolution = resolveTestMappings(
      resolveInput({
        // Same file and title path, but under a DIFFERENT runner project:
        // the selector does not match, and the resolver can still see the
        // test moved rather than vanished.
        catalog: catalog([row({ logicalKey: UNPAID_KEY, project: 'webkit' })]),
        sidecar: sidecar([ruleEntry()]),
        businessRuleClaimIds: [PAID_CLAIM],
      }),
    );
    const stale = resolution.problems.filter((problem) => problem.cause === 'TEST_MAPPING_STALE');
    expect(stale).toHaveLength(1);
    expect(stale[0]?.detail).toContain(`the test now appears as key '${UNPAID_KEY}'`);
  });

  it('is byte-identical with no rules declared: no ruleBindings, same problems', () => {
    const withRules = resolveTestMappings(
      resolveInput({
        sidecar: sidecar([ruleEntry()]),
        businessRuleClaimIds: [PAID_CLAIM],
      }),
    );
    const withoutRules = resolveTestMappings(resolveInput({ sidecar: sidecar([ruleEntry()]) }));
    expect(withoutRules.ruleBindings).toEqual([]);
    // Without a rules registry the same declaration is stale — which is
    // exactly what a repository that never declared `rules:` sees.
    expect(withoutRules.problems.map((problem) => problem.cause)).toEqual(['TEST_MAPPING_STALE']);
    expect(withoutRules.obligations).toEqual(withRules.obligations);
  });

  it('keeps rule bindings out of the obligation grading projection', () => {
    const resolution = resolveTestMappings(
      resolveInput({
        catalog: catalog([row({ logicalKey: KEY }), row({ logicalKey: UNPAID_KEY, titlePath: ['Invoices', 'cancels an unpaid invoice'] })]),
        sidecar: sidecar([
          ruleEntry(),
          {
            key: UNPAID_KEY,
            selector: {
              runner: 'playwright',
              project: 'chromium',
              file: 'e2e/invoices.spec.js',
              titlePath: ['Invoices', 'cancels an unpaid invoice'],
            },
            kind: 'observed-e2e',
            claims: [OBLIGATION],
            reason: 'The journey cancels an unpaid invoice through the UI.',
          },
        ]),
        businessRuleClaimIds: [PAID_CLAIM],
      }),
    );
    const grading = mappingGradingClaims(resolution, []);
    const obligationIds = grading.map((claim) => claim.obligationId);
    expect(obligationIds).toContain(OBLIGATION);
    expect(obligationIds).not.toContain(PAID_CLAIM);
  });

  it('sorts rule bindings by claim id, deterministically under a shuffled registry', () => {
    const shuffled = resolveTestMappings(
      resolveInput({
        businessRuleClaimIds: [PAID_CLAIM, UNPAID_CLAIM],
        sidecar: sidecar([
          ruleEntry(),
          {
            key: UNPAID_KEY,
            selector: {
              runner: 'playwright',
              project: 'chromium',
              file: 'e2e/invoices.spec.js',
              titlePath: ['Invoices', 'cancels an unpaid invoice'],
            },
            kind: 'observed-e2e',
            claims: [UNPAID_CLAIM],
            reason: 'The journey cancels an unpaid invoice, which must succeed.',
          },
        ]),
        catalog: catalog([
          row({ logicalKey: KEY }),
          row({ logicalKey: UNPAID_KEY, titlePath: ['Invoices', 'cancels an unpaid invoice'] }),
        ]),
      }),
    );
    const reversed = resolveTestMappings(
      resolveInput({
        businessRuleClaimIds: [UNPAID_CLAIM, PAID_CLAIM],
        sidecar: sidecar([
          {
            key: UNPAID_KEY,
            selector: {
              runner: 'playwright',
              project: 'chromium',
              file: 'e2e/invoices.spec.js',
              titlePath: ['Invoices', 'cancels an unpaid invoice'],
            },
            kind: 'observed-e2e',
            claims: [UNPAID_CLAIM],
            reason: 'The journey cancels an unpaid invoice, which must succeed.',
          },
          ruleEntry(),
        ]),
        catalog: catalog([
          row({ logicalKey: UNPAID_KEY, titlePath: ['Invoices', 'cancels an unpaid invoice'] }),
          row({ logicalKey: KEY }),
        ]),
      }),
    );
    expect(shuffled.ruleBindings).toEqual(reversed.ruleBindings);
    expect(shuffled.ruleBindings.map((entry) => entry.claimId)).toEqual([PAID_CLAIM, UNPAID_CLAIM]);
  });
});