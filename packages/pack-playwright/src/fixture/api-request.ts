/**
 * Playwright API-context helpers. Calls made from test code go directly to
 * the app and are reported to the witness only as run-scoped diagnostics;
 * they never pass through the session proxy and never satisfy E2E claims.
 * Browser page traffic has a separate proxy route and is the only transport
 * channel that can support observed-E2E claims.
 */
import type { APIRequestContext, APIResponse } from 'playwright';

/** The validated origin pair one session's API calls route between. */
export interface SessionApiRouting {
  appOrigin: string;
  sessionOrigin: string;
}

/**
 * Validates the origin pair exactly like the page channel's own rule:
 * both must be plain http and share the same (loopback) host — the swap
 * is a port swap, never a host change.
 *
 * Args:
 *   appBaseURL: the configured app origin (GATEFORGE_APP_BASE_URL).
 *   sessionProxyURL: the supervisor-issued session proxy origin.
 *
 * Returns:
 *   SessionApiRouting: the parsed, validated pair.
 */
export function sessionApiRouting(appBaseURL: string, sessionProxyURL: string): SessionApiRouting {
  const appOrigin = new URL(appBaseURL);
  const sessionOrigin = new URL(sessionProxyURL);
  if (
    appOrigin.protocol !== 'http:' ||
    sessionOrigin.protocol !== appOrigin.protocol ||
    sessionOrigin.hostname !== appOrigin.hostname
  ) {
    throw new Error('Gateforge session proxy and app base must share the same loopback HTTP host');
  }
  return { appOrigin: appOrigin.origin, sessionOrigin: sessionOrigin.origin };
}

/** Loopback in the three forms a browser URL can carry it. */
export function isLoopbackHostname(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '::1' || hostname === '[::1]' || /^127\./.test(hostname);
}

/** What the wrapper decided about one call URL. */
export interface ApiRewrite {
  /** The URL to hand the underlying context (raw for non-app origins). */
  url: string;
  /** True when the call was rehosted onto the session proxy. */
  routed: boolean;
  /**
   * For a non-app origin that is still plausibly the app (the app base's
   * own host or loopback): the origin, for the unrouted-origin report.
   * Null for the app origin itself and for foreign origins.
   */
  mismatchedOrigin: string | null;
}

/**
 * Resolves one call URL against the context base URL (or the app origin
 * when none is known) and rehosts it when it carries the app origin.
 * Non-app URLs come back RAW so the underlying context's own base URL
 * semantics keep applying to relative foreign paths.
 *
 * Args:
 *   rawUrl: the URL exactly as the test passed it.
 *   baseURL: the context's base URL (project `use.baseURL`), if known.
 *   routing: the validated session routing.
 *
 * Returns:
 *   ApiRewrite: the URL to send, the routing verdict, and any mismatch.
 */
export function rewriteApiUrl(rawUrl: string, baseURL: string | undefined, routing: SessionApiRouting): ApiRewrite {
  if (routing.appOrigin === routing.sessionOrigin) {
    return { url: rawUrl, routed: false, mismatchedOrigin: null };
  }
  const resolved = new URL(rawUrl, baseURL ?? routing.appOrigin);
  if (resolved.origin === routing.appOrigin) {
    const rehosted = new URL(resolved.href);
    rehosted.host = new URL(routing.sessionOrigin).host;
    return { url: rehosted.href, routed: true, mismatchedOrigin: null };
  }
  const mismatched =
    resolved.hostname === new URL(routing.appOrigin).hostname || isLoopbackHostname(resolved.hostname)
      ? resolved.origin
      : null;
  return { url: rawUrl, routed: false, mismatchedOrigin: mismatched };
}

/**
 * A lazily-resolved routing source. Null sends every call straight to
 * the app — that is setup traffic (module scope, worker hooks) or a
 * session-less test, which the witness never credits.
 */
export type ApiRoutingSource = () => Promise<SessionApiRouting | null>;

export interface WrapApiRequestContextOptions {
  /** Resolves relative call URLs when no better base URL is known. */
  baseURL?: string;
  routing: ApiRoutingSource;
  onUnroutedOrigin?: (origin: string) => void;
}

type ApiVerbOptions = Parameters<APIRequestContext['get']>[1];

/**
 * Wraps an APIRequestContext so app-origin calls ride the session proxy.
 * All arguments are passed through untouched; only the URL can change.
 *
 * Args:
 *   underlying: the real context (the built-in `request` fixture, the
 *     page context's request, or a fresh `request.newContext()`).
 *   options: base URL for relative resolution, the routing source, and
 *     the optional unrouted-origin reporter.
 *
 * Returns:
 *   APIRequestContext: the explicitly wrapped context.
 */
