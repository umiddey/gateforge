/**
 * GPP/3 message catalog and payload schemas (Interface pin #5).
 *
 * Every frame is `{protocolVersion: 3, pluginId, pluginVersion, type, seq,
 * payload, digest}` with `digest = sha256(canonical({type, seq, payload}))`
 * over the GF-canonical-JSON of @gateforge/core (pin #1).
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
 * frozen @gateforge/core `Resource`, `UnresolvedReason`, and
 * `ClassificationSignal` shapes.
 */
import { z } from 'zod';
import { ClassificationSignalSchema, ResourceSchema, UnresolvedReasonSchema } from '@gateforge/core';
/** The GPP version this package speaks. Handshakes pin this value. */
export declare const PROTOCOL_VERSION = 3;
/**
 * Capability a GPP/3 plugin declares when its discovery handler emits
 * classification signals. The host does NOT require it — a detector
 * that discovers resources but cannot emit signals stays valid and its
 * resources fall back to conservative classification defaults.
 */
export declare const SIGNAL_CAPABILITY = "classification-signals";
/** Maximum bytes per stdout line, enforced while framing (GPP/1 lineage). */
export declare const MAX_FRAME_BYTES: number;
/** Message catalog: every legal envelope `type`. */
export declare const MESSAGE_TYPES: readonly ["hello", "ready", "discover", "result", "error", "shutdown", "bye"];
/** Union of catalog message types. */
export type MessageType = (typeof MESSAGE_TYPES)[number];
/**
 * Detector finding (discovery-spike lineage, e.g. `DUPLICATE_TABLE_NAME`):
 * a non-resource observation a detector makes about the scanned sources.
 */
