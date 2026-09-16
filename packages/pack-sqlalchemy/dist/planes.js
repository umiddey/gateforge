/**
 * Optional plane attribution helpers for the SQLAlchemy detector.
 *
 * Core derives business meaning from normalized classification signals.
 * Two channels feed `attributes.plane` on `sqlalchemy.table` resources:
 *
 * - a programmatic {@link PlaneRule} (the detector factory option; for
 *   host code and tests); and
 * - the declarative `.gateforge/planes.json` document — an explicit,
 *   human-reviewed config file (every rule must carry a non-empty
 *   `reason`, the review artifact). A `match` rule may additionally
 *   carry `exclude` — repo-root-relative globs pruning whole FILES from
 *   the rule's surface (a directory surface mixing planes, e.g.
 *   contractor-scoped routers beside global-ingress endpoints under one
 *   `backend/api/v1/`, needs those exceptions documented; exclusion is
 *   explicit and reviewed here, unlike silent precedence between
 *   overlapping rules). Rules resolve in two tiers with
 *   EXPLICIT-BEATS-GENERAL precedence: a table claimed by ANY `tables`
 *   rule (explicit enumeration) resolves ONLY against `tables` rules —
 *   `match` (glob) rules are ignored for it; glob rules apply only to
 *   tables no explicit rule claims. WHY: an enumerated name list is a
 *   more specific human claim than a directory glob, and a glob's
 *   `exclude` prunes source files — it cannot enumerate table-name
 *   claims — so cross-tier overlap must not read as contradiction.
 *   Within a tier: agreement applies the plane; disagreement emits a
 *   blocking `PLANE_RULE_CONTRADICTION` finding and applies nothing;
 *   NO matching rule applies nothing either — the resource stays
 *   plane-unresolved and the core classifier blocks it, forcing the
 *   config author to cover every table (closed-world completeness).
 *
 * Absence of the config file is normal and byte-identical to
 * {@link NO_PLANE_MAPPING}; a malformed document throws (fail closed).
 */
import { readFileSync } from 'node:fs';
import { globMatch } from '@gate-forge/core';
/** The empty rule; core derives plane from normalized signals. */
export const NO_PLANE_MAPPING = () => null;
/** Rule that maps table names to planes; unmapped tables stay null. */
export function byTableName(mapping) {
    const table = new Map(Object.entries(mapping));
    return (context) => table.get(context.tableName) ?? null;
}
// ---------------------------------------------------------------------------
// Declarative plane config (`.gateforge/planes.json`)
// ---------------------------------------------------------------------------
/** Repo-root-relative location of the declarative plane config document. */
export const PLANES_CONFIG_PATH = '.gateforge/planes.json';
/** The absent-config default: no rules, no mapping (byte-identical noop). */
export const DEFAULT_PLANES_CONFIG = { rules: [] };
/** The plane values a rule may assert, in canonical order. */
const PLANES = ['tenant', 'master', 'global'];
/** The only keys a rule object may carry. */
const RULE_KEYS = ['match', 'tables', 'exclude', 'plane', 'reason'];
/**
 * Validates one repo-root-relative posix glob pattern. Rejects
 * absolute, drive-qualified, backslash, and `..`-escaping patterns with
 * a single-cause error (same posture as the graph's source-path
 * normalizer — a pattern escaping the repo root would silently match
 * nothing and hide exactly the tables the rule exists to cover).
 * `field` names the error location: `'match'` for the rule's own
 * pattern, `exclude[N]` for one exclusion entry.
 */
function validateMatchPattern(raw, path, index, field) {
    const at = `rules[${index}].${field}`;
    if (typeof raw !== 'string' || raw.length === 0) {
        throw new Error(`invalid planes config: ${at} must be a non-empty string at ${path}`);
    }
    if (raw.includes('\\')) {
        throw new Error(`invalid planes config: ${at} must use posix '/' separators ` +
            `(repo-root-relative) at ${path}: ${JSON.stringify(raw)}`);
    }
    if (raw.startsWith('/') || /^[A-Za-z]:/.test(raw)) {
        throw new Error(`invalid planes config: ${at} must be a repo-root-relative glob ` +
            `at ${path}: ${JSON.stringify(raw)}`);
    }
    if (raw.split('/').includes('..')) {
        throw new Error(`invalid planes config: ${at} must not escape the repo root ` +
            `('..') at ${path}: ${JSON.stringify(raw)}`);
    }
    return raw;
}
/** Validates one `tables` entry list (fail closed on every wrong shape). */
function validateTables(raw, path, index) {
    if (!Array.isArray(raw) || raw.length === 0) {
        throw new Error(`invalid planes config: rules[${index}].tables must be a non-empty array of names at ${path}`);
    }
    return raw.map((name) => {
        if (typeof name !== 'string' || name.length === 0) {
            throw new Error(`invalid planes config: rules[${index}].tables entries must be non-empty strings ` +
                `at ${path}`);
        }
        return name;
    });
}
/**
 * Validates one `exclude` entry list (fail closed on every wrong
 * shape): a non-empty array of repo-root-relative posix globs, each
 * pattern-validated exactly like `match` — a malformed exclusion would
 * otherwise silently match nothing and let the rule keep claiming the
 * very file the author meant to except.
 */
