/**
 * Plan §8 / D1 engine tests: the witness-owned loopback observation
 * proxy (ADR 0004 D7) proves TRANSPORT only — the witness observed an
 * HTTP exchange; test attribution is suite-claimed. Red probe: claiming
 * an http observation without real proxied traffic fails (409). Happy
 * path: Node-driven traffic through the proxy yields a witnessed
 * `http.request` record that — together with a provenanced claimed ui
 * anchor — satisfies `http:request-observed` in the real verdict
 * engine, while `http:frontend-request-observed` stays blocking
 * `missing` on the same run. Suite-forged network records stay invalid.
 *
 * Mount-path coverage (phase 7): with an explicit `mountPath` the proxy
 * forwards AND records the STRIPPED backend path; without one the
 * behavior stays byte-identical.
 */
import { describe, expect, it } from 'vitest';
import { createServer, request as httpRequest, type Server } from 'node:http';
import { evaluateObligation, recordIdOf, type Obligation } from '@gateforge/core';
import type { Page, TestInfo } from 'playwright/test';
import {
  createEvidence,
  SURFACE_DESCRIPTOR_VERSION,
  type SurfaceDescriptor,
} from '../src/fixture/evidence.js';
import type { WitnessClient } from '../src/fixture/witness-client.js';
import { startWitness, type WitnessHandle } from '../src/witness/server.js';
import {
  openSupervisorSession,
  beginJourneyInterval,
  type SupervisorSession,
} from './helpers.js';

const RUN_ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const TOKEN = 'observation-run-token';
// Enforcement-review fix 3: session lifecycle is supervisor-only, so the
// tests act as their own supervisor — the witness is started WITH a
// verifier key and every session open presents it (the run token alone
// answers 401/403).
const VERIFIER_KEY = 'observation-verifier-key';

const OBLIGATION: Obligation = {
  schemaVersion: 1,
  id: 'tenant.http-post-api-contracts-x1:http:frontend-request-observed',
  resourceId: 'tenant.http-post-api-contracts-x1',
  contract: 'http:frontend-request-observed',
  policyId: 'p',
  lifecycle: { create: false, read: false, update: false, delete: false },
};

/** The explicit transport contract (plan §8 / D1): same exchange, narrower promise. */
const TRANSPORT_OBLIGATION: Obligation = {
  ...OBLIGATION,
  id: 'tenant.http-post-api-contracts-x1:http:request-observed',
  contract: 'http:request-observed',
};

/** Status-ok is the same transport proof additionally requiring 2xx (plan §10: ≥1 2xx satisfies). */
const STATUS_OBLIGATION: Obligation = {
  ...OBLIGATION,
  id: 'tenant.http-post-api-contracts-x1:http:response-status-ok',
  contract: 'http:response-status-ok',
};

/** Minimal loopback target app: POST /api/contracts → 201. */
async function startTarget(): Promise<{ url: string; stop: () => Promise<void> }> {
  const server: Server = createServer((req, res) => {
    res.writeHead(201, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, path: req.url }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no target port');
  return {
    url: `http://127.0.0.1:${address.port}`,
    stop: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** Issues a witness record-shaped document with valid provenance. */
function record(overrides: Record<string, unknown>): Record<string, unknown> {
  const base: Record<string, unknown> = {
    schemaVersion: 1,
    runId: RUN_ID,
    trust: 'witnessed',
    obligationId: OBLIGATION.id,
    testId: 'journey-1',
    kind: 'ui.action',
    origin: 'suite-submitted',
    payload: { operation: 'create', entityId: 'acc-1' },
    ...overrides,
  };
  base['recordId'] = recordIdOf({
    runId: RUN_ID,
    obligationId: base['obligationId'] as string,
    kind: base['kind'] as string,
    testId: base['testId'] as string,
    origin: base['origin'] as 'engine-observed' | 'suite-submitted',
    payload: base['payload'],
  });
  return base;
}

function callProxy(
  proxyUrl: string,
  path: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const forward = httpRequest(`${proxyUrl}${path}`, { method: 'POST' }, (res) => {
      let data = '';
      res.on('data', (chunk: Buffer) => (data += chunk.toString()));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }));
    });
    forward.on('error', reject);
    forward.end();
  });
}

/**
 * Phase 1 session channel: opens the supervisor session the journey runs
 * under and starts a witness-recorded action interval, so proxied
 * traffic is attributed to THIS session and consumable as its evidence.
 */
async function openJourney(
  witness: WitnessHandle,
  testId = 'journey-1',
): Promise<SupervisorSession> {
  const session = await openSupervisorSession(witness.url, TOKEN, testId, 0, VERIFIER_KEY);
  await beginJourneyInterval(witness.url, TOKEN, session, 'create');
  return session;
}

/** The session-attributed browser-facing proxy origin for one exchange. */
function journeyProxyUrl(witness: WitnessHandle, session: SupervisorSession): string {
  void witness;
  if (session.proxyUrl === null) throw new Error('session has no observation proxy');
  return session.proxyUrl;
}

function observe(
  witness: WitnessHandle,
  session: SupervisorSession | null,
  overrides: Record<string, unknown> = {},
): Promise<{ status: number; statusCode: number }> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      claimId: TRANSPORT_OBLIGATION.id,
      testId: session?.testId ?? 'journey-1',
      method: 'POST',
      path: '/api/contracts',
      ...(session === null
        ? {}
        : { sessionId: session.sessionId, sessionToken: session.sessionToken }),
      ...overrides,
    });
    const forward = httpRequest(
      `${witness.url}/witness/http-observation`,
      { method: 'POST', headers: { 'x-gateforge-run': TOKEN, 'content-type': 'application/json' } },
      (res) => {
        let data = '';
        res.on('data', (chunk: Buffer) => (data += chunk.toString()));
        res.on('end', () => resolve({ statusCode: res.statusCode ?? 0, status: JSON.parse(data).status }));
      },
    );
    forward.on('error', reject);
    forward.end(body);
  });
}

