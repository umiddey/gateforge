/**
 * Runner adapters over the core contract (plan 2026-09-13 phase 2 item
 * 6 + Phase 4 items 1/9): the Playwright adapter and the bounded pytest
 * diagnostic adapter.
 *
 * Capability honesty (declared, never implied):
 * - Playwright: `inventory`, `resolveInstances`, and (since Phase 4)
 *   `execute` are AVAILABLE. `execute` runs the suite under trusted
 *   supervision (ADR 0005 D2 + execution-authority fix): the consumer's
 *   config file is NEVER loaded — the supervisor synthesizes a minimal
 *   trusted config (exact selected files, bare project names as data,
 *   the engine reporter forced by absolute path, serial workers, zero
 *   retries) and runs it with a finite timeout. The gateforge
 *   reporter's runner-outcomes document is REQUIRED input; a missing
 *   document is an incomplete run (never a silent green). Consumer
 *   globalSetup/teardown/reporters/webServer/per-project options are
 *   NOT honored (constrained model, see trusted-config.ts).
 * - Pytest: `inventory` (bounded collection), `resolveInstances`
 *   (node-id identity), and (since Phase 4) `execute` — the §3.5
 *   diagnostic execution: one isolated junit-XML run per suite in the
 *   excluded run-state dir. Its results are DIAGNOSTIC data (never
 *   witness evidence, never E2E satisfaction).
 *
 * Both adapters fail closed: an undeclared capability is an error, and
 * inventory problems come back as typed catalog rows, never silence.
 */
