import type { RunnerExecutionEnv, RunnerExecutionEnvelope, RunnerSelection } from '@gateforge/core';
/** Default whole-run wall-clock bound for one supervised playwright run. */
export declare const DEFAULT_RUN_TIMEOUT_MS: number;
/** The runner-outcomes document the gateforge reporter writes. */
export interface RunnerOutcomesDocument {
    schemaVersion: 1;
    /** The runner's final run status (FullResult.status). */
    runStatus: string | null;
    /** Runner-level errors (globalSetup/teardown/runner body). */
    runnerErrors: string[];
    /** One row per executed test instance (per project instance). */
    outcomes: Array<{
        testId: string;
        file: string;
        titlePath: string[];
        project: string | null;
        status: string;
        attempt: number;
        expectedFailure: boolean;
    }>;
    /** Shard declaration from TEST_SHARD, or null when unsharded. */
    shard: {
        index: number;
        total: number;
    } | null;
}
/** Options for one supervised playwright run. */
export interface SupervisedRunOptions {
    /**
     * Base argv of the runner command (default: the engine's pinned
     * playwright CLI). Tests substitute a stub runner here; production
     * never overrides it. A stub ignores the trusted `--config` flags the
     * supervisor appends (it replaces the whole invocation).
     */
    command?: readonly string[];
    /** Whole-run wall-clock bound (default {@link DEFAULT_RUN_TIMEOUT_MS}). */
    timeoutMs?: number;
    /** Repo root override (default: process cwd; the trusted testDir). */
    cwd?: string;
    /**
     * Exact repo-relative posix test files to run (the supervisor's
     * selection as data). Undefined = the runner default (every spec
     * under the root). The consumer config's scoping never applies.
     */
    testFiles?: readonly string[];
    /**
     * Bare project names to run (identity only). Undefined = no project
     * filter. Per-project code options are never honored.
     */
    projects?: readonly string[];
    /**
     * Engine reporter entry override (tests point at a built reporter;
     * production resolves the pack's own dist entry).
     */
    reporterEntry?: string;
}
/**
 * The pinned playwright version visible to this process (the pack's own
 * dependency — the same CLI the supervised run uses), or 'unknown' when
 * the manifest cannot be read (honest placeholder, never a guess).
 */
export declare function playwrightVersion(): string;
/**
 * Executes the configured playwright suite under trusted supervision and
 * returns the structured outcome envelope (plan Phase 4 item 1). The
 * consumer's config file is NEVER loaded (see the module doc); the run
 * uses the synthesized trusted config over the exact selected files.
 *
 * Args:
 *   selection: the exact logical keys the supervisor expects (data only
 *     at this layer — the run itself is the full configured suite).
 *   env: run-state dir + run identity + pre-sanitized vars the child
 *     inherits (witness wiring; NEVER verifier material, NEVER state
 *     paths — the child must not locate the spool or outcomes files).
 *   options: runner command override (tests), timeout, cwd, the exact
 *     test files/projects to run, reporter entry override.
 *
 * Returns:
 *   Promise<RunnerExecutionEnvelope>: the structured outcome envelope —
 *   `complete` is false with a single-cause detail for missing/failed
 *   outcomes, timeout, or nonzero exit.
 */
export declare function executeSupervisedPlaywright(selection: RunnerSelection, env: RunnerExecutionEnv, options?: SupervisedRunOptions): Promise<RunnerExecutionEnvelope>;
/**
 * Default runner command: the engine's own pinned playwright CLI. The
 * CLI is passed as a PLAIN absolute filesystem path — Node's process
 * entry must be a path, never a `file:` URL (a URL argument fails with
 * MODULE_NOT_FOUND before the runner starts, which would masquerade as
 * a failed suite). A broken pack dependency surfaces as the typed
 * incomplete envelope (the argv names the path), never a hang.
 *
 * Returns:
 *   readonly string[]: `[process.execPath, <playwright cli.js>]`.
 */
export declare function defaultPlaywrightCommand(cwd?: string): readonly string[];
/**
 * Reads + structurally validates the runner-outcomes document (the
 * gateforge reporter's supervision input). Exported for the trusted
 * supervisor (the CLI), which joins outcomes rows against its planned
 * expected set — reporter data is input only, never signature authority.
 *
 * Args:
 *   path: absolute outcomes document path.
 *
 * Returns:
 *   RunnerOutcomesDocument | null: the parsed document, or null when
 *   missing/malformed (supervision then fails closed).
 */
export declare function readRunnerOutcomes(path: string): RunnerOutcomesDocument | null;
//# sourceMappingURL=supervised-run.d.ts.map