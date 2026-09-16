/**
 * Master-plane admin tables end-to-end (the recorded consumer gap,
 * 2026-09-15): an ERP consumer keeps control-plane models on a second
 * `declarative_base()` tree mapped to the `master` plane, and those
 * tables were invisible to the obligation registry — every one of them
 * dropped at delete-semantics resolution (the tree never declared
 * `__gateforge_delete_semantics__`), classification nulled, blocking
 * `unclassified` rows, ZERO obligations.
 *
 * These tests pin the compile path the repair relies on:
 * - POSITIVE (hard): a master-plane user-facing table with identity +
 *   hard-delete declaration + reviewed adapter classifies user-facing
 *   and generates `master.<t>:persistence:<op>` obligations — the same
 *   registry surface tenant tables get (no tenant-only gating exists).
 * - POSITIVE (archive): archive declaration + archived state binds
 *   `deleteSemantics: 'archive'` with the owner-owned archive fields.
 * - NEGATIVE (the recorded gap): the same real table WITHOUT delete
 *   declarations stays `unclassified` (DELETE_SEMANTICS_UNRESOLVED),
 *   produces zero obligations, and blocks by name.
 * - NEGATIVE (internal intent does not rescue the tree): an
 *   internalRule-matched table without declarations still fail-closes
 *   (the conservative exposure is kept but delete semantics stay
 *   unresolved) — visibility comes from the owner's declaration.
 */
import { describe, expect, it } from 'vitest';
import {
  buildResourceGraph,
  classifierBlocking,
  evaluatePolicies,
  runClassification,
  type ClassificationSignal,
  type DetectorOutput,
  type PolicyFile,
  type Resource,
} from '../src/index.js';

const ADMIN_LOC = { file: 'backend/admin_platform/models/platform_user.py', line: 14, col: 0 };

/** Builds a master-plane admin table resource (consumer shape). */
function adminTable(overrides: Partial<Resource> = {}): Resource {
  return {
    schemaVersion: 1,
    id: 'platform_users',
    kind: 'sqlalchemy.table',
    source: ADMIN_LOC.file,
    location: ADMIN_LOC,
    detectorVersion: '0.1.0',
    attributes: {
      resourceName: 'platform_users',
      plane: 'master',
      primaryKeyColumns: ['id'],
      updateableFields: ['email', 'full_name'],
    },
    ...overrides,
  };
}

function detectorOutput(resources: Resource[]): DetectorOutput {
  return {
    detectorId: 'gateforge.pack-sqlalchemy',
    detectorVersion: '0.1.0',
    resources,
    unresolved: [],
    findings: [],
    classificationSignals: [],
  };
}

/** One declaration-style signal targeted at the admin table. */
function signal(dimension: string, assertion: unknown, table = 'platform_users'): ClassificationSignal {
  return {
    schemaVersion: 1,
    target: { resourceName: table },
    dimension,
    assertion,
    basis: 'declaration',
    source: 'gateforge.declaration:delete-semantics',
    location: ADMIN_LOC,
    detector: { id: 'gateforge.pack-sqlalchemy', version: '0.1.0' },
  } as ClassificationSignal;
}

const IDENTITY = signal('identity', ['id']);

/** The consumer-shaped policy: persistence contracts over user-facing tables. */
const PERSISTENCE_POLICY: PolicyFile = {
  schemaVersion: 1,
  policies: [
    {
      id: 'user-facing-persistence',
      when: { kind: 'sqlalchemy.table', exposure: 'user-facing' },
      require: ['persistence:create', 'persistence:read', 'persistence:update', 'persistence:delete'],
    },
  ],
};

