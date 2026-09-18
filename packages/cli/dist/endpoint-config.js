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
import { readFileSync } from 'node:fs';
import { globMatch } from '@gate-forge/core';
/** Repo-root-relative location of the declarative endpoint config. */
export const ENDPOINTS_CONFIG_PATH = '.gateforge/endpoints.json';
/**
 * The closed capability vocabulary a rule may assert — exactly the
 * compiler's own rule vocabulary (path/handler shapes plus the
 * corroborated crud fallbacks and both delete semantics). A declared
 * `crud-delete`/`crud-archive` on a DELETE endpoint resolves the
 * archive-vs-hard question the linked model could not prove.
 */
export const ENDPOINT_CAPABILITIES = [
    'health-operations',
    'auth-session',
    'webhook-callback',
    'workflow-command',
    'task-async',
    'search-query',
    'validation-preview',
    'file-transfer',
    'ai-automation',
    'realtime',
    'crud-create',
    'crud-read',
    'crud-update',
    'crud-delete',
    'crud-archive',
];
/** Concrete HTTP methods a rule may pin (never `ANY` — that is not a method). */
const RULE_METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'];
/** The only keys a rule object may carry. */
const RULE_KEYS = ['match', 'handlers', 'paths', 'method', 'capability', 'reason'];
/** The absent-config default: no rules, no declarations (noop). */
export const DEFAULT_ENDPOINTS_CONFIG = { rules: [] };
/**
 * Validates one glob pattern with the constraint's own path domain:
 * - `match` patterns are repo-root-relative posix globs (same posture
 *   as the planes config — absolute, drive-qualified, backslash, and
 *   `..`-escaping patterns are rejected);
 * - `paths` patterns are canonical URL paths and must start with `/`;
 * - `handlers` patterns are code-identifier globs, shape-validated only.
 */
function validatePattern(raw, at, domain) {
    if (typeof raw !== 'string' || raw.length === 0) {
        throw new Error(`invalid endpoints config: ${at} must be a non-empty string`);
    }
    if (domain === 'repo') {
        if (raw.includes('\\')) {
            throw new Error(`invalid endpoints config: ${at} must use posix '/' separators ` +
                `(repo-root-relative): ${JSON.stringify(raw)}`);
        }
        if (raw.startsWith('/') || /^[A-Za-z]:/.test(raw)) {
            throw new Error(`invalid endpoints config: ${at} must be a repo-root-relative glob: ${JSON.stringify(raw)}`);
        }
        if (raw.split('/').includes('..')) {
            throw new Error(`invalid endpoints config: ${at} must not escape the repo root ('..'): ${JSON.stringify(raw)}`);
        }
    }
    else if (domain === 'url' && !raw.startsWith('/')) {
        throw new Error(`invalid endpoints config: ${at} must start with '/' (it matches a canonical URL path): ` +
            JSON.stringify(raw));
    }
    return raw;
}
/** Validates one pattern-list constraint (non-empty array of globs). */
function validatePatternList(raw, at, domain) {
    if (!Array.isArray(raw) || raw.length === 0) {
        throw new Error(`invalid endpoints config: ${at} must be a non-empty array of globs`);
    }
    return raw.map((pattern, entry) => validatePattern(pattern, `${at}[${entry}]`, domain));
}
/** Validates one rule object (fail closed; first cause wins, in order). */
function parseEndpointCapabilityRule(value, index) {
    const at = `rules[${index}]`;
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error(`invalid endpoints config: ${at} must be an object`);
    }
    const record = value;
    const unknownKeys = Object.keys(record).filter((key) => !RULE_KEYS.includes(key));
    if (unknownKeys.length > 0) {
        // Strict on purpose: a typo'd key ('capabilty') would otherwise
        // silently drop a reviewed rule and un-declare exactly its endpoints.
        throw new Error(`invalid endpoints config: ${at} has unknown key(s) ${unknownKeys.sort().join(', ')}`);
    }
    const hasMatch = record['match'] !== undefined;
    const hasHandlers = record['handlers'] !== undefined;
    const hasPaths = record['paths'] !== undefined;
    if (!hasMatch && !hasHandlers && !hasPaths) {
        throw new Error(`invalid endpoints config: ${at} must carry at least one of ` +
            `'match', 'handlers', or 'paths' (an unconstrained rule would declare every endpoint)`);
    }
    let method;
    if (record['method'] !== undefined) {
        const raw = record['method'];
        if (typeof raw !== 'string' || !RULE_METHODS.includes(raw)) {
            throw new Error(`invalid endpoints config: ${at}.method must be one of: ` +
                `${RULE_METHODS.map((value) => `'${value}'`).join(', ')} (never 'ANY')`);
        }
        method = raw;
    }
    const capability = record['capability'];
    if (typeof capability !== 'string' ||
        !ENDPOINT_CAPABILITIES.includes(capability)) {
        throw new Error(`invalid endpoints config: ${at}.capability must be one of: ` +
            `${ENDPOINT_CAPABILITIES.map((value) => `'${value}'`).join(', ')}`);
    }
    const reason = record['reason'];
    if (typeof reason !== 'string' || reason.trim().length === 0) {
        throw new Error(`invalid endpoints config: ${at}.reason must be a non-empty string ` +
            '(the config is a human review artifact)');
    }
    return {
        ...(hasMatch ? { match: validatePattern(record['match'], `${at}.match`, 'repo') } : {}),
        ...(hasHandlers
            ? { handlers: validatePatternList(record['handlers'], `${at}.handlers`, 'identifier') }
            : {}),
        ...(hasPaths ? { paths: validatePatternList(record['paths'], `${at}.paths`, 'url') } : {}),
        ...(method !== undefined ? { method } : {}),
        capability: capability,
        reason,
    };
}
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
export function readEndpointsConfigOrNull(path) {
    if (path === null)
        return DEFAULT_ENDPOINTS_CONFIG;
    let text;
    try {
        text = readFileSync(path, 'utf8');
    }
    catch {
        return DEFAULT_ENDPOINTS_CONFIG; // absence is normal; malformed is not (below)
    }
    const parsed = JSON.parse(text);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error(`invalid endpoints config: expected an object at ${path}`);
    }
    const document = parsed;
    const unknownKeys = Object.keys(document).filter((key) => key !== 'rules');
    if (unknownKeys.length > 0) {
        throw new Error(`invalid endpoints config: unknown key(s) ${unknownKeys.sort().join(', ')} at ${path}`);
    }
    const rules = document['rules'];
    if (!Array.isArray(rules)) {
        throw new Error(`invalid endpoints config: 'rules' must be an array of rule objects at ${path}`);
    }
    return { rules: rules.map((rule, index) => parseEndpointCapabilityRule(rule, index)) };
}
/**
 * The simple (last segment) name of a handler symbol: the part after
 * the module separator `:` with any dotted attribute scope stripped
 * (`app.api.analytics:get_analytics_logs` → `get_analytics_logs`).
 * Exported for the compiler, which builds each identity's
 * `matchHandlers` list from its contributing route facts.
 */
