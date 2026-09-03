/**
 * Background-task obligation contract vocabulary (interface pin #5).
 *
 * Each contract identifies ONE behavioral guarantee a task resource
 * must honor. The full obligation id is formed as
 * `<resourceId>:<contract>` (e.g. `task.email.send:task:idempotent`).
 *
 * The five contracts here are the documented vocabulary every
 * detector-classified task resource generates (subject to policy
 * filters). Each contract maps to a single e2e scenario in the
 * `example/task/` slice and a single unit assertion in `test/`.
 *
 * Contracts are pure data (no policy evaluation lives here). The
 * engine combines these with the resource attributes (`retryPolicy`,
 * `idempotencyKey`, `terminalOn`, `observability`) to derive the
 * per-resource obligation list at gate time.
 */
/** Pinned contract names this pack emits. */
export const TASK_OBLIGATION_CONTRACTS = [
    'task:retry-policy-enforced',
    'task:idempotent',
    'task:terminal-handled',
    'task:observability-recorded',
    'task:duplicate-delivery-handled',
];
/**
 * Stable check-id used by the e2e harness to label a single scenario
 * (mirrors pack-auth's verifier keys). Not part of the wire contract;
 * the contract name is the obligation id suffix.
 */
export const TASK_OBLIGATION_DESCRIPTIONS = {
    'task:retry-policy-enforced': 'flaky task retries up to maxAttempts before final failure',
    'task:idempotent': 'execution with the same idempotency key is deduplicated (one side effect)',
    'task:terminal-handled': 'errors whose type is in terminalOn are NOT retried (terminal outcome)',
    'task:observability-recorded': 'every execution (success + failure) emits an audit record in runs.json',
    'task:duplicate-delivery-handled': 'duplicate deliveries of the same task produce exactly one side effect',
};
/**
 * Builds the five obligation ids for one resource id. The pack's
 * policy treats every detected `task.resource` as producing every
 * contract in `TASK_OBLIGATION_CONTRACTS` (no lifecycle gating).
 *
 * Args:
 *   resourceId: The stable, dotted resource id (e.g. `task.email.send`).
 *
 * Returns:
 *   string[]: Five obligation ids, one per contract, in the pinned
 *     order of `TASK_OBLIGATION_CONTRACTS`.
 */
export function obligationsFor(resourceId) {
    return TASK_OBLIGATION_CONTRACTS.map((contract) => `${resourceId}:${contract}`);
}
//# sourceMappingURL=obligations.js.map