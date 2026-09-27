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
import { test as base, expect, type Page } from 'playwright/test';
import { setTimeout as delay } from 'node:timers/promises';
import { ENV_WITNESS_URL } from '../constants.js';
import {
  createEvidence,
  type EvidenceApi,
  type SurfaceDescriptor,
} from './evidence.js';
import { WitnessClient } from './witness-client.js';

/**
 * Routes browser requests for the configured app origin through the
 * supervisor-issued session proxy, preserving the app URL and path.
 *
 * Args:
 *   page: Playwright page used by the current test.
 *   appBaseURL: shared observation-proxy origin from the operator.
 *   sessionProxyURL: dedicated observation-proxy origin for this test.
 */
export async function routePageThroughSessionProxy(
  page: Page,
  appBaseURL: string,
  sessionProxyURL: string,
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
      await route.continue();
      return;
    }
    requestURL.host = sessionOrigin.host;
    await route.continue({ url: requestURL.href });
  });
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
  page: async ({ page }, use, testInfo) => {
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
    if (session.proxyUrl !== null) {
      await routePageThroughSessionProxy(page, appBaseURL, session.proxyUrl);
    }
    await use(page);
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
