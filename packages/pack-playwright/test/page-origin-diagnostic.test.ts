/**
 * Silent origin mismatch (plan 0.9.2 item F).
 *
 * A suite whose browser talks to `http://host:13001` while
 * GATEFORGE_APP_BASE_URL names `http://host:13101` routes NOTHING through
 * the session proxy, so every `observed-e2e` transport claim finalizes
 * with "no HTTP exchange passed through this session's observation proxy"
 * — a note that blames the fixture page and says nothing about the real
 * cause. The fixture records the origins it did NOT route (bounded) and
 * the zero-traffic note names them with both fixes.
 *
 * The diagnostic is TEXT: it never mints a record and never changes a
 * verdict, which the parity case pins by grading the same traffic with
 * and without it.
 */
import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Page, Route } from 'playwright/test';
import { startWitness } from '../src/witness/server.js';
import {
  createUnroutedOriginReporter,
  routePageThroughSessionProxy,
  type UnroutedOriginReporter,
} from '../src/fixture/fixture.js';
import { WitnessClient } from '../src/fixture/witness-client.js';
import {
  makeTempProject,
  writeFixtureProject,
  openSupervisorSession,
  closeSupervisorSession,
  type SupervisorSession,
} from './helpers.js';
import { startMarkerServer } from './marker-server.js';
import { RUN_HEADER, VERIFIER_HEADER } from '../src/constants.js';
import {
  evaluateObligation,
  ObligationSchema,
  type Obligation,
  type VerdictOutcome,
} from '@gate-forge/core';

const TOKEN = 'run-token-origins';
const VERIFIER_KEY = 'verifier-secret-the-suite-never-sees';
const TEST_ID = 'playwright:chromium:e2e/accounts.spec.js:lists the accounts';
const HTTP_CLAIM = 'tenant.accounts:http:request-observed';
const LIFECYCLE = {
  create: true,
  read: true,
  update: true,
  delete: true,
  deleteSemantics: 'hard',
  updateableFields: ['first_name', 'last_name', 'status'],
} as const;
const CLASSIFICATION = {
  exposure: 'user-facing',
  plane: 'tenant',
  lifecycle: LIFECYCLE,
  primaryKey: ['id'],
  evidenceAdapter: 'tenant.accounts',
} as const;

interface StubPage {
  page: Page;
  readonly handlers: number;
  /** Drives the installed route handler once for `url`. */
  drive(url: string): Promise<void>;
  /** Every `route.continue()` the helper made; `url` undefined for a bare continue. */
  readonly continued: ReadonlyArray<{ url: string | undefined }>;
}

/**
 * A Page stand-in recording what the route handler did — the same stub the
 * CommonJS entry test drives. The real browser path stays covered by the
 * witness e2e suites; what matters here is WHICH origin the helper
 * rewrites and which it reports.
 */
function stubPage(): StubPage {
  const handlers: Array<(route: Route) => Promise<void>> = [];
  const continued: Array<{ url: string | undefined }> = [];
  return {
    page: {
      route(_pattern: string, handler: (route: Route) => Promise<void>): void {
        handlers.push(handler);
      },
    } as unknown as Page,
    get handlers(): number {
      return handlers.length;
    },
    continued,
    async drive(url: string): Promise<void> {
      const handler = handlers[0];
      if (handler === undefined) throw new Error('no route handler was installed');
      await handler({
        request: () => ({ url: () => url, method: () => 'GET', headers: () => ({}), resourceType: () => 'document' }),
        continue: async (options?: { url: string }) => {
          continued.push({ url: options?.url });
        },
      } as unknown as Route);
    },
  };
}

/** The obligation the real engine grades one witnessed record against. */
function httpObligation(): Obligation {
  return ObligationSchema.parse({
    schemaVersion: 1,
    id: HTTP_CLAIM,
    resourceId: 'tenant.accounts',
    contract: 'http:request-observed',
    policyId: 'user-facing-lifecycle',
    lifecycle: LIFECYCLE,
  });
}

