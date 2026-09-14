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
import { SchemaVersionField } from './common.js';
import { sha256Canonical } from '../canonical-json.js';

/** Domain tag separating execution-result digests from every other hash. */
export const EXECUTION_RESULT_DOMAIN = 'gateforge.execution-result.v1';

/** Domain tag separating selection digests from every other hash. */
export const SELECTION_DOMAIN = 'gateforge.selection.v1';

/** Hex pattern shared by every 64-char lowercase digest field. */
const HEX64 = /^[0-9a-f]{64}$/;

/** One planned instance (fixed BEFORE the run; ADR 0005 D2). */
export const PlannedInstanceSchema = z
  .object({
    /** Stable logical key (§5.2). */
    logicalKey: z.string().min(1),
    /** Runner project, or null when no enumeration bound one. */
    project: z.string().min(1).nullable(),
    /** Repo-relative posix file. */
    file: z.string().min(1),
    /** Full title path (describe stack, then the test title). */
    titlePath: z.array(z.string().min(1)).min(1),
    /** The framework's own instance id, or null when unbound. */
    frameworkId: z.string().nullable(),
  })
  .strict();

/** Inferred planned-instance shape. */
export type PlannedInstance = z.infer<typeof PlannedInstanceSchema>;

/** Per-instance execution status the supervisor accepts from the runner. */
export const InstanceStatusSchema = z.enum(['passed', 'failed', 'skipped', 'fixme', 'not-run']);

/** Inferred instance-status shape. */
export type InstanceStatus = z.infer<typeof InstanceStatusSchema>;

/** One executed instance outcome (supervision-normalized; input only). */
export const ExecutedOutcomeSchema = z
  .object({
    /** Stable logical key the executed instance resolved to. */
    logicalKey: z.string().min(1),
    /** Runner project, or null when the runner did not report one. */
    project: z.string().nullable(),
    /** Repo-relative posix file (the instance identity join key). */
    file: z.string().min(1),
    /** Full title path (the instance identity join key). */
    titlePath: z.array(z.string().min(1)),
    /** Observed outcome on this attempt. */
    status: InstanceStatusSchema,
    /** Attempt number (1 = first attempt; required retries stay zero). */
    attempt: z.number().int().min(1),
    /** True when the instance was an expected failure (never proves behavior). */
    expectedFailure: z.boolean(),
  })
  .strict();

/** Inferred executed-outcome shape. */
export type ExecutedOutcome = z.infer<typeof ExecutedOutcomeSchema>;

/** One typed supervision finding (plan §5.4 run rows). */
export const SupervisionFindingSchema = z
  .object({
    /** Stable cause code (TEST_NOT_EXECUTED / TEST_FAILED / RUN_INCOMPLETE). */
    cause: z.enum(['TEST_NOT_EXECUTED', 'TEST_FAILED', 'RUN_INCOMPLETE']),
    /** Single-cause human explanation (instance-scoped when known). */
    detail: z.string().min(1),
    /** The logical key the finding is scoped to, or null for run-scoped. */
    logicalKey: z.string().nullable(),
  })
  .strict();

/** Inferred supervision-finding shape. */
export type SupervisionFinding = z.infer<typeof SupervisionFindingSchema>;

/** One witness-recorded session of an expected test (execution authority). */
export const TracedSessionSchema = z
  .object({
    /** Witness-issued session id (UUID). */
    sessionId: z.string().min(1),
    /** Witness-monotonic tick at open. */
    openedTick: z.number().int().min(0),
    /** Witness-monotonic tick at seal (null = never sealed — blocking). */
    sealedTick: z.number().int().min(0).nullable(),
    /** The outcome the supervisor observed at close (null = unknown). */
    outcome: z.string().nullable(),
    /**
     * Witness-side activity bound to the session (review recheck fix
     * 2026-09-14): records issued under the session + recorded intervals
     * + engine-observed exchanges. A sealed-passed session with zero
     * activity blocks supervision (fabricated-lifecycle signature).
     */
    activity: z.number().int().min(0),
  })
  .strict();

/** Inferred traced-session shape. */
export type TracedSession = z.infer<typeof TracedSessionSchema>;

/** The witness-side session trace for ONE expected test. */
export const TracedTestSchema = z
  .object({
    /** The runner-assigned id the session was opened under (diagnostic). */
    testId: z.string().min(1).nullable(),
    /** Registered runner project (the expected-set identity join key). */
    project: z.string().min(1).nullable(),
    /** Registered repo-relative posix file (the identity join key). */
    file: z.string().min(1),
    /** Registered full title path (the identity join key). */
    titlePath: z.array(z.string().min(1)).min(1),
    /** Every session the witness recorded for this expected test. */
    sessions: z.array(TracedSessionSchema),
  })
  .strict();

/** Inferred traced-test shape. */
export type TracedTest = z.infer<typeof TracedTestSchema>;

