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
  runClassification,
  type Claim,
  type Classification,
  type ClassificationSignal,
  type DetectorOutput,
  type JsonValue,
  type PolicyFile,
  type Resource,
  type ResourceGraph,
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
function detector(
  resources: Resource[],
  unresolved: DetectorOutput['unresolved'] = [],
  findings: DetectorOutput['findings'] = [],
): DetectorOutput {
  return {
    detectorId: 'gateforge.discovery.sqlalchemy',
    detectorVersion: '0.1.0',
    resources,
    unresolved,
    findings,
    classificationSignals: [],
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
      archiveFields?: Record<string, string | number | boolean>;
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

/** Graph over one automatically classified `tenant.accounts` table. */
function graphFor(classification: Record<string, unknown>) {
  const resource = table({ attributes: { resourceName: 'accounts' } });
  const graph = buildResourceGraph({ detectors: [detector([resource])] });
  const value = classification as Classification;
  const signals = ([
    { dimension: 'plane', assertion: value.plane },
    { dimension: 'identity', assertion: value.primaryKey },
    ...Object.entries(value.lifecycle)
      .filter(([key]) => ['create', 'read', 'update', 'delete'].includes(key))
      .map(([key, assertion]) => ({
        dimension: `lifecycle.${key}`,
        assertion,
        basis: assertion === false ? 'code-negative-closed-world' : 'declaration',
      })),
    ...(value.lifecycle.deleteSemantics !== undefined
      ? [{ dimension: 'delete-semantics', assertion: value.lifecycle.deleteSemantics }]
      : []),
    ...(value.lifecycle.archiveFields !== undefined
      ? [{ dimension: 'archive-state', assertion: value.lifecycle.archiveFields }]
      : []),
    { dimension: 'adapter-binding', assertion: value.evidenceAdapter ?? 'adapter' },
    ...(value.exposure === 'internal'
      ? [
          { dimension: 'internality', assertion: true, basis: 'organization-policy' },
          { dimension: 'internality', assertion: { category: 'worker' }, basis: 'code-positive' },
        ]
      : []),
  ].map((signal) => ({
    schemaVersion: 1 as const,
    target: { resourceName: 'accounts' },
    source: 'gateforge:internal',
    location: resource.location,
    detector: { id: 'gateforge.core', version: '1' },
    basis: 'declaration' as const,
    ...signal,
  }))) as ClassificationSignal[];
  // Channel split (ADR 0003 D2): suppressive shapes ride the host-issued
  // authority channel; everything else stays on the detector channel.
  const suppressive = (signal: ClassificationSignal): boolean =>
    (signal.dimension === 'internality' &&
      (signal.basis === 'declaration' || signal.basis === 'organization-policy')) ||
    (signal.dimension.startsWith('lifecycle.') && signal.basis === 'code-negative-closed-world');
  return runClassification({
    graph,
    signals: signals.filter((signal) => !suppressive(signal)),
    authority: signals.filter(suppressive),
    policy: {
      schemaVersion: 1,
      scanRoots: ['backend/**/*.py'],
      trustedInternalEntryPoints: [{ category: 'worker', detector: 'gateforge.core' }],
      internalRules: [],
      coverage: [
        { capability: 'exposure.http', exhaustive: true, detector: 'gateforge.core', appliesTo: ['backend/**'] },
      ],
      declarations: { internality: 'gateforge:internal' },
      volatileFields: [],
    },
    adapters: [value.evidenceAdapter ?? 'adapter'],
    scan: {
      requestedPaths: ['backend/models/x.py'],
      scannedPaths: ['backend/models/x.py'],
      coverage: [
        { detector: 'gateforge.pack-sqlalchemy', scannedPaths: ['backend/models/x.py'] },
        // The fixture's worker-reachability issuer reports the same file.
        { detector: 'gateforge.core', scannedPaths: ['backend/models/x.py'] },
      ],
      configuredDetectors: 1,
      successfulDetectors: 1,
    },
  }).graph;
}

/** Canonical-JSON bytes with a cast past the open attributes payload. */
function bytes(value: unknown): string {
  return canonicalJson(value as JsonValue);
}

/**
 * Graph over one already-classified `http.endpoint` resource with the
 * given detector attributes (the endpoint compiler stamps `capabilities`
 * and `frontendConsumed` there, ADR 0004 D5/D8).
 */
function endpointGraph(attributes: Record<string, unknown>): ResourceGraph {
  return {
    schemaVersion: 1,
    resources: [
      {
        schemaVersion: 1,
        id: 'tenant.http-post-api-accounts-a1b2c3d4',
        name: 'http-post-api-accounts-a1b2c3d4',
        plane: 'tenant',
        kind: 'http.endpoint',
        source: 'backend/api/accounts.py',
        location: { file: 'backend/api/accounts.py', line: 30, col: 0 },
        exposure: 'user-facing',
        classification: {
          exposure: 'user-facing',
          plane: 'tenant',
          lifecycle: {
            create: true,
            read: true,
            update: true,
            delete: true,
            deleteSemantics: 'hard',
          },
          primaryKey: ['method', 'path'],
          evidenceAdapter: 'accounts',
        },
        classificationTrace: null,
        detector: { id: 'gateforge.endpoint-compiler', version: '1' },
        attributes,
      },
    ],
    unresolved: [],
    findings: [],
    stale: [],
  };
}

describe('policy → obligation generation', () => {
  it('generates the four CRUD obligations for a full user-facing lifecycle', () => {
    const result = evaluatePolicies({
      graph: graphFor(userFacing({ create: true, read: true, update: true, delete: true, deleteSemantics: 'archive', archiveFields: { status: 'archived' } })),
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
    const lifecycle = { create: true, read: true, update: true, delete: true, deleteSemantics: 'archive', archiveFields: { status: 'archived' } } as const;
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
      graph: graphFor(userFacing({ create: true, read: true, update: true, delete: true, deleteSemantics: 'archive', archiveFields: { status: 'archived' } })),
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

describe('endpoint capability and consumption matchers (ADR 0004 D8)', () => {
  const WORKFLOW_POLICY: PolicyFile = {
    schemaVersion: 1,
    policies: [
      {
        id: 'workflow-command-endpoints',
        when: { capability: 'workflow-command', consumed: true },
        require: [
          'workflow:transition-allowed',
          'workflow:transition-rejected',
          'workflow:terminal-immutable',
        ],
      },
    ],
  };

  it('matches capability only when attributes.capabilities contains the exact string', () => {
    const consumed = {
      capabilities: ['crud-create', 'workflow-command'],
      frontendConsumed: true,
      linkedResourceName: 'accounts',
    };
    const matched = evaluatePolicies({
      graph: endpointGraph(consumed),
      policies: WORKFLOW_POLICY,
    });
    expect(matched.obligations).toHaveLength(3);
    // The near-miss capability never matches (fail closed).
    const nearMiss = evaluatePolicies({
      graph: endpointGraph({ ...consumed, capabilities: ['workflow-command-ish'] }),
      policies: WORKFLOW_POLICY,
    });
    expect(nearMiss.obligations).toEqual([]);
    // A non-array capabilities attribute never matches either.
    const nonArray = evaluatePolicies({
      graph: endpointGraph({ ...consumed, capabilities: 'workflow-command' }),
      policies: WORKFLOW_POLICY,
    });
    expect(nonArray.obligations).toEqual([]);
    // Resources without a capabilities attribute (tables) never match a
    // capability-scoped policy.
    const tableless = evaluatePolicies({
      graph: graphFor(userFacing({ create: true, read: true, update: true, delete: true, deleteSemantics: 'hard' })),
      policies: WORKFLOW_POLICY,
    });
    expect(tableless.obligations).toEqual([]);
  });

  it('consumed:true excludes unconsumed endpoints and resources without the attribute', () => {
    const attributes = { capabilities: ['workflow-command'] };
    expect(
      evaluatePolicies({ graph: endpointGraph({ ...attributes, frontendConsumed: false }), policies: WORKFLOW_POLICY })
        .obligations,
    ).toEqual([]);
    expect(
      evaluatePolicies({ graph: endpointGraph(attributes), policies: WORKFLOW_POLICY }).obligations,
    ).toEqual([]);
  });

  it('consumed:false matches non-consumed and non-endpoint resources, never consumed ones', () => {
    const policy: PolicyFile = {
      schemaVersion: 1,
      policies: [
        { id: 'not-consumed', when: { consumed: false }, require: ['audit:retention'] },
      ],
    };
    // A table carries no frontendConsumed attribute: it is "not consumed".
    const tableOnly = evaluatePolicies({
      graph: graphFor(userFacing({ create: true, read: true, update: true, delete: true, deleteSemantics: 'hard' })),
      policies: policy,
    });
    expect(tableOnly.obligations.map((o) => o.id)).toEqual(['tenant.accounts:audit:retention']);
    // An unconsumed endpoint matches too...
    const unconsumed = evaluatePolicies({
      graph: endpointGraph({ capabilities: ['workflow-command'], frontendConsumed: false }),
      policies: policy,
    });
    expect(unconsumed.obligations.map((o) => o.resourceId)).toEqual([
      'tenant.http-post-api-accounts-a1b2c3d4',
    ]);
    // ...but a consumed endpoint does not.
    const consumed = evaluatePolicies({
      graph: endpointGraph({ capabilities: ['workflow-command'], frontendConsumed: true }),
      policies: policy,
    });
    expect(consumed.obligations).toEqual([]);
  });

  it('still suppresses crud:/persistence: contracts on endpoint resources', () => {
    const result = evaluatePolicies({
      graph: endpointGraph({ capabilities: ['crud-create'], frontendConsumed: true }),
      policies: {
        schemaVersion: 1,
        policies: [
          {
            id: 'sneaky',
            when: { kind: 'http.endpoint' },
            require: ['crud:create', 'persistence:read', 'http:frontend-request-observed'],
          },
        ],
      },
    });
    // Routes are never conflated with tables: only the non-CRUD http
    // contract generates (ADR 0004 D8 guard, unchanged).
    expect(result.obligations.map((o) => o.id)).toEqual([
      'tenant.http-post-api-accounts-a1b2c3d4:http:frontend-request-observed',
    ]);
  });

  it('generates <id>:workflow:<check> obligations from a capability-scoped policy', () => {
    const result = evaluatePolicies({
      graph: endpointGraph({ capabilities: ['workflow-command'], frontendConsumed: true }),
      policies: WORKFLOW_POLICY,
    });
    expect(result.obligations.map((o) => o.id)).toEqual([
      'tenant.http-post-api-accounts-a1b2c3d4:workflow:terminal-immutable',
      'tenant.http-post-api-accounts-a1b2c3d4:workflow:transition-allowed',
      'tenant.http-post-api-accounts-a1b2c3d4:workflow:transition-rejected',
    ]);
    expect(result.obligations.every((o) => o.policyId === 'workflow-command-endpoints')).toBe(true);
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
      graph: graphFor(userFacing({ create: true, read: true, update: true, delete: true, deleteSemantics: 'archive', archiveFields: { status: 'archived' } })),
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

  it('blocks the gate on detector findings and stale references (fail closed)', () => {
    // Automatic classification has no manual classification reference to
    // preserve as stale; the detector finding remains gate-visible.
    // classification key points at a resource that no longer exists
    // (invariant 9: nothing silently disappears).
    const graph = buildResourceGraph({
      detectors: [
        detector(
          [table({ attributes: { resourceName: 'accounts' } })],
          [],
          [
            {
              code: 'PARSE_ERROR',
              detail: 'failed to read backend/models/broken.py: EACCES',
              locations: [{ file: 'backend/models/broken.py', line: 1, col: 0 }],
            },
          ],
        ),
      ],
    });
    expect(graph.findings.map((f) => f.code)).toContain('PARSE_ERROR');
    expect(graph.stale).toEqual([]);

    const result = evaluatePolicies({ graph, policies: CRUD_POLICY });

    const finding = result.blocking.find((b) => b.kind === 'finding');
    expect(finding?.detail).toContain('PARSE_ERROR');
    expect(finding?.detail).toContain('failed to read backend/models/broken.py');
    // Fail closed: the detector finding still blocks the run.
    expect(result.blocking.length).toBeGreaterThanOrEqual(1);
    // Fail closed: the obligations still generate, but the run blocks.
    expect(result.obligations).toHaveLength(0);
    expect(result.blocking.length).toBeGreaterThanOrEqual(1);
  });

  it('is byte-for-byte deterministic across runs (canonical JSON)', () => {
    const graph = buildResourceGraph({
      detectors: [
        detector(
          [table({ attributes: { resourceName: 'accounts' } })],
          [{ code: 'computed_tablename', detail: 'f-string', location: { file: 'backend/models/ghost.py', line: 3, col: 0 } }],
        ),
      ],
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
    const lifecycle = { create: true, read: true, update: true, delete: true, deleteSemantics: 'archive', archiveFields: { status: 'archived' } } as const;
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
