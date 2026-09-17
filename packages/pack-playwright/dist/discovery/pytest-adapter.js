/**
 * Bounded pytest diagnostic adapter (plan 2026-09-13 §3.5, phase 2 item
 * 8 + Phase 4 item 9). pytest is a runner, not a test category: its
 * suites power the advisory "red means inspect this" alarm and NEVER
 * supply E2E proof.
 *
 * Hard bounds, all fail-closed:
 * - The adapter only ever composes the CONFIGURED argv (interpreter +
 *   args from `diagnostics.suites[]`), appending collection/report
 *   flags. It never scans directories for executables and never runs a
 *   command it did not compose from config.
 * - Every invocation carries a finite timeout (`timeoutMs` from the
 *   suite config); on expiry the child is killed and a typed timeout is
 *   reported — an incomplete/unavailable run, never a passing one.
 * - Collection prefers structured output: `--collect-only -q` node ids;
 *   execution outcomes come from native junit XML ({@link parseJunitXml})
 *   written into the EXCLUDED run-state dir, never tracked inputs.
 * - Diagnostic execution (Phase 4) runs each suite ONCE in an isolated
 *   process with every `GATEFORGE_*` variable stripped, and the result
 *   is DIAGNOSTIC data: it is never fed into claims, witness records,
 *   baselines, waivers, or E2E satisfaction (§3.5).
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import { TestDiscoveryError, untrustedEnv } from './reconcile.js';
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
export function pytestCollectArgv(suite) {
    return [...suite.argv, '--collect-only', '-q', ...suite.testPaths];
}
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
export function pytestExecutionArgv(suite, stateDir) {
    const reportPath = join(stateDir, 'diagnostics', `${suite.name}.xml`);
    return [...suite.argv, `--junitxml=${reportPath}`, ...suite.testPaths];
}
/** Matches a `--collect-only -q` output line that is a pytest node id. */
function isNodeIdLine(line) {
    return line.includes('::') && !line.startsWith('=') && !line.startsWith(' ') && !line.startsWith('\t');
}
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
export async function collectPytestSuite(suite, cwd) {
    const argv = pytestCollectArgv(suite);
    const child = spawn(argv[0] ?? '', argv.slice(1), {
        cwd,
        env: untrustedEnv(process.env),
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    const outcome = await new Promise((settle) => {
        let stdout = '';
        let stderr = '';
        let timedOut = false;
        const timer = setTimeout(() => {
            timedOut = true;
            child.kill('SIGKILL');
        }, suite.timeoutMs);
        child.stdout?.on('data', (chunk) => {
            stdout += chunk.toString('utf8');
        });
        child.stderr?.on('data', (chunk) => {
            stderr += chunk.toString('utf8');
        });
        child.once('error', (error) => {
            clearTimeout(timer);
            settle({ code: null, stdout, stderr, timedOut: false, error });
        });
        child.once('exit', (code) => {
            clearTimeout(timer);
            settle({ code, stdout, stderr, timedOut, error: null });
        });
    });
    if (outcome.timedOut) {
        return {
            status: 'unavailable',
            detail: `suite '${suite.name}' collection exceeded its ${String(suite.timeoutMs)}ms timeout and was killed`,
            cases: [],
            collectionErrors: [],
            exitCode: null,
        };
    }
    if (outcome.error !== null) {
        return {
            status: 'unavailable',
            detail: `suite '${suite.name}' collection failed to start (${suite.argv[0] ?? ''}): ${outcome.error.message}`,
            cases: [],
            collectionErrors: [],
            exitCode: null,
        };
    }
    const nodeIds = [...new Set(outcome.stdout
            .split('\n')
            .map((line) => line.trim())
            .filter((line) => isNodeIdLine(line)))].sort();
    const collectionErrors = outcome.code !== 0
        ? [...new Set((outcome.stderr + '\n' + outcome.stdout)
                .split('\n')
                .filter((line) => /ERROR|error/i.test(line))
                .map((line) => line.trim().slice(0, 300)))].sort()
        : [];
    if (nodeIds.length === 0 && (outcome.code !== 0 || collectionErrors.length > 0)) {
        const firstError = collectionErrors[0];
        return {
            status: 'unavailable',
            detail: `suite '${suite.name}' collected no tests (exit ${String(outcome.code)}): ` +
                (firstError !== undefined ? `first error: ${firstError}` : 'no structured output'),
            cases: [],
            collectionErrors,
            exitCode: outcome.code,
        };
    }
    return {
        status: 'discovered',
        detail: `suite '${suite.name}' collection enumerated ${String(nodeIds.length)} case(s) via configured argv`,
        cases: nodeIds.map((nodeId) => {
            const segments = nodeId.split('::');
            return {
                nodeId,
                file: (segments[0] ?? nodeId).split('\\').join('/'),
                titlePath: segments.slice(1),
            };
        }),
        collectionErrors,
        exitCode: outcome.code,
    };
}
/** Typed parser failure for malformed junit XML (fail closed). */
export class JunitParseError extends Error {
    constructor(message) {
        super(message);
        this.name = 'JunitParseError';
    }
}
/**
 * Parses one attr="value" group into a record, tolerating the
 * whitespace separators between attributes. Anything else (unterminated
 * or malformed attributes) throws.
 */
function parseAttributes(text, tagName) {
    const attributes = {};
    const pattern = /([A-Za-z_:][A-Za-z0-9_:.-]*)="([^"]*)"/g;
    const whitespace = /\s*/gy;
    let consumed = 0;
    whitespace.lastIndex = consumed;
    const spaceMatch = whitespace.exec(text);
    if (spaceMatch !== null)
        consumed = whitespace.lastIndex;
    let match;
    while ((match = pattern.exec(text)) !== null) {
        if (match.index !== consumed) {
            throw new JunitParseError(`malformed attribute text in <${tagName}>: '${text.slice(consumed, match.index)}'`);
        }
        attributes[match[1] ?? ''] = match[2] ?? '';
        consumed = pattern.lastIndex;
        whitespace.lastIndex = consumed;
        const trailing = whitespace.exec(text);
        if (trailing !== null)
            consumed = whitespace.lastIndex;
    }
    if (consumed !== text.length) {
        throw new JunitParseError(`malformed attribute text in <${tagName}>: '${text.slice(consumed)}'`);
    }
    return attributes;
}
/**
 * Extracts the inner text of an element body up to the given end tag.
 */
