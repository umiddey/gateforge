/**
 * Unit tests of `matchHttpRoute` — the ONE obligation-free route
 * resolver (WP2: one route resolver). The 4 matcher cases here are
 * ported from the deleted http-contract `matchExchange` (WP1) so the
 * router semantics live with the single matcher in core; the
 * obligation-aware wrapper (`resolveHttpRoute`) stays pinned by
 * verifier-registry.test.ts.
 */
import { describe, expect, it } from 'vitest';
import type { HttpRouteCandidate } from '../src/verdict/registry.js';
import { interpretObservedPath, matchHttpRoute } from '../src/verdict/pack-verifiers.js';

/** One candidate with the given identity, shape, and optional order. */
function route(
  resourceId: string,
  method: string,
  canonicalPath: string,
  registration?: { scope: string; order: number },
): HttpRouteCandidate {
  return {
    resourceId,
    method,
    canonicalPath,
    ...(registration === undefined ? {} : { registration }),
  };
}

describe('matchHttpRoute — the one route resolver (router semantics)', () => {
  const table = [
    route('http.endpoint:GET /items/actions', 'GET', '/items/actions', { scope: 'fixture:app', order: 0 }),
    route('http.endpoint:GET /items/{}', 'GET', '/items/{}', { scope: 'fixture:app', order: 1 }),
    route('http.endpoint:GET /items/{*}', 'GET', '/items/{*}', { scope: 'fixture:app', order: 2 }),
    route('http.endpoint:POST /items', 'POST', '/items', { scope: 'fixture:app', order: 3 }),
  ];

  it('resolves the first registered full match (literal first only when registered first)', () => {
    expect(matchHttpRoute('GET', '/items/actions', table)).toEqual({
      status: 'match',
      matched: table[0],
    });
  });

  it('resolves a registered parameter route before a later literal route when the router does so', () => {
    const parameterFirst = [
      route('http.endpoint:GET /items/{}', 'GET', '/items/{}', { scope: 'fixture:app', order: 0 }),
      route('http.endpoint:GET /items/actions', 'GET', '/items/actions', { scope: 'fixture:app', order: 1 }),
    ];
    expect(matchHttpRoute('GET', '/items/actions', parameterFirst)).toEqual({
      status: 'match',
      matched: parameterFirst[0],
    });
  });

  it('accepts trailing-slash variants and ignores query strings', () => {
    // Callers pass the INTERPRETED path (the verifier path runs
    // `interpretObservedPath` first) — query stripped, trailing slash
    // preserved for the matcher's empty-segment filter.
    const interpreted = interpretObservedPath('/items/actions/?page=2');
    if (interpreted.ok === false) throw new Error(interpreted.reason);
    expect(matchHttpRoute('GET', interpreted.path, table)).toEqual({
      status: 'match',
      matched: table[0],
    });
  });

  it('never matches on a method mismatch (nomatch, not a route)', () => {
    expect(matchHttpRoute('DELETE', '/items/actions', table).status).toBe('nomatch');
  });

  it('fails closed as ambiguous when equal matches carry no proven registration order', () => {
    const unordered = [
      route('http.endpoint:GET /items/{}', 'GET', '/items/{}'),
      route('http.endpoint:GET /items/{*}', 'GET', '/items/{*}'),
    ];
    expect(matchHttpRoute('GET', '/items/actions', unordered)).toEqual({
      status: 'ambiguous',
      candidates: [
        'GET /items/{*} (http.endpoint:GET /items/{*})',
        'GET /items/{} (http.endpoint:GET /items/{})',
      ],
    });
  });

  it('grades an unattributable inventory entry incomplete (uniqueness cannot be established)', () => {
    const incomplete = [
      route('http.endpoint:GET /items/{}', 'GET', '/items/{}'),
      route('http.endpoint:ANY /items', 'ANY', '/items'),
    ];
    const outcome = matchHttpRoute('GET', '/items', incomplete);
    expect(outcome.status).toBe('incomplete');
    expect(outcome).toMatchObject({ status: 'incomplete' });
    if (outcome.status === 'incomplete') {
      expect(outcome.reason).toContain('not attributable');
    }
  });
});
