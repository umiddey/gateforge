/**
 * Owner-declared documentation folders that may leave evidence identity.
 * The declaration is trusted only when the matching trusted-policy digest
 * is provisioned outside the candidate repository.
 */
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { GateforgeConfig } from '@gate-forge/core';
import { GIT_SCOPE_CONTROL_BASENAMES, MANIFEST_NAMES, PACK_CONFIGS, collectDeclaredInputs } from './input-snapshot.js';
import { UsageError } from './errors.js';

/** Repo-relative owner declaration path. */
export const DOCS_EXCLUSIONS_PATH = '.gateforge/docs-exclusions.yml';

/** The reduced guarantee shown in successful reports. */
export const DOCS_EXCLUSIONS_GUARANTEE =
  'owner assertion only: Gateforge does not prove these files cannot affect product behavior or tests; ' +
  'a later app/test read can make old evidence look valid after an excluded file changes';

const EXECUTABLE_EXTENSIONS = new Set([
  '.c', '.cc', '.cpp', '.cs', '.cxx', '.go', '.h', '.hpp', '.java', '.js', '.jsx', '.mjs', '.cjs',
  '.kt', '.kts', '.m', '.mm', '.php', '.py', '.pyi', '.rb', '.rs', '.scala', '.sh', '.bash', '.zsh',
  '.sql', '.swift', '.ts', '.tsx', '.mts', '.cts', '.vue', '.svelte', '.html', '.css', '.mdx', '.wasm',
  '.node', '.exe', '.dll', '.so', '.dylib', '.jar', '.class',
]);

// Unknown formats fail closed. These common document and raster-image types
// are not proof of irrelevance: the owner promise still carries that risk.
const DOCUMENTATION_EXTENSIONS = new Set([
  '.md', '.markdown', '.mdown', '.mkd', '.rst', '.adoc', '.asciidoc', '.txt', '.pdf',
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.bmp', '.tif', '.tiff', '.ico',
]);
const DOCUMENTATION_BASENAMES = new Set(['.gitkeep', 'readme', 'license', 'notice', 'changelog', 'copying']);

const EXECUTION_CONFIG_NAMES = new Set([
  '.babelrc', '.eslintrc', '.prettierrc', 'playwright.config.js', 'playwright.config.cjs',
  'playwright.config.mjs', 'playwright.config.ts', 'playwright.config.cts', 'playwright.config.mts',
  'vitest.config.js', 'vitest.config.mjs', 'vitest.config.ts', 'jest.config.js', 'jest.config.cjs',
  'jest.config.mjs', 'jest.config.ts', 'pytest.ini', 'tox.ini', 'setup.cfg', 'tsconfig.json',
  'webpack.config.js', 'vite.config.js', 'vite.config.ts', 'rollup.config.js', 'rollup.config.ts',
  '.pre-commit-config.yaml', '.gitlab-ci.yml', 'azure-pipelines.yml', '.travis.yml',
  'jenkinsfile', 'dockerfile', 'makefile', 'agents.md', 'gateforge.md',
  'composer.json', 'composer.lock', 'bun.lock', 'bun.lockb', 'deno.lock', 'uv.lock',
  'pipfile', 'pipfile.lock', 'gemfile', 'gemfile.lock', 'go.work', 'go.work.sum',
  'pnpm-workspace.yaml', 'mix.exs', 'mix.lock', 'pubspec.yaml', 'pubspec.lock',
]);

