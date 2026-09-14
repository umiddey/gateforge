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
import { SchemaVersionField } from './common.js';
import { ObligationIdSchema } from './claim.js';
import { TestKindSchema } from './test-catalog.js';
/**
 * Which existing test an entry declares (plan §5.3 selector). `titlePath`
 * is part of the identity rules (§5.2): a selector WITHOUT one would
 * cover a whole file — the resolver treats that as the prohibited
 * wildcard (unsafe declaration), so honest entries always carry it.
 */
export const TestSelectorSchema = z
    .object({
    /** Runner the test executes under, e.g. `playwright`. */
    runner: z.string().min(1),
    /** Runner project, e.g. `chromium`. Absent = every project of the file/title. */
    project: z.string().min(1).optional(),
    /** Repo-root-relative posix path of the test file. */
    file: z.string().min(1),
    /** Full title path (describe stack, then the test title). */
    titlePath: z.array(z.string().min(1)).optional(),
})
    .strict();
/**
 * One sidecar mapping entry (plan §5.3): a stable logical key, the
 * selector locating the existing test, the declared kind/categories, the
 * claimed obligation ids, and the required human reason.
 */
export const TestMapEntrySchema = z
    .object({
    /** Stable logical key of the test (the catalog's `logicalKey`). */
    key: z.string().min(1),
    /** Selector locating the current test instance(s). */
    selector: TestSelectorSchema,
    /** Declared kind; resolves `unknown`, never observed mocking (§5.3). */
    kind: TestKindSchema.optional(),
    /** Behavior-category labels (hints only, never proof; §3.2). */
    categories: z.array(z.string().min(1)).optional(),
    /** Claimed obligation ids — at least one; `'*'` never parses. */
    claims: z.array(ObligationIdSchema).min(1, 'every mapping entry must claim at least one obligation'),
    /** Required free-text why (a declaration must be reviewable). */
    reason: z
        .string()
        .trim()
        .min(8, 'reason is required free text (at least 8 characters) explaining the declaration'),
})
    .strict();
/**
 * The `.gateforge/test-map.yml` document (plan §5.3): a tracked,
 * versioned sidecar of mapping declarations. Duplicate keys fail the
 * parse naming both entries' keys and selectors.
 */
export const TestMapSchema = z
    .object({
    schemaVersion: SchemaVersionField,
    /** Mapping declarations, unique by `key` (order is data, not identity). */
    tests: z.array(TestMapEntrySchema),
})
    .strict()
    .superRefine((document, ctx) => {
    // §5.2: validate uniqueness — duplicate keys list BOTH entries and
    // never bind the first match.
    const seen = new Map();
    for (let index = 0; index < document.tests.length; index += 1) {
        const entry = document.tests[index];
        if (entry === undefined)
            continue;
        const previous = seen.get(entry.key);
        if (previous !== undefined) {
            ctx.addIssue({
                code: 'custom',
                path: ['tests', index, 'key'],
                message: `duplicate sidecar key '${entry.key}' — entries at tests[${String(document.tests.indexOf(previous))}] (file ${previous.selector.file}) and tests[${String(index)}] (file ${entry.selector.file})`,
            });
            continue;
        }
        seen.set(entry.key, entry);
    }
});
//# sourceMappingURL=test-map.js.map