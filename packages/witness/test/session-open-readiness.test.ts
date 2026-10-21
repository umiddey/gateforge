/**
 * Session-open readiness (plan 20261021_0030_gf_infra_visibility P4
 * rework, per Main's 08:5x review bullet): a session must be REGISTERED
 * the moment its open arrives — the drain re-opens the identical
 * (worker, testId) pair exactly once on a transport loss (the 5 s
 * client timeout included) and that retry is only a recovery because
 * the witness answers it with the SAME session — while a registered
 * session must not be USABLE until its Observe before-snapshots are
 * stored.
 *
 * Three gates:
 *  - an identical re-open while the first open's snapshots are still
 *    running returns the SAME sessionId and mints no second session
 *    (the previous "register only after the snapshots" fix minted a
 *    second session plus proxy there — the orphan-session regression
 *    Main's review flagged);
 *  - /sessions/resolve refuses a not-ready session exactly like an
 *    unknown one (404) — the before-state must exist before the test
 *    acts (the plan's Forbidden invariant);
 *  - a DIFFERENT test's open on the same worker while the bound
 *    session is still not ready unbinds that abandoned session and
 *    opens immediately: the abandoned session's credential never
 *    shipped (open response and resolve both gate on readiness), so
 *    the trusted supervisor's new open for the worker is the lifecycle
 *    signal that the previous test ended — the next test on that
 *    worker must never be 409-refused by a session whose response died
 *    with its transport.
 *
 * The real-timer waits here (adapter list delays, the pending-state
 * probe and the open-latency bound) are the SUBJECT: readiness is a
 * wall-clock property of the snapshot round, which deterministic fake
 * timers cannot produce (rule exception, named per the test-timer
 * rule).
 */
import { createServer, type Server } from 'node:http';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { startWitness, type WitnessHandle } from '../src/witness/server.js';
import { ENV_FINGERPRINT_HEADER, RUN_HEADER, VERIFIER_HEADER } from '../src/constants.js';

/** A started loopback fingerprint target and its closer. */
interface FingerprintTarget {
  url: string;
  stop: () => Promise<void>;
}

const RUN_ID = 'run-open-readiness';
const RUN_BEARER = 'token-open-readiness';
const VERIFIER_KEY = 'verifier-open-readiness';
const SLOW_MS = 1_500;
const FAST_MS = 250;
const FINGERPRINT = 'fp-open-readiness';
const SLOW_RESOURCE = 'r-slow';
const FAST_RESOURCE = 'r-fast';
const SLOW_CLAIM = `${SLOW_RESOURCE}:persistence:create`;
const FAST_CLAIM = `${FAST_RESOURCE}:persistence:create`;

/** Witnesses and targets started by the suite, stopped after it. */
const WITNESSES: WitnessHandle[] = [];
const TARGETS: FingerprintTarget[] = [];
const ADAPTER_DIRS: string[] = [];

afterAll(async () => {
  for (const witness of WITNESSES.splice(0)) await witness.stop();
  for (const target of TARGETS.splice(0)) await target.stop();
  for (const dir of ADAPTER_DIRS.splice(0)) rmSync(join(dir, '..'), { recursive: true, force: true });
});

/** Loopback target every adapter reads: answers GET with the marker header. */
async function startFingerprintTarget(): Promise<FingerprintTarget> {
  const server: Server = createServer((_req, res) => {
    res.writeHead(200, {
      'content-type': 'application/json',
      [ENV_FINGERPRINT_HEADER]: FINGERPRINT,
    });
    res.end('{}');
  });
  // Real timer with a named subject: the adapter delay under test is a
  // wall-clock property (rule exception). This project's ES2023 lib has
  // no Promise.withResolvers (see the P1 concurrency test), so the
  // executor form stays.
  await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('fingerprint target failed to bind');
  }
  return {
    url: `http://127.0.0.1:${String(address.port)}`,
    stop: () => new Promise<void>((resolveClose) => server.close(() => resolveClose())),
  };
}

