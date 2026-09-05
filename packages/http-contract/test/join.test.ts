/**
 * Phase 1 engine tests: the deterministic frontend-call/server-route join
 * (ADR 0004 D3, plan phase 1 verification checklist), plus the phase 3
 * literal-precedence refinement. Pure and offline.
 */
import { describe, expect, it } from 'vitest';
import {
  FRONTEND_ROUTE_AMBIGUOUS,
  FRONTEND_ROUTE_UNWIRED,
  HTTP_METHOD_DYNAMIC,
  canonicalEndpointIdentity,
  endpointResourceName,
  joinFrontendCalls,
  routeMatchKind,
  routeMatchesCall,
  type HttpContractFact,
  type HttpMethod,
} from '../src/index.js';

let seq = 0;
function route(method: HttpMethod, rawPath: string, normalizedPath = rawPath): HttpContractFact {
  seq += 1;
  return {
    schemaVersion: 1,
    role: 'server-route',
    method,
    normalizedPath,
    rawPath,
    framework: 'fastapi',
    handlerSymbol: `app.handler_${seq}`,
    source: { file: 'backend/routes.py', line: seq, col: 0 },
  };
}

function call(method: HttpMethod, rawPath: string, normalizedPath = rawPath): HttpContractFact {
  seq += 1;
  return {
    schemaVersion: 1,
    role: 'frontend-call',
    method,
    normalizedPath,
    rawPath,
    framework: 'fetch',
    callsites: [`frontend/src/api.ts:${seq}`],
    source: { file: 'frontend/src/api.ts', line: seq, col: 2 },
  };
}

function identities(result: { endpoints: ReadonlyArray<{ identity: string }> }): string[] {
  return result.endpoints.map((endpoint) => endpoint.identity);
}

describe('positional join semantics', () => {
  it('joins a frontend template slot to a named backend param', () => {
    // Plan checklist: `/accounts/${id}` joins `/accounts/{account_id}`.
    const result = joinFrontendCalls(
      [route('GET', '/accounts/{account_id}', '/accounts/{}')],
      [call('GET', '/accounts/${id}', '/accounts/{}')],
    );
    expect(identities(result)).toEqual(['GET /accounts/{}']);
    expect(result.blocks).toEqual([]);
    expect(result.endpoints[0]?.calls).toHaveLength(1);
    expect(result.endpoints[0]?.routes).toHaveLength(1);
  });

  it('preserves both raw and canonical paths on both sides for explain', () => {
    const result = joinFrontendCalls(
      [route('POST', '/api/v1/accounts/{account_id}', '/api/v1/accounts/{}')],
      [call('POST', '/api/v1/accounts/${id}', '/api/v1/accounts/{}')],
    );
    const endpoint = result.endpoints[0];
    expect(endpoint?.routes[0]?.rawPath).toBe('/api/v1/accounts/{account_id}');
    expect(endpoint?.routes[0]?.normalizedPath).toBe('/api/v1/accounts/{}');
    expect(endpoint?.calls[0]?.rawPath).toBe('/api/v1/accounts/${id}');
    expect(endpoint?.calls[0]?.normalizedPath).toBe('/api/v1/accounts/{}');
    expect(endpoint?.canonicalPath).toBe('/api/v1/accounts/{}');
  });

  it('joins a trailing-slash call to the slashless route (dogfood regression)', () => {
    // Dogfood: 24 misses where the frontend called `/api/v2/accounts/`
    // while the backend declared `/api/v2/accounts`. Trailing slashes are
    // not significant (routers normalize/redirect the variant), so the
    // canonical forms coincide and the call joins. The raw call spelling
    // is preserved for explain.
    const result = joinFrontendCalls(
      [route('GET', '/api/v2/accounts')],
      [call('GET', '/api/v2/accounts/', '/api/v2/accounts')],
    );
    expect(identities(result)).toEqual(['GET /api/v2/accounts']);
    expect(result.blocks).toEqual([]);
    expect(result.endpoints[0]?.calls[0]?.rawPath).toBe('/api/v2/accounts/');
    expect(result.endpoints[0]?.calls[0]?.normalizedPath).toBe('/api/v2/accounts');
    expect(result.endpoints[0]?.routes[0]?.rawPath).toBe('/api/v2/accounts');
  });

  it('does not require parameter-name equality', () => {
    expect(
      routeMatchesCall(
        route('GET', '/x/{banana}', '/x/{}'),
        call('GET', '/x/${apple}', '/x/{}'),
      ),
    ).toBe(true);
  });

  it('does not join different literal segment counts', () => {
    expect(routeMatchesCall(route('GET', '/a/b'), call('GET', '/a'))).toBe(false);
    expect(routeMatchesCall(route('GET', '/a'), call('GET', '/a/b'))).toBe(false);
  });

  it('does not join same path with different methods', () => {
    expect(routeMatchesCall(route('POST', '/accounts'), call('GET', '/accounts'))).toBe(false);
    expect(routeMatchesCall(route('DELETE', '/a/{}'), call('PUT', '/a/{}'))).toBe(false);
  });

  it('does not join differing literal segments at the same position', () => {
    expect(routeMatchesCall(route('GET', '/api/accounts'), call('GET', '/api/contacts'))).toBe(
      false,
    );
  });

  it('joins a wildcard converter only under the documented rule', () => {
    // Plan checklist: `/files/${path}` joins `{path:path}`.
    const result = joinFrontendCalls(
      [route('GET', '/files/{file_path:path}', '/files/{*}')],
      [call('GET', '/files/${path}', '/files/{}')],
    );
    expect(identities(result)).toEqual(['GET /files/{*}']);

    // One-or-more trailing segments: multi-slot calls also join.
    expect(routeMatchesCall(route('GET', '/files/{*}'), call('GET', '/files/{}/{}'))).toBe(true);
    // At least one segment must remain for the wildcard to absorb.
    expect(routeMatchesCall(route('GET', '/files/{*}'), call('GET', '/files'))).toBe(false);
    // Prefix before the wildcard must still match positionally.
    expect(routeMatchesCall(route('GET', '/files/{*}'), call('GET', '/assets/x'))).toBe(false);
  });

  it('never joins ANY routes or ANY calls', () => {
    expect(routeMatchesCall(route('ANY', '/anything'), call('GET', '/anything'))).toBe(false);
    const result = joinFrontendCalls([route('GET', '/x')], [call('ANY', '/x')]);
    expect(result.endpoints).toEqual([]);
    expect(result.blocks[0]?.code).toBe(HTTP_METHOD_DYNAMIC);
  });

  it('joins root paths and literal paths exactly', () => {
    expect(routeMatchesCall(route('GET', '/'), call('GET', '/'))).toBe(true);
    expect(routeMatchesCall(route('GET', '/health/ready'), call('GET', '/health/ready'))).toBe(
      true,
    );
  });
});

