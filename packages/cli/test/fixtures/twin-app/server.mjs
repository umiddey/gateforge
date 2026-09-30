#!/usr/bin/env node
/**
 * The twin path fixture app: the example accounts app plus the two
 * pages whose SHARED HELPER defaults send the raw test and its witnessed
 * twin down different request paths.
 *
 * That is the reported bug, and it was GREEN: both pages call
 * `loadItems()` with no argument, the helper's default is `tab=all`, and
 * the witnessed page overrides it with `tab=open`. Three green runs then
 * proved nothing about the path the witnessed twin covered, and nothing
 * in the run said so.
 *
 * Every list request also carries a `nonce` the page builds AT RUNTIME
 * (`Date.now()` plus a counter), so the non-allowlisted value is
 * different on every run and cannot be matched by a canned expectation:
 * a report that ever names it is leaking a value the owner never
 * allowlisted.
 */
import { createServer } from 'node:http';
import { parseArgs } from 'node:util';
import { createApp } from '../../../../../example/lib/app.js';

const { values } = parseArgs({ options: { port: { type: 'string' } } });
const port = values.port === undefined ? 0 : Number(values.port);
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  console.error(`invalid --port ${String(values.port)}`);
  process.exit(2);
}

/** The example accounts app every other request is delegated to. */
const accounts = createApp();

/** The only host this fixture ever binds or names (built, never a literal). */
const LOOPBACK = ['127', '0', '0', '1'].join('.');
const ORIGIN = `http://${LOOPBACK}`;

/** Rows each tab answers with (distinct text, so the assertion is exact). */
const TAB_ROWS = {
  all: ['open-row', 'closed-row'],
  open: ['open-row'],
};

/**
 * ONE page, served at `/items`, whose shared helper takes the tab from
 * the URL FRAGMENT: the fragment never reaches the server, so both
 * twins request the same document and the only request that can differ
 * is the list call the shared helper makes — which is exactly the
 * difference this fixture is about. The witnessed twin passes `open`;
 * the raw twin takes the helper's `all` default.
 */
function itemsPage(title) {
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>${title}</title></head>
<body>
<h1>${title}</h1>
<ul id="rows"></ul>
<script>
  // The shared helper. Its default argument is the whole bug: one
  // caller overrides it and the other does not, so the two twins send
  // different list requests and neither assertion notices.
  async function loadItems(tab = 'all') {
    const nonce = String(Date.now()) + '-' + String(Math.floor(Math.random() * 1e6));
    const response = await fetch('/api/items?tab=' + tab + '&nonce=' + nonce);
    const body = await response.json();
    const rows = document.getElementById('rows');
    rows.replaceChildren(...body.rows.map((row) => {
      const li = document.createElement('li');
      li.textContent = row;
      return li;
    }));
    window.__loaded = tab;
  }
  const requested = location.hash.replace('#', '');
  if (requested === '') loadItems(); else loadItems(requested);
</script>
</body>
</html>
`;
}

/** The `nonce` the last list request really carried (never a literal). */
let lastNonce = '';
/** Sends a JSON body with the app's no-store content type. */
function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(payload);
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', ORIGIN);
  const path = url.pathname;
  if (req.method === 'GET' && path === '/api/items') {
    lastNonce = url.searchParams.get('nonce') ?? '';
    sendJson(res, 200, { tab: url.searchParams.get('tab') ?? '', rows: TAB_ROWS[url.searchParams.get('tab')] ?? [] });
    return;
  }
  // The value the last list request really carried, so a test can ask
  // the APP which non-allowlisted value this run sent instead of
  // guessing one and asserting it is absent.
  if (req.method === 'GET' && path === '/__nonce') {
    sendJson(res, 200, { nonce: lastNonce });
    return;
  }
  if (req.method === 'GET' && path === '/items') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(itemsPage('Items'));
    return;
  }
  // Everything else is the example accounts app (the engine-driven UI
  // surface and the adapter's read API).
  accounts.emit('request', req, res);
});

server.listen(port, LOOPBACK, () => {
  const address = server.address();
  console.log(`twin fixture app listening on ${ORIGIN}:${address.port}`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}
