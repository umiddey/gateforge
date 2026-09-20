/**
 * Principal driver + `behavior.case` issuance (plan 2026-09-19 §4.6,
 * Phase 5): the witness-owned engine-http driver executes the approved
 * request against the real example app, attributes it against the bound
 * inventory, resolves barriers, observes after-state, and seals the
 * record — which the core grader then evaluates end to end
 * (witness → ledger → verdict).
 */
import { describe, expect, it } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { startWitness } from '../src/witness/server.js';
import { SURFACE_DESCRIPTOR_VERSION } from '../src/surface.js';
import { createMemoryFixtureProvider } from '../src/witness/fixture-provider.js';
import { createTestStateService, type TestStateService } from './test-state-service.js';
// The example app is an untyped checked-in fixture (not a workspace package).
// @ts-expect-error: no declaration file for the example fixture
import { createApp } from '../../../example/lib/app.js';
import {
  evaluateObligation,
  type BehaviorCatalog,
} from '@gate-forge/core';
import { RUN_HEADER, VERIFIER_HEADER } from '../src/constants.js';

const TOKEN = 'principal-run-token';
const VERIFIER_KEY = 'principal-verifier-the-suite-never-sees';
const TEST_ID = 'playwright:chromium:e2e/profile.spec.ts:owner updates account';
const OTHER_TEST_ID = 'playwright:chromium:e2e/admin.spec.ts:admin updates account';
const CASE_ID = 'c'.repeat(64);
const AUTH_DIGEST = 'a'.repeat(64);
const ENDPOINT = 'tenant.http-profile';
const OBLIGATION_ID = `${ENDPOINT}:http:effect-verified`;

const LIFECYCLE = {
  create: true,
  read: true,
  update: true,
  delete: true,
  deleteSemantics: 'hard' as const,
};

function updateDefinition(overrides: Record<string, unknown> = {}) {
  return {
    id: 'owner-update',
    contract: 'http:effect-verified',
    channel: 'engine-http',
    fixture: 'one-account',
    actor: 'owner-a',
    action: {
      kind: 'request',
      method: 'POST',
      pathTemplate: '/accounts/{id}',
      path: { id: { from: 'fixture', key: 'accountA.id' } },
      query: {},
      body: {
        encoding: 'form',
        fields: {
          first_name: { from: 'literal', value: 'Ada' },
          last_name: { from: 'literal', value: 'Lovelace' },
        },
      },
      credentialVariant: 'valid',
    },
    expect: {
      statuses: [303],
      response: [],
      state: [
        {
          kind: 'updated',
          scope: 'accounts',
          subject: { from: 'fixture', key: 'accountA.identity' },
          fields: {
            first_name: { from: 'literal', value: 'Ada' },
            last_name: { from: 'literal', value: 'Lovelace' },
          },
        },
      ],
    },
    ...overrides,
  };
}

function compiledCase(definition: Record<string, unknown>, completion: 'immediate' | 'barrier' = 'immediate') {
  return {
    caseId: CASE_ID,
    specDigest: 'e'.repeat(64),
    resourceId: ENDPOINT,
    endpointResourceId: ENDPOINT,
    obligationIds: [OBLIGATION_ID],
    definition,
    effects: [
      {
        id: 'accounts',
        resourceId: 'tenant.accounts',
        adapter: 'accounts',
        scope: 'fixture-accounts',
        identityFields: ['id'],
        fields: ['first_name', 'last_name', 'status'],
        completion,
      },
    ],
    sourceFiles: ['backend/profile.js'],
  };
}

function catalogFor(definition: Record<string, unknown>, completion: 'immediate' | 'barrier' = 'immediate'): BehaviorCatalog {
  return {
    schemaVersion: 1,
    catalogDigest: 'f'.repeat(64),
    cases: [compiledCase(definition, completion) as never],
    requirements: { [OBLIGATION_ID]: [CASE_ID] },
    dependencies: { [ENDPOINT]: ['tenant.accounts'] },
  } as BehaviorCatalog;
}

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
      "  environmentFingerprint: 'principal-test-fp',",
      '  async snapshotScope(ctx, input) {',
      '    const stored = load(`${input.fixtureNamespace}.json`) ?? { checkpoint: `${input.fixtureNamespace}:0`, entities: [] };',
      '    return {',
      '      scope: input.scope,',
      '      fixtureNamespace: input.fixtureNamespace,',
      '      complete: true,',
      '      checkpoint: stored.checkpoint,',
      '      entities: stored.entities,',
      '      exhausted: true,',
      '    };',
      '  },',
      '  async awaitBarrier(ctx, input) {',
      '    const verdict = load("_barrier.json") ?? { complete: true };',
      '    const stored = load(`${input.fixtureNamespace}.json`) ?? { checkpoint: `${input.fixtureNamespace}:0` };',
      '    return { complete: verdict.complete === true, checkpoint: stored.checkpoint };',
      '  },',
      '};',
      '',
    ].join('\n'),
  );
}

