import { z } from 'zod';
/**
 * A plugin entry in `.gateforge.yml`. Unlike a run-manifest plugin
 * registration, a config entry also declares HOW to launch the plugin:
 * `subprocess` plugins get `command` (argv, run without network);
 * `in-process` plugins get `module` (a TS module specifier).
 */
export declare const ConfigPluginSchema: z.ZodObject<{
    id: z.ZodString;
    version: z.ZodString;
    transport: z.ZodEnum<{
        subprocess: "subprocess";
        "in-process": "in-process";
    }>;
    command: z.ZodOptional<z.ZodArray<z.ZodString>>;
    module: z.ZodOptional<z.ZodString>;
}, z.core.$strict>;
/** Inferred config-plugin shape. */
export type ConfigPlugin = z.infer<typeof ConfigPluginSchema>;
/**
 * Enforcement-mode configuration (plan 2026-09-13 §3.4/§3.3, ADR 0005
 * D1/D4). OPTIONAL and off by default — enabling strict E2E is an
 * explicit, tracked owner decision.
 */
export declare const EnforcementConfigSchema: z.ZodObject<{
    mode: z.ZodDefault<z.ZodEnum<{
        standard: "standard";
        managed: "managed";
    }>>;
    strictE2E: z.ZodDefault<z.ZodBoolean>;
    approvedPolicyDigest: z.ZodOptional<z.ZodString>;
}, z.core.$strict>;
/** Inferred enforcement-section shape (fields defaulted when the section is present). */
export type EnforcementConfig = z.infer<typeof EnforcementConfigSchema>;
/**
 * One configured diagnostic suite (plan 2026-09-13 §3.5, phase 2 item
 * 8): an EXISTING suite the owner registers for the advisory "red means
 * inspect this" alarm. Gateforge never discovers suites on its own — no
 * directory scans, no executing commands found on disk; everything comes
 * from this explicit, tracked configuration.
 *
 * Only `pytest` is accepted today: other runners stay explicitly
 * unsupported until an adapter exists (plan phase 2 item 6) — a typo'd
 * or aspirational runner name must fail the config load, not silently
 * disable a suite.
 */
export declare const DiagnosticSuiteSchema: z.ZodObject<{
    name: z.ZodString;
    runner: z.ZodEnum<{
        pytest: "pytest";
    }>;
    cwd: z.ZodString;
    argv: z.ZodArray<z.ZodString>;
    testPaths: z.ZodArray<z.ZodString>;
    timeoutMs: z.ZodNumber;
    witnessed: z.ZodOptional<z.ZodBoolean>;
}, z.core.$strict>;
/** Inferred diagnostic-suite shape. */
export type DiagnosticSuite = z.infer<typeof DiagnosticSuiteSchema>;
/**
 * The `diagnostics` config section (plan §3.5): registered diagnostic
 * suites. ABSENT = no diagnostic suites (the default; the alarm is
 * opt-in and never a commit blocker by itself).
 */
export declare const DiagnosticsConfigSchema: z.ZodObject<{
    suites: z.ZodArray<z.ZodObject<{
        name: z.ZodString;
        runner: z.ZodEnum<{
            pytest: "pytest";
        }>;
        cwd: z.ZodString;
        argv: z.ZodArray<z.ZodString>;
        testPaths: z.ZodArray<z.ZodString>;
        timeoutMs: z.ZodNumber;
        witnessed: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strict>>;
}, z.core.$strict>;
/** Inferred diagnostics-section shape. */
export type DiagnosticsConfig = z.infer<typeof DiagnosticsConfigSchema>;
/**
 * The `.gateforge.yml` document schema (pin #6). All paths are
 * repo-root-relative. Unknown keys are rejected — a typo must fail the
 * config load, not silently disable a subsystem.
 */
export declare const GateforgeConfigSchema: z.ZodObject<{
    schemaVersion: z.ZodLiteral<1>;
    project: z.ZodObject<{
        languages: z.ZodArray<z.ZodString>;
        paths: z.ZodObject<{
            include: z.ZodArray<z.ZodString>;
            exclude: z.ZodArray<z.ZodString>;
        }, z.core.$strict>;
    }, z.core.$strict>;
    plugins: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        version: z.ZodString;
        transport: z.ZodEnum<{
            subprocess: "subprocess";
            "in-process": "in-process";
        }>;
        command: z.ZodOptional<z.ZodArray<z.ZodString>>;
        module: z.ZodOptional<z.ZodString>;
    }, z.core.$strict>>;
    policies: z.ZodString;
    classificationPolicy: z.ZodString;
    adapters: z.ZodString;
    waivers: z.ZodString;
    baselines: z.ZodString;
    changed: z.ZodObject<{
        provider: z.ZodEnum<{
            "local-staged": "local-staged";
            "github-pr": "github-pr";
            "gitlab-mr": "gitlab-mr";
            auto: "auto";
        }>;
    }, z.core.$strict>;
    witness: z.ZodObject<{
        maxDurationSeconds: z.ZodNumber;
    }, z.core.$strict>;
    clock: z.ZodObject<{
        mode: z.ZodEnum<{
            system: "system";
            fixed: "fixed";
        }>;
        fixedAt: z.ZodOptional<z.ZodISODateTime>;
    }, z.core.$strict>;
    enforcement: z.ZodOptional<z.ZodObject<{
        mode: z.ZodDefault<z.ZodEnum<{
            standard: "standard";
            managed: "managed";
        }>>;
        strictE2E: z.ZodDefault<z.ZodBoolean>;
        approvedPolicyDigest: z.ZodOptional<z.ZodString>;
    }, z.core.$strict>>;
    coveragePolicy: z.ZodOptional<z.ZodObject<{
        tables: z.ZodArray<z.ZodObject<{
            name: z.ZodString;
            requiredOperations: z.ZodArray<z.ZodEnum<{
                create: "create";
                read: "read";
                update: "update";
                delete: "delete";
            }>>;
            disposition: z.ZodOptional<z.ZodObject<{
                kind: z.ZodEnum<{
                    "read-only-surface": "read-only-surface";
                    "admin-plane-unreachable": "admin-plane-unreachable";
                    "not-user-facing": "not-user-facing";
                    other: "other";
                }>;
                note: z.ZodOptional<z.ZodString>;
            }, z.core.$strict>>;
        }, z.core.$strict>>;
    }, z.core.$strict>>;
    diagnostics: z.ZodOptional<z.ZodObject<{
        suites: z.ZodArray<z.ZodObject<{
            name: z.ZodString;
            runner: z.ZodEnum<{
                pytest: "pytest";
            }>;
            cwd: z.ZodString;
            argv: z.ZodArray<z.ZodString>;
            testPaths: z.ZodArray<z.ZodString>;
            timeoutMs: z.ZodNumber;
            witnessed: z.ZodOptional<z.ZodBoolean>;
        }, z.core.$strict>>;
    }, z.core.$strict>>;
}, z.core.$strict>;
/** Inferred `.gateforge.yml` shape. */
export type GateforgeConfig = z.infer<typeof GateforgeConfigSchema>;
/**
 * One actionable config diagnostic: where, what, and expected-vs-got.
 */
