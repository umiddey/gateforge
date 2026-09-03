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
import { createHash } from 'node:crypto';
import { FRONTEND_ROUTE_AMBIGUOUS, FRONTEND_ROUTE_UNWIRED, HTTP_METHOD_DYNAMIC, } from './codes.js';
import { HTTP_PARAM_SLOT, HTTP_WILDCARD_SLOT, pathSegments } from './normalize.js';
/** Canonical identity string for a method/path pair. */
export function canonicalEndpointIdentity(method, canonicalPath) {
    return `${method} ${canonicalPath}`;
}
/**
 * Deterministic, collision-safe endpoint resource name (ADR 0004 D1):
 * `http-<method>-<path-slug>-<sha8>`. The slug keeps reports readable; the
 * identity hash suffix makes distinct endpoints collision-free even when
 * sanitization would coincide (dot vs dash), and is invariant under
 * parameter-name changes because it hashes the canonical form.
 */
export function endpointResourceName(method, canonicalPath) {
    const identity = canonicalEndpointIdentity(method, canonicalPath);
    const slug = canonicalPath
        .split('/')
        .filter((segment) => segment !== '')
        .map((segment) => {
        if (segment === HTTP_PARAM_SLOT)
            return 'param';
        if (segment === HTTP_WILDCARD_SLOT)
            return 'wildcard';
        return segment
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-+|-+$/g, '');
    })
        .filter((segment) => segment !== '')
        .join('-');
    const hash = createHash('sha256').update(identity).digest('hex').slice(0, 8);
    const base = slug.length > 0 ? slug : 'root';
    return `http-${method.toLowerCase()}-${base}-${hash}`;
}
/** Positional segment match for a route without a trailing wildcard. */
function segmentsMatchExact(routeSegments, callSegments) {
    if (routeSegments.length !== callSegments.length)
        return false;
    for (let index = 0; index < routeSegments.length; index += 1) {
        const routeSegment = routeSegments[index] ?? '';
        const callSegment = callSegments[index] ?? '';
        if (routeSegment === callSegment)
            continue; // literal==literal or slot==slot
        if (routeSegment === HTTP_PARAM_SLOT)
            continue; // backend param matches any call segment
        if (callSegment === HTTP_PARAM_SLOT)
            continue; // frontend slot matches any route segment
        return false;
    }
    return true;
}
/**
 * Wildcard rule (ADR 0004 D3, the only one): a trailing route `{*}`
 * matches one or more trailing call segments; everything before it must
 * match positionally. Non-trailing wildcards never join.
 */
function segmentsMatchWildcard(routeSegments, callSegments) {
    const wildcardIndex = routeSegments.length - 1;
    if (callSegments.length < routeSegments.length)
        return false; // needs >=1 absorbed segment
    for (let index = 0; index < wildcardIndex; index += 1) {
        const routeSegment = routeSegments[index] ?? '';
        const callSegment = callSegments[index] ?? '';
        if (routeSegment === callSegment)
            continue;
        if (routeSegment === HTTP_PARAM_SLOT)
            continue;
        if (callSegment === HTTP_PARAM_SLOT)
            continue;
        return false;
    }
    return true;
}
/** Whether one call fact can join one route fact. */
export function routeMatchesCall(route, call) {
    if (route.method === 'ANY' || call.method === 'ANY')
        return false;
    if (route.method !== call.method)
        return false;
    const routeSegments = pathSegments(route.normalizedPath);
    const callSegments = pathSegments(call.normalizedPath);
    if (routeSegments.length === 0 || callSegments.length === 0) {
        return routeSegments.length === 0 && callSegments.length === 0;
    }
    const wildcard = routeSegments[routeSegments.length - 1] === HTTP_WILDCARD_SLOT;
    return wildcard
        ? segmentsMatchWildcard(routeSegments, callSegments)
        : segmentsMatchExact(routeSegments, callSegments);
}
/**
 * Joins frontend-call facts against server-route facts.
 *
 * `ANY` routes participate in the inventory (they carry exposure evidence)
 * but never join: a catch-all registration cannot prove which concrete
 * method the frontend exercised. Calls with a non-concrete method produce
 * `HTTP_METHOD_DYNAMIC` blocks.
 */
