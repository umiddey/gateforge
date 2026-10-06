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
  settlePromise: Promise<void> | undefined;
  settleResolve: (() => void) | undefined;
  pendingResponses: Set<Promise<void>>;
  generation: number;
}

export interface PageObserver {
  flush(): Promise<void>;
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
    if (closed) return;
    clearTimeout(state.settleTimer);
    state.settleResolve?.();
    const generation = ++state.generation;
    let resolveSettlement!: () => void;
    let rejectSettlement!: (error: unknown) => void;
    const settlement = new Promise<void>((resolve, reject) => {
      resolveSettlement = resolve;
      rejectSettlement = reject;
    });
    void settlement.catch(() => undefined);
    state.settlePromise = settlement;
    state.settleResolve = resolveSettlement;
    state.settleTimer = setTimeout(() => {
      state.settleTimer = undefined;
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
        if (closed || state.generation !== generation) return;
        const visit: ObservedPageVisit = {
          url,
          navigations: [...state.navigations],
          exceptions: [...state.exceptions],
          domMarkerHit,
          apiResponses: [...state.apiResponses],
        };
        state.navigations = [];
        state.exceptions = [];
        state.apiResponses = [];
        const verdict = gradePageVisit({ pages: options.pages, loginRoutes: options.loginRoutes, visit });
        await options.onVisit(visit, verdict);
      })().then(resolveSettlement, rejectSettlement).finally(() => {
        if (state.generation === generation) {
          state.settlePromise = undefined;
          state.settleResolve = undefined;
        }
      });
    }, options.quietMs ?? 300);
  };
  const flush = async (): Promise<void> => {
    for (;;) {
      const pending = [...states.values()].flatMap((state) => [
        ...(state.settlePromise === undefined ? [] : [state.settlePromise]),
        ...state.pendingResponses,
      ]);
      if (pending.length === 0) return;
      await Promise.all(pending);
    }
  };
  const watch = (page: Page): void => {
    if (states.has(page)) return;
    const state: PageState = {
      page,
      navigations: [],
      exceptions: [],
      apiResponses: [],
      settleTimer: undefined,
      settlePromise: undefined,
      settleResolve: undefined,
      pendingResponses: new Set(),
      generation: 0,
    };
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
      const pending = (async () => {
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
      state.pendingResponses.add(pending);
      void pending.then(
        () => state.pendingResponses.delete(pending),
        () => state.pendingResponses.delete(pending),
      );
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
    flush,
    async close(): Promise<void> {
      if (closed) return;
      clearInterval(discoveryTimer);
      try {
        await flush();
      } finally {
        closed = true;
        for (const state of states.values()) clearTimeout(state.settleTimer);
        await browser.close();
      }
    },
  };
}
