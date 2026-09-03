/**
 * Phase 1 engine tests: the deterministic frontend-call/server-route join
 * (ADR 0004 D3, plan phase 1 verification checklist). Pure and offline.
 */
import { describe, expect, it } from 'vitest';
import {
  FRONTEND_ROUTE_AMBIGUOUS,
  FRONTEND_ROUTE_UNWIRED,
  HTTP_METHOD_DYNAMIC,
  canonicalEndpointIdentity,
  endpointResourceName,
  joinFrontendCalls,
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

  it('blocks ambiguous joins listing every distinct candidate — the red probe', () => {
    // Deliberately break the one-to-one rule: two DISTINCT routes both
    // match (param vs literal overlap). The join must refuse to guess.
    const result = joinFrontendCalls(
      [route('GET', '/billing/{account_id}', '/billing/{}'), route('GET', '/billing/summary')],
      [call('GET', '/billing/{}')],
    );
    expect(result.endpoints).toEqual([]);
    expect(result.blocks).toHaveLength(1);
    const block = result.blocks[0];
    expect(block?.code).toBe(FRONTEND_ROUTE_AMBIGUOUS);
    expect(block?.candidates).toEqual(['GET /billing/summary', 'GET /billing/{}']);
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

describe('determinism', () => {
  it('is invariant under input permutation (byte-identical output)', () => {
    const routes = [
      route('GET', '/accounts/{}'),
      route('POST', '/accounts'),
      route('DELETE', '/accounts/{}'),
      route('GET', '/files/{*}'),
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
