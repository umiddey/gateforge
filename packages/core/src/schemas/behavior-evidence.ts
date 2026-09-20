/**
 * behavior.case observation schemas (plan 2026-09-19 §4.6, §15.3).
 *
 * Pure data contracts for the engine-issued case proof record. Phase 1
 * ships the schema only — there is no issuer and no fake producer. A
 * suite-posted object shaped like this remains suite-submitted and
 * never satisfies the strong HTTP contracts.
 */
import { z } from 'zod';
import { FingerprintHexSchema } from './baseline.js';
import { JsonSchema } from './behavior-policy.js';

/** Evidence kind issued for a complete behavior case. */
export const BEHAVIOR_CASE_KIND = 'behavior.case';

/** Payload version for behavior.case records. */
export const BEHAVIOR_CASE_PAYLOAD_VERSION = 1;

/** Scalar or composite entity identity, matching existing core behavior. */
export const EntityIdSchema = z.union([
  z.string().min(1),
  z.number().int(),
  z.record(z.string(), z.union([z.string(), z.number().int(), z.boolean()])),
]);

/** Inferred entity-id shape. */
export type EntityId = z.infer<typeof EntityIdSchema>;

/** One entity projection inside a trusted scope snapshot. */
export const ScopeEntitySchema = z
  .object({
    entityId: EntityIdSchema,
    fields: z.record(z.string(), JsonSchema),
  })
  .strict();

/** Inferred scope-entity shape. */
export type ScopeEntity = z.infer<typeof ScopeEntitySchema>;

/**
 * Strict snapshot of one declared effect scope. complete:false,
 * omitted declared fields, unknown identity, inconsistent checkpoints,
 * or truncation cannot satisfy a strong contract.
 */
export const ScopeSnapshotSchema = z
  .object({
    scope: z.string().min(1),
    fixtureNamespace: z.string().min(1),
    complete: z.boolean(),
    checkpoint: z.string().min(1),
    entities: z.array(ScopeEntitySchema),
  })
  .strict();

/** Inferred scope-snapshot shape. */
export type ScopeSnapshot = z.infer<typeof ScopeSnapshotSchema>;

/** Witness-side case lifecycle. Each transition requires the previous. */
export const BEHAVIOR_CASE_STATES = [
  'registered',
  'fixture-prepared',
  'before-snapshot-complete',
  'principal-executing',
  'request-captured',
  'barrier-reached',
  'after-snapshot-complete',
  'sealed',
] as const;

/** Inferred lifecycle state. */
export type BehaviorCaseState = (typeof BEHAVIOR_CASE_STATES)[number];

/** One captured request attempt inside a case. */
export const BehaviorAttemptSchema = z
  .object({
    engineRequestId: z.string().min(1),
    method: z.string().min(1),
    path: z.string().min(1),
    endpointResourceId: z.string().min(1).nullable(),
    actorRef: z.string().min(1),
    requestDigest: FingerprintHexSchema,
    status: z.number().int().min(100).max(599).nullable(),
    responseDigest: FingerprintHexSchema.nullable(),
  })
  .strict();

/** Inferred attempt shape. */
export type BehaviorAttempt = z.infer<typeof BehaviorAttemptSchema>;

/**
 * Actual observed request/response values sealed by the witness (Phase 5).
 * Digests in {@link BehaviorAttemptSchema} bind identity; these values
 * are what the semantic grader evaluates response rules and
 * request-derived expectations against. Bounded at capture (over-limit
 * inputs block instead of hashing a misleading prefix).
 */
export const BehaviorRequestObservationSchema = z
  .object({
    /** Joins the observation to its attempt. */
    engineRequestId: z.string().min(1),
    /** Observed HTTP method (uppercase). */
    method: z.string().min(1),
    /** Observed concrete path (no template variables). */
    path: z.string().min(1),
    /** Observed decoded query map. */
    query: z.record(z.string(), JsonSchema),
    /** Observed submitted body (parsed JSON, or raw text when not JSON). */
    body: JsonSchema,
    /** Observed response status (null when no response exists). */
    status: z.number().int().min(100).max(599).nullable(),
    /** Observed response body (parsed JSON, or raw text when not JSON). */
    responseBody: JsonSchema,
  })
  .strict();

/** Inferred request-observation shape. */
export type BehaviorRequestObservation = z.infer<typeof BehaviorRequestObservationSchema>;

/** Trusted actor metadata — never credential bytes. */
export const BehaviorActorObservationSchema = z
  .object({
    principalId: z.string().min(1),
    tenantId: z.string().min(1).nullable(),
    roles: z.array(z.string().min(1)),
  })
  .strict();

/** Inferred actor observation. */
export type BehaviorActorObservation = z.infer<typeof BehaviorActorObservationSchema>;

/**
 * Signed behavior.case payload. Outer EvidenceRecordSchema still binds
 * run/test/obligation identity and origin; this is the inner payload.
 */
export const BehaviorCasePayloadSchema = z
  .object({
    payloadVersion: z.literal(BEHAVIOR_CASE_PAYLOAD_VERSION),
    caseId: FingerprintHexSchema,
    caseSpecDigest: FingerprintHexSchema,
    obligationIds: z.array(z.string().min(1)).min(1),
    endpointResourceId: z.string().min(1).nullable(),
    operationId: z.string().min(1),
    sessionId: z.string().min(1),
    executionId: z.string().min(1),
    fixtureNamespace: z.string().min(1),
    actor: BehaviorActorObservationSchema,
    actionDigest: FingerprintHexSchema,
    submittedValues: JsonSchema,
    attempts: z.array(BehaviorAttemptSchema),
    /**
     * Actual observed request/response values (Phase 5): what response
     * rules and request-derived expectations grade against. Empty for
     * surface-driven cases (Phase 6 seals browser observations instead).
     */
    requestObservations: z.array(BehaviorRequestObservationSchema),
    /**
     * Engine-browser observation (Phase 6): the URL, engine-observed
     * entity id, and engine-read visible fields for surface-driven
     * cases. Absent for request-driven cases.
     */
    browserObservation: z
      .object({
        url: z.string().min(1),
        entityId: z.string().min(1),
        visibleFields: z.record(z.string(), JsonSchema),
      })
      .strict()
      .optional(),
    /**
     * Sealed fixture values (Phase 5): authoritative generated subject
     * identities the witness resolved fixture keys against. Identity
     * data, never credential bytes.
     */
    fixtureValues: JsonSchema,
    before: z.array(ScopeSnapshotSchema),
    after: z.array(ScopeSnapshotSchema),
    completion: z
      .object({
        complete: z.boolean(),
        checkpoint: z.string().min(1),
      })
      .strict(),
    channel: z.enum(['engine-browser', 'engine-http', 'engine-task']),
    authorityProfileDigest: FingerprintHexSchema,
    state: z.enum(BEHAVIOR_CASE_STATES),
  })
  .strict();

/** Inferred behavior.case payload. */
export type BehaviorCasePayload = z.infer<typeof BehaviorCasePayloadSchema>;
