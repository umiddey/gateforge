import type { DiscoveryOutcome } from '@gateforge/plugin-protocol';
import { type ClientScanConfig } from './client-calls.js';
/** Detector contract: `discover(paths)` is sync (pure over file bytes). */
export interface HttpDetector {
    discover(paths: readonly string[]): DiscoveryOutcome;
}
/** Options for {@link createHttpDetector}. */
export interface HttpDetectorOptions {
    /** Repo root for repo-relative `source` paths (default: `process.cwd()`). */
    root?: string;
    /** Client-scan configuration (declarates resolvable APIs, ADR 0004 D6). */
    clientScan?: ClientScanConfig;
    /**
     * Repo-relative path of a client-scan config document (JSON) read from
     * `root` when `clientScan` is not given (default:
     * `.gateforge/http-clients.json`; absence is normal).
     */
    clientScanConfigPath?: string;
}
/** Where an externally-reachable artifact was found. */
export type HttpOrigin = 'express' | 'fastify' | 'hono' | 'nestjs' | 'fetch' | 'axios';
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