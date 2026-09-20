/**
 * Behavior-policy schemas and compiler (plan 2026-09-19 Phase 1):
 * every discovered endpoint gets its own requirement identity; required
 * cases AND; missing/stale references block; strong contracts stay
 * unavailable without a real behavior.case producer.
 */
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import {
  BehaviorCasePayloadSchema,
  BehaviorPolicySchema,
  CAUSE_NEXT_ACTIONS,
  EMPTY_BEHAVIOR_CATALOG_DIGEST,
  PolicyEvaluationError,
  ScopeSnapshotSchema,
  capabilityFor,
  compileBehaviorPolicy,
  evaluateObligation,
  fingerprint,
  fingerprintObligation,
  parseBehaviorPolicy,
  sha256Canonical,
  type BehaviorPolicy,
  type GraphResource,
  type ResourceGraph,
} from '../src/index.js';

const LIFECYCLE = {
  create: true,
  read: true,
  update: true,
  delete: true,
  deleteSemantics: 'hard' as const,
};

const PROFILE_ID = 'tenant.http-post-profile-accounts-param';
const ADMIN_ID = 'tenant.http-post-admin-accounts-param';
const IMPORT_ID = 'tenant.http-post-imports-accounts';
const DIGEST_A = 'a'.repeat(64);

function classifiedEndpoint(
  id: string,
  name: string,
  attributes: Record<string, unknown>,
): GraphResource {
  return {
    schemaVersion: 1,
    id,
    name,
    plane: 'tenant',
    kind: 'http.endpoint',
    source: `backend/${name}.js`,
    location: { file: `backend/${name}.js`, line: 10, col: 0 },
    exposure: 'user-facing',
    classification: {
      exposure: 'user-facing',
      plane: 'tenant',
      lifecycle: LIFECYCLE,
      primaryKey: ['method', 'path'],
      evidenceAdapter: 'accounts',
    },
    classificationTrace: null,
    detector: { id: 'gateforge.endpoint-compiler', version: '1' },
    attributes,
  };
}

function classifiedTable(id: string, name: string, plane: 'tenant' | 'master'): GraphResource {
  return {
    schemaVersion: 1,
    id,
    name,
    plane,
    kind: 'sqlalchemy.table',
    source: `models/${name}.py`,
    location: { file: `models/${name}.py`, line: 1, col: 0 },
    exposure: 'user-facing',
    classification: {
      exposure: 'user-facing',
      plane,
      lifecycle: LIFECYCLE,
      primaryKey: plane === 'tenant' ? ['tenant_id', 'id'] : ['id'],
      evidenceAdapter: 'accounts',
    },
    classificationTrace: null,
    detector: { id: 'gateforge.pack-sqlalchemy', version: '1' },
    attributes: { resourceName: name },
  };
}

function graphOf(resources: GraphResource[]): ResourceGraph {
  return { schemaVersion: 1, resources, unresolved: [], findings: [], stale: [] };
}

function accountsEffect(resourceId: string) {
  return {
    id: 'accounts',
    resourceId,
    adapter: 'accounts',
    scope: 'fixture-accounts',
    identityFields: ['tenant_id', 'id'],
    fields: ['first_name', 'last_name', 'status'],
    completion: 'immediate' as const,
  };
}

function ownerUpdateCase(id: string, pathTemplate: string, firstName: string, lastName: string) {
  return {
    id,
    contract: 'http:effect-verified' as const,
    channel: 'engine-http' as const,
    fixture: 'two-tenants-two-accounts',
    actor: 'owner-a',
    action: {
      kind: 'request' as const,
      method: 'POST' as const,
      pathTemplate,
      path: { id: { from: 'fixture' as const, key: 'accountA.id' } },
      query: {},
      body: {
        encoding: 'json' as const,
        fields: {
          first_name: { from: 'literal' as const, value: firstName },
          last_name: { from: 'literal' as const, value: lastName },
        },
      },
      credentialVariant: 'valid' as const,
    },
    expect: {
      statuses: [200],
      response: [],
      state: [
        {
          kind: 'updated' as const,
          scope: 'accounts',
          subject: { from: 'fixture' as const, key: 'accountA.identity' },
          fields: {
            first_name: {
              from: 'request' as const,
              attempt: 0,
              pointer: '/body/first_name',
              transform: 'identity' as const,
            },
            last_name: {
              from: 'request' as const,
              attempt: 0,
              pointer: '/body/last_name',
              transform: 'identity' as const,
            },
          },
        },
      ],
    },
  };
}

