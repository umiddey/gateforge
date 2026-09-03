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
/** The evidence shape `normalize` must return. */
export interface NormalizedAuditEntity {
    /** The audit entry id, extracted from the raw body. */
    entityId: string;
    /** Projected fields the obligation's `expectFields` can match. */
    fields: Record<string, unknown>;
}
/** Context handed to `read` by the witness service. */
export interface TaskAuditAdapterContext {
    /** Base URL of the target environment (loopback, trusted). */
    baseUrl: string;
    /** Per-request headers (e.g. the run token for authenticity). */
    headers?: Record<string, string>;
}
/** The frozen adapter module contract (pin #8). */
export interface TaskAuditAdapter {
    resourceId: string;
    read(ctx: TaskAuditAdapterContext, id: string): Promise<unknown>;
    normalize(body: unknown): NormalizedAuditEntity;
    deletion: 'hard' | 'archive';
    environmentFingerprint: string;
}
/**
 * Zod schema for the data fields of an adapter module (functions are
 * checked by {@link validateTaskAuditAdapter} for a single-cause
 * diagnostic list; zod function schemas would blur the message).
 */
export declare const TaskAuditAdapterSchema: z.ZodObject<{
    resourceId: z.ZodString;
    deletion: z.ZodEnum<{
        hard: "hard";
        archive: "archive";
    }>;
    environmentFingerprint: z.ZodString;
    read: z.ZodUnknown;
    normalize: z.ZodUnknown;
}, z.core.$strict>;
/** Outcome of {@link validateTaskAuditAdapter}. */
export type TaskAuditAdapterValidation = {
    ok: true;
    adapter: TaskAuditAdapter;
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
 *   TaskAuditAdapterValidation: The typed adapter, or every issue found.
 */
export declare function validateTaskAuditAdapter(value: unknown): TaskAuditAdapterValidation;
//# sourceMappingURL=adapter-schema.d.ts.map