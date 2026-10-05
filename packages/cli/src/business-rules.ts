/**
 * The CLI seam for owner-declared BUSINESS RULES
 * (plan 2026-10-05 §5 D3/D4/D5, WP4).
 *
 * One module owns every fact a rule needs, because the three consumers
 * — `check`, `next` and `tests mark`/`explain` — must never disagree
 * about what a case is worth:
 *
 * - the OWNER rules come from the owner-answers document, which the
 *   pipeline already read (never a second read of the same file);
 * - the CLAIM IDS come from the cases those rules declare, and are what
 *   the one mapping resolver validates a `business-rule:` claim against;
 * - the RUN FACTS come from a SEALED execution result plus the sealed
 *   records and the owner's WITNESSED suite declarations. A run with no
 *   sealed execution result passes `null`, and `null` grades everything
 *   mapped as `unproven` — a declaration is never proof.
 *
 * Two invariants this module exists to hold:
 * - **run-wide.** Rule grading reads the FULL rule list and the FULL
 *   rule bindings, never the changed-file selection, so a `--scope
 *   changed` run cannot scope a rule away. A case whose test sits
 *   outside that run's graded slice is reported as `unproven (outside
 *   this run's graded slice)` — visible, not absent, and never
 *   satisfied by a receipt that never covered it.
 * - **advisory never hides.** `enforcement: advisory` routes a case's
 *   finding into the report's existing `advisories` channel; only
 *   `enforcement: block` findings reach `blocking` and the exit code.
 *   Both channels carry the same typed cause, and the channel is decided
 *   by the OWNER's declaration on the rule, never by a new severity.
 */
import {
  BUSINESS_RULE_TYPE_TABLE,
  businessRuleClaimId,
  EvidenceRecordSchema,
  casesOf,
  evaluateBusinessRules,
  type BlockingEntry,
  type BusinessRule,
  type BusinessRuleBinding,
  type BusinessRuleCaseResult,
  type BusinessRuleEvaluation,
  type BusinessRuleRunFacts,
  type BusinessRuleTestFact,
  type EvidenceRecord,
  type ExecutionResult,
  type GateforgeConfig,
  type ResourceGraph,
  type TestCatalog,
} from '@gate-forge/core';
import { UsageError } from './errors.js';

/** Every rule-case claim id this rule list declares, sorted. */
export function businessRuleClaimIds(rules: readonly BusinessRule[]): string[] {
  const ids = rules.flatMap((rule) =>
    casesOf(rule).map((entry) => businessRuleClaimId(rule.id, entry.id)),
  );
  return [...new Set(ids)].sort();
}

/** The runner each catalog row executes under, keyed by logical key. */
export function catalogRunnerIndex(catalog: TestCatalog): Map<string, string> {
  return new Map(catalog.entries.map((entry) => [entry.logicalKey, entry.runner]));
}

/**
 * The logical test keys whose FILE the catalog observed intercepting the
 * system under test. A mocked spec can never satisfy a rule: it proves
 * the mock, not the rule (plan invariant 6).
 */
export function mockedTestKeys(catalog: TestCatalog): Set<string> {
  return new Set(
    catalog.entries
      .filter((entry) => entry.suppressionSignals.some((signal) => signal.kind === 'mock'))
      .map((entry) => entry.logicalKey),
  );
}

/**
 * The resolver's rule bindings projected onto the evaluator's binding
 * shape. Pure; the resolver has already dropped quarantined, stale and
 * wildcard-rejected declarations, and the evaluator independently
 * refuses anything but `native`/`sidecar` origins.
 *
 * A binding whose selector bound no catalog instance contributes no
 * runner, which the evaluator reads as "not an accepted kind" rather
 * than guessing one: a declaration with no resolvable instance is not
 * proof of anything.
 */
export function businessRuleBindingsOf(
  ruleBindings: readonly { claimId: string; bindings: readonly ResolvedRuleBinding[] }[],
  runners: ReadonlyMap<string, string>,
  mockedKeys: ReadonlySet<string>,
): Map<string, readonly BusinessRuleBinding[]> {
  const bindings = new Map<string, readonly BusinessRuleBinding[]>();
  for (const claim of ruleBindings) {
    bindings.set(
      claim.claimId,
      claim.bindings.map((binding) => ({
        logicalKey: binding.logicalKey,
        origin: binding.origin,
        declaredKind: binding.declaredKind,
        runner: runners.get(binding.logicalKey) ?? '',
        mocked: mockedKeys.has(binding.logicalKey),
        reason: binding.reason,
        file: binding.instances[0]?.file ?? binding.logicalKey,
      })),
    );
  }
  return bindings;
}

