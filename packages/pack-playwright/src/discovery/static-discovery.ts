/**
 * Bounded static discovery of Playwright tests (plan 2026-09-13 phase 2
 * item 3): a TypeScript-compiler-API scan of the configured test-file
 * globs — the same AST-only pattern as `@gate-forge/pack-http`'s
 * client-call scanner (pure analysis, no evaluation).
 *
 * The model is deliberately bounded and fail-closed:
 *
 * - **Test calls**: `test('title', fn)`, `test.skip/.only/.fixme(...)`,
 *   `test.each([...])(...)` — resolved through local aliases and the
 *   relative-import graph (`const t = test.extend({...})`,
 *   `t('title', ...)` in another file), plus this pack's own runner
 *   specifier `@gate-forge/pack-playwright` (its exported `test` is a
 *   playwright test function — the documented consumer import). Every
 *   other module-external binding stays unproven.
 * - **Describes**: nested `test.describe('X', () => {...})` stacks build
 *   each case's full titlePath.
 * - **Parameterization**: `test.each` and template-literal titles are
 *   recorded via `parameterIdentity` (with `${}` slots); a computed
 *   title that cannot be resolved statically becomes an UNRESOLVED row,
 *   never an omission.
 * - **Budgets**: import traversal has a file-count budget and a depth
 *   bound; exceeding either records `traversal-budget-exceeded`
 *   unresolved rows instead of looping.
 * - **Unresolvable wrappers**: a call through a name that cannot be
 *   proven to be a test function becomes an unresolved row with its
 *   call location — never "no tests".
 * - **Parse errors**: every parser diagnostic is recorded with its
 *   location; a file that half-parses contributes both its rows and a
 *   parse error.
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, posix } from 'node:path';
import ts from 'typescript';
import { pathInScope, type Location } from '@gate-forge/core';
import { CLAIM_ANNOTATION_TYPE } from '../constants.js';
import { gitIgnoredPaths } from './git-ignore.js';

/** Default cap on files pulled in through import traversal. */
export const DEFAULT_MAX_TRAVERSED_FILES = 200;

/** Default bound on import-traversal depth (chain length). */
export const DEFAULT_MAX_IMPORT_DEPTH = 16;

/** Traversal-budget knobs for one scan. */
export interface ScanBudget {
  /** Max files pulled in through import traversal (default 200). */
  maxTraversedFiles?: number;
  /** Max import-chain depth when resolving an alias (default 16). */
  maxImportDepth?: number;
}

/**
 * A caller-supplied veto over one repo-relative posix file. Returning
 * true means the file is NOT a static-discovery candidate. It is
 * consulted at the candidate-seed boundary only, so it never removes
 * a file the runner legitimately enumerates, and never shortens
 * import traversal (a traversed import target is read for bindings
 * whatever the seed says about it).
 */
export type RepoRelativeFileFilter = (repoRelativePath: string) => boolean;

/** Options for one static test scan. */
export interface StaticScanOptions {
  /** Absolute repo root. */
  cwd: string;
  /** Repo-root-relative include globs (the configured test files). */
  include: readonly string[];
  /** Repo-root-relative exclude globs (any match wins). */
  exclude: readonly string[];
  /**
   * Optional veto over seeded candidates (repo-relative posix paths).
   *
   * The seed is the ONLY place this applies: a file the caller hides
   * here contributes no static rows, while import traversal from a
   * kept file and the native runner's own enumeration are untouched.
   * Gateforge's CLI passes the engine's own generated run-state
   * artifacts (see `cli/src/state-artifacts.ts`) so the controller
   * spec a first run persists into the state directory cannot be
   * harvested back as a test the repository never declared.
   */
  excludeFile?: RepoRelativeFileFilter;
  /**
   * Per-file runner-globals predicate (repo-relative posix paths).
   *
   * TRUE when the file's own runner injects `test`/`it`/`describe` as
   * GLOBALS (vitest `globals: true`): in such a file a bare
   * `it('…')`/`test('…')` IS a test registration the runner owns, not
   * an alias the scan could not resolve. Without this predicate every
   * unbound call stays `unresolved-test-alias`, which is what a file
   * without runner globals must keep.
   */
  testGlobals?: RepoRelativeFileFilter;
  /** Traversal budgets (defaults documented on {@link ScanBudget}). */
  budget?: ScanBudget;
}

/** Facts one static test call exposes for kind inference. */
export interface StaticTestFacts {
  /** Fixture names in the test callback's first parameter. */
  signatureParams: string[];
  /** `page.route(...)` (or any `<x>.route(`) inside the test body. */
  pageRoute: Location | null;
  /** Literal URL patterns passed to `page.route(...)`, when statically known. */
  pageRouteTargets?: string[];
  /** fetch/axios call inside the test body. */
  httpClientCall: Location | null;
  /** fetch/axios call anywhere in the file (app-boundary import hint). */
  fileHttpClientCall: Location | null;
  /** `vi.mock(...)` / `jest.mock(...)` anywhere in the file. */
  fileMockImport: Location | null;
  /**
   * The page-observation tamper attributed to THIS test: a tamper
   * written in the spec, one the test's body or registration fixture
   * provably reaches in an imported helper, or — when reachability
   * cannot be proven — the file-wide graph tamper as before (0.13.10
   * F3). Null when the scan proves the test never reaches any. Static
   * observation risks are refused by the witness; this location names
   * the offending file and source line.
   */
  fileRouteInterception: Location | null;
  /**
   * Import of the gateforge evidence pack (`@gate-forge/pack-playwright`)
   * anywhere in the file. Lets inference tell fixture tests (which take
   * the `evidence` param and never drive the browser themselves) apart
   * from suite-driven browser tests for Observe-channel suggestions.
   */
  gateforgeFixtureImport: Location | null;
}

/** One statically discovered test call. */
export interface StaticTestEntry {
  /** Repo-root-relative posix file path. */
  file: string;
  /** Describe stack + title. */
  titlePath: string[];
  /** Last segment of {@link titlePath}. */
  title: string;
  /** Test-call location (diagnostics, never identity). */
  location: Location;
  /** `each`/template parameter identity, or null. */
  parameterIdentity: string | null;
  /** Suppression signals recorded at/below this call. */
  signals: Array<{ kind: 'skip' | 'only' | 'fixme'; detail: string; location: Location }>;
  /** Inference facts from the call + callback body. */
  facts: StaticTestFacts;
  /** Literal claims from this test's Gateforge annotations, when present. */
  annotationClaims?: string[];
  /** Why a Gateforge annotation could not be resolved without execution. */
  annotationIssue?: string;
}

/** One statically detected gap (unresolvable call, budget, dynamic title). */
export interface StaticUnresolved {
  /** Stable code, e.g. `unresolved-wrapper`. */
  code: string;
  /** Single-cause human explanation. */
  detail: string;
  /** Repo-relative file of the gap (catalog row input). */
  file: string;
  /** Title path when a literal title was readable, else a placeholder. */
  titlePath: string[];
  /** Location of the unresolved call/import. */
  location: Location;
  /** Call-site facts retained when the title is dynamic but the test binding is proven. */
  facts?: StaticTestFacts;
  /** Suppression signals from that call site and its lexical describe stack. */
  signals?: StaticTestEntry['signals'];
}

/** One parser failure with its location. */
export interface StaticParseError {
  file: string;
  message: string;
  location: Location;
}

/** A test registration is controlled by a Gateforge environment variable. */
export interface StaticRegistrationWarning {
  file: string;
  titlePath: string[];
  environmentVariable: string;
  location: Location;
}

/** Result of one static scan. */
export interface StaticScanResult {
  entries: StaticTestEntry[];
  unresolved: StaticUnresolved[];
  parseErrors: StaticParseError[];
  registrationWarnings: StaticRegistrationWarning[];
  /** Repo-relative files that were parsed (seeded + traversed). */
  scannedFiles: string[];
  /**
   * Resolved RELATIVE import edges of every file the scan modeled: one
   * row per modeled file with the repo-relative posix paths its own
   * module-scope imports resolve to. This is the import graph, read from
   * ASTs — a folder is test infrastructure because a catalog test imports
   * it, never because of what the folder is called.
   */
  importsByFile: { file: string; imports: string[] }[];
  /** True when the import-traversal budget cut resolution short. */
  budgetExceeded: boolean;
}

/** Placeholder titlePath for unresolved calls with no readable title. */
export const UNRESOLVED_TITLE_PLACEHOLDER = '<unresolved-title>';

/** Directories never descended into (build output, deps, VCS state). */
const PRUNED_DIRS = new Set(['.git', 'node_modules', 'dist', 'test-results', 'playwright-report']);

/** File extensions the scanner parses (everything else is skipped). */
const PARSEABLE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];

/** Playwright's exported test-function binding names. */
const TEST_BINDING_NAMES = new Set(['test', 'it']);

/**
 * Test-structure names: a bare call through one of these is still a
 * possible test registration even with no module-scope binding (an
 * import-less global `test`/`it`/`describe`), so it stays a visible row.
 * Any OTHER unbound bare identifier is an ordinary local call, not a
 * test alias (consumer migration, E22: UI callbacks like
 * `handleAction('export-csv', cb)` defined in function scope).
 */
const TEST_STRUCTURE_NAMES = new Set(['test', 'it', 'describe']);

/**
 * The package root and exported `fixture` subpath both expose the pack's
 * Playwright test function (`base.extend` over `playwright/test` — see
 * `fixture/fixture.ts`). Binding either sanctioned runner source lets the
 * static scan follow documented package imports instead of emitting
 * unresolvable rows. Every OTHER module-external import stays unresolved —
 * fail-closed is unchanged.
 */
export const GATEFORGE_PACK_SPECIFIER = '@gate-forge/pack-playwright';

/** Reads package metadata without loading or executing consumer code. */
function readPackageMetadata(state: ScanState, absolutePath: string): Record<string, unknown> | null {
  const cached = state.packageMetadata.get(absolutePath);
  if (cached !== undefined) return cached;
  let metadata: Record<string, unknown> | null = null;
  if (isFile(absolutePath)) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(absolutePath, 'utf8'));
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        metadata = parsed as Record<string, unknown>;
      }
    } catch {
      // Invalid package metadata is not proof of package identity.
    }
  }
  state.packageMetadata.set(absolutePath, metadata);
  return metadata;
}

function packageDeclaresAlias(metadata: Record<string, unknown> | null, alias: string): boolean {
  if (metadata === null) return false;
  for (const field of ['dependencies', 'devDependencies', 'optionalDependencies']) {
    const group = metadata[field];
    if (typeof group !== 'object' || group === null || Array.isArray(group)) continue;
    const target = (group as Record<string, unknown>)[alias];
    if (
      typeof target === 'string' &&
      (target === `npm:${GATEFORGE_PACK_SPECIFIER}` ||
        (target.startsWith(`npm:${GATEFORGE_PACK_SPECIFIER}@`) &&
          target.length > `npm:${GATEFORGE_PACK_SPECIFIER}@`.length))
    ) {
      return true;
    }
  }
  return false;
}

/** Whether a bare package name is proven to alias the Gateforge package. */
function isGateforgePackageAlias(state: ScanState, file: string, alias: string): boolean {
  if (!/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i.test(alias)) return false;

  const rootPackage = readPackageMetadata(state, join(state.cwd, 'package.json'));
  if (packageDeclaresAlias(rootPackage, alias)) return true;

  let directory = join(state.cwd, posix.dirname(file));
  let nearestPackagePath: string | null = null;
  while (directory === state.cwd || directory.startsWith(`${state.cwd}/`)) {
    const candidate = join(directory, 'package.json');
    if (isFile(candidate)) {
      nearestPackagePath = candidate;
      break;
    }
    if (directory === state.cwd) break;
    directory = posix.dirname(directory);
  }
  if (
    nearestPackagePath !== null &&
    nearestPackagePath !== join(state.cwd, 'package.json') &&
    packageDeclaresAlias(readPackageMetadata(state, nearestPackagePath), alias)
  ) {
    return true;
  }

  directory = join(state.cwd, posix.dirname(file));
  while (directory === state.cwd || directory.startsWith(`${state.cwd}/`)) {
    const installed = readPackageMetadata(state, join(directory, 'node_modules', alias, 'package.json'));
    if (installed?.name === GATEFORGE_PACK_SPECIFIER) return true;
    if (directory === state.cwd) break;
    directory = posix.dirname(directory);
  }
  return false;
}

/** Whether the specifier is the Gateforge package's runner module. */
function isPackSpecifier(state: ScanState, file: string, specifier: string): boolean {
  const suffix = '/fixture';
  const packageName = specifier.endsWith(suffix) ? specifier.slice(0, -suffix.length) : specifier;
  if (packageName === GATEFORGE_PACK_SPECIFIER) return true;
  return isGateforgePackageAlias(state, file, packageName);
}

/** Chain segments that modify a test/describe call without changing identity. */
const SUPPRESSION_SEGMENTS = new Set(['skip', 'only', 'fixme']);

/** Chain segments never part of a test call (hooks, fixtures, config). */
const NON_TEST_SEGMENTS = new Set([
  'beforeEach',
  'afterEach',
  'beforeAll',
  'afterAll',
  'use',
  'extend',
  'setTimeout',
  'expect',
  'annotate',
  'tag',
  // Event-listener / interception shapes (`cy.on('tap', fn)`,
  // `page.route('**/x', fn)`, `el.addEventListener('click', fn)`): a
  // string first argument + callback is their ordinary shape, not a test
  // declaration — no runner registers tests through these. Treating them
  // as unprovable wrappers flooded the catalog with phantom unresolved
  // rows when product code was scanned (consumer migration, E22).
  'on',
  'once',
  'addEventListener',
  'route',
  // Sanitizer hook registration (`DOMPurify.addHook('afterSanitizeAttributes',
  // fn)`) — same string+callback shape as the interception calls above; a
  // product-code call, never a test declaration (consumer migration).
  'addHook',
  // Sub-step registration (`test.step('title', fn)`): a step is scoped to
  // its parent test and the native runner never enumerates it as an
  // instance — treating it as an entry produced phantom static-only rows
  // that blocked inventory completeness (consumer migration, E22).
  'step',
  // Module-mocking shapes (`vi.mock('mod', factory)`,
  // `jest.mock('mod', factory)`): the vitest/jest module registry, never
  // a test-case registration. The mock itself is already recorded as a
  // file-level mock signal (findModuleMock); emitting an unresolved row
  // per mocked module flooded setup files (consumer migration, E22).
  'mock',
  // slowness modifier (`test.slow(...)`): suite/runner control like
  // `use`/`setTimeout`, never a test declaration.
  'slow',
]);

