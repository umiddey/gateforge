/**
 * Runner-adapter contract (plan 2026-09-13 phase 2 item 6): the small
 * interface every test-runner adapter implements so inventory, instance
 * resolution, and execution have one shape.
 *
 * This module is TYPES ONLY (no runtime code): adapters live in their
 * packs (the Playwright and bounded pytest adapters in
 * `@gate-forge/pack-playwright/discovery`), while the contract belongs to
 * the engine so CLI/pipeline code can depend on the shape without
 * depending on a pack.
 *
 * Honesty rules baked into the contract:
 * - `capabilities` is declared, never implied: an adapter that cannot
 *   execute says so (`not-wired-until-phase-4`); callers fail closed
 *   instead of guessing.
 * - `execute` returns a structured outcome envelope — runner exit codes
 *   alone are never a gate result (plan §5.1 row "Execution result").
 */
import type { TestCatalogEntry } from './test-catalog.js';
/** Availability of one adapter capability. */
export type RunnerCapability = 'available' | 'not-wired-until-phase-4' | 'unsupported';
/** The declared capabilities of one adapter. */
export interface RunnerCapabilities {
    /** Enumerate the runner's tests into catalog entries. */
    inventory: RunnerCapability;
    /** Map a logical key to concrete runtime instances (project/param). */
    resolveInstances: RunnerCapability;
    /**
     * Execute a selection under trusted supervision and return the
     * structured outcome envelope. `not-wired-until-phase-4` until the
     * trusted supervisor owns the run (plan phase 4).
     */
    execute: RunnerCapability;
}
/** One concrete runtime instance a logical test resolves to. */
export interface RunnerTestInstance {
    /** The logical key the instance belongs to (§5.2 identity rules). */
    logicalKey: string;
    /** Runner project, e.g. `chromium` (framework IDs identify instances). */
    project: string | null;
    /**
     * The framework's own instance id (playwright spec id, pytest node
     * id). Framework IDs identify runtime instances; the logical key
     * stays the stable mapping identity.
     */
    frameworkId: string;
}
/** The tests an execute call is asked to run (exact, never a wildcard). */
export interface RunnerSelection {
    /** Exact logical keys selected for the run. */
    logicalKeys: readonly string[];
}
/** Environment identity an execute call runs under (plan §3.3 rule 4). */
export interface RunnerExecutionEnv {
    /** Absolute run-state directory (excluded from tracked inputs). */
    stateDir: string;
    /** Run id the execution binds to. */
    runId: string;
    /** Extra env the supervisor wires for the run (already sanitized). */
    vars: Readonly<Record<string, string>>;
}
/** Per-instance outcome of a supervised execution (plan §5.1 row 4). */
export interface RunnerInstanceOutcome {
    logicalKey: string;
    /** The concrete instance that ran. */
    project: string | null;
    frameworkId: string;
    /** passed | failed | skipped | fixme — first attempt, no retries. */
    status: 'passed' | 'failed' | 'skipped' | 'fixme' | 'not-run';
    /** Attempt number (1 = first attempt; required retries stay zero). */
    attempt: number;
    /**
     * True when the instance is an expected failure (e.g. Playwright
     * `test.fail()`): an expected-failure exemption never proves behavior
     * (plan §3.3 rule 3) and supervision blocks on it.
     */
    expectedFailure?: boolean;
}
/**
 * The structured outcome envelope `execute` resolves with. Runner
 * reporter data is INPUT here, never signature authority (plan §5.1).
 * Phase 4 extends the envelope with the supervision surfaces trusted
 * runner supervision needs (fixture/teardown outcome, shard
 * completeness, retry detection, engine versions) — all optional so
 * earlier adapters remain valid.
 */
export interface RunnerExecutionEnvelope {
    /** Framework process exit code (supplementary, never decisive). */
    processExit: number | null;
    /** Whether the COMPLETE selected set ran (no missing cases/shards). */
    complete: boolean;
    /** One outcome per planned instance. */
    outcomes: readonly RunnerInstanceOutcome[];
    /** Single-cause detail when the run is incomplete. */
    incompleteDetail?: string;
    /**
     * Setup/teardown/runner-body outcome observed during the run
     * (plan §3.3 rule 5: the complete run — fixtures and teardown
     * included — must end successfully). Absent = unknown (fail closed
     * downstream).
     */
    fixtureOutcome?: 'passed' | 'failed' | 'unknown';
    /**
     * Shard completeness when the runner reports sharding; null/absent
     * means the runner reported none (single-shard runs).
     */
    shards?: {
        complete: boolean;
        detail: string;
    } | null;
    /** True when retry-assisted execution was detected (retries must be 0). */
    retriesDetected?: boolean;
    /** Detail describing the retry detection. */
    retriesDetail?: string;
    /** Runtime engine versions captured during the run (honest subset). */
    engines?: Record<string, string>;
    /** Browser versions when the runner reports them (may be empty). */
    browsers?: Record<string, string>;
}
/**
 * The adapter contract (plan phase 2 item 6): inventory, instance
 * resolution, execution, outcomes. Adapters must be deterministic and
 * fail closed: enumeration never returns an empty inventory for a scan
 * that failed, and undeclared capabilities are rejected by callers.
 *
 * @typeParam TEntry - the catalog entry row shape the adapter emits.
 */
export interface TestRunnerAdapter<TEntry extends object = TestCatalogEntry> {
    /** Runner name the adapter serves, e.g. `playwright`. */
    readonly runner: string;
    /** Declared capabilities — callers must honor, never assume. */
    readonly capabilities: RunnerCapabilities;
    /**
     * Enumerates the runner's configured tests.
     *
     * Args:
     *   cwd: absolute repo root the runner configuration lives under.
     *
     * Returns:
     *   Promise<TEntry[]>: catalog entry rows (unresolved rows included —
     *   never an empty list for a failed scan).
     */
    inventory(cwd: string): Promise<readonly TEntry[]>;
    /**
     * Resolves one logical key to its concrete runtime instances.
     *
     * Args:
     *   logicalKey: the stable logical identity (§5.2).
     *   cwd: absolute repo root.
     *
     * Returns:
     *   Promise<RunnerTestInstance[]>: matching instances (empty when the
     *   key has no current instance — a visible stale mapping, §5.2).
     */
    resolveInstances(logicalKey: string, cwd: string): Promise<readonly RunnerTestInstance[]>;
    /**
     * Executes a selection under trusted supervision. Adapters whose
     * `capabilities.execute` is not `available` reject here (fail closed).
     *
     * Args:
     *   selection: exact logical keys to run.
     *   env: run-state dir + run identity the execution binds to.
     *
     * Returns:
     *   Promise<RunnerExecutionEnvelope>: structured outcome envelope.
     */
    execute(selection: RunnerSelection, env: RunnerExecutionEnv): Promise<RunnerExecutionEnvelope>;
}
//# sourceMappingURL=runner-adapter.d.ts.map