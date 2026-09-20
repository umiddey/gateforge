/**
 * Required-case grading (plan 2026-09-19 §4.7, Phase 5): exact
 * endpoint/request/actor/subject/value binding to authoritative
 * before/after effects. One table-level result never satisfies a
 * distinct endpoint; wrong-row and secondary-effect probes fail.
 */
import { describe, expect, it } from 'vitest';
import type { RequiredCaseOutcome } from '../src/index.js';

function reasonOf(outcome: RequiredCaseOutcome): string {
  return outcome.status === 'satisfied' ? '' : outcome.reason;
}
import {
  behaviorActionDigestOf,
  evaluateObligation,
  evaluateRequiredCases,
  recordIdOf,
  type BehaviorCatalog,
  type BehaviorGradeContext,
  type Obligation,
} from '../src/index.js';

const HEX = (seed: string): string => seed.repeat(64).slice(0, 64);
const CASE_ID = HEX('c');
const SPEC_DIGEST = HEX('e');
const AUTH_DIGEST = HEX('a');
const LIFECYCLE = {
  create: true,
  read: true,
  update: true,
  delete: true,
  deleteSemantics: 'hard' as const,
};
const ENDPOINT = 'tenant.http-profile';
const OBLIGATION_ID = `${ENDPOINT}:http:effect-verified`;

function definition(overrides: Record<string, unknown> = {}) {
  return {
    id: 'owner-update',
    contract: 'http:effect-verified',
    channel: 'engine-http',
    fixture: 'one-account',
    actor: 'owner-a',
    action: {
      kind: 'request',
      method: 'POST',
      pathTemplate: '/profile/accounts/{id}',
      path: { id: { from: 'fixture', key: 'accountA.id' } },
      query: {},
      body: {
        encoding: 'json',
        fields: { first_name: { from: 'literal', value: 'Ada' } },
      },
      credentialVariant: 'valid',
    },
    expect: {
      statuses: [200],
      response: [],
      state: [
        {
          kind: 'updated',
          scope: 'accounts',
          subject: { from: 'fixture', key: 'accountA.identity' },
          fields: { first_name: { from: 'literal', value: 'Ada' } },
        },
      ],
    },
    ...overrides,
  };
}

function catalogFor(def: ReturnType<typeof definition>): BehaviorCatalog {
  return {
    schemaVersion: 1,
    catalogDigest: HEX('f'),
    cases: [
      {
        caseId: CASE_ID,
        specDigest: SPEC_DIGEST,
        resourceId: ENDPOINT,
        endpointResourceId: ENDPOINT,
        obligationIds: [OBLIGATION_ID],
        definition: def as never,
        effects: [
          {
            id: 'accounts',
            resourceId: 'tenant.accounts',
            adapter: 'accounts',
            scope: 'fixture-accounts',
            identityFields: ['id'],
            fields: ['first_name'],
            completion: 'immediate',
          },
        ],
        sourceFiles: ['backend/profile.js'],
      },
    ],
    requirements: { [OBLIGATION_ID]: [CASE_ID] },
    dependencies: { [ENDPOINT]: ['tenant.accounts'] },
  };
}

const OBLIGATION: Obligation = {
  schemaVersion: 1,
  id: OBLIGATION_ID,
  resourceId: ENDPOINT,
  contract: 'http:effect-verified',
  policyId: 'behavior-policy',
  lifecycle: LIFECYCLE,
};

function routes() {
  return [{ resourceId: ENDPOINT, method: 'POST', canonicalPath: '/profile/accounts/{}' }];
}

function contextFor(catalog: BehaviorCatalog): BehaviorGradeContext {
  return {
    catalog,
    requirements: catalog.requirements,
    authorityProfileDigest: AUTH_DIGEST,
    plannedTestIds: ['test-1'],
  };
}

function entity(id: string, firstName: string) {
  return { entityId: id, fields: { first_name: firstName } };
}

