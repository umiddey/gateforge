/** Pure route matching and grading for browser-observed page visits. */
import type { LiveChannelSnapshot } from './page-live-channels.js';

export interface PageRoute {
  id: string;
  path: string;
  /**
   * True only when the page's audience declares NO login (no `session` in
   * the `.gateforge.yml` `pages.audiences` entry): on such a page an app
   * data answer of exactly 401 IS the expected not-logged-in answer and
   * does not refuse `dataOk`. Controller-held — derived from the config
   * audience table, never supplied by the suite.
   */
  anonymous?: boolean;
}

export interface ObservedPageVisit {
  url: string;
  navigations: string[];
  exceptions: string[];
  domMarkerHit: boolean;
  apiResponses: Array<{
    method: string;
    url: string;
    status: number;
    fetchDest?: string | null;
    remoteAddress: string | null;
    proxied: boolean;
  }>;
  /**
   * True only when every tracked app data request of the visit settled
   * (response collected or request failed without ambiguity), where a
   * failure counts as settled only when it was a client-side cancel
   * superseded by a completed same-method/full-URL request (see
   * {@link apiRequestsSettled}). A visit graded while requests were in
   * flight must never read as settled.
   */
  apiRequestsSettled: boolean;
  /**
   * The requests that left the app data set unsettled, named for the
   * refusal diagnosis (`unsettledRequestsOf`): un-superseded failures
   * with their browser error text, then still-open requests as
   * `outstanding`, capped at five. Empty for a settled visit.
   */
  unsettledRequests: UnsettledRequest[];
  /**
   * The declared/protocol live channels the visit kept open (a
   * controller-declared path prefix, an app-host WebSocket upgrade, a
   * `text/event-stream` response). They never count as app data
   * evidence and never hold the settle wait; they are listed instead.
   */
  liveChannels: LiveChannelSnapshot;
}

/** One tracked app data request that failed without completing. */
export interface ObservedApiRequestFailure {
  method: string;
  url: string;
  errorText: string;
}

/** One tracked app data request that reached requestfinished. */
export interface ObservedApiRequestCompletion {
  method: string;
  url: string;
}

/**
 * Grades a visit's tracked app data request set as settled: no request is
 * still outstanding, and every failure is a client-side cancel
 * (`net::ERR_ABORTED`) that a completed request with the same method and
 * the same full URL (origin+path+query) superseded within the same visit.
 * Evaluated at grading time, so the superseding request may start before
 * or after the abort. Any other failure text (connection refused, empty
 * response, dead body, ...), or an unretried cancel, stays unsettled.
 */
export function apiRequestsSettled(input: {
  outstandingCount: number;
  failures: readonly ObservedApiRequestFailure[];
  completions: readonly ObservedApiRequestCompletion[];
}): boolean {
  if (input.outstandingCount !== 0) return false;
  const completed = new Set(input.completions.map(({ method, url }) => `${method} ${url}`));
  return input.failures.every((failure) =>
    failure.errorText === 'net::ERR_ABORTED' && completed.has(`${failure.method} ${failure.url}`),
  );
}

/** One request a visit could not settle, as the evidence names it. */
export interface UnsettledRequest {
  method: string;
  /** Path without query — every tracked app data call is same-origin. */
  url: string;
  /** The browser failure text, or `outstanding` for a still-open request. */
  errorText: string;
}

/** How many culprits the diagnosis carries before it stops listing. */
const UNSETTLED_REQUESTS_CAP = 5;

/**
 * Names the requests that left a visit's app data set unsettled, with the
 * SAME settled rule {@link apiRequestsSettled} grades by: every failure
 * that did NOT count as settled (an abort counts only when a completed
 * same-method/full-URL request superseded it) keeps its real browser
 * error text, and every request still open at grading time is listed as
 * `outstanding`. Capped at five, urls without their query — this is the
 * one-line "which request hung?" answer, not a transcript.
 *
 * Args:
 *   input.outstanding: the requests still open at grading time.
 *   input.failures: the requests that failed without completing.
 *   input.completions: the requests that reached completion.
 *
 * Returns:
 *   UnsettledRequest[]: at most five entries; failures first.
 */
