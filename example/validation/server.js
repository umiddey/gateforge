// Gateforge example application: a validation pack exercise.
//
// In-process store, in-memory only. Two endpoints:
//
//   GET  /accounts                 list accounts
//   POST /accounts                 create account (validated by a zod schema)
//
// The zod schema (defined here for the example — the production
// detection target is `z.object({...})` in the user's codebase):
//
//   first_name: 1..50 chars
//   last_name:  1..50 chars
//   email:      basic email regex
//
// The server mirrors the validation pack's contract obligations:
//   - boundary-accepted       (201 with valid body)
//   - boundary-rejected       (400 with explicit field names on invalid body)
//   - no-side-effect-on-reject (rejected POST does NOT add to the store)

import http from 'node:http';

const PORT = Number(process.env.PORT ?? 3005);
const LOOPBACK_HOST = '127.0.0.1';

/** Minimal zod-like schema: validates {first_name, last_name, email}. */
function makeAccountSchema() {
  const errors = (path, msg) => [{ field: path, message: msg }];
  const validate = (input) => {
    const out = [];
    if (typeof input !== 'object' || input === null) {
      out.push(...errors('body', 'must be an object'));
      return { ok: false, errors: out };
    }
    const { first_name, last_name, email } = input;
    if (typeof first_name !== 'string' || first_name.length < 1 || first_name.length > 50) {
      out.push(...errors('first_name', 'must be 1..50 chars'));
    }
    if (typeof last_name !== 'string' || last_name.length < 1 || last_name.length > 50) {
      out.push(...errors('last_name', 'must be 1..50 chars'));
    }
    if (typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      out.push(...errors('email', 'must be a valid email'));
    }
    return out.length === 0 ? { ok: true } : { ok: false, errors: out };
  };
  return { validate };
}

const schema = makeAccountSchema();

/**
 * Default process-local ledger (standalone runs). Test harnesses inject
 * their own ledger to observe state independently of the app's HTTP API.
 */
function createMemoryLedger() {
  const rows = [];
  let seq = 0;
  return {
    list: () => rows.map((row) => ({ ...row })),
    push: (fields) => {
      seq += 1;
      const record = { id: `acc-${seq}`, ...fields };
      rows.push(record);
      return { ...record };
    },
  };
}

const defaultLedger = createMemoryLedger();
const store = {
  list: () => defaultLedger.list(),
  push: (fields) => defaultLedger.push(fields),
};
let seq = 0;

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let buf = '';
    req.on('data', (chunk) => { buf += chunk; if (buf.length > 32_000) { req.destroy(); reject(new Error('body too large')); } });
    req.on('end', () => {
      try { resolve(JSON.parse(buf)); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function projectRow(a) {
  return { id: a.id, first_name: a.first_name, last_name: a.last_name, email: a.email };
}

/**
 * Creates the validation example application (factory for harnesses).
 *
 * Args:
 *   options (object): optional `ledger` ({list(), push(fields)}) — the
 *   app writes through it and the trusted observer reads through it.
 *
 * Returns:
 *   http.Server (unbound; the caller listens on loopback).
 */
export function createValidationApp({ ledger = defaultLedger } = {}) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${LOOPBACK_HOST}`);
    try {
      if (req.method === 'GET' && url.pathname === '/accounts') {
        return json(res, 200, { accounts: ledger.list().map(projectRow) });
      }
      if (req.method === 'POST' && url.pathname === '/accounts') {
        const body = await readJsonBody(req);
        const result = schema.validate(body);
        if (!result.ok) return json(res, 400, { errors: result.errors });
        const created = ledger.push({ first_name: body.first_name, last_name: body.last_name, email: body.email });
        return json(res, 201, projectRow(created));
      }
      return json(res, 404, { error: 'not found' });
    } catch (err) {
      return json(res, 400, { error: err instanceof Error ? err.message : 'bad request' });
    }
  });
  return server;
}

export { createMemoryLedger };

const invokedDirectly = process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].split('/').pop() ?? '');
if (invokedDirectly) {
  const server = createValidationApp();
  server.listen(PORT, LOOPBACK_HOST, () => {
    console.log(`gateforge validation example listening on http://${LOOPBACK_HOST}:${PORT}`);
  });
}
