#!/usr/bin/env node
/**
 * Gateforge example workflow server: an in-memory contract state
 * machine on port 3002.
 *
 *   draft  --submit-->  pending  --sign-->  signed  --terminate-->  terminated
 *
 * `terminated` is the only terminal state — every write attempt against
 * it is rejected with `409 { error: "terminal-state" }` and appends NO
 * audit row. Invalid jumps (e.g. `draft -> signed`) are rejected with
 * `409 { error: "invalid-transition" }` and append NO audit row. Every
 * accepted transition appends one row to `audit.json` with the shape
 *
 *   { actor, from, to, at }
 *
 * Usage:
 *   node server.js                       default port 3002
 *   PORT=4173 node server.js             override port via env
 *   node server.js --port=4173           override via cli arg
 *
 * HTTP surface:
 *   GET    /contracts              list { contracts: [{ id, status }] }
 *   GET    /contracts/:id          one contract (404 if missing)
 *   POST   /contracts              create in `draft` state
 *                                   body: { actor, title }
 *   POST   /contracts/:id/transitions  attempt a transition
 *                                      body: { actor, event }
 *   GET    /audit                  { rows: AuditRow[] }
 *   POST   /audit/reset             clear the audit log (test only)
 *
 * Every successful mutation answers 4xx/2xx directly; we DO NOT
 * redirect anywhere — this server is a JSON API, not a UI.
 */
import http from 'node:http';
import { appendFileSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const AUDIT_PATH = join(HERE, 'audit.json');
const MAX_BODY_BYTES = 32 * 1024;

const STATUSES = /** @type {const} */ (['draft', 'pending', 'signed', 'terminated']);

/** Allowed transitions per (from, event). */
const TRANSITIONS = /** @type {const} */ ([
  { from: 'draft', event: 'submit', to: 'pending' },
  { from: 'pending', event: 'sign', to: 'signed' },
  { from: 'signed', event: 'terminate', to: 'terminated' },
]);

const TERMINAL = /** @type {readonly string[]} */ (['terminated']);

/** Seed clock for deterministic tests; override with `Clock({ now })`. */
function makeClock(initial = new Date('2026-08-31T00:00:00.000Z')) {
  let now = initial;
  return {
    now: () => new Date(now),
    advance: (ms) => { now = new Date(now.getTime() + ms); return now; },
    set: (at) => { now = new Date(at); return now; },
  };
}

/** Read the audit log from disk; return `[]` if missing or malformed. */
function readAudit() {
  if (!existsSync(AUDIT_PATH)) return [];
  let raw;
  try {
    raw = readFileSync(AUDIT_PATH, 'utf8');
  } catch {
    return [];
  }
  if (raw.trim().length === 0) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** Append one row to the audit log atomically. */
function appendAudit(row) {
  const rows = readAudit();
  rows.push(row);
  writeFileSync(AUDIT_PATH, JSON.stringify(rows, null, 2) + '\n');
}

/** In-memory contract store. */
class ContractStore {
  constructor() {
    /** @type {Map<string, { id: string, status: string, title: string, history: string[] }>} */
    this.contracts = new Map();
    this._seq = 0;
  }

  /** Allocate a new contract id (`wf-<n>`). Deterministic per process. */
  _nextId() {
    this._seq += 1;
    return `wf-${this._seq}`;
  }

  /** Create a new contract in `draft` state. */
  create({ title }) {
    const id = this._nextId();
    const contract = { id, status: 'draft', title, history: ['draft'] };
    this.contracts.set(id, contract);
    return contract;
  }

  /** Find by id; `null` if missing. */
  get(id) {
    return this.contracts.get(id) ?? null;
  }

  /** Snapshot of the current state for serialisation. */
  list() {
    return [...this.contracts.values()].map((c) => ({ id: c.id, status: c.status, title: c.title }));
  }

  /** Wipe the store and reset the id counter (test-only). */
  clear() {
    this.contracts.clear();
    this._seq = 0;
  }
}

/**
 * Attempt to transition
/**
 * Attempt to transition `contract` by `event`.
 *
 * @returns {{
 *   ok: boolean,
 *   status: number,
 *   body: object
 * }}
 */
function attemptTransition(store, contract, { actor, event }, clock) {
  if (TERMINAL.includes(contract.status)) {
    return { ok: false, status: 409, body: { error: 'terminal-state', currentStatus: contract.status } };
  }
  const found = TRANSITIONS.find((t) => t.from === contract.status && t.event === event);
  if (found === undefined) {
    return { ok: false, status: 409, body: { error: 'invalid-transition', currentStatus: contract.status, event } };
  }
  contract.status = found.to;
  contract.history.push(found.to);
  appendAudit({ actor, from: found.from, to: found.to, at: clock.now().toISOString() });
  return { ok: true, status: 200, body: { id: contract.id, status: contract.status } };
}

/** Escape a value for JSON-safe embedding in error responses (no XSS surface; JSON only). */
function jsonResponse(res, status, body) {
  const bodyText = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(bodyText),
  });
  res.end(bodyText);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let chunks = [];
    let received = 0;
    req.on('data', (chunk) => {
      received += chunk.length;
      if (received > MAX_BODY_BYTES) {
        reject(new Error('payload too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (text.length === 0) return resolve({});
      try {
        resolve(JSON.parse(text));
      } catch (err) {
        reject(new Error(`invalid JSON: ${err.message}`));
      }
    });
    req.on('error', reject);
  });
}

/** Build the request handler. */
function buildHandler({ store, clock }) {
  return async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
    const { pathname } = url;
    const method = req.method ?? 'GET';

    try {
      if (method === 'GET' && pathname === '/contracts') {
        return jsonResponse(res, 200, { contracts: store.list() });
      }
      if (method === 'POST' && pathname === '/contracts') {
        const body = await readJsonBody(req);
        if (typeof body.actor !== 'string' || typeof body.title !== 'string') {
          return jsonResponse(res, 400, { error: 'actor and title required' });
        }
        const contract = store.create({ title: body.title });
        appendAudit({ actor: body.actor, from: '<initial>', to: 'draft', at: clock.now().toISOString() });
        return jsonResponse(res, 201, { id: contract.id, status: contract.status });
      }
      const singleMatch = /^\/contracts\/([^/]+)$/.exec(pathname);
      if (method === 'GET' && singleMatch !== null) {
        const contract = store.get(singleMatch[1]);
        if (contract === null) return jsonResponse(res, 404, { error: 'not found' });
        return jsonResponse(res, 200, contract);
      }
      const transMatch = /^\/contracts\/([^/]+)\/transitions$/.exec(pathname);
      if (method === 'POST' && transMatch !== null) {
        const contract = store.get(transMatch[1]);
        if (contract === null) return jsonResponse(res, 404, { error: 'not found' });
        const body = await readJsonBody(req);
        if (typeof body.actor !== 'string' || typeof body.event !== 'string') {
          return jsonResponse(res, 400, { error: 'actor and event required' });
        }
        const result = attemptTransition(store, contract, { actor: body.actor, event: body.event }, clock);
        return jsonResponse(res, result.status, result.body);
      }
      if (method === 'GET' && pathname === '/audit') {
        return jsonResponse(res, 200, { rows: readAudit() });
      }
      if (method === 'POST' && pathname === '/audit/reset') {
        writeFileSync(AUDIT_PATH, '[]\n');
        return jsonResponse(res, 200, { reset: true });
      }
      if (method === 'POST' && pathname === '/contracts/reset') {
        store.clear();
        return jsonResponse(res, 200, { reset: true });
      }
    } catch (err) {
      return jsonResponse(res, 400, { error: err instanceof Error ? err.message : 'bad request' });
    }
  };
}

