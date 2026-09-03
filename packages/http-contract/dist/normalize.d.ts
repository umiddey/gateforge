/**
 * Canonical HTTP path and method normalization (ADR 0004 D2).
 *
 * Total and deterministic: the same input always yields the same result,
 * and the canonical form is invariant under parameter-name changes
 * (`/accounts/{account_id}` and `/accounts/{id}` both canonicalize to
 * `/accounts/{}`). There is no fuzzy matching here — unresolvable shapes
 * return a typed `HTTP_PATH_DYNAMIC` outcome instead of a best effort.
 */
import type { HttpMethod } from './schema.js';
/** Canonical single-segment positional parameter slot. */
export declare const HTTP_PARAM_SLOT = "{}";
/** Canonical wildcard slot (FastAPI `{name:path}` converters, `*` catch-alls). */
export declare const HTTP_WILDCARD_SLOT = "{*}";
export declare const NormalizeDynamicCode = "HTTP_PATH_DYNAMIC";
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
export declare function normalizeHttpPath(rawPath: string, options?: NormalizePathOptions): NormalizePathResult;
/**
 * Normalizes one raw method expression. Returns `null` for dynamic or
 * unknown methods — the caller must emit `HTTP_METHOD_DYNAMIC`; defaulting
 * to `GET` is forbidden (ADR 0004 D2 rule 7).
 */
export declare function normalizeHttpMethod(rawMethod: string): HttpMethod | null;
/** Splits a canonical path into segments (empty segments dropped). */
export declare function pathSegments(canonicalPath: string): string[];
//# sourceMappingURL=normalize.d.ts.map