function languageKindFor(file: string): ts.ScriptKind {
  if (file.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (file.endsWith('.jsx')) return ts.ScriptKind.JSX;
  if (file.endsWith('.mjs') || file.endsWith('.cjs')) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function locationOf(file: string, source: ts.SourceFile, node: ts.Node): Location {
  const { line, character } = source.getLineAndCharacterOfPosition(node.getStart(source));
  return { file, line: line + 1, col: character };
}

/**
 * Tests whether a syntax node is nested inside another node's subtree.
 *
 * Args:
 *   container: candidate ancestor node.
 *   target: node whose ancestry is checked.
 *
 * Returns:
 *   boolean: true when target is inside container.
 */
function isWithinNode(container: ts.Node, target: ts.Node): boolean {
  let current: ts.Node | undefined = target;
  while (current !== undefined && current !== container) current = current.parent;
  return current === container;
}

/**
 * Finds Gateforge environment reads in conditional ancestors of a test
 * registration so environment-dependent registrations can be reviewed.
 *
 * Args:
 *   file: repo-relative file containing the registration.
 *   source: parsed TypeScript source file.
 *   node: registration call node.
 *   titlePath: static title path for the registration.
 *
 * Returns:
 *   StaticRegistrationWarning[]: one warning per relevant environment variable.
 */
function registrationWarningsForCall(
  file: string,
  source: ts.SourceFile,
  node: ts.Node,
  titlePath: string[],
): StaticRegistrationWarning[] {
  const guards: ts.Expression[] = [];
  for (let parent = node.parent; parent !== undefined; parent = parent.parent) {
    if (
      ts.isIfStatement(parent) &&
      (isWithinNode(parent.thenStatement, node) ||
        (parent.elseStatement !== undefined && isWithinNode(parent.elseStatement, node)))
    ) {
      guards.push(parent.expression);
    } else if (
      ts.isConditionalExpression(parent) &&
      (isWithinNode(parent.whenTrue, node) || isWithinNode(parent.whenFalse, node))
    ) {
      guards.push(parent.condition);
    } else if (
      ts.isBinaryExpression(parent) &&
      isWithinNode(parent.right, node) &&
      (parent.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
        parent.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
        parent.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)
    ) {
      guards.push(parent.left);
    }
  }
  if (guards.length === 0) return [];
  const variables = new Map<string, Location>();
  /**
   * Recognizes property or literal-index access to process.env.
   *
   * Args:
   *   expression: expression to inspect.
   *
   * Returns:
   *   boolean: true when expression is process.env.
   */
  const isProcessEnv = (expression: ts.Expression): boolean =>
    (ts.isPropertyAccessExpression(expression) &&
      ts.isIdentifier(expression.expression) &&
      expression.expression.text === 'process' &&
      expression.name.text === 'env') ||
    (ts.isElementAccessExpression(expression) &&
      ts.isIdentifier(expression.expression) &&
      expression.expression.text === 'process' &&
      expression.argumentExpression !== undefined &&
      ts.isStringLiteral(expression.argumentExpression) &&
      expression.argumentExpression.text === 'env');
  /**
   * Records Gateforge environment reads from one registration guard.
   *
   * Args:
   *   guard: conditional expression to scan.
   *
   * Returns:
   *   void.
   */
  const visitGuard = (guard: ts.Node): void => {
    if (ts.isPropertyAccessExpression(guard) && isProcessEnv(guard.expression)) {
      const name = guard.name.text;
      if (name.startsWith('GATEFORGE_') && !variables.has(name)) {
        variables.set(name, locationOf(file, source, guard));
      }
    } else if (
      ts.isElementAccessExpression(guard) &&
      isProcessEnv(guard.expression) &&
      guard.argumentExpression !== undefined &&
      ts.isStringLiteral(guard.argumentExpression)
    ) {
      const name = guard.argumentExpression.text;
      if (name.startsWith('GATEFORGE_') && !variables.has(name)) {
        variables.set(name, locationOf(file, source, guard));
      }
    }
    ts.forEachChild(guard, visitGuard);
  };
  for (const guard of guards) visitGuard(guard);
  return [...variables.entries()].map(([environmentVariable, location]) => ({
    file,
    titlePath: [...titlePath],
    environmentVariable,
    location,
  }));
}

/**
 * Walks the repo (pruning VCS/deps/build dirs) and returns the sorted
 * repo-relative posix files matching the include globs, no exclude glob,
 * and no git ignore rule. Pure filesystem listing — no content is read
 * here.
 *
 * A path the repository ignores (e.g. the built, git-ignored bundle a
 * frontend build writes into the tree) can never be enumerated by the
 * runner, so a row from it would be a permanent `unenumeratedReason`
 * gap. Where git cannot answer — outside a work tree, or git
 * unavailable — every candidate is kept exactly as before
 * (see {@link gitIgnoredPaths}).
 */
function collectCandidateFiles(
  cwd: string,
  include: readonly string[],
  exclude: readonly string[],
  excludeFile?: RepoRelativeFileFilter,
): string[] {
  const found: string[] = [];
  const walk = (dir: string, rel: string): void => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return; // unreadable dir: invisible, never a scan failure of other files
    }
    for (const name of names.sort()) {
      if (PRUNED_DIRS.has(name)) continue;
      const abs = join(dir, name);
      const relPath = rel === '' ? name : `${rel}/${name}`;
      let stats;
      try {
        stats = statSync(abs);
      } catch {
        continue;
      }
      if (stats.isDirectory()) {
        walk(abs, relPath);
      } else if (
        PARSEABLE_EXTENSIONS.some((ext) => name.endsWith(ext)) &&
        pathInScope(relPath, include) &&
        !pathInScope(relPath, exclude) &&
        excludeFile?.(relPath) !== true
      ) {
        found.push(relPath);
      }
    }
  };
  walk(cwd, '');
  const ignored = gitIgnoredPaths(cwd, found);
  if (ignored === null) return found.sort();
  return found.filter((file) => !ignored.has(file)).sort();
}

/** The callee shape `{base, names}` of `a.b.c(...)`, else null. */
function calleeChain(expression: ts.Expression): { base: string; names: string[] } | null {
  if (ts.isIdentifier(expression)) return { base: expression.text, names: [] };
  if (ts.isPropertyAccessExpression(expression)) {
    const inner = calleeChain(expression.expression);
    if (inner === null) return null;
    return { base: inner.base, names: [...inner.names, expression.name.text] };
  }
  return null;
}

/** How a local name binds to a (possibly imported) test function. */
interface Binding {
  kind: 'test' | 'alias' | 'import' | 'unresolvable' | 'plain' | 'testmodule' | 'import-broken' | 'external';
  /** alias: target local name; import: resolved target file. */
  target?: string;
  /** import: the imported name at the target. */
  importedName?: string;
}

/** Per-file model: bindings, imports, and exports (module scope only). */
interface FileModel {
  file: string;
  source: ts.SourceFile;
  bindings: Map<string, Binding>;
  /**
   * exportedName → what it maps to (local name, re-export, or the pack's
   * own test binding for bare `export { test } from
   * '@gate-forge/pack-playwright'` re-export modules).
   */
  exports: Map<string, { local: string } | { targetFile: string; importedName: string } | { packTest: true }>;
}

/** Outcome of resolving one name to a test function (or not). */
type AliasResolution = 'test' | 'wrapper-unresolvable' | 'unknown' | 'budget' | 'not-a-test' | 'testmodule';

/**
 * Whether a function body references test-structure names — a wrapper
 * or factory mentioning `test`/`it`/`describe` can register cases and
 * must stay visible as unresolvable; a body free of them is an ordinary
 * helper (seed/step/UI callback) whose calls are never test rows.
 * Conservative by construction: shadowing, parameters, and property
 * names also block the plain classification (fail-visible, never
 * fail-silent).
 *
 * Args:
 *   body: the function body (or whole arrow/function expression) to scan.
 *
 * Returns:
 *   True when any `test`/`it`/`describe` identifier occurs in the subtree.
 */
function bodyReferencesTest(body: ts.Node): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isIdentifier(node) && TEST_STRUCTURE_NAMES.has(node.text)) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(body);
  return found;
}

interface ScanState {
  cwd: string;
  result: StaticScanResult;
  models: Map<string, FileModel>;
  seeded: Set<string>;
  traversed: Set<string>;
  resolving: Set<string>;
  maxTraversedFiles: number;
  maxImportDepth: number;
  /** Whether the file's runner provides test globals (see StaticScanOptions). */
  testGlobals: (file: string) => boolean;
  /** Parsed package manifests and installed package identities, keyed by path. */
  packageMetadata: Map<string, Record<string, unknown> | null>;
  /** Memoized tamper-reach verdicts per exported or module-local name (`file::name`). */
  routeReachByExport: Map<string, TamperReach>;
  /** Memoized first import-time (top-level) tamper per file, or null. */
  routeTopLevelByFile: Map<string, Location | null>;
}

/**
 * Reads a file's text; unreadable content is a parse error row. A path
 * that is not a regular file (a directory that reached the read through
 * a seeded or traversed row) is skipped silently — a directory is not
 * a parse failure of the consumer's source, and reporting one used to
 * flip `inventoryComplete` on a repo that parses fine.
 */
function readText(state: ScanState, file: string): string | null {
  const absolute = join(state.cwd, file);
  if (!isFile(absolute)) return null;
  try {
    return readFileSync(absolute, 'utf8');
  } catch (error) {
    state.result.parseErrors.push({
      file,
      message: `cannot read file: ${(error as Error).message.split('\n')[0] ?? 'read error'}`,
      location: { file, line: 1, col: 0 },
    });
    return null;
  }
}

/**
 * Models one file's module-scope bindings. Files are modeled on demand:
 * seeded candidates first, import targets pulled from disk under the
 * traversal budget.
 */
function modelOf(state: ScanState, cwd: string, file: string, pulled: boolean): FileModel | null {
  const cached = state.models.get(file);
  if (cached !== undefined) return cached;
  if (pulled) {
    if (state.traversed.has(file)) return null;
    if (state.traversed.size >= state.maxTraversedFiles) {
      state.result.budgetExceeded = true;
      return null;
    }
    state.traversed.add(file);
    if (!existsSync(join(cwd, file))) return null;
  }
  const text = readText(state, file);
  if (text === null) return null;
  if (!state.result.scannedFiles.includes(file)) state.result.scannedFiles.push(file);
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, languageKindFor(file));
  const parseDiagnostics = (source as ts.SourceFile & { parseDiagnostics?: readonly ts.DiagnosticWithLocation[] })
    .parseDiagnostics;
  for (const diagnostic of parseDiagnostics ?? []) {
    const { line, character } = source.getLineAndCharacterOfPosition(diagnostic.start);
    state.result.parseErrors.push({
      file,
      message: String(diagnostic.messageText).split('\n')[0] ?? 'parse error',
      location: { file, line: line + 1, col: character },
    });
  }
  const model: FileModel = { file, source, bindings: new Map(), exports: new Map() };
  state.models.set(file, model);
  modelModuleScope(state, cwd, model, source);
  return model;
}

