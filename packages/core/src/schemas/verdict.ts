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
 * select its next action. `DIAGNOSTIC_*` codes advise on the separate
 * diagnostic run; `TEST_MAP_OUT_OF_SYNC` advises on generated mappings.
 * These report advisories are never obligation verdicts. The seven verdict
 * VALUES are unchanged; causes enrich reports without weakening contracts.
 */
export const CauseCodeSchema = z.enum([
  'TEST_INVENTORY_INCOMPLETE',
  'TEST_KIND_UNKNOWN',
  'TEST_MAPPING_MISSING',
  'TEST_MAPPING_AMBIGUOUS',
  'TEST_MAPPING_STALE',
  'TEST_MAP_OUT_OF_SYNC',
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
  'ENDPOINT_BEHAVIOR_MISSING',
  'BEHAVIOR_REFERENCE_STALE',
  'BEHAVIOR_CASE_UNMAPPED',
  'BEHAVIOR_CASE_MISSING',
  'BEHAVIOR_BINDING_MISMATCH',
  'BEHAVIOR_EFFECT_MISMATCH',
  'OBSERVATION_SCOPE_INCOMPLETE',
  'BEHAVIOR_UNEXPECTED_EFFECT',
  'ENFORCEMENT_BOUNDARY_UNVERIFIED',
  'RUNTIME_PREPARATION_FAILED',
  'RUNTIME_READINESS_FAILED',
  'QUARANTINE_EXPIRED',
  'MIGRATION_MISSING',
  'MIGRATION_LINEAGE_BROKEN',
  'MIGRATION_DOWNGRADE_NOOP',
  'MIGRATION_DRIFT',
  'MIGRATION_ROUNDTRIP_FAILED',
  'MIGRATION_DATA_LOST',
  'MIGRATION_CONFLICT',
  'MIGRATION_SCRATCH_UNSAFE',
  'ADAPTER_CANNOT_WITNESS',
  'ADAPTER_VOLATILE_FIELD_SKIPPED',
  'TWIN_PATH_DIVERGENT',
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
  TEST_MAP_OUT_OF_SYNC: 'gateforge tests sync',
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
  ENDPOINT_BEHAVIOR_MISSING: 'Owner defines endpoint behavior; agent cannot exclude it',
  BEHAVIOR_REFERENCE_STALE: 'Repair reviewed references and rerun',
  BEHAVIOR_CASE_UNMAPPED: 'Reuse/map a suitable test, or add thin overlay proof',
  BEHAVIOR_CASE_MISSING: 'Execute the case through its required channel',
  BEHAVIOR_BINDING_MISMATCH: 'Repair wrong path/record binding; no label changes as proof',
  BEHAVIOR_EFFECT_MISMATCH: 'Fix the application or owner-reviewed expectation',
  OBSERVATION_SCOPE_INCOMPLETE: 'Supply a working trusted observer or fix collection',
  BEHAVIOR_UNEXPECTED_EFFECT: 'Fix application side effect',
  ENFORCEMENT_BOUNDARY_UNVERIFIED: 'Owner provisions/verifies runtime',
  RUNTIME_PREPARATION_FAILED:
    'Repair the tracked `runtime.prepare` command (its failure log is under run state `runtime/`) — ' +
    'the candidate runtime must build or install before the gate can execute',
  QUARANTINE_EXPIRED:
    'Owner: renew or delete the expired quarantine (`gateforge quarantine <testKey> --owner --approver --reason --expires`); an expired quarantine blocks',
  RUNTIME_READINESS_FAILED:
    'Repair the tracked `runtime.services` command or readiness probe — the candidate ' +
    'runtime must become ready before evidence is trusted',
  MIGRATION_MISSING: 'Write an Alembic revision for the changed model, then run `gateforge check`',
  MIGRATION_LINEAGE_BROKEN:
    'Repair the migration chain so it has one head, unique revision ids, and existing parents, then run `gateforge check`',
  MIGRATION_DOWNGRADE_NOOP:
    'Implement downgrade() so the chain round-trips, or pin the revision in `alembic.irreversible`, then run `gateforge check`',
  MIGRATION_DRIFT: 'Make `alembic check` clean against the models, then run `gateforge check`',
  MIGRATION_ROUNDTRIP_FAILED:
    'Fix the migration so upgrade, downgrade base, and upgrade head succeed on a disposable database, then run `gateforge check`',
  MIGRATION_DATA_LOST: 'Preserve declared table rows across the upgrade, then run `gateforge check`',
  MIGRATION_CONFLICT: 'Rebase onto the target head and merge the named revisions, then run `gateforge check`',
  MIGRATION_SCRATCH_UNSAFE:
    'Set `alembic.scratch.adminUrl` to a trusted disposable Postgres admin URL. The engine only creates and drops `gf_tmp_` databases',
  ADAPTER_CANNOT_WITNESS:
    'Give the adapter a complete paged collection read (or a natural key) so a create can be proven; until then the engine cannot witness that obligation',
  ADAPTER_VOLATILE_FIELD_SKIPPED:
    'Review the adapter: it declares this field server-computed, so the entered value was not echo-checked. Drop the declaration if the app should store what was entered',
  TWIN_PATH_DIVERGENT:
    'Make the raw test and its witnessed twin send the same request: align the shared helper defaults, or map the pair with `twinOf`',
});
