/**
 * Adapter-kit suite: the configuration-first constructor against a real
 * loopback app, covering the shapes every consumer hits — a paged
 * collection, a server-computed field, a list route that only works
 * through a redirect, and a login seat whose credentials live only in
 * the witness environment.
 *
 * The parity case matters most: a kit adapter and a hand-written
 * adapter must produce IDENTICAL evidence records for the same row, or
 * the generator would quietly change what the gate proves.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { defineHttpAdapter } from '../src/adapter-kit/index.js';
import type { AdapterContext } from '../src/witness/types.js';

/** Rows the fixture collection serves (3 pages of 100 + a short one). */
const ROW_COUNT = 250;
/** The login the secure routes require. */
const SEAT_USER = 'witness-seat';
const SEAT_PASSWORD = 'witness-secret-value';

/** One fixture row. */
interface Row {
  id: string;
  label: string;
  /** The server computes this one; what a client sent is not kept. */
  display_label: string;
}

/** The fixture's rows. */
const ROWS: readonly Row[] = Array.from({ length: ROW_COUNT }, (_unused, index) => ({
  id: `rec-${String(index + 1)}`,
  label: `label-${String(index + 1)}`,
  display_label: `LABEL ${String(index + 1)}`,
}));

/** Serves a JSON response. */
function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...headers });
  res.end(JSON.stringify(body));
}

/** The fixture app: paged rows, a redirect-only list, a login seat. */
function handle(req: IncomingMessage, res: ServerResponse): void {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const path = url.pathname;

  if (path === '/login' && req.method === 'POST') {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, string>;
      if (body['username'] === SEAT_USER && body['password'] === SEAT_PASSWORD) {
        res.setHeader('set-cookie', 'session=abc123; HttpOnly; Path=/');
        sendJson(res, 200, { ok: true });
        return;
      }
      sendJson(res, 401, { ok: false });
    });
    return;
  }

  if (path === '/secure/rows') {
    if (req.headers['cookie'] !== 'session=abc123') {
      sendJson(res, 401, { error: 'login required' });
      return;
    }
    sendJson(res, 200, { rows: [ROWS[0]] });
    return;
  }

  // A list route that only ever works through a redirect: following it
  // silently would hide the real path from the reviewer (E28).
  if (path === '/legacy/rows') {
    res.writeHead(307, { location: '/api/rows' });
    res.end();
    return;
  }

  const byId = /^\/api\/rows\/(rec-[0-9]+)$/.exec(path);
  if (byId !== null && req.method === 'GET') {
    const row = ROWS.find((candidate) => candidate.id === byId[1]);
    if (row === undefined) {
      sendJson(res, 404, { error: 'not found' });
      return;
    }
    sendJson(res, 200, { row });
    return;
  }

  if (path === '/api/rows' && req.method === 'GET') {
    const size = Number(url.searchParams.get('page_size') ?? '100');
    const page = Number(url.searchParams.get('page') ?? '1');
    const start = (page - 1) * size;
    sendJson(res, 200, { rows: ROWS.slice(start, start + size) });
    return;
  }

  sendJson(res, 404, { error: 'not found' });
}

/** The running fixture. */
let server: Server;
/** Its loopback base URL. */
let baseUrl: string;

/**
 * Builds a witness adapter context over loopback (the shape the witness
 * service hands adapters).
 *
 * Args:
 *   base: the app base URL.
 *   resourceId: the resource this context serves.
 *
 * Returns:
 *   AdapterContext: a GET-only context.
 */
function makeCtx(base: string, resourceId: string): AdapterContext {
  return {
    baseUrl: base,
    resourceId,
    get: async (path: string) => {
      const response = await fetch(`${base}${path}`, { redirect: 'manual' });
      return {
        status: response.status,
        json: () => response.json() as Promise<unknown>,
        text: () => response.text(),
        headers: response.headers,
      };
    },
  };
}

