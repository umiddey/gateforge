/**
 * Behavior-case lifecycle (plan 2026-09-19 §4.5–4.7, Phase 4): the
 * supervisor-only `/runs/behavior-catalog` binding plus the worker-facing
 * `POST /behavior/execute` (fixture lease + authoritative before
 * snapshot, redacted reference). Real loopback HTTP against a real
 * witness; file-mediated trusted observation (the adapter reads
 * namespace state files the app backend writes — never the app's own
 * GET, which a lying proxy corrupts in one probe).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { startWitness } from '../src/witness/server.js';
import { createMemoryFixtureProvider } from '../src/witness/fixture-provider.js';
import { createTestStateService } from './test-state-service.js';
import { RUN_HEADER, VERIFIER_HEADER } from '../src/constants.js';

const TOKEN = 'behavior-run-token';
const VERIFIER_KEY = 'behavior-verifier-the-suite-never-sees';
const TEST_ID = 'playwright:chromium:e2e/profile.spec.ts:owner updates account';
const OTHER_TEST_ID = 'playwright:chromium:e2e/admin.spec.ts:admin updates account';
const CASE_A = 'c'.repeat(64);
const CASE_B = 'd'.repeat(64);
const DIGEST = (seed: string): string => seed.repeat(64).slice(0, 64);

function definition(id: string) {
  return {
    id,
    contract: 'http:effect-verified',
    channel: 'engine-http',
    fixture: 'one-account',
    actor: 'owner-a',
    action: {
      kind: 'request',
      method: 'POST',
      pathTemplate: '/profile/accounts/{id}',
      path: { id: { from: 'fixture', key: 'accountA.id' } },
      query: {},
      body: {
        encoding: 'json',
        fields: { first_name: { from: 'literal', value: 'Ada' } },
      },
      credentialVariant: 'valid',
    },
    expect: {
      statuses: [200],
      response: [],
      state: [
        {
          kind: 'updated',
          scope: 'accounts',
          subject: { from: 'fixture', key: 'accountA.identity' },
          fields: { first_name: { from: 'literal', value: 'Ada' } },
        },
      ],
    },
  };
}

function compiledCase(caseId: string, slug: string) {
  return {
    caseId,
    specDigest: DIGEST('e'),
    resourceId: 'tenant.http-profile',
    endpointResourceId: 'tenant.http-profile',
    obligationIds: ['tenant.http-profile:http:effect-verified'],
    definition: definition(slug),
    effects: [
      {
        id: 'accounts',
        resourceId: 'tenant.accounts',
        adapter: 'accounts',
        scope: 'fixture-accounts',
        identityFields: ['id'],
        fields: ['first_name', 'last_name', 'status'],
        completion: 'immediate',
      },
    ],
    sourceFiles: ['backend/profile.js', 'models/accounts.py'],
  };
}

function catalog(caseIds: string[]) {
  const cases = caseIds.map((caseId, index) => compiledCase(caseId, index === 0 ? 'owner-update' : 'owner-reject'));
  return {
    schemaVersion: 1,
    catalogDigest: (caseIds.join('') + 'f'.repeat(64)).slice(0, 64),
    cases,
    requirements: { 'tenant.http-profile:http:effect-verified': [...caseIds] },
    dependencies: { 'tenant.http-profile': ['tenant.accounts'] },
  };
}

/**
 * File-mediated snapshot adapter: reads `<stateDir>/<namespace>.json`
 * (`{checkpoint, entities}`) plus an optional `_mode.json` fault switch
 * (`{completeFalse, wrongNamespace, truncate, unordered}`). The adapter
 * never touches the application's HTTP API — the independent observer.
 */
