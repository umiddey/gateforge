/** Pure route matching and grading for browser-observed page visits. */

export interface PageRoute {
  id: string;
  path: string;
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
}

export type PageRefusalReason =
  | 'PAGE_ROUTE_UNMATCHED'
  | 'PAGE_BOUNCED_TO_LOGIN'
  | 'PAGE_UNCAUGHT_EXCEPTION'
  | 'PAGE_ERROR_MARKER'
  | 'PAGE_API_ERROR'
  | 'PAGE_LOCALLY_FULFILLED';

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

/** Grade one settled visit using only witness-collected browser observations. */
export function gradePageVisit(input: {
  pages: readonly PageRoute[];
  loginRoutes?: readonly string[];
  visit: ObservedPageVisit;
}): PageVisitVerdict {
  const { visit } = input;
  const navigatedPaths = [...visit.navigations, visit.url].map(pathname).filter((value): value is string => value !== null);
  const loginPaths = (input.loginRoutes ?? []).map(pathname).filter((value): value is string => value !== null);
  const bounced = loginPaths.some((loginPath) => navigatedPaths.includes(loginPath));
  let page: PageRoute | undefined;
  for (const url of [...visit.navigations, visit.url].reverse()) {
    if (loginPaths.includes(pathname(url) ?? '')) continue;
    page = input.pages.find(({ path }) => matchPageRoute(path, url));
    if (page !== undefined) break;
  }
  const loadsReasons: PageRefusalReason[] = [];
  if (page === undefined) loadsReasons.push('PAGE_ROUTE_UNMATCHED');
  if (bounced) loadsReasons.push('PAGE_BOUNCED_TO_LOGIN');
  if (visit.exceptions.length > 0) loadsReasons.push('PAGE_UNCAUGHT_EXCEPTION');
  if (visit.domMarkerHit) loadsReasons.push('PAGE_ERROR_MARKER');
  const dataReasons: PageRefusalReason[] = [];
  for (const response of visit.apiResponses) {
    if (response.remoteAddress === null || !response.proxied) dataReasons.push('PAGE_LOCALLY_FULFILLED');
    else if (response.status >= 400) dataReasons.push('PAGE_API_ERROR');
  }
  return {
    pageId: page?.id ?? null,
    finalUrl: visit.url,
    loads: { satisfied: loadsReasons.length === 0, refusalReasons: [...new Set(loadsReasons)] },
    dataOk: { satisfied: dataReasons.length === 0, refusalReasons: [...new Set(dataReasons)] },
  };
}

/** Browser-backed observer attached to an existing Chromium debugging port. */
