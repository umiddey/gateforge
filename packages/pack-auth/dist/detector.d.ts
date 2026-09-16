import type { DiscoveryOutcome } from '@gate-forge/plugin-protocol';
/** Detector contract: `discover(paths)` is sync (pure over file bytes). */
export interface AuthDetector {
    discover(paths: readonly string[]): DiscoveryOutcome;
}
/** Options for {@link createAuthDetector}. */
export interface AuthDetectorOptions {
    /** Repo root for repo-relative `source` paths (default: `process.cwd()`). */
    root?: string;
}
/** Detected framework for a resource. */
export type AuthFramework = 'nestjs' | 'express' | 'fastify' | 'hono';
/** Tenancy classification for one endpoint. */
export type Tenancy = 'tenant-bound' | 'none';
/**
 * Creates the discover-capable detector module. The default export of
 * the pack is `createAuthDetector()` — the CLI in-process contract.
 *
 * Args:
 *   options: Optional root override for repo-relative `source` paths.
 *
 * Returns:
 *   AuthDetector: the pinned `{ discover(paths) }` module.
 */
export declare function createAuthDetector(options?: AuthDetectorOptions): AuthDetector;
//# sourceMappingURL=detector.d.ts.map