/**
 * The sealed execution result. Strict: unknown keys are rejected so a
 * hostile run-state edit cannot smuggle extra authority in.
 */
export const ExecutionResultSchema = z
  .object({
    schemaVersion: SchemaVersionField,
    /** Run manifest identity the execution belongs to. */
    runId: z.string().uuid(),
    /** Fresh trusted invocation identity of the supervising run. */
    invocationId: z.string().uuid(),
    /** 64-hex digest of the canonical input snapshot this run tested. */
    inputDigest: z.string().regex(HEX64, 'inputDigest must be 64-char lowercase hex'),
    /** 64-hex trusted policy/config revision digest (ADR 0005 D6). */
    trustedPolicyDigest: z.string().regex(HEX64, 'trustedPolicyDigest must be 64-char lowercase hex'),
    /** The selection the supervisor fixed BEFORE the run. */
    selection: z
      .object({
        /** Runner the selection executes under. */
        runner: z.string().min(1),
        /** Selection mode; `full-relevant-suite` until narrower selection is proven safe. */
        mode: z.enum(['full-relevant-suite', 'mapped-selection']),
        /** Exact logical keys the run was expected to cover (sorted). */
        logicalKeys: z.array(z.string().min(1)),
      })
      .strict(),
    /** 64-hex digest binding the selection (domain-separated). */
    selectionDigest: z.string().regex(HEX64, 'selectionDigest must be 64-char lowercase hex'),
    /** 64-hex digest of the catalog the selection was planned from. */
    catalogDigest: z.string().regex(HEX64, 'catalogDigest must be 64-char lowercase hex'),
    /** The planned instances (the expected test set, fixed pre-run). */
    planned: z.array(PlannedInstanceSchema),
    /** The executed instance outcomes (reporter data = input only). */
    outcomes: z.array(ExecutedOutcomeSchema),
    /**
     * 64-hex digest over the expected set the witness registered BEFORE
     * the run (enforcement-review fix 2d; additive). Present only when
     * the supervisor registered an expected set with the witness.
     */
    enumerationDigest: z.string().regex(HEX64).optional(),
    /**
     * The witness-side per-test session trace (enforcement-review fix 2d;
     * additive): sessionIds + outcomes per expected test, so receipts
     * bind the CORROBORATED execution trace — not just the runner's own
     * account. Present only when the supervisor fetched it.
     */
    sessionTrace: z.array(TracedTestSchema).optional(),
    /** Framework process exit code (supplementary, never decisive). */
    runnerExit: z.number().int().nullable(),
    /** Supervision verdict: true only when the complete expected set passed. */
    complete: z.boolean(),
    /** Typed findings (empty only when complete). */
    causes: z.array(SupervisionFindingSchema),
    /** Setup/teardown/runner-body outcome the supervisor observed. */
    fixtureOutcome: z.enum(['passed', 'failed', 'unknown']),
    /** Shard completeness the supervisor verified. */
    shardCompleteness: z
      .object({
        /** True only when every expected shard ran. */
        complete: z.boolean(),
        /** Single-cause detail when incomplete. */
        detail: z.string(),
      })
      .strict(),
    /** Highest attempt number observed (must be 1 — required retries are zero). */
    maxAttemptObserved: z.number().int().min(1),
    /** Engine/runtime versions the supervisor captured (honest subset). */
    engines: z.record(z.string().min(1), z.string()),
    /** Browser versions when the runner reports them (may be empty). */
    browsers: z.record(z.string().min(1), z.string()),
    /** 64-hex domain-separated environment identity (node/platform/arch/engines). */
    environmentIdentity: z.string().regex(HEX64, 'environmentIdentity must be 64-char lowercase hex'),
    /** Run start instant (ISO-8601). */
    startedAt: z.string().datetime(),
    /** Run end instant (ISO-8601). */
    finishedAt: z.string().datetime(),
  })
  .strict()
  .superRefine((result, ctx) => {
    // A complete run with findings is a contradiction — fail closed on
    // the inconsistent document instead of trusting either field.
    if (result.complete && result.causes.length > 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['complete'],
        message: 'a complete execution result cannot carry supervision causes',
      });
    }
    if (!result.complete && result.causes.length === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['causes'],
        message: 'an incomplete execution result requires at least one typed cause',
      });
    }
  });

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
export function executionResultDigestOf(result: ExecutionResult): string {
  return sha256Canonical({ domain: EXECUTION_RESULT_DOMAIN, result });
}

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
export function selectionDigestOf(selection: {
  runner: string;
  mode: 'full-relevant-suite' | 'mapped-selection';
  logicalKeys: readonly string[];
}): string {
  return sha256Canonical({
    domain: SELECTION_DOMAIN,
    runner: selection.runner,
    mode: selection.mode,
    logicalKeys: [...new Set(selection.logicalKeys)].sort(),
  });
}
