/**
 * Heuristic repository scan for `gateforge init`: cheap filesystem
 * signals only — no network, no plugin execution, fail-open (unreadable
 * files are skipped, never fatal). Ignores dependency and build output
 * (`node_modules`, `.venv`, `venv`, `dist`, `build`, `.git`).
 *
 * The scan answers two questions: which languages the repo uses, and
 * which bundled-detector signals are present — so init can RECOMMEND a
 * minimal install and let the user choose, instead of silently enabling
 * packs whose proof channels do not exist.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join, relative } from 'node:path';

/** Directories never descended into (dependency, build, VCS output). */
const IGNORED_DIRS = new Set([
  'node_modules',
  '.venv',
  'venv',
  '.git',
  'dist',
  'build',
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
]);

/** Files larger than this are never content-scanned (binary guard). */
const MAX_SCAN_BYTES = 1024 * 1024;

/**
 * The heuristic scan result: detected languages and detector signals.
 * Languages are a subset of `python` / `javascript` / `typescript`
 * (`python` when the repo is empty or yields no signal). Signals name
 * the bundled-detector evidence found: `sqlalchemy`, `fastapi`,
 * `playwright`, `pytest`, `http-clients`.
 */
export interface RepoScan {
  /** Detected languages, deterministically ordered. */
  languages: string[];
  /** Detected signals, deterministically ordered. */
  signals: string[];
}

/**
 * Scans the repository rooted at `cwd`.
 *
 * Args:
 *   cwd: absolute repo root.
 *
 * Returns:
 *   RepoScan: languages + signals (fail-open: unreadable paths are
 *   skipped, an empty repo reports `python` with no signals).
 */
export function scanRepo(cwd: string): RepoScan {
  const files: string[] = [];
  collectFiles(cwd, cwd, files);
  let hasPy = false;
  let hasJs = false;
  let hasTs = false;
  let hasPackageJson = false;
  let hasSqlalchemy = false;
  let hasFastapi = false;
  let hasPlaywright = false;
  let hasPytestIni = false;
  let hasPytestToml = false;
  let hasPytestFile = false;
  let hasHttpClient = false;
  for (const file of files) {
    const base = basename(file);
    if (file.endsWith('.py')) hasPy = true;
    if (/\.(js|jsx|mjs|cjs)$/.test(file)) hasJs = true;
    if (/\.(ts|tsx)$/.test(file)) hasTs = true;
    if (base === 'package.json') {
      hasPackageJson = true;
      if (packageJsonHasHttpClient(join(cwd, file))) hasHttpClient = true;
    }
    if (base.startsWith('playwright.config.')) hasPlaywright = true;
    if (base === 'pytest.ini') hasPytestIni = true;
    if (base === 'pyproject.toml' && fileTextContains(join(cwd, file), '[tool.pytest')) {
      hasPytestToml = true;
    }
    if (
      file.endsWith('.py') &&
      basename(file).startsWith('test_') &&
      /(^|\/)tests\//.test(`/${file}`)
    ) {
      hasPytestFile = true;
    }
    if (file.endsWith('.py') && !hasSqlalchemy) {
      if (
        fileTextContains(join(cwd, file), 'DeclarativeBase') ||
        fileTextContains(join(cwd, file), 'declarative_base(') ||
        fileTextContains(join(cwd, file), '__tablename__')
      ) {
        hasSqlalchemy = true;
      }
    }
    if (file.endsWith('.py') && !hasFastapi) {
      if (
        fileTextContains(join(cwd, file), 'from fastapi') ||
        fileTextContains(join(cwd, file), 'import fastapi')
      ) {
        hasFastapi = true;
      }
    }
  }
  const languages: string[] = [];
  if (hasPy) languages.push('python');
  if (hasJs || (hasPackageJson && !hasTs)) languages.push('javascript');
  if (hasTs) languages.push('typescript');
  if (languages.length === 0) languages.push('python');
  const signals: string[] = [];
  if (hasSqlalchemy) signals.push('sqlalchemy');
  if (hasFastapi) signals.push('fastapi');
  if (hasPlaywright) signals.push('playwright');
  if (hasPytestIni || hasPytestToml || hasPytestFile) signals.push('pytest');
  if (hasHttpClient) signals.push('http-clients');
  return { languages, signals };
}

/**
 * Recommends bundled plugin ids for a scan. Never includes
 * `gateforge.pack-task` (no semantic verifier — opt-in only via
 * `--plugins`). Signal-derived when signals exist, otherwise the
 * language-derived bundled set (empty repos: sqlalchemy + fastapi).
 *
 * Args:
 *   scan: the heuristic scan result.
 *
 * Returns:
 *   string[]: deterministically ordered bundled plugin ids.
 */
