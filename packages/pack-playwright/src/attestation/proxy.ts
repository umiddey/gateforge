/**
 * Loopback attestation proxy (GF-13 minimal v1, plan invariant 5).
 *
 * A bare disposable app can't positively prove it is disposable. The
 * proxy fronts a loopback app and stamps EVERY response with the
 * environment markers the witness requires:
 *
 * - `x-gateforge-env-fingerprint: <fingerprint>` — the run's attested
 *   environment identity (the witness compares adapter reads against
 *   it; GF-13).
 * - `x-gateforge-attestation-scope: loopback` — the scope the marker
 *   attests (observability; the witness's identity check is the marker).
 *
 * This mirrors the Ryuk label pattern (docs/research/environment_
 * attestation.md §3.1): the signal is created by the same actor that
 * later relies on it — the gateforge runner stamps the environment it
 * created. For real deployments the SUT itself (or its middleware/
 * container labels) presents the same marker.
 */
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { LOOPBACK_HOSTNAME } from '../constants.js';
import { ENV_FINGERPRINT_HEADER, ATTESTATION_SCOPE_HEADER } from '../constants.js';

/** Handle for a running attestation proxy. */
export interface AttestationProxyHandle {
  /** The proxy's loopback base URL (use this as app/adapter base). */
  url: string;
  stop: () => Promise<void>;
}

/**
 * Starts the attestation proxy in front of `targetBaseUrl`.
 *
 * Args:
 *   targetBaseUrl: absolute URL of the loopback app to front.
 *   fingerprint: marker value to stamp on every response.
 *   scope: attestation-scope marker (default 'loopback').
 *
 * Returns:
 *   AttestationProxyHandle: {url, stop} once listening.
 */
export function startAttestationProxy(
  targetBaseUrl: string,
  fingerprint: string,
  scope = 'loopback',
): Promise<AttestationProxyHandle> {
  const target = new URL(targetBaseUrl);
  const server = createServer((req, res) => {
    const proxy = httpRequest(
      {
        host: target.hostname,
        port: target.port === '' ? undefined : Number(target.port),
        method: req.method,
        path: req.url,
        headers: { ...req.headers, host: target.host },
      },
      (upstream) => {
        res.writeHead(upstream.statusCode ?? 502, {
          ...(upstream.headers as Record<string, string | string[]>),
          [ENV_FINGERPRINT_HEADER]: fingerprint,
          [ATTESTATION_SCOPE_HEADER]: scope,
        });
        upstream.pipe(res);
      },
    );
    proxy.on('error', () => {
      res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('attestation proxy: upstream unreachable');
    });
    req.pipe(proxy);
  });

  return new Promise((resolveProxy, rejectProxy) => {
    server.once('error', rejectProxy);
    server.listen(0, LOOPBACK_HOSTNAME, () => {
      server.removeAllListeners('error');
      const address = server.address();
      if (address === null || typeof address === 'string') {
        server.close();
        rejectProxy(new Error('attestation proxy failed to bind an OS-assigned port'));
        return;
      }
      const url = `http://${LOOPBACK_HOSTNAME}:${address.port}`;
      const handle = Object.freeze({
        url,
        stop: (): Promise<void> =>
          new Promise((resolveClose) => {
            server.close(() => resolveClose());
          }),
      });
      resolveProxy(handle);
    });
  });
}

export type { Server, IncomingMessage, ServerResponse };