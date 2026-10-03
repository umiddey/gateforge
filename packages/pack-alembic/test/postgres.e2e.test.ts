import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { appendFileSync, cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { AlembicConfigSchema } from '@gate-forge/core';
import { compileAlembic, scratchDatabaseExists } from '../src/index.js';

const adminUrl = process.env['GATEFORGE_ALEMBIC_TEST_ADMIN_URL'];
const python = process.env['GATEFORGE_ALEMBIC_TEST_PYTHON'] ?? 'python3';
const example = fileURLToPath(new URL('../../../examples/alembic/', import.meta.url));
const roots: string[] = [];

if (adminUrl === undefined || adminUrl.trim() === '') {
  console.warn('[pack-alembic] PostgreSQL integration tests skipped: set GATEFORGE_ALEMBIC_TEST_ADMIN_URL to a disposable PostgreSQL admin URL.');
}

const postgres = adminUrl === undefined || adminUrl.trim() === '' ? describe.skip : describe;

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'gf-alembic-postgres-'));
  roots.push(root);
  cpSync(example, root, { recursive: true });
  return root;
}

/** Declared tables per seed fixture. `rename` seeds before the rename, `merged` after it. */
const SEED_TABLES = {
  rename: [{ name: 'invoices', columns: ['id', 'customer_name', 'total_amount'], copies: [{ from: 'customer_name', to: 'client_name' }] }],
  merged: [{ name: 'invoices', columns: ['id', 'client_name', 'total_amount'] }],
} as const;

/**
 * Builds a validated pack configuration.
 *
 * Args:
 *   options: seed fixture variant and optional merge target ref.
 *
 * Returns:
 *   object: schema-valid Alembic configuration for the example app.
 */
function config(options: { seed?: keyof typeof SEED_TABLES; mergeRef?: string } = {}) {
  return AlembicConfigSchema.parse({
    chains: [{ name: 'invoices', migrations: 'migrations/versions', models: ['models.py'] }],
    scratch: { adminUrl },
    ...(options.seed === undefined
      ? {}
      : { seed: { path: 'seed.sql', tables: SEED_TABLES[options.seed] } }),
    ...(options.mergeRef === undefined ? {} : { merge: { targetRef: options.mergeRef } }),
    irreversible: [],
  });
}

/**
 * Runs the compiler against a fixture root.
 *
 * Args:
 *   root: fixture directory.
 *   options: seed fixture variant, merge target ref, changed files, and the post-create seam.
 *
 * Returns:
 *   Promise<AlembicCompileResult>: obligations, blocking findings, and witness records.
 */
async function compile(
  root: string,
  options: { seed?: keyof typeof SEED_TABLES; mergeRef?: string; changedFiles?: string[]; afterCreate?: (name: string) => void } = {},
) {
  return compileAlembic({
    cwd: root,
    alembic: config(options),
    changedFiles: options.changedFiles ?? [],
    now: '2026-09-28T00:00:00.000Z',
    python,
    afterCreate: options.afterCreate,
  });
}

function runPsql(databaseUrl: string, sql: string): string {
  const result = spawnSync('psql', [databaseUrl, '-v', 'ON_ERROR_STOP=1', '-tAc', sql], {
    encoding: 'utf8',
    env: { PATH: process.env['PATH'] ?? '', HOME: process.env['HOME'] ?? '' },
  });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || 'psql failed');
  return (result.stdout ?? '').trim();
}

function passedContracts(result: Awaited<ReturnType<typeof compile>>): string[] {
  const contracts: string[] = [];
  for (const record of result.records) {
    const payload = record.payload as Record<string, unknown> | null;
    if (payload !== null && payload['passed'] === true && typeof payload['contract'] === 'string') {
      contracts.push(payload['contract']);
    }
  }
  return contracts.sort();
}

/** Branch A revision: backfills notes on the `invoices` table. */
const BRANCH_A_REVISION = `"""003f_backfill_notes

Revision ID: 003f_backfill_notes
Revises: 002_rename_customer

"""
from alembic import op

revision: str = '003f_backfill_notes'
down_revision: str = '002_rename_customer'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("UPDATE invoices SET notes = 'branch-a' WHERE notes IS NULL")


def downgrade() -> None:
    op.execute("UPDATE invoices SET notes = NULL WHERE notes = 'branch-a'")
`;

/** Branch B revision: backfills status on the same table. */
const BRANCH_B_REVISION = `"""003t_backfill_status

Revision ID: 003t_backfill_status
Revises: 002_rename_customer

"""
from alembic import op

revision: str = '003t_backfill_status'
down_revision: str = '002_rename_customer'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("UPDATE invoices SET status = 'open' WHERE status = 'draft'")


def downgrade() -> None:
    op.execute("UPDATE invoices SET status = 'draft' WHERE status = 'open'")
`;

