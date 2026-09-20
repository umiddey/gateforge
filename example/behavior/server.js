import { fileURLToPath } from 'node:url';
/**
 * Complete-behavior reference application (plan 2026-09-19 §4, Phase 6):
 * profile, admin, and import routes over the SAME accounts table, each
 * with a distinct handler and real UI forms, sharing the injected
 * accounts store interface from `example/lib/app.js` (no second storage
 * model — the store is imported, and small rendering helpers are local).
 *
 * Route registrations are explicit `app.get/post(path, handler)`
 * calls so the pack-http detector discovers them statically. Each
 * mutating route has a distinct handler (profile update, admin update,
 * bulk import) so per-endpoint behavior cases bind to distinct code.
 */
import express from 'express';
import { createAccountStore } from '../lib/app.js';

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function layout(title, body) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head><body>${body}</body></html>`;
}

function accountRow(account, editBase) {
  return `<li><a href="${editBase}/${encodeURIComponent(account.id)}/edit">${escapeHtml(account.first_name)} ${escapeHtml(account.last_name)}</a> (${escapeHtml(account.status)})</li>`;
}

function editForm(action, account, error = null) {
  const complaint = error === null ? '' : `<p class="error">${escapeHtml(error)}</p>`;
  return `<form method="post" action="${action}">` +
    `<label>First name <input name="first_name" value="${escapeHtml(account.first_name)}"></label>` +
    `<label>Last name <input name="last_name" value="${escapeHtml(account.last_name)}"></label>` +
    `<button type="submit">Save</button></form>${complaint}`;
}

function validateNames(fields) {
  const firstName = String(fields.first_name ?? '').trim();
  const lastName = String(fields.last_name ?? '').trim();
  if (!firstName || !lastName) return { error: 'Both first_name and last_name are required.' };
  return { firstName, lastName };
}

/**
 * Creates the behavior reference application.
 *
 * Args:
 *   options (object): optional `store` (prebuilt account store) or
 *     `backend` (injected async backing, forwarded to a fresh store).
 *
 * Returns:
 *   express.Application (unbound; the caller listens on loopback).
 */
export function createBehaviorApp({ store = null, backend = null } = {}) {
  const accounts = store ?? createAccountStore({ backend });
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use(express.json());

  async function loadAccount(req, res, next) {
    const account = await accounts.get(req.params.id);
    if (account === null || account === undefined) {
      res.status(404).send(layout('Not found', '<h1>Not found</h1>'));
      return;
    }
    req.account = account;
    next();
  }

  // --- Profile surface (customer self-service) ---------------------------
  app.get('/profile/accounts', profileListHandler);
  app.get('/profile/accounts/:id/edit', loadAccount, profileEditHandler);
  app.post('/profile/accounts/:id', loadAccount, profileUpdateHandler);

  async function profileListHandler(req, res) {
    const rows = (await accounts.list()).map((account) => accountRow(account, '/profile/accounts')).join('');
    res.send(layout('Profile accounts', `<h1>Profile accounts</h1><ul>${rows}</ul>`));
  }

  async function profileEditHandler(req, res) {
    res.send(layout('Edit profile account', `<h1>Edit profile account</h1>${editForm(`/profile/accounts/${encodeURIComponent(req.account.id)}`, req.account)}`));
  }

  async function profileUpdateHandler(req, res) {
    const names = validateNames(req.body);
    if (names.error) {
      res.status(422).send(layout('Edit profile account', `<h1>Edit profile account</h1>${editForm(`/profile/accounts/${encodeURIComponent(req.account.id)}`, { ...req.account, ...req.body }, names.error)}`));
      return;
    }
    await accounts.update(req.account.id, names);
    res.redirect(303, '/profile/accounts');
  }

  // --- Admin surface (privileged operator) -------------------------------
  app.get('/admin/accounts', adminListHandler);
  app.get('/admin/accounts/:id/edit', loadAccount, adminEditHandler);
  app.post('/admin/accounts/:id', loadAccount, adminUpdateHandler);

  async function adminListHandler(req, res) {
    const rows = (await accounts.list()).map((account) => accountRow(account, '/admin/accounts')).join('');
    res.send(layout('Admin accounts', `<h1>Admin accounts</h1><ul>${rows}</ul>`));
  }

  async function adminEditHandler(req, res) {
    res.send(layout('Edit admin account', `<h1>Edit admin account</h1>${editForm(`/admin/accounts/${encodeURIComponent(req.account.id)}`, req.account)}`));
  }

  async function adminUpdateHandler(req, res) {
    const names = validateNames(req.body);
    if (names.error) {
      res.status(422).send(layout('Edit admin account', `<h1>Edit admin account</h1>${editForm(`/admin/accounts/${encodeURIComponent(req.account.id)}`, { ...req.account, ...req.body }, names.error)}`));
      return;
    }
    await accounts.update(req.account.id, names);
    res.redirect(303, '/admin/accounts');
  }

  // --- Import surface (bulk spreadsheet-style ingest) --------------------
  app.get('/imports/accounts', importFormHandler);
  app.post('/imports/accounts', importCreateHandler);

  async function importFormHandler(req, res) {
    res.send(
      layout(
        'Import accounts',
        '<h1>Import accounts</h1>' +
          '<form method="post" action="/imports/accounts" enctype="multipart/form-data">' +
          '<label>Rows (JSON array) <textarea name="rows" rows="8" cols="60"></textarea></label>' +
          '<label>Spreadsheet file <input type="file" name="sheet"></label>' +
          '<button type="submit">Import</button></form>',
      ),
    );
  }

  async function importCreateHandler(req, res) {
    // The form posts urlencoded when no file is chosen; a file-bearing
    // multipart post without a multipart parser is a 415 (explicit
    // rejection observation — never a silent partial import).
    const contentType = String(req.headers['content-type'] ?? '');
    if (contentType.includes('multipart/')) {
      res.status(415).send(layout('Import accounts', '<h1>Import accounts</h1><p class="error">Spreadsheet file ingest needs the bulk JSON rows field.</p>'));
      return;
    }
    let rows = req.body?.rows ?? req.body;
    if (typeof rows === 'string') {
      try {
        rows = JSON.parse(rows);
      } catch {
        res.status(422).send(layout('Import accounts', '<h1>Import accounts</h1><p class="error">Rows must be a JSON array.</p>'));
        return;
      }
    }
    if (!Array.isArray(rows) || rows.length === 0) {
      res.status(422).send(layout('Import accounts', '<h1>Import accounts</h1><p class="error">Rows must be a non-empty JSON array.</p>'));
      return;
    }
    const created = [];
    for (const row of rows) {
      const names = validateNames(row ?? {});
      if (names.error) {
        res.status(422).send(layout('Import accounts', `<h1>Import accounts</h1><p class="error">Row is invalid: ${escapeHtml(names.error)}</p>`));
        return;
      }
      created.push(await accounts.create(names));
    }
    res.status(200).json({ ok: true, created: created.map((account) => account.id) });
  }

  // --- Trusted read API (adapter surface; independent observer reads here in tests) ---
  app.get('/api/accounts', apiListHandler);
  app.get('/api/accounts/:id', loadAccount, apiReadHandler);

  async function apiListHandler(req, res) {
    res.json({ accounts: await accounts.list() });
  }

  async function apiReadHandler(req, res) {
    res.json(req.account);
  }

  return app;
}

/** Runs the reference app on loopback for Playwright and smoke consumers. */
function startServer() {
  const rawPort = Number(process.argv[2] === '--port' ? process.argv[3] : process.env.PORT ?? 4175);
  const port = Number.isInteger(rawPort) && rawPort >= 0 && rawPort <= 65535 ? rawPort : 4175;
  const server = createBehaviorApp().listen(port, '127.0.0.1', () => {
    const address = server.address();
    const boundPort = typeof address === 'object' && address !== null ? address.port : port;
    console.log(`gateforge behavior example listening on http://127.0.0.1:${boundPort}`);
  });
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => server.close(() => process.exit(0)));
  }
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  startServer();
}
