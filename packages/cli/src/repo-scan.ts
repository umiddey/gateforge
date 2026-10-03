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
// Git-ignore scope for the heuristic walk (owner decision D5): content
// in a gitignored tree (a built report bundle, a local cache) is not
// what the repository is made of, so it must not decide what `init`
// recommends — a dirty working copy then recommends exactly what a
// clean clone of the same commit does.
import { gitIgnoredPaths, type GitIgnoredScope } from './git-ignored.js';

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
 * `playwright`, `vitest`, `cypress`, `pytest`, `http-clients`. Each
 * signal carries the file evidence it was read from in `reasons`.
 */
export interface RepoScan {
  /** Detected languages, deterministically ordered. */
  languages: string[];
  /** Detected signals, deterministically ordered. */
  signals: string[];
  /**
   * The concrete evidence behind each signal, keyed by signal name: a
   * human sentence naming what was read and the repo-relative file it
   * was read from. Absent for a signal with no file evidence.
   */
  reasons?: Record<string, string>;
}

/** The signal that justifies each recommended pack, in print order. */
const PACK_SIGNAL: Record<string, string> = {
  'gateforge.pack-fastapi': 'fastapi',
  'gateforge.pack-sqlalchemy': 'sqlalchemy',
  'gateforge.pack-http': 'http-clients',
};

/**
 * A SQLModel table model written with `SQLModel` literally in the class
 * head: `class Item(SQLModel, table=True)`. An SQLAlchemy model the
 * declarative-base needles below never match.
 */
const SQLMODEL_TABLE = /class\s+([A-Za-z_]\w*)\s*\(\s*SQLModel\b[^)]*\btable\s*=\s*True/;

/**
 * One `class <Name>(<bases>)` head, captured for base-chain resolution.
 * A head is "table-bearing" when it also carries `table=True`.
 */
const CLASS_HEAD = /class\s+([A-Za-z_]\w*)\s*\(([^)]*)\)/g;

/** A `table=True` class keyword, the SQLModel table marker. */
const TABLE_TRUE = /\btable\s*=\s*True\b/;

