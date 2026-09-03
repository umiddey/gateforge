/**
 * The webhook pack obligation vocabulary.
 *
 * Every obligation id is `<resourceId>:<contract>` where `<resourceId>`
 * is the stable id the detector emits for one webhook endpoint
 * (e.g. `webhook.stripe.payments`) and `<contract>` is one of the
 * five names below.
 *
 * Contract grammar: `webhook:<verb>` (no interior colons). Trailing
 * colons are rejected by `ContractNameSchema` upstream.
 *
 * Vocabulary rationale (per the pack brief):
 *
 * - `webhook:signature-accepted` — A request carrying a valid signature
 *   (HMAC-SHA256 over the canonical body, matched against the
 *   configured header) is accepted (2xx) and reaches the handler.
 *   Verified by issuing the request with a freshly-computed signature;
 *   the handler MUST produce its declared success status.
 *
 * - `webhook:signature-rejected` — A request whose signature does NOT
 *   match the canonical body / header / secret is rejected with 401
 *   and NEVER reaches the handler. Verified by mutating one byte of the
 *   payload while leaving the signature untouched (or vice-versa).
 *
 * - `webhook:malformed-rejected` — A request whose body is not valid
 *   JSON (or whose Content-Type is wrong / payload exceeds `maxBody`)
 *   is rejected with 400 and never reaches the signature verifier.
 *   Verified by sending a malformed JSON body.
 *
 * - `webhook:replay-idempotent` — When the same `event_id` arrives more
 *   than once within `attributes.replayWindow` ms, only the FIRST
 *   delivery produces a side effect; subsequent deliveries are deduped.
 *   Verified by issuing the same event_id twice with valid signatures
 *   and confirming the in-memory log has exactly one side-effect entry.
 *
 * - `webhook:retry-bounded` — The server enforces a hard ceiling on the
 *   number of retries it will accept per `event_id` (default 3). The
 *   server responds 429 once the ceiling is exceeded. Verified by
 *   firing the same event repeatedly with the `X-Webhook-Attempt`
 *   header and confirming the response transitions 2xx → 2xx → 2xx →
 *   429 at attempt 4.
 */
export const WEBHOOK_OBLIGATION_CONTRACTS = [
    'webhook:signature-accepted',
    'webhook:signature-rejected',
    'webhook:malformed-rejected',
    'webhook:replay-idempotent',
    'webhook:retry-bounded',
];
/**
 * Builds the canonical `<resourceId>:<contract>` obligation id for one
 * webhook endpoint. Stable across runs (no clock, no randomness).
 *
 * Args:
 *   resourceId: The detector-emitted resource id (`webhook.<area>.<endpoint>`).
 *   contract: One of {@link WEBHOOK_OBLIGATION_CONTRACTS}.
 *
 * Returns:
 *   string: The `<resourceId>:<contract>` obligation id.
 */
export function obligationId(resourceId, contract) {
    return `${resourceId}:${contract}`;
}
//# sourceMappingURL=obligations.js.map