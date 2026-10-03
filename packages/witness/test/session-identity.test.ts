/**
 * Per-session adapter identity (plan 2026-09-25 Phase 4b item 3b).
 *
 * A per-tenant singleton table can only be read from inside the tenant
 * the test just created, so the test registers THAT tenant's login with
 * the witness for its OWN session. The kit then resolves the seat for a
 * read by the session the read runs under — session A's reads use A's
 * identity, session B's reads never touch A's — and without a
 * registration the process-global environment seat is used exactly as
 * before.
 *
 * The trust argument (why this cannot become an evidence channel) is
 * written out in `packages/cli/guides/TEST-ENVIRONMENT.md`; the server
 * side (registration, refusal, lifecycle, containment) is covered in
 * `session-identity-server.test.ts`.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { defineHttpAdapter } from '../src/adapter-kit/index.js';
import type { AdapterContext, EvidenceAdapter, SessionIdentity } from '../src/witness/types.js';

/** The tenant each fixture login belongs to (the app's own answer). */
const TENANT_A = 'tenant-a';
const TENANT_B = 'tenant-b';
const FIXED_TENANT = 'tenant-fixed';
/** A credential built at runtime — never a literal, never in a record. */
const RUNTIME_SECRET = `rt-${Math.random().toString(36).slice(2)}-${Date.now()}`;

/** The login table the fixture app serves (a per-tenant login). */
const LOGINS: Readonly<Record<string, { tenant: string; password: string }>> = {
  'user-fixed': { tenant: FIXED_TENANT, password: RUNTIME_SECRET },
  'user-a': { tenant: TENANT_A, password: RUNTIME_SECRET },
  'user-b': { tenant: TENANT_B, password: RUNTIME_SECRET },
};

/** The identity one session registers for its own tenant's login. */
function identityFor(user: string): SessionIdentity {
  return {
    seat: 'tenant-seat',
    values: {
      GATEFORGE_TEST_TENANT_USER: user,
      GATEFORGE_TEST_TENANT_PASSWORD: RUNTIME_SECRET,
    },
  };
}

/** Serves a JSON response. */
function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

/**
 * The fixture app: one login per tenant, one tenant-scoped collection.
 * Every read states WHICH tenant the engine is reading as, so a read made
 * with the wrong identity is visible in the answer, not guessed at.
 */
function handle(req: IncomingMessage, res: ServerResponse): void {
  const url = new URL(req.url ?? '/', `http://${LOOPBACK}`);
  if (url.pathname === '/login' && req.method === 'POST') {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, string>;
      const login = LOGINS[body['username'] ?? ''];
      if (login === undefined || login.password !== body['password']) {
        sendJson(res, 401, { ok: false });
        return;
      }
      res.setHeader('set-cookie', `session=${login.tenant}; HttpOnly; Path=/`);
      sendJson(res, 200, { ok: true, tenant: login.tenant });
    });
    return;
  }
  if (url.pathname === '/ledger-entries') {
    const cookie = req.headers['cookie'] ?? '';
    const tenant = /session=([a-z-]+)/.exec(cookie)?.[1];
    if (tenant === undefined) {
      sendJson(res, 401, { error: 'login required' });
      return;
    }
    sendJson(res, 200, { rows: [{ id: 'entry-1', tenant }] });
    return;
  }
  sendJson(res, 404, { error: 'not found' });
}

/** The loopback host this suite binds (never a literal, never a redacted copy). */
const LOOPBACK = [127, 0, 0, 1].join('.');
/** The running fixture. */
let server: Server;
/** Its loopback base URL. */
let baseUrl: string;

/** A kit adapter that reads the tenant-scoped collection through a seat. */
function ledgerAdapter(): EvidenceAdapter {
  return defineHttpAdapter({
    resourceId: 'tenant.ledger_entries',
    readPath: () => '/ledger-entries',
    listPath: '/ledger-entries',
    collectionKey: 'rows',
    auth: {
      kind: 'cookie-login',
      seats: {
        'tenant-seat': {
          loginPath: '/login',
          credentials: {
            username: 'GATEFORGE_TEST_TENANT_USER',
            password: 'GATEFORGE_TEST_TENANT_PASSWORD',
          },
        },
      },
      seat: 'tenant-seat',
    },
    fields: ['id', 'tenant'],
    deletion: 'hard',
    environmentFingerprint: 'loopback-v1',
  });
}

