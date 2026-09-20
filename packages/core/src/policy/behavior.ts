/**
 * Behavior-policy compiler (plan 2026-09-19 §4.1/§4.7): turns a
 * validated behavior document plus the current resource graph into a
 * deterministic catalog, obligations, and blocking entries.
 *
 * Core accepts validated data only. YAML loading stays in the CLI.
 * Duplicate/contradictory documents fail as PolicyEvaluationError
 * (exit 2). Missing/stale graph references become BlockingEntry values
 * with ENDPOINT_BEHAVIOR_MISSING / BEHAVIOR_REFERENCE_STALE.
 */
import { sha256Canonical, type JsonValue } from '../canonical-json.js';
import { HTTP_ENDPOINT_RESOURCE_KIND, type GraphResource, type ResourceGraph } from '../graph/schema.js';
import { compareStrings } from '../graph/util.js';
import {
  BEHAVIOR_CATALOG_DOMAIN,
  BEHAVIOR_REQUIREMENTS_DOMAIN,
  BehaviorCatalogSchema,
  type BehaviorCatalog,
  type CompiledBehaviorCase,
} from '../schemas/behavior-catalog.js';
import {
  BEHAVIOR_CASE_DOMAIN,
  BEHAVIOR_HTTP_METHODS,
  BehaviorPolicySchema,
  HTTP_REQUEST_OBSERVED,
  TRANSPORT_ONLY_CONTRACTS,
  type BehaviorCase,
  type BehaviorHttpMethod,
  type BehaviorPolicy,
  type EffectScope,
  type EndpointBehavior,
  type ResourceBehavior,
} from '../schemas/behavior-policy.js';
import { ObligationSchema, type Obligation } from '../schemas/obligation.js';
import { CAUSE_NEXT_ACTIONS } from '../schemas/verdict.js';
import {
  BlockingEntrySchema,
  PolicyEvaluationError,
  type BlockingEntry,
} from './evaluate.js';

/** Policy id stamped on every obligation compiled from a behavior document. */
export const BEHAVIOR_POLICY_ID = 'behavior-policy';

/** Canonical empty-catalog digest (never an omitted field). */
export const EMPTY_BEHAVIOR_CATALOG_DIGEST = sha256Canonical({
  domain: BEHAVIOR_CATALOG_DOMAIN,
  schemaVersion: 1,
  cases: [],
  requirements: {},
  dependencies: {},
});

/** Input to {@link compileBehaviorPolicy}. */
export interface CompileBehaviorPolicyInput {
  /** Built resource graph (classified endpoints and business resources). */
  graph: ResourceGraph;
  /** Already-parsed behavior document. */
  policy: BehaviorPolicy;
}

/** Deterministic compiler output. */
export interface CompileBehaviorPolicyResult {
  catalog: BehaviorCatalog;
  obligations: Obligation[];
  blocking: BlockingEntry[];
}

/**
 * Parses unknown input as a behavior policy. Unknown versions, extra
 * keys, and semantic schema failures are config errors (exit 2).
 *
 * Args:
 *   input (unknown): decoded YAML/JSON document.
 *
 * Returns:
 *   BehaviorPolicy: the validated document.
 */
export function parseBehaviorPolicy(input: unknown): BehaviorPolicy {
  const parsed = BehaviorPolicySchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = issue?.path.length ? issue.path.join('.') : '<root>';
    throw new PolicyEvaluationError(
      `behavior policy is invalid at ${path}: ${issue?.message ?? parsed.error.message}`,
    );
  }
  return parsed.data;
}

/**
 * Compiles a validated behavior policy against the current graph.
 *
 * Args:
 *   input (CompileBehaviorPolicyInput): graph plus validated policy.
 *
 * Returns:
 *   CompileBehaviorPolicyResult: catalog, obligations, blocking entries.
 */
