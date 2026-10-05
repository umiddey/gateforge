/**
 * Owner-declared business rules: the `rules:` schema, the claim-id shape,
 * and the pure evaluator (plan 2026-10-05 §4, D1/D2/D4).
 *
 * Every status in the plan's table is exercised here against synthetic
 * SEALED facts — the evaluator never reads a file, so a run's evidence is
 * exactly the data the caller hands it.
 */
import { describe, expect, it } from 'vitest';
import {
  BUSINESS_RULE_TYPE_TABLE,
  BusinessRuleSchema,
  BusinessRulesSchema,
  businessRuleClaimId,
  casesOf,
  evaluateBusinessRules,
  isBusinessRuleFinding,
  parseBusinessRuleClaimId,
  isBusinessRuleClaimId,
  type BusinessRule,
  type BusinessRuleBinding,
  type BusinessRuleCaseResult,
  type BusinessRuleRunFacts,
  type BusinessRuleTestFact,
  type EvidenceRecord,
} from '../src/index.js';

const RULE: BusinessRule = {
  id: 'invoice-cancel-only-unpaid',
  title: 'An invoice can only be cancelled while it is unpaid',
  test: 'e2e',
  enforcement: 'block',
  cases: [
    { id: 'unpaid-can-cancel', describe: 'Cancelling an unpaid invoice succeeds and it shows as cancelled' },
    { id: 'paid-cannot-cancel', describe: 'Cancelling a paid invoice is refused and it stays paid' },
  ],
};

function binding(overrides: Partial<BusinessRuleBinding> = {}): BusinessRuleBinding {
  return {
    logicalKey: 'cancel-invoice.spec.ts:cancels',
    origin: 'sidecar',
    declaredKind: 'observed-e2e',
    runner: 'playwright',
    mocked: false,
    reason: 'the owner mapped this journey',
    file: 'tests/e2e/cancel-invoice.spec.ts',
    ...overrides,
  };
}

function testFact(overrides: Partial<BusinessRuleTestFact> = {}): BusinessRuleTestFact {
  return {
    logicalKey: 'cancel-invoice.spec.ts:cancels',
    runner: 'playwright',
    status: 'passed',
    inGradedSlice: true,
    sessionIds: ['session-1'],
    ...overrides,
  };
}

function record(kind: string, sessionId: string): EvidenceRecord {
  return {
    schemaVersion: 1,
    recordId: 'a'.repeat(64),
    runId: '11111111-1111-4111-8111-111111111111',
    trust: 'witnessed',
    obligationId: 'tenant.invoices:crud:read',
    kind,
    testId: 'cancel-invoice.spec.ts:cancels',
    payload: { sessionId },
  };
}

function facts(
  overrides: Omit<Partial<BusinessRuleRunFacts>, 'tests'> & { tests?: BusinessRuleTestFact[] } = {},
): BusinessRuleRunFacts {
  const list = overrides.tests ?? [testFact()];
  return {
    scope: 'full',
    docsOnly: false,
    records: [record('http.request', 'session-1')],
    witnessedRunners: new Set(['playwright']),
    ...overrides,
    tests: new Map(list.map((fact) => [fact.logicalKey, fact])),
  };
}

function caseOf(result: readonly BusinessRuleCaseResult[], caseId: string): BusinessRuleCaseResult {
  const found = result.find((entry) => entry.caseId === caseId);
  if (found === undefined) throw new Error(`no case '${caseId}' in the evaluation`);
  return found;
}

const BOTH_CASES = new Map<string, BusinessRuleBinding[]>([
  [businessRuleClaimId(RULE.id, 'unpaid-can-cancel'), [binding()]],
  [businessRuleClaimId(RULE.id, 'paid-cannot-cancel'), [binding()]],
]);