export function unsettledRequestsOf(input: {
  outstanding: readonly { method: string; url: string }[];
  failures: readonly ObservedApiRequestFailure[];
  completions: readonly ObservedApiRequestCompletion[];
}): UnsettledRequest[] {
  const completed = new Set(input.completions.map(({ method, url }) => `${method} ${url}`));
  const withoutQuery = (url: string): string => {
    try {
      return new URL(url).pathname;
    } catch {
      return url;
    }
  };
  return [
    ...input.failures
      .filter((failure) => !(failure.errorText === 'net::ERR_ABORTED' && completed.has(`${failure.method} ${failure.url}`)))
      .map(({ method, url, errorText }) => ({ method, url: withoutQuery(url), errorText })),
    ...input.outstanding.map(({ method, url }) => ({ method, url: withoutQuery(url), errorText: 'outstanding' })),
  ].slice(0, UNSETTLED_REQUESTS_CAP);
}

/**
 * The response that refused data-ok with PAGE_API_ERROR, as one
 * `METHOD path -> status` line, or null. The anonymous-401 exemption is
 * the grader's own ({@link gradePageVisit}): on a page whose audience
 * declares no login, a 401 is the expected not-logged-in answer and is
 * not the refusing response.
 *
 * Args:
 *   responses: the visit's collected app data responses.
 *   anonymous: the page's anonymous flag (audience without login).
 *
 * Returns:
 *   string | null: the first refusing response, or null.
 */
export function apiErrorDetailOf(
  responses: ReadonlyArray<{ method: string; url: string; status: number }>,
  anonymous: boolean,
): string | null {
  for (const response of responses) {
    if (response.status < 400) continue;
    if (response.status === 401 && anonymous) continue;
    let path = response.url;
    try {
      path = new URL(response.url).pathname;
    } catch {
      // Keep the raw text when the url does not parse.
    }
    return `${response.method} ${path} -> ${String(response.status)}`;
  }
  return null;
}

export type PageRefusalReason =
  | 'PAGE_ROUTE_UNMATCHED'
  | 'PAGE_BOUNCED_TO_LOGIN'
  | 'PAGE_UNCAUGHT_EXCEPTION'
  | 'PAGE_ERROR_MARKER'
  | 'PAGE_API_ERROR'
  | 'PAGE_LOCALLY_FULFILLED'
  | 'PAGE_API_UNSETTLED'
  | 'PAGE_APP_ORIGIN_MISMATCH'
  | 'PAGE_AUDIENCE_SESSION_INVALID';

export interface PageVisitVerdict {
  pageId: string | null;
  finalUrl: string;
  loads: { satisfied: boolean; refusalReasons: PageRefusalReason[] };
  dataOk: { satisfied: boolean; refusalReasons: PageRefusalReason[] };
}

function pathname(raw: string): string | null {
  try {
    return new URL(raw, 'http://gateforge.invalid').pathname.replace(/\/+$/, '') || '/';
  } catch {
    return null;
  }
}

/** Match an absolute route template, where each `:name` consumes one segment. */
export function matchPageRoute(routePath: string, rawUrl: string): boolean {
  const actual = pathname(rawUrl);
  const expected = pathname(routePath);
  if (actual === null || expected === null) return false;
  const templateParts = expected.split('/').filter(Boolean);
  const actualParts = actual.split('/').filter(Boolean);
  return templateParts.length === actualParts.length && templateParts.every((part, index) =>
    part.startsWith(':') ? actualParts[index] !== '' : part === actualParts[index],
  );
}

/**
 * The declared login route a visit landed on, or null. A visit whose
 * REQUESTED route is itself a declared login page never counts: a
 * directly opened declared login page is a legitimate public page, only
 * a bounced protected navigation is a rejected session.
 */
export function landedLoginRoute(
  finalUrl: string,
  requestedPath: string,
  loginRoutes: readonly string[],
): string | null {
  const finalPath = pathname(finalUrl);
  if (finalPath === null) return null;
  const matched = loginRoutes.find((route) => pathname(route) === finalPath);
  if (matched === undefined) return null;
  const requested = pathname(requestedPath);
  if (requested !== null && loginRoutes.some((route) => pathname(route) === requested)) return null;
  return matched;
}

