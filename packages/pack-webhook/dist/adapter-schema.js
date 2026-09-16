/**
 * Entity-adapter schema (pack deliverable: "entity-adapter schema doc").
 *
 * Mirrors `@gate-forge/pack-sqlalchemy`'s adapter contract, scoped to
 * the webhook pack's delivery-log resources. The witness service loads
 * `.gateforge/adapters/<resourceId>.mjs` and calls `read(ctx, id)`
 * when a test asks for persistence evidence (the
 * `webhook:replay-idempotent` and `webhook:retry-bounded` contracts
 * both need to read the in-memory delivery log to assert
 * "exactly one side effect" and "bounded retry count").
 *
 * Adapter responsibilities (mirrored by {@link WebhookEntityAdapterSchema}
 * and enforced by {@link validateWebhookEntityAdapter}):
 *
 * - `resourceId` — the resource this adapter proves; must match the
 *   file name (`<resourceId>.mjs`) so the registry binds by filename.
 * - `read(ctx, id)` — GET-only fetch of one delivery record; returns
 *   the raw response body. Implementations MUST NOT mutate anything.
 * - `normalize(body)` — project the raw body onto the evidence shape
 *   `{ entityId, fields }` where `fields` carry the classified primary
 *   key columns (`event_id`, `attempt`).
 * - `deletion: 'hard' | 'archive'` — how removal manifests. Delivery
 *   records are append-only; archive semantics ("the row keeps
 *   existing retrievable") is the right mode for an audit log.
 * - `environmentFingerprint` — the target-environment marker (e.g.
 *   the value of a response header the witness compares on a probe
 *   GET). The example webhook server emits
 *   `x-gateforge-env: example-webhook-v1`.
 */
import { z } from 'zod';
/**
 * Zod schema for the data fields of an adapter module (functions are
 * checked by {@link validateWebhookEntityAdapter} for a single-cause
 * diagnostic list; zod function schemas would blur the message).
 */
export const WebhookEntityAdapterSchema = z
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
 *   WebhookEntityAdapterValidation: The typed adapter, or every issue found.
 */
export function validateWebhookEntityAdapter(value) {
    const parsed = WebhookEntityAdapterSchema.safeParse(value);
    if (!parsed.success) {
        return {
            ok: false,
            issues: parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
        };
    }
    const candidate = value;
    const issues = [];
    if (typeof candidate.read !== 'function') {
        issues.push('read: must be a function (ctx, id) => Promise<unknown>');
    }
    if (typeof candidate.normalize !== 'function') {
        issues.push('normalize: must be a function (body) => { entityId, fields }');
    }
    if (issues.length > 0)
        return { ok: false, issues };
    return { ok: true, adapter: value };
}
//# sourceMappingURL=adapter-schema.js.map