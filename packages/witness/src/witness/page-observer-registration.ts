import type { ServerResponse } from 'node:http';
import type { BrowserContextOptions } from 'playwright';
import type { PageObservationContext, SessionPageObserverRequest } from './types.js';
import { driveEngineVisit, type EngineBrowserManager } from './browser.js';
import { observePageBrowser, type PageObserver } from './page-observer.js';
import {
  apiErrorDetailOf,
  landedLoginRoute,
  type ObservedPageVisit,
  type PageRoute,
  type PageVisitVerdict,
} from './page-observation.js';
export interface PageObserverRegistrationState {
  pageObservers: Map<string, PageObserver>;
  pageObservationRecords: Map<string, string[]>;
  observed: Array<{ seq: number; sessionId: string | null; path: string; status: number }>;
  /** Controller-held page-observation context (0.13 authority cutover). */
  pageObservation: PageObservationContext | null;
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
  requireSession(body: Record<string, unknown>): {
    sessionId: string;
    testId: string;
    activity: number;
    /** The supervisor-registered spec file this session was minted for. */
    registeredFile: string | null;
  };
  issueRecord(obligationId: string, testId: string, payload: unknown): string;
}): Promise<void> {
  const { state, body } = input;
  const session = input.requireSession(body as unknown as Record<string, unknown>);
  if (body.testId !== session.testId) throw new PageObserverRegistrationError('page observer test identity does not match its session', 403);
  if (!Number.isInteger(body.debuggingPort) || body.debuggingPort < 1 || body.debuggingPort > 65535) {
    throw new PageObserverRegistrationError('page observer debuggingPort must be a valid TCP port', 400);
  }
  // Authority cutover (0.13): the request carries NOTHING but session
  // credentials and the debugging port. Every grading input comes from
  // the supervisor-registered context; without one there is no page
  // proof, whatever the suite body or environment claims.
  const context = state.pageObservation;
  if (context === null) {
    throw new PageObserverRegistrationError(
      'page observation refused: no controller-registered page-observation context exists for this run',
      409,
    );
  }
  // Static browser-API tamper risks match the SUPERVISOR-opened session
  // identity (its registered spec file, or an applicable trusted test id)
  // — never suite metadata, and never a mutable environment variable.
  const tamperRisk = context.tamperRisks.find((risk) =>
    (risk.testId !== null && risk.testId === session.testId) ||
    (session.registeredFile !== null && risk.file === session.registeredFile),
  );
  if (tamperRisk !== undefined) {
    throw new PageObserverRegistrationError(
      'PAGE_OBSERVATION_TAMPER_RISK: page records refused for this test; browser API mutation at ' +
        `${tamperRisk.locationFile}:${String(tamperRisk.line)}`,
      403,
    );
  }
  if (state.pageObservers.has(session.sessionId)) {
    throw new PageObserverRegistrationError('page observer is already registered for this session', 409);
  }
  const usedExchanges = new Set<number>();
  let observationSequence = 0;
  let observer: PageObserver;
  try {
    observer = await observePageBrowser({
      debuggingPort: body.debuggingPort,
      pages: context.pages,
      loginRoutes: context.loginRoutes,
      errorMarkers: context.errorMarkers,
      appOrigins: context.appOrigins,
      liveChannels: context.liveChannels ?? [],
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
        // An unmatched observation (out-of-table or undeclared-login page)
        // must never mint obligation ids like `null:page:loads`; a matched
        // page keeps its records even when the verdict refuses it.
        if (!context.pages.some((page) => page.id === verdict.pageId)) return;
        // Origin enforcement (0.13 authority cutover): a MATCHED route
        // whose FINAL URL origin the controller never declared can never
        // mint proof — the explicit refusal replaces the verdict, so
        // wrong-origin content is recorded as refused, never satisfied.
        let finalOrigin: string | null = null;
        try {
          finalOrigin = new URL(visit.url).origin;
        } catch {
          finalOrigin = null;
        }
        let finalVerdict = verdict;
        if (finalOrigin === null || !context.appOrigins.includes(finalOrigin)) {
          finalVerdict = {
            pageId: verdict.pageId,
            finalUrl: visit.url,
            loads: { satisfied: false, refusalReasons: ['PAGE_APP_ORIGIN_MISMATCH'] },
            dataOk: { satisfied: false, refusalReasons: ['PAGE_APP_ORIGIN_MISMATCH'] },
          };
        }
        const payload = {
          channel: 'observed',
          routeId: finalVerdict.pageId,
          finalUrl: visit.url,
          navigations: visit.navigations,
          exceptions: visit.exceptions,
          domMarkerHit: visit.domMarkerHit,
          apiStatuses: visit.apiResponses.map(({ method, url, status, remoteAddress, proxied }) => ({ method, url, status, remoteAddress, proxied })),
          // One payload shared by both promise records; the sequence
          // increases on every observation of this registered session.
          apiRequestsSettled: visit.apiRequestsSettled,
          unsettledRequests: visit.unsettledRequests,
          liveChannels: visit.liveChannels,
          observationSequence: observationSequence++,
          loads: finalVerdict.loads,
          dataOk: finalVerdict.dataOk,
        };
        const recordIds = state.pageObservationRecords.get(session.sessionId) ?? [];
        recordIds.push(input.issueRecord(`${finalVerdict.pageId}:page:loads`, session.testId, payload));
        recordIds.push(input.issueRecord(`${finalVerdict.pageId}:page:data-ok`, session.testId, payload));
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
function normalizePageStorageState(raw: unknown): BrowserContextOptions['storageState'] {
  if (raw === undefined) return undefined;
  if (raw === null || typeof raw !== 'object' || !('cookies' in raw) || !Array.isArray(raw.cookies) ||
    !('origins' in raw) || !Array.isArray(raw.origins)) {
    throw new PageObserverRegistrationError('page sweep storage state must contain cookie and origin arrays', 400);
  }
  const cookies = raw.cookies.map((entry) => {
    if (entry === null || typeof entry !== 'object' || !('name' in entry) || typeof entry.name !== 'string' ||
      !('value' in entry) || typeof entry.value !== 'string' || !('domain' in entry) || typeof entry.domain !== 'string' ||
      !('path' in entry) || typeof entry.path !== 'string' || !('expires' in entry) || typeof entry.expires !== 'number' ||
      !('httpOnly' in entry) || typeof entry.httpOnly !== 'boolean' || !('secure' in entry) || typeof entry.secure !== 'boolean' ||
      !('sameSite' in entry) || (entry.sameSite !== 'Strict' && entry.sameSite !== 'Lax' && entry.sameSite !== 'None')) {
      throw new PageObserverRegistrationError('page sweep storage state contains an invalid cookie', 400);
    }
    return {
      name: entry.name,
      value: entry.value,
      domain: entry.domain,
      path: entry.path,
      expires: entry.expires,
      httpOnly: entry.httpOnly,
      secure: entry.secure,
      sameSite: entry.sameSite,
    };
  });
  const origins = raw.origins.map((entry) => {
    if (entry === null || typeof entry !== 'object' || !('origin' in entry) || typeof entry.origin !== 'string' ||
      !('localStorage' in entry) || !Array.isArray(entry.localStorage)) {
      throw new PageObserverRegistrationError('page sweep storage state contains an invalid origin', 400);
    }
    const localStorage = entry.localStorage.map((item: unknown) => {
      if (item === null || typeof item !== 'object' || !('name' in item) || typeof item.name !== 'string' ||
        !('value' in item) || typeof item.value !== 'string') {
        throw new PageObserverRegistrationError('page sweep storage state contains an invalid local-storage value', 400);
      }
      return { name: item.name, value: item.value };
    });
    return { origin: entry.origin, localStorage };
  });
  return { cookies, origins };
}

/**
 * One sweep progress line, emitted as each visit finishes so a killed run
 * keeps the lines it already earned. `detail` names WHY the page refused
 * when the reason alone cannot: the unsettled requests for
 * PAGE_API_UNSETTLED, the refusing response for PAGE_API_ERROR — appended
 * after the timing as `: <detail>`.
 */
export function formatSweepProgress(info: {
  index: number;
  total: number;
  audience: string;
  path: string;
  proven: boolean;
  firstReason: string | null;
  ms: number;
  detail?: string | null;
}): string {
  const outcome = info.proven ? 'proven' : `refused${info.firstReason === null ? '' : ` ${info.firstReason}`}`;
  const suffix = info.detail === undefined || info.detail === null || info.detail === '' ? '' : `: ${info.detail}`;
  return `page ${String(info.index)}/${String(info.total)} ${info.audience} ${info.path} -> ${outcome} (${String(info.ms)} ms)${suffix}`;
}

/**
 * The progress-line detail for one refused visit: the unsettled requests
 * for PAGE_API_UNSETTLED (`GET /a net::ERR_ABORTED; POST /b outstanding`),
 * the refusing response for PAGE_API_ERROR (`GET /api/y -> 500`, with the
 * grader's own anonymous-401 exemption), null for every other reason.
 *
 * Args:
 *   firstReason: the first refusal reason of the verdict.
 *   visit: the visit the verdict graded.
 *   anonymous: the page's anonymous flag (audience without login).
 *
 * Returns:
 *   string | null: the appended detail, or null when the reason is
 *   self-explanatory.
 */
export function progressDetailFor(firstReason: string | null, visit: ObservedPageVisit, anonymous: boolean): string | null {
  if (firstReason === 'PAGE_API_UNSETTLED') {
    const detail = visit.unsettledRequests
      .map(({ method, url, errorText }) => `${method} ${url} ${errorText}`)
      .join('; ');
    return detail === '' ? null : detail;
  }
  if (firstReason === 'PAGE_API_ERROR') return apiErrorDetailOf(visit.apiResponses, anonymous);
  return null;
}

/** One swept route outcome: the page verdict plus whether the sweep visited it. */
export interface SweptPageVisit {
  routeId: string;
  verdict: PageVisitVerdict;
  /** False when the sweep refused this page WITHOUT visiting it. */
  visited: boolean;
}

/** The outcome of one audience's swept page visits. */
export interface PageSweepResult {
  visits: SweptPageVisit[];
  /**
   * Set when the audience's session was rejected on the FIRST visited
   * page (it landed on a declared login route): the remaining pages were
   * refused WITHOUT visiting, with PAGE_AUDIENCE_SESSION_INVALID.
   */
  sessionRejected: { path: string; login: string; notVisited: number } | null;
  /**
   * Every API exchange the sweep's visited pages produced, in visit
   * order — the raw material for the session-wide `http.exchanges`
   * record (the caller deduplicates and caps it). A rejected session
   * that visited nothing contributes none.
   */
  exchanges: Array<{ method: string; url: string; status: number; fetchDest?: string | null }>;
}

export async function sweepPageVisits(input: {
  browser: EngineBrowserManager;
  sessionId: string;
  testId: string;
  appBase: string;
  /** The audience these routes belong to (named in progress lines). */
  audience: string;
  routes: readonly PageRoute[];
  loginRoutes: readonly string[];
  errorMarkers: readonly string[];
  /** Declared live-channel path prefixes (same rule as the observed channel). */
  liveChannels: readonly string[];
  storageState?: unknown;
  /** Called as each visited page finishes, with its one progress line. */
  onProgress?: (line: string) => void;
  issueRecord(obligationId: string, testId: string, payload: unknown): string;
}): Promise<PageSweepResult> {
  const page = await input.browser.pageFor(input.sessionId, normalizePageStorageState(input.storageState));
  const visits: SweptPageVisit[] = [];
  const exchanges: Array<{ method: string; url: string; status: number; fetchDest?: string | null }> = [];
  let observationSequence = 0;
  // A session the app rejects (e.g. a rotating refresh token the suite's
  // own storage-state file already consumed) bounces the FIRST visited
  // page to a declared login route. Every further route could only
  // bounce the same way, so they are refused WITHOUT visiting; the
  // records still issue, and the payload says the page was not visited
  // and why. Session-less audiences are unaffected.
  let sessionRejected: PageSweepResult['sessionRejected'] = null;
  for (const [index, route] of input.routes.entries()) {
    if (sessionRejected !== null) {
      const verdict: PageVisitVerdict = {
        pageId: route.id,
        finalUrl: route.path,
        loads: { satisfied: false, refusalReasons: ['PAGE_AUDIENCE_SESSION_INVALID'] },
        dataOk: { satisfied: false, refusalReasons: ['PAGE_AUDIENCE_SESSION_INVALID'] },
      };
      const payload = {
        channel: 'swept',
        routeId: verdict.pageId,
        // The page was never visited; the payload says so and why.
        notVisited: 'PAGE_AUDIENCE_SESSION_INVALID',
        finalUrl: route.path,
        navigations: [],
        exceptions: [],
        domMarkerHit: false,
        apiStatuses: [],
        apiRequestsSettled: true,
        unsettledRequests: [],
        liveChannels: { count: 0, paths: [] },
        observationSequence: observationSequence++,
        loads: verdict.loads,
        dataOk: verdict.dataOk,
      };
      input.issueRecord(`${verdict.pageId}:page:loads`, input.testId, payload);
      input.issueRecord(`${verdict.pageId}:page:data-ok`, input.testId, payload);
      visits.push({ routeId: route.id, verdict, visited: false });
      continue;
    }
    const visitStartedAt = Date.now();
    const observation = await driveEngineVisit(page, input.appBase, route, input.routes, {
      loginRoutes: input.loginRoutes,
      errorMarkers: input.errorMarkers,
      liveChannels: input.liveChannels,
    });
    const { verdict, visit } = observation;
    if (verdict.pageId === null) {
      throw new PageObserverRegistrationError(`engine visit did not match a declared page route: ${route.path}`, 503);
    }
    const payload = {
      channel: 'swept',
      routeId: verdict.pageId,
      finalUrl: visit.url,
      navigations: visit.navigations,
      exceptions: visit.exceptions,
      domMarkerHit: visit.domMarkerHit,
      apiStatuses: visit.apiResponses.map(({ method, url, status, remoteAddress, proxied }) => ({ method, url, status, remoteAddress, proxied })),
      // One payload reused for both contracts; the sequence increases
      // within this sweep.
      apiRequestsSettled: visit.apiRequestsSettled,
      unsettledRequests: visit.unsettledRequests,
      liveChannels: visit.liveChannels,
      observationSequence: observationSequence++,
      loads: verdict.loads,
      dataOk: verdict.dataOk,
    };
    input.issueRecord(`${verdict.pageId}:page:loads`, input.testId, payload);
    input.issueRecord(`${verdict.pageId}:page:data-ok`, input.testId, payload);
    visits.push({ routeId: verdict.pageId, verdict, visited: true });
    for (const response of visit.apiResponses) {
      exchanges.push({ method: response.method, url: response.url, status: response.status, fetchDest: response.fetchDest ?? null });
    }
    input.onProgress?.(formatSweepProgress({
      index: index + 1,
      total: input.routes.length,
      audience: input.audience,
      path: route.path,
      proven: verdict.loads.satisfied && verdict.dataOk.satisfied,
      firstReason: verdict.loads.refusalReasons[0] ?? verdict.dataOk.refusalReasons[0] ?? null,
      ms: Date.now() - visitStartedAt,
      detail: progressDetailFor(
        verdict.loads.refusalReasons[0] ?? verdict.dataOk.refusalReasons[0] ?? null,
        visit,
        route.anonymous === true,
      ),
    }));
    if (index === 0 && input.storageState !== undefined) {
      const login = landedLoginRoute(visit.url, route.path, input.loginRoutes);
      if (login !== null) {
        sessionRejected = { path: route.path, login, notVisited: input.routes.length - 1 };
      }
    }
  }
  return { visits, sessionRejected, exchanges };
}
