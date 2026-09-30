/**
 * `defineHttpAdapter(config)`: the reviewed config → contract-valid
 * adapter constructor.
 *
 * What it buys a project: a correct by-id read, a complete (paged)
 * collection read, a deterministic projection, declared
 * server-computed fields, and witness-side login — from configuration
 * instead of a hand-rolled module. What it never does: trust itself.
 * The returned object is an ordinary pin-#8 adapter; the gate treats a
 * generated adapter exactly like a hand-written one, every doubt fails
 * closed with a plain message, and nothing here can write.
 */
import type {
  CollectionReadOptions,
  CollectionReader,
  HttpAdapterConfig,
  HttpAdapterPaging,
} from './config.js';
import { projectEntity, type NormalizedEntity } from './projection.js';
import {
  createSessionReader,
  type KitGetResult,
  type KitProbeResult,
  type SessionStore,
} from './session.js';
import type { AdapterContext, EvidenceAdapter, SessionIdentity } from '../witness/types.js';

/** The context a probe read runs under (the audit passes just a base URL). */
export type KitProbeContext = {
  baseUrl: string;
  headers?: Record<string, string>;
  /**
   * The session a witnessed read belongs to, and the identity THAT
   * session registered (plan Phase 4b item 3b). A probe (no session)
   * carries neither and reads through the environment seat, exactly as
   * before.
   */
  sessionId?: string;
  sessionIdentity?: SessionIdentity | null;
};

/** Default page cap for every bounded collection walk. */
export const DEFAULT_MAX_PAGES = 100;

/** Default rows per page for page/offset paging. */
export const DEFAULT_PAGE_SIZE = 100;

/**
 * Appends a query parameter to a path, preserving what is already there.
 *
 * Args:
 *   path: path (with any existing query) to extend.
 *   key: query parameter name.
 *   value: parameter value.
 *
 * Returns:
 *   string: the path with one more query parameter.
 */
function withQuery(path: string, key: string, value: string): string {
  const separator = path.includes('?') ? '&' : '?';
  return `${path}${separator}${encodeURIComponent(key)}=${encodeURIComponent(value)}`;
}

/**
 * Applies the declared paging to one page path.
 *
 * Args:
 *   basePath: the collection path without paging parameters.
 *   paging: the paging declaration.
 *   page: 1-based page number.
 *
 * Returns:
 *   string: the path for that page.
 */
function pagedPath(basePath: string, paging: HttpAdapterPaging, page: number): string {
  if (paging.kind === 'page') {
    const size = paging.pageSize ?? DEFAULT_PAGE_SIZE;
    let path = withQuery(basePath, paging.pageParam ?? 'page', String(page));
    path = withQuery(path, paging.pageSizeParam ?? 'page_size', String(size));
    return path;
  }
  if (paging.kind === 'offset') {
    const size = paging.pageSize ?? DEFAULT_PAGE_SIZE;
    const offset = withQuery(basePath, paging.offsetParam ?? 'offset', String((page - 1) * size));
    return withQuery(offset, paging.limitParam ?? 'limit', String(size));
  }
  return basePath;
}

/**
 * Builds one contract-valid adapter from reviewed configuration.
 *
 * Args:
 *   config: the adapter declaration (paths, projection, paging, auth).
 *
 * Returns:
 *   EvidenceAdapter: a frozen pin-#8 adapter. `list` is exported only
 *   when the config declares a collection read, so a resource without
 *   one honestly reports that the witness cannot pre-observe it.
 * @throws Error when the config can never produce a valid adapter
 *   (no read and no list; an unusable projection) — fail closed at
 *   write time rather than at gate time.
 */