/** The resolver binding shape this projection reads (narrow on purpose). */
interface ResolvedRuleBinding {
  logicalKey: string;
  origin: 'native' | 'sidecar' | 'inferred' | 'prior-run';
  declaredKind: string | null;
  reason: string | null;
  instances: readonly { runner: string; file: string }[];
}

/**
 * Reads the OWNER's declared `witnessed` diagnostic suites as the set of
 * runner names whose proof this repository can produce. A suite the
 * owner did not mark witnessed contributes nothing: the pytest row of
 * the type table requires one, and an unwitnessed suite is not proof
 * (owner decision, 2026-10-04).
 */
export function witnessedRunnersOf(config: GateforgeConfig): Set<string> {
  const runners = new Set<string>();
  for (const suite of config.diagnostics?.suites ?? []) {
    if (suite.witnessed === true) runners.add('pytest');
  }
  return runners;
}

/**
 * One test's sealed facts.
 *
 * The GRADED SLICE is the selection the supervisor fixed BEFORE the run:
 * a test the selection did not name is outside the slice even when the
 * runner happened to execute it, which is exactly the `--scope changed`
 * case the plan calls out. Status is the supervisor's own normalized
 * outcome, never a reporter summary.
 */
function testFactOf(
  result: ExecutionResult,
  logicalKey: string,
  executionKey: string,
  runners: ReadonlyMap<string, string>,
): BusinessRuleTestFact {
  const planned = result.planned.find((instance) => instance.logicalKey === executionKey);
  const outcome = result.outcomes.find((row) => row.logicalKey === executionKey);
  // The session trace joins on the INSTANCE identity (project, file,
  // title path). Runner adapters may use a reconciliation key in the
  // sealed result while the catalog and sidecar use the catalog key.
  const trace = (result.sessionTrace ?? []).find(
    (test) =>
      planned !== undefined &&
      test.file === planned.file &&
      test.project === planned.project &&
      test.titlePath.join('>') === planned.titlePath.join('>'),
  );
  return {
    logicalKey,
    runner: runners.get(logicalKey) ?? '',
    status: outcome?.status ?? 'not-run',
    inGradedSlice: result.selection.logicalKeys.includes(executionKey),
    sessionIds: (trace?.sessions ?? []).map((session) => session.sessionId),
  };
}

/** Stable join key shared by catalog, planned, and executed test instances. */
function instanceKey(project: string | null, file: string, titlePath: readonly string[]): string {
  return `${project ?? ''}\u0000${file}\u0000${titlePath.join('>')}`;
}

/** The sealed facts one run makes available, or null when no run exists. */
export interface BusinessRuleFactsInput {
  /** The sealed execution result, or null for a static `check` run. */
  result: ExecutionResult | null;
  /**
   * The run's authorized evidence records, exactly as `evaluateRun`
   * returned them (`unknown[]`: authorization is established, shape is
   * not). Validated here against the record schema; a record that does
   * not parse contributes no proof.
   */
  records: readonly unknown[];
  /** Runners whose suite the owner declared witnessed. */
  witnessedRunners: ReadonlySet<string>;
  /** The receipt's evaluation scope. */
  scope: 'full' | 'changed';
  /** True for the engine-owned docs-only slice (zero records by construction). */
  docsOnly: boolean;
  /** The run's catalog, for the runner each key executes under. */
  catalog: TestCatalog;
}

/**
 * Builds the evaluator's run facts from a SEALED execution result.
 *
 * Args:
 *   input: the sealed execution result (null when none exists), the
 *     sealed records, the witnessed runners, the receipt's scope, and the
 *     run's catalog.
 *
 * Returns:
 *   BusinessRuleRunFacts | null: the facts, or null for no sealed run —
 *   which is what makes a static `check` grade everything mapped as
 *   `unproven` instead of quietly satisfied.
 */
