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
else fetch(path === '/bad' ? '/api/bad' : path === '/delayed500' ? '/data500' : path === '/delayed200' ? '/data200' : path === '/aborted' ? '/api/aborted' : path === '/slowbody' ? '/data-slowbody' : path === '/deadbody' ? '/data-deadbody' : path === '/lateerror' ? '/databody' : '/api/ok').then((response) => { document.querySelector('main').innerText = String(response.status); if (path === '/lateerror') setTimeout(() => { throw new Error('late body crash'); }, 100); }).catch(() => {});
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
});