/** Merge revision: adds a NOT NULL column, which seeded rows cannot satisfy. */
const MERGE_REVISION = `"""004_merge_branches

Revision ID: 004_merge_branches
Revises: 003f_backfill_notes, 003t_backfill_status

"""
from alembic import op
import sqlalchemy as sa

revision: str = '004_merge_branches'
down_revision = ('003f_backfill_notes', '003t_backfill_status')
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column('invoices', sa.Column('region_code', sa.String(), nullable=False))


def downgrade() -> None:
    op.drop_column('invoices', 'region_code')
`;

/** Seed the target branch owns, written against the renamed column. */
const MERGED_SEED = `INSERT INTO invoices (id, client_name, total_amount, status)
VALUES ('invoice-001', 'Ada Lovelace', 1250, 'draft');
INSERT INTO invoices (id, client_name, total_amount, status)
VALUES ('invoice-002', 'Grace Hopper', 840, 'open');
INSERT INTO invoices (id, client_name, total_amount, status)
VALUES ('invoice-003', 'Karen Sparck Jones', 2600, 'open');
`;

/**
 * Runs a git command inside a fixture repository.
 *
 * Args:
 *   root: fixture directory.
 *   args: git arguments without the leading `git`.
 *
 * Returns:
 *   void: throws when git fails.
 */