/** Collects module-scope imports, `test.extend` aliases, and exports. */
function modelModuleScope(state: ScanState, cwd: string, model: FileModel, source: ts.SourceFile): void {
  const isModuleScope = (node: ts.Node): boolean => {
    let current: ts.Node | undefined = node.parent;
    while (current !== undefined) {
      if (
        ts.isFunctionDeclaration(current) ||
        ts.isFunctionExpression(current) ||
        ts.isArrowFunction(current) ||
        ts.isMethodDeclaration(current) ||
        ts.isBlock(current)
      ) {
        return false;
      }
      current = current.parent;
    }
    return true;
  };
  const visit = (node: ts.Node): void => {
    // import { test [as t] } from '@playwright/test' | './helpers'
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && isModuleScope(node)) {
      const clause = node.importClause;
      const specifier = node.moduleSpecifier.text;
      const isRelative = specifier.startsWith('./') || specifier.startsWith('../');
      const markExternal = (local: string, imported: string): void => {
        // A named import from outside the scanned set (package, builtin,
        // alias): an attempted alias, not an ordinary local — later
        // test-shaped calls through it stay visible rows. Relative
        // targets that resolve nowhere keep the same marker plus their
        // own unresolved-import row (fail-visible twice, never silent).
        if (isRelative) {
          const target = resolveSpecifier(state, cwd, model.file, specifier);
          if (target !== null) {
            model.bindings.set(local, { kind: 'import', target, importedName: imported });
            return;
          }
          model.bindings.set(local, { kind: 'import-broken', importedName: imported });
          state.result.unresolved.push({
            code: 'unresolved-import',
            detail: `import '${imported}' from '${specifier}' does not resolve inside the scanned set`,
            file: model.file,
            titlePath: [UNRESOLVED_TITLE_PLACEHOLDER],
            location: locationOf(model.file, source, node),
          });
        } else {
          model.bindings.set(local, { kind: 'external', importedName: imported });
        }
      };
      if (clause?.namedBindings !== undefined && ts.isNamedImports(clause.namedBindings)) {
        for (const element of clause.namedBindings.elements) {
          const imported = element.propertyName?.text ?? element.name.text;
          const local = element.name.text;
          if (TEST_BINDING_NAMES.has(imported) && isTestModuleSpecifier(state, model.file, specifier)) {
            model.bindings.set(local, { kind: 'test' });
          } else {
            markExternal(local, imported);
          }
        }
      }
      // import * as pw from '@playwright/test' | './helpers' — the module
      // object (test-module when the specifier is the test module).
      if (clause?.namedBindings !== undefined && ts.isNamespaceImport(clause.namedBindings)) {
        const local = clause.namedBindings.name.text;
        if (isTestModuleSpecifier(state, model.file, specifier)) {
          model.bindings.set(local, { kind: 'testmodule' });
        } else {
          markExternal(local, '*');
        }
      }
      // import foo from './helpers' — default import through the target's
      // exports (or a visible marker when it cannot resolve).
      if (clause?.name !== undefined) {
        markExternal(clause.name.text, 'default');
      }
    }
    // export { x [as y] } / export { x } from './m'
    if (ts.isExportDeclaration(node) && isModuleScope(node)) {
      const specifier = node.moduleSpecifier;
      if (specifier !== undefined && ts.isStringLiteral(specifier)) {
        if (
          node.exportClause !== undefined &&
          ts.isNamedExports(node.exportClause) &&
          isPackSpecifier(state, model.file, specifier.text)
        ) {
          // Bare re-export of the pack's own surface (the sanctioned
          // local runner-module pattern, e.g. the consumer's
          // `helpers.js`: `export { test } from '@gate-forge/pack-playwright'`).
          for (const element of node.exportClause.elements) {
            const imported = element.propertyName?.text ?? element.name.text;
            if (TEST_BINDING_NAMES.has(imported)) {
              model.exports.set(element.name.text, { packTest: true });
            }
          }
        } else {
          const target =
            specifier.text.startsWith('./') || specifier.text.startsWith('../')
              ? resolveSpecifier(state, cwd, model.file, specifier.text)
              : null;
          if (target !== null && node.exportClause !== undefined && ts.isNamedExports(node.exportClause)) {
            for (const element of node.exportClause.elements) {
              model.exports.set(element.name.text, {
                targetFile: target,
                importedName: element.propertyName?.text ?? element.name.text,
              });
            }
          }
        }
      } else if (node.exportClause !== undefined && ts.isNamedExports(node.exportClause)) {
        for (const element of node.exportClause.elements) {
          model.exports.set(element.name.text, { local: element.propertyName?.text ?? element.name.text });
        }
      }
    }
    // module-scope const aliases: `const t = test.extend({...})`, `const t = base`, wrappers
    if (ts.isVariableStatement(node) && isModuleScope(node)) {
      for (const declaration of node.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name) || declaration.initializer === undefined) continue;
        const name = declaration.name.text;
        const initializer = declaration.initializer;
        if (ts.isIdentifier(initializer)) {
          model.bindings.set(name, { kind: 'alias', target: initializer.text });
        } else if (
          ts.isCallExpression(initializer) &&
          ts.isPropertyAccessExpression(initializer.expression) &&
          initializer.expression.name.text === 'extend'
        ) {
          const extended = initializer.expression.expression;
          if (ts.isIdentifier(extended)) {
            model.bindings.set(name, { kind: 'alias', target: extended.text });
          } else if (
            ts.isPropertyAccessExpression(extended) &&
            (extended.name.text === 'test' || extended.name.text === 'it') &&
            ts.isIdentifier(extended.expression)
          ) {
            // Member-extend over a module object
            // (`const test = base.test.extend({...})` with
            // `const base = require('@playwright/test')`): the
            // consumer-local harness pattern — resolves through the
            // module binding (consumer migration, E22).
            model.bindings.set(name, { kind: 'alias', target: extended.expression.text });
          } else {
            model.bindings.set(name, { kind: 'unresolvable' });
          }
        } else if (
          ts.isCallExpression(initializer) &&
          ts.isIdentifier(initializer.expression) &&
          initializer.expression.text === 'require' &&
          initializer.arguments.length > 0 &&
          initializer.arguments[0] !== undefined &&
          ts.isStringLiteral(initializer.arguments[0]) &&
          isTestModuleSpecifier(state, model.file, (initializer.arguments[0] as ts.StringLiteral).text)
        ) {
          // `const base = require('@playwright/test')`: the module object
          // whose `.test` is the test function. Bare requires of any other
          // specifier bind nothing (ordinary library calls, not aliases).
          model.bindings.set(name, { kind: 'testmodule' });
        } else if (
          (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer)) &&
          !TEST_STRUCTURE_NAMES.has(name) &&
          !bodyReferencesTest(initializer)
        ) {
          // A locally-defined plain function with no test-structure
          // reference in its body (seed/step/UI helper): calls through it
          // are ordinary calls, never test registrations (consumer
          // migration, E22). Anything test-referencing stays unresolvable
          // (a possible factory — fail-visible).
          model.bindings.set(name, { kind: 'plain' });
        } else {
          // `const t = makeTest()` and friends: a wrapper the scanner
          // cannot prove — calls through it stay visible as unresolved.
          model.bindings.set(name, { kind: 'unresolvable' });
        }
        if ((node.modifiers ?? []).some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) {
          model.exports.set(name, { local: name });
        }
      }
    }
    // CJS destructure: `const { test } = require('@playwright/test')` or
    // `const { test } = require('./helpers')` — same bindings as ESM.
    if (
      ts.isVariableStatement(node) &&
      isModuleScope(node) &&
      !ts.isImportDeclaration(node)
    ) {
      for (const declaration of node.declarationList.declarations) {
        if (!ts.isObjectBindingPattern(declaration.name)) continue;
        const initializer = declaration.initializer;
        if (initializer === undefined || !ts.isCallExpression(initializer)) continue;
        if (!ts.isIdentifier(initializer.expression) || initializer.expression.text !== 'require') continue;
        const requireArgument = initializer.arguments[0];
        if (requireArgument === undefined || !ts.isStringLiteral(requireArgument)) continue;
        const specifier = requireArgument.text;
        for (const element of declaration.name.elements) {
          if (!ts.isBindingElement(element) || !ts.isIdentifier(element.name)) continue;
          const imported = (element.propertyName !== undefined && ts.isIdentifier(element.propertyName)
            ? element.propertyName.text
            : element.name.text);
          const local = element.name.text;
          if (TEST_BINDING_NAMES.has(imported) && isTestModuleSpecifier(state, model.file, specifier)) {
            model.bindings.set(local, { kind: 'test' });
          } else if (specifier.startsWith('./') || specifier.startsWith('../')) {
            const target = resolveSpecifier(state, cwd, model.file, specifier);
            if (target !== null) {
              model.bindings.set(local, { kind: 'import', target, importedName: imported });
            } else {
              // Same failed-binding marker as the ESM path above: the
              // name was meant as an alias, so later test-shaped calls
              // through it stay visible rows.
              model.bindings.set(local, { kind: 'import-broken', importedName: imported });
            }
          }
        }
      }
    }
    // Module-scope function declarations: a plain `function seed(...)`
    // with no test-structure reference in its body is an ordinary helper
    // (consumer migration, E22: `withStepTimeout`/`runStep` step wrappers).
    // Test-referencing bodies stay unmodeled (a possible factory), and
    // `test`/`it`/`describe`-named declarations stay unmodeled (a possible
    // global registration) — both fail-visible, never fail-silent.
    if (
      ts.isFunctionDeclaration(node) &&
      isModuleScope(node) &&
      node.name !== undefined &&
      ts.isIdentifier(node.name) &&
      node.body !== undefined
    ) {
      const name = node.name.text;
      if (!TEST_STRUCTURE_NAMES.has(name) && !bodyReferencesTest(node.body)) {
        model.bindings.set(name, { kind: 'plain' });
      }
      if ((node.modifiers ?? []).some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) {
        model.exports.set(name, { local: name });
      }
    }
    // CJS exports: property assignments on `exports`/`module.exports` and
    // object assignment via `module.exports = { test, seed: runSeed }`.
    // These map exports back to bindings so local require chains resolve.
    if (ts.isExpressionStatement(node) && isModuleScope(node)) {
      const expr = node.expression;
      if (
        ts.isBinaryExpression(expr) &&
        expr.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isPropertyAccessExpression(expr.left)
      ) {
        const owner = expr.left.expression;
        const exportName = expr.left.name.text;
        const isExportsProperty =
          (ts.isIdentifier(owner) && owner.text === 'exports') ||
          (ts.isPropertyAccessExpression(owner) &&
            owner.name.text === 'exports' &&
            ts.isIdentifier(owner.expression) &&
            owner.expression.text === 'module');
        if (isExportsProperty) {
          let target: string | null = ts.isIdentifier(expr.right) ? expr.right.text : null;
          if (
            target === null &&
            ts.isCallExpression(expr.right) &&
            ts.isPropertyAccessExpression(expr.right.expression) &&
            expr.right.expression.name.text === 'extend'
          ) {
            const extended = expr.right.expression.expression;
            if (ts.isIdentifier(extended)) {
              target = extended.text;
            } else if (
              ts.isPropertyAccessExpression(extended) &&
              (extended.name.text === 'test' || extended.name.text === 'it') &&
              ts.isIdentifier(extended.expression)
            ) {
              target = extended.expression.text;
            }
          }
          model.bindings.set(exportName, target === null ? { kind: 'unresolvable' } : { kind: 'alias', target });
          model.exports.set(exportName, { local: exportName });
        }
      }
      if (
        ts.isBinaryExpression(expr) &&
        expr.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isPropertyAccessExpression(expr.left) &&
        ts.isIdentifier(expr.left.expression) &&
        expr.left.expression.text === 'module' &&
        expr.left.name.text === 'exports' &&
        ts.isObjectLiteralExpression(expr.right)
      ) {
        for (const prop of expr.right.properties) {
          if (ts.isShorthandPropertyAssignment(prop)) {
            model.exports.set(prop.name.text, { local: prop.name.text });
          } else if (
            ts.isPropertyAssignment(prop) &&
            ts.isIdentifier(prop.name) &&
            ts.isIdentifier(prop.initializer)
          ) {
            model.exports.set(prop.name.text, { local: prop.initializer.text });
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
}

/** Whether the specifier is playwright's own test module. */
function isPlaywrightSpecifier(specifier: string): boolean {
  return specifier === '@playwright/test' || specifier === 'playwright/test' || specifier === 'playwright';
}

/**
 * Whether a named import from this specifier can bind a playwright test
 * function: playwright's own test module, or the gateforge pack (whose
 * exported `test` is a `base.extend` over playwright's — see
 * {@link GATEFORGE_PACK_SPECIFIER}).
 */
function isTestModuleSpecifier(state: ScanState, file: string, specifier: string): boolean {
  return isPlaywrightSpecifier(specifier) || isPackSpecifier(state, file, specifier);
}

/**
 * Resolves a relative specifier the way node/TS resolve it: a FILE
 * first (the bare path when it names a parseable SCRIPT file, then each
 * parseable extension), then a directory's `index.*`. A directory is
 * never a resolution result — `existsSync` is true for one, and
 * returning it made `readText` fail with EISDIR and report a false
 * parse error against the consumer's own source whenever a file and a
 * directory shared a name (install rehearsal F16).
 *
 * Args:
 *   state: the running scan (seeded/traversed files win outright).
 *   cwd: absolute repo root.
 *   fromFile: repo-relative file holding the import.
 *   specifier: the import specifier, as written.
 *
 * Returns:
 *   string | null: repo-relative FILE path, or null when nothing
 *   resolves.
 */
function resolveSpecifier(state: ScanState, cwd: string, fromFile: string, specifier: string): string | null {
  const base = posix.dirname(fromFile);
  const joined = posix.normalize(posix.join(base, specifier));
  // The bare path only when it already names a SCRIPT file. A specifier
  // like `./translations/en.json` (or any non-script asset) must never
  // resolve: the scan parses JavaScript/TypeScript only, so pulling a
  // JSON document into the parser flooded the catalog with thousands of
  // parse-error rows for one import (fresh-clone snag 5b — a frontend
  // translations file alone produced 18,658 of them). The extension and
  // index candidates below still cover extensionless script specifiers.
  const candidates = [
    ...(PARSEABLE_EXTENSIONS.some((ext) => joined.endsWith(ext)) ? [joined] : []),
    ...PARSEABLE_EXTENSIONS.map((ext) => `${joined}${ext}`),
    ...PARSEABLE_EXTENSIONS.map((ext) => `${joined}/index${ext}`),
  ];
  for (const candidate of candidates) {
    if (state.seeded.has(candidate) || state.traversed.has(candidate)) return candidate;
  }
  for (const candidate of candidates) {
    if (isFile(join(cwd, candidate))) return candidate;
  }
  return null;
}

/**
 * Whether an absolute path is an existing regular file (never a
 * directory, a socket, or a device node).
 *
 * Args:
 *   absolute: absolute filesystem path.
 *
 * Returns:
 *   boolean: true only for an existing regular file.
 */
function isFile(absolute: string): boolean {
  try {
    return statSync(absolute).isFile();
  } catch {
    return false;
  }
}

/**
 * Resolves whether `name` in `file` binds to a playwright test function,
 * through aliases and relative imports, bounded by depth + file budget.
 * Cycle-guarded via `state.resolving`.
 */
function resolveTestAlias(state: ScanState, cwd: string, file: string, name: string, depth: number): AliasResolution {
  if (depth > state.maxImportDepth) {
    state.result.budgetExceeded = true;
    return 'budget';
  }
  const key = `${file}::${name}`;
  if (state.resolving.has(key)) return 'unknown'; // alias cycle: not provable
  const model = modelOf(state, cwd, file, !state.seeded.has(file));
  if (model === null) {
    if (state.result.budgetExceeded && !state.seeded.has(file) && !state.traversed.has(file)) {
      return 'budget';
    }
    return 'unknown';
  }
  const binding = model.bindings.get(name);
  if (binding !== undefined) {
    if (binding.kind === 'test') return 'test';
    if (binding.kind === 'testmodule') return 'testmodule';
    if (binding.kind === 'plain') return 'not-a-test';
    if (binding.kind === 'import-broken') return 'unknown';
    if (binding.kind === 'external') return 'unknown';
    if (binding.kind === 'unresolvable') return 'wrapper-unresolvable';
    if (binding.kind === 'alias' && binding.target !== undefined) {
      state.resolving.add(key);
      const resolved = resolveTestAlias(state, cwd, file, binding.target, depth + 1);
      state.resolving.delete(key);
      // An alias chain rooted in the required test module object
      // (`base.test.extend(...)` over `require('@playwright/test')`) is
      // the test function itself.
      if (resolved === 'testmodule') return 'test';
      return resolved;
    }
    if (binding.kind === 'import' && binding.target !== undefined && binding.importedName !== undefined) {
      state.resolving.add(key);
      const resolved = resolveExportedName(state, cwd, binding.target, binding.importedName, depth + 1);
      state.resolving.delete(key);
      return resolved;
    }
  }
  return 'unknown';
}

/** Resolves a name through the target file's exports, then its bindings. */
function resolveExportedName(
  state: ScanState,
  cwd: string,
  file: string,
  name: string,
  depth: number,
): AliasResolution {
  if (depth > state.maxImportDepth) {
    state.result.budgetExceeded = true;
    return 'budget';
  }
  const model = modelOf(state, cwd, file, !state.seeded.has(file));
  if (model === null) {
    return state.result.budgetExceeded && !state.seeded.has(file) && !state.traversed.has(file)
      ? 'budget'
      : 'unknown';
  }
  const exported = model.exports.get(name);
  if (exported !== undefined) {
    if ('local' in exported) return resolveTestAlias(state, cwd, file, exported.local, depth + 1);
    if ('packTest' in exported) return 'test';
    state.resolving.add(`${file}::${name}`);
    const resolved = resolveExportedName(state, cwd, exported.targetFile, exported.importedName, depth + 1);
    state.resolving.delete(`${file}::${name}`);
    return resolved;
  }
  return resolveTestAlias(state, cwd, file, name, depth + 1);
}

/** Extracts the title text (with `${}` slots) or null when computed. */
function titleOf(argument: ts.Expression | undefined): { title: string; parameterized: boolean } | null {
  if (argument === undefined) return null;
  if (ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument)) {
    return { title: argument.text, parameterized: false };
  }
  if (ts.isTemplateExpression(argument)) {
    let text = argument.head.text;
    for (const span of argument.templateSpans) {
      text += '${}';
      text += span.literal.text;
    }
    return { title: text, parameterized: true };
  }
  return null;
}

/** Fixture names in the callback's first parameter (destructured or bare). */
function signatureParamsOf(callback: ts.Expression): string[] {
  if (!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback)) return [];
  const first = callback.parameters[0];
  if (first === undefined) return [];
  if (ts.isObjectBindingPattern(first.name)) {
    const names: string[] = [];
    for (const element of first.name.elements) {
      if (ts.isBindingElement(element) && ts.isIdentifier(element.name)) names.push(element.name.text);
    }
    return names;
  }
  if (ts.isIdentifier(first.name)) return [first.name.text];
  return [];
}

/**
 * Signature parameter names that prove a real browser is in play.
 * `evidence` is this pack's trusted-evidence fixture — it is built on a
 * live `page` (see `fixture/fixture.ts`), so a test declaring it runs a
 * real browser journey.
 */
export const BROWSER_FIXTURE_PARAMS = new Set(['page', 'browser', 'context', 'browserName', 'evidence']);
const HTTP_CLIENT_CALLEES = new Set(['fetch', 'axios']);

/** Whether the subtree contains `<x>.route(` — playwright interception. */
function findPageRoute(node: ts.Node, source: ts.SourceFile, file: string): Location | null {
  let found: Location | null = null;
  const visit = (current: ts.Node): void => {
    if (found !== null) return;
    if (
      ts.isCallExpression(current) &&
      ts.isPropertyAccessExpression(current.expression) &&
      current.expression.name.text === 'route' &&
      ts.isIdentifier(current.expression.expression)
    ) {
      found = locationOf(file, source, current);
      return;
    }
    ts.forEachChild(current, visit);
  };
  visit(node);
  return found;
}

/**
 * Collects literal URL patterns intercepted by `page.route` in one test.
 *
 * Args:
 *   node: the test callback subtree.
 *
 * Returns:
 *   string[]: unique, sorted static route patterns.
 */
function pageRouteTargets(node: ts.Node): string[] {
  const targets = new Set<string>();
  const visit = (current: ts.Node): void => {
    if (
      ts.isCallExpression(current) &&
      ts.isPropertyAccessExpression(current.expression) &&
      current.expression.name.text === 'route' &&
      ts.isIdentifier(current.expression.expression)
    ) {
      const target = current.arguments[0];
      if (
        target !== undefined &&
        ts.isStringLiteralLike(target) &&
        target.text.length > 0
      ) {
        targets.add(target.text);
      }
    }
    ts.forEachChild(current, visit);
  };
  visit(node);
  return [...targets].sort();
}

/** Whether the subtree calls fetch/axios (the app's HTTP boundary). */
function findHttpClientCall(node: ts.Node, source: ts.SourceFile, file: string): Location | null {
  let found: Location | null = null;
  const visit = (current: ts.Node): void => {
    if (found !== null) return;
    if (ts.isCallExpression(current)) {
      const chain = calleeChain(current.expression);
      if (chain !== null && HTTP_CLIENT_CALLEES.has(chain.base)) {
        found = locationOf(file, source, current);
        return;
      }
    }
    ts.forEachChild(current, visit);
  };
  visit(node);
  return found;
}

/** Whether the file imports the gateforge evidence pack (fixture tests). */
function findGateforgeFixtureImport(state: ScanState, source: ts.SourceFile, file: string): Location | null {
  let found: Location | null = null;
  const visit = (node: ts.Node): void => {
    if (found !== null) return;
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      isPackSpecifier(state, file, node.moduleSpecifier.text)
    ) {
      found = locationOf(file, source, node);
      return;
    }
    if (
      ts.isCallExpression(node) &&
      node.arguments.length === 1 &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'require'
    ) {
      const specifier = node.arguments[0];
      if (specifier !== undefined && ts.isStringLiteral(specifier) && isPackSpecifier(state, file, specifier.text)) {
        found = locationOf(file, source, node);
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/** Whether the file contains a `vi.mock(...)` / `jest.mock(...)` call. */
function findModuleMock(source: ts.SourceFile, file: string): Location | null {
  let found: Location | null = null;
  const visit = (node: ts.Node): void => {
    if (found !== null) return;
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      (node.expression.name.text === 'mock') &&
      ts.isIdentifier(node.expression.expression) &&
      (node.expression.expression.text === 'vi' || node.expression.expression.text === 'jest')
    ) {
      found = locationOf(file, source, node);
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/** The storage mutations a storage-only init script may make. */
const SAFE_STORAGE_METHODS: Record<string, true> = {
  clear: true,
  getItem: true,
  removeItem: true,
  setItem: true,
};

/** `localStorage`/`sessionStorage`, optionally reached through `window`. */
function storageReceiverName(node: ts.Expression): string | null {
  if (
    ts.isPropertyAccessExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === 'window'
  ) {
    return node.name.text;
  }
  return ts.isIdentifier(node) ? node.text : null;
}

/**
 * Resolves a name to a variable initializer declared in a block (or
 * module scope) enclosing `from`, walking outward — the lexical lookup
 * a closure reference performs, innermost block winning. `let`/`var`
 * count too: the grammar below admits only values that are inert data,
 * so a reassigned binding can add no capability.
 */
function resolveLocalInitializer(name: string, from: ts.Node): ts.Expression | undefined {
  let current: ts.Node | undefined = from.parent;
  while (current !== undefined) {
    if (ts.isBlock(current) || ts.isSourceFile(current)) {
      for (const statement of current.statements) {
        if (!ts.isVariableStatement(statement)) continue;
        for (const declaration of statement.declarationList.declarations) {
          if (ts.isIdentifier(declaration.name) && declaration.name.text === name) {
            return declaration.initializer;
          }
        }
      }
    }
    current = current.parent;
  }
  return undefined;
}

/**
 * Resolves a name to a function declared in a block (or module scope)
 * enclosing `from`: a function declaration, a variable whose
 * initializer is the function itself, or — one bounded hop, cycle
 * guarded — an alias to another such name. Null when the name is not a
 * locally declared function: a reference form the scan cannot prove
 * stays a tamper.
 */
function resolveLocalFunctionReference(
  name: string,
  from: ts.Node,
  depth: number,
  seen: ReadonlySet<string>,
): ts.ArrowFunction | ts.FunctionExpression | ts.FunctionDeclaration | null {
  if (depth > 4 || seen.has(name)) return null;
  let current: ts.Node | undefined = from.parent;
  while (current !== undefined) {
    if (ts.isBlock(current) || ts.isSourceFile(current)) {
      for (const statement of current.statements) {
        if (ts.isFunctionDeclaration(statement) && statement.name !== undefined && statement.name.text === name && statement.body !== undefined) {
          return statement;
        }
        if (!ts.isVariableStatement(statement)) continue;
        for (const declaration of statement.declarationList.declarations) {
          if (!ts.isIdentifier(declaration.name) || declaration.name.text !== name) continue;
          const initializer = declaration.initializer;
          if (initializer === undefined) return null;
          if (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer)) return initializer;
          if (ts.isIdentifier(initializer)) {
            const next = new Set(seen);
            next.add(name);
            return resolveLocalFunctionReference(initializer.text, declaration, depth + 1, next);
          }
          return null;
        }
      }
    }
    current = current.parent;
  }
  return null;
}

/** Whether `new` is a zero-argument `new Date()` — an inert timestamp read. */
function isNewDateConstruction(expression: ts.NewExpression): boolean {
  return (
    ts.isIdentifier(expression.expression) &&
    expression.expression.text === 'Date' &&
    (expression.arguments === undefined || expression.arguments.length === 0)
  );
}

/**
 * A value a storage-only init script may compute for a storage
 * key/value slot: literals (never template forms), the script's own
 * parameters, lexically declared constants whose initializer is such a
 * value, structured literals of them, and a whitelist of inert
 * builtins (`JSON.stringify`, `String`, `Date.now()`, `new Date()` and
 * its `toISOString()`). Every shape is data only — nothing here can
 * reach the page, the network, or any other browser API. Anything else
 * — a bare unresolved identifier, a template form, a computed member
 * read — fails closed.
 */
function isStorageOnlyValue(expression: ts.Expression, params: ReadonlySet<string>, stack: ReadonlySet<string>): boolean {
  if (
    ts.isStringLiteral(expression) ||
    ts.isNumericLiteral(expression) ||
    expression.kind === ts.SyntaxKind.TrueKeyword ||
    expression.kind === ts.SyntaxKind.FalseKeyword ||
    expression.kind === ts.SyntaxKind.NullKeyword
  ) {
    return true;
  }
  if (ts.isIdentifier(expression)) {
    if (expression.text === 'undefined') return true;
    if (params.has(expression.text)) return true;
    if (stack.has(expression.text)) return false;
    const initializer = resolveLocalInitializer(expression.text, expression);
    if (initializer === undefined) return false;
    const next = new Set(stack);
    next.add(expression.text);
    return isStorageOnlyValue(initializer, params, next);
  }
  if (ts.isPropertyAccessExpression(expression)) {
    return (
      expression.name.text === 'toISOString' &&
      ts.isNewExpression(expression.expression) &&
      isNewDateConstruction(expression.expression)
    );
  }
  if (ts.isCallExpression(expression)) {
    const callee = expression.expression;
    if (ts.isPropertyAccessExpression(callee)) {
      const owner = callee.expression;
      if (
        callee.name.text === 'now' &&
        ts.isIdentifier(owner) &&
        owner.text === 'Date' &&
        expression.arguments.length === 0
      ) {
        return true;
      }
      if (
        callee.name.text === 'stringify' &&
        ts.isIdentifier(owner) &&
        owner.text === 'JSON' &&
        expression.arguments.length === 1
      ) {
        const first = expression.arguments[0];
        return first !== undefined && isStorageOnlyValue(first, params, stack);
      }
      if (
        callee.name.text === 'toISOString' &&
        expression.arguments.length === 0 &&
        ts.isNewExpression(owner) &&
        isNewDateConstruction(owner)
      ) {
        return true;
      }
      return false;
    }
    if (ts.isIdentifier(callee) && callee.text === 'String' && expression.arguments.length === 1) {
      const first = expression.arguments[0];
      return first !== undefined && isStorageOnlyValue(first, params, stack);
    }
    return false;
  }
  if (ts.isNewExpression(expression)) return isNewDateConstruction(expression);
  if (ts.isObjectLiteralExpression(expression)) {
    return expression.properties.every((property) => {
      if (ts.isPropertyAssignment(property)) return isStorageOnlyValue(property.initializer, params, stack);
      if (ts.isShorthandPropertyAssignment(property)) return isStorageOnlyValue(property.name, params, stack);
      return false;
    });
  }
  if (ts.isArrayLiteralExpression(expression)) {
    return expression.elements.every((element) => ts.isExpression(element) && isStorageOnlyValue(element, params, stack));
  }
  return false;
}

/**
 * One `localStorage.setItem('k', 'v')`-shaped storage call, keyed and
 * valued by {@link isStorageOnlyValue} expressions.
 */
function isStorageOnlyCall(expression: ts.Expression, params: ReadonlySet<string>, stack: ReadonlySet<string>): boolean {
  if (!ts.isCallExpression(expression) || !ts.isPropertyAccessExpression(expression.expression)) return false;
  const method = expression.expression.name.text;
  if (SAFE_STORAGE_METHODS[method] !== true) return false;
  const receiver = storageReceiverName(expression.expression.expression);
  if (receiver !== 'localStorage' && receiver !== 'sessionStorage') return false;
  const first = expression.arguments[0];
  const second = expression.arguments[1];
  if (method === 'setItem') {
    return (
      first !== undefined &&
      second !== undefined &&
      isStorageOnlyValue(first, params, stack) &&
      isStorageOnlyValue(second, params, stack)
    );
  }
  if (method === 'removeItem' || method === 'getItem') {
    return expression.arguments.length === 1 && first !== undefined && isStorageOnlyValue(first, params, stack);
  }
  return expression.arguments.length === 0;
}

/** A storage read or an inert value — one operand of a guarded condition. */
function isStorageOnlyOperand(expression: ts.Expression, params: ReadonlySet<string>, stack: ReadonlySet<string>): boolean {
  return isStorageOnlyValue(expression, params, stack) || isStorageOnlyCall(expression, params, stack);
}

/**
 * The condition of a guarded storage-only statement: an equality
 * comparison (or negation) over storage reads and inert values — the
 * read-then-seed shape. Anything else fails closed.
 */
function isStorageOnlyCondition(expression: ts.Expression, params: ReadonlySet<string>, stack: ReadonlySet<string>): boolean {
  if (ts.isBinaryExpression(expression)) {
    const operator = expression.operatorToken.kind;
    const comparable =
      operator === ts.SyntaxKind.EqualsEqualsEqualsToken ||
      operator === ts.SyntaxKind.ExclamationEqualsEqualsToken ||
      operator === ts.SyntaxKind.EqualsEqualsToken ||
      operator === ts.SyntaxKind.ExclamationEqualsToken;
    return (
      comparable &&
      isStorageOnlyOperand(expression.left, params, stack) &&
      isStorageOnlyOperand(expression.right, params, stack)
    );
  }
  if (ts.isPrefixUnaryExpression(expression) && expression.operator === ts.SyntaxKind.ExclamationToken) {
    return isStorageOnlyOperand(expression.operand, params, stack);
  }
  return isStorageOnlyOperand(expression, params, stack);
}

/** One statement of a storage-only init script body. */
function isStorageOnlyStatement(node: ts.Statement, params: ReadonlySet<string>): boolean {
  if (ts.isExpressionStatement(node)) return isStorageOnlyCall(node.expression, params, new Set<string>());
  if (ts.isIfStatement(node)) {
    return (
      isStorageOnlyCondition(node.expression, params, new Set<string>()) &&
      isStorageOnlyStatement(node.thenStatement, params) &&
      (node.elseStatement === undefined || isStorageOnlyStatement(node.elseStatement, params))
    );
  }
  if (ts.isTryStatement(node)) {
    const tryClean = node.tryBlock.statements.every((statement) => isStorageOnlyStatement(statement, params));
    const catchClean =
      node.catchClause === undefined ||
      node.catchClause.block.statements.every((statement) => isStorageOnlyStatement(statement, params));
    const finallyClean =
      node.finallyBlock === undefined ||
      node.finallyBlock.statements.every((statement) => isStorageOnlyStatement(statement, params));
    return tryClean && catchClean && finallyClean;
  }
  if (ts.isBlock(node)) return node.statements.every((statement) => isStorageOnlyStatement(statement, params));
  return false;
}

/** Applies the storage-only body grammar to one resolved script function. */
function isStorageOnlyScriptFunction(
  script: ts.ArrowFunction | ts.FunctionExpression | ts.FunctionDeclaration,
  call: ts.CallExpression,
): boolean {
  // The script may take parameters ONLY when the addInitScript call
  // passes exactly one argument per parameter (0.13.10 F2); a
  // parameterless script with extra arguments stays a tamper (0.13.9).
  // Each parameter can then only ever be serialized data, so a body
  // made solely of storage calls mutates nothing but storage.
  if (call.arguments.length !== script.parameters.length + 1) return false;
  const params = new Set<string>();
  for (const parameter of script.parameters) {
    if (!ts.isIdentifier(parameter.name)) return false;
    params.add(parameter.name.text);
  }
  const body = script.body;
  if (body === undefined) return false;
  if (ts.isBlock(body)) {
    return (
      body.statements.length > 0 &&
      body.statements.every((statement) => isStorageOnlyStatement(statement, params))
    );
  }
  return isStorageOnlyCall(body, params, new Set<string>());
}

/**
 * True when one `addInitScript(...)` call is a STORAGE-ONLY init
 * script: a single script argument — an arrow/function literal or a
 * reference to a locally declared function — whose body is made solely
 * of localStorage/sessionStorage mutations (`setItem`/`getItem`/
 * `removeItem`/`clear`, optional `window.` receiver), with exactly one
 * `addInitScript` argument per declared parameter. The body grammar
 * admits storage calls keyed/valued by literals, the script's own
 * parameters, lexically declared constants and inert builtins
 * (`JSON.stringify`, `String`, `Date.now()`, `new Date()`
 * `.toISOString()`), under the control flow that guards them (`if`
 * over a storage read, `try`/`catch`). Such a script mutates nothing
 * the witness cannot verify solely from its independent observer, so
 * it is not a tamper and the scan continues past it. Every other shape
 * — an arity mismatch, a template form, an unresolved identifier in a
 * key/value slot, any other statement (network, DOM,
 * `Object.defineProperty`), a string/path script, an empty body, a
 * reference the scan cannot resolve to a local declaration — stays a
 * tamper (fail closed). The same function handed to `page.evaluate`
 * is unaffected: evaluate keeps its own rule.
 */
function isStorageOnlyInitScript(call: ts.CallExpression): boolean {
  const script = call.arguments[0];
  if (script === undefined) return false;
  if (ts.isArrowFunction(script) || ts.isFunctionExpression(script)) {
    return isStorageOnlyScriptFunction(script, call);
  }
  if (ts.isIdentifier(script)) {
    const resolved = resolveLocalFunctionReference(script.text, script, 0, new Set<string>());
    return resolved !== null && isStorageOnlyScriptFunction(resolved, call);
  }
  return false;
}

/** Page-observation tamper API calls: browser mutations the witness cannot verify solely from its independent CDP observer. */
const TAMPER_API_CALLS: Record<string, true> = {
  addInitScript: true,
  connectOverCDP: true,
  evaluate: true,
  exposeFunction: true,
  fulfill: true,
  newBrowserCDPSession: true,
  newCDPSession: true,
  route: true,
  setContent: true,
};

/**
 * The location of one page-observation tamper API call, or null. A
 * storage-only init script ({@link isStorageOnlyInitScript}) is not a
 * tamper — the scan continues past it so a real tamper later in the
 * file is still found.
 */
function tamperApiLocation(source: ts.SourceFile, file: string, node: ts.CallExpression): Location | null {
  if (!ts.isPropertyAccessExpression(node.expression)) return null;
  if (TAMPER_API_CALLS[node.expression.name.text] !== true) return null;
  if (node.expression.name.text === 'addInitScript' && isStorageOnlyInitScript(node)) return null;
  return locationOf(file, source, node);
}

/**
 * Finds one page-observation tamper API call in a parsed helper/spec.
 * Includes every browser mutation path the witness cannot verify solely
 * from its independent CDP observer — except a storage-only init script
 * ({@link isStorageOnlyInitScript}), which mutates only
 * localStorage/sessionStorage and is therefore not a tamper; the scan
 * continues past it so a real tamper later in the file is still found.
 */
function findRouteInterception(source: ts.SourceFile, file: string): Location | null {
  let found: Location | null = null;
  const visit = (node: ts.Node): void => {
    if (found !== null) return;
    if (ts.isCallExpression(node)) {
      const tamper = tamperApiLocation(source, file, node);
      if (tamper !== null) {
        found = tamper;
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/** First tamper call in a spec or any helper imported by its module graph. */
function findImportedRouteInterception(state: ScanState, cwd: string, root: string): Location | null {
  const visited = new Set<string>();
  const visit = (file: string, depth: number): Location | null => {
    if (visited.has(file) || depth > state.maxImportDepth) return null;
    visited.add(file);
    const model = state.models.get(file) ?? modelOf(state, cwd, file, true);
    if (model === null) return null;
    const local = findRouteInterception(model.source, file);
    if (local !== null) return local;
    for (const binding of model.bindings.values()) {
      if (binding.kind !== 'import' || binding.target === undefined) continue;
      const nested = visit(binding.target, depth + 1);
      if (nested !== null) return nested;
    }
    return null;
  };
  return visit(root, 0);
}

/** Whether a piece of scanned code can reach a page-observation tamper. */
type TamperReach =
  | { kind: 'clean' }
  | { kind: 'tamper'; location: Location }
  | { kind: 'unknown' };

/** Shared immutable verdicts; never mutated. */
const CLEAN_REACH: TamperReach = { kind: 'clean' };
const UNKNOWN_REACH: TamperReach = { kind: 'unknown' };

/**
 * A reference to a risky or unprovable name whose invocation cannot be
 * proven at this site: a helper CALLED directly carries its reach; a
 * helper passed around as a value reads as unknown, and the caller
 * falls back to today's file-wide flag.
 */
function referenceVerdict(reach: TamperReach, called: boolean): TamperReach {
  if (reach.kind === 'clean') return CLEAN_REACH;
  return called ? reach : UNKNOWN_REACH;
}

/** Module-scope declarations by name: variable initializers, function declarations. */
const routeDeclsByModel = new WeakMap<FileModel, Map<string, ts.Node>>();

function routeDeclsOf(model: FileModel): Map<string, ts.Node> {
  const cached = routeDeclsByModel.get(model);
  if (cached !== undefined) return cached;
  const decls = new Map<string, ts.Node>();
  for (const statement of model.source.statements) {
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && declaration.initializer !== undefined) {
          decls.set(declaration.name.text, declaration.initializer);
        }
      }
    } else if (ts.isFunctionDeclaration(statement) && statement.name !== undefined && statement.body !== undefined) {
      decls.set(statement.name.text, statement);
    }
  }
  routeDeclsByModel.set(model, decls);
  return decls;
}

/**
 * Resolves a name to a declaration readable from `from`'s lexical
 * position: a variable initializer or a function declaration in a
 * block (or the module scope) enclosing it, innermost block winning —
 * the lookup a closure reference performs. Undefined when the name
 * declares nothing lexically visible.
 */
function resolveLocalReferenceNode(name: string, from: ts.Node): ts.Node | undefined {
  let current: ts.Node | undefined = from.parent;
  while (current !== undefined) {
    if (ts.isBlock(current) || ts.isSourceFile(current)) {
      for (const statement of current.statements) {
        if (ts.isFunctionDeclaration(statement) && statement.name !== undefined && statement.name.text === name && statement.body !== undefined) {
          return statement;
        }
        if (!ts.isVariableStatement(statement)) continue;
        for (const declaration of statement.declarationList.declarations) {
          if (ts.isIdentifier(declaration.name) && declaration.name.text === name && declaration.initializer !== undefined) {
            return declaration.initializer;
          }
        }
      }
    }
    current = current.parent;
  }
  return undefined;
}

/**
 * The first tamper call OUTSIDE any function body in the file: code an
 * import executes, so every file importing this one reaches it. Memoized
 * per scan; a file that cannot be modeled adds none.
 */
function topLevelTamperOf(state: ScanState, cwd: string, file: string): Location | null {
  const cached = state.routeTopLevelByFile.get(file);
  if (cached !== undefined) return cached;
  const model = state.models.get(file) ?? modelOf(state, cwd, file, true);
  let found: Location | null = null;
  if (model !== null) {
    const runsAtImport = (node: ts.Node): boolean =>
      ts.isFunctionDeclaration(node) ||
      ts.isArrowFunction(node) ||
      ts.isFunctionExpression(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isConstructorDeclaration(node) ||
      ts.isGetAccessorDeclaration(node) ||
      ts.isSetAccessorDeclaration(node);
    const visit = (node: ts.Node): void => {
      if (found !== null) return;
      if (ts.isCallExpression(node)) {
        const tamper = tamperApiLocation(model.source, file, node);
        if (tamper !== null) {
          found = tamper;
          return;
        }
      }
      if (runsAtImport(node)) return;
      ts.forEachChild(node, visit);
    };
    visit(model.source);
  }
  state.routeTopLevelByFile.set(file, found);
  return found;
}

/** First import-time (top-level) tamper across the file's import graph, or null. */
function firstGraphTopLevelTamper(state: ScanState, cwd: string, root: string): Location | null {
  const visited = new Set<string>();
  const visit = (file: string, depth: number): Location | null => {
    if (visited.has(file) || depth > state.maxImportDepth) return null;
    visited.add(file);
    const model = state.models.get(file) ?? modelOf(state, cwd, file, true);
    if (model === null) return null;
    const topLevel = topLevelTamperOf(state, cwd, file);
    if (topLevel !== null) return topLevel;
    for (const binding of model.bindings.values()) {
      if (binding.kind !== 'import' || binding.target === undefined) continue;
      const nested = visit(binding.target, depth + 1);
      if (nested !== null) return nested;
    }
    return null;
  };
  return visit(root, 0);
}

/** The reach of one module-scope name: its declaration's subtree, or the export it points at. */
function localNameTamperReach(
  state: ScanState,
  cwd: string,
  model: FileModel,
  name: string,
  depth: number,
  active: Set<string>,
): TamperReach {
  const declaration = routeDeclsOf(model).get(name);
  if (declaration !== undefined) {
    return nodeTamperReach(state, cwd, model, declaration, depth + 1, active);
  }
  const binding = model.bindings.get(name);
  if (binding === undefined) return UNKNOWN_REACH;
  switch (binding.kind) {
    case 'import': {
      if (binding.target === undefined) return CLEAN_REACH;
      return binding.importedName === '*'
        ? namespaceModuleReach(state, cwd, binding.target, depth + 1, active)
        : exportedNameTamperReach(state, cwd, binding.target, binding.importedName ?? '', depth + 1, active);
    }
    case 'alias': {
      const aliased = binding.target === undefined ? undefined : routeDeclsOf(model).get(binding.target);
      return aliased === undefined ? CLEAN_REACH : nodeTamperReach(state, cwd, model, aliased, depth + 1, active);
    }
    case 'test':
    case 'testmodule':
    case 'external':
    case 'plain':
    case 'import-broken':
      return CLEAN_REACH;
    case 'unresolvable':
      return UNKNOWN_REACH;
  }
}

/**
 * Memoized tamper reach of one exported name, following re-exports.
 * An in-progress name reads as clean: a recursion through a cycle adds
 * no reach beyond the cycle's own direct tampers, which are found on
 * their own. Over the import budget reads as unknown (fail closed); a
 * file that cannot be modeled adds no reach — the same visibility the
 * graph traversal itself has.
 */
function exportedNameTamperReach(
  state: ScanState,
  cwd: string,
  file: string,
  name: string,
  depth: number,
  active: Set<string>,
): TamperReach {
  const key = `${file}::${name}`;
  const cached = state.routeReachByExport.get(key);
  if (cached !== undefined) return cached;
  if (depth > state.maxImportDepth) return UNKNOWN_REACH;
  if (active.has(key)) return CLEAN_REACH;
  active.add(key);
  const model = state.models.get(file) ?? modelOf(state, cwd, file, true);
  let verdict: TamperReach;
  if (model === null) {
    verdict = CLEAN_REACH;
  } else {
    const exported = model.exports.get(name);
    if (exported === undefined) {
      verdict = localNameTamperReach(state, cwd, model, name, depth, active);
    } else if ('packTest' in exported) {
      verdict = CLEAN_REACH;
    } else if ('targetFile' in exported) {
      verdict = exportedNameTamperReach(state, cwd, exported.targetFile, exported.importedName, depth + 1, active);
    } else {
      verdict = localNameTamperReach(state, cwd, model, exported.local, depth, active);
    }
  }
  active.delete(key);
  state.routeReachByExport.set(key, verdict);
  return verdict;
}

/**
 * Whether a whole module can carry a tamper at all: its import-time
 * calls, every export it declares, and everything its own imports
 * point at. This is the summary an UNPROVABLE use of a namespace
 * import is judged against — `clean` only when nothing anywhere in the
 * module's reach can tamper; anything else falls back to the file-wide
 * flag.
 */
function namespaceModuleReach(
  state: ScanState,
  cwd: string,
  file: string,
  depth: number,
  active: Set<string>,
): TamperReach {
  const key = `${file}::<namespace>`;
  const cached = state.routeReachByExport.get(key);
  if (cached !== undefined) return cached;
  if (depth > state.maxImportDepth) return UNKNOWN_REACH;
  if (active.has(key)) return CLEAN_REACH;
  active.add(key);
  const verdict = ((): TamperReach => {
    const topLevel = topLevelTamperOf(state, cwd, file);
    if (topLevel !== null) return { kind: 'tamper', location: topLevel };
    const model = state.models.get(file) ?? modelOf(state, cwd, file, true);
    if (model === null) return CLEAN_REACH;
    for (const exportedName of model.exports.keys()) {
      const reach = exportedNameTamperReach(state, cwd, file, exportedName, depth + 1, active);
      if (reach.kind !== 'clean') return reach;
    }
    for (const binding of model.bindings.values()) {
      if (binding.kind !== 'import' || binding.target === undefined) continue;
      const reach =
        binding.importedName === '*'
          ? namespaceModuleReach(state, cwd, binding.target, depth + 1, active)
          : exportedNameTamperReach(state, cwd, binding.target, binding.importedName ?? '', depth + 1, active);
      if (reach.kind !== 'clean') return reach;
    }
    return CLEAN_REACH;
  })();
  active.delete(key);
  state.routeReachByExport.set(key, verdict);
  return verdict;
}

/** Reach of one identifier reference: a local declaration, an import, or nothing. */
function identifierReach(
  state: ScanState,
  cwd: string,
  model: FileModel,
  identifier: ts.Identifier,
  depth: number,
  active: Set<string>,
  called: boolean,
): TamperReach {
  const text = identifier.text;
  const key = `${model.file}::${text}`;
  if (active.has(key)) return CLEAN_REACH;
  const local = resolveLocalReferenceNode(text, identifier);
  if (local !== undefined) {
    active.add(key);
    const reach = referenceVerdict(nodeTamperReach(state, cwd, model, local, depth + 1, active), called);
    active.delete(key);
    return reach;
  }
  const binding = model.bindings.get(text);
  if (binding === undefined) return CLEAN_REACH;
  if (binding.kind === 'import' && binding.target !== undefined) {
    const reach =
      binding.importedName === '*'
        ? namespaceModuleReach(state, cwd, binding.target, depth + 1, active)
        : exportedNameTamperReach(state, cwd, binding.target, binding.importedName ?? '', depth + 1, active);
    return referenceVerdict(reach, called);
  }
  return CLEAN_REACH;
}

/**
 * Tamper reach of one node subtree (a test body, a helper declaration):
 * the first tamper API call in the subtree, or the reach of any name it
 * references. A name referenced only as a VALUE (passed around,
 * stored) cannot be proven to run and reads as unknown; property
 * names, binding names, and parameters are never references.
 */
function nodeTamperReach(
  state: ScanState,
  cwd: string,
  model: FileModel,
  node: ts.Node,
  depth: number,
  active: Set<string>,
): TamperReach {
  if (depth > state.maxImportDepth) return UNKNOWN_REACH;
  let verdict: TamperReach = CLEAN_REACH;
  // Whether this syntactic position IS the callee of its parent call —
  // the one position where a reference is proof the referenced code runs.
  const calledHere = (reference: ts.Node): boolean =>
    ts.isCallExpression(reference.parent) && reference.parent.expression === reference;
  const visit = (current: ts.Node): void => {
    if (verdict.kind !== 'clean') return;
    if (ts.isIdentifier(current)) {
      verdict = referenceVerdict(identifierReach(state, cwd, model, current, depth, active, false), false);
      return;
    }
    if (ts.isCallExpression(current)) {
      const tamper = tamperApiLocation(model.source, model.file, current);
      if (tamper !== null) {
        verdict = { kind: 'tamper', location: tamper };
        return;
      }
      if (ts.isIdentifier(current.expression)) {
        verdict = referenceVerdict(identifierReach(state, cwd, model, current.expression, depth, active, true), true);
      } else {
        visit(current.expression);
      }
      if (verdict.kind !== 'clean') return;
      for (const argument of current.arguments) {
        visit(argument);
        if (verdict.kind !== 'clean') return;
      }
      return;
    }
    if (ts.isPropertyAccessExpression(current)) {
      const base = current.expression;
      const called = calledHere(current);
      if (ts.isIdentifier(base)) {
        const binding = model.bindings.get(base.text);
        if (binding !== undefined && binding.kind === 'import' && binding.target !== undefined && binding.importedName === '*') {
          verdict = referenceVerdict(exportedNameTamperReach(state, cwd, binding.target, current.name.text, depth + 1, active), called);
          return;
        }
        verdict = referenceVerdict(identifierReach(state, cwd, model, base, depth, active, called), called);
        return;
      }
      visit(base);
      return;
    }
    if (ts.isElementAccessExpression(current)) {
      const base = current.expression;
      const called = calledHere(current);
      if (ts.isIdentifier(base)) {
        const binding = model.bindings.get(base.text);
        if (binding !== undefined && binding.kind === 'import' && binding.target !== undefined && binding.importedName === '*') {
          if (ts.isStringLiteral(current.argumentExpression)) {
            verdict = referenceVerdict(
              exportedNameTamperReach(state, cwd, binding.target, current.argumentExpression.text, depth + 1, active),
              called,
            );
            return;
          }
          verdict = UNKNOWN_REACH; // dynamic namespace access: cannot prove which export runs
          return;
        }
        verdict = referenceVerdict(identifierReach(state, cwd, model, base, depth, active, false), false);
        if (verdict.kind !== 'clean') return;
        visit(current.argumentExpression);
        return;
      }
      visit(base);
      if (verdict.kind !== 'clean') return;
      visit(current.argumentExpression);
      return;
    }
    if (ts.isSpreadElement(current)) {
      if (ts.isIdentifier(current.expression)) {
        const binding = model.bindings.get(current.expression.text);
        if (binding !== undefined && binding.kind === 'import' && binding.importedName === '*') {
          verdict = UNKNOWN_REACH; // spreading a namespace: cannot prove what runs
          return;
        }
      }
      visit(current.expression);
      return;
    }
    if (ts.isVariableStatement(current)) {
      for (const declaration of current.declarationList.declarations) {
        if (declaration.initializer !== undefined) {
          visit(declaration.initializer);
          if (verdict.kind !== 'clean') return;
        }
      }
      return;
    }
    if (
      ts.isFunctionDeclaration(current) ||
      ts.isFunctionExpression(current) ||
      ts.isArrowFunction(current) ||
      ts.isMethodDeclaration(current)
    ) {
      for (const parameter of current.parameters) {
        if (parameter.initializer !== undefined) {
          visit(parameter.initializer);
          if (verdict.kind !== 'clean') return;
        }
      }
      if (current.body !== undefined) visit(current.body);
      return;
    }
    if (ts.isImportDeclaration(current) || ts.isExportDeclaration(current)) return;
    ts.forEachChild(current, visit);
  };
  visit(node);
  return verdict;
}

/**
 * The tamper location attributed to ONE test (0.13.10 F3): a tamper
 * written in the spec, or one that executes at import time anywhere in
 * its import graph, flags every test of the file exactly as before;
 * otherwise the test's own body — and the fixture chain its
 * registration name resolves through — is followed, flagging the test
 * at the reached helper's tamper line. When reachability cannot be
 * proven, today's file-wide graph tamper is the flag; when the scan
 * proves the test never reaches any tamper, there is none.
 */
function attributedRouteInterception(
  state: ScanState,
  cwd: string,
  model: FileModel,
  base: string,
  callback: ts.Expression | undefined,
  fileWideTamper: Location | null,
  fallback: Location | null,
): Location | null {
  if (fileWideTamper !== null) return fileWideTamper;
  const active = new Set<string>();
  const registration = localNameTamperReach(state, cwd, model, base, 0, active);
  if (registration.kind === 'tamper') return registration.location;
  if (registration.kind === 'unknown') return fallback;
  if (callback === undefined) return fallback;
  const body = nodeTamperReach(state, cwd, model, callback, 0, active);
  if (body.kind === 'tamper') return body.location;
  if (body.kind === 'unknown') return fallback;
  return null;
}

/**
 * Runs the bounded static scan over the configured globs. Every value is
 * derived from ASTs; the only I/O is reading candidate + import-target
 * files under {@link ScanBudget}.
 *
 * Args:
 *   options: cwd, include/exclude globs, and optional budgets.
 *
 * Returns:
 *   StaticScanResult: entries, unresolved rows, parse errors, registration
 *   warnings, scanned files, and the budget flag. Never throws for
 *   scanner-detectable problems — those are rows (fail closed as data, not silence).
 */
export function scanTestFiles(options: StaticScanOptions): StaticScanResult {
  const state: ScanState = {
    cwd: options.cwd,
    result: {
      entries: [],
      unresolved: [],
      parseErrors: [],
      registrationWarnings: [],
      scannedFiles: [],
      importsByFile: [],
      budgetExceeded: false,
    },
    models: new Map(),
    seeded: new Set(),
    traversed: new Set(),
    resolving: new Set(),
    maxTraversedFiles: options.budget?.maxTraversedFiles ?? DEFAULT_MAX_TRAVERSED_FILES,
    maxImportDepth: options.budget?.maxImportDepth ?? DEFAULT_MAX_IMPORT_DEPTH,
    testGlobals: options.testGlobals ?? ((): boolean => false),
    packageMetadata: new Map(),
    routeReachByExport: new Map(),
    routeTopLevelByFile: new Map(),
  };
  const seededFiles = collectCandidateFiles(options.cwd, options.include, options.exclude, options.excludeFile);
  for (const file of seededFiles) state.seeded.add(file);

  for (const file of seededFiles) {
    const model = modelOf(state, options.cwd, file, false);
    if (model === null) continue;
    const fileHttpClient = findHttpClientCall(model.source, model.source, file);
    const fileMock = findModuleMock(model.source, file);
    const fileRoute = findImportedRouteInterception(state, options.cwd, file);
    const gateforgeImport = findGateforgeFixtureImport(state, model.source, file);
    scanFileForTests(state, options.cwd, model, fileHttpClient, fileMock, fileRoute, gateforgeImport);
  }

  // The import graph of everything the scan modeled. Every module-scope
  // relative import was resolved to a repo-relative path while modeling
  // (a broken one became its own `unresolved-import` row, never a
  // dangling edge), so this is read from what the scan already proved.
  state.result.importsByFile = [...state.models.values()]
    .map((model) => ({
      file: model.file,
      imports: [
        ...new Set(
          [...model.bindings.values()]
            .filter((binding) => binding.kind === 'import' && binding.target !== undefined)
            .map((binding) => binding.target as string),
        ),
      ].sort(),
    }))
    .sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
  state.result.registrationWarnings.sort(
    (a, b) =>
      (a.file < b.file ? -1 : a.file > b.file ? 1 : 0) ||
      a.location.line - b.location.line ||
      (a.environmentVariable < b.environmentVariable ? -1 : a.environmentVariable > b.environmentVariable ? 1 : 0) ||
      (a.titlePath.join('>') < b.titlePath.join('>') ? -1 : a.titlePath.join('>') > b.titlePath.join('>') ? 1 : 0),
  );

  state.result.entries.sort((a, b) => compareEntry(a, b));
  state.result.unresolved.sort(
    (a, b) =>
      (a.file < b.file ? -1 : a.file > b.file ? 1 : 0) ||
      a.location.line - b.location.line ||
      a.location.col - b.location.col,
  );
  state.result.parseErrors.sort(
    (a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0) || a.location.line - b.location.line,
  );
  state.result.scannedFiles.sort();
  return state.result;
}

/** One named-path graph walk: the files reached, and whether it was complete. */
export interface NamedPathGraph {
  /** Repo-relative files a root names, plus their own import closure. */
  files: string[];
  /** True when the traversal budget cut the walk short. */
  budgetExceeded: boolean;
}

/**
 * The files the given roots NAME, plus their own import closure.
 *
 * A root is a runner configuration: `reporter: [['./tests/e2e/fixtures/reporter.js']]`,
 * `globalSetup`, `globalTeardown`, a project `use: { storageState }`, a
 * `require.resolve('./…')` — none of which is an import statement, so the
 * catalog's import graph never reaches it. This walk reads them the same
 * way the rest of the scanner reads code: the SAME parser, the SAME
 * `resolveSpecifier` (so `./x`, `./x.ts`, `./x/index.js` behave exactly
 * as an import does), the SAME traversal budget.
 *
 * Two edges leave a modeled file, and both are followed:
 * - every RELATIVE string literal that resolves to an existing file
 *   (the named-file edge). A literal that resolves to nothing contributes
 *   nothing — a declaration is read as a fact, never as a
 *   candidate-supplied string;
 * - the file's own resolved import edges (the transitive edge).
 *
 * ISOLATED from the test scan on purpose: this walk builds its own scan
 * state, so a runner configuration that half-parses adds no parse-error
 * row to the catalog and can never flip `inventoryComplete`.
 *
 * FAIL-OPEN like the catalog's own import graph: a walk the budget cut
 * short attributes NOTHING, because a partial graph must attribute
 * nothing rather than guess at the rest.
 *
 * Args:
 *   cwd: absolute repo root.
 *   roots: repo-relative posix files to start from (excluded from the answer).
 *   budget: traversal knobs (defaults as documented on {@link ScanBudget}).
 *
 * Returns:
 *   NamedPathGraph: the reached files, sorted, and the budget flag.
 */
export function namedPathGraph(cwd: string, roots: readonly string[], budget?: ScanBudget): NamedPathGraph {
  const state: ScanState = {
    cwd,
    result: {
      entries: [],
      unresolved: [],
      parseErrors: [],
      registrationWarnings: [],
      scannedFiles: [],
      importsByFile: [],
      budgetExceeded: false,
    },
    models: new Map(),
    seeded: new Set(),
    traversed: new Set(),
    resolving: new Set(),
    maxTraversedFiles: budget?.maxTraversedFiles ?? DEFAULT_MAX_TRAVERSED_FILES,
    maxImportDepth: budget?.maxImportDepth ?? DEFAULT_MAX_IMPORT_DEPTH,
    testGlobals: (): boolean => false,
    packageMetadata: new Map(),
    routeReachByExport: new Map(),
    routeTopLevelByFile: new Map(),
  };
  const rootFiles = new Set(roots);
  const reached = new Set<string>();
  const queue = [...roots];
  while (queue.length > 0) {
    const file = queue.pop() as string;
    const model = modelOf(state, cwd, file, true);
    if (model === null) continue;
    for (const target of relativeLiteralsIn(state, cwd, model)) {
      if (rootFiles.has(target) || reached.has(target)) continue;
      reached.add(target);
      queue.push(target);
    }
    for (const binding of model.bindings.values()) {
      if (binding.kind !== 'import' || binding.target === undefined) continue;
      const target = binding.target;
      if (rootFiles.has(target) || reached.has(target)) continue;
      reached.add(target);
      queue.push(target);
    }
  }
  if (state.result.budgetExceeded) return { files: [], budgetExceeded: true };
  return { files: [...reached].sort(), budgetExceeded: false };
}

/**
 * The repo-relative files a modeled file NAMES by a relative string
 * literal, through the scanner's own specifier resolution.
 *
 * Args:
 *   state: the walk's scan state (specifier resolution reads its sets).
 *   cwd: absolute repo root.
 *   model: the modeled file to read the literals from.
 *
 * Returns:
 *   string[]: resolved repo-relative paths, sorted, without duplicates.
 */
function relativeLiteralsIn(state: ScanState, cwd: string, model: FileModel): string[] {
  const found = new Set<string>();
  const visit = (node: ts.Node): void => {
    const text = ts.isStringLiteral(node)
      ? node.text
      : ts.isNoSubstitutionTemplateLiteral(node)
        ? node.text
        : null;
    if (text !== null && (text.startsWith('./') || text.startsWith('../'))) {
      const target = resolveSpecifier(state, cwd, model.file, text);
      if (target !== null) found.add(target);
    }
    ts.forEachChild(node, visit);
  };
  visit(model.source);
  return [...found].sort();
}

/** Deterministic entry order: file, then titlePath, then line. */
function compareEntry(a: StaticTestEntry, b: StaticTestEntry): number {
  return (
    (a.file < b.file ? -1 : a.file > b.file ? 1 : 0) ||
    (a.titlePath.join('>') < b.titlePath.join('>') ? -1 : a.titlePath.join('>') > b.titlePath.join('>') ? 1 : 0) ||
    a.location.line - b.location.line
  );
}

/** Visits one modeled file, harvesting describe stacks and test calls. */
function scanFileForTests(
  state: ScanState,
  cwd: string,
  model: FileModel,
  fileHttpClient: Location | null,
  fileMock: Location | null,
  fileRoute: Location | null,
  gateforgeImport: Location | null,
): void {
  const { file, source } = model;
  // Once per file, not once per call site: the runner-globals predicate
  // matches globs, and a file has hundreds of call expressions.
  const runnerGlobals = state.testGlobals(file);
  // 0.13.10 F3: a tamper written in this spec — or one that executes at
  // import time anywhere in its import graph — flags every test of the
  // file exactly as before. A tamper inside an imported HELPER is
  // attributed per test; when reachability cannot be proven, today's
  // file-wide graph tamper (`fileRoute`) stays the flag.
  const specDirectTamper = findRouteInterception(source, file);
  const importTimeTamper = specDirectTamper === null ? firstGraphTopLevelTamper(state, cwd, file) : null;
  const fileWideTamper: Location | null = specDirectTamper ?? importTimeTamper;
  const routeFor = (base: string, callback: ts.Expression | undefined): Location | null =>
    attributedRouteInterception(state, cwd, model, base, callback, fileWideTamper, fileRoute);

  const visit = (
    node: ts.Node,
    describeStack: Array<{ titles: string[]; signals: StaticTestEntry['signals'] }>,
    enclosing: { facts: StaticTestFacts; signals: StaticTestEntry['signals'] } | null,
  ): void => {
    if (!ts.isCallExpression(node)) {
      ts.forEachChild(node, (child) => visit(child, describeStack, enclosing));
      return;
    }
    const chain = calleeChain(node.expression);
    if (chain === null) {
      ts.forEachChild(node, (child) => visit(child, describeStack, enclosing));
      return;
    }
    const location = locationOf(file, source, node);
    const resolution = resolveTestAlias(state, cwd, file, chain.base, 0);
    const names = chain.names;
    // A runner that injects the test GLOBALS for this file (vitest
    // `globals: true`) owns a bare `describe(...)` exactly as it owns a
    // bare `it(...)`: the runner itself would execute this suite. Without
    // it, an import-less describe reads as an unresolvable alias and the
    // whole file collapses into gaps.
    const isDescribe =
      names.includes('describe') ||
      (resolution === 'unknown' && names.length === 0 && chain.base === 'describe' && runnerGlobals);
    const isExtend = names.includes('extend');
    const lifecycle = names.some((name) => NON_TEST_SEGMENTS.has(name));
    const suppression = names.filter((name) => SUPPRESSION_SEGMENTS.has(name));
    const eachCall = names.includes('each');
    const titleArgument = node.arguments[0];
    const callback = node.arguments.find((argument) => ts.isArrowFunction(argument) || ts.isFunctionExpression(argument));
    // `pw.test(...)` / `base.test(...)` where pw/base is the required or
    // namespaced test module object: the test function itself (not a
    // wrapper) — grades exactly like a direct `test(...)` registration.
    // A runner that provides GLOBALS for this file (vitest `globals: true`)
    // makes a bare `it('…')`/`test('…')` a registration the runner itself
    // owns: the runner proves those files by executing them, so the scan
    // must not file them as an unresolvable alias.
    const globalsRegistration =
      resolution === 'unknown' &&
      names.length === 0 &&
      (chain.base === 'test' || chain.base === 'it') &&
      runnerGlobals;
    const effectiveResolution = globalsRegistration
      ? 'test'
      : resolution === 'testmodule' && !isExtend && !lifecycle && !isDescribe && (names[0] === 'test' || names[0] === 'it')
        ? 'test'
        : resolution;

    // Zero-arg conditional suppression INSIDE a test body: test.skip() / test.fixme()
    if (
      effectiveResolution === 'test' &&
      suppression.length > 0 &&
      node.arguments.length === 0 &&
      enclosing !== null
    ) {
      enclosing.signals.push({ kind: suppression[0] as 'skip' | 'only' | 'fixme', detail: `${chain.base}.${suppression[0]}() call`, location });
      return;
    }
    // Conditional-skip form test.skip(condition, 'reason') inside a body.
    if (
      effectiveResolution === 'test' &&
      suppression.length > 0 &&
      node.arguments.length === 2 &&
      callback === undefined &&
      enclosing !== null
    ) {
      enclosing.signals.push({ kind: suppression[0] as 'skip' | 'only' | 'fixme', detail: `${chain.base}.${suppression[0]}(condition) call`, location });
      return;
    }

    // Suppression/control calls that declare NO case
    // (`test.skip(cond[, reason])` in a helper or hook,
    // `test.setTimeout`-adjacent modifiers without a title+callback):
    // suite/runner control, never a test declaration — a non-title
    // first argument (`true`, a timeout) or a missing callback must not
    // become a dynamic-title gap (consumer migration, E22:
    // `test.skip(true, \`...${var}...\`)` in helpers produced phantom
    // dynamic-title rows). The declaration forms `test.skip(title, fn)`
    // / `test.only(title, fn)` / `test.fixme(title, fn)` — static OR
    // parameterized title WITH a callback — fall through to entry
    // creation with their skip/only/fixme signal, so a zero-instance
    // skipped template stays a visible blocking row (fail-closed: adding
    // `.skip` must never complete the inventory by dropping the case).
    if (
      suppression.length > 0 &&
      !isExtend &&
      !lifecycle &&
      !isDescribe &&
      !eachCall
    ) {
      const controlTitle = titleArgument !== undefined ? titleOf(titleArgument) : null;
      if (controlTitle === null || callback === undefined) {
        ts.forEachChild(node, (child) => visit(child, describeStack, enclosing));
        return;
      }
    }

    // Known-non-test callee: a locally-defined plain function (no
    // test-structure reference in its body), resolved in-file or through
    // one import/export hop — an ordinary helper call (step wrappers,
    // UI callbacks factored into named functions), never a test
    // registration. No row; nested calls still walked.
    if (resolution === 'not-a-test' && !isExtend && !isDescribe) {
      ts.forEachChild(node, (child) => visit(child, describeStack, enclosing));
      return;
    }
    // Bare identifier with no module-scope evidence at all (no import,
    // no declaration — e.g. a function-scope UI callback or step-label
    // helper): not a test alias. Test-structure names (test/it/describe)
    // stay visible — an import-less global registration is still a
    // possible test. A failed relative import already carries its own
    // unresolved-import row AND an import-broken marker, so attempted
    // aliases never take this path.
    if (
      resolution === 'unknown' &&
      names.length === 0 &&
      !isExtend &&
      !isDescribe &&
      !TEST_STRUCTURE_NAMES.has(chain.base) &&
      !model.bindings.has(chain.base)
    ) {
      ts.forEachChild(node, (child) => visit(child, describeStack, enclosing));
      return;
    }

    if (isDescribe || (eachCall && names.includes('describe'))) {
      // describe(...) — push its title/signal scope over the callback body.
      const title = titleOf(titleArgument);
      const childStack = [...describeStack];
      if (title !== null) {
        childStack.push({
          titles: [title.title],
          signals: suppression.map((kind) => ({
            kind: kind as 'skip' | 'only' | 'fixme',
            detail: `test.describe.${kind} modifier`,
            location,
          })),
        });
      }
      if (callback !== undefined) {
        ts.forEachChild(callback, (child) => visit(child, childStack, enclosing));
      }
      return;
    }

    if (effectiveResolution === 'test' && !isExtend && !lifecycle && !isDescribe && titleArgument !== undefined && !eachCall) {
      const title = titleOf(titleArgument);
      if (title === null) {
        const callSite = buildEntry({
          file,
          source,
          node,
          callback,
          titlePath: [UNRESOLVED_TITLE_PLACEHOLDER],
          parameterized: false,
          inheritedSignals: describeStack.flatMap((scope) => scope.signals),
          suppression,
          location,
          fileHttpClient,
          fileMock,
          route: routeFor(chain.base, callback),
          gateforgeImport,
        });
        state.result.unresolved.push({
          code: 'dynamic-title',
          detail: 'test title is computed and cannot be resolved statically',
          file,
          titlePath: [UNRESOLVED_TITLE_PLACEHOLDER],
          location,
          facts: callSite.facts,
          signals: callSite.signals,
        });
        return;
      }
      const entry = buildEntry({
        file,
        source,
        node,
        callback,
        titlePath: [...describeStack.flatMap((scope) => scope.titles), title.title],
        parameterized: title.parameterized,
        inheritedSignals: describeStack.flatMap((scope) => scope.signals),
        suppression,
        location,
        fileHttpClient,
        fileMock,
        route: routeFor(chain.base, callback),
        gateforgeImport,
      });
      state.result.entries.push(entry);
      state.result.registrationWarnings.push(
        ...registrationWarningsForCall(file, source, node, entry.titlePath),
      );
      // Walk the body so inner zero-arg `test.skip()` / `test.fixme()`
      // calls attach to THIS entry's signals.
      if (callback !== undefined) {
        const enclosing = { facts: entry.facts, signals: entry.signals };
        ts.forEachChild(callback, (child) => visit(child, describeStack, enclosing));
      }
      return;
    }

    if (effectiveResolution === 'test' && eachCall && !isExtend && !lifecycle) {
      // test.each([...])(title, fn): the OUTER call carries the title.
      const outer = node.parent;
      if (ts.isCallExpression(outer) && outer.expression === node) {
        const title = titleOf(outer.arguments[0]);
        const outerCallback = outer.arguments.find(
          (argument) => ts.isArrowFunction(argument) || ts.isFunctionExpression(argument),
        );
        const outerLocation = locationOf(file, source, outer);
        if (title === null) {
          const callSite = buildEntry({
            file,
            source,
            node: outer,
            callback: outerCallback,
            titlePath: [UNRESOLVED_TITLE_PLACEHOLDER],
            parameterized: 'each',
            inheritedSignals: describeStack.flatMap((scope) => scope.signals),
            suppression,
            location: outerLocation,
            fileHttpClient,
            fileMock,
            route: routeFor(chain.base, outerCallback),
            gateforgeImport,
          });
          state.result.unresolved.push({
            code: 'dynamic-title',
            detail: 'parameterized test title is computed and cannot be resolved statically',
            file,
            titlePath: [UNRESOLVED_TITLE_PLACEHOLDER],
            location: outerLocation,
            facts: callSite.facts,
            signals: callSite.signals,
          });
          return;
        }
        const entry = buildEntry({
          file,
          source,
          node: outer,
          callback: outerCallback,
          titlePath: [...describeStack.flatMap((scope) => scope.titles), title.title],
          parameterized: 'each',
          inheritedSignals: describeStack.flatMap((scope) => scope.signals),
          suppression,
          location: outerLocation,
          fileHttpClient,
          fileMock,
          route: routeFor(chain.base, outerCallback),
          gateforgeImport,
        });
        state.result.entries.push(entry);
        state.result.registrationWarnings.push(
          ...registrationWarningsForCall(file, source, outer, entry.titlePath),
        );
        if (outerCallback !== undefined) {
          const enclosing = { facts: entry.facts, signals: entry.signals };
          ts.forEachChild(outerCallback, (child) => visit(child, describeStack, enclosing));
        }
        return;
      }
      return; // the inner test.each(data) call itself: handled via the outer
    }

    if (
      (resolution === 'wrapper-unresolvable' || resolution === 'unknown' || resolution === 'budget') &&
      !isExtend &&
      !lifecycle &&
      !isDescribe &&
      titleArgument !== undefined &&
      typeof titleOf(titleArgument)?.title === 'string' &&
      node.arguments.some((argument) => ts.isArrowFunction(argument) || ts.isFunctionExpression(argument))
    ) {
      // A call that LOOKS like a test (literal title + callback) through
      // a name we cannot prove: recorded, never omitted, with its call
      // location. Single-argument calls (`page.goto('/x')`) are NOT
      // test-shaped and stay unclassified.
      const code =
        resolution === 'wrapper-unresolvable'
          ? 'unresolved-wrapper'
          : resolution === 'budget'
            ? 'traversal-budget-exceeded'
            : 'unresolved-test-alias';
      const detail =
        resolution === 'wrapper-unresolvable'
          ? `call target '${chain.base}' is a declared wrapper whose test binding cannot be proven statically`
          : resolution === 'budget'
            ? `import/alias traversal budget exceeded before '${chain.base}' could be resolved`
            : `call target '${chain.base}' is not a known test binding (outside the scanned set or not statically provable)`;
      state.result.unresolved.push({
        code,
        detail,
        file,
        titlePath: [...describeStack.flatMap((scope) => scope.titles), titleOf(titleArgument)?.title ?? UNRESOLVED_TITLE_PLACEHOLDER],
        location,
      });
      return;
    }

    // Everything else: keep walking (non-test calls, bare identifiers).
    ts.forEachChild(node, (child) => visit(child, describeStack, enclosing));
  };

  visit(source, [], null);
}

type StaticJson =
  | string
  | number
  | boolean
  | null
  | StaticJson[]
  | { [key: string]: StaticJson };

type StaticJsonResult = { ok: true; value: StaticJson } | { ok: false };

/**
 * Finds one top-level local constant initializer by name.
 *
 * Args:
 *   source: parsed test source file.
 *   name: local identifier to resolve.
 *
 * Returns:
 *   ts.Expression | null: a unique const initializer, or null when it
 *   is absent, ambiguous, mutable, or destructured.
 */
function localConstantInitializer(source: ts.SourceFile, name: string): ts.Expression | null {
  const matches: ts.Expression[] = [];
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement) || (statement.declarationList.flags & ts.NodeFlags.Const) === 0) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.name.text === name && declaration.initializer !== undefined) {
        matches.push(declaration.initializer);
      }
    }
  }
  return matches.length === 1 ? (matches[0] ?? null) : null;
}

/**
 * Finds a pure local helper declared as a function or const arrow.
 *
 * Args:
 *   source: parsed test source file.
 *   name: helper identifier to resolve.
 *
 * Returns:
 *   ts.FunctionDeclaration | ts.ArrowFunction | ts.FunctionExpression | null:
 *   one unambiguous top-level function helper.
 */
function localStaticFunction(
  source: ts.SourceFile,
  name: string,
): ts.FunctionDeclaration | ts.ArrowFunction | ts.FunctionExpression | null {
  const matches: Array<ts.FunctionDeclaration | ts.ArrowFunction | ts.FunctionExpression> = [];
  for (const statement of source.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name?.text === name) {
      matches.push(statement);
      continue;
    }
    if (!ts.isVariableStatement(statement) || (statement.declarationList.flags & ts.NodeFlags.Const) === 0) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || declaration.name.text !== name || declaration.initializer === undefined) continue;
      if (ts.isArrowFunction(declaration.initializer) || ts.isFunctionExpression(declaration.initializer)) {
        matches.push(declaration.initializer);
      }
    }
  }
  return matches.length === 1 ? (matches[0] ?? null) : null;
}

