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
/**
 * The obligation artifact. `lifecycle` carries the classification
 * lifecycle attributes relevant to this obligation — it is part of the
 * fingerprint identity (pin #2), so it must travel with the obligation.
 */
export declare const ObligationSchema: z.ZodObject<{
    schemaVersion: z.ZodLiteral<1>;
    id: z.ZodString;
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
/** Inferred obligation shape. */
export type Obligation = z.infer<typeof ObligationSchema>;
//# sourceMappingURL=obligation.d.ts.map