function git(root: string, ...args: string[]): void {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${(result.stderr || result.stdout || '').trim()}`);
  }
}

/**
 * Builds a repository with two branches that each alter the same table.
 *
 * `main` carries the target-branch seed fixture; `feature` carries a
 * competing revision on the same `invoices` table. Neither branch has
 * merged the other yet.
 *
 * Returns:
 *   string: fixture root, checked out on `feature`.
 */
function twoBranchFixture(): string {
  const root = fixture();
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.email', 'gateforge@example.invalid');
  git(root, 'config', 'user.name', 'Gateforge Test');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'base chain');
  git(root, 'checkout', '-q', '-b', 'feature');
  writeFileSync(join(root, 'migrations/versions/003f_backfill_notes.py'), BRANCH_A_REVISION);
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'branch a backfills notes');
  git(root, 'checkout', '-q', 'main');
  writeFileSync(join(root, 'migrations/versions/003t_backfill_status.py'), BRANCH_B_REVISION);
  writeFileSync(join(root, 'seed.sql'), MERGED_SEED);
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'branch b backfills status and owns the seed');
  git(root, 'checkout', '-q', 'feature');
  return root;
}

/**
 * Merges the target branch into the feature branch and adds the merge revision.
 *
 * Args:
 *   root: two-branch fixture root.
 *
 * Returns:
 *   void: the fixture now holds a single head on top of both branches.
 */
function mergeTargetIntoFeature(root: string): void {
  git(root, 'merge', '-q', '--no-ff', '-m', 'merge main into feature', 'main');
  writeFileSync(join(root, 'migrations/versions/004_merge_branches.py'), MERGE_REVISION);
  const models = join(root, 'models.py');
  writeFileSync(
    models,
    readFileSync(models, 'utf8').replace(
      '    notes = Column(Text, nullable=True)',
      "    notes = Column(Text, nullable=True)\n    region_code = Column(String, nullable=False)",
    ),
  );
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'merge revision');
}

postgres('engine-run Alembic obligations on disposable PostgreSQL', () => {
  it('satisfies lineage, roundtrip, and seeded rename preservation on the example chain', async () => {
    const result = await compile(fixture(), { seed: 'rename' });
    expect(result.blocking.map((item) => item.cause)).toEqual([]);
    expect(passedContracts(result)).toEqual([
      'alembic:data-preserved', 'alembic:lineage-intact', 'alembic:roundtrip-verified',
    ]);
  });

  it('blocks a changed model without a new migration', async () => {
    const result = await compile(fixture(), { changedFiles: ['models.py'] });
    expect(result.blocking.map((item) => item.cause)).toContain('MIGRATION_MISSING');
  });

  it('blocks a no-op downgrade and model drift for their specific causes', async () => {
    const noOp = fixture();
    const revision = join(noOp, 'migrations/versions/002_rename_customer.py');
    writeFileSync(revision, readFileSync(revision, 'utf8').replace("op.alter_column('invoices', 'client_name', new_column_name='customer_name')", 'pass'));
    const noOpResult = await compile(noOp);
    expect(noOpResult.blocking.map((item) => item.cause)).toContain('MIGRATION_DOWNGRADE_NOOP');

    const drift = fixture();
    appendFileSync(join(drift, 'models.py'), "\nInvoice.__table__.append_column(Column('unmapped_field', String, nullable=True))\n");
    const driftResult = await compile(drift, { changedFiles: ['models.py'] });
    expect(driftResult.blocking.map((item) => item.cause)).toContain('MIGRATION_DRIFT');
  });

  it('blocks a destructive rename after seeding the previous revision', async () => {
    const root = fixture();
    const revision = join(root, 'migrations/versions/002_rename_customer.py');
    writeFileSync(revision, `from alembic import op\nimport sqlalchemy as sa\nrevision = '002_rename_customer'\ndown_revision = '001_initial'\nbranch_labels = None\ndepends_on = None\ndef upgrade():\n    op.add_column('invoices', sa.Column('client_name', sa.String(), nullable=True))\n    op.drop_column('invoices', 'customer_name')\ndef downgrade():\n    op.add_column('invoices', sa.Column('customer_name', sa.String(), nullable=True))\n    op.drop_column('invoices', 'client_name')\n`);
    const result = await compile(root, { seed: 'rename' });
    expect(result.blocking.map((item) => item.cause)).toContain('MIGRATION_DATA_LOST');
  });

  it('drops only the recorded per-run scratch id and leaves similar and app databases intact', async () => {
    const root = fixture();
    const appName = `gfapp_guard_${randomBytes(5).toString('hex')}`;
    const appUrl = new URL(adminUrl as string);
    appUrl.pathname = `/${appName}`;
    const similarName = `gf_tmp_${randomBytes(8).toString('hex')}`;
    let createdName = '';
    const previousDatabaseUrl = process.env['DATABASE_URL'];
    runPsql(adminUrl as string, `CREATE DATABASE ${appName}`);
    runPsql(adminUrl as string, `CREATE DATABASE ${similarName}`);
    runPsql(appUrl.toString(), "CREATE TABLE gateforge_guard (value text NOT NULL); INSERT INTO gateforge_guard VALUES ('untouched')");
    process.env['DATABASE_URL'] = appUrl.toString();
    try {
      const result = await compile(root, {
        afterCreate(name) {
          createdName = name;
        },
      });
      expect(result.blocking).toEqual([]);
      expect(createdName).toMatch(/^gf_tmp_[a-f0-9]{16}$/);
      expect(scratchDatabaseExists(adminUrl as string, createdName)).toBe(false);
      expect(scratchDatabaseExists(adminUrl as string, similarName)).toBe(true);
      expect(runPsql(appUrl.toString(), 'SELECT value FROM gateforge_guard')).toBe('untouched');
    } finally {
      if (previousDatabaseUrl === undefined) delete process.env['DATABASE_URL'];
      else process.env['DATABASE_URL'] = previousDatabaseUrl;
      runPsql(adminUrl as string, `DROP DATABASE IF EXISTS ${appName} WITH (FORCE)`);
      runPsql(adminUrl as string, `DROP DATABASE IF EXISTS ${similarName} WITH (FORCE)`);
    }
  });

  it('drops the engine-created database after an injected post-create failure', async () => {
    let createdName = '';
    const result = await compile(fixture(), {
      afterCreate(name) {
        createdName = name;
        throw new Error('injected integration failure');
      },
    });
    expect(result.blocking.map((item) => item.cause)).toContain('MIGRATION_ROUNDTRIP_FAILED');
    expect(createdName).toMatch(/^gf_tmp_[a-f0-9]{16}$/);
    expect(scratchDatabaseExists(adminUrl as string, createdName)).toBe(false);
  });

  it('blocks the merge result of two branches that alter the same table, then blocks its merge revision on seeded rows', async () => {
    const root = twoBranchFixture();

    const branchA = await compile(root);
    expect(branchA.blocking.map((item) => item.cause)).toEqual([]);
    expect(passedContracts(branchA)).toContain('alembic:roundtrip-verified');

    git(root, 'checkout', '-q', 'main');
    const branchB = await compile(root);
    expect(branchB.blocking.map((item) => item.cause)).toEqual([]);
    expect(passedContracts(branchB)).toContain('alembic:roundtrip-verified');

    git(root, 'checkout', '-q', 'feature');
    const twoHeads = await compile(root, { mergeRef: 'main' });
    const conflict = twoHeads.blocking.filter((item) => item.cause === 'MIGRATION_CONFLICT');
    expect(conflict).toHaveLength(1);
    expect(conflict[0]?.detail).toContain('003f_backfill_notes');
    expect(conflict[0]?.detail).toContain('003t_backfill_status');
    expect(passedContracts(twoHeads)).not.toContain('alembic:merge-clean');

    mergeTargetIntoFeature(root);
    const merged = await compile(root, { mergeRef: 'main', seed: 'merged' });
    expect(passedContracts(merged)).toContain('alembic:merge-clean');
    const dataFailure = merged.blocking.filter((item) => item.detail?.includes('region_code') === true);
    expect(dataFailure.map((item) => item.cause)).toContain('MIGRATION_ROUNDTRIP_FAILED');
    expect(passedContracts(merged)).not.toContain('alembic:data-preserved');
  }, 120_000);
});
