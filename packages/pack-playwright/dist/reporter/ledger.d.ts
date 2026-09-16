/**
 * Reporter ledger computation (pure helpers).
 *
 * Per-claim verdicts are computed with the REAL verdict engine
 * (`evaluateObligation`, G3 pin #9) — the reporter never trusts a test's
 * own conclusion. Per-claim isolation: each row evaluates exactly that
 * test's claim against the run's witness ledger; the engine attributes
 * records by (obligationId, testId), so a claim cannot borrow another
 * test's evidence.
 *
 * The ledger needs the run's obligations (from `GATEFORGE_OBLIGATIONS`)
 * and each resource's classification (primaryKey etc.) from the witness
 * (`GET /classifications`). When either is unavailable the row carries
 * `verdict: null` and the reason says exactly what is missing.
 */
import { type Classification, type HttpRouteCandidate, type Verdict } from '@gate-forge/core';
import type { IssuedLedgerRecord } from '../fixture/witness-client.js';
/** One suite-visible obligation from `obligations.json` (state contract). */
export interface StateObligationEntry {
    id: string;
    resourceId: string;
    contract: string;
    policyId: string;
    lifecycle: {
        create: boolean;
        read: boolean;
        update: boolean;
        delete: boolean;
        deleteSemantics?: 'hard' | 'archive';
        archiveFields?: Record<string, string | number | boolean>;
        updateableFields?: string[];
    };
    fingerprint: string;
    source: string;
    location: {
        file: string;
        line: number;
        col: number;
    } | null;
}
/** The obligations document the CLI writes (`{schemaVersion, obligations}`). */
export interface ObligationsDocument {
    schemaVersion: number;
    obligations: StateObligationEntry[];
}
/** A claim extracted from one test's annotations. */
export interface LedgerClaim {
    obligationId: string;
    testId: string;
    testFile: string;
    location: {
        file: string;
        line: number;
        col: number;
    } | null;
}
/** One ledger row: one test's claim judged by the engine. */
export interface LedgerRow {
    claim: string;
    testId: string;
    testFile: string;
    verdict: Verdict | null;
    reason: string | null;
    recordIds: string[];
    trustTier: 'witnessed' | 'claimed' | null;
}
/** Load a valid claim-shaped object from the annotation source. */
export declare function claimOf(obligationId: string, test: {
    id: string;
    location?: {
        file: string;
        line: number;
        column: number;
    } | null;
}): LedgerClaim;
/** Parses the obligations document (fail-lenient: missing → null). */
export declare function parseObligationsDocument(raw: string): ObligationsDocument | null;
/**
 * Computes one ledger row for a claim.
 *
 * Advisory only (plan §9): the reporter runs inside the suite-side
 * runtime, so its rows can never be authoritative. HTTP rows grade
 * against the CLI-derived route inventory when the caller supplies it;
 * without route context the core resolver blocks with a missing-context
 * result — the reporter never shows an authoritative pass merely
 * because it lacked the inventory.
 *
 * Args:
 *   claim: the claim under judgment.
 *   obligations: the run's obligations (state doc).
 *   classifications: per-resource classification map (witness surface).
 *   records: the full run ledger.
 *   now: injected instant for the verdict engine.
 *   httpRoutes: advisory route inventory (CLI-derived `http-routes.json`
 *     when present, else null). The authoritative CLI recomputes this
 *     from source and never trusts a reporter-supplied list.
 *
 * Returns:
 *   LedgerRow: verdict + reason + considered record ids. `verdict:
 *   null` (with reason) when required context is missing.
 */
export declare function ledgerRowFor(claim: LedgerClaim, obligations: ObligationsDocument | null, classifications: Record<string, Classification>, records: readonly IssuedLedgerRecord[], now: string, httpRoutes?: readonly HttpRouteCandidate[] | null): LedgerRow;
/** Blocks the run? (satisfied/waived are clean.) */
export declare function isBlocking(verdict: Verdict | null): boolean;
//# sourceMappingURL=ledger.d.ts.map