import { describe, expect, it } from 'vitest';
import {
  BaselineSchema,
  ClassificationFileSchema,
  ClaimSchema,
  EvidenceRecordSchema,
  GATEFORGE_SCHEMA_VERSION,
  ObligationSchema,
  PolicyFileSchema,
  RunManifestSchema,
  VerdictSchema,
  WaiverSchema,
} from '../src/index.js';
import { parse as parseYaml } from 'yaml';

/** Fixed v4 uuid for fixture manifests. */
const RUN_ID = '109156be-c4fb-41ea-b1b4-ef167167e9c9';
/** Fixed 64-hex fixture fingerprint. */
const FP = 'a'.repeat(64);
/** Fixed 64-hex fixture record id. */
const RECORD_ID = 'b'.repeat(64);

describe('schema round-trips', () => {
  it('ClassificationFile: YAML document parses to the typed shape', () => {
    const doc = ClassificationFileSchema.parse(
      parseYaml(`
schemaVersion: 1
resources:
  tenant.accounts:
    exposure: user-facing
    plane: tenant
    primaryKey: [id]
    evidenceAdapter: accounts
    lifecycle:
      create: true
      read: true
      update: true
      delete: true
      deleteSemantics: archive
  master.internal_settings:
    exposure: internal
    plane: master
    primaryKey: [tenant_id, key]
    lifecycle:
      create: false
      read: true
      update: false
      delete: false
`),
    );
    const accounts = doc.resources['tenant.accounts'];
    expect(accounts?.exposure).toBe('user-facing');
    expect(accounts?.lifecycle.deleteSemantics).toBe('archive');
    expect(accounts?.primaryKey).toEqual(['id']);
    const settings = doc.resources['master.internal_settings'];
    expect(settings?.primaryKey).toEqual(['tenant_id', 'key']);
    expect(settings?.evidenceAdapter).toBeUndefined();
  });

  it('PolicyFile: when/require round-trips', () => {
    const doc = PolicyFileSchema.parse(
      parseYaml(`
schemaVersion: 1
policies:
  - id: user-facing-sqlalchemy-lifecycle
    when:
      kind: sqlalchemy.table
      exposure: user-facing
    require: [crud:create, crud:read, crud:update, crud:delete]
`),
    );
    expect(doc.policies[0]?.id).toBe('user-facing-sqlalchemy-lifecycle');
    expect(doc.policies[0]?.when.kind).toBe('sqlalchemy.table');
    expect(doc.policies[0]?.require).toEqual([
      'crud:create',
      'crud:read',
      'crud:update',
      'crud:delete',
    ]);
  });

  it('Obligation: id matches <resourceId>:<contract>', () => {
    const obligation = ObligationSchema.parse({
      schemaVersion: 1,
      id: 'tenant.accounts:crud:update',
      resourceId: 'tenant.accounts',
      contract: 'crud:update',
      policyId: 'user-facing-sqlalchemy-lifecycle',
      lifecycle: {
        create: true,
        read: true,
        update: true,
        delete: true,
        deleteSemantics: 'archive',
      },
    });
    expect(obligation.id).toBe(`${obligation.resourceId}:${obligation.contract}`);
  });

  it('Claim and EvidenceRecord round-trip with bulk scope (pin #11)', () => {
    const claim = ClaimSchema.parse({
      schemaVersion: 1,
      obligationId: 'tenant.accounts:crud:update',
      testId: 'admin changes an account name',
      testFile: 'tests/accounts.spec.ts',
    });
    expect(claim.obligationId).toBe('tenant.accounts:crud:update');

    const record = EvidenceRecordSchema.parse({
      schemaVersion: 1,
      recordId: RECORD_ID,
      runId: RUN_ID,
      trust: 'witnessed',
      obligationId: 'tenant.accounts:crud:update',
      kind: 'persistence.entity',
      scope: { kind: 'bulk', count: 3 },
      issuedAt: '2026-08-30T12:00:00.000Z',
    });
    expect(record.scope?.count).toBe(3);
    expect(record.trust).toBe('witnessed');
  });

  it('RunManifest round-trips per pin #4', () => {
    const manifest = RunManifestSchema.parse({
      schemaVersion: 1,
      runId: RUN_ID,
      startedAt: '2026-08-30T12:00:00.000Z',
      gitSha: null,
      provider: 'local-staged',
      plugins: [
        { id: 'gateforge.pack-sqlalchemy', version: '0.1.0', transport: 'subprocess' },
      ],
      attestationScope: null,
    });
    expect(manifest.provider).toBe('local-staged');
    expect(manifest.gitSha).toBeNull();
  });

  it('all seven verdicts are valid (ADR 0001)', () => {
    expect(VerdictSchema.options).toEqual([
      'satisfied',
      'missing',
      'invalid',
      'unclassified',
      'unresolved',
      'waived',
      'stale',
    ]);
  });

  it('GATEFORGE_SCHEMA_VERSION is 1', () => {
    expect(GATEFORGE_SCHEMA_VERSION).toBe(1);
  });
});

