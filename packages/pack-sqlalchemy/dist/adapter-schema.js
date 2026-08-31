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
/**
 * Zod schema for the data fields of an adapter module (functions are
 * checked by {@link validateEntityAdapter} for a single-cause diagnostic
 * list; zod function schemas would blur the message).
 */
export const EntityAdapterSchema = z
    .object({
    resourceId: z.string().min(1),
    deletion: z.enum(['hard', 'archive']),
    environmentFingerprint: z.string().min(1),
    read: z.unknown(),
    normalize: z.unknown(),
})
    .strict();
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
export function validateEntityAdapter(value) {
    const parsed = EntityAdapterSchema.safeParse(value);
    if (!parsed.success) {
        return { ok: false, issues: parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`) };
    }
    const candidate = value;
    const issues = [];
    if (typeof candidate.read !== 'function')
        issues.push('read: must be a function (ctx, id) => Promise<unknown>');
    if (typeof candidate.normalize !== 'function')
        issues.push('normalize: must be a function (body) => { entityId, fields }');
    if (issues.length > 0)
        return { ok: false, issues };
    return { ok: true, adapter: value };
}
//# sourceMappingURL=adapter-schema.js.map