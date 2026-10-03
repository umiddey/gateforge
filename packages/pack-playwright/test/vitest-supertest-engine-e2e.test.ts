/**
 * The Vitest+supertest engine e2e (plan 2026-09-25 phase 4): a real
 * HTTP app, a real witness with per-session observation proxies, the
 * real supervisor drain, and the real Vitest runner adapter driving a
 * real vitest child whose supertest traffic flows through the per-test
 * session proxy.
 *
 * Proven end to end:
 * - `request(baseUrl)` THROUGH the gateforge wrapper issues ONE
 *   witnessed `persistence.observed` record bound to the vitest test
 *   identity;
 * - a raw `request(baseUrl)` that BYPASSES the wrapper stays green at
 *   the runner level and is credited with NOTHING (finalize notes name
 *   the missing traffic);
 * - the IN-PROCESS mode (`request(app)` handed the app itself) is
 *   REFUSED with the typed `IN_PROCESS_CLIENT_REFUSED` message — never
 *   silently passed.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { startWitness } from '../src/witness/server.js';
import { startSupervisorSpoolDrain } from '../src/supervisor/drain.js';
import { VitestRunnerAdapter } from '../src/discovery/vitest-runner-adapter.js';
import { makeTempProject, removeTempProject, writeFixtureProject, writeObserveAdapter } from './helpers.js';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const TOKEN = 'run-token-vitest-supertest-e2e';
const VERIFIER_KEY = 'verifier-secret-the-vitest-child-never-sees';
const FINGERPRINT = 'example-v1';
const CREATE_CLAIM = 'tenant.accounts:persistence:create';
const GREEN_KEY = 'tests/green.test.mjs#creates account through the session proxy';
const RED_KEY = 'tests/red.test.mjs#bypasses the session proxy';
const REFUSAL_FILE = 'tests/inprocess.test.mjs';

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

/** Symlinks `target` at `link` unless the link already exists. */
function linkIfAbsent(target: string, link: string): void {
  if (!existsSync(link)) symlinkSync(target, link, 'dir');
}

/** The example backend (plain node http; the surface the observe adapter binds). */
const APP = `
const http = require('node:http');
const ACCOUNTS = new Map();
let seq = 0;
const server = http.createServer((req, res) => {
  res.setHeader('x-gateforge-env-fingerprint', '${FINGERPRINT}');
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

/**
 * The GREEN probe suite: the wrapped supertest call through the
 * session proxy. It lives in its OWN file because the adapter's
 * selection granularity is the file — the bypass probe in the same
 * file would create an account inside the green session's before/after
 * window and make the create ambiguous (the witness refuses ambiguous
 * creations rather than crediting them).
 */
const GREEN_SUITE = `
import { test, expect } from 'vitest';
import request from 'supertest';
import { gateforgeSupertest } from '@gate-forge/pack-playwright/vitest';

const gate = gateforgeSupertest(request);

test('creates account through the session proxy', async () => {
  const app = process.env.GATEFORGE_APP_BASE_URL;
  const response = await (await gate(app)).post('/api/accounts').send({ first_name: 'Grace', last_name: 'Hopper' });
  expect(response.status).toBe(201);
  expect(response.body.first_name).toBe('Grace');
});
`;

/** The RED probe suite: a raw supertest call that bypasses the proxy. */
const RED_SUITE = `
import { test, expect } from 'vitest';
import request from 'supertest';

test('bypasses the session proxy', async () => {
  const app = process.env.GATEFORGE_APP_BASE_URL;
  const response = await request(app).post('/api/accounts').send({ first_name: 'Direct', last_name: 'Untagged' });
  expect(response.status).toBe(201);
});
`;

/** The refusal suite: supertest handed the app itself. */
const REFUSAL_SUITE = `
import { test } from 'vitest';
import request from 'supertest';
import { gateforgeSupertest } from '@gate-forge/pack-playwright/vitest';

const gate = gateforgeSupertest(request);

