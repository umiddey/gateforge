/**
 * Bounded static dataflow for frontend API-client calls (ADR 0004 D6,
 * plan phase 3).
 *
 * Real ASTs (the TypeScript compiler API, pure analysis — no evaluation,
 * no I/O beyond the caller-provided file set) replace the old regex
 * client scan. The model is deliberately bounded:
 *
 * - **Direct literal calls**: `fetch('/x')`, `axios.get('/x')`, instance
 *   verbs, `axios({url, method})` — method from verb name or a literal /
 *   const `method` property; never a silent GET default for computed
 *   methods (those become `HTTP_METHOD_DYNAMIC`).
 * - **Module constants**: `const X = '/x'` / template / builder call,
 *   resolved across the scanned file set through relative imports with a
 *   cycle guard and memoization.
 * - **Templates**: `${expr}` holes resolve through the same value table;
 *   rooted holes become positional `{}` slots without needing runtime
 *   values; an unresolvable hole before the path is rooted (host/base)
 *   makes the whole target `FRONTEND_CALL_TARGET_UNRESOLVED`.
 * - **Configured client symbols** (`apiClient.get(...)`) and **pure URL
 *   builders** (`buildApiPath('/v1/x')` with an optional declared base)
 *   are configuration-declared resolvable APIs — never coverage
 *   exemptions: unresolved flows still block.
 * - **Instance baseURL joining**: when an instance symbol's creation is
 *   modeled — a module-scope `const apiClient = axios.create({...})`
 *   whose config carries a proven LITERAL `baseURL` (a direct property,
 *   or one reaching it through a declared constant config object the
 *   creation is assigned from or spreads, resolved by the same bounded
 *   value table) — the base joins into the emitted call path:
 *   `normalizedPath = normalize(baseURL + callPath)` with exactly one
 *   slash seam. Empty/`/` bases, absolute call URLs, and unprovable
 *   (env-dependent) bases join nothing: the callsite behaves exactly as
 *   it would without the feature, and joining never turns a passing
 *   callsite into a blocker. The raw path stays exactly as written.
 * - **Simple wrapper functions**: a configured wrapper whose declaration
 *   in the scanned set is a single `return <client call>(...)` arrow or
 *   function resolves its internal call with the callsite's first
 *   argument substituted for the wrapper's first parameter (one level,
 *   one parameter — anything deeper is typed unresolved).
 */
import { FRONTEND_CALL_TARGET_UNRESOLVED, HTTP_METHOD_DYNAMIC, HTTP_PATH_DYNAMIC } from '@gateforge/http-contract';
import type { HttpMethod } from '@gateforge/http-contract';
import { type Location } from '@gateforge/core';
/**
 * Optional per-entry file scoping (phase 3 scan-scoping). Globs are
 * repo-root-relative posix (`frontend/src/**`), matched with core's
 * deterministic `pathInScope` machinery — the same wildcards as the
 * classification policy's scan roots.
 */
export interface ClientSymbolScoping {
    /**
     * Files the entry applies to. Absent = every scanned file (the
     * back-compat default); present = at least one glob must match.
     */
    include?: readonly string[];
    /**
     * Files the entry never applies to. Any match wins over `include` —
     * a deterministic precedence (documented in the README).
     */
    exclude?: readonly string[];
}
/** A configured client symbol: plain string (unscoped) or scoped object. */
export interface ClientSymbolConfig extends ClientSymbolScoping {
    /** Instance symbol exposing verb methods, e.g. `apiClient`. */
    name: string;
}
/** A configured wrapper callable: `name` + concrete method + scoping. */
export interface WrapperFunctionConfig extends ClientSymbolScoping {
    name: string;
    /**
     * The concrete method the wrapper always issues (wrappers with
     * computed methods stay unresolved).
     */
    method: HttpMethod;
}
/** A configured pure URL builder: `name` + optional base + scoping. */
export interface UrlBuilderConfig extends ClientSymbolScoping {
    name: string;
    /** Optional literal base the builder prepends. */
    base?: string;
}
/**
 * Configuration for the client-call scanner (all optional).
 *
 * Scan scoping (phase 3): `clientScanRoots` / `serverScanRoots` narrow
 * WHERE client-call and generic server-route scanning apply at all —
 * two real dogfood failures drove this. A consumer's e2e specs defined
 * a helper also named `api`, and every harness call was scanned as
 * product frontend consumption (20 FRONTEND_CALL_TARGET_UNRESOLVED
 * blockers + phantom consumption); another repo discovered false
 * `http.endpoint` server routes inside `tests/e2e` because test-harness
 * mock servers matched the generic route regex. Test-harness calls are
 * a different contract class, so a file outside the roots produces NO
 * facts of that kind at all. Absent keys scan everything — the
 * byte-identical back-compat contract.
 */
