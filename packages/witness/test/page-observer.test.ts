import { createServer } from 'node:http';
import { createServer as createTcpServer } from 'node:net';
import { once } from 'node:events';
import { chromium } from 'playwright';
import { afterEach, describe, expect, it } from 'vitest';
import { observePageBrowser } from '../src/witness/page-observer.js';
import { PAGE_OBSERVER_FLUSH_TIMEOUT_MS } from '../src/constants.js';
import type { ObservedPageVisit, PageVisitVerdict } from '../src/witness/page-observation.js';

const html = `<!doctype html><html><body><main id="app"></main><script>
const p = location.pathname;
async function render() {
  if (p === '/secret') { history.replaceState({}, '', '/login'); document.querySelector('#app').textContent = 'Login'; return; }
  if (p === '/login') { document.querySelector('#app').textContent = 'Login'; return; }
  if (p === '/crash') { setTimeout(() => { throw new Error('render crashed'); }, 0); return; }
  if (p === '/broken') { document.querySelector('#app').textContent = 'Something went wrong'; return; }
  const api = p === '/bad' ? '/api/bad' : p === '/local' ? '/api/local' : p === '/unproxied' ? '/api/unproxied' : '/api/orders';
  const response = await fetch(api);
  document.querySelector('#app').textContent = 'Orders ' + response.status;
}
render();
</script></body></html>`;

// The real SPA cancel shape: fire a data fetch, cancel it client-side with
// an AbortController, then (optionally) re-issue the same request. The 50ms
// delay before the abort is deliberate real time INSIDE THE PAGE: fake
// timers in the test process cannot drive the page's JS or the browser's
// network stack, and the abort must land after Chromium actually dispatched
// the request (rule exception, same rationale as the server delays above).
const cancelHtml = `<!doctype html><html><body><main id="app"></main><script>
(async () => {
  const p = location.pathname;
  const controller = new AbortController();
  fetch(p === '/cancelquery' ? '/api/x?a=1' : '/api/x', { signal: controller.signal }).catch(() => {});
  setTimeout(() => {
    controller.abort();
    if (p === '/cancelonly') return;
    fetch(p === '/cancelquery' ? '/api/x?a=2' : '/api/x').then((response) => { document.querySelector('#app').textContent = 'Data ' + String(response.status); }).catch(() => {});
  }, 50);
})().catch(() => {});
</script></body></html>`;

