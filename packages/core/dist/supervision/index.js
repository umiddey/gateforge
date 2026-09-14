/**
 * Trusted runner supervision — expected-set enforcement (plan
 * 2026-09-13 Phase 4 work item 4, ADR 0005 D2). The supervisor fixes the
 * expected test set BEFORE the run (from resolved mappings/catalog
 * selection) and compares planned versus executed instances after it.
 * Suite reporter data is INPUT here, never signature authority: a suite
 * that writes its own report cannot shrink its expected set, hide a
 * skip, or turn an incomplete shard into success.
 *
 * Every problem becomes a typed finding with a plan §5.4 run cause —
 * `TEST_NOT_EXECUTED` / `TEST_FAILED` / `RUN_INCOMPLETE` — and any
 * finding fails the whole run (§3.3 rule 5): there is no selective
 * pass out of a failed required suite.
 *
 * Execution authority (enforcement-review fix 2): the runner-reported
 * outcomes document is suite-writable and is therefore DEMOTED to detail
 * input. When the supervisor supplies a witness-side `sessionTrace` (the
 * signing authority's own record of which expected tests opened exactly
 * one or more sealed sessions, and with which outcomes), supervision
 * grades completeness from it: every expected test must have at least one
 * SEALED session whose outcome is 'passed' (parameterized instances of one
 * expected test produce one session per executed instance; every one of
 * them must seal passed), no session may remain unsealed, and every traced
 * test must belong to the expected set. A trace that could not be fetched
 * (`sessionTrace: null`) blocks the run outright — a missing authority is
 * never graded as success.
 *
 * Pure and deterministic: identical inputs produce identical findings in
 * identical order.
 */
import { compareStrings } from '../graph/util.js';
import { sha256Canonical } from '../canonical-json.js';
/** Identity key for planned/executed matching: project + file + titlePath. */
function instanceKey(project, file, titlePath) {
    return `${project ?? '-'}\u0000${file}\u0000${titlePath.join('>')}`;
}
/**
 * Enforces the expected test set (ADR 0005 D2). Findings cover, in
 * deterministic order: zero selected tests, `.only`/`.skip`/`.fixme` in
 * the required selection, cases the runner never enumerated, retry-
 * assisted execution, planned instances that never executed, unexpected
 * executed instances outside the expected set, failed instances,
 * expected failures, skipped/fixme outcomes, teardown/fixture failures,
 * shard incompleteness, adapter-judged incompleteness, and a nonzero
 * runner exit. All are blocking; `complete` is true only when none fired.
 *
 * Args:
 *   planned: the expected set fixed BEFORE the run.
 *   envelope: the structured execution envelope (input only).
 *
 * Returns:
 *   SupervisionResult: complete flag plus typed findings.
 */
