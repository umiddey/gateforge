/**
 * Claim schema (plan §4.6): a test's declaration that it covers an
 * obligation, expressed via native framework metadata (e.g. a Playwright
 * annotation `{type: 'gateforge', description: '<obligation id>'}`).
 *
 * A claim is NOT proof (invariant 2) — it only links a test to an
 * obligation so the verifier knows which evidence to gather.
 */
import { z } from 'zod';
/**
 * Obligation reference `<resourceId>:<contract>`: resourceId carries no
 * colon, contract may (e.g. `crud:update`), so the id splits at the
 * FIRST colon.
 */
export declare const ObligationIdSchema: z.ZodString;
/** Inferred obligation-id shape. */
export type ObligationId = z.infer<typeof ObligationIdSchema>;
/** A test's declared coverage of one obligation. */
export declare const ClaimSchema: z.ZodObject<{
    schemaVersion: z.ZodLiteral<1>;
    obligationId: z.ZodString;
    testId: z.ZodString;
    testFile: z.ZodOptional<z.ZodString>;
    location: z.ZodOptional<z.ZodObject<{
        file: z.ZodString;
        line: z.ZodNumber;
        col: z.ZodNumber;
    }, z.core.$strict>>;
}, z.core.$strict>;
/** Inferred claim shape. */
export type Claim = z.infer<typeof ClaimSchema>;
//# sourceMappingURL=claim.d.ts.map