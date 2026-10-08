/**
 * The witnessed API request channel (unit): URL rewriting and the
 * explicit APIRequestContext wrapper. The witnessed e2e lives in
 * packages/cli/test/api-request-e2e.test.ts.
 */
import { describe, expect, it } from 'vitest';
import type { APIRequestContext, APIResponse } from 'playwright';
import {
  rewriteApiUrl,
  sessionApiRouting,
  wrapApiRequestContext,
  wrapDirectRequestContext,
  type SessionApiRouting,
} from '../src/fixture/api-request.js';

const APP = 'http://localhost:13001';
const PROXY = 'http://localhost:14001';
const routing: SessionApiRouting = sessionApiRouting(APP, PROXY);

describe('sessionApiRouting — the alignment rule the page channel already enforces', () => {
  it('accepts same-host http origins and rejects anything else', () => {
    expect(sessionApiRouting(APP, PROXY)).toEqual({ appOrigin: APP, sessionOrigin: PROXY });
    expect(() => sessionApiRouting('https://localhost:13001', PROXY)).toThrow(/share the same loopback HTTP host/);
    expect(() => sessionApiRouting(APP, 'http://127.0.0.9:14001')).toThrow(/share the same loopback HTTP host/);
  });
});

describe('rewriteApiUrl — app-origin calls rehost onto the session proxy', () => {
  it('rehosts an absolute app URL keeping path and query', () => {
    expect(rewriteApiUrl(`${APP}/api/items?limit=5`, undefined, routing)).toEqual({
      url: `${PROXY}/api/items?limit=5`,
      routed: true,
      mismatchedOrigin: null,
    });
  });

  it('rehosts a relative URL resolved against the context base URL', () => {
    expect(rewriteApiUrl('/api/items?limit=5', APP, routing)).toEqual({
      url: `${PROXY}/api/items?limit=5`,
      routed: true,
      mismatchedOrigin: null,
    });
  });

  it('resolves a relative URL against the app origin when no base URL exists', () => {
    expect(rewriteApiUrl('/api/items', undefined, routing)).toEqual({
      url: `${PROXY}/api/items`,
      routed: true,
      mismatchedOrigin: null,
    });
  });

  it('passes a foreign origin through untouched without a mismatch report', () => {
    expect(rewriteApiUrl('https://cdn.example.com/v1/data', APP, routing)).toEqual({
      url: 'https://cdn.example.com/v1/data',
      routed: false,
      mismatchedOrigin: null,
    });
  });

  it('reports a same-host other-port origin as a mismatch but leaves the URL raw', () => {
    expect(rewriteApiUrl('http://localhost:9999/api/items', APP, routing)).toEqual({
      url: 'http://localhost:9999/api/items',
      routed: false,
      mismatchedOrigin: 'http://localhost:9999',
    });
  });

  it('reports a loopback origin as a mismatch but leaves the URL raw', () => {
    expect(rewriteApiUrl('http://127.0.0.5:2/api/items', APP, routing)).toEqual({
      url: 'http://127.0.0.5:2/api/items',
      routed: false,
      mismatchedOrigin: 'http://127.0.0.5:2',
    });
  });
});

