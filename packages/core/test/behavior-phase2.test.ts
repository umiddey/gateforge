/**
 * Phase 2 (plan 2026-09-19): every endpoint gets a requirement; stale
 * effects block; required cases without a declared test mapping block
 * with BEHAVIOR_CASE_UNMAPPED; native-only claims never satisfy cases.
 */
import { describe, expect, it } from 'vitest';
import {
  BehaviorPolicySchema,
  compileBehaviorPolicy,
  resolveTestMappings,
  TestMapEntrySchema,
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
const TABLE_ID = 'tenant.accounts';

function endpoint(id: string, name: string): GraphResource {
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
    attributes: { method: 'POST', canonicalPath: '/profile/accounts/{}', linkedResourceName: 'accounts' },
  };
}

function table(id: string, name: string): GraphResource {
  return {
    schemaVersion: 1,
    id,
    name,
    plane: 'tenant',
    kind: 'sqlalchemy.table',
    source: `models/${name}.py`,
    location: { file: `models/${name}.py`, line: 1, col: 0 },
    exposure: 'user-facing',
    classification: {
      exposure: 'user-facing',
      plane: 'tenant',
      lifecycle: LIFECYCLE,
      primaryKey: ['tenant_id', 'id'],
      evidenceAdapter: 'accounts',
    },
    classificationTrace: null,
    detector: { id: 'gateforge.pack-sqlalchemy', version: '1' },
    attributes: { resourceName: name },
  };
}

function effect(resourceId: string) {
  return {
    id: 'accounts',
    resourceId,
    adapter: 'accounts',
    scope: 'fixture-accounts',
    identityFields: ['tenant_id', 'id'],
    fields: ['first_name'],
    completion: 'immediate' as const,
  };
}

function httpCase(id: string) {
  return {
    id,
    contract: 'http:effect-verified' as const,
    channel: 'engine-http' as const,
    fixture: 'one-account',
    actor: 'owner-a',
    action: {
      kind: 'request' as const,
      method: 'POST' as const,
      pathTemplate: '/profile/accounts/{id}',
      path: { id: { from: 'fixture' as const, key: 'accountA.id' } },
      query: {},
      body: {
        encoding: 'json' as const,
        fields: { first_name: { from: 'literal' as const, value: 'Ada' } },
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
          fields: { first_name: { from: 'literal' as const, value: 'Ada' } },
        },
      ],
    },
  };
}

function graphOf(resources: GraphResource[]): ResourceGraph {
  return { schemaVersion: 1, resources, unresolved: [], findings: [], stale: [] };
}

function catalogOf(obligationId: string, logicalKey: string) {
  return {
    schemaVersion: 1 as const,
    entries: [
      {
        schemaVersion: 1 as const,
        logicalKey,
        runner: 'playwright' as const,
        project: null,
        file: 'e2e/profile.spec.js',
        titlePath: ['profile updates account'],
        title: 'profile updates account',
        parameterIdentity: null,
        inferredKind: 'browser-e2e' as const,
        kindSignals: [],
        categorySignals: [],
        suppressionSignals: [],
        sourceDigest: 'd'.repeat(64),
        sourceLocation: { file: 'e2e/profile.spec.js', line: 1, col: 0 },
        discoveryStatus: 'resolved' as const,
      },
    ],
    unresolved: [],
    parseErrors: [],
    inventoryComplete: true,
    runnerSummaries: [],
  } as never;
}

describe('Phase 2 effect references', () => {
  it('blocks an endpoint effect on a resource outside the graph', () => {
    const policy: BehaviorPolicy = BehaviorPolicySchema.parse({
      schemaVersion: 1,
      endpoints: [{ resourceId: PROFILE_ID, effects: [effect('tenant.missing')], cases: [httpCase('owner-update')] }],
      resources: [],
    });
    const result = compileBehaviorPolicy({ graph: graphOf([endpoint(PROFILE_ID, 'profile'), table(TABLE_ID, 'accounts')]), policy });
    expect(result.blocking.some((entry) => entry.cause === 'BEHAVIOR_REFERENCE_STALE')).toBe(true);
    expect(result.obligations.some((item) => item.resourceId === PROFILE_ID)).toBe(false);
  });

  it('blocks a domain effect on a resource outside the graph', () => {
    const policy: BehaviorPolicy = BehaviorPolicySchema.parse({
      schemaVersion: 1,
      endpoints: [],
      resources: [{ resourceId: TABLE_ID, effects: [effect('tenant.missing')], cases: [httpCase('owner-update')] }],
    });
    const result = compileBehaviorPolicy({ graph: graphOf([table(TABLE_ID, 'accounts')]), policy });
    expect(result.blocking.some((entry) => entry.cause === 'BEHAVIOR_REFERENCE_STALE')).toBe(true);
    expect(result.obligations).toHaveLength(0);
  });
});