export function compileBehaviorPolicy(input: CompileBehaviorPolicyInput): CompileBehaviorPolicyResult {
  const policy = BehaviorPolicySchema.parse(input.policy);
  const endpointsById = new Map<string, GraphResource>();
  const resourcesById = new Map<string, GraphResource>();
  for (const resource of input.graph.resources) {
    if (resource.id === null) continue;
    resourcesById.set(resource.id, resource);
    if (resource.kind === HTTP_ENDPOINT_RESOURCE_KIND) {
      endpointsById.set(resource.id, resource);
    }
  }

  const declaredEndpoints = new Map<string, EndpointBehavior>();
  for (const endpoint of policy.endpoints) {
    declaredEndpoints.set(endpoint.resourceId, endpoint);
  }
  const declaredResources = new Map<string, ResourceBehavior>();
  for (const resource of policy.resources) {
    declaredResources.set(resource.resourceId, resource);
  }

  const blocking: BlockingEntry[] = [];
  const compiled: CompiledBehaviorCase[] = [];
  const obligationCases = new Map<string, { obligation: Obligation; specs: JsonValue[] }>();

  for (const [resourceId, resource] of [...endpointsById.entries()].sort((a, b) =>
    compareStrings(a[0], b[0]),
  )) {
    const declared = declaredEndpoints.get(resourceId);
    if (declared === undefined) {
      blocking.push(
        block(
          'finding',
          resourceId,
          resource.name,
          `discovered endpoint '${resourceId}' has no approved behavioral declaration`,
          resource.location,
          'ENDPOINT_BEHAVIOR_MISSING',
        ),
      );
      continue;
    }
    const operational = isHealthOperations(resource);
    if (declared.disposition?.kind === 'operational-only' && !operational) {
      throw new PolicyEvaluationError(
        `operational-only disposition on '${resourceId}' is illegal: the route is not positively classified health-operations`,
      );
    }
    const staleEffect = declared.effects.find((effect) => !resourcesById.has(effect.resourceId));
    if (staleEffect !== undefined) {
      blocking.push(
        block(
          'stale-reference',
          resourceId,
          resource.name,
          `behavior policy declares effect '${staleEffect.resourceId}' for endpoint '${resourceId}' which is not in the current graph`,
          resource.location,
          'BEHAVIOR_REFERENCE_STALE',
        ),
      );
      continue;
    }
    const linkedError = linkedResourceConflict(resource, declared.effects);
    if (linkedError !== null) {
      blocking.push(
        block('finding', resourceId, resource.name, linkedError, resource.location, 'BEHAVIOR_BINDING_MISMATCH'),
      );
      continue;
    }
    const sourceFiles = sortedUnique([
      resource.source,
      ...declared.effects.flatMap((effect) => {
        const target = resourcesById.get(effect.resourceId);
        return target === undefined ? [] : [target.source];
      }),
    ]);
    if (declared.disposition?.kind === 'out-of-scope') {
      continue;
    }
    const effects = sortEffects(declared.effects);
    if (declared.disposition?.kind === 'operational-only') {
      const hasTransport = declared.cases.some((item) => TRANSPORT_ONLY_CONTRACTS.has(item.contract));
      collectSubject({
        resourceId,
        endpointResourceId: resourceId,
        resource,
        effects,
        cases: hasTransport ? declared.cases : [...declared.cases, operationalTransportCase(resource)],
        sourceFiles,
        compiled,
        obligationCases,
      });
      continue;
    }
    collectSubject({
      resourceId,
      endpointResourceId: resourceId,
      resource,
      effects,
      cases: declared.cases,
      sourceFiles,
      compiled,
      obligationCases,
    });
  }

  for (const declared of policy.endpoints) {
    if (endpointsById.has(declared.resourceId)) continue;
    blocking.push(
      block(
        'stale-reference',
        declared.resourceId,
        declared.resourceId,
        `behavior policy references endpoint '${declared.resourceId}' which is not in the current graph`,
        null,
        'BEHAVIOR_REFERENCE_STALE',
      ),
    );
  }

  for (const declared of policy.resources) {
    const resource = resourcesById.get(declared.resourceId);
    if (resource === undefined) {
      blocking.push(
        block(
          'stale-reference',
          declared.resourceId,
          declared.resourceId,
          `behavior policy references resource '${declared.resourceId}' which is not in the current graph`,
          null,
          'BEHAVIOR_REFERENCE_STALE',
        ),
      );
      continue;
    }
    const staleEffect = declared.effects.find((effect) => !resourcesById.has(effect.resourceId));
    if (staleEffect !== undefined) {
      blocking.push(
        block(
          'stale-reference',
          declared.resourceId,
          declared.resourceId,
          `behavior policy declares effect '${staleEffect.resourceId}' for resource '${declared.resourceId}' which is not in the current graph`,
          resource.location,
          'BEHAVIOR_REFERENCE_STALE',
        ),
      );
      continue;
    }
    collectSubject({
      resourceId: declared.resourceId,
      endpointResourceId: null,
      resource,
      effects: sortEffects(declared.effects),
      cases: declared.cases,
      sourceFiles: sortedUnique([resource.source]),
      compiled,
      obligationCases,
    });
  }

  compiled.sort((a, b) => compareStrings(a.caseId, b.caseId));
  const requirements: Record<string, string[]> = {};
  const obligations: Obligation[] = [];
  for (const [obligationId, entry] of [...obligationCases.entries()].sort((a, b) =>
    compareStrings(a[0], b[0]),
  )) {
    const caseIds = compiled
      .filter((item) => item.obligationIds.includes(obligationId))
      .map((item) => item.caseId)
      .sort(compareStrings);
    requirements[obligationId] = caseIds;
    const requirementsDigest = sha256Canonical({
      domain: BEHAVIOR_REQUIREMENTS_DOMAIN,
      obligationId,
      specifications: [...entry.specs].sort((a, b) =>
        compareStrings(canonicalKey(a), canonicalKey(b)),
      ),
    });
    obligations.push(
      ObligationSchema.parse({
        ...entry.obligation,
        requirementsDigest,
      }),
    );
  }

  const dependencies: Record<string, string[]> = {};
  for (const item of compiled) {
    const ids = sortedUnique(item.effects.map((effect) => effect.resourceId));
    dependencies[item.resourceId] = ids;
  }

  const catalogBody = {
    schemaVersion: 1 as const,
    cases: compiled,
    requirements,
    dependencies,
  };
  const catalogDigest =
    compiled.length === 0
      ? EMPTY_BEHAVIOR_CATALOG_DIGEST
      : sha256Canonical({ domain: BEHAVIOR_CATALOG_DOMAIN, ...catalogBody });
  const catalog = BehaviorCatalogSchema.parse({ ...catalogBody, catalogDigest });
  return {
    catalog,
    obligations: obligations.sort((a, b) => compareStrings(a.id, b.id)),
    blocking: blocking.sort((a, b) => {
      const byKind = compareStrings(a.kind, b.kind);
      if (byKind !== 0) return byKind;
      return compareStrings(a.resourceId ?? '', b.resourceId ?? '');
    }),
  };
}

