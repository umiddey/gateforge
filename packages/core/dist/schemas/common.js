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
export const GATEFORGE_SCHEMA_VERSION = 1;
/**
 * schemaVersion field with the "unknown versions rejected" behavior:
 * anything but `1` produces an explicit unsupported-version diagnostic
 * rather than a silent type error.
 */
export const SchemaVersionField = z.literal(GATEFORGE_SCHEMA_VERSION, {
    error: (issue) => issue.input === undefined
        ? `schemaVersion is required and must be ${GATEFORGE_SCHEMA_VERSION}`
        : `unsupported schemaVersion: got ${String(issue.input)}, expected ${GATEFORGE_SCHEMA_VERSION} (gateforge never migrates old versions)`,
});
/** Where in a source file an artifact was found (discovery-spike shape). */
export const LocationSchema = z
    .object({
    /** Repo-root-relative path of the source file. */
    file: z.string().min(1),
    /** 1-based line number. */
    line: z.number().int().min(1),
    /** 0-based column offset. */
    col: z.number().int().min(0),
})
    .strict();
/** Whether a resource is exposed to end users or purely internal. */
export const ExposureSchema = z.enum(['user-facing', 'internal']);
/**
 * Deployment plane of a resource (tenant-scoped, master/shared, or global).
 */
export const PlaneSchema = z.enum(['tenant', 'master', 'global']);
/**
 * Transport a plugin speaks over the plugin boundary (ADR 0002):
 * `subprocess` = GPP/3 JSON-lines child process, `in-process` = TS
 * detector loaded into the engine.
 */
export const TransportSchema = z.enum(['subprocess', 'in-process']);
/** Trust tier of an evidence record (ADR 0001: only witnessed can satisfy). */
export const TrustTierSchema = z.enum(['claimed', 'witnessed']);
/**
 * Contract-name grammar. Contracts carry their own namespace segment
 * (`crud:update`, `crud:delete`), so interior colons are legal; the
 * obligation id `<resourceId>:<contract>` splits at the FIRST colon,
 * hence a contract must not START with one. Trailing colons are
 * rejected as malformed.
 */
export const ContractNameSchema = z
    .string()
    .min(1)
    .regex(/^[^:].*[^:]|^[^:]$/, "contract must not start or end with ':' (obligation ids split at the first colon)");
//# sourceMappingURL=common.js.map