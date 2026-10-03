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
import { parse as parseYaml } from 'yaml';
import { CONFIG_SEARCH_PRUNED_DIRS, PLAYWRIGHT_CONFIG_NAMES } from '@gate-forge/pack-playwright';
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
  /**
   * Changed paths the owner declared as runtime state the run itself
   * rewrites (`enforcement.resealRuntimeFiles`) and that neither
   * sealed commit tracks — the ONLY paths a declaration may hide. A
   * tracked path is never here, so a declaration can never hide a
   * source change.
   *
   * Present only when the config declares at least one glob, so a
   * repository that declares nothing gets today's result object byte
   * for byte. `changedPaths` always keeps the real tree difference,
   * declared or not: the receipt states what the trees really differ
   * in, and the consumer recomputes that from the trees themselves.
   */
  disregardedPaths?: string[];
}

/**
 * Reads one committed tree's file list, so a path can be proven to be
 * untracked in it. A changed path that EITHER commit tracks is source
 * and never matches a runtime declaration, however the glob reads.
 *
 * Args:
 *   gitDir: the absolute git dir holding the tree object.
 *   env: the process environment (Git redirectors are stripped).
 *   treeId: the commit's tree (`<sha>^{tree}`).
 *
 * Returns:
 *   Set<string>: every repo-relative posix path the commit tracks;
 *   null when the list cannot be read (never a guess — the caller
 *   then disregards nothing).
 */
function committedPaths(gitDir: string, env: NodeJS.ProcessEnv, treeId: string): Set<string> | null {
  const out = run(gitDir, env, ['ls-tree', '-r', '-z', '--name-only', treeId]);
  if (out === null) return null;
  return new Set(out.split('\0').filter((path) => path.length > 0));
}

/**
 * The git modes a candidate tree records. Only an ordinary blob is
 * generated OUTPUT: a symlink (`120000`) and a submodule/gitlink
 * (`160000`) are links, not bytes this run may have produced, and a
 * missing entry is a path that is not in the sealed tree at all.
 */
const REGULAR_FILE_MODE: Record<string, true> = { '100644': true, '100755': true };

/**
 * Every path a sealed candidate tree records, with its git mode. The
 * candidate tree carries the workspace's untracked bytes too — that is
 * what makes it a candidate — so this listing is what tells a generated
 * artifact apart from a link.
 *
 * Args:
 *   gitDir: the absolute git dir holding the tree object.
 *   env: the process environment (Git redirectors are stripped).
 *   treeId: the sealed candidate tree.
 *
 * Returns:
 *   Map<string, string>: repo-relative posix path → git mode; null when
 *   the listing cannot be read (never a partial answer).
 */
function sealedTreeModes(
  gitDir: string,
  env: NodeJS.ProcessEnv,
  treeId: string,
): Map<string, string> | null {
  const out = run(gitDir, env, ['ls-tree', '-r', '-z', treeId]);
  if (out === null) return null;
  const modes = new Map<string, string>();
  for (const record of out.split('\0')) {
    if (record.length === 0) continue;
    const tab = record.indexOf('\t');
    if (tab < 0) return null;
    const mode = record.slice(0, tab).split(/\s+/)[0];
    if (mode === undefined) return null;
    modes.set(record.slice(tab + 1), mode);
  }
  return modes;
}

/**
 * Why a changed path the SEALED runner config declares as a browser state
 * is NOT generated output this run may have produced, or null when it is.
 *
 * A declaration is a READ statement first: it names where a project reads
 * a session, never which bytes preparation owns. Only a path that is
 * untracked in BOTH sealed commits, outside the run's input inventory, an
 * ordinary file in the sealed tree and not a deletion is generated output,
 * so a repository that COMMITS its fixture session keeps a perfectly valid
 * read declaration whose bytes stay immutable.
 *
 * Args:
 *   entry: the changed path, with its tree-diff status.
 *   mode: the path's git mode in the sealed candidate tree.
 *   parentTracked: every path the parent's commit tracks.
 *   currentTracked: every path this run's commit tracks.
 *   inputFiles: the paths this run's input snapshot binds, or null when
 *     the caller has no inventory (never a guess).
 *
 * Returns:
 *   string | null: the plain refusal, or null when admissible.
 */
function generatedStateRefusal(
  entry: ChangedPath,
  mode: string | undefined,
  parentTracked: ReadonlySet<string>,
  currentTracked: ReadonlySet<string>,
  inputFiles: ReadonlySet<string> | null,
): string | null {
  const named = `declared browser state changed: ${entry.path}`;
  if (parentTracked.has(entry.path) || currentTracked.has(entry.path)) {
    return (
      `${named} — it is tracked by git, so it is source: a use.storageState declaration is a READ path, ` +
      'never a write permission over tracked bytes'
    );
  }
  if (inputFiles !== null && inputFiles.has(entry.path)) {
    return `${named} — it is bound by this run's input snapshot, so preparation may not redefine what the run tested`;
  }
  if (entry.status === 'D') {
    return `${named} — a removal is never preparation output, so it cannot be carried as a state change`;
  }
  if (mode === undefined || !Object.hasOwn(REGULAR_FILE_MODE, mode)) {
    return `${named} — it is not an ordinary file inside the sealed candidate, so it is never generated output`;
  }
  return null;
}