/** A sealed passing payload for the default definition. */
function passingPayload(overrides: Record<string, unknown> = {}) {
  const def = definition();
  return {
    payloadVersion: 1,
    caseId: CASE_ID,
    caseSpecDigest: SPEC_DIGEST,
    obligationIds: [OBLIGATION_ID],
    endpointResourceId: ENDPOINT,
    operationId: 'op-1',
    sessionId: 'sess-1',
    executionId: 'exec-1',
    fixtureNamespace: 'ns-1',
    actor: { principalId: 'owner-a', tenantId: 't1', roles: ['owner'] },
    actionDigest: behaviorActionDigestOf(def.action),
    submittedValues: {
      path: '/profile/accounts/acc-1',
      query: {},
      body: { first_name: 'Ada' },
    },
    attempts: [
      {
        engineRequestId: 'req-1',
        method: 'POST',
        path: '/profile/accounts/acc-1',
        endpointResourceId: ENDPOINT,
        actorRef: 'owner-a',
        requestDigest: HEX('1'),
        status: 200,
        responseDigest: HEX('2'),
      },
    ],
    requestObservations: [
      {
        engineRequestId: 'req-1',
        method: 'POST',
        path: '/profile/accounts/acc-1',
        query: {},
        body: { first_name: 'Ada' },
        status: 200,
        responseBody: { ok: true },
      },
    ],
    fixtureValues: { accountA: { id: 'acc-1', identity: 'acc-1' } },
    before: [
      {
        scope: 'fixture-accounts',
        fixtureNamespace: 'ns-1',
        complete: true,
        checkpoint: 'ns-1:1',
        entities: [entity('acc-1', 'Grace')],
      },
    ],
    after: [
      {
        scope: 'fixture-accounts',
        fixtureNamespace: 'ns-1',
        complete: true,
        checkpoint: 'ns-1:2',
        entities: [entity('acc-1', 'Ada')],
      },
    ],
    completion: { complete: true, checkpoint: 'ns-1:2' },
    channel: 'engine-http',
    authorityProfileDigest: AUTH_DIGEST,
    state: 'sealed',
    ...overrides,
  };
}

function record(payload: unknown, overrides: Record<string, unknown> = {}) {
  return {
    recordId: 'rec-1',
    testId: 'test-1',
    kind: 'behavior.case',
    origin: 'engine-observed',
    trust: 'witnessed',
    payload,
    ...overrides,
  };
}

function grade(payload: unknown, options: { catalog?: BehaviorCatalog; records?: unknown[]; obligation?: Obligation } = {}) {
  const def = definition();
  const catalog = options.catalog ?? catalogFor(def);
  return evaluateRequiredCases({
    obligation: options.obligation ?? OBLIGATION,
    requiredCaseIds: [CASE_ID],
    records: (options.records ?? [record(payload)]) as never,
    context: contextFor(catalog),
    httpRoutes: routes() as never,
  });
}

function domainObligation(contract: string): {
  obligation: Obligation;
  catalog: BehaviorCatalog;
  payload: Record<string, unknown>;
} {
  const obligationId = `${ENDPOINT}:${contract}`;
  const def = definition({ contract });
  const catalog = catalogFor(def);
  const compiled = catalog.cases[0] as (typeof catalog.cases)[number];
  compiled.obligationIds = [obligationId];
  catalog.requirements = { [obligationId]: [CASE_ID] };
  const payload = passingPayload({ obligationIds: [obligationId] });
  return {
    obligation: {
      ...OBLIGATION,
      id: obligationId,
      contract,
    },
    catalog,
    payload,
  };
}

