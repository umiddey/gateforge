/**
 * Entity-adapter schema (pack deliverable: "entity-adapter schema doc").
 *
 * The evidence-witness contract (interface pin #8, ADR 0002): an
 * adapter is a reviewed, engine-side module whose default export
 * executes GET-only reads against the target resource. The witness
 * service loads `.gateforge/adapters/<resourceId>.mjs` and calls
 * `read(ctx, id)` when a test asks for persistence evidence; the raw
 * adapter response is never returned to the test process — only the
 * `verdictRelevant` projection is.
 *
 * Adapter responsibilities (mirrored by {@link EntityAdapterSchema} and
 * enforced by {@link validateEntityAdapter}):
 * - `resourceId` — the resource this adapter proves; must match the
 *   file name (`<resourceId>.mjs`) so the registry binds by filename.
 * - `read(ctx, id)` — GET-only fetch of one entity; returns the raw
 *   response body. Implementations MUST NOT mutate anything.
 * - `normalize(body)` — project the raw body onto the evidence shape
 *   `{ entityId, fields }` where `fields` carry the classified
 *   `primaryKey` columns.
 * - `deletion: 'hard' | 'archive'` — how removal manifests (archive =
 *   soft delete: the row keeps existing retrievable).
 * - `environmentFingerprint` — the target-environment marker (e.g. the
 *   value of a response header the witness compares on a probe GET);
 *   a fingerprint mismatch rejects the record (GF-13).
 */
import { z } from 'zod';
/** The evidence shape `normalize` must return. */
export interface NormalizedEntity {
    /** The entity id, extracted from the raw body (column-keyed). */
    entityId: string;
    /** Projected fields the obligation's `expectFields` can match. */
    fields: Record<string, unknown>;
}
/** Context handed to `read` by the witness service. */
export interface EntityAdapterContext {
    /** Base URL of the target environment (loopback, trusted). */
    baseUrl: string;
    /** Per-request headers (e.g. the run token for authenticity). */
    headers?: Record<string, string>;
}
/** The frozen adapter module contract (pin #8). */
export interface EntityAdapter {
    resourceId: string;
    read(ctx: EntityAdapterContext, id: string): Promise<unknown>;
    normalize(body: unknown): NormalizedEntity;
    deletion: 'hard' | 'archive';
    environmentFingerprint: string;
}
/**
 * Zod schema for the data fields of an adapter module (functions are
 * checked by {@link validateEntityAdapter} for a single-cause diagnostic
 * list; zod function schemas would blur the message).
 */
export declare const EntityAdapterSchema: z.ZodObject<{
    resourceId: z.ZodString;
    deletion: z.ZodEnum<{
        hard: "hard";
        archive: "archive";
    }>;
    environmentFingerprint: z.ZodString;
    read: z.ZodUnknown;
    normalize: z.ZodUnknown;
}, z.core.$strict>;
/** Outcome of {@link validateEntityAdapter}. */
export type EntityAdapterValidation = {
    ok: true;
    adapter: EntityAdapter;
} | {
    ok: false;
    issues: string[];
};
/**
 * Validates an adapter module against the frozen contract, failing
 * closed with one issue per violated field.
 *
 * Args:
 *   value: The default export of an `.mjs` adapter module.
 *
 * Returns:
 *   EntityAdapterValidation: The typed adapter, or every issue found.
 */
export declare function validateEntityAdapter(value: unknown): EntityAdapterValidation;
//# sourceMappingURL=adapter-schema.d.ts.map