/**
 * Grade one settled visit using only witness-collected browser observations.
 *
 * `expectedPage` grades the visit against the one configured page the driver
 * deliberately requested: the settled URL must be that page, so a redirect to
 * a login route or to any other page refuses the expected page under its own
 * id instead of matching an incidental route. Without it the visit is
 * attributed to the last opened declared page, where a directly opened
 * declared login page counts as a legitimate public page while a bounced
 * protected navigation never does.
 */
export function gradePageVisit(input: {
  pages: readonly PageRoute[];
  expectedPage?: PageRoute;
  loginRoutes?: readonly string[];
  visit: ObservedPageVisit;
}): PageVisitVerdict {
  const { visit } = input;
  const urls = [...visit.navigations, visit.url];
  const navigatedPaths = urls.map(pathname).filter((value): value is string => value !== null);
  const loginPaths = (input.loginRoutes ?? []).map(pathname).filter((value): value is string => value !== null);
  const observedLogin = loginPaths.some((loginPath) => navigatedPaths.includes(loginPath));
  let page: PageRoute | undefined;
  if (input.expectedPage !== undefined) {
    page = input.expectedPage;
  } else {
    for (const url of [...urls].reverse()) {
      if (loginPaths.includes(pathname(url) ?? '')) continue;
      page = input.pages.find(({ path }) => matchPageRoute(path, url));
      if (page !== undefined) break;
    }
    // A declared login page reached without any other requested page is a
    // legitimate public page; after a bounced protected navigation it is not.
    if (page === undefined && navigatedPaths.length > 0 && navigatedPaths.every((value) => loginPaths.includes(value))) {
      for (const url of [...urls].reverse()) {
        page = input.pages.find(({ path }) => matchPageRoute(path, url));
        if (page !== undefined) break;
      }
    }
  }
  const routeMatched = page !== undefined && matchPageRoute(page.path, visit.url);
  const pageIsLoginRoute = page !== undefined && loginPaths.includes(pathname(page.path) ?? '');
  const bounced = observedLogin && !pageIsLoginRoute;
  const loadsReasons: PageRefusalReason[] = [];
  if (!routeMatched) loadsReasons.push('PAGE_ROUTE_UNMATCHED');
  if (bounced) loadsReasons.push('PAGE_BOUNCED_TO_LOGIN');
  if (visit.exceptions.length > 0) loadsReasons.push('PAGE_UNCAUGHT_EXCEPTION');
  if (visit.domMarkerHit) loadsReasons.push('PAGE_ERROR_MARKER');
  const dataReasons: PageRefusalReason[] = [];
  // An observation whose app request set did not settle (a request failed
  // or a bounded wait expired) is unverifiable: both promises refuse with
  // the typed unsettled reason, never a fabricated JS exception.
  if (visit.apiRequestsSettled !== true) {
    loadsReasons.push('PAGE_API_UNSETTLED');
    dataReasons.push('PAGE_API_UNSETTLED');
  }
  for (const response of visit.apiResponses) {
    if (response.remoteAddress === null || !response.proxied) {
      loadsReasons.push('PAGE_LOCALLY_FULFILLED');
      dataReasons.push('PAGE_LOCALLY_FULFILLED');
    } else if (
      response.status >= 400 &&
      // Owner decision (0.13): on a page whose audience has NO login
      // configured, an app data answer of exactly 401 IS the expected
      // not-logged-in answer. Every other >= 400 status, and 401 on a
      // page whose audience HAS a login, still refuses — as does a 401
      // on an unresolved page (`page` undefined fails closed).
      !(response.status === 401 && page?.anonymous === true)
    ) {
      dataReasons.push('PAGE_API_ERROR');
    }
  }
  return {
    pageId: page?.id ?? null,
    finalUrl: visit.url,
    loads: { satisfied: loadsReasons.length === 0, refusalReasons: [...new Set(loadsReasons)] },
    dataOk: { satisfied: dataReasons.length === 0, refusalReasons: [...new Set(dataReasons)] },
  };
}

/** Browser-backed observer attached to an existing Chromium debugging port. */
