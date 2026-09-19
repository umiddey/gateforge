/**
 * Closed-world CRUD coverage evaluator (plan 2026-09-13 §3.6, Phase 0
 * item 7, ADR 0005 D5). Pure and deterministic: given the owner-owned
 * coverage policy tables, the CURRENT run's user-facing table inventory,
 * and the resolved test mappings, it returns typed blocking
 * `CRUD_COVERAGE_MISSING` findings for every required operation lacking
 * mapped browser-e2e coverage and lacking an owner disposition.
 *
 * Fail-closed by construction:
 * - The caller MUST pass the resource inventory. A policy table absent
 *   from it yields a CONFIG-ERROR result (callers turn that into exit 2):
 *   a name the inventory cannot see is silently uncheckable, and a
 *   silently dropped table is a violation, never coverage.
 * - Inventory tables the policy does NOT enumerate are violations too
 *   (the policy is closed-world over the inventory).
 * - Only real-UI mappings satisfy (`browser-e2e` engine-driven and
 *   `observed-e2e` suite-driven-over-proxy; plan §3.2: api-e2e cannot
 *   substitute for browser behavior); the mapping subsystem may pass an
 *   empty list for now — the honest result is that enabled, undispositioned
 *   tables block until mappings or dispositions exist.
 */
import { compareStrings } from '../graph/util.js';
import { CAUSE_NEXT_ACTIONS, type CauseCode } from '../schemas/verdict.js';
import type { CoverageOperation, CoverageTable } from '../schemas/coverage-policy.js';

/**
 * One inventory table the caller derived from the current run's resource
 * graph (user-facing, non-endpoint resources). Passing the inventory is
 * REQUIRED: it is what makes a silently dropped policy table detectable.
 */
export interface CoverageInventoryTable {
  /** Bare resource name, matched exactly against policy table names. */
  name: string;
  /** Operations the resource's lifecycle currently enables (dropped-table findings name these). */
  operations: readonly CoverageOperation[];
}

/** One resolved test mapping (plan §5.1 mapping resolution) — input, not proof. */
export interface MappedCoverage {
  /** Bare table name the mapping covers. */
  table: string;
  /** The covered operation. */
  operation: CoverageOperation;
  /** Declared test kind; only real-UI kinds (`browser-e2e`, `observed-e2e`) satisfy closed-world coverage. */
  testKind: string;
}

/** Configuration-error finding: the policy names a table the inventory cannot see. */
export interface CoverageConfigError {
  /** Always `COVERAGE_TABLE_UNKNOWN`. */
  code: 'COVERAGE_TABLE_UNKNOWN';
  /** The unknown policy table name. */
  table: string;
  /** Single-cause explanation; callers turn this into exit 2. */
  detail: string;
}

/** Blocking finding: required real-UI coverage is missing and undispositioned. */
export interface CoverageBlockingFinding {
  /** Always `CRUD_COVERAGE_MISSING` (plan §3.6/§5.4). */
  code: 'CRUD_COVERAGE_MISSING';
  /** Stable cause code carried into the shared report model. */
  cause: Extract<CauseCode, 'CRUD_COVERAGE_MISSING'>;
  /** The table lacking coverage. */
  table: string;
  /** The uncovered operation; null for a whole-table dropped violation. */
  operation: CoverageOperation | null;
  /** Single-cause explanation naming the gap. */
  detail: string;
  /** Plan §5.4 next action for `CRUD_COVERAGE_MISSING`. */
  nextAction: string;
}

/** The complete evaluator result: config errors and blocking findings, sorted. */
export interface CoveragePolicyResult {
  /** Configuration errors (unknown table names) — callers exit 2 on these. */
  configErrors: CoverageConfigError[];
  /** Blocking findings — callers surface these as blocking report entries. */
  blocking: CoverageBlockingFinding[];
}

/** Cause + next action for every blocking finding (plan §5.4). */
const CRUD_COVERAGE_MISSING_CAUSE = CAUSE_NEXT_ACTIONS['CRUD_COVERAGE_MISSING'];

