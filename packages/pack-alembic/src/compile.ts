/**
 * Compiles opt-in Alembic obligations and engine-run witness records.
 *
 * Static lineage is an engine-executed parse, never a suite claim.
 * Roundtrip, data preservation, and merge safety require a disposable
 * database the engine creates and drops. A passing record is issued only
 * after that execution.
 */
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { CAUSE_NEXT_ACTIONS, recordIdOf, type AlembicConfig, type BlockingEntry, type EvidenceRecord, type Obligation } from '@gate-forge/core';
import { runPython, scanLineage, type RunnerResult, type ScanLineage, type ScannedMigration } from './execute.js';
import { createScratchDatabase, dropScratchDatabase, isScratchDatabaseName, ScratchUnsafeError } from './scratch.js';

/** Obligation contract: one head, no duplicate ids, no dangling parents. */
export const ALEMBIC_LINEAGE_INTACT = 'alembic:lineage-intact';

/** Obligation contract: upgrade, downgrade base, upgrade, schema equal, alembic check clean. */
export const ALEMBIC_ROUNDTRIP_VERIFIED = 'alembic:roundtrip-verified';

/** Obligation contract: declared row counts and column fingerprints survive. */
export const ALEMBIC_DATA_PRESERVED = 'alembic:data-preserved';

/** Obligation contract: the merge result has one head and a clean roundtrip. */
export const ALEMBIC_MERGE_CLEAN = 'alembic:merge-clean';

/** Policy id stamped on every Alembic obligation. */
export const ALEMBIC_POLICY_ID = 'alembic.migration-obligations';

/** Evidence kind issued only by this engine path. */
export const ALEMBIC_WITNESS_KIND = 'alembic.witness';

/** Stable engine test id. Suite claims cannot mint this producer. */
export const ALEMBIC_ENGINE_TEST_ID = 'gateforge.engine.alembic';

/** Lifecycle carried on Alembic obligations. Not a CRUD grant. */
const LIFECYCLE = { create: false, read: true, update: false, delete: false } as const;

/** One compiled chain. */
export interface AlembicCompileResult {
  /** Obligations that must be proven by engine records. */
  obligations: Obligation[];
  /** Blocking findings with additive cause codes. */
  blocking: BlockingEntry[];
  /** Engine-observed records for this run only. */
  records: EvidenceRecord[];
  /** Source files used to diff-scope each chain resource. */
  sources: Record<string, string[]>;
  /** Owner-visible notes, including pinned irreversible revisions. */
  notices: string[];
  /** Wall-clock milliseconds spent in database execution. */
  durationMs: number;
}

/**
 * Matches a repo-relative path against a simple glob (`*`, `**`).
 *
 * Args:
 *   glob: configured model glob.
 *   path: posix repo-relative path.
 *
 * Returns:
 *   boolean: true when the path matches.
 */
