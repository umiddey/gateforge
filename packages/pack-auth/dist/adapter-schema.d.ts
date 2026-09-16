/**
 * Entity-adapter schema for the auth pack.
 *
 * The auth pack follows the same adapter contract as
 * `@gate-forge/pack-sqlalchemy` (interface pin #8): adapters are reviewed
 * engine-side modules whose default export executes GET-only reads
 * against the target resource. The witness service loads
 * `.gateforge/adapters/<resourceId>.mjs` and calls `read(ctx, id)` when
 * a test asks for persistence evidence; the raw adapter response is
 * never returned to the test process — only the `verdictRelevant`
 * projection is.
 *
 * Why the auth pack needs an adapter at all: `auth:denied-no-side-effect`
 * is proven by issuing the denied request, then reading the target
 * entity via this adapter and comparing fields. The adapter gives the
 * engine a trusted, GET-only read against a real production-shape
 * surface — never the test process's view of state.
 *
 * The pack exports `AuthEntityAdapterSchema` + `validateAuthEntityAdapter`
 * for fail-closed validation of an adapter module's default export.
 *
 * The pack's example adapter targets `example.billing.refund`: a single
 * resource id bound to the auth example server's billing record.
 */
import { z } from 'zod';
/** The evidence shape `normalize` must return. */
export interface NormalizedAuthEntity {
    /** The entity id (column-keyed from the raw body). */
    entityId: string;
    /** Projected fields the obligation's `expectFields` can match. */
    fields: Record<string, unknown>;
}
/** Context handed to `read` by the witness service. */
export interface AuthAdapterContext {
    /** Base URL of the target environment (loopback, trusted). */
    baseUrl: string;
    /** Per-request headers (e.g. the run token for authenticity). */
    headers?: Record<string, string>;
}
/** The frozen adapter module contract (pin #8, mirrored). */
export interface AuthEntityAdapter {
    resourceId: string;
    read(ctx: AuthAdapterContext, id: string): Promise<unknown>;
    normalize(body: unknown): NormalizedAuthEntity;
    deletion: 'hard' | 'archive';
    environmentFingerprint: string;
}
/**
 * Zod schema for the data fields of an adapter module (functions are
 * checked by {@link validateAuthEntityAdapter} for a single-cause
 * diagnostic list; zod function schemas would blur the message).
 */
export declare const AuthEntityAdapterSchema: z.ZodObject<{
    resourceId: z.ZodString;
    deletion: z.ZodEnum<{
        hard: "hard";
        archive: "archive";
    }>;
    environmentFingerprint: z.ZodString;
    read: z.ZodUnknown;
    normalize: z.ZodUnknown;
}, z.core.$strict>;
/** Outcome of {@link validateAuthEntityAdapter}. */
export type AuthEntityAdapterValidation = {
    ok: true;
    adapter: AuthEntityAdapter;
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
 *   AuthEntityAdapterValidation: The typed adapter, or every issue found.
 */
export declare function validateAuthEntityAdapter(value: unknown): AuthEntityAdapterValidation;
//# sourceMappingURL=adapter-schema.d.ts.map