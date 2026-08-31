/**
 * GPP/2 message catalog and payload schemas (Interface pin #5).
 *
 * Every frame is `{protocolVersion: 2, pluginId, pluginVersion, type, seq,
 * payload, digest}` with `digest = sha256(canonical({type, seq, payload}))`
 * over the GF-canonical-JSON of @gateforge/core (pin #1).
 *
 * Payload validation is schema-generated: every payload type below has a
 * zod schema and is validated on receive; any failure is `E_SCHEMA` with a
 * single-cause path/message diagnostic. The result payload matches the
 * frozen @gateforge/core `Resource` and `UnresolvedReason` shapes.
 */
import { z } from 'zod';
import { LocationSchema, ResourceSchema, UnresolvedReasonSchema } from '@gateforge/core';

/** The GPP version this package speaks. Handshakes pin this value. */
export const PROTOCOL_VERSION = 2;

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
] as const;

/** Union of catalog message types. */
export type MessageType = (typeof MESSAGE_TYPES)[number];

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

/** Inferred finding shape. */
export type Finding = z.infer<typeof FindingSchema>;

/** The complete discovery output a plugin returns for one request. */
export interface DiscoveryOutcome {
  resources: z.infer<typeof ResourceSchema>[];
  unresolved: z.infer<typeof UnresolvedReasonSchema>[];
  findings: Finding[];
}

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
    /** Discovered resources (@gateforge/core Resource shape). */
    resources: z.array(ResourceSchema),
    /** Reasons discovery could not proceed for parts of the input. */
    unresolved: z.array(UnresolvedReasonSchema),
    /** Non-resource observations (duplicates, ambiguities). */
    findings: z.array(FindingSchema),
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
export const PAYLOAD_SCHEMAS: Record<MessageType, z.ZodType> = {
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
export function firstIssueText(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return 'unknown validation failure';
  const path = issue.path.map(String).join('.');
  return path.length > 0 ? `${path}: ${issue.message}` : issue.message;
}
