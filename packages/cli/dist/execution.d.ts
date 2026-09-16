import { type BlockingEntry, type ExecutionResult, type ExecutedOutcome, type GateReceipt, type Obligation, type PlannedInstance, type ResolvedMappings, type ResourceGraph, type RunnerExecutionEnvelope, type SupervisionFinding, type TestCatalog, type TracedTestInput } from '@gateforge/core';
import type { GateforgeConfig } from '@gateforge/core';
import type { RunnerOutcomesDocument } from '@gateforge/pack-playwright';
/** The normalized invocation stamped into supervised receipts. */
export declare const SUPERVISED_INVOCATION = "test-gates --changed";
/**
 * Computes the trusted policy/config revision digest (ADR 0005 D6) over
 * the trusted-revision-owned documents of the repository: `.gateforge.yml`,
 * the policies and classification-policy documents, the mapping
 * sidecar when present, the EXECUTABLE evidence adapters (`.mjs` modules
 * the witness loads engine-side), and the local in-process plugin
 * modules (review recheck 2026-09-14: executable adapters and plugins
 * can weaken the gate — detectors, evidence reads, scope — so a
 * candidate that edits them is a policy-revision change and cannot
 * approve its own weaker checks; a provisioned approved digest pins
 * their bytes too). Absent optional files contribute fixed
 * empty-bytes entries so the set is deterministic.
 *
 * Args:
 *   cwd: absolute repo root.
 *   configPaths: the resolved repo-relative config paths (policies,
 *     classificationPolicy) plus the optional sidecar path, the adapters
 *     dir, waivers dir, and the repo-relative plugin module specifiers.
 *
 * Returns:
 *   string: 64-char lowercase hex trusted policy digest.
 *
 * Throws:
 *   UsageError: when a REQUIRED trusted document exists but cannot be
 *     read (fail closed — an unreadable trusted revision is never
 *     hashed as empty).
 */
export declare function computeTrustedPolicyDigest(cwd: string, configPaths: {
    config: string;
    policies: string;
    classificationPolicy: string;
    sidecar: string;
    adaptersDir: string;
    waiverFiles: readonly string[];
    pluginModules: readonly string[];
}): string;
/**
 * Builds the trusted-policy digest directly from a loaded config (the
 * common CLI shape): resolves the executable-input paths (adapters dir,
 * waiver files, local in-process plugin modules) and delegates to
 * {@link computeTrustedPolicyDigest}. All gate surfaces call this so the
 * digest is identical everywhere (check, broker, test-gates, doctor).
 *
 * Args:
 *   cwd: absolute repo root.
 *   config: the loaded gateforge config (paths + plugin declarations).
 *
 * Returns:
 *   string: 64-char lowercase hex trusted policy digest.
 */
export declare function trustedPolicyDigestForConfig(cwd: string, config: GateforgeConfig): string;
/**
 * The mapped obligation claims per reconciliation key (plan Phase 4
 * claim injection): SIDECAR bindings join the catalog so a mapped test's
 * runtime evidence lands on the right claims. Keys are
 * `<file>#<titlePath.join('>')>` — the same reconciliation key the
 * reporter computes from the runner's own test events. Claims are
 * DECLARATIONS; they never satisfy anything by themselves.
 *
 * Native annotations never inject: the trusted reporter reads them
 * directly from the CURRENT run's test cases, so injection would add
 * nothing — and the resolver's native origin is the PRIOR run's
 * run-state claims.json, which must never be re-attached to this run's
 * tests (a stale or file-wide native row would re-attribute another
 * test's claims onto this run's evidence). The sidecar is exactly the
 * claim source the runner cannot see on its own (plan E02).
 *
 * Args:
 *   resolution: the resolved-mappings surface (Phase 3 resolver output).
 *   catalog: the current catalog (instance identities).
 *
 * Returns:
 *   Record<string, string[]>: reconciliation key → sorted obligation ids.
 */
export declare function claimInjectionsFor(resolution: ResolvedMappings, catalog: TestCatalog): Record<string, string[]>;
/** The planned expected set fixed BEFORE the run (per catalog row). */
export interface PlannedRow {
    /** The planned instance (schema shape). */
    planned: PlannedInstance;
    /** The supervision input (blocking annotations, unenumerated reason). */
    input: {
        logicalKey: string;
        project: string | null;
        file: string;
        titlePath: string[];
        blockingAnnotations: string[];
        unenumeratedReason?: string;
    };
}
/**
 * Plans the expected test set from the catalog (plan Phase 4 item 2, §3.3
 * rule 5): the complete configured relevant playwright suite. Narrower
 * selection is never guessed — until dependency/journey mapping is
 * proven (Phase 5+), the conservative full relevant suite always runs.
 * Catalog rows carry the pre-run honesty signals: `.only`/`.skip`/
 * `.fixme` annotations and cases the runner never enumerated.
 *
 * Args:
 *   catalog: the freshly discovered catalog.
 *
 * Returns:
 *   PlannedRow[]: one row per planned playwright instance, sorted by
 *   logical key.
 */
