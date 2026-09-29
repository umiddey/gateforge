/**
 * Row projection: the shared, deterministic mapping from one raw
 * response body onto the evidence shape `{ entityId, fields }`.
 *
 * Pure and total: an absent field is omitted (never invented as
 * `null`), so a field the endpoint does not return can never be
 * mistaken for a persisted value.
 */

/** The evidence shape every adapter's `normalize` returns. */
export interface NormalizedEntity {
  /** The entity id, projected from the raw body. */
  entityId: string;
  /** Projected fields the obligation's `expectFields` can match. */
  fields: Record<string, unknown>;
}

/** Projection inputs (the kit's field-shaped config). */
export interface ProjectionConfig {
  /** Projected field names (dotted paths allowed). */
  fields?: readonly string[];
  /** Projected name -> key the response actually carries. */
  fieldMap?: Readonly<Record<string, string>>;
  /** Key identifying the entity (default `id`). */
  entityIdKey?: string;
}

/**
 * Reads one dotted path out of a raw body.
 *
 * Args:
 *   source: the raw row.
 *   path: key, or dotted path (`owner.name`).
 *
 * Returns:
 *   unknown: the value at that path, or `undefined` when any segment is
 *   absent (an absent value is never an error here — the caller decides
 *   what an unknown field means).
 */
export function readPath(source: unknown, path: string): unknown {
  let current: unknown = source;
  for (const segment of path.split('.')) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/**
 * Projects one raw row onto the evidence shape.
 *
 * Args:
 *   body: the raw response body.
 *   config: field-shaped kit config (`fields`, `fieldMap`, `entityIdKey`).
 *
 * Returns:
 *   NormalizedEntity: the entity id plus exactly the declared fields the
 *   row carries. A non-object body yields an empty projection.
 */
export function projectEntity(body: unknown, config: ProjectionConfig): NormalizedEntity {
  if (body === null || typeof body !== 'object') {
    return { entityId: '', fields: {} };
  }
  const fields: Record<string, unknown> = {};
  for (const key of config.fields ?? []) {
    const sourceKey = config.fieldMap?.[key] ?? key;
    const value = readPath(body, sourceKey);
    if (value !== undefined) fields[key] = value;
  }
  const idKey = config.entityIdKey ?? 'id';
  const rawId = readPath(body, idKey);
  return { entityId: rawId === undefined || rawId === null ? '' : String(rawId), fields };
}
