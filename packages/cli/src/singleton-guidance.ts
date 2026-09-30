/**
 * Per-tenant singleton guidance (plan 2026-09-25 Phase 4b item 3).
 *
 * A table whose UNIQUE constraint includes the tenant scope column
 * admits one row per tenant (E9/E10): a create of such a resource is
 * provable ONLY on a brand-new tenant, while the witness's adapter reads
 * use one process-global login. The sqlalchemy pack emits that as an
 * additive `singletonPerTenant` fact; this module turns it into the ONE
 * plain advisory line the owner reads, plus the same guidance as ready-made
 * lines for `next`/`init` (both of which call
 * {@link singletonPerTenantGuidanceLines} rather than re-deriving the rule).
 *
 * Nothing here blocks: the advisory is a finding in the report's advisory
 * channel, cause `RESOURCE_SINGLETON_PER_TENANT`. A resource without the
 * fact produces no entry at all, so a repo that has none is byte-identical.
 */
import { CAUSE_NEXT_ACTIONS, type BlockingEntry, type GraphResource } from '@gate-forge/core';

/** The additive fact the sqlalchemy pack attaches to such a table. */
export interface SingletonPerTenantFact {
  /** Declared constraint/index name, or null when it is unnamed. */
  constraint: string | null;
  /** The recognized tenant-scope column inside {@link columns}. */
  tenantColumn: string;
  /** Every column of the unique constraint/index, written order. */
  columns: readonly string[];
}

/** One per-tenant-singleton resource of the graph. */
export interface SingletonResource {
  /** Plane-qualified graph id (`tenant.ledger_entries`). */
  resourceId: string;
  /** Bare resource name. */
  name: string;
  /** The tag as the detector emitted it. */
  fact: SingletonPerTenantFact;
}

/**
 * The exact sentence every surface repeats for one singleton resource:
 * what the constraint means, what must be witnessed where, and how (the
 * session-scoped adapter identity).
 */
function guidanceSentence(resourceId: string, fact: SingletonPerTenantFact): string {
  const constraint =
    fact.constraint === null
      ? `unique(${fact.columns.join(', ')})`
      : `${String(fact.constraint)} unique(${fact.columns.join(', ')})`;
  return (
    `'${resourceId}' is a singleton per tenant: ${constraint} includes the tenant scope column ` +
    `'${fact.tenantColumn}', so exactly one row per tenant exists. Its create can only be proven on a ` +
    'fresh tenant: create the tenant in the test, then register that tenant login with the witness ' +
    'for THIS session only (POST /sessions/identity — see the test-environment guide) so the adapter ' +
    'reads see the new tenant instead of the process-global seat.'
  );
}

/**
 * Reads the additive `singletonPerTenant` fact off one graph resource,
 * or null when the resource carries none (the overwhelming majority).
 */
function singletonFactOf(resource: GraphResource): SingletonPerTenantFact | null {
  const raw = resource.attributes['singletonPerTenant'];
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const fact = raw as { constraint?: unknown; tenantColumn?: unknown; columns?: unknown };
  if (typeof fact.tenantColumn !== 'string' || fact.tenantColumn.length === 0) return null;
  if (!Array.isArray(fact.columns) || fact.columns.length === 0) return null;
  const columns: string[] = [];
  for (const column of fact.columns) {
    if (typeof column !== 'string' || column.length === 0) return null;
    columns.push(column);
  }
  return {
    constraint:
      typeof fact.constraint === 'string' && fact.constraint.length > 0 ? fact.constraint : null,
    tenantColumn: fact.tenantColumn,
    columns,
  };
}

/**
 * Every per-tenant-singleton resource of the graph, in graph order.
 *
 * Args:
 *   resources: The graph's resource list.
 *
 * Returns:
 *   SingletonResource[]: the tagged resources; empty when there are none.
 */
export function singletonPerTenantResources(
  resources: readonly GraphResource[],
): SingletonResource[] {
  const found: SingletonResource[] = [];
  for (const resource of resources) {
    const fact = singletonFactOf(resource);
    if (fact === null || resource.id === null) continue;
    found.push({ resourceId: resource.id, name: resource.name, fact });
  }
  return found;
}

/**
 * The advisory entries for the singleton resources that owe a create.
 * Never blocking: these ride the report's advisory channel.
 *
 * Args:
 *   resources: The graph's resource list.
 *   owedResourceIds: Resource ids that owe `persistence:create` (any
 *     verdict state — a satisfied create does not make the constraint stop
 *     applying to the next one).
 *
 * Returns:
 *   BlockingEntry[]: one finding per owed singleton resource; empty when
 *     no owed resource carries the tag.
 */
export function singletonPerTenantAdvisories(
  resources: readonly GraphResource[],
  owedResourceIds: ReadonlySet<string>,
): BlockingEntry[] {
  return singletonPerTenantResources(resources)
    .filter((resource) => owedResourceIds.has(resource.resourceId))
    .map((resource) => ({
      kind: 'finding' as const,
      resourceId: resource.resourceId,
      name: resource.name,
      detail: guidanceSentence(resource.resourceId, resource.fact),
      location: null,
      cause: 'RESOURCE_SINGLETON_PER_TENANT' as const,
      nextAction: CAUSE_NEXT_ACTIONS.RESOURCE_SINGLETON_PER_TENANT,
    }));
}

/**
 * The same guidance as plain lines, for `gateforge next` and `gateforge
 * init`. Both commands own their own output shape; they call this and
 * print what they get (nothing at all when no resource is tagged).
 *
 * Args:
 *   resources: The graph's resource list.
 *
 * Returns:
 *   string[]: one line per tagged resource, in graph order.
 */
export function singletonPerTenantGuidanceLines(
  resources: readonly GraphResource[],
): string[] {
  return singletonPerTenantResources(resources).map((resource) =>
    guidanceSentence(resource.resourceId, resource.fact),
  );
}
