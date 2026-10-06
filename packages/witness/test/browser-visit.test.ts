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
else fetch(path === '/bad' ? '/api/bad' : '/api/ok').then((response) => { document.querySelector('main').innerText = String(response.status); });
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
      expect((await driveEngineVisit(page, appBase, pages[0]!, pages, { loginRoutes: ['/login'], errorMarkers: ['Something went wrong'] })).loads.satisfied).toBe(true);
      expect((await driveEngineVisit(page, appBase, pages[1]!, pages, { loginRoutes: ['/login'] })).loads.refusalReasons).toContain('PAGE_BOUNCED_TO_LOGIN');
      expect((await driveEngineVisit(page, appBase, pages[2]!, pages)).loads.refusalReasons).toContain('PAGE_UNCAUGHT_EXCEPTION');
      expect((await driveEngineVisit(page, appBase, pages[3]!, pages, { errorMarkers: ['Something went wrong'] })).loads.refusalReasons).toContain('PAGE_ERROR_MARKER');
      expect((await driveEngineVisit(page, appBase, pages[4]!, pages)).dataOk.refusalReasons).toContain('PAGE_API_ERROR');
    } finally {
      await close();
      close = undefined;
    }
  });
});
