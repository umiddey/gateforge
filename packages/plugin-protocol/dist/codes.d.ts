/**
 * GPP/3 failure codes and their error classes (ADR 0002 D3).
 *
 * Every failure is a distinct class extending {@link ProtocolFailure} and
 * carries a single-cause, actionable detail naming (where applicable) the
 * frame number, message type, offending field, and expected vs got — never
 * a stack dump. Consumers render diagnostics via {@link formatDiagnostic};
 * `error.stack` is a JS-runtime artifact and must never be printed by the
 * host.
 */
/** Every fail-closed GPP/3 diagnostic code. */
export declare const FAILURE_CODES: readonly ["E_PROTOCOL_VERSION", "E_UNKNOWN_PLUGIN", "E_FRAME_JSON", "E_UNKNOWN_TYPE", "E_SCHEMA", "E_EOF", "E_TIMEOUT", "E_PLUGIN_ERROR", "E_EXIT_STATUS"];
/** Union of all GPP/3 failure codes. */
export type ProtocolFailureCode = (typeof FAILURE_CODES)[number];
/** Rendering context attached to a failure for the offending-frame line. */
export interface FailureContext {
    /** 1-based ordinal of the received frame that caused the failure. */
    frameNo?: number;
    /** Raw stdout line (truncated to 200 chars by formatDiagnostic). */
    rawLine?: string;
}
/**
 * Base class for every fail-closed protocol failure. The `message` is the
 * single-cause detail; `code`/`frameNo`/`rawLine` are structured fields.
 */
export declare class ProtocolFailure extends Error {
    readonly code: ProtocolFailureCode;
    readonly frameNo: number | undefined;
    readonly rawLine: string | undefined;
    constructor(code: ProtocolFailureCode, detail: string, context?: FailureContext);
}
/** Handshake or envelope declared a protocol version other than 3. */
export declare class ProtocolVersionError extends ProtocolFailure {
    constructor(detail: string, context?: FailureContext);
}
/** Plugin identity (pluginId or pluginVersion) differs from the pinned registration. */
export declare class UnknownPluginError extends ProtocolFailure {
    constructor(detail: string, context?: FailureContext);
}
/** Framing violation: empty line, invalid JSON, non-object frame, or over the line cap. */
export declare class FrameJsonError extends ProtocolFailure {
    constructor(detail: string, context?: FailureContext);
}
/** Envelope `type` is not in the message catalog. */
export declare class UnknownTypeError extends ProtocolFailure {
    constructor(detail: string, context?: FailureContext);
}
/** Missing/mistyped mandatory field, digest mismatch, seq gap, or state violation. */
export declare class SchemaError extends ProtocolFailure {
    constructor(detail: string, context?: FailureContext);
}
/** Plugin stream ended (plugin exited) before the expected frame arrived. */
export declare class EofError extends ProtocolFailure {
    constructor(detail: string, context?: FailureContext);
}
/** No expected frame within the watchdog budget; the plugin is killed. */
export declare class TimeoutError extends ProtocolFailure {
    constructor(detail: string, context?: FailureContext);
}
/** Plugin answered a request (or the session) with an `error` frame. */
export declare class PluginError extends ProtocolFailure {
    constructor(detail: string, context?: FailureContext);
}
/** Plugin exited nonzero (or had to be killed) after a clean `bye`. */
export declare class ExitStatusError extends ProtocolFailure {
    constructor(detail: string, context?: FailureContext);
}
/** Narrows an unknown thrown value to a {@link ProtocolFailure}, optionally by code. */
export declare function isProtocolFailure(value: unknown, code?: ProtocolFailureCode): value is ProtocolFailure;
/**
 * Renders the two-line host diagnostic (spec §5 lineage):
 * `[plugin-protocol] FAIL <CODE>: <detail>` plus, when the offending raw
 * frame is known, `[plugin-protocol] offending frame: <raw, ≤200 chars>`.
 * Never includes stack frames.
 */
export declare function formatDiagnostic(failure: ProtocolFailure): string;
//# sourceMappingURL=codes.d.ts.map