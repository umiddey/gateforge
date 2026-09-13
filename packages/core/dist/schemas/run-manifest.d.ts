/**
 * RunManifest schema (pin #4): identity of a single gateforge run. Every
 * verdict and every witnessed evidence record references its run.
 *
 * `startedAt` comes from the injected clock (deterministic tests), never
 * the wall clock. At shutdown the witness service appends the record ids
 * it issued to the manifest (pin #7).
 */
import { z } from 'zod';
/** Which changed-file provider backs the run (pin #5 of architecture contracts). */
export declare const ChangedProviderSchema: z.ZodEnum<{
    "local-staged": "local-staged";
    "github-pr": "github-pr";
    "gitlab-mr": "gitlab-mr";
    "all-files": "all-files";
}>;
/** Inferred changed-provider shape. */
export type ChangedProvider = z.infer<typeof ChangedProviderSchema>;
/**
 * V2 evidence attestation envelope (plan §11.3): the witness's signed
 * statement of its run context and issued record set. `attestationVersion`
 * is an explicit literal — never a reinterpreted legacy field — so an old
 * `{runId, recordIds}` MAC cannot authorize evidence even when it
 * verifies under its own format.
 */
export declare const AttestationSchema: z.ZodObject<{
    attestationVersion: z.ZodLiteral<2>;
    runId: z.ZodUUID;
    invocationId: z.ZodUUID;
    inputDigest: z.ZodString;
    recordIds: z.ZodArray<z.ZodString>;
    mac: z.ZodString;
}, z.core.$strict>;
/** Inferred v2 attestation envelope shape. */
export type Attestation = z.infer<typeof AttestationSchema>;
/** The run manifest artifact. */
export declare const RunManifestSchema: z.ZodObject<{
    schemaVersion: z.ZodLiteral<1>;
    runId: z.ZodUUID;
    startedAt: z.ZodISODateTime;
    gitSha: z.ZodNullable<z.ZodString>;
    provider: z.ZodEnum<{
        "local-staged": "local-staged";
        "github-pr": "github-pr";
        "gitlab-mr": "gitlab-mr";
        "all-files": "all-files";
    }>;
    plugins: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        version: z.ZodString;
        transport: z.ZodEnum<{
            subprocess: "subprocess";
            "in-process": "in-process";
        }>;
    }, z.core.$strict>>;
    attestationScope: z.ZodNullable<z.ZodString>;
    recordIds: z.ZodOptional<z.ZodArray<z.ZodString>>;
    recordIdsMac: z.ZodOptional<z.ZodString>;
    invocationId: z.ZodOptional<z.ZodUUID>;
    inputDigest: z.ZodOptional<z.ZodString>;
    attestation: z.ZodOptional<z.ZodObject<{
        attestationVersion: z.ZodLiteral<2>;
        runId: z.ZodUUID;
        invocationId: z.ZodUUID;
        inputDigest: z.ZodString;
        recordIds: z.ZodArray<z.ZodString>;
        mac: z.ZodString;
    }, z.core.$strict>>;
}, z.core.$strict>;
/** Inferred run-manifest shape. */
export type RunManifest = z.infer<typeof RunManifestSchema>;
//# sourceMappingURL=run-manifest.d.ts.map