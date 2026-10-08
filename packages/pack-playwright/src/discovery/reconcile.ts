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
import { fileURLToPath } from 'node:url';

import { buildRunnerChildEnv } from './runner-env.js';
import { CLAIM_ANNOTATION_TYPE, ENV_PLAYWRIGHT_CONFIG_DIR } from '../constants.js';
import { localPlaywrightCliCandidates } from '../runner-resolution.js';
import { CONFIG_SEARCH_PRUNED_DIRS, PLAYWRIGHT_CONFIG_NAMES } from './config-locations.js';
import type { Location } from '@gate-forge/core';
import {
  PROJECT_GRAPH_PATH_ENV,
  type ProjectGraphDocument,
  type ProjectTestFileScope,
} from '../reporter/project-graph-reporter.js';

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
  /**
   * Project name → the names it depends on, as the RUNNER resolved them
   * (see {@link projectGraphReporterEntry}). Absent when the enumeration
   * could not read the graph — never guessed, and never a partial graph
   * treated as a complete one.
   */
  projectDependencies?: Record<string, string[]>;
  /**
   * Project name → the `use.storageState` STRING the runner resolved for
   * it (the standard auth pattern's declared state file). Absent when no
   * project declares one, and absent together with
   * {@link projectDependencies} whenever the graph itself was unreadable.
   */
  projectStorageStates?: Record<string, string>;
  /**
   * Per project, the runner's OWN resolved test-file selection
   * (`testDir`/`testMatch`/`testIgnore`) as the enumeration read it.
   * Absent when the document carried none or could not be read: absence
   * means "the runner's selection is unknown", never "it collects
   * nothing".
   */
  testFileScope?: ProjectTestFileScope[];
  /**
   * Project name → the RESOLVED `use.browserName` the runner will run
   * that project with (devices already merged by the runner itself; see
   * {@link projectGraphReporterEntry}). Absent when the document carried
   * none or could not be read: absence means "the browser is
   * undetermined", and every browser-dependent rule fails closed.
   */
  projectBrowsers?: Record<string, string>;
  /**
   * The runner-resolved project NAMES, as the json reporter
   * rebuilt `config.projects[]` (an unnamed project — the
   * implicit one a config with no `projects` array gets, or a
   * declared project without a `name` — reports ''). Absent
   * when the report carried no `config.projects` section
   * (an older reporter): absence never triggers the
   * no-named-project verdict.
   */
  projectNames?: string[];
  /**
   * Project name → the per-test timeout (ms) the RUNNER resolved for it,
   * as the json reporter rebuilt `config.projects[].timeout` (data, never
   * the consumer config). Only finite positive numbers are kept: `0`
   * (Playwright's "no timeout"), negatives and non-numbers are absence.
   * Absent when no project reported a usable timeout. Playwright reports
   * its own 30 s default for a project that declared none, so a consumer
   * of this field must treat it as a floor-able value (see
   * `effectiveProjectTimeoutMs`), not as proof of a declaration.
   */
  projectTimeouts?: Record<string, number>;
}

/**
 * Resolves the engine-owned project-graph reporter entry.
 *
 * Absolute and pack-relative for the same reason the trusted reporter
 * entry is: the enumeration child must load an ENGINE file by absolute
 * path, never a candidate-relative one. Resolution works from both the
 * `src/` and `dist/` layouts.
 *
 * @param fromModule: module URL to resolve the pack from (default: this file).
 *
 * @returns
 *   string: absolute `<pack>/dist/reporter/project-graph-reporter.js`.
 */
export function projectGraphReporterEntry(fromModule: string = import.meta.url): string {
  const pkgPath = fileURLToPath(new URL('../../package.json', fromModule));
  return join(pkgPath.slice(0, -'package.json'.length), 'dist', 'reporter', 'project-graph-reporter.js');
}

/**
 * The playwright CLI of the repo being scanned, else the pack's own.
 * Resolution order (consumer-first, nearest-first): the CONFIG
 * DIRECTORY's own install and then every directory above it (a
 * subdirectory project pins the playwright version its config and
 * specs load through — running any other version against it dies with
 * the two-versions-of-@playwright/test conflict), and within each
 * directory the `@playwright/test` CLI before the bare `playwright`
 * one (see {@link localPlaywrightCliCandidates}).
 *
 * Args:
 *   cwd: absolute repo root.
 *   configDir: config directory repo-relative (`'.'` for root-level).
 *
 * Returns:
 *   string: absolute path of the CLI to invoke.
 *
 * Throws:
 *   TestDiscoveryError: when neither the repo's own nor the pack's CLI
 *   exists (a broken pack dependency, never a silent fallback).
 */
