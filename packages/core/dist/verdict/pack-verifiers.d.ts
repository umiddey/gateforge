import { type HttpRouteCandidate } from './registry.js';
/**
 * Single deterministic path interpretation for runtime observations
 * (plan §9 steps 1-3). Conservative and lockstep with the witness
 * proxy storage (`normalizeObservedPath` in
 * `@gateforge/pack-playwright`'s witness/server.ts — same rules, no
 * collapsing, no decoding on either side):
 * - query (`?...`) and fragment (`#...`) are stripped;
 * - one leading slash is required (a missing one is added);
 * - trailing slashes are dropped (root `/` stays `/`) — routers treat
 *   these as the same resource;
 * - case and segment boundaries are PRESERVED: duplicate slashes are
 *   NOT collapsed (collapsing would let `//` masquerade across segment
 *   boundaries), and percent-encodings are NEVER decoded (`%2F` stays a
 *   literal part of its segment, never a separator).
 *
 * Noncanonical input whose routing meaning is uncertain (duplicate
 * slashes, an encoded slash, a non-path-absolute value) does NOT match
 * a different endpoint — it fails with a reason so the verifier blocks
 * instead of substituting a route.
 *
 * Local on purpose: core must not depend on `@gateforge/http-contract`.
 *
 * Args:
 *   rawUrl: the observed URL carried by the witnessed record.
 *
 * Returns:
 *   `{ok: true, path}` with the interpreted path, or `{ok: false,
 *   reason}` naming the noncanonical input.
 */
export declare function interpretObservedPath(rawUrl: unknown): {
    ok: true;
    path: string;
} | {
    ok: false;
    reason: string;
};
/**
 * Deterministic runtime route attribution over the COMPLETE candidate
 * set (plan §9 steps 4-9, D2). No literal-precedence shortcut: when
 * both `/accounts/export` and `/accounts/{}` match the observation,
 * the transport status is known but handler attribution is ambiguous
 * and the claim blocks.
 *
 * Args:
 *   observedMethod: the witnessed record's method (any case).
 *   observedPath: the interpreted observed path (from
 *     `interpretObservedPath`).
 *   candidates: the complete host-derived route inventory.
 *   obligationResourceId: the obligation's own resource id.
 *
 * Returns:
 *   - `{status: 'incomplete', reason}` when any candidate carries an
 *     unknown/dynamic method or an unsupported shape (uniqueness
 *     cannot be established);
 *   - `{status: 'nomatch', reason}` when zero candidates match;
 *   - `{status: 'ambiguous', candidates}` with the sorted identity
 *     texts when more than one distinct resource matches;
 *   - `{status: 'mismatch', matched}` when exactly one candidate
 *     matches but it is a different endpoint;
 *   - `{status: 'match', matched}` when the unique match is the
 *     obligation's own endpoint.
 */
export declare function resolveHttpRoute(observedMethod: string, observedPath: string, candidates: readonly HttpRouteCandidate[], obligationResourceId: string): {
    status: 'match';
    matched: HttpRouteCandidate;
} | {
    status: 'mismatch';
    matched: HttpRouteCandidate;
} | {
    status: 'nomatch';
    reason: string;
} | {
    status: 'ambiguous';
    candidates: string[];
} | {
    status: 'incomplete';
    reason: string;
};
/**
 * Positional match of a concrete observed path against a compiled
 * canonical shape (ADR 0004 D2/D3 semantics): literal segments must be
 * equal, `{}` matches any single non-empty segment, and a TRAILING `{*}`
 * matches one or more trailing segments. Non-trailing wildcards and any
 * other shape never match. Case-sensitive.
 *
 * Args:
 *   observedPath: the concrete observed path (query already stripped).
 *   canonicalPath: the endpoint's compiled canonical shape.
 *
 * Returns:
 *   boolean: true only when the observed path instantiates the shape.
 */
export declare function pathMatchesShape(observedPath: string, canonicalPath: string): boolean;
/** Registers every pack namespace + the http namespace. Idempotent. */
export declare function registerPackVerifiers(): void;
//# sourceMappingURL=pack-verifiers.d.ts.map