describe('business-rule schema', () => {
  it('defaults the test type to e2e and enforcement to block', () => {
    const parsed = BusinessRuleSchema.parse({ id: 'r-1', title: 'Invoices are paid' });
    expect(parsed.test).toBe('e2e');
    expect(parsed.enforcement).toBe('block');
    expect(parsed.cases).toBeUndefined();
  });

  it('rejects an advisory rule with no reason, and a blocking rule that carries one', () => {
    const advisory = BusinessRuleSchema.safeParse({ id: 'r-1', title: 't', enforcement: 'advisory' });
    expect(advisory.success).toBe(false);
    expect(advisory.error?.issues[0]?.message).toContain('advisoryReason');
    const blocked = BusinessRuleSchema.safeParse({ id: 'r-1', title: 't', advisoryReason: 'because' });
    expect(blocked.success).toBe(false);
    expect(
      BusinessRuleSchema.safeParse({
        id: 'r-1',
        title: 't',
        enforcement: 'advisory',
        advisoryReason: 'the surface ships next quarter',
      }).success,
    ).toBe(true);
  });

  it('rejects duplicate case ids inside a rule and duplicate rule ids in the section', () => {
    const dupCase = BusinessRuleSchema.safeParse({
      id: 'r-1',
      title: 't',
      cases: [
        { id: 'c', describe: 'a' },
        { id: 'c', describe: 'b' },
      ],
    });
    expect(dupCase.success).toBe(false);
    expect(dupCase.error?.issues[0]?.message).toContain("duplicate case id 'c'");
    const dupRule = BusinessRulesSchema.safeParse([
      { id: 'r-1', title: 'a' },
      { id: 'r-1', title: 'b' },
    ]);
    expect(dupRule.success).toBe(false);
    expect(dupRule.error?.issues[0]?.message).toContain("duplicate business rule id 'r-1'");
  });

  it('rejects a rule id or case id outside the closed slug shape', () => {
    expect(BusinessRuleSchema.safeParse({ id: 'Invoice', title: 't' }).success).toBe(false);
    expect(
      BusinessRuleSchema.safeParse({ id: 'r-1', title: 't', cases: [{ id: 'A B', describe: 'x' }] }).success,
    ).toBe(false);
  });

  it('materializes the implicit `default` case for a rule without cases', () => {
    const implicit = BusinessRuleSchema.parse({ id: 'r-1', title: 'Every account is tenant scoped' });
    expect(casesOf(implicit)).toEqual([{ id: 'default', describe: 'Every account is tenant scoped' }]);
    expect(casesOf(RULE)).toHaveLength(2);
  });
});

describe('business-rule claim ids', () => {
  it('passes the existing <resourceId>:<contract> obligation-id shape', () => {
    const claimId = businessRuleClaimId('invoice-cancel-only-unpaid', 'unpaid-can-cancel');
    expect(claimId).toBe('business-rule:invoice-cancel-only-unpaid/unpaid-can-cancel');
    expect(isBusinessRuleClaimId(claimId)).toBe(true);
    expect(parseBusinessRuleClaimId(claimId)).toEqual({
      ruleId: 'invoice-cancel-only-unpaid',
      caseId: 'unpaid-can-cancel',
    });
    expect(isBusinessRuleClaimId('tenant.invoices:crud:read')).toBe(false);
    expect(parseBusinessRuleClaimId('business-rule:no-case')).toBeNull();
  });
});

describe('business-rule type table', () => {
  it('never lets a weaker kind satisfy a stronger type', () => {
    expect(BUSINESS_RULE_TYPE_TABLE.e2e.acceptedKinds).toEqual(['browser-e2e', 'observed-e2e']);
    expect(BUSINESS_RULE_TYPE_TABLE.e2e.acceptedKinds).not.toContain('api-e2e');
    expect(BUSINESS_RULE_TYPE_TABLE.e2e.acceptedKinds).not.toContain('unit');
    expect(BUSINESS_RULE_TYPE_TABLE.pytest.acceptedKinds).toEqual(['unit', 'integration', 'server-e2e']);
    expect(BUSINESS_RULE_TYPE_TABLE.pytest.requiresWitnessedSuite).toBe(true);
  });
});

