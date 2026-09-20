/**
 * Trusted test-state service (plan 2026-09-19 §4.4 item 7, Phase 4):
 * genuine out-of-process observation for witness tests. An in-memory
 * store with STRICT capability separation:
 *
 * - the WRITER capability mutates namespaced state (the application's
 *   write path in strong example runs);
 * - the READER capability only observes (the witness's independent
 *   observer). It exposes no mutator — a read-only observer cannot
 *   write, by construction, not by convention.
 * - namespaces isolate cases: equal business ids under different
 *   namespaces are different entities and can never cross-credit.
 * - every mutation bumps a per-namespace checkpoint clock, giving
 *   authoritative before/after checkpoints.
 *
 * Real storage behavior (maps, checkpoints, namespace fencing), never a
 * callback returning expected pass values. Test-only harness code — the
 * production observer is owner-provisioned (read-only DB credentials, a
 * trusted sidecar, or equivalent).
 */

export interface StateEntity {
  entityId: unknown;
  fields: Record<string, unknown>;
}

/** Write capability: the application's namespaced write path. */
export interface StateWriter {
  /** Inserts or replaces one entity in a namespace. */
  put(namespace: string, entityId: unknown, fields: Record<string, unknown>): void;
  /** Patches fields of an existing entity (throws when absent). */
  patch(namespace: string, entityId: unknown, fields: Record<string, unknown>): void;
  /** Removes one entity from a namespace (absent = no-op). */
  remove(namespace: string, entityId: unknown): void;
  /** Drops a whole namespace (lease cleanup). */
  clearNamespace(namespace: string): void;
}

/** Read capability: the witness's independent observer (no mutators). */
export interface StateReader {
  /** All entities of a namespace in canonical identity order. */
  readAll(namespace: string): StateEntity[];
  /** Current authoritative checkpoint of a namespace. */
  checkpoint(namespace: string): string;
}

/** The service handle: one writer, one reader, shared backing state. */
export interface TestStateService {
  writer: StateWriter;
  reader: StateReader;
}

function identityKey(entityId: unknown): string {
  if (entityId === null || entityId === undefined) return 'missing:';
  if (typeof entityId === 'string' || typeof entityId === 'number' || typeof entityId === 'boolean') {
    return `${typeof entityId}:${String(entityId)}`;
  }
  if (typeof entityId === 'object' && !Array.isArray(entityId)) {
    const record = entityId as Record<string, unknown>;
    const parts = Object.keys(record)
      .sort()
      .map((key) => {
        const value = record[key];
        return `${key}=${typeof value}:${String(value)}`;
      });
    return `composite:${parts.join('|')}`;
  }
  return `opaque:${String(entityId)}`;
}

/**
 * Creates an isolated test-state service (fresh backing state per call).
 */
export function createTestStateService(): TestStateService {
  const namespaces = new Map<string, Map<string, StateEntity>>();
  const clocks = new Map<string, number>();
  const tableOf = (namespace: string): Map<string, StateEntity> => {
    const table = namespaces.get(namespace);
    if (table !== undefined) return table;
    const fresh = new Map<string, StateEntity>();
    namespaces.set(namespace, fresh);
    return fresh;
  };
  const bump = (namespace: string): void => {
    clocks.set(namespace, (clocks.get(namespace) ?? 0) + 1);
  };
  const writer: StateWriter = {
    put(namespace: string, entityId: unknown, fields: Record<string, unknown>): void {
      tableOf(namespace).set(identityKey(entityId), { entityId, fields: { ...fields } });
      bump(namespace);
    },
    patch(namespace: string, entityId: unknown, fields: Record<string, unknown>): void {
      const table = tableOf(namespace);
      const key = identityKey(entityId);
      const current = table.get(key);
      if (current === undefined) {
        throw new Error(`test-state: cannot patch absent entity '${key}' in namespace '${namespace}'`);
      }
      table.set(key, { entityId: current.entityId, fields: { ...current.fields, ...fields } });
      bump(namespace);
    },
    remove(namespace: string, entityId: unknown): void {
      if (tableOf(namespace).delete(identityKey(entityId))) bump(namespace);
    },
    clearNamespace(namespace: string): void {
      namespaces.delete(namespace);
      clocks.delete(namespace);
    },
  };
  const reader: StateReader = {
    readAll(namespace: string): StateEntity[] {
      const table = namespaces.get(namespace);
      if (table === undefined) return [];
      return [...table.entries()]
        .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
        .map(([, entity]) => ({ entityId: entity.entityId, fields: { ...entity.fields } }));
    },
    checkpoint(namespace: string): string {
      return `${namespace}:${String(clocks.get(namespace) ?? 0)}`;
    },
  };
  return { writer, reader };
}
