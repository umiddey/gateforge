/**
 * Native Playwright reconciliation (plan 2026-09-13 phase 2 item 4):
 * enumerates the consumer's tests through the INSTALLED Playwright's
 * official list mode (`playwright test --list --reporter=json`) and
 * reconciles the result with the static scan.
 *
 * TRUST BOUNDARY (plan §3.3, phase 2 item 4): `--list` loads the
 * consumer's playwright config and test modules as UNTRUSTED code —
 * they execute in a child process. This module therefore:
 * - strips every `GATEFORGE_*` variable from the scrubbed child
 *   environment, then sets only an isolated, secret-free temporary
 *   `GATEFORGE_STATE_DIR`;
 * - gives wired comparison listings only the safe run-variable allowlist
 *   actually exposed to runner children;
 * - removes temporary state after scrubbed enumeration;
 * - enforces a finite timeout (the child is killed; a timeout is a
 *   typed failure, never a hang or an empty inventory);
 * - treats a failed invocation as a typed error (CLI exit 2), while
 *   parseable reporter output (even alongside reporter `errors`, e.g.
 *   "No tests found") is DATA for the catalog.
 *
 * Where no playwright config exists, reconciliation is reported
 * unavailable — that is not an error for non-playwright repositories.
 *
 * Subdirectory projects are first-class (monorepo/subdirectory layout):
 * a consumer may keep playwright self-contained in ONE subdirectory
 * (`e2e/` with its own `playwright.config.ts` and its own
 * `node_modules/playwright`, possibly at a different version than the
 * repo root). Enumeration therefore runs the way the OWNER runs it —
 * from the config's directory, with the CLI found in THAT directory —
 * because a root-level shim config that re-exports the nested config
 * would load the nested @playwright/test through the ROOT install and
 * die on the two-versions-of-@playwright/test conflict.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { buildRunnerChildEnv } from './runner-env.js';
import { CLAIM_ANNOTATION_TYPE } from '../constants.js';
import type { Location } from '@gate-forge/core';

/** Config file names checked at the repo root and one level deep
 * (first match wins within each directory). */
const PLAYWRIGHT_CONFIG_NAMES = [
  'playwright.config.ts',
  'playwright.config.mts',
  'playwright.config.cts',
  'playwright.config.js',
  'playwright.config.mjs',
  'playwright.config.cjs',
] as const;

/** Directory names never searched for a nested playwright config
 * (dependency trees, build output, VCS state, runner artifacts). */
const CONFIG_SEARCH_PRUNED_DIRS: ReadonlySet<string> = new Set([
  'node_modules',
  'dist',
  '.git',
  'test-results',
  'coverage',
  'build',
]);

/** Default wall-clock bound for one `--list` invocation. */
export const DEFAULT_LIST_TIMEOUT_MS = 60_000;

/** Typed discovery failure: a playwright invocation that could not run
 * or produce parseable output (CLI maps this to exit 2). */
export class TestDiscoveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TestDiscoveryError';
  }
}

/** One test instance the native runner enumerated. */
export interface NativeInstance {
  /** Repo-root-relative posix file path. */
  file: string;
  /** Describe stack + title (no file segment). */
  titlePath: string[];
  /** Last segment of {@link titlePath}. */
  title: string;
  /** Runner project name, e.g. `chromium`. */
  project: string;
  /** The framework's instance id (spec id + project id). */
  frameworkId: string;
  /** Source line/column of the test call (diagnostics). */
  location: Location;
  /** Native expected status (`passed`/`skipped`). */
  expectedStatus: string;
  /** Native annotation types on the instance (e.g. `skip`, `fixme`). */
  annotations: string[];
  /** Current `{type: 'gateforge'}` annotation descriptions. */
  claims: string[];
}

/** Outcome of one native list run. */
export interface NativeListResult {
  /** `discovered` when instances were enumerated, else `unavailable`. */
  status: 'discovered' | 'unavailable';
  /** Single-cause human detail (why unavailable / what ran). */
  detail: string;
  /** Enumerated instances (empty when unavailable). */
  instances: NativeInstance[];
  /** Reporter errors from the JSON document (data, not a throw). */
  errors: string[];
}

/**
 * The playwright CLI of the repo being scanned, else the pack's own.
 * Resolution order (consumer-first, subdirectory-first): the CONFIG
 * DIRECTORY's own install (a subdirectory project pins the playwright
 * version its config and specs load through — running any other version
 * against it dies with the two-versions-of-@playwright/test conflict),
 * then the repo root's, then the pack's own.
 *
 * Args:
 *   cwd: absolute repo root.
 *   configDir: config directory repo-relative (`'.'` for root-level).
 */