export declare const FindingSchema: z.ZodObject<{
    code: z.ZodString;
    detail: z.ZodString;
    locations: z.ZodArray<z.ZodObject<{
        file: z.ZodString;
        line: z.ZodNumber;
        col: z.ZodNumber;
    }, z.core.$strict>>;
}, z.core.$strict>;
/** Inferred finding shape. */
export type Finding = z.infer<typeof FindingSchema>;
/** The complete discovery output a plugin returns for one request. */
export interface DiscoveryOutcome {
    resources: z.infer<typeof ResourceSchema>[];
    unresolved: z.infer<typeof UnresolvedReasonSchema>[];
    findings: Finding[];
    classificationSignals: z.infer<typeof ClassificationSignalSchema>[];
    /**
     * Repo-root-relative files the plugin actually examined successfully.
     * Coverage evidence for the complete-scan attestation: the host unions
     * these across successful plugins and fails closed when the union does
     * not cover the requested scope. A plugin that omits the field leaves
     * coverage unknown — which fails closed.
     */
    scannedPaths?: string[];
}
/** `hello` (plugin → host, mandatory first frame): declared capabilities. */
export declare const HelloPayloadSchema: z.ZodObject<{
    capabilities: z.ZodArray<z.ZodString>;
}, z.core.$strict>;
/** `ready` (host → plugin): empty payload; identity is pinned in the envelope. */
export declare const ReadyPayloadSchema: z.ZodObject<{}, z.core.$strict>;
/** `discover` (host → plugin): lock-step request over repo-relative paths. */
export declare const DiscoverPayloadSchema: z.ZodObject<{
    requestId: z.ZodString;
    paths: z.ZodArray<z.ZodString>;
}, z.core.$strict>;
/** `result` (plugin → host): exactly one per discover, echoing `requestId`. */
export declare const ResultPayloadSchema: z.ZodObject<{
    requestId: z.ZodString;
    resources: z.ZodArray<z.ZodObject<{
        schemaVersion: z.ZodLiteral<1>;
        id: z.ZodString;
        kind: z.ZodString;
        source: z.ZodString;
        location: z.ZodObject<{
            file: z.ZodString;
            line: z.ZodNumber;
            col: z.ZodNumber;
        }, z.core.$strict>;
        detectorVersion: z.ZodString;
        attributes: z.ZodRecord<z.ZodString, z.ZodUnknown>;
    }, z.core.$strict>>;
    unresolved: z.ZodArray<z.ZodObject<{
        code: z.ZodString;
        detail: z.ZodString;
        location: z.ZodObject<{
            file: z.ZodString;
            line: z.ZodNumber;
            col: z.ZodNumber;
        }, z.core.$strict>;
    }, z.core.$strict>>;
    findings: z.ZodArray<z.ZodObject<{
        code: z.ZodString;
        detail: z.ZodString;
        locations: z.ZodArray<z.ZodObject<{
            file: z.ZodString;
            line: z.ZodNumber;
            col: z.ZodNumber;
        }, z.core.$strict>>;
    }, z.core.$strict>>;
    classificationSignals: z.ZodArray<z.ZodObject<{
        schemaVersion: z.ZodLiteral<1>;
        target: z.ZodObject<{
            resourceName: z.ZodOptional<z.ZodString>;
            resourceId: z.ZodOptional<z.ZodString>;
            symbol: z.ZodOptional<z.ZodString>;
        }, z.core.$strict>;
        dimension: z.ZodEnum<{
            exposure: "exposure";
            plane: "plane";
            identity: "identity";
            "lifecycle.create": "lifecycle.create";
            "lifecycle.read": "lifecycle.read";
            "lifecycle.update": "lifecycle.update";
            "lifecycle.delete": "lifecycle.delete";
            "delete-semantics": "delete-semantics";
            "archive-state": "archive-state";
            "adapter-binding": "adapter-binding";
            internality: "internality";
        }>;
        assertion: z.ZodUnion<readonly [z.ZodString, z.ZodBoolean, z.ZodArray<z.ZodString>, z.ZodRecord<z.ZodString, z.ZodUnion<readonly [z.ZodString, z.ZodNumber, z.ZodBoolean]>>]>;
        basis: z.ZodEnum<{
            "code-positive": "code-positive";
            "code-negative-closed-world": "code-negative-closed-world";
            declaration: "declaration";
            "organization-policy": "organization-policy";
        }>;
        source: z.ZodString;
        location: z.ZodObject<{
            file: z.ZodString;
            line: z.ZodNumber;
            col: z.ZodNumber;
        }, z.core.$strict>;
        detector: z.ZodObject<{
            id: z.ZodString;
            version: z.ZodString;
        }, z.core.$strict>;
    }, z.core.$strict>>;
    scannedPaths: z.ZodOptional<z.ZodArray<z.ZodString>>;
}, z.core.$strict>;
/**
 * `error` (both directions). Request-scoped (plugin answers one discover):
 * carries `requestId`. Session-fatal: no `requestId`; the sender considers
 * the session unrecoverable and terminates afterwards.
 */
export declare const ErrorPayloadSchema: z.ZodObject<{
    requestId: z.ZodOptional<z.ZodString>;
    code: z.ZodString;
    message: z.ZodString;
}, z.core.$strict>;
/** `shutdown` (host → plugin): empty payload. */
export declare const ShutdownPayloadSchema: z.ZodObject<{}, z.core.$strict>;
/** `bye` (plugin → host): mandatory reply to shutdown, then exit 0. */
export declare const ByePayloadSchema: z.ZodObject<{}, z.core.$strict>;
/** Payload schema for each catalog message type. */
export declare const PAYLOAD_SCHEMAS: Record<MessageType, z.ZodType>;
/** The capability the host requires of every plugin. */
export declare const REQUIRED_CAPABILITY = "discover";
/**
 * Renders the first zod issue of a failed payload parse as a single-cause
 * field path + message (`resources[0].id: Required`). Only the first issue
 * is reported — diagnostics name one cause, not a list.
 */
export declare function firstIssueText(error: z.ZodError): string;
//# sourceMappingURL=schema.d.ts.map