/**
 * Extensions whose import statements the graph resolves.
 *
 * A fixed string-keyed lookup, so it is a Record and membership is
 * `Object.hasOwn` — never the `in` operator, which would answer `true`
 * for an inherited prototype key. The keys are extensions, so nothing in
 * the graph can name a prototype member; the own-property test is what
 * keeps that guarantee independent of the key spelling.
 */
const SOURCE_EXTENSIONS: Readonly<Record<string, true>> = {
  '.ts': true,
  '.tsx': true,
  '.mts': true,
  '.cts': true,
  '.js': true,
  '.jsx': true,
  '.mjs': true,
  '.cjs': true,
  '.py': true,
};

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
 * Whether a re-seal parent is bound to its OWN commit: the commit the
 * parent document says it sealed must exist in this repository's
 * object store and be an ancestor of (or equal to) HEAD. A parent
 * sealed on a sibling branch, or one whose commit this repository
 * cannot read, proves nothing about the bytes this run froze.
 *
 * The commit is read from the parent DOCUMENT, never from a CI
 * variable: a merge request's diff base is a different commit from the
 * one the previous pipeline tested, and no CI sets that variable to
 * the parent anyway.
 *
 * Args:
 *   gitDir: the absolute git dir of this repository.
 *   env: the process environment (Git redirectors are stripped).
 *   sha: the commit the parent document names, or null when it names
 *     none.
 *
 * Returns:
 *   'ancestor' when the commit exists and HEAD descends from it,
 *   'missing' when the parent names no commit or none this
 *   repository can read, and 'diverged' when the commit exists but
 *   HEAD does not descend from it.
 */
