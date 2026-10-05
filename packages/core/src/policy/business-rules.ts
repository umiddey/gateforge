/**
 * Owner-declared BUSINESS RULES evaluator (plan 2026-10-05 §4/D4).
 *
 * Pure and deterministic, exactly like the closed-world coverage
 * evaluator it is modelled on: given the owner rules, the type table,
 * the resolver's rule bindings, the derived test catalog and (optionally)
 * the SEALED facts of one run, it returns one status per rule case plus
 * typed findings. It never reads a file, never reads an environment
 * variable and never mutates its inputs.
 *
 * The four statuses, and the honesty each one carries:
 *
 * | status       | meaning                                                          |
 * |--------------|------------------------------------------------------------------|
 * | `unmapped`   | no gradeable binding of an accepted kind exists                   |
 * | `wrong-type` | bindings exist, but none of an accepted kind/runner              |
 * | `unproven`   | mapped, but no sealed run / not executed / outside the graded     |
 * |              | slice / missing the type's proof                                  |
 * | `failing`    | a mapped test of an accepted kind failed                          |
 * | `satisfied`  | EVERY mapped test of an accepted kind passed with the type's      |
 * |              | proof; the report names the channel (`satisfied (observe)`)       |
 *
 * Invariants this function is built to hold:
 * - a DECLARATION is never proof — a mapping alone is at best `unmapped`
 *   resolved into `unproven` until a sealed run says otherwise;
 * - no WEAKER kind satisfies a stronger type (the type table is
 *   closed-world; a row never inherits another row's kinds);
 * - a mocked spec, a quarantined test (dropped by the resolver before
 *   this call) and an inferred-only binding never satisfy;
 * - a GREEN sibling never forgives a RED one — one failing mapped test
 *   makes the whole case `failing`;
 * - findings sort by rule id then case id, so the same inputs always
 *   produce the same output.
 */
import { compareStrings } from '../graph/util.js';
import {
  BUSINESS_RULE_TYPE_TABLE,
  businessRuleClaimId,
  casesOf,
  type BusinessRule,
  type BusinessRuleCaseStatus,
  type BusinessRuleTestType,
  type BusinessRuleTypeRow,
} from '../schemas/business-rules.js';
import { CAUSE_NEXT_ACTIONS, type CauseCode } from '../schemas/verdict.js';
import type { EvidenceRecord } from '../schemas/evidence.js';

/** The record kind a `browser-e2e` binding must have produced. */
const BROWSER_ANCHOR_KIND = 'ui.action';

/** The record kind an `observed-e2e` binding must have produced. */
const OBSERVED_EXCHANGE_KIND = 'http.request';

/** One bound test, as the resolver produced it (a DECLARATION, not proof). */
export interface BusinessRuleBinding {
  /** Stable catalog logical key the declaration resolves to. */
  logicalKey: string;
  /** Declaration origin; only `native`/`sidecar` grade. */
  origin: 'native' | 'sidecar' | 'inferred' | 'prior-run';
  /** Declared kind, when the declaration named one. */
  declaredKind: string | null;
  /** Runner the bound instances execute under. */
  runner: string;
  /** True when discovery observed the spec mocking the system under test. */
  mocked: boolean;
  /** The sidecar declaration's review reason, when present. */
  reason: string | null;
  /** The test's source file (repo-relative), for starter-test rendering. */
  file: string;
}

/** One test's SEALED facts of the run being graded. */
export interface BusinessRuleTestFact {
  /** Catalog logical key. */
  logicalKey: string;
  /** Runner the sealed run executed it under. */
  runner: string;
  /** Outcome the supervision observed (never the reporter's own summary). */
  status: 'passed' | 'failed' | 'skipped' | 'fixme' | 'not-run';
  /**
   * Whether the sealed run's GRADED SLICE selected this test. False on a
   * `--scope changed` run that did not select it: the case is reported as
   * `unproven (outside this run's graded slice)`, never silently absent
   * and never satisfied by a receipt that never covered it.
   */
  inGradedSlice: boolean;
  /** Witness session ids the sealed run attributed to this test. */
  sessionIds: readonly string[];
}

