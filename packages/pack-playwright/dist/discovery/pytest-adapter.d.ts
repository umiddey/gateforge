import type { DiagnosticSuite } from '@gate-forge/core';
import { TestDiscoveryError } from './reconcile.js';
/** One collected pytest case, identity preserved (§3.5). */
export interface PytestCollectedCase {
    /** The exact pytest node id, parameters included. */
    nodeId: string;
    /** File part of the node id (posix, suite-cwd-relative). */
    file: string;
    /** Class/test segments after the file part. */
    titlePath: string[];
}
/** Outcome of one collection run. */
export interface PytestCollectionResult {
    status: 'discovered' | 'unavailable';
    /** Single-cause detail (errors verbatim, bounded). */
    detail: string;
    cases: PytestCollectedCase[];
    /** Node ids pytest reported as collection errors, if any. */
    collectionErrors: string[];
    exitCode: number | null;
}
/**
 * Composes the collection argv for a configured suite: the configured
 * interpreter/args verbatim, then `--collect-only -q`, then the
 * configured testPaths. Nothing else — no directory guessing, no extra
 * commands beyond the configured argv + collection flags.
 *
 * Args:
 *   suite: the configured diagnostic suite.
 *
 * Returns:
 *   string[]: argv to spawn with cwd = repo root (the adapter passes the
 *   suite's own testPaths, which are repo-root-relative and resolved by
 *   the caller's cwd choice).
 */
export declare function pytestCollectArgv(suite: DiagnosticSuite): string[];
/**
 * Composes the Phase 4 diagnostic EXECUTION argv (junit XML into the
 * EXCLUDED run-state dir). Exported now so the composition is tested;
 * invoking it is Phase 4 work.
 *
 * Args:
 *   suite: the configured diagnostic suite.
 *   stateDir: absolute run-state directory (excluded from inputs).
 *
 * Returns:
 *   string[]: argv running the suite with a junitxml report at
 *   `<stateDir>/diagnostics/<suite.name>.xml`.
 */
export declare function pytestExecutionArgv(suite: DiagnosticSuite, stateDir: string): string[];
/**
 * Runs one bounded collection for a configured suite. The child runs as
 * UNTRUSTED consumer code (all `GATEFORGE_*` env stripped — same trust
 * boundary as playwright enumeration) with the suite's finite timeout.
 *
 * Args:
 *   suite: the configured suite (argv, testPaths, timeoutMs).
 *   cwd: absolute repo root the repo-relative testPaths resolve against.
 *
 * Returns:
 *   Promise<PytestCollectionResult>: collected node ids or an
 *   unavailable verdict — collection failure is data (§3.5: show
 *   incomplete status), never a fabricated empty success.
 */
export declare function collectPytestSuite(suite: DiagnosticSuite, cwd: string): Promise<PytestCollectionResult>;
/** One parsed junit-XML testcase (pytest diagnostics surface). */
export interface JunitTestCase {
    /** Classname (module path as pytest emitted it). */
    classname: string;
    /** Test name incl. parameters, e.g. `test_x[param-2]`. */
    name: string;
    /** passed | failed | error | skipped. */
    outcome: 'passed' | 'failed' | 'error' | 'skipped';
    /** The skip/xfail type attribute when skipped, e.g. `pytest.xfail`. */
    skipType?: string;
    /** First line of failure/error/skip message, when present. */
    message?: string;
    /** The file attribute pytest emits when present (node-id reconstruction). */
    file?: string;
}
/** Parsed junit-XML document (one testsuite). */
export interface JunitDocument {
    suiteName: string;
    tests: number;
    failures: number;
    errors: number;
    skipped: number;
    cases: JunitTestCase[];
}
/** Typed parser failure for malformed junit XML (fail closed). */
export declare class JunitParseError extends Error {
    constructor(message: string);
}
/**
 * Parses a pytest junit-XML document into structured outcomes (plan
 * phase 2 item 8: prefer structured results over parsing terminal
 * colors). Bounded and strict: the parser understands the exact subset
 * pytest emits (`<testsuite>` with `<testcase>` children carrying
 * `<failure>`, `<error>`, or `<skipped type="...">` children) and THROWS
 * (`JunitParseError`) on anything else — a malformed report is never
 * silently read as a green run. xfail appears as `skipped` with
 * `type="pytest.xfail"`; collection errors appear as testcases named
 * `pytest_collection` with an `<error>` child.
 *
 * Args:
 *   xml: the junit-XML document text.
 *
 * Returns:
 *   JunitDocument: suite counters + one row per testcase.
 *
 * Throws:
 *   JunitParseError: on missing/malformed structure (fail closed).
 */
