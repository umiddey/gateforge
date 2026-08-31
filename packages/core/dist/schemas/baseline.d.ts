/**
 * Baseline schema (pin #3): `.gateforge/baselines/obligations.json`.
 * Baselines store obligation fingerprints (pin #2) and may only ever
 * SHRINK to a strict subset (invariant 4) — the update command enforces
 * that; this schema enforces the on-disk shape and ordering.
 */
import { z } from 'zod';
/** A single obligation fingerprint: 64-char lowercase sha256 hex. */
export declare const FingerprintHexSchema: z.ZodString;
/** Inferred fingerprint-hex shape. */
export type FingerprintHex = z.infer<typeof FingerprintHexSchema>;
/** The baseline document: known-forgiven obligation fingerprints. */
export declare const BaselineSchema: z.ZodObject<{
    schemaVersion: z.ZodLiteral<1>;
    fingerprints: z.ZodArray<z.ZodString>;
}, z.core.$strict>;
/** Inferred baseline-document shape. */
export type Baseline = z.infer<typeof BaselineSchema>;
//# sourceMappingURL=baseline.d.ts.map