describe('Phase 2 required-case mapping', () => {
  function compiled() {
    const policy: BehaviorPolicy = BehaviorPolicySchema.parse({
      schemaVersion: 1,
      endpoints: [
        {
          resourceId: PROFILE_ID,
          effects: [effect(TABLE_ID)],
          cases: [httpCase('owner-update'), httpCase('owner-reject')],
        },
      ],
      resources: [],
    });
    return compileBehaviorPolicy({ graph: graphOf([endpoint(PROFILE_ID, 'profile'), table(TABLE_ID, 'accounts')]), policy });
  }

  it('emits BEHAVIOR_CASE_UNMAPPED for every required case with no sidecar mapping', () => {
    const { catalog } = compiled();
    const resolved = resolveTestMappings({
      catalog: catalogOf(`${PROFILE_ID}:http:effect-verified`, 'profile-key'),
      nativeClaims: [],
      sidecar: { schemaVersion: 1, tests: [] },
      obligationIds: [`${PROFILE_ID}:http:effect-verified`],
      behaviorCatalog: catalog,
    });
    const unmapped = resolved.problems.filter((problem) => problem.cause === 'BEHAVIOR_CASE_UNMAPPED');
    expect(unmapped).toHaveLength(2);
  });

  it('a sidecar entry mapping one of two cases leaves exactly one UNMAPPED', () => {
    const { catalog } = compiled();
    const required = catalog.requirements[`${PROFILE_ID}:http:effect-verified`] ?? [];
    expect(required).toHaveLength(2);
    const resolved = resolveTestMappings({
      catalog: catalogOf(`${PROFILE_ID}:http:effect-verified`, 'profile-key'),
      nativeClaims: [],
      sidecar: {
        schemaVersion: 1,
        tests: [
          {
            key: 'profile-key',
            selector: { runner: 'playwright', file: 'e2e/profile.spec.js', titlePath: ['profile updates account'] },
            claims: [`${PROFILE_ID}:http:effect-verified`],
            caseIds: [required[0] as string],
            reason: 'covers the happy path only for now',
          },
        ],
      },
      obligationIds: [`${PROFILE_ID}:http:effect-verified`],
      behaviorCatalog: catalog,
    });
    const unmapped = resolved.problems.filter((problem) => problem.cause === 'BEHAVIOR_CASE_UNMAPPED');
    expect(unmapped).toHaveLength(1);
  });

  it('native annotations never satisfy required cases', () => {
    const { catalog } = compiled();
    const resolved = resolveTestMappings({
      catalog: catalogOf(`${PROFILE_ID}:http:effect-verified`, 'profile-key'),
      nativeClaims: [
        {
          schemaVersion: 1,
          testId: 'profile-key',
          testFile: 'e2e/profile.spec.js',
          obligationId: `${PROFILE_ID}:http:effect-verified`,
          location: { file: 'e2e/profile.spec.js', line: 1, col: 0 },
        },
      ],
      sidecar: { schemaVersion: 1, tests: [] },
      obligationIds: [`${PROFILE_ID}:http:effect-verified`],
      behaviorCatalog: catalog,
    });
    expect(resolved.problems.filter((problem) => problem.cause === 'BEHAVIOR_CASE_UNMAPPED')).toHaveLength(2);
  });

  it('duplicate caseIds in a sidecar entry fail closed', () => {
    const parsed = TestMapEntrySchema.safeParse({
      key: 'profile-key',
      selector: { runner: 'playwright', file: 'e2e/profile.spec.js', titlePath: ['t'] },
      claims: [`${PROFILE_ID}:http:effect-verified`],
      caseIds: ['case-a', 'case-a'],
      reason: 'duplicate case declaration for tests',
    });
    expect(parsed.success).toBe(false);
  });
});
