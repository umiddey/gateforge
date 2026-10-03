/**
 * Per-tenant singleton facts (plan 2026-09-25 Phase 4b item 3a).
 *
 * A table whose UNIQUE constraint — or whose UNIQUE INDEX — is declared
 * over EXACTLY the tenancy scope columns admits at most ONE row per
 * tenancy scope. A create of such a resource is therefore provable only
 * on a brand-new tenant, while the witness's adapter reads use one
 * process-global login: the create reads as "the fixed tenant already has
 * that row". This module mints the additive `singletonPerTenant`
 * attribute that lets the gate TELL the owner; it never decides a
 * verdict, never blocks, and never guesses.
 *
 * "Exactly the scope" is the whole rule, and it is deliberately strict:
 * EVERY column of the constraint must be a recognized tenancy-scope
 * column. A constraint that merely CONTAINS a scope column says
 * something else — `unique (period_id, tenant_id, contract_id,
 * recipient_user_id)` says one row per recipient per period, so many
 * rows per tenant exist, and calling that a singleton produced a
 * provably false sentence about a real table (it also mistook a domain
 * `tenant_id` column — the renter — for the tenancy scope). Both facts
 * must therefore be provable statically: the table must carry plane
 * evidence of `tenant` (the reviewed decision, resolved by the plane
 * channel) AND one of its declared `uniqueConstraints` must be written
 * over scope columns only. A table on another plane, an unreviewed
 * table, and a constraint that names any non-scope column are left
 * untouched, so the output stays byte-identical wherever the tag is not
 * earned.
 *
 * WHICH columns carry the tenant scope is the owner's call: the default
 * is {@link TENANT_SCOPE_COLUMNS}, and an application whose scope column
 * is spelled differently (`contractor_id`, ...) passes its own list, read
 * from `.gateforge.yml` (`tenancy.scopeColumns`, see `tenancy.ts`). The
 * passed list REPLACES the default — it never extends it, so a table
 * scoped by a column the owner did not declare stays untagged even when
 * its name resembles the default list.
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
  /**
   * The first tenancy-scope column of the constraint in written order.
   * Kept for the additive contract; {@link scopeColumns} names them all.
   */
  tenantColumn: string;
  /**
   * Every recognized tenancy-scope column of the constraint, written
   * order. Under the default list the spellings are ALTERNATIVES, so this
   * is normally one name; a composite declared scope lists them all.
   */
  scopeColumns: readonly string[];
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
 * or null when no declared constraint is written over the tenancy scope
 * ALONE.
 *
 * A constraint qualifies only when EVERY column it names is a recognized
 * scope column — it is written over the tenancy scope and nothing else. A
 * constraint that merely CONTAINS a scope column says something else
 * entirely: `unique (period_id, tenant_id, contract_id,
 * recipient_user_id)` allows one row per recipient per period, so many
 * rows per tenant exist and the table is not a singleton. Naming PART of
 * a composite declared scope (`unique (org_id)` under
 * `tenancy.scopeColumns: [org_id, tenant_id]`) still qualifies, and
 * soundly so: at most one row per organization is at most one row per
 * (organization, tenant).
 *
 * Args:
 *   attributes: One `sqlalchemy.table` resource's attributes.
 *   scopeColumns: The tenancy-scope column names to recognize (default:
 *     {@link TENANT_SCOPE_COLUMNS}; an owner-declared list REPLACES it).
 *
 * Returns:
 *   SingletonPerTenantFact | null: the deciding constraint's fact, or null.
 */
export function singletonTagFor(
  attributes: Attributes,
  scopeColumns: readonly string[] = TENANT_SCOPE_COLUMNS,
): SingletonPerTenantFact | null {
  // Plane evidence first: an unreviewed table is never a tenant table.
  if (attributes['plane'] !== 'tenant') return null;
  const declared = attributes['uniqueConstraints'];
  if (!Array.isArray(declared)) return null;
  for (const raw of declared) {
    const constraint = uniqueConstraintOf(raw);
    if (constraint === null) continue;
    // Every column must be the scope; a single non-scope column means the
    // constraint distinguishes more than the tenancy and admits repeated
    // creates per tenant.
    const scopeInConstraint = constraint.columns.filter((column) =>
      scopeColumns.includes(column),
    );
    if (scopeInConstraint.length !== constraint.columns.length) continue;
    // Written order decides which constraint is reported when several
    // qualify — deterministic, and every one of them still says the same.
    const first = scopeInConstraint[0];
    if (first === undefined) continue;
    return {
      constraint: constraint.name,
      tenantColumn: first,
      scopeColumns: [...scopeInConstraint],
      columns: [...constraint.columns],
    };
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
 *   scopeColumns: The tenant-scope column names to recognize (default:
 *     {@link TENANT_SCOPE_COLUMNS}; an owner-declared list REPLACES it).
 *
 * Returns:
 *   DiscoverableResource[]: the same resources, tagged where provable.
 */
export function applySingletonTags<T extends DiscoverableResource>(
  resources: readonly T[],
  scopeColumns: readonly string[] = TENANT_SCOPE_COLUMNS,
): T[] {
  return resources.map((resource) => {
    if (resource.kind !== 'sqlalchemy.table') return resource;
    const fact = singletonTagFor(resource.attributes, scopeColumns);
    if (fact === null) return resource;
    return { ...resource, attributes: { ...resource.attributes, singletonPerTenant: fact } };
  });
}
