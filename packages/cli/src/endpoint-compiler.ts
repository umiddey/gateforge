/**
 * The endpoint compiler (ADR 0004 D5/D6, plan phase 4): a deterministic
 * CLI-pipeline stage that consumes every detector contribution's
 * `http.contract` facts, joins frontend calls to backend routes
 * (`@gateforge/http-contract`), classifies endpoint capabilities with
 * rules over detector FACTS (never framework syntax), links endpoints to
 * business resources only through unambiguous evidence, and emits a
 * synthetic `gateforge.endpoint-compiler` contribution whose endpoint
 * resources are classified like any other resource.
 *
 * Guarantees:
 * - pure function of the contributions plus the optional declarative
 *   endpoint-plane config; input permutation yields byte-identical
 *   output;
 * - unwired calls, ambiguous joins, unresolved semantics, and ambiguous
 *   linkage become typed blocking entries — never guesses, never
 *   first-match-wins, never absence-as-internal;
 * - HTTP method is one candidate among many: command suffixes beat
 *   methods, and every `crud-*` rule demands corroboration (schema
 *   symbols, response model, or a linked business resource);
 * - entity linkage is an explicit attribute, never the path-derived name
 *   itself (the route/table collision red probe stays green).
 *
 * Endpoint-plane config channel (plan phase 5): the SAME
 * `.gateforge/planes.json` document that classifies business tables can
 * declare endpoint planes — an explicit, human-reviewed declaration
 * keyed on the ROUTER SOURCE FILE path (`match` globs; `tables` rules
 * never apply to endpoints). ALL matching rules must agree: agreement
 * emits a plane-dimension signal exactly like the classifier's
 * inheritance channel; disagreement emits a typed
 * `PLANE_RULE_CONTRADICTION` blocking entry and no plane evidence; no
 * matching rule leaves the endpoint on the inheritance/operational/
 * unresolved channels as before. Absence of the config file is normal
 * and byte-identical to not having this channel; a malformed document
 * throws (fail closed). The config plane participates as EVIDENCE, never
 * as a blanket override: when the linked-resource/operational plane
 * derivable from the contributions contradicts it, both assertions are
 * emitted so the classifier blocks with `PLANE_CONTRADICTION`.
 */
import { join as joinPath } from 'node:path';
import {
  ENDPOINT_RESOURCE_LINK_UNRESOLVED,
  ENDPOINT_SEMANTICS_UNRESOLVED,
  HTTP_CONTRACT_KIND,
  HTTP_ENDPOINT_KIND,
  HttpContractFactSchema,
  canonicalEndpointIdentity,
  derivePathResourceName,
  endpointResourceName,
  joinFrontendCalls,
  type HttpContractFact,
  type HttpLocation,
  type HttpMethod,
  type JoinBlock,
} from '@gateforge/http-contract';
import { HTTP_ENDPOINT_RESOURCE_KIND, type DetectorOutput, type Finding, type Resource } from '@gateforge/core';
import {
  PLANE_RULE_CONTRADICTION,
  PLANES_CONFIG_PATH,
  readPlanesConfigOrNull,
  resolvePlaneByRules,
  type PlanesConfig,
} from '@gateforge/pack-sqlalchemy';
import { UsageError } from './errors.js';

/** Detector id of the synthetic compiler contribution (engine-issued). */
export const ENDPOINT_COMPILER_DETECTOR_ID = 'gateforge.endpoint-compiler';

/** Schema version of the compiler's output payloads. */
export const ENDPOINT_COMPILER_VERSION = '1';

/** One compiled endpoint and every fact behind it. */
export interface EndpointRecord {
  method: HttpMethod;
  canonicalPath: string;
  identity: string;
  resourceName: string;
  capabilities: string[];
  capabilityTrace: Array<{ capability: string; rule: string; evidence: string }>;
  linkedResourceName: string | null;
  frontendConsumed: boolean;
  deleteSemantics: 'hard' | 'archive' | null;
  routes: HttpContractFact[];
  calls: HttpContractFact[];
}

export interface EndpointInventory {
  /** All parsed contract facts, canonical order. */
  facts: HttpContractFact[];
  /** Every compiled endpoint (consumed and unconsumed), sorted by identity. */
  endpoints: EndpointRecord[];
  /** Unmatched frontend calls (typed blocks). */
  unwired: JoinBlock[];
  /** Ambiguous joins (typed blocks). */
  ambiguous: JoinBlock[];
}

export interface CompileResult {
  /** Synthetic contribution to merge into buildResourceGraph inputs. */
  contribution: DetectorOutput;
  inventory: EndpointInventory;
}

/** Business-resource name candidates for linkage (from contributions). */
interface BusinessResourceName {
  name: string;
  kind: string;
  /** Declaration location of the first same-named resource (diagnostics). */
  location: HttpLocation;
  /**
   * Plane evidence visible at compile time for this resource name:
   * `attributes.plane` across same-named business (non-endpoint)
   * resources plus plane-dimension signal assertions targeting the name.
   * Mirrors what the classifier's `resolveEndpointPlanes` reads off the
   * linked decision — minus evidence minted only after compilation.
   */
  planes: Set<string>;
}