function playwrightCliPath(cwd: string, configDir: string): string {
  // CONSUMER-FIRST resolution: a consumer repo pins its own
  // playwright/@playwright/test version (its config and specs load
  // through it). Running the pack's CLI against a consumer whose local
  // version differs dies with the two-versions-of-@playwright/test
  // conflict — so the scanned repo's own CLI wins when present
  // (consumer migration, E22). The pack's CLI remains the fallback
  // (fixture repos symlink the monorepo node_modules, so they resolve
  // to the same bytes either way).
  const searchRoots = configDir !== '.' ? [join(cwd, configDir), cwd] : [cwd];
  for (const searchRoot of searchRoots) {
    for (const candidate of localPlaywrightCliCandidates(searchRoot)) {
      if (existsSync(candidate)) return candidate;
    }
  }
  const require = createRequire(import.meta.url);
  const pkgJson = require.resolve('playwright/package.json');
  const cli = join(dirname(pkgJson), 'cli.js');
  if (!existsSync(cli)) {
    throw new TestDiscoveryError(`playwright CLI not found at '${cli}' (pack dependency broken)`);
  }
  return cli;
}

/** The scanned repo's local playwright CLI locations, in preference order. */
export function localPlaywrightCliCandidates(cwd: string): string[] {
  return [
    join(cwd, 'node_modules', 'playwright', 'cli.js'),
    join(cwd, 'node_modules', '@playwright', 'test', 'cli.js'),
  ];
}

/**
 * Strips every `GATEFORGE_*` variable from the environment for UNTRUSTED
 * child runs, then adds only a caller-owned temporary state directory.
 *
 * Args:
 *   env: the parent environment.
 *   discoveryStateDir: empty temporary directory used only to register
 *     supervised tests; it never contains verifier keys or run tokens.
 *
 * Returns:
 *   NodeJS.ProcessEnv: a copy without caller `GATEFORGE_*` values except
 *   the supplied isolated state directory.
 */
export function untrustedEnv(env: NodeJS.ProcessEnv, discoveryStateDir?: string): NodeJS.ProcessEnv {
  const child: NodeJS.ProcessEnv = { ...env };
  for (const key of Object.keys(child)) {
    if (key.startsWith('GATEFORGE_')) delete child[key];
  }
  if (discoveryStateDir !== undefined) child['GATEFORGE_STATE_DIR'] = discoveryStateDir;
  return child;
}

/**
 * Finds the consumer's playwright config: at the repo root first, then —
 * only when no root-level config exists — ONE directory level deep
 * (immediate subdirectories, dependency/build/VCS/runner directories
 * pruned), alphabetically first match. Returns the repo-relative posix
 * path (`'playwright.config.ts'`, or `'e2e/playwright.config.ts'` for a
 * subdirectory project), or null when none exists.
 *
 * Root-level configs always win: an existing root project must keep its
 * exact historical invocation. The nested search only extends discovery
 * to the self-contained subdirectory layout (the config's OWN directory
 * pins its playwright install — see {@link playwrightCliPath}).
 *
 * Args:
 *   cwd: absolute repo root.
 *
 * Returns:
 *   string | null: repo-relative posix config path, or null.
 */
export function findPlaywrightConfig(cwd: string): string | null {
  for (const name of PLAYWRIGHT_CONFIG_NAMES) {
    const path = join(cwd, name);
    if (existsSync(path)) return name;
  }
  let names: string[];
  try {
    names = readdirSync(cwd);
  } catch {
    return null; // unreadable root: the root-level search already came up empty
  }
  const subdirs = names
    .filter((name) => !CONFIG_SEARCH_PRUNED_DIRS.has(name))
    .filter((name) => {
      try {
        return statSync(join(cwd, name)).isDirectory();
      } catch {
        return false; // unreadable entry: invisible, never a search failure
      }
    })
    .sort();
  for (const dir of subdirs) {
    for (const name of PLAYWRIGHT_CONFIG_NAMES) {
      if (existsSync(join(cwd, dir, name))) return `${dir}/${name}`;
    }
  }
  return null;
}

/** Minimal JSON-reporter suite node shape (fields discovery consumes). */
interface ReporterSuite {
  title?: string;
  file?: string;
  suites?: ReporterSuite[];
  specs?: ReporterSpec[];
}

