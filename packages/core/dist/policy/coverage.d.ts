import { type CauseCode } from '../schemas/verdict.js';
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
    /** Declared test kind; ONLY `browser-e2e` satisfies closed-world coverage. */
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
 * - otherwise each required operation without a `browser-e2e` mapping →
 *   blocking `CRUD_COVERAGE_MISSING`.
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
export declare function evaluateCoveragePolicy(tables: readonly CoverageTable[], inventory: readonly CoverageInventoryTable[], mappedCoverage?: readonly MappedCoverage[]): CoveragePolicyResult;
//# sourceMappingURL=coverage.d.ts.map