const EXAMPLE_YAML = `
schemaVersion: 1
endpoints:
  - resourceId: tenant.http-post-profile-accounts-param
    effects:
      - id: accounts
        resourceId: tenant.accounts
        adapter: accounts
        scope: fixture-accounts
        identityFields: [tenant_id, id]
        fields: [first_name, last_name, status]
        completion: immediate
    cases:
      - id: owner-update
        contract: http:effect-verified
        channel: engine-http
        fixture: two-tenants-two-accounts
        actor: owner-a
        action:
          kind: request
          method: POST
          pathTemplate: /profile/accounts/{id}
          path:
            id: {from: fixture, key: accountA.id}
          query: {}
          body:
            encoding: json
            fields:
              first_name: {from: literal, value: Ada}
              last_name: {from: literal, value: Lovelace}
          credentialVariant: valid
        expect:
          statuses: [200]
          response: []
          state:
            - kind: updated
              scope: accounts
              subject: {from: fixture, key: accountA.identity}
              fields:
                first_name: {from: request, attempt: 0, pointer: /body/first_name, transform: identity}
                last_name: {from: request, attempt: 0, pointer: /body/last_name, transform: identity}
      - id: foreign-tenant-denied
        contract: auth:tenant-isolated
        channel: engine-http
        fixture: two-tenants-two-accounts
        actor: owner-b
        controlCase: owner-update
        action:
          kind: request
          method: POST
          pathTemplate: /profile/accounts/{id}
          path:
            id: {from: fixture, key: accountA.id}
          query: {}
          body:
            encoding: json
            fields:
              first_name: {from: literal, value: Ada}
              last_name: {from: literal, value: Lovelace}
          credentialVariant: valid
        expect:
          statuses: [403]
          response:
            - {kind: absent, pointer: /account}
          state:
            - {kind: unchanged, scope: accounts}
  - resourceId: tenant.http-post-admin-accounts-param
    effects:
      - id: accounts
        resourceId: tenant.accounts
        adapter: accounts
        scope: fixture-accounts
        identityFields: [tenant_id, id]
        fields: [first_name, last_name, status]
        completion: immediate
    cases:
      - id: admin-update
        contract: http:effect-verified
        channel: engine-http
        fixture: two-tenants-two-accounts
        actor: admin-a
        action:
          kind: request
          method: POST
          pathTemplate: /admin/accounts/{id}
          path:
            id: {from: fixture, key: accountA.id}
          query: {}
          body:
            encoding: json
            fields:
              first_name: {from: literal, value: Grace}
              last_name: {from: literal, value: Hopper}
          credentialVariant: valid
        expect:
          statuses: [200]
          response: []
          state:
            - kind: updated
              scope: accounts
              subject: {from: fixture, key: accountA.identity}
              fields:
                first_name: {from: request, attempt: 0, pointer: /body/first_name, transform: identity}
                last_name: {from: request, attempt: 0, pointer: /body/last_name, transform: identity}
resources: []
`;

function exampleGraph(extra: GraphResource[] = []): ResourceGraph {
  return graphOf([
    classifiedEndpoint(PROFILE_ID, 'profile-accounts', {
      method: 'POST',
      canonicalPath: '/profile/accounts/{}',
      linkedResourceName: 'accounts',
      frontendConsumed: true,
    }),
    classifiedEndpoint(ADMIN_ID, 'admin-accounts', {
      method: 'POST',
      canonicalPath: '/admin/accounts/{}',
      linkedResourceName: 'accounts',
      frontendConsumed: false,
    }),
    classifiedTable('tenant.accounts', 'accounts', 'tenant'),
    ...extra,
  ]);
}