interface CapabilityContext {
  method: HttpMethod;
  pathLower: string;
  handlerLower: string;
  hasRequestSchemas: boolean;
  hasResponseModel: boolean;
  linked: boolean;
  consumed: boolean;
}

interface CapabilityRule {
  capability: string;
  rule: string;
  test: (ctx: CapabilityContext) => boolean;
}

const COMMAND_SUFFIXES =
  '(approve|finalize|submit|sign|reject|cancel|retry|clone|activate|deactivate|terminate|transition|publish|expire|suspend|resume|revoke|restore)';

/**
 * Suffixes stripped when normalizing a schema/model symbol for linkage
 * corroboration (ADR 0004 D5). One suffix, case-insensitive, at most.
 */
const SCHEMA_SYMBOL_SUFFIXES = [
  'out',
  'in',
  'dto',
  'schema',
  'model',
  'payload',
  'response',
  'request',
  'create',
  'update',
  'read',
] as const;

/**
 * Exact, non-fuzzy schema-symbol corroboration rule:
 * - take the symbol's LAST dotted segment, lowercased;
 * - candidate forms are the bare segment plus the segment with ONE of
 *   `SCHEMA_SYMBOL_SUFFIXES` stripped (case-insensitive, non-empty rest);
 * - the symbol corroborates the candidate when a form equals the
 *   candidate OR the candidate with ONE trailing 's' removed (plural
 *   tolerance, e.g. `AccountOut` corroborates `accounts`).
 * Total and deterministic: no substring or edit-distance matching.
 */
export function symbolCorroborates(symbol: string, candidate: string): boolean {
  const lastSegment = symbol.includes('.') ? symbol.slice(symbol.lastIndexOf('.') + 1) : symbol;
  const lower = lastSegment.toLowerCase();
  const forms = [lower];
  for (const suffix of SCHEMA_SYMBOL_SUFFIXES) {
    if (lower.length > suffix.length && lower.endsWith(suffix)) {
      forms.push(lower.slice(0, lower.length - suffix.length));
    }
  }
  const singularCandidate = candidate.endsWith('s') ? candidate.slice(0, -1) : candidate;
  return forms.includes(candidate) || forms.includes(singularCandidate);
}

/**
 * Exact, non-fuzzy handler-name corroboration rule:
 * - take the handler symbol's LAST segment after the final ':' or '.',
 *   lowercased;
 * - normalize the candidate to singular by removing ONE trailing 's' if
 *   present;
 * - the handler corroborates the candidate when the candidate OR its
 *   singular form appears as a whole snake_case word, i.e. delimited by
 *   '_' or string start/end (equality, `_x`, `x_`, or `_x_`).
 * Total and deterministic: no substring or edit-distance matching.
 */
export function handlerCorroborates(handlerSymbol: string, candidate: string): boolean {
  const afterColon = handlerSymbol.includes(':')
    ? handlerSymbol.slice(handlerSymbol.lastIndexOf(':') + 1)
    : handlerSymbol;
  const lastSegment = afterColon.includes('.')
    ? afterColon.slice(afterColon.lastIndexOf('.') + 1)
    : afterColon;
  // camelCase boundaries count as snake_case word boundaries: the
  // lowercase fold alone would glue `listAccounts` into one word and
  // miss the `accounts` candidate.
  const handler = lastSegment
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase();
  const singular = candidate.endsWith('s') ? candidate.slice(0, -1) : candidate;
  const forms = candidate === singular ? [candidate] : [candidate, singular];
  for (const form of forms) {
    if (
      handler === form ||
      handler.startsWith(`${form}_`) ||
      handler.endsWith(`_${form}`) ||
      handler.includes(`_${form}_`)
    ) {
      return true;
    }
  }
  return false;
}

/**
 * The genuine operational-probe path shape (plan §6 "Health/operations").
 *
 * WHY segment-exact + depth-capped: the previous rule matched the probe
 * words at ANY depth, so business sub-resources whose paths happen to
 * contain a probe-sounding SEGMENT were misclassified operational-global
 * (health-operations) — silently exempting them from adapters and
 * obligations (a dogfood enforcement hole). Concrete false positives:
 * `…/operating-costs/settlements/{}/readiness` and
 * `…/meter-readings/readiness` (business readiness states, via the then-
 * listed `readiness`), `/admin/imports/task/{}/status` (business job
 * status, via `status`), `/admin/clients/{}/health` (per-client health
 * sub-resource, via `health`). An infrastructure probe is a TOP-LEVEL
 * route, not a sub-resource: the words below must BE a path segment on a
 * route of depth <= 2 hanging directly off the root. `readiness`,
 * `liveness`, `status`, and `ops` are deliberately NOT on the list —
 * they are business-vocabulary words (`status` alone is half of every
 * job API); the unambiguous probe spellings (`healthz`, `readyz`,
 * `livez`) and the bare root `/` cover the infrastructure side.
 */
