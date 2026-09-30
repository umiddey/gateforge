/**
 * Trusted Playwright config synthesis (execution-authority fix): the
 * supervised runner NEVER loads the consumer's `playwright.config.*`.
 * That file is arbitrary code running in the runner MAIN process — the
 * same process as the gateforge reporter — so a hostile config can
 * write fabricated lifecycle spool events and a fabricated outcomes
 * document, then exit 0 before any spec executes (the confirmed
 * execution bypass). Instead the supervisor synthesizes a minimal
 * trusted config into the excluded run-state dir and runs the runner
 * with `--config <trusted>`:
 *
 * - test files: the exact repo-relative files the supervisor selected
 *   (from the planned expected set), or the runner default when the
 *   caller selected nothing;
 * - projects: bare names carried as data (identity only — per-project
 *   code options are NOT honored);
 * - reporter: the engine's own reporter entry forced by absolute path
 *   with run-state paths as CONSTRUCTOR OPTIONS (never env — worker
 *   processes must not learn the spool/outcomes locations);
 * - workers: 1, fullyParallel: false (serial — one open session at a
 *   time, so a worker can never reach another test's open session);
 * - retries: 0, forbidOnly: true (required retries are zero; `.only`
 *   in a required run is a runner-level error);
 * - no globalSetup/globalTeardown, no webServer, no consumer reporters.
 *
 * Authority boundary after this fix:
 * - TRUSTED: the CLI process, the witness process, and the runner MAIN
 *   process (Playwright native + synthesized config + engine reporter).
 * - UNTRUSTED: worker processes (test files, helpers, page objects,
 *   and any code they import). Workers keep ONLY the witness URL + run
 *   token + app base in env — enough for the fixture, never enough to
 *   locate the spool or outcomes files.
 * - Worker forgery of another test's lifecycle always collides with the
 *   genuine reporter events for that test; the drain records the
 *   collision and supervision fails the run closed.
 *
 * Compatibility limits (honest, not transparent):
 * - consumer `globalSetup`/`globalTeardown` are NOT executed;
 * - consumer reporters, `webServer`, per-project `use` options,
 *   `testDir`/`testIgnore` scoping, and sharding are NOT honored;
 * - consumer `testMatch` scoping is NOT honored as CONSUMER CODE. What IS
 *   honored is the SUPERVISOR'S OWN per-project file selection
 *   (`projectScopes`): project identity is the join key the whole pipeline
 *   speaks — catalog rows, the registered expected set, session opens, and
 *   the execution trace — so file scoping must be per project too. A single
 *   global `testMatch` collects every selected file under EVERY project,
 *   which is how a `setup`-dependency config (`{ name: 'setup', testMatch:
 *   /.*\.setup\.ts/ }` plus a dependent project) ran the whole suite once
 *   per project: identities the registered expected set never bound, so
 *   their sessions were refused and they lost every piece of evidence.
 * - tests must be self-contained (app provided externally via the
 *   app-base env, as the fixture already requires).
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** File name of the synthesized trusted config inside the run-state dir. */
export const TRUSTED_CONFIG_FILE = 'trusted.playwright.config.mjs';

/** File name of the forced reporter options (diagnostic mirror of argv). */
export const TRUSTED_REPORTER_OPTIONS_FILE = 'trusted-reporter-options.json';

/** Options the synthesized trusted config carries for the engine reporter. */
export interface TrustedReporterOptions {
  /** Absolute run-state dir (spool, outcomes, injections, obligations). */
  stateDir: string;
  /** The run identity (spool path segment). */
  runId: string;
  /** Absolute runner-outcomes document path. */
  outcomesPath: string;
  /** Absolute obligations document path (reporter ledger; empty when none). */
  obligationsPath: string;
}

/** Inputs for one trusted config synthesis. */
export interface TrustedConfigInput {
  /** Absolute repo root (the runner's testDir). */
  cwd: string;
  /** Absolute run-state dir (receives the synthesized config). */
  stateDir: string;
  /** The run identity. */
  runId: string;
  /** Absolute engine reporter entry (see {@link trustedReporterEntry}). */
  reporterEntry: string;
  /** Trusted operator-provided app proxy URL for relative browser navigation. */
  appBaseUrl?: string;
  /** Operator-provided browser storage state, embedded only in trusted config. */
  storageState?: string;
  /** Exact repo-relative posix test files to run (undefined = default). */
  testFiles?: readonly string[];
  /** Bare project names to run (undefined = no project filter). */
  projects?: readonly string[];
  /**
   * The supervisor's OWN per-project file selection: each named project
   * carries exactly the files the plan attributed to it. A project with no
   * files is omitted (it would execute nothing). Files no project scope
   * claims (a project-less plan row) stay in the global `testMatch`, so
   * they still run. Empty = one global `testMatch` over `testFiles`, which
   * is byte-identical to the pre-scope behavior for a single-project run.
   */
  projectScopes?: readonly ProjectScope[];
  /** Per-test timeout ms (default 60_000). */
  testTimeoutMs?: number;
}

