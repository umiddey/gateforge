#!/usr/bin/env node
// Gateforge auth example: a tiny node:http server that demonstrates every
// auth obligation on a single /billing/refund endpoint.
//
// Routes:
//   GET  /api/billing/refund/:id          trusted read for the adapter (GET-only)
//   POST /billing/refund                   guarded: requireRole('admin') + requireTenant()
//
// Auth model:
//   - Tokens are HS256 JWTs (no external deps; stdlib + node:crypto).
//   - Forged or signature-invalid tokens => 401; the handler never runs.
//   - Missing role => 403; the handler never runs.
//   - Cross-tenant principal => 403; the handler never runs.
//   - Every denial path is verified to produce no persisted side effect
//     (the refund is recorded ONLY when the handler actually runs).
//
// Environment:
//   GATEFORGE_AUTH_PORT  — bind port (default: 3001)
//   GATEFORGE_AUTH_SECRET — HMAC secret (default: a stable test secret)

import http from 'node:http';
import crypto from 'node:crypto';
import { parseArgs } from 'node:util';

const LOOPBACK_HOST = '0.0.0.0';

const { values: cliValues } = parseArgs({
  options: { port: { type: 'string' } },
  strict: false,
});

const PORT = (() => {
  const fromCli = Number(cliValues.port ?? Number.NaN);
  if (Number.isInteger(fromCli) && fromCli >= 0 && fromCli <= 65535) return fromCli;
  return Number(process.env.GATEFORGE_AUTH_PORT ?? 3001);
})();
const DEFAULT_AUTH_SECRET = process.env.GATEFORGE_AUTH_SECRET ?? 'gateforge-auth-test-secret-v1';
const SECRET = DEFAULT_AUTH_SECRET;
const ENV_FINGERPRINT = 'auth-loopback-v1';

/** In-memory refund ledger (the "database" the adapter reads). */
const refunds = new Map();

/** Server-issued sequential refund ids (`rfn-<n>`). */
let nextRefundSeq = 1;

/**
 * Default process-local ledger (standalone runs). Test harnesses inject
 * their own ledger to observe state independently of the app's HTTP API:
 * the app writes through it, the trusted observer reads through it, and
 * the worker receives neither.
 */
function createMemoryLedger() {
  const rows = new Map();
  let seq = 1;
  return {
    find: (id) => rows.get(id) ?? null,
    all: () => [...rows.values()],
    save: (record) => {
      const stored = { ...record };
      if (stored.id === undefined || stored.id === null) {
        stored.id = `rfn-${seq++}`;
      }
      rows.set(stored.id, stored);
      return stored;
    },
  };
}

const defaultLedger = {
  find: (id) => refunds.get(id) ?? null,
  all: () => [...refunds.values()],
  save: (record) => {
    const stored = { ...record };
    if (stored.id === undefined || stored.id === null) {
      stored.id = `rfn-${nextRefundSeq++}`;
    }
    refunds.set(stored.id, stored);
    return stored;
  },
};