export function handlerSimpleName(handlerSymbol) {
    const withoutModule = handlerSymbol.includes(':')
        ? handlerSymbol.slice(handlerSymbol.lastIndexOf(':') + 1)
        : handlerSymbol;
    return withoutModule.includes('.')
        ? withoutModule.slice(withoutModule.lastIndexOf('.') + 1)
        : withoutModule;
}
/**
 * Whether one config rule matches one endpoint identity. Every selector
 * the rule carries must hold (AND semantics — a rule narrows its own
 * surface): the router source path glob against ANY contributing route's
 * file, any handler glob against ANY contributing route's handler simple
 * name, any path glob against the identity's canonical path, and an
 * optional exact method against the identity's method. A `handlers`
 * rule never matches a handler-less identity (no evidence, no claim).
 */
export function endpointRuleMatches(rule, input) {
    if (rule.match !== undefined) {
        if (!input.matchSources.some((source) => globMatch(source, rule.match)))
            return false;
    }
    if (rule.handlers !== undefined) {
        if (!input.matchHandlers.some((name) => rule.handlers?.some((pattern) => globMatch(name, pattern)))) {
            return false;
        }
    }
    if (rule.paths !== undefined) {
        if (!rule.paths.some((pattern) => globMatch(input.canonicalPath, pattern)))
            return false;
    }
    if (rule.method !== undefined && rule.method !== input.method)
        return false;
    return true;
}
/**
 * Deterministic, fail-closed rule evaluation for one endpoint identity:
 * collect every matching rule in config order; when they all assert the
 * SAME capability, that capability is declared (duplicated assertions
 * are one declaration — review artifacts may overlap); when they
 * disagree, `conflict` is true and NOTHING is applied (the compiler
 * emits the typed contradiction — never first-rule-wins).
 */
export function resolveDeclaredCapabilities(config, input) {
    const hits = [];
    for (let index = 0; index < config.rules.length; index += 1) {
        const rule = config.rules[index];
        if (rule === undefined || !endpointRuleMatches(rule, input))
            continue;
        hits.push({ index, capability: rule.capability, reason: rule.reason });
    }
    const first = hits[0];
    const conflict = first !== undefined && hits.some((hit) => hit.capability !== first.capability);
    return { hits, conflict };
}
//# sourceMappingURL=endpoint-config.js.map