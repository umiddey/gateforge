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
 *
 * API requests made directly from test code are never E2E evidence. The
 * `request` fixture, owned `page.request`/`context.request`, and exported
 * `request` factory all go directly to the app; only browser page traffic
 * rides the session proxy.
 */
import { chromium, firefox, webkit, request as playwrightRequest } from 'playwright';
import type { Page, TestInfo } from 'playwright/test';
import { createServer as createTcpServer } from 'node:net';
import { once } from 'node:events';
import type { APIRequestContext, Browser, CDPSession } from 'playwright/test';

import { expect, test as base } from './consumer-runner.js';
import { setTimeout as delay } from 'node:timers/promises';
import { ENV_WITNESS_URL } from '../constants.js';
import {
  createEvidence,
  type EvidenceApi,
  type SurfaceDescriptor,
} from './evidence.js';
import { wrapDirectRequestContext } from './api-request.js';
import { WitnessClient, type SessionPageObserverFlushRequest } from './witness-client.js';
import type { SessionCredential } from '../witness/types.js';
const browserDebuggingPorts = new WeakMap<Browser, number>();
const unavailableInitiatorBrowsers = new Set<string>();

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
 * Resolves the supervisor-issued session for one (testId, workerIndex)
 * pair, polling until the deadline: the trusted reporter's session open
 * and the worker's first resolve race, so a bounded wait absorbs the
 * dispatch latency.
 *
 * Args:
 *   witness: the witness client.
 *   testId: the runner-side test id the session was opened under.
 *   workerIndex: the worker slot the session was opened under.
 *   timeoutMs: how long to wait for the session to appear.
 *
 * Returns:
 *   Promise<SessionCredential | null>: the open session, or null at the
 *   deadline.
 */
async function resolveSessionBounded(
  witness: WitnessClient,
  testId: string,
  workerIndex: number,
  timeoutMs: number,
): Promise<SessionCredential | null> {
  const deadline = Date.now() + timeoutMs;
  let session = await witness.resolveSession({ testId, workerIndex });
  while (session === null && Date.now() < deadline) {
    await delay(100);
    session = await witness.resolveSession({ testId, workerIndex });
  }
  return session;
}

/** The project's `use.baseURL`, when it is a non-empty string. */
function projectBaseURL(testInfo: TestInfo): string | undefined {
  const baseURL: unknown = testInfo.project.use['baseURL'];
  return typeof baseURL === 'string' && baseURL !== '' ? baseURL : undefined;
}


interface CdpInitiatorFrame {
  url?: string;
}

interface CdpInitiatorStack {
  callFrames?: CdpInitiatorFrame[];
  parent?: CdpInitiatorStack;
}

interface CdpRequestInitiatorEvent {
  request: { method: string; url: string };
  initiator?: { stack?: CdpInitiatorStack };
}

/**
 * Attaches Chromium's script initiator to requests in arrival order.
 * Missing CDP events deliberately remain unknown and preserve prior behavior.
 */
interface InitiatorTracking {
  session: CDPSession;
  classify(method: string, url: string): Promise<'page' | 'test-code' | 'unknown'>;
}