function validateExclude(raw, path, index) {
    if (!Array.isArray(raw) || raw.length === 0) {
        throw new Error(`invalid planes config: rules[${index}].exclude must be a non-empty array of globs ` +
            `at ${path}`);
    }
    return raw.map((pattern, entry) => validateMatchPattern(pattern, path, index, `exclude[${entry}]`));
}
/** Validates one rule object (fail closed; first cause wins, in order). */
function parsePlaneConfigRule(value, path, index) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error(`invalid planes config: rules[${index}] must be an object at ${path}`);
    }
    const record = value;
    const unknownKeys = Object.keys(record).filter((key) => !RULE_KEYS.includes(key));
    if (unknownKeys.length > 0) {
        // Strict on purpose: a typo'd key ('planes', 'matsh') would otherwise
        // silently drop a reviewed rule and un-cover exactly its tables.
        throw new Error(`invalid planes config: rules[${index}] has unknown key(s) ` +
            `${unknownKeys.sort().join(', ')} at ${path}`);
    }
    const hasMatch = record['match'] !== undefined;
    const hasTables = record['tables'] !== undefined;
    if (hasMatch === hasTables) {
        throw new Error(`invalid planes config: rules[${index}] must carry exactly one of 'match' or 'tables' ` +
            `at ${path}`);
    }
    const hasExclude = record['exclude'] !== undefined;
    // Mirror the exactly-one-of posture: `exclude` prunes the surface of
    // a source-path glob, so on a `tables` rule it would be dead config —
    // and dead config in a review artifact reads as a review that never
    // happened. Reject instead of silently ignoring.
    if (hasExclude && !hasMatch) {
        throw new Error(`invalid planes config: rules[${index}].exclude is only valid together with 'match' ` +
            `at ${path}`);
    }
    const plane = record['plane'];
    if (!PLANES.includes(plane)) {
        throw new Error(`invalid planes config: rules[${index}].plane must be one of: ` +
            `${PLANES.map((value) => `'${value}'`).join(', ')} at ${path}`);
    }
    const reason = record['reason'];
    if (typeof reason !== 'string' || reason.trim().length === 0) {
        throw new Error(`invalid planes config: rules[${index}].reason must be a non-empty string ` +
            '(the config is a human review artifact) at ' +
            path);
    }
    return {
        ...(hasMatch
            ? {
                match: validateMatchPattern(record['match'], path, index, 'match'),
                ...(hasExclude
                    ? { exclude: validateExclude(record['exclude'], path, index) }
                    : {}),
            }
            : { tables: validateTables(record['tables'], path, index) }),
        plane: plane,
        reason,
    };
}
/**
 * Reads a declarative plane config document. Returns the default config
 * when the file is absent (normal; byte-identical to
 * {@link NO_PLANE_MAPPING}); malformed documents throw (fail closed —
 * the CLI surfaces the error instead of scanning with partial trust).
 *
 * Accepted shape: `{ rules: [{ match?, exclude?, tables?, plane, reason }] }` — a
 * rule carries EXACTLY ONE of `match` (repo-root-relative source-path
 * glob) or `tables` (explicit tableName / class-simple-name list),
 * always with a strict `plane` and a non-empty human `reason`; a
 * `match` rule may additionally carry `exclude` (a non-empty list of
 * repo-root-relative globs pruning files from its surface — rejected
 * on a `tables` rule).
 */
