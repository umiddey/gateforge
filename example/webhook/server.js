#!/usr/bin/env node
// Example webhook receiver for @gate-forge/pack-webhook.
//
// Listens on PORT 3003 by default (configurable via --port, accepts 0
// for OS-assigned free port). Implements the five obligation contracts
// the pack claims:
//
//   webhook:signature-accepted     — valid HMAC-SHA256 sig over raw body
//   webhook:signature-rejected     — bad signature -> 401, no side effect
//   webhook:malformed-rejected     — invalid JSON / oversized body -> 400
//   webhook:replay-idempotent      — duplicate event_id within window
//                                    produces exactly one side-effect entry
//   webhook:retry-bounded          — same event_id with attempt > 3 -> 429
//
// The shared secret is loopback-only and deterministic so the e2e suite
// can sign requests without coordination. The signature header mirrors
// the detector's default (`x-signature`) and the algorithm is HMAC-SHA256
// over the raw request body. The replay window is 5 minutes
// (configurable via env WEBHOOK_REPLAY_WINDOW_MS).

import { parseArgs } from 'node:util';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';

/** Shared HMAC secret (loopback, deterministic). */
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET ?? 'gateforge-webhook-loopback-secret-v1';

/** Signature header (matches detector default). */
const SIGNATURE_HEADER = 'x-signature';

/** Replay window: 5 minutes default. */
const REPLAY_WINDOW_MS = Number(process.env.WEBHOOK_REPLAY_WINDOW_MS ?? 5 * 60 * 1000);

/** Hard ceiling on retries per event_id. */
const MAX_ATTEMPTS = 3;

/** Maximum accepted body size in bytes (1 MiB). */
const MAX_BODY_BYTES = 1_048_576;

/** Allowed skew tolerance for the `X-Webhook-Timestamp` header (ms). */
const TIMESTAMP_SKEW_MS = REPLAY_WINDOW_MS;

/** In-memory delivery log: event_id -> { attempt, firstSeenAt, sideEffects }. */
const deliveryLog = new Map();

/** Apply the side effect for a freshly-accepted event. */
function applySideEffect(event, state = defaultWebhookState()) {
  const prior = state.deliveryLog.get(event.event_id);
  state.deliveryLog.set(event.event_id, {
    eventId: event.event_id,
    attempt: 1,
    firstSeenAt: Date.now(),
    sideEffectCount: (prior?.sideEffectCount ?? 0) + 1,
  });
}

/** Read raw body from request as Buffer. */
function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error('body-too-large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Compute expected HMAC-SHA256 over the raw body. */
function computeSignature(rawBody, secret = WEBHOOK_SECRET) {
  return createHmac('sha256', secret).update(rawBody).digest('hex');
}

/** Constant-time signature compare. */
function signatureMatches(expected, provided) {
  if (typeof provided !== 'string' || provided.length === 0) return false;
  const expBuf = Buffer.from(expected, 'utf8');
  const provBuf = Buffer.from(provided, 'utf8');
  if (expBuf.length !== provBuf.length) return false;
  return timingSafeEqual(expBuf, provBuf);
}

/** Write a JSON response. */
function send(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
    'x-gateforge-env': 'example-webhook-v1',
  });
  res.end(payload);
}

