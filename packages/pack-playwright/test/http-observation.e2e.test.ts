/**
 * Phase 6 REAL-browser proof (playwright-evidence class per
 * docs/testing/TESTING_POLICY.md): a real chromium run issues the HTTP
 * request THROUGH the witness-owned observation proxy, and the witness
 * turns that engine observation into a witnessed `http.request` record.
 *
 * The transport-only sibling (`test/http-observation.test.ts`) drives
 * the proxy with node `http.request`; this test proves the actual
 * browser path — `page.goto(proxyUrl)` + a native form submission — so
 * "the browser issued the request" is engine-observed, not asserted.
 *
 * Honest marking: this test needs a real chromium binary. If the
 * environment lacks one it FAILS (testing policy forbids silent skips).
 * Red probe first: before the browser drives any traffic, claiming the
 * observation must be refused (409).
 */
import { describe, expect, it } from 'vitest';
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { startWitness, type WitnessHandle } from '../src/witness/server.js';
import { RUN_HEADER } from '../src/constants.js';

const RUN_ID = '2b4a6c80-1e3d-4f5a-8b7c-9d0e1f2a3b4c';
const TOKEN = 'browser-observation-run-token';
const OBLIGATION_ID = 'tenant.http-post-api-contracts-browser:http:frontend-request-observed';
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
    obligationId: OBLIGATION_ID,
    testId: TEST_ID,
    claimId: OBLIGATION_ID,
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
        records: Array<{
          kind: string;
          trust: string;
          origin: string;
          obligationId: string;
          payload: Record<string, unknown>;
        }>;
      };
      const httpRecords = ledger.records.filter((entry) => entry.kind === 'http.request');
      expect(httpRecords).toHaveLength(1);
      expect(httpRecords[0]?.trust).toBe('witnessed');
      expect(httpRecords[0]?.origin).toBe('engine-observed');
      expect(httpRecords[0]?.obligationId).toBe(OBLIGATION_ID);
      expect(httpRecords[0]?.payload).toMatchObject({
        method: 'POST',
        url: '/api/contracts',
        status: 201,
      });
    } finally {
      await witness.stop();
      await target.stop();
    }
  });
});