export interface ConfigDiagnostic {
    /** File the diagnostic came from ('<inline>' for direct parse calls). */
    file: string;
    /** JSON path into the document, e.g. `$.plugins[0].transport`. */
    jsonPath: string;
    /** What is wrong. */
    message: string;
    /** What the schema expected, when known. */
    expected?: string;
    /** What was found, rendered compactly. */
    got?: string;
}
/** Error raised for any fail-closed config problem. */
export declare class GateforgeConfigError extends Error {
    /** All collected diagnostics (first is the primary cause). */
    readonly diagnostics: ConfigDiagnostic[];
    /**
     * Builds the error from diagnostics.
     *
     * Args:
     *   diagnostics: nonempty list of actionable diagnostics.
     */
    constructor(diagnostics: ConfigDiagnostic[]);
}
/**
 * Converts a zod issue path to a JSONPath-style string (`$.a.b[0]`).
 *
 * Args:
 *   path: zod issue path segments.
 *
 * Returns:
 *   string: JSON path with a leading `$`.
 */
export declare function jsonPathFor(path: PropertyKey[]): string;
/**
 * Converts zod issues into actionable config diagnostics.
 *
 * Args:
 *   error: failed zod result error.
 *   file: file name to attach to every diagnostic.
 *   input: the original parsed document, used to recover got-values.
 *
 * Returns:
 *   ConfigDiagnostic[]: one diagnostic per issue, same order.
 */
export declare function diagnosticsFromZodError(error: z.ZodError, file: string, input?: unknown): ConfigDiagnostic[];
/**
 * Formats diagnostics into the multi-line message users see.
 *
 * Args:
 *   diagnostics: diagnostics to render.
 *
 * Returns:
 *   string: human-readable, single-cause-first listing.
 */
export declare function formatDiagnostics(diagnostics: ConfigDiagnostic[]): string;
/**
 * Validates an already-parsed config document against the schema.
 *
 * Args:
 *   input: parsed YAML/JSON document (an unknown value).
 *   file: source file name for diagnostics (default '<inline>').
 *
 * Returns:
 *   GateforgeConfig: the validated config.
 *
 * Raises:
 *   GateforgeConfigError: on any schema violation, including unknown
 *   schemaVersion (never migrated) and unknown keys (typos fail loud).
 */
export declare function parseConfig(input: unknown, { file }?: {
    file?: string;
}): GateforgeConfig;
/**
 * Loads and validates `.gateforge.yml` from disk. Fail-closed: a missing
 * file, unparsable YAML, or schema violations all raise
 * {@link GateforgeConfigError} with actionable diagnostics.
 *
 * Args:
 *   path: config file path (default '.gateforge.yml').
 *
 * Returns:
 *   GateforgeConfig: the validated config.
 *
 * Raises:
 *   GateforgeConfigError: for missing/unreadable/unparsable/invalid config.
 */
export declare function loadConfig(path?: string): GateforgeConfig;
//# sourceMappingURL=index.d.ts.map