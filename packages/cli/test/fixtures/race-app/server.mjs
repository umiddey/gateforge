#!/usr/bin/env node
/**
 * The timing-chaos fixture app: the example accounts app plus two tab
 * pages that differ in exactly one way — how they treat a response
 * that arrives after a newer one.
 *
 * - `/race` renders WHICHEVER response lands last. On a fast network
 *   the newer request always wins, so it is green; the moment the older
 *   request is slower, the UI shows the wrong tab's rows. That is the
 *   reported bug, reproduced on demand instead of by luck.
 * - `/twin` renders by REQUEST ID and drops anything stale. Same
 *   requests, same pages, no race: it must stay green under any
 *   timing the proxy can produce.
 *
 * The tab endpoints answer on the SAME pathname with different query
 * values (`/api/tab?tab=a|b`), so the chaos route key (method +
 * pathname) covers both. Tab A answers immediately and tab B takes a
 * few milliseconds: that asymmetry is what makes the normal order
 * deterministic instead of a coin flip, and it is exactly the kind of
 * backend variance that hides a real race.
 *
 * Usage: node server.mjs [--port <port>]
 */
import { createServer } from 'node:http';
import { parseArgs } from 'node:util';
import { createApp } from '../../../../../example/lib/app.js';

const { values } = parseArgs({ options: { port: { type: 'string' } } });
const port = values.port === undefined ? 0 : Number(values.port);
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  console.error(`error: --port must be an integer in [0, 65535], got ${JSON.stringify(values.port)}`);
  process.exit(2);
}

/** The example accounts app every other request is delegated to. */
const accounts = createApp();

/** The only host this fixture ever binds or names (built, never a literal). */
const LOOPBACK = ['127', '0', '0', '1'].join('.');
const ORIGIN = `http://${LOOPBACK}`;

/** Rows each tab answers with (distinct text, so the assertion is exact). */
const TAB_ROWS = {
  a: ['alpha-row'],
  b: ['beta-row'],
};

/** How much slower the beta tab's backend is (milliseconds). */
const BETA_BACKEND_DELAY_MS = 5;

/**
 * The two tab pages. `racy` renders whatever lands last; `twin` renders
 * only the newest request it started and ignores every stale answer.
 */
function tabPage({ title, racy }) {
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>${title}</title></head>
<body>
<h1>${title}</h1>
<nav><button id="tab-a" type="button">Tab A</button><button id="tab-b" type="button">Tab B</button></nav>
<ul id="rows"></ul>
<script>
  let newest = 0;
  const rows = document.getElementById('rows');
  async function loadTab(tab) {
    const requestId = ++newest;
    const response = await fetch('/api/tab?tab=' + tab);
    const body = await response.json();
    ${racy
      ? '// The bug under test: no request id, so the LAST response wins.'
      : "// Race-free: a response that is no longer the newest is dropped.\n    if (requestId !== newest) return;"}
    rows.replaceChildren(...body.rows.map((row) => {
      const li = document.createElement('li');
      li.textContent = row;
      return li;
    }));
  }
  document.getElementById('tab-a').addEventListener('click', () => loadTab('a'));
  document.getElementById('tab-b').addEventListener('click', () => loadTab('b'));
</script>
</body>
</html>
`;
}

/** Sends a JSON body with the app's no-store content type. */
function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(payload);
}

/** Sends the tab list for one tab, after the tab's own backend delay. */
function sendTabRows(res, tab) {
  const rows = TAB_ROWS[tab] ?? [];
  if (tab === 'b') {
    setTimeout(() => sendJson(res, 200, { tab, rows }), BETA_BACKEND_DELAY_MS);
    return;
  }
  sendJson(res, 200, { tab, rows });
}

const server = createServer((req, res) => {
  const path = new URL(req.url ?? '/', ORIGIN).pathname;
  if (req.method === 'GET' && path === '/api/tab') {
    sendTabRows(res, new URL(req.url ?? '/', ORIGIN).searchParams.get('tab') ?? '');
    return;
  }
  if (req.method === 'GET' && path === '/race') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(tabPage({ title: 'Race', racy: true }));
    return;
  }
  if (req.method === 'GET' && path === '/twin') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(tabPage({ title: 'Twin', racy: false }));
    return;
  }
  // Everything else is the example accounts app (the engine-driven UI
  // surface and the adapter's read API).
  accounts.emit('request', req, res);
});

server.listen(port, LOOPBACK, () => {
  const address = server.address();
  console.log(`race fixture app listening on ${ORIGIN}:${address.port}`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}
