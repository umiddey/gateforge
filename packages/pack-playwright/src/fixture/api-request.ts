/**
 * Request-fixture and `request.newContext()` calls go directly to the app
 * and are reported only as run-scoped diagnostics; they never pass through
 * the session proxy or satisfy E2E claims. `page.request` and
 * `context.request` stay untouched because Playwright's `Route.fetch` uses
 * the context request internally to forward browser traffic.
 */
import type { APIRequestContext, APIResponse } from 'playwright';

type ApiVerbOptions = Parameters<APIRequestContext['get']>[1];

function isLoopbackHostname(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '::1' || hostname === '[::1]' || /^127\./.test(hostname);
}

/** An app-origin API call made directly from a test-code request context. */
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



