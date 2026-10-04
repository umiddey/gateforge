/**
 * Runner file scopes: WHICH files a runner's own configuration collects.
 *
 * The static scan is seeded from Gateforge's own include globs, so it
 * can find test-shaped calls anywhere in the repository — including
 * files the configured runner would never run (a vitest suite in a
 * playwright-configured repository, a spec under a `testDir` the config
 * excludes). Cataloguing those as that runner's tests is wrong twice
 * over: the runner will not execute them, and their assertions were
 * never proved.
 *
 * This module answers the file question from DATA, never from a guess:
 * - Playwright: the enumeration's own project-graph reporter hands us
 *   the resolved per-project `testDir`/`testMatch`/`testIgnore` (see
 *   `reporter/project-graph-reporter.ts`) — the runner's own words.
 * - Vitest: a bounded, AST-only read of the repository's own
 *   `vitest.config.*`/`vite.config.*` literal `test.include` /
 *   `test.exclude` / `test.globals` values. A spread of
 *   vitest's own imported defaults (`...configDefaults.exclude`,
 *   the idiom the vitest docs recommend) reads as those
 *   defaults — but only when the name is imported from
 *   `vitest/config` or `vitest` in the same file. No consumer
 *   code runs and no expression is evaluated.
 *
 * Every scope is FAIL-OPEN: when a selection cannot be read faithfully
 * (a computed glob, a function-valued selector, a missing config), the
 * scope is not authoritative and selects every file, which is exactly
 * the pre-existing behaviour. Narrowing a catalog on a mis-read glob is
 * the one failure mode this module must never have.
 */

import { readdirSync, readFileSync, type Dirent } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';

import ts from 'typescript';

import type { ProjectTestFileScope } from '../reporter/project-graph-reporter.js';

/** One runner's own test-file selection, as data. */
export interface RunnerFileScope {
  /** Which runner this selection belongs to (`playwright`, `vitest`, …). */
  runner: string;
  /** Absolute directory the globs are relative to. */
  root: string;
  /** Globs a file must match; empty means "every file under `root`". */
  include: readonly string[];
  /** Globs that exclude a file even when an include matched. */
  exclude: readonly string[];
  /** The runner injects `test`/`it`/`describe` as globals in these files. */
  globals: boolean;
  /**
   * TRUE only when this scope came from the runner's own resolved
   * configuration. A non-authoritative scope narrows nothing.
   */
  authoritative: boolean;
  /**
   * Why this scope narrows nothing, in plain words — surfaced on the
   * runner summary so a fail-open selection says so instead of being
   * indistinguishable from a selection that collected nothing.
   */
  note?: string;
}

/**
 * What a runner's own configuration says about one file: it collects it
 * (`claimed`), it explicitly does not (`disclaimed`), or nothing declared
 * it either way (`unclaimed`).
 */
export type RunnerFileVerdict = 'claimed' | 'disclaimed' | 'unclaimed';

/** Vitest's documented default `test.include`. */
const VITEST_DEFAULT_INCLUDE: readonly string[] = ['**/*.{test,spec}.?(c|m)[jt]s?(x)'];

/** Vitest's documented default `test.exclude`. */
const VITEST_DEFAULT_EXCLUDE: readonly string[] = [
  '**/node_modules/**',
  '**/dist/**',
  '**/cypress/**',
  '**/.{idea,git,cache,output,temp}/**',
  '**/{karma,rollup,webpack,vite,vitest,jest,ava,babel,nyc,cypress,tsup,build,eslint,prettier}.config.*',
];

/** Config file names a vitest repository may declare, in resolution order. */
const VITEST_CONFIG_NAMES: readonly string[] = [
  'vitest.config.ts',
  'vitest.config.mts',
  'vitest.config.cts',
  'vitest.config.js',
  'vitest.config.mjs',
  'vitest.config.cjs',
  'vite.config.ts',
  'vite.config.mts',
  'vite.config.cts',
  'vite.config.js',
  'vite.config.mjs',
  'vite.config.cjs',
];

