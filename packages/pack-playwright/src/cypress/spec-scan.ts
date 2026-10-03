/**
 * Static enumeration of a Cypress project's specs (plan 2026-09-25
 * phase 2, job 1).
 *
 * Cypress has no `--list-tests` mode: the only runner-native way to
 * learn the test set is to RUN the suite, which would execute the very
 * tests whose set must be fixed BEFORE the run. So the expected set is
 * read from the spec sources instead, and it is read FAIL CLOSED: a
 * spec whose suite or test titles are not static string literals cannot
 * be enumerated honestly, and the enumeration reports `unavailable`
 * rather than a partial guess — supervision then blocks the run, never
 * a green run against a half-known expected set.
 *
 * Scope: the spec files Cypress itself collects by default under a
 * `cypress/` tree — `*.cy.{js,jsx,ts,tsx}` and `*.spec.{js,jsx,ts,tsx}`
 * (support files and `node_modules` are never specs).
 */
import { readFileSync, readdirSync, type Dirent } from 'node:fs';
import { join, relative } from 'node:path';

/** One statically enumerated Cypress test. */
export interface ScannedCypressTest {
  /** Repo-relative posix spec path. */
  readonly file: string;
  /** Suite chain titles, then the leaf test title. */
  readonly titlePath: readonly string[];
}

/** The outcome of scanning one project's spec tree. */
export type SpecScanResult =
  | { readonly status: 'scanned'; readonly tests: readonly ScannedCypressTest[] }
  | { readonly status: 'unavailable'; readonly detail: string };

/** Spec file extensions Cypress collects by default. */
const SPEC_EXTENSIONS: readonly string[] = [
  '.cy.js',
  '.cy.jsx',
  '.cy.ts',
  '.cy.tsx',
  '.spec.js',
  '.spec.jsx',
  '.spec.ts',
  '.spec.tsx',
];

/** Directory names never walked while collecting specs. */
const SKIPPED_DIRECTORIES: readonly string[] = [
  'node_modules',
  'support',
  'downloads',
  'screenshots',
  'videos',
];

/** The opening token of a suite declaration (`describe`/`context`). */
const SUITE_TOKENS: readonly string[] = [
  'describe.only',
  'describe.skip',
  'context.only',
  'context.skip',
  'describe',
  'context',
];

/** A suite opening token (any `describe`/`context` modifier). */
const SUITE_TOKEN = /^(?:describe|context)(?:\.(?:only|skip))?$/;

/** A test opening token (`it`/`test`, any modifier). */
const TEST_TOKEN = /^(?:it|test)(?:\.(?:only|skip))?$/;

/** Why one spec could not be enumerated statically. */
class UnscannableSpec extends Error {}

/** One declaration the scanner classified, with its brace depth. */
interface Declaration {
  readonly kind: 'suite' | 'test';
  readonly title: string;
  /** The brace depth the declaration sits at. */
  readonly depth: number;
}

/**
 * Collects the spec files of a project (repo-relative posix paths,
 * sorted). Only the default `cypress/` spec tree is walked.
 *
 * Args:
 *   root: absolute project root.
 *
 * Returns:
 *   string[]: the spec files, sorted; [] when the project has none.
 */
export function cypressSpecFiles(root: string): string[] {
  const found: string[] = [];
  const walk = (directory: string): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRECTORIES.includes(entry.name)) walk(join(directory, entry.name));
        continue;
      }
      if (SPEC_EXTENSIONS.some((extension) => entry.name.endsWith(extension))) {
        found.push(relative(root, join(directory, entry.name)).split('\\').join('/'));
      }
    }
  };
  walk(join(root, 'cypress'));
  return found.sort();
}

/**
 * Statically enumerates every test a project's specs declare.
 *
 * Args:
 *   root: absolute project root.
 *
 * Returns:
 *   SpecScanResult: the declared tests, or `unavailable` with a single
 *   cause when a spec uses a non-literal title or declares no test
 *   (never a partial set, never a faked empty success).
 */
export function scanCypressSpecs(root: string): SpecScanResult {
  const files = cypressSpecFiles(root);
  if (files.length === 0) {
    return {
      status: 'unavailable',
      detail: `no Cypress spec file under ${join(root, 'cypress')} — a zero-test project never proves coverage`,
    };
  }
  const tests: ScannedCypressTest[] = [];
  for (const file of files) {
    let source: string;
    try {
      source = readFileSync(join(root, file), 'utf8');
    } catch (error) {
      return { status: 'unavailable', detail: `cannot read Cypress spec '${file}': ${(error as Error).message}` };
    }
    let declarations: Declaration[];
    try {
      declarations = declarationsOf(source);
    } catch (error) {
      const reason = error instanceof UnscannableSpec ? error.message : (error as Error).message;
      return {
        status: 'unavailable',
        detail:
          `Cypress spec '${file}' cannot be enumerated statically (${reason}) — ` +
          'the expected set is never guessed',
      };
    }
    tests.push(...resolveTitlePaths(declarations).map((resolved) => ({ file, titlePath: resolved })));
  }
  if (tests.length === 0) {
    return {
      status: 'unavailable',
      detail: `the ${String(files.length)} Cypress spec file(s) under ${root} declare no test`,
    };
  }
  return { status: 'scanned', tests };
}