/** Encode the `{"alg":"HS256","typ":"JWT"}` JOSE header (canonical JSON). */
function encodeHeader() {
  return base64UrlEncode(Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
}

/**
 * Compute the HS256 signature over `header.payload`, base64url-encoded.
 *
 * Args:
 *   header: base64url-encoded JOSE header.
 *   payload: base64url-encoded JSON payload.
 *
 * Returns:
 *   string: base64url-encoded HMAC-SHA256 digest.
 */
function sign(header, payload, secret = SECRET) {
  return base64UrlEncode(
    crypto.createHmac('sha256', secret).update(`${header}.${payload}`).digest(),
  );
}

/**
 * Sign a claims object as an HS256 JWT. Returns `header.payload.sig`.
 *
 * Args:
 *   claims: Plain-object JWT payload (sub, role, tenantId, exp).
 *
 * Returns:
 *   string: Compact JWS.
 */
function mintToken(claims, secret = SECRET) {
  const header = encodeHeader();
  const payload = base64UrlEncode(Buffer.from(JSON.stringify(claims)));
  const signature = sign(header, payload, secret);
  return `${header}.${payload}.${signature}`;
}

/**
 * Verify a token's signature and required claims. Returns either the
 * decoded claims object or `{ok:false, reason}` describing the first
 * failure (signature, expiry, missing claim). Single-cause: subsequent
 * failures are not reported — first failure short-circuits, matching
 * fail-closed auth semantics.
 *
 * Args:
 *   token: Compact JWS string.
 *
 * Returns:
 *   {ok:true, claims} | {ok:false, reason}
 */
function verifyToken(token, secret = SECRET) {
  if (typeof token !== 'string') return { ok: false, reason: 'missing token' };
  const parts = token.split('.');
  if (parts.length !== 3) return { ok: false, reason: 'malformed token' };
  const [header, payload, signature] = parts;
  if (!header || !payload || !signature) return { ok: false, reason: 'malformed token' };
  const expected = sign(header, payload, secret);
  if (!safeEqual(expected, signature)) return { ok: false, reason: 'bad signature' };
  let claims;
  try {
    claims = JSON.parse(Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
  } catch {
    return { ok: false, reason: 'unparseable payload' };
  }
  if (typeof claims.exp === 'number' && Math.floor(Date.now() / 1000) > claims.exp) {
    return { ok: false, reason: 'token expired' };
  }
  return { ok: true, claims };
}

/**
 * Constant-time string compare (HMAC tag verification). Defensive against
 * timing attacks even on a loopback demo: real signing keys MUST use a
 * constant-time compare.
 */
function safeEqual(a, b) {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.length !== bBuf.length) return false;
  return crypto.timingSafeEqual(aBuf, bBuf);
}

function base64UrlEncode(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Reads and JSON-parses a request body. Empty body => {}.
 *
 * Args:
 *   req: node:http.IncomingMessage.
 *
 * Returns:
 *   Promise<object>: Parsed JSON object. Empty body => empty object.
 */
function readJson(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 32 * 1024) {
        reject(new Error('body too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (raw.length === 0) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('malformed JSON'));
      }
    });
    req.on('error', reject);
  });
}

/** Writes a JSON response with the env fingerprint + content-type. */
function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'x-gateforge-env': ENV_FINGERPRINT,
  });
  res.end(text);
}

/**
 * Read the bearer token from the `Authorization` header. Returns the
 * raw token string or `null` when missing/malformed.
 */
function bearerFromAuthz(value) {
  if (typeof value !== 'string') return null;
  const match = /^Bearer\s+(.+)$/.exec(value);
  if (!match) return null;
  return match[1] ?? null;
}

/**
 * Look up a refund by id; returns `null` when absent.
 */
function findRefund(id, ledger = defaultLedger) {
  return ledger.find(id);
}

/**
 * Persist a refund record. The handler ONLY runs after every guard has
 * passed, so this is the side-effect surface for `auth:denied-no-side-effect`.
 */
function createRefund({ id, amountCents, tenantId, requestedBy }, ledger = defaultLedger) {
  const record = {
    amount_cents: amountCents,
    tenant_id: tenantId,
    requested_by: requestedBy,
    status: 'refunded',
    created_at: new Date('2026-08-31T00:00:00.000Z').toISOString(),
  };
  if (id !== undefined && id !== null) record.id = id;
  return ledger.save(record);
}

/** Route matchers for the example. Kept inline (no router dep). */
const REFUND_GET = /^\/api\/billing\/refund\/(rfn-\d+)$/;
const REFUND_POST = /^\/billing\/refund$/;