/** One named project and the repo-relative files the plan attributed to it. */
export interface ProjectScope {
  /** The project name — identity only; no consumer code options. */
  name: string;
  /** Repo-relative posix test files this project runs. */
  files: readonly string[];
}

/**
 * Resolves the engine reporter entry the trusted config forces: the
 * pack's own BUILT reporter (the same class the consumer config would
 * reference by package name). Never a repo-relative path — the entry
 * must be engine-owned, never candidate-controlled.
 *
 * Args:
 *   fromModule: module URL to resolve the pack from (default: this file).
 *
 * Returns:
 *   string: absolute `<pack>/dist/reporter/reporter.js` path.
 */
export function trustedReporterEntry(fromModule: string = import.meta.url): string {
  // Package-root relative (works for both src/ and dist/ layouts — the
  // package.json subpath is not in `exports`, so no self-name resolve).
  const pkgPath = fileURLToPath(new URL('../../package.json', fromModule));
  return join(pkgPath.slice(0, -'package.json'.length), 'dist', 'reporter', 'reporter.js');
}

/**
 * Synthesizes the trusted Playwright config into the run-state dir.
 *
 * Args:
 *   input: repo root, run state, reporter entry, file/project selection.
 *
 * Returns:
 *   { configPath, reporterOptions }: absolute config path for
 *   `--config`, plus the reporter options embedded in it.
 */
export function synthesizeTrustedConfig(input: TrustedConfigInput): {
  configPath: string;
  reporterOptions: TrustedReporterOptions;
} {
  const reporterOptions: TrustedReporterOptions = {
    stateDir: input.stateDir,
    runId: input.runId,
    outcomesPath: join(input.stateDir, 'runner-outcomes.json'),
    obligationsPath: join(input.stateDir, 'obligations.json'),
  };
  const testFiles = [...new Set(input.testFiles ?? [])].sort();
  const projects = [...new Set(input.projects ?? [])].sort();
  // Per-project file selection. Each project carries exactly the files the
  // plan attributed to it, so a project-scoped consumer config (the standard
  // `setup`-project auth pattern) does not have every selected file collected
  // under every project. Files no project scope claims stay in the global
  // `testMatch` — a project-less plan row must still execute. With no scopes
  // at all (the single-project case) this is exactly the old one-global-
  // `testMatch` config, so those runs stay byte-identical.
  const projectScopes = (input.projectScopes ?? [])
    .map((scope) => ({ name: scope.name, files: [...new Set(scope.files)].sort() }))
    .filter((scope) => scope.name.length > 0 && scope.files.length > 0)
    .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
  const scopedFiles = new Set(projectScopes.flatMap((scope) => scope.files));
  const unscopedFiles = testFiles.filter((file) => !scopedFiles.has(file));
  const lines = [
    '// GENERATED by gateforge trusted supervision — do not edit. The',
    '// consumer config file is NEVER loaded for supervised runs: it is',
    '// arbitrary main-process code that could fabricate the lifecycle',
    '// spool and outcomes document this reporter writes.',
    'export default {',
    `  testDir: ${JSON.stringify(input.cwd)},`,
    ...(unscopedFiles.length > 0 ? [`  testMatch: ${JSON.stringify(unscopedFiles)},`] : []),
    ...(projectScopes.length > 0
      ? [
          `  projects: ${JSON.stringify(
            projectScopes.map((scope) => ({ name: scope.name, testMatch: scope.files })),
          )},`,
        ]
      : projects.length > 0
        ? [`  projects: ${JSON.stringify(projects.map((name) => ({ name })) )},`]
        : []),
    '  workers: 1,',
    '  fullyParallel: false,',
    '  retries: 0,',
    '  forbidOnly: true,',
    `  timeout: ${String(input.testTimeoutMs ?? 60_000)},`,
    '  reporter: [',
    "    ['list'],",
    `    [${JSON.stringify(input.reporterEntry)}, ${JSON.stringify(reporterOptions)}],`,
    '  ],',
    `  use: ${JSON.stringify({
      headless: true,
      trace: 'off',
      ...(input.appBaseUrl !== undefined ? { baseURL: input.appBaseUrl } : {}),
      ...(input.storageState !== undefined ? { storageState: input.storageState } : {}),
    })},`,
    `  outputDir: ${JSON.stringify(join(input.stateDir, 'playwright-artifacts'))},`,
    '};',
    '',
  ];
  mkdirSync(input.stateDir, { recursive: true });
  const configPath = join(input.stateDir, TRUSTED_CONFIG_FILE);
  writeFileSync(configPath, `${lines.join('\n')}`, 'utf8');
  writeFileSync(
    join(input.stateDir, TRUSTED_REPORTER_OPTIONS_FILE),
    `${JSON.stringify({ configPath, reporterEntry: input.reporterEntry, reporterOptions, testFiles, projects, projectScopes }, null, 2)}\n`,
    'utf8',
  );
  return { configPath, reporterOptions };
}
