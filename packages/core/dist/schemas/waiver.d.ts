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
/** Exact-scope reference: one fingerprint of one resource/contract pair. */
export declare const WaiverScopeSchema: z.ZodObject<{
    kind: z.ZodLiteral<"exact">;
    resourceId: z.ZodString;
    fingerprint: z.ZodString;
}, z.core.$strict>;
/** Inferred waiver-scope shape. */
export type WaiverScope = z.infer<typeof WaiverScopeSchema>;
/** A fully-specified waiver. */
export declare const WaiverSchema: z.ZodObject<{
    schemaVersion: z.ZodLiteral<1>;
    owner: z.ZodString;
    justificationUrl: z.ZodURL;
    approver: z.ZodString;
    scope: z.ZodObject<{
        kind: z.ZodLiteral<"exact">;
        resourceId: z.ZodString;
        fingerprint: z.ZodString;
    }, z.core.$strict>;
    expiresAt: z.ZodISODateTime;
}, z.core.$strict>;
/** Inferred waiver shape. */
export type Waiver = z.infer<typeof WaiverSchema>;
//# sourceMappingURL=waiver.d.ts.map