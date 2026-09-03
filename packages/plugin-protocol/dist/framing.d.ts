/**
 * Line framing + envelope construction/verification shared by the host and
 * the TS plugin SDK (spec §1–§2 lineage, hardened per ADR 0002 D3).
 *
 * Framing: one JSON object per line, `\n`-delimited, UTF-8, 8 MiB cap.
 * Envelope: `{protocolVersion, pluginId, pluginVersion, type, seq, payload,
 * digest}` with `digest = sha256(canonical({type, seq, payload}))`.
 */
import { type JsonValue } from '@gateforge/core';
import { type MessageType } from './schema.js';
/** A fully decoded and verified GPP/3 frame. */
export interface GppEnvelope {
    protocolVersion: 3;
    pluginId: string;
    pluginVersion: string;
    type: MessageType;
    seq: number;
    payload: unknown;
    digest: string;
}
/** Splits an accumulated stdout buffer into complete lines. */
export declare function extractLines(buffer: Buffer): {
    lines: Buffer[];
    rest: Buffer;
};
/**
 * Parses one raw stdout line into a JSON object. Fails closed with
 * `E_FRAME_JSON` on empty lines, invalid JSON, and non-object frames.
 */
export declare function parseLine(raw: Buffer, frameNo: number, expect: string): Record<string, unknown>;
/** Context for verifying a received envelope. */
export interface EnvelopeContext {
    /** pluginId this side pinned at the handshake. */
    pinnedId: string;
    /** pluginVersion this side pinned at the handshake. */
    pinnedVersion: string;
    /** Next legal `seq` of the peer (starts at 1, strictly sequential). */
    expectedSeq: number;
}
/**
 * Verifies the transport envelope of a received frame: mandatory fields,
 * protocol version, catalog membership, pinned identity, seq order, and
 * digest. Fails closed with the code matching the first violated rule.
 * Returns the narrowed envelope (payload still unvalidated).
 */
export declare function verifyEnvelope(frame: Record<string, unknown>, frameNo: number, ctx: EnvelopeContext): GppEnvelope;
/**
 * Validates a verified envelope's payload against the per-type schema.
 * Throws `E_SCHEMA` with the first failing field path on mismatch.
 */
export declare function verifyPayload(envelope: GppEnvelope, frameNo: number): unknown;
/**
 * Builds one outgoing frame (this side's identity + seq) and serializes it
 * as a newline-terminated JSON line with the canonical digest.
 */
export declare function encodeFrame(identity: {
    pluginId: string;
    pluginVersion: string;
}, type: MessageType, seq: number, payload: JsonValue): string;
//# sourceMappingURL=framing.d.ts.map