const OPERATIONAL_PROBE_SEGMENTS: ReadonlySet<string> = new Set([
  'health',
  'healthz',
  'ready',
  'readyz',
  'live',
  'livez',
  'drain',
  'metrics',
  'ping',
  'version',
  'info',
]);

/**
 * Whether the canonical path IS an infrastructure-probe route: the bare
 * root `/`, or a route of depth <= 2 where some segment IS exactly
 * (case-insensitively) one of `OPERATIONAL_PROBE_SEGMENTS`. Deep business
 * routes never qualify, whatever their segments spell.
 */
export function isOperationalProbePath(canonicalPath: string): boolean {
  if (canonicalPath === '/') return true;
  const segments = canonicalPath.split('/').filter((segment) => segment !== '');
  if (segments.length > 2) return false;
  return segments.some((segment) => OPERATIONAL_PROBE_SEGMENTS.has(segment.toLowerCase()));
}

/**
 * Capability rules (ADR 0004 D5). All matching rules apply (an endpoint
 * may carry several capabilities); ordering matters only for the
 * `crud-*` fallbacks, which defer to command semantics.
 */
const CAPABILITY_RULES: CapabilityRule[] = [
  {
    capability: 'health-operations',
    rule: 'HEALTH_PATH_NO_SCHEMA',
    // GET/HEAD, no request schema, no business link, and a path that IS a
    // probe shape (segment-exact probe word, depth <= 2, or bare root —
    // see isOperationalProbePath for why the shape is this narrow). The
    // `!linked` guard keeps a business-linked route (a /health path bound
    // to a health-record table, say) out of the operational class: a
    // linked endpoint is a business UI flow, never a probe.
    test: (c) =>
      c.method !== 'ANY' &&
      (c.method === 'GET' || c.method === 'HEAD') &&
      !c.hasRequestSchemas &&
      !c.linked &&
      isOperationalProbePath(c.pathLower),
  },
  {
    capability: 'auth-session',
    rule: 'AUTH_SESSION_PATH',
    test: (c) =>
      /(^|\/)(login|logout|session|sessions|token|tokens|refresh|register|signup|signin|password)(\/|$)/.test(c.pathLower),
  },
  {
    capability: 'webhook-callback',
    rule: 'WEBHOOK_PATH',
    test: (c) => /(webhook|callback)s?(\/|$)/.test(c.pathLower),
  },
  {
    capability: 'workflow-command',
    rule: 'COMMAND_SUFFIX',
    test: (c) =>
      new RegExp(`(^|/)${COMMAND_SUFFIXES}(\\/|$)`).test(c.pathLower) ||
      new RegExp(`_${COMMAND_SUFFIXES}$`).test(c.handlerLower),
  },
  {
    capability: 'task-async',
    rule: 'TASK_PATH',
    test: (c) => /(^|\/)(jobs?|tasks?|queue|worker)(\/|$)/.test(c.pathLower),
  },
  {
    capability: 'search-query',
    rule: 'SEARCH_SHAPE',
    test: (c) =>
      c.method === 'GET' &&
      (/(^|\/)(search|query)(\/|$)/.test(c.pathLower) ||
        /_(search|find|query|list)(_|$)/.test(c.handlerLower)),
  },
  {
    capability: 'validation-preview',
    rule: 'VALIDATION_SHAPE',
    test: (c) => /(validate|preview|dry-?run)(\/|_|$)/.test(c.pathLower) || /_(validate|preview)$/.test(c.handlerLower),
  },
  {
    capability: 'file-transfer',
    rule: 'FILE_SHAPE',
    test: (c) => /(^|\/)(upload|download|export|import|files?|attachments?)(\/|$)/.test(c.pathLower),
  },
  {
    capability: 'ai-automation',
    rule: 'AI_SHAPE',
    test: (c) => /(^|\/)(ai|llm|agent|completion)s?(\/|$)/.test(c.pathLower) || /synthes/.test(c.pathLower),
  },
  {
    capability: 'realtime',
    rule: 'STREAM_SHAPE',
    test: (c) => /(^|\/)(ws|socket|stream|sse|events)(\/|$)/.test(c.pathLower),
  },
];

/** Corroborated crud fallbacks: only when no command-like rule matched. */
const CRUD_FALLBACK_RULES: CapabilityRule[] = [
  {
    capability: 'crud-create',
    rule: 'POST_WITH_SCHEMA_OR_LINK',
    test: (c) => c.method === 'POST' && (c.hasRequestSchemas || c.hasResponseModel || c.linked) && !COMMAND_SHAPED(c),
  },
  {
    capability: 'crud-read',
    rule: 'GET_WITH_RESPONSE_OR_LINK',
    test: (c) =>
      (c.method === 'GET' || c.method === 'HEAD') &&
      (c.hasResponseModel || c.linked) &&
      !SEARCH_SHAPED(c) &&
      !COMMAND_SHAPED(c),
  },
  {
    capability: 'crud-update',
    rule: 'PUT_PATCH_WITH_SCHEMA_OR_LINK',
    // Same exclusion as crud-create/crud-read: capability rules COMPOSE
    // (all matching CAPABILITY_RULES attach), so a command-shaped
    // PUT — `PUT /invoices/{id}/approve`, or a `_approve`-suffixed
    // handler on an item route — would otherwise carry BOTH
    // workflow-command and crud-update. Commands beat methods (plan
    // §5.4): the command capability wins exclusively and the method
    // fallback never attaches beside it.
    test: (c) =>
      (c.method === 'PUT' || c.method === 'PATCH') &&
      (c.hasRequestSchemas || c.hasResponseModel || c.linked) &&
      !COMMAND_SHAPED(c),
  },
];

