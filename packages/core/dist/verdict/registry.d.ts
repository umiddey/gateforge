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
 *
 * Alongside each verifier the registry carries explicit CAPABILITY
 * metadata (plan 2026-09-13 Phase 0 item 3, ADR 0005): implemented
 * contracts, the required observer channel, supported test kinds, and
 * availability — registered with the same first-wins/no-override rule so
 * no consumer (CLI, packs) can weaken an advertised capability by
 * registration order or by duplicating contract-name lists.
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
/**
 * One contract's availability inside a registered namespace (plan
 * 2026-09-13 Phase 0 item 3): implemented contracts grade evidence;
 * unavailable ones are REGISTERED but fail closed — no honest observation
 * channel exists yet, so no evidence can ever satisfy them.
 */
export type ContractAvailability = {
    status: 'available';
} | {
    status: 'unavailable';
    /** The fail-closed reason (names the missing engine-owned producer). */
    reason: string;
};
/**
 * Explicit capability metadata for one contract namespace (plan
 * 2026-09-13 Phase 0 item 3, ADR 0005): what the namespace's verifier can
 * honestly prove, which independent observer channel that proof requires,
 * which test kinds can carry it, and whether any of it is available today.
 * Single source of truth — CLI and packs consume this record instead of
 * duplicating contract-name lists.
 */
export interface ContractCapability {
    /** The contract namespace this record describes (e.g. `http`). */
    namespace: string;
    /**
     * Exact contract names the verifier fully implements. Empty means
     * `none — fail-closed`: every contract of the namespace blocks.
     */
    contracts: readonly string[];
    /**
     * Contracts that are registered but NOT satisfiable (no honest
     * observation channel), each with its fail-closed reason. These names
     * stay blocking whatever evidence arrives.
     */
    unavailableContracts: readonly {
        contract: string;
        reason: string;
    }[];
    /**
     * Description of the required independent observer channel for the
     * implemented contracts (what must exist for proof to be honest).
     */
    observer: string;
    /** Test kinds whose evidence can satisfy the implemented contracts. */
    testKinds: readonly string[];
    /** Namespace-level availability; `unavailable` fails every contract closed. */
    availability: ContractAvailability;
}
/**
 * Registers the capability metadata for one contract namespace. Throws
 * when the namespace already carries a capability record — like verifier
 * registration (first-wins), a later registration can never redefine or
 * weaken another namespace's advertised capability (plan Phase 0
 * acceptance: no protected verifier can be replaced by registration
 * order).
 *
 * Args:
 *   capability: the capability record (namespace, implemented contracts,
 *     required observer, test kinds, availability).
 *
 * Throws:
 *   Error: when the namespace already has a capability record.
 */
export declare function registerContractCapabilities(capability: ContractCapability): void;
/**
 * The capability record for a contract's namespace, or null when the
 * namespace has none (an unregistered namespace is itself unsupported).
 *
 * Args:
 *   contract: a contract name (`namespace:operation`); the namespace is
 *     the text before the first colon (same split as `verifierFor`).
 *
 * Returns:
 *   ContractCapability | null: the namespace's capability record.
 */
export declare function capabilityFor(contract: string): ContractCapability | null;
/** All registered capability records, sorted by namespace (diagnostics/tests). */
export declare function allCapabilities(): ContractCapability[];
//# sourceMappingURL=registry.d.ts.map