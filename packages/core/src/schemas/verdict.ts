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
  'RESOURCE_SINGLETON_PER_TENANT',
  'RESPONSE_FIELD_MISSING_FROM_MODEL',
  'TWIN_PATH_DIVERGENT',
  'BUSINESS_RULE_TEST_MISSING',
  'BUSINESS_RULE_TEST_TYPE_MISMATCH',
  'BUSINESS_RULE_TEST_UNPROVEN',
  'BUSINESS_RULE_TEST_FAILING',
  // The HTTP call rules (0.14 WP3, plan §4.3 R2-R4): a call the
  // product makes that no route serves, several routes serve equally,
  // or no static join could resolve. Report-only by default
  // (`http.callFindings`); blocking only when the owner declares it.
  'HTTP_CALL_UNMATCHED',
  'HTTP_CALL_AMBIGUOUS',
  'HTTP_CALL_UNRESOLVED',
  'HTTP_ROUTE_NOT_INVENTORIED',
  // 0.14 WP4: the witness's body-vs-model check. A mismatch is a finding
  // (report-only under `http.responseShape: report`); an over-cap body is
  // refused, never silently passed.
  'HTTP_RESPONSE_SHAPE_MISMATCH',
  'HTTP_BODY_TOO_LARGE',
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
    'Attribute the change with `gateforge explain <file>` (it prints what the file is and what ' +
    'governs it): map the detected resource, declare documentation folders with ' +
    '`gateforge init --docs-exclude <folders>`, or add the detection that owns the file. ' +
    'Do not weaken policy.',
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
  RESOURCE_SINGLETON_PER_TENANT:
    'Witness this create on a fresh tenant: the unique constraint admits one row per tenant, so ' +
    "register the new tenant's login with the witness for THIS session only " +
    '(POST /sessions/identity) and prove the create there',
  RESPONSE_FIELD_MISSING_FROM_MODEL:
    'The frontend reads a field the response model does not declare: restore the field on the ' +
    'response model (or read the one it declares). A test that mocks the response proves nothing ' +
    'about this read',
  TWIN_PATH_DIVERGENT:
    'Make the raw test and its witnessed twin send the same request: align the shared helper defaults, or map the pair with `twinOf`',
  BUSINESS_RULE_TEST_MISSING:
    'Write the test the rule names (a starter is printed by `gateforge next`), then map it with ' +
    '`gateforge tests mark --rule <rule>/<case> --test <file>#<title> --kind <kind> --reason "…"`. ' +
    'A mapping alone is a declaration, never a proof.',
  BUSINESS_RULE_TEST_TYPE_MISMATCH:
    'Map a test of the type the rule names (`gateforge tests explain` lists the accepted kinds): a ' +
    'weaker test kind never satisfies a stronger rule type.',
  BUSINESS_RULE_TEST_UNPROVEN:
    'Run the mapped test under supervision for this exact candidate (`gateforge test-gates`). A case ' +
    'with no passing, witnessed run is `unproven`, never satisfied.',
  BUSINESS_RULE_TEST_FAILING:
    'Fix the mapped test or the behaviour it proves: every mapped test of a case must pass (a green ' +
    'sibling never forgives a red one).',
  HTTP_ROUTE_NOT_INVENTORIED:
    'The app answered but the route inventory is incomplete; check the detector for this framework',
  HTTP_CALL_UNMATCHED:
    'A witnessed call matches no served route: fix the caller URL or serve the route it means; ' +
    'an unresolvable call is an application bug, not a missing test',
  HTTP_CALL_AMBIGUOUS:
    'A witnessed call matches several routes equally: make the routes distinguishable ' +
    '(or record the router\'s registration order) so exactly one can answer the call',
  HTTP_CALL_UNRESOLVED:
    'The static join cannot compute this call\'s URL: declare the wrapper/base URL in the ' +
    'endpoint scan configuration so the call site resolves instead of staying invisible',
  HTTP_RESPONSE_SHAPE_MISMATCH:
    'A witnessed response body does not match the response schema the app declares in its OpenAPI ' +
    'document: fix the handler so the body matches the declared model, or fix the declared schema if it is wrong',
  HTTP_BODY_TOO_LARGE:
    'A witnessed response body exceeds the 1 MiB check cap, so its shape cannot be verified: ' +
    'return a smaller body for this route or exclude it from the body check',
});
