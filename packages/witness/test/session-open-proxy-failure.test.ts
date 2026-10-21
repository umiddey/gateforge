/**
 * Proxy-allocation failure while an identical re-open waits (plan
 * 20261021_0030_gf_infra_visibility P4 finish, Main's 10:1x bullet
 * item 1): the session-open catch path unregisters the session when its
 * observation proxy cannot be allocated — and must settle the session's
 * readiness gate RESOLVED (never rejected: an unobserved rejection is
 * an unhandledRejection), so the concurrent re-open wakes and answers
 * the SAME failure. Before the fix the gate never settled and the
 * re-open hung forever.
 *
 * The ::1 loopback bind refusal is injected at the OS edge (the
 * `node:http` listen call) because a loopback bind failure cannot be
 * produced deterministically from outside the process (the proxy binds
 * OS-assigned ports with bounded retries); every line of witness logic
 * under test — gate settle, unregistration re-check, failure mirroring
 * — runs for real. The delayed refusal and the pending-state probe are
 * the subject: they are wall-clock concurrency between two HTTP calls,
 * which deterministic fake timers cannot produce (rule exception,
 * named).
 */
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { RequestListener, Server } from 'node:http';
import { startWitness, type WitnessHandle } from '../src/witness/server.js';
import { RUN_HEADER, VERIFIER_HEADER } from '../src/constants.js';

/** When true, every `listen(…, '::1')` refuses after `delayMs`. */
const ipv6Refusal = vi.hoisted(() => ({ refuse: false, delayMs: 0 }));

vi.mock('node:http', async (importOriginal) => {
  const http = await importOriginal<Record<string, unknown>>();
  // Module-namespace unknown → the real createServer under its one
  // used call shape (createServer(handler)).
  const realCreateServer = http['createServer'] as (requestListener?: RequestListener) => Server;
  const wrappedCreateServer = (requestListener?: RequestListener): Server => {
    const server = realCreateServer(requestListener);
    const realListen = server.listen.bind(server) as (...listenArgs: unknown[]) => Server;
    const listenPatch = (...listenArgs: unknown[]): Server => {
      const host = listenArgs.length >= 2 ? listenArgs[1] : undefined;
      if (ipv6Refusal.refuse && typeof host === 'string' && host === '::1') {
        const error = Object.assign(
          new Error('listen EADDRNOTAVAIL ::1 (test-injected loopback IPv6 bind refusal)'),
          { code: 'EADDRNOTAVAIL' },
        );
        setTimeout(() => server.emit('error', error), ipv6Refusal.delayMs);
        return server;
      }
      return realListen(...listenArgs);
    };
    // Server.listen's overloads do not admit a variadic patch; install
    // the wrapper without a fabricated member type.
    Reflect.set(server, 'listen', listenPatch);
    return server;
  };
  return { ...http, createServer: wrappedCreateServer };
});

const RUN_ID = 'run-proxy-failure';
const RUN_BEARER = 'token-proxy-failure';
const VERIFIER_KEY = 'verifier-proxy-failure';

/** Witnesses started by the suite, stopped after it. */
const WITNESSES: WitnessHandle[] = [];

afterAll(async () => {
  for (const witness of WITNESSES.splice(0)) await witness.stop();
});

/**
 * One witness with an observation proxy wired: every session open then
 * allocates its DEDICATED proxy listeners (one per loopback address the
 * target hostname resolves to — here `localhost` → 127.0.0.1 and ::1).
 * The upstream is never contacted: the bind fails first.
 */
async function startProxyWitness(): Promise<WitnessHandle> {
  const witness = await startWitness({
    runId: RUN_ID,
    token: RUN_BEARER,
    verifierKey: VERIFIER_KEY,
    proxyTarget: 'http://localhost:9',
  });
  WITNESSES.push(witness);
  return witness;
}

/** Supervisor-channel headers: run token + verifier key (every gate needs these). */
function supervisorHeaders(): Record<string, string> {
  return {
    [RUN_HEADER]: RUN_BEARER,
    [VERIFIER_HEADER]: VERIFIER_KEY,
    'content-type': 'application/json',
  };
}

async function openSession(witness: WitnessHandle, body: Record<string, unknown>): Promise<Response> {
  return fetch(`${witness.url}/sessions/open`, {
    method: 'POST',
    headers: supervisorHeaders(),
    body: JSON.stringify(body),
  });
}

async function resolveSession(witness: WitnessHandle, testId: string): Promise<Response> {
  return fetch(`${witness.url}/sessions/resolve`, {
    method: 'POST',
    headers: supervisorHeaders(),
    body: JSON.stringify({ testId, workerIndex: 0 }),
  });
}

/** Narrows an error body to its message (validated, never cast). */
function errorOf(body: unknown): string {
  if (typeof body === 'object' && body !== null && 'error' in body && typeof body.error === 'string') {
    return body.error;
  }
  throw new Error(`no error field in answer: ${JSON.stringify(body)}`);
}

// The waits below are real timers: the delayed bind refusal IS the
// awaited condition (the re-open must arrive while the allocation is in
// flight), which fake timers cannot express — and this project's
// ES2023 test lib has no Promise.withResolvers (see the P1 concurrency
// test), so the executor form stays (rule exceptions, named).
const wait = (ms: number): Promise<void> => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

describe('session open settles its readiness gate when the proxy allocation fails (plan P4 finish)', () => {
  it('answers a re-open that waited behind a proxy allocation failure — no hang, never 200', async () => {
    const witness = await startProxyWitness();
    // Refuse the ::1 loopback bind 1.2 s in: by then the first open is
    // REGISTERED with its proxy allocation in flight — exactly the
    // drain-retry window.
    ipv6Refusal.refuse = true;
    ipv6Refusal.delayMs = 1_200;
    try {
      const openBody = { testId: 'proxy-failure-reopen', workerIndex: 0 };
      const startedAt = performance.now();
      const firstPromise = openSession(witness, openBody);
      await wait(200);
      const reOpenPromise = openSession(witness, openBody);
      const [first, reOpen] = await Promise.all([firstPromise, reOpenPromise]);
      const elapsedMs = performance.now() - startedAt;
      // The original open fails with the bind failure (500).
      expect(first.status).toBe(500);
      expect(errorOf(await first.json())).toMatch(/failed to bind/);
      // The re-open woke on the SETTLED gate and mirrored the same
      // failure — before the fix it awaited a promise nobody ever
      // settled and hung until the runner's own timeout.
      expect(reOpen.status).toBe(500);
      expect(errorOf(await reOpen.json())).toMatch(/failed to bind/);
      expect(elapsedMs).toBeLessThan(10_000);
      // The failed session is gone: resolve refuses it like an unknown
      // one, and the worker slot is free.
      const resolved = await resolveSession(witness, 'proxy-failure-reopen');
      expect(resolved.status).toBe(404);
    } finally {
      ipv6Refusal.refuse = false;
    }
  }, 10_000);
});