const COMMAND_SHAPED = (c: CapabilityContext): boolean =>
  CAPABILITY_RULES.find((rule) => rule.capability === 'workflow-command')?.test(c) ?? false;
const SEARCH_SHAPED = (c: CapabilityContext): boolean =>
  CAPABILITY_RULES.find((rule) => rule.capability === 'search-query')?.test(c) ?? false;

/** Deletes classify separately: semantics need positive evidence. */
function classifyDelete(
  routes: readonly HttpContractFact[],
  deleteSemantics: 'hard' | 'archive' | null,
): { capability: string | null; trace: Array<{ capability: string; rule: string; evidence: string }> } {
  const trace: Array<{ capability: string; rule: string; evidence: string }> = [];
  const handlerText = routes
    .map((route) => route.handlerSymbol ?? '')
    .join(' ')
    .toLowerCase();
  const pathText = routes.map((route) => route.normalizedPath.toLowerCase()).join(' ');
  if (deleteSemantics === 'archive' || /archive|soft.?delete|deactivate/.test(`${handlerText} ${pathText}`)) {
    trace.push({ capability: 'crud-archive', rule: 'DELETE_ARCHIVE_EVIDENCE', evidence: 'archive semantics in handler/path/linked-model evidence' });
    return { capability: 'crud-archive', trace };
  }
  if (deleteSemantics === 'hard' || /destroy|purge|permanent/.test(handlerText)) {
    trace.push({ capability: 'crud-delete', rule: 'DELETE_HARD_EVIDENCE', evidence: 'hard-delete semantics in handler/linked-model evidence' });
    return { capability: 'crud-delete', trace };
  }
  return { capability: null, trace };
}

/**
 * Converts the open attributes emitted by HTTP detector packs into the
 * strict, framework-neutral contract fact consumed by the endpoint compiler.
 *
 * FastAPI retains detector-specific route metadata such as `effectivePath`
 * and `responseModel` for explainability; those fields are deliberately not
 * part of the shared fact schema and must be projected before validation.
 */
function contractFactCandidate(resource: Resource): Record<string, unknown> {
  const attributes = resource.attributes as Record<string, unknown>;
  const effectivePath =
    typeof attributes['effectivePath'] === 'string' ? attributes['effectivePath'] : undefined;
  const rawPath =
    effectivePath ??
    (typeof attributes['rawPath'] === 'string' ? attributes['rawPath'] : undefined);
  const normalizedPath =
    typeof attributes['normalizedPath'] === 'string' && attributes['normalizedPath'].length > 0
      ? attributes['normalizedPath']
      : rawPath;
  const candidate: Record<string, unknown> = {
    schemaVersion: 1,
    role: attributes['role'],
    method: attributes['method'],
    normalizedPath,
    rawPath,
    framework: attributes['framework'],
    source: resource.location,
  };
  for (const key of ['handlerSymbol', 'requestSchemaSymbols', 'responseSchemaSymbols', 'callsites']) {
    const value = attributes[key];
    if (Array.isArray(value)) {
      if (value.length > 0) candidate[key] = value;
    } else if (value !== undefined) {
      candidate[key] = value;
    }
  }
  if (
    candidate['responseSchemaSymbols'] === undefined &&
    typeof attributes['responseModel'] === 'string' &&
    attributes['responseModel'].length > 0
  ) {
    candidate['responseSchemaSymbols'] = [attributes['responseModel']];
  }
  return candidate;
}

/** Extracts and validates contract facts from every contribution. */
export function extractContractFacts(
  contributions: readonly DetectorOutput[],
): { facts: HttpContractFact[]; findings: Finding[] } {
  const facts: HttpContractFact[] = [];
  const findings: Finding[] = [];
  for (const contribution of contributions) {
    for (const resource of contribution.resources) {
      if (resource.kind !== HTTP_CONTRACT_KIND) continue;
      const parsed = HttpContractFactSchema.safeParse(contractFactCandidate(resource));
      if (!parsed.success) {
        findings.push({
          code: 'INVALID_HTTP_CONTRACT_FACT',
          detail:
            `contract fact from ${contribution.detectorId} at ` +
            `${resource.location.file}:${resource.location.line} failed validation: ` +
            `${parsed.error.issues[0]?.message ?? 'unknown issue'}`,
          locations: [resource.location],
        });
        continue;
      }
      facts.push(parsed.data);
    }
  }
  facts.sort((a, b) => compareText(JSON.stringify(a), JSON.stringify(b)));
  return { facts, findings };
}