/**
 * The sealed facts one run makes available to the evaluator. `null`
 * (no sealed run) is the honest static-`check` input: everything mapped
 * is `unproven` until a run exists.
 */
export interface BusinessRuleRunFacts {
  /** The receipt's evaluation scope. */
  scope: 'full' | 'changed';
  /** True for the engine-owned docs-only slice (zero records by construction). */
  docsOnly: boolean;
  /** Per-test sealed facts keyed by catalog logicalKey. */
  tests: ReadonlyMap<string, BusinessRuleTestFact>;
  /** The sealed run's witness evidence records. */
  records: readonly EvidenceRecord[];
  /** Runners whose suite the owner declared WITNESSED for this run. */
  witnessedRunners: ReadonlySet<string>;
}

/** Configuration error: a rule names a subject the inventory cannot see. */
export interface BusinessRuleConfigError {
  /** Always `BUSINESS_RULE_SUBJECT_UNKNOWN`. */
  code: 'BUSINESS_RULE_SUBJECT_UNKNOWN';
  /** The rule the error is scoped to. */
  ruleId: string;
  /** The unknown subject name. */
  subject: string;
  /** Single-cause explanation; callers turn this into exit 2. */
  detail: string;
}

/** One typed rule finding (blocking or advisory, decided by the caller). */
export interface BusinessRuleFinding {
  /** Stable finding code; equal to `cause`. */
  code: CauseCode;
  /** The report cause code. */
  cause: CauseCode;
  /** Owning rule id. */
  ruleId: string;
  /** Owning case id. */
  caseId: string;
  /** The claim id the case is mapped by. */
  claimId: string;
  /** Single-cause explanation naming the rule, the case and the gap. */
  detail: string;
  /** The shared next action for this cause. */
  nextAction: string;
  /** The mapped test keys the finding is about (sorted, possibly empty). */
  tests: readonly string[];
}

/** One graded rule case. */
export interface BusinessRuleCaseResult {
  /** Owning rule id. */
  ruleId: string;
  /** Owning case id. */
  caseId: string;
  /** The claim id this case is mapped by. */
  claimId: string;
  /** The graded status. */
  status: BusinessRuleCaseStatus;
  /** The proof channel when satisfied (e.g. `observe`), else null. */
  channel: string | null;
  /** Sorted logical keys of the gradeable mapped tests. */
  mappedTests: readonly string[];
  /** The typed finding when the case is not satisfied; null when satisfied. */
  finding: BusinessRuleFinding | null;
}

/**
 * Whether the sealed run holds a record of `kind` attributable to one of
 * the test's own witness sessions. This is the WP3 attribution: the run's
 * session trace joins a test to its session ids, and a record carrying
 * `payload.sessionId` joins the session back to the test — no obligation
 * claim is involved anywhere in that join.
 */
function sessionProves(
  facts: BusinessRuleRunFacts,
  sessionIds: readonly string[],
  kind: string,
): boolean {
  if (sessionIds.length === 0) return false;
  const sessions = new Set(sessionIds);
  return facts.records.some((record) => {
    if (record.kind !== kind) return false;
    const session = sessionIdOf(record);
    return session !== null && sessions.has(session);
  });
}

/** The complete evaluator result. */
export interface BusinessRuleEvaluation {
  configErrors: BusinessRuleConfigError[];
  /** Every case of every rule, sorted by rule id then case id. */
  cases: BusinessRuleCaseResult[];
}

/** Inputs of {@link evaluateBusinessRules}. */
export interface EvaluateBusinessRulesInput {
  /** The owner rules, already validated. */
  rules: readonly BusinessRule[];
  /** Resolved rule bindings keyed by claim id. */
  bindings: ReadonlyMap<string, readonly BusinessRuleBinding[]>;
  /** The resource names this run discovered (validates `subject`). */
  inventory: readonly string[];
  /** The sealed run's facts, or null when no sealed run exists. */
  runFacts: BusinessRuleRunFacts | null;
  /** Type table override (tests); defaults to the shipped table. */
  typeTable?: Readonly<Record<BusinessRuleTestType, BusinessRuleTypeRow>>;
}

