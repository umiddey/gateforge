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
 * One GET route the runtime route inventory omits because its
 * endpoint's plane is unanswered.
 *
 * An endpoint with no resolved plane has no plane-qualified graph id,
 * so `httpRoutesView` skips it: the route IS compiled and it DOES
 * exist — nothing downstream can see it, which is not the same thing.
 * The scaffolder needs it to name the real blocker instead of
 * reporting the resource as unserved (GF-12).
 */
export interface UnresolvedRoute {
  /** Concrete uppercase method as compiled (e.g. `GET`). */
  readonly method: string;
  /** Compiled canonical path shape (e.g. `/accounts/{}`). */
  readonly canonicalPath: string;
  /** Linked business resource name, when the compiler linked one. */
  readonly linkedResourceName?: string;
}

/**
 * The plane-unanswered GET routes that could serve one business
 * resource: the same evidence rule the resolved inventory uses — the
 * engine LINKED the route, or the path NAMES the resource as a whole
 * segment. A route the compiler linked to a DIFFERENT resource is
 * never returned here: that is someone else's route.
 *
 * Args:
 *   resource: the business resource.
 *   routes: the plane-unanswered route inventory.
 *
 * Returns:
 *   UnresolvedRoute[]: every GET route that could serve the resource,
 *   in the order the inventory carries them.
 */
export function unresolvedRoutesForResource(
  resource: GraphResource,
  routes: readonly UnresolvedRoute[],
): UnresolvedRoute[] {
  const gets = routes.filter((route) => route.method === 'GET');
  const name = nameSegment(resource.name);
  return gets.filter(
    (route) =>
      route.linkedResourceName === resource.name ||
      route.canonicalPath.split('/').some((segment) => nameSegment(segment) === name),
  );
}

/**
 * The literal path segments a route carries BETWEEN the segment that
 * names the resource and its positional tail.
 *
 * `/shipments/carrier/{id}` names `shipments` and then adds a literal
 * `carrier`, so it reads a carrier THROUGH a shipment: whatever it
 * answers, it is not one shipment entity. A route whose last literal
 * segment IS the resource (`/shipments/{id}`) has no such tail, and a
 * route that never names the resource cannot be judged this way at
 * all — there the engine's linkage is the evidence.
 *
 * Args:
 *   prefix: the literal prefix `splitRoutePath` left behind.
 *   resourceName: the business resource name.
 *
 * Returns:
 *   string[]: the literal segments after the resource segment, or an
 *   empty array when the route's own level IS the resource.
 */
export function literalTailAfterResource(prefix: string, resourceName: string): string[] {
  const segments = prefix.split('/').filter((segment) => segment.length > 0);
  const name = nameSegment(resourceName);
  const at = segments.findIndex((segment) => nameSegment(segment) === name);
  if (at < 0 || at === segments.length - 1) return [];
  return segments.slice(at + 1);
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
 * The probe reads exactly what a witnessed run would read, so it can
 * report the real status, the real `Location` of a redirect-only
 * path, and the real environment marker (GF-13) instead of what the
 * adapter chose to report about itself. A kit adapter issues the read
 * through its own `probe` hook — its seat, its cookies, one re-login
 * on 401; a kit that predates the hook declares the path it reads
 * (`evidencePaths`) and the probe issues the GET itself. A
 * hand-written adapter is probed through its own read with a
 * recording context, so the GETs it issues are observed from the
 * outside.
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
  if (paths !== null) {
    const target = paths.list() ?? paths.read(probeId ?? '0');
    if (target === null) {
      return {
        name: report.name,
        outcome: 'skipped',
        path: '',
        detail: 'adapter declares no probeable path (composed collection reads are probed by the run)',
      };
    }
    // A kit adapter reads through its own seat, so the probe must
    // too: an unauthenticated GET would report a 401 the adapter
    // never sees and blame credentials that are perfectly correct.
    const probe = module['probe'];
    return typeof probe === 'function'
      ? probeThroughKit(report, baseUrl, probe as KitProbe, probeId)
      : probePath(report, baseUrl, target);
  }
  return probeThroughAdapter(report, baseUrl, probeId);
}

/**
 * The read-only probe hook a kit adapter exposes: it issues ONE read
 * through the adapter's own transport, seat and all.
 */
interface KitProbe {
  (ctx: { baseUrl: string }, id?: string): Promise<KitProbeResult>;
}

