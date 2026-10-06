/**
 * The gateforge Playwright fixture (plan §5.3, GF-24, invariant 6;
 * Phase 1: consumer-declared surface + supervisor-issued sessions).
 *
 * `test` is `test.extend` exposing the `evidence` fixture built from
 * {@link createEvidence} — the ONLY way tests interact with gateforge:
 * the trusted primitives (`ui`, `visible`, `persistence`, `http`,
 * `finalize`) submit witness-stamped records under the supervisor-issued
 * test session; there is no boolean escape hatch and no direct record
 * API. Tests that use engine-driven UI must extend this runner with a
 * declarative `surface` descriptor (`test.extend({ surface })`) — the
 * pack carries no application-specific selectors. Tests must
 * import `{ test, expect }` FROM A RUNNER EXTENDED LIKE THIS — importing
 * raw `playwright/test` bypasses the fixture and produces claims with no
 * records (the engine grades the obligation `missing`; GF-24).
 */
import { chromium, firefox, webkit } from 'playwright';
import type { Page } from 'playwright/test';
import { createServer as createTcpServer } from 'node:net';
import { once } from 'node:events';
import type { Browser } from 'playwright/test';

import { expect, test as base } from './consumer-runner.js';
import { setTimeout as delay } from 'node:timers/promises';
import { ENV_WITNESS_URL } from '../constants.js';
import {
  createEvidence,
  type EvidenceApi,
  type SurfaceDescriptor,
} from './evidence.js';
import { WitnessClient, type SessionPageObserverFlushRequest } from './witness-client.js';
const browserDebuggingPorts = new WeakMap<Browser, number>();

/**
 * Flushes this test's page observations to the witness. A flush failure
 * must never fail the app's own passing test: the failure is surfaced as
 * one diagnostic line and page proof stays fail closed (a missing record
 * is an unproven obligation, never a satisfied one).
 */
export async function flushPageObserverEvidence(
  witness: Pick<WitnessClient, 'flushPageObserver'>,
  request: SessionPageObserverFlushRequest,
): Promise<void> {
  try {
    await witness.flushPageObserver(request);
  } catch (error) {
    console.error(
      `gateforge: page observation flush failed (${error instanceof Error ? error.message : String(error)}); page proof for this test stays missing`,
    );
  }
}

async function availableDebuggingPort(): Promise<number> {
  const server = createTcpServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('Could not allocate a Chromium debugging port.');
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}


/**
 * Routes browser requests for the configured app origin through the
 * supervisor-issued session proxy, preserving the app URL and path.
 *
 * Every OTHER origin the page requests is continued untouched — that is
 * what a third-party asset needs. When such an origin is on the app's
 * own host (or loopback) it is also a silent ORIGIN MISMATCH: the page
 * is talking to an app origin Gateforge never configured, so nothing it
 * fetches can reach the session proxy. `onUnroutedOrigin` reports those
 * origins so the witness's zero-traffic note can name the real cause
 * (plan 0.9.2 item F). It is diagnostic text: no record, no verdict.
 *
 * Args:
 *   page: Playwright page used by the current test.
 *   appBaseURL: shared observation-proxy origin from the operator.
 *   sessionProxyURL: dedicated observation-proxy origin for this test.
 *   onUnroutedOrigin: optional sink for unrouted same-host origins.
 */
export async function routePageThroughSessionProxy(
  page: Page,
  appBaseURL: string,
  sessionProxyURL: string,
  onUnroutedOrigin?: (origin: string) => void,
): Promise<void> {
  const appOrigin = new URL(appBaseURL);
  const sessionOrigin = new URL(sessionProxyURL);
  if (
    appOrigin.protocol !== 'http:' ||
    sessionOrigin.protocol !== appOrigin.protocol ||
    sessionOrigin.hostname !== appOrigin.hostname
  ) {
    throw new Error('Gateforge session proxy and app base must share the same loopback HTTP host');
  }
  if (appOrigin.origin === sessionOrigin.origin) return;

  await page.route('**/*', async (route) => {
    const requestURL = new URL(route.request().url());
    if (requestURL.origin !== appOrigin.origin) {
      if (onUnroutedOrigin !== undefined && isAppHostOrigin(requestURL, appOrigin)) {
        onUnroutedOrigin(requestURL.origin);
      }
      await route.continue();
      return;
    }
    requestURL.host = sessionOrigin.host;
    await route.continue({ url: requestURL.href });
  });
}