export function businessRuleRunFacts(input: BusinessRuleFactsInput): BusinessRuleRunFacts | null {
  if (input.result === null) return null;
  const runners = catalogRunnerIndex(input.catalog);
  const logicalKeyByInstance = new Map(
    input.catalog.entries.map((entry) => [
      instanceKey(entry.project, entry.file, entry.titlePath),
      entry.logicalKey,
    ]),
  );
  const logicalKeyOf = (
    project: string | null,
    file: string,
    titlePath: readonly string[],
    fallback: string,
  ): string => logicalKeyByInstance.get(instanceKey(project, file, titlePath)) ?? fallback;
  const tests = new Map<string, BusinessRuleTestFact>();
  // Planned instances first (the expected set), then any outcome for a
  // key the plan never listed: the plan is pre-run, the outcome is what
  // actually ran, and an executed-but-unplanned key is still a fact.
  for (const planned of input.result.planned) {
    const logicalKey = logicalKeyOf(planned.project, planned.file, planned.titlePath, planned.logicalKey);
    tests.set(logicalKey, testFactOf(input.result, logicalKey, planned.logicalKey, runners));
  }
  for (const outcome of input.result.outcomes) {
    const logicalKey = logicalKeyOf(outcome.project, outcome.file, outcome.titlePath, outcome.logicalKey);
    if (tests.has(logicalKey)) continue;
    tests.set(logicalKey, testFactOf(input.result, logicalKey, outcome.logicalKey, runners));
  }
  // Runner adapters use their reconciliation identity (`file#title`)
  // in execution results, while catalog/sidecar mappings use the
  // declared logical key (`pytest:suite:file:title`). Bridge only rows
  // from the runner whose execution this result records, and only when
  // the planned instance identifies one unambiguous catalog row.
  for (const entry of input.catalog.entries) {
    if (entry.runner !== input.result.selection.runner || tests.has(entry.logicalKey)) continue;
    const matchingInstances = input.result.planned.filter(
      (planned) =>
        planned.file === entry.file &&
        planned.titlePath.join('>') === entry.titlePath.join('>'),
    );
    const instance = matchingInstances[0];
    if (matchingInstances.length !== 1 || instance === undefined) continue;
    tests.set(entry.logicalKey, testFactOf(input.result, entry.logicalKey, instance.logicalKey, runners));
  }

  return {
    scope: input.scope,
    docsOnly: input.docsOnly,
    tests,
    records: authorizedRecords(input.records),
    witnessedRunners: input.witnessedRunners,
  };
}

/**
 * Validates the run's AUTHORIZED records into the typed shape the
 * evaluator reads.
 *
 * `evaluateRun` returns them as `unknown[]` because all that has been
 * established at that point is AUTHORIZATION, not shape. This is where
 * the shape is established: a record that does not parse contributes no
 * proof, which is the fail-closed direction. Parsing here rather than
 * asserting a type keeps a malformed or tampered ledger from being
 * attributed to a rule case.
 *
 * Args:
 *   records: the authorized, quarantine-filtered records.
 *
 * Returns:
 *   EvidenceRecord[]: the records that satisfy the schema, in input order.
 */
function authorizedRecords(records: readonly unknown[]): EvidenceRecord[] {
  const valid: EvidenceRecord[] = [];
  for (const record of records) {
    const parsed = EvidenceRecordSchema.safeParse(record);
    if (parsed.success) valid.push(parsed.data);
  }
  return valid;
}

/** Everything one rule-grading pass needs beyond the pipeline's own output. */
export interface BusinessRuleGradingInput {
  /** The owner's declared rules (empty = the feature is off). */
  rules: readonly BusinessRule[];
  /** The one resolver's rule bindings for this run. */
  ruleBindings: readonly { claimId: string; bindings: readonly ResolvedRuleBinding[] }[];
  /** The run's resource inventory (validates `subject`). */
  inventory: readonly string[];
  /** The sealed run's facts, or null when no sealed run exists. */
  runFacts: BusinessRuleRunFacts | null;
  /** The run's catalog (runner identity and observed mocking). */
  catalog: TestCatalog;
}

/**
 * Grades every declared rule case for one run.
 *
 * Args:
 *   input: rules, rule bindings, the inventory, the sealed facts and the
 *     catalog.
 *
 * Returns:
 *   BusinessRuleEvaluation: config errors plus every case result, sorted
 *   by rule id then case id.
 *
 * Throws:
 *   UsageError: when a rule names a `subject` the inventory cannot see
 *     (exit 2 — a silently uncheckable name is a configuration error, the
 *     same posture as an unknown coverage table).
 */
