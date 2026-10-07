import { describe, expect, it } from 'vitest';
import {
  apiErrorDetailOf,
  gradePageVisit,
  landedLoginRoute,
  matchPageRoute,
  unsettledRequestsOf,
} from '../src/witness/page-observation.js';

const pages = [{ id: 'tenant.page-orders', path: '/orders/:id' }];
const clean = {
  url: 'http://127.0.0.1:47013/orders/42',
  navigations: [],
  exceptions: [],
  domMarkerHit: false,
  apiResponses: [{ method: 'GET', url: 'http://127.0.0.1:47013/api/orders/42', status: 200, remoteAddress: '127.0.0.1', proxied: true }],
  apiRequestsSettled: true,
  unsettledRequests: [],
  liveChannels: { count: 0, paths: [] },
};

describe('page observation grading', () => {
  it('matches parameterized routes', () => {
    expect(matchPageRoute('/orders/:id', '/orders/42')).toBe(true);
    expect(matchPageRoute('/orders/:id', '/orders/42/items')).toBe(false);
  });

  describe('landedLoginRoute', () => {
    it('names the login route a bounced visit landed on', () => {
      expect(landedLoginRoute('http://127.0.0.1:47013/login?next=/orders', '/orders', ['/login'])).toBe('/login');
    });

    it('never counts a directly opened declared login page as a rejection', () => {
      expect(landedLoginRoute('http://127.0.0.1:47013/login', '/login', ['/login'])).toBeNull();
    });

    it('returns null when the final URL is no declared login route', () => {
      expect(landedLoginRoute('http://127.0.0.1:47013/orders/42', '/orders/42', ['/login'])).toBeNull();
      expect(landedLoginRoute('http://127.0.0.1:47013/signin', '/orders', ['/login'])).toBeNull();
    });

    it('normalizes trailing slashes and query strings', () => {
      expect(landedLoginRoute('http://127.0.0.1:47013/login/?next=/orders', '/orders', ['/login/'])).toBe('/login/');
    });
  });

  it('satisfies both obligations for a clean visit', () => {
    expect(gradePageVisit({ pages, visit: clean })).toMatchObject({
      pageId: 'tenant.page-orders',
      loads: { satisfied: true, refusalReasons: [] },
      dataOk: { satisfied: true, refusalReasons: [] },
    });
  });

  it('does not credit a transient declared route when the settled URL is unmatched', () => {
    const verdict = gradePageVisit({
      pages,
      visit: { ...clean, url: 'http://127.0.0.1/unlisted', navigations: ['/orders/42', '/unlisted'] },
    });
    expect(verdict.pageId).toBe('tenant.page-orders');
    expect(verdict.loads.satisfied).toBe(false);
    expect(verdict.loads.refusalReasons).toContain('PAGE_ROUTE_UNMATCHED');
  });

  it('refuses a login bounce, uncaught exception, and error marker for page loads', () => {
    expect(gradePageVisit({ pages, loginRoutes: ['/login'], visit: { ...clean, url: 'http://127.0.0.1/login', navigations: ['/orders/42', '/login'] } }).loads.refusalReasons).toContain('PAGE_BOUNCED_TO_LOGIN');
    expect(gradePageVisit({ pages, visit: { ...clean, exceptions: ['Error: render crashed'] } }).loads.refusalReasons).toContain('PAGE_UNCAUGHT_EXCEPTION');
    expect(gradePageVisit({ pages, visit: { ...clean, domMarkerHit: true } }).loads.refusalReasons).toContain('PAGE_ERROR_MARKER');
  });

  it('refuses an API error for data-ok only', () => {
    const verdict = gradePageVisit({ pages, visit: { ...clean, apiResponses: [{ ...clean.apiResponses[0]!, status: 500 }] } });
    expect(verdict.loads.satisfied).toBe(true);
    expect(verdict.dataOk.refusalReasons).toContain('PAGE_API_ERROR');
  });

  it('refuses app responses without a remote address or matching proxy exchange', () => {
    const apiResponse = clean.apiResponses[0]!;
    const locallyFulfilled = gradePageVisit({
      pages,
      visit: { ...clean, apiResponses: [{ ...apiResponse, remoteAddress: null, proxied: true }] },
    });
    expect(locallyFulfilled.loads.refusalReasons).toContain('PAGE_LOCALLY_FULFILLED');
    expect(locallyFulfilled.dataOk.refusalReasons).toContain('PAGE_LOCALLY_FULFILLED');

    const unproxied = gradePageVisit({
      pages,
      visit: { ...clean, apiResponses: [{ ...apiResponse, remoteAddress: '127.0.0.1', proxied: false }] },
    });
    expect(unproxied.loads.refusalReasons).toContain('PAGE_LOCALLY_FULFILLED');
    expect(unproxied.dataOk.refusalReasons).toContain('PAGE_LOCALLY_FULFILLED');
  });

  it('refuses an unsettled visit on both promises', () => {
    const verdict = gradePageVisit({ pages, visit: { ...clean, apiRequestsSettled: false } });
    expect(verdict.loads.satisfied).toBe(false);
    expect(verdict.loads.refusalReasons).toContain('PAGE_API_UNSETTLED');
    expect(verdict.dataOk.satisfied).toBe(false);
    expect(verdict.dataOk.refusalReasons).toContain('PAGE_API_UNSETTLED');
  });

  it('never credits clean API evidence while the request set is unsettled', () => {
    const verdict = gradePageVisit({
      pages,
      visit: { ...clean, apiRequestsSettled: undefined as unknown as boolean },
    });
    expect(verdict.loads.refusalReasons).toContain('PAGE_API_UNSETTLED');
    expect(verdict.dataOk.refusalReasons).toContain('PAGE_API_UNSETTLED');
  });

  it('a visit whose only open exchange is a declared live channel satisfies both promises', () => {
    // The channel never grades a live-channel exchange as app data: the
    // open long poll is LISTED (liveChannels) and absent from
    // apiResponses, so a page holding a live connection grades clean
    // once everything else settled.
    const verdict = gradePageVisit({
      pages,
      visit: {
        ...clean,
        apiResponses: [],
        liveChannels: { count: 1, paths: ['/live/poll'] },
      },
    });
    expect(verdict.loads.satisfied).toBe(true);
    expect(verdict.dataOk.satisfied).toBe(true);
    expect(verdict.loads.refusalReasons).toEqual([]);
    expect(verdict.dataOk.refusalReasons).toEqual([]);
  });

  it('a non-declared open exchange still refuses both promises as unsettled', () => {
    const verdict = gradePageVisit({
      pages,
      visit: { ...clean, apiResponses: [], apiRequestsSettled: false },
    });
    expect(verdict.loads.satisfied).toBe(false);
    expect(verdict.loads.refusalReasons).toContain('PAGE_API_UNSETTLED');
    expect(verdict.dataOk.satisfied).toBe(false);
    expect(verdict.dataOk.refusalReasons).toContain('PAGE_API_UNSETTLED');
  });
});