/** Classifies the admin tree with the given signals (attributes.plane channel). */
function classify(
  resources: Resource[],
  signals: ClassificationSignal[],
  internalRules: Array<{ match: { resourceName: string }; reason: string }> = [],
  adapters: readonly string[] = ['master.platform_users'],
) {
  return runClassification({
    graph: buildResourceGraph({ detectors: [detectorOutput(resources)] }),
    signals,
    authority: [],
    policy: {
      schemaVersion: 1,
      scanRoots: ['backend/**'],
      trustedInternalEntryPoints: [],
      internalRules,
      coverage: [
        { capability: 'models.sqlalchemy', detector: 'gateforge.pack-sqlalchemy', appliesTo: ['backend/**'] },
        { capability: 'exposure.http', exhaustive: true, detector: 'gateforge.pack-sqlalchemy', appliesTo: ['backend/**'] },
      ],
      declarations: { deleteSemantics: 'gateforge.declaration:delete-semantics', archiveState: 'gateforge.declaration:archive-state' },
      volatileFields: [],
    },
    adapters,
    scan: {
      requestedPaths: [ADMIN_LOC.file],
      scannedPaths: [ADMIN_LOC.file],
      coverage: [{ detector: 'gateforge.pack-sqlalchemy', scannedPaths: [ADMIN_LOC.file] }],
      configuredDetectors: 1,
      successfulDetectors: 1,
    },
  });
}

