/**
 * Response-shape checks (0.14 WP4 step 3): each proxied exchange whose
 * route declares a JSON response schema for its status is validated
 * against that schema. The index is built once, at run bind, from the
 * OpenAPI document the witness fetched; the document is held in memory
 * only and never sealed. A body is buffered for validation only when a
 * schema applies, and a body over the cap is a refusal for that exchange
 * alone. Every other case is `unchecked` with a reason and never fails.
 *
 * Route matching uses core's `interpretObservedPath` + `matchHttpRoute`,
 * the same resolver the engine's route attribution already uses.
 */
import { Ajv, type ValidateFunction } from 'ajv';
import { interpretObservedPath, matchHttpRoute, type HttpRouteCandidate } from '@gate-forge/core';
import { routeTableFromOpenApi } from '@gate-forge/http-contract';
import { isJsonObject } from '../json.js';

/** A body is buffered for validation up to this many bytes; over it the exchange is refused. */
export const RESPONSE_BODY_CAP_BYTES = 1024 * 1024;

/** One exchange's verdict. `refused` is a refusal for that exchange's obligation only. */
export type ResponseShape =
  | { verdict: 'ok' }
  | { verdict: 'mismatch'; errors: Array<{ pointer: string; message: string }> }
  | { verdict: 'unchecked'; why: string }
  | { verdict: 'refused'; why: 'HTTP_BODY_TOO_LARGE' };

/** What the proxy does for one exchange, decided before any byte is copied. */
export type ResponsePlan =
  | { kind: 'unchecked'; why: string }
  | { kind: 'validate'; validate: ValidateFunction };

interface ResponseEntry {
  /** The JSON media schema the status declares; null when none is declared. */
  readonly schema: Record<string, unknown> | null;
  /** Compiled validator; null when there is no schema or it did not compile. */
  readonly validate: ValidateFunction | null;
}

interface RouteEntry {
  readonly candidate: HttpRouteCandidate;
  /** Keyed by the OpenAPI response key: an exact status, `2XX`-style range, or `default`. */
  readonly responses: ReadonlyMap<string, ResponseEntry>;
}

export interface ResponseShapeIndex {
  readonly routes: readonly RouteEntry[];
}

/** Builds the per-route response index from a parsed OpenAPI document. */
export function buildResponseShapeIndex(document: unknown): ResponseShapeIndex {
  const ajv = new Ajv({ strict: false, allErrors: false, validateFormats: false });
  const root = recordOf(document);
  const components = root['components'];
  const paths = recordOf(root['paths']);
  const routes = routeTableFromOpenApi(document).map((route): RouteEntry => {
    const operation = recordOf(recordOf(paths[route.path])[route.method.toLowerCase()]);
    const responses = new Map<string, ResponseEntry>();
    for (const [key, response] of Object.entries(recordOf(operation['responses']))) {
      responses.set(key, responseEntry(ajv, components, recordOf(response)));
    }
    return {
      candidate: {
        resourceId: `http.endpoint:${route.method} ${route.normalizedPath}`,
        method: route.method,
        canonicalPath: route.normalizedPath,
      },
      responses,
    };
  });
  return { routes };
}

/** Decides how one exchange is judged, from the route, status and content type it carries. */
export function planResponseShape(
  index: ResponseShapeIndex | null,
  method: string,
  observedPath: string,
  status: number,
  contentType: string | undefined,
): ResponsePlan {
  if (index === null) return { kind: 'unchecked', why: 'openapi-unavailable' };
  const interpreted = interpretObservedPath(observedPath);
  if (!interpreted.ok) return { kind: 'unchecked', why: 'no-route' };
  const match = matchHttpRoute(method, interpreted.path, index.routes.map((route) => route.candidate));
  if (match.status === 'ambiguous') return { kind: 'unchecked', why: 'ambiguous-route' };
  if (match.status === 'incomplete') return { kind: 'unchecked', why: 'incomplete-route' };
  if (match.status !== 'match') return { kind: 'unchecked', why: 'no-route' };
  const route = index.routes.find((entry) => entry.candidate.resourceId === match.matched.resourceId);
  if (route === undefined) return { kind: 'unchecked', why: 'no-route' };
  // Exact status, then its `2XX`-style range, then `default` (OpenAPI precedence).
  const entry =
    route.responses.get(String(status)) ??
    route.responses.get(`${String(Math.floor(status / 100))}XX`) ??
    route.responses.get('default');
  if (entry === undefined) return { kind: 'unchecked', why: 'status-undeclared' };
  if (entry.schema === null) return { kind: 'unchecked', why: 'no-response-schema' };
  if (!isJsonMediaType(contentType ?? '')) return { kind: 'unchecked', why: 'non-json-response' };
  if (entry.validate === null) return { kind: 'unchecked', why: 'schema-uncompilable' };
  return { kind: 'validate', validate: entry.validate };
}

