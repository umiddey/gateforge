/**
 * `gateforge migrate`: move owner declarations that used to live in their
 * own files into `.gateforge.yml`, without touching anything else.
 *
 * 0.10 removed `.gateforge/docs-exclusions.yml` and
 * `.gateforge/cache-exclusions.yml`; evidence exclusions now live in
 * `.gateforge.yml` under `evidence.exclude`. Every command refuses a
 * repository that still carries either file (reading it would silently
 * drop the owner's exclusions), so this command is the way through.
 *
 * Three properties make it safe to run on a real repository:
 * - **Preview by default.** Without `--confirm` nothing on disk moves; the
 *   exact diff of `.gateforge.yml` and the files that would be removed are
 *   printed and the exit code is 0.
 * - **Text insert, never re-serialize.** The owner's YAML is spliced, so
 *   every comment and key order survives byte for byte; only the
 *   `evidence.exclude` block is new. A declaration this release cannot
 *   extend safely (an inline `evidence:`, a non-list `exclude`) is
 *   refused by name instead of being overwritten.
 * - **Idempotent.** Nothing to migrate prints `nothing to migrate` and
 *   exits 0, so a re-run after a partial adoption is free.
 *
 * Migrating changes a policy input, so it ends with the re-pin reminder:
 * the approved digest must be regenerated outside the repository.
 */
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig, type GateforgeConfig } from '@gate-forge/core';
import { parseArgs } from '../args.js';
import { UsageError } from '../errors.js';
import type { Io } from '../io.js';
import { writeLine } from '../io.js';
import { setEvidenceExclude, configTextDiff } from '../evidence-config-text.js';
import { readLegacyCacheExclusions } from '../cache-exclusions.js';
import { readLegacyDocsExclusions } from '../docs-exclusions.js';
import {
  LEGACY_CACHE_EXCLUSIONS_PATH,
  LEGACY_DOCS_EXCLUSIONS_PATH,
  legacyExclusionPathsPresent,
} from '../legacy-exclusion-paths.js';
import { rejectUnknownFlags } from './common.js';

export const MIGRATE_USAGE =
  'usage: gateforge migrate [--confirm]\n' +
  '       Moves owner declarations out of their own files and into .gateforge.yml.\n' +
  '       Today that is the evidence exclusions: .gateforge/docs-exclusions.yml and\n' +
  `       ${LEGACY_CACHE_EXCLUSIONS_PATH} become\n` +
  '       `evidence.exclude.docs` and `evidence.exclude.cache` in .gateforge.yml.\n' +
  '       Preview by default (prints the exact diff, writes nothing, exit 0);\n' +
  '       --confirm writes the block and deletes the old files. Idempotent: a repository\n' +
  '       with nothing to migrate prints `nothing to migrate` and exits 0.\n' +
  '       The old files are NOT read by any other command: while either is present every\n' +
  '       command refuses and names this one.';

/** Flags the command accepts (plus the implicit `help`). */
const MIGRATE_FLAGS = ['confirm', 'help'] as const;

/** What one migration step found, before anything is written. */
interface MigrationStep {
  /** Stable id, printed so a later step can be recognized in a diff. */
  readonly id: string;
  /** One owner-facing line describing what would change. */
  readonly describe: string;
  /** Repo-relative files this step would delete. */
  readonly removals: readonly string[];
  /** The exact preview text for the repository's config document. */
  readonly diff: string;
  /** Applies the step: rewrite the config, then delete the old files. */
  apply(cwd: string, configPath: string): void;
}

/**
 * Builds the evidence-exclusions step, or null when there is nothing to do.
 *
 * Args:
 *   cwd: absolute repository root.
 *   config: the validated `.gateforge.yml` (read WITHOUT the pre-0.10
 *     refusal: that refusal names this command).
 *
 * Returns:
 *   MigrationStep | null: the step, or null when no old file is present.
 */
