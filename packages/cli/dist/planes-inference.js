/**
 * Plane-config inference for `gateforge init --planes`.
 *
 * Unconfigured repos block every table with `PLANE_UNRESOLVED` — the
 * classifier never guesses across tenant/master/global (ADR 0003 D5) —
 * so init can PROPOSE `.gateforge/planes.json` from what discovery
 * actually saw: the source directories of the discovered business
 * tables. The proposal is a review artifact, never a silent decision:
 * every rule carries a reason naming the directory it was inferred
 * from, init writes the file only on explicit consent, and the user is
 * told to review it before the next run.
 *
 * Semantics (deterministic, conservative):
 * - tables under conventional test directories (`tests/`, `test/`) are
 *   EXCLUDED from inference: they are fixtures, not business tables,
 *   and a rule endorsing them would misclassify them as business
 *   surface (they stay plane-less and gate-visible instead);
 * - source directories are grouped into MODEL TREES under the longest
 *   common directory prefix, one non-overlapping `match` glob per tree;
 * - a tree whose path names a control-plane segment (`admin`, `master`,
 *   `control`, `root`, `operator`) proposes `master`; everything else
 *   proposes `tenant`. A keyword heuristic IS a guess — but a
 *   reviewable one, written into the file with its evidence, never a
 *   runtime inference.
 */
import { dirname } from 'node:path';
/** Directory segments that mark test fixtures (exact segment match). */
const TEST_SEGMENTS = new Set(['tests', 'test']);
/** Path keywords that mark a control-plane (master) model tree. */
const MASTER_KEYWORDS = ['admin', 'master', 'control', 'root', 'operator'];
/** The posix directory of a repo-relative source path ('' at the root). */
function directoryOf(source) {
    const normalized = source.replaceAll('\\', '/');
    const index = normalized.lastIndexOf('/');
    return index === -1 ? '' : normalized.slice(0, index);
}
/** Whether any path segment marks the path as test fixture surface. */
function isTestPath(source) {
    return source
        .replaceAll('\\', '/')
        .split('/')
        .slice(0, -1)
        .some((segment) => TEST_SEGMENTS.has(segment));
}
/**
 * Whether the relative directory names a control-plane tree (a keyword
 * appears as a segment substring, case-insensitive: `admin_platform`,
 * `Master`, `control-plane` all match).
 */
function isMasterTree(relativeDir) {
    const lower = relativeDir.toLowerCase();
    return MASTER_KEYWORDS.some((keyword) => lower.includes(keyword));
}
/**
 * Derives a proposed planes config from discovered table source paths.
 * Pure over its input; the caller owns consent and the write.
 *
 * Args:
 *   tableSources: Repo-root-relative source paths of discovered
 *     `sqlalchemy.table` resources.
 *
 * Returns:
 *   PlaneInference: The proposal with diagnostics; `config` is null
 *     when no table was discovered (nothing to map) — the note says so.
 */
export function inferPlanesConfig(tableSources) {
    const unique = [...new Set(tableSources)].sort();
    if (unique.length === 0) {
        return { config: null, note: 'no sqlalchemy tables discovered — nothing to propose', skippedTestTables: 0 };
    }
    const business = unique.filter((source) => !isTestPath(source));
    const skippedTestTables = unique.length - business.length;
    if (business.length === 0) {
        return {
            config: null,
            note: 'every discovered table lives under a test directory — no business plane to propose ' +
                '(exclude test paths from the scan or classify them deliberately)',
            skippedTestTables,
        };
    }
    // Longest common directory prefix of the business trees (segment-wise).
    const dirs = business.map(directoryOf);
    let prefix = dirs[0]?.split('/') ?? [];
    for (const dir of dirs.slice(1)) {
        const segments = dir.split('/');
        let common = 0;
        while (common < prefix.length && common < segments.length && prefix[common] === segments[common]) {
            common += 1;
        }
        prefix = prefix.slice(0, common);
        if (prefix.length === 0)
            break;
    }
    const prefixPath = prefix.join('/');
    // One group per directory segment directly under the prefix (files
    // directly IN the prefix form their own group), so the resulting
    // `match` globs never overlap — overlapping plane rules with
    // different planes would block as PLANE_RULE_CONTRADICTION at runtime.
    const groups = new Map();
    for (const dir of dirs) {
        const relative = prefixPath.length === 0 ? dir : dir.startsWith(`${prefixPath}/`) ? dir.slice(prefixPath.length + 1) : '';
        const head = relative === '' ? '' : (relative.split('/')[0] ?? '');
        groups.set(head, (groups.get(head) ?? 0) + 1);
    }
    const rules = [];
    for (const head of [...groups.keys()].sort()) {
        const treePath = head === '' ? prefixPath : prefixPath.length === 0 ? head : `${prefixPath}/${head}`;
        // `P/<seg>/**` covers the subtree; the files-directly-under-P group
        // covers exactly one level (`P/*.py`) so the globs stay disjoint.
        const match = head === '' ? (prefixPath.length === 0 ? '*.py' : `${prefixPath}/*.py`) : `${treePath}/**`;
        const plane = isMasterTree(head === '' ? prefixPath : head) ? 'master' : 'tenant';
        rules.push({
            match,
            plane,
            reason: `inferred from model directory '${treePath}' by gateforge init; ` +
                'review before relying on this',
        });
    }
    rules.sort((a, b) => (a.match ?? '').localeCompare(b.match ?? ''));
    return { config: { rules }, note: null, skippedTestTables };
}
//# sourceMappingURL=planes-inference.js.map