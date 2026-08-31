/**
 * Claim schema (plan §4.6): a test's declaration that it covers an
 * obligation, expressed via native framework metadata (e.g. a Playwright
 * annotation `{type: 'gateforge', description: '<obligation id>'}`).
 *
 * A claim is NOT proof (invariant 2) — it only links a test to an
 * obligation so the verifier knows which evidence to gather.
 */
import { z } from 'zod';
import { LocationSchema, SchemaVersionField } from './common.js';
/**
 * Obligation reference `<resourceId>:<contract>`: resourceId carries no
 * colon, contract may (e.g. `crud:update`), so the id splits at the
 * FIRST colon.
 */
export const ObligationIdSchema = z
    .string()
    .min(1)
    .regex(/^[^:]+:.+$/, "obligation id must match '<resourceId>:<contract>' (split at the first colon)");
/** A test's declared coverage of one obligation. */
export const ClaimSchema = z
    .object({
    schemaVersion: SchemaVersionField,
    /** The obligation this test claims to cover. */
    obligationId: ObligationIdSchema,
    /** Stable test identifier (framework test id or full title). */
    testId: z.string().min(1),
    /** File the test lives in, when the framework provides it. */
    testFile: z.string().min(1).optional(),
    /** Source location of the test declaration, when available. */
    location: LocationSchema.optional(),
})
    .strict();
//# sourceMappingURL=claim.js.map