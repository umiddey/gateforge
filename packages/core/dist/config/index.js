/**
 * `.gateforge.yml` loading and validation (pin #6).
 *
 * Fail-closed by design: a missing file, unparsable YAML, an unknown
 * `schemaVersion`, or any schema violation raises
 * {@link GateforgeConfigError} carrying actionable diagnostics — each
 * with the source file, a JSON path, and expected-vs-got detail.
 * Exit code for this failure class is 2 (config/usage error).
 */
import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { SchemaVersionField, TransportSchema } from '../schemas/common.js';
import { z } from 'zod';
/**
 * A plugin entry in `.gateforge.yml`. Unlike a run-manifest plugin
 * registration, a config entry also declares HOW to launch the plugin:
 * `subprocess` plugins get `command` (argv, run without network);
 * `in-process` plugins get `module` (a TS module specifier).
 */
export const ConfigPluginSchema = z
    .object({
    /** Plugin id, e.g. `gateforge.pack-sqlalchemy`. */
    id: z.string().min(1),
    /** Declared plugin version (handshake-checked at spawn, pin #5). */
    version: z.string().min(1),
    /** Transport over the plugin boundary (ADR 0002). */
    transport: TransportSchema,
    /** argv to spawn (subprocess transport only), executed with no network. */
    command: z.array(z.string().min(1)).min(1).optional(),
    /** Module specifier to import (in-process transport only). */
    module: z.string().min(1).optional(),
})
    .strict()
    .superRefine((plugin, ctx) => {
    // Issuer reservation (ADR 0003 D2/D6): `gateforge.core` is the
    // ENGINE's suppressive-signal authority. A plugin configured under
    // that id would let ordinary plugin output forge engine-issued
    // declarations, so the id is reserved at config validation — the
    // engine is not a configurable plugin.
    if (plugin.id === 'gateforge.core') {
        ctx.addIssue({
            code: 'custom',
            path: ['id'],
            message: "plugin id 'gateforge.core' is reserved: suppressive classification authority is engine-issued, never plugin-issued",
        });
    }
    if (plugin.transport === 'subprocess') {
        if (plugin.command === undefined) {
            ctx.addIssue({
                code: 'custom',
                path: ['command'],
                message: `subprocess plugin '${plugin.id}' requires 'command' (argv to spawn)`,
            });
        }
        if (plugin.module !== undefined) {
            ctx.addIssue({
                code: 'custom',
                path: ['module'],
                message: `subprocess plugin '${plugin.id}' must not declare 'module' (in-process only)`,
            });
        }
    }
    else {
        if (plugin.module === undefined) {
            ctx.addIssue({
                code: 'custom',
                path: ['module'],
                message: `in-process plugin '${plugin.id}' requires 'module' (module specifier to import)`,
            });
        }
        if (plugin.command !== undefined) {
            ctx.addIssue({
                code: 'custom',
                path: ['command'],
                message: `in-process plugin '${plugin.id}' must not declare 'command' (subprocess only)`,
            });
        }
    }
});
/**
 * The `.gateforge.yml` document schema (pin #6). All paths are
 * repo-root-relative. Unknown keys are rejected — a typo must fail the
 * config load, not silently disable a subsystem.
 */
export const GateforgeConfigSchema = z
    .object({
    schemaVersion: SchemaVersionField,
    /** Project-wide discovery settings. */
    project: z
        .object({
        /** Languages detectors should run for, e.g. ['python']. */
        languages: z.array(z.string().min(1)).min(1),
        /** Path filters applied to discovery. */
        paths: z
            .object({
            /** Globs to include. */
            include: z.array(z.string().min(1)).min(1),
            /** Globs to exclude. */
            exclude: z.array(z.string().min(1)),
        })
            .strict(),
    })
        .strict(),
    /** Plugin set: subprocess (GPP/3) and in-process detectors. */
    plugins: z.array(ConfigPluginSchema),
    /** Path to the policies YAML document. */
    policies: z.string().min(1),
    /**
     * Path to the classification-policy YAML document (plan phase 5,
     * ADR 0003 D5): repository-wide deterministic classification rules.
     * Effective classifications are computed from detector signals on
     * every run; there is no manual classifications document.
     */
    classificationPolicy: z.string().min(1),
    /** Directory of reviewed evidence adapters (.mjs, engine-loaded). */
    adapters: z.string().min(1),
    /** Directory of waiver documents. */
    waivers: z.string().min(1),
    /** Path to the baseline document (`.gateforge/baselines/obligations.json`). */
    baselines: z.string().min(1),
    /** Changed-file provider selection (architecture contract 5). */
    changed: z
        .object({
        provider: z.enum(['auto', 'local-staged', 'github-pr', 'gitlab-mr']),
    })
        .strict(),
    /** Witness service bounds. */
    witness: z
        .object({
        /** Upper bound for a single witness call, in seconds. */
        maxDurationSeconds: z.number().int().min(1),
    })
        .strict(),
    /** Clock selection: system time, or a fixed instant for determinism. */
    clock: z
        .object({
        mode: z.enum(['system', 'fixed']),
        /** Required with mode 'fixed'; meaningless otherwise (rejected). */
        fixedAt: z.iso.datetime().optional(),
    })
        .strict()
        .superRefine((clock, ctx) => {
        if (clock.mode === 'fixed' && clock.fixedAt === undefined) {
            ctx.addIssue({
                code: 'custom',
                path: ['fixedAt'],
                message: "clock.mode 'fixed' requires 'fixedAt' (ISO-8601 instant)",
            });
        }
        if (clock.mode === 'system' && clock.fixedAt !== undefined) {
            ctx.addIssue({
                code: 'custom',
                path: ['fixedAt'],
                message: "'fixedAt' is only valid with clock.mode 'fixed'",
            });
        }
    }),
})
    .strict();
