/**
 * The pytest+httpx engine e2e (plan 2026-09-25 phase 3): a REAL FastAPI
 * app, a REAL witness with a per-session observation proxy, the REAL
 * supervisor drain, and the REAL pytest runner adapter driving a REAL
 * pytest child whose `httpx` client flows through the per-test session
 * proxy — the same trust tier a Playwright session produces.
 *
 * Proven end to end:
 * - a proxied POST /api/accounts produces ONE witnessed
 *   `persistence.observed` record (`channel: 'observe'`) bound to the
 *   pytest test identity;
 * - an UNTAGGED request (a direct call to the app that bypasses the
 *   session proxy) is NOT counted: the runner itself reports green, the
 *   witness issues no record, and the finalize notes name the missing
 *   traffic — fail closed, never silent evidence.
 *
 * The interpreter comes from `GATEFORGE_PYTEST_TEST_PYTHON` (the same
 * env-carried mechanism the Alembic Postgres tests use) and must carry
 * fastapi + uvicorn + httpx + pytest; when the variable is absent the
 * suite skips — an unavailable harness is never a silent pass.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { startWitness } from '../src/witness/server.js';
import { startSupervisorSpoolDrain } from '../src/supervisor/drain.js';
import { PytestRunnerAdapter } from '../src/discovery/pytest-runner-adapter.js';
import { makeTempProject, removeTempProject, writeFixtureProject, writeObserveAdapter } from './helpers.js';

const PYTHON = process.env['GATEFORGE_PYTEST_TEST_PYTHON'] ?? '';
const TOKEN = 'run-token-pytest-httpx-e2e';
const VERIFIER_KEY = 'verifier-secret-the-pytest-child-never-sees';
const FINGERPRINT = 'example-v1';
const CREATE_CLAIM = 'tenant.accounts:persistence:create';
const TEST_FILE = 'tests/test_accounts.py';
const TEST_KEY = 'tests/test_accounts.py#test_creates_account';
const UNTAGGED_KEY = 'tests/test_accounts.py#test_calls_app_directly';

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
  throw new Error(`the FastAPI app at ${url} never became ready`);
}

/**
 * The example backend: an in-memory accounts resource with the exact
 * surface the observe adapter binds (create/list/read) and the
 * environment fingerprint the witness attests at startup.
 */
const FASTAPI_APP = `
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

app = FastAPI()
ACCOUNTS = {}
SEQ = iter(range(1, 10**9))


class AccountIn(BaseModel):
    first_name: str
    last_name: str
    status: str = "active"


@app.middleware("http")
async def stamp_fingerprint(request, call_next):
    response = await call_next(request)
    response.headers["x-gateforge-env-fingerprint"] = "${FINGERPRINT}"
    return response


@app.post("/api/accounts", status_code=201)
async def create_account(account: AccountIn):
    account_id = "acc-%d" % next(SEQ)
    record = {"id": account_id, **account.model_dump()}
    ACCOUNTS[account_id] = record
    return record


@app.get("/api/accounts")
async def list_accounts():
    return {"accounts": list(ACCOUNTS.values())}


@app.get("/api/accounts/{account_id}")
async def read_account(account_id: str):
    if account_id not in ACCOUNTS:
        raise HTTPException(status_code=404, detail="absent")
    return ACCOUNTS[account_id]
`;

/**
 * The pytest suite: one proxied create (the witnessed journey) and one
 * direct call (the untagged probe — the runner passes it, the witness
 * must never credit it).
 */
const PYTEST_SUITE = `
def test_creates_account(gateforge_http):
    response = gateforge_http.post(
        "/api/accounts", json={"first_name": "Grace", "last_name": "Hopper"}
    )
    assert response.status_code == 201, response.text
    assert response.json()["first_name"] == "Grace"


def test_calls_app_directly():
    import json
    import os
    import urllib.request

    app_url = os.environ["GATEFORGE_APP_BASE_URL"]
    request = urllib.request.Request(
        app_url + "/api/accounts",
        data=json.dumps({"first_name": "Direct", "last_name": "Untagged"}).encode(),
        headers={"content-type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(request) as response:
        assert response.status == 201
`;

/** The `.gateforge.yml` the adapter composes its runs from. */
function configYaml(): string {
  return [
    'schemaVersion: 1',
    'project:',
    '  languages: [python]',
    '  paths:',
    '    include: ["tests/**/*.py"]',
    '    exclude: []',
    'plugins: []',
    'policies: .gateforge/policies.yml',
    'classificationPolicy: .gateforge/classification-policy.yml',
    'adapters: .gateforge/adapters',
    'waivers: .gateforge/waivers',
    'baselines: .gateforge/baselines/obligations.json',
    'scan:',
    '  scanRoots: ["tests/**/*.py"]',
    '  declarations:',
    '    internality: gateforge:internal',
    '  volatileFields: []',
    'changed:',
    '  provider: auto',
    'witness:',
    '  maxDurationSeconds: 5',
    'diagnostics:',
    '  suites:',
    '    - name: accounts-httpx',
    '      runner: pytest',
    '      cwd: .',
    `      argv: ["${PYTHON}", "-m", "pytest"]`,
    '      testPaths: ["tests"]',
    '      timeoutMs: 120000',
    '      witnessed: true',
    'clock:',
    '  mode: fixed',
    '  fixedAt: "2026-08-30T12:00:00.000Z"',
    '',
  ].join('\n');
}