/** Statuses ordered by how badly a case is doing (worst first). */
const STATUS_SEVERITY: Readonly<Record<BusinessRuleCaseStatus, number>> = Object.freeze({
  unmapped: 0,
  'wrong-type': 1,
  failing: 2,
  unproven: 3,
  satisfied: 4,
});

/** The session id a record was stamped under, when it carries one. */
function sessionIdOf(record: EvidenceRecord): string | null {
  const payload = record.payload;
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const value = (payload as Record<string, unknown>)['sessionId'];
  return typeof value === 'string' && value.length > 0 ? value : null;
}


/** The record kind a binding's accepted test kind must have produced. */
function anchorKindFor(kind: string): string | null {
  if (kind === 'browser-e2e') return BROWSER_ANCHOR_KIND;
  if (kind === 'observed-e2e') return OBSERVED_EXCHANGE_KIND;
  return null;
}

/** What one mapped test of an accepted kind fails to prove, or null when it does. */
interface Unproven {
  readonly logicalKey: string;
  readonly detail: string;
}

/** Grades one accepted binding against the sealed facts. */
function gradeBinding(
  binding: BusinessRuleBinding,
  kind: string,
  row: BusinessRuleTypeRow,
  facts: BusinessRuleRunFacts | null,
): { failing: string | null; unproven: Unproven | null } {
  if (facts === null) {
    return {
      failing: null,
      unproven: {
        logicalKey: binding.logicalKey,
        detail:
          `test '${binding.logicalKey}' is mapped but no sealed supervised run exists yet — ` +
          'a mapping is a declaration, never a proof (`gateforge test-gates`)',
      },
    };
  }
  const fact = facts.tests.get(binding.logicalKey);
  if (fact === undefined) {
    return {
      failing: null,
      unproven: {
        logicalKey: binding.logicalKey,
        detail:
          `test '${binding.logicalKey}' is mapped but the sealed run did not execute it — ` +
          'a test that did not run proves nothing',
      },
    };
  }
  if (!fact.inGradedSlice) {
    return {
      failing: null,
      unproven: {
        logicalKey: binding.logicalKey,
        detail:
          `test '${binding.logicalKey}' is mapped but sits outside this run's graded slice ` +
          `(scope '${facts.scope}') — re-run without the narrowed scope, or let the slice select it`,
      },
    };
  }
  if (fact.status === 'failed') {
    return { failing: binding.logicalKey, unproven: null };
  }
  if (fact.status !== 'passed') {
    return {
      failing: null,
      unproven: {
        logicalKey: binding.logicalKey,
        detail:
          `test '${binding.logicalKey}' is mapped but the sealed run recorded it as ` +
          `'${fact.status}' — only a passing run proves the rule`,
      },
    };
  }
  if (row.requiresWitnessedSuite && !facts.witnessedRunners.has(row.runner)) {
    return {
      failing: null,
      unproven: {
        logicalKey: binding.logicalKey,
        detail:
          `test '${binding.logicalKey}' passed, but no WITNESSED ${row.runner} suite ran in the ` +
          `sealed run — mark the suite witnessed (\`diagnostics.suites[].witnessed\` in .gateforge.yml); ` +
          'an unwitnessed suite is not proof',
      },
    };
  }
  const anchor = anchorKindFor(kind);
  if (anchor !== null && !sessionProves(facts, fact.sessionIds, anchor)) {
    return {
      failing: null,
      unproven: {
        logicalKey: binding.logicalKey,
        detail:
          `test '${binding.logicalKey}' passed but produced no '${anchor}' witness record ` +
          'attributable to its own session — a ' + kind + ' test must run on the Gateforge fixture ' +
          "(`@gate-forge/pack-playwright/fixture`) so the witness sees the journey",
      },
    };
  }
  return { failing: null, unproven: null };
}

/**
 * Grades one rule case. Pure; `bindings` are the case's gradeable
 * bindings (the resolver has already dropped quarantined and stale
 * ones).
 */
