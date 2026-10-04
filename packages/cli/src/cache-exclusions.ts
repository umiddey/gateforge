/**
 * Owner-declared Python bytecode files that may leave evidence identity.
 * The declaration lives in `.gateforge.yml` under `evidence.exclude.cache`
 * (0.10.0) and is trusted only when the matching trusted-policy digest is
 * provisioned outside the candidate repository.
 */
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { GateforgeConfig } from '@gate-forge/core';
import { collectDeclaredInputs } from './input-snapshot.js';
import { UsageError } from './errors.js';
import { LEGACY_CACHE_EXCLUSIONS_PATH, rejectLegacyExclusions } from './legacy-exclusion-paths.js';

/** Where the declaration is read from, named in refusals and digests. */
export const CACHE_EXCLUSIONS_SOURCE = '.gateforge.yml (evidence.exclude.cache)';
/** The reduced guarantee shown in reports when bytecode is excluded. */
export const CACHE_EXCLUSIONS_GUARANTEE =
  'owner assertion only: Gateforge does not prove excluded bytecode cannot affect runtime behavior; ' +
  'a changed bytecode file can make old evidence appear current';

/**
 * Loads and validates the owner-declared Python bytecode files from
 * `.gateforge.yml` (`evidence.exclude.cache`).
 *
 * Args:
 *   cwd: absolute repository root.
 *   config: validated Gateforge configuration.
 *
 * Returns:
 *   string[]: sorted exact cache paths, or an empty list when undeclared.
 *
 * Throws:
 *   UsageError: a pre-0.10 declaration file, or any refusal below.
 */
export function loadCacheExclusions(cwd: string, config: GateforgeConfig): string[] {
  rejectLegacyExclusions(cwd);
  const files = config.evidence?.exclude?.cache ?? [];
  if (files.length === 0) return [];
  return validateCacheFiles(cwd, files, config);
}

/**
 * Reads the REMOVED 0.9 declaration file — for `gateforge migrate` only.
 * Same symlink, shape and validation rules as the 0.9 loader, so a
 * migrated repository gets exactly the list it had before.
 *
 * Args:
 *   cwd: absolute repository root.
 *   config: validated Gateforge configuration.
 *
 * Returns:
 *   string[]: sorted exact cache paths, or an empty list when absent.
 *
 * Throws:
 *   UsageError: an unreadable, malformed or unsafe declaration.
 */
export function readLegacyCacheExclusions(cwd: string, config: GateforgeConfig): string[] {
  const absolute = join(cwd, ...LEGACY_CACHE_EXCLUSIONS_PATH.split('/'));
  if (!existsSync(absolute)) return [];
  inspectCachePathComponents(cwd, LEGACY_CACHE_EXCLUSIONS_PATH, true, false);
  let stat;
  try {
    stat = lstatSync(absolute);
  } catch (error) {
    throw new UsageError(`cannot inspect ${LEGACY_CACHE_EXCLUSIONS_PATH}: ${(error as Error).message}`);
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new UsageError(`${LEGACY_CACHE_EXCLUSIONS_PATH} must be a regular file, not a symlink or directory`);
  }
  let document: unknown;
  try {
    document = parseYaml(readFileSync(absolute, 'utf8'));
  } catch (error) {
    throw new UsageError(`${LEGACY_CACHE_EXCLUSIONS_PATH} is not valid YAML: ${(error as Error).message}`);
  }
  if (typeof document !== 'object' || document === null || Array.isArray(document)) {
    throw new UsageError(`${LEGACY_CACHE_EXCLUSIONS_PATH} must contain only schemaVersion: 1 and a files list`);
  }
  const raw: unknown = 'files' in document ? document.files : null;
  const listed = Array.isArray(raw) ? raw : [];
  const files = listed.filter((file): file is string => typeof file === 'string');
  if (
    !Array.isArray(raw) ||
    files.length !== listed.length ||
    !('schemaVersion' in document) ||
    document.schemaVersion !== 1 ||
    Object.keys(document).some((key) => key !== 'schemaVersion' && key !== 'files')
  ) {
    throw new UsageError(`${LEGACY_CACHE_EXCLUSIONS_PATH} must contain only schemaVersion: 1 and a files list`);
  }
  return validateCacheFiles(cwd, files, config);
}

/**
 * Validates an init request and returns canonical, sorted file paths.
 *
 * Args:
 *   cwd: absolute repository root.
 *   files: exact paths requested by the owner.
 *   config: validated Gateforge configuration.
 *
 * Returns:
 *   string[]: validated, sorted paths.
 *
 * Throws:
 *   UsageError: an invalid path, configured input, or unsafe filesystem entry.
 */