/** Grades witnessed records through the real verdict engine, as the gate does. */
function gradeClaim(
  obligation: Obligation,
  records: Array<Record<string, unknown>>,
): VerdictOutcome {
  return evaluateObligation(obligation, {
    claims: [{ schemaVersion: 1, obligationId: obligation.id, testId: TEST_ID }],
    records,
    waivers: [],
    classification: CLASSIFICATION,
    // The endpoint inventory the endpoint matcher resolves against, as
    // the gate supplies it: one GET route on this resource.
    httpRoutes: [
      { resourceId: 'tenant.accounts', method: 'GET', canonicalPath: '/api/accounts' },
    ],
    now: '2026-08-30T12:00:01.000Z',
  });
}

function supervisorHeaders(): Record<string, string> {
  return { [RUN_HEADER]: TOKEN, [VERIFIER_HEADER]: VERIFIER_KEY, 'content-type': 'application/json' };
}

async function post(
  url: string,
  path: string,
  body: unknown,
  headers: Record<string, string> = supervisorHeaders(),
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${url}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

async function declare(url: string, obligations: string[]): Promise<void> {
  expect((await post(url, '/runs/observe-declarations', { obligations })).status).toBe(200);
}

async function finalize(
  url: string,
  sessionId: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  return post(url, '/observe/finalize', { sessionId });
}

async function ledgerRecords(url: string): Promise<Array<Record<string, unknown>>> {
  const response = await fetch(`${url}/records`, { headers: { [RUN_HEADER]: TOKEN } });
  return ((await response.json()) as { records: Array<Record<string, unknown>> }).records;
}

/** Sends one HTTP exchange through a session's dedicated proxy port. */
async function proxyExchange(proxyUrl: string, method: string, path: string): Promise<number> {
  const response = await fetch(`${proxyUrl}${path}`, { method });
  return response.status;
}

/**
 * A witness over a temp fixture project, an app origin (the marker app)
 * and a session observation proxy forwarding to it — the shape the page
 * fixture routes onto.
 */
async function startDiagnosticWitness() {
  const runId = randomUUID();
  const project = makeTempProject('page-origins');
  writeFixtureProject(project);
  const app = await startMarkerServer('example-v1');
  const witness = await startWitness({
    runId,
    token: TOKEN,
    verifierKey: VERIFIER_KEY,
    adaptersDir: join(project, '.gateforge/adapters'),
    classificationsPath: join(project, '.gateforge/effective-classifications.yml'),
    targetBaseUrl: app.url,
    targetFingerprint: 'example-v1',
    adapterBaseUrl: app.url,
    proxyTarget: app.url,
  });
  return { witness, app, runId };
}

/**
 * Wires the page exactly the way the fixture does: the routing helper
 * plus the diagnostic reporter bound to THIS session's credential.
 */
async function installFixtureRouting(
  page: Page,
  appBaseURL: string,
  session: SupervisorSession,
  reporter: UnroutedOriginReporter | undefined,
): Promise<void> {
  await routePageThroughSessionProxy(page, appBaseURL, session.proxyUrl as string, reporter?.report);
}

describe('a silent origin mismatch becomes a visible note (plan 0.9.2 F)', () => {
  it("names the origin the page really requested, with both fixes", async () => {
    const fixture = await startDiagnosticWitness();
    // A second loopback origin: the suite's own base URL, the one the
    // tests load while GATEFORGE_APP_BASE_URL names the other one.
    const suiteOrigin = await startMarkerServer('example-v1');
    try {
      await declare(fixture.witness.url, [HTTP_CLAIM]);
      const session = await openSupervisorSession(
        fixture.witness.url,
        TOKEN,
        TEST_ID,
        0,
        VERIFIER_KEY,
        [HTTP_CLAIM],
      );
      const reporter = createUnroutedOriginReporter({
        witness: new WitnessClient(fixture.witness.url, TOKEN),
        session,
        appBaseURL: fixture.app.url,
      });
      const stub = stubPage();
      await installFixtureRouting(stub.page, fixture.app.url, session, reporter);
      // The page loads the suite's own origin: nothing is rewritten and
      // nothing reaches the session proxy.
      await stub.drive(`${suiteOrigin.url}/dashboard`);
      await stub.drive(`${suiteOrigin.url}/api/accounts`);
      await reporter.settled();
      expect(stub.continued).toEqual([{ url: undefined }, { url: undefined }]);
      // A real request to that origin — the traffic the run actually made.
      expect(await proxyExchange(suiteOrigin.url, 'GET', '/api/accounts')).toBe(200);

      const done = await finalize(fixture.witness.url, session.sessionId);
      expect(done.body['finalized']).toEqual([]);
      const notes = JSON.stringify(done.body['notes']);
      expect(notes).toContain('no HTTP exchange');
      expect(notes).toContain(suiteOrigin.url);
      expect(notes).toContain('GATEFORGE_APP_BASE_URL');
      expect(notes).toContain(fixture.app.url);
      // Both fixes, named.
      expect(notes).toContain('set GATEFORGE_APP_BASE_URL to the origin your suite uses');
      expect(notes).toContain('envAllowlist');
      // Diagnostic text only: no record was minted.
      expect((await ledgerRecords(fixture.witness.url)).filter((e) => e['kind'] === 'http.observed')).toEqual([]);
      await closeSupervisorSession(fixture.witness.url, TOKEN, session.sessionId, 'passed', VERIFIER_KEY);
    } finally {
      await fixture.witness.stop();
      await fixture.app.stop();
      await suiteOrigin.stop();
    }
  });

  it('routes traffic when the origins match, and keeps the origin note out', async () => {
    const fixture = await startDiagnosticWitness();
    try {
      await declare(fixture.witness.url, [HTTP_CLAIM]);
      const session = await openSupervisorSession(
        fixture.witness.url,
        TOKEN,
        TEST_ID,
        0,
        VERIFIER_KEY,
        [HTTP_CLAIM],
      );
      const reporter = createUnroutedOriginReporter({
        witness: new WitnessClient(fixture.witness.url, TOKEN),
        session,
        appBaseURL: fixture.app.url,
      });
      const stub = stubPage();
      await installFixtureRouting(stub.page, fixture.app.url, session, reporter);
      await stub.drive(`${fixture.app.url}/api/accounts`);
      await reporter.settled();
      // Rewritten onto the session proxy — the exchange travels.
      expect(stub.continued).toEqual([{ url: `${session.proxyUrl as string}/api/accounts` }]);
      expect(await proxyExchange(session.proxyUrl as string, 'GET', '/api/accounts')).toBe(200);

      const done = await finalize(fixture.witness.url, session.sessionId);
      expect(done.body['notes']).toEqual([]);
      expect(done.body['finalized']).toHaveLength(1);
      expect(gradeClaim(httpObligation(), await ledgerRecords(fixture.witness.url))).toMatchObject({
        verdict: 'satisfied',
      });
      await closeSupervisorSession(fixture.witness.url, TOKEN, session.sessionId, 'passed', VERIFIER_KEY);
    } finally {
      await fixture.witness.stop();
      await fixture.app.stop();
    }
  });

  it('changes no verdict: identical with and without the diagnostic', async () => {
    const run = async (reportDiagnostic: boolean) => {
      const fixture = await startDiagnosticWitness();
      try {
        await declare(fixture.witness.url, [HTTP_CLAIM]);
        const session = await openSupervisorSession(
          fixture.witness.url,
          TOKEN,
          TEST_ID,
          0,
          VERIFIER_KEY,
          [HTTP_CLAIM],
        );
        if (reportDiagnostic) {
          const suiteOrigin = await startMarkerServer('example-v1');
          try {
            const reporter = createUnroutedOriginReporter({
              witness: new WitnessClient(fixture.witness.url, TOKEN),
              session,
              appBaseURL: fixture.app.url,
            });
            const stub = stubPage();
            await installFixtureRouting(stub.page, fixture.app.url, session, reporter);
            await stub.drive(`${suiteOrigin.url}/dashboard`);
            await reporter.settled();
          } finally {
            await suiteOrigin.stop();
          }
        }
        const proxied = await proxyExchange(session.proxyUrl as string, 'GET', '/api/accounts');
        expect(proxied).toBe(200);
        const done = await finalize(fixture.witness.url, session.sessionId);
        const outcome = gradeClaim(httpObligation(), await ledgerRecords(fixture.witness.url));
        const notes = JSON.stringify(done.body['notes']);
        await closeSupervisorSession(fixture.witness.url, TOKEN, session.sessionId, 'passed', VERIFIER_KEY);
        // The note differs by exactly the diagnostic sentence, and nothing
        // else: same finalized set, same verdict, same reason.
        return { outcome, finalized: done.body['finalized'], notes };
      } finally {
        await fixture.witness.stop();
        await fixture.app.stop();
      }
    };

    const withDiagnostic = await run(true);
    const without = await run(false);
    expect(withDiagnostic.outcome.verdict).toBe('satisfied');
    expect(without.outcome.verdict).toBe('satisfied');
    // Record ids bind the run id, which differs per witness; the verdict,
    // its reason and the count of records driving it do not.
    expect(withDiagnostic.outcome.recordIds).toHaveLength(without.outcome.recordIds.length);
    expect(withDiagnostic.outcome.reason).toBe(without.outcome.reason);
    expect(
      (withDiagnostic.finalized as Array<Record<string, unknown>>).map((entry) => entry['obligationId']),
    ).toEqual((without.finalized as Array<Record<string, unknown>>).map((entry) => entry['obligationId']));
    expect(withDiagnostic.notes).toBe('[]');
  });

  it('leaves a zero-traffic verdict missing either way, and changes only the note text', async () => {
    const run = async (reportDiagnostic: boolean) => {
      const fixture = await startDiagnosticWitness();
      const suiteOrigin = await startMarkerServer('example-v1');
      try {
        await declare(fixture.witness.url, [HTTP_CLAIM]);
        const session = await openSupervisorSession(
          fixture.witness.url,
          TOKEN,
          TEST_ID,
          0,
          VERIFIER_KEY,
          [HTTP_CLAIM],
        );
        if (reportDiagnostic) {
          const reporter = createUnroutedOriginReporter({
            witness: new WitnessClient(fixture.witness.url, TOKEN),
            session,
            appBaseURL: fixture.app.url,
          });
          const stub = stubPage();
          await installFixtureRouting(stub.page, fixture.app.url, session, reporter);
          await stub.drive(`${suiteOrigin.url}/dashboard`);
          await reporter.settled();
        }
        const done = await finalize(fixture.witness.url, session.sessionId);
        const outcome = gradeClaim(httpObligation(), await ledgerRecords(fixture.witness.url));
        const notes = String((done.body['notes'] as string[])[0]);
        await closeSupervisorSession(fixture.witness.url, TOKEN, session.sessionId, 'passed', VERIFIER_KEY);
        return { outcome, notes, suiteOrigin: suiteOrigin.url };
      } finally {
        await fixture.witness.stop();
        await fixture.app.stop();
        await suiteOrigin.stop();
      }
    };

    const withDiagnostic = await run(true);
    const without = await run(false);
    expect(withDiagnostic.outcome.verdict).toBe(without.outcome.verdict);
    expect(withDiagnostic.outcome.reason).toBe(without.outcome.reason);
    expect(withDiagnostic.notes).not.toBe(without.notes);
    expect(withDiagnostic.notes).toContain(withDiagnostic.suiteOrigin);
  });
});

describe('the fixture reports only bounded, plausible origins', () => {
  it('caps the report at five distinct origins and never blocks the page', async () => {
    const fixture = await startDiagnosticWitness();
    try {
      const session = await openSupervisorSession(fixture.witness.url, TOKEN, TEST_ID, 0, VERIFIER_KEY);
      const reporter = createUnroutedOriginReporter({
        witness: new WitnessClient(fixture.witness.url, TOKEN),
        session,
        appBaseURL: fixture.app.url,
      });
      const stub = stubPage();
      await installFixtureRouting(stub.page, fixture.app.url, session, reporter);
      // Six loopback origins, plus a third-party host and a duplicated one.
      for (let port = 1; port <= 6; port += 1) {
        await stub.drive(`http://127.0.0.1:${String(9000 + port)}/api/accounts`);
      }
      await stub.drive('https://cdn.example.test/asset.js');
      await stub.drive(`http://127.0.0.1:9001/api/accounts`);
      await reporter.settled();
      expect(reporter.origins).toEqual([
        'http://127.0.0.1:9001',
        'http://127.0.0.1:9002',
        'http://127.0.0.1:9003',
        'http://127.0.0.1:9004',
        'http://127.0.0.1:9005',
      ]);
      await closeSupervisorSession(fixture.witness.url, TOKEN, session.sessionId, 'passed', VERIFIER_KEY);
    } finally {
      await fixture.witness.stop();
      await fixture.app.stop();
    }
  });

  it('installs no route handler when the app base IS the session origin', async () => {
    const stub = stubPage();
    const reported: string[] = [];
    await routePageThroughSessionProxy(
      stub.page,
      'http://localhost:4411',
      'http://localhost:4411',
      (origin) => reported.push(origin),
    );
    expect(stub.handlers).toBe(0);
    expect(reported).toEqual([]);
  });
});

describe('the witness session channel for the diagnostic', () => {
  it('refuses another session\'s credential and drops the report at close', async () => {
    const fixture = await startDiagnosticWitness();
    try {
      await declare(fixture.witness.url, [HTTP_CLAIM]);
      const first = await openSupervisorSession(fixture.witness.url, TOKEN, TEST_ID, 0, VERIFIER_KEY);
      const second = await openSupervisorSession(
        fixture.witness.url,
        TOKEN,
        `${TEST_ID}-second`,
        1,
        VERIFIER_KEY,
      );
      const foreign = await post(
        fixture.witness.url,
        '/sessions/page-origins',
        {
          sessionId: second.sessionId,
          sessionToken: first.sessionToken,
          appBaseUrl: fixture.app.url,
          origins: ['http://127.0.0.1:9999'],
        },
      );
      expect(foreign.status).toBe(403);
      await closeSupervisorSession(fixture.witness.url, TOKEN, first.sessionId, 'passed', VERIFIER_KEY);
      const sealed = await post(
        fixture.witness.url,
        '/sessions/page-origins',
        {
          sessionId: first.sessionId,
          sessionToken: first.sessionToken,
          appBaseUrl: fixture.app.url,
          origins: ['http://127.0.0.1:9999'],
        },
      );
      expect(sealed.status).toBe(409);
      const done = await finalize(fixture.witness.url, second.sessionId);
      expect(JSON.stringify(done.body['notes'])).not.toContain('127.0.0.1:9999');
      await closeSupervisorSession(fixture.witness.url, TOKEN, second.sessionId, 'passed', VERIFIER_KEY);
    } finally {
      await fixture.witness.stop();
      await fixture.app.stop();
    }
  });

  it('refuses a malformed origin instead of storing half a diagnostic', async () => {
    const fixture = await startDiagnosticWitness();
    try {
      const session = await openSupervisorSession(fixture.witness.url, TOKEN, TEST_ID, 0, VERIFIER_KEY);
      for (const body of [
        { appBaseUrl: fixture.app.url, origins: ['not-a-url'] },
        { appBaseUrl: 'not-a-url', origins: ['http://127.0.0.1:9999'] },
        { appBaseUrl: fixture.app.url, origins: [] },
        { appBaseUrl: fixture.app.url, origins: 'http://127.0.0.1:9999' },
      ]) {
        const refused = await post(fixture.witness.url, '/sessions/page-origins', {
          sessionId: session.sessionId,
          sessionToken: session.sessionToken,
          ...body,
        });
        expect(refused.status).toBe(400);
      }
      await closeSupervisorSession(fixture.witness.url, TOKEN, session.sessionId, 'passed', VERIFIER_KEY);
    } finally {
      await fixture.witness.stop();
      await fixture.app.stop();
    }
  });
});