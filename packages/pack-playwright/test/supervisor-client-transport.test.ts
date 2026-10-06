/**
 * Supervisor transport tests: the client's HTTP exchange honours ONLY
 * the computed budget — never a transport-internal default. Pure and
 * offline (a local loopback server; no witness stack, no browsers).
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SupervisorClient } from '../src/supervisor/client.js';
import { WitnessRequestError } from '../src/fixture/witness-client.js';

const servers: Server[] = [];

async function listen(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('transport server did not bind TCP');
  return `http://127.0.0.1:${address.port}`;
}

afterEach(async () => {
  vi.unstubAllGlobals();
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});

const SWEEP = {
  audience: 'public',
  pages: [{ id: 'orders', path: '/orders' }],
  loginRoutes: [],
  errorMarkers: [],
  liveChannels: [],
};

describe('supervisor client transport', () => {
  it('does not route through global fetch: a sweep succeeds even when fetch is broken', async () => {
    const url = await listen((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ visits: [{ page: '/orders' }] }));
    });
    vi.stubGlobal('fetch', async () => {
      throw new Error('global fetch must not carry supervisor calls');
    });
    const supervisor = new SupervisorClient(url, 'token', 'verifier', 5_000);
    const result = await supervisor.sweepPages(SWEEP);
    expect(result.visits).toEqual([{ page: '/orders' }]);
  });

  it('a slow sweep answers within a budget larger than the delay', async () => {
    // Real wall-clock socket delay: the point is the transport's REAL
    // deadline (undici's fixed header timeout vs our budget), which no
    // fake clock can exercise — same pattern as witness-client-timing.
    const url = await listen((_request, response) => {
      setTimeout(() => {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ visits: [] }));
      }, 2_000);
    });
    const supervisor = new SupervisorClient(url, 'token', 'verifier', 5_000);
    const result = await supervisor.sweepPages({ ...SWEEP, pages: [{ id: 'slow', path: '/slow' }] });
    expect(result.visits).toEqual([]);
  }, 15_000);

  it('a budget shorter than the delay aborts with the existing typed error', async () => {
    // Real wall-clock socket delay (see above): fake timers cannot
    // exercise the transport's real abort path.
    const url = await listen((_request, response) => {
      setTimeout(() => {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ visits: [] }));
      }, 2_000);
    });
    const supervisor = new SupervisorClient(url, 'token', 'verifier', 1_000);
    // No pages: the sweep budget is exactly the 1 s base timeout, so a
    // 2 s-delayed answer must hit the deadline.
    const error = await supervisor
      .sweepPages({ ...SWEEP, pages: [] })
      .then(
        () => null,
        (failure: unknown) => failure,
      );
    expect(error).toBeInstanceOf(WitnessRequestError);
    expect((error as WitnessRequestError).status).toBe(0);
    expect((error as WitnessRequestError).message).toContain('supervisor call to /runs/page-sweep failed:');
  }, 15_000);

  it('executionTrace also bypasses global fetch', async () => {
    const url = await listen((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ tests: [] }));
    });
    vi.stubGlobal('fetch', async () => {
      throw new Error('global fetch must not carry supervisor calls');
    });
    const supervisor = new SupervisorClient(url, 'token', 'verifier', 5_000);
    const trace = await supervisor.executionTrace();
    expect(trace).toEqual({ tests: [] });
  });
});