describe('BehaviorPolicySchema', () => {
  it('parses the plan YAML example with three cases', () => {
    const policy = BehaviorPolicySchema.parse(parseYaml(EXAMPLE_YAML));
    expect(policy.endpoints).toHaveLength(2);
    expect(policy.endpoints[0]?.cases.map((item) => item.id)).toEqual([
      'owner-update',
      'foreign-tenant-denied',
    ]);
    expect(policy.endpoints[1]?.cases.map((item) => item.id)).toEqual(['admin-update']);
  });

  it('rejects unknown schema versions', () => {
    expect(() => parseBehaviorPolicy({ schemaVersion: 2, endpoints: [], resources: [] })).toThrow(
      PolicyEvaluationError,
    );
  });

  it('rejects duplicate case ids on one subject', () => {
    const policy = {
      schemaVersion: 1,
      endpoints: [
        {
          resourceId: PROFILE_ID,
          effects: [accountsEffect('tenant.accounts')],
          cases: [
            ownerUpdateCase('owner-update', '/profile/accounts/{id}', 'Ada', 'Lovelace'),
            ownerUpdateCase('owner-update', '/profile/accounts/{id}', 'Ada', 'Lovelace'),
          ],
        },
      ],
      resources: [],
    };
    expect(() => BehaviorPolicySchema.parse(policy)).toThrow(/duplicate case id/);
  });

  it('rejects missing positive control on a denial contract', () => {
    const policy = {
      schemaVersion: 1,
      endpoints: [
        {
          resourceId: PROFILE_ID,
          effects: [accountsEffect('tenant.accounts')],
          cases: [
            {
              ...ownerUpdateCase('foreign-tenant-denied', '/profile/accounts/{id}', 'Ada', 'Lovelace'),
              contract: 'auth:tenant-isolated',
              expect: {
                statuses: [403],
                response: [{ kind: 'absent', pointer: '/account' }],
                state: [{ kind: 'unchanged', scope: 'accounts' }],
              },
            },
          ],
        },
      ],
      resources: [],
    };
    expect(() => BehaviorPolicySchema.parse(policy)).toThrow(/controlCase/);
  });

  it('rejects empty mutation expectations', () => {
    const behaviorCase = ownerUpdateCase('owner-update', '/profile/accounts/{id}', 'Ada', 'Lovelace');
    behaviorCase.expect.state = [];
    expect(() =>
      BehaviorPolicySchema.parse({
        schemaVersion: 1,
        endpoints: [
          {
            resourceId: PROFILE_ID,
            effects: [accountsEffect('tenant.accounts')],
            cases: [behaviorCase],
          },
        ],
        resources: [],
      }),
    ).toThrow(/empty state rules/);
  });

  it('rejects arbitrary expression/callback values', () => {
    expect(() =>
      BehaviorPolicySchema.parse({
        schemaVersion: 1,
        endpoints: [
          {
            resourceId: PROFILE_ID,
            effects: [accountsEffect('tenant.accounts')],
            cases: [
              {
                ...ownerUpdateCase('owner-update', '/profile/accounts/{id}', 'Ada', 'Lovelace'),
                action: {
                  kind: 'request',
                  method: 'POST',
                  pathTemplate: '/profile/accounts/{id}',
                  path: {},
                  query: {},
                  body: {
                    encoding: 'json',
                    fields: { first_name: { from: 'expression', expr: '1+1' } },
                  },
                  credentialVariant: 'valid',
                },
              },
            ],
          },
        ],
        resources: [],
      }),
    ).toThrow();
  });

  it('rejects secret YAML literals', () => {
    expect(() =>
      BehaviorPolicySchema.parse({
        schemaVersion: 1,
        endpoints: [
          {
            resourceId: PROFILE_ID,
            effects: [accountsEffect('tenant.accounts')],
            cases: [
              {
                ...ownerUpdateCase('owner-update', '/profile/accounts/{id}', 'Ada', 'Lovelace'),
                action: {
                  kind: 'request',
                  method: 'POST',
                  pathTemplate: '/profile/accounts/{id}',
                  path: {},
                  query: {},
                  body: {
                    encoding: 'json',
                    fields: { password: { from: 'literal', value: 'hunter2' } },
                  },
                  credentialVariant: 'valid',
                },
              },
            ],
          },
        ],
        resources: [],
      }),
    ).toThrow(/secret field/);
  });

  it('rejects unknown keys', () => {
    expect(() =>
      BehaviorPolicySchema.parse({ schemaVersion: 1, endpoints: [], resources: [], warnOnly: true }),
    ).toThrow();
  });
});

