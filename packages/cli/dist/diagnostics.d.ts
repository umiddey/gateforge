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
}
/**
 * Runs the configured diagnostic suites (plan Phase 4 item 9) and saves
 * the report. Each suite runs ONCE via its adapter in an isolated
 * process. With no suites configured this is a no-op (exit 0, feature
 * off) — the alarm is opt-in and never invents suites.
 *
 * Args:
 *   input: config, cwd, state dir, current input digest, optional suite
 *     filter, and the injected instant.
 *
 * Returns:
 *   Promise<DiagnosticsRun>: results, aggregated exit code, and the
 *   staleness verdict on any previously saved report.
 *
 * Throws:
 *   UsageError: when `suiteName` matches no configured suite (exit 2).
 */
export declare function runDiagnosticSuites(input: RunDiagnosticsInput): Promise<DiagnosticsRun>;
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