export function gradeBusinessRules(input: BusinessRuleGradingInput): BusinessRuleEvaluation {
  const evaluation = evaluateBusinessRules({
    rules: input.rules,
    bindings: businessRuleBindingsOf(
      input.ruleBindings,
      catalogRunnerIndex(input.catalog),
      mockedTestKeys(input.catalog),
    ),
    inventory: input.inventory,
    runFacts: input.runFacts,
  });
  if (evaluation.configErrors.length > 0) {
    const first = evaluation.configErrors[0];
    throw new UsageError(
      `${first?.detail ?? 'a business rule names an unknown subject'}${
        evaluation.configErrors.length > 1
          ? ` (and ${String(evaluation.configErrors.length - 1)} more business-rule configuration error(s))`
          : ''
      }`,
    );
  }
  return evaluation;
}

/** One case result projected onto the report's blocking-entry shape. */
function blockingEntryOf(result: BusinessRuleCaseResult): BlockingEntry {
  const finding = result.finding;
  return {
    kind: 'finding',
    resourceId: null,
    name: result.ruleId,
    detail: finding?.detail ?? '',
    location: null,
    cause: finding?.cause ?? 'BUSINESS_RULE_TEST_MISSING',
    nextAction: finding?.nextAction ?? '',
  };
}

/**
 * Splits a graded evaluation into the report's TWO channels.
 *
 * `enforcement: advisory` is decided by the OWNER's declaration on the
 * rule, not by how bad the case looks: an advisory rule's findings are
 * printed and serialized every run and only stay out of `blocking` and
 * the exit code (plan invariant 7). The codes are identical in both
 * channels, so a reader tells an advisory finding from a blocking one by
 * where it is, never by a new severity.
 */
export function partitionBusinessRuleEntries(
  rules: readonly BusinessRule[],
  cases: readonly BusinessRuleCaseResult[],
): { blocking: BlockingEntry[]; advisories: BlockingEntry[] } {
  const enforcement = new Map(rules.map((rule) => [rule.id, rule.enforcement]));
  const blocking: BlockingEntry[] = [];
  const advisories: BlockingEntry[] = [];
  for (const result of cases) {
    if (result.finding === null) continue;
    const entry = blockingEntryOf(result);
    if (enforcement.get(result.ruleId) === 'advisory') advisories.push(entry);
    else blocking.push(entry);
  }
  return { blocking, advisories };
}

/**
 * The resource names one run's inventory offers as a rule `subject`.
 * Ranking and display only — a subject is never proof, and a rule
 * without one is graded regardless of this list.
 */
export function businessRuleInventory(graph: ResourceGraph): string[] {
  return [
    ...new Set(graph.resources.flatMap((resource) => (resource.name === null ? [] : [resource.name]))),
  ].sort();
}

/** One serialized rule case in a report's additive `businessRules` section. */
export interface BusinessRuleReportEntry {
  /** The rule the case belongs to. */
  ruleId: string;
  /** The case id (unique within the rule). */
  caseId: string;
  /** The rule's declared proof type (`e2e`, `pytest`, ...). */
  test: string;
  /** The rule's enforcement (`block` | `advisory`). */
  enforcement: string;
  /** `unmapped` | `wrong-type` | `unproven` | `failing` | `satisfied`. */
  status: string;
  /** The channel that proved a satisfied case (`engine`, `observe`, `execution`), else null. */
  channel: string | null;
  /** The gradeable mapped tests of the case, sorted. */
  mappedTests: readonly string[];
  /** The typed finding, null exactly when satisfied. */
  finding: {
    cause: string;
    detail: string;
    nextAction: string;
    tests: readonly string[];
  } | null;
}

/**
 * Serializes every graded rule case for the report's `businessRules`
 * section (plan §7.5, invariant 6): a SATISFIED case must be visible
 * naming the channel that proved it — "satisfied" read as "the rule
 * holds" is exactly the overclaim the channel naming exists to prevent —
 * and a demoted (advisory) case appears here beside its advisory-channel
 * entry, so the section is the one place that lists EVERY case with its
 * status. The section rides the json document only when rules are
 * declared, so a repository without the feature keeps its exact report.
 *
 * Args:
 *   rules: the owner's declared rules (status and channel context).
 *   cases: the graded case results, sorted by rule id then case id.
 *
 * Returns:
 *   BusinessRuleReportEntry[]: the serialized cases, input order.
 */
