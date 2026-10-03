/**
 * Discover-time config resolution — the staged gate's correctness hinge.
 *
 * `gateforge check --staged` moves the process cwd to the staged candidate
 * checkout before discovery runs, so every config document the detector
 * reads (`.gateforge/planes.json`, the `.gateforge.yml` tenancy block)
 * must come from the root in force at the DISCOVER call — the gated bytes,
 * not the user's working-tree config. pack-sqlalchemy resolves both
 * channels per call; this suite pins that so a refactor back to a
 * factory-time capture (the pack-fastapi defect) is caught here, and pins
 * that an explicit option still wins over the document.
 */
import { describe, expect, it } from 'vitest';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { DiscoveryOutcome } from '@gate-forge/plugin-protocol';
import {
  createSqlalchemyDetector,
  PLANES_CONFIG_PATH,
  TENANCY_CONFIG_PATH,
  type PlanesConfig,
  type SqlalchemyDetectorOptions,
} from '../src/index.js';
import { FIXTURE_ROOT } from './helpers.js';

const ORIGINAL_CWD = process.cwd();

const PLANE_FIXTURES = ['planes/admin_models.py', 'planes/erp/tenant_models.py'] as const;

/**
 * A tenant-plane table whose UNIQUE constraint is written over the tenancy
 * scope column ALONE.
 *
 * The `singleton_contractor_scope.py` fixture cannot carry this suite: its
 * constraint is `unique (contractor_id, ledger_id, kind)`, and the tag is
 * minted only when EVERY column of a constraint is a recognized scope
 * column — a constraint that merely CONTAINS the scope admits repeated
 * creates per tenant and is deliberately left untagged. So the model is
 * written here, at the project root (never under `tests/`, which the scan
 * prunes) with an exact-scope constraint.
 */
const SCOPE_MODEL = 'ledger_models.py';

const SCOPE_MODEL_SOURCE = `from sqlalchemy import Column, Integer, String, UniqueConstraint
from sqlalchemy.orm import declarative_base

Base = declarative_base()


class ContractorProfile(Base):
    """Unique (contractor_id): exactly one row per contractor."""

    __tablename__ = "contractor_profiles"
    __table_args__ = (UniqueConstraint("contractor_id", name="uq_contractor_profile"),)

    id = Column(Integer, primary_key=True)
    contractor_id = Column(String(32), nullable=False)
`;

/** The table the exact-scope fixture declares. */
const SCOPE_TABLE = 'contractor_profiles';

/** Every path the tenancy cases scan. */
const SCOPE_PATHS = [...PLANE_FIXTURES, SCOPE_MODEL] as const;

/**
 * The reviewed plane decision for the scope fixture. The tag needs BOTH
 * facts: reviewed plane evidence of `tenant` (the plane channel) and a
 * DECLARED scope column (the tenancy channel under test) — the fixed
 * default list does not recognize `contractor_id`.
 */
const SCOPE_PLANES: PlanesConfig = {
  rules: [
    {
      tables: [SCOPE_TABLE],
      plane: 'tenant',
      reason: 'one profile per contractor scope',
    },
  ],
};

/** A temp project with the plane fixtures copied in plus the scope model. */
function makeProject(name: string): string {
  const root = mkdtempSync(join(tmpdir(), `gateforge-sqlalchemy-config-${name}-`));
  for (const relative of PLANE_FIXTURES) {
    const absolute = join(root, relative);
    mkdirSync(dirname(absolute), { recursive: true });
    cpSync(join(FIXTURE_ROOT, relative), absolute);
  }
  writeFileSync(join(root, SCOPE_MODEL), SCOPE_MODEL_SOURCE, 'utf8');
  return root;
}

/** Writes `.gateforge/planes.json` into `project`. */
function writePlanesConfig(project: string, document: PlanesConfig): void {
  mkdirSync(join(project, '.gateforge'), { recursive: true });
  writeFileSync(join(project, PLANES_CONFIG_PATH), JSON.stringify(document), 'utf8');
}

/** Writes a `.gateforge.yml` declaring the tenancy scope columns. */
function writeTenancyConfig(project: string, scopeColumns: readonly string[]): void {
  writeFileSync(
    join(project, TENANCY_CONFIG_PATH),
    `schemaVersion: 1\ntenancy:\n  scopeColumns: [${scopeColumns.join(', ')}]\n`,
    'utf8',
  );
}

/** Discovers with `project` as the process cwd; always restores it. */
async function discoverIn(
  project: string,
  paths: readonly string[],
  options: SqlalchemyDetectorOptions = {},
): Promise<DiscoveryOutcome> {
  process.chdir(project);
  try {
    return (await createSqlalchemyDetector(options).discover([...paths])) as DiscoveryOutcome;
  } finally {
    process.chdir(ORIGINAL_CWD);
  }
}

