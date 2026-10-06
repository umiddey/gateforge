import type { ServerResponse } from 'node:http';
import type { SessionPageObserverRequest } from './types.js';
import { driveEngineVisit, type EngineBrowserManager } from './browser.js';
import { observePageBrowser, type PageObserver } from './page-observer.js';
import type { PageRoute, PageVisitVerdict } from './page-observation.js';
export interface PageObserverRegistrationState {
  pageObservers: Map<string, PageObserver>;
  pageObservationRecords: Map<string, string[]>;
  observed: Array<{ seq: number; sessionId: string | null; path: string; status: number }>;
}

export class PageObserverRegistrationError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'PageObserverRegistrationError';
  }
}

export async function registerPageObserver(input: {
  state: PageObserverRegistrationState;
  response: ServerResponse;
  body: SessionPageObserverRequest;
  requireSession(body: Record<string, unknown>): { sessionId: string; testId: string; activity: number };
  issueRecord(obligationId: string, testId: string, payload: unknown): string;
}): Promise<void> {
  const { state, body } = input;
  const session = input.requireSession(body as unknown as Record<string, unknown>);
  if (body.testId !== session.testId) throw new PageObserverRegistrationError('page observer test identity does not match its session', 403);
  if (!Number.isInteger(body.debuggingPort) || body.debuggingPort < 1 || body.debuggingPort > 65535) {
    throw new PageObserverRegistrationError('page observer debuggingPort must be a valid TCP port', 400);
  }
  if (!Array.isArray(body.pages) || body.pages.some((page) =>
    typeof page.id !== 'string' || page.id.length === 0 || page.id.includes(':') ||
    typeof page.path !== 'string' || !page.path.startsWith('/'),
  )) throw new PageObserverRegistrationError('page observer requires a valid page route table', 400);
  if (!Array.isArray(body.loginRoutes) || body.loginRoutes.some((path) => typeof path !== 'string' || !path.startsWith('/')) ||
    !Array.isArray(body.errorMarkers) || body.errorMarkers.some((marker) => typeof marker !== 'string' || marker.length === 0) ||
    !Array.isArray(body.appOrigins) || body.appOrigins.some((origin) => {
      try { return new URL(origin).origin !== origin; } catch { return true; }
    })) {
    throw new PageObserverRegistrationError('page observer configuration is invalid', 400);
  }
  if (state.pageObservers.has(session.sessionId)) {
    throw new PageObserverRegistrationError('page observer is already registered for this session', 409);
  }
  const usedExchanges = new Set<number>();
  let observer: PageObserver;
  try {
    observer = await observePageBrowser({
      debuggingPort: body.debuggingPort,
      pages: body.pages,
      loginRoutes: body.loginRoutes,
      errorMarkers: body.errorMarkers,
      appOrigins: body.appOrigins,
      isProxiedExchange(url, status) {
        const path = new URL(url).pathname;
        const exchange = state.observed.find((candidate) =>
          candidate.sessionId === session.sessionId && candidate.path === path && candidate.status === status &&
          !usedExchanges.has(candidate.seq),
        );
        if (exchange === undefined) return false;
        usedExchanges.add(exchange.seq);
        return true;
      },
      onVisit(visit, verdict: PageVisitVerdict) {
        const payload = {
          channel: 'observed',
          routeId: verdict.pageId,
          finalUrl: visit.url,
          navigations: visit.navigations,
          exceptions: visit.exceptions,
          domMarkerHit: visit.domMarkerHit,
          apiStatuses: visit.apiResponses.map(({ url, status, remoteAddress, proxied }) => ({ url, status, remoteAddress, proxied })),
          loads: verdict.loads,
          dataOk: verdict.dataOk,
        };
        const recordIds = state.pageObservationRecords.get(session.sessionId) ?? [];
        recordIds.push(input.issueRecord(`${verdict.pageId}:page:loads`, session.testId, payload));
        recordIds.push(input.issueRecord(`${verdict.pageId}:page:data-ok`, session.testId, payload));
        state.pageObservationRecords.set(session.sessionId, recordIds);
      },
    });
  } catch (error) {
    throw new PageObserverRegistrationError(`could not attach page observer: ${error instanceof Error ? error.message : String(error)}`, 503);
  }
  state.pageObservers.set(session.sessionId, observer);
  session.activity += 1;
  input.response.writeHead(200, { 'content-type': 'application/json' });
  input.response.end(JSON.stringify({ registered: true }));
}

/**
 * Visits referee-selected page gaps in the engine-owned session and issues
 * the same page-observation records with their independent channel.
 */
export async function sweepPageVisits(input: {
  browser: EngineBrowserManager;
  sessionId: string;
  testId: string;
  appBase: string;
  routes: readonly PageRoute[];
  loginRoutes: readonly string[];
  errorMarkers: readonly string[];
  issueRecord(obligationId: string, testId: string, payload: unknown): string;
}): Promise<Array<{ routeId: string; verdict: PageVisitVerdict }>> {
  const page = await input.browser.pageFor(input.sessionId);
  const visits: Array<{ routeId: string; verdict: PageVisitVerdict }> = [];
  for (const route of input.routes) {
    const verdict = await driveEngineVisit(page, input.appBase, route, input.routes, {
      loginRoutes: input.loginRoutes,
      errorMarkers: input.errorMarkers,
    });
    if (verdict.pageId === null) {
      throw new PageObserverRegistrationError(`engine visit did not match a declared page route: ${route.path}`, 503);
    }
    const payload = {
      channel: 'swept',
      routeId: verdict.pageId,
      finalUrl: verdict.finalUrl,
      navigations: [],
      exceptions: [],
      domMarkerHit: false,
      apiStatuses: [],
      loads: verdict.loads,
      dataOk: verdict.dataOk,
    };
    input.issueRecord(`${verdict.pageId}:page:loads`, input.testId, payload);
    input.issueRecord(`${verdict.pageId}:page:data-ok`, input.testId, payload);
    visits.push({ routeId: verdict.pageId, verdict });
  }
  return visits;
}