describe('compileBehaviorPolicy', () => {
  it('emits distinct obligations and case sets for two endpoints on one table', () => {
    const policy = BehaviorPolicySchema.parse(parseYaml(EXAMPLE_YAML));
    const result = compileBehaviorPolicy({ graph: exampleGraph(), policy });
    expect(result.blocking.map((entry) => entry.cause)).toEqual([]);
    const obligationIds = result.obligations.map((item) => item.id).sort();
    expect(obligationIds).toEqual([
      `${ADMIN_ID}:http:effect-verified`,
      `${PROFILE_ID}:auth:tenant-isolated`,
      `${PROFILE_ID}:http:effect-verified`,
    ]);
    expect(result.catalog.requirements[`${PROFILE_ID}:http:effect-verified`]).toHaveLength(1);
    expect(result.catalog.requirements[`${ADMIN_ID}:http:effect-verified`]).toHaveLength(1);
    expect(result.catalog.requirements[`${PROFILE_ID}:http:effect-verified`]).not.toEqual(
      result.catalog.requirements[`${ADMIN_ID}:http:effect-verified`],
    );
    for (const obligation of result.obligations) {
      expect(obligation.requirementsDigest).toMatch(/^[0-9a-f]{64}$/);
      expect(obligation.resourceId.includes(':')).toBe(false);
    }
  });

  it('is deterministic under reordered endpoint/case maps', () => {
    const policy = BehaviorPolicySchema.parse(parseYaml(EXAMPLE_YAML));
    const reversed: BehaviorPolicy = {
      ...policy,
      endpoints: [...policy.endpoints].reverse().map((endpoint) => ({
        ...endpoint,
        cases: [...endpoint.cases].reverse(),
        effects: [...endpoint.effects].reverse(),
      })),
    };
    const a = compileBehaviorPolicy({ graph: exampleGraph(), policy });
    const b = compileBehaviorPolicy({ graph: exampleGraph(), policy: reversed });
    expect(b.catalog.catalogDigest).toBe(a.catalog.catalogDigest);
    expect(b.obligations.map((item) => item.requirementsDigest)).toEqual(
      a.obligations.map((item) => item.requirementsDigest),
    );
  });

  it('changes requirementsDigest when expected values change, not when maps are reordered', () => {
    const policy = BehaviorPolicySchema.parse(parseYaml(EXAMPLE_YAML));
    const baseline = compileBehaviorPolicy({ graph: exampleGraph(), policy });
    const mutated = structuredClone(policy);
    const field = mutated.endpoints[0]?.cases[0]?.action;
    if (field !== undefined && field.kind === 'request' && field.body.encoding === 'json') {
      field.body.fields['first_name'] = { from: 'literal', value: 'Grace' };
    }
    const changed = compileBehaviorPolicy({ graph: exampleGraph(), policy: mutated });
    const baseProfile = baseline.obligations.find((item) => item.id === `${PROFILE_ID}:http:effect-verified`);
    const changedProfile = changed.obligations.find((item) => item.id === `${PROFILE_ID}:http:effect-verified`);
    expect(changedProfile?.requirementsDigest).not.toBe(baseProfile?.requirementsDigest);
  });

  it('keeps same bare table names in different planes distinct', () => {
    const policy: BehaviorPolicy = {
      schemaVersion: 1,
      endpoints: [
        {
          resourceId: PROFILE_ID,
          effects: [accountsEffect('tenant.accounts')],
          cases: [ownerUpdateCase('owner-update', '/profile/accounts/{id}', 'Ada', 'Lovelace')],
        },
        {
          resourceId: 'master.http-post-admin-accounts-param',
          effects: [accountsEffect('master.accounts')],
          cases: [ownerUpdateCase('admin-update', '/admin/accounts/{id}', 'Grace', 'Hopper')],
        },
      ],
      resources: [],
    };
    const result = compileBehaviorPolicy({
      graph: graphOf([
        classifiedEndpoint(PROFILE_ID, 'profile-accounts', {
          method: 'POST',
          canonicalPath: '/profile/accounts/{}',
          linkedResourceName: 'accounts',
        }),
        classifiedEndpoint('master.http-post-admin-accounts-param', 'master-admin', {
          method: 'POST',
          canonicalPath: '/admin/accounts/{}',
          linkedResourceName: 'accounts',
        }),
        classifiedTable('tenant.accounts', 'accounts', 'tenant'),
        classifiedTable('master.accounts', 'accounts', 'master'),
      ]),
      policy,
    });
    expect(result.catalog.dependencies[PROFILE_ID]).toEqual(['tenant.accounts']);
    expect(result.catalog.dependencies['master.http-post-admin-accounts-param']).toEqual([
      'master.accounts',
    ]);
    expect(result.obligations.map((item) => item.resourceId).sort()).toEqual([
      'master.http-post-admin-accounts-param',
      PROFILE_ID,
    ]);
  });

  it('blocks a discovered endpoint with no declaration (ENDPOINT_BEHAVIOR_MISSING)', () => {
    const policy = BehaviorPolicySchema.parse(parseYaml(EXAMPLE_YAML));
    const result = compileBehaviorPolicy({
      graph: exampleGraph([
        classifiedEndpoint(IMPORT_ID, 'import-accounts', {
          method: 'POST',
          canonicalPath: '/imports/accounts',
          linkedResourceName: 'accounts',
          frontendConsumed: false,
        }),
      ]),
      policy,
    });
    const missing = result.blocking.find((entry) => entry.cause === 'ENDPOINT_BEHAVIOR_MISSING');
    expect(missing?.resourceId).toBe(IMPORT_ID);
    expect(missing?.nextAction).toBe(CAUSE_NEXT_ACTIONS.ENDPOINT_BEHAVIOR_MISSING);
    expect(result.obligations.some((item) => item.resourceId === IMPORT_ID)).toBe(false);
  });

  it('blocks a stale endpoint reference (BEHAVIOR_REFERENCE_STALE)', () => {
    const policy = BehaviorPolicySchema.parse(parseYaml(EXAMPLE_YAML));
    const result = compileBehaviorPolicy({
      graph: graphOf([
        classifiedEndpoint(PROFILE_ID, 'profile-accounts', {
          method: 'POST',
          canonicalPath: '/profile/accounts/{}',
          linkedResourceName: 'accounts',
        }),
        classifiedTable('tenant.accounts', 'accounts', 'tenant'),
      ]),
      policy,
    });
    const stale = result.blocking.find((entry) => entry.cause === 'BEHAVIOR_REFERENCE_STALE');
    expect(stale?.resourceId).toBe(ADMIN_ID);
    expect(stale?.kind).toBe('stale-reference');
  });

  it('rejects operational-only on a non-health route', () => {
    const policy: BehaviorPolicy = {
      schemaVersion: 1,
      endpoints: [
        {
          resourceId: PROFILE_ID,
          effects: [accountsEffect('tenant.accounts')],
          cases: [],
          disposition: { kind: 'operational-only', reason: 'named health' },
        },
      ],
      resources: [],
    };
    expect(() => compileBehaviorPolicy({ graph: exampleGraph(), policy })).toThrow(
      /health-operations/,
    );
  });

  it('uses the canonical empty catalog digest when every endpoint is out-of-scope', () => {
    const policy: BehaviorPolicy = {
      schemaVersion: 1,
      endpoints: [
        {
          resourceId: PROFILE_ID,
          effects: [accountsEffect('tenant.accounts')],
          cases: [ownerUpdateCase('owner-update', '/profile/accounts/{id}', 'Ada', 'Lovelace')],
          disposition: { kind: 'out-of-scope', reason: 'owner exclusion' },
        },
        {
          resourceId: ADMIN_ID,
          effects: [accountsEffect('tenant.accounts')],
          cases: [ownerUpdateCase('admin-update', '/admin/accounts/{id}', 'Grace', 'Hopper')],
          disposition: { kind: 'out-of-scope', reason: 'owner exclusion' },
        },
      ],
      resources: [],
    };
    const result = compileBehaviorPolicy({ graph: exampleGraph(), policy });
    expect(result.catalog.cases).toEqual([]);
    expect(result.catalog.catalogDigest).toBe(EMPTY_BEHAVIOR_CATALOG_DIGEST);
    expect(result.obligations).toEqual([]);
  });
});

