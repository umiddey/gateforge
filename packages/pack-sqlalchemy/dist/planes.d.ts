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
/** The plane enum the graph accepts. */
export type SqlalchemyPlane = 'tenant' | 'master' | 'global';
/** Facts about one table resource a plane rule can key on. */
export interface PlaneContext {
    tableName: string;
    classQname: string | null;
    provenance: string;
}
/** A plane rule returns a plane, or null to leave binding to core. */
export type PlaneRule = (context: PlaneContext) => SqlalchemyPlane | null;
/** The empty rule; core derives plane from normalized signals. */
export declare const NO_PLANE_MAPPING: PlaneRule;
/** Rule that maps table names to planes; unmapped tables stay null. */
export declare function byTableName(mapping: Record<string, SqlalchemyPlane>): PlaneRule;
/** Repo-root-relative location of the declarative plane config document. */
export declare const PLANES_CONFIG_PATH = ".gateforge/planes.json";
/** One reviewed rule of the declarative plane config. */
export interface PlaneConfigRule {
    /**
     * Repo-root-relative glob matched against the resource's SOURCE FILE
     * path, with core's classifier glob semantics (`*` within one path
     * segment, `**` across segments, `?` one character).
     */
    readonly match?: string;
    /**
     * Explicit names matched against the resource's table `resourceName`
     * OR its class simple name. Matching either is deliberate: the table
     * name and the declaring class name are both identity evidence for
     * the same resource. Explicit-beats-general: any table claimed here
     * resolves only against `tables` rules — `match` globs are ignored
     * for it (an enumeration is a more specific human claim, and a
     * glob's `exclude` prunes source files, not table names).
     */
    readonly tables?: readonly string[];
    /**
     * Repo-root-relative globs pruning whole FILES from this rule's
     * surface: when the resource's source path matches ANY of them the
     * rule does not apply at all (checked before tier collection, so an
     * excluded file cannot collide with a narrower per-file rule).
     * Valid only together with `match` — the reader rejects
     * `tables` + `exclude` at read time. WHY: real directory surfaces
     * mix planes (a `backend/api/v1/**` of contractor-scoped routers
     * beside global-ingress files such as `public_payment.py`); without
     * a documented exclusion the narrow per-file rules collide with the
     * directory glob inside one tier and block as
     * `PLANE_RULE_CONTRADICTION`. The exceptions live here, explicit and
     * reviewed (they ride the same `reason` artifact), rather than being
     * resolved by silent rule precedence.
     */
    readonly exclude?: readonly string[];
    /** The plane this rule asserts (strictly `tenant`|`master`|`global`). */
    readonly plane: SqlalchemyPlane;
    /** Required non-empty human rationale; rides conflict diagnostics. */
    readonly reason: string;
}
/** Parsed `.gateforge/planes.json` document (strict schema). */
export interface PlanesConfig {
    readonly rules: readonly PlaneConfigRule[];
}
/** The absent-config default: no rules, no mapping (byte-identical noop). */
export declare const DEFAULT_PLANES_CONFIG: PlanesConfig;
/**
 * Parses and validates one declarative plane config DOCUMENT TEXT
 * (strict; every rule reviewed). Exported for generators that must
 * self-check a proposed document BEFORE writing it (e.g. `gateforge
 * init --planes`) — the exact validation the runtime reader applies,
 * applied to the draft.
 *
 * Accepted shape: `{ rules: [{ match?, exclude?, tables?, plane, reason }] }` — a
 * rule carries EXACTLY ONE of `match` (repo-root-relative source-path
 * glob) or `tables` (explicit tableName / class-simple-name list),
 * always with a strict `plane` and a non-empty human `reason`; a
 * `match` rule may additionally carry `exclude` (a non-empty list of
 * repo-root-relative globs pruning files from its surface — rejected
 * on a `tables` rule).
 */
export declare function parsePlanesConfigText(text: string, path: string): PlanesConfig;
/**
 * Reads a declarative plane config document. Returns the default config
 * when the file is absent (normal; byte-identical to
 * {@link NO_PLANE_MAPPING}); malformed documents throw (fail closed —
 * the CLI surfaces the error instead of scanning with partial trust).
 */
export declare function readPlanesConfigOrNull(path: string | null): PlanesConfig;
/** The facts one `sqlalchemy.table` resource is matched against. */
export interface PlaneMatchInput {
    /** Repo-root-relative source file path of the resource. */
    readonly sourcePath: string;
    /** The table name (`attributes.resourceName`). */
    readonly tableName: string;
    /** Simple (last `.`-segment) class name; null for Table()-call resources. */
    readonly classSimpleName: string | null;
}
/** One rule that matched a resource (config order preserved). */
export interface PlaneRuleHit {
    /** The rule's 0-based index in the config document. */
    readonly index: number;
    /** The plane the rule asserts. */
    readonly plane: SqlalchemyPlane;
    /** The rule's human review rationale. */
    readonly reason: string;
}
/** The deterministic outcome of rule evaluation for one resource. */
export interface PlaneResolution {
    /**
     * The agreed plane, or null when NO rule of the resource's deciding
     * tier matched or that tier's rules conflict (fail closed: never
     * guess between planes).
     */
    readonly plane: SqlalchemyPlane | null;
    /**
     * Every hit of the DECIDING tier, in config order — the `tables`
     * tier when any `tables` rule claimed the resource, else the `match`
     * tier (diagnostics input).
     */
    readonly hits: readonly PlaneRuleHit[];
    /** True when ≥2 rules of the deciding tier matched and disagree. */
    readonly conflict: boolean;
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
export declare function planeRuleMatches(rule: PlaneConfigRule, input: PlaneMatchInput): boolean;
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
export declare function resolvePlaneByRules(config: PlanesConfig, input: PlaneMatchInput): PlaneResolution;
//# sourceMappingURL=planes.d.ts.map