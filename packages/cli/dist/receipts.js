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
import { CAUSE_NEXT_ACTIONS, ExecutionResultSchema, compareStrings, executionResultDigestOf, verifyGateReceipt, } from '@gate-forge/core';
import { readStateDocument } from './state.js';
/** The §5.4 next action per cause (single source: core). */
const NEXT_ACTIONS = CAUSE_NEXT_ACTIONS;
/**
 * A receipt's EFFECTIVE evaluation scope: the field is additive
 * (pre-extension receipts omit it) and absence means `full` — exactly
 * what the historical whole-relevant-suite seal certified.
 *
 * Args:
 *   receipt: a schema-valid receipt.
 *
 * Returns:
 *   'full' | 'changed': the effective scope.
 */
export function receiptScope(receipt) {
    return receipt.scope ?? 'full';
}
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
    // Scope expectations (opt-in scoped runs; additive fields, checked only
    // when the consumer demands them). A scope or covered-set mismatch is a
    // STALE rejection — the sealed run certified a different slice than the
    // one this evaluation needs, which is the E13 staleness contract
    // extended to the slice axis.
    if (expected.scope !== undefined) {
        const effective = receiptScope(verified.receipt);
        if (effective !== expected.scope) {
            return {
                status: 'stale',
                detail: `gate receipt sealed scope '${effective}' but this evaluation demands '${expected.scope}'; ` +
                    'the sealed run certified a different slice than the one needed (fail closed)',
            };
        }
        if (expected.scope === 'changed' && expected.coveredObligationFingerprints !== undefined) {
            const sealed = [...new Set(verified.receipt.coveredObligationFingerprints ?? [])].sort();
            const demanded = [...new Set(expected.coveredObligationFingerprints)].sort();
            if (sealed.length !== demanded.length ||
                sealed.some((fingerprint, index) => fingerprint !== demanded[index])) {
                return {
                    status: 'stale',
                    detail: 'gate receipt coveredObligationFingerprints differ from the demanded slice; ' +
                        'reuse requires the IDENTICAL sealed coverage (fail closed)',
                };
            }
        }
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
 * Scope-coverage consumption for `check --require-e2e` (opt-in scoped
 * runs): a FULL receipt (or a legacy one with no scope field) covers
 * everything, exactly as before. A CHANGED receipt satisfies the gate
 * only when EVERY obligation arising from the currently-changed files is
 * inside its sealed covered set; otherwise a typed EVIDENCE_SCOPE_INCOMPLETE
 * blocker names the uncovered obligations — fail closed, never a silent
 * partial pass.
 *
 * The caller supplies `required` as the obligations demanded by THIS
 * evaluation (diff-joined by the caller: the changed slice for
 * `check --changed`, every obligation for an unscoped/expanded run). The
 * run state holds ONE receipt at a time (each seal overwrites the file),
 * so the honest "union of valid receipts for this digest" is that single
 * receipt — documented invariance, not an approximation.
 *
 * Args:
 *   receipt: the verified receipt (load status ok).
 *   required: the obligations this evaluation must see covered.
 *
 * Returns:
 *   BlockingEntry[]: empty when coverage is complete, else one typed
 *   blocker naming the uncovered obligations (capped list, full count).
 */
export function scopedReceiptCoverageBlocking(receipt, required) {
    if (receiptScope(receipt) === 'full')
        return [];
    const covered = new Set(receipt.coveredObligationFingerprints ?? []);
    const uncovered = required.filter((obligation) => !covered.has(obligation.fingerprint));
    if (uncovered.length === 0)
        return [];
    const named = uncovered
        .slice(0, 5)
        .map((obligation) => obligation.id)
        .sort(compareStrings)
        .join(', ');
    const more = uncovered.length > 5 ? ` (+${String(uncovered.length - 5)} more)` : '';
    return [
        {
            kind: 'finding',
            resourceId: null,
            name: null,
            detail: `require-e2e: the changed-scope receipt covers ${String(covered.size)} obligation(s) but ` +
                `${String(uncovered.length)} obligation(s) arising from the current change are uncovered ` +
                `(${named}${more}) — seal full-scope evidence or widen the slice (fail closed)`,
            location: null,
            cause: 'EVIDENCE_SCOPE_INCOMPLETE',
            nextAction: NEXT_ACTIONS.EVIDENCE_SCOPE_INCOMPLETE,
        },
    ];
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