function writeSnapshotAdapter(adaptersDir: string) {
  mkdirSync(adaptersDir, { recursive: true });
  writeFileSync(
    join(adaptersDir, 'accounts.mjs'),
    [
      "import { readFileSync, existsSync } from 'node:fs';",
      "import { join, dirname } from 'node:path';",
      "import { fileURLToPath } from 'node:url';",
      'const STATE_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "behavior-state");',
      'function load(name) {',
      '  const path = join(STATE_DIR, name);',
      '  if (!existsSync(path)) return null;',
      '  return JSON.parse(readFileSync(path, "utf8"));',
      '}',
      'export default {',
      '  async read() { return null; },',
      '  normalize() { return { entityId: null, fields: {} }; },',
      "  deletion: 'hard',",
      "  environmentFingerprint: 'behavior-test-fp',",
      '  async snapshotScope(ctx, input) {',
      '    const mode = load("_mode.json") ?? {};',
      '    const stored = load(`${input.fixtureNamespace}.json`) ?? { checkpoint: `${input.fixtureNamespace}:0`, entities: [] };',
      '    let entities = stored.entities;',
      '    if (mode.truncate) entities = entities.slice(0, Math.max(0, entities.length - 1));',
      '    if (mode.unordered) entities = [...entities].reverse();',
      '    return {',
      '      scope: input.scope,',
      '      fixtureNamespace: mode.wrongNamespace ? "some-other-namespace" : input.fixtureNamespace,',
      '      complete: mode.completeFalse ? false : true,',
      '      checkpoint: stored.checkpoint,',
      '      entities,',
      '      exhausted: mode.paged ? false : true,',
      '      ...(mode.truncate ? { totalSize: stored.entities.length } : {}),',
      '    };',
      '  },',
      '};',
      '',
    ].join('\n'),
  );
}

interface Fixture {
  witness: Awaited<ReturnType<typeof startWitness>>;
  root: string;
  stateDir: string;
  runId: string;
}

async function startBehaviorWitness(caseIds: string[]): Promise<Fixture> {
  const root = mkdtempSync(join(tmpdir(), 'gateforge-behavior-'));
  const adaptersDir = join(root, '.gateforge', 'adapters');
  const stateDir = join(root, 'behavior-state');
  mkdirSync(stateDir, { recursive: true });
  writeSnapshotAdapter(adaptersDir);
  const runId = randomUUID();
  const witness = await startWitness({
    runId,
    token: TOKEN,
    verifierKey: VERIFIER_KEY,
    adaptersDir,
    fixtureProvider: createMemoryFixtureProvider(),
    now: () => '2026-09-19T00:00:00.000Z',
  });
  return { witness, root, stateDir, runId };
}

/** Witness namespace for the Nth lease of a case (memory provider recipe). */
function namespaceFor(runId: string, caseId: string, lease = 1): string {
  return `fixture-${runId}-${caseId}-${String(lease)}`.toLowerCase().replace(/[^a-z0-9-]/g, '-');
}

function writeNamespace(stateDir: string, namespace: string, checkpoint: number, entities: unknown[]): void {
  writeFileSync(
    join(stateDir, `${namespace}.json`),
    `${JSON.stringify({ checkpoint: `${namespace}:${String(checkpoint)}`, entities })}\n`,
  );
}

function writeMode(stateDir: string, mode: Record<string, unknown>): void {
  writeFileSync(join(stateDir, '_mode.json'), `${JSON.stringify(mode)}\n`);
}

