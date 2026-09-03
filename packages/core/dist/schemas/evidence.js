/**
 * EvidenceRecord schema (plan §4.7, pins #7/#11): typed records issued
 * by the witness service. This is the only evidence shape the verifier
 * trusts; test-side assertions never appear here.
 *
 * ADR 0001 / GF-23 encoded here: every record carries a service-issued
 * `recordId` and the `runId` of its run manifest. Records whose trust
 * tier is `claimed` (no service-issued provenance) can never produce a
 * `satisfied` verdict — the verdict engine enforces that.
 */
import { z } from 'zod';
import { SchemaVersionField, TrustTierSchema } from './common.js';
import { ObligationIdSchema } from './claim.js';
/**
 * Optional bulk scope (pin #11): a single record may stand for `count`
 * homogeneous items. Obligations themselves stay per-resource; bulk
 * scope only widens what one record attests.
 */
export const BulkScopeSchema = z
    .object({
    kind: z.literal('bulk'),
    /** Number of items this record attests to (positive). */
    count: z.number().int().min(1),
})
    .strict();
/**
 * Where a record's contents came from (part of the hashed identity,
 * pin #7). `suite-submitted` records carry the TESTED SUITE's own
 * assertion — the witness received it but cannot verify it happened —
 * and are stamped `trust: 'claimed'` at issuance. `engine-observed`
 * records carry contents the witness itself produced from an
 * engine-side observation (the adapter read behind
 * `persistence.entity`) and are stamped `trust: 'witnessed'`.
 */
export const RecordOriginSchema = z.enum(['suite-submitted', 'engine-observed']);
/**
 * A trusted evidence record issued by the witness service.
 */
export const EvidenceRecordSchema = z
    .object({
    schemaVersion: SchemaVersionField,
    /** Service-issued record id (sha256 hex of its canonical identity). */
    recordId: z.string().regex(/^[0-9a-f]{64}$/, 'recordId must be a 64-char lowercase sha256 hex'),
    /** Run manifest this record belongs to. */
    runId: z.uuid(),
    /** Trust tier: `witnessed` records were collected engine-side. */
    trust: TrustTierSchema,
    /** Obligation the evidence relates to. */
    obligationId: ObligationIdSchema,
    /** Evidence primitive kind, e.g. `ui.action`, `persistence.entity`. */
    kind: z.string().min(1),
    /** Test that produced the claim this evidence supports, when known. */
    testId: z.string().min(1).optional(),
    /** Evidence payload (primitive-defined, open JSON). */
    payload: z.unknown().optional(),
    /** Where the contents came from (drives the trust stamp at issuance). */
    origin: RecordOriginSchema.optional(),
    /** Bulk attestation scope, when this record covers multiple items. */
    scope: BulkScopeSchema.optional(),
    /** Issue timestamp from the engine-injected clock (ISO-8601). */
    issuedAt: z.iso.datetime().optional(),
})
    .strict();
//# sourceMappingURL=evidence.js.map