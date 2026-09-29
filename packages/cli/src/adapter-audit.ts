/**
 * Adapter audit: what a project actually has in `.gateforge/adapters/`
 * and what it is missing.
 *
 * The engine never trusts an adapter's name — it loads the module and
 * validates it against the SAME contract the witness validates
 * (`validateAdapter`, reached through `@gate-forge/pack-playwright`'s
 * compatibility re-export), so `adapters check` and the witnessed run
 * can never disagree about what an adapter is.
 *
 * Everything here is read-only: loading an adapter runs its own
 * top-level code, and the optional probe issues exactly ONE GET per
 * adapter. No adapter is ever trusted, rewritten, or deleted here.
 */
import { existsSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { validateAdapter } from '@gate-forge/pack-playwright';
import type { GraphResource, HttpRouteCandidate } from '@gate-forge/core';
import { pathMatchesShape } from '@gate-forge/core';

/** The header the target environment presents its marker in (GF-13). */
export const ENV_FINGERPRINT_HEADER = 'x-gateforge-env-fingerprint';

/** One adapter file, loaded and validated. */
export interface AdapterFileReport {
  /** Adapter name (the file's base name, without `.mjs`). */
  name: string;
  /** Absolute path of the adapter module. */
  file: string;
  /** True when the module satisfies the frozen contract. */
  ok: boolean;
  /** Why it is not (empty when ok). */
  issues: string[];
  /** The loaded module, when it loaded at all. */
  module: Record<string, unknown> | null;
  /** Declared capabilities (empty defaults for a broken module). */
  declares: {
    /** The adapter can list the collection (pre-observation). */
    list: boolean;
    /** Entity-scoped create absence via a natural key. */
    naturalKey: boolean;
    /** Server-computed fields the adapter declared (E18a). */
    volatileFields: string[];
    /** Removal semantics the adapter declares. */
    deletion: string | null;
    /** Environment marker the adapter declares. */
    environmentFingerprint: string | null;
  };
}

/** The outcome of one `--probe` GET. */
export type AdapterProbeOutcome =
  | 'ok'
  | 'absent'
  | 'auth'
  | 'fingerprint-mismatch'
  | 'failed'
  | 'skipped';

/** One probe result. */
export interface AdapterProbeReport {
  /** The adapter that was probed. */
  name: string;
  /** What happened. */
  outcome: AdapterProbeOutcome;
  /** The path the probe read. */
  path: string;
  /** Human detail (never a credential). */
  detail: string;
}

/**
 * Lists the adapter module files in one adapters directory.
 *
 * Args:
 *   adaptersDir: absolute path of the adapters directory.
 *
 * Returns:
 *   string[]: absolute paths of every `.mjs` adapter, sorted by name.
 */
export function listAdapterFiles(adaptersDir: string): string[] {
  if (!existsSync(adaptersDir)) return [];
  return readdirSync(adaptersDir)
    .filter((entry) => entry.endsWith('.mjs'))
    .sort()
    .map((entry) => join(adaptersDir, entry));
}

/**
 * Loads one adapter module and validates it against the frozen contract.
 *
 * Args:
 *   file: absolute path of the `.mjs` adapter.
 *
 * Returns:
 *   AdapterFileReport: the verdict plus what the module declares. A
 *   module that cannot even be imported is reported, never thrown.
 */
export async function auditAdapterFile(file: string): Promise<AdapterFileReport> {
  const name = basename(file, '.mjs');
  let module: Record<string, unknown> | null = null;
  const issues: string[] = [];
  try {
    // Runtime-selected module: the adapter file is the project's own
    // reviewed code, and its path is only known at run time.
    const imported = (await import(pathToFileURL(file).href)) as { default?: unknown };
    if (typeof imported.default !== 'object' || imported.default === null) {
      issues.push('must default-export an object {read, normalize, deletion, environmentFingerprint}');
    } else {
      module = imported.default as Record<string, unknown>;
    }
  } catch (error) {
    issues.push(`could not be imported: ${(error as Error).message.split('\n')[0] ?? 'unknown error'}`);
  }
  if (module !== null && issues.length === 0) {
    try {
      validateAdapter(module, name);
    } catch (error) {
      issues.push((error as Error).message.split('\n')[0] ?? 'invalid adapter');
    }
  }
  const declared = module ?? {};
  return {
    name,
    file,
    ok: issues.length === 0,
    issues,
    module,
    declares: {
      list: typeof declared['list'] === 'function',
      naturalKey: declared['identity'] === 'natural-key',
      volatileFields: Array.isArray(declared['volatileFields'])
        ? declared['volatileFields'].filter((key): key is string => typeof key === 'string')
        : [],
      deletion: typeof declared['deletion'] === 'string' ? declared['deletion'] : null,
      environmentFingerprint:
        typeof declared['environmentFingerprint'] === 'string'
          ? declared['environmentFingerprint']
          : null,
    },
  };
}

/**
 * Loads and validates every adapter in a directory.
 *
 * Args:
 *   adaptersDir: absolute path of the adapters directory.
 *
 * Returns:
 *   AdapterFileReport[]: one report per `.mjs` file, sorted by name.
 */
export async function auditAdapters(adaptersDir: string): Promise<AdapterFileReport[]> {
  const files = listAdapterFiles(adaptersDir);
  const reports: AdapterFileReport[] = [];
  for (const file of files) {
    reports.push(await auditAdapterFile(file));
  }
  return reports;
}

/**
 * Normalizes one compiled route path to the engine's `{...}` shape so
 * `pathMatchesShape` can compare it with a concrete adapter path.
 *
 * Args:
 *   canonicalPath: the compiled route shape (`:id` style).
 *
 * Returns:
 *   string: the same shape with every positional segment as `{}`.
 */
export function toShapePath(canonicalPath: string): string {
  return canonicalPath
    .split('/')
    .map((segment) => (segment.startsWith(':') || segment === '{}' ? '{}' : segment))
    .join('/');
}

/**
 * Whether a declared adapter path instantiates a compiled GET route.
 *
 * Args:
 *   adapterPath: the path an adapter declares (query stripped).
 *   routes: the compiled route inventory.
 *
 * Returns:
 *   boolean: true when some GET route has the same shape.
 */
export function pathIsCompiledGet(adapterPath: string, routes: readonly HttpRouteCandidate[]): boolean {
  const bare = adapterPath.split('?')[0] ?? adapterPath;
  return routes.some(
    (route) => route.method === 'GET' && pathMatchesShape(bare, toShapePath(route.canonicalPath)),
  );
}

/**
 * The GET routes that could serve one business resource: those the
 * engine LINKED to it, plus (clearly separated) those whose path NAMES
 * it. Linkage is evidence; a name match is a candidate the scaffolder
 * marks as a guess. Naming is matched per whole path segment, with `_`
 * and `-` treated as the same separator, so a table `work_reports`
 * still finds `/api/v1/work-reports` — but `tasks` never matches
 * `/api/v1/tasks-archive` or `/api/v1/subtasks`.
 *
 * Args:
 *   resource: the business resource.
 *   routes: the compiled route inventory.
 *
 * Returns:
 *   {linked: HttpRouteCandidate[], candidates: HttpRouteCandidate[]}.
 */
export function routesForResource(
  resource: GraphResource,
  routes: readonly HttpRouteCandidate[],
): { linked: HttpRouteCandidate[]; candidates: HttpRouteCandidate[] } {
  const gets = routes.filter((route) => route.method === 'GET');
  const linked = gets.filter((route) => route.linkedResourceName === resource.name);
  const name = nameSegment(resource.name);
  const candidates = gets.filter((route) => {
    if (route.linkedResourceName === resource.name) return false;
    return route.canonicalPath
      .split('/')
      .some((segment) => nameSegment(segment) === name);
  });
  return { linked, candidates };
}

/**
 * Normalizes one name or path segment for whole-segment name matching.
 *
 * Args:
 *   value: a resource name or one path segment.
 *
 * Returns:
 *   string: lowercase, with every run of `_`/`-` collapsed to `-`.
 */
function nameSegment(value: string): string {
  return value.toLowerCase().replace(/[-_]+/g, '-');
}

/**
 * Splits one compiled path into its literal prefix and its trailing
 * positional segments (`:id` / `{}`).
 *
 * Args:
 *   canonicalPath: the compiled route shape.
 *
 * Returns:
 *   {prefix: string, idSegments: string[]}: the collection path and the
 *   positional tail (empty for a collection route).
 */
export function splitRoutePath(canonicalPath: string): { prefix: string; idSegments: string[] } {
  const segments = canonicalPath.split('/').filter((segment) => segment.length > 0);
  const idSegments: string[] = [];
  while (segments.length > 0) {
    const last = segments[segments.length - 1] as string;
    if (!last.startsWith(':') && last !== '{}') break;
    idSegments.unshift(last);
    segments.pop();
  }
  return { prefix: `/${segments.join('/')}`, idSegments };
}

/**
 * The introspection a kit adapter exposes for probing
 * (`evidencePaths`): the exact path its first read of each kind hits.
 */
interface KitEvidencePaths {
  read: (id: string) => string | null;
  list: () => string | null;
}

/**
 * Reads an adapter's kit introspection, when it has one.
 *
 * Args:
 *   module: the loaded adapter module.
 *
 * Returns:
 *   KitEvidencePaths | null: the declared paths, or null for a
 *   hand-written adapter that declares none.
 */
function kitPathsOf(module: Record<string, unknown>): KitEvidencePaths | null {
  const declared = module['evidencePaths'];
  if (typeof declared !== 'object' || declared === null) return null;
  const paths = declared as Record<string, unknown>;
  if (typeof paths['read'] !== 'function' || typeof paths['list'] !== 'function') return null;
  return {
    read: (paths['read'] as (id: string) => string | null).bind(declared),
    list: (paths['list'] as () => string | null).bind(declared),
  };
}

/**
 * Probes one adapter with a single GET (read-only).
 *
 * The probe issues the GET ITSELF against the path the adapter reads,
 * so it can report the real status, the real `Location` of a
 * redirect-only path, and the real environment marker (GF-13) instead
 * of what the adapter chose to report about itself. A kit adapter
 * declares that path (`evidencePaths`); a hand-written adapter is
 * probed through its own read with a recording context, so the GETs it
 * issues are observed from the outside.
 *
 * Args:
 *   report: the loaded adapter.
 *   baseUrl: the running app's base URL.
 *   probeId: entity id to read when there is no collection read.
 *
 * Returns:
 *   Promise<AdapterProbeReport>: what the one GET showed.
 */
export async function probeAdapter(
  report: AdapterFileReport,
  baseUrl: string,
  probeId?: string,
): Promise<AdapterProbeReport> {
  const module = report.module;
  if (module === null || typeof module['read'] !== 'function') {
    return {
      name: report.name,
      outcome: 'skipped',
      path: '',
      detail: 'adapter does not load; nothing to probe',
    };
  }
  const paths = kitPathsOf(module);
  const readPath = paths === null ? null : (paths.read(probeId ?? '0') ?? null);
  const listPath = paths === null ? null : paths.list();
  const target = listPath ?? readPath;
  if (target !== null) {
    return probePath(report, baseUrl, target);
  }
  if (paths !== null) {
    return {
      name: report.name,
      outcome: 'skipped',
      path: '',
      detail: 'adapter declares no probeable path (composed collection reads are probed by the run)',
    };
  }
  return probeThroughAdapter(report, baseUrl, probeId);
}

/**
 * Issues the probe's single GET against a known path.
 *
 * Args:
 *   report: the loaded adapter (for the declared fingerprint).
 *   baseUrl: the running app's base URL.
 *   path: the path the adapter reads.
 *
 * Returns:
 *   Promise<AdapterProbeReport>: classified status.
 */
async function probePath(
  report: AdapterFileReport,
  baseUrl: string,
  path: string,
): Promise<AdapterProbeReport> {
  const response = await fetch(`${baseUrl.replace(/\/$/, '')}${path}`, { redirect: 'manual' });
  const declared = report.declares.environmentFingerprint;
  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get('location');
    return {
      name: report.name,
      outcome: 'failed',
      path,
      detail:
        `GET ${path} answered ${String(response.status)}` +
        `${location === null ? '' : ` -> ${location}`}; a read that only works through a ` +
        'redirect is not a stable evidence path',
    };
  }
  if (response.status === 401 || response.status === 403) {
    return {
      name: report.name,
      outcome: 'auth',
      path,
      detail:
        `GET ${path} answered ${String(response.status)}; check the adapter's login seat and ` +
        'the witness environment credentials it names',
    };
  }
  if (response.status === 404) {
    return {
      name: report.name,
      outcome: 'absent',
      path,
      detail: `GET ${path} answered 404; the resource is not served at this path`,
    };
  }
  if (response.status < 200 || response.status >= 300) {
    return {
      name: report.name,
      outcome: 'failed',
      path,
      detail: `GET ${path} answered ${String(response.status)}`,
    };
  }
  const marker = response.headers.get(ENV_FINGERPRINT_HEADER);
  if (declared !== null && marker !== declared) {
    return {
      name: report.name,
      outcome: 'fingerprint-mismatch',
      path,
      detail:
        `GET ${path} presents ${ENV_FINGERPRINT_HEADER}=${JSON.stringify(marker)} but the adapter ` +
        `declares ${JSON.stringify(declared)} (GF-13: the adapter must read the environment under test)`,
    };
  }
  return {
    name: report.name,
    outcome: 'ok',
    path,
    detail:
      marker === null
        ? 'GET answered 2xx (no environment marker presented)'
        : `GET answered 2xx and presents the declared fingerprint '${declared}'`,
  };
}

