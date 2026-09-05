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
/**
 * Classifies one call/route pair by match quality, or returns `null` when
 * the pair does not match under the documented positional rules. Pure and
 * order-independent; `routeMatchesCall` is exactly `kind !== null`.
 */
export function routeMatchKind(route, call) {
    if (route.method === 'ANY' || call.method === 'ANY')
        return null;
    if (route.method !== call.method)
        return null;
    const routeSegments = pathSegments(route.normalizedPath);
    const callSegments = pathSegments(call.normalizedPath);
    if (routeSegments.length === 0 || callSegments.length === 0) {
        // Root matches root, and only root: a vacuous all-literal match.
        return routeSegments.length === 0 && callSegments.length === 0 ? 'literal' : null;
    }
    const wildcard = routeSegments[routeSegments.length - 1] === HTTP_WILDCARD_SLOT;
    if (wildcard) {
        // Absorption is generality, not equality — see the wildcard rule and
        // the LITERAL PRECEDENCE note in the module docstring.
        return segmentsMatchWildcard(routeSegments, callSegments) ? 'parameter' : null;
    }
    if (!segmentsMatchExact(routeSegments, callSegments))
        return null;
    for (let index = 0; index < routeSegments.length; index += 1) {
        // Any position where the strings differ (route `{}` vs call literal,
        // or call `{}` vs route literal) consumed slot generality.
        if (routeSegments[index] !== callSegments[index])
            return 'parameter';
    }
    return 'literal';
}
/** Whether one call fact can join one route fact at all. */
export function routeMatchesCall(route, call) {
    return routeMatchKind(route, call) !== null;
}
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
        // Step 1 — all positional candidates, computed exactly as before.
        const candidates = [];
        for (const entry of byIdentity.values()) {
            const route = entry.routes[0];
            if (!route)
                continue;
            const kind = routeMatchKind(route, call);
            if (kind !== null)
                candidates.push({ entry, kind });
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
        // Steps 2/3 — LITERAL PRECEDENCE partition. Literal matches shadow
        // parameter matches because routers (FastAPI included) resolve literal
        // segments before parameterized ones at runtime; a wildcard match is a
        // parameter match and never shadows. Parameter-only candidates keep
        // today's behavior. No scoring: the partition is all-or-nothing.
        const selected = candidates.some((candidate) => candidate.kind === 'literal')
            ? candidates.filter((candidate) => candidate.kind === 'literal')
            : candidates;
        const distinct = new Map();
        for (const { entry } of selected) {
            const route = entry.routes[0];
            if (route)
                distinct.set(entry.identity, entry);
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
        const matched = selected[0]?.entry;
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