function gradeDomainObligation(contract: string, transportOnly = false) {
  const { obligation, catalog, payload } = domainObligation(contract);
  const recordPayload = transportOnly
    ? {
        scenario: 'transport-only',
        outcome: 'accepted',
        method: 'POST',
        url: '/profile/accounts/acc-1',
        status: 200,
      }
    : payload;
  const recordKind = transportOnly ? 'http.request' : 'behavior.case';
  const recordBody = {
    ...record(recordPayload, { recordId: HEX('b'), kind: recordKind }),
    obligationId: obligation.id,
    runId: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
  };
  recordBody.recordId = recordIdOf({
    runId: recordBody.runId,
    obligationId: obligation.id,
    kind: recordKind,
    testId: 'test-1',
    origin: 'engine-observed',
    payload: recordPayload,
  });
  return evaluateObligation(obligation, {
    claims: [{ schemaVersion: 1, obligationId: obligation.id, testId: 'test-1' }],
    records: [recordBody],
    waivers: [],
    classification: {
      exposure: 'user-facing',
      plane: 'tenant',
      primaryKey: ['id'],
      lifecycle: LIFECYCLE,
      evidenceAdapter: 'accounts',
    },
    behavior: {
      catalog,
      requirements: catalog.requirements,
      authorityProfileDigest: AUTH_DIGEST,
    },
    httpRoutes: routes(),
    now: '2026-01-01T00:00:00.000Z',
  });
}

describe('Phase 8 behavior.case dispatch', () => {
  it.each([
    'task:idempotent',
    'webhook:signature-accepted',
    'workflow:transition-allowed',
  ])('satisfies %s only through the semantic behavior.case grader', (contract) => {
    const outcome = gradeDomainObligation(contract);
    expect(outcome.verdict, outcome.reason ?? '').toBe('satisfied');
  });

  it.each([
    'task:idempotent',
    'webhook:signature-accepted',
    'workflow:transition-allowed',
  ])('keeps %s blocking when only a transport record is present', (contract) => {
    const outcome = gradeDomainObligation(contract, true);
    expect(outcome.verdict).toBe('missing');
    expect(outcome.reason).toContain('required case');
  });
});

describe('evaluateRequiredCases (green path)', () => {
  it('satisfies an exact update with the observed effect', () => {
    const outcome = grade(passingPayload());
    expect(outcome.status).toBe('satisfied');
    expect(outcome.recordIds).toEqual(['rec-1']);
  });

  it('accepts a declared 303 form-redirect status', () => {
    const def = definition();
    def.expect.statuses = [303];
    const payload = passingPayload();
    (payload.attempts[0] as Record<string, unknown>)['status'] = 303;
    (payload.requestObservations[0] as Record<string, unknown>)['status'] = 303;
    const outcome = grade(payload, { catalog: catalogFor(def) });
    expect(outcome.status).toBe('satisfied');
  });
});