async function attachInitiatorTracking(page: Page, appBaseURL: string): Promise<InitiatorTracking> {
  const session = await page.context().newCDPSession(page);
  const pending = new Map<string, Array<'page' | 'test-code' | 'unknown'>>();
  // Route callbacks that arrived before their CDP event, oldest first.
  const waiting = new Map<string, Array<(verdict: 'page' | 'test-code' | 'unknown') => void>>();
  const appOriginPrefix = `${new URL(appBaseURL).origin}/`;
  session.on('Network.requestWillBeSent', (event: CdpRequestInitiatorEvent) => {
    if (!event.request.url.startsWith(appOriginPrefix)) return;
    let deepest = event.initiator?.stack;
    while (deepest?.parent !== undefined) deepest = deepest.parent;
    const outermost = deepest?.callFrames?.at(-1);
    const verdict = outermost === undefined ? 'unknown' : outermost.url ? 'page' : 'test-code';
    const key = `${event.request.method} ${event.request.url}`;
    const waiter = waiting.get(key)?.shift();
    if (waiter !== undefined) {
      waiter(verdict);
      return;
    }
    const queue = pending.get(key) ?? [];
    queue.push(verdict);
    pending.set(key, queue);
  });
  await session.send('Network.enable');
  await session.send('Debugger.enable');
  await session.send('Debugger.setAsyncCallStackDepth', { maxDepth: 32 });
  return {
    session,
    classify(method, url) {
      const key = `${method} ${url}`;
      const queue = pending.get(key);
      const queued = queue?.shift();
      if (queue?.length === 0) pending.delete(key);
      if (queued !== undefined) return Promise.resolve(queued);
      // A burst of requests can deliver a CDP event just after its route
      // callback. Wait for that event only, never a fixed pause: a fixed
      // pause shifts the app's request timing. No event in 50 ms: unknown.
      return new Promise((resolve) => {
        const waiters = waiting.get(key) ?? [];
        const timer = setTimeout(() => {
          const index = waiters.indexOf(settle);
          if (index >= 0) waiters.splice(index, 1);
          resolve('unknown');
        }, 50);
        const settle = (verdict: 'page' | 'test-code' | 'unknown'): void => {
          clearTimeout(timer);
          resolve(verdict);
        };
        waiters.push(settle);
        waiting.set(key, waiters);
      });
    },
  };
}
/**
 * Routes browser requests for the configured app origin through the
 * supervisor-issued session proxy, preserving the app URL and path.
 *
 * Every OTHER origin the page requests is passed to remaining routes untouched,
 * preserving the consumer's handlers for third-party assets. When an origin is on the app's
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
  initiatorForRequest?: (method: string, url: string) => Promise<'page' | 'test-code' | 'unknown'>,
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
      await route.fallback();
      return;
    }
    const originalURL = requestURL.href;
    requestURL.host = sessionOrigin.host;
    const initiator = await initiatorForRequest?.(route.request().method(), originalURL);
    const headers: Record<string, string> = {
      ...route.request().headers(),
      'x-gateforge-resource-type': route.request().resourceType(),
    };
    if (initiator === 'test-code') headers['x-gateforge-initiator'] = 'test-code';
    // Yield to consumer context routes while carrying the session rewrite.
    // continue() would skip their stubs and change the test's response.
    await route.fallback({ url: requestURL.href, headers });
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
interface DirectExchangeReporter {
  report(exchange: { method: string; url: string; status: number }): void;
  settled(): Promise<void>;
}

const directExchangeReporters = new Map<string, DirectExchangeReporter>();

function directExchangeReporterFor(testInfo: TestInfo): DirectExchangeReporter {
  const existing = directExchangeReporters.get(testInfo.testId);
  if (existing !== undefined) return existing;
  const inFlight = new Set<Promise<unknown>>();
  const witness = new WitnessClient();
  const reporter: DirectExchangeReporter = {
    report(exchange): void {
      const sent = (async () => {
        const session = await resolveSessionBounded(witness, testInfo.testId, testInfo.workerIndex, 5_000);
        if (session === null) return;
        await witness.reportSessionDirectExchanges({
          sessionId: session.sessionId,
          sessionToken: session.sessionToken,
          exchanges: [exchange],
        });
      })().catch(() => undefined);
      inFlight.add(sent);
      void sent.then(() => inFlight.delete(sent));
    },
    async settled(): Promise<void> {
      while (inFlight.size > 0) await Promise.all([...inFlight]);
    },
  };
  directExchangeReporters.set(testInfo.testId, reporter);
  return reporter;
}

async function settleDirectExchangeReports(testInfo: TestInfo): Promise<void> {
  const reporter = directExchangeReporters.get(testInfo.testId);
  if (reporter === undefined) return;
  try {
    await reporter.settled();
  } finally {
    directExchangeReporters.delete(testInfo.testId);
  }
}

/** Fixture map this pack adds to every test. */
export type EvidenceFixtures = {
  /** Pending diagnostic-only direct API reports, settled before test teardown. */
  directApiReports: void;
  surface: SurfaceDescriptor | undefined;
  /** The trusted evidence primitive surface for the running test. */
  evidence: EvidenceApi;
};

/**
 * The runner the evidence fixtures extend. Page observation needs a
 * Chromium debugging port, so only then does it replace Playwright's
 * worker-scoped `browser`. The replacement is registered at module load,
 * and ONLY when the supervisor enabled page observation: a worker-scoped
 * override changes Playwright's worker hash, and tests whose runners
 * differ in it are scheduled in separate worker groups. A suite mixing
 * this runner with Playwright's own would then no longer run in file
 * order (an order-dependent suite breaks), for a port nothing reads.
 */
const browserRunner =
  process.env['GATEFORGE_PAGE_OBSERVATION_ENABLED'] === '1'
    ? base.extend({
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
      })
    : base;

/**
 * The extended test runner. Surface-independent evidence channels have
 * no surface requirement; the first UI call fails closed if no surface
 * was wired.
 */
