/**
 * Verdict + UnresolvedReason schemas (ADR 0001 seven verdicts, pin #5
 * unresolved-entry shape). The pure evaluator itself lives in
 * `src/verdict` (G3); these are the frozen data shapes it speaks.
 */
import { z } from 'zod';
import { LocationSchema } from './common.js';

/**
 * The seven verdicts. Blocking (non-clean) verdicts: `missing`,
 * `invalid`, `unclassified`, `unresolved`, `stale`. Clean: `satisfied`,
 * `waived`.
 */
export const VerdictSchema = z.enum([
  'satisfied',
  'missing',
  'invalid',
  'unclassified',
  'unresolved',
  'waived',
  'stale',
]);

/** Inferred verdict shape. */
export type Verdict = z.infer<typeof VerdictSchema>;

/** Machine-readable reason attached to `unresolved` verdicts. */
export const UnresolvedReasonSchema = z
  .object({
    /** Short stable code, e.g. `no_tablename_source`, `E_TIMEOUT`. */
    code: z.string().min(1),
    /** Single-cause human explanation (no stack dumps). */
    detail: z.string().min(1),
    /** Source location the reason points at. */
    location: LocationSchema,
  })
  .strict();

/** Inferred unresolved-reason shape. */
export type UnresolvedReason = z.infer<typeof UnresolvedReasonSchema>;
