/**
 * `gateforge migrate`: move owner declarations that used to live in their
 * own files into the documents that read them, without touching anything
 * else.
 *
 * 0.10 removed `.gateforge/docs-exclusions.yml` and
 * `.gateforge/cache-exclusions.yml`; 0.11.0 folds four more files away:
 *
 * - `.gateforge/planes.json` and `.gateforge/endpoints.json` become the
 *   `planes:` / `endpoints:` SECTIONS of the owner-answers document;
 * - `.gateforge/http-clients.json` and `.gateforge/fastapi.json` become
 *   `scan.httpClients` / `scan.fastapi` in `.gateforge.yml`;
 * - the four scanner keys leave the answers document for `scan:`.
 *
 * Contract (unchanged, extended):
 *
 * - **Fail closed.** A file whose bytes its new home would refuse is
 *   refused BY NAME here, and nothing is written — a migrate that half
 *   succeeded would leave a repository that cannot load.
 * - **Text-level writes.** The answers document is an owner review
 *   artifact: every section spliced into it preserves the bytes around it,
 *   comments included (see `yaml-section.ts`).
 * - **Idempotent.** Nothing to migrate prints `nothing to migrate` and
 *   exits 0, so a re-run after a partial adoption is free.
 *
 * Migrating changes a policy input, so it ends with the re-pin reminder:
 * the bytes moved between documents are still owner-pinned, and a
 * repository that trusts a digest computed over the old files would be
 * trusting a set of inputs that no longer exists.
 */
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  loadPreMigrationConfig,
  type GateforgeConfig,
  type ScanConfig,
} from '@gate-forge/core';
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
import { composeScanSection, movedDocumentSteps, type MigrationStep } from './migrate-moved-documents.js';

export const MIGRATE_USAGE =
  'usage: gateforge migrate [--confirm]\n' +
  '       Moves owner declarations out of their own files into the documents that read them.\n' +
  '       Today that is:\n' +
  `         .gateforge/docs-exclusions.yml and ${LEGACY_CACHE_EXCLUSIONS_PATH}\n` +
  '           become `evidence.exclude.docs` / `evidence.exclude.cache` in .gateforge.yml\n' +
  '         .gateforge/planes.json and .gateforge/endpoints.json\n' +
  '           become the `planes:` / `endpoints:` sections of the owner-answers document\n' +
  '         .gateforge/http-clients.json and .gateforge/fastapi.json\n' +
  '           become `scan.httpClients` / `scan.fastapi` in .gateforge.yml\n' +
  '         `scanRoots`, `coverage`, `declarations`, `volatileFields`\n' +
  '           move out of the owner-answers document into `scan:` in .gateforge.yml\n' +
  '       Preview by default (prints the exact diff, writes nothing, exit 0);\n' +
  '       --confirm writes each section as TEXT (every other byte survives) and deletes the\n' +
  '       old files. Idempotent: a repository with nothing to migrate prints `nothing to\n' +
  '       migrate` and exits 0.\n' +
  '       The old files are NOT read by any other command: while any of them is present every\n' +
  '       command refuses and names this one.';

/** Flags the command accepts (plus the implicit `help`). */
const MIGRATE_FLAGS = ['confirm', 'help'] as const;

/**
 * Writes a file through a sibling temporary file, so an interrupted
 * migrate never leaves a half-written document behind.
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

/**
 * Builds the evidence-exclusions step, or null when there is nothing to do.
 *
 * Args:
 *   cwd: absolute repository root.
 *   config: the config as the repository will read it AFTER this migration
 *     (the pre-0.11 file plus the composed `scan:`), because the exclusion
 *     validators refuse to hide a declared gate input.
 *
 * Returns:
 *   MigrationStep[]: the step, or an empty list when no old file is present.
 */
function evidenceExclusionsSteps(cwd: string, config: GateforgeConfig): MigrationStep[] {
  if (legacyExclusionPathsPresent(cwd).length === 0) return [];
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
  return [
    {
      id: 'evidence-exclusions',
      describe: `${declared.join(', ')} move into ${configPath}; ${removals.join(' and ')} deleted`,
      removals,
      diff: configTextDiff(configPath, before, after),
      apply: (repoRoot: string) => {
        writeFileAtomic(repoRoot, configPath, after);
        for (const removal of removals) {
          const absolute = join(repoRoot, ...removal.split('/'));
          if (existsSync(absolute)) unlinkSync(absolute);
        }
      },
    },
  ];
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
  // Read the config LENIENTLY, without either refusal: a repository that
  // needs migrating is exactly the one whose `.gateforge.yml` has no `scan:`
  // yet and whose answers document still carries the scanner keys the
  // strict loader refuses by name. This command is the ONE place those
  // shapes are readable.
  const configPath = join(io.cwd, '.gateforge.yml');
  if (!existsSync(configPath)) {
    throw new UsageError('migrate: no .gateforge.yml in this repository — run `gateforge init` first');
  }
  const preMigration = loadPreMigrationConfig(configPath);
  // The scanner settings as the repository will read them once this command
  // is done. Everything downstream validates against them, so a migration
  // that would produce a config a run rejects fails here instead.
  const scan = composeScanSection(io.cwd, preMigration);
  const effective: GateforgeConfig = { ...preMigration, scan } as GateforgeConfig;
  const steps = [
    ...evidenceExclusionsSteps(io.cwd, effective),
    ...movedDocumentSteps(io.cwd, preMigration),
  ];
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
    step.apply(io.cwd);
    writeLine(io.stdout, `migrated: ${step.describe}`);
  }
  writeLine(
    io.stdout,
    'policy inputs changed: re-pin the approved digest (gateforge enforcement doctor)',
  );
  return 0;
}