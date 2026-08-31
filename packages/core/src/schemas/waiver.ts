/**
 * Waiver schema (ADR 0001): a time-bounded, justified exception to one
 * exact obligation identity. ALL FIVE mandatory fields are required —
 * a waiver missing any of them is a configuration error, never a
 * partially-applied exception.
 *
 * The five fields: `owner`, `justificationUrl`, `approver`,
 * `scope` (exact `resourceId` + `fingerprint` pair), `expiresAt`.
 * Expired waivers do NOT produce `waived` — they produce `invalid`
 * (verdict engine, pin #9).
 */
import { z } from 'zod';
import { SchemaVersionField } from './common.js';

/** Exact-scope reference: one fingerprint of one resource/contract pair. */
export const WaiverScopeSchema = z
  .object({
    kind: z.literal('exact'),
    /** Resource whose obligation is waived. */
    resourceId: z.string().min(1),
    /** Exact obligation fingerprint (pin #2) being waived. */
    fingerprint: z
      .string()
      .regex(/^[0-9a-f]{64}$/, 'fingerprint must be a 64-char lowercase sha256 hex'),
  })
  .strict();

/** Inferred waiver-scope shape. */
export type WaiverScope = z.infer<typeof WaiverScopeSchema>;

/** A fully-specified waiver. */
export const WaiverSchema = z
  .object({
    schemaVersion: SchemaVersionField,
    /** Person/team accountable for the waived obligation. */
    owner: z.string().min(1),
    /** Link to the written justification (ticket, ADR, review). */
    justificationUrl: z.url(),
    /** Named approver who accepted the risk. */
    approver: z.string().min(1),
    /** Exact obligation identity being waived. */
    scope: WaiverScopeSchema,
    /** Expiry instant (ISO-8601); after this the obligation is `invalid`. */
    expiresAt: z.iso.datetime(),
  })
  .strict();

/** Inferred waiver shape. */
export type Waiver = z.infer<typeof WaiverSchema>;
