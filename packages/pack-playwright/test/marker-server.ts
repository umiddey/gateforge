/**
 * A tiny loopback STATEFUL accounts target for witness/fixture tests.
 *
 * Serves the same surface the example app exposes:
 * - `GET /api/accounts` → `{accounts: [...]}` (adapter `list` probe)
 * - `GET /api/accounts/:id` → the entity, or 404 when absent
 * - `POST /api/accounts` `{first_name, last_name}` → mints + returns the
 *   entity (the app-side effect of a UI create)
 * - `POST /api/accounts/:id/archive` → flips status to 'archived'
 *
 * Every response stamps `x-gateforge-env-fingerprint` when `fingerprint`
 * is non-null — the fixture analog of the attestation proxy: bare
 * markerless servers stand in for unattested environments. Stateful so
 * engine-side pre-observations can observe a true "absent before"
 * (create postconditions, audit round 4).
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { ENV_FINGERPRINT_HEADER } from '../src/constants.js';

interface Account {
  id: string;
  first_name: string;
  last_name: string;
  status: 'active' | 'archived';
}

const INITIAL: Account[] = [
  { id: 'acc-1', first_name: 'Ada', last_name: 'Lovelace', status: 'active' },
];

/** Starts the stateful marker server (fingerprint null = no marker). */
export async function startMarkerServer(
  fingerprint: string | null,
): Promise<{ url: string; stop: () => Promise<void> }> {
  const accounts = new Map<string, Account>(INITIAL.map((account) => [account.id, account]));
  let nextId = INITIAL.length + 1;

  const server = createServer((req, res) => {
    res.writeHead(200, {
      'content-type': 'application/json',
      ...(fingerprint === null ? {} : { [ENV_FINGERPRINT_HEADER]: fingerprint }),
    });
    handle(req, res, accounts, () => String(nextId++));
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

function handle(
  req: IncomingMessage,
  res: ServerResponse,
  accounts: Map<string, Account>,
  mintId: () => string,
): void {
  const url = req.url ?? '/';
  const readBody = (): Promise<string> =>
    new Promise((resolve) => {
      let raw = '';
      req.setEncoding('utf8');
      req.on('data', (chunk: string) => {
        raw += chunk;
      });
      req.on('end', () => resolve(raw));
    });

  if (req.method === 'GET' && url === '/api/accounts') {
    res.end(JSON.stringify({ accounts: [...accounts.values()] }));
    return;
  }
  if (req.method === 'POST' && url === '/api/accounts') {
    void readBody().then((raw) => {
      let body: Record<string, unknown> = {};
      try {
        body = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        // mint with empty names rather than failing the app-side helper
      }
      const account: Account = {
        id: mintId(),
        first_name: String(body['first_name'] ?? ''),
        last_name: String(body['last_name'] ?? ''),
        status: 'active',
      };
      accounts.set(account.id, account);
      res.end(JSON.stringify(account));
    });
    return;
  }
  const archiveMatch = /^\/api\/accounts\/([^/]+)\/archive$/.exec(url);
  if (req.method === 'POST' && archiveMatch !== null) {
    const account = accounts.get(decodeURIComponent(archiveMatch[1] as string));
    if (account === undefined) {
      res.statusCode = 404;
      res.end(JSON.stringify({ error: 'not found' }));
      return;
    }
    account.status = 'archived';
    res.end(JSON.stringify(account));
    return;
  }
  const updateMatch = /^\/api\/accounts\/([^/]+)$/.exec(url);
  if ((req.method === 'PATCH' || req.method === 'PUT') && updateMatch !== null) {
    const account = accounts.get(decodeURIComponent(updateMatch[1] as string));
    if (account === undefined) {
      res.statusCode = 404;
      res.end(JSON.stringify({ error: 'not found' }));
      return;
    }
    void readBody().then((raw) => {
      let body: Record<string, unknown> = {};
      try {
        body = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        // leave the row unchanged on an unparsable body
      }
      if (typeof body['first_name'] === 'string') account.first_name = body['first_name'];
      if (typeof body['last_name'] === 'string') account.last_name = body['last_name'];
      res.end(JSON.stringify(account));
    });
    return;
  }
  const entityMatch = /^\/api\/accounts\/([^/]+)$/.exec(url);
  if (req.method === 'GET' && entityMatch !== null) {
    const account = accounts.get(decodeURIComponent(entityMatch[1] as string));
    if (account === undefined) {
      res.statusCode = 404;
      res.end(JSON.stringify({ error: 'not found' }));
      return;
    }
    res.end(JSON.stringify(account));
    return;
  }
  res.statusCode = 404;
  res.end(JSON.stringify({ error: 'not found' }));
}
