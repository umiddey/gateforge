import { type Obligation } from '../schemas/obligation.js';
import type { TrustTier } from '../schemas/common.js';
import type { Verdict } from '../schemas/verdict.js';
import { type Waiver } from '../schemas/waiver.js';
/** Verdicts that block a run (exit code 1). Clean: satisfied, waived. */
export declare const BLOCKING_VERDICTS: readonly Verdict[];
/**
 * Fail-closed verdict-engine error: raised only for engine-internal
 * contract violations (malformed obligation, invalid `now`) — never for
 * adversary-controlled evidence, which must degrade to a verdict.
 */
export declare class GateforgeVerdictError extends Error {
    constructor(message: string);
}
/** A waiver plus the engine-only stale-owner flag (GF-17). */
export type WaiverRef = Waiver & {
    readonly ownerStale?: boolean;
};
/** The pinned pin-#9 result shape for one obligation. */
export interface VerdictOutcome {
    /** One of the seven verdicts (ADR 0001 D1). */
    verdict: Verdict;
    /**
     * Single-cause human explanation. `null` only for `satisfied`;
     * every other verdict explains itself (invariant 8).
     */
    reason: string | null;
    /**
     * Record ids that drove the verdict — the satisfying witnessed set for
     * `satisfied`; all considered records for `missing`/`invalid`; empty for
     * verdicts decided before evidence is consulted. Sorted, deduplicated.
     */
    recordIds: string[];
}
/**
 * A per-obligation verdict enriched for reporting: the batch wrapper adds
 * the obligation identity, the highest trust tier among considered
 * records, and optional detector provenance (invariant 8 trace).
 */
export interface ObligationVerdict extends VerdictOutcome {
    /** The obligation this verdict is about. */
    obligation: Obligation;
    /** Highest trust tier among the obligation's records; null when none. */
    trustTier: TrustTier | null;
    /** Detector provenance for the trace; attached by the caller when known. */
    detector?: {
        id: string;
        version: string;
    } | null;
}
/** Pin-#9 evaluation context. Malformed entries degrade, never crash. */
export interface VerdictContext {
    /** Reporter claims (Claim-shaped); entries failing the schema are ignored. */
    claims: readonly unknown[];
    /**
     * Witness records — deliberately lenient input: records that fail the
     * EvidenceRecord shape or lack service-issued provenance are treated as
     * claimed-tier (GF-23), never rejected.
     */
    records: readonly unknown[];
    /** Loaded waivers; `ownerStale: true` entries yield `stale` (GF-17). */
    waivers: readonly WaiverRef[];
    /** Classification of `obligation.resourceId`; null ⇒ `unclassified`. */
    classification: unknown;
    /** Injected clock instant (invariant 7) — the only time source. */
    now: Date | string;
}
/**
 * Normalizes the injected clock to a Date. Accepts Date or ISO-8601
 * string; anything else is an engine-internal contract violation.
 *
 * Args:
 *   now: the injected clock instant.
 *
 * Returns:
 *   Date: the parsed instant.
 *
 * Throws:
 *   GateforgeVerdictError: when `now` is not a valid ISO-8601 instant.
 */
export declare function parseInstant(now: Date | string): Date;
/**
 * Evaluates ONE obligation against the run's claims, records, waivers,
 * classification, and injected clock (pin #9). Pure and deterministic:
 * identical inputs produce identical outcomes.
 *
 * Args:
 *   obligation: the obligation under evaluation (validated schema shape).
 *   context: claims, records, waivers, classification, and `now`.
 *
 * Returns:
 *   VerdictOutcome: {verdict, reason, recordIds} — reason is null only
 *   for `satisfied`; recordIds is always a sorted array.
 *
 * Throws:
 *   GateforgeVerdictError: when the obligation or `now` violates the
 *   engine-internal contract (evidence problems NEVER throw — they
 *   produce `invalid`/`missing` verdicts).
 */
export declare function evaluateObligation(obligation: Obligation, context: VerdictContext): VerdictOutcome;
/**
 * Evaluates a batch of obligations against one context and returns
 * report-ready entries sorted by obligation id, each enriched with the
 * highest trust tier among its records (SARIF properties) and optional
 * detector provenance passthrough.
 *
 * Args:
 *   obligations: obligations to evaluate.
 *   context: the shared pin-#9 evaluation context.
 *
 * Returns:
 *   ObligationVerdict[]: sorted by obligation id; deterministic.
 */
export declare function evaluateObligations(obligations: readonly Obligation[], context: VerdictContext): ObligationVerdict[];
//# sourceMappingURL=evaluate.d.ts.map