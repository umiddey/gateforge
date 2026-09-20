/**
 * `evidence.prove(caseId)` (plan 2026-09-19 Phase 6 item 1): the
 * worker-facing proof primitive. The call sends ONLY the allowed case
 * id plus the session credential — actor material, expectations, and
 * subjects resolve engine-side. Covered here through the real
 * fixture client against a real witness (engine-http cases need no
 * browser), plus the worker-boundary rejections.
 */
import { describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { startWitness } from '../src/witness/server.js';
import { WitnessClient } from '../src/fixture/witness-client.js';
import { createEvidence } from '../src/fixture/evidence.js';
import { createMemoryFixtureProvider } from '../src/witness/fixture-provider.js';
import { RUN_HEADER, VERIFIER_HEADER } from '../src/constants.js';

const TOKEN = 'prove-run-token';
const VERIFIER_KEY = 'prove-verifier-the-suite-never-sees';
const TEST_ID = 'playwright:chromium:e2e/profile.spec.ts:owner updates profile';
const CASE_ID = 'c'.repeat(64);
const AUTH_DIGEST = 'a'.repeat(64);
const ENDPOINT = 'tenant.http-profile';
const OBLIGATION_ID = `${ENDPOINT}:http:effect-verified`;

function definition() {
  return {
    id: 'owner-update',
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

function catalog() {
  return {
    schemaVersion: 1,
    catalogDigest: 'f'.repeat(64),
    cases: [
      {
        caseId: CASE_ID,
        specDigest: 'e'.repeat(64),
        resourceId: ENDPOINT,
        endpointResourceId: ENDPOINT,
        obligationIds: [OBLIGATION_ID],
        definition: definition(),
        effects: [
          {
            id: 'accounts',
            resourceId: 'tenant.accounts',
            adapter: 'accounts',
            scope: 'fixture-accounts',
            identityFields: ['id'],
            fields: ['first_name'],
            completion: 'immediate',
          },
        ],
        sourceFiles: ['backend/profile.js'],
      },
    ],
    requirements: { [OBLIGATION_ID]: [CASE_ID] },
    dependencies: { [ENDPOINT]: ['tenant.accounts'] },
  };
}

const ROUTES = [{ resourceId: ENDPOINT, method: 'POST', canonicalPath: '/profile/accounts/{}' }];

function writeAdapter(adaptersDir: string) {
  mkdirSync(adaptersDir, { recursive: true });
  writeFileSync(
    join(adaptersDir, 'accounts.mjs'),
    [
      "import { readFileSync, existsSync } from 'node:fs';",
      "import { join, dirname } from 'node:path';",
      "import { fileURLToPath } from 'node:url';",
      'const STATE_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "behavior-state");',
      'export default {',
      '  async read() { return null; },',
      '  normalize() { return { entityId: null, fields: {} }; },',
      "  deletion: 'hard',",
      "  environmentFingerprint: 'prove-test-fp',",
      '  async snapshotScope(ctx, input) {',
      '    const path = join(STATE_DIR, `${input.fixtureNamespace}.json`);',
      '    const stored = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : { checkpoint: `${input.fixtureNamespace}:0`, entities: [] };',
      '    return { scope: input.scope, fixtureNamespace: input.fixtureNamespace, complete: true, checkpoint: stored.checkpoint, entities: stored.entities, exhausted: true };',
      '  },',
      '};',
      '',
    ].join('\n'),
  );
}

function namespaceFor(runId: string): string {
  return `fixture-${runId}-${CASE_ID}-1`.toLowerCase().replace(/[^a-z0-9-]/g, '-');
}

interface ProveHarness {
  witness: Awaited<ReturnType<typeof startWitness>>;
  client: WitnessClient;
  session: { sessionId: string; sessionToken: string };
  namespace: string;
  stateDir: string;
  close(): Promise<void>;
}

async function startProveHarness(): Promise<ProveHarness> {
  const root = mkdtempSync(join(tmpdir(), 'gateforge-prove-'));
  const adaptersDir = join(root, '.gateforge', 'adapters');
  const stateDir = join(root, 'behavior-state');
  mkdirSync(stateDir, { recursive: true });
  writeAdapter(adaptersDir);
  const runId = randomUUID();
  // Stub app: applies the update through the namespace file (the
  // file-mediated trusted observer reads the same file).
  const namespace = namespaceFor(runId);
  const stub: Server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += String(chunk);
    });
    req.on('end', () => {
      const statePath = join(stateDir, `${namespace}.json`);
      const body = raw === '' ? {} : (JSON.parse(raw) as Record<string, unknown>);
      writeFileSync(
        statePath,
        `${JSON.stringify({
          checkpoint: `${namespace}:2`,
          entities: [{ entityId: 'acc-1', fields: { first_name: body['first_name'] ?? 'Ada' } }],
        })}\n`,
      );
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise<void>((resolve) => stub.listen(0, '127.0.0.1', resolve));
  const address = stub.address();
  if (address === null || typeof address === 'string') throw new Error('no stub port');
  writeFileSync(
    join(stateDir, `${namespace}.json`),
    `${JSON.stringify({ checkpoint: `${namespace}:1`, entities: [{ entityId: 'acc-1', fields: { first_name: 'Grace' } }] })}\n`,
  );
  const witness = await startWitness({
    runId,
    token: TOKEN,
    verifierKey: VERIFIER_KEY,
    adaptersDir,
    targetBaseUrl: `http://127.0.0.1:${String(address.port)}`,
    fixtureProvider: createMemoryFixtureProvider({
      actors: { 'owner-a': { principalId: 'owner-a', tenantId: 't1', roles: ['owner'] } },
      credentials: { 'owner-a': {} },
      subjects: { 'one-account': { accountA: { id: 'acc-1', identity: 'acc-1' } } },
    }),
    now: () => '2026-09-19T00:00:00.000Z',
  });
  const bound = await (
    await fetch(`${witness.url}/runs/behavior-catalog`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [RUN_HEADER]: TOKEN, [VERIFIER_HEADER]: VERIFIER_KEY },
      body: JSON.stringify({ catalog: catalog(), assignments: { [TEST_ID]: [CASE_ID] }, routes: ROUTES, authorityProfileDigest: AUTH_DIGEST }),
    })
  ).json();
  if ((bound as { bound?: unknown }).bound !== true) throw new Error('catalog bind failed');
  const opened = (await (
    await fetch(`${witness.url}/sessions/open`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [RUN_HEADER]: TOKEN, [VERIFIER_HEADER]: VERIFIER_KEY },
      body: JSON.stringify({ testId: TEST_ID, workerIndex: 0 }),
    })
  ).json()) as { sessionId: string; sessionToken: string };
  const client = new WitnessClient(witness.url, TOKEN);
  return {
    witness,
    client,
    session: { sessionId: opened.sessionId, sessionToken: opened.sessionToken },
    namespace,
    stateDir,
    close: async () => {
      await witness.stop();
      await new Promise<void>((resolve) => stub.close(() => resolve()));
    },
  };
}

