/**
 * Resource schema (plan §4.2): a stable, code-derived object that may
 * carry obligations. Produced by detectors, keyed by a stable resource id.
 */
import { z } from 'zod';
import { LocationSchema, SchemaVersionField } from './common.js';
/**
 * A discovered resource. `attributes` is detector-defined payload data
 * (e.g. table name, framework style) and is deliberately open — detectors
 * own their attribute vocabulary. Identity, kind, and provenance are not.
 */
export const ResourceSchema = z
    .object({
    schemaVersion: SchemaVersionField,
    /** Stable resource id, e.g. `tenant.accounts`. */
    id: z.string().min(1),
    /** Detector framework kind, e.g. `sqlalchemy.table`. */
    kind: z.string().min(1),
    /** Repo-root-relative path of the file the resource was found in. */
    source: z.string().min(1),
    /** Exact source location of the declaration. */
    location: LocationSchema,
    /** Version of the detector that produced this resource. */
    detectorVersion: z.string().min(1),
    /** Detector-specific discovered attributes (open payload). */
    attributes: z.record(z.string(), z.unknown()),
})
    .strict();
//# sourceMappingURL=resource.js.map