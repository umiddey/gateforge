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
import type { HttpMethod } from '@gate-forge/http-contract';

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
] as const;

/** One declared endpoint capability. */
export type EndpointCapability = (typeof ENDPOINT_CAPABILITIES)[number];

/** Concrete HTTP methods a rule may pin (never `ANY` — that is not a method). */
const RULE_METHODS: readonly string[] = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'];

/** The only keys a rule object may carry. */
const RULE_KEYS: readonly string[] = ['match', 'handlers', 'paths', 'method', 'capability', 'reason'];

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
export const DEFAULT_ENDPOINTS_CONFIG: EndpointsConfig = { rules: [] };

/**
 * Validates one glob pattern with the constraint's own path domain:
 * - `match` patterns are repo-root-relative posix globs (same posture
 *   as the planes config — absolute, drive-qualified, backslash, and
 *   `..`-escaping patterns are rejected);
 * - `paths` patterns are canonical URL paths and must start with `/`;
 * - `handlers` patterns are code-identifier globs, shape-validated only.
 */
function validatePattern(raw: unknown, at: string, domain: 'repo' | 'url' | 'identifier'): string {
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new Error(`invalid endpoints config: ${at} must be a non-empty string`);
  }
  if (domain === 'repo') {
    if (raw.includes('\\')) {
      throw new Error(
        `invalid endpoints config: ${at} must use posix '/' separators ` +
          `(repo-root-relative): ${JSON.stringify(raw)}`,
      );
    }
    if (raw.startsWith('/') || /^[A-Za-z]:/.test(raw)) {
      throw new Error(
        `invalid endpoints config: ${at} must be a repo-root-relative glob: ${JSON.stringify(raw)}`,
      );
    }
    if (raw.split('/').includes('..')) {
      throw new Error(
        `invalid endpoints config: ${at} must not escape the repo root ('..'): ${JSON.stringify(raw)}`,
      );
    }
  } else if (domain === 'url' && !raw.startsWith('/')) {
    throw new Error(
      `invalid endpoints config: ${at} must start with '/' (it matches a canonical URL path): ` +
        JSON.stringify(raw),
    );
  }
  return raw;
}

/** Validates one pattern-list constraint (non-empty array of globs). */
function validatePatternList(
  raw: unknown,
  at: string,
  domain: 'repo' | 'url' | 'identifier',
): readonly string[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error(`invalid endpoints config: ${at} must be a non-empty array of globs`);
  }
  return raw.map((pattern, entry) => validatePattern(pattern, `${at}[${entry}]`, domain));
}

/** Validates one rule object (fail closed; first cause wins, in order). */
function parseEndpointCapabilityRule(value: unknown, index: number): EndpointCapabilityRule {
  const at = `rules[${index}]`;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`invalid endpoints config: ${at} must be an object`);
  }
  const record = value as Record<string, unknown>;
  const unknownKeys = Object.keys(record).filter((key) => !RULE_KEYS.includes(key));
  if (unknownKeys.length > 0) {
    // Strict on purpose: a typo'd key ('capabilty') would otherwise
    // silently drop a reviewed rule and un-declare exactly its endpoints.
    throw new Error(
      `invalid endpoints config: ${at} has unknown key(s) ${unknownKeys.sort().join(', ')}`,
    );
  }
  const hasMatch = record['match'] !== undefined;
  const hasHandlers = record['handlers'] !== undefined;
  const hasPaths = record['paths'] !== undefined;
  if (!hasMatch && !hasHandlers && !hasPaths) {
    throw new Error(
      `invalid endpoints config: ${at} must carry at least one of ` +
        `'match', 'handlers', or 'paths' (an unconstrained rule would declare every endpoint)`,
    );
  }
  let method: HttpMethod | undefined;
  if (record['method'] !== undefined) {
    const raw = record['method'];
    if (typeof raw !== 'string' || !RULE_METHODS.includes(raw)) {
      throw new Error(
        `invalid endpoints config: ${at}.method must be one of: ` +
          `${RULE_METHODS.map((value) => `'${value}'`).join(', ')} (never 'ANY')`,
      );
    }
    method = raw as HttpMethod;
  }
  const capability = record['capability'];
  if (
    typeof capability !== 'string' ||
    !ENDPOINT_CAPABILITIES.includes(capability as EndpointCapability)
  ) {
    throw new Error(
      `invalid endpoints config: ${at}.capability must be one of: ` +
        `${ENDPOINT_CAPABILITIES.map((value) => `'${value}'`).join(', ')}`,
    );
  }
  const reason = record['reason'];
  if (typeof reason !== 'string' || reason.trim().length === 0) {
    throw new Error(
      `invalid endpoints config: ${at}.reason must be a non-empty string ` +
        '(the config is a human review artifact)',
    );
  }
  return {
    ...(hasMatch ? { match: validatePattern(record['match'], `${at}.match`, 'repo') } : {}),
    ...(hasHandlers
      ? { handlers: validatePatternList(record['handlers'], `${at}.handlers`, 'identifier') }
      : {}),
    ...(hasPaths ? { paths: validatePatternList(record['paths'], `${at}.paths`, 'url') } : {}),
    ...(method !== undefined ? { method } : {}),
    capability: capability as EndpointCapability,
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
export function readEndpointsConfigOrNull(path: string | null): EndpointsConfig {
  if (path === null) return DEFAULT_ENDPOINTS_CONFIG;
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return DEFAULT_ENDPOINTS_CONFIG; // absence is normal; malformed is not (below)
  }
  const parsed: unknown = JSON.parse(text);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`invalid endpoints config: expected an object at ${path}`);
  }
  const document = parsed as Record<string, unknown>;
  const unknownKeys = Object.keys(document).filter((key) => key !== 'rules');
  if (unknownKeys.length > 0) {
    throw new Error(
      `invalid endpoints config: unknown key(s) ${unknownKeys.sort().join(', ')} at ${path}`,
    );
  }
  const rules = document['rules'];
  if (!Array.isArray(rules)) {
    throw new Error(
      `invalid endpoints config: 'rules' must be an array of rule objects at ${path}`,
    );
  }
  return { rules: rules.map((rule, index) => parseEndpointCapabilityRule(rule, index)) };
}

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
export function handlerSimpleName(handlerSymbol: string): string {
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
export function endpointRuleMatches(rule: EndpointCapabilityRule, input: EndpointMatchInput): boolean {
  if (rule.match !== undefined) {
    if (!input.matchSources.some((source) => globMatch(source, rule.match as string))) return false;
  }
  if (rule.handlers !== undefined) {
    if (
      !input.matchHandlers.some((name) =>
        rule.handlers?.some((pattern) => globMatch(name, pattern)),
      )
    ) {
      return false;
    }
  }
  if (rule.paths !== undefined) {
    if (!rule.paths.some((pattern) => globMatch(input.canonicalPath, pattern))) return false;
  }
  if (rule.method !== undefined && rule.method !== input.method) return false;
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
export function resolveDeclaredCapabilities(
  config: EndpointsConfig,
  input: EndpointMatchInput,
): EndpointCapabilityResolution {
  const hits: EndpointRuleHit[] = [];
  for (let index = 0; index < config.rules.length; index += 1) {
    const rule = config.rules[index];
    if (rule === undefined || !endpointRuleMatches(rule, input)) continue;
    hits.push({ index, capability: rule.capability, reason: rule.reason });
  }
  const first = hits[0];
  const conflict = first !== undefined && hits.some((hit) => hit.capability !== first.capability);
  return { hits, conflict };
}
