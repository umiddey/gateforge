import { createServer } from 'node:http';
import { createServer as createTcpServer } from 'node:net';
import { once } from 'node:events';
import { chromium } from 'playwright';
import { afterEach, describe, expect, it } from 'vitest';
import { observePageBrowser } from '../src/witness/page-observer.js';
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
});