export function parentCommitAcceptance(
  gitDir: string | null,
  env: NodeJS.ProcessEnv,
  sha: string | null | undefined,
): 'ancestor' | 'missing' | 'diverged' {
  const commit = (sha ?? '').trim();
  if (gitDir === null || !/^[0-9a-f]{40}$/.test(commit)) return 'missing';
  if (runBytes(gitDir, env, ['cat-file', '-e', `${commit}^{commit}`]) === null) return 'missing';
  return runBytes(gitDir, env, ['merge-base', '--is-ancestor', commit, 'HEAD']) === null ? 'diverged' : 'ancestor';
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
 * The one plain line a run prints when a declared runtime file was
 * dropped from the change set, so a user sees exactly which ignored
 * bytes the decision ignored instead of having to infer it.
 *
 * Args:
 *   paths: the disregarded changed paths, sorted.
 *
 * Returns:
 *   string: the line body, without the `test-gates: ` prefix the
 *   caller writes (that prefix is the surface, not the message).
 */
export function resealDisregardNotice(paths: readonly string[]): string {
  return `re-seal disregards ${String(paths.length)} declared runtime file(s): ${paths.join(', ')}`;
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
    if (!Object.hasOwn(SOURCE_EXTENSIONS, extname(path))) continue;
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
  /** Files owned by declared dependency projects, not merely setup-named files. */
  dependencyFiles: string[];
  /**
   * True when a runner config declares a dependency project whose test
   * files cannot be resolved from the config's own bytes. Every changed
   * test file is then a possible setup file (fail closed).
   */
  unresolved: boolean;
}

/** Each configured runner reads its own config, not another runner's root file. */
const RUNNER_CONFIG_NAMES: Readonly<Record<string, readonly string[]>> = {
  playwright: PLAYWRIGHT_CONFIG_NAMES,
  vitest: ['vitest.config.ts', 'vitest.config.js'],
  cypress: ['cypress.config.ts', 'cypress.config.js'],
  pytest: [],
};

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

/** Reads selected config bytes only from the sealed tree, never the working copy. */
function runnerConfigText(
  gitDir: string,
  env: NodeJS.ProcessEnv,
  treeId: string,
): { text: string; directory: string; name: string; runner: string } | null {
  const root = run(gitDir, env, ['ls-tree', '-z', treeId]);
  if (root === null) return null;
  const rootPaths = new Set<string>();
  const nested: string[] = [];
  for (const entry of root.split('\0')) {
    const tab = entry.indexOf('\t');
    if (tab < 0) continue;
    const name = entry.slice(tab + 1);
    rootPaths.add(name);
    if (entry.startsWith('040000 tree ') && CONFIG_SEARCH_PRUNED_DIRS[name] !== true) nested.push(name);
  }
  let runner = 'playwright';
  if (rootPaths.has('.gateforge.yml')) {
    const config = run(gitDir, env, ['cat-file', 'blob', `${treeId}:.gateforge.yml`]);
    if (config === null) return null;
    try {
      const document = parseYaml(config) as { runner?: unknown } | null;
      if (typeof document?.runner === 'string') runner = document.runner;
    } catch {
      return null;
    }
  }
  if (!Object.hasOwn(RUNNER_CONFIG_NAMES, runner)) return null;
  for (const name of RUNNER_CONFIG_NAMES[runner] ?? []) {
    if (!rootPaths.has(name)) continue;
    const text = run(gitDir, env, ['cat-file', 'blob', `${treeId}:${name}`]);
    return text === null ? null : { text, directory: '.', name, runner };
  }
  if (runner !== 'playwright' || nested.length === 0) return null;
  nested.sort();
  // One bounded listing of immediate children, not one Git process per candidate.
  const children = run(gitDir, env, ['ls-tree', '--name-only', '-z', treeId, ...nested.map((name) => `${name}/`)]);
  if (children === null) return null;
  const paths = new Set(children.split('\0'));
  for (const directory of nested) {
    for (const name of PLAYWRIGHT_CONFIG_NAMES) {
      const path = `${directory}/${name}`;
      if (!paths.has(path)) continue;
      const text = run(gitDir, env, ['cat-file', 'blob', `${treeId}:${path}`]);
      return text === null ? null : { text, directory, name, runner };
    }
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
  // Tracked apart from `files`: only these are re-executed by a run
  // because a `dependencies` edge orders them (see dependencyFiles).
  const dependencyFiles = new Set<string>();
  const source = runnerConfigText(gitDir, env, treeId);
  const config = source?.text ?? null;
  // No `dependencies` token anywhere means no dependency stage the
  // config declares; a token we cannot resolve fails closed below.
  if (config === null || !/\bdependencies\b/.test(config)) {
    return { files: [...files], dependencyFiles: [], unresolved: false };
  }
  const projectsAt = config.indexOf('projects');
  if (projectsAt < 0) return { files: [...files], dependencyFiles: [], unresolved: true };
  const arrayAt = config.indexOf('[', projectsAt);
  if (arrayAt < 0) return { files: [...files], dependencyFiles: [], unresolved: true };
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
  if (end < 0) return { files: [...files], dependencyFiles: [], unresolved: true };
  const outerConfig = config.slice(0, projectsAt) + config.slice(end + 1);
  const inheritedTestDir = /\btestDir\s*:\s*['"`]([^'"`]+)['"`]/.exec(outerConfig)?.[1];
  if (/\btestDir\s*:/.test(outerConfig) && inheritedTestDir === undefined) {
    return { files: [...files], dependencyFiles: [], unresolved: true };
  }
  const projectLiterals = splitTopLevel(config.slice(arrayAt + 1, end)).filter(
    (literal) => literal.startsWith('{'),
  );
  if (projectLiterals.length === 0) return { files: [...files], dependencyFiles: [], unresolved: true };
  const byName = new Map<string, string>();
  let anyDependency = false;
  for (const literal of projectLiterals) {
    const name = /\bname\s*:\s*['"`]([^'"`]+)['"`]/.exec(literal)?.[1];
    if (name === undefined) return { files: [...files], dependencyFiles: [], unresolved: true };
    byName.set(name, literal);
    if (/\bdependencies\s*:/.test(literal)) anyDependency = true;
  }
  if (!anyDependency) return { files: [...files], dependencyFiles: [], unresolved: false };
  for (const literal of projectLiterals) {
    const declared = /\bdependencies\s*:\s*\[([^\]]*)\]/.exec(literal);
    if (declared === null || declared[1] === undefined) {
      if (/\bdependencies\s*:/.test(literal)) {
        return { files: [...files], dependencyFiles: [], unresolved: true };
      }
      continue;
    }
    const names = stringLiterals(splitTopLevel(declared[1]));
    if (names === null) return { files: [...files], dependencyFiles: [], unresolved: true };
    for (const name of names) {
      const project = byName.get(name);
      if (project === undefined) return { files: [...files], dependencyFiles: [], unresolved: true };
      const testDir = /\btestDir\s*:\s*['"`]([^'"`]+)['"`]/.exec(project)?.[1];
      if (project.includes('testDir') && testDir === undefined) {
        return { files: [...files], dependencyFiles: [], unresolved: true };
      }
      const match = /\btestMatch\s*:\s*(['"`][^'"`]+['"`]|\[[^\]]*\])/.exec(project);
      if (match === null || match[1] === undefined) {
        return { files: [...files], dependencyFiles: [], unresolved: true };
      }
      const literal = match[1];
      const patterns =
        literal.startsWith('[') ? stringLiterals(splitTopLevel(literal.slice(1, -1))) : stringLiterals([literal]);
      if (patterns === null) return { files: [...files], dependencyFiles: [], unresolved: true };
      const testRoot = posix.normalize(posix.join(source?.directory ?? '.', testDir ?? inheritedTestDir ?? '.'));
      const prefix = testRoot === '.' ? '' : `${testRoot}/`;
      for (const pattern of patterns) {
        const matches = picomatch(pattern, { dot: true, matchBase: !pattern.includes('/') });
        for (const file of testFiles) {
          if (!file.startsWith(prefix)) continue;
          if (matches(file.slice(prefix.length))) {
            files.add(file);
            dependencyFiles.add(file);
          }
        }
      }
    }
  }
  return { files: [...files].sort(), dependencyFiles: [...dependencyFiles].sort(), unresolved: false };
}

/** One project as the sealed config's own bytes declare it. */
interface SealedProjectDeclaration {
  /** The project's literal `name`. */
  name: string;
  /** Its effective `testDir` (its own, else the config-level one). */
  testDir: string | null;
  /** Its effective `testMatch` patterns, or null when neither level declares one. */
  testMatch: string[] | null;
  /** Its literal `dependencies` names, or null when the key is absent. */
  dependencies: readonly string[] | null;
  /** Its effective `use.storageState` declaration, or null when it has none. */
  state: string | null;
}

/** The sealed runner config's projects, plus whatever the bytes could not pin down. */
interface SealedConfigDeclaration {
  /** The directory the config file lives in — what a relative path resolves from. */
  directory: string;
  /** Every declared project, in declaration order. */
  projects: SealedProjectDeclaration[];
  /**
   * Non-null when the bytes declare something this resolver cannot pin
   * down. It is never a silent empty list: an unreadable declaration is
   * a refusal, because guessing who reads a generated state file is
   * exactly the guess that must not be made.
   */
  problem: string | null;
}

/**
 * The name of one object-literal member, or null when the key is
 * computed and therefore names nothing this resolver can read.
 */
function configPropertyName(member: ts.ObjectLiteralElementLike): string | null {
  const name = member.name;
  // A member the syntax tree does not give a name for is a member this
  // resolver cannot key on, exactly like a computed key: it reports
  // nothing rather than guessing.
  if (name === undefined) return null;
  if (ts.isIdentifier(name)) return name.text;
  if (ts.isStringLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name)) return name.text;
  return null;
}

/**
 * One object literal's member by name, distinguishing three states that
 * must never be collapsed: the key is ABSENT, the key is present with a
 * readable initializer, or the key cannot be read at all.
 *
 * A spread only blocks a value when it comes AFTER the literal member,
 * because a later spread can overwrite it. A spread BEFORE the literal
 * member is overwritten BY it, which is what keeps the common
 * `defineConfig({ …devices['Desktop Chrome'], projects: […] })` shape
 * readable. An absent key is reported absent even beside a spread: a
 * spread that really did supply it can only make this resolver
 * UNDER-report a declaration, and an unreported declaration classifies as
 * app code and is refused by name — never the other way round, which is
 * the direction that would matter.
 */
function configProperty(
  object: ts.ObjectLiteralExpression,
  name: string,
): { present: boolean; node: ts.Expression | null } {
  let found: ts.Expression | null = null;
  for (const member of object.properties) {
    if (ts.isSpreadAssignment(member)) {
      if (found !== null) return { present: true, node: null };
      continue;
    }
    const key = configPropertyName(member);
    if (key === null) {
      // A computed key could be this very property, in this very place.
      if (found !== null) return { present: true, node: null };
      continue;
    }
    if (key !== name) continue;
    if (!ts.isPropertyAssignment(member)) return { present: true, node: null };
    found = member.initializer;
  }
  return { present: found !== null, node: found };
}

/**
 * A fixed string value, or null when the expression computes one. This is
 * the narrowing the whole declaration resolver rests on, exactly as it is
 * for the import graph above: a string literal or a no-substitution
 * template is fixed at parse time, and everything else computes.
 */
function sealedString(node: ts.Expression): string | null {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  return null;
}

/**
 * A fixed array of strings, or null when the expression is not one. An
 * empty array IS a fixed value (`dependencies: []`), which is why callers
 * read presence separately from emptiness.
 */
function sealedStringArray(node: ts.Expression): string[] | null {
  if (!ts.isArrayLiteralExpression(node)) return null;
  const values: string[] = [];
  for (const element of node.elements) {
    if (ts.isSpreadElement(element)) return null;
    const value = sealedString(element);
    if (value === null) return null;
    values.push(value);
  }
  return values;
}

/** A fixed string OR a fixed array of strings, or null when computed. */
function sealedStringPatterns(node: ts.Expression): string[] | null {
  const single = sealedString(node);
  return single === null ? sealedStringArray(node) : [single];
}

/**
 * Whether a normalized repo-relative posix path stays inside the
 * repository: not absolute, not the parent, not under it.
 */
function withinRepository(path: string): boolean {
  return path.length > 0 && !path.startsWith('/') && path !== '..' && !path.startsWith('../');
}

/**
 * One `testMatch` pattern against a path relative to the project's own
 * `testDir`. A pattern with no `/` matches a basename, exactly as the
 * runner's own default matching does.
 */
function matchesTestPattern(pattern: string, relativePath: string): boolean {
  return picomatch(pattern, { dot: true, matchBase: !pattern.includes('/') })(relativePath);
}

/**
 * The configuration object a runner config module default-exports, or
 * null when the module exports anything else (a call this resolver
 * cannot fold, a re-export, or nothing at all).
 */
function sealedConfigObject(sourceFile: ts.SourceFile): ts.ObjectLiteralExpression | null {
  for (const statement of sourceFile.statements) {
    if (!ts.isExportAssignment(statement) || statement.isExportEquals) continue;
    let expression: ts.Expression = statement.expression;
    // `defineConfig({ … })` is the one call the runner's own shape uses,
    // and it takes exactly the object literal this resolver reads.
    if (ts.isCallExpression(expression)) {
      if (expression.arguments.length !== 1) return null;
      const [only] = expression.arguments;
      if (only === undefined) return null;
      expression = only;
    }
    while (ts.isParenthesizedExpression(expression)) expression = expression.expression;
    return ts.isObjectLiteralExpression(expression) ? expression : null;
  }
  return null;
}

/**
 * Resolves the sealed runner config's projects, honouring root/global
 * inheritance the way the runner honours it.
 *
 * Every field is reported as ABSENT, FIXED or UNRESOLVED and never
 * guessed. A declaration the bytes compute (a variable, a concatenation,
 * a template with `${…}`, a call) is a doubt: it refuses, because the
 * classifier's whole job is to know who reads a declared state file.
 */
function sealedConfigProjects(text: string, name: string, directory: string): SealedConfigDeclaration {
  const unresolvable = (problem: string): SealedConfigDeclaration => ({ directory, projects: [], problem });
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const sourceFile = ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true, scriptKindFor(name));
  const parseDiagnostics = (sourceFile as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] })
    .parseDiagnostics;
  if ((parseDiagnostics ?? []).length > 0) {
    return unresolvable(`the runner config '${name}' does not parse, so its declarations cannot be read`);
  }
  const config = sealedConfigObject(sourceFile);
  if (config === null) {
    return unresolvable(`the runner config '${name}' exports no configuration object literal`);
  }
  // The root/global values a project inherits unless it declares its own.
  const rootUse = configProperty(config, 'use');
  if (rootUse.present && (rootUse.node === null || !ts.isObjectLiteralExpression(rootUse.node))) {
    return unresolvable(`the runner config '${name}' computes its root 'use' block`);
  }
  let rootState: string | null = null;
  if (rootUse.node !== null && ts.isObjectLiteralExpression(rootUse.node)) {
    const state = configProperty(rootUse.node, 'storageState');
    if (state.present && state.node === null) {
      return unresolvable(`the runner config '${name}' computes its root 'use.storageState'`);
    }
    // An INLINE state (`{ cookies, origins }`) names no file at all, so
    // it nominates nothing; a computed value names an unknown file,
    // which is a doubt and refuses.
    if (state.node !== null && !ts.isObjectLiteralExpression(state.node)) {
      rootState = sealedString(state.node);
      if (rootState === null) {
        return unresolvable(`the runner config '${name}' computes its root 'use.storageState'`);
      }
    }
  }
  const rootTestDir = configProperty(config, 'testDir');
  if (rootTestDir.present && (rootTestDir.node === null || sealedString(rootTestDir.node) === null)) {
    return unresolvable(`the runner config '${name}' declares a root 'testDir' that is not a fixed path`);
  }
  const rootTestMatch = configProperty(config, 'testMatch');
  if (rootTestMatch.present && (rootTestMatch.node === null || sealedStringPatterns(rootTestMatch.node) === null)) {
    return unresolvable(`the runner config '${name}' declares a root 'testMatch' that is not a fixed pattern list`);
  }
  const projectsProperty = configProperty(config, 'projects');
  if (!projectsProperty.present) return { directory, projects: [], problem: null };
  if (projectsProperty.node === null || !ts.isArrayLiteralExpression(projectsProperty.node)) {
    return unresolvable(`the runner config '${name}' computes its 'projects' list`);
  }
  const projects: SealedProjectDeclaration[] = [];
  const seen = new Set<string>();
  for (const element of projectsProperty.node.elements) {
    if (!ts.isObjectLiteralExpression(element)) {
      return unresolvable(`the runner config '${name}' computes one of its project declarations`);
    }
    const nameProperty = configProperty(element, 'name');
    const projectName = nameProperty.node === null ? null : sealedString(nameProperty.node);
    if (!nameProperty.present || projectName === null || projectName.length === 0) {
      return unresolvable(`a project in the runner config '${name}' has no fixed name`);
    }
    if (seen.has(projectName)) {
      return unresolvable(`the runner config '${name}' declares project '${projectName}' twice`);
    }
    seen.add(projectName);
    const testDirProperty = configProperty(element, 'testDir');
    if (testDirProperty.present && (testDirProperty.node === null || sealedString(testDirProperty.node) === null)) {
      return unresolvable(`project '${projectName}' in the runner config '${name}' declares a 'testDir' that is not a fixed path`);
    }
    const testMatchProperty = configProperty(element, 'testMatch');
    if (testMatchProperty.present && (testMatchProperty.node === null || sealedStringPatterns(testMatchProperty.node) === null)) {
      return unresolvable(`project '${projectName}' in the runner config '${name}' declares a 'testMatch' that is not a fixed pattern list`);
    }
    const dependenciesProperty = configProperty(element, 'dependencies');
    if (dependenciesProperty.present && (dependenciesProperty.node === null || sealedStringArray(dependenciesProperty.node) === null)) {
      return unresolvable(`project '${projectName}' in the runner config '${name}' declares 'dependencies' that are not a fixed name list`);
    }
    const useProperty = configProperty(element, 'use');
    if (useProperty.present && (useProperty.node === null || !ts.isObjectLiteralExpression(useProperty.node))) {
      return unresolvable(`project '${projectName}' in the runner config '${name}' declares a 'use' that is not an object literal`);
    }
    let state: string | null = null;
    if (useProperty.node !== null && ts.isObjectLiteralExpression(useProperty.node)) {
      const stateProperty = configProperty(useProperty.node, 'storageState');
      if (stateProperty.present && stateProperty.node === null) {
        return unresolvable(`project '${projectName}' in the runner config '${name}' computes its 'use.storageState'`);
      }
      if (stateProperty.node !== null && !ts.isObjectLiteralExpression(stateProperty.node)) {
        state = sealedString(stateProperty.node);
        if (state === null) {
          return unresolvable(`project '${projectName}' in the runner config '${name}' computes its 'use.storageState'`);
        }
      }
    }
    const ownTestDir = testDirProperty.node === null ? null : sealedString(testDirProperty.node);
    const ownTestMatch = testMatchProperty.node === null ? null : sealedStringPatterns(testMatchProperty.node);
    projects.push({
      name: projectName,
      testDir: ownTestDir ?? (rootTestDir.node === null ? null : sealedString(rootTestDir.node)),
      testMatch: ownTestMatch ?? (rootTestMatch.node === null ? null : sealedStringPatterns(rootTestMatch.node)),
      dependencies: dependenciesProperty.node === null ? null : sealedStringArray(dependenciesProperty.node),
      state: state ?? rootState,
    });
  }
  return { directory, projects, problem: null };
}