describe('anonymous pages of audiences without a login', () => {
  const base = 'http://127.0.0.1';
  const anonymousPages = [{ id: 'global.page-terms', path: '/terms', anonymous: true }];
  const api401 = { method: 'GET', url: `${base}/api/me`, status: 401, remoteAddress: '127.0.0.1', proxied: true };

  it('accepts exactly 401 as the expected not-logged-in answer', () => {
    const resolved = gradePageVisit({
      pages: anonymousPages,
      visit: { ...clean, url: `${base}/terms`, apiResponses: [{ ...api401 }] },
    });
    expect(resolved.pageId).toBe('global.page-terms');
    expect(resolved.loads.satisfied).toBe(true);
    expect(resolved.dataOk.satisfied).toBe(true);
    expect(resolved.dataOk.refusalReasons).toEqual([]);
    const expected = gradePageVisit({
      pages: anonymousPages,
      expectedPage: anonymousPages[0],
      visit: { ...clean, url: `${base}/terms`, apiResponses: [{ ...api401 }] },
    });
    expect(expected.pageId).toBe('global.page-terms');
    expect(expected.dataOk.satisfied).toBe(true);
    expect(expected.dataOk.refusalReasons).toEqual([]);
  });

  it('still refuses a 403 and every other error status on an anonymous page', () => {
    for (const status of [403, 500]) {
      const verdict = gradePageVisit({
        pages: anonymousPages,
        visit: { ...clean, url: `${base}/terms`, apiResponses: [{ ...api401, status }] },
      });
      expect(verdict.dataOk.satisfied).toBe(false);
      expect(verdict.dataOk.refusalReasons).toContain('PAGE_API_ERROR');
    }
  });

  it('still refuses a 401 on a page whose audience has a login', () => {
    const verdict = gradePageVisit({
      pages: [{ id: 'tenant.page-secret', path: '/terms' }],
      visit: { ...clean, url: `${base}/terms`, apiResponses: [{ ...api401 }] },
    });
    expect(verdict.pageId).toBe('tenant.page-secret');
    expect(verdict.dataOk.satisfied).toBe(false);
    expect(verdict.dataOk.refusalReasons).toEqual(['PAGE_API_ERROR']);
  });
});