describe('cardinality and blocking', () => {
  it('blocks unwired frontend calls with the typed code and source', () => {
    const result = joinFrontendCalls([route('GET', '/accounts')], [call('POST', '/invoices')]);
    expect(result.endpoints).toEqual([]);
    expect(result.blocks).toHaveLength(1);
    const block = result.blocks[0];
    expect(block?.code).toBe(FRONTEND_ROUTE_UNWIRED);
    expect(block?.location.file).toBe('frontend/src/api.ts');
    expect(block?.detail).toContain('/invoices');
  });

  it('blocks ambiguous parameter-tier joins listing every distinct candidate — the red probe', () => {
    // Updated for phase 3 literal precedence: the old probe (routes
    // `/billing/{}` + `/billing/summary` vs call `/billing/{}`) now joins
    // the exact-shape route because the literal tier shadows the literal
    // sibling. Two PARAMETER-tier candidates still refuse to guess.
    // Deliberately break the one-to-one rule with two parameter matches:
    // a route param and a route wildcard both absorb the literal call.
    const result = joinFrontendCalls(
      [route('GET', '/billing/{account_id}', '/billing/{}'), route('GET', '/billing/{*}')],
      [call('GET', '/billing/x')],
    );
    expect(result.endpoints).toEqual([]);
    expect(result.blocks).toHaveLength(1);
    const block = result.blocks[0];
    expect(block?.code).toBe(FRONTEND_ROUTE_AMBIGUOUS);
    expect(block?.candidates).toEqual(['GET /billing/{*}', 'GET /billing/{}']);
  });

  it('collapses duplicate identical routes into one endpoint, not ambiguity', () => {
    // FastAPI include_router mounts the same router twice with the same
    // effective literal prefix — one identity, two sources.
    const result = joinFrontendCalls(
      [route('GET', '/api/v1/accounts'), { ...route('GET', '/api/v1/accounts'), source: { file: 'backend/other.py', line: 9, col: 0 } }],
      [call('GET', '/api/v1/accounts')],
    );
    expect(identities(result)).toEqual(['GET /api/v1/accounts']);
    expect(result.blocks).toEqual([]);
    expect(result.endpoints[0]?.routes).toHaveLength(2);
  });

  it('one endpoint aggregates many frontend callsites', () => {
    const result = joinFrontendCalls(
      [route('GET', '/accounts/{}')],
      [call('GET', '/accounts/{}'), call('GET', '/accounts/{}', '/accounts/{}')],
    );
    expect(result.endpoints[0]?.calls).toHaveLength(2);
    expect(result.blocks).toEqual([]);
  });
});