function gradeCase(
  rule: BusinessRule,
  caseId: string,
  describe: string,
  bindings: readonly BusinessRuleBinding[],
  typeTable: Readonly<Record<BusinessRuleTestType, BusinessRuleTypeRow>>,
  facts: BusinessRuleRunFacts | null,
): BusinessRuleCaseResult {
  const claimId = businessRuleClaimId(rule.id, caseId);
  const row = typeTable[rule.test];
  const gradeable = bindings.filter((binding) => binding.origin === 'native' || binding.origin === 'sidecar');
  const mappedTests = [...new Set(gradeable.map((binding) => binding.logicalKey))].sort(compareStrings);
  const finding = (code: CauseCode, detail: string, tests: readonly string[]): BusinessRuleFinding => ({
    code,
    cause: code,
    ruleId: rule.id,
    caseId,
    claimId,
    detail: `business rule '${rule.id}' case '${caseId}' (${describe}): ${detail}`,
    nextAction: CAUSE_NEXT_ACTIONS[code],
    tests,
  });

  if (gradeable.length === 0) {
    return {
      ruleId: rule.id,
      caseId,
      claimId,
      status: 'unmapped',
      channel: null,
      mappedTests: [],
      finding: finding(
        'BUSINESS_RULE_TEST_MISSING',
        `no test is mapped for this case; the rule needs a '${row.label}' test ` +
          `(${row.acceptedKinds.join(' or ')}) — \`gateforge next\` prints a starter and the exact mark command`,
        [],
      ),
    };
  }

  const accepted = gradeable.filter(
    (binding) => row.acceptedKinds.includes(binding.declaredKind ?? '') && binding.runner === row.runner,
  );
  if (accepted.length === 0) {
    const kinds = [...new Set(gradeable.map((binding) => binding.declaredKind ?? 'undeclared'))].sort(compareStrings);
    return {
      ruleId: rule.id,
      caseId,
      claimId,
      status: 'wrong-type',
      channel: null,
      mappedTests,
      finding: finding(
        'BUSINESS_RULE_TEST_TYPE_MISMATCH',
        `the ${kinds.join('/')} test(s) mapped to this case cannot prove a '${row.label}' rule: ` +
          `this type accepts ${row.acceptedKinds.join(' or ')} under runner '${row.runner}' ` +
          '(a weaker kind never satisfies a stronger type)',
        mappedTests,
      ),
    };
  }

  const unmocked = accepted.filter((binding) => !binding.mocked);
  const failing: string[] = [];
  const unproven: Unproven[] = [];
  const channels = new Set<string>();
  for (const binding of unmocked) {
    const kind = binding.declaredKind as string;
    const graded = gradeBinding(binding, kind, row, facts);
    if (graded.failing !== null) failing.push(graded.failing);
    if (graded.unproven !== null) unproven.push(graded.unproven);
    if (graded.failing === null && graded.unproven === null) {
      channels.add(row.kindChannels[kind] ?? row.defaultChannel);
    }
  }
  const acceptedTests = [...new Set(accepted.map((binding) => binding.logicalKey))].sort(compareStrings);

  if (unmocked.length < accepted.length) {
    const mockedKeys = accepted.filter((binding) => binding.mocked).map((binding) => binding.logicalKey);
    unproven.push({
      logicalKey: mockedKeys.sort(compareStrings)[0] ?? '',
      detail:
        `test(s) ${mockedKeys.sort(compareStrings).join(', ')} mock the system under test — ` +
        "a mocked spec never proves an end-to-end rule (the catalog observed an interception in the file)",
    });
  }

  if (failing.length > 0) {
    const failed = [...new Set(failing)].sort(compareStrings);
    return {
      ruleId: rule.id,
      caseId,
      claimId,
      status: 'failing',
      channel: null,
      mappedTests,
      finding: finding(
        'BUSINESS_RULE_TEST_FAILING',
        `mapped test(s) ${failed.join(', ')} failed in the sealed run; every mapped test of a case ` +
          'must pass (a green sibling never forgives a red one)',
        failed,
      ),
    };
  }
  if (unproven.length > 0) {
    const sorted = [...unproven].sort((a, b) => compareStrings(a.logicalKey, b.logicalKey));
    return {
      ruleId: rule.id,
      caseId,
      claimId,
      status: 'unproven',
      channel: null,
      mappedTests,
      finding: finding(
        'BUSINESS_RULE_TEST_UNPROVEN',
        sorted.map((entry) => entry.detail).join('; '),
        sorted.map((entry) => entry.logicalKey).filter((key) => key.length > 0),
      ),
    };
  }
  return {
    ruleId: rule.id,
    caseId,
    claimId,
    status: 'satisfied',
    channel: [...channels].sort(compareStrings).join('+') || row.defaultChannel,
    mappedTests,
    finding: null,
  };
}

