/** Pure route matching and grading for browser-observed page visits. */

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
    url: string;
    status: number;
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

export type PageRefusalReason =
  | 'PAGE_ROUTE_UNMATCHED'
  | 'PAGE_BOUNCED_TO_LOGIN'
  | 'PAGE_UNCAUGHT_EXCEPTION'
  | 'PAGE_ERROR_MARKER'
  | 'PAGE_API_ERROR'
  | 'PAGE_LOCALLY_FULFILLED'
  | 'PAGE_API_UNSETTLED'
  | 'PAGE_APP_ORIGIN_MISMATCH';

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