describe('unknown schemaVersion is rejected, never migrated', () => {
  const schemaDrift = /unsupported schemaVersion/;

  it('classification rejects schemaVersion 2', () => {
    const result = ClassificationFileSchema.safeParse({ schemaVersion: 2, resources: {} });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((issue) => schemaDrift.test(issue.message))).toBe(true);
    }
  });

  it('policy rejects schemaVersion 0', () => {
    const result = PolicyFileSchema.safeParse({ schemaVersion: 0, policies: [] });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((issue) => schemaDrift.test(issue.message))).toBe(true);
    }
  });

  it('baseline rejects schemaVersion 2', () => {
    const result = BaselineSchema.safeParse({ schemaVersion: 2, fingerprints: [] });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((issue) => schemaDrift.test(issue.message))).toBe(true);
    }
  });

  it('run-manifest rejects string schemaVersion', () => {
    const result = RunManifestSchema.safeParse({
      schemaVersion: '1',
      runId: RUN_ID,
      startedAt: '2026-08-30T12:00:00.000Z',
      gitSha: null,
      provider: 'local-staged',
      plugins: [],
      attestationScope: null,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((issue) => schemaDrift.test(issue.message))).toBe(true);
    }
  });
});

describe('waiver: five mandatory fields, missing any = error', () => {
  const valid = {
    schemaVersion: 1,
    owner: 'platform-team',
    justificationUrl: 'https://issues.example.com/123',
    approver: 'jd',
    scope: { kind: 'exact', resourceId: 'tenant.accounts', fingerprint: FP },
    expiresAt: '2027-01-01T00:00:00.000Z',
  };

  it('accepts a fully-specified waiver', () => {
    expect(WaiverSchema.parse(valid).scope.fingerprint).toBe(FP);
  });

  for (const field of [
    'owner',
    'justificationUrl',
    'approver',
    'scope',
    'expiresAt',
  ] as const) {
    it(`rejects a waiver missing '${field}'`, () => {
      const broken = { ...valid } as Record<string, unknown>;
      delete broken[field];
      const result = WaiverSchema.safeParse(broken);
      expect(result.success).toBe(false);
    });
  }

  it('rejects non-exact scope kinds and bad fingerprints', () => {
    expect(
      WaiverSchema.safeParse({
        ...valid,
        scope: { kind: 'resource', resourceId: 'tenant.accounts' },
      }).success,
    ).toBe(false);
    expect(
      WaiverSchema.safeParse({
        ...valid,
        scope: { kind: 'exact', resourceId: 'tenant.accounts', fingerprint: 'xyz' },
      }).success,
    ).toBe(false);
  });

  it('rejects unknown keys (typos fail loud)', () => {
    expect(
      WaiverSchema.safeParse({ ...valid, expiresat: '2027-01-01T00:00:00.000Z' })
        .success,
    ).toBe(false);
  });
});

describe('baseline ordering (pin #3)', () => {
  const fpA = '0'.repeat(64);
  const fpB = 'f'.repeat(64);

  it('accepts sorted, duplicate-free lists', () => {
    expect(
      BaselineSchema.parse({ schemaVersion: 1, fingerprints: [fpA, fpB] })
        .fingerprints,
    ).toEqual([fpA, fpB]);
    expect(BaselineSchema.parse({ schemaVersion: 1, fingerprints: [] }).fingerprints).toEqual([]);
  });

  it('rejects unsorted lists with the offending index', () => {
    const result = BaselineSchema.safeParse({
      schemaVersion: 1,
      fingerprints: [fpB, fpA],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.path).toEqual(['fingerprints', 0]);
    }
  });

  it('rejects duplicates', () => {
    expect(
      BaselineSchema.safeParse({ schemaVersion: 1, fingerprints: [fpA, fpA] }).success,
    ).toBe(false);
  });
});