beforeAll(async () => {
  server = createServer(handle);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('adapter kit: reads', () => {
  it('reads one entity through the declared wrapper and projects the declared fields', async () => {
    const adapter = defineHttpAdapter({
      resourceId: 'test.rows',
      readPath: (id) => `/api/rows/${encodeURIComponent(id)}`,
      itemWrapper: 'row',
      fields: ['id', 'label', 'display_label'],
      deletion: 'hard',
      environmentFingerprint: 'loopback-v1',
    });
    const body = await adapter.read(makeCtx(baseUrl, 'test.rows'), 'rec-7');
    expect(adapter.normalize(body)).toEqual({
      entityId: 'rec-7',
      fields: { id: 'rec-7', label: 'label-7', display_label: 'LABEL 7' },
    });
  });

  it('reports an absent entity as null instead of failing', async () => {
    const adapter = defineHttpAdapter({
      resourceId: 'test.rows',
      readPath: (id) => `/api/rows/${encodeURIComponent(id)}`,
      itemWrapper: 'row',
      deletion: 'hard',
      environmentFingerprint: 'loopback-v1',
    });
    await expect(adapter.read(makeCtx(baseUrl, 'test.rows'), 'rec-9999')).resolves.toBeNull();
  });

  it('gives the same record as a hand-written adapter for the same row', async () => {
    const kit = defineHttpAdapter({
      resourceId: 'test.rows',
      readPath: (id) => `/api/rows/${encodeURIComponent(id)}`,
      itemWrapper: 'row',
      fields: ['id', 'label'],
      deletion: 'hard',
      environmentFingerprint: 'loopback-v1',
    });
    // The hand-written shape every existing consumer already ships.
    const handWritten = {
      resourceId: 'test.rows',
      async read(ctx: AdapterContext, id: unknown): Promise<unknown> {
        const res = await ctx.get(`/api/rows/${encodeURIComponent(String(id))}`);
        if (res.status === 404) return null;
        return (await res.json() as { row: unknown }).row;
      },
      normalize(body: unknown): { entityId: string; fields: Record<string, unknown> } {
        const row = body as { id: string; label: string };
        return { entityId: row.id, fields: { id: row.id, label: row.label } };
      },
      deletion: 'hard' as const,
      environmentFingerprint: 'loopback-v1',
    };
    const ctx = makeCtx(baseUrl, 'test.rows');
    const kitBody = await kit.read(ctx, 'rec-12');
    const handBody = await handWritten.read(ctx, 'rec-12');
    expect(kitBody).toEqual(handBody);
    expect(kit.normalize(kitBody)).toEqual(handWritten.normalize(handBody));
  });
});

describe('adapter kit: paging', () => {
  it('walks every page of a 250-row collection', async () => {
    const adapter = defineHttpAdapter({
      resourceId: 'test.rows',
      readPath: (id) => `/api/rows/${encodeURIComponent(id)}`,
      itemWrapper: 'row',
      listPath: '/api/rows',
      collectionKey: 'rows',
      paging: { kind: 'page', pageSize: 100 },
      fields: ['id'],
      deletion: 'hard',
      environmentFingerprint: 'loopback-v1',
    });
    const rows = await adapter.list?.(makeCtx(baseUrl, 'test.rows'));
    expect(rows).toHaveLength(ROW_COUNT);
    expect(new Set((rows as Row[]).map((row) => row.id)).size).toBe(ROW_COUNT);
  });

  it('fails closed on a truncated walk instead of returning a partial list', async () => {
    const adapter = defineHttpAdapter({
      resourceId: 'test.rows',
      readPath: (id) => `/api/rows/${encodeURIComponent(id)}`,
      itemWrapper: 'row',
      listPath: '/api/rows',
      collectionKey: 'rows',
      // A cap below the real page count: a partial id set would let a
      // create look "absent" when the row sits on page 3.
      paging: { kind: 'page', pageSize: 100, maxPages: 2 },
      fields: ['id'],
      deletion: 'hard',
      environmentFingerprint: 'loopback-v1',
    });
    await expect(adapter.list?.(makeCtx(baseUrl, 'test.rows'))).rejects.toThrow(/result truncated/);
  });

  it('omits list entirely when the config declares no collection read', () => {
    const adapter = defineHttpAdapter({
      resourceId: 'test.rows',
      readPath: (id) => `/api/rows/${encodeURIComponent(id)}`,
      itemWrapper: 'row',
      deletion: 'hard',
      environmentFingerprint: 'loopback-v1',
    });
    expect(adapter.list).toBeUndefined();
  });

  it('refuses a config that can never observe the resource', () => {
    expect(() =>
      defineHttpAdapter({
        resourceId: 'test.rows',
        deletion: 'hard',
        environmentFingerprint: 'loopback-v1',
      }),
    ).toThrow(/neither readPath nor listPath/);
  });
});

describe('adapter kit: server-computed fields', () => {
  it('declares volatile fields instead of hiding them', () => {
    const adapter = defineHttpAdapter({
      resourceId: 'test.rows',
      readPath: (id) => `/api/rows/${encodeURIComponent(id)}`,
      itemWrapper: 'row',
      fields: ['id', 'label', 'display_label'],
      volatileFields: ['display_label'],
      deletion: 'hard',
      environmentFingerprint: 'loopback-v1',
    });
    // The field is still OBSERVED (evidence stays complete); it is
    // declared, so the engine can skip the exact-value echo and say so.
    expect(adapter.volatileFields).toEqual(['display_label']);
    expect(
      adapter.normalize({ id: 'rec-1', label: 'a', display_label: 'SERVER SAYS OTHER' }).fields,
    ).toEqual({ id: 'rec-1', label: 'a', display_label: 'SERVER SAYS OTHER' });
  });
});

describe('adapter kit: redirects', () => {
  it('fails closed on a list route that only works through a redirect', async () => {
    const adapter = defineHttpAdapter({
      resourceId: 'test.rows',
      readPath: (id) => `/api/rows/${encodeURIComponent(id)}`,
      itemWrapper: 'row',
      listPath: '/legacy/rows',
      collectionKey: 'rows',
      paging: { kind: 'page', pageSize: 100 },
      deletion: 'hard',
      environmentFingerprint: 'loopback-v1',
    });
    await expect(adapter.list?.(makeCtx(baseUrl, 'test.rows'))).rejects.toThrow(
      /not a stable evidence path/,
    );
  });
});

describe('adapter kit: witness-side login', () => {
  it('logs in once with credentials from the witness environment and reads', async () => {
    const adapter = defineHttpAdapter({
      resourceId: 'test.rows',
      readPath: () => '/secure/rows',
      listPath: '/secure/rows',
      collectionKey: 'rows',
      auth: {
        kind: 'cookie-login',
        seats: {
          seat: {
            loginPath: '/login',
            credentials: {
              username: 'GATEFORGE_TEST_ADAPTER_USER',
              password: 'GATEFORGE_TEST_ADAPTER_PASSWORD',
            },
          },
        },
      },
      fields: ['id'],
      deletion: 'hard',
      environmentFingerprint: 'loopback-v1',
    });
    process.env['GATEFORGE_TEST_ADAPTER_USER'] = SEAT_USER;
    process.env['GATEFORGE_TEST_ADAPTER_PASSWORD'] = SEAT_PASSWORD;
    try {
      const ctx = makeCtx(baseUrl, 'test.rows');
      const first = await adapter.list?.(ctx);
      const second = await adapter.list?.(ctx);
      expect(first).toHaveLength(1);
      expect(second).toEqual(first);
    } finally {
      delete process.env['GATEFORGE_TEST_ADAPTER_USER'];
      delete process.env['GATEFORGE_TEST_ADAPTER_PASSWORD'];
    }
  });

  it('fails closed with the env var names when the credential is absent', async () => {
    const adapter = defineHttpAdapter({
      resourceId: 'test.rows',
      readPath: () => '/secure/rows',
      listPath: '/secure/rows',
      collectionKey: 'rows',
      auth: {
        kind: 'cookie-login',
        seats: {
          seat: {
            loginPath: '/login',
            credentials: { username: 'GATEFORGE_TEST_ADAPTER_ABSENT', password: 'GATEFORGE_TEST_ADAPTER_ABSENT' },
          },
        },
      },
      deletion: 'hard',
      environmentFingerprint: 'loopback-v1',
    });
    await expect(adapter.read(makeCtx(baseUrl, 'test.rows'), 'rec-1')).rejects.toThrow(
      /GATEFORGE_TEST_ADAPTER_ABSENT/,
    );
  });
});

describe('adapter kit: composed-collection probe', () => {
  // `listCollection` composes its reads itself, so there is no static
  // first-page path to name. The probe used to fall through to the
  // by-id path and dereference the absent readPath — a TypeError that
  // crashed `gateforge adapters check --probe`. It must instead read
  // the collection's FIRST page through the same walker the witness
  // uses, issue exactly that one GET (never a full walk), and report
  // what the app answered.
  let probeServer: Server;
  let probeBase: string;
  /** Every path the fixture served, in arrival order. */
  let served: string[];

  beforeAll(async () => {
    served = [];
    probeServer = createServer((req, res) => {
      served.push(req.url ?? '/');
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const send = (status: number, body: unknown): void => {
        res.writeHead(status, {
          'content-type': 'application/json; charset=utf-8',
          'x-gateforge-env-fingerprint': 'composed-probe-v1',
        });
        res.end(JSON.stringify(body));
      };
      if (url.pathname === '/composed/rows') {
        const page = Number(url.searchParams.get('page') ?? '1');
        const size = Number(url.searchParams.get('page_size') ?? '100');
        send(200, { rows: page === 1 ? [{ id: 'w-1' }, { id: 'w-2' }] : [] });
        return;
      }
      if (url.pathname === '/cursor/rows') {
        const cursor = url.searchParams.get('cursor');
        send(200, {
          rows: cursor === null ? [{ id: 'c-1' }] : [],
          ...(cursor === null ? { next: 'page-2' } : {}),
        });
        return;
      }
      send(404, { error: 'not found' });
    });
    await new Promise<void>((resolve) => probeServer.listen(0, '127.0.0.1', resolve));
    probeBase = `http://127.0.0.1:${String((probeServer.address() as AddressInfo).port)}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => probeServer.close(() => resolve()));
  });

  it('probes a listCollection adapter through its first page instead of throwing', async () => {
    const adapter = defineHttpAdapter({
      resourceId: 'demo.widgets',
      deletion: 'hard',
      environmentFingerprint: 'composed-probe-v1',
      listCollection: (readAll) => readAll('/composed/rows', { collectionKey: 'rows' }),
      collectionKey: 'rows',
    });
    const result = await adapter.probe({ baseUrl: probeBase }, '0');
    expect(result.status).toBe(200);
    expect(result.path).toBe('/composed/rows?page=1&page_size=100');
    // One GET: the collection's first page, never a full walk.
    expect(served).toEqual(['/composed/rows?page=1&page_size=100']);
  });

  it('probes a cursor-composed collection through its first parent page', async () => {
    served = [];
    const adapter = defineHttpAdapter({
      resourceId: 'demo.cursors',
      deletion: 'hard',
      environmentFingerprint: 'composed-probe-v1',
      paging: { kind: 'cursor' },
      pageCursor: (body) => {
        if (body === null || typeof body !== 'object' || !('next' in body)) return undefined;
        const next: unknown = body['next'];
        return typeof next === 'string' ? next : undefined;
      },
      listCollection: (readAll) =>
        readAll(
          (cursor) => (cursor === undefined ? '/cursor/rows' : `/cursor/rows?cursor=${cursor}`),
          { collectionKey: 'rows' },
        ),
      collectionKey: 'rows',
    });
    const result = await adapter.probe({ baseUrl: probeBase });
    expect(result.status).toBe(200);
    expect(result.path).toBe('/cursor/rows');
    expect(served).toEqual(['/cursor/rows']);
  });

  it('the collection read itself still walks every page (probe changes nothing there)', async () => {
    served = [];
    const adapter = defineHttpAdapter({
      resourceId: 'demo.widgets',
      deletion: 'hard',
      environmentFingerprint: 'composed-probe-v1',
      paging: { kind: 'page', pageSize: 2 },
      listCollection: (readAll) => readAll('/composed/rows', { collectionKey: 'rows' }),
      collectionKey: 'rows',
    });
    const rows = await adapter.list?.(makeCtx(probeBase, 'demo.widgets'));
    // Two pages of two rows each (the fixture answers page 2 empty) —
    // the walk is untouched by the probe's single-page read.
    expect(rows).toEqual([{ id: 'w-1' }, { id: 'w-2' }]);
    expect(served).toEqual([
      '/composed/rows?page=1&page_size=2',
      '/composed/rows?page=2&page_size=2',
    ]);
  });
});
