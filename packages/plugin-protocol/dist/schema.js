/**
 * GPP/3 message catalog and payload schemas (Interface pin #5).
 *
 * Every frame is `{protocolVersion: 3, pluginId, pluginVersion, type, seq,
 * payload, digest}` with `digest = sha256(canonical({type, seq, payload}))`
 * over the GF-canonical-JSON of @gate-forge/core (pin #1).
 *
 * GPP/3 (ADR 0003 D6) adds `classificationSignals` to the `result`
 * payload — INSIDE the digest-checked envelope, never beside it. There
 * is no unversioned optional-field compatibility: a GPP/2 peer fails
 * closed at the handshake with `E_PROTOCOL_VERSION` naming both
 * versions, and a GPP/3 peer omitting the field fails `E_SCHEMA`.
 *
 * Payload validation is schema-generated: every payload type below has a
 * zod schema and is validated on receive; any failure is `E_SCHEMA` with a
 * single-cause path/message diagnostic. The result payload matches the
 * frozen @gate-forge/core `Resource`, `UnresolvedReason`, and
 * `ClassificationSignal` shapes.
 */
import { z } from 'zod';
import { ClassificationSignalSchema, LocationSchema, ResourceSchema, UnresolvedReasonSchema, } from '@gate-forge/core';
/** The GPP version this package speaks. Handshakes pin this value. */
export const PROTOCOL_VERSION = 3;
/**
 * Capability a GPP/3 plugin declares when its discovery handler emits
 * classification signals. The host does NOT require it — a detector
 * that discovers resources but cannot emit signals stays valid and its
 * resources fall back to conservative classification defaults.
 */
export const SIGNAL_CAPABILITY = 'classification-signals';
/** Maximum bytes per stdout line, enforced while framing (GPP/1 lineage). */
export const MAX_FRAME_BYTES = 8 * 1024 * 1024; // 8 MiB
/** Message catalog: every legal envelope `type`. */
export const MESSAGE_TYPES = [
    'hello',
    'ready',
    'discover',
    'result',
    'error',
    'shutdown',
    'bye',
];
/**
 * Detector finding (discovery-spike lineage, e.g. `DUPLICATE_TABLE_NAME`):
 * a non-resource observation a detector makes about the scanned sources.
 */
export const FindingSchema = z
    .object({
    /** Short stable finding code, e.g. `DUPLICATE_ROUTE`. */
    code: z.string().min(1),
    /** Single-cause human explanation. */
    detail: z.string().min(1),
    /** Source locations the finding points at. */
    locations: z.array(LocationSchema).min(1),
})
    .strict();
/** `hello` (plugin → host, mandatory first frame): declared capabilities. */
export const HelloPayloadSchema = z
    .object({
    /** Non-empty capability list; the host requires `discover`. */
    capabilities: z.array(z.string().min(1)).min(1),
})
    .strict();
/** `ready` (host → plugin): empty payload; identity is pinned in the envelope. */
export const ReadyPayloadSchema = z.object({}).strict();
/** `discover` (host → plugin): lock-step request over repo-relative paths. */
export const DiscoverPayloadSchema = z
    .object({
    /** Host-generated id echoed by the response (`result`/`error`). */
    requestId: z.string().min(1),
    /** Repo-root-relative paths to scan; no absolute paths, no `..`. */
    paths: z.array(z.string().min(1)).min(1),
})
    .strict();
/** `result` (plugin → host): exactly one per discover, echoing `requestId`. */
export const ResultPayloadSchema = z
    .object({
    /** Echoes the outstanding discover's `requestId`. */
    requestId: z.string().min(1),
    /** Discovered resources (@gate-forge/core Resource shape). */
    resources: z.array(ResourceSchema),
    /** Reasons discovery could not proceed for parts of the input. */
    unresolved: z.array(UnresolvedReasonSchema),
    /** Non-resource observations (duplicates, ambiguities). */
    findings: z.array(FindingSchema),
    /**
     * Classification-signal facts (GPP/3, ADR 0003 D6). Mandatory since
     * the version bump — detectors without signal support send `[]`.
     */
    classificationSignals: z.array(ClassificationSignalSchema),
    /**
     * Repo-root-relative files the plugin actually examined successfully
     * (coverage evidence for the complete-scan attestation). Optional on
     * the wire; a plugin that omits it leaves coverage unknown, which
     * fails closed in the host's attestation.
     */
    scannedPaths: z.array(z.string().min(1)).optional(),
})
    .strict();
/**
 * `error` (both directions). Request-scoped (plugin answers one discover):
 * carries `requestId`. Session-fatal: no `requestId`; the sender considers
 * the session unrecoverable and terminates afterwards.
 */
export const ErrorPayloadSchema = z
    .object({
    requestId: z.string().min(1).optional(),
    /** Plugin-side failure code, e.g. `E_PLUGIN_INTERNAL`. */
    code: z.string().min(1),
    /** Single-cause human explanation (no stack dumps). */
    message: z.string().min(1),
})
    .strict();
/** `shutdown` (host → plugin): empty payload. */
export const ShutdownPayloadSchema = z.object({}).strict();
/** `bye` (plugin → host): mandatory reply to shutdown, then exit 0. */
export const ByePayloadSchema = z.object({}).strict();
/** Payload schema for each catalog message type. */
export const PAYLOAD_SCHEMAS = {
    hello: HelloPayloadSchema,
    ready: ReadyPayloadSchema,
    discover: DiscoverPayloadSchema,
    result: ResultPayloadSchema,
    error: ErrorPayloadSchema,
    shutdown: ShutdownPayloadSchema,
    bye: ByePayloadSchema,
};
/** The capability the host requires of every plugin. */
export const REQUIRED_CAPABILITY = 'discover';
/**
 * Renders the first zod issue of a failed payload parse as a single-cause
 * field path + message (`resources[0].id: Required`). Only the first issue
 * is reported — diagnostics name one cause, not a list.
 */
export function firstIssueText(error) {
    const issue = error.issues[0];
    if (!issue)
        return 'unknown validation failure';
    const path = issue.path.map(String).join('.');
    return path.length > 0 ? `${path}: ${issue.message}` : issue.message;
}
//# sourceMappingURL=schema.js.map