function playwrightCliPath(cwd: string, configDir: string): string {
  // CONSUMER-FIRST resolution: a consumer repo pins its own
  // playwright/@playwright/test version (its config and specs load
  // through it). Running the pack's CLI against a consumer whose local
  // version differs dies with the two-versions-of-@playwright/test
  // conflict — so the scanned repo's own CLI wins when present
  // (consumer migration, E22; install rehearsal F7). The pack's CLI
  // remains the fallback (fixture repos symlink the monorepo
  // node_modules, so they resolve to the same bytes either way).
  for (const candidate of localPlaywrightCliCandidates(join(cwd, configDir))) {
    if (existsSync(candidate)) return candidate;
  }
  const require = createRequire(import.meta.url);
  const pkgJson = require.resolve('playwright/package.json');
  const cli = join(dirname(pkgJson), 'cli.js');
  if (!existsSync(cli)) {
    throw new TestDiscoveryError(`playwright CLI not found at '${cli}' (pack dependency broken)`);
  }
  return cli;
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
 * Enumerates EVERY playwright config the search space contains, in the
 * order the choice is made: repo-root configs first (in
 * {@link PLAYWRIGHT_CONFIG_NAMES} order), then ONE directory level
 * deep (immediate subdirectories, dependency/build/VCS/runner
 * directories pruned, alphabetically).
 *
 * Enumeration runs exactly one config, so a repo with several configs
 * is inventoried as a subset. Listing them all is what lets that
 * narrowing be reported instead of silent — see
 * {@link findPlaywrightConfig}.
 *
 * Args:
 *   cwd: absolute repo root.
 *
 * Returns:
 *   string[]: repo-relative posix config paths, in choice order.
 */
export function findPlaywrightConfigs(cwd: string): string[] {
  const found: string[] = [];
  for (const name of PLAYWRIGHT_CONFIG_NAMES) {
    if (existsSync(join(cwd, name))) found.push(name);
  }
  let names: string[];
  try {
    names = readdirSync(cwd);
  } catch {
    return found; // unreadable root: the root-level search already came up empty
  }
  const subdirs = names
    .filter((name) => CONFIG_SEARCH_PRUNED_DIRS[name] !== true)
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
      if (existsSync(join(cwd, dir, name))) found.push(`${dir}/${name}`);
    }
  }
  return found;
}

/**
 * Finds the ONE consumer playwright config enumeration runs: at the
 * repo root first, then — only when no root-level config exists — ONE
 * directory level deep (see {@link findPlaywrightConfigs}). Returns
 * the repo-relative posix path (`'playwright.config.ts'`, or
 * `'e2e/playwright.config.ts'` for a subdirectory project), or null
 * when none exists.
 *
 * Root-level configs always win: an existing root project must keep its
 * exact historical invocation. The nested search only extends discovery
 * to the self-contained subdirectory layout (the config's OWN directory
 * pins its playwright install — see {@link playwrightCliPath}).
 *
 * The choice is never silent: when more than one config exists,
 * {@link listNativePlaywrightTests} names every discovered config, the
 * one used and why, and the ones NOT inventoried. There is deliberately
 * no configuration key for the choice: any such key would change WHICH
 * consumer code runs, not just what is reported, and it would have to
 * be plumbed through the discovery callers' option sets.
 *
 * Args:
 *   cwd: absolute repo root.
 *
 * Returns:
 *   string | null: repo-relative posix config path, or null.
 */
export function findPlaywrightConfig(cwd: string): string | null {
  return findPlaywrightConfigs(cwd)[0] ?? null;
}

/**
 * Builds the one-line disclosure appended to enumeration's detail when
 * the repo holds more than one playwright config. Without it a repo
 * with several suites is silently graded as a subset.
 *
 * Args:
 *   configs: every discovered config, in choice order (first = used).
 *   used: the config enumeration ran.
 *
 * Returns:
 *   string: the disclosure, or '' when there is nothing to disclose.
 */
