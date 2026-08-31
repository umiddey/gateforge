import { type DiscoveryOutcome } from './schema.js';
/** Default per-phase watchdog budgets. */
export declare const DEFAULT_TIMEOUTS: Required<Pick<PluginTimeouts, 'handshakeMs' | 'requestMs' | 'shutdownMs'>>;
/** Watchdog budgets, all individually overridable for tests. */
export interface PluginTimeouts {
    /** Time budget for the plugin's first `hello` frame. */
    handshakeMs: number;
    /** Time budget for each `result`/`error` response. */
    requestMs: number;
    /** Time budget for `bye` and for the exit after it. */
    shutdownMs: number;
}
/** Options for {@link PluginSession}. */
export interface PluginSpawnOptions {
    /** Full argv of the plugin subprocess, e.g. `['node', 'plugin.js', root]`. */
    command: readonly string[];
    /** Expected pluginId — pinned at the handshake, enforced on every frame. */
    pluginId: string;
    /** Expected pluginVersion — pinned at the handshake, enforced on every frame. */
    pluginVersion: string;
    /** Working directory for the subprocess (default: process cwd). */
    cwd?: string;
    /** Full environment for the subprocess (default: inherit). */
    env?: NodeJS.ProcessEnv;
    /** Watchdog budgets (default: {@link DEFAULT_TIMEOUTS}). */
    timeouts?: Partial<PluginTimeouts>;
    /** Line cap in bytes (default: 8 MiB). */
    maxLineBytes?: number;
}
/**
 * One persistent plugin subprocess: one spawn, many discovers (lock-step),
 * one shutdown handshake. Any protocol violation fails the session closed:
 * the plugin is killed and a typed {@link ProtocolFailure} is thrown whose
 * `message` is a single-cause diagnostic.
 */
export declare class PluginSession {
    #private;
    constructor(options: PluginSpawnOptions);
    /**
     * Performs the handshake: reads and validates `hello` (pinning
     * protocolVersion, pluginId, pluginVersion) and answers `ready`.
     */
    start(): Promise<void>;
    /**
     * Sends one `discover` and awaits the matching `result`/`error`.
     * Lock-step: at most one discover may be outstanding per session.
     */
    discover(paths: readonly string[]): Promise<DiscoveryOutcome>;
    /**
     * Shutdown handshake: `shutdown` → `bye` → exit 0. Nonzero exit or a
     * hang after a clean bye is `E_EXIT_STATUS`.
     */
    shutdown(): Promise<void>;
    /**
     * Best-effort teardown: kills the plugin if it is still running and
     * waits for it to exit. Never throws; safe to call multiple times and
     * after any failure.
     */
    dispose(): Promise<void>;
}
//# sourceMappingURL=host.d.ts.map