/** Loads and validates the optional owner-declared documentation folders. */
export function loadDocsExclusions(cwd: string, config: GateforgeConfig): string[] {
  const absolute = join(cwd, ...DOCS_EXCLUSIONS_PATH.split('/'));
  if (!existsSync(absolute)) return [];
  inspectPathComponents(cwd, DOCS_EXCLUSIONS_PATH, true);
  let stat;
  try {
    stat = lstatSync(absolute);
  } catch (error) {
    throw new UsageError(`cannot inspect ${DOCS_EXCLUSIONS_PATH}: ${(error as Error).message}`);
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new UsageError(`${DOCS_EXCLUSIONS_PATH} must be a regular file, not a symlink or directory`);
  }
  let document: unknown;
  try {
    document = parseYaml(readFileSync(absolute, 'utf8'));
  } catch (error) {
    throw new UsageError(`${DOCS_EXCLUSIONS_PATH} is not valid YAML: ${(error as Error).message}`);
  }
  if (
    typeof document !== 'object' || document === null || Array.isArray(document) ||
    Object.keys(document).some((key) => key !== 'schemaVersion' && key !== 'folders') ||
    (document as Record<string, unknown>)['schemaVersion'] !== 1 ||
    !Array.isArray((document as Record<string, unknown>)['folders'])
  ) {
    throw new UsageError(`${DOCS_EXCLUSIONS_PATH} must contain only schemaVersion: 1 and a folders list`);
  }
  const folders = (document as { folders: unknown[] }).folders;
  if (folders.some((folder) => typeof folder !== 'string')) {
    throw new UsageError(`${DOCS_EXCLUSIONS_PATH} folders must contain repo-relative directories`);
  }
  return validateDocsExclusionFolders(cwd, folders as string[], config, true);
}

/** Validates an init request and returns canonical, sorted directory paths. */
export function validateRequestedDocsFolders(cwd: string, folders: readonly string[], config: GateforgeConfig): string[] {
  if (folders.length === 0) return [];
  return validateDocsExclusionFolders(cwd, [...new Set(folders)], config, true);
}

/** Validates folder names, trusted inputs, and all present filesystem entries below each folder. */
function validateDocsExclusionFolders(
  cwd: string,
  folders: readonly string[],
  config: GateforgeConfig,
  requireExisting: boolean,
): string[] {
  const normalized = folders.map((folder) => normalizeFolder(folder));
  const sorted = [...new Set(normalized)].sort();
  for (let index = 0; index < sorted.length; index += 1) {
    const current = sorted[index];
    if (current === undefined) continue;
    if (index > 0) {
      const previous = sorted[index - 1];
      if (previous !== undefined && (current === previous || current.startsWith(`${previous}/`))) {
        throw new UsageError(`documentation exclusions overlap: '${previous}' already covers '${current}'`);
      }
    }
  }
  const declared = new Set(collectDeclaredInputs(cwd, config).filter((path) => !path.startsWith('absent:')));
  for (const folder of sorted) {
    const first = folder.split('/')[0] ?? '';
    if (first === '.git' || first === '.gateforge') {
      throw new UsageError(`cannot exclude protected trust metadata folder '${folder}'`);
    }
    const absolute = join(cwd, ...folder.split('/'));
    const present = inspectPathComponents(cwd, folder, requireExisting);
    if (!present) continue;
    const rootStat = lstatSync(absolute);
    if (!rootStat.isDirectory()) throw new UsageError(`documentation exclusion '${folder}' is not a directory`);
    const inspect = (directory: string, relativeDirectory: string): void => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const relativePath = `${relativeDirectory}/${entry.name}`;
        const entryPath = join(directory, entry.name);
        const entryStat = lstatSync(entryPath);
        if (entryStat.isSymbolicLink()) {
          throw new UsageError(`documentation exclusion rejects symlink '${relativePath}' (fail closed)`);
        }
        if (entryStat.isDirectory()) {
          inspect(entryPath, relativePath);
          continue;
        }
        if (!entryStat.isFile()) {
          throw new UsageError(`documentation exclusion rejects non-file input '${relativePath}' (fail closed)`);
        }
        if (isProtectedFile(relativePath, entry.name, entryStat.mode, declared)) {
          throw new UsageError(`cannot exclude executable or gate input '${relativePath}'`);
        }
        if (!isAllowlistedDocumentationFile(entry.name)) {
          throw new UsageError(
            `cannot exclude '${relativePath}': file type is outside the documentation and static-asset allowlist (fail closed)`,
          );
        }
      }
    };
    inspect(absolute, folder);
    for (const input of declared) {
      if (input === folder || input.startsWith(`${folder}/`)) {
        throw new UsageError(`cannot exclude configured scan or gate input '${input}'`);
      }
    }
  }
  return sorted;
}

