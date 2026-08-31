/**
 * Waiver loading and validation (ADR 0001 D4, GF-15/16/17): reads
 * `*.json` waiver files from the configured waivers directory.
 *
 * Fail-closed rules:
 * - ALL FIVE fields (owner, justificationUrl, approver, scope,
 *   expiresAt) are mandatory — a file missing any of them is a
 *   fail-closed configuration error, never a partially-applied exception
 *   (GF-15).
 * - Expiry is evaluated against the INJECTED clock (`now` option) —
 *   never the wall clock (invariant 7, GF-16). Expired waivers are
 *   reported separately; the verdict engine turns them into `invalid`.
 * - An optional owner-checker hook flags waivers whose owner no longer
 *   exists; flagged waivers surface as `stale` downstream (GF-17).
 *   Default: no owner checking.
 * - Two waivers claiming the same exact (resourceId, fingerprint) scope
 *   are ambiguous → configuration error.
 *
 * Loading is synchronous, matching `loadConfig`'s convention.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { compareStrings } from '../graph/util.js';
import { WaiverSchema } from '../schemas/waiver.js';
import { parseInstant } from '../verdict/index.js';
/**
 * Error raised for any fail-closed waiver configuration problem
 * (GF-15): missing mandatory fields, unparsable JSON, duplicate exact
 * scopes, or an over-long waiver duration. Carries every problem found
 * across the directory so one run reports all of them.
 */
export class GateforgeWaiverError extends Error {
    /** Every problem found, file-scoped, in deterministic order. */
    problems;
    constructor(problems) {
        const rendered = problems
            .map((problem) => `  ${problem.file}: ${problem.detail}`)
            .join('\n');
        super(`waiver configuration failed closed with ${problems.length} problem(s):\n${rendered}`);
        this.name = 'GateforgeWaiverError';
        this.problems = problems;
    }
}
/**
 * Loads and validates every `*.json` waiver file in `dir` (sorted by
 * filename for determinism). A missing directory yields an empty result —
 * projects may simply have no waivers. Any problem (unparsable JSON,
 * missing mandatory field, duplicate scope, over-long duration) fails
 * closed: {@link GateforgeWaiverError} listing every problem found.
 *
 * Args:
 *   dir: the configured waivers directory (e.g. `.gateforge/waivers/`).
 *   options: injected clock, optional owner checker, optional max duration.
 *
 * Returns:
 *   WaiverLoadResult: valid / stale-owner / expired partitions.
 *
 * Throws:
 *   GateforgeWaiverError: when any waiver file fails closed (GF-15).
 */
export function loadWaivers(dir, options) {
    const now = parseInstant(options.now);
    const problems = [];
    if (!existsSync(dir)) {
        return { waivers: [], staleOwner: [], expired: [] };
    }
    const files = readdirSync(dir, { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
        .map((entry) => entry.name)
        .sort(compareStrings);
    const parsed = [];
    for (const file of files) {
        const path = join(dir, file);
        let document;
        try {
            document = JSON.parse(readFileSync(path, 'utf8'));
        }
        catch (error) {
            problems.push({
                file,
                detail: `not parsable JSON: ${error instanceof Error ? error.message : String(error)}`,
            });
            continue;
        }
        const result = WaiverSchema.safeParse(document);
        if (!result.success) {
            for (const issue of result.error.issues) {
                problems.push({
                    file,
                    detail: `${issue.path.join('.') || '<waiver>'}: ${issue.message}`,
                });
            }
            continue;
        }
        const waiver = result.data;
        if (options.maxDurationMs !== undefined) {
            const duration = Date.parse(waiver.expiresAt) - now.getTime();
            if (duration > options.maxDurationMs) {
                problems.push({
                    file,
                    detail: `expiresAt '${waiver.expiresAt}' exceeds the maximum waiver duration ` +
                        `(${Math.round(options.maxDurationMs / 86_400_000)} days from now)`,
                });
                continue;
            }
        }
        parsed.push({ file, waiver });
    }
    // Exact-scope uniqueness: two waivers on one (resourceId, fingerprint)
    // pair are ambiguous about who owns the exception — fail closed
    // (mirrors invariant 4's exactness).
    const byScope = {};
    for (const { file, waiver } of parsed) {
        const scopeKey = `${waiver.scope.resourceId}\u0000${waiver.scope.fingerprint}`;
        const firstFile = byScope[scopeKey];
        if (firstFile !== undefined) {
            problems.push({
                file,
                detail: `duplicate exact scope (resourceId '${waiver.scope.resourceId}', fingerprint ` +
                    `'${waiver.scope.fingerprint}') already covered by '${firstFile}'`,
            });
            continue;
        }
        byScope[scopeKey] = file;
    }
    if (problems.length > 0) {
        throw new GateforgeWaiverError(problems);
    }
    const waivers = [];
    const staleOwner = [];
    const expired = [];
    for (const { waiver } of parsed) {
        if (now.getTime() >= Date.parse(waiver.expiresAt)) {
            expired.push(waiver);
            continue;
        }
        if (options.ownerExists !== undefined && !options.ownerExists(waiver)) {
            staleOwner.push({ ...waiver, ownerStale: true });
            continue;
        }
        waivers.push(waiver);
    }
    const byOwner = (a, b) => compareStrings(`${a.owner}\u0000${a.expiresAt}`, `${b.owner}\u0000${b.expiresAt}`);
    waivers.sort(byOwner);
    staleOwner.sort(byOwner);
    expired.sort(byOwner);
    return { waivers, staleOwner, expired };
}
//# sourceMappingURL=index.js.map