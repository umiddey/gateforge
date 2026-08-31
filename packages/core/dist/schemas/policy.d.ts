/**
 * Policy schemas (plan §4.4): declarative YAML mapping resource
 * attributes to required test obligations. Policies are pure data —
 * there is no code escape hatch (ADR 0002).
 */
import { z } from 'zod';
/**
 * Attribute matchers a resource must satisfy for the policy to apply.
 * All provided matchers must match (AND semantics); omitted matchers are
 * wildcard.
 */
export declare const PolicyWhenSchema: z.ZodObject<{
    kind: z.ZodOptional<z.ZodString>;
    exposure: z.ZodOptional<z.ZodEnum<{
        "user-facing": "user-facing";
        internal: "internal";
    }>>;
    plane: z.ZodOptional<z.ZodEnum<{
        tenant: "tenant";
        master: "master";
        global: "global";
    }>>;
}, z.core.$strict>;
/** Inferred policy matcher shape. */
export type PolicyWhen = z.infer<typeof PolicyWhenSchema>;
/** One policy: when matched, require the listed contracts as obligations. */
export declare const PolicySchema: z.ZodObject<{
    id: z.ZodString;
    when: z.ZodObject<{
        kind: z.ZodOptional<z.ZodString>;
        exposure: z.ZodOptional<z.ZodEnum<{
            "user-facing": "user-facing";
            internal: "internal";
        }>>;
        plane: z.ZodOptional<z.ZodEnum<{
            tenant: "tenant";
            master: "master";
            global: "global";
        }>>;
    }, z.core.$strict>;
    require: z.ZodArray<z.ZodString>;
}, z.core.$strict>;
/** Inferred single-policy shape. */
export type Policy = z.infer<typeof PolicySchema>;
/** The policies document loaded from the path in `.gateforge.yml`. */
export declare const PolicyFileSchema: z.ZodObject<{
    schemaVersion: z.ZodLiteral<1>;
    policies: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        when: z.ZodObject<{
            kind: z.ZodOptional<z.ZodString>;
            exposure: z.ZodOptional<z.ZodEnum<{
                "user-facing": "user-facing";
                internal: "internal";
            }>>;
            plane: z.ZodOptional<z.ZodEnum<{
                tenant: "tenant";
                master: "master";
                global: "global";
            }>>;
        }, z.core.$strict>;
        require: z.ZodArray<z.ZodString>;
    }, z.core.$strict>>;
}, z.core.$strict>;
/** Inferred policies-document shape. */
export type PolicyFile = z.infer<typeof PolicyFileSchema>;
//# sourceMappingURL=policy.d.ts.map