function innerText(xml, from, endTag) {
    const end = xml.indexOf(endTag, from);
    if (end < 0)
        throw new JunitParseError(`missing ${endTag}`);
    return xml.slice(from, end);
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
export function parseJunitXml(xml) {
    // The `<testsuite` literal must not match the `<testsuites>` wrapper
    // pytest emits (the `(?![a-zA-Z])` boundary rejects the `s`), or every
    // real document would fail attribute parsing and look "unparsable".
    // Self-closing empty suite (zero tests) first — the open-tag pattern
    // would otherwise swallow the closing slash into its attribute text.
    const emptyMatch = /<testsuite(?![a-zA-Z])[^>]*?\/>/.exec(xml);
    if (emptyMatch !== null) {
        const attributes = parseAttributes((/<testsuite(?![a-zA-Z])([^>]*?)\/>/.exec(xml)?.[1]) ?? '', 'testsuite');
        return {
            suiteName: attributes['name'] ?? '',
            tests: Number(attributes['tests'] ?? '0'),
            failures: Number(attributes['failures'] ?? '0'),
            errors: Number(attributes['errors'] ?? '0'),
            skipped: Number(attributes['skipped'] ?? '0'),
            cases: [],
        };
    }
    const suiteMatch = /<testsuite(?![a-zA-Z])([^>]*)>/.exec(xml);
    if (suiteMatch === null) {
        throw new JunitParseError('no <testsuite> element found');
    }
    const suiteAttributes = parseAttributes(suiteMatch[1] ?? '', 'testsuite');
    const bodyStart = (suiteMatch.index ?? 0) + suiteMatch[0].length;
    const body = innerText(xml, bodyStart, '</testsuite>');
    const cases = [];
    const casePattern = /<testcase([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g;
    let match;
    while ((match = casePattern.exec(body)) !== null) {
        const attributes = parseAttributes(match[1] ?? '', 'testcase');
        const childXml = match[3];
        let outcome = 'passed';
        let skipType;
        let message;
        if (childXml !== undefined) {
            if (/<failure/.test(childXml)) {
                outcome = 'failed';
                message = firstLineOf(childXml, '<failure');
            }
            else if (/<error/.test(childXml)) {
                outcome = 'error';
                message = firstLineOf(childXml, '<error');
            }
            else if (/<skipped/.test(childXml)) {
                outcome = 'skipped';
                // Lazy capture + optional slash: pytest emits self-closing
                // `<skipped type="..." message="" />`; a greedy `[^>]*` would
                // swallow the trailing `/' and break attribute parsing (which
                // would mark every xfail-bearing report unparsable).
                const skipMatch = /<skipped\b([^>]*?)\/?>/.exec(childXml);
                const skipAttributes = skipMatch === null ? {} : parseAttributes(skipMatch[1] ?? '', 'skipped');
                skipType = skipAttributes['type'];
                message = skipAttributes['message'];
            }
            else {
                throw new JunitParseError(`unsupported <testcase> child content for '${attributes['name'] ?? ''}'`);
            }
        }
        cases.push({
            classname: attributes['classname'] ?? '',
            name: attributes['name'] ?? '',
            outcome,
            ...(skipType !== undefined ? { skipType } : {}),
            ...(message !== undefined ? { message } : {}),
            ...(attributes['file'] !== undefined && attributes['file'] !== '' ? { file: attributes['file'] } : {}),
        });
    }
    return {
        suiteName: suiteAttributes['name'] ?? '',
        tests: Number(suiteAttributes['tests'] ?? String(cases.length)),
        failures: Number(suiteAttributes['failures'] ?? '0'),
        errors: Number(suiteAttributes['errors'] ?? '0'),
        skipped: Number(suiteAttributes['skipped'] ?? '0'),
        cases,
    };
}
/** First-line message of a failure/error child, tag attribute first. */
function firstLineOf(childXml, tag) {
    const match = new RegExp(`${tag}([^>]*)>([\\s\\S]*?)<`).exec(childXml);
    if (match === null)
        return undefined;
    const attributes = parseAttributes(match[1] ?? '', tag.slice(1));
    const text = (attributes['message'] ?? match[2] ?? '').trim();
    return text.length === 0 ? undefined : text.split('\n')[0];
}
/**
 * Repo-relative form of `path` against `cwd` (absolute inputs only by
 * contract; relative pass through normalized).
 */
export function repoRelative(cwd, path) {
    return (isAbsolute(path) ? relative(cwd, path) : path).split('\\').join('/');
}
/**
 * Executes one configured diagnostic suite ONCE (plan Phase 4 item 9, §3.5):
 * an isolated process (default: every `GATEFORGE_*` variable stripped —
 * {@link options.env} overrides this ONLY for the supervised WITNESSED
 * participant, which receives the run-scoped env built by
 * `buildWitnessedPytestChildEnv`), the configured argv + a junit-XML
 * report into the EXCLUDED run-state dir, and a finite timeout. The
 * result is diagnostic data — advisory-only for default suites; a
 * `witnessed: true` suite's outcome additionally blocks the supervised
 * gate (the mapped test's red is never graded green).
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
 *   options: optional `env` — the child environment override. The
 *     advisory path never passes it (byte-identical `untrustedEnv`
 *     stripping); the supervised witnessed participant passes the
 *     run-scoped env so its persistence-intent writes can reach the
 *     trusted drain's spool.
 *
 * Returns:
 *   Promise<DiagnosticRunResult>: the structured diagnostic result.
 */
export async function executePytestSuite(suite, repoRoot, stateDir, options) {
    const reportPath = join(stateDir, 'diagnostics', `${suite.name}.xml`);
    const argv = pytestExecutionArgv(suite, stateDir);
    const base = {
        suite: suite.name,
        status: 'incomplete',
        exitCode: null,
        timedOut: false,
        spawnError: null,
        collectionErrors: [],
        selectedScope: [...suite.testPaths],
        nodeIds: [],
        cases: [],
        counts: { passed: 0, failed: 0, errors: 0, skipped: 0, xfailed: 0 },
        complete: false,
        incompleteDetail: null,
        causes: [],
        reportPath,
        reportExists: existsSync(reportPath),
        reportUnparsable: false,
    };
    const child = spawn(argv[0] ?? '', argv.slice(1), {
        cwd: join(repoRoot, suite.cwd),
        // Advisory default: untrustedEnv strips every GATEFORGE_* name. The
        // witnessed participant override (options.env) is built exclusively
        // by the trusted CLI through buildWitnessedPytestChildEnv — the
        // run-scoped allowlist that never carries the verifier key.
        env: options?.env ?? untrustedEnv(process.env),
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    const outcome = await new Promise((settle) => {
        let stdout = '';
        let stderr = '';
        let timedOut = false;
        const timer = setTimeout(() => {
            timedOut = true;
            child.kill('SIGKILL');
        }, suite.timeoutMs);
        child.stdout?.on('data', (chunk) => {
            stdout += chunk.toString('utf8');
        });
        child.stderr?.on('data', (chunk) => {
            stderr += chunk.toString('utf8');
        });
        child.once('error', (error) => {
            clearTimeout(timer);
            settle({ code: null, signal: null, stdout, stderr, timedOut: false, error });
        });
        child.once('exit', (code, signal) => {
            clearTimeout(timer);
            settle({ code, signal, stdout, stderr, timedOut, error: null });
        });
    });
    if (outcome.timedOut) {
        return {
            ...base,
            timedOut: true,
            incompleteDetail: `suite '${suite.name}' exceeded its ${String(suite.timeoutMs)}ms timeout and was killed — ` +
                'an incomplete diagnostic run never displays as passing',
            causes: ['DIAGNOSTIC_RUN_INCOMPLETE'],
        };
    }
    if (outcome.error !== null) {
        return {
            ...base,
            spawnError: outcome.error.message,
            incompleteDetail: `suite '${suite.name}' could not start (${suite.argv[0] ?? ''}): ${outcome.error.message} — ` +
                'repair the interpreter/configured argv',
            causes: ['DIAGNOSTIC_RUN_INCOMPLETE'],
        };
    }
    const collectionErrors = [...new Set((outcome.stderr + '\n' + outcome.stdout)
            .split('\n')
            .filter((line) => /ERROR|error/i.test(line))
            .map((line) => line.trim().slice(0, 300)))].sort();
    const reportExists = existsSync(reportPath);
    let document = null;
    let reportUnparsable = false;
    if (reportExists) {
        try {
            document = parseJunitXml(readFileSync(reportPath, 'utf8'));
        }
        catch {
            reportUnparsable = true; // fail closed: a malformed report is never a green run
        }
    }
    const cases = [];
    const counts = { passed: 0, failed: 0, errors: 0, skipped: 0, xfailed: 0 };
    const nodeIds = [];
    if (document !== null) {
        for (const testCase of document.cases) {
            const file = caseFileOf(testCase);
            const nodeId = `${file}::${testCase.name}`;
            nodeIds.push(nodeId);
            if (testCase.outcome === 'passed')
                counts.passed += 1;
            else if (testCase.outcome === 'failed')
                counts.failed += 1;
            else if (testCase.outcome === 'error')
                counts.errors += 1;
            else {
                counts.skipped += 1;
                if (testCase.skipType === 'pytest.xfail' || testCase.skipType === 'xfail')
                    counts.xfailed += 1;
            }
            cases.push({
                nodeId,
                outcome: testCase.outcome,
                ...(testCase.skipType !== undefined ? { skipType: testCase.skipType } : {}),
                ...(testCase.message !== undefined ? { message: testCase.message } : {}),
                // pytest junit: collection errors are testcases named
                // `pytest_collection` with an <error> child.
                phase: testCase.name === 'pytest_collection'
                    ? 'collection'
                    : testCase.outcome === 'error'
                        ? 'setup'
                        : testCase.outcome === 'failed'
                            ? 'call'
                            : 'unknown',
            });
        }
    }
    const incompleteDetail = diagnoseIncomplete({
        suiteName: suite.name,
        exitCode: outcome.code,
        signal: outcome.signal,
        document,
        reportExists,
        reportUnparsable,
        collectionErrors,
    });
    const complete = incompleteDetail === null;
    let status;
    let causes = [];
    if (!complete) {
        status = 'incomplete';
        causes = ['DIAGNOSTIC_RUN_INCOMPLETE'];
    }
    else if (counts.failed > 0 || counts.errors > 0) {
        status = 'failures';
        causes = ['DIAGNOSTIC_TEST_FAILURE'];
    }
    else {
        status = 'completed';
    }
    return {
        ...base,
        exitCode: outcome.code,
        collectionErrors,
        nodeIds: [...new Set(nodeIds)].sort(),
        cases,
        counts,
        complete,
        incompleteDetail,
        causes,
        reportExists,
        reportUnparsable,
        status,
    };
}
/**
 * Decides whether a finished diagnostic run is INCOMPLETE (fail closed):
 * unparsable/missing report, nonzero pytest status codes (2 interrupted,
 * 3 internal, 4 usage), exit 5 (no tests collected), zero reported
 * tests, or a run whose cases are ALL skipped/xfail. Returns null when
 * the run honestly completed.
 */
function diagnoseIncomplete(input) {
    if (input.signal !== null) {
        return `suite '${input.suiteName}' was interrupted (${input.signal}) — an unavailable run, never a passing one`;
    }
    if (!input.reportExists) {
        return `suite '${input.suiteName}' produced no junit report — the run cannot be trusted as complete`;
    }
    if (input.reportUnparsable || input.document === null) {
        return `suite '${input.suiteName}' produced an unparsable junit report — fail closed (never read as a green run)`;
    }
    if (input.exitCode === 5) {
        return `suite '${input.suiteName}' collected no tests (pytest exit 5) — a zero-test run is incomplete`;
    }
    if (input.exitCode !== null && input.exitCode >= 2 && input.exitCode !== 5) {
        return `suite '${input.suiteName}' ended with pytest status ${String(input.exitCode)} (interrupted/internal/usage error) — incomplete`;
    }
    if (input.exitCode === null) {
        return `suite '${input.suiteName}' ended without an exit status — incomplete`;
    }
    if (input.document.tests === 0) {
        return `suite '${input.suiteName}' reported zero tests — a zero-test run is incomplete`;
    }
    if (input.document.cases.length > 0 && input.document.cases.every((testCase) => testCase.outcome === 'skipped')) {
        return `suite '${input.suiteName}' ran only skipped/expected-failure cases — nothing executed, so the run is incomplete`;
    }
    if (input.collectionErrors.length > 0 && input.exitCode !== 0 && input.document.cases.length === 0) {
        return `suite '${input.suiteName}' reported collection errors: ${input.collectionErrors[0] ?? ''}`;
    }
    return null;
}
/** Best-effort file part of a junit testcase (file attr, then classname). */
function caseFileOf(testCase) {
    if (testCase.file !== undefined && testCase.file.length > 0)
        return testCase.file;
    if (testCase.classname.length > 0)
        return testCase.classname.split('.').join('/');
    return '';
}
/** Re-export so the adapter module is the single pytest surface. */
export { TestDiscoveryError };
//# sourceMappingURL=pytest-adapter.js.map