function configChoiceNote(configs: readonly string[], used: string): string {
  if (configs.length < 2) return '';
  const reason = used.includes('/')
    ? 'no repo-root config exists, so the alphabetically first subdirectory config is inventoried'
    : 'a repo-root config always wins, so a root project keeps its exact invocation';
  const listed = configs
    .map((path) =>
      path === used
        ? `${path} (inventoried: ${reason})`
        : `${path} (not inventoried: its test cases are missing from this catalog)`,
    )
    .join(', ');
  return (
    ` — note: ${String(configs.length)} playwright configs are present, and only 1 is inventoried: ${listed}`
  );
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
  config?: { rootDir?: string; projects?: Array<{ name?: string; timeout?: unknown }> };
  suites?: ReporterSuite[];
  errors?: Array<{ message?: string }>;
}

/**
 * True when a parsed graph field is a plain object (never an array, never
 * null): the container both project-graph maps are.
 */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** True when a parsed field is an object whose values are all strings. */
function isStringRecord(value: unknown): value is Record<string, string> {
  return isPlainRecord(value) && Object.values(value).every((entry) => typeof entry === 'string');
}

/** True when a parsed dependency list is an array of strings. */
function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry: unknown) => typeof entry === 'string');
}

/** Converts an absolute path to repo-root-relative posix form. */
function toRepoRelative(cwd: string, path: string): string {
  const rel = relative(cwd, resolve(cwd, path));
  return rel.split('\\').join('/');
}

/**
 * Reads the `version` of an installed package by its directory (the
 * `<pkg>/package.json` beside a CLI), or null when it is unreadable.
 *
 * Args:
 *   packageDir: absolute directory of the installed package.
 *
 * Returns:
 *   string | null: the declared version, or null when unreadable.
 */
function installedVersion(packageDir: string): string | null {
  try {
    const parsed = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8')) as { version?: unknown };
    return typeof parsed.version === 'string' ? parsed.version : null;
  } catch {
    return null;
  }
}

/**
 * Expands a runner load error that is really a playwright VERSION
 * conflict into one sentence naming both versions and the real cause.
 * A missing dependency is the wrong diagnosis there: nothing is
 * missing, the two-versions-of-@playwright/test conflict is (install
 * rehearsal F7), and the pack's pinned copy must not be what runs the
 * consumer's project. Every other message is passed through
 * unchanged.
 *
 * Args:
 *   message: one reporter load error.
 *   cli: absolute path of the CLI that produced it.
 *
 * Returns:
 *   string: the message, with the conflict named when it is one.
 */
