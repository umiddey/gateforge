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
import { CAUSE_NEXT_ACTIONS, ExecutionResultSchema, executionResultDigestOf, verifyGateReceipt, } from '@gateforge/core';
import { readStateDocument } from './state.js';
/** The §5.4 next action per cause (single source: core). */
const NEXT_ACTIONS = CAUSE_NEXT_ACTIONS;
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
export function loadReceiptFor(stateDir, verifierKey, expected) {
    const document = readStateDocument(stateDir, 'receipt.json');
    if (document === null)
        return { status: 'absent' };
    if (verifierKey === null) {
        return {
            status: 'unverified',
            detail: 'no witness verifier key available; the gate receipt cannot be authenticated (fail closed)',
        };
    }
    const verified = verifyGateReceipt(verifierKey, document, {
        inputDigest: expected.inputDigest,
        trustedPolicyDigest: expected.trustedPolicyDigest,
        selectionDigest: expected.selectionDigest,
        catalogDigest: expected.catalogDigest,
    });
    if (!verified.ok) {
        if (verified.rejection === 'missing' || verified.rejection === 'malformed') {
            return { status: 'malformed', detail: verified.detail };
        }
        if (verified.rejection === 'mac-fail') {
            return { status: 'unverified', detail: verified.detail };
        }
        if (verified.rejection === 'not-clean') {
            return { status: 'malformed', detail: verified.detail };
        }
        return { status: 'stale', detail: verified.detail };
    }
    const executionRaw = readStateDocument(stateDir, 'execution-result.json');
    if (executionRaw === null) {
        return {
            status: 'execution-mismatch',
            detail: 'the receipt binds an execution result that is missing from the run state (fail closed)',
        };
    }
    const executionParsed = ExecutionResultSchema.safeParse(executionRaw);
    if (!executionParsed.success) {
        return {
            status: 'execution-mismatch',
            detail: 'the bound execution result is malformed (fail closed)',
        };
    }
    const executionResult = executionParsed.data;
    if (executionResultDigestOf(executionResult) !== verified.receipt.executionResultDigest) {
        return {
            status: 'execution-mismatch',
            detail: 'the execution result no longer matches the receipt digest — the supervision record was altered (fail closed)',
        };
    }
    if (!executionResult.complete) {
        return {
            status: 'execution-mismatch',
            detail: 'the bound execution result records an incomplete run; receipts exist only for complete runs (fail closed)',
        };
    }
    return { status: 'ok', receipt: verified.receipt, executionResult };
}
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
export function receiptGateBlocking(load) {
    if (load.status === 'ok')
        return [];
    const block = (cause, detail) => ({
        kind: 'finding',
        resourceId: null,
        name: null,
        detail,
        location: null,
        cause,
        nextAction: NEXT_ACTIONS[cause],
    });
    switch (load.status) {
        case 'absent':
            return [
                block('RUN_INCOMPLETE', 'require-e2e: no gate receipt exists for the current state — run `gateforge test-gates --changed` ' +
                    'to execute the configured E2E suite; record bundles saved without a complete-run receipt are rejected (fail closed)'),
            ];
        case 'unverified':
            return [block('ENFORCEMENT_UNTRUSTED', `require-e2e: ${load.detail}`)];
        case 'malformed':
            return [block('ENFORCEMENT_UNTRUSTED', `require-e2e: ${load.detail}`)];
        case 'stale':
            return [block('EVIDENCE_STALE', `require-e2e: ${load.detail} (E13: tested inputs differ from the candidate — rerun)`)];
        case 'execution-mismatch':
            return [block('ENFORCEMENT_UNTRUSTED', `require-e2e: ${load.detail}`)];
    }
}
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
export function tryReuseReceipt(stateDir, verifierKey, expected) {
    if (verifierKey === null)
        return { reuse: false };
    const load = loadReceiptFor(stateDir, verifierKey, expected);
    if (load.status !== 'ok')
        return { reuse: false };
    return { reuse: true, receipt: load.receipt };
}
//# sourceMappingURL=receipts.js.map