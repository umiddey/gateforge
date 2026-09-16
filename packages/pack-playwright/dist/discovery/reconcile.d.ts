import type { Location } from '@gate-forge/core';
/** Default wall-clock bound for one `--list` invocation. */
export declare const DEFAULT_LIST_TIMEOUT_MS = 60000;
/** Typed discovery failure: a playwright invocation that could not run
 * or produce parseable output (CLI maps this to exit 2). */
export declare class TestDiscoveryError extends Error {
    constructor(message: string);
}
/** One test instance the native runner enumerated. */
export interface NativeInstance {
    /** Repo-root-relative posix file path. */
    file: string;
    /** Describe stack + title (no file segment). */
    titlePath: string[];
    /** Last segment of {@link titlePath}. */
    title: string;
    /** Runner project name, e.g. `chromium`. */
    project: string;
    /** The framework's instance id (spec id + project id). */
    frameworkId: string;
    /** Source line/column of the test call (diagnostics). */
    location: Location;
    /** Native expected status (`passed`/`skipped`). */
    expectedStatus: string;
    /** Native annotation types on the instance (e.g. `skip`, `fixme`). */
    annotations: string[];
}
/** Outcome of one native list run. */
export interface NativeListResult {
    /** `discovered` when instances were enumerated, else `unavailable`. */
    status: 'discovered' | 'unavailable';
    /** Single-cause human detail (why unavailable / what ran). */
    detail: string;
    /** Enumerated instances (empty when unavailable). */
    instances: NativeInstance[];
    /** Reporter errors from the JSON document (data, not a throw). */
    errors: string[];
}
/** The scanned repo's local playwright CLI locations, in preference order. */
export declare function localPlaywrightCliCandidates(cwd: string): string[];
/**
 * Strips every `GATEFORGE_*` variable from the environment for UNTRUSTED
 * child runs: config/test-module enumeration must execute without
 * gateforge signing env (witness keys, run tokens, run state).
 *
 * Args:
 *   env: the parent environment.
 *
 * Returns:
 *   NodeJS.ProcessEnv: a copy without any `GATEFORGE_*` keys.
 */
export declare function untrustedEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
/** Finds the consumer's playwright config at the repo root, if any. */
export declare function findPlaywrightConfig(cwd: string): string | null;
/**
 * Enumerates the consumer's playwright tests via official list mode.
 * See the module doc for the trust boundary. The engine's own pinned
 * playwright (pack dependency, 1.58.2) supplies the CLI — no network,
 * no npx resolution from the consumer.
 *
 * Args:
 *   options: `cwd` (absolute repo root) and optional `timeoutMs`
 *     (default {@link DEFAULT_LIST_TIMEOUT_MS}).
 *
 * Returns:
 *   Promise<NativeListResult>: enumerated instances, reporter errors,
 *   and an unavailable verdict when no playwright config exists.
 *
 * Throws:
 *   TestDiscoveryError: when the child cannot spawn, exceeds the
 *   timeout, or stdout is not parseable reporter JSON.
 */
export declare function listNativePlaywrightTests(options: {
    cwd: string;
    timeoutMs?: number;
}): Promise<NativeListResult>;
/** Matching key for reconciliation: file + full title path (no project). */
export declare function reconciliationKey(file: string, titlePath: readonly string[]): string;
/**
 * Flattens a junit-style pytest node id into (file, titlePath): the part
 * before the first `::` is the file, the remaining segments the path.
 *
 * Args:
 *   nodeId: pytest node id, e.g. `tests/test_x.py::TestA::test_b[param]`.
 *
 * Returns:
 *   { file, titlePath }: posix file + class/test title path.
 */
export declare function splitPytestNodeId(nodeId: string): {
    file: string;
    titlePath: string[];
};
/**
 * sha256 hex of one file's bytes (the catalog `sourceDigest`), or null
 * when the file cannot be read — callers turn that into an unresolved
 * row instead of a fabricated digest.
 *
 * Args:
 *   cwd: absolute repo root.
 *   file: repo-relative posix path.
 *
 * Returns:
 *   string | null: 64-char lowercase hex digest, or null when unreadable.
 */
export declare function fileDigest(cwd: string, file: string): string | null;
//# sourceMappingURL=reconcile.d.ts.map