describe('evaluateRequiredCases (binding probes fail)', () => {
  it('action A + read B is a binding mismatch (wrong subject path)', () => {
    const payload = passingPayload();
    (payload.attempts[0] as Record<string, unknown>)['path'] = '/profile/accounts/acc-2';
    (payload.requestObservations[0] as Record<string, unknown>)['path'] = '/profile/accounts/acc-2';
    const outcome = grade(payload);
    expect(outcome.status).toBe('invalid');
    expect(reasonOf(outcome)).toMatch(/BINDING_MISMATCH/);
  });

  it('wrong HTTP method is a binding mismatch', () => {
    const payload = passingPayload();
    (payload.attempts[0] as Record<string, unknown>)['method'] = 'GET';
    const outcome = grade(payload);
    // GET /profile/accounts/acc-1 matches no inventoried route → invalid binding.
    expect(outcome.status).toBe('invalid');
  });

  it('wrong endpoint observation is a binding mismatch', () => {
    const payload = passingPayload();
    (payload.attempts[0] as Record<string, unknown>)['path'] = '/admin/accounts/acc-1';
    (payload.requestObservations[0] as Record<string, unknown>)['path'] = '/admin/accounts/acc-1';
    const outcome = grade(payload);
    expect(outcome.status).toBe('invalid');
    expect(reasonOf(outcome)).toMatch(/BINDING_MISMATCH/);
  });

  it('a 200 with no saved change fails the effect (zero delta)', () => {
    const payload = passingPayload();
    (payload.after[0] as { entities: unknown[] }).entities = [entity('acc-1', 'Grace')];
    const outcome = grade(payload);
    expect(outcome.status).toBe('invalid');
    expect(reasonOf(outcome)).toMatch(/zero state delta|differs from the expected effect/);
  });

  it('a correct row plus a wrong secondary effect fails (unexpected effect)', () => {
    const payload = passingPayload();
    (payload.after[0] as { entities: unknown[] }).entities = [entity('acc-1', 'Ada'), entity('acc-9', 'Mallory')];
    const outcome = grade(payload);
    expect(outcome.status).toBe('invalid');
    expect(reasonOf(outcome)).toMatch(/UNEXPECTED_EFFECT/);
  });

  it('two indistinguishable matching requests are ambiguity, not first-match-wins', () => {
    const payload = passingPayload();
    (payload.attempts as unknown[]).push({ ...(payload.attempts[0] as object), engineRequestId: 'req-2' });
    const outcome = grade(payload);
    expect(outcome.status).toBe('invalid');
    expect(reasonOf(outcome)).toMatch(/ambiguity/);
  });

  it('a missing required case blocks (no evidence credit for labels)', () => {
    const outcome = grade(passingPayload(), { records: [] });
    expect(outcome.status).toBe('missing');
    expect(reasonOf(outcome)).toMatch(/BEHAVIOR_CASE_MISSING/);
  });

  it('duplicate sealed records for one case are invalid', () => {
    const payload = passingPayload();
    const outcome = grade(payload, {
      records: [record(payload, { recordId: 'rec-1' }), record(payload, { recordId: 'rec-2' })],
    });
    expect(outcome.status).toBe('invalid');
    expect(reasonOf(outcome)).toMatch(/one execution/);
  });

  it('a record from an unplanned test claiming this obligation is replay (invalid)', () => {
    const outcome = grade(passingPayload(), {
      records: [record(passingPayload(), { testId: 'other-test' })],
    });
    expect(outcome.status).toBe('invalid');
    expect(reasonOf(outcome)).toMatch(/replay/);
  });

  it('a suite-submitted lookalike is ignored (missing, never satisfied)', () => {
    const outcome = grade(passingPayload(), {
      records: [record(passingPayload(), { origin: 'suite-submitted', trust: 'claimed' })],
    });
    expect(outcome.status).toBe('missing');
  });

  it('a stale spec digest blocks (binding mismatch)', () => {
    const outcome = grade(passingPayload({ caseSpecDigest: HEX('9') }));
    expect(outcome.status).toBe('invalid');
    expect(reasonOf(outcome)).toMatch(/BINDING_MISMATCH/);
  });

  it('a foreign authority profile blocks', () => {
    const outcome = grade(passingPayload({ authorityProfileDigest: HEX('9') }));
    expect(outcome.status).toBe('invalid');
    expect(reasonOf(outcome)).toMatch(/authority profile/);
  });
});

