/**
 * The Cypress engine e2e (plan 2026-09-25 phase 2): a real HTTP app, a
 * real witness with per-session observation proxies, the real
 * supervisor drain, and the real Cypress runner adapter driving a real
 * headless Cypress run whose `cy.request` traffic flows through the
 * per-test session proxy.
 *
 * Proven end to end:
 * - `cy.request` at the app origin is REWRITTEN onto the running test's
 *   session proxy and issues ONE witnessed `persistence.observed`
 *   record bound to the Cypress test identity;
 * - a raw browser `fetch` at the same origin BYPASSES the channel —
 *   the run stays green at the runner level and the witness credits
 *   NOTHING, with the finalize note naming the missing traffic;
 * - the run is graded by supervision, never by Cypress's own "passed".
 *
 * The Cypress CLI comes from `GATEFORGE_CYPRESS_TEST_BIN` (the same
 * env-carried mechanism the conformance suite uses). When it is not
 * exported the suite SKIPS — a missing Cypress install is an
 * unavailable harness, never a silent pass.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { startWitness } from '../src/witness/server.js';
import { startSupervisorSpoolDrain } from '../src/supervisor/drain.js';
import { CypressRunnerAdapter } from '../src/discovery/cypress-runner-adapter.js';
import { writeFixtureProject, writeObserveAdapter } from './helpers.js';

/** The Cypress CLI install this run drives. */
const CYPRESS_BIN = process.env['GATEFORGE_CYPRESS_TEST_BIN'] ?? '';

const TOKEN = 'run-token-cypress-engine-e2e';
const VERIFIER_KEY = 'verifier-secret-the-cypress-child-never-sees';
const FINGERPRINT = 'example-v1';
const CREATE_CLAIM = 'tenant.accounts:persistence:create';
const GREEN_KEY = 'cypress/e2e/green.cy.js#creates account through the session proxy';
const RED_KEY = 'cypress/e2e/red.cy.js#bypasses the session proxy';

/** One OS-assigned free loopback port. */
function freePort(): Promise<number> {
  return new Promise((resolvePort, rejectPort) => {
    const server = createServer();
    server.once('error', rejectPort);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      server.close(() => (port > 0 ? resolvePort(port) : rejectPort(new Error('no free port'))));
    });
  });
}

/** Waits until the app answers GET /api/accounts. */
async function waitForApp(url: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      const response = await fetch(`${url}/api/accounts`);
      if (response.ok) return;
    } catch {
      // not listening yet
    }
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 50));
  }
  throw new Error(`the app at ${url} never became ready`);
}

/** The example backend (plain node http; the surface the observe adapter binds). */
const APP = `
const http = require('node:http');
const ACCOUNTS = new Map();
let seq = 0;
const server = http.createServer((req, res) => {
  res.setHeader('x-gateforge-env-fingerprint', '${FINGERPRINT}');
  // The untagged probe is a raw browser fetch: the browser is a
  // different origin, so the app must allow the cross-origin read.
  res.setHeader('access-control-allow-origin', '*');
  const url = new URL(req.url, 'http://127.0.0.1');
  if (req.method === 'POST' && url.pathname === '/api/accounts') {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      const fields = JSON.parse(body || '{}');
      const id = 'acc-' + String(++seq);
      const record = { id, first_name: fields.first_name ?? '', last_name: fields.last_name ?? '', status: 'active' };
      ACCOUNTS.set(id, record);
      res.writeHead(201, { 'content-type': 'application/json' });
      res.end(JSON.stringify(record));
    });
    return;
  }
  if (req.method === 'GET' && url.pathname === '/api/accounts') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ accounts: [...ACCOUNTS.values()] }));
    return;
  }
  const match = /^\\/api\\/accounts\\/([^/]+)$/.exec(url.pathname);
  if (req.method === 'GET' && match !== null) {
    const record = ACCOUNTS.get(decodeURIComponent(match[1]));
    if (record === undefined) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'absent' }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(record));
    return;
  }
  res.writeHead(404);
  res.end();
});
server.listen(Number(process.env.APP_PORT), '127.0.0.1');
`;

/** The GREEN spec: `cy.request` at the app origin (the tagged channel). */
const GREEN_SPEC = `
it('creates account through the session proxy', () => {
  cy.request({
    method: 'POST',
    url: Cypress.env('appBaseUrl') + '/api/accounts',
    body: { first_name: 'Grace', last_name: 'Hopper' },
  }).then((response) => {
    expect(response.status).to.eq(201);
    expect(response.body.first_name).to.eq('Grace');
  });
});
`;

/**
 * The RED spec: a raw browser `fetch` at the same origin. It never
 * crosses the session proxy, so nothing about it can be witnessed —
 * the runner is green and the evidence is simply absent.
 */
const RED_SPEC = `
it('bypasses the session proxy', () => {
  const app = Cypress.env('appBaseUrl');
  cy.window().then((win) =>
    win
      .fetch(app + '/api/accounts', {
        method: 'POST',
        headers: { 'content-type': 'text/plain;charset=UTF-8' },
        body: JSON.stringify({ first_name: 'Direct', last_name: 'Untagged' }),
      })
      .then((response) => {
        expect(response.status).to.eq(201);
      }),
  );
});
`;