/** Error raised for any fail-closed config problem. */
export class GateforgeConfigError extends Error {
    /** All collected diagnostics (first is the primary cause). */
    diagnostics;
    /**
     * Builds the error from diagnostics.
     *
     * Args:
     *   diagnostics: nonempty list of actionable diagnostics.
     */
    constructor(diagnostics) {
        super(formatDiagnostics(diagnostics));
        this.name = 'GateforgeConfigError';
        this.diagnostics = diagnostics;
    }
}
/**
 * Renders a diagnostic input value compactly for `got` fields.
 *
 * Args:
 *   value: the offending value from the parsed document.
 *
 * Returns:
 *   string: single-line, length-capped rendering of the value.
 */
function renderGot(value) {
    let rendered;
    if (typeof value === 'string') {
        rendered = JSON.stringify(value);
    }
    else if (value === undefined) {
        rendered = 'undefined';
    }
    else {
        try {
            rendered = JSON.stringify(value) ?? String(value);
        }
        catch {
            rendered = String(value);
        }
    }
    return rendered.length > 80 ? `${rendered.slice(0, 77)}...` : rendered;
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
export function jsonPathFor(path) {
    let out = '$';
    for (const segment of path) {
        out += typeof segment === 'number' ? `[${String(segment)}]` : `.${String(segment)}`;
    }
    return out;
}
/**
 * Reads the offending value out of the original document by issue path.
 * Zod v4 issues do not carry the rejected input, so we recover it here.
 *
 * Args:
 *   input: the original parsed document handed to the schema.
 *   path: zod issue path segments.
 *
 * Returns:
 *   unknown: the value at the path, or undefined when unreachable.
 */
function valueAtPath(input, path) {
    let current = input;
    for (const segment of path) {
        if (current === null || typeof current !== 'object') {
            return undefined;
        }
        current = current[segment];
    }
    return current;
}
/**
 * Extracts the "expected" detail from a zod issue when available:
 * enum/literal issues carry `values`, type issues carry `expected`.
 *
 * Args:
 *   issue: the zod issue.
 *
 * Returns:
 *   string | undefined: rendered expectation, when the issue has one.
 */
function expectedFromIssue(issue) {
    const record = issue;
    const values = record['values'];
    if (Array.isArray(values) && values.length > 0) {
        return values.map((value) => JSON.stringify(value)).join(' | ');
    }
    return typeof record['expected'] === 'string' ? record['expected'] : undefined;
}
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
export function diagnosticsFromZodError(error, file, input) {
    return error.issues.map((issue) => {
        const gotValue = input === undefined ? undefined : valueAtPath(input, issue.path);
        return {
            file,
            jsonPath: jsonPathFor(issue.path),
            message: issue.message,
            expected: expectedFromIssue(issue),
            got: gotValue === undefined ? undefined : renderGot(gotValue),
        };
    });
}
/**
 * Formats diagnostics into the multi-line message users see.
 *
 * Args:
 *   diagnostics: diagnostics to render.
 *
 * Returns:
 *   string: human-readable, single-cause-first listing.
 */
export function formatDiagnostics(diagnostics) {
    const head = diagnostics.length === 1
        ? 'invalid gateforge config (1 error)'
        : `invalid gateforge config (${String(diagnostics.length)} errors)`;
    const lines = diagnostics.map((diagnostic) => {
        const parts = [diagnostic.file, diagnostic.jsonPath, diagnostic.message];
        if (diagnostic.expected !== undefined) {
            parts.push(`expected: ${diagnostic.expected}`);
        }
        if (diagnostic.got !== undefined) {
            parts.push(`got: ${diagnostic.got}`);
        }
        return `  - ${parts.filter((part) => part.length > 0).join(': ')}`;
    });
    return [head, ...lines].join('\n');
}
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
export function parseConfig(input, { file = '<inline>' } = {}) {
    // Migration diagnostic (plan phase 5): the authoritative manual
    // classifications document was removed in the automatic-classification
    // cutover. Fail with the exact migration steps, never a generic
    // unknown-key error.
    if (input !== null && typeof input === 'object' && 'classifications' in input) {
        throw new GateforgeConfigError([
            {
                file,
                jsonPath: '$.classifications',
                message: "config key 'classifications' was removed: classification is now automatic. " +
                    "Delete the key and add `classificationPolicy: .gateforge/classification-policy.yml` " +
                    '(create it with `gateforge init`); its scanRoots gate every closed-world proof. ' +
                    'Per-resource entries became `gateforge classify --write-snapshot` output ' +
                    '(a derived artifact — never authoritative input) or source declarations.',
            },
        ]);
    }
    const result = GateforgeConfigSchema.safeParse(input);
    if (result.success) {
        return result.data;
    }
    throw new GateforgeConfigError(diagnosticsFromZodError(result.error, file, input));
}
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
export function loadConfig(path = '.gateforge.yml') {
    let raw;
    try {
        raw = readFileSync(path, 'utf8');
    }
    catch (cause) {
        const code = cause.code ?? 'UNKNOWN';
        const hint = code === 'ENOENT'
            ? 'run the init command or pass an explicit config path'
            : 'check file permissions';
        throw new GateforgeConfigError([
            {
                file: path,
                jsonPath: '$',
                message: `cannot read config file (${code}); ${hint}`,
            },
        ]);
    }
    let document;
    try {
        document = parseYaml(raw);
    }
    catch (cause) {
        throw new GateforgeConfigError([
            {
                file: path,
                jsonPath: '$',
                message: `invalid YAML: ${cause.message.split('\n')[0] ?? 'parse error'}`,
            },
        ]);
    }
    return parseConfig(document, { file: path });
}
//# sourceMappingURL=index.js.map