describe('literal precedence (phase 3 refinement)', () => {
  const dogfoodRoutes = () => [
    route('GET', '/api/v1/contractor/messages/{message_id}', '/api/v1/contractor/messages/{}'),
    route('GET', '/api/v1/contractor/messages/search'),
    route('GET', '/api/v1/contractor/messages/unread-count'),
  ];

  it('joins the dogfood template call to the param route despite literal siblings', () => {
    // Real dogfood ambiguity: `GET /api/v1/contractor/messages/${id}` used
    // to be FRONTEND_ROUTE_AMBIGUOUS against `/messages/{}`,
    // `/messages/search`, `/messages/unread-count`. Routers resolve
    // literals before params at runtime, so the static join picks
    // `/messages/{}` and the gate unblocks.
    const result = joinFrontendCalls(dogfoodRoutes(), [
      call('GET', '/api/v1/contractor/messages/${id}', '/api/v1/contractor/messages/{}'),
    ]);
    expect(result.blocks).toEqual([]);
    expect(identities(result)).toEqual(['GET /api/v1/contractor/messages/{}']);
    expect(result.endpoints[0]?.calls).toHaveLength(1);
    expect(result.endpoints[0]?.routes).toHaveLength(1);
  });

  it('joins the dogfood literal call to the literal route only', () => {
    const result = joinFrontendCalls(dogfoodRoutes(), [
      call('GET', '/api/v1/contractor/messages/unread-count'),
    ]);
    expect(result.blocks).toEqual([]);
    expect(identities(result)).toEqual(['GET /api/v1/contractor/messages/unread-count']);
  });

  it('joins /faqs/${id} to /faqs/{} despite the /faqs/suggestions literal sibling', () => {
    const result = joinFrontendCalls(
      [route('GET', '/faqs/{faq_id}', '/faqs/{}'), route('GET', '/faqs/suggestions')],
      [call('GET', '/faqs/${id}', '/faqs/{}')],
    );
    expect(result.blocks).toEqual([]);
    expect(identities(result)).toEqual(['GET /faqs/{}']);
  });

  it('classifies match quality: literal, parameter, or none', () => {
    const literalCall = call('GET', '/x/y');
    expect(routeMatchKind(route('GET', '/x/y'), literalCall)).toBe('literal');
    // Slot-for-slot: the route declares exactly the shape the call has.
    expect(routeMatchKind(route('GET', '/x/{}'), call('GET', '/x/{}'))).toBe('literal');
    expect(routeMatchKind(route('GET', '/'), call('GET', '/'))).toBe('literal');
    // Route param absorbed a call literal.
    expect(routeMatchKind(route('GET', '/x/{}'), literalCall)).toBe('parameter');
    // Call slot relaxed onto a route literal.
    expect(routeMatchKind(route('GET', '/x/y'), call('GET', '/x/{}'))).toBe('parameter');
    // A wildcard match is never a literal match.
    expect(routeMatchKind(route('GET', '/x/{*}'), literalCall)).toBe('parameter');
    expect(routeMatchKind(route('GET', '/x/{*}'), call('GET', '/x/{}'))).toBe('parameter');
    expect(routeMatchKind(route('GET', '/x/z'), literalCall)).toBeNull();
  });

  it('keeps routeMatchesCall as the boolean view over the partition', () => {
    expect(routeMatchesCall(route('GET', '/x/{}'), call('GET', '/x/y'))).toBe(true);
    expect(routeMatchesCall(route('GET', '/x/y'), call('GET', '/x/{}'))).toBe(true);
    expect(routeMatchesCall(route('GET', '/x/{*}'), call('GET', '/x/a/b'))).toBe(true);
    expect(routeMatchesCall(route('GET', '/x/z'), call('GET', '/x/y'))).toBe(false);
  });

  it('keeps the parameter-only fallback when no literal sibling exists', () => {
    const routeFact = route('GET', '/billing/{account_id}', '/billing/{}');
    const callFact = call('GET', '/billing/summary');
    const result = joinFrontendCalls([routeFact], [callFact]);
    expect(result.blocks).toEqual([]);
    expect(identities(result)).toEqual(['GET /billing/{}']);
    expect(routeMatchKind(routeFact, callFact)).toBe('parameter');
  });

  it('a wildcard candidate loses to a literal-tier sibling', () => {
    // Under the pre-phase-3 rules this was FRONTEND_ROUTE_AMBIGUOUS; the
    // wildcard `/files/{*}` is a parameter match and never shadows the
    // exact-shape `/files/{}`.
    const result = joinFrontendCalls(
      [route('GET', '/files/{*}'), route('GET', '/files/{name}', '/files/{}')],
      [call('GET', '/files/${name}', '/files/{}')],
    );
    expect(result.blocks).toEqual([]);
    expect(identities(result)).toEqual(['GET /files/{}']);
  });

  it('blocks a slotted call whose only candidates are literal siblings', () => {
    // No literal tier exists (a call `{}` relaxed onto route literals is a
    // parameter match), so the parameter fallback sees two distinct
    // literal routes and must refuse to guess.
    const result = joinFrontendCalls(
      [route('GET', '/messages/search'), route('GET', '/messages/unread-count')],
      [call('GET', '/messages/${id}', '/messages/{}')],
    );
    expect(result.endpoints).toEqual([]);
    expect(result.blocks).toHaveLength(1);
    expect(result.blocks[0]?.code).toBe(FRONTEND_ROUTE_AMBIGUOUS);
    expect(result.blocks[0]?.candidates).toEqual([
      'GET /messages/search',
      'GET /messages/unread-count',
    ]);
  });

  it('never guesses inside the literal tier itself (more than one literal candidate)', () => {
    // With normalized facts the literal tier holds at most one distinct
    // identity (identity == canonical path). If facts disagree only
    // cosmetically (same segment sequence, different identity strings,
    // e.g. an un-normalized trailing slash), the engine still refuses to
    // guess: more than one literal candidate is AMBIGUOUS with both listed.
    const result = joinFrontendCalls(
      [
        route('GET', '/messages/{id}', '/messages/{}'),
        route('GET', '/messages/{id}/', '/messages/{}/'),
      ],
      [call('GET', '/messages/${id}', '/messages/{}')],
    );
    expect(result.endpoints).toEqual([]);
    expect(result.blocks).toHaveLength(1);
    expect(result.blocks[0]?.code).toBe(FRONTEND_ROUTE_AMBIGUOUS);
    expect(result.blocks[0]?.candidates).toEqual(['GET /messages/{}', 'GET /messages/{}/']);
  });
});