/**
 * The GENERATED STATE a runner's own configuration declares, and the test
 * files that CONSUME it — read from the SEALED config's own SYNTAX, never
 * from a candidate-supplied document, never from an unsigned diagnostic
 * and never from an environment variable.
 *
 * A `use.storageState` token anywhere in the file proves nothing: a
 * comment, nested metadata, a spread or a computed value can all carry
 * the same three words with no project reading a browser state at all. So
 * the declarations come from the parsed tree, with the same conventions
 * this file's import graph uses.
 *
 * The consumer set is the declaring project plus every project that
 * DEPENDS ON it, transitively — the DOWNSTREAM closure, walked over
 * reverse dependency edges. Walking the declaring project's own
 * `dependencies` instead reaches its UPSTREAM prerequisites, which
 * produce artifacts rather than consume them, and silently omits the very
 * bodies whose saved session the file carries.
 */
function generatedStateConsumers(
  gitDir: string,
  env: NodeJS.ProcessEnv,
  treeId: string,
  testFiles: readonly string[],
): { consumers: Map<string, string[]>; problem: string | null } {
  const source = runnerConfigText(gitDir, env, treeId);
  // No runner config in this sealed tree means nothing declares a
  // generated state, which is a fact rather than a doubt.
  if (source === null) return { consumers: new Map(), problem: null };
  // Only the Playwright shape declares projects and a per-project state;
  // every other runner's config keeps its classification untouched.
  if (source.runner !== 'playwright') return { consumers: new Map(), problem: null };
  const declaration = sealedConfigProjects(source.text, source.name, source.directory);
  if (declaration.problem !== null) return { consumers: new Map(), problem: declaration.problem };
  const byName = new Map<string, { declaration: SealedProjectDeclaration; files: string[] }>();
  for (const project of declaration.projects) {
    const testRoot = posix.normalize(posix.join(declaration.directory, project.testDir ?? '.'));
    if (!withinRepository(testRoot)) {
      return {
        consumers: new Map(),
        problem: `project '${project.name}' collects from outside the repository ('${testRoot}')`,
      };
    }
    const prefix = testRoot === '.' ? '' : `${testRoot}/`;
    const owned = testFiles.filter((file) => {
      if (!file.startsWith(prefix)) return false;
      if (project.testMatch === null) return true;
      const relativePath = file.slice(prefix.length);
      return project.testMatch.some((pattern) => matchesTestPattern(pattern, relativePath));
    });
    byName.set(project.name, { declaration: project, files: [...new Set(owned)].sort() });
  }
  // Reverse edges: the projects each declared project is a prerequisite
  // of. A name that resolves to no declared project leaves the graph
  // incomplete, so it is a doubt rather than an empty edge.
  const dependents = new Map<string, string[]>();
  for (const [name, entry] of byName) {
    for (const dependency of entry.declaration.dependencies ?? []) {
      if (!byName.has(dependency)) {
        return {
          consumers: new Map(),
          problem: `project '${name}' depends on '${dependency}', which the sealed runner config does not declare`,
        };
      }
      const list = dependents.get(dependency) ?? [];
      list.push(name);
      dependents.set(dependency, list);
    }
  }
  const consumers = new Map<string, string[]>();
  for (const entry of byName.values()) {
    if (entry.declaration.state === null) continue;
    const declared = posix.normalize(posix.join(declaration.directory, entry.declaration.state));
    // A declaration that resolves outside the repository names no path
    // in either sealed tree, so it can never be a changed candidate.
    if (!withinRepository(declared)) continue;
    const reached = new Set<string>([entry.declaration.name]);
    const queue = [entry.declaration.name];
    while (queue.length > 0) {
      const current = queue.shift() as string;
      for (const dependent of dependents.get(current) ?? []) {
        if (reached.has(dependent)) continue;
        reached.add(dependent);
        queue.push(dependent);
      }
    }
    const files = new Set<string>();
    for (const name of reached) {
      for (const file of byName.get(name)?.files ?? []) files.add(file);
    }
    const existing = consumers.get(declared) ?? [];
    for (const file of files) existing.push(file);
    consumers.set(declared, [...new Set(existing)].sort());
  }
  return { consumers, problem: null };
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
  runtimeFileGlobs?: readonly string[];
  parentCommitTreeId?: string;
  currentCommitTreeId?: string;
  /**
   * Repo-relative paths this run's input snapshot binds, or absent when
   * the caller holds no inventory. A declared browser state that IS an
   * input is authority, not output, so it can never be carried as a
   * generated-state change. Nothing else in the two sealed trees records
   * that membership, so it is not inferable from them: a recomputation
   * holding no inventory — the independent chain check reads no input
   * snapshot — decides such a path on trackedness, removal and file mode
   * alone, never on an assumed membership. The two sides can therefore
   * reach different verdicts for an input-bound state path, and each one
   * is the verdict its own evidence supports.
   */
  inputFiles?: ReadonlySet<string>;
}): ResealChangeClassification {
  const changed = diffSealedTrees(input.gitDir, input.env, input.parentTreeId, input.currentTreeId);
  const changedPaths = (changed ?? []).map((entry) => entry.path);
  // An undeclared repository gets no `disregardedPaths` key at all, so
  // the whole result object is the one it got before this feature.
  const declared = input.runtimeFileGlobs ?? [];
  const refuse = (reason: string, disregarded: string[] = []): ResealChangeClassification => ({
    eligible: false,
    reason: resealRefusal(reason),
    changedPaths,
    testFiles: [],
    helperFiles: [],
    affectedTestFiles: [],
    ...(declared.length > 0 ? { disregardedPaths: disregarded } : {}),
  });
  if (changed === null) {
    return refuse(
      `the sealed trees could not be diffed (${input.parentTreeId} → ${input.currentTreeId})`,
    );
  }
  // The GENERATED STATE the SEALED runner config declares (the standard
  // auth pattern's saved session above all), read from that config's own
  // syntax. A change in one of those paths is a change in the INPUTS of
  // the tests that consume it — never app code — so it is kept out of the
  // app/helper classification and instead demands exactly those consumers
  // re-execute. Deriving it here, from the sealed config bytes, is what
  // lets the sealing run and an independent consumer recompute the
  // identical affected set with no extra receipt field and no owner
  // declaration.
  //
  // A declaration the bytes COMPUTE is a refusal, not an empty list: a
  // guess about who reads a state file is precisely the guess that must
  // not be made, and an unreadable declaration that fell through to the
  // app-code branch would only hide that doubt behind a worse message.
  const stateGraph = generatedStateConsumers(
    input.gitDir,
    input.env,
    input.currentTreeId,
    input.testFiles,
  );
  // The two sealed COMMIT trees say which paths are TRACKED source. One
  // reading serves both decisions that need exactly that fact: an owner
  // declaration may hide only an untracked path, and a declared browser
  // state counts as generated output only when it is untracked too.
  // Without both commit trees neither decision can be made, so both fail
  // closed — an unreadable listing refuses, and an absent one classifies
  // nothing as ignorable and nothing as generated.
  let trackedness: { parent: Set<string>; current: Set<string> } | null = null;
  if (
    input.parentCommitTreeId !== undefined &&
    input.currentCommitTreeId !== undefined &&
    (declared.length > 0 || stateGraph.consumers.size > 0)
  ) {
    const parent = committedPaths(input.gitDir, input.env, input.parentCommitTreeId);
    const current = committedPaths(input.gitDir, input.env, input.currentCommitTreeId);
    if (parent === null || current === null) {
      return refuse(
        `the files tracked by the two sealed commits could not be read ` +
          `(${input.parentCommitTreeId}, ${input.currentCommitTreeId})`,
      );
    }
    trackedness = { parent, current };
  }
  const testFileSet = new Set(input.testFiles);
  // The owner may declare runtime state the run itself rewrites (a
  // witnessed login stage's storage state, a runner's own cache): the
  // bytes are gitignored workspace state, so EVERY sealed candidate
  // tree differs from the last one in them and no re-seal could ever
  // succeed without a declaration. It is an OWNER ASSERTION, so it is
  // deliberately narrow: a matching changed path is disregarded only
  // when it is absent from BOTH sealed commits, i.e. when it exists
  // solely as untracked/ignored workspace bytes, AND when the sealed
  // runner config does not itself speak for that path. A tracked path
  // never matches, whatever the glob reads. Without a declaration, or
  // without the two commit trees to check trackedness against, nothing
  // is disregarded (fail closed).
  //
  // PRECEDENCE: the sealed runner config outranks the owner assertion,
  // because a glob is a claim about bytes while a `use.storageState`
  // nomination is a claim about who READS them. A nominated target is
  // the input of the tests that consume it, so it must reach the
  // generated-state rules below — untracked, outside the input
  // inventory, an ordinary file, not a removal, every reader
  // re-executing — instead of being swallowed as ignorable runtime
  // bytes, which is exactly how a changed state would be carried as a
  // proven cache write. And when those declarations cannot be COMPUTED
  // no nomination can be named at all, so no raw non-test path may be
  // disregarded then either: the refusal below is the only place that
  // reports that doubt, and a glob must not hide it. Every other case
  // is unchanged, which is what an ordinary runtime cache relies on.
  let disregarded: string[] = [];
  if (declared.length > 0 && trackedness !== null) {
    const { parent, current } = trackedness;
    const matchers = declared.map((glob) => picomatch(glob, { dot: true }));
    disregarded = changed
      .filter(
        (entry) =>
          !stateGraph.consumers.has(entry.path) &&
          (stateGraph.problem === null || testFileSet.has(entry.path)) &&
          !parent.has(entry.path) &&
          !current.has(entry.path) &&
          matchers.some((matcher) => matcher(entry.path)),
      )
      .map((entry) => entry.path);
  }
  const ignored = new Set(disregarded);
  const changes = changed.filter((entry) => !ignored.has(entry.path));
  const classifiedPaths = changes.map((entry) => entry.path);
  if (changes.length === 0) {
    return refuse('the sealed trees are identical, so there is nothing to classify', disregarded);
  }
  const roots = testRoots(input.testFiles);
  // A sealed config whose declarations the bytes COMPUTE cannot say who
  // reads a declared state file. That is a refusal the moment the change
  // set holds a non-test path, because such a path may be exactly the
  // generated state — never a silent empty dependency set that would let
  // it through as app code nobody looked at.
  if (stateGraph.problem !== null) {
    const undecomposed = classifiedPaths.find((path) => !testFileSet.has(path));
    if (undecomposed !== undefined) {
      return refuse(`${stateGraph.problem}, so '${undecomposed}' cannot be shown to be test code`);
    }
  }
  // A declared state path is generated OUTPUT only when it is untracked
  // in both sealed commits, outside the input inventory, an ordinary file
  // in the sealed candidate and not a deletion. Anything else keeps the
  // ordinary app-code classification — which refuses it by name — so a
  // TRACKED app/config/source file can never escape that refusal merely
  // by being named in the runner config.
  const stateChanged: ChangedPath[] = [];
  const stateConsumers = new Map<string, string[]>();
  const stateConsumerFiles = new Set<string>();
  if (stateGraph.problem === null && trackedness !== null && stateGraph.consumers.size > 0) {
    const modes = sealedTreeModes(input.gitDir, input.env, input.currentTreeId);
    if (modes === null) {
      return refuse(`the sealed candidate tree's entry modes could not be read (${input.currentTreeId})`);
    }
    for (const entry of changes) {
      const consumers = stateGraph.consumers.get(entry.path);
      if (consumers === undefined) continue;
      const refusal = generatedStateRefusal(
        entry,
        modes.get(entry.path),
        trackedness.parent,
        trackedness.current,
        input.inputFiles ?? null,
      );
      if (refusal !== null) return refuse(refusal);
      stateChanged.push(entry);
      stateConsumers.set(entry.path, consumers);
      for (const file of consumers) stateConsumerFiles.add(file);
    }
  }
  const statePaths = new Set(stateConsumers.keys());
  const codeChanges = changes.filter((entry) => !statePaths.has(entry.path));
  const testFiles = codeChanges.filter((entry) => testFileSet.has(entry.path)).map((entry) => entry.path);
  // A deleted path is classified by the SAME catalog: a deleted test
  // file simply leaves the expected set, while a deleted anything-else is
  // app code by definition and its importers break at run time.
  for (const entry of codeChanges) {
    if (entry.status === 'D' && !testFileSet.has(entry.path)) {
      return refuse(`app file deleted: ${entry.path}`);
    }
  }
  const candidates = codeChanges.filter((entry) => !testFileSet.has(entry.path)).map((entry) => entry.path);
  // A changed path outside every test root is app code whatever the
  // import graph says, so it refuses first and by its own name: the
  // reason a user needs is "you changed app code", not a doubt about
  // some unrelated file's imports.
  const appFile = candidates.find((path) => !underTestRoot(path, roots));
  if (appFile !== undefined) return refuse(`app file changed: ${appFile}`);
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
    return refuse(`setup dependency tests cannot be resolved from the runner config for ${candidates[0]}`);
  } else {
    const setup = testFiles.find((file) => stage.files.includes(file));
    if (setup !== undefined) {
      return refuse(`setup test changed: ${setup}`);
    }
  }
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
  const pythonChanged = classifiedPaths.some((path) => extname(path) === '.py');
  const scriptChanged = classifiedPaths.some((path) => extname(path) !== '.py');
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
  const importsOf = new Map<string, string[][]>();
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
    importsOf.set(file.path, resolved);
    for (const candidates of resolved) {
      for (const target of candidates) {
        const importers = importersOf.get(target);
        if (importers === undefined) importersOf.set(target, [file.path]);
        else if (!importers.includes(file.path)) importers.push(file.path);
      }
    }
  }
  // Directory membership alone does not make an application importer
  // test code. Each importer must also lead to a cataloged test.
  const testCode = new Set(testFileSet);
  const pendingTestCode = [...testFileSet];
  for (let index = 0; index < pendingTestCode.length; index += 1) {
    for (const candidates of importsOf.get(pendingTestCode[index] as string) ?? []) {
      for (const target of candidates) {
        if (!importsOf.has(target) || testCode.has(target)) continue;
        testCode.add(target);
        pendingTestCode.push(target);
      }
    }
  }
  const helperFiles: string[] = [];
  const affected = new Set(testFiles);
  // A DEPENDENCY project's tests run BEFORE the dependents in every
  // supervised run (the `dependencies` edge the enumeration captured),
  // so a dependent change re-executes the whole stage. The affected set
  // must say so: the chain recomputation (reseal-chain) re-derives this
  // same set from the same two trees and refuses a fresh outcome
  // outside it, so omitting the stage makes the run re-execute a test
  // its own receipt then rejects as EVIDENCE_STALE. Only files a
  // declared `dependencies` project owns are added — a
  // convention-named setup file is never re-executed, so naming it
  // would demand an outcome that never arrives. An UNRESOLVED stage
  // adds nothing: the refusal above already failed this change set
  // closed, and a stage we cannot read must not be guessed at.
  if (!stage.unresolved) {
    for (const file of stage.dependencyFiles) affected.add(file);
  }
  // A changed declared-state path demands exactly its consumers: the test
  // files whose own project reads it, plus every project ordered after it
  // (its upstream prerequisites, which produce the state, are already in
  // the dependency stage above). The consumers SEED the importer closure
  // below rather than only joining its result: a consumer that other
  // specs reach through a shared fixture must drag those importers with
  // it, or the run would carry proof for specs whose browser state
  // changed underneath them. A changed state target with NO consumer this
  // run can name is a refusal, not a silent pass: the bytes that changed
  // would otherwise reach a body nobody re-ran.
  for (const entry of stateChanged) {
    const consumers = stateConsumers.get(entry.path) ?? [];
    if (consumers.length === 0) {
      return refuse(
        `generated state changed: ${entry.path} has no consumer this run can name from the sealed runner ` +
          'config, so nothing proves which test reads it (fail closed)',
      );
    }
    for (const file of consumers) affected.add(file);
  }
  for (const path of [...new Set([...testFiles, ...candidates, ...stateConsumerFiles])]) {
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
        else if (!underTestRoot(file, roots) || !testCode.has(file)) {
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
    ...(declared.length > 0 ? { disregardedPaths: disregarded } : {}),
  };
}
