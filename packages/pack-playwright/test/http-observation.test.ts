/**
 * Phase 6 engine tests: the witness-owned loopback observation proxy
 * (ADR 0004 D7). Red probe: claiming an http observation without real
 * proxied traffic fails (409). Happy path: traffic through the proxy
 * yields a witnessed `http.request` record that — together with a
 * provenanced claimed ui anchor — satisfies `http:frontend-request-observed`
 * in the real verdict engine. Suite-forged network records stay invalid.
 *
 * Mount-path coverage (phase 7): with an explicit `mountPath` the proxy
 * forwards AND records the STRIPPED backend path; without one the
 * behavior stays byte-identical.
 */
import { describe, expect, it } from 'vitest';
import { createServer, request as httpRequest, type Server } from 'node:http';
import { evaluateObligation, recordIdOf, type Obligation } from '@gateforge/core';
import { startWitness, type WitnessHandle } from '../src/witness/server.js';

const RUN_ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const TOKEN = 'observation-run-token';

const OBLIGATION: Obligation = {
  schemaVersion: 1,
  id: 'tenant.http-post-api-contracts-x1:http:frontend-request-observed',
  resourceId: 'tenant.http-post-api-contracts-x1',
  contract: 'http:frontend-request-observed',
  policyId: 'p',
  lifecycle: { create: false, read: false, update: false, delete: false },
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

function observe(
  witness: WitnessHandle,
  overrides: Record<string, unknown> = {},
): Promise<{ status: number; statusCode: number }> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      obligationId: OBLIGATION.id,
      testId: 'journey-1',
      claimId: OBLIGATION.id,
      method: 'POST',
      path: '/api/contracts',
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

describe('witness-owned observation proxy (ADR 0004 D7)', () => {
  it('red probe: no proxied traffic — the observation claim is refused (409)', async () => {
    const target = await startTarget();
    const witness = await startWitness({ runId: RUN_ID, token: TOKEN, proxyTarget: target.url });
    try {
      expect(witness.proxyUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      const result = await observe(witness);
      expect(result.statusCode).toBe(409);
    } finally {
      await witness.stop();
      await target.stop();
    }
  });

  it('real proxied traffic yields a witnessed http.request record, single-use', async () => {
    const target = await startTarget();
    const witness = await startWitness({ runId: RUN_ID, token: TOKEN, proxyTarget: target.url });
    try {
      const emitted = await callProxy(witness.proxyUrl as string, '/api/contracts');
      expect(emitted.status).toBe(201);

      const consumed = await observe(witness);
      expect(consumed.statusCode).toBe(200);
      expect(consumed.status).toBe(201);

      // Single-use: the same observation cannot be claimed twice.
      const replay = await observe(witness);
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

  it('the real verdict engine: witnessed observation + claimed anchor satisfies; forged fails', async () => {
    const target = await startTarget();
    const witness = await startWitness({ runId: RUN_ID, token: TOKEN, proxyTarget: target.url });
    try {
      await callProxy(witness.proxyUrl as string, '/api/contracts');
      await observe(witness);

      const recordsResponse = await fetch(`${witness.url}/records`, {
        headers: { 'x-gateforge-run': TOKEN },
      });
      const body = (await recordsResponse.json()) as {
        records: Array<Record<string, unknown>>;
      };
      const witnessedRequest = body.records.find((entry) => entry.kind === 'http.request');
      expect(witnessedRequest).toBeDefined();

      const anchor = record({});

      const satisfied = evaluateObligation(OBLIGATION, {
        claims: [{ schemaVersion: 1, obligationId: OBLIGATION.id, testId: 'journey-1' }],
        records: [anchor, witnessedRequest],
        waivers: [],
        classification: {
          exposure: 'user-facing',
          plane: 'tenant',
          primaryKey: ['method', 'path'],
          lifecycle: { create: false, read: false, update: false, delete: false },
          evidenceAdapter: 'x',
        },
        now: '2026-01-01T00:00:00.000Z',
      });
      if (satisfied.verdict !== 'satisfied') {
        throw new Error(`got ${satisfied.verdict}: ${satisfied.reason}`);
      }
      expect(satisfied.verdict).toBe('satisfied');

      // Suite-forged network record instead of the engine observation:
      // the gate grades it invalid, never satisfied.
      const forged = record({
        kind: 'http.request',
        origin: 'suite-submitted',
        trust: 'claimed',
        payload: { method: 'POST', url: '/api/contracts', status: 201 },
      });
      const forgedOutcome = evaluateObligation(OBLIGATION, {
        claims: [{ schemaVersion: 1, obligationId: OBLIGATION.id, testId: 'journey-1' }],
        records: [anchor, forged],
        waivers: [],
        classification: {
          exposure: 'user-facing',
          plane: 'tenant',
          primaryKey: ['method', 'path'],
          lifecycle: { create: false, read: false, update: false, delete: false },
          evidenceAdapter: 'x',
        },
        now: '2026-01-01T00:00:00.000Z',
      });
      expect(forgedOutcome.verdict).toBe('invalid');
      expect(forgedOutcome.reason).toContain('HTTP_OBSERVATION_UNTRUSTED');
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
    const witness = await startWitness({ runId: RUN_ID, token: TOKEN, proxyTarget: target.url });
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

describe('observation-proxy mount path (deployment-topology declaration)', () => {
  it('strips the mount prefix: /api/ops/x is forwarded AND recorded as /ops/x', async () => {
    const target = await startTarget();
    const witness = await startWitness({
      runId: RUN_ID,
      token: TOKEN,
      proxyTarget: target.url,
      mountPath: '/api',
    });
    try {
      // The browser calls the frontend-mounted path; the target must see
      // the STRIPPED backend path (query preserved).
      const forwarded = await callProxy(witness.proxyUrl as string, '/api/ops/x?y=1');
      expect(forwarded.status).toBe(201);
      expect(JSON.parse(forwarded.body)).toMatchObject({ path: '/ops/x?y=1' });

      // The claim references the backend-derived obligation identity.
      const consumed = await observe(witness, { path: '/ops/x' });
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
      const replay = await observe(witness, { path: '/ops/x' });
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
      proxyTarget: target.url,
      mountPath: '/api',
    });
    try {
      const forwarded = await callProxy(witness.proxyUrl as string, '/other');
      expect(forwarded.status).toBe(201);
      expect(JSON.parse(forwarded.body)).toMatchObject({ path: '/other' });
      const consumed = await observe(witness, { path: '/other' });
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
      proxyTarget: target.url,
      mountPath: null,
    });
    try {
      const forwarded = await callProxy(witness.proxyUrl as string, '/api/ops/x');
      expect(forwarded.status).toBe(201);
      expect(JSON.parse(forwarded.body)).toMatchObject({ path: '/api/ops/x' });
      const consumed = await observe(witness, { path: '/api/ops/x' });
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