export function defineHttpAdapter(config: HttpAdapterConfig): EvidenceAdapter {
  const hasRead = config.readPath !== undefined && config.readPath !== null;
  const hasList =
    (config.listPath !== undefined && config.listPath !== null) ||
    typeof config.listCollection === 'function';
  if (!hasRead && !hasList) {
    throw new Error(
      `${config.resourceId}: adapter declares neither readPath nor listPath/listCollection — ` +
        'an evidence adapter must be able to observe the resource',
    );
  }
  const sessions: SessionStore = new Map();
  // The context of the read in flight: a kit `listCollection` callback
  // receives only the reader, never the witness context.
  let lastCtx: AdapterContext | null = null;

  /**
   * Projects one raw body onto the evidence shape.
   *
   * Args:
   *   body: the raw response body.
   *
   * Returns:
   *   NormalizedEntity: entity id plus the declared projected fields.
   */
  const normalize = (body: unknown): NormalizedEntity =>
    projectEntity(body, {
      ...(config.fields !== undefined ? { fields: config.fields } : {}),
      ...(config.fieldMap !== undefined ? { fieldMap: config.fieldMap } : {}),
      ...(config.entityIdKey !== undefined ? { entityIdKey: config.entityIdKey } : {}),
    });

  /**
   * Reads one path through the kit transport and returns status+body.
   *
   * Args:
   *   ctx: the read context (the witness adapter context, or a
   *     probe's base URL).
   *   path: absolute path to read.
   *
   * Returns:
   *   Promise<KitGetResult>: status, headers, parsed body.
   */
  const request = (ctx: KitProbeContext, path: string): Promise<KitGetResult> =>
    createSessionReader({
      ...(config.auth !== undefined ? { auth: config.auth } : {}),
      resourceId: config.resourceId,
      ctx,
      sessions,
    })(path);

  /**
   * Resolves the declared by-id path for one entity.
   *
   * Args:
   *   id: the entity id.
   *
   * Returns:
   *   string: the by-id path.
   */
  const pathForId = (id: string): string => {
    if (typeof config.readPath === 'function') return config.readPath(id);
    return (config.readPath as string).replaceAll('{id}', encodeURIComponent(id));
  };


  /**
   * The exact path this adapter's first collection read hits (null
   * when it composes one itself).
   *
   * Returns:
   *   string | null: the first page path, or null.
   */
  const firstListPath = (): string | null => {
    if (config.listCollection !== undefined) return null;
    if (config.listPath === undefined || config.listPath === null) return null;
    const paging = config.paging ?? { kind: 'page' as const };
    return typeof config.listPath === 'function'
      ? pagedPath(config.listPath(undefined), paging, 1)
      : pagedPath(config.listPath, paging, 1);
  };
  /**
   * Walks one (possibly paged) collection to completion.
   *
   * Args:
   *   ctx: the witness adapter context.
   *   pathFor: the collection path, or a `(cursor) => path` function.
   *   options: collection key, cursor extraction, paging overrides.
   *
   * Returns:
   *   Promise<readonly unknown[]>: every member row across all pages.
   * @throws Error on a malformed page, a repeated cursor, or a walk
   *   that reached its cap with rows still unread (never a silent
   *   truncation).
   */
  const readAllFor = async (
    ctx: AdapterContext,
    pathFor: string | ((cursor: string | undefined) => string),
    options: CollectionReadOptions = {},
  ): Promise<readonly unknown[]> => {
    const paging = options.paging ?? config.paging ?? { kind: 'page' };
    const maxPages = options.maxPages ?? paging.maxPages ?? DEFAULT_MAX_PAGES;
    const collectionKey =
      options.collectionKey === undefined ? (config.collectionKey ?? null) : options.collectionKey;
    const pageCursor = options.pageCursor ?? config.pageCursor;
    const rows: unknown[] = [];
    const seenCursors = new Set<string>();
    let cursor: string | undefined;
    for (let page = 1; page <= maxPages; page += 1) {
      let path: string;
      if (paging.kind === 'cursor') {
        if (typeof pathFor === 'function') path = pathFor(cursor);
        else if (cursor === undefined) path = pathFor;
        else path = withQuery(pathFor, 'cursor', cursor);
      } else {
        const base = typeof pathFor === 'function' ? pathFor(undefined) : pathFor;
        path = pagedPath(base, paging, page);
      }
      const result = await request(ctx, path);
      if (result.status < 200 || result.status >= 300) {
        throw new Error(
          `${config.resourceId}: collection read GET ${path} -> ${String(result.status)}`,
        );
      }
      const pageRows =
        typeof collectionKey === 'function'
          ? collectionKey(result.body)
          : collectionKey === null || collectionKey === undefined
            ? result.body
            : (result.body as Record<string, unknown> | null)?.[collectionKey];
      if (!Array.isArray(pageRows)) {
        throw new Error(
          `${config.resourceId}: collection read GET ${path} returned no array` +
            (collectionKey === null || collectionKey === undefined
              ? ' (declare collectionKey when the body wraps the rows)'
              : ` under '${String(collectionKey)}'`),
        );
      }
      rows.push(...pageRows);
      if (paging.kind === 'cursor') {
        const next = pageCursor?.(result.body);
        if (next === null || next === undefined) return rows;
        const key = String(next);
        // A repeated cursor would loop forever and never prove completeness.
        if (seenCursors.has(key)) {
          throw new Error(
            `${config.resourceId}: collection cursor repeated ('${key}') — the list would never ` +
              'be complete',
          );
        }
        seenCursors.add(key);
        cursor = key;
        continue;
      }
      const size = paging.pageSize ?? DEFAULT_PAGE_SIZE;
      // A short page IS the last page.
      if (pageRows.length < size) return rows;
      // A full page before the cap: keep walking.
      if (page < maxPages) continue;
      // A full page AT the cap means rows are unread, which is a
      // truncation, not a list (E11, E27).
      throw new Error(
        `${config.resourceId}: result truncated — ${String(rows.length)} row(s) read in ` +
          `${String(maxPages)} page(s) of ${String(size)} and the collection still has more ` +
          '(raise paging.maxPages or fix the collectionKey; a partial id set never proves absence)',
      );
    }
    throw new Error(
      `${config.resourceId}: collection read reached the ${String(maxPages)}-page cap without a ` +
        'next page (raise paging.maxPages or fix the cursor)',
    );
  };

  /**
   * GET-only read of one entity.
   *
   * Args:
   *   ctx: the witness adapter context.
   *   id: the entity id.
   *
   * Returns:
   *   Promise<unknown>: the raw entity body, or null when absent (404).
   * @throws Error on any non-2xx other than 404, and on a redirect.
   */
  const read = async (ctx: AdapterContext, id: unknown): Promise<unknown> => {
    lastCtx = ctx;
    const wanted = String(id);
    if (hasRead) {
      const path = pathForId(wanted);
      const result = await request(ctx, path);
      if (result.status === 404) return null;
      if (result.status < 200 || result.status >= 300) {
        throw new Error(`${config.resourceId}: GET ${path} -> ${String(result.status)}`);
      }
      const member =
        config.itemWrapper === undefined || config.itemWrapper === null
          ? result.body
          : (result.body as Record<string, unknown> | null)?.[config.itemWrapper];
      return member === undefined ? null : member;
    }
    // Collection-resolved member: the read path is unknown, so the id is
    // located in the complete collection (GET-only).
    const rows = await listEntities(ctx);
    return (
      rows.find((row) => normalize(row).entityId === wanted) ?? null
    );
  };

  /**
   * Reads the whole collection through whichever source is declared.
   *
   * Args:
   *   ctx: the witness adapter context.
   *
   * Returns:
   *   Promise<readonly unknown[]>: every member row.
   */
  const listEntities = async (ctx: AdapterContext): Promise<readonly unknown[]> => {
    lastCtx = ctx;
    if (config.listCollection !== undefined) {
      const rows = await config.listCollection((pathFor, options) =>
        readAllFor(ctx, pathFor, options),
      );
      if (!Array.isArray(rows)) {
        throw new Error(
          `${config.resourceId}: composed collection returned no array — listCollection must ` +
            'resolve the complete member list',
        );
      }
      return rows;
    }
    return readAllFor(ctx, config.listPath as string | ((cursor: string | undefined) => string), {});
  };

  const readAll: CollectionReader = (pathFor, options) => {
    if (lastCtx === null) {
      throw new Error(
        `${config.resourceId}: collection read used outside an adapter read/list call`,
      );
    }
    return readAllFor(lastCtx, pathFor, options);
  };

  /**
   * Issues ONE read through this adapter's own transport — seat
   * login, cookie/bearer, one re-login on 401, GET-only — so a probe
   * sees exactly what a witnessed run would. Never writes.
   *
   * Args:
   *   ctx: the base URL to read (headers, when the app needs them).
   *   id: the entity id to read when there is no collection read.
   *
   * Returns:
   *   Promise<KitProbeResult>: the path, status, and headers of that read.
   * @throws KitAuthError when the seat's credentials are absent or
   *   rejected; KitRedirectError when the read only works through a
   *   redirect.
   */
  const probe = async (ctx: KitProbeContext, id?: string): Promise<KitProbeResult> => {
    const listPath = firstListPath();
    const path = listPath ?? pathForId(id ?? '0');
    const result = await request(ctx, path);
    return { path, status: result.status, headers: result.headers };
  };
  return Object.freeze({
    resourceId: config.resourceId,
    read,
    // Read-only introspection for `gateforge adapters check --probe`:
    // the exact path this adapter's first read of each kind hits. Not
    // part of the pin-#8 contract; ignored by the witness.
    evidencePaths: {
      read: (id: string): string | null => (hasRead ? pathForId(id) : null),
      list: (): string | null => firstListPath(),
    },
    // Read-only introspection for `gateforge adapters check --probe`:
    // the ONE read this adapter would issue, issued through its own
    // seat, so the probe reports what a witnessed run would see. Not
    // part of the pin-#8 contract; ignored by the witness.
    probe,
    ...(hasList
      ? { list: async (ctx: AdapterContext): Promise<unknown[]> => [...(await listEntities(ctx))] }
      : {}),
    normalize,
    deletion: config.deletion,
    environmentFingerprint: config.environmentFingerprint,
    ...(config.fields !== undefined ? { fields: [...config.fields] } : {}),
    ...(config.volatileFields !== undefined
      ? { volatileFields: [...config.volatileFields] }
      : {}),
    ...(config.identity !== undefined ? { identity: config.identity } : {}),
    ...(config.baseUrl !== undefined ? { baseUrl: config.baseUrl } : {}),
    ...(config.probeServer !== undefined
      ? { probeServer: config.probeServer as EvidenceAdapter['probeServer'] }
      : {}),
    ...(config.observe !== undefined ? { observe: config.observe as EvidenceAdapter['observe'] } : {}),
    ...(config.snapshotScope !== undefined
      ? { snapshotScope: config.snapshotScope as EvidenceAdapter['snapshotScope'] }
      : {}),
    ...(config.awaitBarrier !== undefined
      ? { awaitBarrier: config.awaitBarrier as EvidenceAdapter['awaitBarrier'] }
      : {}),
  } as EvidenceAdapter);
}
