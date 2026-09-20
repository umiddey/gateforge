/**
 * Obligation fingerprint (pin #2): the stable identity a baseline stores.
 *
 * `fingerprint(obligation-ish) = sha256(GF-canonical-JSON of
 * {resourceId, contract, policyId, lifecycle}` plus `requirementsDigest`
 * when present). Omitting the digest keeps historical four-field
 * fingerprints unchanged. Undefined fields are never hashed.
 */
import { z } from 'zod';
import { sha256Canonical, type JsonValue } from './canonical-json.js';
import { ContractNameSchema } from './schemas/common.js';
import { LifecycleSchema } from './schemas/classification.js';
import { BlockingEntrySchema, type BlockingEntry } from './policy/evaluate.js';

/** Exactly the identity fields hashed into an obligation fingerprint. */
export const FingerprintInputSchema = z
  .object({
    /** Resource the obligation attaches to (no colons). */
    resourceId: z
      .string()
      .min(1)
      .regex(/^[^:]+$/, "resourceId must not contain ':'"),
    /** Contract name, e.g. `crud:update`. */
    contract: ContractNameSchema,
    /** Policy id that generated the obligation. */
    policyId: z.string().min(1),
    /** Classification lifecycle attributes relevant to the contract. */
    lifecycle: LifecycleSchema,
    /**
     * Present only for behavior-catalog obligations. Never hashed as
     * `undefined` — omitted fields keep the historical four-key identity.
     */
    requirementsDigest: z
      .string()
      .regex(/^[0-9a-f]{64}$/, 'requirementsDigest must be a 64-char lowercase sha256 hex')
      .optional(),
  })
  .strict();

/** Inferred fingerprint-input shape. */
export type FingerprintInput = z.infer<typeof FingerprintInputSchema>;

/** Obligation-shaped input the shared projection accepts. */
export interface ObligationFingerprintSource {
  resourceId: string;
  contract: string;
  policyId: string;
  lifecycle: FingerprintInput['lifecycle'];
  requirementsDigest?: string;
}

/**
 * Projects an obligation onto fingerprint identity fields. Omits
 * `requirementsDigest` when absent so canonical JSON never contains
 * undefined.
 *
 * Args:
 *   obligation (ObligationFingerprintSource): obligation or equivalent.
 *
 * Returns:
 *   FingerprintInput: the hashed identity object.
 */
export function obligationFingerprintInput(
  obligation: ObligationFingerprintSource,
): FingerprintInput {
  const input: FingerprintInput = {
    resourceId: obligation.resourceId,
    contract: obligation.contract,
    policyId: obligation.policyId,
    lifecycle: obligation.lifecycle,
  };
  if (obligation.requirementsDigest !== undefined) {
    input.requirementsDigest = obligation.requirementsDigest;
  }
  return FingerprintInputSchema.parse(input);
}

/**
 * Computes the obligation fingerprint (pin #2).
 *
 * Args:
 *   input: the obligation identity — resourceId, contract, policyId,
 *     lifecycle, and optional requirementsDigest.
 *
 * Returns:
 *   string: 64-char lowercase sha256 hex over the GF-canonical-JSON of
 *   the identity object. Stable across key order and process runs.
 */
export function fingerprint(input: FingerprintInput): string {
  const parsed = FingerprintInputSchema.parse(input);
  const payload: Record<string, JsonValue> = {
    resourceId: parsed.resourceId,
    contract: parsed.contract,
    policyId: parsed.policyId,
    lifecycle: parsed.lifecycle as unknown as JsonValue,
  };
  if (parsed.requirementsDigest !== undefined) {
    payload['requirementsDigest'] = parsed.requirementsDigest;
  }
  return sha256Canonical(payload);
}

/**
 * Fingerprint of a full obligation through the shared projection.
 *
 * Args:
 *   obligation (ObligationFingerprintSource): obligation or equivalent.
 *
 * Returns:
 *   string: 64-char lowercase sha256 hex.
 */
export function fingerprintObligation(obligation: ObligationFingerprintSource): string {
  return fingerprint(obligationFingerprintInput(obligation));
}

/**
 * The BLOCKING-ENTRY fingerprint (phase 8 workstream C): the stable
 * identity a baseline stores for gate red that is not an obligation —
 * unclassified/unresolved resources, detector/graph findings, and stale
 * references. sha256 over the GF-canonical-JSON of the whole entry
 * (kind, resourceId, name, detail, location): any change to the cause —
 * including wording or location of the underlying problem — mints a NEW
 * fingerprint, which the baseline does not contain, which blocks again.
 * That is the fail-closed direction: the adoption baseline forgives the
 * debt exactly as it stood at adoption; anything that shifts must be
 * re-proven, never re-forgiven (the baseline is shrink-only).
 */
export function blockingEntryFingerprint(entry: BlockingEntry): string {
  return sha256Canonical(BlockingEntrySchema.parse(entry));
}
