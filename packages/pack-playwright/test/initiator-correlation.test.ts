import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';

const SAMPLE_COUNT = 20;

function pathFor(kind: string, index: number): string {
  return `/probe/${kind}/${String(index)}`;
}

function samplesFor(
  kind: string,
  cdpAt: Map<string, number>,
  routeAt: Map<string, number>,
): number[] {
  return Array.from({ length: SAMPLE_COUNT }, (_, index) => {
    const path = pathFor(kind, index);
    const eventTime = cdpAt.get(path);
    const routeTime = routeAt.get(path);
    if (eventTime === undefined || routeTime === undefined) {
      throw new Error(`missing CDP/route timestamp for ${path}`);
    }
    return routeTime - eventTime;
  });
}

function rangeOf(values: number[]): { minMs: number; maxMs: number } {
  return {
    minMs: Math.min(...values),
    maxMs: Math.max(...values),
  };
}

async function startApp(): Promise<{ url: string; server: Server }> {
  const server = createServer((request, response) => {
    const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
    if (pathname === '/') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(
        '<button id="click">Click</button><button id="delayed">Delayed click</button>' +
          '<script>window.nextPath="";' +
          'document.querySelector("#click").onclick=()=>fetch(window.nextPath);' +
          'document.querySelector("#delayed").onclick=async()=>{' +
          'await new Promise(resolve=>setTimeout(resolve,0));await fetch(window.nextPath)};' +
          '</script>',
      );
      return;
    }
    response.writeHead(200, { 'content-type': 'text/plain' });
    response.end('ok');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${String(address.port)}`, server };
}

async function setNextPath(page: Page, path: string): Promise<void> {
  await page.evaluate((value) => {
    (window as Window & { nextPath: string }).nextPath = value;
  }, path);
}

describe('CDP requestWillBeSent versus Playwright route timing', () => {
  let browser: Browser | undefined;
  afterAll(async () => {
    await browser?.close();
  });

  it('measures event-to-route arrival for clicks, delayed clicks, and page.evaluate fetches', async () => {
    const app = await startApp();
    browser = await chromium.launch({ headless: true });
    try {
      const context = await browser.newContext();
      const page = await context.newPage();
      const cdp = await context.newCDPSession(page);
      const cdpAt = new Map<string, number>();
      const routeAt = new Map<string, number>();
      cdp.on('Network.requestWillBeSent', (event: { request: { url: string } }) => {
        const pathname = new URL(event.request.url).pathname;
        if (pathname.startsWith('/probe/')) cdpAt.set(pathname, performance.now());
      });
      await cdp.send('Network.enable');
      await cdp.send('Debugger.enable');
      await cdp.send('Debugger.setAsyncCallStackDepth', { maxDepth: 32 });
      await page.route('**/*', async (route) => {
        const pathname = new URL(route.request().url()).pathname;
        if (pathname.startsWith('/probe/')) routeAt.set(pathname, performance.now());
        await route.continue();
      });
      await page.goto(app.url);

      for (let index = 0; index < SAMPLE_COUNT; index += 1) {
        const path = pathFor('click', index);
        await setNextPath(page, path);
        await Promise.all([
          page.waitForResponse((response) => new URL(response.url()).pathname === path),
          page.locator('#click').click(),
        ]);
      }
      for (let index = 0; index < SAMPLE_COUNT; index += 1) {
        const path = pathFor('delayed-click', index);
        await setNextPath(page, path);
        await Promise.all([
          page.waitForResponse((response) => new URL(response.url()).pathname === path),
          page.locator('#delayed').click(),
        ]);
      }
      for (let index = 0; index < SAMPLE_COUNT; index += 1) {
        const path = pathFor('evaluate', index);
        await page.evaluate(async (requestPath) => {
          await fetch(requestPath);
        }, path);
      }

      const ranges = {
        click: rangeOf(samplesFor('click', cdpAt, routeAt)),
        delayedClick: rangeOf(samplesFor('delayed-click', cdpAt, routeAt)),
        evaluate: rangeOf(samplesFor('evaluate', cdpAt, routeAt)),
      };
      console.log(`CDP-to-route entry deltas (ms; route − Network.requestWillBeSent): ${JSON.stringify(ranges)}`);
      // This is an integration probe of real Chromium timing (including
      // the application's real setTimeout), not a latency assertion.
      expect(cdpAt.size).toBe(SAMPLE_COUNT * 3);
      expect(routeAt.size).toBe(SAMPLE_COUNT * 3);
      await cdp.detach();
      await context.close();
    } finally {
      await new Promise<void>((resolve) => app.server.close(() => resolve()));
    }
  });
});