/**
 * Whether an unrouted origin is a plausible app origin at all: the app
 * base's own host, or loopback (where every local deployment lives). A
 * CDN or an analytics host is not a mismatch and is never reported.
 */
function isAppHostOrigin(url: URL, appOrigin: URL): boolean {
  return url.hostname === appOrigin.hostname || isLoopbackHostname(url.hostname);
}

/** Loopback in the three forms a browser URL can carry it. */
function isLoopbackHostname(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '::1' || hostname === '[::1]' || /^127\./.test(hostname);
}

/** Distinct origins one session reports (see the witness-side cap). */
const UNROUTED_ORIGIN_CAP = 5;

/**
 * The diagnostic sink the page fixture hands to
 * {@link routePageThroughSessionProxy}: it hands each distinct unrouted
 * origin to the witness for THIS session, which quotes it in the
 * zero-traffic note.
 *
 * It can never affect the run: reports are fire-and-forget (a page load
 * never waits on the witness) and a failed one is dropped — the claim
 * blocks either way, and the only thing lost is the hint.
 */
export interface UnroutedOriginReporter {
  /** The sink to pass as `onUnroutedOrigin`. */
  report(origin: string): void;
  /** The distinct origins this reporter has accepted, in first-seen order. */
  readonly origins: readonly string[];
  /** Resolves once every report sent so far has settled. */
  settled(): Promise<void>;
}

/**
 * Builds the session's origin reporter.
 *
 * Args:
 *   witness: the session's witness client.
 *   session: the session the report belongs to (its own, never another's).
 *   appBaseURL: the base URL the fixture routes — the origin the page
 *     was supposed to load.
 *
 * Returns:
 *   UnroutedOriginReporter: the bounded, non-blocking reporter.
 */
export function createUnroutedOriginReporter(options: {
  witness: WitnessClient;
  session: { sessionId: string; sessionToken: string };
  appBaseURL: string;
}): UnroutedOriginReporter {
  const appBaseUrl = new URL(options.appBaseURL).origin;
  const origins: string[] = [];
  const inFlight = new Set<Promise<unknown>>();
  return {
    origins,
    report(origin: string): void {
      if (origin === appBaseUrl || origins.includes(origin)) return;
      if (origins.length >= UNROUTED_ORIGIN_CAP) return;
      origins.push(origin);
      // Diagnostic only: the witness may refuse (a sealed session, a
      // malformed origin) and the page must never learn about it.
      const sent = options.witness
        .reportSessionPageOrigins({
          sessionId: options.session.sessionId,
          sessionToken: options.session.sessionToken,
          appBaseUrl,
          origins: [origin],
        })
        .catch(() => undefined);
      inFlight.add(sent);
      void sent.then(() => inFlight.delete(sent));
    },
    async settled(): Promise<void> {
      while (inFlight.size > 0) await Promise.all([...inFlight]);
    },
  };
}

/** Fixture map this pack adds to every test. */
export type EvidenceFixtures = {
  /**
   * Optional consumer-declared UI surface. Only tests that call
   * `evidence.ui.*` need to declare it.
   */
  surface: SurfaceDescriptor | undefined;
  /** The trusted evidence primitive surface for the running test. */
  evidence: EvidenceApi;
};

/**
 * The extended test runner. Surface-independent evidence channels have
 * no surface requirement; the first UI call fails closed if no surface
 * was wired.
 */
