/**
 * Test-only change classification (plan phases 1-2): Gateforge never
 * takes the candidate's word for what changed. It computes the change
 * set itself from the two SEALED candidate trees (the parent receipt's
 * `candidateTreeId` and the tree this run froze), classifies every
 * changed path from the runner's OWN test catalog plus the repository's
 * own import graph, and fails closed on any doubt.
 *
 * Import statements are read from each file's SYNTAX, never from its
 * text: a JS/TS blob is parsed with the TypeScript compiler API and a
 * Python blob with its comment lines and triple-quoted text removed, so
 * a sentence in a comment that happens to name an import call is prose
 * and never a computed import. Bytes the parser cannot read refuse the
 * re-seal rather than pass unexamined.
 *
 * Three classes exist, and only the first two may re-seal:
 *
 * - **test file** — a path the runner's own enumeration lists as
 *   containing tests (the catalog rows are the only definition of a
 *   test file: `playwright --list`, pytest collection, `vitest list`,
 *   Cypress spec scan — whatever the configured runner enumerated).
 * - **test helper** — a file under a runner test root whose every
 *   importer Gateforge can resolve is itself test code. Its importers
 *   re-run, transitively.
 * - **anything else** — app code, runner config, manifests/lockfiles,
 *   fixtures, generated files, docs: not eligible, full run as before.
 *
 * Uncertainty is never resolved in the candidate's favour: a dynamic or
 * unresolvable import makes a helper claim impossible to prove, and a
 * helper that cannot be proven is an ordinary non-test file.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, posix, relative, resolve } from 'node:path';
import picomatch from 'picomatch';
import ts from 'typescript';
import { sanitizedAuthorityEnv } from './candidate-tree.js';
import { UsageError } from './errors.js';

/** One changed path with its Git status letter (`A`, `M`, `D`, …). */
export interface ChangedPath {
  /** Repository-relative POSIX path. */
  path: string;
  /** Git status letter from the tree diff. */
  status: string;
}

/** The classification of one change set, with the reason when refused. */
export interface ResealChangeClassification {
  /** True when every changed path is test code or a provable test helper. */
  eligible: boolean;
  /**
   * One plain line naming the FIRST offending path and the reason, or
   * null when the change is eligible. Printed by the caller so a
   * non-eligible run says exactly why it re-runs everything.
   */
  reason: string | null;
  /** Every changed path, sorted. */
  changedPaths: string[];
  /** Changed paths the runner catalog enumerates as test files. */
  testFiles: string[];
  /** Changed paths proven to be test helpers (imported only by test code). */
  helperFiles: string[];
  /**
   * Test files whose tests must re-run: the changed test files plus
   * every transitive importer of a changed helper, sorted.
   */
  affectedTestFiles: string[];
}

/** Extensions whose import statements the graph resolves. */
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.py']);

/** Suffixes a relative specifier may carry, longest first. */
const RESOLVABLE_SUFFIXES = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.py'] as const;

/** One import statement (TS/JS static import/export/require, or Python). */
interface ImportRef {
  /** Raw specifier as written in the file. */
  specifier: string;
}

/** A tracked blob and the imports its bytes declare. */
interface TrackedFile {
  /** Repository-relative POSIX path. */
  path: string;
  /** Import specifiers, in source order. */
  imports: ImportRef[];
  /** True when the file loads a module through a computed specifier. */
  dynamic: boolean;
  /** True when the file's bytes are not a parseable script. */
  unparsable: boolean;
}

/** One `compilerOptions.paths` alias from the repository tsconfig. */
interface PathAlias {
  /** Alias prefix without the trailing wildcard. */
  prefix: string;
  /** Repository-relative directory the wildcard tail resolves against. */
  target: string;
}

/**
 * Runs one git plumbing command against the authority object store and
 * returns its raw stdout bytes. Object sizes git reports are BYTE
 * counts, so any caller that cuts output by those sizes must work on
 * these bytes, never on a decoded string.
 *
 * Args:
 *   gitDir: the absolute git dir.
 *   env: the process environment (Git redirectors are stripped).
 *   args: the git arguments.
 *   input: optional stdin text.
 *
 * Returns:
 *   Buffer | null: stdout bytes, or null when git exits non-zero.
 */
function runBytes(gitDir: string, env: NodeJS.ProcessEnv, args: readonly string[], input?: string): Buffer | null {
  const result = spawnSync('git', ['--git-dir', gitDir, '--no-replace-objects', ...args], {
    env: sanitizedAuthorityEnv(env),
    ...(input !== undefined ? { input } : {}),
    maxBuffer: 256 * 1024 * 1024,
  });
  if (result.error !== undefined) {
    throw new UsageError(`re-seal change classification: cannot run git: ${(result.error as Error).message}`);
  }
  if (result.status !== 0) return null;
  return result.stdout;
}

