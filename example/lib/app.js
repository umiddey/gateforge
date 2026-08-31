// Gateforge example application: an in-memory `accounts` resource with a
// server-rendered HTML UI and a read-only JSON API.
//
// Zero external dependencies (node:http only). The server binds 127.0.0.1 and
// never performs outbound requests: Gateforge runs offline, loopback only.
//
// HTTP surface
//   UI (server-rendered HTML, plain form posts):
//     GET  /                       accounts list (archived rows stay visible, marked)
//     GET  /accounts/new           create form
//     POST /accounts               create        (fields: first_name, last_name)
//     GET  /accounts/:id/edit      edit form (prefilled)
//     POST /accounts/:id           update        (fields: first_name, last_name)
//     POST /accounts/:id/archive   archive       (status change; no hard delete)
//   JSON read API (trusted-adapter surface):
//     GET /api/accounts            { "accounts": [...] }
//     GET /api/accounts/:id        account object | 404 { "error": "not found" }
//
// Every successful mutation answers 303 -> "/" so the rendered list is the
// visible result of the action (create shows the new row, update the changed
// values, archive the archived status).

import http from 'node:http';

const MAX_BODY_BYTES = 32 * 1024;

/** Escape a value for safe interpolation into HTML text and attributes. */
function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/**
 * Serialize a value as GF-canonical JSON: UTF-8, recursively key-sorted,
 * no whitespace. Payloads are strings only (ids, names, statuses, ISO
 * timestamps), so no number-formatting edge cases apply.
 */
function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * Create the in-memory accounts store.
 *
 * Args:
 *   options (object): optional.
 *     clock (function): injectable clock; called for every timestamp and may
 *       return anything `new Date()` accepts. Defaults to the system clock.
 *
 * Returns:
 *   object: { create, get, list, update, archive }. Ids are server-issued
 *   `acc-<n>`; timestamps are ISO-8601 strings from the injected clock;
 *   archive only flips `status` to "archived" (no hard delete).
 */
export function createAccountStore({ clock = () => new Date() } = {}) {
  const accounts = new Map();
  let nextId = 1;
  const nowIso = () => new Date(clock()).toISOString();

  return {
    create({ firstName, lastName }) {
      const id = `acc-${nextId++}`;
      const timestamp = nowIso();
      const account = {
        id,
        first_name: firstName,
        last_name: lastName,
        status: 'active',
        created_at: timestamp,
        updated_at: timestamp,
      };
      accounts.set(id, account);
      return account;
    },

    get(id) {
      return accounts.get(id) ?? null;
    },

    list() {
      return [...accounts.values()];
    },

    update(id, { firstName, lastName }) {
      const account = accounts.get(id);
      if (!account) return null;
      account.first_name = firstName;
      account.last_name = lastName;
      account.updated_at = nowIso();
      return account;
    },

    archive(id) {
      const account = accounts.get(id);
      if (!account) return null;
      account.status = 'archived';
      account.updated_at = nowIso();
      return account;
    },
  };
}

