/**
 * Test-owned API contexts use the current session proxy, marked test-code.
 * This yields witness-observed ledger traffic, never UI claim evidence.
 * page.request/context.request are deliberately untouched: Route.fetch uses
 * those contexts internally to forward genuine browser traffic.
 */
import type { APIRequestContext, APIResponse } from 'playwright';

type FetchOptions = NonNullable<Parameters<APIRequestContext['fetch']>[1]>;

export interface WrapRequestContextOptions {
  baseURL?: string;
  appBaseURL?: string;
  maxRedirects?: number;
  /** Null means no current test owns the call (module/worker setup). */
  sessionProxyUrl: () => Promise<string | null>;
}

/** Rehosts only app-origin calls, preserving Playwright's response objects. */
export function wrapRequestContext(
  underlying: APIRequestContext,
  options: WrapRequestContextOptions,
): APIRequestContext {
  const appBase = options.appBaseURL ?? options.baseURL;
  const appOrigin = appBase === undefined ? null : new URL(appBase).origin;
  const isApp = (candidate: URL): boolean => {
    if (candidate.protocol !== 'http:' && candidate.protocol !== 'https:') return false;
    if (appOrigin !== null) return candidate.origin === appOrigin;
    return candidate.hostname === 'localhost' || candidate.hostname === '[::1]' || /^127\./.test(candidate.hostname);
  };
  const invoke = async (
    target: Parameters<APIRequestContext['fetch']>[0],
    callOptions: FetchOptions = {},
  ): Promise<APIResponse> => {
    const originalUrl = typeof target === 'string' ? target : target.url();
    let url: URL;
    try {
      url = new URL(originalUrl, options.baseURL);
    } catch {
      return underlying.fetch(target, callOptions);
    }
    if (!isApp(url)) return underlying.fetch(target, callOptions);
    const proxyUrl = await options.sessionProxyUrl();
    if (proxyUrl === null) return underlying.fetch(target, callOptions);
    const proxy = new URL(proxyUrl);
    let requestOptions: FetchOptions = { ...callOptions };
    if (typeof target !== 'string') {
      requestOptions.method ??= target.method();
      requestOptions.headers ??= target.headers();
      if (requestOptions.data === undefined && requestOptions.form === undefined && requestOptions.multipart === undefined) {
        const body = target.postDataBuffer();
        if (body !== null) requestOptions.data = body;
      }
    }
    const maxRedirects = requestOptions.maxRedirects ?? options.maxRedirects ?? 20;
    if (maxRedirects < 0) throw new Error("'maxRedirects' must be greater than or equal to '0'");
    // Follow redirects against the ORIGINAL origin, rehosting each app hop.
    // Leaving this to Playwright would send absolute app redirects directly,
    // outside the session proxy. maxRedirects:0 still returns the original
    // 3xx response and Location header unchanged.
    for (let redirects = 0; ; redirects++) {
      const routed = isApp(url);
      const destination = new URL(url);
      const headers = { ...requestOptions.headers };
      if (routed) {
        for (const name of Object.keys(headers)) {
          if (name.toLowerCase() === 'x-gateforge-initiator') delete headers[name];
        }
        destination.protocol = proxy.protocol;
        destination.host = proxy.host;
        headers['x-gateforge-initiator'] = 'test-code';
      }
      const response = await underlying.fetch(destination.href, {
        ...requestOptions, headers, maxRedirects: 0,
      });
      const status = response.status();
      const location = response.headers()['location'];
      if (
        maxRedirects === 0 ||
        (status !== 301 && status !== 302 && status !== 303 && status !== 307 && status !== 308) ||
        !location
      ) return response;
      if (redirects === maxRedirects) {
        await response.dispose();
        throw new Error('Max redirect count exceeded');
      }
      const method = (requestOptions.method ?? 'GET').toUpperCase();
      if (((status === 301 || status === 302) && method === 'POST') || (status === 303 && method !== 'GET' && method !== 'HEAD')) {
        requestOptions = { ...requestOptions, method: 'GET', headers: { ...requestOptions.headers } };
        delete requestOptions.data;
        delete requestOptions.form;
        delete requestOptions.multipart;
        for (const name of Object.keys(requestOptions.headers!)) {
          if (/^content-(?:encoding|language|length|location|type)$/i.test(name)) delete requestOptions.headers![name];
        }
      }
      delete requestOptions.params;
      url = new URL(location, url);
      await response.dispose();
    }
  };
  return {
    fetch: invoke,
    get: (url, callOptions) => invoke(url, { ...callOptions, method: 'GET' }),
    post: (url, callOptions) => invoke(url, { ...callOptions, method: 'POST' }),
    put: (url, callOptions) => invoke(url, { ...callOptions, method: 'PUT' }),
    patch: (url, callOptions) => invoke(url, { ...callOptions, method: 'PATCH' }),
    delete: (url, callOptions) => invoke(url, { ...callOptions, method: 'DELETE' }),
    head: (url, callOptions) => invoke(url, { ...callOptions, method: 'HEAD' }),
    dispose: (disposeOptions) => underlying.dispose(disposeOptions),
    storageState: (stateOptions) => underlying.storageState(stateOptions),
    [Symbol.asyncDispose]: () => underlying[Symbol.asyncDispose](),
  };
}
