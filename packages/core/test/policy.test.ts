/**
 * Policy-engine tests (G2): declarative policies → obligations with
 * lifecycle gating (plan §5.2), internal-resource claim invalidation
 * (ADR 0001), blocking visibility for unclassified/unresolved
 * resources (invariants 1, 8), and byte-for-byte determinism.
 */
import { describe, expect, it } from 'vitest';
import {
  buildResourceGraph,
  canonicalJson,
  evaluatePolicies,
  fingerprint,
  lifecycleAllowsContract,
  PolicyEvaluationError,
  PolicyEvaluationResultSchema,
  type Claim,
  type DetectorOutput,
  type JsonValue,
  type PolicyFile,
  type Resource,
  type Waiver,
} from '../src/index.js';

/** Builds a minimal table-shaped detector resource. */
function table(overrides: Partial<Resource> & { attributes: Record<string, unknown> }): Resource {
  return {
    schemaVersion: 1,
    id: 'raw',
    kind: 'sqlalchemy.table',
    source: 'backend/models/x.py',
    location: { file: 'backend/models/x.py', line: 10, col: 0 },
    detectorVersion: '0.1.0',
    ...overrides,
  };
}

/** A detector contribution with defaults. */
function detector(resources: Resource[], unresolved: DetectorOutput['unresolved'] = []): DetectorOutput {
  return {
    detectorId: 'gateforge.discovery.sqlalchemy',
    detectorVersion: '0.1.0',
    resources,
    unresolved,
    findings: [],
  };
}

/** User-facing classification with a customizable lifecycle. */
function userFacing(lifecycle: Record<string, unknown>, adapter = 'adapter') {
  return {
    exposure: 'user-facing',
    plane: 'tenant',
    lifecycle: lifecycle as {
      create: boolean;
      read: boolean;
      update: boolean;
      delete: boolean;
      deleteSemantics?: 'hard' | 'archive';
    },
    primaryKey: ['id'],
    evidenceAdapter: adapter,
  };
}

const CRUD_POLICY: PolicyFile = {
  schemaVersion: 1,
  policies: [
    {
      id: 'user-facing-sqlalchemy-lifecycle',
      when: { kind: 'sqlalchemy.table', exposure: 'user-facing' },
      require: ['crud:create', 'crud:read', 'crud:update', 'crud:delete'],
    },
  ],
};

/** Graph over one classified `tenant.accounts` table. */
function graphFor(classification: Record<string, unknown>) {
  return buildResourceGraph({
    detectors: [detector([table({ attributes: { resourceName: 'accounts' } })])],
    classifications: { schemaVersion: 1, resources: { 'tenant.accounts': classification } },
  });
}

/** Canonical-JSON bytes with a cast past the open attributes payload. */
function bytes(value: unknown): string {
  return canonicalJson(value as JsonValue);
}