import { loadConfig } from '@gateforge/core';
import type { DiagnosticSuite, RunnerCapabilities, RunnerExecutionEnvelope, RunnerSelection, RunnerExecutionEnv, RunnerTestInstance, TestCatalog, TestCatalogEntry, TestRunnerAdapter } from '@gateforge/core';
import { type DiscoverOptions } from './discover.js';
import { type DiagnosticRunResult } from './pytest-adapter.js';
import { listNativePlaywrightTests } from './reconcile.js';
import { type SupervisedRunOptions } from './supervised-run.js';
/** Error thrown when an adapter capability is not available. */
export declare class AdapterCapabilityError extends Error {
    constructor(message: string);
}
/** Options the adapters need beyond cwd (config-loading override). */
export interface AdapterOptions {
    /** Discovery knobs (pytest collection, timeouts). */
    discover?: Omit<DiscoverOptions, 'cwd' | 'config'>;
    /**
     * Pre-loaded config; when absent the adapter loads `.gateforge.yml`
     * from `cwd` itself (fail-closed via core).
     */
    config?: ReturnType<typeof loadConfig>;
    /**
     * Supervised-run knobs for `execute` (runner command override for
     * tests, whole-run timeout). Production uses the defaults.
     */
    run?: SupervisedRunOptions;
}
/** The Playwright runner adapter. */
export declare class PlaywrightAdapter implements TestRunnerAdapter<TestCatalogEntry> {
    private readonly options;
    readonly runner = "playwright";
    readonly capabilities: RunnerCapabilities;
    constructor(options?: AdapterOptions);
    /**
     * Enumerates the configured playwright tests (static + reconciled).
     *
     * Args:
     *   cwd: absolute repo root.
     *
     * Returns:
     *   Promise<readonly TestCatalogEntry[]>: catalog rows (gaps included).
     */
    inventory(cwd: string): Promise<readonly TestCatalogEntry[]>;
    /**
     * Resolves a logical key to its runtime instances (project + native
     * framework id) via the reconciled catalog.
     *
     * Args:
     *   logicalKey: the stable logical identity.
     *   cwd: absolute repo root.
     *
     * Returns:
     *   Promise<readonly RunnerTestInstance[]>: matching instances (empty
     *   when the key has no current instance — a visible stale mapping).
     */
    resolveInstances(logicalKey: string, cwd: string): Promise<readonly RunnerTestInstance[]>;
    /**
     * Executes the playwright suite under trusted supervision (plan
     * Phase 4 item 1, ADR 0005 D2, execution-authority fix): the
     * consumer's config file is never loaded (trusted-config synthesis
     * over the exact selected files); the gateforge reporter's outcomes
     * document is the per-instance data source. Expected-set comparison
     * is the supervisor's job (core supervision module) — this envelope
     * is structured INPUT, never a gate result.
     *
     * Args:
     *   selection: exact logical keys the supervisor expects (carried for
     *     the supervisor; the run itself is the full configured suite).
     *   env: run-state dir + run identity + pre-sanitized child env vars.
     *
     * Returns:
     *   Promise<RunnerExecutionEnvelope>: structured outcome envelope —
     *   `complete: false` with a single-cause detail for missing config,
     *   missing/malformed outcomes, timeout, or nonzero exit.
     */
    execute(selection: RunnerSelection, env: RunnerExecutionEnv): Promise<RunnerExecutionEnvelope>;
}
/** The bounded pytest diagnostic adapter (§3.5; collection + execution). */
export declare class PytestAdapter implements TestRunnerAdapter<TestCatalogEntry> {
    private readonly suite;
    readonly runner = "pytest";
    readonly capabilities: RunnerCapabilities;
    constructor(suite: DiagnosticSuite);
    /**
     * Collects the configured suite (bounded, structured node ids).
     *
     * Args:
     *   cwd: absolute repo root (suite.cwd resolves against it).
     *
     * Returns:
     *   Promise<readonly TestCatalogEntry[]>: one row per collected node
     *   id; collection failure yields a single unresolved row (never an
     *   empty success).
     */
    inventory(cwd: string): Promise<readonly TestCatalogEntry[]>;
    /**
     * Resolves a logical key to its collected node ids.
     *
     * Args:
     *   logicalKey: the stable logical identity.
     *   cwd: absolute repo root.
     *
     * Returns:
     *   Promise<readonly RunnerTestInstance[]>: matching instances.
     */
    resolveInstances(logicalKey: string, cwd: string): Promise<readonly RunnerTestInstance[]>;
    /**
     * Executes the configured diagnostic suite ONCE (plan Phase 4 item 9,
     * §3.5): isolated process (GATEFORGE_* stripped), junit XML into the
     * EXCLUDED run-state dir, finite timeout. The result is advisory
     * diagnostic data — never witness evidence, never E2E satisfaction.
     *
     * Args:
     *   selection: ignored (the suite's configured testPaths are the scope).
     *   env: the run env whose stateDir hosts the junit report.
     *
     * Returns:
     *   Promise<RunnerExecutionEnvelope>: a structured envelope wrapping
     *   the diagnostic outcome — `complete` mirrors the diagnostic run's
     *   completeness. Use {@link executeDiagnostic} for the full typed
     *   result (causes, counters, report path).
     */
    execute(selection: RunnerSelection, env: RunnerExecutionEnv): Promise<RunnerExecutionEnvelope>;
    /**
     * Executes the configured diagnostic suite and returns the FULL typed
     * diagnostic result (§3.5): status, exit code, counters (skips/xfail
     * explicit), collection/setup errors, failure locations/messages,
     * completeness, report path. Advisory data only.
     *
     * Args:
     *   repoRoot: absolute repo root (suite.cwd resolves against it).
     *   stateDir: absolute run-state dir for the junit report.
     *
     * Returns:
     *   Promise<DiagnosticRunResult>: the structured diagnostic result.
     */
    executeDiagnostic(repoRoot: string, stateDir: string): Promise<DiagnosticRunResult>;
}
/** Loads the catalog a discovery run produced (shared helper). */
export declare function loadCatalog(options: DiscoverOptions): Promise<TestCatalog>;
/** Native list re-export for CLI-level reconciliation previews. */
export { listNativePlaywrightTests };
//# sourceMappingURL=adapters.d.ts.map