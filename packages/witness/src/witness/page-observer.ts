import type { Browser, BrowserContext, Page, Request } from 'playwright';
import {
  apiRequestsSettled,
  gradePageVisit,
  type ObservedApiRequestCompletion,
  type ObservedApiRequestFailure,
  type ObservedPageVisit,
  type PageRoute,
  type PageVisitVerdict,
} from './page-observation.js';
import {
  ENGINE_PAGE_VISIT_ADDRESS_TIMEOUT_MS,
  ENGINE_PAGE_VISIT_API_SETTLE_TIMEOUT_MS,
} from '../constants.js';

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

/**
 * One navigation window: the evidence of ONE main-frame document visit.
 * Evidence accumulates across quiet re-emissions (a later emission can
 * never drop an earlier error); only a genuinely new main-frame navigation
 * AFTER the window has emitted replaces it with a fresh window.
 */
interface PageWindow {
  /** Latest main-frame URL seen in this window (boundary compare source). */
  url: string;
  navigations: string[];
  exceptions: string[];
  apiResponses: ObservedPageVisit['apiResponses'];
  /** App data requests (fetch/XHR or /api/) started but not yet settled. */
  outstanding: Set<Request>;
  /** Wakes a pending emission wait when an outstanding request settles. */
  settleNotify: (() => void) | undefined;
  /** Tracked app data requests of this window that failed, with why. */
  failedRequests: ObservedApiRequestFailure[];
  /** Tracked app data requests of this window that reached completion. */
  completedRequests: ObservedApiRequestCompletion[];
  /** Bounded response collections (address lookups) still in flight. */
  pendingResponses: Set<Promise<void>>;
  /** Last REAL DOM marker reading of this window's document. */
  domMarkerHit: boolean;
  /** True once a settled DOM marker read proved this window's document. */
  domGraded: boolean;
  /** True once this window has emitted at least one observation. */
  emitted: boolean;
  /** True when evidence arrived that no emission has carried yet. */
  dirty: boolean;
}

interface PageState {
  page: Page;
  window: PageWindow;
  settleTimer: NodeJS.Timeout | undefined;
  settlePromise: Promise<void> | undefined;
  settleResolve: (() => void) | undefined;
  /** Associates each tracked request with the window that captured it. */
  requestWindows: Map<Request, PageWindow>;
  /** Salvage emissions of windows closed by a navigation boundary. */
  pendingFinalizations: Set<Promise<void>>;
  generation: number;
}

export interface PageObserver {
  flush(): Promise<void>;
  close(): Promise<void>;
}

/** The request resource types that carry application data exchanges. */
const API_RESOURCE_TYPES: Record<string, true> = { fetch: true, xhr: true };

/** Same-document navigation check (hash-only changes never close a window). */
function sameWindowUrl(previous: string, next: string): boolean {
  try {
    const before = new URL(previous);
    const after = new URL(next);
    return before.origin === after.origin && before.pathname === after.pathname && before.search === after.search;
  } catch {
    return false;
  }
}

