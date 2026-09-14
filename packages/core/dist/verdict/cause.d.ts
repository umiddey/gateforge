import { type CauseCode } from '../schemas/verdict.js';
/** Cause plus its plan §5.4 next action, attached to a report entry. */
export interface VerdictCause {
    /** Stable cause code, or null when Phase 0 has no honest mapping. */
    cause: CauseCode | null;
    /** Human next action for the cause, or null when unmapped. */
    nextAction: string | null;
}
/**
 * Maps one blocking verdict to its cause and next action (plan §5.4).
 * Deterministic and pure: identical inputs produce identical output.
 *
 * Mapping (Phase 0, extended in Phase 1):
 * - clean verdicts (`satisfied`, `waived`) → null cause;
 * - no capability record for the contract's namespace →
 *   VERIFIER_UNSUPPORTED (nothing is registered to prove it with);
 * - a registered namespace that does not implement the contract (e.g.
 *   `http:frontend-request-observed`, unknown `crud:*`/`http:*` names)
 *   or an unavailable namespace (the five domain namespaces) →
 *   VERIFIER_UNSUPPORTED;
 * - a supported contract whose reason reports the §3.6 exact-value echo
 *   violation → EVIDENCE_VALUE_MISMATCH;
 * - a crud claim whose session exchange cannot be attributed because the
 *   host supplied no route inventory → VERIFIER_UNSUPPORTED (the setup
 *   lacks the derived inventory the proof channel needs);
 * - a supported contract whose reason reports absent required
 *   observations (including the crud session-channel rules: direct
 *   mutation outside the session channel, no visible result, no
 *   session-bound anchor) → EVIDENCE_NOT_COLLECTED;
 * - `no claim declares '<id>'` → TEST_MAPPING_MISSING (no existing test
 *   is connected to the obligation; the Phase 2-3 mapping subsystem
 *   refines this into catalog-backed causes);
 * - anything else → null (precise single-cause reason; no guessed code).
 *
 * Args:
 *   params: obligationId, contract, verdict value, and engine reason of
 *     the report entry being rendered.
 *
 * Returns:
 *   VerdictCause: `{cause, nextAction}` — cause/nextAction are null when
 *   the verdict is clean or no honest mapping exists yet.
 */
export declare function causeForVerdict(params: {
    obligationId: string;
    contract: string;
    verdict: string;
    reason: string | null;
}): VerdictCause;
/**
 * One precise capability gap (plan Phase 0 item 4, ADR 0005 D1/D5): a
 * required contract whose proof channel is unavailable. `detail` names
 * the contract, the missing observer, and the fail-closed consequence;
 * `nextAction` is always the plan §5.4 `VERIFIER_UNSUPPORTED` action.
 */
export interface CapabilityGap {
    /** The unsupported contract name. */
    contract: string;
    /** The independent observer channel whose absence blocks this contract. */
    observer: string;
    /** Single-cause precise explanation (fail-closed wording). */
    detail: string;
    /** Always `VERIFIER_UNSUPPORTED` (plan §5.4). */
    cause: Extract<CauseCode, 'VERIFIER_UNSUPPORTED'>;
    /** Plan §5.4 next action for an unsupported proof channel. */
    nextAction: string;
}
/**
 * Computes the capability gap for one contract, or null when the
 * contract's namespace is registered, available, and implements the
 * contract. Pure; reads only the capability registry (single source of
 * truth — no duplicated contract lists at call sites).
 *
 * Args:
 *   contract: the required contract name, e.g. `http:request-observed`.
 *
 * Returns:
 *   CapabilityGap | null: the gap, or null when the contract is provable.
 */
export declare function capabilityGap(contract: string): CapabilityGap | null;
/**
 * Preflight for strict setups (plan Phase 0 item 4): returns one gap per
 * obligation whose contract cannot be proven. A strict setup demanding an
 * unavailable contract must fail closed with these precise errors — it
 * cannot advertise an operational blocking E2E gate.
 *
 * Args:
 *   obligations: the obligations to preflight (`id` + `contract`).
 *
 * Returns:
 *   Array<CapabilityGap & {obligationId: string}>: one entry per
 *   unsupported obligation, sorted by obligation id (deterministic).
 */
export declare function strictCapabilityGaps(obligations: readonly {
    id: string;
    contract: string;
}[]): Array<CapabilityGap & {
    obligationId: string;
}>;
//# sourceMappingURL=cause.d.ts.map