describe('evaluateBusinessRules', () => {
  it('reports unmapped cases without a sealed run (a mapping alone is never proof)', () => {
    const result = evaluateBusinessRules({ rules: [RULE], bindings: new Map(), inventory: [], runFacts: null });
    expect(result.cases.map((entry) => entry.status)).toEqual(['unmapped', 'unmapped']);
    const entry = caseOf(result.cases, 'unpaid-can-cancel');
    expect(entry.finding?.code).toBe('BUSINESS_RULE_TEST_MISSING');
    expect(entry.finding?.detail).toContain('invoice-cancel-only-unpaid');
    expect(entry.finding?.detail).toContain('unpaid-can-cancel');
    expect(entry.finding?.detail).toContain("'e2e'");
  });

  it('reports wrong-type when only a weaker kind is mapped', () => {
    for (const kind of ['api-e2e', 'unit']) {
      const result = evaluateBusinessRules({
        rules: [RULE],
        bindings: new Map([
          [businessRuleClaimId(RULE.id, 'unpaid-can-cancel'), [binding({ declaredKind: kind })]],
        ]),
        inventory: [],
        runFacts: null,
      });
      const entry = caseOf(result.cases, 'unpaid-can-cancel');
      expect(entry.status).toBe('wrong-type');
      expect(entry.finding?.code).toBe('BUSINESS_RULE_TEST_TYPE_MISMATCH');
      expect(entry.finding?.detail).toContain('browser-e2e or observed-e2e');
    }
  });

  it('satisfies every case one passed observed-e2e test proves, naming the channel', () => {
    const result = evaluateBusinessRules({ rules: [RULE], bindings: BOTH_CASES, inventory: [], runFacts: facts() });
    expect(result.cases.map((entry) => entry.status)).toEqual(['satisfied', 'satisfied']);
    expect(caseOf(result.cases, 'unpaid-can-cancel').channel).toBe('observe');
    expect(caseOf(result.cases, 'unpaid-can-cancel').finding).toBeNull();
  });

  it('fails every case one failing test touches', () => {
    const result = evaluateBusinessRules({
      rules: [RULE],
      bindings: BOTH_CASES,
      inventory: [],
      runFacts: facts({ tests: [testFact({ status: 'failed' })] }),
    });
    expect(result.cases.map((entry) => entry.status)).toEqual(['failing', 'failing']);
    expect(caseOf(result.cases, 'unpaid-can-cancel').finding?.code).toBe('BUSINESS_RULE_TEST_FAILING');
  });

  it('never forgives a red mapped test with a green sibling', () => {
    const result = evaluateBusinessRules({
      rules: [RULE],
      bindings: new Map([
        [
          businessRuleClaimId(RULE.id, 'unpaid-can-cancel'),
          [binding({ logicalKey: 'green.spec.ts:x' }), binding({ logicalKey: 'red.spec.ts:y' })],
        ],
      ]),
      inventory: [],
      runFacts: facts({
        tests: [
          testFact({ logicalKey: 'green.spec.ts:x', sessionIds: ['session-1'] }),
          testFact({ logicalKey: 'red.spec.ts:y', status: 'failed', sessionIds: ['session-2'] }),
        ],
        records: [record('http.request', 'session-1'), record('http.request', 'session-2')],
      }),
    });
    const entry = caseOf(result.cases, 'unpaid-can-cancel');
    expect(entry.status).toBe('failing');
    expect(entry.finding?.tests).toEqual(['red.spec.ts:y']);
  });

  it('never satisfies from a mocked spec, a quarantined (dropped) binding or an inferred one', () => {
    const mocked = evaluateBusinessRules({
      rules: [RULE],
      bindings: new Map([
        [businessRuleClaimId(RULE.id, 'unpaid-can-cancel'), [binding({ mocked: true })]],
      ]),
      inventory: [],
      runFacts: facts(),
    });
    const mockedCase = caseOf(mocked.cases, 'unpaid-can-cancel');
    expect(mockedCase.status).toBe('unproven');
    expect(mockedCase.finding?.detail).toContain('mock the system under test');

    // A quarantined test is dropped by the resolver before it reaches the
    // evaluator, so it binds nothing at all.
    expect(
      caseOf(
        evaluateBusinessRules({ rules: [RULE], bindings: new Map(), inventory: [], runFacts: facts() }).cases,
        'unpaid-can-cancel',
      ).status,
    ).toBe('unmapped');

    const inferred = evaluateBusinessRules({
      rules: [RULE],
      bindings: new Map([
        [
          businessRuleClaimId(RULE.id, 'unpaid-can-cancel'),
          [binding({ origin: 'inferred', declaredKind: null })],
        ],
      ]),
      inventory: [],
      runFacts: facts(),
    });
    expect(caseOf(inferred.cases, 'unpaid-can-cancel').status).toBe('unmapped');
  });

  it("stays unproven outside a scoped run's graded slice instead of vanishing", () => {
    const result = evaluateBusinessRules({
      rules: [RULE],
      bindings: BOTH_CASES,
      inventory: [],
      runFacts: facts({ scope: 'changed', tests: [testFact({ inGradedSlice: false })] }),
    });
    expect(result.cases.map((entry) => entry.status)).toEqual(['unproven', 'unproven']);
    const entry = caseOf(result.cases, 'unpaid-can-cancel');
    expect(entry.finding?.code).toBe('BUSINESS_RULE_TEST_UNPROVEN');
    expect(entry.finding?.detail).toContain("outside this run's graded slice");
  });

  it('stays unproven when the test produced no witness record of its own session', () => {
    const result = evaluateBusinessRules({
      rules: [RULE],
      bindings: BOTH_CASES,
      inventory: [],
      runFacts: facts({ records: [record('http.request', 'some-other-session')] }),
    });
    const entry = caseOf(result.cases, 'unpaid-can-cancel');
    expect(entry.status).toBe('unproven');
    expect(entry.finding?.detail).toContain("no 'http.request' witness record");
  });

  it('accepts a browser-e2e binding on an engine ui.action anchor', () => {
    const result = evaluateBusinessRules({
      rules: [{ ...RULE, cases: [{ id: 'unpaid-can-cancel', describe: 'x' }] }],
      bindings: new Map([
        [businessRuleClaimId(RULE.id, 'unpaid-can-cancel'), [binding({ declaredKind: 'browser-e2e' })]],
      ]),
      inventory: [],
      runFacts: facts({ records: [record('ui.action', 'session-1')] }),
    });
    expect(result.cases[0]?.status).toBe('satisfied');
    expect(result.cases[0]?.channel).toBe('engine');
  });

  it('keeps a pytest rule unproven without a witnessed pytest suite, and says so', () => {
    const pytestRule: BusinessRule = {
      id: 'invoice-total-matches-lines',
      title: 'An invoice total equals the sum of its lines',
      test: 'pytest',
      enforcement: 'block',
      cases: [{ id: 'sum', describe: 'The stored total equals the line sum' }],
    };
    const bindings = new Map([
      [
        businessRuleClaimId(pytestRule.id, 'sum'),
        [binding({ declaredKind: 'unit', runner: 'pytest', logicalKey: 'tests/test_invoice.py::test_total' })],
      ],
    ]);
    const pytestFact = testFact({
      logicalKey: 'tests/test_invoice.py::test_total',
      runner: 'pytest',
      sessionIds: [],
    });
    const unwitnessed = evaluateBusinessRules({
      rules: [pytestRule],
      bindings,
      inventory: [],
      runFacts: facts({ tests: [pytestFact], witnessedRunners: new Set(['playwright']) }),
    });
    expect(unwitnessed.cases[0]?.status).toBe('unproven');
    expect(unwitnessed.cases[0]?.finding?.detail).toContain('mark the suite witnessed');

    const witnessed = evaluateBusinessRules({
      rules: [pytestRule],
      bindings,
      inventory: [],
      runFacts: facts({ tests: [pytestFact], witnessedRunners: new Set(['pytest']), records: [] }),
    });
    expect(witnessed.cases[0]?.status).toBe('satisfied');
    expect(witnessed.cases[0]?.channel).toBe('execution');
  });

  it('treats a docs-only slice as proving nothing', () => {
    const result = evaluateBusinessRules({
      rules: [RULE],
      bindings: BOTH_CASES,
      inventory: [],
      runFacts: facts({ scope: 'changed', docsOnly: true, records: [], tests: [testFact({ inGradedSlice: false })] }),
    });
    expect(result.cases.every((entry) => entry.status === 'unproven')).toBe(true);
  });

  it('rejects an unknown subject as a configuration error and skips grading it', () => {
    const result = evaluateBusinessRules({
      rules: [{ ...RULE, subject: 'nope' }],
      bindings: BOTH_CASES,
      inventory: ['invoices'],
      runFacts: facts(),
    });
    expect(result.configErrors).toHaveLength(1);
    expect(result.configErrors[0]?.code).toBe('BUSINESS_RULE_SUBJECT_UNKNOWN');
    expect(result.cases).toHaveLength(0);

    const known = evaluateBusinessRules({
      rules: [{ ...RULE, subject: 'invoices' }],
      bindings: BOTH_CASES,
      inventory: ['invoices'],
      runFacts: facts(),
    });
    expect(known.configErrors).toHaveLength(0);
    expect(known.cases).toHaveLength(2);
  });

  it('is deterministic and sorts by rule id then case id', () => {
    const other: BusinessRule = {
      id: 'aaa-earlier-rule',
      title: 'Another rule',
      test: 'e2e',
      enforcement: 'block',
      cases: [
        { id: 'z', describe: 'z' },
        { id: 'a', describe: 'a' },
      ],
    };
    const result = evaluateBusinessRules({ rules: [RULE, other], bindings: new Map(), inventory: [], runFacts: null });
    expect(result.cases.map((entry) => `${entry.ruleId}/${entry.caseId}`)).toEqual([
      'aaa-earlier-rule/a',
      'aaa-earlier-rule/z',
      'invoice-cancel-only-unpaid/paid-cannot-cancel',
      'invoice-cancel-only-unpaid/unpaid-can-cancel',
    ]);
    const again = evaluateBusinessRules({ rules: [other, RULE], bindings: new Map(), inventory: [], runFacts: null });
    expect(JSON.stringify(again)).toBe(JSON.stringify(result));
  });

  it('exposes a typed finding exactly when the case is not satisfied', () => {
    const result = evaluateBusinessRules({ rules: [RULE], bindings: BOTH_CASES, inventory: [], runFacts: facts() });
    expect(isBusinessRuleFinding(result.cases[0]!)).toBe(false);
    const unmapped = evaluateBusinessRules({ rules: [RULE], bindings: new Map(), inventory: [], runFacts: null });
    expect(isBusinessRuleFinding(unmapped.cases[0]!)).toBe(true);
  });
});