interface CollectInput {
  resourceId: string;
  endpointResourceId: string | null;
  resource: GraphResource;
  effects: EffectScope[];
  cases: BehaviorCase[];
  sourceFiles: string[];
  compiled: CompiledBehaviorCase[];
  obligationCases: Map<string, { obligation: Obligation; specs: JsonValue[] }>;
}

/**
 * Compiles every case of one subject into catalog entries and obligation drafts.
 *
 * Args:
 *   input (CollectInput): subject, cases, and accumulators.
 */
function collectSubject(input: CollectInput): void {
  const lifecycle = input.resource.classification?.lifecycle ?? {
    create: true,
    read: true,
    update: true,
    delete: true,
    deleteSemantics: 'hard' as const,
  };
  for (const definition of input.cases) {
    const spec = canonicalizeCase(definition);
    const specDigest = sha256Canonical(spec as JsonValue);
    const caseId = sha256Canonical({
      domain: BEHAVIOR_CASE_DOMAIN,
      resourceId: input.resourceId,
      id: definition.id,
    });
    const obligationId = `${input.resourceId}:${definition.contract}`;
    const compiled: CompiledBehaviorCase = {
      caseId,
      specDigest,
      resourceId: input.resourceId,
      endpointResourceId: input.endpointResourceId,
      obligationIds: [obligationId],
      definition,
      effects: input.effects,
      sourceFiles: input.sourceFiles,
    };
    input.compiled.push(compiled);
    const existing = input.obligationCases.get(obligationId);
    if (existing === undefined) {
      input.obligationCases.set(obligationId, {
        obligation: ObligationSchema.parse({
          schemaVersion: 1,
          id: obligationId,
          resourceId: input.resourceId,
          contract: definition.contract,
          policyId: BEHAVIOR_POLICY_ID,
          lifecycle,
        }),
        specs: [spec as JsonValue],
      });
    } else {
      existing.specs.push(spec as JsonValue);
    }
  }
}