export function validateRequestedCacheFiles(
  cwd: string,
  files: readonly string[],
  config: GateforgeConfig,
): string[] {
  return validateCacheFiles(cwd, [...files], config);
}

/**
 * Validates exact bytecode paths, configured inputs, and existing filesystem entries.
 *
 * Args:
 *   cwd: absolute repository root.
 *   files: requested paths.
 *   config: validated Gateforge configuration.
 *
 * Returns:
 *   string[]: canonical, sorted paths.
 *
 * Throws:
 *   UsageError: duplicate, unsafe, configured, or symlinked paths.
 */
function validateCacheFiles(cwd: string, files: readonly string[], config: GateforgeConfig): string[] {
  const normalized = files.map((file) => normalizeCacheFile(file));
  const sorted = [...normalized].sort();
  for (let index = 1; index < sorted.length; index += 1) {
    if (sorted[index] === sorted[index - 1]) {
      throw new UsageError(`duplicate Python bytecode exclusion '${sorted[index]}'`);
    }
  }
  const declared = new Set(collectDeclaredInputs(cwd, config).filter((path) => !path.startsWith('absent:')));
  for (const file of sorted) {
    if (declared.has(file)) throw new UsageError(`cannot exclude configured scan or gate input '${file}'`);
    inspectCachePathComponents(cwd, file, false, true);
  }
  return sorted;
}

/**
 * Normalizes one exact repo-relative path and requires a direct __pycache__ child.
 *
 * Args:
 *   file: requested repository-relative path.
 *
 * Returns:
 *   string: canonical slash-separated path.
 *
 * Throws:
 *   UsageError: path is not a direct .pyc/.pyo cache file.
 */
function normalizeCacheFile(file: string): string {
  if (
    file.length === 0 || file.includes('\\') || file.startsWith('/') || /^[A-Za-z]:/.test(file) ||
    /[*?\[\]{}!]/.test(file) || file.endsWith('/')
  ) {
    throw new UsageError(`Python bytecode exclusion '${file}' must be an exact repo-relative file path`);
  }
  const segments = file.split('/');
  if (segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')) {
    throw new UsageError(`Python bytecode exclusion '${file}' must not contain empty, '.' or '..' path segments`);
  }
  const cacheIndex = segments.lastIndexOf('__pycache__');
  const basename = segments.at(-1) ?? '';
  if (cacheIndex !== segments.length - 2 || !/\.(?:pyc|pyo)$/.test(basename)) {
    throw new UsageError(`Python bytecode exclusion '${file}' must name a .pyc or .pyo file directly inside __pycache__`);
  }
  if (segments.some((segment) => segment === '.git' || segment === '.gateforge')) {
    throw new UsageError(`cannot exclude protected trust metadata path '${file}'`);
  }
  return segments.join('/');
}

/**
 * Rejects symlinks and wrong filesystem types along one declared bytecode path.
 *
 * Args:
 *   cwd: absolute repository root.
 *   path: validated repository-relative path.
 *   requireTarget: whether the whole path must already exist.
 *   targetMustBeFile: whether an existing target must be a regular file.
 *
 * Returns:
 *   void.
 *
 * Throws:
 *   UsageError: a symlink, wrong parent type, missing required entry, or unreadable path.
 */
function inspectCachePathComponents(
  cwd: string,
  path: string,
  requireTarget: boolean,
  targetMustBeFile: boolean,
): void {
  let cursor = resolve(cwd);
  const segments = path.split('/');
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    if (segment === undefined) continue;
    cursor = join(cursor, segment);
    let stat;
    try {
      stat = lstatSync(cursor);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new UsageError(`cannot inspect Python bytecode exclusion '${path}': ${(error as Error).message}`);
      }
      if (requireTarget) throw new UsageError(`required path '${path}' does not exist`);
      return;
    }
    if (stat.isSymbolicLink()) {
      throw new UsageError(`Python bytecode exclusion rejects symlink path '${path}' (fail closed)`);
    }
    const isTarget = index === segments.length - 1;
    if (!isTarget && !stat.isDirectory()) {
      throw new UsageError(`Python bytecode exclusion parent in '${path}' is not a directory`);
    }
    if (isTarget && targetMustBeFile && !stat.isFile()) {
      throw new UsageError(`Python bytecode exclusion '${path}' is not a regular file`);
    }
    if (isTarget && targetMustBeFile && (stat.mode & 0o111) !== 0) {
      throw new UsageError(`Python bytecode exclusion '${path}' must not be executable`);
    }
  }
}