describe('behavior.case schema (no issuer)', () => {
  it('accepts a complete payload and rejects unknown keys', () => {
    const payload = BehaviorCasePayloadSchema.parse({
      payloadVersion: 1,
      caseId: DIGEST_A,
      caseSpecDigest: DIGEST_A,
      obligationIds: [`${PROFILE_ID}:http:effect-verified`],
      endpointResourceId: PROFILE_ID,
      operationId: 'op-1',
      sessionId: 'session-1',
      executionId: 'exec-1',
      fixtureNamespace: 'run-1',
      actor: { principalId: 'owner-a', tenantId: 't-a', roles: ['owner'] },
      actionDigest: DIGEST_A,
      submittedValues: { first_name: 'Ada' },
      attempts: [],
      requestObservations: [],
      fixtureValues: {},
      before: [],
      after: [],
      completion: { complete: true, checkpoint: 'done' },
      channel: 'engine-http',
      authorityProfileDigest: DIGEST_A,
      state: 'sealed',
    });
    expect(payload.payloadVersion).toBe(1);
    expect(() =>
      BehaviorCasePayloadSchema.parse({ ...payload, forged: true }),
    ).toThrow();
  });

  it('rejects incomplete scope snapshots as data, not as a skip', () => {
    const snapshot = ScopeSnapshotSchema.parse({
      scope: 'accounts',
      fixtureNamespace: 'run-1',
      complete: false,
      checkpoint: 'page-1',
      entities: [],
    });
    expect(snapshot.complete).toBe(false);
  });
});

