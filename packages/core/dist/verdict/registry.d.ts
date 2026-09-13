/**
 * Semantic-verifier registry (ADR 0004 D8, plan phase 5).
 *
 * Each contract namespace (`persistence`, `http`, `auth`, `workflow`,
 * `webhook`, `task`, `validation`, `crud`) is graded by exactly ONE
 * verifier that its owning pack/engine registers. Registration is
 * first-wins and protected: a later registration for an already-known
 * namespace throws — a pack can never override another pack's semantics.
 * Unknown namespaces stay fail-closed blocking (`missing`), so adding a
 * contract is always safe and never silently satisfiable.
 */
import type { Claim, Obligation } from '../schemas/index.js';
import type { TrustTier } from '../schemas/common.js';
/**
 * One runtime route candidate for HTTP attribution (plan §9, D2).
 * Core-owned: the host (CLI) derives the COMPLETE list from its
 * resource graph — every applicable `http.endpoint` resource, including
 * routes with no frontend consumer and no generated obligation. A
 * caller may never supply only the route it wants to satisfy, and the
 * list is never accepted from a claim or evidence payload (Phase 6
 * snapshots this context; the producer sorts it codepoint-wise by
 * resourceId so it is deterministic).
 */
export interface HttpRouteCandidate {
    /** Graph resource id of the endpoint (e.g. `http.endpoint:GET /a/{}`). */
    resourceId: string;
    /** Concrete uppercase method as compiled (e.g. `GET`). */
    method: string;
    /** Compiled canonical path shape (e.g. `/accounts/{}`). */
    canonicalPath: string;
}
/** Lenient record view (same shape the verdict engine reads). */
export interface RegistryRecordLike {
    readonly recordId: unknown;
    readonly runId: unknown;
    readonly trust: unknown;
    readonly obligationId: unknown;
    readonly testId: unknown;
    readonly kind: unknown;
    readonly origin: unknown;
    readonly payload: unknown;
}
/** One claim's evidence bundle handed to a verifier. */
export interface ClaimEvidenceInput {
    claim: Claim;
    obligation: Obligation;
    evidence: Array<{
        record: RegistryRecordLike;
        trust: TrustTier;
    }>;
    /** Ordered primary-key columns from the resource classification. */
    primaryKey: readonly string[];
    /**
     * The obligation's graph resource (kind + attributes), when the host
     * can supply it. Verifiers use it to bind evidence to identity.
     */
    resource?: {
        kind: string;
        attributes: Record<string, unknown>;
    } | null;
    /**
     * The COMPLETE runtime route inventory for HTTP attribution (plan
     * §9, D2): every applicable `http.endpoint` resource, host-derived
     * from the graph — never from a claim or evidence payload. Absent
     * (null/undefined) blocks HTTP satisfaction: without the full
     * candidate set no endpoint-specific pass is authoritative (no
     * any-endpoint fallback).
     */
    httpRoutes?: readonly HttpRouteCandidate[] | null;
}
/** Per-claim grading outcome (same shape the aggregation consumes). */
export type ClaimOutcome = {
    status: 'satisfied';
    recordIds: string[];
} | {
    status: 'invalid';
    reason: string;
} | {
    status: 'missing';
    reason: string;
    recordIds?: string[];
};
/** A namespace's semantic grader over one claim's evidence. */
export type ContractVerifier = (input: ClaimEvidenceInput) => ClaimOutcome;
/**
 * Registers the semantic verifier for a contract namespace. Throws when
 * the namespace is already registered — verifier registration cannot
 * override another namespace's semantics (plan phase 5 checklist).
 */
export declare function registerContractVerifier(namespace: string, verifier: ContractVerifier): void;
/** The verifier for a contract's namespace, or null when unregistered. */
export declare function verifierFor(contract: string): ContractVerifier | null;
/** All registered namespaces (sorted; for diagnostics and tests). */
export declare function registeredNamespaces(): string[];
//# sourceMappingURL=registry.d.ts.map