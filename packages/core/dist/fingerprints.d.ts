/**
 * Obligation fingerprint (pin #2): the stable identity a baseline stores.
 *
 * `fingerprint(obligation-ish) = sha256(GF-canonical-JSON of
 * {resourceId, contract, policyId, lifecycle})` where `lifecycle` is the
 * classification lifecycle relevant to that contract. Key order in the
 * input is irrelevant — canonical JSON sorts keys before hashing.
 */
import { z } from 'zod';
/** Exactly the identity fields hashed into an obligation fingerprint. */
export declare const FingerprintInputSchema: z.ZodObject<{
    resourceId: z.ZodString;
    contract: z.ZodString;
    policyId: z.ZodString;
    lifecycle: z.ZodObject<{
        create: z.ZodBoolean;
        read: z.ZodBoolean;
        update: z.ZodBoolean;
        delete: z.ZodBoolean;
        deleteSemantics: z.ZodOptional<z.ZodEnum<{
            hard: "hard";
            archive: "archive";
        }>>;
        archiveFields: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnion<readonly [z.ZodString, z.ZodNumber, z.ZodBoolean]>>>;
        updateableFields: z.ZodOptional<z.ZodArray<z.ZodString>>;
    }, z.core.$strict>;
}, z.core.$strict>;
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
export declare function fingerprint(input: FingerprintInput): string;
//# sourceMappingURL=fingerprints.d.ts.map