export function globMatches(glob: string, path: string): boolean {
  const escaped = glob
    .split('**')
    .map((part) => part.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*'))
    .join('.*');
  return new RegExp(`^${escaped}$`).test(path);
}

/**
 * sha256 of migration file bytes, path-sorted.
 *
 * Args:
 *   cwd: repository root.
 *   files: repo-relative migration files.
 *
 * Returns:
 *   string: 64-char lowercase hex digest.
 */
export function filesDigest(cwd: string, files: readonly string[]): string {
  const hash = createHash('sha256');
  for (const file of [...files].sort()) {
    hash.update(file);
    hash.update('\0');
    hash.update(readFileSync(join(cwd, file)));
    hash.update('\0');
  }
  return hash.digest('hex');
}

/**
 * Builds one obligation for a chain resource.
 *
 * Args:
 *   resourceId: `alembic.chain.<name>`.
 *   contract: Alembic contract name.
 *
 * Returns:
 *   Obligation: schema-valid obligation.
 */
function obligation(resourceId: string, contract: string): Obligation {
  return {
    schemaVersion: 1,
    id: `${resourceId}:${contract}`,
    resourceId,
    contract,
    policyId: ALEMBIC_POLICY_ID,
    lifecycle: { ...LIFECYCLE },
  };
}

/**
 * Builds one blocking entry.
 *
 * Args:
 *   cause: additive migration cause code.
 *   detail: single-cause explanation.
 *   resourceId: chain resource id, or null.
 *   file: repo-relative file, when known.
 *
 * Returns:
 *   BlockingEntry: report-ready finding.
 */
function block(
  cause: BlockingEntry['cause'],
  detail: string,
  resourceId: string | null,
  file: string | null,
): BlockingEntry {
  return {
    kind: 'finding',
    resourceId,
    name: resourceId,
    detail,
    location: file === null ? null : { file, line: 1, col: 0 },
    cause,
    nextAction: cause === null || cause === undefined ? null : CAUSE_NEXT_ACTIONS[cause],
  };
}

/**
 * Issues one engine-observed witness record.
 *
 * Args:
 *   runId: run manifest id.
 *   now: injected clock instant.
 *   obligationId: obligation the record proves or fails.
 *   payload: JSON payload including contract, passed, and filesDigest.
 *
 * Returns:
 *   EvidenceRecord: provenance-valid witnessed record.
 */
function witnessRecord(
  runId: string,
  now: string,
  obligationId: string,
  payload: Record<string, unknown>,
): EvidenceRecord {
  const body = {
    runId,
    obligationId,
    kind: ALEMBIC_WITNESS_KIND,
    testId: ALEMBIC_ENGINE_TEST_ID,
    origin: 'engine-observed' as const,
    payload,
  };
  return {
    schemaVersion: 1,
    recordId: recordIdOf(body),
    trust: 'witnessed',
    issuedAt: now,
    ...body,
  };
}

/**
 * Resolves a chain's versions directory and model import.
 *
 * Args:
 *   cwd: repository root.
 *   chain: one configured chain.
 *
 * Returns:
 *   object: absolute versions dir, module name, metadata path, and relative dir.
 */
/** Resolved locations for one configured chain. */
export interface ChainLocation {
  /** Absolute versions directory. */
  versionsDir: string;
  /** Repo-relative versions directory. */
  relativeDir: string;
  /** Importable metadata module. */
  modelsModule: string;
  /** Metadata attribute path. */
  metadataAttr: string;
}

/**
 * Resolves a chain's versions directory and model import.
 *
 * Args:
 *   cwd: repository root.
 *   chain: one configured chain.
 *
 * Returns:
 *   ChainLocation: absolute versions dir, module name, and metadata path.
 */
function chainPaths(cwd: string, chain: AlembicConfig['chains'][number]): ChainLocation {
  const relativeDir = chain.migrations.replace(/\\/g, '/').replace(/^\.\//, '');
  const firstModel = chain.models[0] ?? 'models.py';
  const moduleFromFile = firstModel.replace(/\\/g, '/').replace(/\.py$/, '').replace(/\//g, '.');
  return {
    versionsDir: resolve(cwd, relativeDir),
    relativeDir,
    modelsModule: chain.modelsModule ?? moduleFromFile,
    metadataAttr: chain.metadata ?? 'Base.metadata',
  };
}

/**
 * Creates a detached worktree and merges the target ref into it.
 *
 * Args:
 *   cwd: repository root.
 *   targetRef: git ref to merge.
 *
 * Returns:
 *   object: worktree directory, merge status, and a cleanup function.
 */
export function mergeTargetWorktree(
  cwd: string,
  targetRef: string,
): { dir: string; status: number; stderr: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'gf-alembic-merge-'));
  const cleanup = (): void => {
    spawnSync('git', ['worktree', 'remove', '--force', dir], { cwd, encoding: 'utf8' });
    rmSync(dir, { recursive: true, force: true });
  };
  const added = spawnSync('git', ['worktree', 'add', '--detach', dir, 'HEAD'], { cwd, encoding: 'utf8' });
  if (added.status !== 0) {
    cleanup();
    return { dir, status: added.status ?? 1, stderr: (added.stderr ?? '').trim(), cleanup: () => undefined };
  }
  const merged = spawnSync('git', ['merge', '--no-commit', '--no-ff', targetRef], { cwd: dir, encoding: 'utf8' });
  return { dir, status: merged.status ?? 1, stderr: (merged.stderr ?? merged.stdout ?? '').trim(), cleanup };
}

/**
 * Runs upgrade → downgrade base → upgrade and compares schema snapshots.
 *
 * Args:
 *   cwd: tree whose models and versions are executed.
 *   versionsDir: absolute versions directory.
 *   modelsModule: importable metadata module.
 *   metadataAttr: metadata attribute path.
 *   scratchUrl: disposable database URL.
 *   python: interpreter.
 *   extraPythonPath: extra PYTHONPATH entries.
 *   skipDowngrade: owner-pinned irreversible chain.
 *
 * Returns:
 *   RunnerResult: ok, or a mapped cause.
 */
export function executeRoundtrip(options: {
  cwd: string;
  versionsDir: string;
  modelsModule: string;
  metadataAttr: string;
  scratchUrl: string;
  python?: string;
  extraPythonPath?: readonly string[];
  skipDowngrade?: boolean;
}): RunnerResult {
  const python = options.python ?? 'python3';
  const extra = options.extraPythonPath ?? [];
  const common = {
    scratchUrl: options.scratchUrl,
    versionsDir: options.versionsDir,
    modelsModule: options.modelsModule,
    metadataAttr: options.metadataAttr,
    pythonPath: [options.cwd, ...extra],
  };
  const call = (action: string, revision?: string): RunnerResult =>
    runPython(options.cwd, { command: 'alembic', action, revision, ...common }, python, extra);
  const upgraded = call('upgrade', 'head');
  if (!upgraded.ok) return upgraded;
  const before = runPython(options.cwd, { command: 'snapshot', scratchUrl: options.scratchUrl }, python, extra);
  if (!before.ok) return before;
  if (!options.skipDowngrade) {
    const downgraded = call('downgrade', 'base');
    if (!downgraded.ok) {
      return { ok: false, cause: 'MIGRATION_DOWNGRADE_NOOP', detail: downgraded.detail ?? 'downgrade failed' };
    }
    const middle = runPython(options.cwd, { command: 'snapshot', scratchUrl: options.scratchUrl }, python, extra);
    const tables = (middle.snapshot as { tables?: unknown[] } | undefined)?.tables ?? [];
    if (tables.length > 0) {
      return {
        ok: false,
        cause: 'MIGRATION_DOWNGRADE_NOOP',
        detail: 'downgrade base left tables behind; downgrade() is a no-op or incomplete',
      };
    }
    const again = call('upgrade', 'head');
    if (!again.ok) return again;
    const after = runPython(options.cwd, { command: 'snapshot', scratchUrl: options.scratchUrl }, python, extra);
    if (JSON.stringify(before.snapshot) !== JSON.stringify(after.snapshot)) {
      return {
        ok: false,
        cause: 'MIGRATION_ROUNDTRIP_FAILED',
        detail: 'schema after upgrade/downgrade/upgrade does not match the first upgrade',
      };
    }
  }
  const checked = call('check');
  if (!checked.ok) {
    return {
      ok: false,
      cause: checked.cause === 'MIGRATION_DRIFT' ? 'MIGRATION_DRIFT' : 'MIGRATION_DRIFT',
      detail: checked.detail ?? 'alembic check failed',
    };
  }
  return { ok: true, snapshot: before.snapshot };
}

/**
 * Seeds at the previous head and compares declared fingerprints after upgrade.
 *
 * Args:
 *   options: scratch URL, versions, seed SQL, declared tables, previous revision.
 *
 * Returns:
 *   RunnerResult: ok, or MIGRATION_DATA_LOST / roundtrip failure.
 */
export function executePreservation(options: {
  cwd: string;
  versionsDir: string;
  modelsModule: string;
  metadataAttr: string;
  scratchUrl: string;
  previousRevision: string;
  seedSql: string;
  tables: NonNullable<AlembicConfig['seed']>['tables'];
  python?: string;
  extraPythonPath?: readonly string[];
}): RunnerResult {
  const python = options.python ?? 'python3';
  const extra = options.extraPythonPath ?? [];
  const common = {
    scratchUrl: options.scratchUrl,
    versionsDir: options.versionsDir,
    modelsModule: options.modelsModule,
    metadataAttr: options.metadataAttr,
    pythonPath: [options.cwd, ...extra],
  };
  const upPrevious = runPython(
    options.cwd,
    { command: 'alembic', action: 'upgrade', revision: options.previousRevision, ...common },
    python,
    extra,
  );
  if (!upPrevious.ok) return upPrevious;
  const seeded = runPython(
    options.cwd,
    { command: 'alembic', action: 'sql', sql: options.seedSql, ...common },
    python,
    extra,
  );
  if (!seeded.ok) {
    return { ok: false, cause: 'MIGRATION_DATA_LOST', detail: seeded.detail ?? 'seed failed' };
  }
  const before = runPython(
    options.cwd,
    { command: 'fingerprint', scratchUrl: options.scratchUrl, tables: options.tables },
    python,
    extra,
  );
  if (!before.ok || before.fingerprints === undefined) return before;
  const upgraded = runPython(options.cwd, { command: 'alembic', action: 'upgrade', revision: 'head', ...common }, python, extra);
  if (!upgraded.ok) {
    return { ok: false, cause: 'MIGRATION_ROUNDTRIP_FAILED', detail: upgraded.detail ?? 'upgrade of seeded data failed' };
  }
  const after = runPython(
    options.cwd,
    { command: 'fingerprint', scratchUrl: options.scratchUrl, tables: options.tables },
    python,
    extra,
  );
  if (!after.ok || after.fingerprints === undefined) return after;
  for (const table of options.tables) {
    const left = before.fingerprints[table.name];
    const right = after.fingerprints[table.name];
    if (left === undefined || right === undefined) {
      return { ok: false, cause: 'MIGRATION_DATA_LOST', detail: `declared table '${table.name}' has no fingerprint` };
    }
    if (left.count !== right.count) {
      return {
        ok: false,
        cause: 'MIGRATION_DATA_LOST',
        detail: `table '${table.name}' row count changed from ${String(left.count)} to ${String(right.count)}`,
      };
    }
    for (const column of table.columns) {
      if (left.columns[column] !== null && left.columns[column] !== right.columns[column]) {
        return {
          ok: false,
          cause: 'MIGRATION_DATA_LOST',
          detail: `table '${table.name}' column '${column}' fingerprint changed`,
        };
      }
    }
    for (const copy of table.copies ?? []) {
      const fromBefore = left.columns[copy.from];
      const toAfter = right.columns[copy.to];
      if (fromBefore === null || fromBefore === undefined || fromBefore !== toAfter) {
        return {
          ok: false,
          cause: 'MIGRATION_DATA_LOST',
          detail: `table '${table.name}' did not preserve '${copy.from}' into '${copy.to}'`,
        };
      }
    }
  }
  return { ok: true };
}

/**
 * Compiles Alembic obligations for one repository.
 *
 * Args:
 *   input: trusted config, repo root, changed files, and the run id.
 *
 * Returns:
 *   Promise<AlembicCompileResult>: obligations, blocks, and witness records.
 */
export async function compileAlembic(input: {
  cwd: string;
  alembic: AlembicConfig;
  changedFiles: readonly string[];
  now: string;
  runId?: string;
  python?: string;
  extraPythonPath?: readonly string[];
  /** Test seam: throw after the scratch database is created. */
  afterCreate?: (name: string) => void;
}): Promise<AlembicCompileResult> {
  const started = Date.now();
  const runId = input.runId ?? randomUUID();
  const obligations: Obligation[] = [];
  const blocking: BlockingEntry[] = [];
  const records: EvidenceRecord[] = [];
  const sources: Record<string, string[]> = {};
  const notices: string[] = [];
  const irreversible = new Set(input.alembic.irreversible ?? []);

  for (const chain of input.alembic.chains) {
    const resourceId = `alembic.chain.${chain.name}`;
    const paths = chainPaths(input.cwd, chain);
    let lineage: ScanLineage;
    try {
      lineage = scanLineage(input.cwd, [paths.relativeDir], input.python, input.extraPythonPath);
    } catch (error) {
      blocking.push(
        block('MIGRATION_LINEAGE_BROKEN', `cannot scan migrations: ${(error as Error).message}`, resourceId, paths.relativeDir),
      );
      continue;
    }
    const digest = filesDigest(input.cwd, lineage.migrations.map((item) => item.relPath));
    sources[resourceId] = [
      ...lineage.migrations.map((item) => item.relPath),
      ...chain.models,
      chain.alembicIni ?? 'alembic.ini',
    ].sort();
    obligations.push(obligation(resourceId, ALEMBIC_LINEAGE_INTACT));
    obligations.push(obligation(resourceId, ALEMBIC_ROUNDTRIP_VERIFIED));
    if (input.alembic.seed !== undefined) obligations.push(obligation(resourceId, ALEMBIC_DATA_PRESERVED));
    if (input.alembic.merge !== undefined) obligations.push(obligation(resourceId, ALEMBIC_MERGE_CLEAN));

    const changedModels = input.changedFiles.filter(
      (file) => chain.models.some((glob) => globMatches(glob, file)) && !lineage.migrations.some((item) => item.relPath === file),
    );
    const changedMigrations = input.changedFiles.filter((file) =>
      lineage.migrations.some((item) => item.relPath === file) || file.startsWith(`${paths.relativeDir}/`),
    );
    if (changedModels.length > 0 && changedMigrations.length === 0) {
      blocking.push(
        block(
          'MIGRATION_MISSING',
          `model changed (${changedModels.join(', ')}) with no migration in the same change`,
          resourceId,
          changedModels[0] ?? null,
        ),
      );
    }

    const lineageBroken = lineage.findings.length > 0 || lineage.heads.length !== 1;
    if (lineageBroken) {
      const detail =
        lineage.findings.map((finding) => `${finding.code}: ${finding.detail}`).join('; ') ||
        `expected one head, found ${lineage.heads.join(', ') || '<none>'}`;
      blocking.push(block('MIGRATION_LINEAGE_BROKEN', detail, resourceId, lineage.migrations[0]?.relPath ?? null));
    }
    const noop = lineage.migrations.filter((item) => item.downgradeNoop && !irreversible.has(item.revision));
    if (noop.length > 0) {
      blocking.push(
        block(
          'MIGRATION_DOWNGRADE_NOOP',
          `downgrade() is empty in ${noop.map((item) => `${item.revision} (${item.relPath})`).join(', ')}`,
          resourceId,
          noop[0]?.relPath ?? null,
        ),
      );
    }
    const pinned = lineage.migrations.filter((item) => irreversible.has(item.revision)).map((item) => item.revision);
    if (pinned.length > 0) {
      notices.push(`irreversible revisions pinned by the owner: ${pinned.join(', ')}`);
    }

    const payloadBase = {
      producer: 'gateforge.engine',
      filesDigest: digest,
      revisions: lineage.migrations.map((item) => item.revision).sort(),
      irreversible: pinned,
    };
    records.push(
      witnessRecord(runId, input.now, `${resourceId}:${ALEMBIC_LINEAGE_INTACT}`, {
        ...payloadBase,
        contract: ALEMBIC_LINEAGE_INTACT,
        passed: !lineageBroken,
        cause: lineageBroken ? 'MIGRATION_LINEAGE_BROKEN' : null,
        detail: lineageBroken ? 'lineage is not a single intact head' : 'lineage parsed',
      }),
    );

    const roundtrip = await runChainDatabase({
      cwd: input.cwd,
      adminUrl: input.alembic.scratch.adminUrl,
      paths,
      lineage,
      lineageBroken,
      skipDowngrade: pinned.length > 0,
      seed: input.alembic.seed,
      mergeRef: input.alembic.merge?.targetRef,
      python: input.python,
      extraPythonPath: input.extraPythonPath,
      afterCreate: input.afterCreate,
      resourceId,
    });
    blocking.push(...roundtrip.blocking);
    notices.push(...roundtrip.notices);
    for (const entry of roundtrip.records) {
      records.push(
        witnessRecord(runId, input.now, entry.obligationId, {
          ...payloadBase,
          ...entry.payload,
        }),
      );
    }
  }

  return {
    obligations,
    blocking,
    records,
    sources,
    notices,
    durationMs: Date.now() - started,
  };
}

/**
 * Runs the database legs for one chain and always drops the scratch database.
 *
 * Args:
 *   options: chain paths, lineage, and trusted admin URL.
 *
 * Returns:
 *   object: blocking entries and witness payloads.
 */
async function runChainDatabase(options: {
  cwd: string;
  adminUrl: string;
  paths: ChainLocation;
  lineage: ScanLineage;
  lineageBroken: boolean;
  skipDowngrade: boolean;
  seed: AlembicConfig['seed'];
  mergeRef: string | undefined;
  python?: string;
  extraPythonPath?: readonly string[];
  afterCreate?: (name: string) => void;
  resourceId: string;
}): Promise<{ blocking: BlockingEntry[]; notices: string[]; records: Array<{ obligationId: string; payload: Record<string, unknown> }> }> {
  const blocking: BlockingEntry[] = [];
  const notices: string[] = [];
  const records: Array<{ obligationId: string; payload: Record<string, unknown> }> = [];
  const fail = (contract: string, cause: NonNullable<BlockingEntry['cause']>, detail: string, file: string | null): void => {
    blocking.push(block(cause, detail, options.resourceId, file));
    records.push({
      obligationId: `${options.resourceId}:${contract}`,
      payload: { contract, passed: false, cause, detail },
    });
  };

  if (options.lineageBroken) {
    fail(ALEMBIC_ROUNDTRIP_VERIFIED, 'MIGRATION_LINEAGE_BROKEN', 'roundtrip skipped because lineage is broken', null);
    if (options.seed !== undefined) {
      fail(ALEMBIC_DATA_PRESERVED, 'MIGRATION_LINEAGE_BROKEN', 'data check skipped because lineage is broken', null);
    }
    if (options.mergeRef !== undefined) {
      fail(ALEMBIC_MERGE_CLEAN, 'MIGRATION_LINEAGE_BROKEN', 'merge check skipped because lineage is broken', null);
    }
    return { blocking, notices, records };
  }

  let created: { name: string; url: string } | null = null;
  try {
    created = createScratchDatabase(options.adminUrl);
    if (!isScratchDatabaseName(created.name)) {
      throw new ScratchUnsafeError(`refusing database name '${created.name}'`);
    }
    options.afterCreate?.(created.name);
    let cwd = options.cwd;
    let versionsDir = options.paths.versionsDir;
    let cleanup = (): void => undefined;
    if (options.mergeRef !== undefined) {
      const merged = mergeTargetWorktree(options.cwd, options.mergeRef);
      cleanup = merged.cleanup;
      if (merged.status !== 0 && merged.stderr.includes('worktree')) {
        fail(ALEMBIC_MERGE_CLEAN, 'MIGRATION_CONFLICT', merged.stderr || 'cannot merge target ref', null);
        return { blocking, notices, records };
      }
      const mergedLineage = scanLineage(merged.dir, [options.paths.relativeDir], options.python, options.extraPythonPath);
      if (mergedLineage.heads.length !== 1) {
        const named = mergedLineage.migrations
          .filter((item) => mergedLineage.heads.includes(item.revision))
          .map((item) => `${item.revision} (${item.relPath})`)
          .join(', ');
        fail(
          ALEMBIC_MERGE_CLEAN,
          'MIGRATION_CONFLICT',
          `merge result has revisions ${named || mergedLineage.heads.join(', ')}`,
          mergedLineage.migrations[0]?.relPath ?? null,
        );
        cleanup();
        return { blocking, notices, records };
      }
      cwd = merged.dir;
      versionsDir = join(merged.dir, options.paths.relativeDir);
      const round = executeRoundtrip({
        cwd,
        versionsDir,
        modelsModule: options.paths.modelsModule,
        metadataAttr: options.paths.metadataAttr,
        scratchUrl: created.url,
        python: options.python,
        extraPythonPath: options.extraPythonPath,
        skipDowngrade: options.skipDowngrade,
      });
      if (!round.ok) {
        fail(
          ALEMBIC_MERGE_CLEAN,
          (round.cause as NonNullable<BlockingEntry['cause']>) ?? 'MIGRATION_CONFLICT',
          round.detail ?? 'merge roundtrip failed',
          null,
        );
      } else {
        records.push({
          obligationId: `${options.resourceId}:${ALEMBIC_MERGE_CLEAN}`,
          payload: { contract: ALEMBIC_MERGE_CLEAN, passed: true, cause: null, detail: 'merge result round-tripped' },
        });
      }
      cleanup();
    }
    const round = executeRoundtrip({
      cwd: options.cwd,
      versionsDir: options.paths.versionsDir,
      modelsModule: options.paths.modelsModule,
      metadataAttr: options.paths.metadataAttr,
      scratchUrl: created.url,
      python: options.python,
      extraPythonPath: options.extraPythonPath,
      skipDowngrade: options.skipDowngrade,
    });
    if (!round.ok) {
      const cause = (round.cause as NonNullable<BlockingEntry['cause']>) ?? 'MIGRATION_ROUNDTRIP_FAILED';
      fail(ALEMBIC_ROUNDTRIP_VERIFIED, cause, round.detail ?? 'roundtrip failed', null);
    } else {
      records.push({
        obligationId: `${options.resourceId}:${ALEMBIC_ROUNDTRIP_VERIFIED}`,
        payload: {
          contract: ALEMBIC_ROUNDTRIP_VERIFIED,
          passed: true,
          cause: null,
          detail: options.skipDowngrade ? 'upgrade and alembic check passed; downgrade skipped for pinned irreversible revisions' : 'roundtrip passed',
          downgradeSkipped: options.skipDowngrade,
        },
      });
    }
    if (options.seed !== undefined) {
      const head = options.lineage.heads[0];
      const headMigration = options.lineage.migrations.find((item) => item.revision === head);
      const previous = headMigration?.downRevisions[0];
      if (previous === undefined) {
        fail(ALEMBIC_DATA_PRESERVED, 'MIGRATION_DATA_LOST', 'seed requires a previous head to load rows before upgrade', null);
      } else {
        const seedSql = readFileSync(join(options.cwd, options.seed.path), 'utf8');
        const preserved = executePreservation({
          cwd: options.cwd,
          versionsDir: options.paths.versionsDir,
          modelsModule: options.paths.modelsModule,
          metadataAttr: options.paths.metadataAttr,
          scratchUrl: created.url,
          previousRevision: previous,
          seedSql,
          tables: options.seed.tables,
          python: options.python,
          extraPythonPath: options.extraPythonPath,
        });
        if (!preserved.ok) {
          const cause = (preserved.cause as NonNullable<BlockingEntry['cause']>) ?? 'MIGRATION_DATA_LOST';
          fail(ALEMBIC_DATA_PRESERVED, cause, preserved.detail ?? 'data was not preserved', options.seed.path);
        } else {
          records.push({
            obligationId: `${options.resourceId}:${ALEMBIC_DATA_PRESERVED}`,
            payload: { contract: ALEMBIC_DATA_PRESERVED, passed: true, cause: null, detail: 'declared rows survived upgrade' },
          });
        }
      }
    }
    void cwd;
    void versionsDir;
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'scratch database failed';
    const cause = error instanceof ScratchUnsafeError ? 'MIGRATION_SCRATCH_UNSAFE' : 'MIGRATION_ROUNDTRIP_FAILED';
    fail(ALEMBIC_ROUNDTRIP_VERIFIED, cause, detail, null);
  } finally {
    if (created !== null) {
      try {
        dropScratchDatabase(options.adminUrl, created.name);
      } catch (error) {
        blocking.push(
          block(
            'MIGRATION_SCRATCH_UNSAFE',
            `failed to drop ${created.name}: ${error instanceof Error ? error.message : 'drop failed'}`,
            options.resourceId,
            null,
          ),
        );
      }
    }
  }
  return { blocking, notices, records };
}

/**
 * Previous revision of the single head, when the chain is linear.
 *
 * Args:
 *   lineage: scanned lineage.
 *
 * Returns:
 *   string | null: parent revision, or null.
 */
export function previousHead(lineage: ScanLineage): string | null {
  const head = lineage.heads.length === 1 ? lineage.heads[0] : undefined;
  const migration: ScannedMigration | undefined = lineage.migrations.find((item) => item.revision === head);
  return migration?.downRevisions[0] ?? null;
}