/** Ledger records as the witness reports them. */
async function ledgerRecords(url: string): Promise<Array<Record<string, unknown>>> {
  const response = await fetch(`${url}/records`, { headers: { 'x-gateforge-run': TOKEN } });
  return ((await response.json()) as { records: Array<Record<string, unknown>> }).records;
}

/** Polls the ledger until at least `count` records are visible. */
async function waitForRecords(url: string, count: number): Promise<Array<Record<string, unknown>>> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const records = await ledgerRecords(url);
    if (records.length >= count) return records;
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 25));
  }
  return ledgerRecords(url);
}

describe.skipIf(PYTHON === '')('pytest+httpx through the real engine (FastAPI example)', () => {
  const TEMP_DIRS: string[] = [];
  const CHILDREN: ChildProcess[] = [];

  afterAll(() => {
    for (const child of CHILDREN.splice(0)) child.kill('SIGKILL');
    for (const dir of TEMP_DIRS.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('witnesses one proxied create and refuses to credit the untagged direct call', async () => {
    const project = makeTempProject('pytest-e2e');
    TEMP_DIRS.push(project);
    writeFixtureProject(project);
    writeObserveAdapter(project, { fingerprint: FINGERPRINT });
    mkdirSync(join(project, 'tests'), { recursive: true });
    writeFileSync(join(project, '.gateforge.yml'), configYaml());
    writeFileSync(join(project, 'app.py'), FASTAPI_APP);
    writeFileSync(join(project, TEST_FILE), PYTEST_SUITE);

    const port = await freePort();
    const appUrl = `http://127.0.0.1:${String(port)}`;
    const app = spawn(PYTHON, ['-m', 'uvicorn', 'app:app', '--host', '127.0.0.1', '--port', String(port)], {
      cwd: project,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    CHILDREN.push(app);
    await waitForApp(appUrl);

    const stateDir = join(project, '.gateforge/test-gates');
    mkdirSync(stateDir, { recursive: true });
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
    // The trusted counterpart while the suite runs (same shape as the
    // supervised window): sessions open per spool event, and the passed
    // test's session is finalized against its own proxied traffic.
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
      // The CLI-written claim injections (reconciliation key → ids).
      writeFileSync(
        join(stateDir, 'claim-injections.json'),
        `${JSON.stringify({
          schemaVersion: 1,
          injections: {
            [TEST_KEY]: [CREATE_CLAIM],
            [UNTAGGED_KEY]: [CREATE_CLAIM],
          },
        })}\n`,
      );

      const adapter = new PytestRunnerAdapter({
        witness: { url: witness.url, token: TOKEN },
        appBaseUrl: appUrl,
      });

      // GREEN: the proxied journey produces the witnessed record.
      const green = await adapter.execute({
        logicalKeys: [TEST_KEY],
        stateDir,
        runId,
        timeoutMs: 120_000,
        cwd: project,
      });
      expect(green.complete).toBe(true);
      expect(green.outcomes).toHaveLength(1);
      expect(green.outcomes[0]?.status).toBe('passed');
      expect(green.outcomes[0]?.logicalKey).toBe(TEST_KEY);

      const records = await waitForRecords(witness.url, 1);
      const observed = records.find((record) => record['obligationId'] === CREATE_CLAIM);
      expect(observed, `expected one observed record, saw ${JSON.stringify(records)}`).toBeDefined();
      expect(observed?.['trust']).toBe('witnessed');
      expect(observed?.['kind']).toBe('persistence.observed');
      // The reconciliation key, NOT pytest's own node id: this is the
      // identity sidecar claims and the record→claim join use.
      expect(observed?.['testId']).toBe(TEST_KEY);
      const payload = observed?.['payload'] as Record<string, unknown>;
      expect(payload['channel']).toBe('observe');
      expect(payload['found']).toBe(true);
      expect(payload['before']).toEqual({ entityAbsent: true });
      expect(payload['observedFields']).toMatchObject({ first_name: 'Grace' });

      // RED: the direct call bypasses the session proxy. The RUNNER is
      // green — and that is exactly the point: the runner's own green
      // is never authority, and the witness credits NOTHING.
      const red = await adapter.execute({
        logicalKeys: [UNTAGGED_KEY],
        stateDir,
        runId,
        timeoutMs: 120_000,
        cwd: project,
      });
      expect(red.complete).toBe(true);
      expect(red.outcomes[0]?.status).toBe('passed');
      const afterRed = await ledgerRecords(witness.url);
      expect(
        afterRed.filter((record) => record['obligationId'] === CREATE_CLAIM && record['testId'] !== undefined && String(record['testId']).includes('test_calls_app_directly')),
      ).toEqual([]);

      const stopped = await drain.stop();
      expect(stopped.conflicts).toEqual([]);
      expect(stopped.intentFailures).toEqual([]);
      // The untagged session's finalize names the missing traffic.
      expect(stopped.observeNotes.some((note) => note.includes('test_calls_app_directly'))).toBe(true);
    } finally {
      await witness.stop();
      await drain.stop();
    }
  }, 120_000);
});