/** Normalizes one repo-relative directory and rejects globs and traversal. */
function normalizeFolder(folder: string): string {
  if (
    folder.length === 0 || folder.includes('\\') || folder.startsWith('/') || /^[A-Za-z]:/.test(folder) ||
    /[*?\[\]{}!]/.test(folder) || folder.endsWith('/')
  ) {
    throw new UsageError(`documentation exclusion '${folder}' must be an exact repo-relative folder path`);
  }
  const segments = folder.split('/');
  if (segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')) {
    throw new UsageError(`documentation exclusion '${folder}' must not contain empty, '.' or '..' path segments`);
  }
  return segments.join('/');
}

/** Rejects symlinked parent folders and checks whether the requested folder exists. */
function inspectPathComponents(cwd: string, folder: string, requireExisting: boolean): boolean {
  let cursor = resolve(cwd);
  for (const segment of folder.split('/')) {
    cursor = join(cursor, segment);
    let stat;
    try {
      stat = lstatSync(cursor);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new UsageError(`cannot inspect documentation exclusion folder '${folder}': ${(error as Error).message}`);
      }
      if (requireExisting) throw new UsageError(`documentation exclusion folder '${folder}' does not exist`);
      return false;
    }
    if (stat.isSymbolicLink()) throw new UsageError(`documentation exclusion rejects symlink path '${folder}' (fail closed)`);
  }
  return true;
}

/** Returns true when a file is executable, a manifest, a config, or a declared gate input. */
function isProtectedFile(
  relativePath: string,
  basename: string,
  mode: number,
  declared: ReadonlySet<string>,
): boolean {
  const normalized = relativePath.split('\\').join('/');
  const segments = normalized.split('/');
  const extension = basename.includes('.') ? basename.slice(basename.lastIndexOf('.')).toLowerCase() : '';
  const lower = basename.toLowerCase();
  return (
    (mode & 0o111) !== 0 ||
    segments.some((segment) => ['.git', '.gateforge', '.github', '.agents', '.codex'].includes(segment)) ||
    declared.has(normalized) ||
    MANIFEST_NAMES.includes(basename) ||
    GIT_SCOPE_CONTROL_BASENAMES.includes(basename) ||
    PACK_CONFIGS.includes(normalized) ||
    EXECUTABLE_EXTENSIONS.has(extension) ||
    EXECUTION_CONFIG_NAMES.has(lower) ||
    lower.includes('.config.') && !DOCUMENTATION_EXTENSIONS.has(extension) ||
    lower.startsWith('requirements') && lower.endsWith('.txt') ||
    lower.startsWith('tsconfig.') ||
    lower.endsWith('.lock') ||
    lower.endsWith('.lockb') ||
    lower.endsWith('-lock.json') ||
    lower.endsWith('-lock.yaml') ||
    lower.endsWith('.lock.json')
  );
}

/** Checks whether a file has a supported documentation or static-raster type. */
function isAllowlistedDocumentationFile(basename: string): boolean {
  const lower = basename.toLowerCase();
  const extension = lower.includes('.') ? lower.slice(lower.lastIndexOf('.')) : '';
  return DOCUMENTATION_BASENAMES.has(lower) || DOCUMENTATION_EXTENSIONS.has(extension);
}

/** Writes the owner declaration in a stable format. */
export function renderDocsExclusions(folders: readonly string[]): string {
  return folders.length === 0
    ? 'schemaVersion: 1\nfolders: []\n'
    : `schemaVersion: 1\nfolders:\n${folders.map((folder) => `  - ${JSON.stringify(folder)}`).join('\n')}\n`;
}
