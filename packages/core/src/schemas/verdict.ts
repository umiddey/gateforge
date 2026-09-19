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

/**
 * Stable cause codes for the shared report model (plan §5.4, ADR 0005).
 * Blocking-obligation causes name WHY an obligation is not satisfied and
 * select its next action; the three `DIAGNOSTIC_*` codes are advisory
 * result causes for the separate diagnostic run (plan §3.5) — never
 * obligation verdicts. The seven verdict VALUES are unchanged; causes
 * enrich them without weakening any contract.
 */
export const CauseCodeSchema = z.enum([
  'TEST_INVENTORY_INCOMPLETE',
  'TEST_KIND_UNKNOWN',
  'TEST_MAPPING_MISSING',
  'TEST_MAPPING_AMBIGUOUS',
  'TEST_MAPPING_STALE',
  'EVIDENCE_NOT_COLLECTED',
  'VERIFIER_UNSUPPORTED',
  'TEST_NOT_EXECUTED',
  'TEST_FAILED',
  'RUN_INCOMPLETE',
  'EVIDENCE_STALE',
  'CHANGE_UNMAPPED',
  'EVIDENCE_SCOPE_INCOMPLETE',
  'ENFORCEMENT_UNTRUSTED',
  'EVIDENCE_VALUE_MISMATCH',
  'SERVER_PROBE_UNAVAILABLE',
  'CRUD_COVERAGE_MISSING',
  'DIAGNOSTIC_TEST_FAILURE',
  'DIAGNOSTIC_RUN_INCOMPLETE',
  'DIAGNOSTIC_RESULT_STALE',
]);

/** Inferred cause-code union. */
export type CauseCode = z.infer<typeof CauseCodeSchema>;

/**
 * The plan §5.4 next action per cause code. Text, JSON, and SARIF
 * renderings all carry the same strings so every surface agrees on what
 * to do next.
 */
export const CAUSE_NEXT_ACTIONS: Readonly<Record<CauseCode, string>> = Object.freeze({
  TEST_INVENTORY_INCOMPLETE: 'Repair discovery or register a supported adapter',
  TEST_KIND_UNKNOWN: 'Inspect and declare its kind',
  TEST_MAPPING_MISSING:
    'Overlay: write `tests/e2e/gateforge/<resource>.<op>.spec.js`. Do not `tests mark` as a fix ' +
    '— that cannot satisfy the obligation.',
  TEST_MAPPING_AMBIGUOUS: 'Correct the exact mapping',
  TEST_MAPPING_STALE: 'Correct the exact mapping',
  EVIDENCE_NOT_COLLECTED:
    'Write an overlay test in `tests/e2e/gateforge/` using the Gateforge Playwright fixture ' +
    '(`evidence.ui.*` + `persistence.verify`). Do not rewrite existing journeys. Mappings ' +
    '(`tests mark`) are intent, not proof.',
  VERIFIER_UNSUPPORTED:
    'Remove this contract from `.gateforge/policies.yml` or drop the pack. Do not add tests.',
  TEST_NOT_EXECUTED: 'Run or repair the selected suite',
  TEST_FAILED: 'Run or repair the selected suite',
  RUN_INCOMPLETE: 'Run or repair the selected suite',
  EVIDENCE_STALE: 'Rerun for the exact candidate',
  CHANGE_UNMAPPED:
    'Map detection or add an overlay test for the changed resource. Do not weaken policy.',
  EVIDENCE_SCOPE_INCOMPLETE:
    'Map a test to the uncovered obligation (`gateforge tests mark`) or run full scope ' +
    '(`test-gates --changed` without `--scope changed`)',
  ENFORCEMENT_UNTRUSTED: 'Repair enforcement setup',
  EVIDENCE_VALUE_MISMATCH: 'Fix the mutation path or correct the mapping',
  SERVER_PROBE_UNAVAILABLE:
    'Export/repair the adapter server probe (probeServer) so the witness can observe the database engine-side',
  CRUD_COVERAGE_MISSING:
    'Owner: add an overlay test, or record a disposition in trusted `coveragePolicy` ' +
    '(agents must not edit coveragePolicy).',
  DIAGNOSTIC_TEST_FAILURE: 'Inspect the named test, assertion, and relevant application code',
  DIAGNOSTIC_RUN_INCOMPLETE:
    'Repair the run; an incomplete diagnostic run never displays as passing',
  DIAGNOSTIC_RESULT_STALE: 'Rerun the diagnostic suite for the exact candidate',
});