describe('strong HTTP contracts are available with genuine case evidence', () => {
  it('registers effect-verified and read-result-verified as available (Phase 5 grader)', () => {
    const http = capabilityFor('http:effect-verified');
    expect(http?.contracts).toEqual([
      'http:request-observed',
      'http:response-status-ok',
      'http:effect-verified',
      'http:read-result-verified',
    ]);
    expect(
      http?.unavailableContracts.map((entry) => entry.contract),
    ).toEqual(['http:frontend-request-observed']);
  });

  it('grades a fabricated behavior.case-shaped claim as missing', () => {
    const outcome = evaluateObligation(
      {
        schemaVersion: 1,
        id: `${PROFILE_ID}:http:effect-verified`,
        resourceId: PROFILE_ID,
        contract: 'http:effect-verified',
        policyId: 'behavior-policy',
        lifecycle: LIFECYCLE,
        requirementsDigest: DIGEST_A,
      },
      {
        claims: [
          {
            schemaVersion: 1,
            obligationId: `${PROFILE_ID}:http:effect-verified`,
            testId: 'forged',
            testFile: 'forged.spec.js',
          },
        ],
        records: [],
        waivers: [],
        classification: {
          exposure: 'user-facing',
          plane: 'tenant',
          lifecycle: LIFECYCLE,
          primaryKey: ['id'],
          evidenceAdapter: 'accounts',
        },
        now: new Date('2026-09-19T00:00:00.000Z'),
      },
    );
    expect(outcome.verdict).toBe('missing');
    expect(outcome.reason).toContain('no trusted behavior.case observer');
  });
});

describe('fingerprint projection', () => {
  it('omitting requirementsDigest preserves the historical four-key hash', () => {
    const four = {
      resourceId: 'tenant.accounts',
      contract: 'crud:update',
      policyId: 'p',
      lifecycle: LIFECYCLE,
    };
    expect(fingerprint(four)).toBe(sha256Canonical(four));
    expect(fingerprintObligation(four)).toBe(fingerprint(four));
    expect(
      fingerprint({ ...four, requirementsDigest: DIGEST_A }),
    ).not.toBe(fingerprint(four));
  });
});