export function wrapApiRequestContext(
  underlying: APIRequestContext,
  options: WrapApiRequestContextOptions,
): APIRequestContext {
  const routed = async <O>(
    target: string | Parameters<APIRequestContext['fetch']>[0],
    verbOptions: O,
    call: (target: string | Parameters<APIRequestContext['fetch']>[0], verbOptions: O) => Promise<APIResponse>,
  ): Promise<APIResponse> => {
    const routing = await options.routing();
    if (routing === null || typeof target !== 'string') return call(target, verbOptions);
    const rewrite = rewriteApiUrl(target, options.baseURL, routing);
    if (!rewrite.routed) {
      if (rewrite.mismatchedOrigin !== null && options.onUnroutedOrigin !== undefined) {
        options.onUnroutedOrigin(rewrite.mismatchedOrigin);
      }
      return call(target, verbOptions);
    }
    return call(rewrite.url, verbOptions);
  };
  const stringCall = (call: (url: string, verbOptions: ApiVerbOptions) => Promise<APIResponse>) =>
    async (url: string, verbOptions: ApiVerbOptions): Promise<APIResponse> =>
      routed(url, verbOptions, (target, passed) => call(target as string, passed));
  return {
    fetch: (urlOrRequest, verbOptions) =>
      routed(urlOrRequest, verbOptions, (target, passed) => underlying.fetch(target, passed)),
    get: stringCall((url, verbOptions) => underlying.get(url, verbOptions)),
    post: stringCall((url, verbOptions) => underlying.post(url, verbOptions)),
    put: stringCall((url, verbOptions) => underlying.put(url, verbOptions)),
    patch: stringCall((url, verbOptions) => underlying.patch(url, verbOptions)),
    delete: stringCall((url, verbOptions) => underlying.delete(url, verbOptions)),
    head: stringCall((url, verbOptions) => underlying.head(url, verbOptions)),
    dispose: (verbOptions) => underlying.dispose(verbOptions),
    storageState: (verbOptions) => underlying.storageState(verbOptions),
    [Symbol.asyncDispose]: () => underlying.dispose(),
  };
}
/** A hook-scope call observed outside the session proxy (diagnostic only). */
export interface DirectExchange {
  method: string;
  url: string;
  status: number;
}

export interface WrapDirectRequestContextOptions {
  baseURL?: string;
  onExchange: (exchange: DirectExchange) => void;
}

/**
 * Reports direct app-origin API calls made by test contexts. Reporting is
 * best-effort and cannot change the underlying response.
 */
export function wrapDirectRequestContext(
  underlying: APIRequestContext,
  options: WrapDirectRequestContextOptions,
): APIRequestContext {
  const invoke = async (
    method: string,
    target: string,
    call: () => Promise<APIResponse>,
  ): Promise<APIResponse> => {
    const response = await call();
    try {
      const resolved = options.baseURL === undefined ? new URL(target) : new URL(target, options.baseURL);
      const appOrigin = options.baseURL === undefined ? null : new URL(options.baseURL).origin;
      if (
        (resolved.protocol === 'http:' || resolved.protocol === 'https:') &&
        (appOrigin === null ? isLoopbackHostname(resolved.hostname) : resolved.origin === appOrigin)
      ) {
        options.onExchange({ method, url: resolved.href, status: response.status() });
      }
    } catch {
      // A URL that cannot be resolved is not useful for diagnosis.
    }
    return response;
  };
  const wrapped = {
    fetch: (url: Parameters<APIRequestContext['fetch']>[0], verbOptions: ApiVerbOptions) =>
      typeof url === 'string'
        ? invoke('GET', url, () => underlying.fetch(url, verbOptions))
        : underlying.fetch(url, verbOptions),
    get: (url: string, verbOptions: ApiVerbOptions) => invoke('GET', url, () => underlying.get(url, verbOptions)),
    post: (url: string, verbOptions: ApiVerbOptions) => invoke('POST', url, () => underlying.post(url, verbOptions)),
    put: (url: string, verbOptions: ApiVerbOptions) => invoke('PUT', url, () => underlying.put(url, verbOptions)),
    patch: (url: string, verbOptions: ApiVerbOptions) => invoke('PATCH', url, () => underlying.patch(url, verbOptions)),
    delete: (url: string, verbOptions: ApiVerbOptions) => invoke('DELETE', url, () => underlying.delete(url, verbOptions)),
    head: (url: string, verbOptions: ApiVerbOptions) => invoke('HEAD', url, () => underlying.head(url, verbOptions)),
    dispose: (verbOptions: Parameters<APIRequestContext['dispose']>[0]) => underlying.dispose(verbOptions),
    storageState: (verbOptions: Parameters<APIRequestContext['storageState']>[0]) => underlying.storageState(verbOptions),
    [Symbol.asyncDispose]: () => underlying.dispose(),
  };
  return wrapped as APIRequestContext;
}