/**
 * Grades every case of every rule. A rule with no `subject` is graded
 * regardless of the inventory; a rule naming a subject the inventory
 * cannot see is a CONFIGURATION ERROR (the caller exits 2) because a name
 * the inventory cannot see is silently uncheckable.
 *
 * Args:
 *   input: rules, resolved bindings, the run's resource inventory, and the
 *     sealed run's facts (`null` when no sealed run exists).
 *
 * Returns:
 *   BusinessRuleEvaluation: config errors plus every case, sorted by rule
 *   id then case id.
 */
export function evaluateBusinessRules(input: EvaluateBusinessRulesInput): BusinessRuleEvaluation {
  const typeTable = input.typeTable ?? BUSINESS_RULE_TYPE_TABLE;
  const inventory = new Set(input.inventory);
  const configErrors: BusinessRuleConfigError[] = [];
  const cases: BusinessRuleCaseResult[] = [];
  const rules = [...input.rules].sort((a, b) => compareStrings(a.id, b.id));
  for (const rule of rules) {
    if (rule.subject !== undefined && !inventory.has(rule.subject)) {
      configErrors.push({
        code: 'BUSINESS_RULE_SUBJECT_UNKNOWN',
        ruleId: rule.id,
        subject: rule.subject,
        detail:
          `business rule '${rule.id}' names subject '${rule.subject}', which is not present in the ` +
          'current resource inventory; a subject the inventory cannot see is silently uncheckable, so ' +
          'the run fails as a configuration error (ranking and display only — a subject is never proof)',
      });
      continue;
    }
    for (const businessCase of casesOf(rule)) {
      const claimId = businessRuleClaimId(rule.id, businessCase.id);
      cases.push(
        gradeCase(rule, businessCase.id, businessCase.describe, input.bindings.get(claimId) ?? [], typeTable, input.runFacts),
      );
    }
  }
  cases.sort(
    (a, b) => compareStrings(a.ruleId, b.ruleId) || compareStrings(a.caseId, b.caseId),
  );
  return { configErrors, cases };
}

/**
 * The CLOSED table of cause codes a business-rule finding can carry.
 *
 * One table, one purpose: the gate's forgiveness layers ask "is this
 * finding a business rule?" before they forgive anything. The adopted
 * baseline forgives debt the OWNER recorded before adopting; a rule the
 * owner wrote in the pinned answers document is not pre-existing debt,
 * and a finding about it must never be silently waived by a fingerprint
 * that happens to match (plan invariant 2: rules are owner-pinned, so
 * an agent cannot weaken or forgive one).
 *
 * Keyed over `string`, not `CauseCode`: every call site reads a blocking
 * entry's cause, which is nullable, so a `Record<CauseCode, true>` index
 * would force each caller to re-narrow before it could even ask. The
 * four values are still literal cause codes, and a fifth status cannot
 * ship without landing here.
 */
export const BUSINESS_RULE_CAUSES: Record<string, true> = {
  BUSINESS_RULE_TEST_MISSING: true,
  BUSINESS_RULE_TEST_TYPE_MISMATCH: true,
  BUSINESS_RULE_TEST_UNPROVEN: true,
  BUSINESS_RULE_TEST_FAILING: true,
};

/** Whether a case result is one of the four findings the gate reports. */
export function isBusinessRuleFinding(
  result: BusinessRuleCaseResult,
): result is BusinessRuleCaseResult & { finding: BusinessRuleFinding } {
  return result.finding !== null;
}

/** Worst status among a rule's cases (`satisfied` when it has none). */
export function worstBusinessRuleStatus(results: readonly BusinessRuleCaseResult[]): BusinessRuleCaseStatus {
  let worst: BusinessRuleCaseStatus = 'satisfied';
  for (const result of results) {
    if (STATUS_SEVERITY[result.status] < STATUS_SEVERITY[worst]) worst = result.status;
  }
  return worst;
}