/**
 * Evaluates the coverage policy against the current inventory and
 * resolved mappings. Pure: identical inputs produce byte-identical
 * results; findings sort by table then operation.
 *
 * Semantics:
 * - policy table absent from the inventory → CONFIG-ERROR
 *   (`COVERAGE_TABLE_UNKNOWN`);
 * - inventory table absent from the policy → blocking (closed-world: a
 *   silently dropped table is a violation);
 * - dispositioned table → excused (the disposition is a trusted owner
 *   act recorded in config, never an agent self-approval);
 * - otherwise each required operation without a real-UI
 *   (`browser-e2e`/`observed-e2e`) mapping → blocking
 *   `CRUD_COVERAGE_MISSING`.
 *
 * Args:
 *   tables: the policy's table entries (validated `CoveragePolicySchema`).
 *   inventory: the current run's user-facing table inventory (REQUIRED).
 *   mappedCoverage: resolved test mappings; may be empty while the
 *     mapping subsystem is unbuilt (Phase 2-3).
 *
 * Returns:
 *   CoveragePolicyResult: sorted config errors and blocking findings.
 */
export function evaluateCoveragePolicy(
  tables: readonly CoverageTable[],
  inventory: readonly CoverageInventoryTable[],
  mappedCoverage: readonly MappedCoverage[] = [],
): CoveragePolicyResult {
  const inventoryByName = new Map<string, CoverageInventoryTable[]>();
  for (const entry of inventory) {
    const existing = inventoryByName.get(entry.name);
    if (existing === undefined) inventoryByName.set(entry.name, [entry]);
    else existing.push(entry);
  }
  const policyNames = new Set(tables.map((table) => table.name));

  const configErrors: CoverageConfigError[] = [];
  const blocking: CoverageBlockingFinding[] = [];

  for (const table of tables) {
    const known = inventoryByName.get(table.name);
    if (known === undefined) {
      configErrors.push({
        code: 'COVERAGE_TABLE_UNKNOWN',
        table: table.name,
        detail:
          `coverage policy names table '${table.name}' which is not present in the current ` +
          'resource inventory; a name the inventory cannot see is silently uncheckable, so ' +
          'the run fails as a configuration error (a silently dropped table is a violation, ' +
          'never coverage)',
      });
      continue;
    }
    // A recorded owner disposition excuses the table's required
    // operations (trusted-policy act, ADR 0005 D5).
    if (table.disposition !== undefined) continue;
    for (const operation of table.requiredOperations) {
      // Real-UI coverage (plan §3.2 + Observe channel): `browser-e2e`
      // (engine-driven) and `observed-e2e` (suite-driven over the session
      // proxy with independent adapter reads) are both genuine browser
      // journeys — either covers. Every other kind contributes nothing.
      const covered = mappedCoverage.some(
        (mapping) =>
          mapping.table === table.name &&
          mapping.operation === operation &&
          (mapping.testKind === 'browser-e2e' || mapping.testKind === 'observed-e2e'),
      );
      if (covered) continue;
      blocking.push({
        code: 'CRUD_COVERAGE_MISSING',
        cause: 'CRUD_COVERAGE_MISSING',
        table: table.name,
        operation,
        detail:
          `coverage policy: table '${table.name}' has no mapped real-UI ` +
          `'${operation}' coverage (browser-e2e or observed-e2e) and no owner disposition`,
        nextAction: CRUD_COVERAGE_MISSING_CAUSE,
      });
    }
  }

  // Closed-world: an inventory table the policy does not enumerate is a
  // dropped violation, not coverage (plan Phase 0 item 7).
  for (const [name, entries] of inventoryByName) {
    if (policyNames.has(name)) continue;
    const operations = [
      ...new Set(entries.flatMap((entry) => [...entry.operations])),
    ].sort(compareStrings);
    blocking.push({
      code: 'CRUD_COVERAGE_MISSING',
      cause: 'CRUD_COVERAGE_MISSING',
      table: name,
      operation: null,
      detail:
        `coverage policy: user-facing table '${name}' is present in the resource inventory ` +
        `but the policy does not enumerate it (enabled operations: ` +
        `[${operations.join(', ')}]); a silently dropped table is a violation, never coverage`,
      nextAction: CRUD_COVERAGE_MISSING_CAUSE,
    });
  }

  configErrors.sort((a, b) => compareStrings(a.table, b.table));
  blocking.sort((a, b) =>
    compareStrings(a.table, b.table) ||
    compareStrings(a.operation ?? '', b.operation ?? ''),
  );
  return { configErrors, blocking };
}
