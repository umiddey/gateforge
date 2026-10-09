/**
 * The attested backend's OpenAPI document, fetched once by the witness
 * at run-context binding (0.14 WP4 step 2, plan §4.2). The witness
 * fetches it, never the test, so the route table and the response
 * schemas describe the RUNNING app. The raw bytes are digested and the
 * route list is derived with the WP1 builder; the parsed document is
 * kept in witness memory for response-shape validation and never enters
 * a record.
 *
 * An unreachable, non-200, non-JSON or non-object document is a TYPED
 * `unavailable` result carrying its reason: the run continues, and every
 * response shape is then unchecked. It is never a refused bind.
 */
import { createHash } from 'node:crypto';
import { routeTableFromOpenApi } from '@gate-forge/http-contract';

/** One declared route of the document, as the sealed record carries it. */
export interface OpenApiRouteEntry {
  method: string;
  path: string;
}

/** The fetched document: its digest, declared routes, and parsed body. */
export interface OpenApiFetched {
  status: 'fetched';
  path: string;
  digest: string;
  bytes: number;
  routes: OpenApiRouteEntry[];
  /** Parsed document, held in witness memory only (never sealed). */
  document: unknown;
}

/** The document could not be fetched or parsed; the reason is the typed note. */
export interface OpenApiUnavailable {
  status: 'unavailable';
  path: string;
  reason: string;
}

export type OpenApiAtBind = OpenApiFetched | OpenApiUnavailable;

/**
 * Fetches `<attested backend><path>` once and classifies the answer.
 *
 * Args:
 *   baseUrl: the attested backend base URL, or null when none is attested.
 *   path: the document path (starts with `/`).
 *   timeoutMs: the per-request timeout.
 *
 * Returns:
 *   OpenApiAtBind: `fetched` with the digest and routes, or `unavailable`
 *   with a reason. Never throws.
 */
export async function fetchOpenApiAtBind(
  baseUrl: string | null,
  path: string,
  timeoutMs: number,
): Promise<OpenApiAtBind> {
  if (baseUrl === null) {
    return {
      status: 'unavailable',
      path,
      reason: 'no attested backend: the witness has no targetBaseUrl to fetch the document from',
    };
  }
  const target = `${baseUrl.replace(/\/$/, '')}${path.startsWith('/') ? path : `/${path}`}`;
  let text: string;
  try {
    const response = await fetch(target, { signal: AbortSignal.timeout(timeoutMs) });
    if (response.status !== 200) {
      return { status: 'unavailable', path, reason: `GET ${path} answered HTTP ${String(response.status)}` };
    }
    text = await response.text();
  } catch (error) {
    return { status: 'unavailable', path, reason: `GET ${path} failed: ${(error as Error).message}` };
  }
  let document: unknown;
  try {
    document = JSON.parse(text) as unknown;
  } catch {
    return { status: 'unavailable', path, reason: `GET ${path} did not return JSON` };
  }
  if (typeof document !== 'object' || document === null || Array.isArray(document)) {
    return { status: 'unavailable', path, reason: `GET ${path} is not a JSON object` };
  }
  const routes = routeTableFromOpenApi(document).map((route) => ({ method: route.method, path: route.path }));
  return {
    status: 'fetched',
    path,
    digest: createHash('sha256').update(text).digest('hex'),
    bytes: Buffer.byteLength(text, 'utf8'),
    routes,
    document,
  };
}

/**
 * The sealed payload of the `http.openapi` record: the digest, the byte
 * count and the declared routes, or the typed reason it is unavailable.
 * Schemas and the parsed document are deliberately absent.
 *
 * Args:
 *   fetched: the bind-time result.
 *
 * Returns:
 *   Record<string, unknown>: the JSON payload.
 */
export function openApiRecordPayload(fetched: OpenApiAtBind): Record<string, unknown> {
  if (fetched.status === 'unavailable') {
    return { status: 'unavailable', path: fetched.path, reason: fetched.reason };
  }
  return {
    status: 'fetched',
    path: fetched.path,
    digest: fetched.digest,
    bytes: fetched.bytes,
    routes: fetched.routes,
  };
}
