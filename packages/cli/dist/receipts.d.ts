/**
 * Gate-receipt gate (plan 2026-09-13 Phase 4 items 5/8, ADR 0005 D3):
 * `check --require-e2e` and the `test-gates --changed` reuse path read
 * the run-state receipt + execution result and verify them FAIL CLOSED.
 *
 * Rules:
 * - without a valid, non-stale receipt for the CURRENT input digest the
 *   run blocks: missing receipt → RUN_INCOMPLETE (old record bundles
 *   without receipts are rejected, never silently accepted), stale
 *   (input/policy/selection/catalog digest mismatch, E13) →
 *   EVIDENCE_STALE, forged/tampered → ENFORCEMENT_UNTRUSTED;
 * - the receipt's bound execution result must exist and re-hash to the
 *   receipt's digest (a suite-writable file cannot be swapped without
 *   detection);
 * - cache reuse (Phase 4 item 8) requires an identical AUTHENTICATED
 *   input digest, matching selection/catalog/policy digests, a complete
 *   execution result, and a clean verdict summary — ANY changed input
 *   forces a fresh run or a precise block; never reuse across changed
 *   inputs.
 */
import { type BlockingEntry, type ExecutionResult, type GateReceipt } from '@gateforge/core';
/** The expected context a reusable receipt must match exactly. */
export interface ReceiptExpectations {
    /** Current trusted input digest. */
    inputDigest: string;
    /** Current trusted policy/config revision digest. */
    trustedPolicyDigest: string;
    /**
     * Current planned selection digest; omit when the consumer cannot know
     * it (the check gate relies on the input-digest staleness binding).
     */
    selectionDigest?: string;
    /** Current catalog digest; optional for the same reason. */
    catalogDigest?: string;
}
/** The outcome of loading a receipt for enforcement or reuse. */
export type ReceiptLoad = {
    status: 'ok';
    receipt: GateReceipt;
    executionResult: ExecutionResult;
} | {
    status: 'absent';
} | {
    status: 'malformed';
    detail: string;
} | {
    status: 'unverified';
    detail: string;
} | {
    status: 'stale';
    detail: string;
} | {
    status: 'execution-mismatch';
    detail: string;
};
/**
 * Loads and fully verifies the run-state receipt for an expected context
 * (fail closed, typed outcomes — never throws on untrusted content).
 *
 * Args:
 *   stateDir: absolute run-state directory.
 *   verifierKey: the witness verifier key (the receipt's signing
 *     authority; without it nothing verifies).
 *   expected: the digests the receipt must match.
 *
 * Returns:
 *   ReceiptLoad: the typed load outcome.
 */
export declare function loadReceiptFor(stateDir: string, verifierKey: string | null, expected: ReceiptExpectations): ReceiptLoad;
/**
 * Maps a receipt load outcome onto `check --require-e2e` blocking
 * entries (plan §5.4: RUN_INCOMPLETE / EVIDENCE_STALE /
 * ENFORCEMENT_UNTRUSTED). Entries are never diff-scoped away and never
 * waived.
 *
 * Args:
 *   load: the outcome of {@link loadReceiptFor}.
 *
 * Returns:
 *   BlockingEntry[]: one blocking entry per failure (empty on success).
 */
export declare function receiptGateBlocking(load: ReceiptLoad): BlockingEntry[];
/**
 * Decides whether the run-state receipt may be REUSED for a fresh
 * `test-gates --changed` invocation (plan Phase 4 item 8): identical
 * authenticated input digests (input, policy, selection, catalog), a
 * verifying signature, and a complete bound execution result. ANY
 * mismatch → no reuse (the caller runs fresh or blocks precisely).
 *
 * Args:
 *   stateDir: absolute run-state directory.
 *   verifierKey: the witness verifier key, or null (then never reuse).
 *   expected: the current run's expected digests.
 *
 * Returns:
 *   {reuse: true, receipt} | {reuse: false}: the reuse decision.
 */
export declare function tryReuseReceipt(stateDir: string, verifierKey: string | null, expected: ReceiptExpectations): {
    reuse: true;
    receipt: GateReceipt;
} | {
    reuse: false;
};
//# sourceMappingURL=receipts.d.ts.map