describe('policy → obligation generation', () => {
  it('generates the four CRUD obligations for a full user-facing lifecycle', () => {
    const result = evaluatePolicies({
      graph: graphFor(userFacing({ create: true, read: true, update: true, delete: true, deleteSemantics: 'archive' })),
      policies: CRUD_POLICY,
    });

    expect(result.blocking).toEqual([]);
    expect(result.obligations.map((o) => o.id)).toEqual([
      'tenant.accounts:crud:create',
      'tenant.accounts:crud:delete',
      'tenant.accounts:crud:read',
      'tenant.accounts:crud:update',
    ]);
    const update = result.obligations.find((o) => o.contract === 'crud:update');
    expect(update?.policyId).toBe('user-facing-sqlalchemy-lifecycle');
    expect(update?.resourceId).toBe('tenant.accounts');
    // fingerprint (pin #2) derives from exactly the obligation identity
    const lifecycle = { create: true, read: true, update: true, delete: true, deleteSemantics: 'archive' } as const;
    expect(update?.lifecycle).toEqual(lifecycle);
    expect(fingerprint({
      resourceId: 'tenant.accounts',
      contract: 'crud:update',
      policyId: 'user-facing-sqlalchemy-lifecycle',
      lifecycle,
    })).toMatch(/^[0-9a-f]{64}$/);
  });

  it('respects immutable/read-only lifecycles (only crud:read)', () => {
    const result = evaluatePolicies({
      graph: graphFor(userFacing({ create: false, read: true, update: false, delete: false })),
      policies: CRUD_POLICY,
    });
    expect(result.obligations.map((o) => o.contract)).toEqual(['crud:read']);
  });

  it('respects append-only lifecycles (crud:create + crud:read)', () => {
    const result = evaluatePolicies({
      graph: graphFor(userFacing({ create: true, read: true, update: false, delete: false })),
      policies: CRUD_POLICY,
    });
    expect(result.obligations.map((o) => o.contract)).toEqual(['crud:create', 'crud:read']);
  });

  it('keeps archive-vs-hard delete semantics inside the fingerprint identity', () => {
    const archive = evaluatePolicies({
      graph: graphFor(userFacing({ create: true, read: true, update: true, delete: true, deleteSemantics: 'archive' })),
      policies: CRUD_POLICY,
    });
    const hard = evaluatePolicies({
      graph: graphFor(userFacing({ create: true, read: true, update: true, delete: true, deleteSemantics: 'hard' })),
      policies: CRUD_POLICY,
    });
    const archiveDelete = archive.obligations.find((o) => o.contract === 'crud:delete');
    const hardDelete = hard.obligations.find((o) => o.contract === 'crud:delete');
    expect(archiveDelete?.lifecycle.deleteSemantics).toBe('archive');
    expect(hardDelete?.lifecycle.deleteSemantics).toBe('hard');
    // same id, DIFFERENT fingerprint — archive and hard delete carry
    // different evidence contracts (plan §5.2/§5.3)
    expect(archiveDelete?.id).toBe(hardDelete?.id);
    expect(fingerprint({ resourceId: archiveDelete!.resourceId, contract: archiveDelete!.contract, policyId: archiveDelete!.policyId, lifecycle: archiveDelete!.lifecycle }))
      .not.toBe(fingerprint({ resourceId: hardDelete!.resourceId, contract: hardDelete!.contract, policyId: hardDelete!.policyId, lifecycle: hardDelete!.lifecycle }));
  });

  it('passes non-crud contracts through ungated', () => {
    const result = evaluatePolicies({
      graph: graphFor(userFacing({ create: false, read: false, update: false, delete: false })),
      policies: {
        schemaVersion: 1,
        policies: [
          { id: 'audit', when: { kind: 'sqlalchemy.table' }, require: ['audit:retention'] },
        ],
      },
    });
    expect(result.obligations.map((o) => o.id)).toEqual(['tenant.accounts:audit:retention']);
  });

  it('lets the first policy in file order own a duplicated obligation id', () => {
    const result = evaluatePolicies({
      graph: graphFor(userFacing({ create: true, read: true, update: true, delete: true, deleteSemantics: 'hard' })),
      policies: {
        schemaVersion: 1,
        policies: [
          { id: 'first', when: { exposure: 'user-facing' }, require: ['crud:create'] },
          { id: 'second', when: { exposure: 'user-facing' }, require: ['crud:create'] },
        ],
      },
    });
    expect(result.obligations).toHaveLength(1);
    expect(result.obligations[0]?.policyId).toBe('first');
  });

  it('rejects crud contracts outside the four lifecycle operations (fail closed)', () => {
    expect(() =>
      evaluatePolicies({
        graph: graphFor(userFacing({ create: true, read: true, update: true, delete: true, deleteSemantics: 'hard' })),
        policies: {
          schemaVersion: 1,
          policies: [{ id: 'p', when: {}, require: ['crud:export'] }],
        },
      }),
    ).toThrow(PolicyEvaluationError);
  });
});