/** Minimal JSON-reporter spec/test node shape. */
interface ReporterSpec {
  title?: string;
  id?: string;
  file?: string;
  line?: number;
  column?: number;
  tests?: Array<{
    projectId?: string;
    projectName?: string;
    expectedStatus?: string;
    annotations?: Array<{ type?: string; description?: string }>;
  }>;
}
/** Minimal parsed JSON-reporter document shape. */
interface ReporterDocument {
  config?: { rootDir?: string };
  suites?: ReporterSuite[];
  errors?: Array<{ message?: string }>;
}

/** Converts an absolute path to repo-root-relative posix form. */
function toRepoRelative(cwd: string, path: string): string {
  const rel = relative(cwd, resolve(cwd, path));
  return rel.split('\\').join('/');
}

/**
 * Enumerates the consumer's playwright tests via official list mode.
 * See the module doc for the trust boundary. The CLI is the consumer's
 * own when present (the config directory's first — see
 * {@link playwrightCliPath}); the engine's own pinned playwright (pack
 * dependency, 1.58.2) is the fallback — no network, no npx resolution
 * from the consumer.
 *
 * The child runs from the CONFIG'S directory (the way the owner runs
 * it): a subdirectory project's config and specs load through THAT
 * directory's node_modules, with `--config` naming the config as seen
 * from that cwd. Root-level projects keep the exact historical
 * invocation (repo-root cwd, auto-discovered config, no `--config`).
 *
 * Args:
 *   options: `cwd` (absolute repo root), optional `timeoutMs`, and
 *     optional allowlisted wired-runner variables for registration comparison.
 *
 * Returns:
 *   Promise<NativeListResult>: enumerated instances, reporter errors,
 *   and an unavailable verdict when no playwright config exists.
 *
 * Throws:
 *   TestDiscoveryError: when the child cannot spawn, exceeds the
 *   timeout, or produced no readable reporter JSON (the report is read
 *   from the reporter's own output file, never from stdout).
 */
