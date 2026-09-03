/**
 * Deterministic one-to-one join engine (ADR 0004 D3).
 *
 * A frontend consumption exists only when one frontend-call fact joins
 * exactly one distinct backend route identity: equal uppercase method,
 * position-wise segment match where a frontend `{}` matches any single
 * route segment (param or literal) and a trailing route `{*}` matches one
 * or more trailing call segments. Zero matches and multiple distinct
 * matches are typed blocks — there is no scoring, no fuzzy distance, and
 * no first-match-wins.
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
    /** Identity candidates for ambiguity blocks, sorted; empty otherwise. */
    candidates: EndpointIdentity[];
}
export interface JoinResult {
    /** Joined endpoints, sorted by identity. */
    endpoints: JoinedEndpoint[];
    /** Typed blocks (unwired/ambiguous/dynamic-method), deterministically sorted. */
    blocks: JoinBlock[];
}
/** Whether one call fact can join one route fact. */
export declare function routeMatchesCall(route: HttpContractFact, call: HttpContractFact): boolean;
/**
 * Joins frontend-call facts against server-route facts.
 *
 * `ANY` routes participate in the inventory (they carry exposure evidence)
 * but never join: a catch-all registration cannot prove which concrete
 * method the frontend exercised. Calls with a non-concrete method produce
 * `HTTP_METHOD_DYNAMIC` blocks.
 */
export declare function joinFrontendCalls(routes: readonly HttpContractFact[], calls: readonly HttpContractFact[]): JoinResult;
//# sourceMappingURL=join.d.ts.map