describe('evaluateRequiredCases (bulk exact-set)', () => {
  function importDefinition() {
    const def = definition({
      id: 'import-two',
      action: {
        kind: 'request',
        method: 'POST',
        pathTemplate: '/imports/accounts',
        path: {},
        query: {},
        body: { encoding: 'json', fields: {} },
        credentialVariant: 'valid',
      },
      expect: {
        statuses: [200],
        response: [],
        state: [
          {
            kind: 'exact-set',
            scope: 'accounts',
            rows: [
              { subject: { from: 'literal', value: 'acc-1' }, fields: { first_name: { from: 'literal', value: 'Ada' } } },
              { subject: { from: 'literal', value: 'acc-2' }, fields: { first_name: { from: 'literal', value: 'Bob' } } },
            ],
          },
        ],
      },
    });
    return def;
  }

  function importPayload(after: unknown[]) {
    const def = importDefinition();
    return {
      ...passingPayload(),
      actionDigest: behaviorActionDigestOf(def.action),
      attempts: [
        {
          engineRequestId: 'req-1',
          method: 'POST',
          path: '/imports/accounts',
          endpointResourceId: ENDPOINT,
          actorRef: 'owner-a',
          requestDigest: HEX('1'),
          status: 200,
          responseDigest: HEX('2'),
        },
      ],
      requestObservations: [
        {
          engineRequestId: 'req-1',
          method: 'POST',
          path: '/imports/accounts',
          query: {},
          body: {},
          status: 200,
          responseBody: { ok: true },
        },
      ],
      submittedValues: { path: '/imports/accounts', query: {}, body: {} },
      fixtureValues: {},
      before: [
        { scope: 'fixture-accounts', fixtureNamespace: 'ns-1', complete: true, checkpoint: 'ns-1:1', entities: [] },
      ],
      after: [
        { scope: 'fixture-accounts', fixtureNamespace: 'ns-1', complete: true, checkpoint: 'ns-1:2', entities: after },
      ],
    };
  }

  function importRoutes() {
    return [{ resourceId: ENDPOINT, method: 'POST', canonicalPath: '/imports/accounts' }];
  }

  function gradeImport(after: unknown[]) {
    const def = importDefinition();
    const catalog = catalogFor(def);
    return evaluateRequiredCases({
      obligation: OBLIGATION,
      requiredCaseIds: [CASE_ID],
      records: [record(importPayload(after))] as never,
      context: contextFor(catalog),
      httpRoutes: importRoutes() as never,
    });
  }

  it('a complete two-row import satisfies the exact set', () => {
    const outcome = gradeImport([entity('acc-1', 'Ada'), entity('acc-2', 'Bob')]);
    expect(outcome.status).toBe('satisfied');
  });

  it('one of two rows saved fails the exact set', () => {
    expect(gradeImport([entity('acc-1', 'Ada')]).status).toBe('invalid');
  });

  it('an extra row fails the exact set', () => {
    const outcome = gradeImport([entity('acc-1', 'Ada'), entity('acc-2', 'Bob'), entity('acc-3', 'Eve')]);
    expect(outcome.status).toBe('invalid');
    expect(reasonOf(outcome)).toMatch(/exact set mismatch/);
  });

  it('a duplicate row fails the exact set', () => {
    const outcome = gradeImport([entity('acc-1', 'Ada'), entity('acc-1', 'Ada')]);
    expect(outcome.status).toBe('invalid');
  });
});