export interface ClientScanConfig {
    /** Instance symbols exposing verb methods, e.g. `['apiClient']`. */
    clientSymbols?: ReadonlyArray<string | ClientSymbolConfig>;
    /**
     * Wrapper callables: `name` plus the concrete method the wrapper
     * always issues (wrappers with computed methods stay unresolved).
     */
    wrapperFunctions?: ReadonlyArray<WrapperFunctionConfig>;
    /** Pure URL builders with an optional literal base they prepend. */
    urlBuilders?: ReadonlyArray<UrlBuilderConfig>;
    /** Absolute-URL hosts treated as same-origin (canonicalized to path). */
    sameOriginHosts?: readonly string[];
    /**
     * Repo-root-relative globs limiting client-call scanning (fetch,
     * axios, configured symbols, wrappers, builders). Files outside
     * produce NO client-call facts and NO unresolved entries.
     */
    clientScanRoots?: readonly string[];
    /**
     * Repo-root-relative globs limiting generic server-route scanning
     * (`scanServerRoutes` / `scanNestControllers`). Files outside produce
     * NO server-route facts — test servers are not product routes.
     */
    serverScanRoots?: readonly string[];
}
export declare const DEFAULT_CLIENT_SCAN_CONFIG: ClientScanConfig;
/**
 * Whether `file` (repo-root-relative posix) is inside the top-level
 * client-call scan roots. Absent roots admit EVERY file — the
 * back-compat contract: without the key, scanning is exactly as before.
 */
export declare function fileInClientScanRoots(config: ClientScanConfig, file: string): boolean;
/**
 * Whether `file` is inside the top-level server-route scan roots.
 * Absent roots admit every file (back-compat, same rule as above).
 */
export declare function fileInServerScanRoots(config: ClientScanConfig, file: string): boolean;
/**
 * Whether a callsite in `file` uses the configured client symbol
 * `name`: the file must match the top-level clientScanRoots (if
 * present) AND the symbol's own include/exclude (if present). Both
 * gates must pass — per-symbol scoping composes with (never relaxes)
 * the top-level roots.
 */
export declare function clientSymbolActiveIn(config: ClientScanConfig, name: string, file: string): boolean;
/**
 * The configured client-symbol names ACTIVE for `file` — used by the
 * server-route scanner to disambiguate `api.get('/x')`-shaped client
 * calls from router registrations. Scope-aware: a symbol scoped away
 * from this file does not suppress route discovery in it (out of client
 * scope, `<symbol>.<verb>(path, handler)` can only be a router).
 */
export declare function activeClientSymbolNamesIn(config: ClientScanConfig, file: string): string[];
/** One discovered frontend call (one row per source callsite). */
export interface ClientCall {
    method: HttpMethod;
    /** Path exactly as written after constant substitution. */
    rawPath: string;
    /** Canonical positional form of {@link rawPath} (ADR 0004 D2). */
    canonicalPath: string;
    /**
     * The proven literal instance `baseURL` that was joined into
     * {@link canonicalPath} (`normalize(baseURL + rawPath)`), present ONLY
     * when a join actually happened. Fact emission canonicalizes the joined
     * path while {@link rawPath} stays as written; without a joined base
     * this is absent and emission is byte-identical to the pre-feature
     * contract.
     */
    joinedBaseURL?: string;
    /** Producing client, e.g. `fetch`, `axios`, `apiClient`, `apiGet`. */
    framework: string;
    location: Location;
}
export interface ClientScanUnresolved {
    code: typeof FRONTEND_CALL_TARGET_UNRESOLVED | typeof HTTP_METHOD_DYNAMIC | typeof HTTP_PATH_DYNAMIC;
    detail: string;
    location: Location;
}
export interface ClientScanResult {
    calls: ClientCall[];
    unresolved: ClientScanUnresolved[];
}
/**
 * Scans one file for frontend API-client calls under the bounded model.
 * `scannedFiles` maps repo-relative paths to source text for every file
 * in the discovery request (import resolution stays inside the set).
 *
 * Scan scoping (phase 3): a file outside `clientScanRoots` (when the
 * key is present) returns EMPTY — no calls AND no unresolved entries.
 * The gate comes first on purpose: even bare `fetch` extraction must
 * not run, because a scoped-out file (an e2e spec, a test harness) is
 * not product frontend consumption and must be invisible to this
 * channel, blockers included. Files outside the roots still participate
 * in the value table as import targets — scoping narrows fact
 * emission, not the dataflow's ability to resolve product code.
 */
export declare function scanClientCalls(file: string, sourceText: string, config: ClientScanConfig, scannedFiles: ReadonlyMap<string, string>): ClientScanResult;
/**
 * Reads a client-scan config document. Returns the default config when
 * the file is absent; malformed documents throw (fail closed — the CLI
 * surfaces the error instead of scanning with partial trust).
 *
 * Accepted shapes (phase 3 scan-scoping): `clientSymbols` entries are a
 * plain string (back-compat, unscoped) or `{ name, include?, exclude? }`;
 * `wrapperFunctions` / `urlBuilders` entries carry the same optional
 * include/exclude next to their existing `method` / `base` fields; the
 * top-level `clientScanRoots` / `serverScanRoots` arrays scope where
 * client-call and server-route scanning apply at all. Consistent with
 * the pre-existing parser posture: unknown keys are ignored, non-array
 * known keys are ignored, but malformed ENTRY values throw (the wrapper
 * verb check predates this; the new scoping fields throw on wrong
 * shapes and missing names because silently dropping a scope widens the
 * scan instead of narrowing it).
 */
export declare function readClientScanConfigOrNull(path: string | null): ClientScanConfig;
//# sourceMappingURL=client-calls.d.ts.map