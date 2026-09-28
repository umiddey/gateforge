/**
 * Subprocess boundary for the Alembic detector and roundtrip runner.
 */
import { spawnSync } from 'node:child_process';
import { pythonEnvironment } from './detector.js';

/** One parsed migration resource from the AST scanner. */
export interface ScannedMigration {
  /** Revision id. */
  revision: string;
  /** Parent revision ids. */
  downRevisions: string[];
  /** Repo-relative path. */
  relPath: string;
  /** True when downgrade() is pass or missing. */
  downgradeNoop: boolean;
  /** True when upgrade() is pass or missing. */
  upgradeNoop: boolean;
}

/** Lineage facts the compiler grades. */
export interface ScanLineage {
  /** Scanner findings (protocol shape, no host fields). */
  findings: Array<{ code: string; detail: string; locations: Array<{ file: string; line: number; col: number }> }>;
  /** Parsed migrations keyed by revision. */
  migrations: ScannedMigration[];
  /** Head revision ids. */
  heads: string[];
  /** Files the scanner read. */
  scannedPaths: string[];
}

/**
 * Runs the AST scanner. Never executes migration code.
 *
 * Args:
 *   cwd: repository root.
 *   paths: repo-relative files or directories.
 *   python: interpreter. Defaults to python3.
 *   extraPythonPath: leading PYTHONPATH entries.
 *
 * Returns:
 *   ScanLineage: revisions, heads, and findings.
 */
export function scanLineage(
  cwd: string,
  paths: readonly string[],
  python = 'python3',
  extraPythonPath: readonly string[] = [],
): ScanLineage {
  const result = spawnSync(python, ['-m', 'gateforge_alembic_detector.scan', cwd, ...paths], {
    cwd,
    encoding: 'utf8',
    env: pythonEnvironment(extraPythonPath),
    maxBuffer: 10 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error((result.stderr ?? result.stdout ?? 'alembic scan failed').trim());
  }
  const parsed = JSON.parse(result.stdout ?? '{}') as {
    findings?: ScanLineage['findings'];
    resources?: Array<{ kind?: string; source?: string; attributes?: Record<string, unknown> }>;
    scannedPaths?: string[];
  };
  const migrations: ScannedMigration[] = [];
  let heads: string[] = [];
  for (const resource of parsed.resources ?? []) {
    const attributes = resource.attributes ?? {};
    if (resource.kind === 'alembic.migration') {
      migrations.push({
        revision: String(attributes['revision'] ?? ''),
        downRevisions: Array.isArray(attributes['downRevisions'])
          ? attributes['downRevisions'].filter((item): item is string => typeof item === 'string')
          : [],
        relPath: String(resource.source ?? ''),
        downgradeNoop: attributes['downgradeNoop'] === true,
        upgradeNoop: attributes['upgradeNoop'] === true,
      });
    }
    if (resource.kind === 'alembic.chain' && Array.isArray(attributes['heads'])) {
      heads = attributes['heads'].filter((item): item is string => typeof item === 'string');
    }
  }
  return {
    findings: parsed.findings ?? [],
    migrations,
    heads,
    scannedPaths: parsed.scannedPaths ?? [],
  };
}

/** Runner result. */
export interface RunnerResult {
  /** True when the command finished without a mapped cause. */
  ok: boolean;
  /** Stable cause when `ok` is false. */
  cause?: string;
  /** Single-cause detail. */
  detail?: string;
  /** Schema snapshot, when requested. */
  snapshot?: unknown;
  /** Column fingerprints, when requested. */
  fingerprints?: Record<string, { count: number; columns: Record<string, string | null> }>;
}

/**
 * Invokes the engine-owned Python runner. The project's env.py is not used.
 *
 * Args:
 *   cwd: repository root.
 *   payload: runner command document.
 *   python: interpreter.
 *   extraPythonPath: leading PYTHONPATH entries.
 *
 * Returns:
 *   RunnerResult: parsed JSON result. A crashed runner is a failed result.
 */
export function runPython(
  cwd: string,
  payload: Record<string, unknown>,
  python = 'python3',
  extraPythonPath: readonly string[] = [],
): RunnerResult {
  const env = pythonEnvironment(extraPythonPath);
  delete env['DATABASE_URL'];
  delete env['SQLALCHEMY_URL'];
  const result = spawnSync(python, ['-m', 'gateforge_alembic_detector.runner'], {
    cwd,
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env,
    maxBuffer: 10 * 1024 * 1024,
  });
  if (result.status !== 0 && (result.stdout ?? '').trim() === '') {
    const detail =
      result.error?.message ??
      (result.stderr ?? '').trim().split('\n').filter(Boolean).at(-1) ??
      (result.signal === null
        ? `Alembic runner exited with status ${String(result.status)} without a result`
        : `Alembic runner terminated by ${result.signal}`);
    return {
      ok: false,
      cause: 'MIGRATION_ROUNDTRIP_FAILED',
      detail,
    };
  }
  try {
    return JSON.parse(result.stdout ?? '{}') as RunnerResult;
  } catch {
    return {
      ok: false,
      cause: 'MIGRATION_ROUNDTRIP_FAILED',
      detail: (result.stderr ?? result.stdout ?? 'runner returned non-JSON').trim().slice(0, 500),
    };
  }
}