export function readPlanesConfigOrNull(path) {
    if (path === null)
        return DEFAULT_PLANES_CONFIG;
    let text;
    try {
        text = readFileSync(path, 'utf8');
    }
    catch {
        return DEFAULT_PLANES_CONFIG; // absence is normal; malformed is not (below)
    }
    const parsed = JSON.parse(text);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error(`invalid planes config: expected an object at ${path}`);
    }
    const document = parsed;
    const unknownKeys = Object.keys(document).filter((key) => key !== 'rules');
    if (unknownKeys.length > 0) {
        throw new Error(`invalid planes config: unknown key(s) ${unknownKeys.sort().join(', ')} at ${path}`);
    }
    const rules = document['rules'];
    if (!Array.isArray(rules)) {
        throw new Error(`invalid planes config: 'rules' must be an array of rule objects at ${path}`);
    }
    return { rules: rules.map((rule, index) => parsePlaneConfigRule(rule, path, index)) };
}
/**
 * Whether one config rule matches one table resource. A `match` rule
 * globs the resource's repo-root-relative SOURCE FILE path with core's
 * classifier glob semantics (`pathInScope`: `*` within one segment,
 * `**` across segments, `?` one character; whole-path, case-sensitive)
 * — and when the rule carries `exclude`, ANY matching exclusion glob
 * removes the resource's source file from the rule's surface entirely
 * (the documented exception wins over the directory glob; checked
 * first, so an excluded file can never collide with a narrower rule).
 * A `tables` rule matches when ANY listed name equals the table
 * `resourceName` OR the class simple name — deliberately either: table
 * names and class names are both identity evidence. The reader rejects
 * `exclude` on `tables` rules, but the check sits ahead of the branch
 * so hand-built configs cannot resurrect an excluded rule either way.
 */
export function planeRuleMatches(rule, input) {
    if (rule.exclude !== undefined &&
        rule.exclude.some((pattern) => globMatch(input.sourcePath, pattern))) {
        return false;
    }
    if (rule.match !== undefined)
        return globMatch(input.sourcePath, rule.match);
    const names = rule.tables ?? [];
    if (names.includes(input.tableName))
        return true;
    return input.classSimpleName !== null && names.includes(input.classSimpleName);
}
/**
 * Whether one config rule belongs to the EXPLICIT tier (enumerated
 * `tables` claim). Tier membership, not matching, is what this decides:
 * a resource claimed here never falls through to the glob tier.
 */
function isTablesRule(rule) {
    return rule.tables !== undefined;
}
/**
 * Whether one config rule belongs to the GENERAL tier (source-path
 * `match` glob, and only a glob — the reader rejects hybrid rules, but
 * hand-built configs must not let a hybrid claim both tiers).
 */
function isMatchRule(rule) {
    return rule.tables === undefined && rule.match !== undefined;
}
/** All hits of one tier, in config order (deterministic). */
function collectTierHits(config, input, inTier) {
    const hits = [];
    for (let index = 0; index < config.rules.length; index += 1) {
        const rule = config.rules[index];
        if (rule === undefined || !inTier(rule))
            continue;
        if (!planeRuleMatches(rule, input))
            continue;
        hits.push({ index, plane: rule.plane, reason: rule.reason });
    }
    return hits;
}
/**
 * Deterministic, fail-closed rule evaluation in two tiers with
 * explicit-beats-general precedence: a table claimed by ANY `tables`
 * rule resolves ONLY against `tables` rules — `match` (glob) rules are
 * ignored for it; glob rules apply only to tables no explicit rule
 * claims. WHY: an enumerated name list is a more specific human claim
 * than a directory glob, and a glob's `exclude` prunes source files —
 * it cannot enumerate table-name claims — so cross-tier overlap must
 * not read as contradiction. Within the deciding tier: every hit
 * agreeing → that plane; any disagreement → `conflict` with no plane
 * (fail closed: never guess between planes); no hit → no plane. The
 * no-match case is deliberate: the resource stays plane-unresolved and
 * the core classifier blocks it, so a config covers every table or the
 * gate stays red (closed-world completeness).
 */
export function resolvePlaneByRules(config, input) {
    const explicit = collectTierHits(config, input, isTablesRule);
    const hits = explicit.length > 0 ? explicit : collectTierHits(config, input, isMatchRule);
    const first = hits[0];
    if (first !== undefined && hits.every((hit) => hit.plane === first.plane)) {
        return { plane: first.plane, hits, conflict: false };
    }
    return { plane: null, hits, conflict: hits.length > 0 };
}
//# sourceMappingURL=planes.js.map