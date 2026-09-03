/**
 * Line framing + envelope construction/verification shared by the host and
 * the TS plugin SDK (spec §1–§2 lineage, hardened per ADR 0002 D3).
 *
 * Framing: one JSON object per line, `\n`-delimited, UTF-8, 8 MiB cap.
 * Envelope: `{protocolVersion, pluginId, pluginVersion, type, seq, payload,
 * digest}` with `digest = sha256(canonical({type, seq, payload}))`.
 */
import { isJsonValue, sha256Canonical, type JsonValue } from '@gateforge/core';
import {
  FrameJsonError,
  ProtocolVersionError,
  SchemaError,
  UnknownPluginError,
  UnknownTypeError,
  type FailureContext,
} from './codes.js';
import { MESSAGE_TYPES, PAYLOAD_SCHEMAS, PROTOCOL_VERSION, firstIssueText, type MessageType } from './schema.js';

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
export function extractLines(buffer: Buffer): { lines: Buffer[]; rest: Buffer } {
  const lines: Buffer[] = [];
  let start = 0;
  for (let i = 0; i < buffer.length; i++) {
    if (buffer[i] === 0x0a) {
      lines.push(buffer.subarray(start, i));
      start = i + 1;
    }
  }
  return { lines, rest: buffer.subarray(start) };
}

/**
 * Parses one raw stdout line into a JSON object. Fails closed with
 * `E_FRAME_JSON` on empty lines, invalid JSON, and non-object frames.
 */