function diagnoseRunnerLoadError(message: string, cli: string): string {
  if (!/did not expect test\(\) to be called here/.test(message)) return message;
  const require = createRequire(import.meta.url);
  const packDir = dirname(require.resolve('playwright/package.json'));
  const runnerDir = dirname(cli);
  const runnerName = basename(runnerDir) === 'test' ? `@playwright/${basename(runnerDir)}` : basename(runnerDir);
  const runner = `${runnerName}@${installedVersion(runnerDir) ?? 'unknown version'}`;
  const pack = `playwright@${installedVersion(packDir) ?? 'unknown version'} (the pack's pin)`;
  return (
    `${message} — this is the two-versions-of-@playwright/test conflict, not a missing ` +
    `dependency: this project was enumerated with ${runner} while the pack pins ${pack}. ` +
    "Make the project's own @playwright/test the one Gateforge runs (remove the other copy from " +
    'node_modules), or align both to one version.'
  );
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
  const configs = findPlaywrightConfigs(options.cwd);
  const configPath = configs[0] ?? null;
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
  // The JSON report is read from a FILE the runner writes, never from
  // stdout: a consumer's playwright config routinely prints at load
  // time (a dotenv/dotenvx banner, a stray `console.log`) and stdout is
  // the runner's own channel, not a document channel (install
  // rehearsal F6). The path is absolute, so the reporter's
  // cwd-relative resolution cannot move it, and the JSON reporter's
  // `printsToStdio()` turns false — no part of the report can
  // interleave with the config's logging. The same directory holds the
  // project-graph document (below) and is removed with the child.
  const reportDir = mkdtempSync(join(tmpdir(), 'gateforge-playwright-report-'));
  const reportPath = join(reportDir, 'reporter.json');
  // The project graph rides along with the json report through an
  // ENGINE-OWNED reporter (see {@link projectGraphReporterEntry}): the
  // json reporter's `config.projects[]` does not carry `dependencies` in
  // any released playwright (verified against 1.58.2 and 1.62.1), and
  // reading them out of the consumer config would mean trusting candidate
  // code. Without the built entry the enumeration runs exactly as before
  // and reports no graph — the field is optional precisely so a missing
  // graph is honest absence, never a guessed empty one.
  const graphReporterEntry = projectGraphReporterEntry();
  const args = [
    cli,
    'test',
    '--list',
    `--reporter=json${existsSync(graphReporterEntry) ? `,${graphReporterEntry}` : ''}`,
  ];
  if (configDir !== '.') args.push('--config', basename(configPath));
  const discoveryStateDir =
    options.wiredEnv === undefined ? mkdtempSync(join(tmpdir(), 'gateforge-discovery-state-')) : undefined;
  let outcome: { code: number | null; stdout: string; stderr: string; timedOut: boolean; error: Error | null };
  let reportText: string | null = null;
  let graphText: string | null = null;
  try {
    const childEnv: NodeJS.ProcessEnv =
      options.wiredEnv === undefined
        ? untrustedEnv(process.env, discoveryStateDir)
        : buildRunnerChildEnv(options.wiredEnv, process.env);
    // The evidence fixture binds to the CONSUMER's runner, resolved from
    // the config directory this enumeration just discovered: that is what
    // makes a non-root config with its own `node_modules` work, not only a
    // hoisted repository-root install. Set on BOTH the scrubbed and the
    // wired child so the two registrations can never differ.
    childEnv[ENV_PLAYWRIGHT_CONFIG_DIR] = childCwd;
    childEnv['PLAYWRIGHT_JSON_OUTPUT_FILE'] = reportPath;
    childEnv[PROJECT_GRAPH_PATH_ENV] = join(reportDir, 'project-graph.json');
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
    try {
      graphText = readFileSync(join(reportDir, 'project-graph.json'), 'utf8');
    } catch {
      graphText = null;
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
  // The runner-resolved project names: the json reporter rebuilds
  // `config.projects[]` field by field, `name` included (verified
  // against the pack's pinned playwright and a consumer's own). A
  // config with no `projects` array gets ONE implicit project whose
  // name is '' — the runner's own answer that the config declares
  // no named project, which test-gates need for the per-project
  // identity join (catalog rows key by project name).
  const projectNames = document.config?.projects?.map((project) => project.name ?? '');
  const projectTimeouts = readProjectTimeouts(document.config?.projects);
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
  const errors = (document.errors ?? []).map((error) => diagnoseRunnerLoadError(error.message ?? String(error), cli));
  // The project graph the runner resolved, plus the storage states its
  // projects declare. A document that does not parse — or that carries a
  // field this reader does not understand — is absence, never a partial
  // graph: a downstream run that emitted a `dependencies` edge from half
  // a graph would order projects wrongly, and one that honored half the
  // declared states would authenticate the wrong projects.
  let projectDependencies: Record<string, string[]> | undefined;
  let projectBrowsers: Record<string, string> | undefined;
  let projectStorageStates: Record<string, string> | undefined;
  let testFileScope: ProjectTestFileScope[] | undefined;
  if (graphText !== null) {
    try {
      const parsed = JSON.parse(graphText) as Partial<ProjectGraphDocument>;
      // Untrusted input: everything below is checked at runtime, and one
      // bad field discards the WHOLE document rather than half of it.
      const graph: unknown = parsed.projectDependencies;
      const states: unknown = parsed.projectStorageStates;
      const rawScopes: unknown = parsed.testFileScope;
      const rawBrowsers: unknown = parsed.projectBrowsers;
      if (parsed.schemaVersion === 2 && isPlainRecord(graph)) {
        // Null-prototype: a project NAME is candidate data and `__proto__`
        // is a legal one, so the maps keyed by it must not inherit.
        const dependencies = Object.create(null) as Record<string, string[]>;
        const storageStates = Object.create(null) as Record<string, string>;
        let wellFormed = true;
        for (const [name, edges] of Object.entries(graph)) {
          if (!isStringArray(edges)) {
            wellFormed = false;
            break;
          }
          dependencies[name] = [...new Set(edges.filter((edge) => edge.length > 0))].sort();
        }
        if (wellFormed && states !== undefined) {
          if (!isStringRecord(states)) {
            wellFormed = false;
          } else {
            for (const [name, value] of Object.entries(states)) {
              // An empty string is carried, not filtered: whether it may
              // be read is the planner's refusal, never this reader's
              // silent omission.
              storageStates[name] = value;
            }
          }
        }
        if (wellFormed && rawBrowsers !== undefined) {
          if (!isStringRecord(rawBrowsers)) {
            wellFormed = false;
          } else {
            projectBrowsers = { ...rawBrowsers };
          }
        }
        if (wellFormed) {
          const parsedScopes = readTestFileScopes(rawScopes);
          if (parsedScopes === null) {
            wellFormed = false;
          } else {
            testFileScope = parsedScopes;
          }
        }
        if (wellFormed) {
          projectDependencies = dependencies;
          // Omitted when nothing declared a state — an empty map would
          // read as "every project runs with an empty state".
          if (Object.keys(storageStates).length > 0) projectStorageStates = storageStates;
        }
      }
    } catch {
      projectDependencies = undefined;
      projectStorageStates = undefined;
      testFileScope = undefined;
    }
  }
  const configDetail = configDir !== '.' ? ` (cwd '${configDir}')` : '';
  const envDetail =
    options.wiredEnv === undefined
      ? 'isolated temporary GATEFORGE_STATE_DIR'
      : 'allowlisted wired runner variables';
  return {
    status: 'discovered',
    detail:
      `native playwright --list over '${configPath}'${configDetail} enumerated ${String(instances.length)} ` +
      `instance(s) as untrusted code (${envDetail})` + configChoiceNote(configs, configPath),
    instances,
    errors,
    ...(projectDependencies !== undefined ? { projectDependencies } : {}),
    ...(projectStorageStates !== undefined ? { projectStorageStates } : {}),
    ...(testFileScope !== undefined ? { testFileScope } : {}),
    ...(projectBrowsers !== undefined ? { projectBrowsers } : {}),
    ...(projectNames !== undefined ? { projectNames } : {}),
    ...(projectTimeouts !== undefined ? { projectTimeouts } : {}),
  };
}

/**
 * Reads the per-project test timeouts out of the JSON report's
 * `config.projects[]`.
 *
 * Args:
 *   projects: the report's `config.projects`, as untrusted JSON.
 *
 * Returns:
 *   Record<string, number> | undefined: project name → timeout ms for each
 *   NAMED project that reported a finite positive number (null-prototype,
 *   since a project name is candidate data); undefined when none did.
 */
function readProjectTimeouts(
  projects: ReadonlyArray<{ name?: string; timeout?: unknown }> | undefined,
): Record<string, number> | undefined {
  if (!Array.isArray(projects)) return undefined;
  const timeouts = Object.create(null) as Record<string, number>;
  for (const project of projects) {
    const name = project?.name;
    const timeout = project?.timeout;
    if (typeof name !== 'string' || name.length === 0) continue;
    if (typeof timeout !== 'number' || !Number.isFinite(timeout) || timeout <= 0) continue;
    timeouts[name] = timeout;
  }
  return Object.keys(timeouts).length > 0 ? timeouts : undefined;
}

/**
 * Reads the runner-resolved per-project test-file selection out of the
 * untrusted graph document.
 *
 * Args:
 *   value: the document's `testFileScope` field, as untrusted JSON.
 *
 * Returns:
 *   ProjectTestFileScope[]: the well-formed entries; `undefined` when the
 *   field is absent. null when it is present but malformed — the caller
 *   then discards the WHOLE document rather than narrowing the catalog
 *   from half a selection.
 */
function readTestFileScopes(value: unknown): ProjectTestFileScope[] | undefined | null {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) return null;
  const scopes: ProjectTestFileScope[] = [];
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) return null;
    const candidate = entry as Record<string, unknown>;
    const { name, testDir, testMatch, testIgnore } = candidate;
    if (typeof name !== 'string' || typeof testDir !== 'string') return null;
    if (!isStringArray(testMatch) || !isStringArray(testIgnore)) return null;
    scopes.push({ name, testDir, testMatch: [...testMatch], testIgnore: [...testIgnore] });
  }
  return scopes;
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

/**
 * Whether the runner-resolved project names say the config the
 * enumeration ran declares no named project: every reported
 * project name is empty (a config with no `projects` array
 * gets one implicit unnamed project; a declared project
 * without a `name` reports ''). A report that carries no
 * `config.projects` section (an older reporter) never
 * triggers the verdict — absence of evidence is not evidence
 * of absence.
 *
 * Args:
 *   projectNames: the runner-resolved project names, or
 *     undefined when the report carried none.
 *
 * Returns:
 *   boolean: true when the runner positively reported projects
 *     and none of them is named.
 */
export function declaresNoNamedProject(projectNames: string[] | undefined): boolean {
  return (
    projectNames !== undefined &&
    projectNames.every((name) => name.length === 0)
  );
}
