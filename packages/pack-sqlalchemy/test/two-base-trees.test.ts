/**
 * Two-declarative-base trees (the recorded consumer gap, 2026-09-15):
 * the ERP consumer keeps tenant models and admin-platform models on two
 * SEPARATE `declarative_base()` factories that share the variable name
 * `Base` across modules. These tests pin, through the REAL python
 * detector, that:
 * - both trees emit `sqlalchemy.table` resources with their own table
 *   names, primary keys, and per-module Base resolution (no cross-tree
 *   contamination through the shared variable name);
 * - `__gateforge_delete_semantics__` / `__gateforge_archive_state__`
 *   declarations become delete-semantics/archive-state signals scoped
 *   to the declaring table only;
 * - a real table whose tree never declared delete semantics (the
 *   consumer's exact gap shape) still emits table + identity facts but
 *   NO delete-semantics signal — the classifier then fail-closes it
 *   (proven at the core level, `master-plane-admin-tables.test.ts`),
 *   and the repair is the owner's declaration, never a detector guess.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cpSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DiscoveryOutcome } from '@gate-forge/plugin-protocol';
import { createSqlalchemyDetector, type PlaneConfigRule } from '../src/index.js';
import { FIXTURE_ROOT } from './helpers.js';

type ClassificationSignal = DiscoveryOutcome['classificationSignals'][number];

const ORIGINAL_CWD = process.cwd();

/** Fixture files copied into every temp project (repo-relative). */
const TWOBASE_FIXTURES: Readonly<Record<string, string>> = {
  'twobase/tenant/models_base.py': 'twobase/tenant/models_base.py',
  'twobase/tenant/account.py': 'twobase/tenant/account.py',
  'twobase/admin/base.py': 'twobase/admin/base.py',
  'twobase/admin/platform_user.py': 'twobase/admin/platform_user.py',
  'twobase/admin/client_instance.py': 'twobase/admin/client_instance.py',
};

/** Builds a temp project with the two-Base fixtures copied to `dir/`. */
function makeProject(): string {
  const project = mkdtempSync(join(tmpdir(), 'gateforge-twobase-'));
  for (const relative of Object.keys(TWOBASE_FIXTURES)) {
    mkdirSync(dirname(join(project, relative)), { recursive: true });
    cpSync(join(FIXTURE_ROOT, relative), join(project, relative));
  }
  return project;
}

/** Discovers the whole tree with per-path plane rules (consumer shape). */
async function discoverIn(project: string): Promise<DiscoveryOutcome> {
  process.chdir(project);
  try {
    const rules: PlaneConfigRule[] = [
      { match: 'twobase/admin/**', plane: 'master', reason: 'control-plane models' },
      { match: 'twobase/tenant/**', plane: 'tenant', reason: 'tenant workspace models' },
    ];
    return (await createSqlalchemyDetector({ planesConfig: { rules } }).discover([
      'twobase/tenant/models_base.py',
      'twobase/tenant/account.py',
      'twobase/admin/base.py',
      'twobase/admin/platform_user.py',
      'twobase/admin/client_instance.py',
    ])) as DiscoveryOutcome;
  } finally {
    process.chdir(ORIGINAL_CWD);
  }
}

type TableResource = DiscoveryOutcome['resources'][number];

const tablesOf = (outcome: DiscoveryOutcome): TableResource[] =>
  outcome.resources.filter((resource) => resource.kind === 'sqlalchemy.table');
const byTable = (outcome: DiscoveryOutcome, name: string): TableResource | undefined =>
  tablesOf(outcome).find((resource) => resource.attributes['resourceName'] === name);
const signalsFor = (outcome: DiscoveryOutcome, table: string): ClassificationSignal[] =>
  outcome.classificationSignals.filter(
    (signal): signal is ClassificationSignal =>
      (signal.target as { resourceName?: string }).resourceName === table,
  );

describe('two declarative-base trees (consumer admin-platform shape)', () => {
  let project: string;
  beforeEach(() => {
    project = makeProject();
  });
  afterEach(() => {
    rmSync(project, { recursive: true, force: true });
  });

  it('emits both same-named Base factories without cross-tree contamination', async () => {
    const outcome = await discoverIn(project);
    expect(outcome.findings).toEqual([]);
    const accounts = byTable(outcome, 'twobase_accounts');
    const users = byTable(outcome, 'twobase_platform_users');
    const clients = byTable(outcome, 'twobase_client_instances');
    expect(accounts).toBeDefined();
    expect(users).toBeDefined();
    expect(clients).toBeDefined();
    // Per-file Base resolution: each tree's models carry only their own
    // facts (the shared `Base` variable name never merges the trees).
    expect(users?.attributes['baseNames']).toEqual(['Base']);
    expect(accounts?.attributes['baseNames']).toEqual(['Base']);
    // Literal primary keys resolve as identity facts per table.
    expect(users?.attributes['primaryKeyColumns']).toEqual(['id']);
    expect(clients?.attributes['primaryKeyColumns']).toEqual(['id']);
  });

  it('scopes delete declarations to the declaring table and attaches planes per path', async () => {
    const outcome = await discoverIn(project);
    // Hard declaration on the admin model…
    const userSignals = signalsFor(outcome, 'twobase_platform_users');
    expect(
      userSignals.some(
        (signal) => signal.dimension === 'delete-semantics' && signal.assertion === 'hard',
      ),
    ).toBe(true);
    // …archive declaration + archived state on the tenant model…
    const accountSignals = signalsFor(outcome, 'twobase_accounts');
    expect(
      accountSignals.some(
        (signal) => signal.dimension === 'delete-semantics' && signal.assertion === 'archive',
      ),
    ).toBe(true);
    expect(accountSignals.some((signal) => signal.dimension === 'archive-state')).toBe(true);
    // …and NOTHING declared for the unmarked admin table (the consumer
    // gap shape): real table, real key, no delete-semantics evidence.
    expect(signalsFor(outcome, 'twobase_client_instances').map((signal) => signal.dimension)).not.toContain(
      'delete-semantics',
    );
    // Class-derived declarations are SYMBOL-SCOPED to the declaring
    // class: a same-named table in another module/plane can never
    // inherit them (the consumer's cross-plane leak, fixed 2026-09-15).
    const declaration = userSignals.find((signal) => signal.dimension === 'delete-semantics');
    expect(declaration?.target).toMatchObject({
      resourceName: 'twobase_platform_users',
      symbol: expect.stringContaining('TwobasePlatformUser'),
    });
    // Plane rules land on table resources, never on class symbols.
    expect(byTable(outcome, 'twobase_platform_users')?.attributes['plane']).toBe('master');
    expect(byTable(outcome, 'twobase_client_instances')?.attributes['plane']).toBe('master');
    expect(byTable(outcome, 'twobase_accounts')?.attributes['plane']).toBe('tenant');
  });
});
