/**
 * Discover-time config resolution — the staged gate's correctness hinge.
 *
 * `gateforge check --staged` moves the process cwd to the staged candidate
 * checkout before discovery runs, so every config document the detector
 * reads (`.gateforge/planes.json`, the `.gateforge.yml` tenancy block)
 * must come from the root in force at the DISCOVER call — the gated bytes,
 * not the user's working-tree config. pack-sqlalchemy already resolved
 * both channels per call; this suite pins that so a future refactor back
 * to a factory-time capture (the pack-fastapi defect) is caught here, and
 * pins that an explicit option still wins over the document.
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

/** A tenant-plane table whose unique constraint covers `contractor_id`. */
const CONTRACTOR_FIXTURE = 'singleton_contractor_scope.py';

/**
 * The reviewed plane decision for the contractor fixture. The
 * per-tenant-singleton tag needs BOTH facts: reviewed plane evidence of
 * `tenant` (the plane channel) and a DECLARED scope column (the tenancy
 * channel under test) — the fixed default list does not recognize
 * `contractor_id`.
 */
const CONTRACTOR_PLANES: PlanesConfig = {
  rules: [
    {
      tables: ['contractor_ledger_entries', 'contractor_ledgers'],
      plane: 'tenant',
      reason: 'each table carries a contractor_id scope column',
    },
  ],
};

/** A temp project with the plane fixtures (plus any extras) copied in. */
function makeProject(name: string, extraFixtures: readonly string[] = []): string {
  const root = mkdtempSync(join(tmpdir(), `gateforge-sqlalchemy-config-${name}-`));
  for (const relative of [...PLANE_FIXTURES, ...extraFixtures]) {
    const absolute = join(root, relative);
    mkdirSync(dirname(absolute), { recursive: true });
    cpSync(join(FIXTURE_ROOT, relative), absolute);
  }
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
    const factoryCwd = makeProject('tenancy-factory', [CONTRACTOR_FIXTURE]);
    const discoverCwd = makeProject('tenancy-discover', [CONTRACTOR_FIXTURE]);
    try {
      // The working-tree document does not declare `contractor_id`, the
      // staged one does — so the staged root's declaration is the effective
      // one and the additive singleton tag appears. A working-tree read
      // would leave the table untagged.
      writeTenancyConfig(factoryCwd, ['unrelated_scope']);
      writeTenancyConfig(discoverCwd, ['contractor_id']);
      process.chdir(factoryCwd);
      const detector = createSqlalchemyDetector({ planesConfig: CONTRACTOR_PLANES });
      process.chdir(discoverCwd);
      const outcome = (await detector.discover([
        ...PLANE_FIXTURES,
        CONTRACTOR_FIXTURE,
      ])) as DiscoveryOutcome;
      expect(singletonTagOf(outcome, 'contractor_ledger_entries')).toMatchObject({
        tenantColumn: 'contractor_id',
      });
    } finally {
      process.chdir(ORIGINAL_CWD);
      rmSync(factoryCwd, { recursive: true, force: true });
      rmSync(discoverCwd, { recursive: true, force: true });
    }
  });

  it('an explicit tenancyScopeColumns option still wins over the config document', async () => {
    const project = makeProject('explicit-tenancy', [CONTRACTOR_FIXTURE]);
    try {
      writeTenancyConfig(project, ['unrelated_scope']);
      const outcome = await discoverIn(project, [...PLANE_FIXTURES, CONTRACTOR_FIXTURE], {
        planesConfig: CONTRACTOR_PLANES,
        tenancyScopeColumns: ['contractor_id'],
      });
      expect(singletonTagOf(outcome, 'contractor_ledger_entries')).toMatchObject({
        tenantColumn: 'contractor_id',
      });
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });
});