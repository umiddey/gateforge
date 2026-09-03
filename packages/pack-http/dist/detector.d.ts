import type { DiscoveryOutcome } from '@gateforge/plugin-protocol';
/** Detector contract: `discover(paths)` is sync (pure over file bytes). */
export interface HttpDetector {
    discover(paths: readonly string[]): DiscoveryOutcome;
}
/** Options for {@link createHttpDetector}. */
export interface HttpDetectorOptions {
    /** Repo root for repo-relative `source` paths (default: `process.cwd()`). */
    root?: string;
}
/** Where an externally-reachable artifact was found. */
export type HttpOrigin = 'express' | 'fastify' | 'hono' | 'nestjs' | 'fetch' | 'axios';
/**
 * Derives the resource name a path speaks about: the LAST non-empty,
 * non-parameter path segment, lower-cased, file extension stripped.
 * Purely-numeric segments are item selectors (`/accounts/9`), not
 * resource names, and are skipped the same as parameters. Returns
 * `null` when no such segment exists (`/`, `*`, `:id`) — the caller
 * emits NO signal rather than guessing a target.
 */
export declare function resourceNameFromPath(rawPath: string): string | null;
/**
 * Creates the discover-capable detector module. The default export of
 * the pack is `createHttpDetector()` — the CLI in-process contract.
 *
 * Args:
 *   options: Optional root override for repo-relative `source` paths.
 *
 * Returns:
 *   HttpDetector: the pinned `{ discover(paths) }` module.
 */
export declare function createHttpDetector(options?: HttpDetectorOptions): HttpDetector;
//# sourceMappingURL=detector.d.ts.map