describe('evidence.prove (worker proof primitive)', () => {
  it('proves an allowed case through the fixture client and seals a record', async () => {
    const harness = await startProveHarness();
    try {
      const executed = await harness.client.proveCase({ ...harness.session, caseId: CASE_ID });
      expect(executed.caseId).toBe(CASE_ID);
      expect(executed.namespace).toBe(harness.namespace);
      expect(typeof executed.executionId).toBe('string');
      const sealed = await harness.client.drivePrincipal({ ...harness.session, executionId: executed.executionId });
      expect(sealed.state).toBe('sealed');
      expect(sealed.recordIds).toHaveLength(1);
      // Redacted: no credentials, no subjects, no expectations cross.
      expect(JSON.stringify({ ...executed, ...sealed })).not.toMatch(/credref|subject|expect/i);
    } finally {
      await harness.close();
    }
  });

  it('worker boundary rejections: unknown case, foreign case, closed session', async () => {
    const harness = await startProveHarness();
    try {
      await expect(harness.client.proveCase({ ...harness.session, caseId: 'f'.repeat(64) })).rejects.toMatchObject({
        status: 400,
      });
      // Extra keys are request errors, never overrides.
      await expect(
        harness.client.proveCase({ ...harness.session, caseId: CASE_ID, actor: 'mallory' } as never),
      ).rejects.toMatchObject({ status: 400 });
    } finally {
      await harness.close();
    }
  });

  it('createEvidence exposes prove and runs it with the session credential only', async () => {
    const harness = await startProveHarness();
    try {
      const api = await createEvidence({
        testInfo: { testId: TEST_ID, workerIndex: 0, title: 'owner updates profile', annotations: [] } as never,
        surface: {
          schemaVersion: 2,
          list: { path: '/', readySelector: 'h1', rowSelector: 'li', idCellIndex: 0, fieldCellIndexes: {} },
          create: { formPath: '/new', formReadySelector: 'form', fields: {}, submitSelector: 'button' },
          edit: { linkSelector: 'a', formReadySelectorTemplate: 'form-{id}', fields: {}, saveSelectorTemplate: 'button-{id}' },
          archive: { controlSelectorTemplate: 'form-{id}' },
          status: { field: 'status', createdValue: 'active', archivedValue: 'archived' },
          afterAction: { path: '/' },
          deleteFields: {},
        } as never,
        client: harness.client,
        session: { ...harness.session, testId: TEST_ID, workerIndex: 0, claims: [OBLIGATION_ID] } as never,
      });
      expect(typeof api.prove).toBe('function');
      const result = await api.prove(CASE_ID);
      expect(result.state).toBe('sealed');
      expect(result.namespace).toBe(harness.namespace);
      expect(result.recordIds).toHaveLength(1);
      await expect(api.prove('')).rejects.toThrow(/non-empty case id/);
    } finally {
      await harness.close();
    }
  });
});
