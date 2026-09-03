/**
 * The auth pack obligation vocabulary.
 *
 * Every obligation id is `<resourceId>:<contract>` where `<resourceId>` is
 * the stable id the detector emits for one guarded endpoint
 * (`auth.<method>.<path>`) and `<contract>` is one of the names below.
 *
 * Contract grammar: `auth:<verb>` where interior colons are NOT legal
 * (these contracts do not carry their own namespace segment). Trailing
 * colons are rejected by `ContractNameSchema` upstream.
 *
 * Vocabulary rationale (per the pack brief):
 *
 * - `auth:role-allowed` — A request with an authenticated principal whose
 *   role satisfies the endpoint's `roleRequirement` reaches the handler.
 *   Verified by issuing the request with a valid token carrying the
 *   required role; the handler MUST produce its declared success status
 *   (200 / 303 / 201).
 *
 * - `auth:role-denied` — A request whose principal is authenticated but
 *   LACKS the required role is rejected with 401/403 BEFORE any state
 *   mutation. Verified by issuing the same request with a role that does
 *   not satisfy `roleRequirement`; the response MUST be a denial status
 *   and MUST NOT mutate persisted state (this obligation AND
 *   `auth:denied-no-side-effect` together prove "deny is deny").
 *
 * - `auth:tenant-isolated` — A request whose tenant claim differs from
 *   the tenant bound to the target entity is rejected (the endpoint's
 *   `attributes.tenancy` is `tenant-bound`; the example server enforces
 *   `req.user.tenantId === target.tenantId`). Verified by replaying the
 *   admin request with the token of a different tenant; response is
 *   denial status, no read or write succeeds.
 *
 * - `auth:denied-no-side-effect` — A denied request produces no persisted
 *   side effect. Verified by: (a) asserting the denial status, then
 *   (b) issuing a GET on the resource — the entity is unchanged from the
 *   pre-denied snapshot. This is the "deny is deny, not pretend" check
 *   that catches "200 OK with empty body" fake-greens.
 *
 * - `auth:forged-token-rejected` — A request carrying a token whose
 *   signature does not validate (or whose payload fails verification)
 *   is rejected with 401 and never reaches the handler. Verified by
 *   mutating one byte of a valid token and asserting 401; the witness
 *   GET shows the entity is untouched.
 */
export const AUTH_OBLIGATION_CONTRACTS = [
    'auth:role-allowed',
    'auth:role-denied',
    'auth:tenant-isolated',
    'auth:denied-no-side-effect',
    'auth:forged-token-rejected',
];
/**
 * Builds the canonical `<resourceId>:<contract>` obligation id for one
 * guarded endpoint. Stable across runs (no clock, no randomness).
 *
 * Args:
 *   resourceId: The detector-emitted resource id (`auth.<method>.<path>`).
 *   contract: One of {@link AUTH_OBLIGATION_CONTRACTS}.
 *
 * Returns:
 *   string: The `<resourceId>:<contract>` obligation id.
 */
export function obligationId(resourceId, contract) {
    return `${resourceId}:${contract}`;
}
//# sourceMappingURL=obligations.js.map