export function superviseExecution(planned, envelope) {
    const findings = [];
    // Zero selected tests is never a clean run (plan Phase 4 acceptance:
    // "no-tests case"). Nothing executed means nothing is proven.
    if (planned.length === 0) {
        findings.push({
            cause: 'TEST_NOT_EXECUTED',
            detail: 'the required selection contains zero tests — an empty run never proves coverage (run or repair the selected suite)',
            logicalKey: null,
        });
    }
    // Pre-run annotations: `.only`/`.skip`/`.fixme` inside the required
    // selection block outright — required retries are zero and required
    // skips do not exist (plan §3.3 rule 5, E08).
    for (const instance of planned) {
        for (const annotation of instance.blockingAnnotations) {
            findings.push({
                cause: 'TEST_NOT_EXECUTED',
                detail: `required selection carries a '${annotation}' annotation on '${instance.logicalKey}' ` +
                    '(`.${annotation}` in a required run is blocking — remove it or drop the case from the required suite)',
                logicalKey: instance.logicalKey,
            });
        }
        if (instance.unenumeratedReason !== undefined) {
            findings.push({
                cause: 'RUN_INCOMPLETE',
                detail: `the runner did not enumerate required case '${instance.logicalKey}' ` +
                    `(${instance.unenumeratedReason}) — the expected set cannot be sealed over an unenumerable case`,
                logicalKey: instance.logicalKey,
            });
        }
    }
    // Retry-assisted execution: required retries are zero. Any attempt
    // above the first invalidates the run regardless of outcome (E08).
    if (envelope.retriesDetected) {
        findings.push({
            cause: 'RUN_INCOMPLETE',
            detail: `retry-assisted execution detected${envelope.retriesDetail !== undefined ? ` (${envelope.retriesDetail})` : ''} — ` +
                'required retries are zero; only first-attempt outcomes prove behavior (plan §3.3 rule 3)',
            logicalKey: null,
        });
    }
    // Planned versus executed: multiset comparison by instance identity
    // (project + file + titlePath). Reporter rows cannot shrink the set:
    // every planned instance must appear, and nothing outside it may run.
    const plannedByKey = new Map();
    for (const instance of planned) {
        const key = instanceKey(instance.project, instance.file, instance.titlePath);
        plannedByKey.set(key, instance);
    }
    const executedByLogicalKey = new Map();
    for (const outcome of envelope.outcomes) {
        const list = executedByLogicalKey.get(outcome.logicalKey) ?? [];
        list.push(outcome);
        executedByLogicalKey.set(outcome.logicalKey, list);
    }
    const executedKeys = new Set();
    for (const outcome of envelope.outcomes) {
        executedKeys.add(instanceKey(outcome.project, outcome.file, outcome.titlePath));
    }
    for (const instance of planned) {
        const key = instanceKey(instance.project, instance.file, instance.titlePath);
        if (!executedKeys.has(key)) {
            findings.push({
                cause: 'RUN_INCOMPLETE',
                detail: `planned instance '${instance.logicalKey}' never executed — a missing selected case blocks the run (plan §3.3 rule 5)`,
                logicalKey: instance.logicalKey,
            });
        }
    }
    for (const outcome of envelope.outcomes) {
        const key = instanceKey(outcome.project, outcome.file, outcome.titlePath);
        if (!plannedByKey.has(key)) {
            findings.push({
                cause: 'RUN_INCOMPLETE',
                detail: `executed instance '${outcome.logicalKey}' is outside the planned expected set — ` +
                    'selective narrowing of the required suite is prohibited (no selective pass out of a failed suite)',
                logicalKey: outcome.logicalKey,
            });
        }
    }
    // Per-instance outcomes: every non-pass, every expected failure, and
    // every skip is a typed block (E07/E08). Attempts are supervision
    // property too — any attempt above the first is retry-assisted even if
    // the adapter failed to raise its own flag (fail closed, D2).
    for (const outcome of envelope.outcomes) {
        if (outcome.attempt > 1) {
            findings.push({
                cause: 'RUN_INCOMPLETE',
                detail: `instance '${outcome.logicalKey}' executed on attempt ${String(outcome.attempt)} — ` +
                    'retry-assisted execution is prohibited (required retries are zero; plan §3.3 rule 3)',
                logicalKey: outcome.logicalKey,
            });
        }
        if (outcome.status === 'failed' && !outcome.expectedFailure) {
            findings.push({
                cause: 'TEST_FAILED',
                detail: `instance '${outcome.logicalKey}' failed on attempt ${String(outcome.attempt)} — the whole run fails (plan §3.3 rule 5)`,
                logicalKey: outcome.logicalKey,
            });
            continue;
        }
        if (outcome.expectedFailure) {
            findings.push({
                cause: 'TEST_NOT_EXECUTED',
                detail: `instance '${outcome.logicalKey}' is an expected failure — an expected-failure exemption never proves behavior (plan §3.3 rule 3)`,
                logicalKey: outcome.logicalKey,
            });
            continue;
        }
        if (outcome.status === 'skipped' || outcome.status === 'fixme' || outcome.status === 'not-run') {
            findings.push({
                cause: 'TEST_NOT_EXECUTED',
                detail: `instance '${outcome.logicalKey}' did not execute (status '${outcome.status}') — a skip is never coverage`,
                logicalKey: outcome.logicalKey,
            });
        }
    }
    // Setup/teardown/runner-body failures (E07 teardown leg).
    if (envelope.fixtureOutcome !== 'passed') {
        findings.push({
            cause: 'RUN_INCOMPLETE',
            detail: envelope.fixtureOutcome === 'failed'
                ? 'the run did not end successfully: a setup, teardown, or runner-level error was observed — fixtures and teardown must pass too (plan §3.3 rule 5)'
                : 'the run did not report a final fixture/teardown outcome (crash or lost reporter contact) — fail closed',
            logicalKey: null,
        });
    }
    // Shard completeness (E12 incomplete-shard leg).
    if (envelope.shards !== null && !envelope.shards.complete) {
        findings.push({
            cause: 'RUN_INCOMPLETE',
            detail: `incomplete shards: ${envelope.shards.detail} — a partial shard run cannot certify the expected set`,
            logicalKey: null,
        });
    }
    // The adapter's own completeness judgment (timeouts, crashes, lost
    // reporter data).
    if (!envelope.complete) {
        findings.push({
            cause: 'RUN_INCOMPLETE',
            detail: envelope.incompleteDetail !== undefined && envelope.incompleteDetail.length > 0
                ? envelope.incompleteDetail
                : 'the supervised run did not complete (no detail reported) — fail closed',
            logicalKey: null,
        });
    }
    // Runner process exit: supplementary, but nonzero is never clean.
    if (envelope.processExit !== null && envelope.processExit !== 0) {
        findings.push({
            cause: 'RUN_INCOMPLETE',
            detail: `runner process exited with status ${String(envelope.processExit)} — a failed runner never reports a green gate`,
            logicalKey: null,
        });
    }
    // Execution authority (enforcement-review fix 2b): when a witness-side
    // session trace was supplied, the runner-reported outcomes are detail
    // input only — completeness is graded from the trace. A fabricated or
    // absent outcomes document cannot manufacture execution that the
    // witness never recorded, and a trace the supervisor could not fetch
    // blocks outright (fail closed).
    if (envelope.sessionTrace !== undefined) {
        findings.push(...gradeSessionTrace(planned, envelope.sessionTrace));
    }
    findings.sort((a, b) => compareStrings(a.cause, b.cause) ||
        compareStrings(a.logicalKey ?? '', b.logicalKey ?? '') ||
        compareStrings(a.detail, b.detail));
    return { complete: findings.length === 0, findings };
}
/** Identity key shared by planned instances and traced tests. */
function traceKey(project, file, titlePath) {
    return `${project ?? '-'}\u0000${file}\u0000${titlePath.join('>')}`;
}
/**
 * Grades the witness-side session trace against the expected set (the
 * typed core of enforcement-review fix 2). Deterministic findings, in a
 * stable order:
 * - a `null` trace (witness wired, trace unfetchable) blocks the run;
 * - every expected test must have at least one SEALED session whose
 *   outcome is 'passed' — zero sessions yields the review's exact
 *   'has no sealed session' cause, an unsealed session or a non-passed
 *   outcome blocks with its own precise detail;
 * - every traced test must belong to the expected set (a session for an
 *   unregistered test cannot hide outside supervision).
 *
 * Args:
 *   planned: the expected set fixed BEFORE the run.
 *   trace: the witness-side trace (array), or null when unavailable.
 *
 * Returns:
 *   SupervisionFinding[]: the trace-derived findings (possibly empty).
 */
