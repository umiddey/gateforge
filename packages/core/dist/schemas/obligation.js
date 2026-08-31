/**
 * Obligation schema (plan §4.5): a concrete test requirement generated
 * from a resource and a policy. Obligation ids are
 * `<resourceId>:<contract>` (e.g. `tenant.accounts:crud:update`) and the
 * fingerprint over their identity is what baselines store (pin #2).
 *
 * Id grammar: the id splits at the FIRST colon — `resourceId` never
 * contains a colon, `contract` may (e.g. `crud:update`).
 */
import { z } from 'zod';
import { ContractNameSchema, SchemaVersionField } from './common.js';
import { LifecycleSchema } from './classification.js';
/**
 * The obligation artifact. `lifecycle` carries the classification
 * lifecycle attributes relevant to this obligation — it is part of the
 * fingerprint identity (pin #2), so it must travel with the obligation.
 */
export const ObligationSchema = z
    .object({
    schemaVersion: SchemaVersionField,
    /** `<resourceId>:<contract>`. */
    id: z.string().min(1),
    /** Resource the obligation attaches to (no colons — it is the id prefix). */
    resourceId: z
        .string()
        .min(1)
        .regex(/^[^:]+$/, "resourceId must not contain ':' (ids split at the first colon)"),
    /** Contract name required by the policy, e.g. `crud:update`. */
    contract: ContractNameSchema,
    /** Policy id that generated this obligation. */
    policyId: z.string().min(1),
    /** Classification lifecycle attributes relevant to this contract. */
    lifecycle: LifecycleSchema,
})
    .strict()
    .superRefine((obligation, ctx) => {
    const expected = `${obligation.resourceId}:${obligation.contract}`;
    if (obligation.id !== expected) {
        ctx.addIssue({
            code: 'custom',
            path: ['id'],
            message: `obligation id must be '<resourceId>:<contract>': expected '${expected}', got '${obligation.id}'`,
        });
    }
});
//# sourceMappingURL=obligation.js.map