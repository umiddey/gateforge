import { describe, expect, it } from 'vitest';
import {
  matchExchange,
  mergeRouteSources,
  routeTableFromOpenApi,
  type HttpContractFact,
} from '../src/index.js';

const openapi = {
  openapi: '3.1.0',
  info: { title: 'Fixture API', version: '1.0' },
  paths: {
    '/items/{item_id}': {
      get: { operationId: 'get_item' },
    },
    '/items/actions': {
      get: { operationId: 'list_actions' },
    },
    '/openapi-only': {
      post: { operationId: 'create_openapi_only' },
    },
  },
};

function detectorRoute(
  method: HttpContractFact['method'],
  normalizedPath: string,
  order: number,
): HttpContractFact {
  return {
    schemaVersion: 1,
    role: 'server-route',
    method,
    normalizedPath,
    rawPath: normalizedPath,
    framework: 'fastapi',
    registration: { scope: 'fixture:app', order },
    source: { file: 'routes.ts', line: order + 1, col: 0 },
  };
}

describe('route table sources', () => {
  it('extracts OpenAPI path templates and operation ids without reordering by detector precedence', () => {
    expect(routeTableFromOpenApi(openapi)).toEqual([
      expect.objectContaining({ method: 'GET', path: '/items/{item_id}', operationId: 'get_item' }),
      expect.objectContaining({ method: 'GET', path: '/items/actions', operationId: 'list_actions' }),
      expect.objectContaining({ method: 'POST', path: '/openapi-only', operationId: 'create_openapi_only' }),
    ]);
  });

  it('unions detector-only and OpenAPI-only routes and reports source mismatches', () => {
    const detector = [
      detectorRoute('GET', '/items/{}', 0),
      detectorRoute('GET', '/items/actions', 1),
      detectorRoute('GET', '/detector-only', 2),
    ];
    const result = mergeRouteSources(detector, routeTableFromOpenApi(openapi), 'both');

    expect(result.table).toEqual(expect.arrayContaining([
      expect.objectContaining({ method: 'GET', path: '/detector-only' }),
      expect.objectContaining({ method: 'POST', path: '/openapi-only' }),
    ]));
    expect(result.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'ROUTE_SOURCE_MISMATCH', reportOnly: true, presentIn: 'detectors' }),
      expect.objectContaining({ code: 'ROUTE_SOURCE_MISMATCH', reportOnly: true, presentIn: 'openapi' }),
    ]));
    expect(result.findings).toHaveLength(2);
  });
  it('merges a FastAPI path converter with the OpenAPI parameter that omits its converter', () => {
    const detector = [detectorRoute('GET', '/files/{*}', 0)];
    const paths = routeTableFromOpenApi({
      openapi: '3.1.0',
      info: { title: 'Fixture API', version: '1.0' },
      paths: { '/files/{file_path}': { get: { operationId: 'get_file' } } },
    });
    const result = mergeRouteSources(detector, paths, 'both');

    expect(result.findings).toEqual([]);
    expect(result.table).toEqual([
      expect.objectContaining({
        method: 'GET',
        normalizedPath: '/files/{*}',
        operationId: 'get_file',
        routeSources: ['detectors', 'openapi'],
      }),
    ]);
  });

  it('uses detector registration order, not OpenAPI path insertion order, for first-match dispatch', () => {
    const detector = [
      detectorRoute('GET', '/items/actions', 0),
      detectorRoute('GET', '/items/{}', 1),
    ];
    const result = mergeRouteSources(detector, routeTableFromOpenApi(openapi), 'both');

    expect(matchExchange(result.table, 'GET', '/items/actions')).toEqual({
      route: expect.objectContaining({ path: '/items/actions' }),
    });
  });
});

describe('HTTP exchange route matching', () => {
  const table = [
    detectorRoute('GET', '/items/actions', 0),
    detectorRoute('GET', '/items/{}', 1),
    detectorRoute('GET', '/items/{*}', 2),
    detectorRoute('POST', '/items', 3),
  ];

  it('chooses the first registered full match, including literal-first only when registration says so', () => {
    expect(matchExchange(table, 'GET', '/items/actions')).toEqual({
      route: expect.objectContaining({ normalizedPath: '/items/actions' }),
    });
  });
  it('uses a registered parameter route before a later literal route when the router does so', () => {
    const parameterFirst = [
      detectorRoute('GET', '/items/{}', 0),
      detectorRoute('GET', '/items/actions', 1),
    ];
    expect(matchExchange(parameterFirst, 'GET', '/items/actions')).toEqual({
      route: expect.objectContaining({ normalizedPath: '/items/{}' }),
    });
  });

  it('accepts trailing-slash variants and ignores query strings', () => {
    expect(matchExchange(table, 'GET', '/items/actions/?page=2')).toEqual({
      route: expect.objectContaining({ normalizedPath: '/items/actions' }),
    });
  });

  it('returns unmatched for a method mismatch', () => {
    expect(matchExchange(table, 'DELETE', '/items/actions')).toEqual({ unmatched: true });
  });

  it('fails closed as ambiguous when equal matches have no proven registration order', () => {
    const unordered = [
      detectorRoute('GET', '/items/{}', 0),
      detectorRoute('GET', '/items/{*}', 1),
    ].map(({ registration: _registration, ...route }) => route);

    expect(matchExchange(unordered, 'GET', '/items/actions')).toEqual({
      ambiguous: expect.arrayContaining([
        expect.objectContaining({ normalizedPath: '/items/{}' }),
        expect.objectContaining({ normalizedPath: '/items/{*}' }),
      ]),
    });
  });
});