export declare function planExpectedSet(catalog: TestCatalog): PlannedRow[];
/**
 * The obligation slice a `--scope changed` run must certify (plan Goal 2,
 * opt-in scoped sealing): the changed files joined to resources through
 * the SAME join-aware source map the diff scoping grades by
 * ({@link sourcesByResourceId} — backend source AND every joined
 * frontend-call source), then resources joined to obligations, then
 * obligations joined to tests through the ONE mapping resolver.
 *
 * Selection granularity is deliberately FILE-grained: the supervised
 * adapter executes whole spec files (trusted-config `testMatch`), so a
 * file that claims one affected obligation plans ALL its catalog rows.
 * Over-selection inside a claimed file is safe — every planned row must
 * still pass — while under-selection (a claiming test left unplanned)
 * would seal coverage over an unrun test, the one direction that can
 * never be allowed.
 *
 * Testable claims are DECLARED bindings only (`sidecar` or `native`
 * origin, unlike {@link claimInjectionsFor} which injects sidecar-only —
 * selection is not evidence attribution, and a native annotation lives in
 * the test file itself, so running the file re-claims it in THIS run).
 * Inferred/prior-run bindings are suggestion data and never count: a
 * claimed obligation whose only candidates are inferred rows would run
 * tests that produce no evidence for it, so it is reported UNCLAIMED
 * instead — the caller turns that into a typed blocking entry (no
 * guessing a narrower gate).
 *
 * Args:
 *   input: the discovered catalog, the resolved mappings, the run's
 *     obligations and graph, and the resolved changed-file set.
 *
 * Returns:
 *   ScopedPlan: the sliced planned rows (whole claimed files), the
 *   affected obligations with their pin-#2 fingerprints (the receipt's
 *   covered set), and the affected obligations no testable claim covers.
 */
export declare function planScopedExpectedSet(input: {
    catalog: TestCatalog;
    resolution: ResolvedMappings;
    obligations: readonly Obligation[];
    graph: ResourceGraph;
    changedFiles: readonly string[];
}): {
    plannedRows: PlannedRow[];
    affected: Obligation[];
    coveredFingerprints: string[];
    unclaimed: Array<{
        obligationId: string;
        detail: string;
    }>;
};
/**
 * Resolves executed outcome rows (reporter data, input only) into
 * schema-shaped outcomes: logical keys join through the planned set's
 * instance identity; rows outside the plan keep their framework-side
 * identity string so the supervision mismatch names them.
 *
 * Args:
 *   outcomesDoc: the parsed runner-outcomes document (or null).
 *   plannedRows: the planned rows (identity join).
 *
 * Returns:
 *   ExecutedOutcome[]: supervision-normalized executed outcomes.
 */
export declare function executedOutcomesOf(outcomesDoc: RunnerOutcomesDocument | null, plannedRows: readonly PlannedRow[]): ExecutedOutcome[];
/** Everything {@link sealExecutionResult} needs. */
export interface SealExecutionResultInput {
    /** Run manifest identity. */
    runId: string;
    /** Fresh trusted invocation id. */
    invocationId: string;
    /** Tested input digest. */
    inputDigest: string;
    /** Trusted policy/config revision digest. */
    trustedPolicyDigest: string;
    /** Runner the selection executes under. */
    runner: string;
    /**
     * Selection mode (additive, default `full-relevant-suite`): a
     * `--scope changed` run seals `mapped-selection` — the execution
     * result, its digest, and every receipt binding it then name the
     * SLICE that actually ran, so a scoped receipt can never be mistaken
     * for a whole-suite seal.
     */
    mode?: 'full-relevant-suite' | 'mapped-selection';
    /** Logical keys selected. */
    logicalKeys: readonly string[];
    /** The catalog the selection was planned from. */
    catalog: TestCatalog;
    /** Planned rows (from {@link planExpectedSet}). */
    plannedRows: readonly PlannedRow[];
    /** The adapter's structured envelope. */
    envelope: RunnerExecutionEnvelope;
    /** Parsed runner-outcomes document (input; may be null when missing). */
    outcomesDoc: RunnerOutcomesDocument | null;
    /**
     * The witness-side session trace (enforcement-review fix 2b; additive
     * optional input): the EXECUTION AUTHORITY. An array is graded by the
     * core supervision module (every expected test must have sealed
     * passing session(s)); `null` blocks the run (trace unavailable);
     * `undefined` keeps the legacy outcomes-based grading (test seam).
     */
    sessionTrace?: readonly TracedTestInput[] | null;
    /**
     * 64-hex digest over the expected set the witness registered before
     * the run (enforcement-review fix 2d; additive optional) — sealed into
     * the execution result so receipts bind the enforced expected set.
     */
    enumerationDigest?: string;
    /** Run start/end instants (ISO-8601). */
    startedAt: string;
    finishedAt: string;
}
/** The sealed execution result plus its digest. */
export interface SealedExecutionResult {
    /** The schema-valid execution result. */
    result: ExecutionResult;
    /** Its domain-separated digest (the receipt binds this). */
    digest: string;
}
/**
 * Seals the supervision execution result (plan §5.1, Phase 4 item 3):
 * runs the core expected-set enforcement over (planned, executed) and
 * assembles the strict-schema record. `complete` is true only when
 * supervision found nothing — the receipt is issued only from a sealed
 * result with `complete: true` and a clean gate.
 *
 * Args:
 *   input: run identity, digests, planned rows, envelope, and outcomes
 *     document.
 *
 * Returns:
 *   SealedExecutionResult: the validated record + digest.
 *
 * Throws:
 *   UsageError: when the assembled record fails the strict schema (a
 *     supervision/assembly bug — fail closed, never seal a malformed
 *     record).
 */