/** Attach the witness's independent Playwright/CDP client to an existing browser. */
export async function observePageBrowser(options: PageObserverOptions): Promise<PageObserver> {
  if (!Number.isInteger(options.debuggingPort) || options.debuggingPort < 1 || options.debuggingPort > 65535) {
    throw new RangeError('debuggingPort must be a TCP port number');
  }
  // Dynamic import is REQUIRED here: Playwright is an optional peer that may
  // not be installed at all (TYPE-ONLY contract, see browser.ts) — a static
  // import would crash every witness start without a browser. Load it only
  // when a browser observation is requested.
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
  /** The app data exchange URL of a network event, or null when irrelevant. */
  const apiExchangeUrl = (raw: string, resourceType: string): URL | null => {
    try {
      const url = new URL(raw);
      return isAppOrigin(url.href) &&
        (url.pathname.startsWith('/api/') || API_RESOURCE_TYPES[resourceType] === true)
        ? url
        : null;
    } catch {
      return null;
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
        const window = state.window;
        // Wait for in-flight app data requests, bounded (fail closed on hang).
        const deadline = Date.now() + ENGINE_PAGE_VISIT_API_SETTLE_TIMEOUT_MS;
        while (window.outstanding.size > 0) {
          if (closed || state.generation !== generation) return;
          const remaining = deadline - Date.now();
          if (remaining <= 0) break;
          const notified = new Promise<void>((resolve) => { window.settleNotify = resolve; });
          if (window.outstanding.size === 0) break;
          let timer: NodeJS.Timeout | undefined;
          try {
            await Promise.race([
              notified,
              new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), remaining); }),
            ]);
          } finally {
            clearTimeout(timer);
          }
        }
        if (closed || state.generation !== generation) return;
        // Bounded response collections (address lookups) land before grading,
        // so no emission ever grades before its responses were collected.
        while (window.pendingResponses.size > 0) {
          if (closed || state.generation !== generation) return;
          await Promise.all([...window.pendingResponses]);
        }
        if (closed || state.generation !== generation) return;
        let url = state.page.url();
        let domMarkerHit = false;
        try {
          const text = await state.page.locator('body').innerText({ timeout: 1_000 });
          domMarkerHit = options.errorMarkers.some((marker) => text.includes(marker));
          url = state.page.url();
          // Proof bookkeeping: record the REAL reading so a later salvage
          // carries an actually observed DOM state instead of a guess.
          window.domMarkerHit = domMarkerHit;
          window.domGraded = true;
        } catch {
          // A destroyed/closing page has no readable settled DOM; page errors remain in the record.
        }
        if (closed || state.generation !== generation) return;
        const visit: ObservedPageVisit = {
          url,
          navigations: [...window.navigations],
          exceptions: [...window.exceptions],
          domMarkerHit,
          apiResponses: [...window.apiResponses],
          apiRequestsSettled: apiRequestsSettled({
            outstandingCount: window.outstanding.size,
            failures: window.failedRequests,
            completions: window.completedRequests,
          }),
        };
        // Evidence is NOT cleared: repeated quiet emissions of the SAME
        // navigation preserve earlier errors and API statuses; only a new
        // navigation boundary opens a fresh window.
        const verdict = gradePageVisit({ pages: options.pages, loginRoutes: options.loginRoutes, visit });
        await options.onVisit(visit, verdict);
        window.emitted = true;
        window.dirty = false;
      })().then(resolveSettlement, rejectSettlement).finally(() => {
        if (state.generation === generation) {
          state.settlePromise = undefined;
          state.settleResolve = undefined;
        }
      });
    }, options.quietMs ?? 300);
  };
  /**
   * Salvages a window a navigation boundary closed before its quiet
   * emission carried everything: emits the accumulated evidence as-is
   * (requests still outstanding count as unsettled — fail closed). The
   * document is already replaced, so its error markers cannot be re-read;
   * the salvage carries the window's last REAL DOM reading instead.
   */
  const finalizeWindow = (state: PageState, window: PageWindow): void => {
    if (!window.dirty) return; // every observation of this window was emitted
    // Fail closed: without a settled DOM marker read there is no honest
    // loads proof to mint for this document, so the window is not salvaged
    // at all — a missing record can never satisfy an obligation.
    if (!window.domGraded) return;
    const finished = (async () => {
      while (window.pendingResponses.size > 0) {
        await Promise.all([...window.pendingResponses]);
      }
      const visit: ObservedPageVisit = {
        url: window.url,
        navigations: [...window.navigations],
        exceptions: [...window.exceptions],
        // The last actually observed DOM state of the replaced document —
        // never a fabricated clean reading.
        domMarkerHit: window.domMarkerHit,
        apiResponses: [...window.apiResponses],
        apiRequestsSettled: apiRequestsSettled({
          outstandingCount: window.outstanding.size,
          failures: window.failedRequests,
          completions: window.completedRequests,
        }),
      };
      const verdict = gradePageVisit({ pages: options.pages, loginRoutes: options.loginRoutes, visit });
      await options.onVisit(visit, verdict);
    })();
    state.pendingFinalizations.add(finished);
    void finished.then(
      () => state.pendingFinalizations.delete(finished),
      () => state.pendingFinalizations.delete(finished),
    );
  };
  const flush = async (): Promise<void> => {
    for (;;) {
      const pending = [...states.values()].flatMap((state) => [
        ...(state.settlePromise === undefined ? [] : [state.settlePromise]),
        ...state.window.pendingResponses,
        ...state.pendingFinalizations,
      ]);
      if (pending.length === 0) return;
      await Promise.all(pending);
    }
  };
  const watch = (page: Page): void => {
    if (states.has(page)) return;
    const state: PageState = {
      page,
      window: {
        url: page.url(),
        navigations: [],
        exceptions: [],
        apiResponses: [],
        outstanding: new Set(),
        settleNotify: undefined,
        failedRequests: [],
        completedRequests: [],
        pendingResponses: new Set(),
        domMarkerHit: false,
        domGraded: false,
        emitted: false,
        dirty: false,
      },
      settleTimer: undefined,
      settlePromise: undefined,
      settleResolve: undefined,
      requestWindows: new Map(),
      pendingFinalizations: new Set(),
      generation: 0,
    };
    states.set(page, state);
    page.on('framenavigated', (frame) => {
      if (frame !== page.mainFrame()) return;
      const url = frame.url();
      const window = state.window;
      if (window.emitted && !sameWindowUrl(window.url, url)) {
        // A genuinely new main-frame navigation after the window has emitted
        // opens a fresh observation window; the old one is finalized so no
        // evidence is lost and requests begun there cannot taint the new page.
        finalizeWindow(state, window);
        state.window = {
          url,
          navigations: [url],
          exceptions: [],
          apiResponses: [],
          outstanding: new Set(),
          settleNotify: undefined,
          failedRequests: [],
          completedRequests: [],
          pendingResponses: new Set(),
          domMarkerHit: false,
          domGraded: false,
          emitted: false,
          dirty: true,
        };
      } else {
        // Redirect/history chain inside the (still unsettled) window: keep
        // the whole chain so bounce refusals keep working.
        window.navigations.push(url);
        window.url = url;
        window.dirty = true;
      }
      settle(state);
    });
    page.on('pageerror', (error) => {
      const window = state.window;
      window.exceptions.push(error.message);
      window.dirty = true;
      settle(state);
    });
    page.on('request', (request) => {
      if (apiExchangeUrl(request.url(), request.resourceType()) === null) return;
      const window = state.window;
      window.outstanding.add(request);
      state.requestWindows.set(request, window);
      window.dirty = true;
      settle(state);
    });
    page.on('requestfailed', (request) => {
      // The request belongs to the window that captured it at request start,
      // never to whatever navigation is current when the failure lands.
      const window = state.requestWindows.get(request) ?? state.window;
      if (!window.outstanding.delete(request)) return;
      state.requestWindows.delete(request);
      // A failed app data request can never produce a verifiable response;
      // whether it leaves the window unsettled is decided at grading time
      // (a client-side cancel superseded by a completed same-URL request
      // may still count as settled).
      window.failedRequests.push({ method: request.method(), url: request.url(), errorText: request.failure()?.errorText ?? '' });
      window.dirty = true;
      if (window.outstanding.size === 0) window.settleNotify?.();
      settle(state);
    });
    page.on('requestfinished', (request) => {
      // The request lifecycle ends at body completion (or failure), never at
      // response headers: a 200 whose body later dies must stay unsettled.
      const window = state.requestWindows.get(request);
      if (window === undefined) return;
      state.requestWindows.delete(request);
      window.outstanding.delete(request);
      window.completedRequests.push({ method: request.method(), url: request.url() });
      if (window.outstanding.size === 0) window.settleNotify?.();
      // Body completion lets body-driven JS/DOM/next fetches run; the same
      // quiet window restarts before any emission grades them.
      settle(state);
    });
    page.on('response', (response) => {
      const url = response.url();
      if (apiExchangeUrl(url, response.request().resourceType()) === null) return;
      // The response belongs to the window that captured its request at
      // request start. Headers only: collect status/address here; the
      // request stays outstanding until requestfinished/requestfailed.
      const window = state.requestWindows.get(response.request()) ?? state.window;
      // Abort any in-flight emission so it cannot grade before this response
      // is collected; the quiet window restarts.
      settle(state);
      const pending = (async () => {
        let remoteAddress: string | null = null;
        let timeout: NodeJS.Timeout | undefined;
        try {
          remoteAddress = await Promise.race([
            response.serverAddr().then((address) => address?.ipAddress ?? null),
            new Promise<null>((resolve) => {
              timeout = setTimeout(() => resolve(null), ENGINE_PAGE_VISIT_ADDRESS_TIMEOUT_MS);
            }),
          ]);
        } catch {
          // Missing address is a refusal, not a reason to lose the observation.
        } finally {
          clearTimeout(timeout);
        }
        window.apiResponses.push({
          url,
          status: response.status(),
          remoteAddress,
          proxied: options.isProxiedExchange(url, response.status()),
        });
        window.dirty = true;
        settle(state);
      })();
      window.pendingResponses.add(pending);
      void pending.then(
        () => window.pendingResponses.delete(pending),
        () => window.pendingResponses.delete(pending),
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
