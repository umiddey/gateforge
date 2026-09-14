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
 * - tests must be self-contained (app provided externally via the
 *   app-base env, as the fixture already requires).
 */
/** File name of the synthesized trusted config inside the run-state dir. */
export declare const TRUSTED_CONFIG_FILE = "trusted.playwright.config.mjs";
/** File name of the forced reporter options (diagnostic mirror of argv). */
export declare const TRUSTED_REPORTER_OPTIONS_FILE = "trusted-reporter-options.json";
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
    /** Exact repo-relative posix test files to run (undefined = default). */
    testFiles?: readonly string[];
    /** Bare project names to run (undefined = no project filter). */
    projects?: readonly string[];
    /** Per-test timeout ms (default 60_000). */
    testTimeoutMs?: number;
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
export declare function trustedReporterEntry(fromModule?: string): string;
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
export declare function synthesizeTrustedConfig(input: TrustedConfigInput): {
    configPath: string;
    reporterOptions: TrustedReporterOptions;
};
//# sourceMappingURL=trusted-config.d.ts.map