export function joinFrontendCalls(routes, calls) {
    const byIdentity = new Map();
    for (const route of routes) {
        if (route.role !== 'server-route' || route.method === 'ANY')
            continue;
        const identity = canonicalEndpointIdentity(route.method, route.normalizedPath);
        const entry = byIdentity.get(identity);
        if (entry) {
            pushUniqueFact(entry.routes, route);
        }
        else {
            byIdentity.set(identity, { identity, routes: [route], calls: [] });
        }
    }
    const blocks = [];
    const seenBlockKeys = new Set();
    for (const call of calls) {
        if (call.role !== 'frontend-call')
            continue;
        if (call.method === 'ANY') {
            pushBlock(blocks, seenBlockKeys, {
                code: HTTP_METHOD_DYNAMIC,
                detail: `frontend call to '${call.rawPath}' has no statically provable method`,
                location: call.source,
                candidates: [],
            });
            continue;
        }
        const candidates = [];
        for (const entry of byIdentity.values()) {
            const route = entry.routes[0];
            if (route && routeMatchesCall(route, call))
                candidates.push(entry);
        }
        if (candidates.length === 0) {
            pushBlock(blocks, seenBlockKeys, {
                code: FRONTEND_ROUTE_UNWIRED,
                detail: `frontend call '${call.method} ${call.rawPath}' matches no backend route`,
                location: call.source,
                candidates: [],
            });
            continue;
        }
        const distinct = new Map();
        for (const candidate of candidates) {
            const route = candidate.routes[0];
            if (route)
                distinct.set(candidate.identity, candidate);
        }
        if (distinct.size > 1) {
            pushBlock(blocks, seenBlockKeys, {
                code: FRONTEND_ROUTE_AMBIGUOUS,
                detail: `frontend call '${call.method} ${call.rawPath}' matches ${distinct.size} distinct backend routes`,
                location: call.source,
                candidates: [...distinct.keys()].sort(compareStrings),
            });
            continue;
        }
        const matched = candidates[0];
        if (matched) {
            pushUniqueFact(matched.calls, call);
        }
    }
    const endpoints = [...byIdentity.values()]
        .filter((entry) => entry.calls.length > 0)
        .map((entry) => {
        const route = entry.routes[0];
        const method = route?.method ?? 'GET';
        return {
            method,
            canonicalPath: route?.normalizedPath ?? '/',
            identity: entry.identity,
            resourceName: endpointResourceName(method, route?.normalizedPath ?? '/'),
            routes: sortFacts(entry.routes),
            calls: sortFacts(entry.calls),
        };
    })
        .sort((a, b) => compareStrings(a.identity, b.identity));
    return { endpoints, blocks: sortBlocks(blocks) };
}
function pushUniqueFact(list, fact) {
    const key = JSON.stringify(fact);
    if (!list.some((existing) => JSON.stringify(existing) === key))
        list.push(fact);
}
function pushBlock(list, seen, block) {
    const key = JSON.stringify([block.code, block.detail, block.location, block.candidates]);
    if (seen.has(key))
        return;
    seen.add(key);
    list.push(block);
}
function sortFacts(facts) {
    return [...facts].sort((a, b) => compareStrings(JSON.stringify(a), JSON.stringify(b)));
}
function sortBlocks(blocks) {
    return [...blocks].sort((a, b) => compareStrings(a.location.file, b.location.file) ||
        (a.location.line || 0) - (b.location.line || 0) ||
        (a.location.col || 0) - (b.location.col || 0) ||
        compareStrings(a.code, b.code) ||
        compareStrings(a.detail, b.detail));
}
function compareStrings(a, b) {
    if (a === b)
        return 0;
    return a < b ? -1 : 1;
}
//# sourceMappingURL=join.js.map