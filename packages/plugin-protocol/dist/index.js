/**
 * @gateforge/plugin-protocol — GPP/2, the hardened subprocess plugin
 * protocol (ADR 0002 D3).
 *
 * Surface:
 * - {@link PluginSession}: the engine-side host (one spawn, many lock-step
 *   discovers, watchdog + kill, shutdown handshake).
 * - {@link servePlugin}: the TypeScript plugin SDK.
 * - zod payload schemas for every message (`src/schema.ts`).
 * - typed failure classes for every E_* code (`src/codes.ts`).
 * - Python client + reference plugin under `python/`.
 *
 * Lineage: spikes/plugin-protocol/spec.md (GPP/1), hardened with
 * pluginVersion pinning, per-message digests, and schema-generated
 * validation per docs/decisions/0002-plugin-boundary.md.
 */
// ---------------------------------------------------------------------------
// Failure codes, typed errors, diagnostics
// ---------------------------------------------------------------------------
export { FAILURE_CODES, ProtocolFailure, ProtocolVersionError, UnknownPluginError, FrameJsonError, UnknownTypeError, SchemaError, EofError, TimeoutError, PluginError, ExitStatusError, isProtocolFailure, formatDiagnostic, } from './codes.js';
// ---------------------------------------------------------------------------
// Message catalog, payload schemas (pin #5)
// ---------------------------------------------------------------------------
export { PROTOCOL_VERSION, MAX_FRAME_BYTES, MESSAGE_TYPES, REQUIRED_CAPABILITY, HelloPayloadSchema, ReadyPayloadSchema, DiscoverPayloadSchema, ResultPayloadSchema, ErrorPayloadSchema, ShutdownPayloadSchema, ByePayloadSchema, PAYLOAD_SCHEMAS, FindingSchema, firstIssueText, } from './schema.js';
// ---------------------------------------------------------------------------
// Framing + envelope verification
// ---------------------------------------------------------------------------
export { extractLines, parseLine, verifyEnvelope, verifyPayload, encodeFrame, } from './framing.js';
// ---------------------------------------------------------------------------
// Host (engine side)
// ---------------------------------------------------------------------------
export { PluginSession, DEFAULT_TIMEOUTS } from './host.js';
// ---------------------------------------------------------------------------
// Plugin SDK (TS side)
// ---------------------------------------------------------------------------
export { servePlugin } from './plugin.js';
//# sourceMappingURL=index.js.map