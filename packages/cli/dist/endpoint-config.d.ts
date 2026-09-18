/**
 * Declarative endpoint-capability config (`.gateforge/endpoints.json`).
 *
 * The endpoint compiler derives capabilities from detector FACTS only
 * (method/path/handler-name/schema/link); a handler whose logic lives in
 * a service module has no positive evidence and fail-closes with
 * `ENDPOINT_SEMANTICS_UNRESOLVED`. This channel is the explicit escape
 * hatch that message promises: a human asserts what an endpoint DOES,
 * keyed on router source path, handler simple name, canonical path,
 * and/or exact method — every rule carrying a non-empty `reason`, the
 * review artifact.
 *
 * Posture mirrors `.gateforge/planes.json` exactly (same reader shape,
 * same fail-closed semantics):
 * - absence is normal and byte-identical to not having the channel;
 * - a malformed document throws (the CLI surfaces a config error rather
 *   than scanning with partial trust);
 * - ALL matching rules must AGREE: agreement applies the declared
 *   capability (composed with detected ones — capabilities concatenate,
 *   only `crud-*` fallbacks defer); disagreement emits a typed
 *   `ENDPOINT_CAPABILITY_CONTRADICTION` blocking entry and applies
 *   nothing — never first-rule-wins.
 */
import type { HttpMethod } from '@gate-forge/http-contract';
/** Repo-root-relative location of the declarative endpoint config. */
export declare const ENDPOINTS_CONFIG_PATH = ".gateforge/endpoints.json";
/**
 * The closed capability vocabulary a rule may assert — exactly the
 * compiler's own rule vocabulary (path/handler shapes plus the
 * corroborated crud fallbacks and both delete semantics). A declared
 * `crud-delete`/`crud-archive` on a DELETE endpoint resolves the
 * archive-vs-hard question the linked model could not prove.
 */
export declare const ENDPOINT_CAPABILITIES: readonly ["health-operations", "auth-session", "webhook-callback", "workflow-command", "task-async", "search-query", "validation-preview", "file-transfer", "ai-automation", "realtime", "crud-create", "crud-read", "crud-update", "crud-delete", "crud-archive"];
/** One declared endpoint capability. */
export type EndpointCapability = (typeof ENDPOINT_CAPABILITIES)[number];
/** One reviewed capability rule of the declarative endpoint config. */
export interface EndpointCapabilityRule {
    /**
     * Repo-root-relative glob matched against the endpoint's ROUTER
     * SOURCE FILE path (core glob semantics: `*` within one segment,
     * `**` across segments, `?` one character).
     */
    readonly match?: string;
    /**
     * Glob patterns matched against the handler's SIMPLE name (the last
     * segment of `handlerSymbol`; a route fact with no handler symbol
     * never matches a `handlers` constraint). Case-sensitive: code
     * identifiers are matched as written.
     */
    readonly handlers?: readonly string[];
    /**
     * Glob patterns matched against the endpoint's CANONICAL path
     * (`/analytics/**`); patterns must start with `/` — they are URL
     * paths, not repo paths.
     */
    readonly paths?: readonly string[];
    /** Exact HTTP method this rule is scoped to (never `ANY`). */
    readonly method?: HttpMethod;
    /** The capability this rule asserts (strict vocabulary). */
    readonly capability: EndpointCapability;
    /** Required non-empty human rationale; rides contradiction diagnostics. */
    readonly reason: string;
}
/** Parsed `.gateforge/endpoints.json` document (strict schema). */
export interface EndpointsConfig {
    readonly rules: readonly EndpointCapabilityRule[];
}
/** The absent-config default: no rules, no declarations (noop). */
export declare const DEFAULT_ENDPOINTS_CONFIG: EndpointsConfig;
/**
 * Reads a declarative endpoint config document. Returns the default
 * config when the file is absent (normal; byte-identical to not having
 * the channel); malformed documents throw (fail closed — the CLI
 * surfaces the error instead of compiling with partial trust).
 *
 * Accepted shape: `{ rules: [{ match?, handlers?, paths?, method?,
 * capability, reason }] }` — a rule carries AT LEAST ONE selector
 * (`match` router-file glob, `handlers` handler-simple-name globs,
 * `paths` canonical-path globs), an optional exact `method`, always a
 * strict `capability` and a non-empty human `reason`.
 */
export declare function readEndpointsConfigOrNull(path: string | null): EndpointsConfig;
/** The facts one endpoint identity is matched against. */
export interface EndpointMatchInput {
    /**
     * Repo-root-relative ROUTER SOURCE FILE paths of EVERY contributing
     * route (a merged identity can be contributed by several files).
     */
    readonly matchSources: readonly string[];
    /**
     * Handler SIMPLE names of every contributing route (last segment of
     * `handlerSymbol`; routes without a handler symbol contribute none).
     */
    readonly matchHandlers: readonly string[];
    /** The endpoint identity's canonical path. */
    readonly canonicalPath: string;
    /** The endpoint identity's concrete method. */
    readonly method: HttpMethod;
}
/** One rule that matched an endpoint (config order preserved). */
export interface EndpointRuleHit {
    /** The rule's 0-based index in the config document. */
    readonly index: number;
    /** The capability the rule asserts. */
    readonly capability: EndpointCapability;
    /** The rule's human review rationale. */
    readonly reason: string;
}
/** The deterministic outcome of rule evaluation for one endpoint. */
export interface EndpointCapabilityResolution {
    /** Every matching rule's declaration, in config order (may be empty). */
    readonly hits: readonly EndpointRuleHit[];
    /** True when ≥2 rules matched and assert DIFFERENT capabilities. */
    readonly conflict: boolean;
}
/**
 * The simple (last segment) name of a handler symbol: the part after
 * the module separator `:` with any dotted attribute scope stripped
 * (`app.api.analytics:get_analytics_logs` → `get_analytics_logs`).
 * Exported for the compiler, which builds each identity's
 * `matchHandlers` list from its contributing route facts.
 */
export declare function handlerSimpleName(handlerSymbol: string): string;
/**
 * Whether one config rule matches one endpoint identity. Every selector
 * the rule carries must hold (AND semantics — a rule narrows its own
 * surface): the router source path glob against ANY contributing route's
 * file, any handler glob against ANY contributing route's handler simple
 * name, any path glob against the identity's canonical path, and an
 * optional exact method against the identity's method. A `handlers`
 * rule never matches a handler-less identity (no evidence, no claim).
 */
export declare function endpointRuleMatches(rule: EndpointCapabilityRule, input: EndpointMatchInput): boolean;
/**
 * Deterministic, fail-closed rule evaluation for one endpoint identity:
 * collect every matching rule in config order; when they all assert the
 * SAME capability, that capability is declared (duplicated assertions
 * are one declaration — review artifacts may overlap); when they
 * disagree, `conflict` is true and NOTHING is applied (the compiler
 * emits the typed contradiction — never first-rule-wins).
 */
export declare function resolveDeclaredCapabilities(config: EndpointsConfig, input: EndpointMatchInput): EndpointCapabilityResolution;
//# sourceMappingURL=endpoint-config.d.ts.map