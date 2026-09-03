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
  evidence: Array<{ record: RegistryRecordLike; trust: TrustTier }>;
  /** Ordered primary-key columns from the resource classification. */
  primaryKey: readonly string[];
}

/** Per-claim grading outcome (same shape the aggregation consumes). */
export type ClaimOutcome =
  | { status: 'satisfied'; recordIds: string[] }
  | { status: 'invalid'; reason: string }
  | { status: 'missing'; reason: string; recordIds?: string[] };

/** A namespace's semantic grader over one claim's evidence. */
export type ContractVerifier = (input: ClaimEvidenceInput) => ClaimOutcome;

const verifiers = new Map<string, ContractVerifier>();

/**
 * Registers the semantic verifier for a contract namespace. Throws when
 * the namespace is already registered — verifier registration cannot
 * override another namespace's semantics (plan phase 5 checklist).
 */
export function registerContractVerifier(namespace: string, verifier: ContractVerifier): void {
  if (verifiers.has(namespace)) {
    throw new Error(
      `a semantic verifier for contract namespace '${namespace}' is already registered; ` +
        'registration cannot override another namespace',
    );
  }
  verifiers.set(namespace, verifier);
}

/** The verifier for a contract's namespace, or null when unregistered. */
export function verifierFor(contract: string): ContractVerifier | null {
  const separator = contract.indexOf(':');
  const namespace = separator === -1 ? contract : contract.slice(0, separator);
  return verifiers.get(namespace) ?? null;
}

/** All registered namespaces (sorted; for diagnostics and tests). */
export function registeredNamespaces(): string[] {
  return [...verifiers.keys()].sort();
}
