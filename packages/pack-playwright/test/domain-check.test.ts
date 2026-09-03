/**
 * Engine-class tests for the domain-check producer channel (ADR 0004 D8).
 *
 * `POST /witness/domain-check` issues a witnessed `<ns>.check` record
 * ONLY when the scenario's HTTP exchange actually traversed the
 * observation proxy (one matching observation consumed, single-use).
 * Without method/path it answers 409 — non-HTTP scenarios have no
 * engine-side producer yet, and this engine endpoint never mints claimed
 * records. The five check kinds are also accepted suite-submitted via
 * `POST /records` at the CLAIMED tier (trust follows origin): claimed
 * check records anchor the submission but can never satisfy alone.
 */
import { describe, expect, it } from 'vitest';
import { createServer, request as httpRequest, type Server } from 'node:http';
import { startWitness, type WitnessHandle } from '../src/witness/server.js';
import { RUN_HEADER } from '../src/constants.js';

const RUN_ID = '7c1e5d60-8a4b-4c2e-9d3f-1b2a3c4d5e6f';
const TOKEN = 'domain-check-run-token';
const WEBHOOK_CLAIM = 'tenant.webhooks:webhook:signature-accepted';
const AUTH_CLAIM = 'tenant.auth:auth:forged-token-rejected';
const TEST_ID = 'journey-1';

/** Minimal loopback target: POST /api/webhooks/github → 200. */
async function startTarget(): Promise<{ url: string; stop: () => Promise<void> }> {
  const server: Server = createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/api/webhooks/github') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ received: true }));
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
    path: '/api/webhooks/github',
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
  it('witnessed webhook.check from proxied traffic: payload.scenario, bound claim, single-use', async () => {
    const target = await startTarget();
    const witness = await startWitness({ runId: RUN_ID, token: TOKEN, proxyTarget: target.url });
    try {
      expect(witness.proxyUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      const driven = await callProxy(witness.proxyUrl as string, '/api/webhooks/github');
      expect(driven).toBe(200);

      const claimed = await domainCheck(witness);
      expect(claimed.statusCode).toBe(200);
      expect(claimed.body.status).toBe(200);
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
      expect(checks[0]?.payload).toMatchObject({
        scenario: 'signature-accepted',
        method: 'POST',
        url: '/api/webhooks/github',
        status: 200,
      });
    } finally {
      await witness.stop();
      await target.stop();
    }
  });

  it('fail-closed: unobserved path 409, omission 409 with the honest-gap message, unknown kind 400', async () => {
    const target = await startTarget();
    const witness = await startWitness({ runId: RUN_ID, token: TOKEN, proxyTarget: target.url });
    try {
      // No proxy traffic yet: claiming an observed-shaped path is refused.
      const unobserved = await domainCheck(witness);
      expect(unobserved.statusCode).toBe(409);
      expect(unobserved.body.error ?? '').toMatch(/no engine-observed request matches POST \/api\/webhooks\/github/);

      // Honest gap: without method/path there is no engine-side producer
      // for non-HTTP scenarios — no claimed record is ever minted here.
      const omitted = await domainCheck(witness, { method: undefined, path: undefined });
      expect(omitted.statusCode).toBe(409);
      expect(omitted.body.error ?? '').toMatch(/no engine-side producer for non-HTTP scenarios/);

      // Fail closed on the kind: only the five check namespaces produce.
      const unknownKind = await domainCheck(witness, { kind: 'widget.check' });
      expect(unknownKind.statusCode).toBe(400);

      const records = await ledgerOf(witness);
      expect(records).toHaveLength(0);
    } finally {
      await witness.stop();
      await target.stop();
    }
  });

  it('POST /records accepts check kinds suite-submitted (claimed tier, never witnessed)', async () => {
    const target = await startTarget();
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
