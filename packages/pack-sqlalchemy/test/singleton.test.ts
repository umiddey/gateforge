/**
 * Per-tenant singletons (plan 2026-09-25 Phase 4b item 3a, E9/E10).
 *
 * A table whose UNIQUE constraint (or unique index) includes the tenant
 * scope column admits at most ONE row per tenant: a create can therefore
 * only be proven on a brand-new tenant, while the witness reads through
 * one process-global login. The detector emits that as an ADDITIVE fact
 * (`uniqueConstraints` attributes, plus the `singletonPerTenant` tag
 * minted in the TypeScript wrapper where plane evidence lives) so the
 * owner sees the obligation. Nothing here blocks, and a table without
 * either fact is byte-identical to before.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DiscoveryOutcome } from '@gate-forge/plugin-protocol';
import { FIXTURE_ROOT, runDiscover } from './helpers.js';
import {
  applyPlanesConfig,
  DEFAULT_PLANES_CONFIG,
  TENANT_SCOPE_COLUMNS,
  type PlaneConfigRule,
} from '../src/index.js';

const FIXTURE = 'singleton_per_tenant.py';

type TableResource = DiscoveryOutcome['resources'][number];

/** Every table of the fixture, tenant plane applied (the reviewed state). */
const TENANT_PLANE_RULES: readonly PlaneConfigRule[] = [
  {
    tables: ['ledger_entries', 'meters', 'coupons', 'tenant_settings'],
    plane: 'tenant',
    reason: 'each table carries a tenant_id scope column',
  },
];

/** Discovers the singleton fixture through the documented subprocess transport. */
function discoverFixture(cwd = FIXTURE_ROOT): Promise<DiscoveryOutcome> {
  return runDiscover([FIXTURE], { cwd });
}

/** The fixture's tables keyed by resource name, in discovery order. */
function tablesByName(outcome: DiscoveryOutcome): Map<string, TableResource> {
  const tables = new Map<string, TableResource>();
  for (const resource of outcome.resources) {
    if (resource.kind !== 'sqlalchemy.table') continue;
    const name = resource.attributes['resourceName'];
    if (typeof name === 'string') tables.set(name, resource);
  }
  return tables;
}

describe('per-tenant singleton facts (plan Phase 4b item 3a)', () => {
  const projects: string[] = [];
  afterEach(() => {
    for (const project of projects.splice(0)) rmSync(project, { recursive: true, force: true });
  });

  it('reports the unique constraints it can see, with their columns', async () => {
    const tables = tablesByName(await discoverFixture());
    expect(tables.get('ledger_entries')?.attributes['uniqueConstraints']).toEqual([
      {
        name: 'uq_ledger_tenant_ledger_kind',
        kind: 'constraint',
        columns: ['tenant_id', 'ledger', 'kind'],
      },
    ]);
    expect(tables.get('meters')?.attributes['uniqueConstraints']).toEqual([
      { name: 'ux_meters_tenant_serial', kind: 'index', columns: ['tenant_id', 'serial'] },
    ]);
    expect(tables.get('coupons')?.attributes['uniqueConstraints']).toEqual([
      { name: null, kind: 'constraint', columns: ['code'] },
    ]);
    // No unique constraint at all: the attribute is ABSENT, not empty.
    expect(tables.get('tenant_settings')?.attributes['uniqueConstraints']).toBeUndefined();
  });

  it('tags a tenant table whose unique constraint includes the tenant scope column', async () => {
    const tables = tablesByName(applyPlanesConfig(await discoverFixture(), {
      rules: [...TENANT_PLANE_RULES],
    }));
    expect(tables.get('ledger_entries')?.attributes['singletonPerTenant']).toEqual({
      constraint: 'uq_ledger_tenant_ledger_kind',
      tenantColumn: 'tenant_id',
      columns: ['tenant_id', 'ledger', 'kind'],
    });
    // A unique INDEX says exactly the same thing about uniqueness.
    expect(tables.get('meters')?.attributes['singletonPerTenant']).toEqual({
      constraint: 'ux_meters_tenant_serial',
      tenantColumn: 'tenant_id',
      columns: ['tenant_id', 'serial'],
    });
  });

  it('never tags a table whose unique constraint excludes the tenant scope column', async () => {
    const tables = tablesByName(applyPlanesConfig(await discoverFixture(), {
      rules: [...TENANT_PLANE_RULES],
    }));
    expect(tables.get('coupons')?.attributes['singletonPerTenant']).toBeUndefined();
    expect(tables.get('tenant_settings')?.attributes['singletonPerTenant']).toBeUndefined();
  });

  it('never tags without plane evidence: a table of unknown plane stays untagged', async () => {
    const tables = tablesByName(await discoverFixture());
    expect(tables.get('ledger_entries')?.attributes['plane']).toBeUndefined();
    expect(tables.get('ledger_entries')?.attributes['singletonPerTenant']).toBeUndefined();
  });

  it('adds only the plane and the tag, leaving every other attribute untouched', async () => {
    const before = tablesByName(await discoverFixture()).get('ledger_entries');
    const after = tablesByName(applyPlanesConfig(await discoverFixture(), {
      rules: [...TENANT_PLANE_RULES],
    })).get('ledger_entries');
    const tag = after?.attributes['singletonPerTenant'];
    expect(after?.attributes).toEqual({
      ...before?.attributes,
      plane: 'tenant',
      singletonPerTenant: tag,
    });
    expect(Object.keys(before?.attributes ?? {}).sort()).toEqual([
      'abstract',
      'baseNames',
      'classQname',
      'columnNames',
      'hasTableArgs',
      'primaryKeyColumns',
      'resourceName',
      'scope',
      'tableArgsSchema',
      'tableKeywordTrue',
      'tableName',
      'tablenameProvenance',
      'uniqueConstraints',
    ]);
  });

  it('documents the tenant-scope column names it recognizes', () => {
    expect([...TENANT_SCOPE_COLUMNS]).toContain('tenant_id');
    expect(TENANT_SCOPE_COLUMNS).toHaveLength(new Set(TENANT_SCOPE_COLUMNS).size);
  });

  it('is byte-identical for a repo with no planes config at all', async () => {
    const project = mkdtempSync(join(tmpdir(), 'gateforge-singleton-'));
    projects.push(project);
    cpSync(join(FIXTURE_ROOT, FIXTURE), join(project, FIXTURE));
    const inRepo = await discoverFixture(project);
    const fromPackRoot = await discoverFixture();
    expect(JSON.stringify(fromPackRoot)).toBe(JSON.stringify(inRepo));
    // The default (no rules) config changes nothing at all.
    expect(applyPlanesConfig(inRepo, DEFAULT_PLANES_CONFIG)).toStrictEqual(inRepo);
  });
});
