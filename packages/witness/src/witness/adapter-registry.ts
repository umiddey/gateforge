/**
 * Adapter loading + registry (pin #8, plan §5.4).
 *
 * Reviewed evidence adapters load from `.gateforge/adapters/<name>.mjs`
 * at WITNESS START (engine-side — the test process never imports them).
 * Default export contract:
 *
 * ```js
 * export default {
 *   read: async (ctx, id) => body | null,   // GET-only; ctx.get(path) is the transport
 *   normalize: (body) => ({ entityId, fields }), // stamped from the RESPONSE, never caller args
 *   deletion: 'hard' | 'archive',
 *   fields: ['id', 'name'],                     // optional normalized field projection
 *   baseUrl: 'http://…',                    // optional override of the witness's adapter base
 *   identity: 'natural-key',                  // optional entity-scoped create absence proof
 *   list: async (ctx) => bodies,            // optional: powers create pre-observations + Observe snapshots
 *   observe: {                              // optional: Observe-channel mutation bindings (Phase 2)
 *     create: { method: 'POST', path: '/api/v2/accounts' },
 *     update: { method: 'PATCH', path: '/api/v2/accounts/{id}' },
 *   },
 *   probeServer: async (ctx, subject) => ({ found, fields }), // optional: the
 *                          // SERVER-WITNESSED persistence channel probe — executed
 *                          // ONLY in this trusted witness process
 * };
 * ```
 *
 * The registry loads fail-closed: a missing/invalid module, a missing
 * `read`/`normalize`/`deletion`/`environmentFingerprint`, an unknown
 * deletion value, or a duplicate name aborts witness startup with an
 * actionable diagnostic naming the file. The registry is frozen after
 * load — there is no registration path a test could reach (invariant 6,
 * GF-11 "registration path does not exist").
 */
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { AdapterContext, EvidenceAdapter, SessionIdentity } from './types.js';

/**
 * Loads every `.mjs` adapter in `dir` into a frozen registry.
 *
 * Args:
 *   dir: the configured adapters directory (absolute).
 *
 * Returns:
 *   Map<string, EvidenceAdapter>: keyed by the file basename sans `.mjs`.
 *
 * Throws:
 *   AdapterRegistryError: fail-closed load problems — unreadable dir,
 *     unimportable module, or a module missing any contract member.
 */
export async function loadAdapters(
  dir: string,
  options: { deleteDisabledAdapters?: ReadonlySet<string> } = {},
): Promise<Map<string, EvidenceAdapter>> {
  const registry = new Map<string, EvidenceAdapter>();
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      // No adapters directory at all: the registry stays empty; the
      // witness then answers 400 for every persistence request (a run
      // with persistence obligations and no adapters is misconfigured).
      return registry;
    }
    throw new AdapterRegistryError(
      `cannot read adapters directory '${dir}': ${(error as Error).message}`,
    );
  }
  for (const entry of entries.sort()) {
    if (!entry.endsWith('.mjs')) continue;
    const name = entry.slice(0, -'.mjs'.length);
    if (registry.has(name)) {
      throw new AdapterRegistryError(
        `duplicate adapter '${name}' (multiple '${entry}' files is a config error)`,
      );
    }
    const module = await importAdapter(dir, entry, name);
    const adapter = validateAdapter(module, name, {
      deleteDisabled: options.deleteDisabledAdapters?.has(name) ?? false,
    });
    registry.set(name, adapter);
  }
  return Object.freeze(registry);
}