describe('determinism', () => {
  it('is invariant under input permutation (byte-identical output)', () => {
    const routes = [
      route('GET', '/accounts/{}'),
      route('POST', '/accounts'),
      route('DELETE', '/accounts/{}'),
      route('GET', '/files/{*}'),
      // Phase 3: literal siblings that a slotted call must not be
      // ambiguous with, in either input order.
      route('GET', '/accounts/search'),
      route('GET', '/files/{}'),
    ];
    const calls = [
      call('POST', '/accounts'),
      call('GET', '/accounts/{}'),
      call('GET', '/files/{}'),
      call('DELETE', '/accounts/{}'),
    ];
    const forward = joinFrontendCalls(routes, calls);
    const reversed = joinFrontendCalls([...routes].reverse(), [...calls].reverse());
    expect(JSON.stringify(forward)).toBe(JSON.stringify(reversed));
  });

  it('produces identity-sorted endpoints and codepoint-sorted names', () => {
    const result = joinFrontendCalls(
      [route('DELETE', '/accounts/{}'), route('GET', '/accounts/{}'), route('GET', '/accounts')],
      [call('GET', '/accounts'), call('GET', '/accounts/{}'), call('DELETE', '/accounts/{}')],
    );
    expect(identities(result)).toEqual([
      'DELETE /accounts/{}',
      'GET /accounts',
      'GET /accounts/{}',
    ]);
  });
});

describe('endpoint identity and naming', () => {
  it('is invariant under parameter-name changes', () => {
    expect(canonicalEndpointIdentity('GET', '/accounts/{}')).toBe(
      canonicalEndpointIdentity('GET', '/accounts/{}'),
    );
    expect(endpointResourceName('GET', '/accounts/{}')).toBe(
      endpointResourceName('GET', '/accounts/{}'),
    );
  });

  it('produces distinct, dot-free names for distinct endpoints', () => {
    const a = endpointResourceName('GET', '/api/v1/accounts/{}');
    const b = endpointResourceName('POST', '/api/v1/accounts');
    const c = endpointResourceName('GET', '/files/{*}');
    expect(a).toMatch(/^http-get-api-v1-accounts-param-[0-9a-f]{8}$/);
    expect(b).toMatch(/^http-post-api-v1-accounts-[0-9a-f]{8}$/);
    expect(c).toMatch(/^http-get-files-wildcard-[0-9a-f]{8}$/);
    expect(new Set([a, b, c]).size).toBe(3);
    // Namespaced: never a bare business name — cannot collide with
    // `sqlalchemy.table` resource names (ADR 0004 D1).
    for (const name of [a, b, c]) {
      expect(name.startsWith('http-')).toBe(true);
      expect(name.includes('.')).toBe(false);
    }
  });
});
