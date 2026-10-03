/**
 * The per-tenant singleton rule is EXACT (problem 21).
 *
 * The old rule tagged a table whose unique constraint merely CONTAINED a
 * tenant scope column, and the guidance it produced was provably false: a
 * table unique over `(period_id, tenant_id, contract_id,
 * recipient_user_id)` allows one row per recipient per period, so many rows
 * per tenant exist — yet the gate told the owner "exactly one row per
 * tenant exists" and that the create "can only be proven on a fresh
 * tenant". A domain `tenant_id` column (the renter) is not the tenancy
 * scope either.
 *
 * The rule now: the constraint must be written over the tenancy scope and
 * nothing else, and the recognized scope comes from the owner's
 * `tenancy.scopeColumns` when set (the default list is only the fallback).
 * Each case below fails on the old rule and passes on the new one.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DiscoveryOutcome } from '@gate-forge/plugin-protocol';
import { FIXTURE_ROOT } from './helpers.js';
import {
  createSqlalchemyDetector,
  singletonTagFor,
  type PlaneConfigRule,
} from '../src/index.js';

const EXACT_SCOPE_FIXTURE = 'singleton_exact_scope.py';
const COMPOSITE_SCOPE_FIXTURE = 'singleton_composite_scope.py';

const ORIGINAL_CWD = process.cwd();

/** Puts every table of the exact-scope fixture on the tenant plane. */
const TENANT_PLANE_RULES: readonly PlaneConfigRule[] = [
  {
    tables: [
      'tenant_profiles',
      'heating_information_recipients',
      'ledger_period_settings',
    ],
    plane: 'tenant',
    reason: 'the reviewed tenant plane for this fixture',
  },
];

/** Puts every table of the composite-scope fixture on the tenant plane. */
const COMPOSITE_PLANE_RULES: readonly PlaneConfigRule[] = [
  {
    tables: ['org_tenant_settings', 'org_settings', 'org_tenant_labels'],
    plane: 'tenant',
    reason: 'the reviewed tenant plane for this fixture',
  },
];

/**
 * A minimal VALID `.gateforge.yml`: everything the schema requires, plus
 * the optional `tenancy` block when scope columns are declared.
 */
function configText(scopeColumns: readonly string[]): string {
  return `schemaVersion: 1
project:
  languages: [python]
  paths:
    include: ['**/*.py']
    exclude: []
plugins: []
policies: policies.yml
classificationPolicy: classification-policy.yml
adapters: .gateforge/adapters
waivers: .gateforge/waivers
baselines: .gateforge/baselines/obligations.json
changed:
  provider: auto
witness:
  maxDurationMs: 30000
clock:
  mode: system
tenancy:
  scopeColumns: [${scopeColumns.join(', ')}]
`;
}

const projects: string[] = [];

afterEach(() => {
  for (const project of projects.splice(0)) rmSync(project, { recursive: true, force: true });
  process.chdir(ORIGINAL_CWD);
});

/**
 * Discovers one fixture through the pack's own discover entry, with the
 * reviewed plane rules applied and the project as the working directory —
 * that is where `.gateforge.yml` (and therefore the owner's declared
 * `tenancy.scopeColumns`) is read from. The raw python detector cannot be
 * used here: it emits the constraint facts but mints no tag, so the
 * declared scope would never reach the rule under test.
 */
async function discoverIn(
  fixture: string,
  rules: readonly PlaneConfigRule[],
  scopeColumns?: readonly string[],
): Promise<DiscoveryOutcome> {
  const project = mkdtempSync(join(tmpdir(), 'gateforge-singleton-exact-'));
  projects.push(project);
  cpSync(join(FIXTURE_ROOT, fixture), join(project, fixture));
  if (scopeColumns !== undefined) {
    writeFileSync(join(project, '.gateforge.yml'), configText(scopeColumns), 'utf8');
  }
  process.chdir(project);
  const detector = createSqlalchemyDetector(
    rules.length === 0 ? {} : { planesConfig: { rules: [...rules] } },
  );
  return (await detector.discover([fixture])) as DiscoveryOutcome;
}

/** The `singletonPerTenant` tag of one table, or undefined when untagged. */
function tagOf(outcome: DiscoveryOutcome, table: string): unknown {
  const resource = outcome.resources.find(
    (candidate) =>
      candidate.kind === 'sqlalchemy.table' &&
      candidate.attributes['resourceName'] === table,
  );
  return resource?.attributes['singletonPerTenant'];
}