/** Escapes one character for use inside a regular expression. */
function escapeRegExp(character: string): string {
  return character.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Reads a parenthesized group starting at `openIndex` (which must hold
 * `(`), honouring nesting and backslash escapes.
 *
 * Args:
 *   pattern: the glob being translated.
 *   openIndex: index of the group's opening parenthesis.
 *
 * Returns:
 *   {body, end}: the group's body and the index just past its `)`; null
 *   when the group is unbalanced.
 */
function readGroup(
  pattern: string,
  openIndex: number,
): { body: string; end: number } | null {
  let depth = 0;
  for (let index = openIndex; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === '\\') {
      index += 1;
      continue;
    }
    if (character === '(') depth += 1;
    else if (character === ')') {
      depth -= 1;
      if (depth === 0) {
        return { body: pattern.slice(openIndex + 1, index), end: index + 1 };
      }
    }
  }
  return null;
}

/**
 * Finds the `}` closing the `{` at `openIndex`, honouring nesting.
 *
 * Args:
 *   pattern: the glob being translated.
 *   openIndex: index of the brace group's opening `{`.
 *
 * Returns:
 *   number: the index of the matching `}`, or -1 when unbalanced.
 */
function findClosingBrace(pattern: string, openIndex: number): number {
  let depth = 0;
  for (let index = openIndex; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === '\\') {
      index += 1;
      continue;
    }
    if (character === '{') depth += 1;
    else if (character === '}') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

/**
 * Splits a brace group body on its top-level commas.
 *
 * Args:
 *   body: the text between the braces.
 *
 * Returns:
 *   string[]: the alternatives; null when a nested group is unbalanced.
 */
function splitAlternatives(body: string): string[] | null {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (let index = 0; index < body.length; index += 1) {
    const character = body[index] ?? '';
    if (character === '\\') {
      current += character + (body[index + 1] ?? '');
      index += 1;
      continue;
    }
    if (character === '(' || character === '[') depth += 1;
    else if (character === ')' || character === ']') depth -= 1;
    else if (character === ',' && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    if (depth < 0) return null;
    current += character;
  }
  if (depth !== 0) return null;
  parts.push(current);
  return parts;
}

/**
 * Translates one glob into a regular-expression source.
 *
 * Supported: `**`, `*`, `?`, character classes, brace alternation
 * (`{a,b}`), and the extglob forms `@(a|b)`, `?(a|b)`, `+(a|b)` — which
 * together cover the runners' own documented selection globs, such as
 * playwright's default test glob (a globstar, `*.@(spec|test)` and an
 * optional `.(c|m)[jt]s?(x)` extension). Anything else (a negated
 * class or extglob, an unbalanced group) yields null, and null means
 * "this pattern cannot narrow" — never "this pattern matches
 * nothing".
 *
 * Args:
 *   pattern: the glob to translate.
 *
 * Returns:
 *   string: the regexp source, or null when it cannot be translated.
 */
function translateGlob(pattern: string): string | null {
  let source = '';
  let index = 0;
  while (index < pattern.length) {
    const character = pattern[index] ?? '';
    if (character === '\\') {
      const next = pattern[index + 1];
      if (next === undefined) return null;
      source += escapeRegExp(next);
      index += 2;
      continue;
    }
    if (character === '*') {
      let stars = 0;
      while (pattern[index] === '*') {
        stars += 1;
        index += 1;
      }
      if (stars >= 2) {
        if (pattern[index] === '/') {
          source += '(?:.*/)?';
          index += 1;
        } else {
          source += '.*';
        }
      } else {
        source += '[^/]*';
      }
      continue;
    }
    if (character === '?') {
      if (pattern[index + 1] === '(') {
        const group = readGroup(pattern, index + 1);
        if (group === null) return null;
        const inner = translateGlob(group.body);
        if (inner === null) return null;
        source += `(?:${inner})?`;
        index = group.end;
        continue;
      }
      source += '[^/]';
      index += 1;
      continue;
    }
    if ((character === '@' || character === '+') && pattern[index + 1] === '(') {
      const group = readGroup(pattern, index + 1);
      if (group === null) return null;
      const inner = translateGlob(group.body);
      if (inner === null) return null;
      source += character === '@' ? `(?:${inner})` : `(?:${inner})+`;
      index = group.end;
      continue;
    }
    if (character === '[') {
      const end = pattern.indexOf(']', index + 1);
      if (end === -1) return null;
      source += pattern.slice(index, end + 1);
      index = end + 1;
      continue;
    }
    if (character === '{') {
      const end = findClosingBrace(pattern, index);
      if (end === -1) return null;
      const alternatives = splitAlternatives(pattern.slice(index + 1, end));
      if (alternatives === null) return null;
      const parts: string[] = [];
      for (const alternative of alternatives) {
        const fragment = translateGlob(alternative);
        if (fragment === null) return null;
        parts.push(fragment);
      }
      source += `(?:${parts.join('|')})`;
      index = end + 1;
      continue;
    }
    // A `!` introduces a negated class or a `!(…)` extglob; neither has a
    // sound translation here, and a wrong one would drop real tests.
    if (character === '!') return null;
    source += escapeRegExp(character);
    index += 1;
  }
  return source;
}

/** Compiled selection globs, memoized per pattern. */
const compiledGlobs = new Map<string, RegExp | null>();

/**
 * Compiles one selection glob, memoized per pattern.
 *
 * Args:
   glob: the selection glob.
 *
 * Returns:
   RegExp | null: the compiled matcher, or null when the pattern cannot
   be translated faithfully (never "matches nothing").
 */
function compileGlobPattern(glob: string): RegExp | null {
  if (compiledGlobs.has(glob)) return compiledGlobs.get(glob) ?? null;
  const source = translateGlob(glob);
  let compiled: RegExp | null = null;
  if (source !== null) {
    try {
      compiled = new RegExp(`^${source}$`);
    } catch {
      compiled = null;
    }
  }
  compiledGlobs.set(glob, compiled);
  return compiled;
}

/**
 * Whether one glob selects a repo-relative path.
 *
 * Args:
 *   glob: the selection glob.
 *   file: repo-relative posix path, relative to the scope root.
 *
 * Returns:
 *   boolean: false only when the pattern is translatable and does NOT
 *   match. An untranslatable pattern returns true so a mis-read glob can
 *   never narrow the catalog.
 */
function globSelectsFile(glob: string, file: string): boolean {
  const compiled = compileGlobPattern(glob);
  if (compiled === null) return true;
  return compiled.test(file);
}

/**
 * Whether a runner's own configuration collects this file.
 *
 * Args:
 *   scope: the runner's selection.
 *   cwd: absolute repo root.
 *   repoRelativeFile: repo-relative posix path.
 *
 * Returns:
 *   boolean: true when the file is one of the runner's test files. A
 *   non-authoritative scope always returns true (fail open).
 */
export function scopeSelectsFile(
  scope: RunnerFileScope,
  cwd: string,
  repoRelativeFile: string,
): boolean {
  if (!scope.authoritative) return true;
  const absolute = isAbsolute(repoRelativeFile) ? repoRelativeFile : resolve(cwd, repoRelativeFile);
  const file = relative(scope.root, absolute).split('\\').join('/');
  if (file === '' || file.startsWith('../')) return false;
  if (scope.include.length > 0 && !scope.include.some((glob) => globSelectsFile(glob, file))) {
    return false;
  }
  return !scope.exclude.some((glob) => globSelectsFile(glob, file));
}

/**
 * What a runner's OWN configuration says about one file, in three
 * states instead of two.
 *
 * - `claimed`: some runner's selection collects it.
 * - `disclaimed`: no runner collects it AND the configured runner's own
 *   configuration says so — an explicit `testIgnore` match, or a path
 *   outside every authoritative project's `testDir`. The owner declared
 *   this file out of the suite, so it is not a gap in the suite's
 *   inventory.
 * - `unclaimed`: no runner collects it and nothing declared that, so it
 *   may be a misplaced test — a real gap that stays visible.
 *
 * Every scope is FAIL-OPEN as everywhere else in this module: a
 * non-authoritative scope claims every file and disclaims nothing, so a
 * selection that cannot be read faithfully never turns into silence.
 *
 * Args:
 *   configuredScopes: the CONFIGURED runner's own selection.
 *   otherScopes: every other runner's selection.
 *   cwd: absolute repo root.
 *   file: repo-relative posix path.
 *
 * Returns:
 *   RunnerFileVerdict: the three-state answer.
 */
export function runnerFileVerdict(
  configuredScopes: readonly RunnerFileScope[],
  otherScopes: readonly RunnerFileScope[],
  cwd: string,
  file: string,
): RunnerFileVerdict {
  if (anyScopeSelectsFile(configuredScopes, cwd, file)) return 'claimed';
  for (const scope of otherScopes) {
    if (!scope.authoritative) continue;
    if (scopeSelectsFile(scope, cwd, file)) return 'claimed';
  }
  const authoritative = configuredScopes.filter((scope) => scope.authoritative);
  const inside = (scope: RunnerFileScope): boolean => {
    const absolute = isAbsolute(file) ? file : resolve(cwd, file);
    const relativePath = relative(scope.root, absolute).split('\\').join('/');
    return relativePath !== '' && !relativePath.startsWith('../');
  };
  for (const scope of authoritative) {
    if (!inside(scope)) continue;
    const absolute = isAbsolute(file) ? file : resolve(cwd, file);
    const relativePath = relative(scope.root, absolute).split('\\').join('/');
    if (scope.exclude.some((glob) => globSelectsFile(glob, relativePath))) return 'disclaimed';
  }
  if (authoritative.length > 0 && !authoritative.some(inside)) return 'disclaimed';
  return 'unclaimed';
}

/**
 * Whether ANY of the runner's scopes collects the file — the union over
 * projects, which is how a runner collects a file at all.
 */
export function anyScopeSelectsFile(
  scopes: readonly RunnerFileScope[],
  cwd: string,
  repoRelativeFile: string,
): boolean {
  if (scopes.length === 0) return true;
  return scopes.some((scope) => scopeSelectsFile(scope, cwd, repoRelativeFile));
}

/**
 * The playwright scopes the enumeration's runner resolved.
 *
 * Args:
 *   projects: the per-project selection the project-graph reporter read.
 *
 * Returns:
 *   RunnerFileScope[]: one scope per project whose selection was data.
 *   Empty when the runner resolved none, which selects nothing away.
 */
export function playwrightFileScopes(
  projects: readonly ProjectTestFileScope[],
): RunnerFileScope[] {
  const scopes: RunnerFileScope[] = [];
  for (const project of projects) {
    const include = project.testMatch.map((glob) => glob.replace(/^\.\//, ''));
    const exclude = project.testIgnore.map((glob) => glob.replace(/^\.\//, ''));
    // A selection this boundary cannot read as DATA — a root that is not
    // a location, a pattern with no sound translation — makes the whole
    // scope fail open (every file) rather than narrow on a guess, and
    // says so in `note` so a wide selection is never mistaken for a
    // narrow one.
    const unreadable = [
      ...(isAbsolute(project.testDir) ? [] : [`testDir '${project.testDir}' is not an absolute path`]),
      ...[...include, ...exclude]
        .filter((glob) => compileGlobPattern(glob) === null)
        .map((glob) => `selection pattern '${glob}' is not a translatable glob`),
    ];
    scopes.push({
      runner: 'playwright',
      root: project.testDir,
      include,
      exclude,
      globals: false,
      authoritative: unreadable.length === 0,
      ...(unreadable.length > 0 ? { note: `${unreadable.join('; ')} — this project collects every file` } : {}),
    });
  }
  return scopes;
}

/** Reads a string-literal node, else undefined. */
function literalString(node: ts.Node | undefined): string | undefined {
  if (node === undefined) return undefined;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  return undefined;
}

/** Reads a boolean-literal node, else undefined. */
function literalBoolean(node: ts.Node | undefined): boolean | undefined {
  if (node === undefined) return undefined;
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
  return undefined;
}

/**
 * The vitest default selections a config file imports, keyed
 * by the LOCAL name each import binds. Only names imported
 * from `vitest/config` or `vitest` count: a same-named local
 * or another module's export must NOT read as vitest's data.
 */
interface VitestDefaultImports {
  /** Local names bound to vitest's `configDefaults` object. */
  configDefaults: Set<string>;
  /** Local names bound to vitest's default `test.include`. */
  defaultInclude: Set<string>;
  /** Local names bound to vitest's default `test.exclude`. */
  defaultExclude: Set<string>;
}

/**
 * Which vitest default selections the file imports by name,
 * read from its import declarations only.
 *
 * Args:
 *   parsed: the parsed config source file.
 *
 * Returns:
 *   VitestDefaultImports: the local names bound to vitest's
 *   own defaults; empty sets when the file imports none.
 */
function vitestDefaultImportsOf(parsed: ts.SourceFile): VitestDefaultImports {
  const imported: VitestDefaultImports = {
    configDefaults: new Set(),
    defaultInclude: new Set(),
    defaultExclude: new Set(),
  };
  for (const statement of parsed.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    const specifier = statement.moduleSpecifier;
    if (!ts.isStringLiteral(specifier)) continue;
    // Only vitest's own entry points hand out its defaults.
    if (specifier.text !== 'vitest/config' && specifier.text !== 'vitest') continue;
    const named = statement.importClause?.namedBindings;
    if (named === undefined || !ts.isNamedImports(named)) continue;
    for (const binding of named.elements) {
      const source = binding.propertyName?.text ?? binding.name.text;
      if (source === 'configDefaults') imported.configDefaults.add(binding.name.text);
      else if (source === 'defaultInclude') imported.defaultInclude.add(binding.name.text);
      else if (source === 'defaultExclude') imported.defaultExclude.add(binding.name.text);
    }
  }
  return imported;
}

/**
 * The vitest default selection one expression names: a bare
 * `configDefaults.include`, an imported `defaultExclude`, or
 * the inner expression of a spread of either. Any other
 * identifier or property is NOT data this boundary may use.
 *
 * Args:
 *   node: the expression to read.
 *   imported: the vitest defaults the file imports.
 *
 * Returns:
 *   readonly string[] | undefined: the named default
 *   selection, or undefined when the expression names none.
 */
function vitestDefaultSelection(
  node: ts.Node,
  imported: VitestDefaultImports,
): readonly string[] | undefined {
  // A default imported by its own name: `exclude: defaultExclude`.
  if (ts.isIdentifier(node)) {
    if (imported.defaultInclude.has(node.text)) return VITEST_DEFAULT_INCLUDE;
    if (imported.defaultExclude.has(node.text)) return VITEST_DEFAULT_EXCLUDE;
    return undefined;
  }
  // A member of the imported defaults object:
  // `exclude: configDefaults.exclude`.
  if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression)) {
    if (!imported.configDefaults.has(node.expression.text)) return undefined;
    if (node.name.text === 'include') return VITEST_DEFAULT_INCLUDE;
    if (node.name.text === 'exclude') return VITEST_DEFAULT_EXCLUDE;
  }
  return undefined;
}

/**
 * Reads a vitest `include`/`exclude` selection as data:
 * string literals, a spread of vitest's own defaults
 * (`[...configDefaults.exclude, …]` — the idiom the
 * vitest docs recommend), or a bare default
 * (`configDefaults.exclude`). Any other element makes the
 * selection computed, which reads as undefined (fail-open).
 *
 * Args:
 *   node: the `include`/`exclude` initializer.
 *   imported: the vitest defaults the file imports.
 *
 * Returns:
 *   readonly string[] | undefined: the literal selection, or
 *   undefined when it is computed.
 */
function selectionStrings(
  node: ts.Node | undefined,
  imported: VitestDefaultImports,
): readonly string[] | undefined {
  if (node === undefined) return undefined;
  const bare = vitestDefaultSelection(node, imported);
  if (bare !== undefined) return bare;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return [node.text];
  if (!ts.isArrayLiteralExpression(node)) return undefined;
  const values: string[] = [];
  for (const element of node.elements) {
    // `...configDefaults.exclude` widens the selection with
    // vitest's own defaults instead of replacing them.
    if (ts.isSpreadElement(element)) {
      const spread = vitestDefaultSelection(element.expression, imported);
      if (spread === undefined) return undefined;
      values.push(...spread);
      continue;
    }
    const value = literalString(element);
    if (value === undefined) return undefined;
    values.push(value);
  }
  return values;
}

/** The `test` property of an object literal, when it is one itself. */
function propertyOf(object: ts.ObjectLiteralExpression, name: string): ts.Node | undefined {
  for (const member of object.properties) {
    if (!ts.isPropertyAssignment(member)) continue;
    const key = member.name;
    const keyName = ts.isIdentifier(key) || ts.isStringLiteral(key) ? key.text : undefined;
    if (keyName === name) return member.initializer;
  }
  return undefined;
}

/** Directories never descended into when looking for runner configs. */
const CONFIG_SEARCH_PRUNED_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  'out',
  'coverage',
  'test-results',
  'playwright-report',
]);

/** How deep below the repo root a runner config is still read from. */
const MAX_CONFIG_SEARCH_DEPTH = 4;

/**
 * Every vitest configuration the repository declares, at any depth a
 * monorepo keeps one (a repo whose frontend owns `frontend/vitest.config.js`
 * selects files under `frontend/`, not under the repo root).
 *
 * Args:
 *   cwd: absolute repo root.
 *
 * Returns:
 *   string[]: absolute config paths, sorted; empty when the repository
 *   declares none (the scope is then unknown, never empty).
 */
function findVitestConfigFiles(cwd: string): string[] {
  const found: string[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > MAX_CONFIG_SEARCH_DEPTH) return;
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // unreadable dir: invisible, never a failure of other configs
    }
    for (const entry of [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      // Symlinked directories are NOT followed: a link can leave the
      // repository, and a config outside the repo root selects nothing here.
      if (entry.isDirectory()) {
        if (!CONFIG_SEARCH_PRUNED_DIRS.has(entry.name)) walk(join(dir, entry.name), depth + 1);
      } else if (entry.isFile() && VITEST_CONFIG_NAMES.includes(entry.name)) {
        found.push(join(dir, entry.name));
      }
    }
  };
  walk(cwd, 0);
  return found.sort();
}

/**
 * The config object literal of a runner config file, or null when it is
 * not one literal (`module.exports = merge(a, b)`).
 */
function configObjectOf(parsed: ts.SourceFile): ts.ObjectLiteralExpression | null {
  let config: ts.ObjectLiteralExpression | null = null;
  const visit = (node: ts.Node): void => {
    if (config !== null) return;
    // `export default { … }` — the object literal is the config itself.
    if (ts.isExportAssignment(node) && ts.isObjectLiteralExpression(node.expression)) {
      config = node.expression;
      return;
    }
    // `export default defineConfig({ … })` / `mergeConfig(a, { … })`:
    // unwrap the first object literal argument.
    if (
      ts.isExportAssignment(node) &&
      ts.isCallExpression(node.expression) &&
      node.expression.arguments[0] !== undefined &&
      ts.isObjectLiteralExpression(node.expression.arguments[0])
    ) {
      config = node.expression.arguments[0];
      return;
    }
    // The CommonJS transpiled shape: `exports.default = { … }`. `=` is the
    // only assignment operator; anything else is a comparison.
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isObjectLiteralExpression(node.right) &&
      ts.isPropertyAccessExpression(node.left) &&
      node.left.name.text === 'default'
    ) {
      config = node.right;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  return config;
}

/**
 * The vitest selection one config file declares, read with the
 * TypeScript AST only — the same bounded, non-executing read the static
 * test scan already performs on candidate source. No consumer code runs
 * and no expression is evaluated.
 *
 * A config that cannot be read as DATA (unreadable file, a computed
 * `include: buildGlobs()`, `mergeConfig(a, b)`) yields NO scope at all:
 * for a foreign runner, claiming nothing leaves the file with the
 * configured runner exactly as before, which is the fail-open answer.
 *
 * The documented defaults idiom — `exclude` set to a spread
 * of `configDefaults.exclude` beside extra string literals,
 * with `configDefaults` imported from `vitest/config` — reads
 * as vitest's own defaults widened by the literals beside it;
 * a same-named local or a foreign module's export does NOT.
 *
 * Args:
 *   absolute: absolute path of the config file.
 *
 * Returns:
 *   RunnerFileScope | null: the declared selection, or null when this
 *   file declares none that can be read (a `vite.config.*` without a
 *   `test` block is a BUILD config: it configures no test runner).
 */
function vitestScopeOf(absolute: string): RunnerFileScope | null {
  const name = basename(absolute);
  // `vitest.config.*` declares a vitest run even without a `test` block
  // (its defaults then apply); `vite.config.*` only does once it
  // configures `test`.
  const declaresVitest = name.startsWith('vitest.config.');
  let source: string;
  try {
    source = readFileSync(absolute, 'utf8');
  } catch {
    return null;
  }
  const configRoot = dirname(absolute);
  const defaultScope: RunnerFileScope = {
    runner: 'vitest',
    root: configRoot,
    include: [...VITEST_DEFAULT_INCLUDE],
    exclude: [...VITEST_DEFAULT_EXCLUDE],
    globals: false,
    authoritative: true,
  };
  const parsed = ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true);
  const config = configObjectOf(parsed);
  const testNode = config === null ? undefined : propertyOf(config, 'test');
  if (testNode === undefined || !ts.isObjectLiteralExpression(testNode)) {
    // A config with no readable `test` block still runs vitest's
    // documented defaults when the file names vitest itself; a
    // `vite.config.*` without `test` configures a bundler, not a runner.
    return declaresVitest ? defaultScope : null;
  }
  const root = literalString(config === null ? undefined : propertyOf(config, 'root'));
  const base = root === undefined ? configRoot : isAbsolute(root) ? root : resolve(configRoot, root);
  const dir = literalString(propertyOf(testNode, 'dir'));
  const scopeRoot = dir === undefined ? base : isAbsolute(dir) ? dir : resolve(base, dir);
  const includeNode = propertyOf(testNode, 'include');
  const excludeNode = propertyOf(testNode, 'exclude');
  const globalsNode = propertyOf(testNode, 'globals');
  const imported = vitestDefaultImportsOf(parsed);
  const include: readonly string[] | undefined =
    includeNode === undefined ? [...VITEST_DEFAULT_INCLUDE] : selectionStrings(includeNode, imported);
  const exclude: readonly string[] | undefined =
    excludeNode === undefined ? [...VITEST_DEFAULT_EXCLUDE] : selectionStrings(excludeNode, imported);
  const globals = globalsNode === undefined ? false : literalBoolean(globalsNode);
  // A computed selection is not data this boundary may narrow on.
  if (include === undefined || exclude === undefined || globals === undefined) return null;
  return { runner: 'vitest', root: scopeRoot, include, exclude, globals, authoritative: true };
}

/**
 * The repository's own vitest test-file selections, read from every
 * vitest config it declares (root first in resolution order, then nested
 * configs, each scoped to its own directory).
 *
 * Args:
 *   cwd: absolute repo root.
 *
 * Returns:
 *   RunnerFileScope[]: one scope per readable config; empty when the
 *   repository declares no vitest selection this boundary can read.
 */
export function vitestFileScopes(cwd: string): RunnerFileScope[] {
  const scopes: RunnerFileScope[] = [];
  for (const absolute of findVitestConfigFiles(cwd)) {
    const scope = vitestScopeOf(absolute);
    if (scope !== null) scopes.push(scope);
  }
  return scopes;
}

/**
 * Which runner owns a statically discovered file.
 *
 * A foreign scope that is not authoritative claims NOTHING: fail-open
 * for the configured runner means "keep today's behaviour", and a
 * mis-read foreign config must never steal that runner's files.
 *
 * Args:
 *   configuredRunner: the repository's configured runner.
 *   configuredScopes: that runner's own scopes (empty ⇒ unknown).
 *   otherScopes: the other runners' own scopes.
 *   cwd: absolute repo root.
 *   file: repo-relative posix path.
 *
 * Returns:
 *   string | null: the owning runner, or null when no runner's own
 *   configuration claims the file — the file is then not that runner's
 *   test, and the caller reports it instead of inventing a runner.
 */
export function runnerForFile(
  configuredRunner: string,
  configuredScopes: readonly RunnerFileScope[],
  otherScopes: readonly RunnerFileScope[],
  cwd: string,
  file: string,
): string | null {
  if (anyScopeSelectsFile(configuredScopes, cwd, file)) return configuredRunner;
  for (const scope of otherScopes) {
    if (!scope.authoritative) continue;
    if (scopeSelectsFile(scope, cwd, file)) return scope.runner;
  }
  return null;
}

