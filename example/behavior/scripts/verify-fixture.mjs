import { existsSync, readFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const required = [
  '.gateforge.yml',
  'playwright.config.mjs',
  '.gateforge/behavior.yml',
  '.gateforge/policies.yml',
  '.gateforge/classification-policy.yml',
  '.gateforge/adapters/accounts.mjs',
  '.gateforge/baselines/obligations.json',
  'fixtures/behavior-fixtures.yml',
  'fixtures/fixture-detector.mjs',
  'e2e/behavior-proof.spec.js',
];
for (const path of required) {
  if (!existsSync(join(root, path))) throw new Error(`missing committed fixture input: ${path}`);
}
const config = readFileSync(join(root, 'playwright.config.mjs'), 'utf8');
if (!config.includes("name: 'chromium'") || !config.includes("browserName: 'chromium'")) {
  throw new Error('Playwright config must declare the named Chromium project');
}
const playwright = join(root, '..', '..', 'node_modules', '.bin', 'playwright');
const listed = spawnSync(playwright, ['test', '--config=playwright.config.mjs', '--list'], {
  cwd: root,
  encoding: 'utf8',
});
if (listed.status !== 0) {
  throw new Error(`Playwright inventory failed (${String(listed.status)}): ${listed.stderr}`);
}
if (!/chromium/i.test(`${listed.stdout}\n${listed.stderr}`)) {
  throw new Error('Playwright inventory did not report the named Chromium project');
}

const child = spawn(process.execPath, ['server.js', '--port', '4175'], {
  cwd: root,
  stdio: ['ignore', 'pipe', 'pipe'],
});
try {
  await new Promise((resolveReady, rejectReady) => {
    const timer = setTimeout(() => rejectReady(new Error('behavior server did not start')), 10_000);
    child.stdout.on('data', (chunk) => {
      if (chunk.toString().includes('listening on')) {
        clearTimeout(timer);
        resolveReady();
      }
    });
    child.once('error', rejectReady);
  });
  const multipart = new FormData();
  multipart.append('sheet', new Blob(['first_name,last_name\nKatherine,Johnson\n'], { type: 'text/csv' }), 'accounts.csv');
  const unsupported = await fetch('http://127.0.0.1:4175/imports/accounts', { method: 'POST', body: multipart });
  if (unsupported.status !== 415) throw new Error(`multipart must remain typed unsupported (got ${unsupported.status})`);
  const bulk = await fetch('http://127.0.0.1:4175/imports/accounts', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ rows: [
      { first_name: 'Katherine', last_name: 'Johnson' },
      { first_name: 'Dorothy', last_name: 'Vaughan' },
    ] }),
  });
  if (bulk.status !== 200) throw new Error(`engine-http bulk import smoke failed (got ${bulk.status})`);
  const body = await bulk.json();
  if (!body.ok || !Array.isArray(body.created) || body.created.length !== 2) {
    throw new Error('bulk import smoke did not create exactly two accounts');
  }
} finally {
  child.kill('SIGTERM');
}
console.log('behavior fixture verified: named Chromium inventory; bulk JSON import passes; multipart is typed unsupported');