describe('per-tenant singleton is the EXACT scope, not a column that resembles it', () => {
  it('tags a table whose unique constraint covers the scope alone', async () => {
    const outcome = await discoverIn(EXACT_SCOPE_FIXTURE, TENANT_PLANE_RULES);
    expect(tagOf(outcome, 'tenant_profiles')).toEqual({
      constraint: 'uq_tenant_profile_tenant',
      tenantColumn: 'tenant_id',
      scopeColumns: ['tenant_id'],
      columns: ['tenant_id'],
    });
  });

  it('never tags a composite constraint that merely CONTAINS the scope column', async () => {
    const outcome = await discoverIn(EXACT_SCOPE_FIXTURE, TENANT_PLANE_RULES);
    // The old rule tagged BOTH of these and told the owner a row is
    // unique per tenant; neither is.
    expect(tagOf(outcome, 'heating_information_recipients')).toBeUndefined();
    expect(tagOf(outcome, 'ledger_period_settings')).toBeUndefined();
    // The facts stay visible: the owner can still read WHY it was refused.
    const recipients = outcome.resources.find(
      (candidate) =>
        candidate.kind === 'sqlalchemy.table' &&
        candidate.attributes['resourceName'] === 'heating_information_recipients',
    );
    expect(recipients?.attributes['uniqueConstraints']).toEqual([
      {
        name: 'uq_heating_information_recipient_identity',
        kind: 'constraint',
        columns: ['period_id', 'tenant_id', 'contract_id', 'recipient_user_id'],
      },
    ]);
  });

  it('still requires plane evidence, exactly as before', async () => {
    // No plane rules at all: the reviewed decision the tag depends on is
    // missing, so nothing is claimed.
    const outcome = await discoverIn(EXACT_SCOPE_FIXTURE, []);
    expect(tagOf(outcome, 'tenant_profiles')).toBeUndefined();
  });

  it('respects a declared composite scope on both sides', async () => {
    const outcome = await discoverIn(
      COMPOSITE_SCOPE_FIXTURE,
      COMPOSITE_PLANE_RULES,
      ['org_id', 'tenant_id'],
    );
    // Both declared scope columns, and nothing else: one row per tenant.
    expect(tagOf(outcome, 'org_tenant_settings')).toEqual({
      constraint: 'uq_org_tenant_setting',
      tenantColumn: 'org_id',
      scopeColumns: ['org_id', 'tenant_id'],
      columns: ['org_id', 'tenant_id'],
    });
    // A non-scope column inside the constraint defeats the tag…
    expect(tagOf(outcome, 'org_tenant_labels')).toBeUndefined();
    // …and a PARTIAL scope is at most one row per org, which is at most
    // one row per (org, tenant): still a per-tenant singleton.
    expect(tagOf(outcome, 'org_settings')).toEqual({
      constraint: 'uq_org_setting',
      tenantColumn: 'org_id',
      scopeColumns: ['org_id'],
      columns: ['org_id'],
    });
  });

  it('decides on the configured scope columns, not on what a column is named', () => {
    // The unit seam, stated directly: the constraint is judged against the
    // DECLARED list only. A constraint whose every column is in that list
    // is tagged; one naming any other column is not. On the old rule
    // ("contains a scope column") the second case was tagged too.
    const declared = ['org_id', 'tenant_id'];
    const unique = (columns: string[]): Record<string, unknown> => ({
      plane: 'tenant',
      uniqueConstraints: [{ name: 'uq', kind: 'constraint', columns }],
    });
    expect(singletonTagFor(unique(['org_id', 'tenant_id']), declared)).toEqual({
      constraint: 'uq',
      tenantColumn: 'org_id',
      scopeColumns: ['org_id', 'tenant_id'],
      columns: ['org_id', 'tenant_id'],
    });
    // A PART of a composite declared scope is sound too: uniqueness over
    // one scope column still bounds the rows per (org, tenant).
    expect(singletonTagFor(unique(['tenant_id']), declared)).toEqual({
      constraint: 'uq',
      tenantColumn: 'tenant_id',
      scopeColumns: ['tenant_id'],
      columns: ['tenant_id'],
    });
    // One non-scope column decides it against the tag…
    expect(singletonTagFor(unique(['org_id', 'tenant_id', 'kind']), declared)).toBeNull();
    // …and a column that merely LOOKS like a tenant scope but is not in
    // the declared list is a domain column, never a scope.
    expect(singletonTagFor(unique(['tenant_ref']), declared)).toBeNull();
    expect(singletonTagFor(unique(['tenant_id', 'tenant_ref']), declared)).toBeNull();
  });
});