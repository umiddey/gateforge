/**
 * Engine-class tests for the domain-check producer channel (ADR 0004 D8).
 *
 * `POST /witness/domain-check` issues a witnessed `<ns>.check` record
 * ONLY when the scenario's HTTP exchange actually traversed the
 * observation proxy, and the witness DERIVES the outcome class from the
 * status it actually observed — the suite only names the scenario:
 *
 * - accepted scenarios are evidenced by 2xx, rejected scenarios by 4xx;
 *   a contradiction is refused with 409 and consumes NOTHING;
 * - dual-observation idempotency scenarios (`replay-idempotent`,
 *   `idempotent`, `duplicate-delivery-handled`) consume TWO matching
 *   observations single-use;
 * - a scenario outside the kind's namespace table is 400;
 * - without method/path it answers 409 — non-HTTP scenarios have no
 *   engine-side producer yet, and this engine endpoint never mints
 *   claimed records.
 *
 * The five check kinds are also accepted suite-submitted via
 * `POST /records` at the CLAIMED tier (trust follows origin): claimed
 * check records anchor the submission but can never satisfy alone.
 */
import { describe, expect, it } from 'vitest';
import { createServer, request as httpRequest, type Server } from 'node:http';
import { createHash } from 'node:crypto';
import { startWitness, type WitnessHandle } from '../src/witness/server.js';
import { RUN_HEADER } from '../src/constants.js';

const RUN_ID = '7c1e5d60-8a4b-4c2e-9d3f-1b2a3c4d5e6f';
const TOKEN = 'domain-check-run-token';
const WEBHOOK_CLAIM = 'tenant.webhooks:webhook:signature-accepted';
const AUTH_CLAIM = 'tenant.auth:auth:forged-token-rejected';
const TEST_ID = 'journey-1';
const WEBHOOK_PATH = '/api/webhooks/github';
const ACCEPTED_BODY = JSON.stringify({ received: true });
const REJECTED_BODY = JSON.stringify({ error: 'invalid signature' });

/** Minimal loopback target: POST /api/webhooks/github → <status, body>. */
async function startTarget(
  status: number,
  body: string,
): Promise<{ url: string; stop: () => Promise<void> }> {
  const server: Server = createServer((req, res) => {
    if (req.method === 'POST' && req.url === WEBHOOK_PATH) {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(body);
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
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

/** Drives one POST through the witness-owned observation proxy. */
function callProxy(proxyUrl: string, path: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const forward = httpRequest(`${proxyUrl}${path}`, { method: 'POST' }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode ?? 0));
    });
    forward.on('error', reject);
    forward.end();
  });
}

interface DomainCheckResult {
  statusCode: number;
  body: { error?: string; recordId?: string; trust?: string; status?: number };
}

function domainCheck(
  witness: WitnessHandle,
  overrides: Record<string, unknown> = {},
): Promise<DomainCheckResult> {
  const body = JSON.stringify({
    obligationId: WEBHOOK_CLAIM,
    testId: TEST_ID,
    claimId: WEBHOOK_CLAIM,
    kind: 'webhook.check',
    scenario: 'signature-accepted',
    method: 'POST',
    path: WEBHOOK_PATH,
    ...overrides,
  });
  return new Promise((resolve, reject) => {
    const forward = httpRequest(
      `${witness.url}/witness/domain-check`,
      { method: 'POST', headers: { [RUN_HEADER]: TOKEN, 'content-type': 'application/json' } },
      (res) => {
        let data = '';
        res.on('data', (chunk: Buffer) => (data += chunk.toString()));
        res.on('end', () => resolve({ statusCode: res.statusCode ?? 0, body: JSON.parse(data) }));
      },
    );
    forward.on('error', reject);
    forward.end(body);
  });
}

async function ledgerOf(
  witness: WitnessHandle,
): Promise<Array<{ kind: string; trust: string; origin: string; obligationId: string; testId: string; payload: Record<string, unknown> }>> {
  const response = await fetch(`${witness.url}/records`, { headers: { [RUN_HEADER]: TOKEN } });
  const body = (await response.json()) as { records: Array<Record<string, unknown>> };
  return body.records as never;
}

