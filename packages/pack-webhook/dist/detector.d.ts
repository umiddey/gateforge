import type { DiscoveryOutcome } from '@gateforge/plugin-protocol';
/** Detected framework of a webhook endpoint. */
export type WebhookFramework = 'express' | 'fastify' | 'hono' | 'decorator';
/** Allowed signature algorithms the detector records. */
export type SignatureAlgorithm = 'hmac-sha256' | 'hmac-sha1' | 'none';
/** The detector's resource-attribute payload (deterministic, JSON-safe). */
export interface WebhookResourceAttributes {
    /** Framework the resource was detected in. */
    framework: WebhookFramework;
    /** Stable path the endpoint is mounted at. */
    path: string;
    /** HTTP methods the route accepts (sorted). */
    httpMethods: string[];
    /** HTTP header the signature is read from (default `x-signature`). */
    signatureHeader: string;
    /** HMAC variant the signature uses (`none` if no signature detected). */
    signatureAlgorithm: SignatureAlgorithm;
    /** Anti-replay window in milliseconds (default 300000 = 5 minutes). */
    replayWindow: number;
    /** Maximum accepted body size in bytes (default 1 MiB). */
    maxBody: number;
    /** Provider token extracted from the path or decorator argument. */
    provider: string;
}
/** Detector options. */
export interface WebhookDetectorOptions {
    /** Repo-root directory used to compute repo-relative paths. */
    root?: string;
    /** Default replay window override (ms). Defaults to 300000. */
    defaultReplayWindow?: number;
    /** Default max body override (bytes). Defaults to 1_048_576 (1 MiB). */
    defaultMaxBody?: number;
}
/** The pinned in-process plugin contract. */
export interface WebhookDetector {
    discover(paths: readonly string[]): DiscoveryOutcome;
}
/** The default exports for the pack: `discover(paths)`. */
export declare function discoverWebhooks(paths: readonly string[], options?: WebhookDetectorOptions): DiscoveryOutcome;
/** Build a discover-capable detector module. */
export declare function createWebhookDetector(options?: WebhookDetectorOptions): WebhookDetector;
//# sourceMappingURL=detector.d.ts.map