export declare function sealExecutionResult(input: SealExecutionResultInput): SealedExecutionResult;
/** Everything {@link issueGateReceipt} needs. */
export interface IssueGateReceiptInput {
    /** Witness verifier key (the SAME authority as witness records). */
    verifierKey: string;
    /** Run manifest identity. */
    runId: string;
    /** Fresh trusted invocation id. */
    invocationId: string;
    /** Tested input digest. */
    inputDigest: string;
    /** Candidate HEAD sha (or null). */
    gitSha: string | null;
    /** Parent commit sha (or null). */
    parentSha: string | null;
    /** Trusted policy/config revision digest. */
    trustedPolicyDigest: string;
    /**
     * Owner-approved policy revision digest the run was pinned to
     * (review 2026-09-13 P1 #5), when strict enforcement provisioned one
     * (GATEFORGE_APPROVED_POLICY_DIGEST / --approved-policy-digest /
     * trusted config outside the candidate). OPTIONAL and additive: when
     * absent the receipt omits the field (v1 backward compatibility); when
     * present it is covered by the receipt MAC and demanded again at
     * verification under a provisioned pin.
     */
    approvedPolicyDigest?: string | null;
    /** Normalized invocation. */
    invocation: string;
    /** Selection digest. */
    selectionDigest: string;
    /** Catalog digest. */
    catalogDigest: string;
    /**
     * Sealed evaluation scope (additive; default `full`). `changed` seals a
     * SLICE receipt: the covered set below names exactly the obligations
     * the run certifies, and the MAC binds both.
     */
    scope?: 'full' | 'changed';
    /**
     * Pin-#2 fingerprints of the obligations a `changed`-scope receipt
     * covers (sorted, duplicate-free — normalized here). REQUIRED when
     * `scope` is `changed`, refused otherwise (a full receipt covers
     * everything by definition and stays byte-compatible with v1).
     */
    coveredObligationFingerprints?: readonly string[];
    /** Sealed execution-result digest. */
    executionResultDigest: string;
    /** Evidence attestation digest, or null when the run carried none. */
    evidenceAttestationDigest: string | null;
    /** Final verdict summary (blocking must be 0). */
    verdictSummary: {
        total: number;
        satisfied: number;
        waived: number;
        blocking: number;
    };
    /** Issuance instant (ISO-8601). */
    issuedAt: string;
}
/**
 * Issues the authenticated gate receipt (plan Phase 4 item 5, ADR 0005
 * D3): a versioned, domain-separated envelope signed with the witness
 * verifier key — the same authority as witness records, never a second
 * weaker system. Callers must ONLY invoke this after complete
 * supervision success and clean evidence grading (blocking 0).
 *
 * Args:
 *   input: the full binding set + verdict summary + verifier key.
 *
 * Returns:
 *   GateReceipt: the signed receipt.
 *
 * Throws:
 *   UsageError: when blocking > 0 (a receipt is never issued for a
 *     blocking run) or the signed record fails its own schema.
 */
export declare function issueGateReceipt(input: IssueGateReceiptInput): GateReceipt;
/**
 * Reads the parent commit sha (HEAD~1-equivalent) for the receipt's
 * base/parent identity, or null when unavailable (initial commit, non-Git).
 *
 * Args:
 *   cwd: repo root.
 *
 * Returns:
 *   string | null: 40-char sha or null.
 */
export declare function parentSha(cwd: string): string | null;
/**
 * Projects supervision findings into gate blocking entries (typed, plan
 * §5.4 run causes) — never diff-scoped away, never waived.
 *
 * Args:
 *   findings: supervision findings.
 *
 * Returns:
 *   BlockingEntry[]: one blocking entry per finding, sorted.
 */
export declare function supervisionBlocking(findings: readonly SupervisionFinding[]): BlockingEntry[];
/** Serializes a receipt for the run-state file (canonical JSON + newline). */
export declare function serializeReceipt(receipt: GateReceipt): string;
//# sourceMappingURL=execution.d.ts.map