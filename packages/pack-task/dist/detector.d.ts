import type { DiscoveryOutcome } from '@gateforge/plugin-protocol';
/** Attributes attached to every detected `task.resource`. */
export interface TaskResourceAttributes {
    /** Literal task name extracted from the source. */
    taskName: string;
    /** Detection pattern that produced this resource. */
    framework: 'bullmq' | 'bee-queue' | 'custom-queue' | 'message-handler' | 'recurring' | 'decorator';
    /** Retry policy: max attempts + backoff kind (defaults applied if absent). */
    retryPolicy: {
        maxAttempts: number;
        backoff: 'fixed' | 'exponential';
    };
    /** True if the source declares an idempotency key / dedup hint. */
    idempotencyKey: boolean;
    /** Error types whose occurrence marks the task terminal (no retry). */
    terminalOn: string[];
    /** True if the source declares observability hooks (metrics/tracing/listeners). */
    observability: boolean;
    /** Source declaration location (file + line + col). */
    source: {
        file: string;
        line: number;
        col: number;
    };
}
/** Options for {@link createTaskDetector}. */
export interface TaskDetectorOptions {
    /** Override the repo root used for relative path computation. */
    rootDir?: string;
}
/** The pinned in-process plugin contract: `{ discover(paths) }`. */
export interface TaskDetector {
    discover(paths: string[]): Promise<DiscoveryOutcome>;
}
/**
 * Creates a discover-capable detector module. The default export of the
 * pack is an instance with no overrides.
 *
 * Args:
 *   options: Optional `{ rootDir }` override (defaults to `process.cwd()`).
 *
 * Returns:
 *   TaskDetector: A `{ discover(paths) }` callable.
 */
export declare function createTaskDetector(options?: TaskDetectorOptions): TaskDetector;
/** The pinned in-process plugin contract: `{ discover(paths) }`. */
export declare const discover: TaskDetector['discover'];
//# sourceMappingURL=detector.d.ts.map