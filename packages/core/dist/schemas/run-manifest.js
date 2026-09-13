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
/**
 * V2 evidence attestation envelope (plan §11.3): the witness's signed
 * statement of its run context and issued record set. `attestationVersion`
 * is an explicit literal — never a reinterpreted legacy field — so an old
 * `{runId, recordIds}` MAC cannot authorize evidence even when it
 * verifies under its own format.
 */
export const AttestationSchema = z
    .object({
    /** Envelope version; only `2` is produced or honored. */
    attestationVersion: z.literal(2),
    /** Witness run UUID this envelope attests. */
    runId: z.uuid(),
    /** Fresh invocation UUID minted by the trusted test-gates caller. */
    invocationId: z.uuid(),
    /** 64-char lowercase hex digest of the canonical input snapshot. */
    inputDigest: z.string().regex(/^[0-9a-f]{64}$/, 'inputDigest must be 64-char lowercase hex'),
    /** Issued record ids, sorted codepoint-wise and unique. */
    recordIds: z
        .array(z.string().regex(/^[0-9a-f]{64}$/, 'recordId must be 64-char lowercase hex'))
        .superRefine((ids, ctx) => {
        for (let index = 1; index < ids.length; index += 1) {
            const previous = ids[index - 1];
            const current = ids[index];
            if (previous >= current) {
                ctx.addIssue({
                    code: 'custom',
                    message: 'recordIds must be sorted codepoint-wise and unique',
                });
                return;
            }
        }
    }),
    /** HMAC-SHA256 over the v2 body with domain `gateforge.ledger.v2`. */
    mac: z.string().regex(/^[0-9a-f]{64}$/, 'mac must be a 64-char lowercase hex HMAC'),
})
    .strict();
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
     * as easily as it can fabricate records. It is trusted only through
     * the v2 `attestation` envelope below (plan §11.3); this bare list
     * never authorizes evidence.
     */
    recordIds: z.array(z.string().regex(/^[0-9a-f]{64}$/, 'recordId must be 64-char lowercase hex')).optional(),
    /**
     * LEGACY v1 HMAC-SHA256 (verifier-key keyed) over the canonical
     * `{runId, recordIds}`. Readable for diagnostics only: it NEVER
     * authorizes evidence (plan §11.3/§11.6). A verifying v1 MAC over a
     * matching id set still demotes every witnessed record — only the
     * v2 `attestation` envelope can authorize. New writers must not
     * emit this field.
     */
    recordIdsMac: z
        .string()
        .regex(/^[0-9a-f]{64}$/, 'recordIdsMac must be a 64-char lowercase hex HMAC')
        .optional(),
    /**
     * Fresh invocation UUID minted by the trusted test-gates caller for
     * this run (plan §11.4). Stored publicly; its authenticity is
     * established only by the v2 `attestation` MAC covering it. A new
     * suite invocation mints a new value, so a previous invocation's
     * records cannot satisfy the new run.
     */
    invocationId: z.uuid().optional(),
    /**
     * 64-char lowercase hex digest of the canonical input snapshot
     * (plan §11.2) computed for this run's tested inputs. Stored
     * publicly; authenticity comes from the v2 `attestation` MAC.
     */
    inputDigest: z
        .string()
        .regex(/^[0-9a-f]{64}$/, 'inputDigest must be 64-char lowercase hex')
        .optional(),
    /**
     * The v2 evidence attestation envelope (plan §11.3), written by the
     * witness at shutdown from its frozen bound context plus the ids it
     * actually issued — never by reading suite-writable state. The live
     * `GET /ledger-attestation` endpoint serves the same signed object.
     * Absent (or invalid) means no evidence authorizes: evaluation fails
     * closed for witnessed records.
     */
    attestation: AttestationSchema.optional(),
})
    .strict();
//# sourceMappingURL=run-manifest.js.map