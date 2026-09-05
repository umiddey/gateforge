/**
 * Deterministic one-to-one join engine (ADR 0004 D3).
 *
 * A frontend consumption exists only when one frontend-call fact joins
 * exactly one distinct backend route identity: equal uppercase method,
 * position-wise segment match where a frontend `{}` matches any single
 * route segment (param or literal) and a trailing route `{*}` matches one
 * or more trailing call segments.
 *
 * LITERAL PRECEDENCE (phase 3 refinement). Positional candidates are
 * partitioned by match quality before the exactly-one check:
 *
 *  - A match is *literal* when it consumed no slot generality: every
 *    matched position is exact segment equality — literal==literal, or the
 *    call's own `{}` mirrored by the route's `{}` (the route then declares
 *    exactly the shape the call already has; nothing is absorbed beyond
 *    what the call itself carries).
 *  - A match is *parameter* otherwise: a route `{}` absorbed a call
 *    literal, a call `{}` was relaxed onto a route literal, or any `{*}`
 *    absorption happened. A wildcard match is never a literal match.
 *
 * If any literal matches exist they are THE candidates; parameter-only
 * matches are considered only when zero literal matches exist. This
 * mirrors runtime routing truth: FastAPI — like every major router —
 * resolves literal path segments before parameterized ones, so a request
 * to `/messages/search` always hits the literal route and never reaches
 * `/messages/{}` with id="search". The static join must agree: a
 * template call `/messages/${id}` joins `/messages/{}` despite literal
 * siblings, and a literal call `/messages/unread-count` joins only the
 * literal route.
 *
 * Never guess: zero selected candidates and multiple distinct selected
 * candidates (in either tier) are typed blocks — there is no scoring, no
 * fuzzy distance, and no first-match-wins beyond the documented partition.
 *
 * The result is a pure function of the input facts: identical inputs in
 * any permutation produce byte-identical output (total order everywhere).
 */
import { FRONTEND_ROUTE_AMBIGUOUS, FRONTEND_ROUTE_UNWIRED, HTTP_METHOD_DYNAMIC } from './codes.js';
import type { HttpContractFact, HttpLocation, HttpMethod } from './schema.js';
/** Canonical identity of an endpoint: `<METHOD> <canonicalPath>`. */
export type EndpointIdentity = string;
/** Canonical identity string for a method/path pair. */
export declare function canonicalEndpointIdentity(method: HttpMethod, canonicalPath: string): EndpointIdentity;
/**
 * Deterministic, collision-safe endpoint resource name (ADR 0004 D1):
 * `http-<method>-<path-slug>-<sha8>`. The slug keeps reports readable; the
 * identity hash suffix makes distinct endpoints collision-free even when
 * sanitization would coincide (dot vs dash), and is invariant under
 * parameter-name changes because it hashes the canonical form.
 */
export declare function endpointResourceName(method: HttpMethod, canonicalPath: string): string;
/** One joined endpoint: a route identity plus every fact on either side. */
export interface JoinedEndpoint {
    method: HttpMethod;
    canonicalPath: string;
    identity: EndpointIdentity;
    /** Resource name for the compiled `http.endpoint` resource (ADR 0004 D1). */
    resourceName: string;
    /** Every distinct server-route fact carrying this identity (duplicates collapsed). */
    routes: HttpContractFact[];
    /** Every frontend-call fact joined to this identity, source order sorted. */
    calls: HttpContractFact[];
}
/** A typed, source-located join failure. */
export interface JoinBlock {
    code: typeof FRONTEND_ROUTE_UNWIRED | typeof FRONTEND_ROUTE_AMBIGUOUS | typeof HTTP_METHOD_DYNAMIC;
    detail: string;
    location: HttpLocation;
    /** Identity candidates for ambiguity blocks — the surviving
     * literal-precedence tier, sorted; empty otherwise. */
    candidates: EndpointIdentity[];
}
export interface JoinResult {
    /** Joined endpoints, sorted by identity. */
    endpoints: JoinedEndpoint[];
    /** Typed blocks (unwired/ambiguous/dynamic-method), deterministically sorted. */
    blocks: JoinBlock[];
}
/**
 * Match-quality tier of one route/call pair (LITERAL PRECEDENCE).
 *
 * - `'literal'` — matched with zero slot generality: every matched position
 *   is exact segment equality (literal==literal, or the call's own `{}`
 *   mirrored by the route's `{}`; the route consumed nothing beyond what
 *   the call itself declares).
 * - `'parameter'` — matched, but at least one position exercised slot
 *   generality: a route `{}` absorbed a call literal, a call `{}` was
 *   relaxed onto a route literal, or the trailing route `{*}` absorbed one
 *   or more call segments. A wildcard match is never a literal match.
 * - `null` — no positional match at all.
 */
export type RouteMatchKind = 'literal' | 'parameter';
/**
 * Classifies one call/route pair by match quality, or returns `null` when
 * the pair does not match under the documented positional rules. Pure and
 * order-independent; `routeMatchesCall` is exactly `kind !== null`.
 */
export declare function routeMatchKind(route: HttpContractFact, call: HttpContractFact): RouteMatchKind | null;
/** Whether one call fact can join one route fact at all. */
export declare function routeMatchesCall(route: HttpContractFact, call: HttpContractFact): boolean;
/**
 * Joins frontend-call facts against server-route facts.
 *
 * Candidate selection applies LITERAL PRECEDENCE (see the module
 * docstring): literal matches shadow parameter matches, mirroring how
 * routers resolve literal segments before parameterized ones at runtime.
 *
 * `ANY` routes participate in the inventory (they carry exposure evidence)
 * but never join: a catch-all registration cannot prove which concrete
 * method the frontend exercised. Calls with a non-concrete method produce
 * `HTTP_METHOD_DYNAMIC` blocks.
 */
export declare function joinFrontendCalls(routes: readonly HttpContractFact[], calls: readonly HttpContractFact[]): JoinResult;
//# sourceMappingURL=join.d.ts.map