describe('domain-check producer channel (ADR 0004 D8)', () => {
  it('witnessed webhook.check derives outcome ACCEPTED from the observed 201 (exact contract payload, single-use)', async () => {
    const target = await startTarget(201, ACCEPTED_BODY);
    const witness = await startWitness({ runId: RUN_ID, token: TOKEN, proxyTarget: target.url });
    try {
      expect(witness.proxyUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      const driven = await callProxy(witness.proxyUrl as string, WEBHOOK_PATH);
      expect(driven).toBe(201);

      const claimed = await domainCheck(witness);
      expect(claimed.statusCode).toBe(200);
      expect(claimed.body.status).toBe(201);
      expect(claimed.body.trust).toBe('witnessed');

      // Single-use: the same observation cannot be claimed twice.
      const replay = await domainCheck(witness);
      expect(replay.statusCode).toBe(409);

      const records = await ledgerOf(witness);
      const checks = records.filter((entry) => entry.kind === 'webhook.check');
      expect(checks).toHaveLength(1);
      expect(checks[0]?.trust).toBe('witnessed');
      expect(checks[0]?.origin).toBe('engine-observed');
      expect(checks[0]?.obligationId).toBe(WEBHOOK_CLAIM);
      expect(checks[0]?.testId).toBe(TEST_ID);
      // EXACT contract payload: the witness derived the outcome from the
      // observed status and hashed the response body it actually saw; no
      // `observations` key for a single-observation scenario.
      expect(checks[0]?.payload).toEqual({
        scenario: 'signature-accepted',
        outcome: 'accepted',
        method: 'POST',
        url: WEBHOOK_PATH,
        status: 201,
        responseSha256: createHash('sha256').update(ACCEPTED_BODY).digest('hex'),
        responseBytes: Buffer.byteLength(ACCEPTED_BODY),
      });
      const payload = checks[0]?.payload as Record<string, unknown>;
      expect(payload['responseSha256']).toMatch(/^[0-9a-f]{64}$/);
      expect(payload['responseBytes']).toBeGreaterThan(0);
    } finally {
      await witness.stop();
      await target.stop();
    }
  });

  it('red probe now honest: a proxied 401 evidences signature-rejected (outcome REJECTED)', async () => {
    const target = await startTarget(401, REJECTED_BODY);
    const witness = await startWitness({ runId: RUN_ID, token: TOKEN, proxyTarget: target.url });
    try {
      const driven = await callProxy(witness.proxyUrl as string, WEBHOOK_PATH);
      expect(driven).toBe(401);

      const claimed = await domainCheck(witness, { scenario: 'signature-rejected' });
      expect(claimed.statusCode).toBe(200);
      expect(claimed.body.status).toBe(401);
      expect(claimed.body.trust).toBe('witnessed');

      const records = await ledgerOf(witness);
      const checks = records.filter((entry) => entry.kind === 'webhook.check');
      expect(checks).toHaveLength(1);
      expect(checks[0]?.trust).toBe('witnessed');
      expect(checks[0]?.origin).toBe('engine-observed');
      expect(checks[0]?.payload).toEqual({
        scenario: 'signature-rejected',
        outcome: 'rejected',
        method: 'POST',
        url: WEBHOOK_PATH,
        status: 401,
        responseSha256: createHash('sha256').update(REJECTED_BODY).digest('hex'),
        responseBytes: Buffer.byteLength(REJECTED_BODY),
      });
      const payload = checks[0]?.payload as Record<string, unknown>;
      expect(payload['responseSha256']).toMatch(/^[0-9a-f]{64}$/);
      expect(payload['responseBytes']).toBeGreaterThan(0);
    } finally {
      await witness.stop();
      await target.stop();
    }
  });

  it('refusal: a 201 cannot evidence signature-rejected, and the refusal consumes NOTHING', async () => {
    const target = await startTarget(201, ACCEPTED_BODY);
    const witness = await startWitness({ runId: RUN_ID, token: TOKEN, proxyTarget: target.url });
    try {
      const driven = await callProxy(witness.proxyUrl as string, WEBHOOK_PATH);
      expect(driven).toBe(201);

      // The contradiction is refused with the engine-observation wording.
      const refused = await domainCheck(witness, { scenario: 'signature-rejected' });
      expect(refused.statusCode).toBe(409);
      expect(refused.body.error ?? '').toBe(
        "engine observed status(s) 201 which cannot evidence scenario 'signature-rejected'; " +
          'drive the exchange the scenario describes',
      );

      // Nothing was consumed: the honest accepted-scenario claim on the
      // SAME observation still succeeds.
      const honest = await domainCheck(witness);
      expect(honest.statusCode).toBe(200);
      expect(honest.body.status).toBe(201);

      // And single-use is still enforced afterwards.
      const replay = await domainCheck(witness);
      expect(replay.statusCode).toBe(409);

      const records = await ledgerOf(witness);
      const checks = records.filter((entry) => entry.kind === 'webhook.check');
      expect(checks).toHaveLength(1);
      expect(checks[0]?.payload).toMatchObject({
        scenario: 'signature-accepted',
        outcome: 'accepted',
        status: 201,
      });
    } finally {
      await witness.stop();
      await target.stop();
    }
  });

  it('fail-closed: unobserved path 409, omission 409 with the honest-gap message, unknown kind/scenario 400', async () => {
    const target = await startTarget(201, ACCEPTED_BODY);
    const witness = await startWitness({ runId: RUN_ID, token: TOKEN, proxyTarget: target.url });
    try {
      // No proxy traffic yet: claiming an observed-shaped path is refused.
      const unobserved = await domainCheck(witness);
      expect(unobserved.statusCode).toBe(409);
      expect(unobserved.body.error ?? '').toMatch(
        `no engine-observed request matches POST ${WEBHOOK_PATH}`,
      );

      // Honest gap: without method/path there is no engine-side producer
      // for non-HTTP scenarios — no claimed record is ever minted here.
      const omitted = await domainCheck(witness, { method: undefined, path: undefined });
      expect(omitted.statusCode).toBe(409);
      expect(omitted.body.error ?? '').toMatch(/no engine-side producer for non-HTTP scenarios/);

      // Fail closed on the kind: only the five check namespaces produce.
      const unknownKind = await domainCheck(witness, { kind: 'widget.check' });
      expect(unknownKind.statusCode).toBe(400);

      // Fail closed on the scenario: not in the kind's namespace table —
      // neither a made-up name nor another namespace's scenario verb.
      const madeUp = await domainCheck(witness, { scenario: 'made-up-scenario' });
      expect(madeUp.statusCode).toBe(400);
      expect(madeUp.body.error ?? '').toMatch(/not part of the 'webhook\.check' namespace table/);
      const foreign = await domainCheck(witness, { kind: 'auth.check', scenario: 'signature-rejected' });
      expect(foreign.statusCode).toBe(400);

      const records = await ledgerOf(witness);
      expect(records).toHaveLength(0);
    } finally {
      await witness.stop();
      await target.stop();
    }
  });

  it('dual-observation scenario: one observation is 409 (nothing consumed), two requests yield observations: 2', async () => {
    const target = await startTarget(200, ACCEPTED_BODY);
    const witness = await startWitness({ runId: RUN_ID, token: TOKEN, proxyTarget: target.url });
    try {
      // First exchange alone cannot evidence an idempotency proof.
      const first = await callProxy(witness.proxyUrl as string, WEBHOOK_PATH);
      expect(first).toBe(200);
      const premature = await domainCheck(witness, { scenario: 'replay-idempotent' });
      expect(premature.statusCode).toBe(409);
      expect(premature.body.error ?? '').toMatch(
        /TWO engine-observed requests matching POST .* but only 1 was observed/,
      );

      // The premature claim consumed nothing: the ledger is still empty
      // and the second exchange completes the pair.
      const second = await callProxy(witness.proxyUrl as string, WEBHOOK_PATH);
      expect(second).toBe(200);
      const claimed = await domainCheck(witness, { scenario: 'replay-idempotent' });
      expect(claimed.statusCode).toBe(200);
      expect(claimed.body.status).toBe(200);
      expect(claimed.body.trust).toBe('witnessed');

      // Both observations were consumed single-use.
      const replay = await domainCheck(witness, { scenario: 'replay-idempotent' });
      expect(replay.statusCode).toBe(409);

      const records = await ledgerOf(witness);
      const checks = records.filter((entry) => entry.kind === 'webhook.check');
      expect(checks).toHaveLength(1);
      // Dual payload: the LAST observation's status/body + observations: 2.
      expect(checks[0]?.payload).toEqual({
        scenario: 'replay-idempotent',
        outcome: 'accepted',
        method: 'POST',
        url: WEBHOOK_PATH,
        status: 200,
        responseSha256: createHash('sha256').update(ACCEPTED_BODY).digest('hex'),
        responseBytes: Buffer.byteLength(ACCEPTED_BODY),
        observations: 2,
      });
    } finally {
      await witness.stop();
      await target.stop();
    }
  });

  it('POST /records accepts check kinds suite-submitted (claimed tier, never witnessed)', async () => {
    const target = await startTarget(201, ACCEPTED_BODY);
    const witness = await startWitness({ runId: RUN_ID, token: TOKEN, proxyTarget: target.url });
    try {
      const response = await fetch(`${witness.url}/records`, {
        method: 'POST',
        headers: { [RUN_HEADER]: TOKEN, 'content-type': 'application/json' },
        body: JSON.stringify({
          claimId: AUTH_CLAIM,
          kind: 'auth.check',
          payload: { scenario: 'forged-token-rejected', observed: false },
          testId: TEST_ID,
        }),
      });
      expect(response.status).toBe(200);
      const issued = (await response.json()) as { recordId: string; trust: string };
      expect(issued.trust).toBe('claimed');

      const records = await ledgerOf(witness);
      const authChecks = records.filter((entry) => entry.kind === 'auth.check');
      expect(authChecks).toHaveLength(1);
      expect(authChecks[0]?.trust).toBe('claimed');
      expect(authChecks[0]?.origin).toBe('suite-submitted');
      expect(authChecks[0]?.obligationId).toBe(AUTH_CLAIM);
      expect(authChecks[0]?.payload).toMatchObject({ scenario: 'forged-token-rejected' });
    } finally {
      await witness.stop();
      await target.stop();
    }
  });
});
