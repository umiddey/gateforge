/**
 * Obligation fingerprint (pin #2): the stable identity a baseline stores.
 *
 * `fingerprint(obligation-ish) = sha256(GF-canonical-JSON of
 * {resourceId, contract, policyId, lifecycle})` where `lifecycle` is the
 * classification lifecycle relevant to that contract. Key order in the
 * input is irrelevant — canonical JSON sorts keys before hashing.
 */
import { z } from 'zod';
import { sha256Canonical } from './canonical-json.js';
import { ContractNameSchema } from './schemas/common.js';
import { LifecycleSchema } from './schemas/classification.js';

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
  })
  .strict();

/** Inferred fingerprint-input shape. */
export type FingerprintInput = z.infer<typeof FingerprintInputSchema>;

/**
 * Computes the obligation fingerprint (pin #2).
 *
 * Args:
 *   input: the obligation identity — resourceId, contract, policyId,
 *     and the relevant lifecycle attributes.
 *
 * Returns:
 *   string: 64-char lowercase sha256 hex over the GF-canonical-JSON of
 *   the identity object. Stable across key order and process runs.
 */
export function fingerprint(input: FingerprintInput): string {
  return sha256Canonical(FingerprintInputSchema.parse(input));
}
