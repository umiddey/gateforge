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
import { type MappedCoverage, type BlockingEntry, type Claim, type CoverageOperation, type GateforgeConfig, type Obligation, type ObligationVerdict, type ResourceGraph, type WaiverCounts } from '@gateforge/core';
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
     * Declared claims derived from resolved test mappings (plan
     * 2026-09-13 §5.3, Phase 3): sidecar/native mapping bindings join the
     * natively annotated claims so an existing mapped test reaches the SAME
     * authoritative grading path. A mapping declares intent and supplies no
     * test result — with no witnessed evidence the obligation grades
     * EVIDENCE_NOT_COLLECTED (blocking), never satisfied. Claims cannot
     * waive or weaken anything, so strict mode is unaffected. Phase 4 gap:
     * the runtime fixture submits evidence per annotations with the
     * reporter's own testIds, so sidecar claims (testId = logical key)
     * receive no runtime evidence until Phase 4 wires claim injection
     * through session open.
     */
    mappingClaims?: readonly Claim[];
    /**
     * Coverage facts derived from resolved test mappings (plan §3.6,
     * Phase 3): browser-e2e-declared bindings for CRUD-contract
     * obligations, joined to their inventory tables. Feeds the coverage
     * policy so a mapped journey clears its table/operation exactly like
     * an owner disposition; declarations remain inputs, never proof.
     */
    mappedCoverage?: readonly MappedCoverage[];
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
 * Derives the closed-world coverage inventory from the built graph (plan
 * 2026-09-13 §3.6): every RESOLVED, USER-FACING business table. HTTP
 * endpoints are routes, not tables (ADR 0004 D8), and unclassified
 * resources generate no obligations, so neither participates.
 *
 * Args:
 *   graph: the built resource graph with effective classifications bound.
 *
 * Returns:
 *   CoverageInventoryTable-style entries: name + lifecycle-enabled
 *   operations, sorted by name (deterministic).
 */
export declare function coverageInventory(graph: ResourceGraph): Array<{
    name: string;
    operations: readonly CoverageOperation[];
}>;
/**
 * Coverage-policy evaluation for the run (plan §3.6, ADR 0005 D5).
 * Opt-in: an absent/empty `coveragePolicy` config section means the
 * feature is off. When enabled, the policy is validated against the
 * CURRENT run's inventory on EVERY run: unknown table names throw a
 * UsageError (exit 2), and uncovered/undispositioned requirements become
 * blocking findings carrying cause `CRUD_COVERAGE_MISSING`. Resolved
 * test mappings (browser-e2e-declared bindings, plan Phases 2-3) supply
 * the mapped-coverage facts — a mapped journey clears its table/operation
 * exactly as a recorded owner disposition does; both remain inputs and
 * never substitute for runtime proof.
 *
 * Args:
 *   config: the validated `.gateforge.yml`.
 *   graph: the built resource graph (inventory source).
 *   mappedCoverage: coverage facts derived from resolved test mappings
 *     (empty when the sidecar is absent or no binding declares
 *     browser-e2e).
 *
 * Returns:
 *   BlockingEntry[]: coverage findings (empty when the feature is off).
 *
 * Throws:
 *   UsageError: when a policy table name is absent from the inventory
 *     (configuration error — fail closed, never silently uncheckable).
 */
export declare function coveragePolicyBlocking(config: GateforgeConfig, graph: ResourceGraph, mappedCoverage?: readonly MappedCoverage[]): BlockingEntry[];
/**
 * Strict E2E preflight (plan Phase 0 item 4, ADR 0005 D1): when strict
 * E2E mode is on, every obligation demanding a contract whose proof
 * channel is unavailable becomes a blocking entry with a PRECISE
 * capability error (contract + missing observer + next action). A strict
 * setup lacking browser observation stays visibly incomplete — it cannot
 * advertise an operational blocking E2E gate.
 *
 * Args:
 *   obligations: the run's obligations (preflight is setup-wide, never
 *     diff-narrowed).
 *
 * Returns:
 *   BlockingEntry[]: one blocking entry per unsupported obligation.
 */
export declare function strictPreflightBlocking(obligations: readonly Obligation[]): BlockingEntry[];
/**
 * Strict-mode waiver treatment (plan §3.3, ADR 0005 D4): a waived
 * in-scope E2E obligation is NOT proof and cannot authorize the change.
 * Under strict E2E mode the verdict becomes blocking `missing` with cause
 * `ENFORCEMENT_UNTRUSTED`; the original waiver text stays in the reason
 * (legacy/reporting use remains explicit). Every obligation in the engine
 * is an E2E proof obligation — unit/component results never reach the
 * grader — so all waived verdicts convert. Baselined obligations are
 * baseline-clean only in later phases' receipt path; `check` does not
 * consume baselines for grading today.
 *
 * Args:
 *   verdicts: the evaluated verdicts (sorted).
 *
 * Returns:
 *   ObligationVerdict[]: identical unless strict mode converted waived
 *   entries to blocking ones (order and determinism preserved).
 */
export declare function applyStrictE2E(verdicts: readonly ObligationVerdict[]): ObligationVerdict[];
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