/**
 * Canonical HTTP path and method normalization (ADR 0004 D2).
 *
 * Total and deterministic: the same input always yields the same result,
 * and the canonical form is invariant under parameter-name changes
 * (`/accounts/{account_id}` and `/accounts/{id}` both canonicalize to
 * `/accounts/{}`). There is no fuzzy matching here — unresolvable shapes
 * return a typed `HTTP_PATH_DYNAMIC` outcome instead of a best effort.
 */

import { HTTP_PATH_DYNAMIC } from './codes.js';
import type { HttpMethod } from './schema.js';

/** Canonical single-segment positional parameter slot. */
export const HTTP_PARAM_SLOT = '{}';

/** Canonical wildcard slot (FastAPI `{name:path}` converters, `*` catch-alls). */
export const HTTP_WILDCARD_SLOT = '{*}';

export const NormalizeDynamicCode = HTTP_PATH_DYNAMIC;

export interface NormalizePathOk {
  ok: true;
  /** Canonical path: leading `/`, no trailing slash (except root), no query/fragment, positional slots. */
  canonical: string;
  /** True when the path contains at least one positional or wildcard slot. */
  hasParameters: boolean;
}

export interface NormalizePathDynamic {
  ok: false;
  code: typeof NormalizeDynamicCode;
  detail: string;
}

export type NormalizePathResult = NormalizePathOk | NormalizePathDynamic;

export interface NormalizePathOptions {
  /**
   * Hosts whose absolute URLs are treated as same-origin: their path
   * portion is canonicalized. Hosts are matched case-insensitively and
   * without port normalization (declare exactly what you deploy).
   */
  sameOriginHosts?: readonly string[];
}

const ABSOLUTE_URL_RE = /^https?:\/\/([^/?#\s]+)/i;

/**
 * Normalizes one raw path expression to canonical positional form.
 *
 * Rules (ADR 0004 D2), applied in order:
 *  1. strip query (`?...`) and fragment (`#...`);
 *  2. collapse duplicate slashes, ensure one leading slash, strip trailing
 *     slashes (root `/` stays `/`);
 *  3. `${...}` template expressions become `{}`;
 *  4. FastAPI `{name}` / `{name:type}` params become `{}` (names are not
 *     identity); `{name:path}` converters become `{*}`;
 *  5. bare `*` / `*name` catch-all segments become `{*}`;
 *  6. absolute URLs canonicalize only for configured same-origin hosts —
 *     anything else is a typed dynamic outcome, never host-stripped;
 *  7. `..` escape segments are rejected.
 */
export function normalizeHttpPath(
  rawPath: string,
  options: NormalizePathOptions = {},
): NormalizePathResult {
  if (typeof rawPath !== 'string' || rawPath.length === 0) {
    return dynamic('path is empty');
  }

  let working = rawPath;

  const absolute = ABSOLUTE_URL_RE.exec(working);
  if (absolute !== null) {
    const host = (absolute[1] ?? '').toLowerCase();
    const allowed = (options.sameOriginHosts ?? []).some(
      (candidate) => candidate.toLowerCase() === host,
    );
    if (!allowed) {
      return dynamic(`absolute URL host '${host}' is not a configured same-origin host`);
    }
    const pathStart = working.indexOf('/', absolute.index + absolute[0].length - host.length);
    working = pathStart === -1 ? '/' : working.slice(pathStart);
  } else if (!working.startsWith('/')) {
    // Relative expressions have no statically knowable base; resolving
    // them would be a guess (ADR 0004 D2 rule 6).
    return dynamic(`path '${rawPath}' is neither path-absolute nor a configured same-origin URL`);
  }

  // 1. query/fragment strip (first occurrence wins; inside-template edge
  // cases are the detector's responsibility — facts carry resolved paths).
  const queryStart = findFirstOutsideTemplate(working, ['?', '#']);
  if (queryStart !== -1) {
    working = working.slice(0, queryStart);
  }

  // 2. slash normalization.
  working = working.replace(/\/{2,}/g, '/');
  if (!working.startsWith('/')) {
    working = `/${working}`;
  }
  if (working.length > 1) {
    working = working.replace(/\/+$/, '');
  }
  if (working === '') {
    working = '/';
  }

  // 3. template expressions -> positional slots.
  working = working.replace(/\$\{[^}]*\}/g, HTTP_PARAM_SLOT);

  // 4/5. FastAPI params, typed converters, catch-all segments.
  const segments = working.split('/').map((segment): string => {
    if (segment === '*' || /^\*[\w:.-]*$/.test(segment)) return HTTP_WILDCARD_SLOT;
    const param = /^\{([^{}]+)\}$/.exec(segment);
    if (param === null) return segment;
    // `{name:path}` converters absorb one-or-more trailing segments;
    // every other `{name}` / `{name:type}` form is a single positional slot.
    return (param[1] ?? '').endsWith(':path') ? HTTP_WILDCARD_SLOT : HTTP_PARAM_SLOT;
  });
  working = segments.join('/');

  // 7. escape rejection — after normalization so the message quotes the
  // canonical shape the detector would have relied on.
  if (segments.includes('..')) {
    return dynamic(`path '${rawPath}' contains a '..' escape segment`);
  }

  const hasParameters =
    working.includes(HTTP_PARAM_SLOT) || working.includes(HTTP_WILDCARD_SLOT);
  return { ok: true, canonical: working, hasParameters };
}

/**
 * Normalizes one raw method expression. Returns `null` for dynamic or
 * unknown methods — the caller must emit `HTTP_METHOD_DYNAMIC`; defaulting
 * to `GET` is forbidden (ADR 0004 D2 rule 7).
 */
export function normalizeHttpMethod(rawMethod: string): HttpMethod | null {
  const upper = rawMethod.trim().toUpperCase();
  if (upper === 'ANY' || upper === '*') return 'ANY';
  if (HTTP_METHOD_SET.has(upper)) return upper as HttpMethod;
  return null;
}

/** Splits a canonical path into segments (empty segments dropped). */
export function pathSegments(canonicalPath: string): string[] {
  return canonicalPath.split('/').filter((segment) => segment !== '');
}

const HTTP_METHOD_SET: ReadonlySet<string> = new Set([
  'GET',
  'HEAD',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'OPTIONS',
]);

function dynamic(detail: string): NormalizePathDynamic {
  return { ok: false, code: NormalizeDynamicCode, detail };
}

/** Finds the first index of any of `chars` outside a `${...}` template. */
function findFirstOutsideTemplate(input: string, chars: readonly string[]): number {
  let depth = 0;
  for (let index = 0; index < input.length; index += 1) {
    const char: string = input[index] ?? '';
    if (char === '$' && input[index + 1] === '{') {
      depth += 1;
      index += 1;
      continue;
    }
    if (depth > 0 && char === '}') {
      depth -= 1;
      continue;
    }
    if (depth === 0 && chars.includes(char)) return index;
  }
  return -1;
}