/**
 * Builds the synthetic transport-only case for an operational-only route
 * from the endpoint's own method and canonical path.
 *
 * Args:
 *   resource (GraphResource): classified health-operations endpoint.
 *
 * Returns:
 *   BehaviorCase: request-observed case with empty state.
 */
function operationalTransportCase(resource: GraphResource): BehaviorCase {
  const methodRaw = resource.attributes['method'];
  const method: BehaviorHttpMethod =
    typeof methodRaw === 'string' && (BEHAVIOR_HTTP_METHODS as readonly string[]).includes(methodRaw)
      ? (methodRaw as BehaviorHttpMethod)
      : 'GET';
  const pathRaw = resource.attributes['canonicalPath'];
  const pathTemplate =
    typeof pathRaw === 'string' && pathRaw.startsWith('/') ? pathRaw : '/';
  return {
    id: 'operational-transport',
    contract: HTTP_REQUEST_OBSERVED,
    channel: 'engine-http',
    fixture: 'operational',
    actor: 'anonymous',
    action: {
      kind: 'request',
      method,
      pathTemplate,
      path: {},
      query: {},
      body: { encoding: 'json', fields: {} },
      credentialVariant: 'valid',
    },
    expect: {
      statuses: [200],
      response: [],
      state: [],
    },
  };
}

/**
 * True when detector attributes positively classify health-operations only.
 *
 * Args:
 *   resource (GraphResource): discovered endpoint.
 *
 * Returns:
 *   boolean: true only for a single health-operations capability and no business link.
 */
function isHealthOperations(resource: GraphResource): boolean {
  const linked = resource.attributes['linkedResourceName'];
  if (typeof linked === 'string' && linked.length > 0) return false;
  const capabilities = resource.attributes['capabilities'];
  return Array.isArray(capabilities) && capabilities.length === 1 && capabilities[0] === 'health-operations';
}

/**
 * Detects a conflict between source-derived linkedResourceName and declared effects.
 *
 * Args:
 *   resource (GraphResource): discovered endpoint.
 *   effects (EffectScope[]): owner-declared effects.
 *
 * Returns:
 *   string | null: blocking detail, or null when consistent.
 */
function linkedResourceConflict(resource: GraphResource, effects: EffectScope[]): string | null {
  const linked = resource.attributes['linkedResourceName'];
  if (typeof linked !== 'string' || linked.length === 0) return null;
  const matches = effects.some((effect) => {
    const name = effect.resourceId.includes('.')
      ? effect.resourceId.slice(effect.resourceId.indexOf('.') + 1)
      : effect.resourceId;
    return name === linked || effect.resourceId === linked;
  });
  if (matches) return null;
  return (
    `endpoint '${resource.id ?? resource.name}' source link '${linked}' conflicts with declared ` +
    'effect resource ids (source facts cannot be overridden silently)'
  );
}

function sortEffects(effects: EffectScope[]): EffectScope[] {
  return [...effects].sort((a, b) => compareStrings(a.id, b.id));
}

function sortedUnique(values: string[]): string[] {
  return [...new Set(values)].sort(compareStrings);
}

function canonicalizeCase(definition: BehaviorCase): Record<string, JsonValue> {
  return {
    id: definition.id,
    contract: definition.contract,
    channel: definition.channel,
    fixture: definition.fixture,
    actor: definition.actor,
    action: definition.action as unknown as JsonValue,
    expect: definition.expect as unknown as JsonValue,
    controlCase: definition.controlCase ?? null,
  };
}

function canonicalKey(value: JsonValue): string {
  return JSON.stringify(value);
}

function block(
  kind: BlockingEntry['kind'],
  resourceId: string,
  name: string,
  detail: string,
  location: GraphResource['location'] | null,
  cause: 'ENDPOINT_BEHAVIOR_MISSING' | 'BEHAVIOR_REFERENCE_STALE' | 'BEHAVIOR_BINDING_MISMATCH',
): BlockingEntry {
  return BlockingEntrySchema.parse({
    kind,
    resourceId,
    name,
    detail,
    location,
    cause,
    nextAction: CAUSE_NEXT_ACTIONS[cause],
  });
}
