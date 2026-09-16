/**
 * Post-canonicalization for the FastAPI detector.
 *
 * The Python scanner emits raw effective paths; this module is the single
 * place where contract facts get their canonical `normalizedPath` (via
 * `@gate-forge/http-contract`, so canonicalization has exactly one
 * implementation across languages).
 *
 * Classification signals (dogfood remediation phase 4): NONE. The wrapper
 * once minted `exposure: route` / `lifecycle.<op>` signals targeted at the
 * PATH-DERIVED resource name (`pathDerivedResourceName`) — a guess that
 * mostly names no discovered resource (route `/admin-bypasses` vs the real
 * table), so the signals surfaced as STALE_SIGNAL_TARGET blockers while
 * adding nothing: unknown exposure already defaults user-facing and unknown
 * lifecycle operations already default enabled (ADR 0003 D5). Route→resource
 * linkage belongs to the CLI endpoint compiler (schema-symbol/handler
 * corroboration over these very facts' `requestSchemaSymbols`/
 * `responseSchemaSymbols`/`handlerSymbol`, with typed
 * ENDPOINT_RESOURCE_LINK_UNRESOLVED blocks for ambiguity). Core's
 * STALE_SIGNAL_TARGET detection remains for genuinely stale authority
 * signals (declaration markers, adapter bindings, read-only declarations)
 * — this pack simply no longer produces false targets. The
 * `classificationSignals` outcome field stays in the wire shape (protocol
 * contract) and is always empty.
 */
import { type HttpContractFact, type HttpLocation } from '@gate-forge/http-contract';
import type { ClassificationSignal } from '@gate-forge/core';
/** Source location shape shared by facts, resources, and signals. */
type Location = HttpLocation;
/** Wire shape of one python-emitted contract resource (open attributes). */
export interface ContractResource {
    schemaVersion: 1;
    kind: 'http.contract';
    source: string;
    location: Location;
    detectorVersion: string;
    attributes: Record<string, unknown>;
    id: string;
}
export interface CanonicalizationOutcome {
    /** Facts whose effective path canonicalized; `normalizedPath` filled in. */
    facts: HttpContractFact[];
    /** Raw resources kept for the graph's evidence-only channel. */
    resources: ContractResource[];
    /** Typed blocking entries for facts whose path could not canonicalize. */
    unresolved: Array<{
        code: string;
        detail: string;
        location: Location;
    }>;
    /** Exposure/lifecycle signals minted from the canonical facts. */
    classificationSignals: ClassificationSignal[];
}
/**
 * Canonicalizes python-emitted contract resources into typed facts.
 *
 * A fact whose effective path canonicalizes to a dynamic outcome becomes a
 * blocking `HTTP_PATH_DYNAMIC` unresolved entry — never a dropped claim
 * and never a guess. No classification signals are minted (phase 4; see
 * the module doc). Facts and resources are returned in deterministic
 * canonical order.
 */
export declare function canonicalizeFacts(resources: readonly ContractResource[]): CanonicalizationOutcome;
export {};
//# sourceMappingURL=facts.d.ts.map