/**
 * Resolves a bounded JSON-like expression without executing consumer code.
 *
 * Args:
 *   expression: source expression to resolve.
 *   source: parsed file that may contain local consts and pure helpers.
 *   bindings: literal arguments bound to a local helper's parameters.
 *   depth: recursion depth used to reject cycles.
 *
 * Returns:
 *   StaticJsonResult: a literal value when fully resolvable, else failure.
 */
function staticJsonValue(
  expression: ts.Expression,
  source: ts.SourceFile,
  bindings: ReadonlyMap<string, StaticJson> = new Map(),
  depth = 0,
): StaticJsonResult {
  if (depth > 8) return { ok: false };
  if (
    ts.isAsExpression(expression) ||
    ts.isTypeAssertionExpression(expression) ||
    ts.isSatisfiesExpression(expression) ||
    ts.isNonNullExpression(expression)
  ) {
    return staticJsonValue(expression.expression, source, bindings, depth + 1);
  }
  if (ts.isStringLiteralLike(expression)) return { ok: true, value: expression.text };
  if (ts.isNumericLiteral(expression)) {
    const value = Number(expression.text);
    return Number.isFinite(value) ? { ok: true, value } : { ok: false };
  }
  if (expression.kind === ts.SyntaxKind.TrueKeyword) return { ok: true, value: true };
  if (expression.kind === ts.SyntaxKind.FalseKeyword) return { ok: true, value: false };
  if (expression.kind === ts.SyntaxKind.NullKeyword) return { ok: true, value: null };
  if (ts.isIdentifier(expression)) {
    const bound = bindings.get(expression.text);
    if (bound !== undefined) return { ok: true, value: bound };
    const initializer = localConstantInitializer(source, expression.text);
    return initializer === null ? { ok: false } : staticJsonValue(initializer, source, bindings, depth + 1);
  }
  if (ts.isArrayLiteralExpression(expression)) {
    const values: StaticJson[] = [];
    for (const element of expression.elements) {
      if (!ts.isExpression(element)) return { ok: false };
      const resolved = staticJsonValue(element, source, bindings, depth + 1);
      if (!resolved.ok) return { ok: false };
      values.push(resolved.value);
    }
    return { ok: true, value: values };
  }
  if (ts.isObjectLiteralExpression(expression)) {
    const value: Record<string, StaticJson> = {};
    for (const property of expression.properties) {
      if (!ts.isPropertyAssignment(property)) return { ok: false };
      const key = property.name;
      if (!(ts.isIdentifier(key) || ts.isStringLiteralLike(key) || ts.isNumericLiteral(key))) return { ok: false };
      const resolved = staticJsonValue(property.initializer, source, bindings, depth + 1);
      if (!resolved.ok) return { ok: false };
      value[key.text] = resolved.value;
    }
    return { ok: true, value };
  }
  if (ts.isCallExpression(expression) && ts.isIdentifier(expression.expression)) {
    const helper = localStaticFunction(source, expression.expression.text);
    if (helper === null || helper.parameters.length !== expression.arguments.length) return { ok: false };
    const values: StaticJson[] = [];
    for (const argument of expression.arguments) {
      if (ts.isSpreadElement(argument)) return { ok: false };
      const resolved = staticJsonValue(argument, source, bindings, depth + 1);
      if (!resolved.ok) return { ok: false };
      values.push(resolved.value);
    }
    const helperBindings = new Map<string, StaticJson>();
    for (const [index, parameter] of helper.parameters.entries()) {
      if (!ts.isIdentifier(parameter.name)) return { ok: false };
      const value = values[index];
      if (value === undefined) return { ok: false };
      helperBindings.set(parameter.name.text, value);
    }
    const helperBody = helper.body;
    let returned: ts.Expression | undefined;
    if (helperBody === undefined) return { ok: false };
    if (!ts.isBlock(helperBody)) {
      returned = helperBody;
    } else {
      const statement = helperBody.statements[0];
      if (
        helperBody.statements.length === 1 &&
        statement !== undefined &&
        ts.isReturnStatement(statement) &&
        statement.expression !== undefined
      ) {
        returned = statement.expression;
      }
    }
    return returned === undefined
      ? { ok: false }
      : staticJsonValue(returned, source, helperBindings, depth + 1);
  }
  return { ok: false };
}

