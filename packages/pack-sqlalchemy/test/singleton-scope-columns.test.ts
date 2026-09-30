/**
 * Owner-declared tenant scope columns (plan 2026-09-25 Phase 4b item 3a).
 *
 * The fixed `TENANT_SCOPE_COLUMNS` list recognizes the usual spellings
 * (`tenant_id`, `tenant`, ...), but the real incident's ledger table is
 * scoped by `contractor_id`: unique (contractor_id, ledger_id, kind)
 * admits one row per contractor, so a create is provable only on a fresh
 * contractor. The owner must therefore be able to DECLARE which columns
 * carry the tenant scope, and the declaration must REPLACE the default
 * list (never extend it silently). ABSENT stays byte-identical: same tag,
 * same bytes, same nothing.
 *
 * The key lives in `.gateforge.yml`, so it is inside the trusted policy
 * digest — an agent cannot widen the tenant scope of a review artifact
 * without the owner repinning the policy revision.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DiscoveryOutcome } from '@gate-forge/plugin-protocol';
import { FIXTURE_ROOT } from './helpers.js';
import {
  createSqlalchemyDetector,
  readTenancyScopeColumnsOrNull,
  TENANT_SCOPE_COLUMNS,
  type PlaneConfigRule,
} from '../src/index.js';

const CONTRACTOR_FIXTURE = 'singleton_contractor_scope.py';
const TENANT_FIXTURE = 'singleton_per_tenant.py';

const ORIGINAL_CWD = process.cwd();

/** The reviewed plane decision for both singleton fixtures. */
const TENANT_PLANE_RULES: readonly PlaneConfigRule[] = [
  {
    tables: ['contractor_ledger_entries', 'contractor_ledgers'],
    plane: 'tenant',
    reason: 'each table carries a contractor_id scope column',
  },
  {
    tables: ['ledger_entries', 'meters', 'coupons', 'tenant_settings'],
    plane: 'tenant',
    reason: 'each table carries a tenant_id scope column',
  },
];

/** One temp project: both fixtures, plus its `.gateforge.yml` path. */
interface Project {
  readonly dir: string;

  readonly configPath: string;
}

/**
 * A minimal VALID `.gateforge.yml` document: everything the schema
 * requires, plus the optional `tenancy` block when scope columns are
 * declared.
 */
function configText(scopeColumns?: readonly string[]): string {
  const tenancy =
    scopeColumns === undefined
      ? ''
      : `\ntenancy:\n  scopeColumns: [${scopeColumns.join(', ')}]\n`;
  return `schemaVersion: 1
project:
  languages: [python]
  paths:
    include: ["**/*.py"]
    exclude: []
plugins: []
policies: .gateforge/policies.yml
classificationPolicy: .gateforge/classification-policy.yml
adapters: .gateforge/adapters
waivers: .gateforge/waivers
baselines: .gateforge/baselines/obligations.json
changed:
  provider: local-staged
witness:
  maxDurationSeconds: 5
clock:
  mode: system
${tenancy}`;
}

/** Builds a temp project holding both fixtures and no config file yet. */
function makeProject(): Project {
  const dir = mkdtempSync(join(tmpdir(), 'gateforge-scope-columns-'));
  for (const fixture of [CONTRACTOR_FIXTURE, TENANT_FIXTURE]) {
    cpSync(join(FIXTURE_ROOT, fixture), join(dir, fixture));
  }
  return { dir, configPath: join(dir, '.gateforge.yml') };
}

/**
 * Discovers fixtures with the reviewed planes applied, the project's
 * directory as cwd (that is where `.gateforge.yml` is read from), and
 * cwd always restored.
 */
async function discoverIn(
  project: Project,
  files: readonly string[],
  withPlanes = true,
): Promise<DiscoveryOutcome> {
  process.chdir(project.dir);
  try {
    const options = withPlanes
      ? { planesConfig: { rules: [...TENANT_PLANE_RULES] } }
      : {};
    return (await createSqlalchemyDetector(options).discover([...files])) as DiscoveryOutcome;
  } finally {
    process.chdir(ORIGINAL_CWD);
  }
}

/** The `singletonPerTenant` tag of one table, or undefined when untagged. */
function tagOf(outcome: DiscoveryOutcome, table: string): unknown {
  const resource = outcome.resources.find(
    (candidate) =>
      candidate.kind === 'sqlalchemy.table' && candidate.attributes['resourceName'] === table,
  );
  return resource?.attributes['singletonPerTenant'];
}