const extended = browserRunner.extend<EvidenceFixtures>({
  directApiReports: [async ({}, use, testInfo) => {
    if (!process.env[ENV_WITNESS_URL]) {
      await use(undefined);
      return;
    }
    directExchangeReporterFor(testInfo);
    try {
      await use(undefined);
    } finally {
      await settleDirectExchangeReports(testInfo);
    }
  }, { auto: true }],
  page: async ({ page, browser, browserName }, use, testInfo) => {
    if (!process.env[ENV_WITNESS_URL]) {
      await use(page);
      return;
    }
    const appBaseURL = process.env['GATEFORGE_APP_BASE_URL']?.trim();
    if (!appBaseURL) {
      throw new Error('GATEFORGE_APP_BASE_URL is required for witnessed browser traffic.');
    }
    const witness = new WitnessClient();
    const session = await resolveSessionBounded(witness, testInfo.testId, testInfo.workerIndex, 5_000);
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
    let initiatorTracking: InitiatorTracking | undefined;
    if (browserName === 'chromium') {
      initiatorTracking = await attachInitiatorTracking(page, appBaseURL);
    } else if (!unavailableInitiatorBrowsers.has(browserName)) {
      unavailableInitiatorBrowsers.add(browserName);
      console.warn(
        `initiator check unavailable for ${browserName}; requests started by test code cannot be told apart`,
      );
    }
    if (session.proxyUrl !== null) {
      const sessionProxyUrl: string = session.proxyUrl;
      const reporter = createUnroutedOriginReporter({ witness, session, appBaseURL });
      await routePageThroughSessionProxy(
        page,
        appBaseURL,
        sessionProxyUrl,
        reporter.report,
        initiatorTracking?.classify,
      );
      // Do not wrap page/context.request: Playwright's Route.fetch uses
      // the context request internally to forward browser traffic here.
      try {
        await use(page);
      } finally {
        try {
          await reporter.settled();
        } finally {
          try {
            await flushPageObserver();
          } finally {
            await initiatorTracking?.session.detach();
          }
        }
      }
      return;
    }
    try {
      await use(page);
    } finally {
      try {
        await flushPageObserver();
      } finally {
        await initiatorTracking?.session.detach();
      }
    }
  },
  request: async ({ request }, use, testInfo) => {
    if (!process.env[ENV_WITNESS_URL]) {
      await use(request);
      return;
    }
    const appBaseURL = process.env['GATEFORGE_APP_BASE_URL']?.trim();
    if (!appBaseURL) {
      throw new Error('GATEFORGE_APP_BASE_URL is required for witnessed API traffic.');
    }
    const witness = new WitnessClient();
    const session = await resolveSessionBounded(witness, testInfo.testId, testInfo.workerIndex, 5_000);
    if (session === null) {
      throw new Error(`No supervisor-issued witness session for ${testInfo.testId}.`);
    }
    const directReporter = directExchangeReporterFor(testInfo);
    try {
      await use(wrapDirectRequestContext(request, {
        ...(projectBaseURL(testInfo) === undefined ? {} : { baseURL: projectBaseURL(testInfo) }),
        onExchange: (exchange) => directReporter.report(exchange),
      }));
    } finally {
      await directReporter.settled();
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

/**
 * Worker-hook execution depth (beforeAll/beforeEach/afterEach/afterAll
 * RUNNING right now in this worker). The witnessed API factory consults
 * it: a context created inside a worker hook must talk to the app
 * DIRECTLY — that is setup traffic and stays uncredited — even though
 * Playwright runs `beforeAll` of a file inside the FIRST test's
 * test-begin window, where the session is already open and a plain
 * `test.info()` resolve would otherwise credit the call.
 */
let workerHookDepth = 0;

/** The hook registrars whose EXECUTION the tracker wraps. */
const HOOK_REGISTRARS = new Set(['beforeAll', 'beforeEach', 'afterEach', 'afterAll']);

/**
 * Re-exports the extended runner with the four hook registrars wrapped
 * so hook callbacks run inside the tracker above. The proxy forwards
 * every other read untouched — the runner object stays the consumer's
 * own (describe/info all behave identically) — except `extend`, whose
 * result is wrapped the same way: most suites build their own `test` on
 * top of this one, and their hooks are setup traffic too.
 *
 * Playwright picks the fixtures a hook receives by reading the hook
 * function's source (`fn.toString()`, first parameter). The forwarder
 * therefore reports the consumer callback's source as its own: a
 * zero-parameter forwarder would make Playwright build NO fixtures, and
 * `test.beforeEach(async ({ page }) => …)` would get `page === undefined`.
 * The optional hook title (`test.beforeEach('title', fn)`) passes through
 * unchanged; only the function argument is wrapped.
 */
function withHookTracking<T extends object>(extended: T): T {
  return new Proxy(extended, {
    get(target, property, receiver) {
      if (property === 'extend') {
        const extend = Reflect.get(target, property, target) as (...args: unknown[]) => object;
        return (...args: unknown[]): object => withHookTracking(extend(...args));
      }
      if (typeof property !== 'string' || !HOOK_REGISTRARS.has(property)) {
        return Reflect.get(target, property, receiver);
      }
      const register = Reflect.get(target, property, target) as (...args: unknown[]) => unknown;
      return (...registration: unknown[]): unknown =>
        register(
          ...registration.map((argument) =>
            typeof argument === 'function' ? trackedHook(argument as (...args: unknown[]) => unknown) : argument,
          ),
        );
    },
  });
}

/** Wraps one hook callback in the depth tracker, keeping its fixture signature visible. */
function trackedHook(callback: (...args: unknown[]) => unknown): (...args: unknown[]) => unknown {
  // No rest parameter in the forwarder: Playwright's spec transform rejects
  // one ("First argument must use the object destructuring pattern").
  const forwarder = function (this: unknown) {
    const hookArgs = Array.from(arguments);
    workerHookDepth += 1;
    try {
      return Promise.resolve(callback.apply(this, hookArgs)).finally(() => {
        workerHookDepth -= 1;
      });
    } catch (error) {
      workerHookDepth -= 1;
      throw error;
    }
  };
  Object.defineProperty(forwarder, 'toString', { value: () => callback.toString() });
  return forwarder;
}

export const test: typeof extended = withHookTracking(extended);

export { expect }; // re-exported so tests never need `playwright/test`

/**
 * The module-scope `request` of `@gate-forge/pack-playwright/fixture`.
 * `newContext(options)` creates a normal Playwright API context with the
 * supplied options and never rehosts its calls onto the session proxy.
 * App-origin calls made in a test body are reported as direct-API
 * diagnostics only; they can never satisfy an E2E claim. Calls made at
 * module scope have no owning test and are not reported.
 *
 * In worker hooks, calls go straight to the app and remain uncredited;
 * the first test's session may already be open, but that does not make
 * hook traffic test-body evidence.
 */
export const request = {
  async newContext(options: Parameters<typeof playwrightRequest.newContext>[0] = {}): Promise<APIRequestContext> {
    if (!process.env[ENV_WITNESS_URL]) return await playwrightRequest.newContext(options);
    const appBaseURL = process.env['GATEFORGE_APP_BASE_URL']?.trim();
    if (appBaseURL === undefined || appBaseURL === '') return await playwrightRequest.newContext(options);
    const directContext = async (testInfo?: TestInfo): Promise<APIRequestContext> => {
      // Calls go to the app directly. The project's own base URL rides
      // along when the caller gave none, so relative setup calls retain
      // the suite's configured resolution.
      const fallbackBaseURL = options.baseURL ?? (testInfo === undefined ? undefined : projectBaseURL(testInfo));
      const context = await playwrightRequest.newContext(
        fallbackBaseURL === undefined ? options : { ...options, baseURL: fallbackBaseURL },
      );
      return wrapDirectRequestContext(context, {
        ...(fallbackBaseURL === undefined ? {} : { baseURL: fallbackBaseURL }),
        onExchange: (exchange) => {
          let owner = testInfo;
          if (owner === undefined) {
            try {
              owner = base.info();
            } catch {
              return;
            }
          }
          directExchangeReporterFor(owner).report(exchange);
        },
      });
    };
    let testInfo: TestInfo;
    try {
      testInfo = base.info();
    } catch {
      // Module scope: no test owns this context.
      return await directContext();
    }
    if (workerHookDepth > 0) {
      // A worker hook: setup traffic, never credited — even though the
      // first test's session may already be open here.
      return await directContext(testInfo);
    }
    const witness = new WitnessClient();
    // Inside a test body the supervisor has already opened (or is
    // opening) this test's session: wait the same bound the
    // fixtures use. A missing session must NOT fall back to a
    // direct context here — that would silently bypass the
    // witness for in-test traffic (only module scope and worker
    // hooks are setup traffic, which stays uncredited by design).
    const session = await resolveSessionBounded(witness, testInfo.testId, testInfo.workerIndex, 5_000);
    if (session === null) {
      throw new Error(`No supervisor-issued witness session for ${testInfo.testId}.`);
    }
    return await directContext(testInfo);
  },
};