export function businessRuleReportEntries(
  rules: readonly BusinessRule[],
  cases: readonly BusinessRuleCaseResult[],
): BusinessRuleReportEntry[] {
  const typeOf = new Map(rules.map((rule) => [rule.id, rule.test]));
  const enforcementOf = new Map(rules.map((rule) => [rule.id, rule.enforcement]));
  return cases.map((result) => ({
    ruleId: result.ruleId,
    caseId: result.caseId,
    test: typeOf.get(result.ruleId) ?? 'e2e',
    enforcement: enforcementOf.get(result.ruleId) ?? 'block',
    status: result.status,
    channel: result.channel,
    mappedTests: result.mappedTests,
    finding:
      result.finding === null
        ? null
        : {
            cause: result.finding.cause,
            detail: result.finding.detail,
            nextAction: result.finding.nextAction,
            tests: result.finding.tests,
          },
  }));
}

/**
 * The `next` guidance for the run's rule findings (plan D6, §7.2): one
 * block per graded case that carries a finding — the rule title, the
 * case describe, the declared proof type — and, for a case with NO
 * mapped test, the printed starter test (the type table's `starter`
 * field picks the template: a Playwright test on the Gateforge fixture
 * for `e2e`, a pytest function for `pytest`) plus the exact
 * `tests mark --rule` line that maps it once written. A case that IS
 * mapped gets the finding statement only: its gap is proof, not a
 * missing declaration, and inventing a second mark line would steer the
 * owner to map a duplicate instead of running the gate.
 *
 * Pure text; `next` prints these lines for EVERY finding case (§7.2:
 * two starter tests and two mark lines for a two-case rule), not only
 * for the top-ranked candidate.
 */
export function businessRuleGuidanceLines(
  rules: readonly BusinessRule[],
  cases: readonly BusinessRuleCaseResult[],
): string[] {
  const lines: string[] = [];
  for (const result of cases) {
    if (result.finding === null) continue;
    const rule = rules.find((entry) => entry.id === result.ruleId);
    if (rule === undefined) continue;
    const businessCase = casesOf(rule).find((entry) => entry.id === result.caseId);
    const describe = businessCase?.describe ?? result.caseId;
    const row = BUSINESS_RULE_TYPE_TABLE[rule.test];
    lines.push(
      `business rule '${rule.id}' case '${result.caseId}' needs a '${row.label}' test ` +
        `(${row.acceptedKinds.join(' or ')} under runner '${row.runner}') — ${rule.title}`,
    );
    if (result.status !== 'unmapped') continue;
    if (row.starter === 'playwright') {
      const title = `business rule ${rule.id}: ${describe}`;
      const file = `e2e/${rule.id}.spec.mjs`;
      lines.push(`  starter (the fixture's page is what routes the journey through the witness):`);
      lines.push(`    import { test, expect } from '@gate-forge/pack-playwright/fixture';`);
      lines.push(`    test('${title}', async ({ page }) => {`);
      lines.push(`      // Prove "${rule.title}" — ${describe}`);
      lines.push(`    });`);
      lines.push(
        `  then map it: gateforge tests mark --rule ${rule.id}/${result.caseId}` +
          ` --test '${file}#${title}' --kind ${row.acceptedKinds[0] ?? 'browser-e2e'}` +
          ` --reason 'asserts ${rule.id}/${result.caseId} in the real app'`,
      );
    } else {
      const slug = (value: string): string => value.replace(/[^a-z0-9]+/g, '_');
      const pytestName = `test_business_rule_${slug(rule.id)}_${slug(result.caseId)}`;
      const file = `tests/test_${slug(rule.id)}.py`;
      lines.push(`  starter (inside the WITNESSED pytest suite the run supervises):`);
      lines.push(`    def ${pytestName}():`);
      lines.push(`        """Prove "${rule.title}" — ${describe}."""`);
      lines.push(
        `  then map it: gateforge tests mark --rule ${rule.id}/${result.caseId}` +
          ` --test '${file}#${pytestName}' --kind ${row.acceptedKinds[0] ?? 'unit'}` +
          ` --reason 'asserts ${rule.id}/${result.caseId} in the witnessed suite'`,
      );
    }
  }
  return lines;
}