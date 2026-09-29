/**
 * Test-only change classification (plan phases 1-2): Gateforge never
 * takes the candidate's word for what changed. It computes the change
 * set itself from the two SEALED candidate trees (the parent receipt's
 * `candidateTreeId` and the tree this run froze), classifies every
 * changed path from the runner's OWN test catalog plus the repository's
 * own import graph, and fails closed on any doubt.
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
}

/** One `compilerOptions.paths` alias from the repository tsconfig. */
interface PathAlias {
  /** Alias prefix without the trailing wildcard. */
  prefix: string;
  /** Repository-relative directory the wildcard tail resolves against. */
  target: string;
}

function run(gitDir: string, env: NodeJS.ProcessEnv, args: readonly string[], input?: string): string | null {
  const result = spawnSync('git', ['--git-dir', gitDir, '--no-replace-objects', ...args], {
    env: sanitizedAuthorityEnv(env),
    encoding: 'utf8',
    ...(input !== undefined ? { input } : {}),
    maxBuffer: 256 * 1024 * 1024,
  });
  if (result.error !== undefined) {
    throw new UsageError(`re-seal change classification: cannot run git: ${(result.error as Error).message}`);
  }
  if (result.status !== 0) return null;
  return result.stdout;
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

/** One regex per static import form (TS/JS first, then Python). */
const STATIC_IMPORT_PATTERNS: readonly RegExp[] = [
  /(?:^|[\s;])import\s+(?:[^'"()]*?\s+from\s+)?['"]([^'"]+)['"]/g,
  /(?:^|[\s;])export\s+(?:[^'"()]*?\s+from\s+)?['"]([^'"]+)['"]/g,
  /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  /^\s*import\s+([\w.]+)\s*(?:$|#)/gm,
  /^\s*from\s+([\w.]+)\s+import\b/gm,
  /^\s*from\s+(\.[\w.]*)\s+import\b/gm,
];
const DYNAMIC_IMPORT_PATTERNS: readonly RegExp[] = [
  /\bimport\s*\(/,
  /\brequire\s*\(\s*(?!['"])/,
  /\bimportlib\.import_module\s*\(/,
  /\b__import__\s*\(/,
];

/** Parses one file's import statements out of its bytes. */
function parseTrackedFile(path: string, source: string): TrackedFile {
  const imports: ImportRef[] = [];
  const patterns = extname(path) === '.py' ? STATIC_IMPORT_PATTERNS.slice(3) : STATIC_IMPORT_PATTERNS.slice(0, 3);
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      if (match[1] !== undefined) imports.push({ specifier: match[1] });
    }
  }
  return { path, imports, dynamic: DYNAMIC_IMPORT_PATTERNS.some((pattern) => pattern.test(source)) };
}

/**
 * Extracts one blob's bytes from a `git cat-file --batch` transcript.
 * An absent record yields an empty string, which the import scan reads
 * as "this file declares nothing" — never as a clean file.
 */
function batchBlob(batch: string, sha: string): string {
  const header = `${sha} blob `;
  // The search lands on the record separator, so a later record's
  // header begins one byte after it; the first record has none.
  const separator = batch.startsWith(header) ? -1 : batch.indexOf(`\n${header}`);
  if (separator === -1 && !batch.startsWith(header)) return '';
  const starts = separator + 1;
  const headerEnd = batch.indexOf('\n', starts);
  if (headerEnd < 0) return '';
  const size = Number.parseInt(batch.slice(starts + header.length, headerEnd).trim(), 10);
  if (!Number.isFinite(size)) return '';
  return batch.slice(headerEnd + 1, headerEnd + 1 + size);
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
  const batch = run(gitDir, env, ['cat-file', '--batch'], `${entries.map((entry) => entry.sha).join('\n')}\n`);
  if (batch === null) return null;
  return entries
    .map((entry) => parseTrackedFile(entry.path, batchBlob(batch, entry.sha)))
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
    reason,
    changedPaths,
    testFiles: [],
    helperFiles: [],
    affectedTestFiles: [],
  });
  if (changed === null) {
    return refuse(
      `the sealed trees could not be diffed (${input.parentTreeId} → ${input.currentTreeId}) → full run`,
    );
  }
  if (changed.length === 0) {
    return refuse('the sealed trees are identical, so there is nothing to classify → full run');
  }
  const testFileSet = new Set(input.testFiles);
  const roots = testRoots(input.testFiles);
  const testFiles = changed.filter((entry) => testFileSet.has(entry.path)).map((entry) => entry.path);
  // A deleted path is classified by the SAME catalog: a deleted test
  // file simply leaves the expected set, while a deleted anything-else is
  // app code by definition and its importers break at run time.
  for (const entry of changed) {
    if (entry.status === 'D' && !testFileSet.has(entry.path)) {
      return refuse(`app file deleted: ${entry.path} → full run`);
    }
  }
  const candidates = changed.filter((entry) => !testFileSet.has(entry.path)).map((entry) => entry.path);
  // The import graph is consulted for EVERY change set, not only for a
  // helper claim: a spec file can export a shared fixture or a
  // `test.extend`, so a changed test file affects its importers too.
  // Any doubt the graph cannot resolve refuses the whole re-seal.
  const sources = trackedSources(input.gitDir, input.env, input.currentTreeId);
  if (sources === null) {
    return refuse(`the sealed tree's import graph could not be read (${input.currentTreeId}) → full run`);
  }
  const dynamicFile = sources.find((file) => file.dynamic);
  if (dynamicFile !== undefined) {
    return refuse(
      `unresolvable import: ${dynamicFile.path} loads a module through a computed specifier → full run`,
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
        `unresolvable import: ${file.path} → ${unresolvable?.specifier ?? '?'} → full run`,
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
    if (!isTestFile && !underTestRoot(path, roots)) {
      return refuse(`app file changed: ${path} → full run`);
    }
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
            `app file changed: ${file} imports the changed ${isTestFile ? 'test file' : 'test helper'} ${path} → full run`,
          );
        } else queue.push(file);
      }
    }
    if (!isTestFile && seen.size === 0) {
      return refuse(`app file changed: ${path} is imported by no test file, so it is not a test helper → full run`);
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