/** Judges one exchange from its planned check and the body the proxy buffered. */
export function judgeResponseShape(plan: ResponsePlan, body: Buffer, totalBytes: number): ResponseShape {
  if (plan.kind === 'unchecked') return { verdict: 'unchecked', why: plan.why };
  if (totalBytes > RESPONSE_BODY_CAP_BYTES) return { verdict: 'refused', why: 'HTTP_BODY_TOO_LARGE' };
  let data: unknown;
  try {
    data = JSON.parse(body.toString('utf8')) as unknown;
  } catch {
    return { verdict: 'unchecked', why: 'unparseable-json' };
  }
  if (plan.validate(data)) return { verdict: 'ok' };
  const errors = (plan.validate.errors ?? []).slice(0, 3).map((error) => ({
    pointer: error.instancePath,
    message: error.message ?? 'does not match the response schema',
  }));
  return { verdict: 'mismatch', errors };
}

/**
 * What the engine kept of one captured app exchange. `totalBytes` is the
 * TOTAL response body size, or null when Playwright could not read the body;
 * `shapeBody` is the full body when it is within the cap (empty otherwise —
 * an over-cap body is refused before it is parsed).
 */
export interface EngineExchange {
  method: string;
  path: string;
  status: number;
  contentType: string | null;
  totalBytes: number | null;
  shapeBody: Buffer;
}

/**
 * Judges one engine-captured exchange with exactly the proxy's plan and
 * judge, so a UI-driven exchange and a proxied one never disagree about the
 * same body. A body the engine could not read is unchecked, never a failure.
 */
export function judgeEngineExchange(index: ResponseShapeIndex | null, exchange: EngineExchange): ResponseShape {
  const plan = planResponseShape(index, exchange.method, exchange.path, exchange.status, exchange.contentType ?? undefined);
  if (plan.kind === 'unchecked') return { verdict: 'unchecked', why: plan.why };
  if (exchange.totalBytes === null) return { verdict: 'unchecked', why: 'body-unavailable' };
  return judgeResponseShape(plan, exchange.shapeBody, exchange.totalBytes);
}

/**
 * Orders verdicts by how much they must survive a dedup: a repeated
 * method/url/status keeps the worst verdict, so a mismatch on any repeat
 * is never hidden behind an earlier ok.
 */
export function shapeRank(shape: ResponseShape): number {
  switch (shape.verdict) {
    case 'refused':
      return 3;
    case 'mismatch':
      return 2;
    case 'unchecked':
      return 1;
    case 'ok':
      return 0;
  }
}

function responseEntry(ajv: Ajv, components: unknown, response: Record<string, unknown>): ResponseEntry {
  const content = recordOf(response['content']);
  const media = Object.entries(content).find(([name]) => isJsonMediaType(name));
  const declared = media === undefined ? undefined : recordOf(media[1])['schema'];
  if (!isJsonObject(declared)) return { schema: null, validate: null };
  // The document's components become the root so `$ref`s into them resolve.
  const root = components === undefined ? declared : { ...declared, components };
  try {
    return { schema: declared, validate: ajv.compile(root) };
  } catch {
    return { schema: declared, validate: null };
  }
}

function isJsonMediaType(name: string): boolean {
  const base = name.split(';')[0]?.trim().toLowerCase() ?? '';
  return base === 'application/json' || base.endsWith('+json');
}

function recordOf(value: unknown): Record<string, unknown> {
  return isJsonObject(value) ? value : {};
}