describe.skipIf(CYPRESS_BIN === '')('cypress through the real engine', () => {
  const CHILDREN: ChildProcess[] = [];
  const TEMP_DIRS: string[] = [];

  afterAll(() => {
    for (const child of CHILDREN.splice(0)) child.kill('SIGKILL');
    for (const dir of TEMP_DIRS.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('witnesses the proxied create and credits nothing for the untagged fetch', async () => {
    const project = mkdtempSync(join(tmpdir(), 'gateforge-cypress-e2e-'));
    TEMP_DIRS.push(project);
    for (const dir of ['.gateforge/adapters', '.gateforge/waivers', '.gateforge/baselines', '.gateforge/test-gates', 'src', 'cypress/e2e']) {
      mkdirSync(join(project, dir), { recursive: true });
    }
    writeFixtureProject(project);
    writeObserveAdapter(project, { fingerprint: FINGERPRINT });
    mkdirSync(join(project, 'node_modules', '.bin'), { recursive: true });
    if (!existsSync(join(project, 'node_modules', '.bin', 'cypress'))) {
      symlinkSync(CYPRESS_BIN, join(project, 'node_modules', '.bin', 'cypress'));
    }
    writeFileSync(join(project, 'package.json'), '{ "name": "gateforge-cypress-e2e", "private": true }\n');
    writeFileSync(
      join(project, 'cypress.config.cjs'),
      [
        'module.exports = {',
        '  e2e: {',
        "    specPattern: 'cypress/e2e/**/*.cy.js',",
        '    video: false,',
        '    screenshotOnRunFailure: false,',
        '    retries: 0,',
        '    env: { appBaseUrl: process.env.GATEFORGE_APP_BASE_URL },',
        '  },',
        '};',
        '',
      ].join('\n'),
    );
    writeFileSync(join(project, 'cypress/e2e/green.cy.js'), GREEN_SPEC);
    writeFileSync(join(project, 'cypress/e2e/red.cy.js'), RED_SPEC);

    const port = await freePort();
    writeFileSync(join(project, 'app.cjs'), APP);
    const app = spawn(process.execPath, [join(project, 'app.cjs')], {
      env: { ...process.env, APP_PORT: String(port) },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    CHILDREN.push(app);
    const appUrl = `http://127.0.0.1:${String(port)}`;
    await waitForApp(appUrl);

    const stateDir = join(project, '.gateforge/test-gates');
    const runId = randomUUID();
    const witness = await startWitness({
      runId,
      token: TOKEN,
      verifierKey: VERIFIER_KEY,
      adaptersDir: join(project, '.gateforge/adapters'),
      classificationsPath: join(project, '.gateforge/effective-classifications.yml'),
      targetBaseUrl: appUrl,
      targetFingerprint: FINGERPRINT,
      adapterBaseUrl: appUrl,
      proxyTarget: appUrl,
      now: () => '2026-08-30T12:00:01.000Z',
    });
    const drain = startSupervisorSpoolDrain({
      stateDir,
      runId,
      witnessUrl: witness.url,
      runToken: TOKEN,
      verifierKey: VERIFIER_KEY,
      pollMs: 10,
      observeObligations: [CREATE_CLAIM],
    });
    try {
      writeFileSync(
        join(stateDir, 'claim-injections.json'),
        `${JSON.stringify({
          schemaVersion: 1,
          injections: { [GREEN_KEY]: [CREATE_CLAIM], [RED_KEY]: [CREATE_CLAIM] },
        })}\n`,
      );
      const adapter = new CypressRunnerAdapter({
        witness: { url: witness.url, token: TOKEN, appBaseUrl: appUrl },
      });

      // GREEN: the cy.request call, rewritten onto the session proxy.
      const green = await adapter.execute({
        logicalKeys: [GREEN_KEY],
        stateDir,
        runId,
        timeoutMs: 120_000,
        cwd: project,
      });
      expect(green.complete).toBe(true);
      expect(green.outcomes.find((outcome) => outcome.logicalKey === GREEN_KEY)?.status).toBe('passed');

      const records = await fetch(`${witness.url}/records`, { headers: { 'x-gateforge-run': TOKEN } }).then(
        (response) =>
          (response.json() as Promise<{ records: Array<Record<string, unknown>> }>).then((body) => body.records),
      );
      const observed = records.find((record) => record['obligationId'] === CREATE_CLAIM);
      expect(observed, `expected the observed record, saw ${JSON.stringify(records)}`).toBeDefined();
      expect(observed?.['trust']).toBe('witnessed');
      expect(observed?.['testId']).toBe(GREEN_KEY);
      expect((observed?.['payload'] as Record<string, unknown>)['channel']).toBe('observe');

      // RED: the raw browser fetch bypasses the proxy — the RUNNER is
      // green, the witness credits nothing.
      const red = await adapter.execute({
        logicalKeys: [RED_KEY],
        stateDir,
        runId,
        timeoutMs: 120_000,
        cwd: project,
      });
      expect(red.complete).toBe(true);
      expect(red.outcomes.find((outcome) => outcome.logicalKey === RED_KEY)?.status).toBe('passed');
      const afterRed = await fetch(`${witness.url}/records`, { headers: { 'x-gateforge-run': TOKEN } }).then(
        (response) =>
          (response.json() as Promise<{ records: Array<Record<string, unknown>> }>).then((body) => body.records),
      );
      expect(afterRed.filter((record) => String(record['testId'] ?? '').includes('bypasses'))).toEqual([]);

      const stopped = await drain.stop();
      expect(stopped.conflicts).toEqual([]);
      expect(stopped.observeNotes.some((note) => note.includes('bypasses the session proxy'))).toBe(true);
      // The sealed report is the LAST run's (one report per run id):
      // it names the spec file and the title path mocha actually ran.
      const sealed = readFileSync(join(stateDir, 'cypress', runId, 'report.json'), 'utf8');
      expect(sealed).toContain('cypress/e2e/red.cy.js');
      expect(sealed).toContain('bypasses the session proxy');
    } finally {
      await witness.stop();
      await drain.stop();
    }
  }, 120_000);
});
