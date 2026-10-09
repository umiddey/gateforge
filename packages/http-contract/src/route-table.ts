import { HTTP_METHODS, type HttpContractFact, type HttpMethod } from './schema.js';
import { normalizeHttpPath } from './normalize.js';

const OPENAPI_METHODS = new Set<string>(HTTP_METHODS.filter((method) => method !== 'ANY'));

export interface OpenApiRoute {
  readonly method: Exclude<HttpMethod, 'ANY'>;
  /** Original OpenAPI path template, e.g. `/items/{item_id}`. */
  readonly path: string;
  /** Positional form used for matching, e.g. `/items/{}`. */
  readonly normalizedPath: string;
  readonly operationId?: string;
}

export interface RouteTableEntry {
  readonly method: HttpMethod;
  readonly path: string;
  readonly normalizedPath: string;
  readonly operationId?: string;
  readonly registration?: HttpContractFact['registration'];
  readonly routeSources: readonly ('detectors' | 'openapi')[];
  readonly detectorFact?: HttpContractFact;
}

export interface RouteSourceMismatch {
  readonly code: 'ROUTE_SOURCE_MISMATCH';
  readonly reportOnly: true;
  readonly method: HttpMethod;
  readonly path: string;
  readonly presentIn: 'detectors' | 'openapi';
}

export type RouteSourceMode = 'openapi' | 'detectors' | 'both';
export interface MergedRouteSources {
  readonly table: RouteTableEntry[];
  readonly findings: RouteSourceMismatch[];
}

/** Build route entries from an already-fetched OpenAPI document. Performs no I/O. */
export function routeTableFromOpenApi(document: unknown): OpenApiRoute[] {
  if (typeof document !== 'object' || document === null || !('paths' in document)) return [];
  const paths = document.paths;
  if (typeof paths !== 'object' || paths === null || Array.isArray(paths)) return [];

  const routes: OpenApiRoute[] = [];
  for (const [path, rawItem] of Object.entries(paths)) {
    if (typeof rawItem !== 'object' || rawItem === null || Array.isArray(rawItem)) continue;
    const normalized = normalizeHttpPath(path);
    if (!normalized.ok) continue;
    for (const [rawMethod, rawOperation] of Object.entries(rawItem)) {
      const method = rawMethod.toUpperCase();
      if (!OPENAPI_METHODS.has(method)) continue;
      const operationId = typeof rawOperation === 'object' && rawOperation !== null &&
        'operationId' in rawOperation && typeof rawOperation.operationId === 'string'
        ? rawOperation.operationId
        : undefined;
      routes.push({
        method: method as Exclude<HttpMethod, 'ANY'>,
        path,
        normalizedPath: normalized.canonical,
        ...(operationId === undefined ? {} : { operationId }),
      });
    }
  }
  return routes;
}

/** Merge detector and OpenAPI route evidence; detector order remains authoritative. */
export function mergeRouteSources(
  detector: readonly HttpContractFact[],
  openapi: readonly OpenApiRoute[],
  mode: RouteSourceMode,
): MergedRouteSources {
  const detectorByKey = new Map<string, HttpContractFact[]>();
  const detectorBySourceKey = new Map<string, HttpContractFact[]>();
  for (const fact of detector) {
    if (fact.role !== 'server-route') continue;
    const key = routeKey(fact.method, fact.normalizedPath);
    const entries = detectorByKey.get(key);
    if (entries === undefined) detectorByKey.set(key, [fact]);
    else entries.push(fact);
    const sourceKey = routeSourceKey(fact.method, fact.normalizedPath);
    const sourceEntries = detectorBySourceKey.get(sourceKey);
    if (sourceEntries === undefined) detectorBySourceKey.set(sourceKey, [fact]);
    else sourceEntries.push(fact);
  }
  const openapiByKey = new Map<string, OpenApiRoute[]>();
  const openapiBySourceKey = new Map<string, OpenApiRoute[]>();
  for (const route of openapi) {
    const key = routeKey(route.method, route.normalizedPath);
    const entries = openapiByKey.get(key);
    if (entries === undefined) openapiByKey.set(key, [route]);
    else entries.push(route);
    const sourceKey = routeSourceKey(route.method, route.normalizedPath);
    const sourceEntries = openapiBySourceKey.get(sourceKey);
    if (sourceEntries === undefined) openapiBySourceKey.set(sourceKey, [route]);
    else sourceEntries.push(route);
  }

  const keys = new Set<string>();
  if (mode !== 'openapi') {
    for (const key of detectorByKey.keys()) keys.add(key);
  }
  if (mode === 'openapi') {
    for (const key of openapiByKey.keys()) keys.add(key);
  } else if (mode === 'both') {
    for (const [key, routes] of openapiByKey) {
      const route = routes[0];
      if (route !== undefined && !detectorBySourceKey.has(routeSourceKey(route.method, route.normalizedPath))) {
        keys.add(key);
      }
    }
  }

  const table: RouteTableEntry[] = [];
  const findings: RouteSourceMismatch[] = [];
  if (mode === 'both') {
    for (const facts of detectorByKey.values()) {
      const fact = facts[0];
      if (fact !== undefined && !openapiBySourceKey.has(routeSourceKey(fact.method, fact.normalizedPath))) {
        findings.push(mismatch(fact.method, fact.rawPath, 'detectors'));
      }
    }
    for (const routes of openapiByKey.values()) {
      const route = routes[0];
      if (route !== undefined && !detectorBySourceKey.has(routeSourceKey(route.method, route.normalizedPath))) {
        findings.push(mismatch(route.method, route.path, 'openapi'));
      }
    }
  }

  for (const key of keys) {
    const fact = mode === 'openapi' ? undefined : detectorByKey.get(key)?.[0];
    const openapiRoute = mode === 'detectors'
      ? undefined
      : fact === undefined
        ? openapiByKey.get(key)?.[0]
        : openapiBySourceKey.get(routeSourceKey(fact.method, fact.normalizedPath))?.[0];
    if (openapiRoute === undefined && fact === undefined) continue;
    const method = fact?.method ?? openapiRoute?.method;
    const normalizedPath = fact?.normalizedPath ?? openapiRoute?.normalizedPath;
    if (method === undefined || normalizedPath === undefined) continue;
    const entry: RouteTableEntry = {
      method,
      path: openapiRoute?.path ?? fact?.rawPath ?? normalizedPath,
      normalizedPath,
      routeSources: [
        ...(fact === undefined ? [] : ['detectors' as const]),
        ...(openapiRoute === undefined ? [] : ['openapi' as const]),
      ],
      ...(openapiRoute?.operationId === undefined ? {} : { operationId: openapiRoute.operationId }),
      ...(fact?.registration === undefined ? {} : { registration: fact.registration }),
      ...(fact === undefined ? {} : { detectorFact: fact }),
    };
    table.push(entry);
  }
  return { table, findings };
}

function routeKey(method: string, normalizedPath: string): string {
  return `${method} ${normalizedPath}`;
}

/** OpenAPI does not encode FastAPI's path converter, so compare it by slot layout. */
function routeSourceKey(method: string, normalizedPath: string): string {
  return routeKey(method, normalizedPath.replace(/\{\*\}$/, '{}'));
}

function mismatch(
  method: HttpMethod,
  path: string,
  presentIn: 'detectors' | 'openapi',
): RouteSourceMismatch {
  return { code: 'ROUTE_SOURCE_MISMATCH', reportOnly: true, method, path, presentIn };
}
