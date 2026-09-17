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
/**
 * Finds the consumer's playwright config: at the repo root first, then —
 * only when no root-level config exists — ONE directory level deep
 * (immediate subdirectories, dependency/build/VCS/runner directories
 * pruned), alphabetically first match. Returns the repo-relative posix
 * path (`'playwright.config.ts'`, or `'e2e/playwright.config.ts'` for a
 * subdirectory project), or null when none exists.
 *
 * Root-level configs always win: an existing root project must keep its
 * exact historical invocation. The nested search only extends discovery
 * to the self-contained subdirectory layout (the config's OWN directory
 * pins its playwright install — see {@link playwrightCliPath}).
 *
 * Args:
 *   cwd: absolute repo root.
 *
 * Returns:
 *   string | null: repo-relative posix config path, or null.
 */
export declare function findPlaywrightConfig(cwd: string): string | null;
/**
 * Enumerates the consumer's playwright tests via official list mode.
 * See the module doc for the trust boundary. The CLI is the consumer's
 * own when present (the config directory's first — see
 * {@link playwrightCliPath}); the engine's own pinned playwright (pack
 * dependency, 1.58.2) is the fallback — no network, no npx resolution
 * from the consumer.
 *
 * The child runs from the CONFIG'S directory (the way the owner runs
 * it): a subdirectory project's config and specs load through THAT
 * directory's node_modules, with `--config` naming the config as seen
 * from that cwd. Root-level projects keep the exact historical
 * invocation (repo-root cwd, auto-discovered config, no `--config`).
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