async function handle(req, res, ctx = {}) {
  const secret = ctx.secret ?? SECRET;
  const ledger = ctx.ledger ?? defaultLedger;
  const url = new URL(req.url, `http://${LOOPBACK_HOST}`);
  const path = url.pathname;

  // Trusted read for the witness adapter (GET-only).
  const getMatch = REFUND_GET.exec(path);
  if (getMatch && req.method === 'GET') {
    const refund = findRefund(getMatch[1], ledger);
    if (refund) sendJson(res, 200, refund);
    else sendJson(res, 404, { error: 'not found' });
    return;
  }

  // Guarded mutation: role + tenant.
  if (REFUND_POST.exec(path) && req.method === 'POST') {
    const token = bearerFromAuthz(req.headers.authorization);
    const verification = verifyToken(token, secret);
    if (!verification.ok) {
      sendJson(res, 401, { error: 'unauthorized', detail: verification.reason });
      return;
    }
    const claims = verification.claims;
    const role = claims.role;
    if (role !== 'admin') {
      sendJson(res, 403, { error: 'forbidden', detail: 'requires role admin' });
      return;
    }
    let body;
    try {
      body = await readJson(req);
    } catch (err) {
      sendJson(res, 400, { error: 'bad request', detail: err.message });
      return;
    }
    const { tenant_id: requestedTenant, amount_cents: amountCents } = body;
    if (typeof requestedTenant !== 'string' || typeof amountCents !== 'number') {
      sendJson(res, 400, { error: 'bad request', detail: 'tenant_id + amount_cents required' });
      return;
    }
    if (claims.tenantId !== requestedTenant) {
      sendJson(res, 403, { error: 'forbidden', detail: 'cross-tenant request rejected' });
      return;
    }
    const id = `rfn-${nextRefundSeq++}`;
    const record = createRefund(
      {
        amountCents,
        tenantId: requestedTenant,
        requestedBy: claims.sub ?? 'unknown',
      },
      ledger,
    );
    sendJson(res, 201, record);
    return;
  }

  // Token-mint helpers for the e2e harness ONLY (deterministic secrets).
  if (path === '/__test/mint' && req.method === 'POST') {
    let body;
    try {
      body = await readJson(req);
    } catch {
      body = {};
    }
    const role = body.role === 'tenant' ? 'tenant' : 'admin';
    const tenantId = typeof body.tenantId === 'string' ? body.tenantId : 'tenant-a';
    const sub = typeof body.sub === 'string' ? body.sub : `${role}-1`;
    const exp = typeof body.exp === 'number' ? body.exp : Math.floor(Date.now() / 1000) + 3600;
    const token = mintToken({ sub, role, tenantId, exp }, secret);
    sendJson(res, 200, { token, role, tenantId, sub, exp });
    return;
  }

  if (path === '/__test/forged' && req.method === 'POST') {
    // Mint a valid token, then mutate one byte of the signature (adversarial).
    let body;
    try {
      body = await readJson(req);
    } catch {
      body = {};
    }
    const role = body.role === 'tenant' ? 'tenant' : 'admin';
    const tenantId = typeof body.tenantId === 'string' ? body.tenantId : 'tenant-a';
    const token = mintToken({ sub: `${role}-1`, role, tenantId, exp: Math.floor(Date.now() / 1000) + 3600 }, secret);
    // Flip the last byte of the signature to forge it.
    const parts = token.split('.');
    const last = parts[2].slice(0, -1);
    const flipped = (parseInt(token.slice(-1), 36) + 1).toString(36);
    parts[2] = last + flipped;
    sendJson(res, 200, { token: parts.join('.') });
    return;
  }

  sendJson(res, 404, { error: 'not found' });
}

/**
 * Creates the auth example application (factory for test harnesses).
 *
 * Args:
 *   options (object): optional `secret` (HMAC secret; defaults to the
 *     stable test secret) and `ledger` (injected refund ledger; the app
 *     writes through it and the trusted observer reads through it).
 *
 * Returns:
 *   http.Server (unbound; the caller listens on loopback).
 */
export function createAuthApp({ secret = SECRET, ledger = defaultLedger } = {}) {
  const server = http.createServer((req, res) => {
    handle(req, res, { secret, ledger }).catch((err) => {
      sendJson(res, 500, { error: 'internal', detail: err.message });
    });
  });
  return server;
}

/**
 * Mints a test token with an explicit secret (trusted-harness actor
 * provisioning; never suite-supplied at runtime).
 */
export function mintAuthToken(secret, claims) {
  return mintToken(claims, secret);
}

export { DEFAULT_AUTH_SECRET, createMemoryLedger };

const invokedDirectly = process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].split('/').pop() ?? '');
if (invokedDirectly) {
  const server = createAuthApp();
  server.listen(PORT, LOOPBACK_HOST, () => {
    console.log(`gateforge auth example listening on http://${LOOPBACK_HOST}:${PORT}`);
  });

  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      server.close(() => process.exit(0));
    });
  }
}