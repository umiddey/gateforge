import { type JsonValue } from '@gateforge/core';
import { PROTOCOL_VERSION } from './schema.js';
/** What a plugin's discover handler must return (GPP/3 contract). */
export interface DiscoveryResult {
    resources: JsonValue[];
    unresolved: JsonValue[];
    findings: JsonValue[];
    /** Classification-signal facts (ADR 0003 D6); `[]` when unsupported. */
    classificationSignals: JsonValue[];
    /**
     * Optional coverage evidence: repo-root-relative files the handler
     * actually examined successfully. Omitted ⇒ coverage unknown ⇒ the
     * host's complete-scan attestation fails closed.
     */
    scannedPaths?: JsonValue[];
}
/** User-implemented discovery callback. Throw to answer with an `error` frame. */
export type DiscoverHandler = (paths: readonly string[]) => Promise<DiscoveryResult> | DiscoveryResult;
/** Options for {@link servePlugin}. */
export interface ServePluginOptions {
    /** This plugin's declared identity (echoed on every frame). */
    pluginId: string;
    /** This plugin's declared version (pinned by the host at the handshake). */
    pluginVersion: string;
    /** Declared capabilities (default: `['discover']`). */
    capabilities?: readonly string[];
    /** Byte source for host frames (default: `process.stdin`). */
    input?: AsyncIterable<Uint8Array>;
    /** Sink for plugin frames (default: `process.stdout`). */
    output?: {
        write(chunk: Uint8Array | string): unknown;
    };
    /** Line cap in bytes (default: 8 MiB). */
    maxLineBytes?: number;
}
/**
 * Runs the plugin side of a GPP/3 session until the host sends `shutdown`
 * (answered with `bye`) or closes stdin. Throws a {@link ProtocolFailure}
 * if the host violates the protocol (after emitting a session-fatal
 * `error` frame so the host can name the cause).
 */
export declare function servePlugin(handler: DiscoverHandler, options: ServePluginOptions): Promise<void>;
export { PROTOCOL_VERSION };
//# sourceMappingURL=plugin.d.ts.map