async function post(
  url: string,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${url}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', [RUN_HEADER]: TOKEN, ...headers },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

const AUTH_DIGEST = 'a'.repeat(64);
const ROUTES = [{ resourceId: 'tenant.http-profile', method: 'POST', canonicalPath: '/profile/accounts/{}' }];

async function bindCatalog(url: string, caseIds: string[], assignments: Record<string, string[]>) {
  return post(
    url,
    '/runs/behavior-catalog',
    { catalog: catalog(caseIds), assignments, routes: ROUTES, authorityProfileDigest: AUTH_DIGEST },
    { [VERIFIER_HEADER]: VERIFIER_KEY },
  );
}

async function openSession(url: string, testId: string, workerIndex: number) {
  const response = await fetch(`${url}/sessions/open`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', [RUN_HEADER]: TOKEN, [VERIFIER_HEADER]: VERIFIER_KEY },
    body: JSON.stringify({ testId, workerIndex }),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

async function execute(url: string, session: Record<string, unknown>, caseId: string, extra: Record<string, unknown> = {}) {
  return post(url, '/behavior/execute', {
    sessionId: session['sessionId'],
    sessionToken: session['sessionToken'],
    caseId,
    ...extra,
  });
}

async function ledger(url: string) {
  const response = await fetch(`${url}/records`, { headers: { [RUN_HEADER]: TOKEN } });
  return (await response.json()) as { records: Array<{ kind: string }> };
}

const servers: Array<{ stop(): Promise<void> }> = [];
afterEach(async () => {
  while (servers.length > 0) {
    const entry = servers.pop();
    if (entry !== undefined) await entry.stop();
  }
});

describe('behavior catalog binding (supervisor authority)', () => {
  it('refuses worker catalog registration without the verifier key', async () => {
    const fixture = await startBehaviorWitness([CASE_A]);
    servers.push(fixture.witness);
    const attempt = await post(fixture.witness.url, '/runs/behavior-catalog', {
      catalog: catalog([CASE_A]),
      assignments: { [TEST_ID]: [CASE_A] },
    });
    expect(attempt.status).toBe(401);
    // No binding happened: execution reports the unbound catalog.
    const session = await openSession(fixture.witness.url, TEST_ID, 0);
    expect(session.status).toBe(200);
    const run = await execute(fixture.witness.url, session.body, CASE_A);
    expect(run.status).toBe(409);
    expect(String(run.body['error'])).toMatch(/no behavior catalog is bound/);
  });

  it('rejects a stale assignment naming an unknown case', async () => {
    const fixture = await startBehaviorWitness([CASE_A]);
    servers.push(fixture.witness);
    const bound = await bindCatalog(fixture.witness.url, [CASE_A], { [TEST_ID]: ['0'.repeat(64)] });
    expect(bound.status).toBe(400);
    expect(String(bound.body['error'])).toMatch(/unknown case/);
  });

  it('requires routes and an authority profile digest (no unattributable binding)', async () => {
    const fixture = await startBehaviorWitness([CASE_A]);
    servers.push(fixture.witness);
    const noRoutes = await post(
      fixture.witness.url,
      '/runs/behavior-catalog',
      { catalog: catalog([CASE_A]), assignments: { [TEST_ID]: [CASE_A] }, authorityProfileDigest: AUTH_DIGEST },
      { [VERIFIER_HEADER]: VERIFIER_KEY },
    );
    expect(noRoutes.status).toBe(400);
    const noProfile = await post(
      fixture.witness.url,
      '/runs/behavior-catalog',
      { catalog: catalog([CASE_A]), assignments: { [TEST_ID]: [CASE_A] }, routes: ROUTES },
      { [VERIFIER_HEADER]: VERIFIER_KEY },
    );
    expect(noProfile.status).toBe(400);
  });

  it('binds once; a differing catalog is a 409, never a relabel', async () => {
    const fixture = await startBehaviorWitness([CASE_A]);
    servers.push(fixture.witness);
    const first = await bindCatalog(fixture.witness.url, [CASE_A], { [TEST_ID]: [CASE_A] });
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ bound: true, caseCount: 1, assignmentCount: 1 });
    const again = await bindCatalog(fixture.witness.url, [CASE_A], { [TEST_ID]: [CASE_A] });
    expect(again.status).toBe(200);
    const other = await post(
      fixture.witness.url,
      '/runs/behavior-catalog',
      {
        catalog: catalog([CASE_B]),
        assignments: { [TEST_ID]: [CASE_B] },
        routes: ROUTES,
        authorityProfileDigest: AUTH_DIGEST,
      },
      { [VERIFIER_HEADER]: VERIFIER_KEY },
    );
    expect(other.status).toBe(409);
  });
});

describe('behavior execute (worker boundary + lifecycle)', () => {
  it('executes an assigned case: fixture lease, before snapshot, redacted reference', async () => {
    const fixture = await startBehaviorWitness([CASE_A]);
    servers.push(fixture.witness);
    const ns = namespaceFor(fixture.runId, CASE_A);
    writeNamespace(fixture.stateDir, ns, 2, [
      { entityId: 'acc-1', fields: { first_name: 'Ada', last_name: 'L', status: 'active' } },
    ]);
    expect((await bindCatalog(fixture.witness.url, [CASE_A], { [TEST_ID]: [CASE_A] })).status).toBe(200);
    const session = await openSession(fixture.witness.url, TEST_ID, 0);
    expect(session.status).toBe(200);
    const run = await execute(fixture.witness.url, session.body, CASE_A);
    expect(run.status).toBe(200);
    expect(run.body).toMatchObject({ caseId: CASE_A, namespace: ns, beforeCheckpoint: `${ns}:2`, state: 'before-snapshot-complete' });
    expect(typeof run.body['executionId']).toBe('string');
    // Redaction: no credential material, no subjects, no expectations.
    const serialized = JSON.stringify(run.body);
    expect(serialized).not.toMatch(/credref|token|subject|expect/i);
    // Phase 4 issues no satisfying observations — the ledger stays empty.
    expect((await ledger(fixture.witness.url)).records).toEqual([]);
  });

  it('isolates namespaces: equal business ids in two cases never cross-credit', async () => {
    const fixture = await startBehaviorWitness([CASE_A, CASE_B]);
    servers.push(fixture.witness);
    const nsA = namespaceFor(fixture.runId, CASE_A, 1);
    // The second lease on the same provider mints counter 2: namespaces
    // are unique per execution, never per business id.
    const nsB = namespaceFor(fixture.runId, CASE_B, 2);
    expect(nsA).not.toBe(nsB);
    writeNamespace(fixture.stateDir, nsA, 1, [
      { entityId: 'acc-1', fields: { first_name: 'Ada', last_name: 'L', status: 'active' } },
    ]);
    writeNamespace(fixture.stateDir, nsB, 1, [
      { entityId: 'acc-1', fields: { first_name: 'Mallory', last_name: 'X', status: 'active' } },
    ]);
    expect((await bindCatalog(fixture.witness.url, [CASE_A, CASE_B], { [TEST_ID]: [CASE_A, CASE_B] })).status).toBe(200);
    const session = await openSession(fixture.witness.url, TEST_ID, 0);
    const runA = await execute(fixture.witness.url, session.body, CASE_A);
    const runB = await execute(fixture.witness.url, session.body, CASE_B);
    expect(runA.status).toBe(200);
    expect(runB.status).toBe(200);
    expect(runA.body['namespace']).toBe(nsA);
    expect(runB.body['namespace']).toBe(nsB);
  });

  it('rejects actor/expectation overrides as unknown keys (400)', async () => {
    const fixture = await startBehaviorWitness([CASE_A]);
    servers.push(fixture.witness);
    expect((await bindCatalog(fixture.witness.url, [CASE_A], { [TEST_ID]: [CASE_A] })).status).toBe(200);
    const session = await openSession(fixture.witness.url, TEST_ID, 0);
    const hostile = await execute(fixture.witness.url, session.body, CASE_A, {
      actor: { principalId: 'mallory' },
      expect: { statuses: [200] },
    });
    expect(hostile.status).toBe(400);
    expect(String(hostile.body['error'])).toMatch(/exactly/);
  });

  it('rejects unknown cases (400), foreign cases (403), duplicates (409), closed sessions (409)', async () => {
    const fixture = await startBehaviorWitness([CASE_A, CASE_B]);
    servers.push(fixture.witness);
    const ns = namespaceFor(fixture.runId, CASE_A);
    writeNamespace(fixture.stateDir, ns, 0, []);
    expect((await bindCatalog(fixture.witness.url, [CASE_A, CASE_B], { [TEST_ID]: [CASE_A] })).status).toBe(200);
    const session = await openSession(fixture.witness.url, TEST_ID, 0);
    expect((await execute(fixture.witness.url, session.body, 'f'.repeat(64))).status).toBe(400);
    // CASE_B exists but belongs to no assignment for this test.
    const foreign = await execute(fixture.witness.url, session.body, CASE_B);
    expect(foreign.status).toBe(403);
    const first = await execute(fixture.witness.url, session.body, CASE_A);
    expect(first.status).toBe(200);
    expect((await execute(fixture.witness.url, session.body, CASE_A)).status).toBe(409);
    // Close the session: later executions are sealed out.
    const closed = await post(
      fixture.witness.url,
      '/sessions/close',
      { sessionId: session.body['sessionId'] },
      { [VERIFIER_HEADER]: VERIFIER_KEY },
    );
    expect(closed.status).toBe(200);
    const late = await execute(fixture.witness.url, session.body, CASE_B);
    expect(late.status).toBe(409);
  });

  it('blocks incomplete scope collection with a diagnostic fact (no satisfying record)', async () => {
    const fixture = await startBehaviorWitness([CASE_A]);
    servers.push(fixture.witness);
    const ns = namespaceFor(fixture.runId, CASE_A);
    writeNamespace(fixture.stateDir, ns, 1, [
      { entityId: 'acc-1', fields: { first_name: 'Ada', last_name: 'L', status: 'active' } },
    ]);
    writeMode(fixture.stateDir, { completeFalse: true });
    expect((await bindCatalog(fixture.witness.url, [CASE_A], { [TEST_ID]: [CASE_A] })).status).toBe(200);
    const session = await openSession(fixture.witness.url, TEST_ID, 0);
    const run = await execute(fixture.witness.url, session.body, CASE_A);
    expect(run.status).toBe(409);
    expect(String(run.body['error'])).toMatch(/OBSERVATION_SCOPE_INCOMPLETE/);
    expect((await ledger(fixture.witness.url)).records).toEqual([]);
    // The failed execution is terminal: a retry reports the same case as done.
    expect((await execute(fixture.witness.url, session.body, CASE_A)).status).toBe(409);
  });

  it('blocks wrong-namespace and paged snapshots', async () => {
    for (const mode of [{ wrongNamespace: true }, { paged: true }, { truncate: true }, { unordered: true }]) {
      const fixture = await startBehaviorWitness([CASE_A]);
      servers.push(fixture.witness);
      const ns = namespaceFor(fixture.runId, CASE_A);
      writeNamespace(fixture.stateDir, ns, 1, [
        { entityId: 'acc-1', fields: { first_name: 'Ada', last_name: 'L', status: 'active' } },
        { entityId: 'acc-2', fields: { first_name: 'Bob', last_name: 'B', status: 'active' } },
      ]);
      writeMode(fixture.stateDir, mode);
      expect((await bindCatalog(fixture.witness.url, [CASE_A], { [TEST_ID]: [CASE_A] })).status).toBe(200);
      const session = await openSession(fixture.witness.url, TEST_ID, 0);
      const run = await execute(fixture.witness.url, session.body, CASE_A);
      expect(run.status, JSON.stringify(mode)).toBe(409);
      await fixture.witness.stop();
      servers.pop();
    }
  });

  it('a lying app GET cannot fool the independent observer', async () => {
    const service = createTestStateService();
    const root = mkdtempSync(join(tmpdir(), 'gateforge-lying-'));
    const adaptersDir = join(root, '.gateforge', 'adapters');
    const stateDir = join(root, 'behavior-state');
    mkdirSync(stateDir, { recursive: true });
    writeSnapshotAdapter(adaptersDir);
    const runId = randomUUID();
    const ns = namespaceFor(runId, CASE_A);
    // Truth in the trusted service; the namespace file carries it.
    service.writer.put(ns, 'acc-1', { first_name: 'Ada', last_name: 'L', status: 'active' });
    for (const entity of service.reader.readAll(ns)) {
      void entity;
    }
    writeNamespace(
      stateDir,
      ns,
      Number(service.reader.checkpoint(ns).split(':').pop() ?? '0'),
      service.reader.readAll(ns),
    );
    // The app serves a LIE over HTTP for the same record.
    const liar: Server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ accounts: [{ id: 'acc-1', first_name: 'Mallory', last_name: 'X', status: 'active' }] }));
    });
    await new Promise<void>((resolve) => liar.listen(0, '127.0.0.1', resolve));
    const address = liar.address();
    if (address === null || typeof address === 'string') throw new Error('no liar port');
    const liarPort = address.port;
    const witness = await startWitness({
      runId,
      token: TOKEN,
      verifierKey: VERIFIER_KEY,
      adaptersDir,
      fixtureProvider: createMemoryFixtureProvider(),
      now: () => '2026-09-19T00:00:00.000Z',
    });
    servers.push(witness);
    try {
      expect((await bindCatalog(witness.url, [CASE_A], { [TEST_ID]: [CASE_A] })).status).toBe(200);
      const session = await openSession(witness.url, TEST_ID, 0);
      const run = await execute(witness.url, session.body, CASE_A);
      expect(run.status).toBe(200);
      // The checkpoint binds the trusted file, not the HTTP lie.
      expect(run.body['beforeCheckpoint']).toBe(`${ns}:1`);
      const liarBody = (await (await fetch(`http://127.0.0.1:${String(liarPort)}/api/accounts`)).json()) as {
        accounts: Array<{ first_name: string }>;
      };
      expect(liarBody.accounts[0]?.first_name).toBe('Mallory');
      const trusted = service.reader.readAll(ns);
      expect(trusted[0]?.fields['first_name']).toBe('Ada');
    } finally {
      liar.close();
    }
  });

  it('missing snapshotScope support blocks with the observer cause', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gateforge-legacy-adapter-'));
    const adaptersDir = join(root, '.gateforge', 'adapters');
    mkdirSync(adaptersDir, { recursive: true });
    writeFileSync(
      join(adaptersDir, 'accounts.mjs'),
      [
        'export default {',
        '  async read() { return null; },',
        '  normalize() { return { entityId: null, fields: {} }; },',
        "  deletion: 'hard',",
        "  environmentFingerprint: 'legacy-fp',",
        '};',
        '',
      ].join('\n'),
    );
    const runId = randomUUID();
    const witness = await startWitness({
      runId,
      token: TOKEN,
      verifierKey: VERIFIER_KEY,
      adaptersDir,
      fixtureProvider: createMemoryFixtureProvider(),
      now: () => '2026-09-19T00:00:00.000Z',
    });
    servers.push(witness);
    expect((await bindCatalog(witness.url, [CASE_A], { [TEST_ID]: [CASE_A] })).status).toBe(200);
    const session = await openSession(witness.url, TEST_ID, 0);
    const run = await execute(witness.url, session.body, CASE_A);
    expect(run.status).toBe(409);
    expect(String(run.body['error'])).toMatch(/snapshotScope is unavailable/);
  });

  it('no provider means blocked strong cases, never suite fixtures', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gateforge-no-provider-'));
    const adaptersDir = join(root, '.gateforge', 'adapters');
    const stateDir = join(root, 'behavior-state');
    mkdirSync(stateDir, { recursive: true });
    writeSnapshotAdapter(adaptersDir);
    const witness = await startWitness({
      runId: randomUUID(),
      token: TOKEN,
      verifierKey: VERIFIER_KEY,
      adaptersDir,
      now: () => '2026-09-19T00:00:00.000Z',
    });
    servers.push(witness);
    expect((await bindCatalog(witness.url, [CASE_A], { [TEST_ID]: [CASE_A] })).status).toBe(200);
    const session = await openSession(witness.url, TEST_ID, 0);
    const run = await execute(witness.url, session.body, CASE_A);
    expect(run.status).toBe(409);
    expect(String(run.body['error'])).toMatch(/no trusted fixture provider/);
  });
});