/** What one kit-issued read showed. */
interface KitProbeResult {
  path: string;
  status: number;
  headers: Headers;
}

/**
 * Probes a kit adapter through its own read, and reports what the
 * seat had to say.
 *
 * Args:
 *   report: the loaded adapter (for the declared fingerprint).
 *   baseUrl: the running app's base URL.
 *   probe: the adapter's read-only probe hook.
 *   probeId: the entity id to read when there is no collection read.
 *
 * Returns:
 *   Promise<AdapterProbeReport>: classified outcome, or the seat's own
 *   plain failure (never a credential).
 */
async function probeThroughKit(
  report: AdapterFileReport,
  baseUrl: string,
  probe: KitProbe,
  probeId?: string,
): Promise<AdapterProbeReport> {
  let observed: KitProbeResult;
  try {
    observed = await probe({ baseUrl }, probeId);
  } catch (error) {
    return kitReadFailure(report, error);
  }
  return classifyRead(
    report,
    observed.path,
    observed.status,
    observed.headers.get('location'),
    observed.headers.get(ENV_FINGERPRINT_HEADER),
  );
}

/**
 * Classifies what one read showed. Shared by the probe's own GET and
 * the kit's read, so both report the same status the same way.
 *
 * Args:
 *   report: the loaded adapter (for the declared fingerprint).
 *   path: the path the read hit.
 *   status: the HTTP status the app answered.
 *   location: the redirect target, when the app answered with one.
 *   marker: the environment marker the app presented (GF-13).
 *
 * Returns:
 *   AdapterProbeReport: the classified outcome.
 */
function classifyRead(
  report: AdapterFileReport,
  path: string,
  status: number,
  location: string | null,
  marker: string | null,
): AdapterProbeReport {
  if (status >= 300 && status < 400) {
    return {
      name: report.name,
      outcome: 'failed',
      path,
      detail:
        `GET ${path} answered ${String(status)}` +
        `${location === null ? '' : ` -> ${location}`}; a read that only works through a ` +
        'redirect is not a stable evidence path',
    };
  }
  if (status === 401 || status === 403) {
    return {
      name: report.name,
      outcome: 'auth',
      path,
      detail:
        `GET ${path} answered ${String(status)}; check the adapter's login seat and ` +
        'the witness environment credentials it names',
    };
  }
  if (status === 404) {
    return {
      name: report.name,
      outcome: 'absent',
      path,
      detail: `GET ${path} answered 404; the resource is not served at this path`,
    };
  }
  if (status < 200 || status >= 300) {
    return {
      name: report.name,
      outcome: 'failed',
      path,
      detail: `GET ${path} answered ${String(status)}`,
    };
  }
  const declared = report.declares.environmentFingerprint;
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
 * The facts a kit reports about a seat that could not authenticate.
 * Read structurally: the adapter may be built against another copy
 * of the kit, so nothing here is imported.
 */
interface KitAuthFailureShape {
  /** The seat's declared name. */
  seat: string;
  /** Env var names it needs, or null when the login was rejected. */
  envVars: readonly string[] | null;
}

/**
 * Reports why the adapter's own read never got an answer: an absent
 * credential is named by the env vars it needs, a rejected login by
 * the login POST status, and never by a credential value.
 *
 * Args:
 *   report: the loaded adapter.
 *   error: what the kit's read threw.
 *
 * Returns:
 *   AdapterProbeReport: the failure, as the probe reports it.
 */
function kitReadFailure(report: AdapterFileReport, error: unknown): AdapterProbeReport {
  const thrown = error as {
    name?: string;
    message?: string;
    failure?: KitAuthFailureShape;
  };
  const message = thrown.message?.split('\n')[0] ?? 'the adapter read failed';
  if (thrown.name !== 'KitAuthError') {
    return { name: report.name, outcome: 'failed', path: '', detail: message };
  }
  const envVars = thrown.failure?.envVars ?? null;
  return {
    name: report.name,
    outcome: 'auth',
    path: '',
    detail:
      envVars === null || envVars.length === 0
        ? message
        : `the seat '${thrown.failure?.seat ?? ''}' needs ${envVars.join(', ')} in the ` +
          'environment — not probed',
  };
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
  return classifyRead(
    report,
    path,
    response.status,
    response.headers.get('location'),
    response.headers.get(ENV_FINGERPRINT_HEADER),
  );
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