export async function listNativePlaywrightTests(options: {
  cwd: string;
  timeoutMs?: number;
  wiredEnv?: Readonly<Record<string, string>>;
}): Promise<NativeListResult> {
  const configPath = findPlaywrightConfig(options.cwd);
  if (configPath === null) {
    return {
      status: 'unavailable',
      detail: 'reconciliation: unavailable — no playwright config (not an error for non-playwright repos)',
      instances: [],
      errors: [],
    };
  }
  // The config directory, repo-relative ('.' for a root-level config).
  const configDir = dirname(configPath);
  const childCwd = join(options.cwd, configDir);
  const timeoutMs = options.timeoutMs ?? DEFAULT_LIST_TIMEOUT_MS;
  const cli = playwrightCliPath(options.cwd, configDir);
  const args = [cli, 'test', '--list', '--reporter=json'];
  if (configDir !== '.') args.push('--config', basename(configPath));
  const discoveryStateDir =
    options.wiredEnv === undefined ? mkdtempSync(join(tmpdir(), 'gateforge-discovery-state-')) : undefined;
  // The JSON report is read from a FILE the runner writes, never from
  // stdout: a consumer's playwright config routinely prints at load
  // time (a dotenv/dotenvx banner, a stray `console.log`) and stdout is
  // the runner's own channel, not a document channel (install
  // rehearsal F6). The path is absolute, so the reporter's
  // cwd-relative resolution cannot move it, and the JSON reporter's
  // `printsToStdio()` turns false — no part of the report can
  // interleave with the config's logging.
  const reportDir = mkdtempSync(join(tmpdir(), 'gateforge-playwright-report-'));
  const reportPath = join(reportDir, 'reporter.json');
  let outcome: { code: number | null; stdout: string; stderr: string; timedOut: boolean; error: Error | null };
  let reportText: string | null = null;
  try {
    const childEnv: NodeJS.ProcessEnv =
      options.wiredEnv === undefined
        ? untrustedEnv(process.env, discoveryStateDir)
        : buildRunnerChildEnv(options.wiredEnv, process.env);
    childEnv['PLAYWRIGHT_JSON_OUTPUT_FILE'] = reportPath;
    const child = spawn(process.execPath, args, {
      cwd: childCwd,
      env: childEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    outcome = await new Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean; error: Error | null }>(
      (settle) => {
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      let settled = false;
      const finish = (result: { code: number | null; stdout: string; stderr: string; timedOut: boolean; error: Error | null }): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        settle(result);
      };
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, timeoutMs);
      child.stdout?.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8');
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
      });
      child.once('error', (error) => {
        finish({ code: null, stdout, stderr, timedOut: false, error });
      });
      // `exit` only means the process ended. The piped stdout/stderr streams
      // can still contain reporter bytes, so parse only after `close`.
      child.once('close', (code) => {
        finish({ code, stdout, stderr, timedOut, error: null });
      });
    },
  );
    try {
      reportText = readFileSync(reportPath, 'utf8');
    } catch {
      // A runner that never reached the reporter (or one whose version
      // predates its output-file support) leaves no file. The whole
      // captured stream is then the only candidate, and it is read as
      // one document — never scanned for a plausible-looking substring.
      reportText = outcome.stdout;
    }
  } finally {
    if (discoveryStateDir !== undefined) rmSync(discoveryStateDir, { recursive: true, force: true });
    rmSync(reportDir, { recursive: true, force: true });
  }
  if (outcome.error !== null) {
    throw new TestDiscoveryError(`playwright --list failed to run: ${outcome.error.message}`);
  }
  if (outcome.timedOut) {
    throw new TestDiscoveryError(
      `playwright --list exceeded its ${String(timeoutMs)}ms timeout and was killed (fail closed — never an empty inventory)`,
    );
  }
  let document: ReporterDocument;
  try {
    document = JSON.parse(reportText ?? '') as ReporterDocument;
  } catch {
    throw new TestDiscoveryError(
      `playwright --list produced no readable reporter JSON (exit ${String(outcome.code)}). The report ` +
        "is read from the reporter's own output file, so a config that logs to stdout no longer corrupts " +
        'it — this means the run never reached the reporter. Runner output: ' +
        `${(outcome.stderr || outcome.stdout).slice(0, 400)}`,
    );
  }
  // The runner reports files relative to ITS rootDir — the config
  // directory's rootDir when the document omits one. Resolve against the
  // CHILD's cwd (the config directory), then normalize to repo-relative:
  // a subdirectory project's enumerated files ('scenarios/x.spec.ts'
  // from that project's view) must carry the config-directory prefix
  // ('e2e/scenarios/x.spec.ts') to reconcile against the static scan's
  // repo-relative rows.
  const rootDir = document.config?.rootDir !== undefined ? resolve(childCwd, document.config.rootDir) : childCwd;
  const instances: NativeInstance[] = [];
  const walkSuites = (suites: ReporterSuite[], describeStack: string[], file: string | null): void => {
    for (const suite of suites) {
      // Top-level suites carry the file; deeper suites are describes.
      const suiteFile = suite.file !== undefined ? suite.file : file;
      const isFileSuite = file === null && suite.file !== undefined;
      // Titles accumulate only BELOW the file suite (describes). Suites
      // ABOVE it are runner-structural (the unnamed root and the project
      // suite — title '' for an unnamed project): their names are not
      // part of the test identity, and leaking them (newer reporter
      // nestings) broke reconciliation against the static scan.
      const stack = isFileSuite || file === null ? describeStack : [...describeStack, suite.title ?? ''];
      for (const spec of suite.specs ?? []) {
        if (spec.title === undefined || suiteFile === null) continue;
        for (const test of spec.tests ?? []) {
          const project = test.projectName ?? '';
          instances.push({
            file: toRepoRelative(options.cwd, isAbsolute(suiteFile) ? suiteFile : join(rootDir, suiteFile)),
            titlePath: [...stack, spec.title],
            title: spec.title,
            project,
            frameworkId: `${spec.id ?? 'unknown'}#${test.projectId ?? project}`,
            location: {
              file: toRepoRelative(options.cwd, isAbsolute(suiteFile) ? suiteFile : join(rootDir, suiteFile)),
              line: spec.line ?? 0,
              col: spec.column ?? 0,
            },
            expectedStatus: test.expectedStatus ?? 'unknown',
            annotations: (test.annotations ?? []).map((annotation) => annotation.type ?? '').filter((type) => type.length > 0),
            claims: [...new Set(
              (test.annotations ?? [])
                .filter((annotation) => annotation.type === CLAIM_ANNOTATION_TYPE)
                .map((annotation) => annotation.description ?? '')
                .filter((description) => description.length > 0),
            )],
          });
        }
      }
      walkSuites(suite.suites ?? [], stack, suiteFile);
    }
  };
  walkSuites(document.suites ?? [], [], null);
  const errors = (document.errors ?? []).map((error) => error.message ?? String(error));
  const configDetail = configDir !== '.' ? ` (cwd '${configDir}')` : '';
  const envDetail =
    options.wiredEnv === undefined
      ? 'isolated temporary GATEFORGE_STATE_DIR'
      : 'allowlisted wired runner variables';
  return {
    status: 'discovered',
    detail:
      `native playwright --list over '${configPath}'${configDetail} enumerated ${String(instances.length)} ` +
      `instance(s) as untrusted code (${envDetail})`,
    instances,
    errors,
  };
}