/** One adapter per resource, as the registry loads `.mjs` files. */
function adapterSource(resourceId: string, delayMs: number, baseUrl: string): string {
  return `
const delay = (ms) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
export default {
  read: async () => null,
  normalize: (body) => ({
    entityId: body === null || body === undefined ? null : body.id,
    fields: {},
  }),
  deletion: 'hard',
  environmentFingerprint: ${JSON.stringify(FINGERPRINT)},
  baseUrl: ${JSON.stringify(baseUrl)},
  list: async () => {
    await delay(${JSON.stringify(delayMs)});
    return [];
  },
  observe: { create: { method: 'POST', path: ${JSON.stringify(`/api/${resourceId}`)} } },
};
`;
}

/** Supervisor-channel headers: run token + verifier key (every gate needs these). */
function supervisorHeaders(): Record<string, string> {
  return {
    [RUN_HEADER]: RUN_BEARER,
    [VERIFIER_HEADER]: VERIFIER_KEY,
    'content-type': 'application/json',
  };
}

/** Narrows an untyped session-view body (open/resolve answer) to its credential. */
function sessionOf(body: unknown): { sessionId: string; sessionToken: string } {
  if (typeof body !== 'object' || body === null || !('sessionId' in body) || !('sessionToken' in body)) {
    throw new Error(`no session view in answer: ${JSON.stringify(body)}`);
  }
  const candidate = body as Record<string, unknown>;
  if (typeof candidate['sessionId'] !== 'string' || typeof candidate['sessionToken'] !== 'string') {
    throw new Error('session view carried non-string credential fields');
  }
  return { sessionId: candidate['sessionId'], sessionToken: candidate['sessionToken'] };
}

/** Narrows an execution-trace body to its per-session id lists. */
function traceSessionIds(body: unknown): string[][] {
  if (typeof body !== 'object' || body === null || !('tests' in body)) {
    throw new Error(`no execution trace in answer: ${JSON.stringify(body)}`);
  }
  const candidate = body as { tests: unknown };
  if (!Array.isArray(candidate.tests)) throw new Error('execution trace carried no tests array');
  return candidate.tests.map((entry) => {
    if (typeof entry !== 'object' || entry === null || !('sessions' in entry)) {
      throw new Error('execution trace test carried no sessions');
    }
    const sessions = (entry as { sessions: unknown }).sessions;
    if (!Array.isArray(sessions)) throw new Error('execution trace sessions is no array');
    return sessions.map((session) => {
      const id = typeof session === 'object' && session !== null && 'sessionId' in session
        ? (session as { sessionId: unknown }).sessionId
        : undefined;
      if (typeof id !== 'string') throw new Error('traced session carried no sessionId');
      return id;
    });
  });
}

