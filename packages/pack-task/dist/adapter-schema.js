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
 * Adapter responsibilities (mirrored by {@link TaskAuditAdapterSchema}
 * and enforced by {@link validateTaskAuditAdapter}):
 * - `resourceId` — the resource this adapter proves; must match the
 *   file name (`<resourceId>.mjs`) so the registry binds by filename.
 * - `read(ctx, id)` — GET-only fetch of one audit trail entry; returns
 *   the raw audit row from `runs.json`.
 * - `normalize(body)` — project the raw audit row onto the evidence
 *   shape `{ entityId, fields }` where `fields` carry the contract
 *   verdicts (retry count, side-effect count, terminal flag, run id).
 * - `deletion: 'hard' | 'archive'` — how removal manifests (audit
 *   trails archive by default: rows keep existing retrievable).
 * - `environmentFingerprint` — header value to check (the example
 *   server answers `x-gateforge-env: task-loopback-v1`).
 */
import { z } from 'zod';
/**
 * Zod schema for the data fields of an adapter module (functions are
 * checked by {@link validateTaskAuditAdapter} for a single-cause
 * diagnostic list; zod function schemas would blur the message).
 */
export const TaskAuditAdapterSchema = z
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
 *   TaskAuditAdapterValidation: The typed adapter, or every issue found.
 */
export function validateTaskAuditAdapter(value) {
    const parsed = TaskAuditAdapterSchema.safeParse(value);
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