/** The `sqlalchemy.table` resource with this `resourceName`, if any. */
const tableNamed = (outcome: DiscoveryOutcome, tableName: string) =>
  (outcome.resources as Array<{ kind: string; attributes: Record<string, unknown> }>).find(
    (resource) =>
      resource.kind === 'sqlalchemy.table' && resource.attributes['resourceName'] === tableName,
  );

/** The plane attributed to the table with this resource name. */
const planeOf = (outcome: DiscoveryOutcome, tableName: string): unknown =>
  tableNamed(outcome, tableName)?.attributes['plane'];

/** The additive per-tenant-singleton tag on the table with this name. */
const singletonTagOf = (outcome: DiscoveryOutcome, tableName: string): unknown =>
  tableNamed(outcome, tableName)?.attributes['singletonPerTenant'];

describe('pack-sqlalchemy reads its config documents at discover time', () => {
  it('reads .gateforge/planes.json from the root in force at the discover call', async () => {
    const factoryCwd = makeProject('config-factory');
    const discoverCwd = makeProject('config-discover');
    try {
      // The document visible at factory time says master; the gated root's
      // document says tenant. The gated root wins.
      writePlanesConfig(factoryCwd, {
        rules: [{ match: 'planes/**', plane: 'master', reason: 'working-tree plane' }],
      });
      writePlanesConfig(discoverCwd, {
        rules: [{ match: 'planes/**', plane: 'tenant', reason: 'staged plane' }],
      });
      process.chdir(factoryCwd);
      const detector = createSqlalchemyDetector();
      process.chdir(discoverCwd);
      const outcome = (await detector.discover([...PLANE_FIXTURES])) as DiscoveryOutcome;
      expect(planeOf(outcome, 'planes_admin_users')).toBe('tenant');
      expect(planeOf(outcome, 'planes_erp_clients')).toBe('tenant');
      expect(outcome.findings).toEqual([]);
    } finally {
      process.chdir(ORIGINAL_CWD);
      rmSync(factoryCwd, { recursive: true, force: true });
      rmSync(discoverCwd, { recursive: true, force: true });
    }
  });

  it('an explicit planesConfig option still wins over the config document', async () => {
    const project = makeProject('explicit-config');
    try {
      writePlanesConfig(project, {
        rules: [{ match: 'planes/**', plane: 'master', reason: 'document plane' }],
      });
      const outcome = await discoverIn(project, PLANE_FIXTURES, {
        planesConfig: { rules: [{ match: 'planes/**', plane: 'global', reason: 'option plane' }] },
      });
      expect(planeOf(outcome, 'planes_admin_users')).toBe('global');
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  it('reads the .gateforge.yml tenancy block from the root in force at the discover call', async () => {
    const factoryCwd = makeProject('tenancy-factory');
    const discoverCwd = makeProject('tenancy-discover');
    try {
      // The working-tree document does not declare `contractor_id`, the
      // staged one does — so the staged root's declaration is the effective
      // one and the additive singleton tag appears. A working-tree read
      // would leave the table untagged.
      writeTenancyConfig(factoryCwd, ['unrelated_scope']);
      writeTenancyConfig(discoverCwd, ['contractor_id']);
      process.chdir(factoryCwd);
      const detector = createSqlalchemyDetector({ planesConfig: SCOPE_PLANES });
      process.chdir(discoverCwd);
      const outcome = (await detector.discover([...SCOPE_PATHS])) as DiscoveryOutcome;
      expect(singletonTagOf(outcome, SCOPE_TABLE)).toMatchObject({
        tenantColumn: 'contractor_id',
        scopeColumns: ['contractor_id'],
        columns: ['contractor_id'],
      });
    } finally {
      process.chdir(ORIGINAL_CWD);
      rmSync(factoryCwd, { recursive: true, force: true });
      rmSync(discoverCwd, { recursive: true, force: true });
    }
  });

  it('an explicit tenancyScopeColumns option still wins over the config document', async () => {
    const project = makeProject('explicit-tenancy');
    try {
      writeTenancyConfig(project, ['unrelated_scope']);
      const outcome = await discoverIn(project, SCOPE_PATHS, {
        planesConfig: SCOPE_PLANES,
        tenancyScopeColumns: ['contractor_id'],
      });
      expect(singletonTagOf(outcome, SCOPE_TABLE)).toMatchObject({
        tenantColumn: 'contractor_id',
        scopeColumns: ['contractor_id'],
        columns: ['contractor_id'],
      });
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });
});