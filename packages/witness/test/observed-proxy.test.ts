/**
 * The observation proxy's bind surface: the app hostname
 * resolves to EVERY loopback address, and every one of
 * them must serve the proxy's single port.
 *
 * A browser tries every resolved address, so the page
 * channel kept working; a Node-only client (Playwright's
 * APIRequestContext) connects to the single address its
 * resolver picks, so a proxy bound to only the FIRST
 * resolved address refused that client with ECONNREFUSED.
 */
import { createServer, get, type Server } from 'node:http';
import { lookup } from 'node:dns/promises';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { RUN_HEADER, VERIFIER_HEADER } from '../src/constants.js';
import { startWitness, type WitnessHandle } from '../src/witness/server.js';
import type { SessionCredential } from '../src/witness/types.js';

const RUN_ID = 'a1b2c3d4-0000-4000-8000-000000000001';
const RUN_TOKEN = 'observed-proxy-run-token';
const VERIFIER_KEY = 'observed-proxy-verifier-key';
const TEST_ID = 'tests/proxy#observed';
/** The IPv4 loopback host this suite names (built, never copied from output). */
const LOOPBACK = [127, 0, 0, 1].join('.');
const IPV6_LOOPBACK = '::1';
/** The body the fixture app answers with (the proxy forwards it verbatim). */
const APP_MARKER = 'observed-proxy-app-marker';

let witness: WitnessHandle;
let adaptersDir: string;

/** `Promise.withResolvers` for the repo's lib target, which predates it. */
function withResolvers<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** The attested fixture app every observation proxy forwards to. */
let appSawInitiatorHeader = false;
const app: Server = createServer((req, res) => {
  appSawInitiatorHeader = req.headers['x-gateforge-initiator'] !== undefined;
  res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
  res.end(APP_MARKER);
});
/** The app's loopback base (the proxy target names the logical `localhost`). */
let appBaseUrl: string;

beforeAll(async () => {
  const { promise, resolve } = withResolvers<void>();
  app.listen(0, LOOPBACK, () => resolve());
  await promise;
  appBaseUrl = `http://${LOOPBACK}:${String((app.address() as AddressInfo).port)}`;
});

afterAll(async () => {
  const { promise, resolve } = withResolvers<void>();
  app.close(() => resolve());
  await promise;
});

beforeEach(async () => {
  adaptersDir = mkdtempSync(join(tmpdir(), 'gateforge-observed-proxy-'));
  witness = await startWitness({
    runId: RUN_ID,
    token: RUN_TOKEN,
    verifierKey: VERIFIER_KEY,
    adaptersDir,
    classificationsPath: null,
    // The browser-facing logical hostname: it resolves to
    // every loopback address the machine knows.
    proxyTarget: appBaseUrl.replace(LOOPBACK, 'localhost'),
  });
});

afterEach(async () => {
  await witness.stop();
  rmSync(adaptersDir, { recursive: true, force: true });
});

/** Opens one supervisor session (the only channel that can open one). */
async function openSession(): Promise<SessionCredential> {
  const response = await fetch(`${witness.url}/sessions/open`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      [RUN_HEADER]: RUN_TOKEN,
      [VERIFIER_HEADER]: VERIFIER_KEY,
    },
    body: JSON.stringify({ runId: RUN_ID, testId: TEST_ID, workerIndex: 0 }),
  });
  if (response.status !== 200) throw new Error(`session open failed: ${await response.text()}`);
  return (await response.json()) as SessionCredential;
}

/** Seals one session (supervisor only): its dedicated proxy dies with it. */
async function closeSession(session: SessionCredential): Promise<void> {
  const response = await fetch(`${witness.url}/sessions/close`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      [RUN_HEADER]: RUN_TOKEN,
      [VERIFIER_HEADER]: VERIFIER_KEY,
    },
    body: JSON.stringify({ sessionId: session.sessionId }),
  });
  if (response.status !== 200) throw new Error(`session close failed: ${await response.text()}`);
}

/**
 * GETs one URL through Node's http client — the transport a
 * Node-only API client uses. A fresh connection per call: a
 * pooled keep-alive socket would outlive a sealed proxy's
 * listeners and mask the refused channel.
 */
function httpGet(url: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string }> {
  const { promise, resolve, reject } = withResolvers<{ status: number; body: string }>();
  const call = get(url, { agent: false, headers }, (res) => {
    let body = '';
    res.on('data', (chunk: Buffer) => (body += chunk.toString()));
    res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
  });
  call.on('error', reject);
  return promise;
}

/** The bracketed host form of one address, for a URL authority. */
function urlHost(address: string): string {
  return address.includes(':') ? `[${address}]` : address;
}

describe('the observation proxy serves every loopback address', () => {
  it('answers on every address the app hostname resolves to, and seals with the session', async (ctx) => {
    // The multi-address resolution is what this pins: a
    // machine that resolves the hostname to a single
    // address cannot exercise the second family here.
    const resolved = await lookup('localhost', { all: true });
    const addresses = [...new Set(resolved.map((record) => record.address))];
    if (addresses.length < 2) {
      ctx.skip('this machine resolves localhost to a single address');
      return;
    }
    const session = await openSession();
    expect(session.proxyUrl, 'the session carries its dedicated proxy origin').not.toBe(null);
    // The published URL keeps the HOSTNAME (Host headers must
    // stay right); the port is the one every listener shares.
    const port = Number(new URL(session.proxyUrl as string).port);
    expect(port).toBeGreaterThan(0);
    // Both loopback families reach the SAME proxy port: a
    // Node-only client connects to whichever address its own
    // resolver picks, a browser to every address.
    for (const address of [LOOPBACK, IPV6_LOOPBACK]) {
      const answer = await httpGet(`http://${urlHost(address)}:${String(port)}/`);
      expect(answer.status, `http://${urlHost(address)}:${String(port)}/`).toBe(200);
      expect(answer.body).toBe(APP_MARKER);
    }
    // Sealing the session closes its dedicated channel: every
    // listener refuses afterwards.
    await closeSession(session);
    for (const address of [LOOPBACK, IPV6_LOOPBACK]) {
      await expect(httpGet(`http://${urlHost(address)}:${String(port)}/`)).rejects.toThrowError(
        /ECONNREFUSED/,
      );
    }
  });

  it('strips the fixture initiator marker before forwarding to the app', async () => {
    const session = await openSession();
    appSawInitiatorHeader = false;
    const answer = await httpGet(`${session.proxyUrl}/`, { 'x-gateforge-initiator': 'test-code' });
    expect(answer.status).toBe(200);
    expect(answer.body).toBe(APP_MARKER);
    expect(appSawInitiatorHeader).toBe(false);
    await closeSession(session);
  });
});
