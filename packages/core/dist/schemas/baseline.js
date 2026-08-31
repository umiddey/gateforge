/**
 * Baseline schema (pin #3): `.gateforge/baselines/obligations.json`.
 * Baselines store obligation fingerprints (pin #2) and may only ever
 * SHRINK to a strict subset (invariant 4) — the update command enforces
 * that; this schema enforces the on-disk shape and ordering.
 */
import { z } from 'zod';
import { SchemaVersionField } from './common.js';
/** A single obligation fingerprint: 64-char lowercase sha256 hex. */
export const FingerprintHexSchema = z
    .string()
    .regex(/^[0-9a-f]{64}$/, 'fingerprint must be a 64-char lowercase sha256 hex');
/** The baseline document: known-forgiven obligation fingerprints. */
export const BaselineSchema = z
    .object({
    schemaVersion: SchemaVersionField,
    /** Sorted, duplicate-free fingerprint list. */
    fingerprints: z.array(FingerprintHexSchema),
})
    .strict()
    .superRefine((baseline, ctx) => {
    const sorted = [...baseline.fingerprints].sort();
    for (let index = 0; index < baseline.fingerprints.length; index += 1) {
        const current = baseline.fingerprints[index];
        const expected = sorted[index];
        if (current !== expected) {
            ctx.addIssue({
                code: 'custom',
                path: ['fingerprints', index],
                message: "fingerprints must be sorted; expected '" + expected +
                    "' at index " + index + ", got '" + current + "'",
            });
            break;
        }
        if (index > 0 && current === baseline.fingerprints[index - 1]) {
            ctx.addIssue({
                code: 'custom',
                path: ['fingerprints', index],
                message: `duplicate fingerprint '${current}'`,
            });
            break;
        }
    }
});
//# sourceMappingURL=baseline.js.map