export const test = base.extend<EvidenceFixtures>({
  browser: async ({ browserName, launchOptions }, use) => {
    const browserType = { chromium, firefox, webkit }[browserName];
    const witnessed = Boolean(process.env[ENV_WITNESS_URL]) && browserName === 'chromium';
    const debuggingPort = witnessed ? await availableDebuggingPort() : null;
    const args = (launchOptions.args ?? []).filter((arg) => !arg.startsWith('--remote-debugging-port='));
    const browser = await browserType.launch({
      ...launchOptions,
      args: [...args, ...(debuggingPort === null ? [] : [`--remote-debugging-port=${debuggingPort}`])],
    });
    if (debuggingPort !== null) browserDebuggingPorts.set(browser, debuggingPort);
    try {
      await use(browser);
    } finally {
      browserDebuggingPorts.delete(browser);
      await browser.close();
    }
  },
  page: async ({ page, browser }, use, testInfo) => {
    if (!process.env[ENV_WITNESS_URL]) {
      await use(page);
      return;
    }
    const appBaseURL = process.env['GATEFORGE_APP_BASE_URL']?.trim();
    if (!appBaseURL) {
      throw new Error('GATEFORGE_APP_BASE_URL is required for witnessed browser traffic.');
    }
    const witness = new WitnessClient();
    const deadline = Date.now() + 5_000;
    let session = await witness.resolveSession({
      testId: testInfo.testId,
      workerIndex: testInfo.workerIndex,
    });
    while (session === null && Date.now() < deadline) {
      await delay(100);
      session = await witness.resolveSession({
        testId: testInfo.testId,
        workerIndex: testInfo.workerIndex,
      });
    }
    if (session === null) {
      throw new Error(`No supervisor-issued witness session for ${testInfo.testId}.`);
    }
    let pageObserverRegistered = false;
    const debuggingPort = browserDebuggingPorts.get(browser);
    // Authority cutover (0.13): the request carries ONLY session
    // credentials + the debugging port. Grading configuration is
    // controller-held (supervisor-registered page-observation context);
    // a registration the witness refuses (tampered session, unbound
    // context) is surfaced and never retried from suite-side state.
    if (debuggingPort !== undefined && process.env['GATEFORGE_PAGE_OBSERVATION_ENABLED'] === '1') {
      try {
        await witness.registerPageObserver({
          sessionId: session.sessionId,
          sessionToken: session.sessionToken,
          testId: session.testId,
          debuggingPort,
        });
        pageObserverRegistered = true;
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        if (detail.startsWith('PAGE_OBSERVATION_TAMPER_RISK')) {
          // The WITNESS refused this session's records from the
          // controller context (its decision is not env-mutable here);
          // surface it and continue — the page obligations stay
          // unproven, never satisfied by a tampered session.
          console.error(detail);
        } else {
          throw error;
        }
      }
    }
    const flushPageObserver = async (): Promise<void> => {
      if (!pageObserverRegistered) return;
      await flushPageObserverEvidence(witness, {
        sessionId: session.sessionId,
        sessionToken: session.sessionToken,
        testId: session.testId,
      });
    };
    if (session.proxyUrl !== null) {
      // The reporter rides along so a page that loads ANOTHER origin
      // (a suite base URL Gateforge was never told about) reaches the
      // witness as a name, not as silence.
      const reporter = createUnroutedOriginReporter({ witness, session, appBaseURL });
      await routePageThroughSessionProxy(page, appBaseURL, session.proxyUrl, reporter.report);
      try {
        await use(page);
      } finally {
        try {
          await reporter.settled();
        } finally {
          await flushPageObserver();
        }
      }
      return;
    }
    try {
      await use(page);
    } finally {
      await flushPageObserver();
    }
  },
  surface: async ({}, use): Promise<void> => {
    await use(undefined);
  },
  evidence: async ({ page, surface }, use, testInfo) => {
    const evidence = await createEvidence({ page, testInfo, surface });
    await use(evidence);
  },
});

export { expect }; // re-exported so tests never need `playwright/test`