/** One fresh witness with the slow and the fast observe resource declared. */
async function startReadyWitness(): Promise<WitnessHandle> {
  const target = await startFingerprintTarget();
  TARGETS.push(target);
  const adaptersDir = join(mkdtempSync(join(tmpdir(), 'gf-open-readiness-')), 'adapters');
  ADAPTER_DIRS.push(adaptersDir);
  mkdirSync(adaptersDir, { recursive: true });
  writeFileSync(join(adaptersDir, `${SLOW_RESOURCE}.mjs`), adapterSource(SLOW_RESOURCE, SLOW_MS, target.url));
  writeFileSync(join(adaptersDir, `${FAST_RESOURCE}.mjs`), adapterSource(FAST_RESOURCE, FAST_MS, target.url));
  const witness = await startWitness({ runId: RUN_ID, token: RUN_BEARER, verifierKey: VERIFIER_KEY, adaptersDir });
  WITNESSES.push(witness);
  const bound = await fetch(`${witness.url}/runs/observe-declarations`, {
    method: 'POST',
    headers: supervisorHeaders(),
    body: JSON.stringify({ obligations: [SLOW_CLAIM, FAST_CLAIM] }),
  });
  expect(bound.status).toBe(200);
  return witness;
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

// Real timer shared by every gate's pending-state probe below; the wait
// IS the awaited condition (the snapshot round is wall-clock work, no
// event signals "still pending"), so fake timers cannot express it
// (rule exception, named per the test-timer rule). This project's
// ES2023 lib has no Promise.withResolvers (see the P1 concurrency test).
const wait = (ms: number): Promise<void> => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

describe('session open registers at once but resolves only when ready (plan P4 rework)', () => {
  it('answers a re-open of a pending session with the SAME session and mints no second one', async () => {
    const witness = await startReadyWitness();
    const openBody = { testId: 're-open-pending', workerIndex: 0, claims: [SLOW_CLAIM, FAST_CLAIM] };
    const firstPromise = openSession(witness, openBody);
    // The first open is now REGISTERED but its before-snapshots are
    // still running (1.5 s slow list). Give the registration a beat,
    // then re-open the identical (worker, testId) pair — the drain's
    // transport-loss retry shape.
    await wait(200);
    const reOpenPromise = openSession(witness, openBody);
    // The re-open must NOT answer while the first open's snapshots run:
    // it awaits the SAME readiness, never mints a second session. The
    // real-timer probe is the subject (an early answer is the failure).
    const stillPending = await Promise.race([
      reOpenPromise.then(() => 'answered' as const),
      wait(200).then(() => 'pending' as const),
    ]);
    expect(stillPending).toBe('pending');
    const [first, reOpen] = await Promise.all([firstPromise, reOpenPromise]);
    expect(first.status).toBe(200);
    expect(reOpen.status).toBe(200);
    const firstSession = sessionOf(await first.json());
    const reOpenedSession = sessionOf(await reOpen.json());
    expect(reOpenedSession.sessionId).toBe(firstSession.sessionId);
    expect(reOpenedSession.sessionToken).toBe(firstSession.sessionToken);
    // Exactly ONE session exists: without an expected set the trace
    // keys every session by its own id, so a second mint would appear
    // as a second test entry (and a second session proxy with it).
    const trace = await fetch(`${witness.url}/runs/execution-trace`, { headers: supervisorHeaders() });
    expect(trace.status).toBe(200);
    expect(traceSessionIds(await trace.json())).toEqual([[firstSession.sessionId]]);
    // Now that it is ready, the worker's resolve hands out that one
    // session.
    const resolved = await resolveSession(witness, 're-open-pending');
    expect(resolved.status).toBe(200);
    expect(sessionOf(await resolved.json()).sessionId).toBe(firstSession.sessionId);
  });

  it('refuses resolve for a not-ready session exactly like an unknown one', async () => {
    const witness = await startReadyWitness();
    const openPromise = openSession(witness, {
      testId: 'resolve-gated',
      workerIndex: 0,
      claims: [SLOW_CLAIM, FAST_CLAIM],
    });
    // The session is registered but its before-state does not exist
    // yet: resolve must not hand it out (404, the unknown-session
    // answer) — the fixture's bounded wait keeps polling instead of
    // acting against a half-open session.
    await wait(200);
    const pendingResolve = await resolveSession(witness, 'resolve-gated');
    expect(pendingResolve.status).toBe(404);
    const opened = await openPromise;
    expect(opened.status).toBe(200);
    const session = sessionOf(await opened.json());
    const readyResolve = await resolveSession(witness, 'resolve-gated');
    expect(readyResolve.status).toBe(200);
    expect(sessionOf(await readyResolve.json()).sessionId).toBe(session.sessionId);
  });

  it('unbinds an abandoned still-pending session when the same worker opens a different test', async () => {
    const witness = await startReadyWitness();
    const slowOpenPromise = openSession(witness, {
      testId: 'abandoned-slow',
      workerIndex: 0,
      claims: [SLOW_CLAIM],
    });
    // The slow session is registered and snapshotting. The worker's
    // next test now opens: it must open on its OWN fast snapshot only —
    // never wait for the abandoned round, never be 409-refused. The
    // real-timer bound is the subject (waiting for the slow readiness
    // would blow the follower's own 5 s budget in production).
    await wait(200);
    const fastOpenedAt = performance.now();
    const fastOpen = await openSession(witness, {
      testId: 'next-fast',
      workerIndex: 0,
      claims: [FAST_CLAIM],
    });
    const fastElapsedMs = performance.now() - fastOpenedAt;
    expect(fastOpen.status).toBe(200);
    expect(fastElapsedMs).toBeLessThan(SLOW_MS);
    const fastSession = sessionOf(await fastOpen.json());
    // The abandoned session finishes its snapshots into its own record,
    // but stays unresolvable forever: its credential never shipped and
    // its worker binding is gone. Expectation updated by plan P4 finish
    // (Main 10:1x): the abandoned open answers the recorded FAILURE
    // (500) — never 200, whose session view would hand out a credential
    // every submission refuses.
    const slowOpen = await slowOpenPromise;
    expect(slowOpen.status).toBe(500);
    const slowBody: unknown = await slowOpen.json();
    const slowError =
      typeof slowBody === 'object' && slowBody !== null && 'error' in slowBody && typeof slowBody.error === 'string'
        ? slowBody.error
        : JSON.stringify(slowBody);
    expect(slowError).toMatch(/moved to a different test/);
    const slowResolve = await resolveSession(witness, 'abandoned-slow');
    expect(slowResolve.status).toBe(404);
    const fastResolve = await resolveSession(witness, 'next-fast');
    expect(fastResolve.status).toBe(200);
    expect(sessionOf(await fastResolve.json()).sessionId).toBe(fastSession.sessionId);
  });

  it('seals a not-ready session only after its before-snapshots finished (close)', async () => {
    const witness = await startReadyWitness();
    const openStartedAt = performance.now();
    const openPromise = openSession(witness, {
      testId: 'close-waits',
      workerIndex: 0,
      claims: [SLOW_CLAIM, FAST_CLAIM],
    });
    // The session is REGISTERED but its before-snapshots are running.
    // The open answer has not shipped, so the close learns the session
    // id from the supervisor trace (the drain's own read surface).
    await wait(200);
    const trace = await fetch(`${witness.url}/runs/execution-trace`, { headers: supervisorHeaders() });
    expect(trace.status).toBe(200);
    const [pendingId] = traceSessionIds(await trace.json()).flat();
    expect(typeof pendingId).toBe('string');
    const close = await fetch(`${witness.url}/sessions/close`, {
      method: 'POST',
      headers: supervisorHeaders(),
      body: JSON.stringify({ sessionId: pendingId, outcome: 'passed' }),
    });
    // The seal waited out the snapshot round: a late snapshot can never
    // store before-state into an already sealed session (plan P4 finish
    // item 2). Before the fix the close answered while the round ran.
    expect(close.status).toBe(200);
    expect(performance.now() - openStartedAt).toBeGreaterThanOrEqual(SLOW_MS);
    // Sealed: resolve refuses, and the open answer (snapshots long
    // done) still reports the session.
    const resolved = await resolveSession(witness, 'close-waits');
    expect(resolved.status).toBe(404);
    const opened = await openPromise;
    expect(opened.status).toBe(200);
    expect(sessionOf(await opened.json()).sessionId).toBe(pendingId);
  });

  it('releases a not-ready session only after its before-snapshots finished', async () => {
    const witness = await startReadyWitness();
    const openStartedAt = performance.now();
    const openPromise = openSession(witness, {
      testId: 'release-waits',
      workerIndex: 0,
      claims: [SLOW_CLAIM, FAST_CLAIM],
    });
    await wait(200);
    const trace = await fetch(`${witness.url}/runs/execution-trace`, { headers: supervisorHeaders() });
    expect(trace.status).toBe(200);
    const [pendingId] = traceSessionIds(await trace.json()).flat();
    expect(typeof pendingId).toBe('string');
    const release = await fetch(`${witness.url}/sessions/release`, {
      method: 'POST',
      headers: supervisorHeaders(),
      body: JSON.stringify({ sessionId: pendingId }),
    });
    // Same bounded wait as the close: the release seals the lifecycle
    // (outcome-pending) only after the before-state exists.
    expect(release.status).toBe(200);
    expect(performance.now() - openStartedAt).toBeGreaterThanOrEqual(SLOW_MS);
    const resolved = await resolveSession(witness, 'release-waits');
    expect(resolved.status).toBe(404);
    const opened = await openPromise;
    expect(opened.status).toBe(200);
    expect(sessionOf(await opened.json()).sessionId).toBe(pendingId);
  });
});