/** Imports one adapter module; import errors carry an actionable message. */
async function importAdapter(
  dir: string,
  entry: string,
  name: string,
): Promise<unknown> {
  try {
    const loaded = (await import(pathToFileURL(join(dir, entry)).href)) as {
      default?: unknown;
    };
    return loaded.default;
  } catch (error) {
    throw new AdapterRegistryError(
      `adapter '${name}' (${join(dir, entry)}) could not be imported: ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * Validates one adapter module against the pin-#8 contract.
 *
 * Args:
 *   module: the default export of the adapter file.
 *   name: adapter name, used in diagnostics.
 *
 * Returns:
 *   EvidenceAdapter: the validated adapter.
 *
 * Throws:
 *   AdapterRegistryError: when any required member is missing or shaped
 *   wrong. Optional `baseUrl`, `identity`, and `fields` refine read and
 *   create-proof capabilities without changing adapters that omit them.
 */
export function validateAdapter(
  module: unknown,
  name: string,
  options: { deleteDisabled?: boolean } = {},
): EvidenceAdapter {
  if (typeof module !== 'object' || module === null) {
    throw new AdapterRegistryError(
      `adapter '${name}' must default-export an object {read, normalize, deletion, environmentFingerprint}`,
    );
  }
  const adapter = module as Record<string, unknown>;
  const problems: string[] = [];
  if (typeof adapter['read'] !== 'function') problems.push('read must be an async function (ctx, id)');
  if (typeof adapter['normalize'] !== 'function') problems.push('normalize must be a function (body) => {entityId, fields}');
  // Delete-disabled resource: `deletion` is optional (nothing is ever
  // deleted), but a declared value must still be a valid one — adapters
  // that predate this rule, or share a factory with deletable resources,
  // keep declaring it.
  const deletionOptional = options.deleteDisabled === true && adapter['deletion'] === undefined;
  if (!deletionOptional && adapter['deletion'] !== 'hard' && adapter['deletion'] !== 'archive') {
    problems.push("deletion must be 'hard' or 'archive'");
  }
  if (typeof adapter['environmentFingerprint'] !== 'string') {
    problems.push('environmentFingerprint must be a string');
  }
  if (
    adapter['baseUrl'] !== undefined &&
    (typeof adapter['baseUrl'] !== 'string' || adapter['baseUrl'].length === 0)
  ) {
    problems.push('baseUrl must be a non-empty string when present');
  }
  if (adapter['identity'] !== undefined && adapter['identity'] !== 'natural-key') {
    problems.push("identity must be 'natural-key' when present");
  }
  if (adapter['list'] !== undefined && typeof adapter['list'] !== 'function') {
    problems.push('list must be a function (ctx) => entity[] when present');
  }
  if (
    adapter['fields'] !== undefined &&
    (!Array.isArray(adapter['fields']) ||
      adapter['fields'].some((field) => typeof field !== 'string' || field.length === 0) ||
      new Set(adapter['fields']).size !== adapter['fields'].length)
  ) {
    problems.push('fields must be an array of unique non-empty field names when present');
  }
  if (
    adapter['volatileFields'] !== undefined &&
    (!Array.isArray(adapter['volatileFields']) ||
      adapter['volatileFields'].some((field) => typeof field !== 'string' || field.length === 0) ||
      new Set(adapter['volatileFields']).size !== adapter['volatileFields'].length)
  ) {
    problems.push('volatileFields must be an array of unique non-empty field names when present');
  }
  // Server probe (server-witnessed persistence channel): OPTIONAL — an
  // adapter without it simply cannot serve the channel and every server
  // intent for the resource resolves to a typed
  // SERVER_PROBE_UNAVAILABLE failure. A PRESENT but malformed export is
  // a contract violation caught here at load, fail-closed, not at
  // intent time.
  if (adapter['probeServer'] !== undefined && typeof adapter['probeServer'] !== 'function') {
    problems.push('probeServer must be an async function (ctx, subject) => {found, fields} when present');
  }
  // Observe binding (Observe channel, Phase 2): OPTIONAL — an adapter
  // without it serves no observe obligation. Present-but-malformed is a
  // load-time contract violation (fail closed), validated by
  // validateObserveBinding below.
  if (adapter['observe'] !== undefined) {
    const observeProblem = validateObserveBinding(adapter['observe']);
    if (observeProblem !== null) problems.push(observeProblem);
  }
  // Trusted scope/barrier observation (plan 2026-09-19 §4.4, Phase 4):
  // OPTIONAL — adapters lacking these methods still serve legacy proofs
  // but cannot satisfy strong contracts requiring scoped observation.
  // Present-but-not-a-function is a load-time violation (fail closed).
  if (adapter['snapshotScope'] !== undefined && typeof adapter['snapshotScope'] !== 'function') {
    problems.push('snapshotScope must be an async function (ctx, {scope, fixtureNamespace}) => ScopeSnapshot when present');
  }
  if (adapter['awaitBarrier'] !== undefined && typeof adapter['awaitBarrier'] !== 'function') {
    problems.push('awaitBarrier must be an async function (ctx, {scope, fixtureNamespace, operationId, deadlineMs}) when present');
  }
  if (problems.length > 0) {
    throw new AdapterRegistryError(`adapter '${name}' violates the adapter contract: ${problems.join('; ')}`);
  }
  return {
    read: adapter['read'] as EvidenceAdapter['read'],
    normalize: adapter['normalize'] as EvidenceAdapter['normalize'],
    ...(adapter['deletion'] === undefined ? {} : { deletion: adapter['deletion'] as 'hard' | 'archive' }),
    environmentFingerprint: adapter['environmentFingerprint'] as string,
    ...(adapter['identity'] !== undefined ? { identity: 'natural-key' as const } : {}),
    baseUrl: adapter['baseUrl'] as string | undefined,
    ...(adapter['fields'] !== undefined
      ? { fields: [...(adapter['fields'] as string[])] }
      : {}),
    ...(adapter['volatileFields'] !== undefined
      ? { volatileFields: [...(adapter['volatileFields'] as string[])] }
      : {}),
    ...(adapter['list'] !== undefined
      ? { list: adapter['list'] as EvidenceAdapter['list'] }
      : {}),
    ...(adapter['probeServer'] !== undefined
      ? { probeServer: adapter['probeServer'] as EvidenceAdapter['probeServer'] }
      : {}),
    ...(adapter['observe'] !== undefined
      ? { observe: adapter['observe'] as EvidenceAdapter['observe'] }
      : {}),
    ...(adapter['snapshotScope'] !== undefined
      ? { snapshotScope: adapter['snapshotScope'] as EvidenceAdapter['snapshotScope'] }
      : {}),
    ...(adapter['awaitBarrier'] !== undefined
      ? { awaitBarrier: adapter['awaitBarrier'] as EvidenceAdapter['awaitBarrier'] }
      : {}),
  };
}

/** Fail-closed adapter-loading error (witness startup aborts). */
export class AdapterRegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AdapterRegistryError';
  }
}

/** Concrete HTTP methods an observe binding may name (uppercase). */
const OBSERVE_METHODS: ReadonlySet<string> = new Set([
  'GET',
  'HEAD',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'OPTIONS',
]);

/** Observe-eligible operations (the CRUD verbs the grader knows). */
const OBSERVE_OPERATIONS: readonly string[] = ['create', 'read', 'update', 'delete'];

/**
 * Validates one adapter's optional `observe` binding (Observe channel,
 * Phase 2): a plain object with per-operation `{method, path}`
 * entries. Method must be a concrete uppercase verb; path must be an
 * absolute backend-facing path whose only template segment is `{id}` —
 * required on read/update/delete (the entity-id carrier), forbidden on
 * create (create ids come from the adapter list-diff, never from a
 * path guess).
 *
 * Args:
 *   value: the adapter's `observe` export.
 *
 * Returns:
 *   string | null: the contract-violation description, or null when valid.
 */
export function validateObserveBinding(value: unknown): string | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return 'observe must be an object {create?/read?/update?/delete?: {method, path}} when present';
  }
  const binding = value as Record<string, unknown>;
  for (const key of Object.keys(binding)) {
    if (!OBSERVE_OPERATIONS.includes(key)) {
      return `observe carries unknown operation '${key}' (allowed: ${OBSERVE_OPERATIONS.join(', ')})`;
    }
  }
  for (const operation of OBSERVE_OPERATIONS) {
    const entry = binding[operation];
    if (entry === undefined) continue;
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      return `observe.${operation} must be {method, path}`;
    }
    const { method, path } = entry as Record<string, unknown>;
    if (typeof method !== 'string' || !OBSERVE_METHODS.has(method)) {
      return (
        `observe.${operation}.method must be a concrete uppercase HTTP verb ` +
        `(${[...OBSERVE_METHODS].sort().join(', ')})`
      );
    }
    if (typeof path !== 'string' || !path.startsWith('/')) {
      return `observe.${operation}.path must be an absolute backend-facing path starting with '/'`;
    }
    if (path.includes('//') || /[\s?#]/.test(path)) {
      return `observe.${operation}.path must be a plain path template (no duplicate slashes, query, fragment, or whitespace)`;
    }
    const segments = path.split('/').filter((segment) => segment.length > 0);
    const idSegments = segments.filter((segment) => segment === '{id}').length;
    const braced = segments.filter((segment) => segment.startsWith('{') || segment.endsWith('}'));
    if (braced.length !== idSegments) {
      return `observe.${operation}.path may template only the '{id}' segment (got '${path}')`;
    }
    if (operation === 'create' && idSegments > 0) {
      return `observe.create.path must not template '{id}' (create ids come from the adapter list-diff, got '${path}')`;
    }
    // Optional COLLECTION read shape (declared, never inferred): a
    // real UI renders a LIST, so a read may name its entities in the
    // returned rows instead of in the path. Only a read may declare
    // it, only over GET, and never alongside the `{id}` template the
    // by-id reader binds — every shape violation fails here, at load.
    const collection = (entry as Record<string, unknown>)['collection'];
    const declaresCollection = collection !== undefined;
    if (declaresCollection) {
      const problem = validateObserveCollection(collection, operation, method, path);
      if (problem !== null) return problem;
    }
    if (operation !== 'create' && idSegments !== 1 && !declaresCollection) {
      return `observe.${operation}.path must carry exactly one '{id}' segment binding the entity id (got '${path}')`;
    }
  }
  return null;
}

/**
 * Validates one operation's optional `collection` declaration: the
 * response shape whose ROWS name the entities an observe read credits.
 * A collection read must be a `read` over `GET` on a path that carries
 * no `{id}` template (the by-id reader owns that), and must declare the
 * row `idKey`; `rowsKey` is optional and its absence declares that the
 * response root is the row array. Every failure is a load-time
 * contract violation — an adapter can never quietly fall back to
 * inferring a collection from an arbitrary response body.
 *
 * Args:
 *   value: the operation entry's `collection` export.
 *   operation: the observe operation the declaration sits on.
 *   method: the operation's already-validated HTTP method.
 *   path: the operation's already-validated path template.
 *
 * Returns:
 *   string | null: the contract-violation description, or null when valid.
 */
export function validateObserveCollection(
  value: unknown,
  operation: string,
  method: string,
  path: string,
): string | null {
  if (operation !== 'read') {
    return (
      `observe.${operation}.collection is not supported — only a read renders a collection ` +
      `(${operation} ids come from the list-diff or the '{id}' path segment)`
    );
  }
  if (method !== 'GET') {
    return `observe.read.collection requires method 'GET' (got '${method}') — a collection is read, never written`;
  }
  if (path.split('/').includes('{id}')) {
    return (
      `observe.read.collection must not be declared on a path carrying '{id}' (got '${path}') — a ` +
      'by-id read and a collection read are two shapes, never one'
    );
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return `observe.read.collection must be an object {idKey, rowsKey?}`;
  }
  const declaration = value as Record<string, unknown>;
  for (const key of Object.keys(declaration)) {
    if (key !== 'idKey' && key !== 'rowsKey') {
      return `observe.read.collection carries unknown key '${key}' (allowed: idKey, rowsKey)`;
    }
  }
  const idKey = declaration['idKey'];
  if (typeof idKey !== 'string' || idKey.length === 0 || /[\s]/.test(idKey)) {
    return "observe.read.collection.idKey must be a non-empty property name (the row field carrying the entity id)";
  }
  const rowsKey = declaration['rowsKey'];
  if (rowsKey !== undefined && (typeof rowsKey !== 'string' || rowsKey.length === 0 || /[\s]/.test(rowsKey))) {
    return (
      "observe.read.collection.rowsKey must be a non-empty property name when present (omit it when the " +
      'response root is the row array)'
    );
  }
  return null;
}
/**
 * The transport the witness hands to adapter `read` calls (GET-only).
 *
 * Args:
 *   baseUrl: the resolved read base.
 *   resourceId: the resource this adapter serves.
 *   get: the mediated GET primitive.
 *   headers: engine-side read headers, when the run issues one.
 *   session: the test session the read belongs to and the identity THAT
 *     session registered (plan Phase 4b item 3b). Omitted for
 *     engine-driven, probe and supervisor reads — those are not a test
 *     session's read and must never inherit one.
 *
 * Returns:
 *   AdapterContext: the frozen read context.
 */
export function makeAdapterContext(
  baseUrl: string,
  resourceId: string,
  get: AdapterContext['get'],
  headers?: Record<string, string>,
  session?: { sessionId: string; sessionIdentity: SessionIdentity | null },
): AdapterContext {
  return Object.freeze({
    baseUrl,
    resourceId,
    get,
    ...(session !== undefined
      ? { sessionId: session.sessionId, sessionIdentity: session.sessionIdentity }
      : {}),
    ...(headers ? { headers } : {}),
  });
}