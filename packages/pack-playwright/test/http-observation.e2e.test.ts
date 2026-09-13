/**
 * Plan §8 REAL-browser transport proof (playwright-evidence class per
 * docs/testing/TESTING_POLICY.md): a real chromium run issues the HTTP
 * request THROUGH the witness-owned observation proxy, and the witness
 * turns that engine observation into a witnessed `http.request` record.
 * Transport-only: the witness observed an HTTP exchange; test
 * attribution is suite-claimed — even real browser traffic leaves
 * `http:frontend-request-observed` blocking `missing`, while
 * `http:request-observed` grades `satisfied` through the real engine.
 *
 * The Node-driven sibling (`test/http-observation.test.ts`) drives the
 * proxy with node `http.request`; this test proves the actual browser
 * path — `page.goto(proxyUrl)` + a native form submission.
 *
 * Honest marking: this test needs a real chromium binary. If the
 * environment lacks one it FAILS (testing policy forbids silent skips).
 * Red probe first: before the browser drives any traffic, claiming the
 * observation must be refused (409).
 */
import { describe, expect, it } from 'vitest';
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { evaluateObligation, recordIdOf } from '@gateforge/core';
import { startWitness, type WitnessHandle } from '../src/witness/server.js';
import { RUN_HEADER } from '../src/constants.js';

const RUN_ID = '2b4a6c80-1e3d-4f5a-8b7c-9d0e1f2a3b4c';
const TOKEN = 'browser-observation-run-token';
const FRONTEND_OBLIGATION_ID = 'tenant.http-post-api-contracts-browser:http:frontend-request-observed';
const TRANSPORT_OBLIGATION_ID = 'tenant.http-post-api-contracts-browser:http:request-observed';
const TEST_ID = 'browser-journey-1';

const TARGET_PAGE = `<!doctype html>
<html>
  <head><meta charset="utf-8"><title>Contracts</title></head>
  <body>
    <h1>Contracts</h1>
    <form method="POST" action="/api/contracts">
      <input type="hidden" name="plan" value="pro">
      <button type="submit">Create contract</button>
    </form>
  </body>
</html>
`;