function gradeSessionTrace(planned, trace) {
    if (trace === null) {
        return [
            {
                cause: 'RUN_INCOMPLETE',
                detail: 'the witness-side execution trace is unavailable — the session record is the execution ' +
                    'authority and a run without it is never graded complete (fail closed)',
                logicalKey: null,
            },
        ];
    }
    const findings = [];
    const tracedByKey = new Map();
    for (const traced of trace) {
        tracedByKey.set(traceKey(traced.project, traced.file, traced.titlePath), traced);
    }
    const plannedKeys = new Set();
    for (const instance of planned) {
        const key = traceKey(instance.project, instance.file, instance.titlePath);
        plannedKeys.add(key);
        const traced = tracedByKey.get(key);
        if (traced === undefined) {
            findings.push({
                cause: 'RUN_INCOMPLETE',
                detail: `expected test '${instance.logicalKey}' has no sealed session in the witness trace — ` +
                    'the witness-side session record is the execution authority; a passing runner-reported ' +
                    'outcome without a supervisor-sealed session never proves execution',
                logicalKey: instance.logicalKey,
            });
            continue;
        }
        if (traced.sessions.length === 0) {
            findings.push({
                cause: 'RUN_INCOMPLETE',
                detail: `expected test '${instance.logicalKey}' has no sealed session — the witness recorded ` +
                    'no supervisor-opened session for it, so no execution of it is proven',
                logicalKey: instance.logicalKey,
            });
            continue;
        }
        for (const session of traced.sessions) {
            if (session.sealedTick === null) {
                findings.push({
                    cause: 'RUN_INCOMPLETE',
                    detail: `expected test '${instance.logicalKey}' has an unsealed session (${session.sessionId}) — ` +
                        'a session the supervisor never closed proves no completed execution',
                    logicalKey: instance.logicalKey,
                });
                continue;
            }
            if (session.outcome !== 'passed') {
                findings.push({
                    cause: 'RUN_INCOMPLETE',
                    detail: `expected test '${instance.logicalKey}' sealed session (${session.sessionId}) with ` +
                        `outcome '${String(session.outcome ?? 'unknown')}' — only sealed passed sessions prove execution`,
                    logicalKey: instance.logicalKey,
                });
                continue;
            }
            // No activity requirement here (execution-authority fix): a
            // genuine passing test that never touches the witness still
            // executed — the supervisor observed its begin/end through the
            // trusted reporter channel. Session fabrication is defeated at
            // the channel (trusted-config synthesis + unknown run-state
            // paths + lifecycle-conflict detection), not by counting.
        }
    }
    for (const [key, traced] of tracedByKey) {
        if (!plannedKeys.has(key)) {
            findings.push({
                cause: 'RUN_INCOMPLETE',
                detail: `the witness recorded session(s) for a test outside the expected set ` +
                    `(${traced.file}#${traced.titlePath.join('>')}) — sessions are minted only for the ` +
                    'registered expected tests; an unregistered trace entry blocks the run',
                logicalKey: null,
            });
        }
    }
    findings.sort((a, b) => compareStrings(a.logicalKey ?? '', b.logicalKey ?? '') ||
        compareStrings(a.detail, b.detail));
    return findings;
}
/** Domain tag separating expected-set (enumeration) digests from every other hash. */
export const ENUMERATION_DOMAIN = 'gateforge.enumeration.v1';
/**
 * Computes the domain-separated enumeration digest over the expected set
 * registered with the witness BEFORE the run (enforcement-review fix 2d):
 * the execution result binds this digest so a receipt names the exact
 * expected set the witness enforced.
 *
 * Args:
 *   tests: the expected tests (sorted/deduplicated by this function).
 *
 * Returns:
 *   string: 64-char lowercase hex digest.
 */
export function enumerationDigestOf(tests) {
    const normalized = [...tests]
        .map((test) => ({
        project: test.project,
        file: test.file,
        titlePath: [...test.titlePath],
    }))
        .sort((a, b) => compareStrings(a.project ?? '', b.project ?? '') ||
        compareStrings(a.file, b.file) ||
        compareStrings(a.titlePath.join('>'), b.titlePath.join('>')));
    return sha256Canonical({ domain: ENUMERATION_DOMAIN, tests: normalized });
}
//# sourceMappingURL=index.js.map