/**
 * RunManifest schema (pin #4): identity of a single gateforge run. Every
 * verdict and every witnessed evidence record references its run.
 *
 * `startedAt` comes from the injected clock (deterministic tests), never
 * the wall clock. At shutdown the witness service appends the record ids
 * it issued to the manifest (pin #7).
 */
import { z } from 'zod';
import { SchemaVersionField } from './common.js';
import { PluginRegistrationSchema } from './plugin.js';
/** Which changed-file provider backs the run (pin #5 of architecture contracts). */
export const ChangedProviderSchema = z.enum([
    'local-staged',
    'github-pr',
    'gitlab-mr',
    'all-files',
]);
/** The run manifest artifact. */
export const RunManifestSchema = z
    .object({
    schemaVersion: SchemaVersionField,
    /** UUIDv4 identifying this run. */
    runId: z.uuid(),
    /** Run start instant, ISO-8601, from the injected clock. */
    startedAt: z.iso.datetime(),
    /** HEAD git sha of the repo under test, or null when unavailable. */
    gitSha: z.string().regex(/^[0-9a-f]{40}$/, 'gitSha must be a 40-char lowercase sha1 hex').nullable(),
    /** Changed-file provider backing this run. */
    provider: ChangedProviderSchema,
    /** Plugin set with pinned versions (handshake identity, pin #5). */
    plugins: z.array(PluginRegistrationSchema),
    /** Disposable-environment attestation scope, or null when unset. */
    attestationScope: z.string().nullable(),
    /**
     * Record ids the witness issued this run (pin #7), appended at
     * witness shutdown. Optional: the CLI writes the manifest without it
     * before the suite runs; an unappended manifest (witness never
     * finished) is still schema-valid but proves no issuance.
     *
     * TRUST: this list lives in the suite-writable state directory, so
     * on its own it proves nothing — a hostile suite can write ids here
     * as easily as it can fabricate records. It is trusted only when
     * `recordIdsMac` verifies under the witness verifier key (a secret
     * the suite never receives).
     */
    recordIds: z.array(z.string().regex(/^[0-9a-f]{64}$/, 'recordId must be 64-char lowercase hex')).optional(),
    /**
     * HMAC-SHA256 (verifier-key keyed) over the canonical
     * `{runId, recordIds}` — the witness's authentication of the
     * appended set. Verified by the CLI provenance gate; presence of
     * `recordIds` without a verifying MAC is untrusted (fail closed).
     */
    recordIdsMac: z
        .string()
        .regex(/^[0-9a-f]{64}$/, 'recordIdsMac must be a 64-char lowercase hex HMAC')
        .optional(),
})
    .strict();
//# sourceMappingURL=run-manifest.js.map