describe('public login pages and expected-page grading', () => {
  const loginPages = [...pages, { id: 'global.page-login', path: '/login' }];
  const secretPage = { id: 'tenant.page-secret', path: '/secret' };
  const base = 'http://127.0.0.1';

  it('credits a directly opened declared login page', () => {
    const verdict = gradePageVisit({
      pages: loginPages,
      loginRoutes: ['/login'],
      visit: { ...clean, url: `${base}/login`, navigations: [] },
    });
    expect(verdict.pageId).toBe('global.page-login');
    expect(verdict.loads).toEqual({ satisfied: true, refusalReasons: [] });
  });

  it('credits an expected targeted login page', () => {
    const verdict = gradePageVisit({
      pages: loginPages,
      expectedPage: { id: 'global.page-login', path: '/login' },
      loginRoutes: ['/login'],
      visit: { ...clean, url: `${base}/login`, navigations: [] },
    });
    expect(verdict.pageId).toBe('global.page-login');
    expect(verdict.loads).toEqual({ satisfied: true, refusalReasons: [] });
  });

  it('refuses an expected protected page a pure HTTP redirect landed on login', () => {
    const verdict = gradePageVisit({
      pages: loginPages,
      expectedPage: secretPage,
      loginRoutes: ['/login'],
      visit: { ...clean, url: `${base}/login`, navigations: [] },
    });
    expect(verdict.pageId).toBe('tenant.page-secret');
    expect(verdict.loads.satisfied).toBe(false);
    expect(verdict.loads.refusalReasons).toContain('PAGE_BOUNCED_TO_LOGIN');
  });

  it('refuses an expected protected page a SPA redirect landed on login', () => {
    const verdict = gradePageVisit({
      pages: loginPages,
      expectedPage: secretPage,
      loginRoutes: ['/login'],
      visit: { ...clean, url: `${base}/login`, navigations: [`${base}/secret`, `${base}/login`] },
    });
    expect(verdict.pageId).toBe('tenant.page-secret');
    expect(verdict.loads.satisfied).toBe(false);
    expect(verdict.loads.refusalReasons).toContain('PAGE_BOUNCED_TO_LOGIN');
  });

  it('refuses an expected page that settled on an unrelated declared page', () => {
    const verdict = gradePageVisit({
      pages: loginPages,
      expectedPage: secretPage,
      loginRoutes: ['/login'],
      visit: { ...clean, url: `${base}/orders/42`, navigations: [] },
    });
    expect(verdict.pageId).toBe('tenant.page-secret');
    expect(verdict.loads.satisfied).toBe(false);
    expect(verdict.loads.refusalReasons).toContain('PAGE_ROUTE_UNMATCHED');
    expect(verdict.loads.refusalReasons).not.toContain('PAGE_BOUNCED_TO_LOGIN');
  });

  it('keeps an undeclared login page fail closed', () => {
    const verdict = gradePageVisit({
      pages,
      loginRoutes: ['/login'],
      visit: { ...clean, url: `${base}/login`, navigations: [] },
    });
    expect(verdict.pageId).toBeNull();
    expect(verdict.loads.satisfied).toBe(false);
    expect(verdict.loads.refusalReasons).toContain('PAGE_ROUTE_UNMATCHED');
    expect(verdict.loads.refusalReasons).toContain('PAGE_BOUNCED_TO_LOGIN');
  });

  it('attributes a bounce to the matched protected page without an expected page', () => {
    const verdict = gradePageVisit({
      pages: [secretPage, { id: 'global.page-login', path: '/login' }],
      loginRoutes: ['/login'],
      visit: { ...clean, url: `${base}/login`, navigations: [`${base}/secret`] },
    });
    expect(verdict.pageId).toBe('tenant.page-secret');
    expect(verdict.loads.satisfied).toBe(false);
    expect(verdict.loads.refusalReasons).toContain('PAGE_BOUNCED_TO_LOGIN');
  });

  it('keeps crash, error marker, and API refusals for expected pages', () => {
    const crashed = gradePageVisit({
      pages: loginPages,
      expectedPage: secretPage,
      loginRoutes: ['/login'],
      visit: { ...clean, url: `${base}/secret`, exceptions: ['Error: render crashed'] },
    });
    expect(crashed.pageId).toBe('tenant.page-secret');
    expect(crashed.loads.satisfied).toBe(false);
    expect(crashed.loads.refusalReasons).toContain('PAGE_UNCAUGHT_EXCEPTION');

    const marked = gradePageVisit({
      pages: loginPages,
      expectedPage: secretPage,
      loginRoutes: ['/login'],
      visit: { ...clean, url: `${base}/secret`, domMarkerHit: true },
    });
    expect(marked.loads.refusalReasons).toContain('PAGE_ERROR_MARKER');

    const apiError = gradePageVisit({
      pages: loginPages,
      expectedPage: secretPage,
      loginRoutes: ['/login'],
      visit: { ...clean, url: `${base}/secret`, apiResponses: [{ ...clean.apiResponses[0]!, status: 500 }] },
    });
    expect(apiError.loads.satisfied).toBe(true);
    expect(apiError.dataOk.refusalReasons).toContain('PAGE_API_ERROR');

    const crashedLogin = gradePageVisit({
      pages: loginPages,
      expectedPage: { id: 'global.page-login', path: '/login' },
      loginRoutes: ['/login'],
      visit: { ...clean, url: `${base}/login`, exceptions: ['Error: login crashed'] },
    });
    expect(crashedLogin.loads.satisfied).toBe(false);
    expect(crashedLogin.loads.refusalReasons).toContain('PAGE_UNCAUGHT_EXCEPTION');
  });
});