export declare function parseJunitXml(xml: string): JunitDocument;
/**
 * Repo-relative form of `path` against `cwd` (absolute inputs only by
 * contract; relative pass through normalized).
 */
export declare function repoRelative(cwd: string, path: string): string;
/** Honest status of one diagnostic suite run (§3.5 — never E2E proof). */
export type DiagnosticRunStatus = 
/** Completed run, ≥1 passing test, no unexpected failures. */
'completed'
/** Completed run with ≥1 test failure. */
 | 'failures'
/** Unavailable/incomplete: collection error, timeout, missing
 * interpreter, interruption, zero tests, or only skipped/xfail. */
 | 'incomplete';
/** Advisory diagnostic cause codes (plan §5.4 — report-only, never verdicts). */
export type DiagnosticCause = 'DIAGNOSTIC_TEST_FAILURE' | 'DIAGNOSTIC_RUN_INCOMPLETE';
/** One structured per-suite diagnostic result (plan §5.1 "Diagnostic result"). */
export interface DiagnosticRunResult {
    /** The configured suite name. */
    suite: string;
    /** Honest status: completed | failures | incomplete. */
    status: DiagnosticRunStatus;
    /** Suite process exit code (pytest exit codes, null on spawn failure). */
    exitCode: number | null;
    /** True when the finite timeout expired and the child was killed. */
    timedOut: boolean;
    /** Spawn failure detail (e.g. missing interpreter), or null. */
    spawnError: string | null;
    /** Collection/setup errors observed (from stderr scan + junit). */
    collectionErrors: string[];
    /** The selected scope (the configured testPaths, verbatim). */
    selectedScope: string[];
    /** Node ids the report covered (file::name, parameters included). */
    nodeIds: string[];
    /** Per-case outcomes from the junit report. */
    cases: Array<{
        nodeId: string;
        outcome: 'passed' | 'failed' | 'error' | 'skipped';
        skipType?: string;
        message?: string;
        /** Failure phase: collection/setup surface as 'error', others 'call'. */
        phase: 'collection' | 'setup' | 'call' | 'teardown' | 'unknown';
    }>;
    /** Explicit counters — skips/xfail never become passes or proof. */
    counts: {
        passed: number;
        failed: number;
        errors: number;
        skipped: number;
        xfailed: number;
    };
    /** True only when the run was bounded and its report parsed. */
    complete: boolean;
    /** Single-cause detail when incomplete. */
    incompleteDetail: string | null;
    /** Advisory causes for this suite (report-only). */
    causes: DiagnosticCause[];
    /** Absolute junit-XML report path (inside the excluded run-state dir). */
    reportPath: string;
    /** Whether the report file exists on disk. */
    reportExists: boolean;
    /** True when the junit report existed but could not be parsed (fail closed). */
    reportUnparsable: boolean;
}
/**
 * Executes one configured diagnostic suite ONCE (plan Phase 4 item 9, §3.5):
 * an isolated process (every `GATEFORGE_*` variable stripped), the
 * configured argv + a junit-XML report into the EXCLUDED run-state dir,
 * and a finite timeout. The result is advisory diagnostic data — it is
 * never witness evidence and never satisfies an E2E obligation.
 *
 * Exit semantics (plan §3.5 / pytest exit codes):
 * - `completed`: run finished, ≥1 passed, no unexpected failures;
 * - `failures`: the run finished with test failures;
 * - `incomplete`: collection/setup error, timeout, missing interpreter,
 *   interruption, zero tests, or a run of ONLY skipped/xfail cases —
 *   never displayed as a passing diagnostic run.
 *
 * Args:
 *   suite: the configured suite (argv, testPaths, timeoutMs).
 *   repoRoot: absolute repo root (suite.cwd resolves against it).
 *   stateDir: absolute run-state directory (excluded from inputs); the
 *     junit report lands at `<stateDir>/diagnostics/<suite.name>.xml`.
 *
 * Returns:
 *   Promise<DiagnosticRunResult>: the structured diagnostic result.
 */
export declare function executePytestSuite(suite: DiagnosticSuite, repoRoot: string, stateDir: string): Promise<DiagnosticRunResult>;
/** Re-export so the adapter module is the single pytest surface. */
export { TestDiscoveryError };
//# sourceMappingURL=pytest-adapter.d.ts.map