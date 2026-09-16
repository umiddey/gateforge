/**
 * Test-mapping sidecar schema (plan 2026-09-13 §5.3): the versioned
 * `.gateforge/test-map.yml` document an agent (or `tests mark`) writes
 * to connect an EXISTING test to obligations without rewriting a test
 * body.
 *
 * One declaration model (§5.3): native `{type: 'gateforge'}` annotations
 * and sidecar entries normalize through one resolver into the same claim
 * surface — a sidecar entry DECLARES INTENT and supplies no test result
 * or trusted evidence. Rules enforced here (fail closed):
 * - every entry claims at least one obligation (`claims` non-empty);
 * - claim ids must already look like obligation ids
 *   (`<resourceId>:<contract>`) — a `'*'` wildcard is not an obligation
 *   id and never parses;
 * - `kind` must be a supported {@link TestKind} value when present;
 * - `reason` is required free text (a declaration without a why is not
 *   reviewable);
 * - duplicate entry keys are a typed parse error naming BOTH entries —
 *   never "bind the first match".
 *
 * YAML stays OUT of this module: the CLI parses `.gateforge/test-map.yml`
 * with the repository's `yaml` dependency and passes the plain document
 * here, so core speaks only validated data.
 */
import { z } from 'zod';
/**
 * Which existing test an entry declares (plan §5.3 selector). `titlePath`
 * is part of the identity rules (§5.2): a selector WITHOUT one would
 * cover a whole file — the resolver treats that as the prohibited
 * wildcard (unsafe declaration), so honest entries always carry it.
 */
export declare const TestSelectorSchema: z.ZodObject<{
    runner: z.ZodString;
    project: z.ZodOptional<z.ZodString>;
    file: z.ZodString;
    titlePath: z.ZodOptional<z.ZodArray<z.ZodString>>;
}, z.core.$strict>;
/** Inferred test-selector type. */
export type TestSelector = z.infer<typeof TestSelectorSchema>;
/**
 * One sidecar mapping entry (plan §5.3): a stable logical key, the
 * selector locating the existing test, the declared kind/categories, the
 * claimed obligation ids, and the required human reason.
 */
export declare const TestMapEntrySchema: z.ZodObject<{
    key: z.ZodString;
    selector: z.ZodObject<{
        runner: z.ZodString;
        project: z.ZodOptional<z.ZodString>;
        file: z.ZodString;
        titlePath: z.ZodOptional<z.ZodArray<z.ZodString>>;
    }, z.core.$strict>;
    kind: z.ZodOptional<z.ZodEnum<{
        unknown: "unknown";
        "browser-e2e": "browser-e2e";
        "server-e2e": "server-e2e";
        "api-e2e": "api-e2e";
        unit: "unit";
        integration: "integration";
        component: "component";
    }>>;
    categories: z.ZodOptional<z.ZodArray<z.ZodString>>;
    claims: z.ZodArray<z.ZodString>;
    reason: z.ZodString;
}, z.core.$strict>;
/** Inferred test-map-entry type. */
export type TestMapEntry = z.infer<typeof TestMapEntrySchema>;
/**
 * The `.gateforge/test-map.yml` document (plan §5.3): a tracked,
 * versioned sidecar of mapping declarations. Duplicate keys fail the
 * parse naming both entries' keys and selectors.
 */
export declare const TestMapSchema: z.ZodObject<{
    schemaVersion: z.ZodLiteral<1>;
    tests: z.ZodArray<z.ZodObject<{
        key: z.ZodString;
        selector: z.ZodObject<{
            runner: z.ZodString;
            project: z.ZodOptional<z.ZodString>;
            file: z.ZodString;
            titlePath: z.ZodOptional<z.ZodArray<z.ZodString>>;
        }, z.core.$strict>;
        kind: z.ZodOptional<z.ZodEnum<{
            unknown: "unknown";
            "browser-e2e": "browser-e2e";
            "server-e2e": "server-e2e";
            "api-e2e": "api-e2e";
            unit: "unit";
            integration: "integration";
            component: "component";
        }>>;
        categories: z.ZodOptional<z.ZodArray<z.ZodString>>;
        claims: z.ZodArray<z.ZodString>;
        reason: z.ZodString;
    }, z.core.$strict>>;
}, z.core.$strict>;
/** Inferred test-map document type. */
export type TestMap = z.infer<typeof TestMapSchema>;
//# sourceMappingURL=test-map.d.ts.map