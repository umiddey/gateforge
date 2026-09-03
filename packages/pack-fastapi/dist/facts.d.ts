/**
 * Post-canonicalization and signal minting for the FastAPI detector.
 *
 * The Python scanner emits raw effective paths; this module is the single
 * place where contract facts get their canonical `normalizedPath` (via
 * `@gateforge/http-contract`, so canonicalization has exactly one
 * implementation across languages) and where the pack's classification
 * signals (exposure/lifecycle facts about business resources, ADR 0003
 * D1) are minted with the pack's pinned detector identity.
 */
import { type HttpContractFact, type HttpLocation } from '@gateforge/http-contract';
import type { ClassificationSignal } from '@gateforge/core';
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
/**
 * Mirrors pack-http's `resourceNameFromPath`: the last non-parameter,
 * non-numeric, non-empty path segment, lower-cased, extension-stripped.
 * Returns `null` when no name can be derived — the caller must emit
 * nothing rather than guess.
 */
export declare function pathDerivedResourceName(rawPath: string): string | null;
/** HTTP verb → lifecycle operation, mirroring pack-http (`null` = none). */
export declare function operationForMethod(method: string): 'create' | 'read' | 'update' | 'delete' | null;
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
 * Canonicalizes python-emitted contract resources into typed facts and
 * mints the pack's classification signals.
 *
 * A fact whose effective path canonicalizes to a dynamic outcome becomes a
 * blocking `HTTP_PATH_DYNAMIC` unresolved entry — never a dropped claim
 * and never a guess. Facts and signals are returned in deterministic
 * canonical order.
 */
export declare function canonicalizeFacts(resources: readonly ContractResource[]): CanonicalizationOutcome;
export {};
//# sourceMappingURL=facts.d.ts.map