describe('owner-declared tenant scope columns (plan Phase 4b item 3a)', () => {
  const projects: Project[] = [];
  /** Registers a new project for cleanup after the test. */
  function project(scopeColumns?: readonly string[], config = scopeColumns !== undefined): Project {
    const created = makeProject();
    if (config) writeFileSync(created.configPath, configText(scopeColumns), 'utf8');
    projects.push(created);
    return created;
  }
  afterEach(() => {
    for (const entry of projects.splice(0)) rmSync(entry.dir, { recursive: true, force: true });
  });

  it('leaves a contractor-scoped table UNtagged while the key is absent', async () => {
    const declared = project();
    const outcome = await discoverIn(declared, [CONTRACTOR_FIXTURE]);
    // The unique constraint is visible; the fixed list simply does not
    // know `contractor_id`, so nothing is claimed.
    const table = outcome.resources.find(
      (candidate) => candidate.attributes['resourceName'] === 'contractor_ledger_entries',
    );
    expect(table?.attributes['uniqueConstraints']).toEqual([
      { name: 'uq_contractor_ledger_kind', kind: 'constraint', columns: ['contractor_id', 'ledger_id', 'kind'] },
    ]);
    expect(table?.attributes['plane']).toBe('tenant');
    expect(table?.attributes['singletonPerTenant']).toBeUndefined();
  });

  it('tags a contractor-scoped table once the owner declares the scope column', async () => {
    const outcome = await discoverIn(project(['contractor_id']), [CONTRACTOR_FIXTURE]);
    expect(tagOf(outcome, 'contractor_ledger_entries')).toEqual({
      constraint: 'uq_contractor_ledger_kind',
      tenantColumn: 'contractor_id',
      columns: ['contractor_id', 'ledger_id', 'kind'],
    });
  });

  it('never tags a constraint that excludes the declared scope column', async () => {
    const outcome = await discoverIn(project(['contractor_id']), [CONTRACTOR_FIXTURE]);
    expect(tagOf(outcome, 'contractor_ledgers')).toBeUndefined();
  });

  it('never tags without plane evidence, however the owner declares the scope', async () => {
    const outcome = await discoverIn(project(['contractor_id']), [CONTRACTOR_FIXTURE], false);
    expect(tagOf(outcome, 'contractor_ledger_entries')).toBeUndefined();
  });

  it('REPLACES the default list: a declared list never also matches tenant_id', async () => {
    const declared = project(['contractor_id']);
    expect(tagOf(await discoverIn(declared, [TENANT_FIXTURE]), 'ledger_entries')).toBeUndefined();
    // The very same table IS tagged once the declaration is gone — that
    // is the whole difference, and it is the owner's call to make.
    rmSync(declared.configPath);
    expect(tagOf(await discoverIn(declared, [TENANT_FIXTURE]), 'ledger_entries')).toEqual({
      constraint: 'uq_ledger_tenant_ledger_kind',
      tenantColumn: 'tenant_id',
      columns: ['tenant_id', 'ledger', 'kind'],
    });
  });

  it('is byte-identical for a repo whose config has no tenancy key', async () => {
    const noConfig = JSON.stringify(await discoverIn(project(undefined, false), [TENANT_FIXTURE]));
    expect(JSON.stringify(await discoverIn(project(undefined, true), [TENANT_FIXTURE]))).toBe(noConfig);
    // A declared list IS observable — otherwise the key would be a no-op.
    const declared = project(['contractor_id']);
    expect(JSON.stringify(await discoverIn(declared, [CONTRACTOR_FIXTURE]))).not.toBe(
      JSON.stringify(await discoverIn(project(undefined, false), [CONTRACTOR_FIXTURE])),
    );
  });

  it('reads the declared list out of the config, and nothing when absent', () => {
    const created = makeProject();
    projects.push(created);
    expect(readTenancyScopeColumnsOrNull(created.configPath)).toBeNull();
    writeFileSync(created.configPath, configText(['contractor_id', 'org_id']), 'utf8');
    expect(readTenancyScopeColumnsOrNull(created.configPath)).toEqual(['contractor_id', 'org_id']);
    // A config file that is not there is absence, never an error.
    expect(readTenancyScopeColumnsOrNull(join(created.dir, 'missing.yml'))).toBeNull();
  });

  it('fails closed on a malformed tenancy block instead of losing the tag', () => {
    const created = makeProject();
    projects.push(created);
    for (const malformed of [
      'tenancy: [contractor_id]',
      'tenancy:\n  scopeColumns: []',
      'tenancy:\n  scopeColumn: [contractor_id]',
      'tenancy:\n  scopeColumns: 7',
      'tenancy:\n  scopeColumns: [7]',
      '- tenancy\n',
      'tenancy: [unclosed\n',
    ]) {
      writeFileSync(created.configPath, malformed, 'utf8');
      expect(() => readTenancyScopeColumnsOrNull(created.configPath)).toThrow(/invalid config/);
    }
  });

  it('has no opinion about a config problem outside its own block', () => {
    const created = makeProject();
    projects.push(created);
    // The pack is a detector, not the config authority: an unrelated
    // invalid key must not stop discovery (the CLI owns that error).
    writeFileSync(
      created.configPath,
      'classifications: legacy.yml\nproject: [not, a, mapping]\n',
      'utf8',
    );
    expect(readTenancyScopeColumnsOrNull(created.configPath)).toBeNull();
  });

  it('keeps the default list itself untouched', () => {
    expect([...TENANT_SCOPE_COLUMNS]).toEqual([
      'tenant_id',
      'tenant',
      'tenantId',
      'tenant_uuid',
      'tenant_key',
    ]);
  });
});