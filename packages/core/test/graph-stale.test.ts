/**
 * Stale-reference tests (G2, GF-06 + invariant 9): removed/renamed
 * resources must surface as typed `stale` entries across
 * classifications, claims, adapter files, and waivers — never silent
 * disappearance. Sorted output order is by (kind, reference):
 * adapter < claim < classification < waiver.
 */
import { describe, expect, it } from 'vitest';
import { buildResourceGraph, fingerprint, type DetectorOutput, type Resource, type Waiver } from '../src/index.js';

/** A validated table resource named `accounts`. */
function accountsResource(): Resource {
  return {
    schemaVersion: 1,
    id: 'sqlalchemy:table:backend/models/account.py:Account',
    kind: 'sqlalchemy.table',
    source: 'backend/models/account.py',
    location: { file: 'backend/models/account.py', line: 17, col: 0 },
    detectorVersion: '0.1.0',
    attributes: { resourceName: 'accounts', classQname: 'Account' },
  };
}

/** A detector contribution with defaults. */
function detector(resources: Resource[]): DetectorOutput {
  return {
    detectorId: 'gateforge.discovery.sqlalchemy',
    detectorVersion: '0.1.0',
    resources,
    unresolved: [],
    findings: [],
  };
}

const ACCOUNTS_LIFECYCLE = {
  create: true,
  read: true,
  update: true,
  delete: true,
  deleteSemantics: 'archive',
} as const;

const CLASSIFICATIONS = {
  schemaVersion: 1,
  resources: {
    'tenant.accounts': {
      exposure: 'user-facing',
      plane: 'tenant',
      lifecycle: ACCOUNTS_LIFECYCLE,
      primaryKey: ['id'],
      evidenceAdapter: 'tenant.accounts',
    },
  },
};

const CLAIM = {
  schemaVersion: 1,
  obligationId: 'tenant.accounts:crud:update',
  testId: 'admin changes an account name',
  testFile: 'e2e/accounts.spec.ts',
};

const WAIVER: Waiver = {
  schemaVersion: 1,
  owner: 'team-accounts (J. Doe)',
  justificationUrl: 'https://issues.example.com/1234',
  approver: 'reviewer-sec',
  scope: {
    kind: 'exact',
    resourceId: 'tenant.accounts',
    fingerprint: fingerprint({
      resourceId: 'tenant.accounts',
      contract: 'crud:delete',
      policyId: 'crud',
      lifecycle: ACCOUNTS_LIFECYCLE,
    }),
  },
  expiresAt: '2100-01-01T00:00:00.000Z',
};

describe('stale-reference validation (GF-06)', () => {
  it('reports nothing stale while every reference binds', () => {
    const graph = buildResourceGraph({
      detectors: [detector([accountsResource()])],
      classifications: CLASSIFICATIONS,
      claims: [CLAIM],
      adapters: ['tenant.accounts.mjs'],
      waivers: [WAIVER],
    });
    expect(graph.stale).toEqual([]);
  });

  it('surfaces all four artifact kinds as stale after the resource is removed', () => {
    // The declaration is gone; every artifact that pointed at it stays.
    const graph = buildResourceGraph({
      detectors: [detector([])],
      classifications: CLASSIFICATIONS,
      claims: [CLAIM],
      adapters: ['.gateforge/adapters/tenant.accounts.mjs'],
      waivers: [WAIVER],
    });

    expect(graph.resources).toEqual([]);
    expect(graph.stale.map((s) => `${s.kind}:${s.reference}`)).toEqual([
      'adapter:tenant.accounts',
      'claim:tenant.accounts:crud:update',
      'classification:tenant.accounts',
      'waiver:tenant.accounts',
    ]);
    expect(graph.stale.every((s) => s.detail.length > 0)).toBe(true);
  });

  it('flags a claim as stale when the resource is RENAMED (plane change)', () => {
    const renamed = accountsResource();
    renamed.attributes = { ...renamed.attributes, resourceName: 'tenants' };
    const graph = buildResourceGraph({
      detectors: [detector([renamed])],
      classifications: CLASSIFICATIONS,
      claims: [CLAIM], // still points at tenant.accounts
      waivers: [WAIVER],
    });
    expect(graph.stale.map((s) => `${s.kind}:${s.reference}`)).toEqual([
      'claim:tenant.accounts:crud:update',
      'classification:tenant.accounts',
      'waiver:tenant.accounts',
    ]);
  });

  it('keeps references non-stale while the resource is merely malformed or path-invalid', () => {
    const broken = accountsResource();
    broken.source = '../outside/models.py'; // path-invalid, but declared
    const graph = buildResourceGraph({
      detectors: [detector([broken])],
      classifications: CLASSIFICATIONS,
      claims: [CLAIM],
      adapters: ['tenant.accounts'],
    });
    expect(graph.resources).toEqual([]);
    expect(graph.findings.some((f) => f.code === 'NON_REPO_RELATIVE_PATH')).toBe(true);
    expect(graph.stale).toEqual([]);
  });

  it('reports schema-invalid watched claims/waivers as findings, not stale', () => {
    const graph = buildResourceGraph({
      detectors: [detector([])],
      claims: [{ nope: true }],
      waivers: [{ alsoNope: true }],
    });
    expect(graph.stale).toEqual([]);
    expect(graph.findings.map((f) => f.code).sort()).toEqual(['INVALID_CLAIM', 'INVALID_WAIVER']);
  });
});
