import { describe, expect, it } from 'vitest';
import { gradePageVisit, matchPageRoute } from '../src/witness/page-observation.js';

const pages = [{ id: 'tenant.page-orders', path: '/orders/:id' }];
const clean = {
  url: 'http://127.0.0.1:47013/orders/42',
  navigations: [],
  exceptions: [],
  domMarkerHit: false,
  apiResponses: [{ url: 'http://127.0.0.1:47013/api/orders/42', status: 200, remoteAddress: '127.0.0.1', proxied: true }],
};

describe('page observation grading', () => {
  it('matches parameterized routes', () => {
    expect(matchPageRoute('/orders/:id', '/orders/42')).toBe(true);
    expect(matchPageRoute('/orders/:id', '/orders/42/items')).toBe(false);
  });

  it('satisfies both obligations for a clean visit', () => {
    expect(gradePageVisit({ pages, visit: clean })).toMatchObject({
      pageId: 'tenant.page-orders',
      loads: { satisfied: true, refusalReasons: [] },
      dataOk: { satisfied: true, refusalReasons: [] },
    });
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
});
