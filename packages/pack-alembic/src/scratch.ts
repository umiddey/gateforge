/**
 * Disposable Postgres databases for Alembic obligations.
 *
 * The engine creates and drops only names that start with `gf_tmp_`.
 * The admin URL comes from trusted configuration. This module never
 * reads `DATABASE_URL` or any other environment variable.
 */
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';

/** Prefix every engine-created database name must carry. */
export const SCRATCH_PREFIX = 'gf_tmp_';

/** Thrown when a database name or URL is not a disposable scratch database. */
export class ScratchUnsafeError extends Error {
  /**
   * Builds one scratch-safety error.
   *
   * Args:
   *   message: single-cause explanation.
   */
  constructor(message: string) {
    super(message);
    this.name = 'ScratchUnsafeError';
  }
}

/**
 * Whether a database name is an engine-created scratch database.
 *
 * Args:
 *   name: database name, not a URL.
 *
 * Returns:
 *   boolean: true only for `gf_tmp_` plus lowercase hex.
 */
export function isScratchDatabaseName(name: string): boolean {
  return /^gf_tmp_[a-f0-9]{8,}$/.test(name);
}

/**
 * Replaces the database name in a postgres URL.
 *
 * Args:
 *   adminUrl: trusted admin URL from configuration.
 *   name: scratch database name.
 *
 * Returns:
 *   string: URL pointing at `name`.
 */
export function urlForDatabase(adminUrl: string, name: string): string {
  if (!isScratchDatabaseName(name)) {
    throw new ScratchUnsafeError(`refusing database name '${name}'`);
  }
  const parsed = new URL(adminUrl);
  parsed.pathname = `/${name}`;
  return parsed.toString();
}

/**
 * Runs psql against the admin URL. Never consults the process environment
 * for a database URL.
 *
 * Args:
 *   adminUrl: trusted admin URL.
 *   sql: one SQL statement.
 *
 * Returns:
 *   void: throws when psql exits non-zero.
 */
function psql(adminUrl: string, sql: string): void {
  const result = spawnSync('psql', [adminUrl, '-v', 'ON_ERROR_STOP=1', '-c', sql], {
    encoding: 'utf8',
    env: { PATH: process.env['PATH'] ?? '', HOME: process.env['HOME'] ?? '' },
  });
  if (result.error !== undefined) {
    throw new ScratchUnsafeError(`cannot run psql: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const detail = (result.stderr ?? result.stdout ?? '').trim().split('\n')[0] ?? 'psql failed';
    throw new ScratchUnsafeError(detail);
  }
}

/**
 * Creates a disposable database from a trusted admin URL.
 *
 * Args:
 *   adminUrl: trusted admin URL. Not read from the environment.
 *
 * Returns:
 *   object: scratch name and URL. The caller must drop the database.
 */
export function createScratchDatabase(adminUrl: string): { name: string; url: string } {
  if (!adminUrl.startsWith('postgresql://') && !adminUrl.startsWith('postgres://')) {
    throw new ScratchUnsafeError('scratch adminUrl must be a postgresql URL from trusted configuration');
  }
  const name = `${SCRATCH_PREFIX}${randomBytes(8).toString('hex')}`;
  if (!isScratchDatabaseName(name)) {
    throw new ScratchUnsafeError(`refusing database name '${name}'`);
  }
  psql(adminUrl, `CREATE DATABASE ${name}`);
  return { name, url: urlForDatabase(adminUrl, name) };
}

/**
 * Drops a disposable database. Refuses any name that is not `gf_tmp_`.
 *
 * Args:
 *   adminUrl: trusted admin URL.
 *   name: database name to drop.
 *
 * Returns:
 *   void: the database is gone, or the call throws before touching it.
 */
export function dropScratchDatabase(adminUrl: string, name: string): void {
  if (!isScratchDatabaseName(name)) {
    throw new ScratchUnsafeError(`refusing to drop database '${name}'`);
  }
  psql(adminUrl, `DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
}

/**
 * Whether a scratch database still exists.
 *
 * Args:
 *   adminUrl: trusted admin URL.
 *   name: database name.
 *
 * Returns:
 *   boolean: true when the catalog lists the name.
 */
export function scratchDatabaseExists(adminUrl: string, name: string): boolean {
  if (!isScratchDatabaseName(name)) return false;
  const result = spawnSync(
    'psql',
    [adminUrl, '-v', 'ON_ERROR_STOP=1', '-tAc', `SELECT 1 FROM pg_database WHERE datname = '${name}'`],
    { encoding: 'utf8', env: { PATH: process.env['PATH'] ?? '', HOME: process.env['HOME'] ?? '' } },
  );
  return (result.stdout ?? '').trim() === '1';
}