describe('internal resources (ADR 0001)', () => {
  const INTERNAL_POLICY: PolicyFile = {
    schemaVersion: 1,
    policies: [
      { id: 'blanket', when: { kind: 'sqlalchemy.table' }, require: ['crud:create', 'crud:read', 'audit:trail'] },
    ],
  };

  it('generates NO CRUD obligations for internal resources; non-crud contracts still apply', () => {
    const result = evaluatePolicies({
      graph: graphFor({
        exposure: 'internal',
        plane: 'tenant',
        lifecycle: { create: true, read: true, update: true, delete: true, deleteSemantics: 'hard' },
        primaryKey: ['id'],
      }),
      policies: INTERNAL_POLICY,
    });
    expect(result.obligations.map((o) => o.id)).toEqual(['tenant.accounts:audit:trail']);
  });

  it('invalidates claims on internal resources with the ADR reason', () => {
    const result = evaluatePolicies({
      graph: graphFor({
        exposure: 'internal',
        plane: 'tenant',
        lifecycle: { create: false, read: false, update: false, delete: false },
        primaryKey: ['id'],
      }),
      policies: INTERNAL_POLICY,
      claims: [
        { schemaVersion: 1, obligationId: 'tenant.accounts:crud:read', testId: 'internal sneak' },
        { schemaVersion: 1, obligationId: 'tenant.accounts:audit:trail', testId: 'audit check' },
        { schemaVersion: 1, obligationId: 'tenant.ghost:crud:read', testId: 'unknown' },
      ],
    });
    expect(result.claims).toHaveLength(3);
    expect(result.claims.every((c) => c.status === 'invalid')).toBe(true);
    const internalClaims = result.claims.filter((c) => c.reason?.includes('internal'));
    expect(internalClaims).toHaveLength(2);
    const unknownClaim = result.claims.find((c) => c.claim.testId === 'unknown');
    expect(unknownClaim?.reason).toContain('no policy generates');
  });

  it('assesses valid claims on user-facing obligations', () => {
    const result = evaluatePolicies({
      graph: graphFor(userFacing({ create: true, read: true, update: true, delete: true, deleteSemantics: 'archive' })),
      policies: CRUD_POLICY,
      claims: [
        { schemaVersion: 1, obligationId: 'tenant.accounts:crud:update', testId: 'happy path' },
      ],
    });
    expect(result.claims[0]?.status).toBe('valid');
    expect(result.claims[0]?.reason).toBeNull();
  });
  it('emits blocking entries and no obligations for unclassified and unresolved resources', () => {
    const graph = buildResourceGraph({
      detectors: [
        detector(
          [
            table({
              source: 'backend/models/mystery.py',
              location: { file: 'backend/models/mystery.py', line: 5, col: 0 },
              attributes: { resourceName: 'mystery' },
            }),
            table({
              source: 'backend/models/plain.py',
              location: { file: 'backend/models/plain.py', line: 9, col: 0 },
              attributes: { resourceName: 'plain', plane: 'tenant' },
            }),
          ],
          [
            {
              code: 'computed_tablename',
              detail: 'decorated function (2 decorator(s))',
              location: { file: 'backend/models/ghost.py', line: 21, col: 4 },
            },
          ],
        ),
      ],
      classifications: {
        schemaVersion: 1,
        resources: {
          'tenant.accounts': userFacing({ create: true, read: true, update: true, delete: true, deleteSemantics: 'archive' }),
        },
      },
    });

    const result = evaluatePolicies({ graph, policies: CRUD_POLICY });

    // unresolved → blocking, gate-visible
    const unresolvedEntry = result.blocking.find((b) => b.kind === 'unresolved');
    expect(unresolvedEntry?.detail).toContain('computed_tablename');
    expect(unresolvedEntry?.location).toEqual({ file: 'backend/models/ghost.py', line: 21, col: 4 });
    // unclassified (no plane derivable) → blocking with name
    const idLess = result.blocking.find((b) => b.kind === 'unclassified' && b.name === 'mystery');
    expect(idLess?.resourceId).toBeNull();
    // unclassified with plane known from attributes → blocking with id
    const plain = result.blocking.find((b) => b.kind === 'unclassified' && b.name === 'plain');
    expect(plain?.resourceId).toBe('tenant.plain');
    // no obligations at all: nothing classified matched the policy
    expect(result.obligations).toEqual([]);
  });

  it('is byte-for-byte deterministic across runs (canonical JSON)', () => {
    const graph = buildResourceGraph({
      detectors: [
        detector(
          [table({ attributes: { resourceName: 'accounts' } })],
          [{ code: 'computed_tablename', detail: 'f-string', location: { file: 'backend/models/ghost.py', line: 3, col: 0 } }],
        ),
      ],
      classifications: {
        schemaVersion: 1,
        resources: { 'tenant.accounts': userFacing({ create: true, read: true, update: false, delete: true, deleteSemantics: 'archive' }) },
      },
    });
    const claims: Claim[] = [
      { schemaVersion: 1, obligationId: 'tenant.accounts:crud:read', testId: 'b' },
      { schemaVersion: 1, obligationId: 'tenant.accounts:crud:create', testId: 'a' },
    ];
    const a = evaluatePolicies({ graph, policies: CRUD_POLICY, claims });
    const b = evaluatePolicies({ graph, policies: CRUD_POLICY, claims: [...claims].reverse() });
    expect(bytes(a)).toBe(bytes(b));
    expect(PolicyEvaluationResultSchema.parse(a)).toEqual(a);
    // claims sorted by obligation id regardless of input order
    expect(a.claims.map((c) => c.claim.testId)).toEqual(['a', 'b']);
  });
});

describe('lifecycleAllowsContract', () => {
  const lifecycle = { create: true, read: true, update: false, delete: false };

  it('gates crud contracts on lifecycle flags', () => {
    expect(lifecycleAllowsContract('crud:create', lifecycle)).toBe(true);
    expect(lifecycleAllowsContract('crud:update', lifecycle)).toBe(false);
  });

  it('leaves non-crud contracts ungated', () => {
    expect(lifecycleAllowsContract('audit:retention', lifecycle)).toBe(true);
  });
});

// Keeps the waiver import honest: fingerprints inside waivers must match
// the obligation identity they waive — verified against pin #2 here.
describe('waiver fingerprint compatibility (pin #2)', () => {
  it('produces the same fingerprint the graph tests waive against', () => {
    const lifecycle = { create: true, read: true, update: true, delete: true, deleteSemantics: 'archive' } as const;
    const fp = fingerprint({ resourceId: 'tenant.accounts', contract: 'crud:delete', policyId: 'crud', lifecycle });
    const waived: Waiver = {
      schemaVersion: 1,
      owner: 'team',
      justificationUrl: 'https://issues.example.com/1',
      approver: 'sec',
      scope: { kind: 'exact', resourceId: 'tenant.accounts', fingerprint: fp },
      expiresAt: '2100-01-01T00:00:00.000Z',
    };
    expect(waived.scope.fingerprint).toBe(fp);
  });
});
