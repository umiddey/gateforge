import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { startWitness } from '../src/witness/server.js';
import { makeTempProject, removeTempProject, PLAYWRIGHT_CLI, ROOT } from './helpers.js';

const TOKEN = 'consumer-context-token';
const KEY = 'consumer-context-verifier';

async function exercise(witnessed: boolean) {
  const hits: Array<{ path: string; consumer: string | undefined; routeURL: string | undefined }> = [];
  const app = createServer((req, res) => {
    hits.push({ path: req.url ?? '/', consumer: req.headers['x-consumer'] as string | undefined, routeURL: req.headers['x-consumer-url'] as string | undefined });
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<h1>App</h1>');
  });
  await new Promise<void>((resolve) => app.listen(0, '127.0.0.1', resolve));
  const address = app.address();
  if (!address || typeof address === 'string') throw new Error('missing app port');
  const url = `http://127.0.0.1:${address.port}`;
  const witness = await startWitness({ runId: '7b87f223-a378-461e-b4ed-bfd1525f82f0', token: TOKEN, verifierKey: KEY, proxyTarget: url });
  const project = makeTempProject('consumer-context');
  try {
    writeFileSync(join(project, 'playwright.config.mjs'), `export default { testDir: './specs', workers: 1, reporter: [['./reporter.cjs']], use: { headless: true } };`);
    // This reporter acts as the supervisor: only it holds the verifier key.
    writeFileSync(join(project, 'reporter.cjs'), `
const sessions = new Map();
let pending = Promise.resolve();
async function post(path, body) {
  const response = await fetch(${JSON.stringify(witness.url)} + path, { method: 'POST', headers: {
    'x-gateforge-run': ${JSON.stringify(TOKEN)}, 'x-gateforge-verifier': ${JSON.stringify(KEY)}, 'content-type': 'application/json'
  }, body: JSON.stringify(body) });
  if (!response.ok) throw new Error(await response.text());
  return response.json();
}
module.exports = class {
  onTestBegin(test, result) { pending = pending.then(() => post('/sessions/open', { testId: test.id, workerIndex: result.workerIndex })).then(s => { sessions.set(test.id, s); }); }
  onTestEnd(test, result) { if (result.status !== 'passed') console.error(result.errors); pending = pending.then(() => post('/sessions/close', { sessionId: sessions.get(test.id).sessionId, outcome: result.status })); }
  async onEnd() { await pending; }
};`);
    writeFileSync(join(project, 'specs/context.spec.ts'), `
import { test as base, expect } from '@gate-forge/pack-playwright/fixture';
const app = ${JSON.stringify(url)};
let retained;
const employeeTest = base.extend({
  context: async ({ browser }, use) => {
    const ctx = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    await ctx.route('**/*', (r, req) => r.continue({ headers: { ...req.headers(), 'x-consumer': 'employee', 'x-consumer-url': req.url() } }));
    await use(ctx);
    await ctx.close();
  },
  page: async ({ context }, use) => { const page = await context.newPage(); await use(page); },
});
employeeTest('employee context', async ({ page }) => {
  await page.goto(app + '/employee');
  await expect(page.locator('h1')).toHaveText('App');
  const [popup] = await Promise.all([page.waitForEvent('popup'), page.evaluate(url => window.open(url), app + '/employee-popup')]);
  await popup.waitForLoadState();
});
base('plain fixture', async ({ page }) => { await page.goto(app + '/plain'); });
base('explicit pages', async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(app + '/explicit');
  const popup = await Promise.all([page.waitForEvent('popup'), page.evaluate(url => window.open(url), app + '/popup')]).then(([p]) => p);
  await popup.waitForLoadState();
  const owned = await browser.newPage();
  await owned.goto(app + '/owned');
  await owned.close();
  retained = ctx;
});
base.afterAll(async ({ browser }) => {
  // A consumer-owned context and its existing page survive instrumentation.
  await retained.pages()[0].goto(app + '/retained-after');
  const later = await retained.newPage();
  await later.goto(app + '/retained-new-after');
  await retained.close();
  const page = await browser.newPage();
  await page.goto(app + '/after');
  await page.close();
});
`);
    const env: NodeJS.ProcessEnv = { ...process.env, GATEFORGE_APP_BASE_URL: url, GATEFORGE_RUN_TOKEN: TOKEN };
    delete env['GATEFORGE_WITNESS_URL'];
    delete env['GATEFORGE_PAGE_OBSERVATION_ENABLED'];
    if (witnessed) env['GATEFORGE_WITNESS_URL'] = witness.url;
    const child = spawn(process.execPath, [PLAYWRIGHT_CLI, 'test', '--config', join(project, 'playwright.config.mjs')], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', chunk => { output += String(chunk); });
    child.stderr.on('data', chunk => { output += String(chunk); });
    const code = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
    expect(code, output).toBe(0);
    const response = await fetch(witness.url + '/records', { headers: { 'x-gateforge-run': TOKEN } });
    const ledger = await response.json() as { records: Array<{ kind: string; payload: { exchanges?: Array<{ url: string }> } }> };
    return { appURL: url, hits, exchanges: ledger.records.filter(r => r.kind === 'http.exchanges').flatMap(r => r.payload.exchanges ?? []) };
  } finally {
    removeTempProject(project);
    await witness.stop();
    await new Promise<void>((resolve, reject) => app.close(error => error ? reject(error) : resolve()));
  }
}

describe('consumer-created browser contexts (real Chromium)', () => {
  it('records overridden fixtures and explicit pages once, preserves consumer routes, and detaches after each test', async () => {
    const { appURL, hits, exchanges } = await exercise(true);
    expect(hits.find(h => h.path === '/employee')?.consumer).toBe('employee');
    expect(hits.find(h => h.path === '/employee-popup')?.consumer).toBe('employee');
    for (const path of ['/employee', '/employee-popup']) {
      const hit = hits.find(h => h.path === path);
      expect(hit?.routeURL).toBeDefined();
      expect(new URL(hit?.routeURL as string).pathname).toBe(path);
      expect(new URL(hit?.routeURL as string).origin).not.toBe(appURL);
      expect(exchanges.filter(e => e.url === path)).toHaveLength(1);
    }
    for (const path of ['/plain', '/explicit', '/popup', '/owned']) {
      expect(exchanges.filter(e => e.url === path), path).toHaveLength(1);
      expect(hits.filter(h => h.path === path), path).toHaveLength(1);
    }
    for (const path of ['/retained-after', '/retained-new-after', '/after']) {
      expect(hits.filter(h => h.path === path)).toHaveLength(1);
      expect(exchanges.filter(e => e.url === path)).toHaveLength(0);
    }
  }, 60_000);

  it('does not instrument a non-witnessed run', async () => {
    const { hits, exchanges } = await exercise(false);
    expect(hits.map(h => h.path)).toEqual(['/employee', '/employee-popup', '/plain', '/explicit', '/popup', '/owned', '/retained-after', '/retained-new-after', '/after']);
    expect(exchanges).toEqual([]);
  }, 60_000);
});