describe('evaluateRequiredCases (surface cases)', () => {  function surfaceDefinition() {
    return {
      id: 'profile-edit',
      contract: 'http:effect-verified',
      channel: 'engine-browser',
      fixture: 'one-account',
      actor: 'owner-a',
      action: {
        kind: 'surface',
        surface: 'profile',
        operation: 'update',
        subject: { from: 'fixture', key: 'accountA.identity' },
        fields: { first_name: { from: 'literal', value: 'Ada' } },
      },
      expect: {
        statuses: [303],
        response: [],
        state: [
          {
            kind: 'updated',
            scope: 'accounts',
            subject: { from: 'fixture', key: 'accountA.identity' },
            fields: { first_name: { from: 'literal', value: 'Ada' } },
          },
        ],
        visible: {
          surface: 'profile',
          subject: { from: 'fixture', key: 'accountA.identity' },
          fields: { first_name: { from: 'literal', value: 'Ada' } },
        },
      },
    };
  }

  function surfacePayload(overrides: Record<string, unknown> = {}) {
    return {
      ...passingPayload(),
      channel: 'engine-browser',
      actionDigest: behaviorActionDigestOf(surfaceDefinition().action),
      attempts: [],
      requestObservations: [],
      browserObservation: {
        url: 'http://127.0.0.1/profile/accounts',
        entityId: 'acc-1',
        visibleFields: { first_name: 'Ada', last_name: 'Lovelace' },
      },
      ...overrides,
    };
  }

  function gradeSurface(payload: unknown) {
    const def = surfaceDefinition();
    const catalog = catalogFor(def as never);
    return evaluateRequiredCases({
      obligation: OBLIGATION,
      requiredCaseIds: [CASE_ID],
      records: [record(payload)] as never,
      context: contextFor(catalog),
      httpRoutes: routes() as never,
    });
  }

  it('satisfies an engine-observed surface update with matching visible outcome', () => {
    expect(gradeSurface(surfacePayload()).status).toBe('satisfied');
  });

  it('fails when the observed entity is not the declared subject', () => {
    const payload = surfacePayload({
      browserObservation: { url: 'http://x/', entityId: 'acc-9', visibleFields: { first_name: 'Ada' } },
    });
    const outcome = gradeSurface(payload);
    expect(outcome.status).toBe('invalid');
    expect(reasonOf(outcome)).toMatch(/not the declared case subject/);
  });

  it('fails when a rendered field differs', () => {
    const payload = surfacePayload({
      browserObservation: { url: 'http://x/', entityId: 'acc-1', visibleFields: { first_name: 'Mallory' } },
    });
    expect(gradeSurface(payload).status).toBe('invalid');
  });

  it('blocks without a sealed browser observation (missing, never satisfied)', () => {
    const payload = { ...surfacePayload() };
    delete (payload as Record<string, unknown>)['browserObservation'];
    const outcome = gradeSurface(payload);
    expect(outcome.status).toBe('missing');
  });

  it('rejects HTTP attempts on a surface record (binding mismatch)', () => {
    const payload = surfacePayload({
      attempts: [
        {
          engineRequestId: 'req-1',
          method: 'POST',
          path: '/profile/accounts/acc-1',
          endpointResourceId: ENDPOINT,
          actorRef: 'owner-a',
          requestDigest: HEX('1'),
          status: 303,
          responseDigest: HEX('2'),
        },
      ],
    });
    expect(gradeSurface(payload).status).toBe('invalid');
  });
});