/** An `import`/`from ... import` binding, for cross-module base provenance. */
const IMPORT_BINDING = /(?:^|\n)\s*from\s+([\w.]+)\s+import\s+([^\n(]+)|(?:^|\n)\s*import\s+([\w.]+)/g;

/**
 * The simple names a module binds from `sqlmodel` (`SQLModel` itself, or
 * whatever alias it is imported as).
 */
function sqlmodelLocalNames(text: string): Set<string> {
  const names = new Set<string>();
  for (const match of text.matchAll(IMPORT_BINDING)) {
    const module = match[1];
    const imported = match[2];
    if (module === undefined || !/^sqlmodel(\.|\b)/.test(module) || imported === undefined) continue;
    for (const raw of imported.split(',')) {
      const parts = raw.trim().split(/\s+as\s+/);
      const local = parts[1] ?? parts[0];
      if (local !== undefined && /^[A-Za-z_]\w*$/.test(local)) names.add(local);
    }
  }
  return names;
}

/** Every class declared in one file, with its base simple names. */
function classHeads(text: string): Map<string, string[]> {
  const declared = new Map<string, string[]>();
  for (const match of text.matchAll(CLASS_HEAD)) {
    const name = match[1];
    const bases = match[2];
    if (name === undefined || bases === undefined) continue;
    declared.set(
      name,
      bases
        .split(',')
        .map((base) => base.trim().split(/[\s=(:]/)[0] ?? '')
        .filter((base) => /^[A-Za-z_]\w*$/.test(base)),
    );
  }
  return declared;
}

/** The `table=True` class heads of one file, with their base simple names. */
function tableClassHeads(text: string): Array<{ name: string; bases: string[] }> {
  const tables: Array<{ name: string; bases: string[] }> = [];
  for (const match of text.matchAll(CLASS_HEAD)) {
    const name = match[1];
    const bases = match[2];
    if (name === undefined || bases === undefined || !TABLE_TRUE.test(bases)) continue;
    tables.push({
      name,
      bases: bases
        .split(',')
        .map((base) => base.trim().split(/[\s=(:]/)[0] ?? '')
        .filter((base) => /^[A-Za-z_]\w*$/.test(base)),
    });
  }
  return tables;
}

/** Whether one base simple name reaches SQLModel through `declared`. */
function baseReachesSqlmodel(
  base: string,
  declared: ReadonlyMap<string, readonly string[]>,
  sqlmodelRoots: ReadonlySet<string>,
  depth = 0,
): boolean {
  if (sqlmodelRoots.has(base)) return true;
  if (depth > 4) return false;
  const bases = declared.get(base);
  if (bases === undefined) return false;
  return bases.some((parent) => baseReachesSqlmodel(parent, declared, sqlmodelRoots, depth + 1));
}

/**
 * A SQLModel table model whose base is another class: the shape the
 * canonical FastAPI template writes — `class UserBase(SQLModel)` above
 * `class User(UserBase, table=True)`. The base chain resolves over the
 * classes THIS file declares, and over `importedBases`: simple names
 * imported from a module that itself declares a SQLModel class. A chain
 * that never reaches SQLModel is never promoted.
 *
 * Args:
 *   text: the python file's source.
 *   sqlmodelRoots: names bound from `sqlmodel` in this file.
 *   importedBases: names imported from modules that declare SQLModel classes.
 *
 * Returns:
 *   string | null: the class head a signal can quote, or null.
 */
function sqlmodelTableInFile(
  text: string,
  sqlmodelRoots: ReadonlySet<string>,
  importedBases: ReadonlySet<string>,
): string | null {
  const declared = classHeads(text);
  for (const table of tableClassHeads(text)) {
    // `table=True` splits to the bare keyword `table`; it is the marker,
    // never a base, so the quoted head re-joins it as written.
    const head = `${table.name}(${[...table.bases.filter((base) => base !== 'table'), 'table=True'].join(', ')})`;
    if (table.bases.some((base) => baseReachesSqlmodel(base, declared, sqlmodelRoots))) return head;
    if (table.bases.some((base) => importedBases.has(base))) return head;
  }
  return null;
}

/**
 * The simple names other modules may import as a SQLModel base: every
 * class a module that imports sqlmodel declares over a SQLModel root
 * (its own `class UserBase(SQLModel)`), plus the sqlmodel names it
 * binds itself.
 */
function exportedSqlmodelNames(texts: ReadonlyMap<string, string>): Set<string> {
  const exported = new Set<string>();
  for (const text of texts.values()) {
    const roots = sqlmodelLocalNames(text);
    if (roots.size === 0) continue;
    const declared = classHeads(text);
    for (const [name, bases] of declared) {
      if (bases.some((base) => baseReachesSqlmodel(base, declared, roots))) exported.add(name);
    }
  }
  return exported;
}

/**
 * A generated API client inside a js/ts file: the generator's own
 * banner, or an import of a generated-client runtime. Matched in file
 * text only — a directory merely named `client` is not evidence.
 */
const GENERATED_CLIENT =
  /(?:auto|code)[-\s]?generated[^\n]{0,120}?(openapi|hey-api|orval|swagger)|from\s+['"](@hey-api\/client-fetch|openapi-fetch|@orval\/[a-z-]+|@openapitools\/[a-z-]+)['"]/i;

/** A shared axios instance — one client every call goes through. */
const AXIOS_INSTANCE = /axios\s*\.\s*create\s*\(/;

/** The file extensions whose text can carry a js/ts client signal. */
const JS_OR_TS = /\.(js|jsx|mjs|cjs|ts|tsx)$/;

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
  collectFiles(cwd, cwd, files, gitIgnoredPaths(cwd));
  let hasPy = false;
  let hasJs = false;
  let hasTs = false;
  let hasPackageJson = false;
  let hasPlaywright = false;
  let hasVitest = false;
  let hasCypress = false;
  let hasPytestIni = false;
  let hasPytestToml = false;
  let hasPytestFile = false;
  /** Signal → the concrete file evidence that justifies it. */
  const reasons: Record<string, string> = {};
  // The cross-module half of the SQLModel base-chain rule needs every
  // python file's text up front (a base imported from a module that
  // imports sqlmodel). Bounded by the same size guard as the scan.
  const pythonTexts = new Map<string, string>();
  for (const file of files) {
    if (!file.endsWith('.py')) continue;
    const text = readSmallText(join(cwd, file));
    if (text !== null) pythonTexts.set(file, text);
  }
  const exportedBases = exportedSqlmodelNames(pythonTexts);
  for (const file of files) {
    const base = basename(file);
    if (file.endsWith('.py')) hasPy = true;
    if (/\.(js|jsx|mjs|cjs)$/.test(file)) hasJs = true;
    if (/\.(ts|tsx)$/.test(file)) hasTs = true;
    if (base === 'package.json') {
      hasPackageJson = true;
      const dependency = packageJsonHttpClient(join(cwd, file));
      if (dependency && !reasons['http-clients']) {
        reasons['http-clients'] = `package.json dependency '${dependency}' in ${file}`;
      }
    }
    if (base.startsWith('playwright.config.')) hasPlaywright = true;
    if (base.startsWith('vitest.config.') || base.startsWith('vite.config.')) hasVitest = true;
    if (base.startsWith('cypress.config.') || base === 'cypress.json') hasCypress = true;
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
    if (file.endsWith('.py') && !reasons.sqlalchemy) {
      const text = pythonTexts.get(file) ?? null;
      const sqlmodel = text === null ? null : SQLMODEL_TABLE.exec(text);
      const chained = text === null ? null : sqlmodelTableInFile(text, sqlmodelLocalNames(text), exportedBases);
      if (sqlmodel) {
        reasons.sqlalchemy =
          `SQLModel table model 'class ${sqlmodel[1]}(SQLModel, table=True)' in ${file}`;
      } else if (chained !== null) {
        reasons.sqlalchemy = `SQLModel table model 'class ${chained}' in ${file}`;
      } else if (
        text !== null &&
        (text.includes('DeclarativeBase') ||
          text.includes('declarative_base(') ||
          text.includes('__tablename__'))
      ) {
        reasons.sqlalchemy = `SQLAlchemy declarative model in ${file}`;
      }
    }
    if (file.endsWith('.py') && !reasons.fastapi) {
      const text = readSmallText(join(cwd, file));
      if (text !== null && (text.includes('from fastapi') || text.includes('import fastapi'))) {
        reasons.fastapi = `FastAPI imported ('from fastapi') in ${file}`;
      }
    }
    if (JS_OR_TS.test(file) && !reasons['http-clients']) {
      const text = readSmallText(join(cwd, file));
      if (text !== null && GENERATED_CLIENT.test(text)) {
        reasons['http-clients'] = `generated API client in ${file}`;
      } else if (text !== null && AXIOS_INSTANCE.test(text)) {
        reasons['http-clients'] = `shared axios client instance in ${file}`;
      }
    }
  }
  const languages: string[] = [];
  if (hasPy) languages.push('python');
  if (hasJs || (hasPackageJson && !hasTs)) languages.push('javascript');
  if (hasTs) languages.push('typescript');
  if (languages.length === 0) languages.push('python');
  const signals: string[] = [];
  if (reasons.sqlalchemy) signals.push('sqlalchemy');
  if (reasons.fastapi) signals.push('fastapi');
  if (hasPlaywright) signals.push('playwright');
  if (hasVitest) signals.push('vitest');
  if (hasCypress) signals.push('cypress');
  if (hasPytestIni || hasPytestToml || hasPytestFile) signals.push('pytest');
  if (reasons['http-clients']) signals.push('http-clients');
  return { languages, signals, reasons };
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
    ...plugins.flatMap((plugin) => {
      const signal = PACK_SIGNAL[plugin];
      const evidence = signal === undefined ? undefined : scan.reasons?.[signal];
      return [
        `  why: ${plugin} — ${
          evidence ?? `no repository signal — the ${scan.languages.join('/')} default set`
        }`,
      ];
    }),
    '  policy: persistence:* on user-facing tables; transport-only HTTP on consumed endpoints',
    proof === 'observe'
      ? '  proof: observe (existing suite through the witness — no new tests)'
      : '  proof: overlay (tests/e2e/gateforge/)',
    'skipped:',
    '  gateforge.pack-task — no semantic verifier (VERIFIER_UNSUPPORTED)',
    '  http:frontend-request-observed — not provable yet: no independent browser channel',
    '  coveragePolicy / strictE2E — owner opt-in',
  ].join('\n');
}

/**
 * Recursively collects repo-relative file paths, skipping ignored
 * directories and every path this run's Git-ignore scope excludes.
 * Fail-open: unreadable directories contribute nothing.
 */
function collectFiles(
  root: string,
  dir: string,
  out: string[],
  gitIgnored: GitIgnoredScope,
): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (IGNORED_DIRS.has(entry)) continue;
    const absolute = join(dir, entry);
    const relativePath = relative(root, absolute).split('\\').join('/');
    if (gitIgnored.skipsDirectory(relativePath)) continue;
    let stat: ReturnType<typeof statSync>;
    try {
      stat = statSync(absolute);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      collectFiles(root, absolute, out, gitIgnored);
    } else if (gitIgnored.skipsFile(relativePath)) {
      continue;
    } else if (stat.isFile()) {
      out.push(relativePath);
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

/** The HTTP framework dependency a package.json names, if any. */
function packageJsonHttpClient(absolute: string): string | null {
  const text = readSmallText(absolute);
  if (text === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
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
        return name;
      }
    }
  }
  return null;
}