describe('unsettledRequestsOf — naming the requests that left a visit unsettled', () => {
  it('lists un-superseded failures, then open requests, capped at five, without query', () => {
    expect(unsettledRequestsOf({
      outstanding: [
        { method: 'POST', url: 'http://127.0.0.1:13001/api/x?token=1' },
        { method: 'GET', url: 'http://127.0.0.1:13001/api/6' },
        { method: 'GET', url: 'http://127.0.0.1:13001/api/7' },
        { method: 'GET', url: 'http://127.0.0.1:13001/api/8' },
        { method: 'GET', url: 'http://127.0.0.1:13001/api/9' },
        { method: 'GET', url: 'http://127.0.0.1:13001/api/10' },
      ],
      failures: [
        // Superseded exactly as apiRequestsSettled forgives it: never named.
        { method: 'GET', url: 'http://127.0.0.1:13001/api/gone', errorText: 'net::ERR_ABORTED' },
        { method: 'GET', url: 'http://127.0.0.1:13001/api/aborted', errorText: 'net::ERR_ABORTED' },
        { method: 'GET', url: 'http://127.0.0.1:13001/api/dead', errorText: 'net::ERR_EMPTY_RESPONSE' },
      ],
      completions: [{ method: 'GET', url: 'http://127.0.0.1:13001/api/gone' }],
    })).toEqual([
      { method: 'GET', url: '/api/aborted', errorText: 'net::ERR_ABORTED' },
      { method: 'GET', url: '/api/dead', errorText: 'net::ERR_EMPTY_RESPONSE' },
      { method: 'POST', url: '/api/x', errorText: 'outstanding' },
      { method: 'GET', url: '/api/6', errorText: 'outstanding' },
      { method: 'GET', url: '/api/7', errorText: 'outstanding' },
    ]);
  });

  it('collects nothing when every failure was superseded and nothing stayed open', () => {
    expect(unsettledRequestsOf({
      outstanding: [],
      failures: [{ method: 'GET', url: 'http://127.0.0.1:13001/api/a', errorText: 'net::ERR_ABORTED' }],
      completions: [{ method: 'GET', url: 'http://127.0.0.1:13001/api/a' }],
    })).toEqual([]);
  });
});

describe('apiErrorDetailOf — naming the response that refused data-ok', () => {
  const responses = [
    { method: 'GET', url: 'http://127.0.0.1:13001/api/me', status: 401 },
    { method: 'POST', url: 'http://127.0.0.1:13001/api/orders', status: 500 },
    { method: 'GET', url: 'http://127.0.0.1:13001/api/y', status: 503 },
  ];

  it('names the first refusing response as METHOD path -> status', () => {
    expect(apiErrorDetailOf(responses, false)).toBe('GET /api/me -> 401');
  });

  it('skips the anonymous-401 exemption exactly like the grader', () => {
    expect(apiErrorDetailOf(responses, true)).toBe('POST /api/orders -> 500');
  });

  it('returns null when no response refused', () => {
    expect(apiErrorDetailOf([{ method: 'GET', url: 'http://app/api/ok', status: 200 }], false)).toBeNull();
  });
});
