import { createServer } from 'node:http';
import { once } from 'node:events';
import { chromium } from 'playwright';
import { afterEach, describe, expect, it } from 'vitest';
import { EngineBrowserManager, driveEngineVisit } from '../src/witness/browser.js';

const html = `<!doctype html><body><main>Loading</main><script>
const path = location.pathname;
if (path === '/bounce') { history.replaceState({}, '', '/login'); document.body.innerText = 'Login'; }
else if (path === '/crash') setTimeout(() => { throw new Error('render crashed'); }, 0);
else if (path === '/error') document.body.innerText = 'Something went wrong';
else if (path === '/unread401' || path === '/unread200' || path === '/shortbody' || path === '/chunkhang') {
  // The response is retained but its body is NEVER read: the real SPA
  // shape ("if (!res.ok) return null"). Chromium only finishes such a load
  // once every declared byte arrived, regardless of page consumption.
  fetch(path === '/unread401' ? '/api/unread401' : path === '/unread200' ? '/api/unread200' : path === '/shortbody' ? '/data-shortbody' : '/data-chunkhang').then((response) => { window.k = response; }).catch(() => {});
}
else fetch(path === '/bad' ? '/api/bad' : path === '/delayed500' ? '/data500' : path === '/delayed200' ? '/data200' : path === '/aborted' ? '/api/aborted' : path === '/slowbody' ? '/data-slowbody' : path === '/deadbody' ? '/data-deadbody' : path === '/lateerror' ? '/databody' : '/api/ok').then((response) => { document.querySelector('main').innerText = String(response.status); if (path === '/lateerror') setTimeout(() => { throw new Error('late body crash'); }, 100); }).catch(() => {});
</script></body>`;

// The real SPA cancel shape: fire a data fetch, cancel it client-side with
// an AbortController, then (optionally) re-issue the same request. The 50ms
// delay before the abort is deliberate real time INSIDE THE PAGE: fake
// timers in the test process cannot drive the page's JS or the browser's
// network stack, and the abort must land after Chromium actually dispatched
// the request (rule exception, same rationale as the server delays above).
const cancelHtml = `<!doctype html><body><main>Loading</main><script>
(async () => {
  const p = location.pathname;
  const controller = new AbortController();
  fetch(p === '/cancelquery' ? '/api/x?a=1' : '/api/x', { signal: controller.signal }).catch(() => {});
  setTimeout(() => {
    controller.abort();
    if (p === '/cancelonly') return;
    fetch(p === '/cancelquery' ? '/api/x?a=2' : '/api/x').then((response) => { document.querySelector('main').textContent = 'Data ' + String(response.status); }).catch(() => {});
  }, 50);
})().catch(() => {});
</script></body>`;