/**
 * Scans one spec source into its suite/test declarations.
 *
 * Args:
 *   source: the spec file text.
 *
 * Returns:
 *   Declaration[]: declarations in source order.
 *
 * Throws:
 *   UnscannableSpec: when a declaration's title is not a static string
 *   literal (the expected set would be a guess).
 */
function declarationsOf(source: string): Declaration[] {
  const declarations: Declaration[] = [];
  let index = 0;
  let depth = 0;
  while (index < source.length) {
    const character = source[index] as string;
    if (character === '/' && (source[index + 1] === '/' || source[index + 1] === '*')) {
      index = skipComment(source, index);
      continue;
    }
    if (character === '"' || character === "'" || character === '`') {
      index = skipStringLiteral(source, index, character);
      continue;
    }
    if (character === '{') {
      depth += 1;
      index += 1;
      continue;
    }
    if (character === '}') {
      depth -= 1;
      index += 1;
      continue;
    }
    const declaration = declarationAt(source, index, depth);
    if (declaration !== null) {
      declarations.push(declaration.declaration);
      index = declaration.next;
      continue;
    }
    index += 1;
  }
  return declarations;
}

/** The index just past the line or block comment starting at `start`. */
function skipComment(source: string, start: number): number {
  if (source[start + 1] === '/') {
    const end = source.indexOf('\n', start);
    return end === -1 ? source.length : end;
  }
  const end = source.indexOf('*/', start + 2);
  return end === -1 ? source.length : end + 2;
}

/**
 * Skips one string literal (quotes and escapes), returning the index
 * just past its end.
 */
function skipStringLiteral(source: string, start: number, quote: string): number {
  let index = start + 1;
  while (index < source.length) {
    const character = source[index];
    if (character === '\\') {
      index += 2;
      continue;
    }
    if (character === quote) return index + 1;
    index += 1;
  }
  return source.length;
}

/**
 * Matches a suite/test declaration whose identifier starts at `index`.
 *
 * Args:
 *   source: the spec file text.
 *   index: the candidate identifier start.
 *   depth: the brace depth in effect at `index`.
 *
 * Returns:
 *   { declaration: Declaration; next: number } | null: the parsed
 *   declaration and the index just past its argument list; null when
 *   the position starts no declaration.
 *
 * Throws:
 *   UnscannableSpec: when the declaration's title is not a literal.
 */
function declarationAt(
  source: string,
  index: number,
  depth: number,
): { declaration: Declaration; next: number } | null {
  if (index > 0 && /[\w$.]/.test(source[index - 1] as string)) return null;
  const window = source.slice(index, index + 40);
  const suite = SUITE_TOKENS.find(
    (token) => window.startsWith(token) && !/[\w$]/.test(window[token.length] ?? ''),
  );
  const test = /^(?:it|test)(?:\.(?:only|skip))?(?![A-Za-z0-9_$])/.exec(window);
  const token = suite ?? test?.[0];
  if (token === undefined) return null;
  const open = source.indexOf('(', index + token.length);
  if (open === -1) throw new UnscannableSpec(`'${token}' has no argument list`);
  // Resume right after the TITLE literal, not after the whole argument
  // list: a suite's body holds the declarations nested inside it, and
  // brace-depth scoping resolves them.
  const { title, end } = readLiteralTitle(source, open + 1, token);
  return {
    declaration: { kind: TEST_TOKEN.test(token) ? 'test' : 'suite', title, depth },
    next: end,
  };
}

/**
 * Reads a declaration's static title literal.
 *
 * Args:
 *   source: the spec file text.
 *   start: the index just after the opening parenthesis.
 *   token: the declaration token (named in the failure message).
 *
 * Returns:
 *   { title: string; end: number }: the literal title and the index just
 *   past its closing quote.
 *
 * Throws:
 *   UnscannableSpec: when the first argument is not a string literal.
 */
function readLiteralTitle(
  source: string,
  start: number,
  token: string,
): { title: string; end: number } {
  let index = start;
  while (index < source.length && /\s/.test(source[index] as string)) index += 1;
  const quote = source[index];
  if (quote !== '"' && quote !== "'" && quote !== '`') {
    throw new UnscannableSpec(`'${token}' has a non-literal title`);
  }
  const end = skipStringLiteral(source, index, quote);
  return { title: source.slice(index + 1, end - 1), end };
}

/**
 * Resolves the full title path of every test declaration: a suite
 * scopes the declarations nested inside its own brace depth.
 *
 * Args:
 *   declarations: the declarations in source order, with brace depths.
 *
 * Returns:
 *   string[][]: one suite chain + leaf title per test declaration.
 */
function resolveTitlePaths(declarations: readonly Declaration[]): string[][] {
  const resolved: string[][] = [];
  const open: Array<{ title: string; depth: number }> = [];
  for (const declaration of declarations) {
    while (open.length > 0 && (open[open.length - 1] as { depth: number }).depth >= declaration.depth) {
      open.pop();
    }
    if (declaration.kind === 'suite') {
      open.push({ title: declaration.title, depth: declaration.depth });
      continue;
    }
    resolved.push([...open.map((suite) => suite.title), declaration.title]);
  }
  return resolved;
}
