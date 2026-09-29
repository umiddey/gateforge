/**
 * `@gate-forge/witness/adapter-kit` — the configuration-first
 * constructor for evidence adapters.
 *
 * A project writes a reviewed config (paths, wrapper keys, projected
 * fields, paging, login seat) and gets a contract-valid adapter:
 *
 * ```js
 * import { defineHttpAdapter } from '@gate-forge/witness/adapter-kit';
 *
 * export default defineHttpAdapter({
 *   resourceId: 'tenant.accounts',
 *   readPath: (id) => `/api/accounts/${encodeURIComponent(id)}`,
 *   listPath: '/api/accounts',
 *   collectionKey: 'accounts',
 *   paging: { kind: 'page', pageSize: 100 },
 *   fields: ['first_name', 'last_name', 'status'],
 *   deletion: 'archive',
 *   environmentFingerprint: 'loopback-v1',
 * });
 * ```
 *
 * The kit is a convenience, never a shortcut past the gate: what it
 * returns is the frozen pin-#8 adapter, the gate grades a generated
 * adapter exactly like a hand-written one, and a generated file is a
 * STARTING POINT for review — `gateforge adapters scaffold` marks
 * every guess and lists what still needs a human.
 */
export { defineHttpAdapter, DEFAULT_MAX_PAGES, DEFAULT_PAGE_SIZE } from './define.js';
export {
  firstArrayOf,
  readPath,
  projectEntity,
  type NormalizedEntity,
  type ProjectionConfig,
} from './projection.js';
export {
  createSessionReader,
  KitAuthError,
  KitRedirectError,
  type KitGetResult,
  type SessionReaderOptions,
} from './session.js';
export type {
  BearerSeat,
  CollectionReader,
  CollectionReadOptions,
  CookieLoginSeat,
  HttpAdapterAuth,
  HttpAdapterConfig,
  HttpAdapterPaging,
  PagingKind,
} from './config.js';
