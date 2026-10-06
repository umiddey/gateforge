import type { Browser, BrowserContext, Page } from 'playwright';
import type { ObservedPageVisit, PageRoute, PageVisitVerdict } from './page-observation.js';
import { gradePageVisit } from './page-observation.js';

export interface PageObserverOptions {
  debuggingPort: number;
  pages: readonly PageRoute[];
  loginRoutes?: readonly string[];
  errorMarkers: readonly string[];
  appOrigins: readonly string[];
  isProxiedExchange: (url: string, status: number) => boolean;
  onVisit: (visit: ObservedPageVisit, verdict: PageVisitVerdict) => void | Promise<void>;
  quietMs?: number;
}

interface PageState {
  page: Page;
  navigations: string[];
  exceptions: string[];
  apiResponses: ObservedPageVisit['apiResponses'];
  settleTimer: ReturnType<typeof setTimeout> | undefined;
  generation: number;
}

export interface PageObserver {
  close(): Promise<void>;
}

/** Attach the witness's independent Playwright/CDP client to an existing browser. */
export async function observePageBrowser(options: PageObserverOptions): Promise<PageObserver> {
  if (!Number.isInteger(options.debuggingPort) || options.debuggingPort < 1 || options.debuggingPort > 65535) {
    throw new RangeError('debuggingPort must be a TCP port number');
  }
  // Playwright is an optional peer: load it only when a browser observation is requested.
  const { chromium } = await import('playwright');
  const browser: Browser = await chromium.connectOverCDP(`http://127.0.0.1:${options.debuggingPort}`);
  const states = new Map<Page, PageState>();
  const contextsWatched = new Set<BrowserContext>();
  let closed = false;
  const isAppOrigin = (url: string): boolean => {
    try {
      return options.appOrigins.includes(new URL(url).origin);
    } catch {
      return false;
    }
  };
  const settle = (state: PageState): void => {
    clearTimeout(state.settleTimer);
    const generation = ++state.generation;
    state.settleTimer = setTimeout(() => {
      void (async () => {
        if (closed || state.generation !== generation || state.page.url() === 'about:blank') return;
        let url = state.page.url();
        let domMarkerHit = false;
        try {
          const text = await state.page.locator('body').innerText({ timeout: 1_000 });
          domMarkerHit = options.errorMarkers.some((marker) => text.includes(marker));
          url = state.page.url();
        } catch {
          // A destroyed/closing page has no readable settled DOM; page errors remain in the record.
        }
        const visit: ObservedPageVisit = {
          url,
          navigations: [...state.navigations],
          exceptions: [...state.exceptions],
          domMarkerHit,
          apiResponses: [...state.apiResponses],
        };
        const verdict = gradePageVisit({ pages: options.pages, loginRoutes: options.loginRoutes, visit });
        await options.onVisit(visit, verdict);
        state.navigations = [];
        state.exceptions = [];
        state.apiResponses = [];
      })();
    }, options.quietMs ?? 300);
  };
  const watch = (page: Page): void => {
    if (states.has(page)) return;
    const state: PageState = { page, navigations: [], exceptions: [], apiResponses: [], settleTimer: undefined, generation: 0 };
    states.set(page, state);
    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame()) {
        state.navigations.push(frame.url());
        settle(state);
      }
    });
    page.on('pageerror', (error) => {
      state.exceptions.push(error.message);
      settle(state);
    });
    page.on('response', (response) => {
      const url = response.url();
      if (!isAppOrigin(url) || !new URL(url).pathname.startsWith('/api/')) return;
      void (async () => {
        let remoteAddress: string | null = null;
        try {
          remoteAddress = (await response.serverAddr())?.ipAddress ?? null;
        } catch {
          // Missing address is a refusal, not a reason to lose the observation.
        }
        state.apiResponses.push({
          url,
          status: response.status(),
          remoteAddress,
          proxied: options.isProxiedExchange(url, response.status()),
        });
        settle(state);
      })();
    });
    settle(state);
  };
  const discoverPages = (): void => {
    for (const context of browser.contexts()) {
      if (!contextsWatched.has(context)) {
        contextsWatched.add(context);
        context.on('page', watch);
      }
      for (const page of context.pages()) watch(page);
    }
  };
  discoverPages();
  const discoveryTimer = setInterval(discoverPages, 100);
  return {
    async close(): Promise<void> {
      closed = true;
      clearInterval(discoveryTimer);
      for (const state of states.values()) clearTimeout(state.settleTimer);
      await browser.close();
    },
  };
}
