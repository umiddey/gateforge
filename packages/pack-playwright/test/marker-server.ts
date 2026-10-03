/**
 * A tiny loopback STATEFUL accounts target for witness/fixture tests.
 *
 * Serves the same surface the example app exposes:
 * - `GET /api/accounts` → `{accounts: [...]}` (adapter `list` probe);
 *   `?shape=array|summary|empty|duplicate|malformed|large|notjson` serves
 *   the other list bodies a collection-read proof must distinguish
 * - `GET /api/accounts/:id` → the entity, or 404 when absent
 * - `POST /api/accounts` `{first_name, last_name}` → mints + returns the
 *   entity (the app-side effect of a UI create)
 * - `POST /api/accounts/:id/archive` → flips status to 'archived'
 * - `DELETE /api/accounts/:id` → hard-removes the row, or 404 when absent
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
  // Fresh row OBJECTS per server: the seed is module state, and a test
  // that archives or renames a row must never leak that row into the
  // next test's app.
  const accounts = new Map<string, Account>(
    INITIAL.map((account) => [account.id, { ...account }]),
  );
  let nextId = INITIAL.length + 1;

  const server = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (fingerprint !== null) res.setHeader(ENV_FINGERPRINT_HEADER, fingerprint);
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

  const listUrl = new URL(url, 'http://marker.invalid');
  if (req.method === 'GET' && listUrl.pathname === '/api/accounts') {
    const rows = [...accounts.values()];
    const shape = listUrl.searchParams.get('shape') ?? 'wrapped';
    if (shape === 'notjson') {
      res.end('<html>not json</html>');
      return;
    }
    res.end(JSON.stringify(listShape(shape, rows)));
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
  if (req.method === 'DELETE' && entityMatch !== null) {
    const id = decodeURIComponent(entityMatch[1] as string);
    if (!accounts.delete(id)) {
      res.statusCode = 404;
      res.end(JSON.stringify({ error: 'not found' }));
      return;
    }
    res.end(JSON.stringify({ deleted: id }));
    return;
  }
  res.statusCode = 404;
  res.end(JSON.stringify({ error: 'not found' }));
}

/**
 * The list-response bodies `GET /api/accounts?shape=…` can serve, so a
 * collection-read proof can tell a real rendered list from the bodies
 * that must never stand in for one: an envelope, a root array, a
 * metadata-only summary, an empty page, a page naming one row twice, a
 * reversed page, a page of ids the app never held, a row with no id
 * field, and a page larger than the witness response-snapshot cap.
 * `notjson` is served by the caller as raw non-JSON text.
 *
 * @param shape - the requested response shape
 * @param rows - the accounts the app currently holds
 * @returns the JSON body the list route serializes
 */
function listShape(shape: string, rows: Account[]): unknown {
  switch (shape) {
    case 'array':
      return rows;
    case 'summary':
      return { total: rows.length, accounts: rows.length };
    case 'empty':
      return { accounts: [] };
    case 'duplicate':
      return { accounts: rows.length > 1 ? [rows[1], rows[1]] : [rows[0], rows[0]] };
    case 'reversed':
      return { accounts: [...rows].reverse() };
    case 'foreign':
      return { accounts: [{ id: 'acc-elsewhere', first_name: 'Remote', last_name: 'Row', status: 'active' }] };
    case 'newest':
      return { accounts: rows.slice(-1) };
    case 'malformed':
      return { accounts: [{ first_name: 'Nameless', last_name: 'Row', status: 'active' }] };
    case 'large':
      return {
        accounts: Array.from({ length: 200 }, (_unused, index) => ({
          id: `bulk-${String(index)}`,
          first_name: 'Bulk'.repeat(20),
          last_name: 'Filler'.repeat(20),
          status: 'active',
        })),
      };
    default:
      return { accounts: rows };
  }
}
