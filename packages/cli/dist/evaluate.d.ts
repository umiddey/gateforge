/**
 * Verdict evaluation shared by `check` and `test-gates`.
 *
 * Evaluates policy obligations against the run-state claims/records and
 * the configured waivers, using the REAL verdict engine (pin #9). The
 * batch wrapper's context carries ONE classification, so obligations are
 * evaluated one at a time with the classification of their own resource
 * — heterogeneous resources must never borrow each other's business
 * meaning. Detector provenance is attached for the invariant-8 trace.
 *
 * Optional diff scoping (`changedFiles`): only obligations whose resource
 * source file changed are evaluated, and only blocking entries pointing
 * at changed files survive — the `check --changed` contract (GF-09's
 * resource-change set).
 */
import { type BlockingEntry, type GateforgeConfig, type Obligation, type ObligationVerdict, type ResourceGraph, type WaiverCounts } from '@gateforge/core';
/** Everything verdict evaluation needs. */
export interface EvaluateInput {
    /** Repo root; repo-relative config paths resolve against it. */
    cwd: string;
    /** Validated `.gateforge.yml`. */
    config: GateforgeConfig;
    /** Built graph (classifications + detector provenance per resource). */
    graph: ResourceGraph;
    /** Generated obligations (policy result). */
    obligations: readonly Obligation[];
    /**
     * Blocking entries (unclassified/unresolved resources, detector or
     * graph findings, stale references) from the policy result.
     */
    blocking: readonly BlockingEntry[];
    /** Absolute run-state directory holding claims.json / records.json. */
    stateDir: string;
    /** Injected run instant — the only time source (pin #9). */
    now: string;
    /**
     * Diff scope: when non-null, only obligations/blocking entries tied to
     * these changed files are evaluated/reported (check --changed).
     */
    changedFiles?: readonly string[] | null;
    /**
     * Verifier key for the witness attestation surface — a secret the
     * orchestrator shares with the witness and this CLI, never with the
     * tested suite. When absent (or when neither authenticated set
     * verifies) the provenance gate fails closed and demotes every
     * witnessed record: suite-writable artifacts alone cannot prove
     * issuance.
     */
    witnessVerifierKey?: string | null;
    /**
     * Live v2 attestation envelope fetched by `test-gates` while a wired
     * witness was still serving (plan §11.3: the same signed object the
     * shutdown append writes). Verified again here before it contributes
     * trust. Legacy v1 `{runId, recordIds, mac}` shapes never verify here.
     */
    witnessAttestation?: unknown;
    /**
     * Evidence authorization context (plan §11.5–§11.6).
     *
     * `test-gates` holds its mint (`invocationId`) and digest in trusted
     * process memory and passes them here — never by rereading state
     * files after the suite ran. `check` recomputes the current digest
     * itself and requires no invocation match (D3: a completed signed run
     * for identical inputs is reusable).
     */
    evidenceContext?: {
        /** Trusted current input digest, or null when the snapshot is unavailable. */
        expectedInputDigest: string | null;
        /** True when no usable Git inventory exists (non-Git checkout). */
        snapshotUnavailable?: boolean;
        /** Trusted invocation id (test-gates memory; null for check). */
        expectedInvocationId?: string | null;
        /** True for test-gates: the invocation identity must match. */
        requireInvocationId?: boolean;
        /** True when the test-gates run mutated its own inputs post-suite. */
        changedInputs?: boolean;
    };
}
/** The evaluated run. */
export interface EvaluateResult {
    /** Per-obligation verdicts, sorted by obligation id. */
    verdicts: ObligationVerdict[];
    /** Blocking entries (unclassified/unresolved), diff-scoped. */
    blocking: BlockingEntry[];
    /** Waiver-population counts for report summaries. */
    waiverCounts: WaiverCounts;
    /** Whether any blocking verdict or blocking entry exists. */
    blockingRun: boolean;
}
/**
 * Evaluates obligations and blocks per the run inputs.
 *
 * Args:
 *   input: cwd, config, graph, obligations, blocking, state dir,
 *     injected instant, and optional diff scope.
 *
 * Returns:
 *   EvaluateResult: verdicts (sorted), scoped blocking entries, waiver
 *   counts, and the blocking flag.
 */
export declare function evaluateRun(input: EvaluateInput): EvaluateResult;
//# sourceMappingURL=evaluate.d.ts.map