/**
 * Extracts Gateforge claim annotations from one test call using literals only.
 *
 * Args:
 *   node: parsed test-call node.
 *   source: parsed test source file for local const/helper resolution.
 *
 * Returns:
 *   { claims, issue }: deduplicated claim ids, or a visible reason when a
 *   possible annotation cannot be resolved statically.
 */
function gateforgeAnnotationClaims(
  node: ts.Node,
  source: ts.SourceFile,
): { claims: string[]; issue: string | null } {
  if (!ts.isCallExpression(node)) return { claims: [], issue: null };
  const options = node.arguments[1];
  if (options === undefined || ts.isArrowFunction(options) || ts.isFunctionExpression(options)) {
    return { claims: [], issue: null };
  }
  if (ts.isObjectLiteralExpression(options)) {
    const hasAnnotation = options.properties.some(
      (property) => ts.isPropertyAssignment(property) && ts.isIdentifier(property.name) && property.name.text === 'annotation',
    );
    if (!hasAnnotation) {
      return {
        claims: [],
        issue: options.properties.some(ts.isSpreadAssignment)
          ? 'test options contain a spread that may hide a Gateforge annotation'
          : null,
      };
    }
  }
  const resolved = staticJsonValue(options, source);
  if (!resolved.ok) {
    return { claims: [], issue: 'test options may contain a Gateforge annotation but are not a local literal or pure helper result' };
  }
  if (resolved.value === null || Array.isArray(resolved.value) || typeof resolved.value !== 'object') {
    return { claims: [], issue: null };
  }
  const annotation = resolved.value['annotation'];
  if (annotation === undefined) return { claims: [], issue: null };
  const items = Array.isArray(annotation) ? annotation : [annotation];
  const claims: string[] = [];
  for (const item of items) {
    if (item === null || Array.isArray(item) || typeof item !== 'object') {
      return { claims: [], issue: 'annotation value is not a statically resolved object' };
    }
    const type = item['type'];
    if (typeof type !== 'string') {
      return { claims: [], issue: 'annotation type is not a statically resolved string' };
    }
    if (type !== CLAIM_ANNOTATION_TYPE) continue;
    const description = item['description'];
    if (typeof description !== 'string' || description.length === 0) {
      return { claims: [], issue: 'Gateforge annotation description is not a non-empty static string' };
    }
    claims.push(description);
  }
  return { claims: [...new Set(claims)].sort(), issue: null };
}
/** Builds one static entry: facts from the callback body + signals. */
function buildEntry(input: {
  file: string;
  source: ts.SourceFile;
  node: ts.Node;
  callback: ts.Expression | undefined;
  titlePath: string[];
  parameterized: boolean | 'each';
  inheritedSignals: StaticTestEntry['signals'];
  suppression: string[];
  location: Location;
  fileHttpClient: Location | null;
  fileMock: Location | null;
  /** The tamper location attributed to THIS test (0.13.10 F3). */
  route: Location | null;
  gateforgeImport: Location | null;
}): StaticTestEntry {
  const { file, source, node, callback, titlePath, location } = input;
  const annotations = gateforgeAnnotationClaims(node, source);
  const params = callback === undefined ? [] : signatureParamsOf(callback);
  const signals: StaticTestEntry['signals'] = [...input.inheritedSignals];
  for (const kind of input.suppression) {
    signals.push({ kind: kind as 'skip' | 'only' | 'fixme', detail: `test.${kind} modifier`, location });
  }
  let pageRoute: Location | null = null;
  let httpClientCall: Location | null = null;
  const interceptedTargets = callback === undefined ? [] : pageRouteTargets(callback);
  if (callback !== undefined) {
    pageRoute = findPageRoute(callback, source, file);
    httpClientCall = findHttpClientCall(callback, source, file);
  }
  return {
    file,
    titlePath,
    title: titlePath[titlePath.length - 1] ?? UNRESOLVED_TITLE_PLACEHOLDER,
    location,
    parameterIdentity: input.parameterized === false ? null : input.parameterized === 'each' ? 'each' : 'template',
    signals,
    facts: {
      signatureParams: params,
      pageRoute,
      ...(interceptedTargets.length > 0 ? { pageRouteTargets: interceptedTargets } : {}),
      httpClientCall,
      fileHttpClientCall: input.fileHttpClient,
      fileMockImport: input.fileMock,
      fileRouteInterception: input.route,
      gateforgeFixtureImport: input.gateforgeImport,
    },
    ...(annotations.claims.length > 0 ? { annotationClaims: annotations.claims } : {}),
    ...(annotations.issue !== null ? { annotationIssue: annotations.issue } : {}),
  };
}
