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
 *   environmentFingerprint: '…',            // must match the target's marker header
 *   baseUrl: 'http://…',                    // optional override of the witness adapter base
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
import type { AdapterContext, EvidenceAdapter } from './types.js';

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
export async function loadAdapters(dir: string): Promise<Map<string, EvidenceAdapter>> {
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
    const adapter = validateAdapter(module, name);
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
 *   wrong. Optional `baseUrl` (a string) overrides the witness's
 *   configured adapter base for this adapter.
 */
export function validateAdapter(module: unknown, name: string): EvidenceAdapter {
  if (typeof module !== 'object' || module === null) {
    throw new AdapterRegistryError(
      `adapter '${name}' must default-export an object {read, normalize, deletion, environmentFingerprint}`,
    );
  }
  const adapter = module as Record<string, unknown>;
  const problems: string[] = [];
  if (typeof adapter['read'] !== 'function') problems.push('read must be an async function (ctx, id)');
  if (typeof adapter['normalize'] !== 'function') problems.push('normalize must be a function (body) => {entityId, fields}');
  if (adapter['deletion'] !== 'hard' && adapter['deletion'] !== 'archive') {
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
  if (adapter['list'] !== undefined && typeof adapter['list'] !== 'function') {
    problems.push('list must be a function (ctx) => entity[] when present');
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
  if (problems.length > 0) {
    throw new AdapterRegistryError(`adapter '${name}' violates the adapter contract: ${problems.join('; ')}`);
  }
  return {
    read: adapter['read'] as EvidenceAdapter['read'],
    normalize: adapter['normalize'] as EvidenceAdapter['normalize'],
    deletion: adapter['deletion'] as 'hard' | 'archive',
    environmentFingerprint: adapter['environmentFingerprint'] as string,
    baseUrl: adapter['baseUrl'] as string | undefined,
    ...(adapter['list'] !== undefined
      ? { list: adapter['list'] as EvidenceAdapter['list'] }
      : {}),
    ...(adapter['probeServer'] !== undefined
      ? { probeServer: adapter['probeServer'] as EvidenceAdapter['probeServer'] }
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

/** The transport the witness hands to adapter `read` calls (GET-only). */
export function makeAdapterContext(
  baseUrl: string,
  resourceId: string,
  get: AdapterContext['get'],
  headers?: Record<string, string>,
): AdapterContext {
  return Object.freeze({ baseUrl, resourceId, get, ...(headers ? { headers } : {}) });
}