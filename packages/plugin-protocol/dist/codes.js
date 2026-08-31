/**
 * GPP/2 failure codes and their error classes (ADR 0002 D3).
 *
 * Every failure is a distinct class extending {@link ProtocolFailure} and
 * carries a single-cause, actionable detail naming (where applicable) the
 * frame number, message type, offending field, and expected vs got — never
 * a stack dump. Consumers render diagnostics via {@link formatDiagnostic};
 * `error.stack` is a JS-runtime artifact and must never be printed by the
 * host.
 */
/** Every fail-closed GPP/2 diagnostic code. */
export const FAILURE_CODES = [
    'E_PROTOCOL_VERSION',
    'E_UNKNOWN_PLUGIN',
    'E_FRAME_JSON',
    'E_UNKNOWN_TYPE',
    'E_SCHEMA',
    'E_EOF',
    'E_TIMEOUT',
    'E_PLUGIN_ERROR',
    'E_EXIT_STATUS',
];
/**
 * Base class for every fail-closed protocol failure. The `message` is the
 * single-cause detail; `code`/`frameNo`/`rawLine` are structured fields.
 */
export class ProtocolFailure extends Error {
    code;
    frameNo;
    rawLine;
    constructor(code, detail, context = {}) {
        super(detail);
        this.name = new.target.name;
        this.code = code;
        this.frameNo = context.frameNo;
        this.rawLine = context.rawLine;
    }
}
/** Handshake or envelope declared a protocol version other than 2. */
export class ProtocolVersionError extends ProtocolFailure {
    constructor(detail, context = {}) {
        super('E_PROTOCOL_VERSION', detail, context);
    }
}
/** Plugin identity (pluginId or pluginVersion) differs from the pinned registration. */
export class UnknownPluginError extends ProtocolFailure {
    constructor(detail, context = {}) {
        super('E_UNKNOWN_PLUGIN', detail, context);
    }
}
/** Framing violation: empty line, invalid JSON, non-object frame, or over the line cap. */
export class FrameJsonError extends ProtocolFailure {
    constructor(detail, context = {}) {
        super('E_FRAME_JSON', detail, context);
    }
}
/** Envelope `type` is not in the message catalog. */
export class UnknownTypeError extends ProtocolFailure {
    constructor(detail, context = {}) {
        super('E_UNKNOWN_TYPE', detail, context);
    }
}
/** Missing/mistyped mandatory field, digest mismatch, seq gap, or state violation. */
export class SchemaError extends ProtocolFailure {
    constructor(detail, context = {}) {
        super('E_SCHEMA', detail, context);
    }
}
/** Plugin stream ended (plugin exited) before the expected frame arrived. */
export class EofError extends ProtocolFailure {
    constructor(detail, context = {}) {
        super('E_EOF', detail, context);
    }
}
/** No expected frame within the watchdog budget; the plugin is killed. */
export class TimeoutError extends ProtocolFailure {
    constructor(detail, context = {}) {
        super('E_TIMEOUT', detail, context);
    }
}
/** Plugin answered a request (or the session) with an `error` frame. */
export class PluginError extends ProtocolFailure {
    constructor(detail, context = {}) {
        super('E_PLUGIN_ERROR', detail, context);
    }
}
/** Plugin exited nonzero (or had to be killed) after a clean `bye`. */
export class ExitStatusError extends ProtocolFailure {
    constructor(detail, context = {}) {
        super('E_EXIT_STATUS', detail, context);
    }
}
/** Narrows an unknown thrown value to a {@link ProtocolFailure}, optionally by code. */
export function isProtocolFailure(value, code) {
    if (!(value instanceof ProtocolFailure))
        return false;
    return code === undefined || value.code === code;
}
function truncate(text, max) {
    return text.length <= max ? text : `${text.slice(0, max)}…`;
}
/**
 * Renders the two-line host diagnostic (spec §5 lineage):
 * `[plugin-protocol] FAIL <CODE>: <detail>` plus, when the offending raw
 * frame is known, `[plugin-protocol] offending frame: <raw, ≤200 chars>`.
 * Never includes stack frames.
 */
export function formatDiagnostic(failure) {
    const lines = [`[plugin-protocol] FAIL ${failure.code}: ${failure.message}`];
    if (failure.rawLine !== undefined) {
        lines.push(`[plugin-protocol] offending frame: ${truncate(failure.rawLine, 200)}`);
    }
    return lines.join('\n');
}
//# sourceMappingURL=codes.js.map