function run(gitDir: string, env: NodeJS.ProcessEnv, args: readonly string[], input?: string): string | null {
  return runBytes(gitDir, env, args, input)?.toString('utf8') ?? null;
}

function extname(path: string): string {
  const base = path.slice(path.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  return dot <= 0 ? '' : base.slice(dot).toLowerCase();
}

/**
 * Computes the changed path set between two sealed candidate trees in
 * one object store (`git diff-tree -r --no-renames`, so a rename reads
 * as a delete plus an add and can never smuggle content past the
 * classification).
 *
 * Args:
 *   gitDir: the absolute git dir holding both tree objects.
 *   env: the process environment (Git redirectors are stripped).
 *   parentTreeId: the parent receipt's sealed candidate tree.
 *   currentTreeId: the candidate tree this run froze.
 *
 * Returns:
 *   ChangedPath[]: every changed path with its status, sorted by path;
 *   null when the diff cannot be computed (never a guess).
 */
export function diffSealedTrees(
  gitDir: string,
  env: NodeJS.ProcessEnv,
  parentTreeId: string,
  currentTreeId: string,
): ChangedPath[] | null {
  const out = run(gitDir, env, ['diff-tree', '-r', '--no-renames', '--no-commit-id', parentTreeId, currentTreeId]);
  if (out === null) return null;
  const changed: ChangedPath[] = [];
  for (const line of out.split('\n')) {
    if (line.trim().length === 0) continue;
    // `:100644 100644 <old> <new> M\t<path>` — the path is everything
    // after the first tab and may contain spaces.
    const tab = line.indexOf('\t');
    if (tab < 0) return null;
    const meta = line.slice(0, tab).trim().split(/\s+/);
    const status = meta[meta.length - 1] ?? '';
    const path = line.slice(tab + 1);
    if (status.length === 0 || path.length === 0) return null;
    changed.push({ path, status });
  }
  changed.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  return changed;
}
/**
 * Tests whether a parent receipt's sealed tree and the tree this run
 * froze differ ONLY in paths the caller already evaluated itself.
 *
 * A sealed candidate tree carries the workspace's untracked and
 * gitignored bytes, so a verified parent proves the outcomes for ITS
 * bytes — never for whatever the workspace holds now. A path the
 * caller never evaluated (a gitignored dependency, an untracked file)
 * is therefore invisible to its decision, and reusing the parent's
 * outcomes over it would carry a proof nobody produced. The re-seal
 * path does not need this test because it classifies the whole
 * difference itself (see `classifyResealChange`).
 *
 * Args:
 *   gitDir: the absolute git dir holding both tree objects.
 *   env: the process environment (Git redirectors are stripped).
 *   parentTreeId: the parent receipt's sealed candidate tree.
 *   currentTreeId: the candidate tree this run froze.
 *   evaluatedPaths: repo-relative posix paths the caller evaluated.
 *
 * Returns:
 *   boolean: true only when the trees differ exclusively in evaluated
 *   paths; false on any unevaluated path or an undiffable pair (fail
 *   closed — the caller then runs exactly as it did before).
 */
export function carryDiffIsWithinScope(input: {
  gitDir: string;
  env: NodeJS.ProcessEnv;
  parentTreeId: string;
  currentTreeId: string;
  evaluatedPaths: readonly string[];
}): boolean {
  const changed = diffSealedTrees(input.gitDir, input.env, input.parentTreeId, input.currentTreeId);
  if (changed === null) return false;
  const evaluated = new Set(input.evaluatedPaths);
  return changed.every((entry) => evaluated.has(entry.path));
}

/** One regex per static Python import form. */
const PYTHON_IMPORT_PATTERNS: readonly RegExp[] = [
  /^\s*import\s+([\w.]+)\s*(?:$|#)/gm,
  /^\s*from\s+([\w.]+)\s+import\b/gm,
  /^\s*from\s+(\.[\w.]*)\s+import\b/gm,
];
/**
 * One Python module-loading call form: the head that locates the call,
 * and the same call with a single string-literal argument. A literal
 * specifier is fixed at parse time, so the call is an ordinary import
 * edge; anything else (a variable, a concatenation, a template with
 * `${…}`) is computed and refuses the re-seal.
 */
const PYTHON_MODULE_CALLS: readonly { head: RegExp; literal: RegExp }[] = [
  {
    head: /\bimportlib\s*\.\s*import_module\s*\(/g,
    literal: /\bimportlib\s*\.\s*import_module\s*\(\s*(?:(['"])([^'"\n]*)\1|`([^`$\n]*)`)\s*\)/,
  },
  {
    head: /\b__import__\s*\(/g,
    literal: /\b__import__\s*\(\s*(?:(['"])([^'"\n]*)\1|`([^`$\n]*)`)\s*\)/,
  },
];

/**
 * The parser mode a path's extension implies, so a `.tsx` file is read
 * as TSX and a `.mjs` file as JS rather than being parsed as the wrong
 * language and refused for bytes that are perfectly valid.
 *
 * Args:
 *   path: repository-relative POSIX path.
 *
 * Returns:
 *   ts.ScriptKind: the parser mode for that path.
 */
function scriptKindFor(path: string): ts.ScriptKind {
  const extension = extname(path);
  if (extension === '.tsx') return ts.ScriptKind.TSX;
  if (extension === '.jsx') return ts.ScriptKind.JSX;
  if (extension === '.js' || extension === '.mjs' || extension === '.cjs') return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

/**
 * The Python source with comment lines and triple-quoted block text
 * removed, so only real code is left to scan. A line whose first
 * non-space character is `#` is a comment, and text between `'''` or
 * `"""` delimiters is a string: neither is syntax, and neither can
 * declare an import.
 *
 * Args:
 *   source: the blob's bytes.
 *
 * Returns:
 *   string: the code lines, rejoined.
 */
function pythonCodeOnly(source: string): string {
  const kept: string[] = [];
  let closer: string | null = null;
  for (const line of source.split('\n')) {
    if (closer !== null) {
      if (line.includes(closer)) closer = null;
      continue;
    }
    if (line.trimStart().startsWith('#')) continue;
    let code = line;
    for (;;) {
      // The earliest triple-quote on the line opens a string. A partner
      // on the same line makes the whole string droppable; without one
      // the string runs on, and the rest of the file is its text.
      const [earliest] = ['"""', "'''"]
        .map((quote) => ({ quote, at: code.indexOf(quote) }))
        .filter((candidate) => candidate.at >= 0)
        .sort((left, right) => left.at - right.at);
      if (earliest === undefined) break;
      const end = code.indexOf(earliest.quote, earliest.at + 3);
      if (end < 0) {
        code = code.slice(0, earliest.at);
        closer = earliest.quote;
        break;
      }
      code = code.slice(0, earliest.at) + code.slice(end + 3);
    }
    kept.push(code);
  }
  return kept.join('\n');
}

/**
 * The suffix every refusal line ends with. The re-seal path is
 * attempted only under `--scope changed`, so the only thing a refusal
 * ever changes is that this run takes the ordinary CHANGED-SCOPE path
 * (three tests, `scope: changed` receipt) — never a full run.
 */
export const RESEAL_REFUSAL_SUFFIX = '→ changed-scope run';

/** One plain reason line, ending in what this run actually does next. */
export function resealRefusal(reason: string): string {
  return `${reason} ${RESEAL_REFUSAL_SUFFIX}`;
}

/** The same reason without the suffix, for a recomputation verdict. */
export function resealRefusalVerdict(reason: string | null): string {
  return String(reason).replace(new RegExp(` ${RESEAL_REFUSAL_SUFFIX}$`), '');
}

/**
 * Reads one JS/TS blob's import statements out of its syntax tree.
 * Comments and string contents are not syntax, so a sentence that
 * happens to name an import call can never be read as one. A specifier
 * written as a string literal or a no-substitution template is fixed at
 * parse time and is an ordinary edge; every other argument form — a
 * variable, a concatenation, a template with `${…}` — computes the
 * specifier and refuses. Bytes the parser cannot read refuse too,
 * because an unread file cannot be shown to declare nothing computed.
 *
 * Args:
 *   path: repository-relative POSIX path (selects the parser mode).
 *   source: the blob's bytes.
 *
 * Returns:
 *   TrackedFile: the edges, the computed-import flag, the parse flag.
 */
function parseScriptFile(path: string, source: string): TrackedFile {
  // A byte-order mark is an encoding artifact, not source text. Node
  // strips one before compiling, and the TypeScript parser cannot read
  // a shebang that follows it, so leaving the mark in place would
  // refuse a re-seal over bytes that run.
  const text = source.charCodeAt(0) === 0xfeff ? source.slice(1) : source;
  const sourceFile = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, scriptKindFor(path));
  const parseDiagnostics = (sourceFile as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] })
    .parseDiagnostics;
  if ((parseDiagnostics ?? []).length > 0) {
    return { path, imports: [], dynamic: false, unparsable: true };
  }
  const imports: ImportRef[] = [];
  let dynamic = false;
  const record = (expression: ts.Expression | undefined): void => {
    if (expression === undefined) {
      dynamic = true;
      return;
    }
    if (!ts.isStringLiteral(expression) && !ts.isNoSubstitutionTemplateLiteral(expression)) {
      dynamic = true;
      return;
    }
    imports.push({ specifier: expression.text });
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      record(node.moduleSpecifier);
    } else if (ts.isExportDeclaration(node)) {
      // `export { x };` re-exports a local binding and loads nothing;
      // only `export … from 'y'` names a module.
      if (node.moduleSpecifier !== undefined) record(node.moduleSpecifier);
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      record(node.moduleReference.expression);
    } else if (ts.isImportTypeNode(node)) {
      // A type-position `import('x').T` loads nothing at run time, but
      // it still couples this file to the target's shape, so it is an
      // edge; only a computed one refuses.
      if (!ts.isLiteralTypeNode(node.argument) || !ts.isStringLiteral(node.argument.literal)) dynamic = true;
      else imports.push({ specifier: node.argument.literal.text });
    } else if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) record(node.arguments[0]);
      else if (ts.isIdentifier(node.expression) && node.expression.text === 'require') record(node.arguments[0]);
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sourceFile, visit);
  return { path, imports, dynamic, unparsable: false };
}

/**
 * Reads one Python blob's import statements out of its code lines.
 *
 * Args:
 *   path: repository-relative POSIX path.
 *   source: the blob's bytes.
 *
 * Returns:
 *   TrackedFile: the edges and the computed-import flag.
 */
function parsePythonFile(path: string, source: string): TrackedFile {
  const code = pythonCodeOnly(source);
  const imports: ImportRef[] = [];
  for (const pattern of PYTHON_IMPORT_PATTERNS) {
    for (const match of code.matchAll(pattern)) {
      if (match[1] !== undefined) imports.push({ specifier: match[1] });
    }
  }
  // A literal argument is a normal edge; the backtick alternative
  // excludes `$`, so an interpolated template never matches it.
  let dynamic = false;
  for (const call of PYTHON_MODULE_CALLS) {
    for (const match of code.matchAll(call.head)) {
      const literal = call.literal.exec(code.slice(match.index));
      const specifier = literal?.[2] ?? literal?.[3];
      if (literal === null || specifier === undefined) dynamic = true;
      else imports.push({ specifier });
    }
  }
  return { path, imports, dynamic, unparsable: false };
}

/** Parses one file's import statements out of its bytes. */
function parseTrackedFile(path: string, source: string): TrackedFile {
  return extname(path) === '.py' ? parsePythonFile(path, source) : parseScriptFile(path, source);
}

/**
 * Splits a `git cat-file --batch` transcript into the requested blobs'
 * texts, in request order. Records are read sequentially by the BYTE
 * sizes git reports; decoding happens per blob, after the cut, so a
 * multi-byte character can never shift a record boundary.
 *
 * Args:
 *   batch: the raw transcript bytes.
 *   shas: the object ids that were requested, in order.
 *
 * Returns:
 *   string[] | null: one decoded text per requested id, or null when
 *   any record is missing, is not a blob, or is truncated — an unread
 *   object is never read as "declares nothing".
 */
function batchBlobs(batch: Buffer, shas: readonly string[]): string[] | null {
  const texts: string[] = [];
  let offset = 0;
  for (const sha of shas) {
    const headerEnd = batch.indexOf(0x0a, offset);
    if (headerEnd < 0) return null;
    const [id, type, sizeText] = batch.toString('utf8', offset, headerEnd).split(' ');
    const size = Number.parseInt(sizeText ?? '', 10);
    if (id !== sha || type !== 'blob' || !Number.isSafeInteger(size) || size < 0) return null;
    const bodyEnd = headerEnd + 1 + size;
    if (bodyEnd >= batch.length || batch[bodyEnd] !== 0x0a) return null;
    texts.push(batch.toString('utf8', headerEnd + 1, bodyEnd));
    offset = bodyEnd + 1;
  }
  return texts;
}

/**
 * Lists the tracked source files of a sealed tree with the imports
 * their bytes declare. Content comes from the object store, not the
 * workspace, so the graph describes exactly the tree under judgement.
 *
 * Args:
 *   gitDir: the absolute git dir holding the tree object.
 *   env: the process environment (Git redirectors are stripped).
 *   treeId: the sealed candidate tree.
 *
 * Returns:
 *   TrackedFile[]: parsed source files sorted by path; null when the
 *   tree cannot be read (never a partial graph).
 */
function trackedSources(gitDir: string, env: NodeJS.ProcessEnv, treeId: string): TrackedFile[] | null {
  const listing = run(gitDir, env, ['ls-tree', '-r', '-z', treeId]);
  if (listing === null) return null;
  const entries: Array<{ path: string; sha: string }> = [];
  for (const record of listing.split('\0')) {
    if (record.length === 0) continue;
    const tab = record.indexOf('\t');
    if (tab < 0) return null;
    const meta = record.slice(0, tab).split(/\s+/);
    const sha = meta[2] ?? '';
    const path = record.slice(tab + 1);
    if ((meta[1] ?? '') !== 'blob' || sha.length === 0) continue;
    if (!SOURCE_EXTENSIONS.has(extname(path))) continue;
    entries.push({ path, sha });
  }
  if (entries.length === 0) return [];
  const shas = entries.map((entry) => entry.sha);
  const batch = runBytes(gitDir, env, ['cat-file', '--batch'], `${shas.join('\n')}\n`);
  const texts = batch === null ? null : batchBlobs(batch, shas);
  if (texts === null) return null;
  return entries
    .map((entry, index) => parseTrackedFile(entry.path, texts[index] ?? ''))
    .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
}

/** Reads the repository's tsconfig/jsconfig path aliases (fail closed). */
function pathAliases(cwd: string): PathAlias[] {
  for (const name of ['tsconfig.json', 'jsconfig.json']) {
    let raw: string;
    try {
      raw = readFileSync(join(cwd, name), 'utf8');
    } catch {
      continue;
    }
    let parsed: unknown;
    try {
      // tsconfig documents carry comments and trailing commas.
      parsed = JSON.parse(
        raw
          .replace(/\/\*[\s\S]*?\*\//g, '')
          .replace(/(^|\s)\/\/.*$/gm, '$1')
          .replace(/,\s*([}\]])/g, '$1'),
      );
    } catch {
      return [];
    }
    const options = (parsed as { compilerOptions?: { baseUrl?: string; paths?: Record<string, string[]> } })
      ?.compilerOptions;
    const aliases: PathAlias[] = [];
    for (const [pattern, targets] of Object.entries(options?.paths ?? {})) {
      const target = targets[0];
      if (target === undefined) continue;
      aliases.push({
        prefix: pattern.endsWith('/*') ? pattern.slice(0, -2) : pattern.replace(/\*$/, ''),
        target: relative(cwd, resolve(cwd, options?.baseUrl ?? '.', target.replace(/\*$/, '')))
          .split(/[\\/]/)
          .join('/'),
      });
    }
    return aliases;
  }
  return [];
}

function resolutionCandidates(
  fromFile: string,
  specifier: string,
  aliases: readonly PathAlias[],
): string[] | null {
  let base: string | null = null;
  if (specifier.startsWith('.')) {
    base = posix.normalize(posix.join(posix.dirname(fromFile), specifier));
  } else {
    const alias = aliases.find((candidate) => specifier.startsWith(candidate.prefix));
    if (alias !== undefined) {
      base = posix.normalize(posix.join(alias.target, specifier.slice(alias.prefix.length).replace(/^\//, '')));
    } else if (/^[@a-zA-Z]/.test(specifier)) {
      return [];
    } else {
      return null;
    }
  }
  return [
    base,
    // An ESM-style specifier names the emitted extension; the source may
    // be its TypeScript twin (`./helper.js` resolves to `helper.ts`).
    ...(base.match(/\.(js|mjs|cjs|jsx)$/) !== null
      ? [base.replace(/\.(js|mjs|cjs|jsx)$/, '.ts'), base.replace(/\.(js|mjs|cjs|jsx)$/, '.tsx')]
      : []),
    ...RESOLVABLE_SUFFIXES.map((suffix) => `${base}${suffix}`),
    ...RESOLVABLE_SUFFIXES.slice(0, 4).map((suffix) => `${base}/index${suffix}`),
  ];
}

/**
 * A setup/dependency stage of the runner: a test file that runs BEFORE
 * the tests depending on it (a Playwright project named in another
 * project's `dependencies`, or a file the setup naming conventions
 * claim). Changing one changes every dependent test without any import
 * edge, so it can never be carried.
 */
interface SetupStage {
  /** Catalog test files a dependency/setup project owns. */
  files: string[];
  /**
   * True when a runner config declares a dependency project whose test
   * files cannot be resolved from the config's own bytes. Every changed
   * test file is then a possible setup file (fail closed).
   */
  unresolved: boolean;
}

/** Runner config file names, checked at the repository root. */
const RUNNER_CONFIG_NAMES = [
  'playwright.config.ts',
  'playwright.config.mts',
  'playwright.config.cts',
  'playwright.config.js',
  'playwright.config.mjs',
  'playwright.config.cjs',
  'vitest.config.ts',
  'vitest.config.js',
  'cypress.config.ts',
  'cypress.config.js',
] as const;

/**
 * True for a test file the setup naming conventions claim: the
 * extension-stripped basename ends in `setup` (`auth.setup.ts`,
 * `global-setup.ts`, `e2e/setup.ts`) and is not itself a spec/test
 * file, whose name says nothing about the stage it runs in.
 */
function isSetupByConvention(path: string): boolean {
  const base = path.slice(path.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  const stem = (dot <= 0 ? base : base.slice(0, dot)).toLowerCase();
  if (/(?:^|[.\-_])(?:spec|test)$/.test(stem)) return false;
  return /(?:^|[.\-_])(?:global[-_])?setup$/.test(stem);
}

/** Splits a brace-delimited array/object literal into its top-level items. */
function splitTopLevel(text: string): string[] {
  const items: string[] = [];
  let depth = 0;
  let start = 0;
  let quote: string | null = null;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quote !== null) {
      if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"' || char === '`') {
      quote = char;
      continue;
    }
    if (char === '{' || char === '[') depth += 1;
    else if (char === '}' || char === ']') {
      depth -= 1;
      if (depth === 0) {
        items.push(text.slice(start, index + 1).trim());
        start = index + 1;
      }
    } else if (char === ',' && depth === 0) {
      // Between top-level items: the item was already closed and pushed.
      start = index + 1;
    }
  }
  const tail = text.slice(start).trim();
  if (tail.length > 0) items.push(tail);
  return items;
}

/**
 * The string values of already-split items, or null when any item is
 * not a plain quoted literal (a computed value fails closed).
 */
function stringLiterals(items: readonly string[]): string[] | null {
  const values: string[] = [];
  for (const item of items) {
    const value = /^['"`]([^'"`]+)['"`]$/.exec(item)?.[1];
    if (value === undefined) return null;
    values.push(value);
  }
  return values;
}

/** Reads the runner config's own bytes from the sealed tree. */
function runnerConfigText(gitDir: string, env: NodeJS.ProcessEnv, treeId: string): string | null {
  for (const name of RUNNER_CONFIG_NAMES) {
    const text = run(gitDir, env, ['cat-file', 'blob', `${treeId}:${name}`]);
    if (text !== null) return text;
  }
  return null;
}

/**
 * Resolves the setup/dependency stage from the runner config's own
 * bytes: every project another project names in `dependencies` owns
 * the test files its `testMatch` selects. A `dependencies` value that
 * is not a literal list of project names leaves the stage unresolved,
 * which fails the whole re-seal closed rather than guessing.
 *
 * Args:
 *   gitDir: the absolute git dir holding the tree object.
 *   env: the process environment (Git redirectors are stripped).
 *   treeId: the sealed candidate tree.
 *   testFiles: repository-relative paths the runner catalog enumerates.
 *
 * Returns:
 *   SetupStage: the setup test files, or `unresolved` when the config
 *   declares a dependency stage the bytes do not pin down.
 */
function setupStage(
  gitDir: string,
  env: NodeJS.ProcessEnv,
  treeId: string,
  testFiles: readonly string[],
): SetupStage {
  const files = new Set(testFiles.filter((file) => isSetupByConvention(file)));
  const config = runnerConfigText(gitDir, env, treeId);
  // No `dependencies` token anywhere means no dependency stage the
  // config declares; a token we cannot resolve fails closed below.
  if (config === null || !/\bdependencies\b/.test(config)) return { files: [...files], unresolved: false };
  const projectsAt = config.indexOf('projects');
  if (projectsAt < 0) return { files: [...files], unresolved: true };
  const arrayAt = config.indexOf('[', projectsAt);
  if (arrayAt < 0) return { files: [...files], unresolved: true };
  let depth = 0;
  let end = -1;
  for (let index = arrayAt; index < config.length; index += 1) {
    const char = config[index];
    if (char === '[') depth += 1;
    else if (char === ']') {
      depth -= 1;
      if (depth === 0) {
        end = index;
        break;
      }
    }
  }
  if (end < 0) return { files: [...files], unresolved: true };
  const projectLiterals = splitTopLevel(config.slice(arrayAt + 1, end)).filter(
    (literal) => literal.startsWith('{'),
  );
  if (projectLiterals.length === 0) return { files: [...files], unresolved: true };
  const byName = new Map<string, string>();
  let anyDependency = false;
  for (const literal of projectLiterals) {
    const name = /\bname\s*:\s*['"`]([^'"`]+)['"`]/.exec(literal)?.[1];
    if (name === undefined) return { files: [...files], unresolved: true };
    byName.set(name, literal);
    if (/\bdependencies\s*:/.test(literal)) anyDependency = true;
  }
  if (!anyDependency) return { files: [...files], unresolved: false };
  for (const literal of projectLiterals) {
    const declared = /\bdependencies\s*:\s*\[([^\]]*)\]/.exec(literal);
    if (declared === null || declared[1] === undefined) {
      if (/\bdependencies\s*:/.test(literal)) return { files: [...files], unresolved: true };
      continue;
    }
    const names = stringLiterals(splitTopLevel(declared[1]));
    if (names === null) return { files: [...files], unresolved: true };
    for (const name of names) {
      const project = byName.get(name);
      if (project === undefined) return { files: [...files], unresolved: true };
      const testDir = /\btestDir\s*:\s*['"`]([^'"`]+)['"`]/.exec(project)?.[1];
      if (project.includes('testDir') && testDir === undefined) {
        return { files: [...files], unresolved: true };
      }
      const match = /\btestMatch\s*:\s*(['"`][^'"`]+['"`]|\[[^\]]*\])/.exec(project);
      if (match === null || match[1] === undefined) return { files: [...files], unresolved: true };
      const literal = match[1];
      const patterns =
        literal.startsWith('[') ? stringLiterals(splitTopLevel(literal.slice(1, -1))) : stringLiterals([literal]);
      if (patterns === null) return { files: [...files], unresolved: true };
      const prefix = testDir === undefined ? '' : `${posix.normalize(testDir)}/`;
      for (const pattern of patterns) {
        const matches = picomatch(prefix + pattern, { dot: true });
        for (const file of testFiles) {
          if (matches(file)) files.add(file);
        }
      }
    }
  }
  return { files: [...files].sort(), unresolved: false };
}

/** Every directory the catalog's test files live in or under. */
function testRoots(testFiles: readonly string[]): string[] {
  return [...new Set(testFiles.map((file) => posix.dirname(file)))].filter((dir) => dir.length > 0).sort();
}

function underTestRoot(path: string, roots: readonly string[]): boolean {
  return roots.some((root) => path === root || path.startsWith(`${root}/`));
}

/**
 * Classifies one change set against the runner's own test catalog.
 *
 * Args:
 *   gitDir: the absolute git dir holding both tree objects.
 *   env: the process environment (Git redirectors are stripped).
 *   cwd: the repository root (tsconfig alias resolution).
 *   parentTreeId: the parent receipt's sealed candidate tree.
 *   currentTreeId: the candidate tree this run froze.
 *   testFiles: repository-relative paths the runner catalog enumerates.
 *
 * Returns:
 *   ResealChangeClassification: the classes, the affected test files, and
 *   — when the change is not test-only — the single plain reason line.
 */
export function classifyResealChange(input: {
  gitDir: string;
  env: NodeJS.ProcessEnv;
  cwd: string;
  parentTreeId: string;
  currentTreeId: string;
  testFiles: readonly string[];
}): ResealChangeClassification {
  const changed = diffSealedTrees(input.gitDir, input.env, input.parentTreeId, input.currentTreeId);
  const changedPaths = (changed ?? []).map((entry) => entry.path);
  const refuse = (reason: string): ResealChangeClassification => ({
    eligible: false,
    reason: resealRefusal(reason),
    changedPaths,
    testFiles: [],
    helperFiles: [],
    affectedTestFiles: [],
  });
  if (changed === null) {
    return refuse(
      `the sealed trees could not be diffed (${input.parentTreeId} → ${input.currentTreeId})`,
    );
  }
  if (changed.length === 0) {
    return refuse('the sealed trees are identical, so there is nothing to classify');
  }
  const testFileSet = new Set(input.testFiles);
  const roots = testRoots(input.testFiles);
  const testFiles = changed.filter((entry) => testFileSet.has(entry.path)).map((entry) => entry.path);
  // A deleted path is classified by the SAME catalog: a deleted test
  // file simply leaves the expected set, while a deleted anything-else is
  // app code by definition and its importers break at run time.
  for (const entry of changed) {
    if (entry.status === 'D' && !testFileSet.has(entry.path)) {
      return refuse(`app file deleted: ${entry.path}`);
    }
  }
  // A setup/dependency test file changes every dependent test without an
  // import edge, so it can never be carried. A config whose dependency
  // project the bytes do not pin down makes every changed test file a
  // possible setup file.
  const stage = setupStage(input.gitDir, input.env, input.currentTreeId, input.testFiles);
  if (stage.unresolved) {
    const first = testFiles[0];
    if (first !== undefined) {
      return refuse(
        `setup test changed: ${first} (the runner config declares a dependency project whose tests cannot be resolved)`,
      );
    }
  } else {
    const setup = testFiles.find((file) => stage.files.includes(file));
    if (setup !== undefined) {
      return refuse(`setup test changed: ${setup}`);
    }
  }
  const candidates = changed.filter((entry) => !testFileSet.has(entry.path)).map((entry) => entry.path);
  // A changed path outside every test root is app code whatever the
  // import graph says, so it refuses first and by its own name: the
  // reason a user needs is "you changed app code", not a doubt about
  // some unrelated file's imports.
  const appFile = candidates.find((path) => !underTestRoot(path, roots));
  if (appFile !== undefined) return refuse(`app file changed: ${appFile}`);
  // The import graph is consulted for EVERY change set, not only for a
  // helper claim: a spec file can export a shared fixture or a
  // `test.extend`, so a changed test file affects its importers too.
  // Any doubt the graph cannot resolve refuses the whole re-seal.
  const allSources = trackedSources(input.gitDir, input.env, input.currentTreeId);
  if (allSources === null) {
    return refuse(`the sealed tree's import graph could not be read (${input.currentTreeId})`);
  }
  // Imports never cross the language boundary: a Python import (static
  // or computed) loads only Python modules, and a JS/TS import loads
  // only JS/TS/data files. So a file can reach a changed path only when
  // the change set holds a path of its own family (a changed non-Python
  // file of any extension counts as the script family, since a script
  // can import data files). Files of the other family can hide no edge
  // and are left out of the graph, doubts included.
  const pythonChanged = changedPaths.some((path) => extname(path) === '.py');
  const scriptChanged = changedPaths.some((path) => extname(path) !== '.py');
  const sources = allSources.filter((file) => (extname(file.path) === '.py' ? pythonChanged : scriptChanged));
  // A file whose bytes the parser rejects has NOT been shown to declare
  // nothing computed, so it refuses before the graph is read.
  const unparsableFile = sources.find((file) => file.unparsable);
  if (unparsableFile !== undefined) {
    return refuse(`unresolvable import: ${unparsableFile.path} does not parse as a script`);
  }
  const dynamicFile = sources.find((file) => file.dynamic);
  if (dynamicFile !== undefined) {
    return refuse(
      `unresolvable import: ${dynamicFile.path} loads a module through a computed specifier`,
    );
  }
  const aliases = pathAliases(input.cwd);
  /** Every candidate path each import could name, or null when one cannot be read. */
  const resolveImports = (file: TrackedFile): string[][] | null => {
    const resolved: string[][] = [];
    for (const reference of file.imports) {
      const candidates = resolutionCandidates(file.path, reference.specifier, aliases);
      if (candidates === null) return null;
      resolved.push(candidates);
    }
    return resolved;
  };
  /**
   * Every file whose imports could name `target`. Keyed on ALL
   * resolution candidates, not only the tracked one, so a DELETED test
   * file still reaches the specs that imported it (its own path is no
   * longer in the tree, but the importer's specifier still names it).
   */
  const importersOf = new Map<string, string[]>();
  for (const file of sources) {
    const resolved = resolveImports(file);
    if (resolved === null) {
      const unresolvable = file.imports.find(
        (reference) => resolutionCandidates(file.path, reference.specifier, aliases) === null,
      );
      return refuse(
        `unresolvable import: ${file.path} → ${unresolvable?.specifier ?? '?'}`,
      );
    }
    for (const candidates of resolved) {
      for (const target of candidates) {
        const importers = importersOf.get(target);
        if (importers === undefined) importersOf.set(target, [file.path]);
        else if (!importers.includes(file.path)) importers.push(file.path);
      }
    }
  }
  const helperFiles: string[] = [];
  const affected = new Set(testFiles);
  for (const path of [...testFiles, ...candidates]) {
    const isTestFile = testFileSet.has(path);
    // Importers re-run transitively: a shared fixture declared in a
    // helper OR in another spec file reaches every spec that imports it
    // (a helper of a helper counts). A changed test file needs no
    // importer; a changed non-test file must be proven to be a helper.
    const seen = new Set<string>();
    const queue = [path];
    while (queue.length > 0) {
      const current = queue.shift() as string;
      for (const file of importersOf.get(current) ?? []) {
        if (seen.has(file)) continue;
        seen.add(file);
        if (testFileSet.has(file)) affected.add(file);
        else if (!underTestRoot(file, roots)) {
          return refuse(
            `app file changed: ${file} imports the changed ${isTestFile ? 'test file' : 'test helper'} ${path}`,
          );
        } else queue.push(file);
      }
    }
    if (!isTestFile && seen.size === 0) {
      return refuse(`app file changed: ${path} is imported by no test file, so it is not a test helper`);
    }
    if (!isTestFile) helperFiles.push(path);
  }
  return {
    eligible: true,
    reason: null,
    changedPaths,
    testFiles,
    helperFiles: helperFiles.sort(),
    affectedTestFiles: [...affected].sort(),
  };
}
