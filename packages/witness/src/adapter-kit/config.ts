/**
 * Adapter-kit configuration: the reviewed CONFIG a project writes
 * instead of a hand-rolled `read`/`list`/`normalize` triple.
 *
 * The kit is a constructor, never a contract change: what it returns is
 * the frozen pin-#8 `EvidenceAdapter` a hand-written module exports, and
 * a hand-written module keeps working unchanged. Everything here is
 * GET-only — the kit can log in (one POST to a declared login path
 * with credentials named by WITNESS env vars) and then read, but it can
 * never create, update, or delete business state.
 *
 * Design rules carried by these types:
 * - every doubt fails closed with a plain message (a truncated list, an
 *   unknown field, a redirect-only path, a cap that hid rows);
 * - `volatileFields` is declared, never inferred: the engine skips the
 *   exact-value echo for those keys and says so in the report;
 * - credentials are named by ENV VAR, never inlined, and are read only
 *   from the witness process environment.
 */

/** How one collection read walks its pages. */
export type PagingKind = 'cursor' | 'page' | 'offset';

/**
 * Paging declaration for a collection read. Bounded on purpose: a walk
 * that reaches the cap with a next page available is a TRUNCATION, not
 * a complete list, and the kit fails closed instead of returning a
 * partial id set (E11, E27).
 */
export interface HttpAdapterPaging {
  /** Cursor-, page-number-, or offset-addressed pages. */
  kind: PagingKind;
  /** Rows per page for `page`/`offset` (default 100). */
  pageSize?: number;
  /** Hard page cap for every kind (default 100). */
  maxPages?: number;
  /** Query parameter carrying the page number (default `page`). */
  pageParam?: string;
  /** Query parameter carrying the page size (default `page_size`). */
  pageSizeParam?: string;
  /** Query parameter carrying the offset (default `offset`). */
  offsetParam?: string;
  /** Query parameter carrying the row limit (default `limit`). */
  limitParam?: string;
}

/** One named login seat: credentials named by WITNESS env vars. */
export interface CookieLoginSeat {
  /** Path the one login POST is sent to (absolute path). */
  loginPath: string;
  /**
   * Login request body field -> WITNESS env var holding its value.
   * The values are read from `process.env` at call time and never
   * printed, logged, or written anywhere.
   */
  credentials: Readonly<Record<string, string>>;
  /** Keep only this cookie name from the login response (default: all). */
  cookieName?: string;
  /** Extra headers for the login POST (e.g. `content-type`). */
  headers?: Readonly<Record<string, string>>;
}

/** One named bearer seat: a token named by a WITNESS env var. */
export interface BearerSeat {
  /** WITNESS env var holding the bearer token. */
  tokenEnv: string;
  /** Prefix prepended to the token (default `Bearer`). */
  scheme?: string;
}

/** Read authentication for one adapter (witness-side only). */
export type HttpAdapterAuth =
  | { kind: 'none' }
  | { kind: 'bearer'; seats: Readonly<Record<string, BearerSeat>>; seat?: string }
  | { kind: 'cookie-login'; seats: Readonly<Record<string, CookieLoginSeat>>; seat?: string };

/** One kit adapter's whole declaration. */
export interface HttpAdapterConfig {
  /** Registry identity; must equal the adapter file name. */
  resourceId: string;
  /**
   * By-id read path. A function receives the entity id; a string may
   * carry the `{id}` placeholder. `null` resolves members from the
   * collection read instead.
   */
  readPath?: string | ((id: string) => string) | null;
  /** Key holding the entity inside a by-id response body (default: none). */
  itemWrapper?: string | null;
  /** Collection path, or a `(cursor) => path` function for cursors. */
  listPath?: string | ((cursor: string | undefined) => string) | null;
  /** Key holding the array in a collection body, or a selector. */
  collectionKey?: string | ((body: unknown) => unknown) | null;
  /** Next cursor from a page body (cursor paging only). */
  pageCursor?: (body: unknown) => string | null | undefined;
  /** Paging declaration for the collection walk. */
  paging?: HttpAdapterPaging;
  /**
   * Per-parent fan-out: composes a whole collection from several
   * collections. Receives `readAll(pathFor, shape)` and MUST return the
   * complete member list.
   */
  listCollection?: (readAll: CollectionReader) => Promise<readonly unknown[]>;
  /**
   * Projected business fields. Dotted paths are allowed (`owner.name`)
   * and every declared key is checked against the compiled graph by
   * `gateforge adapters check`.
   */
  fields?: readonly string[];
  /** Projected name -> key the response actually carries. */
  fieldMap?: Readonly<Record<string, string>>;
  /** Key identifying the entity when the row has no `id` (default `id`). */
  entityIdKey?: string;
  /** How removal manifests for this resource. */
  deletion?: 'hard' | 'archive';
  /** Target-environment marker the witness compares (GF-13). */
  environmentFingerprint: string;
  /**
   * Fields the SERVER computes on its own. The engine skips the
   * exact-value echo for them and reports the skip — never silently.
   */
  volatileFields?: readonly string[];
  /** Entity-scoped create absence without a collection list. */
  identity?: 'natural-key';
  /** Read authentication (witness environment credentials only). */
  auth?: HttpAdapterAuth;
  /** Base override for THIS adapter's reads. */
  baseUrl?: string;
  /** Optional server probe (contract addition, passed through as-is). */
  probeServer?: (...args: never[]) => unknown;
  /** Optional observe binding (contract addition, passed through as-is). */
  observe?: unknown;
  /** Optional trusted scope observation (contract addition). */
  snapshotScope?: (...args: never[]) => unknown;
  /** Optional completion-barrier observer (contract addition). */
  awaitBarrier?: (...args: never[]) => unknown;
}

/** Options a {@link CollectionReader} call accepts. */
export interface CollectionReadOptions {
  /** Key holding the array in the page body (default: none). */
  collectionKey?: string | ((body: unknown) => unknown) | null;
  /** Next cursor from a page body (cursor paging only). */
  pageCursor?: (body: unknown) => string | null | undefined;
  /** Paging override for this collection. */
  paging?: HttpAdapterPaging;
  /** Page cap override for this collection. */
  maxPages?: number;
}

/**
 * Reads one (possibly paged) collection to completion.
 *
 * Args:
 *   pathFor: collection path, or a `(cursor) => path` function.
 *   options: collection key, cursor extraction, and paging overrides.
 *
 * Returns:
 *   Promise<readonly unknown[]>: every member row across all pages.
 * @throws Error when a page is malformed, a cursor repeats, or the walk
 *   reaches its cap with rows still unread (a truncated list is never
 *   reported as a complete one).
 */
export type CollectionReader = (
  pathFor: string | ((cursor: string | undefined) => string),
  options?: CollectionReadOptions,
) => Promise<readonly unknown[]>;
