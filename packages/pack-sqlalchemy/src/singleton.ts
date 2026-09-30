/**
 * Per-tenant singleton facts (plan 2026-09-25 Phase 4b item 3a).
 *
 * A table whose UNIQUE constraint — or whose UNIQUE INDEX — includes the
 * tenant scope column admits at most ONE row per tenant. A create of such
 * a resource is therefore provable only on a brand-new tenant, while the
 * witness's adapter reads use one process-global login: the create reads
 * as "the fixed tenant already has that row". This module mints the
 * additive `singletonPerTenant` attribute that lets the gate TELL the
 * owner; it never decides a verdict, never blocks, and never guesses.
 *
 * The rule is deliberately narrow and stated in full: BOTH facts must be
 * provable statically — the table must carry plane evidence of `tenant`
 * (the reviewed decision, resolved by the plane channel) AND one of its
 * declared `uniqueConstraints` must include a recognized tenant-scope
 * column. A table on another plane, an unreviewed table, or a unique
 * constraint that excludes the tenant scope column is left untouched, so
 * the output stays byte-identical wherever the tag is not earned.
 */

/** Column names that RESEMBLE the tenant scope of a tenant-plane table. */
export const TENANT_SCOPE_COLUMNS: readonly string[] = Object.freeze([
  'tenant_id',
  'tenant',
  'tenantId',
  'tenant_uuid',
  'tenant_key',
]);

/** The additive tag one per-tenant-singleton table carries. */
export interface SingletonPerTenantFact {
  /** Declared constraint/index name, or null when it is unnamed. */
  constraint: string | null;
  /** The recognized tenant-scope column inside {@link columns}. */
  tenantColumn: string;
  /** Every column of the unique constraint/index, written order. */
  columns: readonly string[];
}

/** One `uniqueConstraints` attribute entry, as the python detector emits it. */
interface UniqueConstraintFact {
  readonly name: string | null;
  readonly kind: string;
  readonly columns: readonly string[];
}

/** The discovered-resource attribute bag the tag is computed from. */
type Attributes = Readonly<Record<string, unknown>>;

/**
 * Reads one `uniqueConstraints` entry, or null when the attribute is
 * absent or malformed (never a partial guess).
 */
function uniqueConstraintOf(value: unknown): UniqueConstraintFact | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const entry = value as { name?: unknown; kind?: unknown; columns?: unknown };
  if (typeof entry.kind !== 'string' || entry.kind.length === 0) return null;
  if (!Array.isArray(entry.columns) || entry.columns.length === 0) return null;
  const columns: string[] = [];
  for (const column of entry.columns) {
    if (typeof column !== 'string' || column.length === 0) return null;
    columns.push(column);
  }
  return {
    name: typeof entry.name === 'string' && entry.name.length > 0 ? entry.name : null,
    kind: entry.kind,
    columns,
  };
}

/**
 * The unique constraint that makes this table a singleton per tenant,
 * or null when no declared constraint includes the tenant scope column.
 *
 * Args:
 *   attributes: One `sqlalchemy.table` resource's attributes.
 *
 * Returns:
 *   SingletonPerTenantFact | null: the deciding constraint's fact, or null.
 */
export function singletonTagFor(attributes: Attributes): SingletonPerTenantFact | null {
  // Plane evidence first: an unreviewed table is never a tenant table.
  if (attributes['plane'] !== 'tenant') return null;
  const declared = attributes['uniqueConstraints'];
  if (!Array.isArray(declared)) return null;
  for (const raw of declared) {
    const constraint = uniqueConstraintOf(raw);
    if (constraint === null) continue;
    // Written order decides which constraint is reported when several
    // qualify — deterministic, and every one of them still says the same.
    for (const column of constraint.columns) {
      if (!TENANT_SCOPE_COLUMNS.includes(column)) continue;
      return {
        constraint: constraint.name,
        tenantColumn: column,
        columns: [...constraint.columns],
      };
    }
  }
  return null;
}

/** The discovered-resource shape the tag pass rewrites. */
interface DiscoverableResource {
  readonly kind: string;
  readonly attributes: Attributes;
}

/**
 * Adds `singletonPerTenant` to every table that earns it and changes
 * nothing else. Pure over its inputs — deterministic.
 *
 * Args:
 *   resources: The discovery outcome's resource list.
 *
 * Returns:
 *   DiscoverableResource[]: the same resources, tagged where provable.
 */
export function applySingletonTags<T extends DiscoverableResource>(resources: readonly T[]): T[] {
  return resources.map((resource) => {
    if (resource.kind !== 'sqlalchemy.table') return resource;
    const fact = singletonTagFor(resource.attributes);
    if (fact === null) return resource;
    return { ...resource, attributes: { ...resource.attributes, singletonPerTenant: fact } };
  });
}