async function freePort(): Promise<number> {
  const server = createTcpServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('TCP server did not bind');
  const { port } = address;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

describe('real CDP page observer', () => {
  let stop: (() => Promise<void>) | undefined;
  afterEach(async () => stop?.());

  it('settles navigation, exceptions, DOM markers, API status and locally fulfilled responses', async () => {
    const app = createServer((request, response) => {
      if (request.url === '/api/bad') { response.writeHead(500); response.end('bad'); return; }
      if (request.url?.startsWith('/api/')) { response.writeHead(200); response.end('{}'); return; }
      response.writeHead(200, { 'content-type': 'text/html' }); response.end(html);
    });
    app.listen(0, '127.0.0.1');
    await once(app, 'listening');
    const appAddress = app.address();
    if (appAddress === null || typeof appAddress === 'string') throw new Error('app server did not bind');
    const appOrigin = `http://127.0.0.1:${appAddress.port}`;
    const debugPort = await freePort();
    const browser = await chromium.launch({ args: [`--remote-debugging-port=${debugPort}`] });
    stop = async () => { await browser.close(); await new Promise<void>((resolve) => app.close(() => resolve())); };
    const visits: Array<{ url: string; observed: ObservedPageVisit; verdict: PageVisitVerdict }> = [];
    const observer = await observePageBrowser({
      debuggingPort: debugPort,
      pages: [
        { id: 'tenant.page-orders', path: '/orders/:id' },
        { id: 'tenant.page-bad', path: '/bad' },
        { id: 'tenant.page-crash', path: '/crash' },
        { id: 'tenant.page-broken', path: '/broken' },
        { id: 'tenant.page-local', path: '/local' },
        { id: 'tenant.page-unproxied', path: '/unproxied' },
      ],
      loginRoutes: ['/login'],
      errorMarkers: ['Something went wrong'],
      appOrigins: [appOrigin],
      isProxiedExchange: (url) => !['/api/local', '/api/unproxied'].includes(new URL(url).pathname),
      quietMs: 300,
      onVisit: (visit, verdict) => {
        visits.push({ url: new URL(visit.url).pathname, observed: visit, verdict });
      },
    });
    const context = await browser.newContext();
    const page = await context.newPage();
    const expectVisit = async (path: string) => {
      const count = visits.length;
      await page.goto(`${appOrigin}${path}`);
      await expect.poll(() => visits.length > count, { timeout: 5_000 }).toBe(true);
      return visits[visits.length - 1]!;
    };

    try {
      expect((await expectVisit('/orders/42')).verdict.loads.satisfied).toBe(true);
      expect((await expectVisit('/secret')).verdict.loads.refusalReasons).toContain('PAGE_BOUNCED_TO_LOGIN');
      expect((await expectVisit('/crash')).verdict.loads.refusalReasons).toContain('PAGE_UNCAUGHT_EXCEPTION');
      expect((await expectVisit('/broken')).verdict.loads.refusalReasons).toContain('PAGE_ERROR_MARKER');
      expect((await expectVisit('/bad')).verdict.dataOk.refusalReasons).toContain('PAGE_API_ERROR');
      await page.route('**/api/local', (route) => route.fulfill({ status: 200, body: '{}' }));
      const locallyFulfilled = await expectVisit('/local');
      expect(locallyFulfilled.verdict.loads.refusalReasons).toContain('PAGE_LOCALLY_FULFILLED');
      expect(locallyFulfilled.verdict.dataOk.refusalReasons).toContain('PAGE_LOCALLY_FULFILLED');
      expect(locallyFulfilled.observed.apiResponses[0]?.remoteAddress).toBeNull();
      expect(locallyFulfilled.observed.apiResponses[0]?.proxied).toBe(false);

      const unproxied = await expectVisit('/unproxied');
      expect(unproxied.observed.apiResponses[0]?.remoteAddress).not.toBeNull();
      expect(unproxied.observed.apiResponses[0]?.proxied).toBe(false);
      expect(unproxied.verdict.loads.refusalReasons).toContain('PAGE_LOCALLY_FULFILLED');
      expect(unproxied.verdict.dataOk.refusalReasons).toContain('PAGE_LOCALLY_FULFILLED');
    } finally {

      await observer.close();
      stop = async () => { await browser.close(); await new Promise<void>((resolve) => app.close(() => resolve())); };
      await context.close();
    }
  });

  it('waits for a delayed API 500 beyond the quiet window before emitting', async () => {
    // Real wall-clock delay: the 500 must land AFTER the observer's real
    // quiet window against real Chromium; fake timers cannot drive the
    // browser's network stack (rule exception, named here).
    const app = createServer((request, response) => {
      if (request.url === '/api/data') {
        setTimeout(() => {
          response.writeHead(500, { 'content-type': 'application/json' });
          response.end('{"error":"server error"}');
        }, 1_200);
        return;
      }
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end('<!doctype html><html><body><main id="app"></main><script>fetch("/api/data").catch(() => {});</script></body></html>');
    });
    app.listen(0, '127.0.0.1');
    await once(app, 'listening');
    const appAddress = app.address();
    if (appAddress === null || typeof appAddress === 'string') throw new Error('app server did not bind');
    const appOrigin = `http://127.0.0.1:${appAddress.port}`;
    const debugPort = await freePort();
    const browser = await chromium.launch({ args: [`--remote-debugging-port=${debugPort}`] });
    stop = async () => { await browser.close(); await new Promise<void>((resolve) => app.close(() => resolve())); };
    const visits: Array<{ observed: ObservedPageVisit; verdict: PageVisitVerdict }> = [];
    const observer = await observePageBrowser({
      debuggingPort: debugPort,
      pages: [{ id: 'tenant.page-orders', path: '/orders' }],
      loginRoutes: ['/login'],
      errorMarkers: [],
      appOrigins: [appOrigin],
      isProxiedExchange: (url) => new URL(url).pathname === '/api/data',
      quietMs: 300,
      onVisit: (observed, verdict) => {
        visits.push({ observed, verdict });
      },
    });
    try {
      const page = await browser.newPage();
      await page.goto(`${appOrigin}/orders`);
      // Exactly ONE emission, carrying the late 500 — never a clean record
      // while the request was in flight.
      await expect.poll(() => visits.length, { timeout: 5_000 }).toBe(1);
      expect(visits[0]!.observed.apiResponses.map(({ status }) => status)).toEqual([500]);
      expect(visits[0]!.observed.apiRequestsSettled).toBe(true);
      expect(visits[0]!.verdict.loads.satisfied).toBe(true);
      expect(visits[0]!.verdict.dataOk.satisfied).toBe(false);
      expect(visits[0]!.verdict.dataOk.refusalReasons).toContain('PAGE_API_ERROR');
    } finally {
      await observer.close();
    }
  });

  it('does not falsely refuse a delayed API 200', async () => {
    // Real wall-clock delay: same rationale as the delayed-500 regression.
    const app = createServer((request, response) => {
      if (request.url === '/api/data') {
        setTimeout(() => { response.writeHead(200); response.end('{}'); }, 1_200);
        return;
      }
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end('<!doctype html><html><body><main id="app"></main><script>fetch("/api/data").catch(() => {});</script></body></html>');
    });
    app.listen(0, '127.0.0.1');
    await once(app, 'listening');
    const appAddress = app.address();
    if (appAddress === null || typeof appAddress === 'string') throw new Error('app server did not bind');
    const appOrigin = `http://127.0.0.1:${appAddress.port}`;
    const debugPort = await freePort();
    const browser = await chromium.launch({ args: [`--remote-debugging-port=${debugPort}`] });
    stop = async () => { await browser.close(); await new Promise<void>((resolve) => app.close(() => resolve())); };
    const visits: Array<{ observed: ObservedPageVisit; verdict: PageVisitVerdict }> = [];
    const observer = await observePageBrowser({
      debuggingPort: debugPort,
      pages: [{ id: 'tenant.page-orders', path: '/orders' }],
      loginRoutes: ['/login'],
      errorMarkers: [],
      appOrigins: [appOrigin],
      isProxiedExchange: (url) => new URL(url).pathname === '/api/data',
      quietMs: 300,
      onVisit: (observed, verdict) => {
        visits.push({ observed, verdict });
      },
    });
    try {
      const page = await browser.newPage();
      await page.goto(`${appOrigin}/orders`);
      await expect.poll(() => visits.length, { timeout: 5_000 }).toBe(1);
      expect(visits[0]!.observed.apiResponses.map(({ status }) => status)).toEqual([200]);
      expect(visits[0]!.observed.apiRequestsSettled).toBe(true);
      expect(visits[0]!.verdict.loads.satisfied).toBe(true);
      expect(visits[0]!.verdict.dataOk.satisfied).toBe(true);
    } finally {
      await observer.close();
    }
  });

  it('accepts a 401 on an anonymous page and refuses a login audience page', async () => {
    // Real wall-clock quiet window against real Chromium; fake timers cannot
    // drive the browser's network stack (rule exception, named here).
    const app = createServer((request, response) => {
      if (request.url === '/api/me') { response.writeHead(401, { 'content-type': 'application/json' }); response.end('{"error":"not logged in"}'); return; }
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end('<!doctype html><html><body><main id="app"></main><script>fetch("/api/me").catch(() => {});</script></body></html>');
    });
    app.listen(0, '127.0.0.1');
    await once(app, 'listening');
    const appAddress = app.address();
    if (appAddress === null || typeof appAddress === 'string') throw new Error('app server did not bind');
    const appOrigin = `http://127.0.0.1:${appAddress.port}`;
    const debugPort = await freePort();
    const browser = await chromium.launch({ args: [`--remote-debugging-port=${debugPort}`] });
    stop = async () => { await browser.close(); await new Promise<void>((resolve) => app.close(() => resolve())); };
    const visits: Array<{ url: string; observed: ObservedPageVisit; verdict: PageVisitVerdict }> = [];
    const observer = await observePageBrowser({
      debuggingPort: debugPort,
      pages: [
        { id: 'global.page-terms', path: '/terms', anonymous: true },
        { id: 'tenant.page-member', path: '/member' },
      ],
      loginRoutes: [],
      errorMarkers: [],
      appOrigins: [appOrigin],
      isProxiedExchange: (url) => new URL(url).pathname === '/api/me',
      quietMs: 300,
      onVisit: (observed, verdict) => {
        visits.push({ url: new URL(observed.url).pathname, observed, verdict });
      },
    });
    try {
      const page = await browser.newPage();
      const expectVisit = async (path: string) => {
        const count = visits.length;
        await page.goto(`${appOrigin}${path}`);
        await expect.poll(() => visits.length > count, { timeout: 5_000 }).toBe(true);
        return visits[visits.length - 1]!;
      };
      // Observed channel: the visit resolves to its page from the
      // controller table, so the flag comes from the RESOLVED page.
      const anonymous = await expectVisit('/terms');
      expect(anonymous.verdict.pageId).toBe('global.page-terms');
      expect(anonymous.verdict.dataOk.satisfied).toBe(true);
      expect(anonymous.verdict.dataOk.refusalReasons).toEqual([]);
      const refused = await expectVisit('/member');
      expect(refused.verdict.pageId).toBe('tenant.page-member');
      expect(refused.verdict.dataOk.satisfied).toBe(false);
      expect(refused.verdict.dataOk.refusalReasons).toEqual(['PAGE_API_ERROR']);
    } finally {
      await observer.close();
    }
  });

  it('refuses a delayed 500 on a non-/api fetch as an API error too', async () => {
    // Real wall-clock delay: same rationale as the delayed-500 regression.
    // The fetch URL carries no /api/ prefix — classification must come from
    // the request resource type.
    const app = createServer((request, response) => {
      if (request.url === '/data') {
        setTimeout(() => { response.writeHead(500); response.end('{}'); }, 1_200);
        return;
      }
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end('<!doctype html><html><body><main id="app"></main><script>fetch("/data").catch(() => {});</script></body></html>');
    });
    app.listen(0, '127.0.0.1');
    await once(app, 'listening');
    const appAddress = app.address();
    if (appAddress === null || typeof appAddress === 'string') throw new Error('app server did not bind');
    const appOrigin = `http://127.0.0.1:${appAddress.port}`;
    const debugPort = await freePort();
    const browser = await chromium.launch({ args: [`--remote-debugging-port=${debugPort}`] });
    stop = async () => { await browser.close(); await new Promise<void>((resolve) => app.close(() => resolve())); };
    const visits: Array<{ observed: ObservedPageVisit; verdict: PageVisitVerdict }> = [];
    const observer = await observePageBrowser({
      debuggingPort: debugPort,
      pages: [{ id: 'tenant.page-orders', path: '/orders' }],
      loginRoutes: ['/login'],
      errorMarkers: [],
      appOrigins: [appOrigin],
      isProxiedExchange: (url) => new URL(url).pathname === '/data',
      quietMs: 300,
      onVisit: (observed, verdict) => {
        visits.push({ observed, verdict });
      },
    });
    try {
      const page = await browser.newPage();
      await page.goto(`${appOrigin}/orders`);
      await expect.poll(() => visits.length, { timeout: 5_000 }).toBe(1);
      expect(visits[0]!.observed.apiResponses.map(({ status }) => status)).toEqual([500]);
      expect(visits[0]!.observed.apiRequestsSettled).toBe(true);
      expect(visits[0]!.verdict.loads.satisfied).toBe(true);
      expect(visits[0]!.verdict.dataOk.refusalReasons).toContain('PAGE_API_ERROR');
    } finally {
      await observer.close();
    }
  });

  it('refuses a failed API request as unsettled', async () => {
    const app = createServer((request, response) => {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end('<!doctype html><html><body><main id="app"></main><script>fetch("/api/data").catch(() => {});</script></body></html>');
    });
    app.listen(0, '127.0.0.1');
    await once(app, 'listening');
    const appAddress = app.address();
    if (appAddress === null || typeof appAddress === 'string') throw new Error('app server did not bind');
    const appOrigin = `http://127.0.0.1:${appAddress.port}`;
    const debugPort = await freePort();
    const browser = await chromium.launch({ args: [`--remote-debugging-port=${debugPort}`] });
    stop = async () => { await browser.close(); await new Promise<void>((resolve) => app.close(() => resolve())); };
    const visits: Array<{ observed: ObservedPageVisit; verdict: PageVisitVerdict }> = [];
    const observer = await observePageBrowser({
      debuggingPort: debugPort,
      pages: [{ id: 'tenant.page-orders', path: '/orders' }],
      loginRoutes: ['/login'],
      errorMarkers: [],
      appOrigins: [appOrigin],
      isProxiedExchange: () => true,
      quietMs: 300,
      onVisit: (observed, verdict) => {
        visits.push({ observed, verdict });
      },
    });
    try {
      const page = await browser.newPage();
      await page.route('**/api/data', (route) => route.abort());
      await page.goto(`${appOrigin}/orders`);
      await expect.poll(() => visits.length, { timeout: 5_000 }).toBe(1);
      expect(visits[0]!.observed.apiRequestsSettled).toBe(false);
      expect(visits[0]!.observed.apiResponses).toEqual([]);
      expect(visits[0]!.verdict.loads.refusalReasons).toContain('PAGE_API_UNSETTLED');
      expect(visits[0]!.verdict.dataOk.refusalReasons).toContain('PAGE_API_UNSETTLED');
    } finally {
      await observer.close();
    }
  });

  it('preserves evidence across repeated quiet emissions of the same navigation', async () => {
    const app = createServer((request, response) => {
      if (request.url === '/api/data') { response.writeHead(200); response.end('{}'); return; }
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end(`<!doctype html><html><body><main id="app"></main><script>
fetch("/api/data").catch(() => {});
setTimeout(() => { throw new Error("late crash"); }, 1200);
</script></body></html>`);
    });
    app.listen(0, '127.0.0.1');
    await once(app, 'listening');
    const appAddress = app.address();
    if (appAddress === null || typeof appAddress === 'string') throw new Error('app server did not bind');
    const appOrigin = `http://127.0.0.1:${appAddress.port}`;
    const debugPort = await freePort();
    const browser = await chromium.launch({ args: [`--remote-debugging-port=${debugPort}`] });
    stop = async () => { await browser.close(); await new Promise<void>((resolve) => app.close(() => resolve())); };
    const visits: Array<{ observed: ObservedPageVisit; verdict: PageVisitVerdict }> = [];
    const observer = await observePageBrowser({
      debuggingPort: debugPort,
      pages: [{ id: 'tenant.page-orders', path: '/orders' }],
      loginRoutes: ['/login'],
      errorMarkers: [],
      appOrigins: [appOrigin],
      isProxiedExchange: (url) => new URL(url).pathname === '/api/data',
      quietMs: 300,
      onVisit: (observed, verdict) => {
        visits.push({ observed, verdict });
      },
    });
    try {
      const page = await browser.newPage();
      await page.goto(`${appOrigin}/orders`);
      // First emission is clean and settled; the later page error must be
      // carried by a SECOND emission that PRESERVES the earlier evidence.
      await expect.poll(() => visits.length, { timeout: 5_000 }).toBe(2);
      expect(visits[0]!.observed.exceptions).toEqual([]);
      expect(visits[0]!.observed.apiResponses.map(({ status }) => status)).toEqual([200]);
      expect(visits[0]!.observed.apiRequestsSettled).toBe(true);
      expect(visits[1]!.observed.exceptions).toEqual(['late crash']);
      expect(visits[1]!.observed.apiResponses.map(({ status }) => status)).toEqual([200]);
      expect(visits[1]!.observed.navigations).toEqual([`${appOrigin}/orders`]);
      expect(visits[1]!.verdict.loads.refusalReasons).toContain('PAGE_UNCAUGHT_EXCEPTION');
      expect(visits[1]!.verdict.loads.refusalReasons).not.toContain('PAGE_API_UNSETTLED');
    } finally {
      await observer.close();
    }
  });

  it('starts a fresh observation window at a new navigation without losing the old one', async () => {
    // Real wall-clock delay for the customers 500: same rationale as the
    // delayed-500 regression.
    const app = createServer((request, response) => {
      if (request.url === '/api/orders') { response.writeHead(200); response.end('[]'); return; }
      if (request.url === '/api/customers') {
        setTimeout(() => { response.writeHead(500); response.end('{}'); }, 1_200);
        return;
      }
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end(`<!doctype html><html><body><main id="app"></main><script>
fetch(location.pathname === "/customers" ? "/api/customers" : "/api/orders").catch(() => {});
</script></body></html>`);
    });
    app.listen(0, '127.0.0.1');
    await once(app, 'listening');
    const appAddress = app.address();
    if (appAddress === null || typeof appAddress === 'string') throw new Error('app server did not bind');
    const appOrigin = `http://127.0.0.1:${appAddress.port}`;
    const debugPort = await freePort();
    const browser = await chromium.launch({ args: [`--remote-debugging-port=${debugPort}`] });
    stop = async () => { await browser.close(); await new Promise<void>((resolve) => app.close(() => resolve())); };
    const visits: Array<{ url: string; observed: ObservedPageVisit; verdict: PageVisitVerdict }> = [];
    const observer = await observePageBrowser({
      debuggingPort: debugPort,
      pages: [{ id: 'tenant.page-orders', path: '/orders' }, { id: 'tenant.page-customers', path: '/customers' }],
      loginRoutes: ['/login'],
      errorMarkers: [],
      appOrigins: [appOrigin],
      isProxiedExchange: (url) => ['/api/orders', '/api/customers'].includes(new URL(url).pathname),
      quietMs: 300,
      onVisit: (observed, verdict) => {
        visits.push({ url: new URL(observed.url).pathname, observed, verdict });
      },
    });
    try {
      const page = await browser.newPage();
      await page.goto(`${appOrigin}/orders`);
      await expect.poll(() => visits.length, { timeout: 5_000 }).toBe(1);
      expect(visits[0]!.url).toBe('/orders');
      expect(visits[0]!.observed.apiResponses.map(({ status }) => status)).toEqual([200]);
      // The genuinely new navigation opens a FRESH window: no historical
      // route retention can attribute the customers visit to orders, and
      // the emitted orders window is not re-issued.
      await page.goto(`${appOrigin}/customers`);
      await expect.poll(() => visits.length, { timeout: 5_000 }).toBe(2);
      expect(visits[1]!.url).toBe('/customers');
      expect(visits[1]!.observed.navigations).toEqual([`${appOrigin}/customers`]);
      expect(visits[1]!.observed.apiResponses.map(({ status }) => status)).toEqual([500]);
      expect(visits[1]!.observed.apiRequestsSettled).toBe(true);
      expect(visits[1]!.verdict.loads.satisfied).toBe(true);
      expect(visits[1]!.verdict.dataOk.refusalReasons).toContain('PAGE_API_ERROR');
    } finally {
      await observer.close();
    }
  });

  it('keeps a 200 whose body completes late settled and satisfying', async () => {
    // Real wall-clock delay: headers flush at once, the body completes only
    // after the quiet window; fake timers cannot drive the browser's
    // network stack (rule exception, named here).
    const app = createServer((request, response) => {
      if (request.url === '/api/body') {
        response.writeHead(200);
        response.flushHeaders();
        setTimeout(() => response.end('{}'), 1_200);
        return;
      }
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end('<!doctype html><html><body><main id="app"></main><script>fetch("/api/body").catch(() => {});</script></body></html>');
    });
    app.listen(0, '127.0.0.1');
    await once(app, 'listening');
    const appAddress = app.address();
    if (appAddress === null || typeof appAddress === 'string') throw new Error('app server did not bind');
    const appOrigin = `http://127.0.0.1:${appAddress.port}`;
    const debugPort = await freePort();
    const browser = await chromium.launch({ args: [`--remote-debugging-port=${debugPort}`] });
    stop = async () => { await browser.close(); await new Promise<void>((resolve) => app.close(() => resolve())); };
    const visits: Array<{ observed: ObservedPageVisit; verdict: PageVisitVerdict }> = [];
    const observer = await observePageBrowser({
      debuggingPort: debugPort,
      pages: [{ id: 'tenant.page-orders', path: '/orders' }],
      loginRoutes: ['/login'],
      errorMarkers: [],
      appOrigins: [appOrigin],
      isProxiedExchange: (url) => new URL(url).pathname === '/api/body',
      quietMs: 300,
      onVisit: (observed, verdict) => {
        visits.push({ observed, verdict });
      },
    });
    try {
      const page = await browser.newPage();
      await page.goto(`${appOrigin}/orders`);
      await expect.poll(() => visits.length, { timeout: 5_000 }).toBe(1);
      expect(visits[0]!.observed.apiResponses.map(({ status }) => status)).toEqual([200]);
      expect(visits[0]!.observed.apiRequestsSettled).toBe(true);
      expect(visits[0]!.verdict.loads.satisfied).toBe(true);
      expect(visits[0]!.verdict.dataOk.satisfied).toBe(true);
    } finally {
      await observer.close();
    }
  });

  it('refuses a 200 whose body never completes as unsettled', async () => {
    // Real wall-clock + real socket teardown: the 200 headers flush at once
    // and the connection dies before the body completes; only the platform
    // can produce this failure shape (rule exception, named here).
    const app = createServer((request, response) => {
      if (request.url === '/api/body') {
        response.writeHead(200);
        response.flushHeaders();
        setTimeout(() => { response.socket?.destroy(); }, 1_200);
        return;
      }
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end('<!doctype html><html><body><main id="app"></main><script>fetch("/api/body").catch(() => {});</script></body></html>');
    });
    app.listen(0, '127.0.0.1');
    await once(app, 'listening');
    const appAddress = app.address();
    if (appAddress === null || typeof appAddress === 'string') throw new Error('app server did not bind');
    const appOrigin = `http://127.0.0.1:${appAddress.port}`;
    const debugPort = await freePort();
    const browser = await chromium.launch({ args: [`--remote-debugging-port=${debugPort}`] });
    stop = async () => { await browser.close(); await new Promise<void>((resolve) => app.close(() => resolve())); };
    const visits: Array<{ observed: ObservedPageVisit; verdict: PageVisitVerdict }> = [];
    const observer = await observePageBrowser({
      debuggingPort: debugPort,
      pages: [{ id: 'tenant.page-orders', path: '/orders' }],
      loginRoutes: ['/login'],
      errorMarkers: [],
      appOrigins: [appOrigin],
      isProxiedExchange: (url) => new URL(url).pathname === '/api/body',
      quietMs: 300,
      onVisit: (observed, verdict) => {
        visits.push({ observed, verdict });
      },
    });
    try {
      const page = await browser.newPage();
      await page.goto(`${appOrigin}/orders`);
      // Headers were collected ([200]) but the request never finished: the
      // observation stays unsettled and can never grade clean.
      await expect.poll(() => visits.length, { timeout: 5_000 }).toBe(1);
      expect(visits[0]!.observed.apiResponses.map(({ status }) => status)).toEqual([200]);
      expect(visits[0]!.observed.apiRequestsSettled).toBe(false);
      expect(visits[0]!.verdict.loads.refusalReasons).toContain('PAGE_API_UNSETTLED');
      expect(visits[0]!.verdict.dataOk.satisfied).toBe(false);
      expect(visits[0]!.verdict.dataOk.refusalReasons).toContain('PAGE_API_UNSETTLED');
    } finally {
      await observer.close();
    }
  });

  it('counts an app-cancelled request settled when a same-URL request completed', async () => {
    // Real page-driven AbortController abort inside Chromium: fake timers
    // cannot drive the page's JS or the browser network stack (rule
    // exception, named at cancelHtml).
    const app = createServer((request, response) => {
      if (request.url === '/api/x') {
        response.writeHead(200);
        response.end('{}');
        return;
      }
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end(cancelHtml);
    });
    app.listen(0, '127.0.0.1');
    await once(app, 'listening');
    const appAddress = app.address();
    if (appAddress === null || typeof appAddress === 'string') throw new Error('app server did not bind');
    const appOrigin = `http://127.0.0.1:${appAddress.port}`;
    const debugPort = await freePort();
    const browser = await chromium.launch({ args: [`--remote-debugging-port=${debugPort}`] });
    stop = async () => { await browser.close(); await new Promise<void>((resolve) => app.close(() => resolve())); };
    const visits: Array<{ observed: ObservedPageVisit; verdict: PageVisitVerdict }> = [];
    const observer = await observePageBrowser({
      debuggingPort: debugPort,
      pages: [{ id: 'tenant.page-cancel', path: '/cancelretry' }],
      loginRoutes: ['/login'],
      errorMarkers: [],
      appOrigins: [appOrigin],
      isProxiedExchange: () => true,
      quietMs: 300,
      onVisit: (observed, verdict) => {
        visits.push({ observed, verdict });
      },
    });
    try {
      const page = await browser.newPage();
      await page.goto(`${appOrigin}/cancelretry`);
      await expect.poll(() => visits.length, { timeout: 5_000 }).toBe(1);
      expect(visits[0]!.observed.apiRequestsSettled).toBe(true);
      // The cancelled request's headers may or may not have been collected
      // before the abort landed; the retry's 200 must be.
      expect(visits[0]!.observed.apiResponses.map(({ status }) => status)).toContain(200);
      expect(visits[0]!.verdict.loads.satisfied).toBe(true);
      expect(visits[0]!.verdict.dataOk.satisfied).toBe(true);
    } finally {
      await observer.close();
    }
  });

  it('refuses an app-cancelled request with no completing retry as unsettled', async () => {
    // Real page-driven AbortController abort inside Chromium: fake timers
    // cannot drive the page's JS or the browser network stack (rule
    // exception, named at cancelHtml).
    const app = createServer((request, response) => {
      if (request.url === '/api/x') {
        response.writeHead(200);
        response.end('{}');
        return;
      }
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end(cancelHtml);
    });
    app.listen(0, '127.0.0.1');
    await once(app, 'listening');
    const appAddress = app.address();
    if (appAddress === null || typeof appAddress === 'string') throw new Error('app server did not bind');
    const appOrigin = `http://127.0.0.1:${appAddress.port}`;
    const debugPort = await freePort();
    const browser = await chromium.launch({ args: [`--remote-debugging-port=${debugPort}`] });
    stop = async () => { await browser.close(); await new Promise<void>((resolve) => app.close(() => resolve())); };
    const visits: Array<{ observed: ObservedPageVisit; verdict: PageVisitVerdict }> = [];
    const observer = await observePageBrowser({
      debuggingPort: debugPort,
      pages: [{ id: 'tenant.page-cancel', path: '/cancelonly' }],
      loginRoutes: ['/login'],
      errorMarkers: [],
      appOrigins: [appOrigin],
      isProxiedExchange: () => true,
      quietMs: 300,
      onVisit: (observed, verdict) => {
        visits.push({ observed, verdict });
      },
    });
    try {
      const page = await browser.newPage();
      await page.goto(`${appOrigin}/cancelonly`);
      await expect.poll(() => visits.length, { timeout: 5_000 }).toBe(1);
      expect(visits[0]!.observed.apiRequestsSettled).toBe(false);
      expect(visits[0]!.verdict.loads.refusalReasons).toContain('PAGE_API_UNSETTLED');
      expect(visits[0]!.verdict.dataOk.refusalReasons).toContain('PAGE_API_UNSETTLED');
    } finally {
      await observer.close();
    }
  });

  it('refuses a cancelled request superseded only by a different URL as unsettled', async () => {
    // Real page-driven AbortController abort inside Chromium: fake timers
    // cannot drive the page's JS or the browser network stack (rule
    // exception, named at cancelHtml).
    const app = createServer((request, response) => {
      if (request.url?.startsWith('/api/x?')) {
        response.writeHead(200);
        response.end('{}');
        return;
      }
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end(cancelHtml);
    });
    app.listen(0, '127.0.0.1');
    await once(app, 'listening');
    const appAddress = app.address();
    if (appAddress === null || typeof appAddress === 'string') throw new Error('app server did not bind');
    const appOrigin = `http://127.0.0.1:${appAddress.port}`;
    const debugPort = await freePort();
    const browser = await chromium.launch({ args: [`--remote-debugging-port=${debugPort}`] });
    stop = async () => { await browser.close(); await new Promise<void>((resolve) => app.close(() => resolve())); };
    const visits: Array<{ observed: ObservedPageVisit; verdict: PageVisitVerdict }> = [];
    const observer = await observePageBrowser({
      debuggingPort: debugPort,
      pages: [{ id: 'tenant.page-cancel', path: '/cancelquery' }],
      loginRoutes: ['/login'],
      errorMarkers: [],
      appOrigins: [appOrigin],
      isProxiedExchange: () => true,
      quietMs: 300,
      onVisit: (observed, verdict) => {
        visits.push({ observed, verdict });
      },
    });
    try {
      const page = await browser.newPage();
      await page.goto(`${appOrigin}/cancelquery`);
      await expect.poll(() => visits.length, { timeout: 5_000 }).toBe(1);
      expect(visits[0]!.observed.apiRequestsSettled).toBe(false);
      // The different-query retry DID complete (its 200 was collected), yet
      // it cannot supersede the cancelled '?a=1' request.
      expect(visits[0]!.observed.apiResponses.map(({ url, status }) => ({ search: new URL(url).search, status }))).toContainEqual({ search: '?a=2', status: 200 });
      expect(visits[0]!.verdict.loads.refusalReasons).toContain('PAGE_API_UNSETTLED');
      expect(visits[0]!.verdict.dataOk.refusalReasons).toContain('PAGE_API_UNSETTLED');
    } finally {
      await observer.close();
    }
  });

  it('settles an unread 401 body once every declared byte arrived', async () => {
    const app = createServer((request, response) => {
      if (request.url === '/api/unread') {
        response.writeHead(401, { 'content-type': 'text/plain' });
        response.end('denied');
        return;
      }
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end('<!doctype html><html><body><main id="app"></main><script>fetch("/api/unread").then((response) => { window.k = response; }).catch(() => {});</script></body></html>');
    });
    app.listen(0, '127.0.0.1');
    await once(app, 'listening');
    const appAddress = app.address();
    if (appAddress === null || typeof appAddress === 'string') throw new Error('app server did not bind');
    const appOrigin = `http://127.0.0.1:${appAddress.port}`;
    const debugPort = await freePort();
    const browser = await chromium.launch({ args: [`--remote-debugging-port=${debugPort}`] });
    stop = async () => { await browser.close(); await new Promise<void>((resolve) => app.close(() => resolve())); };
    const visits: Array<{ observed: ObservedPageVisit; verdict: PageVisitVerdict }> = [];
    const observer = await observePageBrowser({
      debuggingPort: debugPort,
      pages: [{ id: 'tenant.page-orders', path: '/orders' }],
      loginRoutes: ['/login'],
      errorMarkers: [],
      appOrigins: [appOrigin],
      isProxiedExchange: () => true,
      quietMs: 300,
      onVisit: (observed, verdict) => {
        visits.push({ observed, verdict });
      },
    });
    try {
      const page = await browser.newPage();
      await page.goto(`${appOrigin}/orders`);
      // The page retains the response and never reads the body; completion
      // must come from the browser's network events once every declared
      // byte arrived.
      await expect.poll(() => visits.length, { timeout: 5_000 }).toBe(1);
      expect(visits[0]!.observed.apiRequestsSettled).toBe(true);
      expect(visits[0]!.observed.apiResponses.map(({ status }) => status)).toEqual([401]);
      expect(visits[0]!.verdict.loads.satisfied).toBe(true);
      expect(visits[0]!.verdict.dataOk.satisfied).toBe(false);
      // The 401 is still an API error under the < 400 rule — and ONLY that.
      expect(visits[0]!.verdict.dataOk.refusalReasons).toEqual(['PAGE_API_ERROR']);
    } finally {
      await observer.close();
    }
  });

  it('settles an unread 200 body once every declared byte arrived', async () => {
    const app = createServer((request, response) => {
      if (request.url === '/api/unread') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end('{}');
        return;
      }
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end('<!doctype html><html><body><main id="app"></main><script>fetch("/api/unread").then((response) => { window.k = response; }).catch(() => {});</script></body></html>');
    });
    app.listen(0, '127.0.0.1');
    await once(app, 'listening');
    const appAddress = app.address();
    if (appAddress === null || typeof appAddress === 'string') throw new Error('app server did not bind');
    const appOrigin = `http://127.0.0.1:${appAddress.port}`;
    const debugPort = await freePort();
    const browser = await chromium.launch({ args: [`--remote-debugging-port=${debugPort}`] });
    stop = async () => { await browser.close(); await new Promise<void>((resolve) => app.close(() => resolve())); };
    const visits: Array<{ observed: ObservedPageVisit; verdict: PageVisitVerdict }> = [];
    const observer = await observePageBrowser({
      debuggingPort: debugPort,
      pages: [{ id: 'tenant.page-orders', path: '/orders' }],
      loginRoutes: ['/login'],
      errorMarkers: [],
      appOrigins: [appOrigin],
      isProxiedExchange: () => true,
      quietMs: 300,
      onVisit: (observed, verdict) => {
        visits.push({ observed, verdict });
      },
    });
    try {
      const page = await browser.newPage();
      await page.goto(`${appOrigin}/orders`);
      await expect.poll(() => visits.length, { timeout: 5_000 }).toBe(1);
      expect(visits[0]!.observed.apiRequestsSettled).toBe(true);
      expect(visits[0]!.observed.apiResponses.map(({ status }) => status)).toEqual([200]);
      expect(visits[0]!.verdict.loads.satisfied).toBe(true);
      expect(visits[0]!.verdict.dataOk.satisfied).toBe(true);
    } finally {
      await observer.close();
    }
  });

  it('refuses a truncated Content-Length body the page never reads as unsettled', async () => {
    // Real socket teardown: the declared Content-Length can never arrive;
    // only the platform can produce this failure shape (rule exception:
    // fake timers cannot drive the browser's network stack).
    const app = createServer((request, response) => {
      if (request.url === '/api/unread') {
        response.writeHead(200, { 'content-length': '100' });
        response.write('0123456789');
        setTimeout(() => { response.socket?.destroy(); }, 300);
        return;
      }
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end('<!doctype html><html><body><main id="app"></main><script>fetch("/api/unread").then((response) => { window.k = response; }).catch(() => {});</script></body></html>');
    });
    app.listen(0, '127.0.0.1');
    await once(app, 'listening');
    const appAddress = app.address();
    if (appAddress === null || typeof appAddress === 'string') throw new Error('app server did not bind');
    const appOrigin = `http://127.0.0.1:${appAddress.port}`;
    const debugPort = await freePort();
    const browser = await chromium.launch({ args: [`--remote-debugging-port=${debugPort}`] });
    stop = async () => { await browser.close(); await new Promise<void>((resolve) => app.close(() => resolve())); };
    const visits: Array<{ observed: ObservedPageVisit; verdict: PageVisitVerdict }> = [];
    const observer = await observePageBrowser({
      debuggingPort: debugPort,
      pages: [{ id: 'tenant.page-orders', path: '/orders' }],
      loginRoutes: ['/login'],
      errorMarkers: [],
      appOrigins: [appOrigin],
      isProxiedExchange: () => true,
      quietMs: 300,
      onVisit: (observed, verdict) => {
        visits.push({ observed, verdict });
      },
    });
    try {
      const page = await browser.newPage();
      await page.goto(`${appOrigin}/orders`);
      await expect.poll(() => visits.length, { timeout: 5_000 }).toBe(1);
      // 10 of the 100 declared bytes arrived: fewer bytes than declared
      // never complete, so the window stays unsettled.
      expect(visits[0]!.observed.apiRequestsSettled).toBe(false);
      expect(visits[0]!.observed.apiResponses.map(({ status }) => status)).toEqual([200]);
      expect(visits[0]!.verdict.loads.refusalReasons).toContain('PAGE_API_UNSETTLED');
      expect(visits[0]!.verdict.dataOk.refusalReasons).toContain('PAGE_API_UNSETTLED');
    } finally {
      await observer.close();
    }
  });

  it('keeps an unread body without a declared length outstanding', async () => {
    // The chunked stream never terminates: without a declared length the
    // witness cannot verify completion from the browser's network events,
    // so the request stays outstanding (conservative limit). The emission
    // only lands after the bounded settle budget, hence the long poll
    // timeout — real browser network behavior fake timers cannot drive
    // (rule exception).
    const app = createServer((request, response) => {
      if (request.url === '/api/unread') {
        response.writeHead(200, { 'content-type': 'text/plain' });
        response.write('chunk\n');
        return;
      }
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end('<!doctype html><html><body><main id="app"></main><script>fetch("/api/unread").then((response) => { window.k = response; }).catch(() => {});</script></body></html>');
    });
    app.listen(0, '127.0.0.1');
    await once(app, 'listening');
    const appAddress = app.address();
    if (appAddress === null || typeof appAddress === 'string') throw new Error('app server did not bind');
    const appOrigin = `http://127.0.0.1:${appAddress.port}`;
    const debugPort = await freePort();
    const browser = await chromium.launch({ args: [`--remote-debugging-port=${debugPort}`] });
    stop = async () => { await browser.close(); await new Promise<void>((resolve) => app.close(() => resolve())); };
    const visits: Array<{ observed: ObservedPageVisit; verdict: PageVisitVerdict }> = [];
    const observer = await observePageBrowser({
      debuggingPort: debugPort,
      pages: [{ id: 'tenant.page-orders', path: '/orders' }],
      loginRoutes: ['/login'],
      errorMarkers: [],
      appOrigins: [appOrigin],
      isProxiedExchange: () => true,
      quietMs: 300,
      onVisit: (observed, verdict) => {
        visits.push({ observed, verdict });
      },
    });
    try {
      const page = await browser.newPage();
      await page.goto(`${appOrigin}/orders`);
      await expect.poll(() => visits.length, { timeout: 20_000 }).toBe(1);
      expect(visits[0]!.observed.apiRequestsSettled).toBe(false);
      expect(visits[0]!.observed.apiResponses.map(({ status }) => status)).toEqual([200]);
      expect(visits[0]!.verdict.loads.refusalReasons).toContain('PAGE_API_UNSETTLED');
      expect(visits[0]!.verdict.dataOk.refusalReasons).toContain('PAGE_API_UNSETTLED');
    } finally {
      await observer.close();
    }
  });

  it('settles an unread Content-Length 401 body and flushes well under the derived timeout', async () => {
    // Real app shape (the CP failure): the page keeps the response of an
    // auth probe but never reads its Content-Length body. Real browser
    // network behavior fake timers cannot drive (rule exception).
    const app = createServer((request, response) => {
      if (request.url === '/api/unread') {
        response.writeHead(401, { 'content-type': 'text/plain', 'content-length': '6' });
        response.end('denied');
        return;
      }
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end('<!doctype html><html><body><main id="app"></main><script>fetch("/api/unread").then((response) => { window.k = response; }).catch(() => {});</script></body></html>');
    });
    app.listen(0, '127.0.0.1');
    await once(app, 'listening');
    const appAddress = app.address();
    if (appAddress === null || typeof appAddress === 'string') throw new Error('app server did not bind');
    const appOrigin = `http://127.0.0.1:${appAddress.port}`;
    const debugPort = await freePort();
    const browser = await chromium.launch({ args: [`--remote-debugging-port=${debugPort}`] });
    stop = async () => { await browser.close(); await new Promise<void>((resolve) => app.close(() => resolve())); };
    const visits: Array<{ observed: ObservedPageVisit; verdict: PageVisitVerdict }> = [];
    const observer = await observePageBrowser({
      debuggingPort: debugPort,
      pages: [{ id: 'tenant.page-orders', path: '/orders' }],
      loginRoutes: ['/login'],
      errorMarkers: [],
      appOrigins: [appOrigin],
      isProxiedExchange: () => true,
      quietMs: 300,
      onVisit: (observed, verdict) => {
        visits.push({ observed, verdict });
      },
    });
    try {
      const page = await browser.newPage();
      await page.goto(`${appOrigin}/orders`);
      // The emission must not wait out the whole app-data settle budget:
      // the poll bound is a fraction of the derived flush timeout.
      await expect.poll(() => visits.length, { timeout: 5_000 }).toBe(1);
      expect(visits[0]!.observed.apiRequestsSettled).toBe(true);
      expect(visits[0]!.observed.apiResponses.map(({ status }) => status)).toEqual([401]);
      expect(visits[0]!.verdict.loads.satisfied).toBe(true);
      expect(visits[0]!.verdict.dataOk.satisfied).toBe(false);
      expect(visits[0]!.verdict.dataOk.refusalReasons).toEqual(['PAGE_API_ERROR']);
      // The flush RPC's server side is bounded by the shared budget; the
      // observed flush must return well under the derived client timeout.
      const flushStart = Date.now();
      await observer.flush();
      expect(Date.now() - flushStart).toBeLessThan(PAGE_OBSERVER_FLUSH_TIMEOUT_MS);
    } finally {
      await observer.close();
    }
  });

  it('refuses an unread truncated Content-Length body as unsettled', async () => {
    // Real socket teardown: the declared Content-Length can never arrive;
    // only the platform can produce this failure shape (rule exception:
    // fake timers cannot drive the browser's network stack).
    const app = createServer((request, response) => {
      if (request.url === '/api/unread') {
        response.writeHead(200, { 'content-length': '100' });
        response.write('0123456789');
        setTimeout(() => { response.socket?.destroy(); }, 300);
        return;
      }
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end('<!doctype html><html><body><main id="app"></main><script>fetch("/api/unread").then((response) => { window.k = response; }).catch(() => {});</script></body></html>');
    });
    app.listen(0, '127.0.0.1');
    await once(app, 'listening');
    const appAddress = app.address();
    if (appAddress === null || typeof appAddress === 'string') throw new Error('app server did not bind');
    const appOrigin = `http://127.0.0.1:${appAddress.port}`;
    const debugPort = await freePort();
    const browser = await chromium.launch({ args: [`--remote-debugging-port=${debugPort}`] });
    stop = async () => { await browser.close(); await new Promise<void>((resolve) => app.close(() => resolve())); };
    const visits: Array<{ observed: ObservedPageVisit; verdict: PageVisitVerdict }> = [];
    const observer = await observePageBrowser({
      debuggingPort: debugPort,
      pages: [{ id: 'tenant.page-orders', path: '/orders' }],
      loginRoutes: ['/login'],
      errorMarkers: [],
      appOrigins: [appOrigin],
      isProxiedExchange: () => true,
      quietMs: 300,
      onVisit: (observed, verdict) => {
        visits.push({ observed, verdict });
      },
    });
    try {
      const page = await browser.newPage();
      await page.goto(`${appOrigin}/orders`);
      await expect.poll(() => visits.length, { timeout: 5_000 }).toBe(1);
      // 10 of the 100 declared bytes arrived: fewer bytes than declared
      // never upgrade a request to settled.
      expect(visits[0]!.observed.apiRequestsSettled).toBe(false);
      expect(visits[0]!.observed.apiResponses.map(({ status }) => status)).toEqual([200]);
      expect(visits[0]!.verdict.loads.refusalReasons).toContain('PAGE_API_UNSETTLED');
      expect(visits[0]!.verdict.dataOk.refusalReasons).toContain('PAGE_API_UNSETTLED');
    } finally {
      await observer.close();
    }
  });
});
