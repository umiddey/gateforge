/**
 * A tiny loopback marker-stamping target for witness attestation tests.
 *
 * Serves `/api/accounts/acc-1` (the entity the honest adapter reads) and
 * stamps `x-gateforge-env-fingerprint` on every response when
 * `fingerprint` is non-null — the fixture analog of the attestation
 * proxy: bare markerless servers stand in for unattested environments.
 */
import { createServer } from 'node:http';
import { ENV_FINGERPRINT_HEADER } from '../src/constants.js';

const ACCOUNT = {
  id: 'acc-1',
  first_name: 'Ada',
  last_name: 'Lovelace',
  status: 'active',
};

/** Starts the marker server (fingerprint null = no marker presented). */
export async function startMarkerServer(
  fingerprint: string | null,
): Promise<{ url: string; stop: () => Promise<void> }> {
  const server = createServer((req, res) => {
    res.writeHead(200, {
      'content-type': 'application/json',
      ...(fingerprint === null ? {} : { [ENV_FINGERPRINT_HEADER]: fingerprint }),
    });
    const body = req.url === '/api/accounts/acc-1' ? ACCOUNT : {};
    res.end(JSON.stringify(body));
  });
  await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  const address = server.address();
  if (address === null || typeof address === 'string') {
    server.close();
    throw new Error('marker server failed to bind');
  }
  const url = `http://127.0.0.1:${address.port}`;
  return {
    url,
    stop: () =>
      new Promise<void>((resolveClose) => {
        server.close(() => resolveClose());
      }),
  };
}