export function recommendPlugins(scan: RepoScan): string[] {
  const languages = new Set(scan.languages.map((language) => language.toLowerCase()));
  const signals = new Set(scan.signals);
  const ids: string[] = [];
  if (languages.has('python') && signals.has('fastapi')) ids.push('gateforge.pack-fastapi');
  if (languages.has('python') && signals.has('sqlalchemy')) ids.push('gateforge.pack-sqlalchemy');
  if (
    (languages.has('javascript') || languages.has('typescript')) &&
    signals.has('http-clients')
  ) {
    ids.push('gateforge.pack-http');
  }
  if (ids.length > 0) return ids;
  return languageDefaultPlugins([...languages]);
}

/**
 * The language-derived bundled plugin set (no scan): python →
 * fastapi + sqlalchemy, js/ts → http. Never pack-task.
 *
 * Args:
 *   languages: selected languages (case-insensitive).
 *
 * Returns:
 *   string[]: deterministically ordered bundled plugin ids.
 */
export function languageDefaultPlugins(languages: readonly string[]): string[] {
  const normalized = new Set(languages.map((language) => language.toLowerCase()));
  const ids: string[] = [];
  if (normalized.has('python')) ids.push('gateforge.pack-fastapi', 'gateforge.pack-sqlalchemy');
  if (normalized.has('javascript') || normalized.has('typescript')) {
    ids.push('gateforge.pack-http');
  }
  return ids;
}

/**
 * Renders the human scan/recommended/skipped block init prints before
 * writing anything.
 *
 * Args:
 *   scan: the heuristic scan result.
 *   plugins: the recommended (or explicit) plugin ids.
 *   proof: the selected proof path (`overlay` default, `observe` reuses
 *     the existing suite through the witness).
 *
 * Returns:
 *   string: the multi-line block.
 */
export function renderScanBlock(
  scan: RepoScan,
  plugins: readonly string[],
  proof: 'overlay' | 'observe' = 'overlay',
): string {
  return [
    'scan:',
    `  languages: ${scan.languages.join(', ')}`,
    `  signals: ${scan.signals.length > 0 ? scan.signals.join(', ') : '(none)'}`,
    'recommended:',
    `  plugins: ${plugins.length > 0 ? [...plugins].join(', ') : '(none)'}`,
    '  policy: persistence:* on user-facing tables',
    proof === 'observe'
      ? '  proof: observe (existing suite through the witness — no new tests)'
      : '  proof: overlay (tests/e2e/gateforge/)',
    'skipped:',
    '  gateforge.pack-task — no semantic verifier (VERIFIER_UNSUPPORTED)',
    '  http:frontend-request-observed — no independent browser channel',
    '  coveragePolicy / strictE2E — owner opt-in',
  ].join('\n');
}

/**
 * Recursively collects repo-relative file paths, skipping ignored
 * directories. Fail-open: unreadable directories contribute nothing.
 */
function collectFiles(root: string, dir: string, out: string[]): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (IGNORED_DIRS.has(entry)) continue;
    const absolute = join(dir, entry);
    let stat: ReturnType<typeof statSync>;
    try {
      stat = statSync(absolute);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      collectFiles(root, absolute, out);
    } else if (stat.isFile()) {
      out.push(relative(root, absolute).split('\\').join('/'));
    }
  }
}

/** Reads a small text file; returns null when unreadable or too large. */
function readSmallText(absolute: string): string | null {
  try {
    if (!existsSync(absolute)) return null;
    const stat = statSync(absolute);
    if (!stat.isFile() || stat.size > MAX_SCAN_BYTES) return null;
    return readFileSync(absolute, 'utf8');
  } catch {
    return null;
  }
}

/** Whether a file's text contains a needle (false when unreadable). */
function fileTextContains(absolute: string, needle: string): boolean {
  const text = readSmallText(absolute);
  return text !== null && text.includes(needle);
}

/** Whether a package.json names an HTTP framework dependency. */
function packageJsonHasHttpClient(absolute: string): boolean {
  const text = readSmallText(absolute);
  if (text === null) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return false;
  }
  if (typeof parsed !== 'object' || parsed === null) return false;
  const sections = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];
  for (const section of sections) {
    const deps = (parsed as Record<string, unknown>)[section];
    if (typeof deps !== 'object' || deps === null) continue;
    for (const name of Object.keys(deps as Record<string, unknown>)) {
      if (
        name === 'express' ||
        name === 'fastify' ||
        name === 'hono' ||
        name === '@nestjs' ||
        name.startsWith('@nestjs/')
      ) {
        return true;
      }
    }
  }
  return false;
}
