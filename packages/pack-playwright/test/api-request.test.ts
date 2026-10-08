/**
 * Direct API-context calls stay outside the session proxy and are
 * recorded only as diagnostics. The CLI integration lives in
 * packages/cli/test/api-request-e2e.test.ts.
 */
import { describe, expect, it } from 'vitest';
import type { APIRequestContext, APIResponse } from 'playwright';
import { wrapDirectRequestContext } from '../src/fixture/api-request.js';

const APP = 'http://localhost:13001';
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