test('in-process mode is refused', async () => {
  const app = (req, res) => res.end('in-process');
  await gate(app);
});
`;

describe('vitest+supertest through the real engine', () => {
  const CHILDREN: ChildProcess[] = [];
  const TEMP_DIRS: string[] = [];

  afterAll(() => {
    for (const child of CHILDREN.splice(0)) child.kill('SIGKILL');
    for (const dir of TEMP_DIRS.splice(0)) removeTempProject(dir);
  });

  it('witnesses the proxied create, credits nothing for the bypass, and refuses in-process mode', async () => {
    const project = makeTempProject('vitest-e2e');
    TEMP_DIRS.push(project);
    writeFixtureProject(project);
    writeObserveAdapter(project, { fingerprint: FINGERPRINT });
    mkdirSync(join(project, 'tests'), { recursive: true });
    mkdirSync(join(project, 'node_modules', '@gate-forge'), { recursive: true });
    for (const name of ['vitest', 'supertest']) {
      linkIfAbsent(join(ROOT, 'node_modules', name), join(project, 'node_modules', name));
    }
    linkIfAbsent(
      join(ROOT, 'packages', 'pack-playwright'),
      join(project, 'node_modules', '@gate-forge', 'pack-playwright'),
    );
    writeFileSync(
      join(project, 'vitest.config.mjs'),
      [
        "import { defineConfig } from 'vitest/config';",
        'export default defineConfig({',
        '  test: {',
        "    include: ['tests/**/*.test.mjs'],",
        '    retry: 0,',
        '  },',
        '});',
        '',
      ].join('\n'),
    );
    writeFileSync(join(project, 'tests/green.test.mjs'), GREEN_SUITE);
    writeFileSync(join(project, 'tests/red.test.mjs'), RED_SUITE);
    writeFileSync(join(project, REFUSAL_FILE), REFUSAL_SUITE);

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
      const adapter = new VitestRunnerAdapter({
        witness: { url: witness.url, token: TOKEN, appBaseUrl: appUrl },
      });

      // GREEN: the wrapped supertest call through the session proxy.
      // The adapter's selection granularity is the FILE (as with the
      // supervised Playwright run), so this run executes
      // tests/green.test.mjs alone.
      const green = await adapter.execute({
        logicalKeys: [GREEN_KEY],
        stateDir,
        runId,
        timeoutMs: 120_000,
        cwd: project,
      });
      expect(green.complete).toBe(true);
      expect(green.outcomes.length).toBeGreaterThanOrEqual(1);
      expect(green.outcomes.find((outcome) => outcome.logicalKey === GREEN_KEY)?.status).toBe('passed');

      const records = await fetch(`${witness.url}/records`, { headers: { 'x-gateforge-run': TOKEN } }).then(
        (response) => (response.json() as Promise<{ records: Array<Record<string, unknown>> }>).then((body) => body.records),
      );
      const observed = records.find((record) => record['obligationId'] === CREATE_CLAIM);
      expect(observed, `expected the observed record, saw ${JSON.stringify(records)}`).toBeDefined();
      expect(observed?.['trust']).toBe('witnessed');
      expect(observed?.['testId']).toBe(GREEN_KEY);
      expect((observed?.['payload'] as Record<string, unknown>)['channel']).toBe('observe');

      // RED: the raw supertest call bypasses the proxy — the RUNNER is
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
        (response) => (response.json() as Promise<{ records: Array<Record<string, unknown>> }>).then((body) => body.records),
      );
      expect(afterRed.filter((record) => String(record['testId'] ?? '').includes('bypasses'))).toEqual([]);

      const stopped = await drain.stop();
      expect(stopped.conflicts).toEqual([]);
      expect(stopped.observeNotes.some((note) => note.includes('bypasses the session proxy'))).toBe(true);

      // REFUSAL: in-process mode fails the run with the typed message.
      const refusalRunId = randomUUID();
      const refusal = await adapter.execute({
        logicalKeys: ['tests/inprocess.test.mjs#in-process mode is refused'],
        stateDir,
        runId: refusalRunId,
        timeoutMs: 120_000,
        cwd: project,
      });
      expect(refusal.outcomes[0]?.status).toBe('failed');
      const refusalReport = JSON.parse(
        readFileSync(join(stateDir, 'vitest', refusalRunId, 'report.json'), 'utf8'),
      ) as unknown;
      expect(JSON.stringify(refusalReport)).toContain('IN_PROCESS_CLIENT_REFUSED');
      expect(JSON.stringify(refusalReport)).toContain('bypasses the gateforge');
    } finally {
      await witness.stop();
      await drain.stop();
    }
  }, 180_000);
});
