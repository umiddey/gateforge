/**
 * The §3.5 advisory diagnostic runner (plan 2026-09-13 Phase 4 items
 * 9-10, `tests diagnose`): runs the CONFIGURED pytest diagnostic suites
 * once per suite against the current inputs, isolated (its own process,
 * every `GATEFORGE_*` variable stripped, finite timeout, junit XML into
 * the EXCLUDED run-state dir), and prints/serializes a SEPARATE
 * diagnostic report.
 *
 * Hard separation rules (§3.5):
 * - diagnostic results are NEVER fed into claims, witness records,
 *   baselines, waivers, or E2E satisfaction, and never merged into E2E
 *   pass counts;
 * - skips/xfail stay explicit counters — a run of only skipped/xfail is
 *   INCOMPLETE (never a passing diagnostic run);
 * - the advisory causes DIAGNOSTIC_TEST_FAILURE / DIAGNOSTIC_RUN_INCOMPLETE /
 *   DIAGNOSTIC_RESULT_STALE surface in the diagnostic report ONLY;
 * - stdout never prints an unqualified "all tests passed" that could
 *   hide a diagnostic failure.
 *
 * WITNESSED suites (server-witnessed persistence channel; `witnessed:
 * true` in `.gateforge.yml`) are NOT advisory diagnostics and never run
 * here: the advisory window strips every GATEFORGE_* variable, so the
 * participant could not even address the intents spool, and its result
 * must never hide behind the advisory banner. They run through
 * {@link runWitnessedPytestSuites} — only from the supervised test-gates
 * window, with the run-scoped env, where a failed/incomplete run BLOCKS
 * the gate (the mapped server-e2e test's red is never graded green).
 */
import { type GateforgeConfig } from '@gate-forge/core';
import { type DiagnosticRunResult } from '@gate-forge/pack-playwright';
import type { Io } from './io.js';
/** The saved diagnostics report document (run state; never tracked input). */
export interface DiagnosticsReportDocument {
    schemaVersion: 1;
    /** The input digest the diagnostics ran against (staleness check input). */
    inputDigest: string | null;
    /** Per-suite results (sorted by name). */
    suites: DiagnosticRunResult[];
    /** When the report was generated (ISO-8601). */
    generatedAt: string;
}
/** The aggregated exit code for a diagnostics run. */
export type DiagnosticsExitCode = 0 | 1 | 2;
/** Everything {@link runDiagnosticSuites} needs. */
export interface RunDiagnosticsInput {
    /** Validated `.gateforge.yml` (diagnostics.suites). */
    config: GateforgeConfig;
    /** Absolute repo root. */
    cwd: string;
    /** Absolute run-state directory (report + junit XMLs live here). */
    stateDir: string;
    /** Current input digest, or null when the snapshot is unavailable. */
    inputDigest: string | null;
    /** Optional suite-name filter (unknown name → UsageError). */
    suiteName?: string;
    /** Injected clock for the report timestamp. */
    now: string;
}
/** One diagnostics run over the configured suites. */
export interface DiagnosticsRun {
    /** Per-suite results (sorted by suite name). */
    results: DiagnosticRunResult[];
    /** Aggregated exit code: 0 completed, 1 failures, 2 incomplete. */
    exitCode: DiagnosticsExitCode;
    /** True when a previously saved report existed for DIFFERENT inputs. */
    previousReportStale: boolean;
    /** True when the previous saved report existed and matched inputs. */
    previousReportFresh: boolean;
    /**
     * WITNESSED suite names this advisory run EXCLUDED (they run only in
     * the supervised test-gates window, where their result grades).
     * Surfaced so an exclusion is always visible — never silent.
     */
    witnessedExcluded: string[];
}
/**
 * Runs the configured ADVISORY diagnostic suites (plan Phase 4 item 9)
 * and saves the report. Each suite runs ONCE via its adapter in an
 * isolated process. Suites marked `witnessed: true` are EXCLUDED here
 * (surfaced on {@link DiagnosticsRun.witnessedExcluded}) — the advisory
 * window strips every GATEFORGE_* variable, so a witnessed participant
 * could never address the intents spool, and its result grades only in
 * the supervised window. With no (non-witnessed) suites configured this
 * is a no-op run (exit 0, feature off) — the alarm is opt-in and never
 * invents suites.
 *
 * Args:
 *   input: config, cwd, state dir, current input digest, optional suite
 *     filter, and the injected instant.
 *
 * Returns:
 *   Promise<DiagnosticsRun>: results, aggregated exit code, the
 *   staleness verdict on any previously saved report, and the witnessed
 *   suites this advisory run excluded.
 *
 * Throws:
 *   UsageError: when `suiteName` matches no configured suite (exit 2) or
 *     names a WITNESSED suite (running it advisory would run the mapped
 *     test outside the only window where its evidence can grade — fail
 *     closed with the exact command that does run it).
 */
