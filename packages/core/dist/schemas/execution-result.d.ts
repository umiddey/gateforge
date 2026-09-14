/**
 * Execution-result record (plan 2026-09-13 §5.1 row "Execution result",
 * Phase 4 work item 3, ADR 0005 D2): the trusted supervisor's OWN account
 * of a run — planned versus executed instances, per-instance outcomes and
 * attempts, runner exit, fixture/teardown outcome, shard completeness,
 * selection + catalog digests, trusted policy digest, engine versions,
 * and environment identity.
 *
 * Trust boundary (ADR 0005 D2): the suite reporter is INPUT, never
 * signature authority. This record is written by trusted supervision
 * under the excluded run-state directory; its digest (see
 * {@link executionResultDigestOf}) is what the gate receipt binds —
 * never a reporter aggregate. `outcomes` rows are supervision-normalized
 * data, not the reporter's own summary.
 */
import { z } from 'zod';
/** Domain tag separating execution-result digests from every other hash. */
export declare const EXECUTION_RESULT_DOMAIN = "gateforge.execution-result.v1";
/** Domain tag separating selection digests from every other hash. */
export declare const SELECTION_DOMAIN = "gateforge.selection.v1";
/** One planned instance (fixed BEFORE the run; ADR 0005 D2). */
export declare const PlannedInstanceSchema: z.ZodObject<{
    logicalKey: z.ZodString;
    project: z.ZodNullable<z.ZodString>;
    file: z.ZodString;
    titlePath: z.ZodArray<z.ZodString>;
    frameworkId: z.ZodNullable<z.ZodString>;
}, z.core.$strict>;
/** Inferred planned-instance shape. */
export type PlannedInstance = z.infer<typeof PlannedInstanceSchema>;
/** Per-instance execution status the supervisor accepts from the runner. */
export declare const InstanceStatusSchema: z.ZodEnum<{
    fixme: "fixme";
    passed: "passed";
    failed: "failed";
    skipped: "skipped";
    "not-run": "not-run";
}>;
/** Inferred instance-status shape. */
export type InstanceStatus = z.infer<typeof InstanceStatusSchema>;
/** One executed instance outcome (supervision-normalized; input only). */
export declare const ExecutedOutcomeSchema: z.ZodObject<{
    logicalKey: z.ZodString;
    project: z.ZodNullable<z.ZodString>;
    file: z.ZodString;
    titlePath: z.ZodArray<z.ZodString>;
    status: z.ZodEnum<{
        fixme: "fixme";
        passed: "passed";
        failed: "failed";
        skipped: "skipped";
        "not-run": "not-run";
    }>;
    attempt: z.ZodNumber;
    expectedFailure: z.ZodBoolean;
}, z.core.$strict>;
/** Inferred executed-outcome shape. */
export type ExecutedOutcome = z.infer<typeof ExecutedOutcomeSchema>;
/** One typed supervision finding (plan §5.4 run rows). */
export declare const SupervisionFindingSchema: z.ZodObject<{
    cause: z.ZodEnum<{
        TEST_NOT_EXECUTED: "TEST_NOT_EXECUTED";
        TEST_FAILED: "TEST_FAILED";
        RUN_INCOMPLETE: "RUN_INCOMPLETE";
    }>;
    detail: z.ZodString;
    logicalKey: z.ZodNullable<z.ZodString>;
}, z.core.$strict>;
/** Inferred supervision-finding shape. */
export type SupervisionFinding = z.infer<typeof SupervisionFindingSchema>;
/** One witness-recorded session of an expected test (execution authority). */
export declare const TracedSessionSchema: z.ZodObject<{
    sessionId: z.ZodString;
    openedTick: z.ZodNumber;
    sealedTick: z.ZodNullable<z.ZodNumber>;
    outcome: z.ZodNullable<z.ZodString>;
    activity: z.ZodNumber;
}, z.core.$strict>;
/** Inferred traced-session shape. */
export type TracedSession = z.infer<typeof TracedSessionSchema>;
/** The witness-side session trace for ONE expected test. */
export declare const TracedTestSchema: z.ZodObject<{
    testId: z.ZodNullable<z.ZodString>;
    project: z.ZodNullable<z.ZodString>;
    file: z.ZodString;
    titlePath: z.ZodArray<z.ZodString>;
    sessions: z.ZodArray<z.ZodObject<{
        sessionId: z.ZodString;
        openedTick: z.ZodNumber;
        sealedTick: z.ZodNullable<z.ZodNumber>;
        outcome: z.ZodNullable<z.ZodString>;
        activity: z.ZodNumber;
    }, z.core.$strict>>;
}, z.core.$strict>;
/** Inferred traced-test shape. */
export type TracedTest = z.infer<typeof TracedTestSchema>;
/**
 * The sealed execution result. Strict: unknown keys are rejected so a
 * hostile run-state edit cannot smuggle extra authority in.
 */