/**
 * Finds registration instances present in only one environment's native
 * Playwright listing, treating project and duplicate instances as identity.
 *
 * Args:
 *   scrubbed: native instances enumerated without run wiring.
 *   wired: native instances enumerated with the runner's safe run variables.
 *
 * Returns:
 *   An object containing project-qualified instances unique to each listing.
 */
export function diffNativePlaywrightTests(
  scrubbed: readonly NativeInstance[],
  wired: readonly NativeInstance[],
): { scrubbedOnly: NativeInstance[]; wiredOnly: NativeInstance[] } {
  /**
   * Builds the project-qualified matching identity for one instance.
   *
   * Args:
   *   instance: native test instance.
   *
   * Returns:
   *   string: serialized file, title path, and project tuple.
   */
  const keyOf = (instance: NativeInstance): string =>
    JSON.stringify([instance.file, instance.titlePath, instance.project]);
  const wiredCounts = new Map<string, number>();
  for (const instance of wired) {
    const key = keyOf(instance);
    wiredCounts.set(key, (wiredCounts.get(key) ?? 0) + 1);
  }
  const matchedCounts = new Map<string, number>();
  const scrubbedOnly: NativeInstance[] = [];
  for (const instance of scrubbed) {
    const key = keyOf(instance);
    const matched = matchedCounts.get(key) ?? 0;
    if (matched < (wiredCounts.get(key) ?? 0)) {
      matchedCounts.set(key, matched + 1);
    } else {
      scrubbedOnly.push(instance);
    }
  }
  const wiredOnly: NativeInstance[] = [];
  const emittedCounts = new Map<string, number>();
  for (const instance of wired) {
    const key = keyOf(instance);
    const emitted = emittedCounts.get(key) ?? 0;
    if (emitted < (matchedCounts.get(key) ?? 0)) {
      emittedCounts.set(key, emitted + 1);
    } else {
      wiredOnly.push(instance);
    }
  }
  /**
   * Sorts instances deterministically by file, project, and title path.
   *
   * Args:
   *   left: first native test instance.
   *   right: second native test instance.
   *
   * Returns:
   *   number: standard array comparator result.
   */
  const compare = (left: NativeInstance, right: NativeInstance): number => {
    const byFile = left.file < right.file ? -1 : left.file > right.file ? 1 : 0;
    if (byFile !== 0) return byFile;
    const byProject = left.project < right.project ? -1 : left.project > right.project ? 1 : 0;
    if (byProject !== 0) return byProject;
    const leftTitlePath = left.titlePath.join('>');
    const rightTitlePath = right.titlePath.join('>');
    return leftTitlePath < rightTitlePath ? -1 : leftTitlePath > rightTitlePath ? 1 : 0;
  };
  return {
    scrubbedOnly: scrubbedOnly.sort(compare),
    wiredOnly: wiredOnly.sort(compare),
  };
}

/** Matching key for reconciliation: file + full title path (no project). */
export function reconciliationKey(file: string, titlePath: readonly string[]): string {
  return `${file}#${titlePath.join('>')}`;
}

/**
 * Flattens a junit-style pytest node id into (file, titlePath): the part
 * before the first `::` is the file, the remaining segments the path.
 *
 * Args:
 *   nodeId: pytest node id, e.g. `tests/test_x.py::TestA::test_b[param]`.
 *
 * Returns:
 *   { file, titlePath }: posix file + class/test title path.
 */
export function splitPytestNodeId(nodeId: string): { file: string; titlePath: string[] } {
  const segments = nodeId.split('::');
  const file = (segments[0] ?? nodeId).split('\\').join('/');
  const titlePath = segments.slice(1);
  return { file, titlePath: titlePath.length > 0 ? titlePath : [basename(file)] };
}

/**
 * sha256 hex of one file's bytes (the catalog `sourceDigest`), or null
 * when the file cannot be read — callers turn that into an unresolved
 * row instead of a fabricated digest.
 *
 * Args:
 *   cwd: absolute repo root.
 *   file: repo-relative posix path.
 *
 * Returns:
 *   string | null: 64-char lowercase hex digest, or null when unreadable.
 */
export function fileDigest(cwd: string, file: string): string | null {
  try {
    return createHash('sha256').update(readFileSync(join(cwd, file))).digest('hex');
  } catch {
    return null;
  }
}