/** Minimal loopback target app: `/` renders the form, POST /api/contracts → 201 JSON. */
async function startTargetApp(): Promise<{ url: string; stop: () => Promise<void> }> {
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.method === 'GET' && (req.url ?? '/') === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(TARGET_PAGE);
      return;
    }
    if (req.method === 'POST' && req.url === '/api/contracts') {
      res.writeHead(201, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, path: req.url }));
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no target app port');
  return {
    url: `http://127.0.0.1:${address.port}`,
    stop: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** Claims one engine observation as a witnessed http.request record. */
function observe(
  witness: WitnessHandle,
  overrides: Record<string, unknown> = {},
): Promise<{ statusCode: number; body: { error?: string; status?: number; recordId?: string } }> {
  const body = JSON.stringify({
    claimId: TRANSPORT_OBLIGATION_ID,
    testId: TEST_ID,
    method: 'POST',
    path: '/api/contracts',
    ...overrides,
  });
  return new Promise((resolve, reject) => {
    const forward = httpRequest(
      `${witness.url}/witness/http-observation`,
      { method: 'POST', headers: { [RUN_HEADER]: TOKEN, 'content-type': 'application/json' } },
      (res: IncomingMessage) => {
        let data = '';
        res.on('data', (chunk: Buffer) => (data += chunk.toString()));
        res.on('end', () => resolve({ statusCode: res.statusCode ?? 0, body: JSON.parse(data) }));
      },
    );
    forward.on('error', reject);
    forward.end(body);
  });
}

describe('browser-driven observation proxy (real chromium, playwright-evidence)', () => {
  it('the BROWSER POSTs through the proxy; the witness witnesses the request (red probe first)', async () => {
    const target = await startTargetApp();
    const witness = await startWitness({ runId: RUN_ID, token: TOKEN, proxyTarget: target.url });
    try {
      expect(witness.proxyUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);

      // Red probe: no browser traffic yet — the observation claim is refused.
      const redProbe = await observe(witness);
      expect(redProbe.statusCode).toBe(409);

      // Real browser: chromium navigates the PROXY and submits the form,
      // so the POST /api/contracts exchange traverses the witness-owned
      // observation proxy (engine-side, not suite-asserted).
      const { chromium } = await import('playwright');
      const browser = await chromium.launch({ headless: true });
      try {
        const context = await browser.newContext();
        const page = await context.newPage();
        await page.goto(`${witness.proxyUrl as string}/`);
        expect((await page.locator('h1').textContent())?.trim()).toBe('Contracts');
        const [response] = await Promise.all([
          page.waitForResponse(
            (res) => res.url().endsWith('/api/contracts') && res.request().method() === 'POST',
          ),
          page.click('button[type="submit"]'),
        ]);
        expect(response?.status()).toBe(201);
        await context.close();
      } finally {
        await browser.close();
      }

      // The browser-driven exchange is consumable exactly once as a
      // witnessed http.request record.
      const claimed = await observe(witness);
      expect(claimed.statusCode).toBe(200);
      expect(claimed.body.status).toBe(201);

      const replay = await observe(witness);
      expect(replay.statusCode).toBe(409);

      const recordsResponse = await fetch(`${witness.url}/records`, {
        headers: { [RUN_HEADER]: TOKEN },
      });
      const ledger = (await recordsResponse.json()) as {
        records: Array<Record<string, unknown>>;
      };
      const httpRecords = ledger.records.filter(
        (entry) => (entry as { kind?: unknown }).kind === 'http.request',
      );
      expect(httpRecords).toHaveLength(1);
      const first = httpRecords[0] as unknown as Record<string, unknown>;
      expect(first['trust']).toBe('witnessed');
      expect(first['origin']).toBe('engine-observed');
      expect(first['obligationId']).toBe(TRANSPORT_OBLIGATION_ID);
      expect(first['payload']).toMatchObject({
        method: 'POST',
        url: '/api/contracts',
        status: 201,
      });

      // Through the real engine: the browser-driven exchange satisfies
      // the explicit transport contract but leaves the frontend contract
      // blocking missing (no independent browser/test channel).
      const classification = {
        exposure: 'user-facing',
        plane: 'tenant',
        primaryKey: ['method', 'path'],
        lifecycle: { create: false, read: false, update: false, delete: false },
        evidenceAdapter: 'x',
      } as const;
      function provenancedAnchor(obligationId: string): Record<string, unknown> {
        const payload = { operation: 'create', entityId: 'browser-1' };
        const base: Record<string, unknown> = {
          schemaVersion: 1,
          runId: RUN_ID,
          trust: 'claimed',
          obligationId,
          testId: TEST_ID,
          kind: 'ui.action',
          origin: 'suite-submitted',
          payload,
        };
        base['recordId'] = recordIdOf({
          runId: RUN_ID,
          obligationId,
          kind: 'ui.action',
          testId: TEST_ID,
          origin: 'suite-submitted',
          payload,
        });
        return base;
      }
      const transportOutcome = evaluateObligation(
        {
          schemaVersion: 1,
          id: TRANSPORT_OBLIGATION_ID,
          resourceId: 'tenant.http-post-api-contracts-browser',
          contract: 'http:request-observed',
          policyId: 'p',
          lifecycle: { create: false, read: false, update: false, delete: false },
        },
        {
          claims: [{ schemaVersion: 1, obligationId: TRANSPORT_OBLIGATION_ID, testId: TEST_ID }],
          records: [provenancedAnchor(TRANSPORT_OBLIGATION_ID), ...(ledger.records as unknown[])],
          waivers: [],
          classification,
          // Complete inventory (plan §9, D2): the browser-driven
          // observation attributes to the obligation's own endpoint.
          httpRoutes: [
            {
              resourceId: 'tenant.http-post-api-contracts-browser',
              method: 'POST',
              canonicalPath: '/api/contracts',
            },
          ],
          now: '2026-01-01T00:00:00.000Z',
        },
      );
      expect(transportOutcome.verdict).toBe('satisfied');
      const frontendOutcome = evaluateObligation(
        {
          schemaVersion: 1,
          id: FRONTEND_OBLIGATION_ID,
          resourceId: 'tenant.http-post-api-contracts-browser',
          contract: 'http:frontend-request-observed',
          policyId: 'p',
          lifecycle: { create: false, read: false, update: false, delete: false },
        },
        {
          claims: [{ schemaVersion: 1, obligationId: FRONTEND_OBLIGATION_ID, testId: TEST_ID }],
          records: [
            provenancedAnchor(FRONTEND_OBLIGATION_ID),
            ...(ledger.records as unknown[]).map((entry) => ({
              ...((entry as Record<string, unknown>) ?? {}),
              obligationId: FRONTEND_OBLIGATION_ID,
            })),
          ],
          waivers: [],
          classification,
          now: '2026-01-01T00:00:00.000Z',
        },
      );
      expect(frontendOutcome.verdict).toBe('missing');
      expect(frontendOutcome.reason).toContain('no independent browser/test observation channel');
    } finally {
      await witness.stop();
      await target.stop();
    }
  });
});