describe('witness-owned observation proxy (ADR 0004 D7, Phase 1 session channel)', () => {
  it('red probe: no proxied traffic — the observation claim is refused (409)', async () => {
    const target = await startTarget();
    const witness = await startWitness({ runId: RUN_ID, token: TOKEN, verifierKey: VERIFIER_KEY, proxyTarget: target.url });
    try {
      expect(witness.proxyUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      const session = await openJourney(witness);
      const result = await observe(witness, session);
      expect(result.statusCode).toBe(409);
    } finally {
      await witness.stop();
      await target.stop();
    }
  });

  it('real proxied traffic yields a witnessed http.request record, single-use', async () => {
    const target = await startTarget();
    const witness = await startWitness({ runId: RUN_ID, token: TOKEN, verifierKey: VERIFIER_KEY, proxyTarget: target.url });
    try {
      const session = await openJourney(witness);
      const emitted = await callProxy(journeyProxyUrl(witness, session), '/api/contracts');
      expect(emitted.status).toBe(201);

      const consumed = await observe(witness, session);
      expect(consumed.statusCode).toBe(200);
      expect(consumed.status).toBe(201);

      // Single-use: the same observation cannot be claimed twice.
      const replay = await observe(witness, session);
      expect(replay.statusCode).toBe(409);

      // The issued record is witnessed and engine-observed.
      const recordsResponse = await fetch(`${witness.url}/records`, {
        headers: { 'x-gateforge-run': TOKEN },
      });
      const body = (await recordsResponse.json()) as {
        records: Array<{ kind: string; trust: string; origin: string; payload: Record<string, unknown> }>;
      };
      const httpRecords = body.records.filter((entry) => entry.kind === 'http.request');
      expect(httpRecords).toHaveLength(1);
      expect(httpRecords[0]?.trust).toBe('witnessed');
      expect(httpRecords[0]?.origin).toBe('engine-observed');
      expect(httpRecords[0]?.payload).toMatchObject({ method: 'POST', url: '/api/contracts', status: 201 });
    } finally {
      await witness.stop();
      await target.stop();
    }
  });

  it('the real verdict engine: witnessed observation + claimed anchor satisfies transport; frontend stays missing; forged fails', async () => {
    const target = await startTarget();
    const witness = await startWitness({ runId: RUN_ID, token: TOKEN, verifierKey: VERIFIER_KEY, proxyTarget: target.url });
    try {
      const session = await openJourney(witness);
      await callProxy(journeyProxyUrl(witness, session), '/api/contracts');
      await observe(witness, session);

      const recordsResponse = await fetch(`${witness.url}/records`, {
        headers: { 'x-gateforge-run': TOKEN },
      });
      const body = (await recordsResponse.json()) as {
        records: Array<Record<string, unknown>>;
      };
      const witnessedRequest = body.records.find((entry) => entry.kind === 'http.request');
      expect(witnessedRequest).toBeDefined();

      const classification = {
        exposure: 'user-facing',
        plane: 'tenant',
        primaryKey: ['method', 'path'],
        lifecycle: { create: false, read: false, update: false, delete: false },
        evidenceAdapter: 'x',
      } as const;
      const transportAnchor = record({ obligationId: TRANSPORT_OBLIGATION.id });

      const satisfied = evaluateObligation(TRANSPORT_OBLIGATION, {
        claims: [{ schemaVersion: 1, obligationId: TRANSPORT_OBLIGATION.id, testId: 'journey-1' }],
        records: [transportAnchor, witnessedRequest],
        waivers: [],
        classification,
        // Complete inventory (plan §9, D2): the observation attributes
        // to the obligation's own endpoint within this set.
        httpRoutes: [
          {
            resourceId: TRANSPORT_OBLIGATION.resourceId,
            method: 'POST',
            canonicalPath: '/api/contracts',
          },
        ],
        now: '2026-01-01T00:00:00.000Z',
      });
      if (satisfied.verdict !== 'satisfied') {
        throw new Error(`got ${satisfied.verdict}: ${satisfied.reason}`);
      }
      expect(satisfied.verdict).toBe('satisfied');

      // The SAME real exchange cannot satisfy the frontend contract: no
      // independent browser/test observation channel exists.
      const frontendAnchor = record({ obligationId: OBLIGATION.id });
      const frontendWitnessed = { ...(witnessedRequest as Record<string, unknown>), obligationId: OBLIGATION.id };
      const frontendOutcome = evaluateObligation(OBLIGATION, {
        claims: [{ schemaVersion: 1, obligationId: OBLIGATION.id, testId: 'journey-1' }],
        records: [frontendAnchor, frontendWitnessed],
        waivers: [],
        classification,
        now: '2026-01-01T00:00:00.000Z',
      });
      expect(frontendOutcome.verdict).toBe('missing');
      expect(frontendOutcome.reason).toContain("'http:frontend-request-observed'");
      expect(frontendOutcome.reason).toContain('no independent browser/test observation channel');

      // Suite-forged network record instead of the engine observation:
      // the gate grades it invalid, never satisfied.
      const forged = record({
        obligationId: TRANSPORT_OBLIGATION.id,
        kind: 'http.request',
        origin: 'suite-submitted',
        trust: 'claimed',
        payload: { method: 'POST', url: '/api/contracts', status: 201 },
      });
      const forgedOutcome = evaluateObligation(TRANSPORT_OBLIGATION, {
        claims: [{ schemaVersion: 1, obligationId: TRANSPORT_OBLIGATION.id, testId: 'journey-1' }],
        records: [transportAnchor, forged],
        waivers: [],
        classification,
        now: '2026-01-01T00:00:00.000Z',
      });
      expect(forgedOutcome.verdict).toBe('invalid');
      expect(forgedOutcome.reason).toContain('HTTP_OBSERVATION_UNTRUSTED');
    } finally {
      await witness.stop();
      await target.stop();
    }
  });

  it('F6: two real exchanges grade identically in both ledger orders; junk-first cannot move the selection', async () => {
    // Real loopback target + real witness: two distinct paths yield two
    // distinct witnessed records (identical exchanges would collapse to
    // one ledger entry since ids hash the payload). The engine must
    // return the same verdict and selected ids for every permutation,
    // and a suite-forged record appearing first must not change them.
    const target = await startTarget();
    const witness = await startWitness({ runId: RUN_ID, token: TOKEN, verifierKey: VERIFIER_KEY, proxyTarget: target.url });
    try {
      const session = await openJourney(witness);
      await callProxy(journeyProxyUrl(witness, session), '/api/contracts/a');
      await observe(witness, session, { path: '/api/contracts/a' });
      await callProxy(journeyProxyUrl(witness, session), '/api/contracts/b');
      await observe(witness, session, { path: '/api/contracts/b' });

      const ledgerResponse = await fetch(`${witness.url}/records`, {
        headers: { 'x-gateforge-run': TOKEN },
      });
      const ledger = (await ledgerResponse.json()) as { records: Array<Record<string, unknown>> };
      const exchanges = ledger.records.filter((entry) => entry['kind'] === 'http.request');
      expect(exchanges).toHaveLength(2);
      const [firstExchange, secondExchange] = exchanges as [
        Record<string, unknown>,
        Record<string, unknown>,
      ];

      const classification = {
        exposure: 'user-facing',
        plane: 'tenant',
        primaryKey: ['method', 'path'],
        lifecycle: { create: false, read: false, update: false, delete: false },
        evidenceAdapter: 'x',
      } as const;
      // One parameter candidate: both observations attribute uniquely to
      // the obligation's own endpoint (no literal overlap by design).
      const inventory = [
        {
          resourceId: TRANSPORT_OBLIGATION.resourceId,
          method: 'POST',
          canonicalPath: '/api/contracts/{}',
        },
      ];
      const gradeTransport = (records: unknown[]) =>
        evaluateObligation(TRANSPORT_OBLIGATION, {
          claims: [{ schemaVersion: 1, obligationId: TRANSPORT_OBLIGATION.id, testId: 'journey-1' }],
          records,
          waivers: [],
          classification,
          httpRoutes: inventory,
          now: '2026-01-01T00:00:00.000Z',
        });
      const anchor = record({ obligationId: TRANSPORT_OBLIGATION.id });
      const complete = (outcome: { verdict: string; reason: string | null; recordIds: string[] }) => ({
        verdict: outcome.verdict,
        reason: outcome.reason,
        recordIds: outcome.recordIds,
      });

      const forward = complete(gradeTransport([anchor, firstExchange, secondExchange]));
      const reversed = complete(gradeTransport([anchor, secondExchange, firstExchange]));
      expect(forward.verdict).toBe('satisfied');
      expect(reversed).toEqual(forward);

      // Two further real exchanges, consumed directly under the
      // status-ok obligation (rebinding an issued recordId would break
      // its provenance hash — the engine demotes it to claimed): the
      // loopback target answers 201 for every exchange.
      await callProxy(journeyProxyUrl(witness, session), '/api/contracts/a');
      await observe(witness, session, { claimId: STATUS_OBLIGATION.id, path: '/api/contracts/a' });
      await callProxy(journeyProxyUrl(witness, session), '/api/contracts/b');
      await observe(witness, session, { claimId: STATUS_OBLIGATION.id, path: '/api/contracts/b' });
      const statusLedger = (await (
        await fetch(`${witness.url}/records`, { headers: { 'x-gateforge-run': TOKEN } })
      ).json()) as { records: Array<Record<string, unknown>> };
      const statusExchanges = statusLedger.records.filter(
        (entry) =>
          entry['kind'] === 'http.request' && entry['obligationId'] === STATUS_OBLIGATION.id,
      );
      expect(statusExchanges).toHaveLength(2);
      const statusAnchor = record({ obligationId: STATUS_OBLIGATION.id });
      const gradeStatus = (records: unknown[]) =>
        evaluateObligation(STATUS_OBLIGATION, {
          claims: [{ schemaVersion: 1, obligationId: STATUS_OBLIGATION.id, testId: 'journey-1' }],
          records,
          waivers: [],
          classification,
          httpRoutes: inventory,
          now: '2026-01-01T00:00:00.000Z',
        });
      const [statusFirst, statusSecond] = statusExchanges as [
        Record<string, unknown>,
        Record<string, unknown>,
      ];
      const statusForward = complete(gradeStatus([statusAnchor, statusFirst, statusSecond]));
      const statusReversed = complete(gradeStatus([statusAnchor, statusSecond, statusFirst]));
      expect(statusForward.verdict).toBe('satisfied');
      expect(statusReversed).toEqual(statusForward);

      // Junk-first still satisfies with the same selection: the
      // suite-submitted record is invalid weight, never proof.
      const forged = record({
        obligationId: TRANSPORT_OBLIGATION.id,
        kind: 'http.request',
        origin: 'suite-submitted',
        trust: 'claimed',
        payload: { method: 'POST', url: '/api/contracts/a', status: 201 },
      });
      const junkFirst = complete(gradeTransport([anchor, forged, firstExchange, secondExchange]));
      expect(junkFirst).toEqual(forward);
    } finally {
      await witness.stop();
      await target.stop();
    }
  });

  it('F1: Node-only attack — transport-only honesty kept, foreign-test claiming refused (Phase 1)', async () => {
    // The attack uses plain Node HTTP (fetch-style), never Playwright: it
    // proves the proxy cannot tell a browser apart from any suite-side
    // client (transport-only honesty — the FRONTEND contract therefore
    // stays unavailable), while Phase 1 session binding closes the old
    // hole: a testId that never owned the session can no longer claim
    // the exchange at all.
    const target = await startTarget();
    const witness = await startWitness({ runId: RUN_ID, token: TOKEN, verifierKey: VERIFIER_KEY, proxyTarget: target.url });
    try {
      const session = await openJourney(witness, 'journey-1');
      // Attacker traffic (Node, not a browser) traverses the session
      // channel during its recorded interval…
      await callProxy(journeyProxyUrl(witness, session), '/api/contracts');

      // …but a DIFFERENT testId cannot claim it: submissions bind to the
      // supervisor-registered session test (Phase 1).
      const foreign = await observe(witness, session, {
        testId: 'test-that-never-made-a-request',
      });
      expect(foreign.statusCode).toBe(403);

      // The claiming testId matching the session is still transport-
      // satisfied by the exchange (documented boundary: the proxy cannot
      // distinguish Node from a browser — that is exactly why the
      // frontend contract stays a separate, unavailable channel).
      const claimed = await observe(witness, session);
      expect(claimed.statusCode).toBe(200);

      const ledgerResponse = await fetch(`${witness.url}/records`, {
        headers: { 'x-gateforge-run': TOKEN },
      });
      const ledger = (await ledgerResponse.json()) as { records: Array<Record<string, unknown>> };
      const attackRecords = ledger.records.filter(
        (entry) => (entry as { testId?: unknown }).testId === 'journey-1',
      );
      expect(attackRecords.length).toBeGreaterThan(0);
      // No record exists for the foreign testId — nothing was credited.
      expect(
        ledger.records.some(
          (entry) => (entry as { testId?: unknown }).testId === 'test-that-never-made-a-request',
        ),
      ).toBe(false);

      const classification = {
        exposure: 'user-facing',
        plane: 'tenant',
        primaryKey: ['method', 'path'],
        lifecycle: { create: false, read: false, update: false, delete: false },
        evidenceAdapter: 'x',
      } as const;
      // Transport: the witness DID observe the exchange — satisfied (with
      // a provenanced claimed anchor from the declaring test).
      const transportAnchor = record({ obligationId: TRANSPORT_OBLIGATION.id });
      const transportOutcome = evaluateObligation(TRANSPORT_OBLIGATION, {
        claims: [{ schemaVersion: 1, obligationId: TRANSPORT_OBLIGATION.id, testId: 'journey-1' }],
        records: [transportAnchor, ...attackRecords],
        waivers: [],
        classification,
        httpRoutes: [
          {
            resourceId: TRANSPORT_OBLIGATION.resourceId,
            method: 'POST',
            canonicalPath: '/api/contracts',
          },
        ],
        now: '2026-01-01T00:00:00.000Z',
      });
      expect(transportOutcome.verdict).toBe('satisfied');

      // Frontend: the same attack ledger stays blocking missing.
      const frontendAnchor = record({ obligationId: OBLIGATION.id });
      const frontendRecords = attackRecords.map((entry) => ({
        ...(entry as Record<string, unknown>),
        obligationId: OBLIGATION.id,
      }));
      const frontendOutcome = evaluateObligation(OBLIGATION, {
        claims: [
          { schemaVersion: 1, obligationId: OBLIGATION.id, testId: 'journey-1' },
        ],
        records: [frontendAnchor, ...frontendRecords],
        waivers: [],
        classification,
        now: '2026-01-01T00:00:00.000Z',
      });
      expect(frontendOutcome.verdict).toBe('missing');
      expect(frontendOutcome.reason).toContain('no independent browser/test observation channel');
    } finally {
      await witness.stop();
      await target.stop();
    }
  });

  it('anchor-only and empty ledgers leave the frontend contract missing', async () => {
    const frontendAnchor = record({ obligationId: OBLIGATION.id });
    const classification = {
      exposure: 'user-facing',
      plane: 'tenant',
      primaryKey: ['method', 'path'],
      lifecycle: { create: false, read: false, update: false, delete: false },
      evidenceAdapter: 'x',
    } as const;
    const anchorOnly = evaluateObligation(OBLIGATION, {
      claims: [{ schemaVersion: 1, obligationId: OBLIGATION.id, testId: 'journey-1' }],
      records: [frontendAnchor],
      waivers: [],
      classification,
      now: '2026-01-01T00:00:00.000Z',
    });
    expect(anchorOnly.verdict).toBe('missing');
    const empty = evaluateObligation(OBLIGATION, {
      claims: [{ schemaVersion: 1, obligationId: OBLIGATION.id, testId: 'journey-1' }],
      records: [],
      waivers: [],
      classification,
      now: '2026-01-01T00:00:00.000Z',
    });
    expect(empty.verdict).toBe('missing');
    expect(empty.reason).toContain('no independent browser/test observation channel');
  });

  it('the witness refuses a split claimId/obligationId assignment (400)', async () => {
    const target = await startTarget();
    const witness = await startWitness({ runId: RUN_ID, token: TOKEN, verifierKey: VERIFIER_KEY, proxyTarget: target.url });
    try {
      const session = await openJourney(witness);
      await callProxy(journeyProxyUrl(witness, session), '/api/contracts');
      const statusCode = await new Promise<number>((resolve, reject) => {
        const forward = httpRequest(
          `${witness.url}/witness/http-observation`,
          { method: 'POST', headers: { 'x-gateforge-run': TOKEN, 'content-type': 'application/json' } },
          (res) => {
            void res.resume();
            resolve(res.statusCode ?? 0);
          },
        );
        forward.on('error', reject);
        forward.end(
          JSON.stringify({
            claimId: TRANSPORT_OBLIGATION.id,
            obligationId: 'tenant.other:http:request-observed',
            testId: 'journey-1',
            method: 'POST',
            path: '/api/contracts',
            sessionId: session.sessionId,
            sessionToken: session.sessionToken,
          }),
        );
      });
      expect(statusCode).toBe(400);
      // The refused consume consumed nothing: the exchange is still claimable.
      const retry = await observe(witness, session);
      expect(retry.statusCode).toBe(200);
    } finally {
      await witness.stop();
      await target.stop();
    }
  });
});

describe('no claimed-side path around the trust model', () => {
  it('rejects a suite-submitted check-kind record at /records (400, honest gap)', async () => {
    // The witnessed domain-check channel was RETIRED (its scenario label
    // plus status-class outcome was forged-green by construction) and it
    // must not come back as a claimed-side shortcut: check-kind records
    // are not accepted primitives, so domain contracts return to
    // fail-closed until real state-observing producers exist.
    const target = await startTarget();
    const witness = await startWitness({ runId: RUN_ID, token: TOKEN, verifierKey: VERIFIER_KEY, proxyTarget: target.url });
    try {
      const res = await fetch(`${witness.url}/records`, {
        method: 'POST',
        headers: { 'x-gateforge-run': TOKEN, 'content-type': 'application/json' },
        body: JSON.stringify({
          claimId: OBLIGATION.id,
          kind: 'workflow.check',
          payload: { scenario: 'transition-allowed', outcome: 'accepted' },
          testId: 'journey-1',
        }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain(
        "unknown evidence primitive 'workflow.check'; accepted kinds: ui.action, ui.visible-result",
      );
      expect(body.error).toContain(
        'http.request and persistence records are witness-issued only',
      );
    } finally {
      await witness.stop();
      await target.stop();
    }
  });
});

describe('one exchange, every claimed obligation of the declaring test', () => {
  const REQUEST_CLAIM = 'tenant.http-post-api-contracts-x1:http:request-observed';
  const STATUS_CLAIM = 'tenant.http-post-api-contracts-x1:http:response-status-ok';

  it('issues one witnessed record per declared claim from a single consumed exchange', async () => {
    const target = await startTarget();
    const witness = await startWitness({ runId: RUN_ID, token: TOKEN, verifierKey: VERIFIER_KEY, proxyTarget: target.url });
    try {
      const session = await openJourney(witness);
      await callProxy(journeyProxyUrl(witness, session), '/api/contracts');

      // One consume call carrying BOTH claims the test declares.
      const consumed = await new Promise<{ statusCode: number; body: Record<string, unknown> }>(
        (resolve, reject) => {
          const forward = httpRequest(
            `${witness.url}/witness/http-observation`,
            { method: 'POST', headers: { 'x-gateforge-run': TOKEN, 'content-type': 'application/json' } },
            (res) => {
              let data = '';
              res.on('data', (chunk: Buffer) => (data += chunk.toString()));
              res.on('end', () =>
                resolve({ statusCode: res.statusCode ?? 0, body: JSON.parse(data) }),
              );
            },
          );
          forward.on('error', reject);
          forward.end(
            JSON.stringify({
              claimIds: [REQUEST_CLAIM, STATUS_CLAIM],
              testId: 'journey-1',
              method: 'POST',
              path: '/api/contracts',
              sessionId: session.sessionId,
              sessionToken: session.sessionToken,
            }),
          );
        },
      );
      expect(consumed.statusCode).toBe(200);
      const records = consumed.body['records'] as Array<{ recordId: string; obligationId: string }>;
      expect(records).toHaveLength(2);
      expect(records.map((entry) => entry.obligationId).sort()).toEqual(
        [REQUEST_CLAIM, STATUS_CLAIM].sort(),
      );
      // Distinct identities (recordId hashes the obligation id).
      expect(records[0]?.recordId).not.toBe(records[1]?.recordId);
      // Backward-compat surface: first record id + observed status.
      expect(consumed.body['recordId']).toBe(records[0]?.recordId);
      expect(consumed.body['status']).toBe(201);

      // The exchange was consumed ONCE: both ledger records exist, each
      // witnessed + engine-observed, bound to its own obligation.
      const ledgerResponse = await fetch(`${witness.url}/records`, {
        headers: { 'x-gateforge-run': TOKEN },
      });
      const ledger = (await ledgerResponse.json()) as {
        records: Array<{
          kind: string;
          trust: string;
          origin: string;
          obligationId: string;
          testId: string;
          payload: Record<string, unknown>;
        }>;
      };
      const httpRecords = ledger.records.filter((entry) => entry.kind === 'http.request');
      expect(httpRecords).toHaveLength(2);
      for (const entry of httpRecords) {
        expect(entry.trust).toBe('witnessed');
        expect(entry.origin).toBe('engine-observed');
        expect(entry.testId).toBe('journey-1');
        expect(entry.payload).toMatchObject({ method: 'POST', url: '/api/contracts', status: 201 });
      }
      expect(new Set(httpRecords.map((entry) => entry.obligationId))).toEqual(
        new Set([REQUEST_CLAIM, STATUS_CLAIM]),
      );

      // Single-use at the exchange level: nothing left to claim.
      const replay = await observe(witness, session);
      expect(replay.statusCode).toBe(409);
    } finally {
      await witness.stop();
      await target.stop();
    }
  });

  it('fails closed on a claimIds payload with no valid obligation id', async () => {
    const target = await startTarget();
    const witness = await startWitness({ runId: RUN_ID, token: TOKEN, verifierKey: VERIFIER_KEY, proxyTarget: target.url });
    try {
      const session = await openJourney(witness);
      await callProxy(journeyProxyUrl(witness, session), '/api/contracts');
      const bad = await new Promise<{ statusCode: number }>((resolve, reject) => {
        const forward = httpRequest(
          `${witness.url}/witness/http-observation`,
          { method: 'POST', headers: { 'x-gateforge-run': TOKEN, 'content-type': 'application/json' } },
          (res) => {
            void res.resume();
            resolve({ statusCode: res.statusCode ?? 0 });
          },
        );
        forward.on('error', reject);
        forward.end(
          JSON.stringify({
            claimIds: ['not-an-obligation-id'],
            testId: 'j',
            method: 'POST',
            path: '/api/contracts',
            sessionId: session.sessionId,
            sessionToken: session.sessionToken,
          }),
        );
      });
      expect(bad.statusCode).toBe(400);
      // The malformed consume consumed nothing.
      const consumed = await observe(witness, session);
      expect(consumed.statusCode).toBe(200);
    } finally {
      await witness.stop();
      await target.stop();
    }
  });

  it('both claims grade satisfied in the real engine (anchor per claim)', async () => {
    const target = await startTarget();
    const witness = await startWitness({ runId: RUN_ID, token: TOKEN, verifierKey: VERIFIER_KEY, proxyTarget: target.url });
    try {
      const session = await openJourney(witness);
      await callProxy(journeyProxyUrl(witness, session), '/api/contracts');
      const consumed = await new Promise<{ statusCode: number }>((resolve, reject) => {
        const forward = httpRequest(
          `${witness.url}/witness/http-observation`,
          { method: 'POST', headers: { 'x-gateforge-run': TOKEN, 'content-type': 'application/json' } },
          (res) => {
            void res.resume();
            resolve({ statusCode: res.statusCode ?? 0 });
          },
        );
        forward.on('error', reject);
        forward.end(
          JSON.stringify({
            claimIds: [REQUEST_CLAIM, STATUS_CLAIM],
            testId: 'journey-1',
            method: 'POST',
            path: '/api/contracts',
            sessionId: session.sessionId,
            sessionToken: session.sessionToken,
          }),
        );
      });
      expect(consumed.statusCode).toBe(200);

      const ledgerResponse = await fetch(`${witness.url}/records`, {
        headers: { 'x-gateforge-run': TOKEN },
      });
      const ledger = (await ledgerResponse.json()) as { records: Array<Record<string, unknown>> };

      for (const obligation of [
        { ...OBLIGATION, id: REQUEST_CLAIM, contract: 'http:request-observed' },
        { ...OBLIGATION, id: STATUS_CLAIM, contract: 'http:response-status-ok' },
      ]) {
        const anchor = record({ obligationId: obligation.id });
        const outcome = evaluateObligation(obligation, {
          claims: [{ schemaVersion: 1, obligationId: obligation.id, testId: 'journey-1' }],
          records: [...ledger.records, anchor],
          waivers: [],
          classification: {
            exposure: 'user-facing',
            plane: 'tenant',
            primaryKey: ['method', 'path'],
            lifecycle: { create: false, read: false, update: false, delete: false },
            evidenceAdapter: 'x',
          },
          httpRoutes: [
            {
              resourceId: obligation.resourceId,
              method: 'POST',
              canonicalPath: '/api/contracts',
            },
          ],
          now: '2026-01-01T00:00:00.000Z',
        });
        if (outcome.verdict !== 'satisfied') {
          throw new Error(`${obligation.id}: got ${outcome.verdict}: ${outcome.reason}`);
        }
      }
    } finally {
      await witness.stop();
      await target.stop();
    }
  });
});

describe('observation-proxy mount path (deployment-topology declaration)', () => {
  it('strips the mount prefix: /api/ops/x is forwarded AND recorded as /ops/x', async () => {
    const target = await startTarget();
    const witness = await startWitness({
      runId: RUN_ID,
      token: TOKEN,
      verifierKey: VERIFIER_KEY,
      proxyTarget: target.url,
      mountPath: '/api',
    });
    try {
      const session = await openJourney(witness);
      // The caller hits the frontend-mounted path (behind the session
      // channel); the target must see the STRIPPED backend path (query
      // preserved).
      const forwarded = await callProxy(journeyProxyUrl(witness, session), '/api/ops/x?y=1');
      expect(forwarded.status).toBe(201);
      expect(JSON.parse(forwarded.body)).toMatchObject({ path: '/ops/x?y=1' });

      // The claim references the backend-derived obligation identity.
      const consumed = await observe(witness, session, { path: '/ops/x' });
      expect(consumed.statusCode).toBe(200);
      expect(consumed.status).toBe(201);

      const recordsResponse = await fetch(`${witness.url}/records`, {
        headers: { 'x-gateforge-run': TOKEN },
      });
      const body = (await recordsResponse.json()) as {
        records: Array<{ kind: string; payload: Record<string, unknown> }>;
      };
      const httpRecords = body.records.filter((entry) => entry.kind === 'http.request');
      expect(httpRecords).toHaveLength(1);
      // The RECORD carries the stripped path too.
      expect(httpRecords[0]?.payload).toMatchObject({ method: 'POST', url: '/ops/x', status: 201 });

      // Single-use is intact.
      const replay = await observe(witness, session, { path: '/ops/x' });
      expect(replay.statusCode).toBe(409);
    } finally {
      await witness.stop();
      await target.stop();
    }
  });

  it('requests outside the mount prefix pass through and record unstripped', async () => {
    const target = await startTarget();
    const witness = await startWitness({
      runId: RUN_ID,
      token: TOKEN,
      verifierKey: VERIFIER_KEY,
      proxyTarget: target.url,
      mountPath: '/api',
    });
    try {
      const session = await openJourney(witness);
      const forwarded = await callProxy(journeyProxyUrl(witness, session), '/other');
      expect(forwarded.status).toBe(201);
      expect(JSON.parse(forwarded.body)).toMatchObject({ path: '/other' });
      const consumed = await observe(witness, session, { path: '/other' });
      expect(consumed.statusCode).toBe(200);
    } finally {
      await witness.stop();
      await target.stop();
    }
  });

  it('without a mount path the proxy forwards and records byte-identical to today', async () => {
    const target = await startTarget();
    const witness = await startWitness({
      runId: RUN_ID,
      token: TOKEN,
      verifierKey: VERIFIER_KEY,
      proxyTarget: target.url,
      mountPath: null,
    });
    try {
      const session = await openJourney(witness);
      const forwarded = await callProxy(journeyProxyUrl(witness, session), '/api/ops/x');
      expect(forwarded.status).toBe(201);
      expect(JSON.parse(forwarded.body)).toMatchObject({ path: '/api/ops/x' });
      const consumed = await observe(witness, session, { path: '/api/ops/x' });
      expect(consumed.statusCode).toBe(200);
    } finally {
      await witness.stop();
      await target.stop();
    }
  });

  it('fails closed on a mount path without a proxy target and on malformed prefixes', async () => {
    await expect(
      startWitness({ runId: RUN_ID, token: TOKEN, mountPath: '/api' }),
    ).rejects.toThrow(/mountPath requires proxyTarget/);
    const target = await startTarget();
    try {
      await expect(
        startWitness({ runId: RUN_ID, token: TOKEN, proxyTarget: target.url, mountPath: '/' }),
      ).rejects.toThrow(/invalid mountPath/);
      await expect(
        startWitness({ runId: RUN_ID, token: TOKEN, proxyTarget: target.url, mountPath: 'a b' }),
      ).rejects.toThrow(/invalid mountPath/);
    } finally {
      await target.stop();
    }
  });
});

describe('status-narrowed consume (phase 7: multi-status shapes)', () => {
  it('expectedStatus narrows the FIFO match and does not consume on mismatch', async () => {
    const target = await startTarget(); // answers 201 for everything
    const witness = await startWitness({ runId: RUN_ID, token: TOKEN, verifierKey: VERIFIER_KEY, proxyTarget: target.url });
    try {
      const session = await openJourney(witness);
      await callProxy(journeyProxyUrl(witness, session), '/api/contracts');
      await callProxy(journeyProxyUrl(witness, session), '/api/contracts');

      // A wrong expected status matches nothing and consumes NOTHING.
      const miss = await observe(witness, session, { expectedStatus: 404 });
      expect(miss.statusCode).toBe(409);

      // The right status consumes the OLDEST matching exchange.
      const hit = await observe(witness, session, { expectedStatus: 201 });
      expect(hit.statusCode).toBe(200);

      // The second exchange is still available; a status-less consume finds it.
      const second = await observe(witness, session);
      expect(second.statusCode).toBe(200);

      // And then the shape is exhausted.
      const exhausted = await observe(witness, session);
      expect(exhausted.statusCode).toBe(409);
    } finally {
      await witness.stop();
      await target.stop();
    }
  });

  it('rejects a non-integer expectedStatus (400)', async () => {
    const target = await startTarget();
    const witness = await startWitness({ runId: RUN_ID, token: TOKEN, verifierKey: VERIFIER_KEY, proxyTarget: target.url });
    try {
      const bad = await observe(witness, null, { expectedStatus: '2xx' });
      expect(bad.statusCode).toBe(400);
    } finally {
      await witness.stop();
      await target.stop();
    }
  });
});

describe('explicit http claim selection (plan §8 step 7)', () => {
  const CLAIM_A = 'tenant.http-post-api-contracts-x1:http:request-observed';
  const CLAIM_B = 'tenant.http-post-api-contracts-x1:http:response-status-ok';

  /** A minimal VALID consumer surface (never driven by these tests). */
  const SURFACE_PLACEHOLDER: SurfaceDescriptor = {
    schemaVersion: SURFACE_DESCRIPTOR_VERSION,
    list: {
      path: '/list',
      readySelector: 'h1',
      rowSelector: 'tbody tr',
      idCellIndex: 0,
      fieldCellIndexes: { status: 3 },
    },
    create: {
      formPath: '/list/new',
      formReadySelector: 'form',
      fields: { field_a: 'input[name="field_a"]' },
      submitSelector: 'button[type="submit"]',
    },
    edit: {
      linkSelector: 'a[href$="/edit"]',
      formReadySelectorTemplate: 'form[action="/list/{id}"]',
      fields: { field_a: 'input[name="field_a"]' },
      saveSelectorTemplate: 'form[action="/list/{id}"] button',
    },
    archive: { controlSelectorTemplate: 'form[action="/list/{id}/archive"] button' },
    status: { field: 'status' },
    afterAction: { path: '/list' },
    deleteFields: { status: 'archived' },
  };

  /** A Page stand-in: http.observe never reaches the browser. */
  function dummyPage(): Page {
    return new Proxy(
      {},
      {
        get: (_target, prop) => {
          throw new Error(`dummy page: browser method '${String(prop)}' must not be reached`);
        },
      },
    ) as unknown as Page;
  }

  function testInfoOf(claims: string[]): TestInfo {
    return {
      annotations: claims.map((description) => ({ type: 'gateforge', description })),
      testId: 'selection-test-1',
      title: 'selection test',
    } as unknown as TestInfo;
  }

  /** A WitnessClient stand-in capturing the claim binding. */
  function stubClient(captured: { claimIds?: unknown }): WitnessClient {
    return {
      observeHttp: async (request: {
        claimIds?: string[];
        testId: string;
        method: string;
        path: string;
      }) => {
        captured.claimIds = request.claimIds;
        return {
          recordId: 'r1',
          runId: RUN_ID,
          trust: 'witnessed',
          status: 201,
          records: (request.claimIds ?? []).map((obligationId) => ({
            recordId: `r-${obligationId}`,
            obligationId,
          })),
        };
      },
    } as unknown as WitnessClient;
  }

  async function evidenceFor(claims: string[], captured: { claimIds?: unknown }) {
    return createEvidence({
      page: dummyPage(),
      testInfo: testInfoOf(claims),
      surface: SURFACE_PLACEHOLDER,
        client: stubClient(captured),
      session: {
        sessionId: 'harness-session',
        sessionToken: 'harness-secret',
        testId: 'selection-test-1',
        workerIndex: 0,
        proxyUrl: null,
      },
    });
  }

  it('explicit-wrong: targeting an undeclared obligation throws', async () => {
    const captured: { claimIds?: unknown } = {};
    const evidence = await evidenceFor([CLAIM_A], captured);
    await expect(
      evidence.http.observe({ method: 'POST', path: '/api/contracts', obligationId: CLAIM_B }),
    ).rejects.toThrow(/did not declare/);
    expect(captured.claimIds).toBeUndefined();
  });

  it('ambiguous-omitted: two declared claims without an explicit target throws', async () => {
    const captured: { claimIds?: unknown } = {};
    const evidence = await evidenceFor([CLAIM_A, CLAIM_B], captured);
    await expect(evidence.http.observe({ method: 'POST', path: '/api/contracts' })).rejects.toThrow(
      /ambiguous.*explicit obligationId/,
    );
    expect(captured.claimIds).toBeUndefined();
  });

  it('explicit-correct: the declared target binds exactly', async () => {
    const captured: { claimIds?: unknown } = {};
    const evidence = await evidenceFor([CLAIM_A, CLAIM_B], captured);
    const result = await evidence.http.observe({
      method: 'POST',
      path: '/api/contracts',
      obligationId: CLAIM_A,
    });
    expect(captured.claimIds).toEqual([CLAIM_A]);
    expect(result.recordIds).toEqual([`r-${CLAIM_A}`]);
  });

  it('single-claim omission still binds the only claim', async () => {
    const captured: { claimIds?: unknown } = {};
    const evidence = await evidenceFor([CLAIM_A], captured);
    const result = await evidence.http.observe({ method: 'POST', path: '/api/contracts' });
    expect(captured.claimIds).toEqual([CLAIM_A]);
    expect(result.recordIds).toEqual([`r-${CLAIM_A}`]);
  });
});

describe('F4 witness/verifier path alignment (plan §9 step 3)', () => {
  const classification = {
    exposure: 'user-facing',
    plane: 'tenant',
    primaryKey: ['method', 'path'],
    lifecycle: { create: false, read: false, update: false, delete: false },
    evidenceAdapter: 'x',
  } as const;

  /**
   * Grades one real witness-issued record for the transport contract
   * against the obligation's own endpoint inventory.
   *
   * Args:
   *   ledger: the witness-issued records.
   *   obligationId: the obligation the record was issued for.
   *
   * Returns:
   *   The engine outcome (expected `invalid` for noncanonical paths).
   */
  function gradeLedgerRecord(
    ledger: Array<Record<string, unknown>>,
    obligationId: string,
  ): ReturnType<typeof evaluateObligation> {
    const anchor = record({ obligationId });
    const obligation: Obligation = {
      ...TRANSPORT_OBLIGATION,
      id: obligationId,
      resourceId: TRANSPORT_OBLIGATION.resourceId,
    };
    return evaluateObligation(obligation, {
      claims: [{ schemaVersion: 1, obligationId, testId: 'journey-1' }],
      records: [anchor, ...ledger.filter((entry) => entry['kind'] === 'http.request')],
      waivers: [],
      classification,
      httpRoutes: [
        { resourceId: obligation.resourceId, method: 'POST', canonicalPath: '/api/contracts' },
      ],
      now: '2026-01-01T00:00:00.000Z',
    });
  }

  it('duplicate-slash traffic: clean-path consume 409s, exact consume issues a record the verifier blocks', async () => {
    const target = await startTarget();
    const witness = await startWitness({ runId: RUN_ID, token: TOKEN, verifierKey: VERIFIER_KEY, proxyTarget: target.url });
    try {
      const session = await openJourney(witness);
      // Neither side collapses: the observation is stored with `//`.
      const emitted = await callProxy(journeyProxyUrl(witness, session), '/api//contracts');
      expect(emitted.status).toBe(201);
      // The canonical clean path does NOT match the stored observation.
      const clean = await observe(witness, session);
      expect(clean.statusCode).toBe(409);
      // The exact noncanonical path consumes — but the verifier blocks
      // instead of substituting the canonical route.
      const exact = await observe(witness, session, { path: '/api//contracts' });
      expect(exact.statusCode).toBe(200);
      const ledgerResponse = await fetch(`${witness.url}/records`, {
        headers: { 'x-gateforge-run': TOKEN },
      });
      const ledger = (await ledgerResponse.json()) as { records: Array<Record<string, unknown>> };
      const outcome = gradeLedgerRecord(ledger.records, TRANSPORT_OBLIGATION.id);
      expect(outcome.verdict).toBe('invalid');
      expect(outcome.reason).toContain('duplicate slash');
    } finally {
      await witness.stop();
      await target.stop();
    }
  });

  it('encoded-slash traffic: the verifier never decodes it into a separator', async () => {
    const target = await startTarget();
    const witness = await startWitness({ runId: RUN_ID, token: TOKEN, verifierKey: VERIFIER_KEY, proxyTarget: target.url });
    try {
      const session = await openJourney(witness);
      const emitted = await callProxy(journeyProxyUrl(witness, session), '/api%2Fcontracts');
      expect(emitted.status).toBe(201);
      const exact = await observe(witness, session, { path: '/api%2Fcontracts' });
      expect(exact.statusCode).toBe(200);
      const ledgerResponse = await fetch(`${witness.url}/records`, {
        headers: { 'x-gateforge-run': TOKEN },
      });
      const ledger = (await ledgerResponse.json()) as { records: Array<Record<string, unknown>> };
      const outcome = gradeLedgerRecord(ledger.records, TRANSPORT_OBLIGATION.id);
      expect(outcome.verdict).toBe('invalid');
      expect(outcome.reason).toContain('encoded slash');
    } finally {
      await witness.stop();
      await target.stop();
    }
  });
});