export function parseLine(raw: Buffer, frameNo: number, expect: string): Record<string, unknown> {
  const text = raw.toString('utf8');
  if (text.trim().length === 0) {
    throw new FrameJsonError(`frame ${frameNo}: empty line where ${expect} expected`, {
      frameNo,
      rawLine: text,
    });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new FrameJsonError(
      `frame ${frameNo}: line is not valid JSON (${reason}); ` +
        'plugin printed non-protocol output on stdout',
      { frameNo, rawLine: text },
    );
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    const got = parsed === null ? 'null' : Array.isArray(parsed) ? 'array' : typeof parsed;
    throw new FrameJsonError(
      `frame ${frameNo}: valid JSON but not an object (got ${got}) where ${expect} expected`,
      { frameNo, rawLine: text },
    );
  }
  return parsed as Record<string, unknown>;
}

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
export function verifyEnvelope(
  frame: Record<string, unknown>,
  frameNo: number,
  ctx: EnvelopeContext,
): GppEnvelope {
  const ctxOut: FailureContext = { frameNo };
  const foundKeys = Object.keys(frame).sort().join(', ');

  for (const field of [
    'protocolVersion',
    'pluginId',
    'pluginVersion',
    'type',
    'seq',
    'payload',
    'digest',
  ] as const) {
    if (!(field in frame)) {
      throw new SchemaError(
        `frame ${frameNo}: required envelope field "${field}" is missing; found keys [${foundKeys}]`,
        ctxOut,
      );
    }
  }

  const { protocolVersion, pluginId, pluginVersion, type, seq, payload, digest } = frame as Record<
    string,
    unknown
  >;

  if (typeof protocolVersion !== 'number' || !Number.isInteger(protocolVersion)) {
    throw new SchemaError(
      `frame ${frameNo}: envelope field "protocolVersion" must be an integer, got ${JSON.stringify(protocolVersion)}`,
      ctxOut,
    );
  }
  if (protocolVersion !== PROTOCOL_VERSION) {
    throw new ProtocolVersionError(
      `frame ${frameNo}: envelope protocolVersion=${JSON.stringify(protocolVersion)} ` +
        `but the host speaks ${PROTOCOL_VERSION}`,
      ctxOut,
    );
  }

  if (typeof pluginId !== 'string' || pluginId.length === 0) {
    throw new SchemaError(
      `frame ${frameNo}: envelope field "pluginId" must be a non-empty string, got ${JSON.stringify(pluginId)}`,
      ctxOut,
    );
  }
  if (pluginId !== ctx.pinnedId) {
    throw new UnknownPluginError(
      `frame ${frameNo}: pluginId ${JSON.stringify(pluginId)} but this session pinned ` +
        `${JSON.stringify(ctx.pinnedId)}; refusing the frame`,
      ctxOut,
    );
  }

  if (typeof pluginVersion !== 'string' || pluginVersion.length === 0) {
    throw new SchemaError(
      `frame ${frameNo}: envelope field "pluginVersion" must be a non-empty string, got ${JSON.stringify(pluginVersion)}`,
      ctxOut,
    );
  }
  if (pluginVersion !== ctx.pinnedVersion) {
    throw new UnknownPluginError(
      `frame ${frameNo}: pluginVersion ${JSON.stringify(pluginVersion)} but this session pinned ` +
        `${JSON.stringify(ctx.pinnedVersion)} (pluginId ${JSON.stringify(ctx.pinnedId)}); refusing the frame`,
      ctxOut,
    );
  }

  if (typeof type !== 'string' || !(MESSAGE_TYPES as readonly string[]).includes(type)) {
    throw new UnknownTypeError(
      `frame ${frameNo}: unknown message type ${JSON.stringify(type)}; known types: ${MESSAGE_TYPES.join(', ')}`,
      ctxOut,
    );
  }

  if (typeof seq !== 'number' || !Number.isInteger(seq) || seq < 1) {
    throw new SchemaError(
      `frame ${frameNo} (type ${type}): envelope field "seq" must be an integer >= 1, got ${JSON.stringify(seq)}`,
      ctxOut,
    );
  }
  if (seq !== ctx.expectedSeq) {
    throw new SchemaError(
      `frame ${frameNo} (type ${type}): seq ${seq} but expected ${ctx.expectedSeq} ` +
        '(frames must arrive strictly in order, one seq per message)',
      ctxOut,
    );
  }

  if (typeof digest !== 'string' || !/^[0-9a-f]{64}$/.test(digest)) {
    throw new SchemaError(
      `frame ${frameNo} (type ${type}): envelope field "digest" must be 64 lowercase hex chars, ` +
        `got ${JSON.stringify(digest)}`,
      ctxOut,
    );
  }
  const computed = sha256Canonical({ type, seq, payload } as JsonValue);
  if (digest !== computed) {
    throw new SchemaError(
      `frame ${frameNo} (type ${type}): digest mismatch: expected ${computed}, got ${digest} ` +
        '(digest = sha256(canonical({type, seq, payload})))',
      ctxOut,
    );
  }

  return {
    protocolVersion: PROTOCOL_VERSION,
    pluginId,
    pluginVersion,
    type: type as MessageType,
    seq,
    payload,
    digest,
  };
}

/**
 * Validates a verified envelope's payload against the per-type schema.
 * Throws `E_SCHEMA` with the first failing field path on mismatch.
 */
export function verifyPayload(envelope: GppEnvelope, frameNo: number): unknown {
  const schema = PAYLOAD_SCHEMAS[envelope.type];
  const result = schema.safeParse(envelope.payload);
  if (!result.success) {
    throw new SchemaError(
      `frame ${frameNo} (type ${envelope.type}): invalid payload at "${firstIssueText(result.error)}"`,
      { frameNo },
    );
  }
  return result.data;
}

/**
 * Builds one outgoing frame (this side's identity + seq) and serializes it
 * as a newline-terminated JSON line with the canonical digest.
 */
export function encodeFrame(identity: { pluginId: string; pluginVersion: string }, type: MessageType, seq: number, payload: JsonValue): string {
  const digest = sha256Canonical({ type, seq, payload });
  const frame = {
    protocolVersion: PROTOCOL_VERSION,
    pluginId: identity.pluginId,
    pluginVersion: identity.pluginVersion,
    type,
    seq,
    payload,
    digest,
  };
  return `${JSON.stringify(frame)}\n`;
}
