/**
 * Trusted scope-snapshot validation (plan 2026-09-19 §4.4, Phase 4):
 * PURE bounded checks over adapter-produced snapshots. No I/O, no
 * verdicts — the witness calls this before accepting any scope
 * observation into the case lifecycle.
 *
 * Blocking rules (fail closed, never silently sampled):
 * - `complete:false`, pagination not exhausted, omitted declared fields,
 *   unknown identity, inconsistent checkpoints, or size-limit truncation
 *   blocks the case;
 * - entities must arrive in canonical identity order with no duplicate
 *   identity (a reordered or duplicated scope is ambiguous, not proof);
 * - entity count is bounded (over-limit proof inputs block rather than
 *   hash a misleading prefix).
 */
import type { ScopeSnapshot } from './types.js';

/** What a snapshot was validated against. */
export interface SnapshotScopeSpec {
  /** Approved snapshot scope key. */
  scope: string;
  /** Fixture namespace the case lease owns. */
  fixtureNamespace: string;
  /** Exact ordered identity columns (tenant included where needed). */
  identityFields: string[];
  /** Nonempty relevant field projection. */
  fields: string[];
  /** Hard entity cap (bounded memory). */
  maxEntities?: number;
}

/** Default entity cap when the caller names none. */
export const DEFAULT_MAX_SNAPSHOT_ENTITIES = 10_000;

/** Validated snapshot: entities indexed by canonical identity key. */
export interface ValidatedSnapshot {
  /** The validated checkpoint. */
  checkpoint: string;
  /** Identity key → entity index (canonical order preserved). */
  index: Map<string, { entityId: unknown; fields: Record<string, unknown> }>;
  /** Identity keys in snapshot order. */
  order: string[];
}

export type SnapshotValidation = { ok: true; snapshot: ValidatedSnapshot } | { ok: false; detail: string };

/** True for plain data objects (never arrays, null, or class instances). */
function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Canonical identity key: scalars stringify directly; composite keys
 * serialize the COMPLETE column-keyed object with sorted column names.
 * Missing identity columns are an unknown identity (null return).
 */
export function identityKeyOf(entityId: unknown, identityFields: string[]): string | null {
  if (entityId === null || entityId === undefined) return null;
  if (typeof entityId === 'string' || typeof entityId === 'number' || typeof entityId === 'boolean') {
    return `${typeof entityId}:${String(entityId)}`;
  }
  if (!isRecord(entityId)) return null;
  const parts: string[] = [];
  for (const column of [...identityFields].sort()) {
    const value = entityId[column];
    if (value === undefined || value === null) return null;
    if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') return null;
    parts.push(`${column}=${typeof value}:${String(value)}`);
  }
  if (parts.length === 0) return null;
  return `composite:${parts.join('|')}`;
}

/**
 * Validates one trusted scope snapshot against its declared spec.
 *
 * Args:
 *   snapshot: the adapter-produced snapshot (untrusted input).
 *   spec: the declared scope, namespace, identity, and projection.
 *
 * Returns:
 *   SnapshotValidation: the indexed snapshot, or a blocking detail.
 */
export function validateScopeSnapshot(snapshot: unknown, spec: SnapshotScopeSpec): SnapshotValidation {
  const fail = (detail: string): SnapshotValidation => ({ ok: false, detail });
  if (!isRecord(snapshot)) return fail('scope snapshot must be an object');
  if (snapshot['scope'] !== spec.scope) {
    return fail(`scope snapshot scope '${String(snapshot['scope'])}' does not match declared scope '${spec.scope}'`);
  }
  if (snapshot['fixtureNamespace'] !== spec.fixtureNamespace) {
    return fail(
      `scope snapshot namespace '${String(snapshot['fixtureNamespace'])}' does not match the case lease namespace`,
    );
  }
  if (snapshot['complete'] !== true) {
    return fail(`scope '${spec.scope}' collection is incomplete (complete:false) — no partial credit`);
  }
  const checkpoint = snapshot['checkpoint'];
  if (typeof checkpoint !== 'string' || checkpoint.length === 0) {
    return fail(`scope '${spec.scope}' has no authoritative checkpoint`);
  }
  if (snapshot['exhausted'] !== true) {
    return fail(`scope '${spec.scope}' pagination not exhausted — a one-page snapshot cannot prove the set`);
  }
  const entities = snapshot['entities'];
  if (!Array.isArray(entities)) return fail(`scope '${spec.scope}' entities must be an array`);
  const max = spec.maxEntities ?? DEFAULT_MAX_SNAPSHOT_ENTITIES;
  if (entities.length > max) {
    return fail(`scope '${spec.scope}' exceeds the entity bound (${String(entities.length)} > ${String(max)})`);
  }
  const totalSize = snapshot['totalSize'];
  if (totalSize !== undefined) {
    if (typeof totalSize !== 'number' || !Number.isInteger(totalSize) || totalSize < 0) {
      return fail(`scope '${spec.scope}' totalSize must be a non-negative integer when present`);
    }
    if (entities.length !== totalSize) {
      return fail(
        `scope '${spec.scope}' truncated (${String(entities.length)} of ${String(totalSize)}) — never silently sampled`,
      );
    }
  }
  if (spec.fields.length === 0) return fail(`scope '${spec.scope}' declares an empty field projection`);
  const index = new Map<string, { entityId: unknown; fields: Record<string, unknown> }>();
  const order: string[] = [];
  let previous: string | null = null;
  for (let position = 0; position < entities.length; position += 1) {
    const entity = entities[position] as unknown;
    if (!isRecord(entity)) return fail(`scope '${spec.scope}' entity ${String(position)} must be an object`);
    const key = identityKeyOf(entity['entityId'], spec.identityFields);
    if (key === null) {
      return fail(`scope '${spec.scope}' entity ${String(position)} has unknown identity (fail closed)`);
    }
    if (index.has(key)) {
      return fail(`scope '${spec.scope}' has a duplicate identity '${key}' — ambiguous, not proof`);
    }
    if (previous !== null && key <= previous) {
      return fail(`scope '${spec.scope}' is not in canonical identity order ('${key}' after '${previous}')`);
    }
    previous = key;
    const fields = entity['fields'];
    if (!isRecord(fields)) return fail(`scope '${spec.scope}' entity ${String(position)} fields must be an object`);
    for (const name of spec.fields) {
      if (!(name in fields)) {
        return fail(`scope '${spec.scope}' entity ${String(position)} omits declared field '${name}'`);
      }
    }
    const projected: Record<string, unknown> = {};
    for (const [name, value] of Object.entries(fields)) projected[name] = value;
    index.set(key, { entityId: entity['entityId'], fields: projected });
    order.push(key);
  }
  return { ok: true, snapshot: { checkpoint, index, order } };
}