/**
 * Probes a hand-written adapter through its own read, observing the
 * GETs it issues from the outside.
 *
 * Args:
 *   report: the loaded adapter.
 *   baseUrl: the running app's base URL.
 *   probeId: the entity id to read.
 *
 * Returns:
 *   Promise<AdapterProbeReport>: classified outcome.
 */
async function probeThroughAdapter(
  report: AdapterFileReport,
  baseUrl: string,
  probeId?: string,
): Promise<AdapterProbeReport> {
  if (probeId === undefined) {
    return {
      name: report.name,
      outcome: 'skipped',
      path: '',
      detail: 'hand-written adapter: pass --probe-id to read one entity through it',
    };
  }
  const seen: Array<{ path: string; status: number; marker: string | null }> = [];
  const ctx = {
    baseUrl,
    resourceId: report.name,
    get: async (path: string) => {
      const response = await fetch(`${baseUrl.replace(/\/$/, '')}${path}`, { redirect: 'manual' });
      seen.push({
        path,
        status: response.status,
        marker: response.headers.get(ENV_FINGERPRINT_HEADER),
      });
      return {
        status: response.status,
        json: () => response.json() as Promise<unknown>,
        text: () => response.text(),
        headers: response.headers,
      };
    },
  };
  const read = report.module?.['read'] as
    | ((ctx: unknown, id: unknown) => Promise<unknown>)
    | undefined;
  if (read === undefined) {
    return {
      name: report.name,
      outcome: 'skipped',
      path: '',
      detail: 'adapter has no read function',
    };
  }
  let body: unknown;
  try {
    body = await read(ctx, probeId);
  } catch (error) {
    return {
      name: report.name,
      outcome: 'failed',
      path: seen[0]?.path ?? '',
      detail: (error as Error).message.split('\n')[0] ?? 'read failed',
    };
  }
  const observed = seen[0];
  if (observed === undefined) {
    return {
      name: report.name,
      outcome: 'failed',
      path: '',
      detail: 'the adapter read issued no GET through the witness transport',
    };
  }
  if (observed.status === 401 || observed.status === 403) {
    return {
      name: report.name,
      outcome: 'auth',
      path: observed.path,
      detail: `GET ${observed.path} answered ${String(observed.status)}`,
    };
  }
  if (observed.status >= 300 && observed.status < 400) {
    return {
      name: report.name,
      outcome: 'failed',
      path: observed.path,
      detail: `GET ${observed.path} answered ${String(observed.status)} (redirect-only path)`,
    };
  }
  if (body === null || body === undefined) {
    return {
      name: report.name,
      outcome: 'absent',
      path: observed.path,
      detail: observed.status === 404
        ? `GET ${observed.path} answered 404`
        : `GET ${observed.path} answered ${String(observed.status)} and the adapter reported the entity absent`,
    };
  }
  const declared = report.declares.environmentFingerprint;
  if (declared !== null && observed.marker !== declared) {
    return {
      name: report.name,
      outcome: 'fingerprint-mismatch',
      path: observed.path,
      detail:
        `GET ${observed.path} presents ${ENV_FINGERPRINT_HEADER}=${JSON.stringify(observed.marker)} ` +
        `but the adapter declares ${JSON.stringify(declared)} (GF-13)`,
    };
  }
  return {
    name: report.name,
    outcome: 'ok',
    path: observed.path,
    detail: `GET ${observed.path} answered ${String(observed.status)} and the entity was read`,
  };
}