/**
 * Optional compiler inputs. Omitted (default) — e.g. by direct callers
 * and existing tests — no config document is read and the compiled
 * output is byte-identical to the pre-config-channel compiler.
 */
export interface EndpointCompilerOptions {
  /**
   * Repo root. When provided, `.gateforge/planes.json` is read from it
   * (the same path convention the packs use) and its `match` rules
   * become endpoint-plane evidence keyed on router source paths.
   */
  readonly cwd?: string;
}

/**
 * Compiles the endpoint inventory and the synthetic contribution.
 * Pure over its inputs.
 */
export function compileEndpointContribution(
  contributions: readonly DetectorOutput[],
  options: EndpointCompilerOptions = {},
): CompileResult {
  const { facts, findings } = extractContractFacts(contributions);

  // Declarative endpoint-plane config (plan phase 5): read once per
  // compile. Absence is normal (the default config has no rules and no
  // observable effect); a malformed document throws (fail closed) — the
  // CLI surfaces it as a config error instead of scanning with partial
  // trust, mirroring the pack config readers exactly (same reader).
  let planesConfig: PlanesConfig | null = null;
  if (options.cwd !== undefined) {
    try {
      planesConfig = readPlanesConfigOrNull(joinPath(options.cwd, PLANES_CONFIG_PATH));
    } catch (error) {
      throw new UsageError((error as Error).message);
    }
  }

  const businessNames = new Map<string, BusinessResourceName>();
  for (const contribution of contributions) {
    for (const resource of contribution.resources) {
      if (resource.kind === HTTP_CONTRACT_KIND) continue;
      const name = resource.attributes['resourceName'];
      if (typeof name !== 'string' || name.length === 0) continue;
      let entry = businessNames.get(name);
      if (entry === undefined) {
        entry = {
          name,
          kind: resource.kind,
          location: resource.location,
          planes: new Set<string>(),
        };
        businessNames.set(name, entry);
      }
      if (resource.kind === HTTP_ENDPOINT_RESOURCE_KIND) continue; // never chain through endpoints
      const plane = resource.attributes['plane'];
      if (plane === 'tenant' || plane === 'master' || plane === 'global') entry.planes.add(plane);
    }
  }
  // Plane-dimension signals are the other evidence half the classifier
  // sees on the linked resource; collect them so the contradiction
  // mirror below stays faithful to `resolveEndpointPlanes`.
  for (const contribution of contributions) {
    for (const signal of contribution.classificationSignals) {
      if (signal.dimension !== 'plane') continue;
      if (signal.assertion !== 'tenant' && signal.assertion !== 'master' && signal.assertion !== 'global') continue;
      businessNames.get(signal.target.resourceName ?? '')?.planes.add(signal.assertion);
    }
  }
  // Positive delete-semantics evidence from the linked model's own pack.
  const deleteSemanticsByName = new Map<string, 'hard' | 'archive'>();
  for (const contribution of contributions) {
    for (const signal of contribution.classificationSignals) {
      if (signal.dimension !== 'delete-semantics') continue;
      if (signal.assertion !== 'hard' && signal.assertion !== 'archive') continue;
      const name = signal.target.resourceName;
      if (typeof name === 'string' && !deleteSemanticsByName.has(name)) {
        deleteSemanticsByName.set(name, signal.assertion);
      }
    }
  }

  const routes = facts.filter((fact) => fact.role === 'server-route');
  const calls = facts.filter((fact) => fact.role === 'frontend-call');
  const join = joinFrontendCalls(routes, calls);

  // Every distinct route identity is an endpoint — consumed or not — so
  // the inventory is complete and unconsumed routes are visible (phase 7).
  const identities = new Map<string, { method: HttpMethod; canonicalPath: string; routes: HttpContractFact[]; calls: HttpContractFact[] }>();
  for (const route of routes) {
    if (route.method === 'ANY') continue; // exposure-only evidence
    const identity = canonicalEndpointIdentity(route.method, route.normalizedPath);
    const entry = identities.get(identity);
    if (entry !== undefined) {
      if (!containsFact(entry.routes, route)) entry.routes.push(route);
    } else {
      identities.set(identity, { method: route.method, canonicalPath: route.normalizedPath, routes: [route], calls: [] });
    }
  }
  for (const endpoint of join.endpoints) {
    const entry = identities.get(endpoint.identity);
    if (entry !== undefined) {
      for (const call of endpoint.calls) {
        if (!containsFact(entry.calls, call)) entry.calls.push(call);
      }
    }
  }

  const unresolved: Array<{ code: string; detail: string; location: HttpLocation }> = [];
  const seenBlocks = new Set<string>();
  for (const block of join.blocks) {
    const key = JSON.stringify([block.code, block.detail, block.location]);
    if (seenBlocks.has(key)) continue;
    seenBlocks.add(key);
    unresolved.push({ code: block.code, detail: block.detail, location: block.location });
  }

  const endpoints: EndpointRecord[] = [];
  const signals: Array<Record<string, unknown>> = [];
  const resources: Array<Record<string, unknown>> = [];
  const seenEndpointUnresolved = new Set<string>();

  for (const identity of [...identities.keys()].sort(compareText)) {
    const entry = identities.get(identity);
    if (entry === undefined) continue;
    const { method, canonicalPath, routes: endpointRoutes, calls: endpointCalls } = entry;
    const resourceName = endpointResourceName(method, canonicalPath);
    const consumed = endpointCalls.length > 0;

    // Linkage: explicit evidence only. The path-derived name is a
    // NON-authoritative candidate; it becomes a link solely when it names
    // EXACTLY ONE discovered business resource AND a deterministic
    // corroboration fact holds (schema symbol or handler-name word). Name
    // coincidence alone never links.
    const candidate = derivePathResourceName(canonicalPath);
    let linkedResourceName: string | null = null;
    if (candidate !== null) {
      const matches = [...businessNames.values()].filter((entry) => entry.name === candidate);
      if (matches.length === 1) {
        const corroboratedBySchema = endpointRoutes.some((route) =>
          [...(route.responseSchemaSymbols ?? []), ...(route.requestSchemaSymbols ?? [])].some(
            (symbol) => symbolCorroborates(symbol, candidate),
          ),
        );
        const corroboratedByHandler = endpointRoutes.some(
          (route) => route.handlerSymbol !== undefined && handlerCorroborates(route.handlerSymbol, candidate),
        );
        if (corroboratedBySchema || corroboratedByHandler) {
          linkedResourceName = candidate;
        } else {
          const key = `link:${identity}`;
          if (!seenEndpointUnresolved.has(key)) {
            seenEndpointUnresolved.add(key);
            unresolved.push({
              code: ENDPOINT_RESOURCE_LINK_UNRESOLVED,
              detail:
                `endpoint '${identity}' derives resource name '${candidate}' but no schema symbol ` +
                'or handler-name fact corroborates the link; add schema/model evidence ' +
                "(response/request schema named after the resource) or rely on the model pack's own linkage",
              location: endpointRoutes[0]?.source ?? { file: '<unknown>', line: 1, col: 0 },
            });
          }
        }
      } else if (matches.length > 1) {
        const key = `link:${identity}`;
        if (!seenEndpointUnresolved.has(key)) {
          seenEndpointUnresolved.add(key);
          unresolved.push({
            code: ENDPOINT_RESOURCE_LINK_UNRESOLVED,
            detail:
              `endpoint '${identity}' derives resource name '${candidate}' which matches ` +
              `${matches.length} discovered business resources; linkage needs exactly one ` +
              '(disambiguate the route or the resource names)',
            location: endpointRoutes[0]?.source ?? { file: '<unknown>', line: 1, col: 0 },
          });
        }
      }
    }

    // -- Declarative endpoint-plane config channel (plan phase 5) ----------
    // The router SOURCE FILE path is the only thing an endpoint rule can
    // key on (`match` glob; `tables` rules never apply — endpoints carry
    // no table identity). ALL matching rules must agree: agreement yields
    // the config plane; disagreement emits a typed blocking entry and NO
    // plane evidence (never first-match-wins); no matching rule leaves
    // the endpoint on the inheritance/operational/unresolved channels.
    // The configured `reason` (a required human review artifact) rides
    // the conflict diagnostic.
    let configPlane: 'tenant' | 'master' | 'global' | null = null;
    const routerFile = endpointRoutes[0]?.source.file ?? null;
    if (planesConfig !== null && routerFile !== null) {
      const resolution = resolvePlaneByRules(planesConfig, {
        sourcePath: routerFile,
        tableName: '', // an endpoint has no table identity: `tables` rules can never match
        classSimpleName: null,
      });
      if (resolution.conflict) {
        const key = `plane-config:${identity}`;
        if (!seenEndpointUnresolved.has(key)) {
          seenEndpointUnresolved.add(key);
          const asserted = [...new Set(resolution.hits.map((hit) => hit.plane))].sort(compareText);
          unresolved.push({
            code: PLANE_RULE_CONTRADICTION,
            detail:
              `endpoint '${identity}' (router '${routerFile}') matches ${resolution.hits.length} ` +
              `endpoint-plane rules asserting ${asserted.join(' vs ')}: ` +
              resolution.hits
                .map((hit) => `rules[${String(hit.index)}] -> '${hit.plane}' (${hit.reason})`)
                .join('; ') +
              '; endpoint-plane rules are explicit declarations for the router source path — ' +
              'make the matching rules agree or remove the losing rule',
            location: endpointRoutes[0]?.source ?? { file: '<unknown>', line: 1, col: 0 },
          });
        }
      } else if (resolution.plane !== null) {
        configPlane = resolution.plane;
      }
    }

    const handlerLower = endpointRoutes
      .map((route) => route.handlerSymbol ?? '')
      .join(' ')
      .toLowerCase();
    const ctx: CapabilityContext = {
      method,
      pathLower: canonicalPath.toLowerCase(),
      handlerLower,
      hasRequestSchemas: endpointRoutes.some((route) => (route.requestSchemaSymbols?.length ?? 0) > 0),
      hasResponseModel: endpointRoutes.some((route) => (route.responseSchemaSymbols?.length ?? 0) > 0),
      linked: linkedResourceName !== null,
      consumed,
    };

    const capabilities: string[] = [];
    const capabilityTrace: Array<{ capability: string; rule: string; evidence: string }> = [];
    for (const rule of CAPABILITY_RULES) {
      if (rule.test(ctx)) {
        capabilities.push(rule.capability);
        capabilityTrace.push({ capability: rule.capability, rule: rule.rule, evidence: 'detector facts (path/handler/schema/link)' });
      }
    }
    let deleteSemantics: 'hard' | 'archive' | null = null;
    if (method === 'DELETE' && linkedResourceName !== null) {
      const fromModel = deleteSemanticsByName.get(linkedResourceName) ?? null;
      const classified = classifyDelete(endpointRoutes, fromModel);
      if (classified.capability !== null) {
        capabilities.push(classified.capability);
        capabilityTrace.push(...classified.trace);
        if (classified.capability === 'crud-archive') deleteSemantics = 'archive';
        if (classified.capability === 'crud-delete') deleteSemantics = 'hard';
      } else {
        // Plan phase 4 checklist: archive vs hard delete stays unresolved
        // without positive semantics.
        const key = `delete-semantics:${identity}`;
        if (!seenEndpointUnresolved.has(key)) {
          seenEndpointUnresolved.add(key);
          unresolved.push({
            code: ENDPOINT_SEMANTICS_UNRESOLVED,
            detail:
              `endpoint '${identity}' deletes '${linkedResourceName}' but neither the handler nor ` +
              "the linked model's delete-semantics evidence distinguishes archive from hard delete",
            location: endpointRoutes[0]?.source ?? { file: '<unknown>', line: 1, col: 0 },
          });
        }
      }
    }
    for (const rule of CRUD_FALLBACK_RULES) {
      if (capabilities.some((capability) => capability.startsWith('crud-'))) break;
      if (rule.test(ctx)) {
        capabilities.push(rule.capability);
        capabilityTrace.push({ capability: rule.capability, rule: rule.rule, evidence: 'method candidate corroborated by schema/link facts' });
      }
    }
    if (capabilities.length === 0) {
      const key = `semantics:${identity}`;
      if (!seenEndpointUnresolved.has(key)) {
        seenEndpointUnresolved.add(key);
        unresolved.push({
          code: ENDPOINT_SEMANTICS_UNRESOLVED,
          detail:
            `endpoint '${identity}' has no positive capability evidence (method alone never ` +
            'decides semantics); add handler/schema/model evidence or an explicit classification',
          location: endpointRoutes[0]?.source ?? { file: '<unknown>', line: 1, col: 0 },
        });
      }
    }
    capabilities.sort(compareText);
    capabilityTrace.sort((a, b) => compareText(JSON.stringify(a), JSON.stringify(b)));

    const record: EndpointRecord = {
      method,
      canonicalPath,
      identity,
      resourceName,
      capabilities,
      capabilityTrace,
      linkedResourceName,
      frontendConsumed: consumed,
      deleteSemantics,
      routes: [...endpointRoutes].sort((a, b) => compareText(JSON.stringify(a), JSON.stringify(b))),
      calls: [...endpointCalls].sort((a, b) => compareText(JSON.stringify(a), JSON.stringify(b))),
    };
    endpoints.push(record);

    resources.push({
      schemaVersion: 1,
      id: `http.endpoint:${identity}`,
      kind: HTTP_ENDPOINT_RESOURCE_KIND,
      source: record.routes[0]?.source.file ?? '<unknown>',
      location: record.routes[0]?.source ?? { file: '<unknown>', line: 1, col: 0 },
      detectorVersion: ENDPOINT_COMPILER_VERSION,
      attributes: {
        resourceName,
        method,
        canonicalPath,
        identity,
        rawPaths: [...new Set(record.routes.map((route) => route.rawPath))].sort(compareText),
        frameworks: [...new Set(record.routes.map((route) => route.framework))].sort(compareText),
        serverSources: [...new Set(record.routes.map((route) => locationText(route.source)))].sort(compareText),
        callSources: [...new Set(record.calls.map((call) => locationText(call.source)))].sort(compareText),
        mountProvenances: [
          ...new Set(
            record.routes
              .map((route) => (route as HttpContractFact & { mountProvenance?: string }).mountProvenance)
              .filter((value): value is string => typeof value === 'string'),
          ),
        ].sort(compareText),
        capabilities,
        capabilityTrace,
        ...(linkedResourceName !== null ? { linkedResourceName } : {}),
        frontendConsumed: consumed,
        ...(deleteSemantics !== null ? { deleteSemantics } : {}),
      },
    });

    if (consumed) {
      signals.push(endpointSignal('exposure', 'frontend-consumed', record));
    }
    signals.push(endpointSignal('identity', ['method', 'path'], record));
    if (linkedResourceName !== null) {
      signals.push(endpointSignal('adapter-binding', linkedResourceName, record));
    }
    if (configPlane !== null) {
      // The config plane is EVIDENCE, not a blanket override: it enters
      // the classifier as one plane assertion beside the others (source
      // `gateforge.endpoint-compiler:config`, basis `declaration` — the
      // same channel shape the classifier's own inheritance pass mints).
      signals.push(planeSignal(configPlane, record, 'config'));
      // Core's `resolveEndpointPlanes` only consults the linked-resource
      // or operational rule when the endpoint stayed PLANE_UNRESOLVED —
      // with config evidence present it would silently skip inheritance.
      // When the contradicting plane is already derivable from the
      // contributions, mirror it here so the classifier sees BOTH
      // assertions and blocks with PLANE_CONTRADICTION (agreement adds
      // nothing — the set of candidates dedupes).
      if (linkedResourceName !== null) {
        const linked = businessNames.get(linkedResourceName);
        const inherited =
          linked !== undefined && linked.planes.size === 1
            ? ([...linked.planes][0] as 'tenant' | 'master' | 'global' | undefined)
            : undefined;
        if (linked !== undefined && inherited !== undefined && inherited !== configPlane) {
          signals.push(planeSignal(inherited, record, 'linked-resource', linked.location));
        }
      } else if (capabilities.includes('health-operations') && configPlane !== 'global') {
        // Exactly the class the operational rule resolves to `global`
        // (health-operations capability, no business link): a config rule
        // asserting any other plane must meet that assertion, not mute it.
        signals.push(planeSignal('global', record, 'operational'));
      }
    }
  }

  endpoints.sort((a, b) => compareText(a.identity, b.identity));
  resources.sort((a, b) => compareText(String(a['id']), String(b['id'])));
  signals.sort((a, b) => compareText(JSON.stringify(a), JSON.stringify(b)));
  unresolved.sort(
    (a, b) =>
      compareText(a.location.file, b.location.file) ||
      a.location.line - b.location.line ||
      compareText(a.code, b.code) ||
      compareText(a.detail, b.detail),
  );

  const contribution: DetectorOutput = {
    detectorId: ENDPOINT_COMPILER_DETECTOR_ID,
    detectorVersion: ENDPOINT_COMPILER_VERSION,
    resources: resources as unknown as Resource[],
    unresolved,
    findings,
    classificationSignals: signals as unknown as DetectorOutput['classificationSignals'],
    scannedPaths: [],
  };
  return {
    contribution,
    inventory: { facts, endpoints, unwired: join.blocks.filter((block) => block.code === 'FRONTEND_ROUTE_UNWIRED'), ambiguous: join.blocks.filter((block) => block.code === 'FRONTEND_ROUTE_AMBIGUOUS') },
  };
}