/** Namespace the memory provider mints for the Nth lease of a case. */
function namespaceFor(runId: string, caseId: string, lease = 1): string {
  return `fixture-${runId}-${caseId}-${String(lease)}`.toLowerCase().replace(/[^a-z0-9-]/g, '-');
}

interface Harness {
  service: TestStateService;
  root: string;
  stateDir: string;
  runId: string;
  servers: Server[];
  syncFile(namespace: string): void;
  close(): Promise<void>;
}

async function startHarness(): Promise<Harness> {
  const root = mkdtempSync(join(tmpdir(), 'gateforge-principal-'));
  const adaptersDir = join(root, '.gateforge', 'adapters');
  const stateDir = join(root, 'behavior-state');
  mkdirSync(stateDir, { recursive: true });
  writeSnapshotAdapter(adaptersDir);
  const runId = randomUUID();
  const service = createTestStateService();
  const servers: Server[] = [];
  const syncFile = (namespace: string): void => {
    writeFileSync(
      join(stateDir, `${namespace}.json`),
      `${JSON.stringify({ checkpoint: service.reader.checkpoint(namespace), entities: service.reader.readAll(namespace) })}\n`,
    );
  };
  // Seed the authoritative before-state through the trusted service.
  const ns = namespaceFor(runId, CASE_ID);
  service.writer.put(ns, 'acc-1', { first_name: 'Grace', last_name: 'Hopper', status: 'active' });
  syncFile(ns);
  return {
    service,
    root,
    stateDir,
    runId,
    servers,
    syncFile,
    close: async () => {
      for (const server of servers) {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    },
  };
}

function witnessOptions(harness: Harness, targetBaseUrl?: string) {
  return {
    runId: harness.runId,
    token: TOKEN,
    verifierKey: VERIFIER_KEY,
    adaptersDir: join(harness.root, '.gateforge', 'adapters'),
    ...(targetBaseUrl === undefined ? {} : { targetBaseUrl }),
    fixtureProvider: createMemoryFixtureProvider({
      actors: { 'owner-a': { principalId: 'owner-a', tenantId: 't1', roles: ['owner'] } },
      credentials: { 'owner-a': {} },
      subjects: { 'one-account': { accountA: { id: 'acc-1', identity: 'acc-1' } } },
    }),
    now: () => '2026-09-19T00:00:00.000Z',
  };
}

/** Backend delegating to the trusted service (writer capability for the app). */
function serviceBackend(service: TestStateService, harness: Harness, namespace: string) {
  return {
    load: async () =>
      service.reader.readAll(namespace).map((entity) => ({ id: entity.entityId, ...entity.fields })),
    save: async (rows: Array<Record<string, unknown>>) => {
      service.writer.clearNamespace(namespace);
      for (const row of rows) {
        const { id, ...fields } = row;
        service.writer.put(namespace, id, fields as Record<string, unknown>);
      }
      harness.syncFile(namespace);
    },
  };
}

async function startApp(harness: Harness, namespace: string) {
  const server = createApp({ backend: serviceBackend(harness.service, harness, namespace) });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no app port');
  harness.servers.push(server);
  return `http://127.0.0.1:${String(address.port)}`;
}

const ROUTES = [{ resourceId: ENDPOINT, method: 'POST', canonicalPath: '/accounts/{}' }];

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

async function bindCatalog(url: string, catalog: BehaviorCatalog, assignments: Record<string, string[]>, routes: unknown = ROUTES) {
  return post(
    url,
    '/runs/behavior-catalog',
    { catalog, assignments, routes, authorityProfileDigest: AUTH_DIGEST },
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

async function records(url: string) {
  const response = await fetch(`${url}/records`, { headers: { [RUN_HEADER]: TOKEN } });
  return (await response.json()) as { records: Array<Record<string, unknown>> };
}

describe('principal driver end to end (witness to ledger to verdict)', () => {
  it('seals a record the core grader satisfies', async () => {
    const harness = await startHarness();
    try {
      const ns = namespaceFor(harness.runId, CASE_ID);
      // Recreate the witness with the app origin once the app is up.
        const appUrl = await startApp(harness, ns);
      const witness = await startWitness(witnessOptions(harness, appUrl));
      const catalog = catalogFor(updateDefinition());
      expect((await bindCatalog(witness.url, catalog, { [TEST_ID]: [CASE_ID] })).status).toBe(200);
      const session = await openSession(witness.url, TEST_ID, 0);
      expect(session.status).toBe(200);
      const executed = await post(witness.url, '/behavior/execute', {
        sessionId: session.body['sessionId'],
        sessionToken: session.body['sessionToken'],
        caseId: CASE_ID,
      });
      expect(executed.status).toBe(200);
      const executionId = executed.body['executionId'] as string;
      const sealed = await post(witness.url, '/behavior/principal', {
        sessionId: session.body['sessionId'],
        sessionToken: session.body['sessionToken'],
        executionId,
      });
      expect(sealed.status).toBe(200);
      expect(sealed.body).toMatchObject({ caseId: CASE_ID, executionId, state: 'sealed' });
      expect((sealed.body['recordIds'] as string[])).toHaveLength(1);
      // The ledger carries the engine-issued case record …
      const ledger = await records(witness.url);
      const issued = ledger.records.find((record) => record['kind'] === 'behavior.case');
      expect(issued).toBeDefined();
      expect(issued?.['origin']).toBe('engine-observed');
      // … which the core grader satisfies end to end.
      const obligation = {
        schemaVersion: 1,
        id: OBLIGATION_ID,
        resourceId: ENDPOINT,
        contract: 'http:effect-verified',
        policyId: 'behavior-policy',
        lifecycle: LIFECYCLE,
      };
      const outcome = evaluateObligation(obligation as never, {
        claims: [{ schemaVersion: 1, obligationId: OBLIGATION_ID, testId: TEST_ID }],
        records: ledger.records,
        waivers: [],
        classification: {
          exposure: 'user-facing',
          plane: 'tenant',
          lifecycle: LIFECYCLE,
          primaryKey: ['id'],
          evidenceLane: 'claims',
        },
        httpRoutes: ROUTES as never,
        behavior: { catalog, requirements: catalog.requirements, authorityProfileDigest: AUTH_DIGEST },
        now: '2026-09-19T00:00:00.000Z',
      });
      expect(outcome.verdict).toBe('satisfied');
      expect(outcome.reason).toBe(null);
      await witness.stop();
    } finally {
      await harness.close();
    }
  });

  it('a 200 with no saved change seals but grades invalid', async () => {
    const harness = await startHarness();
    try {
      const ns = namespaceFor(harness.runId, CASE_ID);
      // Stub app: always 200, never writes.
      const stub: Server = createServer((_req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      });
      await new Promise<void>((resolve) => stub.listen(0, '127.0.0.1', resolve));
      harness.servers.push(stub);
      const address = stub.address();
      if (address === null || typeof address === 'string') throw new Error('no stub port');
      const witness = await startWitness(witnessOptions(harness, `http://127.0.0.1:${String(address.port)}`));
      const catalog = catalogFor(updateDefinition());
        expect((await bindCatalog(witness.url, catalog, { [TEST_ID]: [CASE_ID] })).status).toBe(200);
      const session = await openSession(witness.url, TEST_ID, 0);
      const executed = await post(witness.url, '/behavior/execute', {
        sessionId: session.body['sessionId'],
        sessionToken: session.body['sessionToken'],
        caseId: CASE_ID,
      });
      expect(executed.status).toBe(200);
      const sealed = await post(witness.url, '/behavior/principal', {
        sessionId: session.body['sessionId'],
        sessionToken: session.body['sessionToken'],
        executionId: executed.body['executionId'],
      });
      // The witness seals what it observed (a 200 with no state change);
      // the GRADER rejects the zero delta.
      expect(sealed.status).toBe(200);
      const ledger = await records(witness.url);
      const issued = ledger.records.find((record) => record['kind'] === 'behavior.case');
      expect(issued).toBeDefined();
      const obligation = {
        schemaVersion: 1,
        id: OBLIGATION_ID,
        resourceId: ENDPOINT,
        contract: 'http:effect-verified',
        policyId: 'behavior-policy',
        lifecycle: LIFECYCLE,
      };
      const outcome = evaluateObligation(obligation as never, {
        claims: [{ schemaVersion: 1, obligationId: OBLIGATION_ID, testId: TEST_ID }],
        records: ledger.records,
        waivers: [],
        classification: { exposure: 'user-facing', plane: 'tenant', lifecycle: LIFECYCLE, primaryKey: ['id'], evidenceLane: 'claims' },
        httpRoutes: ROUTES as never,
        behavior: { catalog, requirements: catalog.requirements, authorityProfileDigest: AUTH_DIGEST },
        now: '2026-09-19T00:00:00.000Z',
      });
      expect(outcome.verdict).toBe('invalid');
      await witness.stop();
    } finally {
      await harness.close();
    }
  });

  it('a correct row plus a secondary ledger write seals but grades unexpected-effect', async () => {
    const harness = await startHarness();
    try {
      const ns = namespaceFor(harness.runId, CASE_ID);
      // Hostile app: applies the update AND smuggles a second row.
      const hostile: Server = createServer((req, res) => {
        let raw = '';
        req.on('data', (chunk) => {
          raw += String(chunk);
        });
        req.on('end', () => {
          const body = Object.fromEntries(new URLSearchParams(raw).entries());
          harness.service.writer.patch(ns, 'acc-1', {
            first_name: body['first_name'],
            last_name: body['last_name'],
          });
          harness.service.writer.put(ns, 'acc-9', { first_name: 'Mallory', last_name: 'X', status: 'active' });
          harness.syncFile(ns);
          res.writeHead(303, { location: '/' });
          res.end(JSON.stringify({ ok: true }));
        });
      });
      await new Promise<void>((resolve) => hostile.listen(0, '127.0.0.1', resolve));
      harness.servers.push(hostile);
      const address = hostile.address();
      if (address === null || typeof address === 'string') throw new Error('no hostile port');
      const witness = await startWitness(witnessOptions(harness, `http://127.0.0.1:${String(address.port)}`));
      const catalog = catalogFor(updateDefinition());
        expect((await bindCatalog(witness.url, catalog, { [TEST_ID]: [CASE_ID] })).status).toBe(200);
      const session = await openSession(witness.url, TEST_ID, 0);
      const executed = await post(witness.url, '/behavior/execute', {
        sessionId: session.body['sessionId'],
        sessionToken: session.body['sessionToken'],
        caseId: CASE_ID,
      });
      expect(executed.status).toBe(200);
      const sealed = await post(witness.url, '/behavior/principal', {
        sessionId: session.body['sessionId'],
        sessionToken: session.body['sessionToken'],
        executionId: executed.body['executionId'],
      });
      expect(sealed.status).toBe(200);
      const ledger = await records(witness.url);
      const issued = ledger.records.find((record) => record['kind'] === 'behavior.case');
      const obligation = {
        schemaVersion: 1,
        id: OBLIGATION_ID,
        resourceId: ENDPOINT,
        contract: 'http:effect-verified',
        policyId: 'behavior-policy',
        lifecycle: LIFECYCLE,
      };
      const outcome = evaluateObligation(obligation as never, {
        claims: [{ schemaVersion: 1, obligationId: OBLIGATION_ID, testId: TEST_ID }],
        records: ledger.records,
        waivers: [],
        classification: { exposure: 'user-facing', plane: 'tenant', lifecycle: LIFECYCLE, primaryKey: ['id'], evidenceLane: 'claims' },
        httpRoutes: ROUTES as never,
        behavior: { catalog, requirements: catalog.requirements, authorityProfileDigest: AUTH_DIGEST },
        now: '2026-09-19T00:00:00.000Z',
      });
      expect(issued).toBeDefined();
      expect(outcome.verdict).toBe('invalid');
      expect(outcome.reason).toMatch(/UNEXPECTED_EFFECT/);
      await witness.stop();
    } finally {
      await harness.close();
    }
  });
});

describe('principal boundary + attribution', () => {  it('a foreign session cannot drive another execution (403), double seal is 409', async () => {
    const harness = await startHarness();
    try {
      const ns = namespaceFor(harness.runId, CASE_ID);
      const appUrl = await startApp(harness, ns);
        const witness = await startWitness(witnessOptions(harness, appUrl));
      const catalog = catalogFor(updateDefinition());
      expect((await bindCatalog(witness.url, catalog, { [TEST_ID]: [CASE_ID], [OTHER_TEST_ID]: [CASE_ID] })).status).toBe(200);
      const session = await openSession(witness.url, TEST_ID, 0);
      const other = await openSession(witness.url, OTHER_TEST_ID, 1);
      const executed = await post(witness.url, '/behavior/execute', {
        sessionId: session.body['sessionId'],
        sessionToken: session.body['sessionToken'],
        caseId: CASE_ID,
      });
      expect(executed.status).toBe(200);
      const foreign = await post(witness.url, '/behavior/principal', {
        sessionId: other.body['sessionId'],
        sessionToken: other.body['sessionToken'],
        executionId: executed.body['executionId'],
      });
      expect(foreign.status).toBe(403);
      const sealed = await post(witness.url, '/behavior/principal', {
        sessionId: session.body['sessionId'],
        sessionToken: session.body['sessionToken'],
        executionId: executed.body['executionId'],
      });
      expect(sealed.status).toBe(200);
      const again = await post(witness.url, '/behavior/principal', {
        sessionId: session.body['sessionId'],
        sessionToken: session.body['sessionToken'],
        executionId: executed.body['executionId'],
      });
      expect(again.status).toBe(409);
      await witness.stop();
    } finally {
      await harness.close();
    }
  });

  it('a principal that misses the inventory fails with a diagnostic (no wrong-endpoint record)', async () => {
    const harness = await startHarness();
    try {
      const ns = namespaceFor(harness.runId, CASE_ID);
      const appUrl = await startApp(harness, ns);
        const witness = await startWitness(witnessOptions(harness, appUrl));
      const catalog = catalogFor(updateDefinition());
      // Inventory without the profile route: the driver still fires, but
      // attribution finds no match for the required endpoint.
      const foreignRoutes = [{ resourceId: 'tenant.http-other', method: 'POST', canonicalPath: '/other/{}' }];
      expect((await bindCatalog(witness.url, catalog, { [TEST_ID]: [CASE_ID] }, foreignRoutes)).status).toBe(200);
      const session = await openSession(witness.url, TEST_ID, 0);
      const executed = await post(witness.url, '/behavior/execute', {
        sessionId: session.body['sessionId'],
        sessionToken: session.body['sessionToken'],
        caseId: CASE_ID,
      });
      expect(executed.status).toBe(200);
      const driven = await post(witness.url, '/behavior/principal', {
        sessionId: session.body['sessionId'],
        sessionToken: session.body['sessionToken'],
        executionId: executed.body['executionId'],
      });
      expect(driven.status).toBe(409);
      expect(String(driven.body['error'])).toMatch(/BINDING_MISMATCH/);
      const ledger = await records(witness.url);
      expect(ledger.records.filter((record) => record['kind'] === 'behavior.case')).toEqual([]);
      await witness.stop();
    } finally {
      await harness.close();
    }
  });

  it('surface and deliver actions block with their phase cause', async () => {
    const harness = await startHarness();
    try {
        const witness = await startWitness(witnessOptions(harness));
      const surfaceDef = updateDefinition({
        id: 'browser-update',
        channel: 'engine-browser',
        action: { kind: 'surface', surface: 'profile', operation: 'update', fields: {} },
      });
      const surfaceCatalog: BehaviorCatalog = {
        schemaVersion: 1,
        catalogDigest: '1'.repeat(64),
        cases: [compiledCase(surfaceDef) as never],
        requirements: { [OBLIGATION_ID]: [CASE_ID] },
        dependencies: { [ENDPOINT]: ['tenant.accounts'] },
      } as BehaviorCatalog;
      expect((await bindCatalog(witness.url, surfaceCatalog, { [TEST_ID]: [CASE_ID] })).status).toBe(200);
      const session = await openSession(witness.url, TEST_ID, 0);
      const ns = namespaceFor(harness.runId, CASE_ID);
      writeFileSync(
        join(harness.stateDir, `${ns}.json`),
        `${JSON.stringify({ checkpoint: `${ns}:0`, entities: [] })}\n`,
      );
      const executed = await post(witness.url, '/behavior/execute', {
        sessionId: session.body['sessionId'],
        sessionToken: session.body['sessionToken'],
        caseId: CASE_ID,
      });
      expect(executed.status).toBe(200);
      const driven = await post(witness.url, '/behavior/principal', {
        sessionId: session.body['sessionId'],
        sessionToken: session.body['sessionToken'],
        executionId: executed.body['executionId'],
      });
      expect(driven.status).toBe(409);
      expect(String(driven.body['error'])).toMatch(/no approved descriptor/);
      await witness.stop();
    } finally {
      await harness.close();
    }
  });

  it('a barrier effect waits for a real checkpoint; a dead barrier blocks', async () => {
    for (const barrier of [{ complete: true }, { complete: false }]) {
      const harness = await startHarness();
      try {
        const ns = namespaceFor(harness.runId, CASE_ID);
        const appUrl = await startApp(harness, ns);
            const witness = await startWitness(witnessOptions(harness, appUrl));
        writeFileSync(join(harness.stateDir, '_barrier.json'), `${JSON.stringify(barrier)}\n`);
        const catalog = catalogFor(updateDefinition(), 'barrier');
        expect((await bindCatalog(witness.url, catalog, { [TEST_ID]: [CASE_ID] })).status).toBe(200);
        const session = await openSession(witness.url, TEST_ID, 0);
        const executed = await post(witness.url, '/behavior/execute', {
          sessionId: session.body['sessionId'],
          sessionToken: session.body['sessionToken'],
          caseId: CASE_ID,
        });
        expect(executed.status).toBe(200);
        const driven = await post(witness.url, '/behavior/principal', {
          sessionId: session.body['sessionId'],
          sessionToken: session.body['sessionToken'],
          executionId: executed.body['executionId'],
        });
        expect(driven.status, JSON.stringify(barrier)).toBe(barrier.complete ? 200 : 409);
        await witness.stop();
      } finally {
        await harness.close();
      }
    }
  });
});

describe('surface principal (bundle resolution + browser boundary)', () => {
  const SURFACE_DESCRIPTOR = {
    schemaVersion: SURFACE_DESCRIPTOR_VERSION,
    list: { path: '/', readySelector: 'h1', rowSelector: 'li', idCellIndex: 0, fieldCellIndexes: {} },
    create: { formPath: '/new', formReadySelector: 'form', fields: {}, submitSelector: 'button' },
    edit: {
      linkSelector: 'a',
      formReadySelectorTemplate: 'form-{id}',
      fields: { first_name: 'input[name="first_name"]' },
      saveSelectorTemplate: 'button-{id}',
    },
    archive: { controlSelectorTemplate: 'form-{id}' },
    status: { field: 'status', createdValue: 'active', archivedValue: 'archived' },
    afterAction: { path: '/' },
    deleteFields: {},
  };

  function surfaceDefinition() {
    return {
      id: 'profile-edit',
      contract: 'http:effect-verified',
      channel: 'engine-browser',
      fixture: 'one-account',
      actor: 'owner-a',
      action: {
        kind: 'surface',
        surface: 'profile',
        operation: 'update',
        subject: { from: 'fixture', key: 'accountA.identity' },
        fields: { first_name: { from: 'literal', value: 'Ada' } },
      },
      expect: {
        statuses: [303],
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

  function surfaceCatalog() {
    return {
      schemaVersion: 1,
      catalogDigest: '9'.repeat(64),
      cases: [
        {
          caseId: CASE_ID,
          specDigest: '8'.repeat(64),
          resourceId: ENDPOINT,
          endpointResourceId: ENDPOINT,
          obligationIds: [OBLIGATION_ID],
          definition: surfaceDefinition(),
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
          sourceFiles: ['frontend/profile.js'],
        },
      ],
      requirements: { [OBLIGATION_ID]: [CASE_ID] },
      dependencies: { [ENDPOINT]: ['tenant.accounts'] },
    };
  }

  async function prepareSurfaceHarness(surfaces: Record<string, unknown>) {
    const harness = await startHarness();
    const witness = await startWitness(witnessOptions(harness));
    const bound = await post(
      witness.url,
      '/runs/behavior-catalog',
      {
        catalog: surfaceCatalog(),
        assignments: { [TEST_ID]: [CASE_ID] },
        routes: ROUTES,
        authorityProfileDigest: AUTH_DIGEST,
        surfaces,
      },
      { [VERIFIER_HEADER]: VERIFIER_KEY },
    );
    return { harness, witness, bound };
  }

  async function prepareExecution(witnessUrl: string) {
    const session = await openSession(witnessUrl, TEST_ID, 0);
    const executed = await post(witnessUrl, '/behavior/execute', {
      sessionId: session.body['sessionId'],
      sessionToken: session.body['sessionToken'],
      caseId: CASE_ID,
    });
    return { session, executed };
  }

  function principal(witnessUrl: string, session: Record<string, unknown>, executionId: unknown) {
    return post(witnessUrl, '/behavior/principal', {
      sessionId: session['sessionId'],
      sessionToken: session['sessionToken'],
      executionId,
    });
  }

  it('rejects a malformed bundle surface at bind time (400)', async () => {
    const harness = await startHarness();
    try {
      const witness = await startWitness(witnessOptions(harness));
      try {
        const bound = await post(
          witness.url,
          '/runs/behavior-catalog',
          {
            catalog: surfaceCatalog(),
            assignments: { [TEST_ID]: [CASE_ID] },
            routes: ROUTES,
            authorityProfileDigest: AUTH_DIGEST,
            surfaces: { profile: { schemaVersion: 2, list: null } },
          },
          { [VERIFIER_HEADER]: VERIFIER_KEY },
        );
        expect(bound.status).toBe(400);
        expect(String(bound.body['error'])).toMatch(/surface 'profile' is invalid/);
      } finally {
        await witness.stop();
      }
    } finally {
      await harness.close();
    }
  });

  it('a surface case without a bound descriptor fails closed (409, no record)', async () => {
    const { harness, witness, bound } = await prepareSurfaceHarness({});
    try {
      expect(bound.status).toBe(200);
      const { session, executed } = await prepareExecution(witness.url);
      expect(executed.status).toBe(200);
      const driven = await principal(witness.url, session.body, executed.body['executionId']);
      expect(driven.status).toBe(409);
      expect(String(driven.body['error'])).toMatch(/no approved descriptor/);
      const ledger = await records(witness.url);
      expect(ledger.records.filter((record) => record['kind'] === 'behavior.case')).toEqual([]);
    } finally {
      await witness.stop();
      await harness.close();
    }
  });

  it('surface file inputs are an explicit unsupported cause (409)', async () => {
    const harness = await startHarness();
    try {
      const witness = await startWitness(witnessOptions(harness));
      try {
        const withFiles = JSON.parse(JSON.stringify(surfaceCatalog())) as {
          cases: Array<{ definition: { action: Record<string, unknown> } }>;
        };
        (withFiles.cases[0]?.definition.action as Record<string, unknown>)['files'] = { sheet: 'import-file' };
        const bound = await post(
          witness.url,
          '/runs/behavior-catalog',
          {
            catalog: withFiles,
            assignments: { [TEST_ID]: [CASE_ID] },
            routes: ROUTES,
            authorityProfileDigest: AUTH_DIGEST,
            surfaces: { profile: SURFACE_DESCRIPTOR },
          },
          { [VERIFIER_HEADER]: VERIFIER_KEY },
        );
        // The catalog schema allows files; the driver refuses them explicitly.
        expect(bound.status).toBe(200);
        const { session, executed } = await prepareExecution(witness.url);
        expect(executed.status).toBe(200);
        const driven = await principal(witness.url, session.body, executed.body['executionId']);
        expect(driven.status).toBe(409);
        expect(String(driven.body['error'])).toMatch(/file inputs/);
      } finally {
        await witness.stop();
      }
    } finally {
      await harness.close();
    }
  });

  it('without a launchable browser the drive blocks honestly (409, no record)', async () => {
    const { harness, witness, bound } = await prepareSurfaceHarness({ profile: SURFACE_DESCRIPTOR });
    try {
      expect(bound.status).toBe(200);
      const { session, executed } = await prepareExecution(witness.url);
      expect(executed.status).toBe(200);
      // No targetBaseUrl is provisioned, so the trusted UI base check
      // fails before any browser launches.
      const driven = await principal(witness.url, session.body, executed.body['executionId']);
      expect(driven.status).toBe(409);
      const ledger = await records(witness.url);
      expect(ledger.records.filter((record) => record['kind'] === 'behavior.case')).toEqual([]);
    } finally {
      await witness.stop();
      await harness.close();
    }
  });
});