/** The webhook route handler. */
async function handleWebhook(req, res, state = defaultWebhookState()) {
  // 1. raw body read + size guard
  let rawBody;
  try {
    rawBody = await readRawBody(req);
  } catch (err) {
    if (err && err.message === 'body-too-large') {
      send(res, 413, { error: 'body-too-large', maxBody: MAX_BODY_BYTES });
    } else {
      send(res, 400, { error: 'malformed', detail: 'unable to read body' });
    }
    return;
  }

  // 2. signature verification
  const providedSig = req.headers[SIGNATURE_HEADER];
  const expectedSig = computeSignature(rawBody);
  if (!signatureMatches(expectedSig, providedSig)) {
    send(res, 401, { error: 'bad-signature' });
    return;
  }

  // 3. JSON parse
  let event;
  try {
    event = JSON.parse(rawBody.toString('utf8'));
  } catch {
    send(res, 400, { error: 'malformed-json' });
    return;
  }
  if (!event || typeof event !== 'object' || typeof event.event_id !== 'string' || event.event_id.length === 0) {
    send(res, 400, { error: 'malformed-event', detail: 'event_id is required' });
    return;
  }

  // 4. timestamp / replay window
  const tsHeader = req.headers['x-webhook-timestamp'];
  const tsNum = tsHeader ? Number(tsHeader) : NaN;
  if (!Number.isFinite(tsNum) || Math.abs(Date.now() - tsNum) > TIMESTAMP_SKEW_MS) {
    send(res, 401, { error: 'stale-timestamp', replayWindowMs: REPLAY_WINDOW_MS });
    return;
  }

  // 5. retry bound
  const attemptHeader = req.headers['x-webhook-attempt'];
  const attempt = attemptHeader ? Number(attemptHeader) : 1;
  if (!Number.isInteger(attempt) || attempt < 1) {
    send(res, 400, { error: 'bad-attempt-header' });
    return;
  }
  if (attempt > MAX_ATTEMPTS) {
    send(res, 429, { error: 'retry-budget-exhausted', maxAttempts: MAX_ATTEMPTS });
    return;
  }

  // 6. replay dedup (only the FIRST delivery produces a side effect)
  const prior = state.deliveryLog.get(event.event_id);
  if (prior !== undefined) {
    send(res, 200, { ok: true, deduplicated: true, eventId: event.event_id });
    return;
  }

  // 7. happy path
  applySideEffect(event);
  send(res, 200, { ok: true, deduplicated: false, eventId: event.event_id });
}

/** GET /delivery-log/:eventId — witness endpoint for the e2e. */
function handleLogGet(req, res, state = defaultWebhookState()) {
  const url = (req.url ?? '').split('?')[0];
  const eventId = decodeURIComponent(url.replace(/^\/delivery-log\//, ''));
  const record = state.deliveryLog.get(eventId);
  if (record === undefined) {
    send(res, 404, { error: 'not-found', eventId });
    return;
  }
  send(res, 200, record);
}

/** Per-instance webhook state (test harnesses inject to observe independently). */
export function createWebhookState() {
  return { deliveryLog: new Map() };
}

/** Default process-global state (standalone runs). */
function defaultWebhookState() {
  return { deliveryLog };
}

/** Start the server on `port` (0 = OS-assigned). */
function start(port, state = defaultWebhookState()) {
  const server = createServer((req, res) => {
    const url = (req.url ?? '').split('?')[0];
    if (req.method === 'POST' && (url === '/webhook/stripe' || url === '/webhook' || url === '/webhook/')) {
      handleWebhook(req, res, state);
      return;
    }
    if (req.method === 'GET' && url.startsWith('/delivery-log/')) {
      handleLogGet(req, res, state);
      return;
    }
    send(res, 404, { error: 'not-found', method: req.method, url });
  });
  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(port, '127.0.0.1', () => {
      const { address, port: bound } = server.address();
      console.log(`gateforge example webhook listening on http://${address}:${bound}`);
      resolve({ server });
    });
  });
}

/** Parse CLI args. */
function parseCli() {
  const { values } = parseArgs({
    options: { port: { type: 'string' } },
  });
  let port = 3003;
  if (values.port !== undefined) {
    port = Number(values.port);
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
      console.error(`error: --port must be an integer in [0, 65535], got ${JSON.stringify(values.port)}`);
      process.exit(2);
    }
  }
  return { port };
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].split('/').pop() ?? '');
if (invokedDirectly) {
  const { port } = parseCli();
  const { server } = await start(port);

  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      server.close(() => process.exit(0));
    });
  }
}