describe('test-state service capabilities', () => {
  it('the reader cannot write (no mutators by construction)', () => {
    const service = createTestStateService();
    const reader = service.reader as unknown as Record<string, unknown>;
    for (const name of ['put', 'patch', 'remove', 'clearNamespace']) {
      expect(reader[name]).toBe(undefined);
    }
    service.writer.put('ns-a', 'acc-1', { first_name: 'Ada' });
    expect(service.reader.readAll('ns-a')).toHaveLength(1);
  });

  it('equal business ids in different namespaces never cross-credit', () => {
    const service = createTestStateService();
    service.writer.put('ns-a', 'acc-1', { first_name: 'Ada' });
    service.writer.put('ns-b', 'acc-1', { first_name: 'Mallory' });
    expect(service.reader.readAll('ns-a')[0]?.fields['first_name']).toBe('Ada');
    expect(service.reader.readAll('ns-b')[0]?.fields['first_name']).toBe('Mallory');
    expect(service.reader.checkpoint('ns-a')).not.toBe(service.reader.checkpoint('ns-b'));
  });

  it('checkpoints advance only on mutation', () => {
    const service = createTestStateService();
    expect(service.reader.checkpoint('ns')).toBe('ns:0');
    service.writer.put('ns', 'acc-1', { a: 1 });
    expect(service.reader.checkpoint('ns')).toBe('ns:1');
    service.writer.patch('ns', 'acc-1', { b: 2 });
    expect(service.reader.checkpoint('ns')).toBe('ns:2');
    expect(() => service.writer.patch('ns', 'missing', {})).toThrow();
  });

  it('lease namespaces are unique per case execution', async () => {
    const provider = createMemoryFixtureProvider();
    const first = await provider.prepare({ recipe: 'r', runId: 'run', caseId: CASE_A });
    const second = await provider.prepare({ recipe: 'r', runId: 'run', caseId: CASE_A });
    expect(first.namespace).not.toBe(second.namespace);
    expect(first.actors).toEqual({});
    await provider.release(first.leaseId);
    await provider.release(first.leaseId);
  });
});