function endpointSignal(dimension: string, assertion: unknown, record: EndpointRecord): Record<string, unknown> {
  return {
    schemaVersion: 1,
    target: { resourceName: record.resourceName },
    dimension,
    assertion,
    basis: 'code-positive',
    source: `${ENDPOINT_COMPILER_DETECTOR_ID}`,
    location: record.routes[0]?.source ?? { file: '<unknown>', line: 1, col: 0 },
    detector: { id: ENDPOINT_COMPILER_DETECTOR_ID, version: ENDPOINT_COMPILER_VERSION },
  };
}

/**
 * A plane-dimension declaration signal for one endpoint, shaped exactly
 * like the classifier's inheritance pass mints them (`basis:
 * 'declaration'`, channel-qualified source). `channel` explains WHERE the
 * assertion came from: `config` (the reviewed `.gateforge/planes.json`
 * rule) or the mirrored `linked-resource` / `operational` derivation the
 * classifier would otherwise apply only when no config evidence exists.
 * `location` overrides the router source when the evidence lives on the
 * linked resource instead.
 */
function planeSignal(
  assertion: 'tenant' | 'master' | 'global',
  record: EndpointRecord,
  channel: 'config' | 'linked-resource' | 'operational',
  location?: HttpLocation,
): Record<string, unknown> {
  return {
    schemaVersion: 1,
    target: { resourceName: record.resourceName },
    dimension: 'plane',
    assertion,
    basis: 'declaration',
    source: `${ENDPOINT_COMPILER_DETECTOR_ID}:${channel}`,
    location: location ?? record.routes[0]?.source ?? { file: '<unknown>', line: 1, col: 0 },
    detector: { id: ENDPOINT_COMPILER_DETECTOR_ID, version: ENDPOINT_COMPILER_VERSION },
  };
}

function containsFact(list: readonly HttpContractFact[], fact: HttpContractFact): boolean {
  const key = JSON.stringify(fact);
  return list.some((entry) => JSON.stringify(entry) === key);
}

function locationText(location: HttpLocation): string {
  return `${location.file}:${location.line}:${location.col}`;
}

function compareText(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}