export declare const ExecutionResultSchema: z.ZodObject<{
    schemaVersion: z.ZodLiteral<1>;
    runId: z.ZodString;
    invocationId: z.ZodString;
    inputDigest: z.ZodString;
    trustedPolicyDigest: z.ZodString;
    selection: z.ZodObject<{
        runner: z.ZodString;
        mode: z.ZodEnum<{
            "full-relevant-suite": "full-relevant-suite";
            "mapped-selection": "mapped-selection";
        }>;
        logicalKeys: z.ZodArray<z.ZodString>;
    }, z.core.$strict>;
    selectionDigest: z.ZodString;
    catalogDigest: z.ZodString;
    planned: z.ZodArray<z.ZodObject<{
        logicalKey: z.ZodString;
        project: z.ZodNullable<z.ZodString>;
        file: z.ZodString;
        titlePath: z.ZodArray<z.ZodString>;
        frameworkId: z.ZodNullable<z.ZodString>;
    }, z.core.$strict>>;
    outcomes: z.ZodArray<z.ZodObject<{
        logicalKey: z.ZodString;
        project: z.ZodNullable<z.ZodString>;
        file: z.ZodString;
        titlePath: z.ZodArray<z.ZodString>;
        status: z.ZodEnum<{
            fixme: "fixme";
            passed: "passed";
            failed: "failed";
            skipped: "skipped";
            "not-run": "not-run";
        }>;
        attempt: z.ZodNumber;
        expectedFailure: z.ZodBoolean;
    }, z.core.$strict>>;
    enumerationDigest: z.ZodOptional<z.ZodString>;
    sessionTrace: z.ZodOptional<z.ZodArray<z.ZodObject<{
        testId: z.ZodNullable<z.ZodString>;
        project: z.ZodNullable<z.ZodString>;
        file: z.ZodString;
        titlePath: z.ZodArray<z.ZodString>;
        sessions: z.ZodArray<z.ZodObject<{
            sessionId: z.ZodString;
            openedTick: z.ZodNumber;
            sealedTick: z.ZodNullable<z.ZodNumber>;
            outcome: z.ZodNullable<z.ZodString>;
            activity: z.ZodNumber;
        }, z.core.$strict>>;
    }, z.core.$strict>>>;
    runnerExit: z.ZodNullable<z.ZodNumber>;
    complete: z.ZodBoolean;
    causes: z.ZodArray<z.ZodObject<{
        cause: z.ZodEnum<{
            TEST_NOT_EXECUTED: "TEST_NOT_EXECUTED";
            TEST_FAILED: "TEST_FAILED";
            RUN_INCOMPLETE: "RUN_INCOMPLETE";
        }>;
        detail: z.ZodString;
        logicalKey: z.ZodNullable<z.ZodString>;
    }, z.core.$strict>>;
    fixtureOutcome: z.ZodEnum<{
        unknown: "unknown";
        passed: "passed";
        failed: "failed";
    }>;
    shardCompleteness: z.ZodObject<{
        complete: z.ZodBoolean;
        detail: z.ZodString;
    }, z.core.$strict>;
    maxAttemptObserved: z.ZodNumber;
    engines: z.ZodRecord<z.ZodString, z.ZodString>;
    browsers: z.ZodRecord<z.ZodString, z.ZodString>;
    environmentIdentity: z.ZodString;
    startedAt: z.ZodString;
    finishedAt: z.ZodString;
}, z.core.$strict>;
/** Inferred execution-result shape. */
export type ExecutionResult = z.infer<typeof ExecutionResultSchema>;
/**
 * Computes the domain-separated digest of an execution result (plan §5.1:
 * the receipt binds THIS digest, never a reporter aggregate). The digest
 * covers every field except the `causes`-vs-`complete` consistency check
 * (which is structural, not content).
 *
 * Args:
 *   result: a validated execution result.
 *
 * Returns:
 *   string: 64-char lowercase hex digest.
 *
 * Throws:
 *   TypeError: when the result contains non-JSON-representable values.
 */
export declare function executionResultDigestOf(result: ExecutionResult): string;
/**
 * Computes the domain-separated selection digest (plan Phase 4 item 3:
 * the expected test set is hashed BEFORE the run so a receipt binds the
 * exact selection, and any selection change forces a fresh run).
 *
 * Args:
 *   selection: the runner, mode, and logical keys selected.
 *
 * Returns:
 *   string: 64-char lowercase hex digest.
 */
export declare function selectionDigestOf(selection: {
    runner: string;
    mode: 'full-relevant-suite' | 'mapped-selection';
    logicalKeys: readonly string[];
}): string;
//# sourceMappingURL=execution-result.d.ts.map