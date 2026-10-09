import { describe, expect, it } from 'vitest';
import {
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

  it('keeps detector registration order, not OpenAPI path insertion order, in the merged table', () => {
    const detector = [
      detectorRoute('GET', '/items/actions', 0),
      detectorRoute('GET', '/items/{}', 1),
    ];
    const result = mergeRouteSources(detector, routeTableFromOpenApi(openapi), 'both');

    // Dispatch order IS the table order (the one route resolver in core
    // consumes it with the detector's registration facts).
    expect(result.table.map((entry) => entry.normalizedPath)).toEqual([
      '/items/actions',
      '/items/{}',
      '/openapi-only',
    ]);
  });
});

