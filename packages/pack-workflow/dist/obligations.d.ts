/**
 * Obligation contract vocabulary for the workflow pack.
 *
 * Every discovered `workflow.contract.*` resource generates the same
 * five obligations (the policy stage of the engine chooses a subset
 * based on classification; the contracts themselves are fixed). The
 * contract names are the suffix of the obligation id
 * `<resourceId>:<contract>`; resource ids always start with
 * `workflow.contract.`, so obligation ids look like
 * `workflow.contract.contracts.draft:workflow:transition-allowed`.
 *
 * The five contracts mirror the root plan §6 "Workflow pack" obligations
 * (valid transition / invalid transition / persisted final state /
 * audit event records actor and transition) plus an explicit
 * terminal-immutability obligation that the e2e suite exercises.
 */
/** Valid transition succeeds + persists + appends an audit row. */
export declare const WORKFLOW_TRANSITION_ALLOWED = "workflow:transition-allowed";
/**
 * Invalid transition is rejected: the adapter's `attemptTransition`
 * returns `{ accepted: false }`, the persisted state is unchanged, and
 * no audit row is appended.
 */
export declare const WORKFLOW_TRANSITION_REJECTED = "workflow:transition-rejected";
/**
 * Any write attempt against a terminal state is rejected with
 * `{ accepted: false, reason: 'terminal-state' }`; no audit row is
 * appended.
 */
export declare const WORKFLOW_TERMINAL_IMMUTABLE = "workflow:terminal-immutable";
/**
 * Audit row emitted on every accepted transition contains `actor`,
 * `from`, `to`, and a timestamp; the adapter's `readAuditLog()`
 * returns the append-only log verbatim.
 */
export declare const WORKFLOW_AUDIT_EMITTED = "workflow:audit-emitted";
/**
 * The persisted entity's `status` matches the machine's terminal state
 * after the transition sequence (e.g. `terminated`, `signed`).
 */
export declare const WORKFLOW_PERSISTED_FINAL_STATE = "workflow:persisted-final-state";
/** Every workflow contract this pack ships, in stable declaration order. */
export declare const WORKFLOW_OBLIGATION_CONTRACTS: readonly string[];
/**
 * Returns the obligation contracts applicable to a workflow resource.
 * Currently every workflow resource is treated equally; the engine's
 * classification stage may narrow this later.
 *
 * Args:
 *   resourceId: The full `workflow.contract.<domain>.<name>` id.
 *
 * Returns:
 *   readonly string[]: The full contract list — same for every workflow
 *     resource today, returned as a fresh copy so callers may not mutate
 *     the shared array.
 */
export declare function obligationsForWorkflowResource(resourceId: string): readonly string[];
//# sourceMappingURL=obligations.d.ts.map