describe('master-plane admin tables → obligation registry', () => {
  it('a hard-delete declaration generates master.* persistence obligations', () => {
    const bound = classify([adminTable()], [IDENTITY, signal('delete-semantics', 'hard')]);
    const entry = bound.graph.resources.find((resource) => resource.name === 'platform_users');
    expect(entry?.classification).not.toBeNull();
    expect(entry?.classification?.exposure).toBe('user-facing');
    expect(entry?.classification?.plane).toBe('master');
    expect(entry?.classification?.lifecycle.deleteSemantics).toBe('hard');

    const result = evaluatePolicies({ graph: bound.graph, policies: PERSISTENCE_POLICY });
    expect(result.blocking).toEqual([]);
    expect(result.obligations.map((obligation) => obligation.id).sort()).toEqual([
      'master.platform_users:persistence:create',
      'master.platform_users:persistence:delete',
      'master.platform_users:persistence:read',
      'master.platform_users:persistence:update',
    ]);
  });

  it('an archive declaration binds the owner-owned archived state', () => {
    const bound = classify([adminTable()], [
      IDENTITY,
      signal('delete-semantics', 'archive'),
      signal('archive-state', { status: 'archived' }),
    ]);
    const entry = bound.graph.resources.find((resource) => resource.name === 'platform_users');
    expect(entry?.classification?.lifecycle.deleteSemantics).toBe('archive');
    expect(entry?.classification?.lifecycle.archiveFields).toEqual({ status: 'archived' });
    const result = evaluatePolicies({ graph: bound.graph, policies: PERSISTENCE_POLICY });
    expect(result.obligations).toHaveLength(4);
    expect(result.obligations[0]?.lifecycle.deleteSemantics).toBe('archive');
  });

  it('without declarations the table stays unclassified with zero obligations (the recorded gap)', () => {
    const bound = classify([adminTable()], [IDENTITY]);
    const entry = bound.graph.resources.find((resource) => resource.name === 'platform_users');
    expect(entry?.classification).toBeNull();

    const blocks = classifierBlocking(bound.classification, bound.graph);
    expect(blocks.some((block) => block.detail.includes('DELETE_SEMANTICS_UNRESOLVED'))).toBe(true);

    const result = evaluatePolicies({ graph: bound.graph, policies: PERSISTENCE_POLICY });
    expect(result.obligations).toEqual([]);
    expect(
      result.blocking.some((row) => row.kind === 'unclassified' && row.resourceId === 'master.platform_users'),
    ).toBe(true);
  });

  it('internal intent does not rescue an undeclared tree (still fail-closed)', () => {
    const bound = classify(
      [adminTable()],
      [IDENTITY],
      [{ match: { resourceName: 'platform_users' }, reason: 'control-plane internal' }],
    );
    const entry = bound.graph.resources.find((resource) => resource.name === 'platform_users');
    // The conservative exposure is kept, but the delete semantics stay
    // unresolved → classification null → no obligations, blocks visible.
    expect(entry?.classification).toBeNull();
    const blocks = classifierBlocking(bound.classification, bound.graph).map((block) => block.detail);
    expect(blocks.some((detail) => detail.includes('INCOMPLETE_PROOF_SCOPE'))).toBe(true);
    expect(blocks.some((detail) => detail.includes('DELETE_SEMANTICS_UNRESOLVED'))).toBe(true);
    const result = evaluatePolicies({ graph: bound.graph, policies: PERSISTENCE_POLICY });
    expect(result.obligations).toEqual([]);
  });

  it('a same-named twin in another plane never inherits a symbol-scoped declaration', () => {
    // The consumer leak (found 2026-09-15): tenant backend/models/
    // agent_execution.py declares hard delete for
    // `agent_capability_execution_runs`; the signal targeted the BARE
    // name, so the master-plane twin inherited the tenant declaration.
    // Symbol-scoped emission + binding pin declarations to their class.
    const tenantTwin = adminTable({
      attributes: {
        resourceName: 'agent_capability_execution_runs',
        plane: 'tenant',
        primaryKeyColumns: ['id'],
        classQname: 'models.agent_execution.AgentCapabilityExecutionRun',
      },
      source: 'backend/models/agent_execution.py',
      location: { file: 'backend/models/agent_execution.py', line: 16, col: 0 },
    });
    const masterTwin = adminTable({
      attributes: {
        resourceName: 'agent_capability_execution_runs',
        plane: 'master',
        classQname: 'admin_platform.models.agent_execution.AdminAgentCapabilityExecutionRun',
      },
      source: 'backend/admin_platform/models/agent_execution.py',
      location: { file: 'backend/admin_platform/models/agent_execution.py', line: 15, col: 0 },
    });
    const tenantSymbol = 'models.agent_execution.AgentCapabilityExecutionRun';
    const tenantDeclaration = {
      ...signal('delete-semantics', 'hard', 'agent_capability_execution_runs'),
      target: { resourceName: 'agent_capability_execution_runs', symbol: tenantSymbol },
      location: { file: 'backend/models/agent_execution.py', line: 18, col: 0 },
    } as ClassificationSignal;
    const identity = {
      ...signal('identity', ['id'], 'agent_capability_execution_runs'),
      target: { resourceName: 'agent_capability_execution_runs', symbol: tenantSymbol },
    } as ClassificationSignal;
    // The master twin's OWN identity (its own class, its own columns):
    const masterIdentity = {
      ...signal('identity', ['uuid'], 'agent_capability_execution_runs'),
      target: {
        resourceName: 'agent_capability_execution_runs',
        symbol: 'admin_platform.models.agent_execution.AdminAgentCapabilityExecutionRun',
      },
      location: { file: 'backend/admin_platform/models/agent_execution.py', line: 16, col: 0 },
    } as ClassificationSignal;

    const bound = classify(
      [tenantTwin, masterTwin],
      [identity, masterIdentity, tenantDeclaration],
      [],
      ['master.platform_users', 'tenant.agent_capability_execution_runs'],
    );
    const tenantEntry = bound.graph.resources.find(
      (resource) => resource.id === 'tenant.agent_capability_execution_runs',
    );
    const masterEntry = bound.graph.resources.find(
      (resource) => resource.id === 'master.agent_capability_execution_runs',
    );
    // The declaring tree binds its own declaration (delete semantics
    // resolved hard; the tenant twin also needs an adapter in real
    // runs, which this fixture does not provide).
    expect(tenantEntry?.classification?.lifecycle.deleteSemantics).toBe('hard');
    // The twin did NOT inherit the declaration: no delete semantics →
    // its classification fail-closes (unclassified) instead of gaining
    // obligations from borrowed evidence.
    expect(masterEntry?.classification).toBeNull();
    const blocks = classifierBlocking(bound.classification, bound.graph);
    expect(
      blocks.some(
        (block) =>
          block.detail.includes('DELETE_SEMANTICS_UNRESOLVED') &&
          block.resourceId === 'master.agent_capability_execution_runs',
      ),
    ).toBe(true);
  });
});
