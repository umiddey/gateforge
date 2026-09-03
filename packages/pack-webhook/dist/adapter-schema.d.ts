/**
 * Entity-adapter schema (pack deliverable: "entity-adapter schema doc").
 *
 * Mirrors `@gateforge/pack-sqlalchemy`'s adapter contract, scoped to
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
/** The frozen adapter module contract. */
export interface WebhookEntityAdapter {
    resourceId: string;
    read(ctx: EntityAdapterContext, id: string): Promise<unknown>;
    normalize(body: unknown): NormalizedEntity;
    deletion: 'hard' | 'archive';
    environmentFingerprint: string;
}
/**
 * Zod schema for the data fields of an adapter module (functions are
 * checked by {@link validateWebhookEntityAdapter} for a single-cause
 * diagnostic list; zod function schemas would blur the message).
 */
export declare const WebhookEntityAdapterSchema: z.ZodObject<{
    resourceId: z.ZodString;
    deletion: z.ZodEnum<{
        hard: "hard";
        archive: "archive";
    }>;
    environmentFingerprint: z.ZodString;
    read: z.ZodUnknown;
    normalize: z.ZodUnknown;
}, z.core.$strict>;
/** Outcome of {@link validateWebhookEntityAdapter}. */
export type WebhookEntityAdapterValidation = {
    ok: true;
    adapter: WebhookEntityAdapter;
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
 *   WebhookEntityAdapterValidation: The typed adapter, or every issue found.
 */
export declare function validateWebhookEntityAdapter(value: unknown): WebhookEntityAdapterValidation;
//# sourceMappingURL=adapter-schema.d.ts.map