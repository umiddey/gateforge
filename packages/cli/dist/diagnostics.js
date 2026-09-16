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
import { canonicalJson, compareStrings, } from '@gate-forge/core';
import { PytestAdapter } from '@gate-forge/pack-playwright';
import { writeLine } from './io.js';
import { UsageError } from './errors.js';
import { readStateDocument, writeDiagnosticsReport } from './state.js';
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
export async function runDiagnosticSuites(input) {
    const configured = [...(input.config.diagnostics?.suites ?? [])].sort((a, b) => compareStrings(a.name, b.name));
    if (input.suiteName !== undefined && !configured.some((suite) => suite.name === input.suiteName)) {
        throw new UsageError(`unknown diagnostic suite '${input.suiteName}' — configured: ` +
            `${configured.map((suite) => suite.name).join(', ') || '(none)'}`);
    }
    const previous = readSavedDiagnostics(input.stateDir);
    const previousReportStale = previous !== null &&
        (previous.inputDigest === null || input.inputDigest === null || previous.inputDigest !== input.inputDigest);
    const previousReportFresh = previous !== null && !previousReportStale && previous.inputDigest !== null;
    const results = [];
    for (const suite of configured) {
        if (input.suiteName !== undefined && suite.name !== input.suiteName)
            continue;
        const adapter = new PytestAdapter(suite);
        results.push(await adapter.executeDiagnostic(input.cwd, input.stateDir));
    }
    const exitCode = diagnosticsExitCode(results);
    writeDiagnosticsReport(input.stateDir, {
        schemaVersion: 1,
        inputDigest: input.inputDigest,
        suites: results,
        generatedAt: input.now,
    });
    return { results, exitCode, previousReportStale, previousReportFresh };
}
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
export function diagnosticsExitCode(results) {
    if (results.length === 0)
        return 0;
    if (results.some((result) => !result.complete || result.status === 'incomplete'))
        return 2;
    if (results.some((result) => result.status === 'failures'))
        return 1;
    if (!results.some((result) => result.counts.passed > 0))
        return 2;
    return 0;
}
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
export function readSavedDiagnostics(stateDir) {
    const document = readStateDocument(stateDir, 'diagnostics.json');
    if (document === null || typeof document !== 'object' || Array.isArray(document))
        return null;
    const record = document;
    if (record['schemaVersion'] !== 1 || !Array.isArray(record['suites']))
        return null;
    return {
        schemaVersion: 1,
        inputDigest: typeof record['inputDigest'] === 'string' ? record['inputDigest'] : null,
        suites: record['suites'],
        generatedAt: typeof record['generatedAt'] === 'string' ? record['generatedAt'] : '',
    };
}
/** Appends the advisory stale cause when the previous report was stale. */
export function staleCauseFor(run) {
    return run.previousReportStale ? ['DIAGNOSTIC_RESULT_STALE'] : [];
}
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
export function renderDiagnosticsText(io, run, inputDigest) {
    writeLine(io.stdout, `diagnostics: ${String(run.results.length)} suite(s) against input ${inputDigest ?? 'unavailable'}`);
    if (run.previousReportStale) {
        writeLine(io.stdout, '[DIAGNOSTIC_RESULT_STALE] the previous diagnostic report was for different inputs — superseded by this run');
    }
    for (const result of run.results) {
        writeLine(io.stdout, `suite ${result.suite}: ${result.status} (passed=${String(result.counts.passed)}` +
            ` failed=${String(result.counts.failed)} errors=${String(result.counts.errors)}` +
            ` skipped=${String(result.counts.skipped)} xfail=${String(result.counts.xfailed)})` +
            ` exit=${String(result.exitCode ?? 'none')}`);
        writeLine(io.stdout, `  scope: ${result.selectedScope.join(', ')}; cases: ${String(result.nodeIds.length)}`);
        writeLine(io.stdout, `  report: ${result.reportPath} (${result.reportExists ? 'written' : 'missing'})`);
        for (const error of result.collectionErrors.slice(0, 3)) {
            writeLine(io.stdout, `  collection/setup: ${error}`);
        }
        for (const testCase of result.cases) {
            if (testCase.outcome === 'passed')
                continue;
            const detail = testCase.outcome === 'skipped'
                ? `skipped${testCase.skipType !== undefined ? ` (${testCase.skipType})` : ''}`
                : `${testCase.outcome} at ${testCase.nodeId}`;
            writeLine(io.stdout, `  [${result.status === 'incomplete' ? 'DIAGNOSTIC_RUN_INCOMPLETE' : 'DIAGNOSTIC_TEST_FAILURE'}] ${detail}` +
                `${testCase.message !== undefined ? ` — ${testCase.message}` : ''}`);
        }
        if (!result.complete && result.incompleteDetail !== null) {
            writeLine(io.stdout, `  [DIAGNOSTIC_RUN_INCOMPLETE] ${result.incompleteDetail}`);
        }
    }
    const code = diagnosticsExitCode(run.results);
    writeLine(io.stdout, code === 0
        ? 'diagnostic run completed (advisory only — never E2E satisfaction)'
        : code === 1
            ? 'diagnostic run found test failures (advisory alarm — inspect before proceeding)'
            : 'diagnostic run incomplete/unavailable (never displayed as passing)');
}
/** Serializes the diagnostics report for `--json` consumers. */
export function diagnosticsJson(run, inputDigest) {
    return canonicalJson({
        schemaVersion: 1,
        inputDigest,
        exitCode: diagnosticsExitCode(run.results),
        previousReportStale: run.previousReportStale,
        causes: staleCauseFor(run),
        suites: run.results,
    });
}
//# sourceMappingURL=diagnostics.js.map