function evidenceExclusionsStep(cwd: string, config: GateforgeConfig): MigrationStep | null {
  if (legacyExclusionPathsPresent(cwd).length === 0) return null;
  const docs = existsSync(join(cwd, ...LEGACY_DOCS_EXCLUSIONS_PATH.split('/')))
    ? readLegacyDocsExclusions(cwd, config)
    : undefined;
  const cache = existsSync(join(cwd, ...LEGACY_CACHE_EXCLUSIONS_PATH.split('/')))
    ? readLegacyCacheExclusions(cwd, config)
    : undefined;
  const configPath = '.gateforge.yml';
  const absoluteConfig = join(cwd, configPath);
  const before = existsSync(absoluteConfig) ? readFileSync(absoluteConfig, 'utf8') : '';
  // Throws (by name) when the existing block cannot be extended safely.
  const after = setEvidenceExclude(before, { docs, cache }, configPath);
  const declared = [
    ...(docs === undefined ? [] : [`evidence.exclude.docs (${String(docs.length)})`]),
    ...(cache === undefined ? [] : [`evidence.exclude.cache (${String(cache.length)})`]),
  ];
  const removals = [
    ...(docs === undefined ? [] : [LEGACY_DOCS_EXCLUSIONS_PATH]),
    ...(cache === undefined ? [] : [LEGACY_CACHE_EXCLUSIONS_PATH]),
  ];
  return {
    id: 'evidence-exclusions',
    describe: `${declared.join(', ')} move into ${configPath}; ${removals.join(' and ')} deleted`,
    removals,
    diff: configTextDiff(configPath, before, after),
    apply: (repoRoot: string, path: string) => {
      writeFileAtomic(repoRoot, path, after);
      for (const removal of removals) {
        const absolute = join(repoRoot, ...removal.split('/'));
        if (existsSync(absolute)) unlinkSync(absolute);
      }
    },
  };
}

/**
 * Writes a file through a sibling temporary file, so an interrupted
 * migrate never leaves a half-written `.gateforge.yml` behind.
 *
 * Args:
 *   cwd: absolute repository root.
 *   path: repo-relative target path.
 *   text: the exact content to write.
 *
 * Returns:
 *   void.
 */
function writeFileAtomic(cwd: string, path: string, text: string): void {
  const absolute = join(cwd, ...path.split('/'));
  const temporary = `${absolute}.gateforge-migrate.tmp`;
  try {
    writeFileSync(temporary, text, { flag: 'wx', encoding: 'utf8' });
    renameSync(temporary, absolute);
  } catch (error) {
    if (existsSync(temporary)) unlinkSync(temporary);
    throw error;
  }
}

/** Every migration step, in the order they are applied. */
function planSteps(cwd: string, config: GateforgeConfig): MigrationStep[] {
  return [evidenceExclusionsStep(cwd, config)].filter((step): step is MigrationStep => step !== null);
}

/**
 * Runs `gateforge migrate`.
 *
 * Args:
 *   io: process context.
 *   argv: arguments after the command name.
 *
 * Returns:
 *   number: 0 on success or preview, 2 on a usage error.
 */
export function migrateCommand(io: Io, argv: readonly string[]): number {
  const { options } = parseArgs(argv);
  rejectUnknownFlags(options, MIGRATE_FLAGS, MIGRATE_USAGE);
  if (options['help'] === true) {
    writeLine(io.stdout, MIGRATE_USAGE);
    return 0;
  }
  if (options['confirm'] !== undefined && options['confirm'] !== true) {
    throw new UsageError("migrate: '--confirm' must be a boolean flag");
  }
  // Read the config DIRECTLY: `loadConfigAt` refuses the pre-0.10 files
  // by naming this very command.
  const configPath = join(io.cwd, '.gateforge.yml');
  if (!existsSync(configPath)) {
    throw new UsageError('migrate: no .gateforge.yml in this repository — run `gateforge init` first');
  }
  const config = loadConfig(configPath);
  const steps = planSteps(io.cwd, config);
  if (steps.length === 0) {
    writeLine(io.stdout, 'nothing to migrate');
    return 0;
  }

  writeLine(io.stdout, 'migration preview (nothing is written without --confirm):');
  for (const step of steps) {
    writeLine(io.stdout, `  ${step.id}: ${step.describe}`);
    for (const line of step.diff.split('\n')) writeLine(io.stdout, `  ${line}`);
    for (const removal of step.removals) writeLine(io.stdout, `  deleted: ${removal}`);
  }
  if (options['confirm'] !== true) {
    writeLine(io.stdout, 'dry run only; rerun this command with --confirm to write');
    return 0;
  }

  for (const step of steps) {
    step.apply(io.cwd, '.gateforge.yml');
    writeLine(io.stdout, `migrated: ${step.describe}`);
  }
  writeLine(
    io.stdout,
    'policy inputs changed: re-pin the approved digest (gateforge enforcement doctor)',
  );
  return 0;
}
