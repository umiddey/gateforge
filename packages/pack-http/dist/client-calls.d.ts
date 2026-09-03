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
 * - **Simple wrapper functions**: a configured wrapper whose declaration
 *   in the scanned set is a single `return <client call>(...)` arrow or
 *   function resolves its internal call with the callsite's first
 *   argument substituted for the wrapper's first parameter (one level,
 *   one parameter — anything deeper is typed unresolved).
 */
import { FRONTEND_CALL_TARGET_UNRESOLVED, HTTP_METHOD_DYNAMIC, HTTP_PATH_DYNAMIC } from '@gateforge/http-contract';
import type { HttpMethod } from '@gateforge/http-contract';
import type { Location } from '@gateforge/core';
/** Configuration for the client-call scanner (all optional). */
export interface ClientScanConfig {
    /** Instance symbols exposing verb methods, e.g. `['apiClient']`. */
    clientSymbols?: readonly string[];
    /**
     * Wrapper callables: `name` plus the concrete method the wrapper
     * always issues (wrappers with computed methods stay unresolved).
     */
    wrapperFunctions?: ReadonlyArray<{
        name: string;
        method: HttpMethod;
    }>;
    /** Pure URL builders with an optional literal base they prepend. */
    urlBuilders?: ReadonlyArray<{
        name: string;
        base?: string;
    }>;
    /** Absolute-URL hosts treated as same-origin (canonicalized to path). */
    sameOriginHosts?: readonly string[];
}
export declare const DEFAULT_CLIENT_SCAN_CONFIG: ClientScanConfig;
/** One discovered frontend call (one row per source callsite). */
export interface ClientCall {
    method: HttpMethod;
    /** Path exactly as written after constant substitution. */
    rawPath: string;
    /** Canonical positional form of {@link rawPath} (ADR 0004 D2). */
    canonicalPath: string;
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
 */
export declare function scanClientCalls(file: string, sourceText: string, config: ClientScanConfig, scannedFiles: ReadonlyMap<string, string>): ClientScanResult;
/**
 * Reads a client-scan config document. Returns the default config when
 * the file is absent; malformed documents throw (fail closed — the CLI
 * surfaces the error instead of scanning with partial trust).
 */
export declare function readClientScanConfigOrNull(path: string | null): ClientScanConfig;
//# sourceMappingURL=client-calls.d.ts.map