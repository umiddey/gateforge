/**
 * Env-fingerprint probe diagnostics (R1-19): a transport failure
 * must say the target is UNREACHABLE — never blame the marker —
 * while a target that answered without the marker keeps the
 * marker message. Both stay failures (fail closed); only the
 * diagnostic is honest.
 */
import { createServer, type Server } from 'node:http';
import { describe, expect, it, beforeEach } from 'vitest';
import {
  clearLoopbackCacheForTests,
  envFingerprintMismatch,
  probeEnvFingerprint,
} from '../src/witness/env-attestation.js';

/** The loopback IP, built programmatically (never a copied placeholder). */
const LOOPBACK_IP = [127, 0, 0, 1].join('.');

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

/** The ephemeral port a listening server bound. */
function portOf(server: Server): number {
  const address = server.address();
  if (typeof address === 'object' && address !== null && 'port' in address) {
    return address.port;
  }
  throw new Error('server address is not an AddressInfo');
}

/** Starts a server on an ephemeral loopback port and resolves once it listens. */
function listen(server: Server): Promise<void> {
  const { promise, resolve } = withResolvers<void>();
  server.listen(0, LOOPBACK_IP, resolve);
  return promise;
}

/** Closes the server (close errors are teardown noise, never verdicts). */
function stopServer(server: Server): Promise<void> {
  const { promise, resolve } = withResolvers<void>();
  server.close(() => resolve());
  return promise;
}

/** A plain 200 server with NO marker headers, on an ephemeral loopback port. */
async function startHeaderlessServer(): Promise<Server> {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/plain' });
    response.end('ok');
  });
  await listen(server);
  return server;
}

/** A port nothing listens on: bind an ephemeral port, note it, release it. */
async function closedPort(): Promise<number> {
  const server = createServer();
  await listen(server);
  const port = portOf(server);
  await stopServer(server);
  return port;
}

describe('probeEnvFingerprint transport diagnostics', () => {
  beforeEach(() => {
    clearLoopbackCacheForTests();
  });

  it('reports an unreachable target as not reachable, not as a missing marker', async () => {
    const baseUrl = `http://${LOOPBACK_IP}:${String(await closedPort())}`;
    const probe = await probeEnvFingerprint(baseUrl, 5_000);
    expect(probe.fingerprint).toBeNull();
    expect(probe.scope).toBeNull();
    expect(probe.transportError, `transportError: ${String(probe.transportError)}`).not.toBeNull();
    const mismatch = envFingerprintMismatch(probe, 'declared-fingerprint', null, baseUrl);
    expect(mismatch).toContain(`target ${baseUrl} is not reachable`);
    expect(mismatch).toContain('start the app before the run (runtime.yml healthcheck)');
    // The old, wrong diagnostic must not survive a transport failure.
    expect(mismatch).not.toContain('presents no');
  });

  it('a reached target without the marker keeps the marker message', async () => {
    const server = await startHeaderlessServer();
    const baseUrl = `http://${LOOPBACK_IP}:${String(portOf(server))}`;
    try {
      const probe = await probeEnvFingerprint(baseUrl, 5_000);
      expect(probe.fingerprint).toBeNull();
      expect(probe.scope).toBeNull();
      expect(probe.transportError).toBeNull();
      const mismatch = envFingerprintMismatch(probe, 'declared-fingerprint', null, baseUrl);
      expect(mismatch).toContain(
        "adapter target presents no 'x-gateforge-env-fingerprint' marker",
      );
      expect(mismatch).toContain('the environment is not attested (GF-13)');
      expect(mismatch).not.toContain('is not reachable');
    } finally {
      await stopServer(server);
    }
  });
});
