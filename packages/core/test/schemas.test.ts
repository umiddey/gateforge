import { describe, expect, it } from 'vitest';
import { ClassificationSchema } from '../src/index.js';
import {
  AttestationSchema,
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
      archiveFields: { status: archived }
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
        deleteSemantics: 'archive', archiveFields: { status: 'archived' },
      },
    });
    expect(obligation.id).toBe(`${obligation.resourceId}:${obligation.contract}`);
    expect(obligation.requirementsDigest).toBeUndefined();
  });

  it('Obligation: requirementsDigest is optional 64-hex', () => {
    const obligation = ObligationSchema.parse({
      schemaVersion: 1,
      id: 'tenant.accounts:http:effect-verified',
      resourceId: 'tenant.accounts',
      contract: 'http:effect-verified',
      policyId: 'behavior-policy',
      lifecycle: {
        create: true,
        read: true,
        update: true,
        delete: true,
        deleteSemantics: 'hard',
      },
      requirementsDigest: 'ab'.repeat(32),
    });
    expect(obligation.requirementsDigest).toBe('ab'.repeat(32));
    expect(() =>
      ObligationSchema.parse({
        schemaVersion: 1,
        id: 'tenant.accounts:http:effect-verified',
        resourceId: 'tenant.accounts',
        contract: 'http:effect-verified',
        policyId: 'behavior-policy',
        lifecycle: {
          create: true,
          read: true,
          update: true,
          delete: true,
          deleteSemantics: 'hard',
        },
        requirementsDigest: 'not-a-digest',
      }),
    ).toThrow();
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

  it('RunManifest stays valid before the witness appends (no recordIds) and after (pin #7)', () => {
    const base = {
      schemaVersion: 1,
      runId: RUN_ID,
      startedAt: '2026-08-30T12:00:00.000Z',
      gitSha: null,
      provider: 'local-staged' as const,
      plugins: [],
      attestationScope: null,
    };
    // Pre-append manifest written by the CLI: no recordIds field.
    expect(RunManifestSchema.parse(base).recordIds).toBeUndefined();
    // Post-append manifest written by the witness shutdown: recordIds present.
    const appended = RunManifestSchema.parse({ ...base, recordIds: [RECORD_ID] });
    expect(appended.recordIds).toEqual([RECORD_ID]);
  });

  it('RunManifest rejects a malformed recordIds entry (fail-closed pin #7)', () => {
    const result = RunManifestSchema.safeParse({
      schemaVersion: 1,
      runId: RUN_ID,
      startedAt: '2026-08-30T12:00:00.000Z',
      gitSha: null,
      provider: 'local-staged',
      plugins: [],
      attestationScope: null,
      recordIds: ['made-up-id-not-issued-by-the-witness'],
    });
    expect(result.success).toBe(false);
  });

  it('RunManifest accepts an authenticated append (recordIds + recordIdsMac, pin #7)', () => {
    const manifest = RunManifestSchema.parse({
      schemaVersion: 1,
      runId: RUN_ID,
      startedAt: '2026-08-30T12:00:00.000Z',
      gitSha: null,
      provider: 'local-staged',
      plugins: [],
      attestationScope: null,
      recordIds: [RECORD_ID],
      recordIdsMac: 'c'.repeat(64),
    });
    expect(manifest.recordIds).toEqual([RECORD_ID]);
    expect(manifest.recordIdsMac).toBe('c'.repeat(64));
    // A malformed MAC is schema-invalid too.
    const bad = RunManifestSchema.safeParse({
      schemaVersion: 1,
      runId: RUN_ID,
      startedAt: '2026-08-30T12:00:00.000Z',
      gitSha: null,
      provider: 'local-staged',
      plugins: [],
      attestationScope: null,
      recordIds: [RECORD_ID],
      recordIdsMac: 'not-a-mac',
    });
    expect(bad.success).toBe(false);
  });

  it('AttestationSchema accepts a versioned v2 envelope and rejects legacy/unsorted shapes', () => {
    const envelope = {
      attestationVersion: 2,
      runId: RUN_ID,
      invocationId: 'aaaaaaaa-0000-4000-8000-000000000001',
      inputDigest: 'c'.repeat(64),
      recordIds: ['a'.repeat(64), RECORD_ID],
      mac: 'd'.repeat(64),
    };
    expect(AttestationSchema.parse(envelope).attestationVersion).toBe(2);
    // Wrong version, unsorted ids, duplicated ids, rewritten legacy
    // field names, and extra keys are all schema-invalid (strict).
    for (const bad of [
      { ...envelope, attestationVersion: 1 },
      { ...envelope, recordIds: [RECORD_ID, 'a'.repeat(64)] },
      { ...envelope, recordIds: [RECORD_ID, RECORD_ID] },
      { ...envelope, recordIdsMac: 'd'.repeat(64) },
      { ...envelope, inputDigest: 'xyz' },
    ]) {
      expect(AttestationSchema.safeParse(bad).success).toBe(false);
    }
  });

  it('RunManifest carries invocationId/inputDigest/attestation and stays strict', () => {
    const manifest = RunManifestSchema.parse({
      schemaVersion: 1,
      runId: RUN_ID,
      startedAt: '2026-08-30T12:00:00.000Z',
      gitSha: null,
      provider: 'local-staged',
      plugins: [],
      attestationScope: null,
      invocationId: 'aaaaaaaa-0000-4000-8000-000000000001',
      inputDigest: 'c'.repeat(64),
      recordIds: [RECORD_ID],
      attestation: {
        attestationVersion: 2,
        runId: RUN_ID,
        invocationId: 'aaaaaaaa-0000-4000-8000-000000000001',
        inputDigest: 'c'.repeat(64),
        recordIds: [RECORD_ID],
        mac: 'd'.repeat(64),
      },
    });
    expect(manifest.invocationId).toBe('aaaaaaaa-0000-4000-8000-000000000001');
    expect(manifest.attestation?.attestationVersion).toBe(2);
    // Unknown keys still rejected (no loosened strict()).
    expect(
      RunManifestSchema.safeParse({ ...(manifest as object), unknownField: 1 }).success,
    ).toBe(false);
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

describe('archive lifecycle requires a non-empty owner-owned archiveFields map', () => {
  const base = {
    exposure: 'user-facing',
    plane: 'tenant',
    lifecycle: {
      create: true,
      read: true,
      update: true,
      delete: true,
      deleteSemantics: 'archive',
    },
    primaryKey: ['id'],
    evidenceAdapter: 'accounts',
  };

  it('rejects an archive lifecycle without archiveFields', () => {
    const result = ClassificationSchema.safeParse(base);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((issue) => issue.path.includes('archiveFields'))).toBe(true);
    }
  });

  it('rejects an EMPTY archiveFields map (audit round 6: it can never satisfy)', () => {
    const result = ClassificationSchema.safeParse({
      ...base,
      lifecycle: { ...base.lifecycle, archiveFields: {} },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(
        result.error.issues.some(
          (issue) =>
            issue.path.includes('archiveFields') &&
            /at least one field/.test(issue.message),
        ),
      ).toBe(true);
    }
  });

  it('rejects an EMPTY updateableFields array (audit round 6)', () => {
    const result = ClassificationSchema.safeParse({
      ...base,
      lifecycle: {
        ...base.lifecycle,
        deleteSemantics: 'hard',
        archiveFields: undefined,
        updateableFields: [],
      },
    });
    expect(result.success).toBe(false);
  });

  it('accepts a populated updateableFields array', () => {
    const result = ClassificationSchema.safeParse({
      ...base,
      lifecycle: {
        ...base.lifecycle,
        deleteSemantics: 'hard',
        updateableFields: ['first_name', 'last_name'],
      },
    });
    expect(result.success).toBe(true);
  });

  it('accepts a populated archiveFields map and a hard-delete lifecycle without one', () => {
    expect(
      ClassificationSchema.safeParse({
        ...base,
        lifecycle: { ...base.lifecycle, archiveFields: { status: 'archived' } },
      }).success,
    ).toBe(true);
    expect(
      ClassificationSchema.safeParse({
        ...base,
        lifecycle: {
          create: true,
          read: true,
          update: true,
          delete: true,
          deleteSemantics: 'hard',
        },
      }).success,
    ).toBe(true);
  });
});

describe('evidenceLane: the claims lane exempts a user-facing entry from the adapter', () => {
  const businessBase = {
    exposure: 'user-facing',
    plane: 'tenant',
    lifecycle: { create: true, read: true, update: true, delete: true, deleteSemantics: 'hard' },
    primaryKey: ['id'],
  };

  it('user-facing WITHOUT evidenceAdapter still fails (the business red side)', () => {
    const result = ClassificationSchema.safeParse(businessBase);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((issue) => issue.path.includes('evidenceAdapter'))).toBe(true);
    }
  });

  it('user-facing with evidenceAdapter present passes unchanged', () => {
    expect(ClassificationSchema.safeParse({ ...businessBase, evidenceAdapter: 'accounts' }).success).toBe(
      true,
    );
  });

  it("user-facing with evidenceLane 'claims' and no adapter passes (http.endpoint lane)", () => {
    // The classifier mints this for http.endpoint resources only; the
    // schema-level contract is that the lane REPLACES the adapter demand.
    expect(ClassificationSchema.safeParse({ ...businessBase, evidenceLane: 'claims' }).success).toBe(
      true,
    );
  });

  it('rejects unknown evidenceLane values', () => {
    expect(
      ClassificationSchema.safeParse({ ...businessBase, evidenceLane: 'vibes' }).success,
    ).toBe(false);
  });
});