describe('evaluateRequiredCases (denial probes B26-B28)', () => {
  function denialCatalog(contract: string, def: ReturnType<typeof definition>) {
    const obligation = `${ENDPOINT}:${contract}`;
    return {
      catalog: {
        schemaVersion: 1,
        catalogDigest: HEX('f'),
        cases: [
          {
            caseId: CASE_ID,
            specDigest: SPEC_DIGEST,
            resourceId: ENDPOINT,
            endpointResourceId: ENDPOINT,
            obligationIds: [obligation],
            definition: def as never,
            effects: [
              {
                id: 'accounts',
                resourceId: 'tenant.accounts',
                adapter: 'accounts',
                scope: 'fixture-accounts',
                identityFields: ['id'],
                fields: ['first_name'],
                completion: 'immediate',
              },
            ],
            sourceFiles: ['backend/profile.js'],
          },
        ],
        requirements: { [obligation]: [CASE_ID] },
        dependencies: { [ENDPOINT]: ['tenant.accounts'] },
      } as BehaviorCatalog,
      obligation: {
        schemaVersion: 1,
        id: obligation,
        resourceId: ENDPOINT,
        contract,
        policyId: 'behavior-policy',
        lifecycle: LIFECYCLE,
      } as Obligation,
    };
  }

  function denialPayload(overrides: Record<string, unknown> = {}) {
    return {
      ...passingPayload(),
      attempts: [
        {
          engineRequestId: 'req-1',
          method: 'POST',
          path: '/profile/accounts/acc-1',
          endpointResourceId: ENDPOINT,
          actorRef: 'member-a',
          requestDigest: HEX('1'),
          status: 403,
          responseDigest: HEX('2'),
        },
      ],
      requestObservations: [
        {
          engineRequestId: 'req-1',
          method: 'POST',
          path: '/profile/accounts/acc-1',
          query: {},
          body: { first_name: 'Ada' },
          status: 403,
          responseBody: { error: 'forbidden' },
        },
      ],
      submittedValues: { path: '/profile/accounts/acc-1', query: {}, body: { first_name: 'Ada' } },
      ...overrides,
    };
  }

  function gradeDenial(contract: string, def: ReturnType<typeof definition>, payload: unknown) {
    const { catalog, obligation } = denialCatalog(contract, def);
    (payload as Record<string, unknown>)['obligationIds'] = [obligation.id];
    (payload as Record<string, unknown>)['actionDigest'] = behaviorActionDigestOf(
      (def as { action: unknown }).action,
    );
    return evaluateRequiredCases({
      obligation,
      requiredCaseIds: [CASE_ID],
      records: [record(payload)] as never,
      context: contextFor(catalog),
      httpRoutes: routes() as never,
    });
  }

  function deniedDef() {
    const def = definition({
      id: 'member-denied',
      contract: 'auth:role-denied',
      actor: 'member-a',
      controlCase: 'owner-update',
    });
    (def.expect as { statuses: number[] }).statuses = [403];
    (def.expect as { state: unknown }).state = [
      {
        kind: 'unchanged',
        scope: 'accounts',
      },
    ];
    return def;
  }

  it('B26: denial against a nonexistent record fails fixture validation', () => {
    // Path targets acc-9, which exists nowhere in before-state: the 403
    // might merely mean a malformed fixture, not a denial.
    const def = deniedDef();
    (def.action as unknown as { path: Record<string, { from: string; value: unknown }> }).path = {
      id: { from: 'literal', value: 'acc-9' },
    };
    const payload = denialPayload();
    (payload.attempts[0] as Record<string, unknown>)['path'] = '/profile/accounts/acc-9';
    (payload.requestObservations[0] as Record<string, unknown>)['path'] = '/profile/accounts/acc-9';
    (payload.submittedValues as Record<string, unknown>)['path'] = '/profile/accounts/acc-9';
    const outcome = gradeDenial('auth:role-denied', def, payload);
    expect(outcome.status).toBe('invalid');
    expect(reasonOf(outcome)).toMatch(/fixture validation/);
  });

  it('B27: a 403 recorded after a business mutation fails (no-side-effect)', () => {
    const def = deniedDef();
    const payload = denialPayload({
      after: [
        {
          scope: 'fixture-accounts',
          fixtureNamespace: 'ns-1',
          complete: true,
          checkpoint: 'ns-1:2',
          entities: [entity('acc-1', 'Ada')],
        },
      ],
    });
    const outcome = gradeDenial('auth:denied-no-side-effect', { ...def, contract: 'auth:denied-no-side-effect', id: 'deny-write' }, payload);
    expect(outcome.status).toBe('invalid');
  });

  it('B28: a 403 body leaking the foreign record fails confidentiality', () => {
    const def = deniedDef();
    (def.expect as { response: unknown }).response = [{ kind: 'absent', pointer: '/refund' }];
    const payload = denialPayload({
      requestObservations: [
        {
          engineRequestId: 'req-1',
          method: 'POST',
          path: '/profile/accounts/acc-1',
          query: {},
          body: { first_name: 'Ada' },
          status: 403,
          responseBody: { error: 'forbidden', refund: { id: 'acc-1', first_name: 'Grace' } },
        },
      ],
    });
    const outcome = gradeDenial('auth:tenant-isolated', { ...def, contract: 'auth:tenant-isolated', id: 'cross-tenant' }, payload);
    expect(outcome.status).toBe('invalid');
  });
});

