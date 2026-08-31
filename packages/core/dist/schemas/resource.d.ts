/**
 * Resource schema (plan §4.2): a stable, code-derived object that may
 * carry obligations. Produced by detectors, keyed by a stable resource id.
 */
import { z } from 'zod';
/**
 * A discovered resource. `attributes` is detector-defined payload data
 * (e.g. table name, framework style) and is deliberately open — detectors
 * own their attribute vocabulary. Identity, kind, and provenance are not.
 */
export declare const ResourceSchema: z.ZodObject<{
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
}, z.core.$strict>;
/** Inferred resource shape. */
export type Resource = z.infer<typeof ResourceSchema>;
//# sourceMappingURL=resource.d.ts.map