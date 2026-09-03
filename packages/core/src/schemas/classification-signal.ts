/**
 * Classification-signal schemas (ADR 0003 D1): the framework-neutral
 * evidence contract detectors emit so core can classify resources
 * automatically. A signal is a FACT — source-located, detector-versioned,
 * basis-typed — never a classification and never authoritative. Core's
 * deterministic rule lattice (ADR 0003 D2) turns signals into decisions.
 *
 * Anti-pattern guards encoded here:
 * - no confidence score field (a signal has a `basis`, not a probability);
 * - every signal must carry a `Location` and a detector identity;
 * - `code-negative-closed-world` names the only basis allowed to
 *   suppress, and the classifier additionally demands a complete-scan
 *   attestation before honoring it.
 */
import { z } from 'zod';
import { sha256Canonical, type JsonValue } from '../canonical-json.js';
import { LocationSchema, PlaneSchema, SchemaVersionField } from './common.js';

/** What a signal addresses: bare name, plane-qualified id, or symbol. */
export const SignalTargetSchema = z
  .object({
    /** Bare resource name, e.g. `accounts`. */
    resourceName: z.string().min(1).optional(),
    /** Plane-qualified resource id, e.g. `tenant.accounts`. */
    resourceId: z.string().min(1).optional(),
    /** Class/function symbol, e.g. `app.models.Account` (matches a resource's `classQname` attribute). */
    symbol: z.string().min(1).optional(),
  })
  .strict();

/** Inferred signal-target shape. */
export type SignalTarget = z.infer<typeof SignalTargetSchema>;

/** Every classification dimension a signal can speak about. */
export const SIGNAL_DIMENSIONS = [
  'exposure',
  'plane',
  'identity',
  'lifecycle.create',
  'lifecycle.read',
  'lifecycle.update',
  'lifecycle.delete',
  'delete-semantics',
  'archive-state',
  'adapter-binding',
  'internality',
] as const;

/** Union of signal dimensions. */
export type SignalDimension = (typeof SIGNAL_DIMENSIONS)[number];

export const SignalDimensionSchema = z.enum(SIGNAL_DIMENSIONS);

/**
 * The evidence basis of a signal (ADR 0003 D1). Only
 * `code-negative-closed-world` may ever suppress obligations, and only
 * when the classifier's complete-scan attestation holds.
 */
export const SignalBasisSchema = z.enum([
  'code-positive',
  'code-negative-closed-world',
  'declaration',
  'organization-policy',
]);

/** Inferred signal-basis type. */
export type SignalBasis = z.infer<typeof SignalBasisSchema>;

/**
 * Dimension-typed assertion payload: `exposure`/`internality` carry a
 * boolean or category string, `plane` a plane name, `identity` the
 * ORDERED primary-key columns, `delete-semantics` `hard|archive`,
 * `archive-state` the owner-owned archived field values, lifecycle
 * dimensions a boolean.
 */
export const SignalAssertionSchema = z.union([
  z.string().min(1),
  z.boolean(),
  z.array(z.string().min(1)).min(1),
  z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
]);

/** Inferred signal-assertion type. */
export type SignalAssertion = z.infer<typeof SignalAssertionSchema>;

/**
 * One classification signal (ADR 0003 D1). Strict: unknown fields are
 * detector bugs and must fail validation, not ride along.
 */
export const ClassificationSignalSchema = z
  .object({
    schemaVersion: SchemaVersionField,
    /** What resource(s) this signal speaks about. */
    target: SignalTargetSchema,
    /** The classification dimension being evidenced. */
    dimension: SignalDimensionSchema,
    /** Dimension-typed assertion payload. */
    assertion: SignalAssertionSchema,
    /** Evidence basis — never a confidence score. */
    basis: SignalBasisSchema,
    /**
     * Issuing source. For SUPPRESSIVE decisions (internality, closed-world
     * lifecycle disable) only configured declaration sources or explicit
     * `gateforge.declaration:<key>` references to configured keys are
     * authoritative — a `gateforge.policy:` prefix alone proves nothing;
     * policy-issued signals enter through engine-controlled minting.
     */
    source: z.string().min(1),
    /** Where the evidence lives in source. */
    location: LocationSchema,
    /**
     * Detector that emitted the signal. The engine issuer
     * (`gateforge.core@1`) is reserved: plugin-emitted signals whose
     * detector identity is not the pinned plugin are rejected at the
     * boundary, and `gateforge.core` cannot be configured as a plugin id.
     */
    detector: z.strictObject({ id: z.string().min(1), version: z.string().min(1) }),
  })
  .strict();

/** Inferred classification-signal shape. */
export type ClassificationSignal = z.infer<typeof ClassificationSignalSchema>;

/**
 * Canonical signal identity (ADR 0003 D1): sha256 over the GF-canonical
 * JSON of the full signal document. Any change of location, assertion,
 * basis, or detector version changes the id — which is what makes
 * `decisionFingerprint`s stale-aware (plan goal 8).
 *
 * Args:
 *   signal: a validated classification signal.
 *
 * Returns:
 *   string: 64-char lowercase sha256 hex.
 */
export function signalId(signal: ClassificationSignal): string {
  return sha256Canonical(signal as unknown as JsonValue);
}

/**
 * The plane-assertion payload narrowed, for signals that assert a plane.
 */
export function planeAssertion(signal: ClassificationSignal): string | null {
  if (signal.dimension !== 'plane') return null;
  const parsed = PlaneSchema.safeParse(signal.assertion);
  return parsed.success ? parsed.data : null;
}