describe('evaluateRequiredCases (strength separation)', () => {
  it('a weaker Observe record never satisfies a protected browser case (B59)', () => {
    const def = definition();
    const catalog = catalogFor(def);
    const observeRecord = {
      recordId: 'rec-observe',
      testId: 'test-1',
      kind: 'persistence.observed',
      origin: 'engine-observed',
      trust: 'witnessed',
      payload: { channel: 'observe', obligationIds: [OBLIGATION_ID] },
    };
    const outcome = evaluateRequiredCases({
      obligation: OBLIGATION,
      requiredCaseIds: [CASE_ID],
      records: [observeRecord] as never,
      context: contextFor(catalog),
      httpRoutes: routes() as never,
    });
    expect(outcome.status).toBe('missing');
  });
});

describe('evaluateRequiredCases (read contracts)', () => {
  it('a read returning another row fails the entity set', () => {
    const def = definition({
      id: 'read-one',
      contract: 'http:read-result-verified',
      action: {
        kind: 'request',
        method: 'GET',
        pathTemplate: '/profile/accounts/{id}',
        path: { id: { from: 'fixture', key: 'accountA.id' } },
        query: {},
        body: { encoding: 'json', fields: {} },
        credentialVariant: 'valid',
      },
      expect: {
        statuses: [200],
        response: [
          {
            kind: 'entity-set',
            pointer: '/accounts',
            identityFields: ['id'],
            expected: [{ from: 'fixture', key: 'accountA.row' }],
          },
        ],
        state: [{ kind: 'unchanged', scope: 'accounts' }],
      },
    });
    const catalog = catalogFor(def);
    const readObligation: Obligation = { ...OBLIGATION, id: `${ENDPOINT}:http:read-result-verified`, contract: 'http:read-result-verified' };
    const catalogWithRead: BehaviorCatalog = {
      ...catalog,
      cases: [{ ...catalog.cases[0], obligationIds: [readObligation.id] } as never],
      requirements: { [readObligation.id]: [CASE_ID] },
    };
    const payload = {
      ...passingPayload(),
      obligationIds: [readObligation.id],
      actionDigest: behaviorActionDigestOf(def.action),
      attempts: [
        {
          engineRequestId: 'req-1',
          method: 'GET',
          path: '/profile/accounts/acc-1',
          endpointResourceId: ENDPOINT,
          actorRef: 'owner-a',
          requestDigest: HEX('1'),
          status: 200,
          responseDigest: HEX('2'),
        },
      ],
      requestObservations: [
        {
          engineRequestId: 'req-1',
          method: 'GET',
          path: '/profile/accounts/acc-1',
          query: {},
          body: {},
          status: 200,
          // Another user's row leaks into the filter result.
          responseBody: { accounts: [{ id: 'acc-9', first_name: 'Mallory' }] },
        },
      ],
      submittedValues: { path: '/profile/accounts/acc-1', query: {}, body: {} },
      fixtureValues: { accountA: { id: 'acc-1', identity: 'acc-1', row: { id: 'acc-1', first_name: 'Ada' } } },
      before: [
        { scope: 'fixture-accounts', fixtureNamespace: 'ns-1', complete: true, checkpoint: 'ns-1:1', entities: [entity('acc-1', 'Ada')] },
      ],
      after: [
        { scope: 'fixture-accounts', fixtureNamespace: 'ns-1', complete: true, checkpoint: 'ns-1:1', entities: [entity('acc-1', 'Ada')] },
      ],
    };
    const outcome = evaluateRequiredCases({
      obligation: readObligation,
      requiredCaseIds: [CASE_ID],
      records: [record(payload)] as never,
      context: { ...contextFor(catalogWithRead), requirements: catalogWithRead.requirements },
      httpRoutes: [{ resourceId: ENDPOINT, method: 'GET', canonicalPath: '/profile/accounts/{}' }] as never,
    });
    expect(outcome.status).toBe('invalid');
  });
});
