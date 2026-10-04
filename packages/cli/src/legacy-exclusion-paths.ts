/**
 * The 0.9 evidence-exclusion declaration paths, and the one refusal that
 * replaces reading them.
 *
 * 0.10 moved both lists into `.gateforge.yml` under `evidence.exclude`.
 * There is NO dual read: a repository that still carries either file is
 * refused by name, with the command that migrates it, because silently
 * ignoring the file would silently drop the owner's exclusions and
 * quietly change what evidence identity means.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { UsageError } from './errors.js';

/** The removed documentation-folder declaration path (0.9 and earlier). */
export const LEGACY_DOCS_EXCLUSIONS_PATH = '.gateforge/docs-exclusions.yml';

/** The removed Python bytecode declaration path (0.9 and earlier). */
export const LEGACY_CACHE_EXCLUSIONS_PATH = '.gateforge/cache-exclusions.yml';

/**
 * Lists the pre-0.10 exclusion files still present in the repository.
 *
 * Args:
 *   cwd: absolute repository root.
 *
 * Returns:
 *   string[]: repo-relative paths of the declarations that still exist.
 */
export function legacyExclusionPathsPresent(cwd: string): string[] {
  return [LEGACY_DOCS_EXCLUSIONS_PATH, LEGACY_CACHE_EXCLUSIONS_PATH].filter((path) =>
    existsSync(join(cwd, ...path.split('/'))),
  );
}

/**
 * Refuses a pre-0.10 declaration instead of reading it (fail closed).
 *
 * Args:
 *   cwd: absolute repository root (the tree the caller is about to read).
 *
 * Returns:
 *   void: nothing when no pre-0.10 declaration is present.
 *
 * Throws:
 *   UsageError: naming the file, the new location, and the migration.
 */
export function rejectLegacyExclusions(cwd: string): void {
  for (const path of legacyExclusionPathsPresent(cwd)) {
    throw new UsageError(
      `found ${path}: since 0.10 evidence exclusions live in .gateforge.yml under evidence.exclude — ` +
        'run `gateforge migrate`',
    );
  }
}