function parsePort(argv) {
  const cliIdx = argv.indexOf('--port');
  if (cliIdx !== -1) {
    const next = argv[cliIdx + 1];
    if (next === undefined) throw new Error('--port requires a value');
    const n = Number(next);
    if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error(`invalid --port: ${next}`);
    return n;
  }
  const eqIdx = argv.indexOf('--port=');
  if (eqIdx !== -1) {
    const next = argv[eqIdx].slice('--port='.length);
    const n = Number(next);
    if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error(`invalid --port: ${next}`);
    return n;
  }
  if (process.env.PORT !== undefined) {
    const n = Number(process.env.PORT);
    if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error(`invalid PORT env: ${process.env.PORT}`);
    return n;
  }
  return 3002;
}

/** Build the app (exported so tests can drive it directly). */
export function createApp(options = {}) {
  const store = options.store ?? new ContractStore();
  const clock = options.clock ?? makeClock();
  const server = http.createServer(buildHandler({ store, clock }));
  return { server, store, clock };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = parsePort(process.argv.slice(2));
  const { server } = createApp();
  server.listen(port, '127.0.0.1', () => {
    const addr = server.address();
    console.log(`gateforge example workflow server listening on http://127.0.0.1:${typeof addr === 'object' && addr !== null ? addr.port : port}`);
  });
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => { server.close(() => process.exit(0)); });
  }
}

// Export pure helpers for the e2e suite and the witness adapter.
export {
  STATUSES,
  TRANSITIONS,
  TERMINAL,
  appendAudit,
  attemptTransition,
  makeClock,
  readAudit,
};