export declare function runDiagnosticSuites(input: RunDiagnosticsInput): Promise<DiagnosticsRun>;
/** Everything {@link runWitnessedPytestSuites} needs. */
export interface WitnessedPytestRunInput {
    /** Validated `.gateforge.yml` (the `witnessed: true` suites). */
    config: GateforgeConfig;
    /** Absolute repo root (suite.cwd resolves against it). */
    cwd: string;
    /** Absolute run-state directory (junit XMLs land here, excluded). */
    stateDir: string;
    /**
     * The supervised participant env built by
     * `buildWitnessedPytestChildEnv` (run-scoped: STATE_DIR/RUN_ID locate
     * the intents spool; WITNESS_URL/RUN_TOKEN wire the run; NEVER the
     * verifier key).
     */
    childEnv: Record<string, string>;
}
/** The supervised witnessed pytest step's result. */
export interface WitnessedPytestRun {
    /** Per-suite results (sorted by suite name). */
    results: DiagnosticRunResult[];
    /**
     * Typed blocking details: one per suite that did not COMPLETE cleanly
     * (test failures, timeout, collection error, zero tests). The mapped
     * server-e2e test's red is never graded green — the caller projects
     * these into run-blocking entries.
     */
    blocking: string[];
}
/**
 * Runs the WITNESSED pytest participants (diagnostics suites marked
 * `witnessed: true`) INSIDE the supervised window — the caller invokes
 * this only while the supervisor spool drain is live, so a pre intent is
 * forwarded to the witness before the suite's mutation and every intent
 * reaches the verifier-key drain. Each suite runs through the SAME
 * bounded adapter as advisory diagnostics (configured argv verbatim,
 * finite timeout, junit XML into the excluded run-state dir), but with
 * the run-scoped child env, and its outcome GRADES: any suite that does
 * not complete cleanly yields a blocking detail (never advisory).
 *
 * The suites stay UNTRUSTED: they can only WRITE intents — the witness
 * stamps evidence from its own server probe, and the child env (by
 * construction) never carries the verifier key or any parent-side state
 * beyond the run identity.
 *
 * Args:
 *   input: config, cwd, state dir, the witnessed child env, and the
 *     injected instant.
 *
 * Returns:
 *   Promise<WitnessedPytestRun>: per-suite results plus typed blocking
 *   details (empty only when every witnessed suite completed).
 */
export declare function runWitnessedPytestSuites(input: WitnessedPytestRunInput): Promise<WitnessedPytestRun>;
/**
 * Aggregates the per-suite exit code (plan §3.5 / `tests diagnose`
 * contract): 0 = completed run with ≥1 passing test and no unexpected
 * failures across all suites; 1 = test failures; 2 = any
 * unavailable/incomplete run (collection error, timeout, missing
 * interpreter, interruption, zero tests, only skipped/xfail).
 *
 * Args:
 *   results: per-suite results.
 *
 * Returns:
 *   DiagnosticsExitCode: the aggregated code.
 */
export declare function diagnosticsExitCode(results: readonly DiagnosticRunResult[]): DiagnosticsExitCode;
/**
 * Reads the saved diagnostics report (staleness input for the
 * DIAGNOSTIC_RESULT_STALE cause). Malformed reports are treated as
 * absent-for-staleness purposes (the report is advisory; its own
 * consumers fail closed separately).
 *
 * Args:
 *   stateDir: absolute run-state directory.
 *
 * Returns:
 *   DiagnosticsReportDocument | null: the saved report or null.
 */
export declare function readSavedDiagnostics(stateDir: string): DiagnosticsReportDocument | null;
/** Appends the advisory stale cause when the previous report was stale. */
export declare function staleCauseFor(run: Pick<DiagnosticsRun, 'previousReportStale'>): string[];
/**
 * Renders the diagnostics report for humans (plan Phase 4 item 10):
 * per-suite status, explicit skip/xfail counters, collection/setup
 * errors, failure locations/messages, completeness, report path, and
 * the input identity. NEVER an unqualified "all tests passed".
 *
 * Args:
 *   io: output target.
 *   run: the diagnostics run.
 *   inputDigest: the tested input identity (or 'unavailable').
 */
export declare function renderDiagnosticsText(io: Io, run: DiagnosticsRun, inputDigest: string | null): void;
/** Serializes the diagnostics report for `--json` consumers. */
export declare function diagnosticsJson(run: DiagnosticsRun, inputDigest: string | null): string;
//# sourceMappingURL=diagnostics.d.ts.map