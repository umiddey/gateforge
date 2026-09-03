/**
 * Shared schema building blocks for every gateforge artifact.
 *
 * ADR 0001: every artifact carries `schemaVersion`. Unknown versions are
 * rejected outright — gateforge never migrates old payloads (fail closed).
 */
import { z } from 'zod';
/**
 * The only schemaVersion gateforge accepts on any artifact, config, or
 * wire payload. Bumping this is a breaking, opt-in event per artifact —
 * there is no automatic migration path, by design.
 */
export declare const GATEFORGE_SCHEMA_VERSION = 1;
/**
 * schemaVersion field with the "unknown versions rejected" behavior:
 * anything but `1` produces an explicit unsupported-version diagnostic
 * rather than a silent type error.
 */
export declare const SchemaVersionField: z.ZodLiteral<1>;
/** Where in a source file an artifact was found (discovery-spike shape). */
export declare const LocationSchema: z.ZodObject<{
    file: z.ZodString;
    line: z.ZodNumber;
    col: z.ZodNumber;
}, z.core.$strict>;
/** Inferred source location shape. */
export type Location = z.infer<typeof LocationSchema>;
/** Whether a resource is exposed to end users or purely internal. */
export declare const ExposureSchema: z.ZodEnum<{
    "user-facing": "user-facing";
    internal: "internal";
}>;
/** Inferred exposure shape. */
export type Exposure = z.infer<typeof ExposureSchema>;
/**
 * Deployment plane of a resource (tenant-scoped, master/shared, or global).
 */
export declare const PlaneSchema: z.ZodEnum<{
    tenant: "tenant";
    master: "master";
    global: "global";
}>;
/** Inferred plane shape. */
export type Plane = z.infer<typeof PlaneSchema>;
/**
 * Transport a plugin speaks over the plugin boundary (ADR 0002):
 * `subprocess` = GPP/3 JSON-lines child process, `in-process` = TS
 * detector loaded into the engine.
 */
export declare const TransportSchema: z.ZodEnum<{
    subprocess: "subprocess";
    "in-process": "in-process";
}>;
/** Inferred transport shape. */
export type Transport = z.infer<typeof TransportSchema>;
/** Trust tier of an evidence record (ADR 0001: only witnessed can satisfy). */
export declare const TrustTierSchema: z.ZodEnum<{
    claimed: "claimed";
    witnessed: "witnessed";
}>;
/** Inferred trust-tier shape. */
export type TrustTier = z.infer<typeof TrustTierSchema>;
/**
 * Contract-name grammar. Contracts carry their own namespace segment
 * (`crud:update`, `crud:delete`), so interior colons are legal; the
 * obligation id `<resourceId>:<contract>` splits at the FIRST colon,
 * hence a contract must not START with one. Trailing colons are
 * rejected as malformed.
 */
export declare const ContractNameSchema: z.ZodString;
/** Inferred contract-name shape. */
export type ContractName = z.infer<typeof ContractNameSchema>;
//# sourceMappingURL=common.d.ts.map