describe('wrapApiRequestContext — the explicit wrapper', () => {
  /** A recording stand-in for the underlying context. */
  function fakeContext(): { context: APIRequestContext; called: Array<{ url: string; options: unknown }> } {
    const called: Array<{ url: string; options: unknown }> = [];
    const respond = (): APIResponse => ({ status: () => 200 }) as APIResponse;
    const context = {
      fetch: (url: string, options?: unknown) => { called.push({ url, options }); return Promise.resolve(respond()); },
      get: (url: string, options?: unknown) => { called.push({ url, options }); return Promise.resolve(respond()); },
      post: (url: string, options?: unknown) => { called.push({ url, options }); return Promise.resolve(respond()); },
      put: (url: string, options?: unknown) => { called.push({ url, options }); return Promise.resolve(respond()); },
      patch: (url: string, options?: unknown) => { called.push({ url, options }); return Promise.resolve(respond()); },
      delete: (url: string, options?: unknown) => { called.push({ url, options }); return Promise.resolve(respond()); },
      head: (url: string, options?: unknown) => { called.push({ url, options }); return Promise.resolve(respond()); },
      dispose: () => Promise.resolve(),
      storageState: () => Promise.resolve({ cookies: [], origins: [] }),
    } as unknown as APIRequestContext;
    return { context, called };
  }

  it('rehosts app-origin calls and keeps the options object untouched', async () => {
    const { context, called } = fakeContext();
    const witnessed = wrapApiRequestContext(context, {
      baseURL: APP,
      routing: async () => routing,
    });
    const options = { headers: { 'x-trace': 't-1' }, data: { limit: 5 } };
    const response = await witnessed.post('/api/items', options);
    expect(response.status()).toBe(200);
    expect(called).toEqual([{ url: `${PROXY}/api/items`, options }]);
  });

  it('passes foreign calls through raw and reports same-host mismatches', async () => {
    const { context, called } = fakeContext();
    const reported: string[] = [];
    const witnessed = wrapApiRequestContext(context, {
      baseURL: APP,
      routing: async () => routing,
      onUnroutedOrigin: (origin) => reported.push(origin),
    });
    await witnessed.get('https://cdn.example.com/v1/data');
    await witnessed.get('http://localhost:9999/api/items');
    expect(called.map((call) => call.url)).toEqual([
      'https://cdn.example.com/v1/data',
      'http://localhost:9999/api/items',
    ]);
    expect(reported).toEqual(['http://localhost:9999']);
  });

  it('sends every call to the app untouched when there is no session', async () => {
    const { context, called } = fakeContext();
    const witnessed = wrapApiRequestContext(context, {
      baseURL: APP,
      routing: async () => null,
    });
    await witnessed.get('/api/items');
    expect(called).toEqual([{ url: '/api/items', options: undefined }]);
  });
});

describe('wrapDirectRequestContext — the direct API diagnostic wrapper', () => {
  /** A recording stand-in whose every verb answers `status`. */
  function fakeStatusContext(status: number): {
    context: APIRequestContext;
    called: Array<{ url: string }>;
  } {
    const called: Array<{ url: string }> = [];
    const respond = (): APIResponse => ({ status: () => status }) as APIResponse;
    const call = (url: string): { url: string } => {
      called.push({ url });
      return { url };
    };
    const context = {
      fetch: (url: string) => Promise.resolve(respond()),
      get: (url: string) => {
        call(url);
        return Promise.resolve(respond());
      },
      post: (url: string) => {
        call(url);
        return Promise.resolve(respond());
      },
      put: (url: string) => {
        call(url);
        return Promise.resolve(respond());
      },
      patch: (url: string) => {
        call(url);
        return Promise.resolve(respond());
      },
      delete: (url: string) => {
        call(url);
        return Promise.resolve(respond());
      },
      head: (url: string) => {
        call(url);
        return Promise.resolve(respond());
      },
      dispose: () => Promise.resolve(),
      storageState: () => Promise.resolve({ cookies: [], origins: [] }),
    } as unknown as APIRequestContext;
    return { context, called };
  }

  it('reports every call with its resolved URL and the response status', async () => {
    const { context } = fakeStatusContext(200);
    const seen: Array<{ method: string; url: string; status: number }> = [];
    const wrapped = wrapDirectRequestContext(context, {
      baseURL: APP,
      onExchange: (exchange) => seen.push(exchange),
    });
    await wrapped.get('/api/items/77');
    await wrapped.post(`${APP}/api/items`, { data: { limit: 5 } });
    expect(seen).toEqual([
      { method: 'GET', url: `${APP}/api/items/77`, status: 200 },
      { method: 'POST', url: `${APP}/api/items`, status: 200 },
    ]);
  });

  it('keeps the call answer untouched even when the reporter throws', async () => {
    const { context } = fakeStatusContext(404);
    const wrapped = wrapDirectRequestContext(context, {
      baseURL: APP,
      onExchange: () => {
        throw new Error('reporter exploded');
      },
    });
    const response = await wrapped.delete('/api/items/77');
    expect(response.status()).toBe(404);
  });

  it('reports non-2xx statuses too — the diagnosis names where the call went', async () => {
    const { context } = fakeStatusContext(500);
    const seen: Array<{ method: string; url: string; status: number }> = [];
    const wrapped = wrapDirectRequestContext(context, {
      onExchange: (exchange) => seen.push(exchange),
    });
    await wrapped.get('http://localhost:13001/api/items');
    expect(seen).toEqual([{ method: 'GET', url: 'http://localhost:13001/api/items', status: 500 }]);
  });
});