/** Wrap page content in the shared HTML layout. */
function layout(title, body) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} · Gateforge example</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 2rem auto; max-width: 64rem; padding: 0 1rem; color: #1c2733; }
  nav a { margin-right: 1rem; }
  table { border-collapse: collapse; width: 100%; margin-top: 1rem; }
  th, td { border: 1px solid #cfd8e3; padding: 0.4rem 0.6rem; text-align: left; vertical-align: top; }
  th { background: #eef2f7; }
  .status { font-weight: 600; }
  .status.active { color: #166534; }
  .status.archived { color: #92400e; }
  tr.archived-row td { color: #6b7280; background: #fafaf9; }
  form.inline { display: inline; }
  button { cursor: pointer; }
  .error { color: #b91c1c; font-weight: 600; }
  .field { display: block; margin-bottom: 0.75rem; }
  .timestamp { font-family: ui-monospace, monospace; font-size: 0.85rem; white-space: nowrap; }
  .empty { margin-top: 1rem; color: #6b7280; }
</style>
</head>
<body>
<nav><a href="/">Accounts</a> <a href="/accounts/new">New account</a></nav>
${body}
</body>
</html>
`;
}

/** Render the accounts list. Archived rows stay visible and marked. */
function renderListPage(accounts) {
  const rows = accounts
    .map((account) => {
      const archived = account.status === 'archived';
      const archiveControl = archived
        ? ''
        : `<form class="inline" method="post" action="/accounts/${account.id}/archive">` +
          `<button type="submit">Archive</button></form>`;
      return `  <tr class="${archived ? 'archived-row' : 'active-row'}">
    <td>${account.id}</td>
    <td>${escapeHtml(account.first_name)}</td>
    <td>${escapeHtml(account.last_name)}</td>
    <td><span class="status ${account.status}">${account.status}</span></td>
    <td class="timestamp">${account.created_at}</td>
    <td class="timestamp">${account.updated_at}</td>
    <td><a href="/accounts/${account.id}/edit">Edit</a> ${archiveControl}</td>
  </tr>`;
    })
    .join('\n');
  const table = accounts.length
    ? `<table>
  <thead><tr><th>ID</th><th>First name</th><th>Last name</th><th>Status</th><th>Created</th><th>Updated</th><th>Actions</th></tr></thead>
  <tbody>
${rows}
  </tbody>
</table>`
    : `<p class="empty">No accounts yet.</p>`;
  return layout('Accounts', `<h1>Accounts</h1>\n${table}`);
}

/** Render the create form, optionally with a validation error. */
function renderCreateFormPage({ error = null, values = {} } = {}) {
  const errorHtml = error ? `<p class="error">${escapeHtml(error)}</p>\n` : '';
  const body = `<h1>New account</h1>
${errorHtml}<form method="post" action="/accounts">
  <label class="field">First name <input type="text" name="first_name" value="${escapeHtml(values.first_name ?? '')}" required></label>
  <label class="field">Last name <input type="text" name="last_name" value="${escapeHtml(values.last_name ?? '')}" required></label>
  <button type="submit">Create account</button>
</form>`;
  return layout('New account', body);
}

/** Render the edit form for one account, plus the archive control. */
function renderEditFormPage(account, { error = null, values = null } = {}) {
  const fields = values ?? account;
  const errorHtml = error ? `<p class="error">${escapeHtml(error)}</p>\n` : '';
  const archiveControl =
    account.status === 'archived'
      ? `<p><span class="status archived">archived</span> — this account is archived (status change only; it stays retrievable).</p>`
      : `<form method="post" action="/accounts/${account.id}/archive">
  <button type="submit">Archive account</button>
</form>`;
  const body = `<h1>Edit account ${account.id}</h1>
<p><a href="/">← Back to accounts</a></p>
${errorHtml}<form method="post" action="/accounts/${account.id}">
  <label class="field">First name <input type="text" name="first_name" value="${escapeHtml(fields.first_name)}" required></label>
  <label class="field">Last name <input type="text" name="last_name" value="${escapeHtml(fields.last_name)}" required></label>
  <button type="submit">Save changes</button>
</form>
<h2>Archive</h2>
${archiveControl}`;
  return layout(`Edit ${account.id}`, body);
}

/** Render the 404 page. */
function renderNotFoundPage(path) {
  const body = `<h1>Not found</h1>
<p>No page at <code>${escapeHtml(path)}</code>.</p>
<p><a href="/">← Back to accounts</a></p>`;
  return layout('Not found', body);
}

/** Send an HTML response. */
function sendHtml(res, status, html) {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' });
  res.end(html);
}

/** Send a GF-canonical JSON response. */
function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(canonicalJson(body));
}

/** Send a POST-redirect-GET hop back to the accounts list. */
function redirectToList(res) {
  res.writeHead(303, { location: '/' });
  res.end();
}

/**
 * Read and parse a urlencoded form body.
 *
 * Returns:
 *   Promise<object>: field map (last value wins per field). Rejects with
 *   Error.code = 'encoding' for non-form content types or malformed bodies,
 *   'too-large' when the body exceeds MAX_BODY_BYTES.
 */
function readFormBody(req) {
  return new Promise((resolve, reject) => {
    const contentType = req.headers['content-type'] ?? '';
    if (!contentType.split(';')[0].trim().startsWith('application/x-www-form-urlencoded')) {
      const error = new Error('expected application/x-www-form-urlencoded body');
      error.code = 'encoding';
      reject(error);
      return;
    }
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > MAX_BODY_BYTES) {
        const error = new Error('request body too large');
        error.code = 'too-large';
        reject(error);
        req.destroy();
      }
    });
    req.on('end', () => {
      try {
        const fields = {};
        for (const [key, value] of new URLSearchParams(raw)) {
          fields[key] = value;
        }
        resolve(fields);
      } catch (error) {
        error.code = 'encoding';
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

/** Validate submitted name fields; returns trimmed values or an error message. */
function validateNames(fields) {
  const firstName = (fields.first_name ?? '').trim();
  const lastName = (fields.last_name ?? '').trim();
  if (!firstName || !lastName) {
    return { error: 'Both first_name and last_name are required.' };
  }
  return { firstName, lastName };
}

/**
 * Create the example application server.
 *
 * Args:
 *   options (object): optional.
 *     clock (function): injectable clock passed through to the store;
 *       defaults to the system clock.
 *
 * Returns:
 *   http.Server: bound later by the caller (always to 127.0.0.1).
 */
export function createApp({ clock } = {}) {
  const store = createAccountStore({ clock });

  async function handle(req, res) {
    const url = new URL(req.url, 'http://127.0.0.1');
    const path = url.pathname;

    // --- JSON read API (trusted-adapter surface) -------------------------
    if (req.method === 'GET' && path === '/api/accounts') {
      sendJson(res, 200, { accounts: store.list() });
      return;
    }
    const apiMatch = /^\/api\/accounts\/(acc-[0-9]+)$/.exec(path);
    if (apiMatch && req.method === 'GET') {
      const account = store.get(apiMatch[1]);
      if (account) sendJson(res, 200, account);
      else sendJson(res, 404, { error: 'not found' });
      return;
    }

    // --- Server-rendered UI ----------------------------------------------
    if (req.method === 'GET' && path === '/') {
      sendHtml(res, 200, renderListPage(store.list()));
      return;
    }
    if (req.method === 'GET' && path === '/accounts/new') {
      sendHtml(res, 200, renderCreateFormPage());
      return;
    }

    const editPageMatch = /^\/accounts\/(acc-[0-9]+)\/edit$/.exec(path);
    if (editPageMatch && req.method === 'GET') {
      const account = store.get(editPageMatch[1]);
      if (account) sendHtml(res, 200, renderEditFormPage(account));
      else sendHtml(res, 404, renderNotFoundPage(path));
      return;
    }

    if (req.method === 'POST' && path === '/accounts') {
      const fields = await readFormBody(req);
      const names = validateNames(fields);
      if (names.error) {
        sendHtml(res, 422, renderCreateFormPage({ error: names.error, values: fields }));
        return;
      }
      store.create(names);
      redirectToList(res);
      return;
    }

    const updateMatch = /^\/accounts\/(acc-[0-9]+)$/.exec(path);
    if (updateMatch && req.method === 'POST') {
      const account = store.get(updateMatch[1]);
      if (!account) {
        sendHtml(res, 404, renderNotFoundPage(path));
        return;
      }
      const fields = await readFormBody(req);
      const names = validateNames(fields);
      if (names.error) {
        sendHtml(res, 422, renderEditFormPage(account, { error: names.error, values: fields }));
        return;
      }
      store.update(account.id, names);
      redirectToList(res);
      return;
    }

    const archiveMatch = /^\/accounts\/(acc-[0-9]+)\/archive$/.exec(path);
    if (archiveMatch && req.method === 'POST') {
      const account = store.get(archiveMatch[1]);
      if (!account) {
        sendHtml(res, 404, renderNotFoundPage(path));
        return;
      }
      store.archive(account.id);
      redirectToList(res);
      return;
    }

    sendHtml(res, 404, renderNotFoundPage(path));
  }

  return http.createServer((req, res) => {
    handle(req, res).catch((error) => {
      if (error.code === 'encoding') {
        sendHtml(res, 415, renderCreateFormPage({ error: error.message }));
        return;
      }
      if (error.code === 'too-large') {
        sendHtml(res, 413, renderCreateFormPage({ error: error.message }));
        return;
      }
      res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('internal server error');
    });
  });
}
