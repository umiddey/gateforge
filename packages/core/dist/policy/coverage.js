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
 * - Only `browser-e2e` mappings satisfy (plan §3.2: api-e2e cannot
 *   substitute for browser behavior); the mapping subsystem may pass an
 *   empty list for now — the honest result is that enabled, undispositioned
 *   tables block until mappings or dispositions exist.
 */
import { compareStrings } from '../graph/util.js';
import { CAUSE_NEXT_ACTIONS } from '../schemas/verdict.js';
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
export function evaluateCoveragePolicy(tables, inventory, mappedCoverage = []) {
    const inventoryByName = new Map();
    for (const entry of inventory) {
        const existing = inventoryByName.get(entry.name);
        if (existing === undefined)
            inventoryByName.set(entry.name, [entry]);
        else
            existing.push(entry);
    }
    const policyNames = new Set(tables.map((table) => table.name));
    const configErrors = [];
    const blocking = [];
    for (const table of tables) {
        const known = inventoryByName.get(table.name);
        if (known === undefined) {
            configErrors.push({
                code: 'COVERAGE_TABLE_UNKNOWN',
                table: table.name,
                detail: `coverage policy names table '${table.name}' which is not present in the current ` +
                    'resource inventory; a name the inventory cannot see is silently uncheckable, so ' +
                    'the run fails as a configuration error (a silently dropped table is a violation, ' +
                    'never coverage)',
            });
            continue;
        }
        // A recorded owner disposition excuses the table's required
        // operations (trusted-policy act, ADR 0005 D5).
        if (table.disposition !== undefined)
            continue;
        for (const operation of table.requiredOperations) {
            const covered = mappedCoverage.some((mapping) => mapping.table === table.name &&
                mapping.operation === operation &&
                mapping.testKind === 'browser-e2e');
            if (covered)
                continue;
            blocking.push({
                code: 'CRUD_COVERAGE_MISSING',
                cause: 'CRUD_COVERAGE_MISSING',
                table: table.name,
                operation,
                detail: `coverage policy: table '${table.name}' has no mapped browser-e2e '${operation}' ` +
                    'coverage and no owner disposition',
                nextAction: CRUD_COVERAGE_MISSING_CAUSE,
            });
        }
    }
    // Closed-world: an inventory table the policy does not enumerate is a
    // dropped violation, not coverage (plan Phase 0 item 7).
    for (const [name, entries] of inventoryByName) {
        if (policyNames.has(name))
            continue;
        const operations = [
            ...new Set(entries.flatMap((entry) => [...entry.operations])),
        ].sort(compareStrings);
        blocking.push({
            code: 'CRUD_COVERAGE_MISSING',
            cause: 'CRUD_COVERAGE_MISSING',
            table: name,
            operation: null,
            detail: `coverage policy: user-facing table '${name}' is present in the resource inventory ` +
                `but the policy does not enumerate it (enabled operations: ` +
                `[${operations.join(', ')}]); a silently dropped table is a violation, never coverage`,
            nextAction: CRUD_COVERAGE_MISSING_CAUSE,
        });
    }
    configErrors.sort((a, b) => compareStrings(a.table, b.table));
    blocking.sort((a, b) => compareStrings(a.table, b.table) ||
        compareStrings(a.operation ?? '', b.operation ?? ''));
    return { configErrors, blocking };
}
//# sourceMappingURL=coverage.js.map