describe('engine browser visit', () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => close?.());

  it('uses the shared grader for clean, bounce, crash, error-screen and API-error visits', async () => {
    const app = createServer((request, response) => {
      if (request.url?.startsWith('/api/')) {
        response.writeHead(request.url === '/api/bad' ? 500 : 200);
        response.end('{}');
        return;
      }
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end(html);
    });
    app.listen(0, [127, 0, 0, 1].join('.'));
    await once(app, 'listening');
    const address = app.address();
    if (address === null || typeof address === 'string') throw new Error('app server did not bind');
    const appBase = `http://${[127, 0, 0, 1].join('.')}:${String(address.port)}`;
    const browser = chromium;
    const manager = new EngineBrowserManager({ launch: (options) => browser.launch(options) });
    const page = await manager.pageFor('visit-test');
    close = async () => { await manager.closeAll(); await new Promise<void>((resolve) => app.close(() => resolve())); };
    const pages = ['/clean', '/bounce', '/crash', '/error', '/bad'].map((path) => ({ id: path, path }));
    try {
      expect((await driveEngineVisit(page, appBase, pages[0]!, pages, { loginRoutes: ['/login'], errorMarkers: ['Something went wrong'] })).verdict.loads.satisfied).toBe(true);
      expect((await driveEngineVisit(page, appBase, pages[1]!, pages, { loginRoutes: ['/login'] })).verdict.loads.refusalReasons).toContain('PAGE_BOUNCED_TO_LOGIN');
      expect((await driveEngineVisit(page, appBase, pages[2]!, pages)).verdict.loads.refusalReasons).toContain('PAGE_UNCAUGHT_EXCEPTION');
      expect((await driveEngineVisit(page, appBase, pages[3]!, pages, { errorMarkers: ['Something went wrong'] })).verdict.loads.refusalReasons).toContain('PAGE_ERROR_MARKER');
      expect((await driveEngineVisit(page, appBase, pages[4]!, pages)).verdict.dataOk.refusalReasons).toContain('PAGE_API_ERROR');
    } finally {
      await close();
      close = undefined;
    }
  });

  it('waits for delayed app data responses and refuses unsettled requests', async () => {
    const app = createServer((request, response) => {
      // Real wall-clock delays are the behavior under test: the 500/200 must
      // land AFTER the observer's real quiet window against real Chromium.
      // Fake timers cannot drive the browser's network stack, so a genuine
      // server-side delay is required here (rule exception, named above).
      if (request.url === '/data500') {
        setTimeout(() => { response.writeHead(500); response.end('{}'); }, 1_200);
        return;
      }
      if (request.url === '/data200') {
        setTimeout(() => { response.writeHead(200); response.end('{}'); }, 1_200);
        return;
      }
      if (request.url?.startsWith('/api/')) {
        response.writeHead(request.url === '/api/bad' ? 500 : 200);
        response.end('{}');
        return;
      }
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end(html);
    });
    app.listen(0, [127, 0, 0, 1].join('.'));
    await once(app, 'listening');
    const address = app.address();
    if (address === null || typeof address === 'string') throw new Error('app server did not bind');
    const appBase = `http://${[127, 0, 0, 1].join('.')}:${String(address.port)}`;
    const browser = chromium;
    const manager = new EngineBrowserManager({ launch: (options) => browser.launch(options) });
    const page = await manager.pageFor('delayed-settle-test');
    close = async () => { await manager.closeAll(); await new Promise<void>((resolve) => app.close(() => resolve())); };
    const pages = ['/delayed500', '/delayed200', '/aborted'].map((path) => ({ id: path, path }));
    try {
      // The 500 lands long after the quiet window; the visit must wait for
      // it (non-/api fetch URL, classified by resource type) and refuse data.
      const delayed500 = await driveEngineVisit(page, appBase, pages[0]!, pages);
      expect(delayed500.visit.apiRequestsSettled).toBe(true);
      expect(delayed500.visit.apiResponses.map(({ status }) => status)).toEqual([500]);
      expect(delayed500.verdict.loads.satisfied).toBe(true);
      expect(delayed500.verdict.dataOk.refusalReasons).toContain('PAGE_API_ERROR');
      const delayed200 = await driveEngineVisit(page, appBase, pages[1]!, pages);
      expect(delayed200.visit.apiRequestsSettled).toBe(true);
      expect(delayed200.visit.apiResponses.map(({ status }) => status)).toEqual([200]);
      expect(delayed200.verdict.loads.satisfied).toBe(true);
      expect(delayed200.verdict.dataOk.satisfied).toBe(true);
      await page.route('**/api/aborted', (route) => route.abort());
      const aborted = await driveEngineVisit(page, appBase, pages[2]!, pages);
      expect(aborted.visit.apiRequestsSettled).toBe(false);
      expect(aborted.visit.apiResponses).toEqual([]);
      expect(aborted.verdict.loads.refusalReasons).toContain('PAGE_API_UNSETTLED');
      expect(aborted.verdict.dataOk.refusalReasons).toContain('PAGE_API_UNSETTLED');
    } finally {
      await close();
      close = undefined;
    }
  });

  it('keeps a 200 whose body completes late settled and satisfying', async () => {
    // Real wall-clock delay: headers flush at once, the body completes only
    // after the quiet window; fake timers cannot drive the browser's
    // network stack (rule exception, named here).
    const app = createServer((request, response) => {
      if (request.url === '/data-slowbody') {
        response.writeHead(200);
        response.flushHeaders();
        setTimeout(() => response.end('{}'), 1_200);
        return;
      }
      if (request.url?.startsWith('/api/')) {
        response.writeHead(200);
        response.end('{}');
        return;
      }
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end(html);
    });
    app.listen(0, [127, 0, 0, 1].join('.'));
    await once(app, 'listening');
    const address = app.address();
    if (address === null || typeof address === 'string') throw new Error('app server did not bind');
    const appBase = `http://${[127, 0, 0, 1].join('.')}:${String(address.port)}`;
    const manager = new EngineBrowserManager({ launch: (options) => chromium.launch(options) });
    const page = await manager.pageFor('slow-body-test');
    close = async () => { await manager.closeAll(); await new Promise<void>((resolve) => app.close(() => resolve())); };
    const pages = ['/slowbody'].map((path) => ({ id: path, path }));
    try {
      const slow = await driveEngineVisit(page, appBase, pages[0]!, pages);
      expect(slow.visit.apiRequestsSettled).toBe(true);
      expect(slow.visit.apiResponses.map(({ status }) => status)).toEqual([200]);
      expect(slow.verdict.loads.satisfied).toBe(true);
      expect(slow.verdict.dataOk.satisfied).toBe(true);
    } finally {
      await close();
      close = undefined;
    }
  });

  it('refuses a 200 whose body never completes as unsettled', async () => {
    // Real wall-clock + real socket teardown: the 200 headers flush at once
    // and the connection dies before the body completes; only the platform
    // can produce this failure shape (rule exception, named here).
    const app = createServer((request, response) => {
      if (request.url === '/data-deadbody') {
        response.writeHead(200);
        response.flushHeaders();
        setTimeout(() => { response.socket?.destroy(); }, 1_200);
        return;
      }
      if (request.url?.startsWith('/api/')) {
        response.writeHead(200);
        response.end('{}');
        return;
      }
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end(html);
    });
    app.listen(0, [127, 0, 0, 1].join('.'));
    await once(app, 'listening');
    const address = app.address();
    if (address === null || typeof address === 'string') throw new Error('app server did not bind');
    const appBase = `http://${[127, 0, 0, 1].join('.')}:${String(address.port)}`;
    const manager = new EngineBrowserManager({ launch: (options) => chromium.launch(options) });
    const page = await manager.pageFor('dead-body-test');
    close = async () => { await manager.closeAll(); await new Promise<void>((resolve) => app.close(() => resolve())); };
    const pages = ['/deadbody'].map((path) => ({ id: path, path }));
    try {
      // Headers were collected ([200]) but the request never finished: the
      // observation stays unsettled and can never grade clean.
      const dead = await driveEngineVisit(page, appBase, pages[0]!, pages);
      expect(dead.visit.apiRequestsSettled).toBe(false);
      expect(dead.visit.apiResponses.map(({ status }) => status)).toEqual([200]);
      // The visit names the request that left it unsettled (the exact
      // Chromium error text for a destroyed socket is platform detail).
      expect(dead.visit.unsettledRequests).toHaveLength(1);
      expect(dead.visit.unsettledRequests[0]?.method).toBe('GET');
      expect(dead.visit.unsettledRequests[0]?.url).toBe('/data-deadbody');
      expect(dead.visit.unsettledRequests[0]?.errorText).toBeTruthy();
      expect(dead.verdict.loads.refusalReasons).toContain('PAGE_API_UNSETTLED');
      expect(dead.verdict.dataOk.satisfied).toBe(false);
      expect(dead.verdict.dataOk.refusalReasons).toContain('PAGE_API_UNSETTLED');
    } finally {
      await close();
      close = undefined;
    }
  });

  it('refuses an error scheduled after a late response body completes', async () => {
    // Real wall-clock delay: the body completes after the quiet window and
    // the page schedules an uncaught error 100ms later; grading must wait
    // for the quiet window AFTER completion to catch it. Fake timers cannot
    // drive the browser's network stack (rule exception, named here).
    const app = createServer((request, response) => {
      if (request.url === '/databody') {
        response.writeHead(200);
        response.flushHeaders();
        setTimeout(() => response.end('{}'), 1_200);
        return;
      }
      if (request.url?.startsWith('/api/')) {
        response.writeHead(200);
        response.end('{}');
        return;
      }
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end(html);
    });
    app.listen(0, [127, 0, 0, 1].join('.'));
    await once(app, 'listening');
    const address = app.address();
    if (address === null || typeof address === 'string') throw new Error('app server did not bind');
    const appBase = `http://${[127, 0, 0, 1].join('.')}:${String(address.port)}`;
    const manager = new EngineBrowserManager({ launch: (options) => chromium.launch(options) });
    const page = await manager.pageFor('late-error-test');
    close = async () => { await manager.closeAll(); await new Promise<void>((resolve) => app.close(() => resolve())); };
    const pages = ['/lateerror'].map((path) => ({ id: path, path }));
    try {
      const late = await driveEngineVisit(page, appBase, pages[0]!, pages);
      expect(late.visit.apiRequestsSettled).toBe(true);
      expect(late.visit.apiResponses.map(({ status }) => status)).toEqual([200]);
      expect(late.visit.exceptions).toEqual(['late body crash']);
      expect(late.verdict.loads.refusalReasons).toContain('PAGE_UNCAUGHT_EXCEPTION');
    } finally {
      await close();
      close = undefined;
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
    app.listen(0, [127, 0, 0, 1].join('.'));
    await once(app, 'listening');
    const address = app.address();
    if (address === null || typeof address === 'string') throw new Error('app server did not bind');
    const appBase = `http://${[127, 0, 0, 1].join('.')}:${String(address.port)}`;
    const manager = new EngineBrowserManager({ launch: (options) => chromium.launch(options) });
    const page = await manager.pageFor('cancel-retry-test');
    close = async () => { await manager.closeAll(); await new Promise<void>((resolve) => app.close(() => resolve())); };
    const pages = ['/cancelretry'].map((path) => ({ id: path, path }));
    try {
      const retried = await driveEngineVisit(page, appBase, pages[0]!, pages);
      expect(retried.visit.apiRequestsSettled).toBe(true);
      // The cancelled request's headers may or may not have been collected
      // before the abort landed; the retry's 200 must be.
      expect(retried.visit.apiResponses.map(({ status }) => status)).toContain(200);
      expect(retried.verdict.loads.satisfied).toBe(true);
      expect(retried.verdict.dataOk.satisfied).toBe(true);
    } finally {
      await close();
      close = undefined;
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
    app.listen(0, [127, 0, 0, 1].join('.'));
    await once(app, 'listening');
    const address = app.address();
    if (address === null || typeof address === 'string') throw new Error('app server did not bind');
    const appBase = `http://${[127, 0, 0, 1].join('.')}:${String(address.port)}`;
    const manager = new EngineBrowserManager({ launch: (options) => chromium.launch(options) });
    const page = await manager.pageFor('cancel-only-test');
    close = async () => { await manager.closeAll(); await new Promise<void>((resolve) => app.close(() => resolve())); };
    const pages = ['/cancelonly'].map((path) => ({ id: path, path }));
    try {
      const cancelled = await driveEngineVisit(page, appBase, pages[0]!, pages);
      expect(cancelled.visit.apiRequestsSettled).toBe(false);
      // The visit names the cancelled request and its real failure text.
      expect(cancelled.visit.unsettledRequests).toEqual([
        { method: 'GET', url: '/api/x', errorText: 'net::ERR_ABORTED' },
      ]);
      expect(cancelled.verdict.loads.refusalReasons).toContain('PAGE_API_UNSETTLED');
      expect(cancelled.verdict.dataOk.refusalReasons).toContain('PAGE_API_UNSETTLED');
    } finally {
      await close();
      close = undefined;
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
    app.listen(0, [127, 0, 0, 1].join('.'));
    await once(app, 'listening');
    const address = app.address();
    if (address === null || typeof address === 'string') throw new Error('app server did not bind');
    const appBase = `http://${[127, 0, 0, 1].join('.')}:${String(address.port)}`;
    const manager = new EngineBrowserManager({ launch: (options) => chromium.launch(options) });
    const page = await manager.pageFor('cancel-query-test');
    close = async () => { await manager.closeAll(); await new Promise<void>((resolve) => app.close(() => resolve())); };
    const pages = ['/cancelquery'].map((path) => ({ id: path, path }));
    try {
      const mismatched = await driveEngineVisit(page, appBase, pages[0]!, pages);
      expect(mismatched.visit.apiRequestsSettled).toBe(false);
      expect(mismatched.verdict.loads.refusalReasons).toContain('PAGE_API_UNSETTLED');
      expect(mismatched.verdict.dataOk.refusalReasons).toContain('PAGE_API_UNSETTLED');
    } finally {
      await close();
      close = undefined;
    }
  });

  it('settles an unread 401 body once every declared byte arrived', async () => {
    const app = createServer((request, response) => {
      if (request.url === '/api/unread401') {
        response.writeHead(401, { 'content-type': 'text/plain' });
        response.end('denied');
        return;
      }
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end(html);
    });
    app.listen(0, [127, 0, 0, 1].join('.'));
    await once(app, 'listening');
    const address = app.address();
    if (address === null || typeof address === 'string') throw new Error('app server did not bind');
    const appBase = `http://${[127, 0, 0, 1].join('.')}:${String(address.port)}`;
    const manager = new EngineBrowserManager({ launch: (options) => chromium.launch(options) });
    const page = await manager.pageFor('unread-401-test');
    close = async () => { await manager.closeAll(); await new Promise<void>((resolve) => app.close(() => resolve())); };
    const pages = ['/unread401'].map((path) => ({ id: path, path }));
    try {
      // The page keeps the response but never reads its body; completion
      // must come from the browser's own network events once every declared
      // byte arrived — not from the page consuming the body.
      const unread = await driveEngineVisit(page, appBase, pages[0]!, pages);
      expect(unread.visit.apiRequestsSettled).toBe(true);
      expect(unread.visit.apiResponses.map(({ status }) => status)).toEqual([401]);
      expect(unread.verdict.loads.satisfied).toBe(true);
      expect(unread.verdict.dataOk.satisfied).toBe(false);
      // The 401 is still an API error while the page's audience has a login
      // (no anonymous flag) — and ONLY that.
      expect(unread.verdict.dataOk.refusalReasons).toEqual(['PAGE_API_ERROR']);
    } finally {
      await close();
      close = undefined;
    }
  });

  it('accepts a 401 on an anonymous audience page and refuses a login page', async () => {
    const app = createServer((request, response) => {
      if (request.url === '/api/unread401') {
        response.writeHead(401, { 'content-type': 'text/plain' });
        response.end('denied');
        return;
      }
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end(html);
    });
    app.listen(0, [127, 0, 0, 1].join('.'));
    await once(app, 'listening');
    const address = app.address();
    if (address === null || typeof address === 'string') throw new Error('app server did not bind');
    const appBase = `http://${[127, 0, 0, 1].join('.')}:${String(address.port)}`;
    const manager = new EngineBrowserManager({ launch: (options) => chromium.launch(options) });
    const page = await manager.pageFor('anonymous-401-test');
    close = async () => { await manager.closeAll(); await new Promise<void>((resolve) => app.close(() => resolve())); };
    const pages = [
      { id: 'global.page-public', path: '/unread401', anonymous: true },
      { id: 'tenant.page-member', path: '/unread401' },
    ];
    try {
      // Swept channel: the referee drives each route directly, so the flag
      // arrives on the EXPECTED page. Exactly 401 is the expected
      // not-logged-in answer only on the session-less audience's page.
      const anonymous = await driveEngineVisit(page, appBase, pages[0]!, pages);
      expect(anonymous.verdict.dataOk.satisfied).toBe(true);
      expect(anonymous.verdict.dataOk.refusalReasons).toEqual([]);
      const refused = await driveEngineVisit(page, appBase, pages[1]!, pages);
      expect(refused.verdict.dataOk.satisfied).toBe(false);
      expect(refused.verdict.dataOk.refusalReasons).toEqual(['PAGE_API_ERROR']);
    } finally {
      await close();
      close = undefined;
    }
  });

  it('settles an unread 200 body once every declared byte arrived', async () => {
    const app = createServer((request, response) => {
      if (request.url === '/api/unread200') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end('{}');
        return;
      }
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end(html);
    });
    app.listen(0, [127, 0, 0, 1].join('.'));
    await once(app, 'listening');
    const address = app.address();
    if (address === null || typeof address === 'string') throw new Error('app server did not bind');
    const appBase = `http://${[127, 0, 0, 1].join('.')}:${String(address.port)}`;
    const manager = new EngineBrowserManager({ launch: (options) => chromium.launch(options) });
    const page = await manager.pageFor('unread-200-test');
    close = async () => { await manager.closeAll(); await new Promise<void>((resolve) => app.close(() => resolve())); };
    const pages = ['/unread200'].map((path) => ({ id: path, path }));
    try {
      const unread = await driveEngineVisit(page, appBase, pages[0]!, pages);
      expect(unread.visit.apiRequestsSettled).toBe(true);
      expect(unread.visit.apiResponses.map(({ status }) => status)).toEqual([200]);
      expect(unread.verdict.loads.satisfied).toBe(true);
      expect(unread.verdict.dataOk.satisfied).toBe(true);
    } finally {
      await close();
      close = undefined;
    }
  });

  it('refuses a truncated Content-Length body the page never reads as unsettled', async () => {
    // Real socket teardown: the declared Content-Length can never arrive;
    // only the platform can produce this failure shape (rule exception:
    // fake timers cannot drive the browser's network stack).
    const app = createServer((request, response) => {
      if (request.url === '/data-shortbody') {
        response.writeHead(200, { 'content-length': '100' });
        response.write('0123456789');
        setTimeout(() => { response.socket?.destroy(); }, 300);
        return;
      }
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end(html);
    });
    app.listen(0, [127, 0, 0, 1].join('.'));
    await once(app, 'listening');
    const address = app.address();
    if (address === null || typeof address === 'string') throw new Error('app server did not bind');
    const appBase = `http://${[127, 0, 0, 1].join('.')}:${String(address.port)}`;
    const manager = new EngineBrowserManager({ launch: (options) => chromium.launch(options) });
    const page = await manager.pageFor('short-body-test');
    close = async () => { await manager.closeAll(); await new Promise<void>((resolve) => app.close(() => resolve())); };
    const pages = ['/shortbody'].map((path) => ({ id: path, path }));
    try {
      // Headers and 10 of the 100 declared bytes arrived; the visit must
      // stay unsettled — fewer bytes than declared never complete.
      const short = await driveEngineVisit(page, appBase, pages[0]!, pages);
      expect(short.visit.apiRequestsSettled).toBe(false);
      expect(short.visit.apiResponses.map(({ status }) => status)).toEqual([200]);
      expect(short.verdict.loads.refusalReasons).toContain('PAGE_API_UNSETTLED');
      expect(short.verdict.dataOk.refusalReasons).toContain('PAGE_API_UNSETTLED');
    } finally {
      await close();
      close = undefined;
    }
  });

  it('keeps an unread body without a declared length outstanding', async () => {
    // The chunked stream never terminates: without a declared length the
    // witness cannot verify completion from the browser's network events,
    // so the request stays outstanding (conservative limit). Fake timers
    // cannot drive the browser's network stack (rule exception).
    const app = createServer((request, response) => {
      if (request.url === '/data-chunkhang') {
        response.writeHead(200, { 'content-type': 'text/plain' });
        response.write('chunk\n');
        return;
      }
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end(html);
    });
    app.listen(0, [127, 0, 0, 1].join('.'));
    await once(app, 'listening');
    const address = app.address();
    if (address === null || typeof address === 'string') throw new Error('app server did not bind');
    const appBase = `http://${[127, 0, 0, 1].join('.')}:${String(address.port)}`;
    const manager = new EngineBrowserManager({ launch: (options) => chromium.launch(options) });
    const page = await manager.pageFor('chunk-hang-test');
    close = async () => { await manager.closeAll(); await new Promise<void>((resolve) => app.close(() => resolve())); };
    const pages = ['/chunkhang'].map((path) => ({ id: path, path }));
    try {
      // Grading waits the whole bounded API settle budget and then refuses:
      // an unread body with no Content-Length never counts as settled.
      const hung = await driveEngineVisit(page, appBase, pages[0]!, pages);
      expect(hung.visit.apiRequestsSettled).toBe(false);
      expect(hung.visit.apiResponses.map(({ status }) => status)).toEqual([200]);
      expect(hung.verdict.loads.refusalReasons).toContain('PAGE_API_UNSETTLED');
      expect(hung.verdict.dataOk.refusalReasons).toContain('PAGE_API_UNSETTLED');
    } finally {
      await close();
      close = undefined;
    }
  });
});
