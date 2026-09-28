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

function config(seed = false) {
  return AlembicConfigSchema.parse({
    chains: [{ name: 'invoices', migrations: 'migrations/versions', models: ['models.py'] }],
    scratch: { adminUrl },
    ...(seed
      ? {
          seed: {
            path: 'seed.sql',
            tables: [{ name: 'invoices', columns: ['id', 'customer_name', 'total_amount'], copies: [{ from: 'customer_name', to: 'client_name' }] }],
          },
        }
      : {}),
    irreversible: [],
  });
}

async function compile(root: string, options: { seed?: boolean; changedFiles?: string[]; afterCreate?: (name: string) => void } = {}) {
  return compileAlembic({
    cwd: root,
    alembic: config(options.seed),
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

postgres('engine-run Alembic obligations on disposable PostgreSQL', () => {
  it('satisfies lineage, roundtrip, and seeded rename preservation on the example chain', async () => {
    const result = await compile(fixture(), { seed: true });
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
    const result = await compile(root, { seed: true });
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
});
