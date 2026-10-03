/**
 * The per-tenant singleton advisory (plan 2026-09-25 Phase 4b item 3a).
 *
 * The sqlalchemy pack tags a table whose UNIQUE constraint includes the
 * tenant scope column; `check` must then say so in ONE plain advisory
 * line — naming the constraint, the tenant column, the fresh-tenant rule
 * and the session-scoped identity that makes it provable. The advisory
 * never blocks, and a graph without the tag yields nothing at all.
 */
import { describe, expect, it } from 'vitest';
import type { GraphResource } from '@gate-forge/core';
import {
  singletonPerTenantAdvisories,
  singletonPerTenantGuidanceLines,
  singletonPerTenantResources,
} from '../src/singleton-guidance.js';

/** One graph resource carrying (or not) the additive tag. */
function resource(
  id: string,
  name: string,
  attributes: Record<string, unknown> = {},
): GraphResource {
  return {
    schemaVersion: 1,
    id,
    name,
    plane: 'tenant',
    kind: 'sqlalchemy.table',
    source: 'app/models.py',
    location: { file: 'app/models.py', line: 1, col: 0 },
    exposure: null,
    classification: null,
    classificationTrace: null,
    detector: { id: 'gate-forge.pack-sqlalchemy', version: '0.0.0' },
    attributes,
  } as GraphResource;
}

const TAGGED = {
  singletonPerTenant: {
    constraint: 'uq_ledger_tenant_ledger_kind',
    tenantColumn: 'tenant_id',
    columns: ['tenant_id', 'ledger', 'kind'],
  },
};

describe('per-tenant singleton advisory', () => {
  it('says what the constraint means and how the create becomes provable', () => {
    const [entry] = singletonPerTenantAdvisories(
      [resource('tenant.ledger_entries', 'ledger_entries', TAGGED)],
      new Set(['tenant.ledger_entries']),
    );
    expect(entry?.kind).toBe('finding');
    expect(entry?.resourceId).toBe('tenant.ledger_entries');
    expect(entry?.cause).toBe('RESOURCE_SINGLETON_PER_TENANT');
    expect(entry?.detail).toContain('uq_ledger_tenant_ledger_kind unique(tenant_id, ledger, kind)');
    expect(entry?.detail).toContain("'tenant_id'");
    expect(entry?.detail).toContain('fresh tenant');
    expect(entry?.detail).toContain('POST /sessions/identity');
    expect(entry?.nextAction).toContain('fresh tenant');
  });

  it('never blocks on its own: it is a finding, not an obligation verdict', () => {
    const entries = singletonPerTenantAdvisories(
      [resource('tenant.ledger_entries', 'ledger_entries', TAGGED)],
      new Set(['tenant.ledger_entries']),
    );
    expect(entries).toHaveLength(1);
    expect(entries.every((entry) => entry.kind === 'finding')).toBe(true);
  });

  it('stays silent for a resource that owes no create', () => {
    expect(
      singletonPerTenantAdvisories([resource('tenant.ledger_entries', 'ledger_entries', TAGGED)], new Set()),
    ).toEqual([]);
    expect(
      singletonPerTenantAdvisories(
        [resource('tenant.ledger_entries', 'ledger_entries', TAGGED)],
        new Set(['tenant.coupons']),
      ),
    ).toEqual([]);
  });

  it('is byte-identical for a graph with no tagged resource', () => {
    const plain = [resource('tenant.coupons', 'coupons'), resource('master.settings', 'settings')];
    expect(singletonPerTenantAdvisories(plain, new Set(['tenant.coupons']))).toEqual([]);
    expect(singletonPerTenantGuidanceLines(plain)).toEqual([]);
    expect(singletonPerTenantResources(plain)).toEqual([]);
  });

  it('names an unnamed constraint by its columns', () => {
    const [entry] = singletonPerTenantAdvisories(
      [
        resource(
          'tenant.ledger_entries',
          'ledger_entries',
          { singletonPerTenant: { constraint: null, tenantColumn: 'tenant_id', columns: ['tenant_id', 'ledger'] } },
        ),
      ],
      new Set(['tenant.ledger_entries']),
    );
    expect(entry?.detail).toContain('unique(tenant_id, ledger)');
  });

  it('names a composite tenancy scope in full', () => {
    const [entry] = singletonPerTenantAdvisories(
      [
        resource('tenant.tenant_settings', 'tenant_settings', {
          singletonPerTenant: {
            constraint: 'uq_org_tenant_setting',
            tenantColumn: 'org_id',
            scopeColumns: ['org_id', 'tenant_id'],
            columns: ['org_id', 'tenant_id'],
          },
        }),
      ],
      new Set(['tenant.tenant_settings']),
    );
    expect(entry?.detail).toContain('uq_org_tenant_setting unique(org_id, tenant_id)');
    expect(entry?.detail).toContain("'org_id and tenant_id'");
  });

  it('ignores a malformed tag rather than crashing the gate', () => {
    const malformed = [
      { singletonPerTenant: 'yes' },
      { singletonPerTenant: null },
      { singletonPerTenant: { tenantColumn: 'tenant_id' } },
      { singletonPerTenant: { tenantColumn: 'tenant_id', columns: [] } },
      { singletonPerTenant: { tenantColumn: 'tenant_id', columns: [1] } },
    ];
    for (const attributes of malformed) {
      expect(singletonPerTenantResources([resource('tenant.t', 't', attributes)])).toEqual([]);
    }
  });

  it('hands next/init the same sentence as ready-made lines', () => {
    const lines = singletonPerTenantGuidanceLines([
      resource('tenant.ledger_entries', 'ledger_entries', TAGGED),
    ]);
    const [advisory] = singletonPerTenantAdvisories(
      [resource('tenant.ledger_entries', 'ledger_entries', TAGGED)],
      new Set(['tenant.ledger_entries']),
    );
    expect(lines[0]).toBe(advisory?.detail);
  });
});
