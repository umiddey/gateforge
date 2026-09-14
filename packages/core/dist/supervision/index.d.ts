/** A planned instance (the expected set, fixed before the run). */ export interface PlannedInstanceInput {
    /** Stable logical key (§5.2). */
    logicalKey: string;
    /** Runner project, or null when no enumeration bound one. */
    project: string | null;
    /** Repo-relative posix file (the identity join key). */
    file: string;
    /** Full title path (the identity join key). */
    titlePath: readonly string[];
    /** Blocking annotations observed pre-run (`.skip` / `.only` / `.fixme`). */
    blockingAnnotations: readonly string[];
    /** Present when the runner never enumerated this case (static-only row). */
    unenumeratedReason?: string;
}
/** One executed instance outcome (reporter data = input only). */
export interface ExecutedOutcomeInput {
    /** Stable logical key the executed instance resolved to. */
    logicalKey: string;
    /** Runner project, or null when the runner did not report one. */
    project: string | null;
    /** Repo-relative posix file (the identity join key). */
    file: string;
    /** Full title path (the identity join key). */
    titlePath: readonly string[];
    /** Observed outcome on this attempt. */
    status: 'passed' | 'failed' | 'skipped' | 'fixme' | 'not-run';
    /** Attempt number (1 = first attempt; required retries are zero). */
    attempt: number;
    /** True when the instance was an expected failure (never proves behavior). */
    expectedFailure: boolean;
}
/**
 * One witness-recorded session of an expected test (the execution
 * authority, enforcement-review fix 2b). Sessions are minted ONLY by the
 * witness's supervisor channel and sealed at the observed test end, so
 * the suite cannot mint, forge, or unseal one after the fact.
 */
export interface TracedSession {
    /** Witness-issued session id (UUID). */
    sessionId: string;
    /** Witness-monotonic tick at open. */
    openedTick: number;
    /** Witness-monotonic tick at seal (null = never sealed — blocking). */
    sealedTick: number | null;
    /** The outcome the supervisor observed at close (null = unknown). */
    outcome: string | null;
    /**
     * Witness-side activity bound to THIS session (diagnostic only): the
     * number of session-bound observations the witness itself made —
     * ledger records issued under the session, recorded UI-action
     * intervals, and engine-observed proxy exchanges attributed to the
     * session. This count is CORROBORATION, never a gate: execution
     * authority is the supervisor-observed lifecycle itself (trusted
     * reporter channel over the exact expected set), because a genuine
     * passing test that never touches the witness is still executed, and
     * a fabricated session with activity is still fabricated. Only the
     * witness can produce this count.
     */
    activity: number;
}
/** The witness-side session trace for ONE expected test. */
export interface TracedTest {
    /** The runner-assigned id the session was opened under (diagnostic). */
    testId: string | null;
    /** Registered runner project (the expected-set identity join key). */
    project: string | null;
    /** Registered repo-relative posix file (the identity join key). */
    file: string;
    /** Registered full title path (the identity join key). */
    titlePath: readonly string[];
    /** Every session the witness recorded for this expected test. */
    sessions: readonly TracedSession[];
}
/** The structured execution envelope the supervised adapter returns. */
export interface SupervisionEnvelopeInput {
    /** Framework process exit code (supplementary, never decisive). */
    processExit: number | null;
    /** Whether the adapter itself judged the run complete. */
    complete: boolean;
    /** Single-cause detail when the adapter judged the run incomplete. */
    incompleteDetail?: string;
    /** Executed instance outcomes (multiset: one row per project instance). */
    outcomes: readonly ExecutedOutcomeInput[];
    /** Setup/teardown/runner-body outcome observed by the supervisor. */
    fixtureOutcome: 'passed' | 'failed' | 'unknown';
    /** Shard verification, or null when the runner reports none. */
    shards: {
        complete: boolean;
        detail: string;
    } | null;
    /** True when a retry-assisted execution was detected (config or attempts). */
    retriesDetected: boolean;
    /** Detail describing the retry detection (when detected). */
    retriesDetail?: string;
    /**
     * The witness-side session trace (enforcement-review fix 2b) — the
     * EXECUTION AUTHORITY. Three states:
     * - `undefined`: no trace was supplied (no witness wired); grading
     *   falls back to the runner-reported outcomes (test seam only — the
     *   supervised CLI always supplies a trace).
     * - `null`: the witness was wired but the trace could not be fetched —
     *   fail closed with a typed RUN_INCOMPLETE (a missing authority is
     *   never success).
     * - an array: the authority; every expected test must have sealed
     *   passing session(s) and every traced test must be in the expected
     *   set, regardless of what the runner-reported outcomes claim.
     */
    sessionTrace?: readonly TracedTest[] | null;
}
/** One typed supervision finding (plan §5.4 run rows). */
export interface SupervisionFinding {
    /** Stable cause code. */
    cause: 'TEST_NOT_EXECUTED' | 'TEST_FAILED' | 'RUN_INCOMPLETE';
    /** Single-cause human explanation. */
    detail: string;
    /** The logical key the finding is scoped to, or null for run-scoped. */
    logicalKey: string | null;
}
/** The supervision verdict for one run. */
export interface SupervisionResult {
    /** True only when the complete expected set passed on first attempts. */
    complete: boolean;
    /** Typed findings (empty only when complete). */
    findings: SupervisionFinding[];
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
export declare function superviseExecution(planned: readonly PlannedInstanceInput[], envelope: SupervisionEnvelopeInput): SupervisionResult;
/** Domain tag separating expected-set (enumeration) digests from every other hash. */
export declare const ENUMERATION_DOMAIN = "gateforge.enumeration.v1";
/** One expected test registered with the witness before the run. */
export interface ExpectedTestInput {
    /** The runner-assigned test id when enumeration bound one (diagnostic). */
    testId?: string | null;
    /** Runner project, or null when the runner reports none. */
    project: string | null;
    /** Repo-relative posix file (the identity join key). */
    file: string;
    /** Full title path (the identity join key). */
    titlePath: readonly string[];
}
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
export declare function enumerationDigestOf(tests: readonly ExpectedTestInput[]): string;
//# sourceMappingURL=index.d.ts.map