/**
 * The adapter context the witness hands a read — carrying the session the
 * read belongs to and, when that session registered one, its identity.
 */
function makeCtx(sessionId: string, sessionIdentity?: SessionIdentity): AdapterContext {
  return {
    baseUrl,
    resourceId: 'tenant.ledger_entries',
    sessionId,
    ...(sessionIdentity !== undefined ? { sessionIdentity } : {}),
    get: async (path: string) => {
      const response = await fetch(`${baseUrl}${path}`, { redirect: 'manual' });
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
  await new Promise<void>((resolve) => server.listen(0, LOOPBACK, resolve));
  baseUrl = `http://${LOOPBACK}:${String((server.address() as AddressInfo).port)}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('per-session adapter identity: the read follows its own session', () => {
  it("reads session A's tenant for session A", async () => {
    const rows = await ledgerAdapter().list?.(makeCtx('session-a', identityFor('user-a')));
    expect(rows).toEqual([{ id: 'entry-1', tenant: TENANT_A }]);
  });

  it('never reads with another session identity: session B sees B (or nothing)', async () => {
    const adapter = ledgerAdapter();
    // B registered nothing: the environment seat is still today's
    // process-global behavior — but A's identity is not B's credential.
    process.env['GATEFORGE_TEST_TENANT_USER'] = 'user-b';
    process.env['GATEFORGE_TEST_TENANT_PASSWORD'] = RUNTIME_SECRET;
    try {
      expect(await adapter.list?.(makeCtx('session-b'))).toEqual([
        { id: 'entry-1', tenant: TENANT_B },
      ]);
      // A second, independent kit adapter bound to B's own identity
      // reads the same tenant A registered — no cross-talk either way.
      expect(await ledgerAdapter().list?.(makeCtx('session-b', identityFor('user-b')))).toEqual([
        { id: 'entry-1', tenant: TENANT_B },
      ]);
    } finally {
      delete process.env['GATEFORGE_TEST_TENANT_USER'];
      delete process.env['GATEFORGE_TEST_TENANT_PASSWORD'];
    }
    // With NO environment seat at all, a session that registered nothing
    // reads nothing: A's identity is not a process-global fallback.
    await expect(ledgerAdapter().list?.(makeCtx('session-c'))).rejects.toThrow(
      /GATEFORGE_TEST_TENANT_USER/,
    );
  });

  it('reads as the process-global seat when no identity is registered', async () => {
    const adapter = ledgerAdapter();
    process.env['GATEFORGE_TEST_TENANT_USER'] = 'user-fixed';
    process.env['GATEFORGE_TEST_TENANT_PASSWORD'] = RUNTIME_SECRET;
    try {
      expect(await adapter.list?.(makeCtx('session-a'))).toEqual([
        { id: 'entry-1', tenant: FIXED_TENANT },
      ]);
    } finally {
      delete process.env['GATEFORGE_TEST_TENANT_USER'];
      delete process.env['GATEFORGE_TEST_TENANT_PASSWORD'];
    }
  });

  it('fails closed naming the missing variable when an identity is incomplete', async () => {
    const partial: SessionIdentity = { seat: 'tenant-seat', values: { GATEFORGE_TEST_TENANT_USER: 'user-a' } };
    await expect(ledgerAdapter().list?.(makeCtx('session-a', partial))).rejects.toThrow(
      /GATEFORGE_TEST_TENANT_PASSWORD/,
    );
  });

  it('refuses an identity that names a seat the adapter does not declare', async () => {
    const wrong: SessionIdentity = { seat: 'not-a-declared-seat', values: {} };
    await expect(ledgerAdapter().list?.(makeCtx('session-a', wrong))).rejects.toThrow(
      /not-a-declared-seat/,
    );
  });

  it('keeps one session cookie out of another session read', async () => {
    const adapter = ledgerAdapter();
    // A logs in and caches its cookie in the kit's shared store; B then
    // reads with its own identity through the SAME adapter instance.
    expect(await adapter.list?.(makeCtx('session-a', identityFor('user-a')))).toEqual([
      { id: 'entry-1', tenant: TENANT_A },
    ]);
    expect(await adapter.list?.(makeCtx('session-b', identityFor('user-b')))).toEqual([
      { id: 'entry-1', tenant: TENANT_B },
    ]);
  });
});