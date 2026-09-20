/**
 * Authentication semantics (plan 2026-09-19 §4.2/§8.1, Phase 7): every
 * auth contract proved through actual engine-controlled requests
 * against the REAL example auth server, graded against independent
 * file-mediated state scopes. Denied requests must deny (declared
 * denial statuses), change nothing (full-scope comparison), and leak
 * nothing (owner-declared absence rules); permission cases carry a
 * passing authorized positive control.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { startWitness } from '../src/witness/server.js';
import { createMemoryFixtureProvider } from '../src/witness/fixture-provider.js';
import { evaluateRequiredCases } from '@gate-forge/core';
// The auth example is an untyped checked-in fixture (not a workspace package).
// @ts-expect-error: no declaration file for the example fixture
import { createAuthApp, mintAuthToken, DEFAULT_AUTH_SECRET } from '../../../example/auth/server.js';
import { RUN_HEADER, VERIFIER_HEADER } from '../src/constants.js';

const TOKEN = 'auth-run-token';
const VERIFIER_KEY = 'auth-verifier-the-suite-never-sees';
const TEST_ID = 'playwright:chromium:e2e/refunds.spec.ts:refund guards';
const ENDPOINT = 'tenant.http-billing-refund';
const SECRET = 'auth-harness-secret-v1';

const CONTRACTS = {
  allowed: 'auth:role-allowed',
  denied: 'auth:role-denied',
  isolated: 'auth:tenant-isolated',
  noSideEffect: 'auth:denied-no-side-effect',
  forged: 'auth:forged-token-rejected',
} as const;

function obligationId(contract: string): string {
  return `${ENDPOINT}:${contract}`;
}

function authDefinition(slug: string, contract: string, actor: string, credentialVariant: string, body: unknown, statuses: number[], state: unknown[], response: unknown[] = [], controlCase?: string) {
  return {
    id: slug,
    contract,
    channel: 'engine-http',
    fixture: 'refund-ledger',
    actor,
    action: {
      kind: 'request',
      method: 'POST',
      pathTemplate: '/billing/refund',
      path: {},
      query: {},
      body: { encoding: 'json', fields: body as Record<string, { from: string; value: unknown }> },
      credentialVariant,
    },
    expect: { statuses, response, state },
    ...(controlCase === undefined ? {} : { controlCase }),
  };
}

const ALLOWED_DEF = authDefinition(
  'refund-allowed',
  CONTRACTS.allowed,
  'admin-a',
  'valid',
  { tenant_id: { from: 'literal', value: 'tenant-a' }, amount_cents: { from: 'literal', value: 500 } },
  [201],
  [
    {
      kind: 'created',
      scope: 'refunds',
      rows: [
        { fields: { amount_cents: { from: 'literal', value: 500 }, tenant_id: { from: 'literal', value: 'tenant-a' } } },
      ],
    },
  ],
  [{ kind: 'equals', pointer: '/status', value: { from: 'literal', value: 'refunded' } }],
);

function denialDef(slug: string, contract: string, actor: string, credentialVariant: string, tenant: string, controlCase: string) {
  return authDefinition(
    slug,
    contract,
    actor,
    credentialVariant,
    { tenant_id: { from: 'literal', value: tenant }, amount_cents: { from: 'literal', value: 500 } },
    contract === CONTRACTS.forged ? [401] : [403],
    [{ kind: 'unchanged', scope: 'refunds' }],
    contract === CONTRACTS.isolated
      ? [{ kind: 'absent', pointer: '/tenant_id' }]
      : [],
    controlCase,
  );
}

const CASES: Array<{ caseId: string; definition: ReturnType<typeof authDefinition> }> = [
  { caseId: 'a'.repeat(64), definition: ALLOWED_DEF },
  { caseId: 'b'.repeat(64), definition: denialDef('refund-denied', CONTRACTS.denied, 'member-a', 'valid', 'tenant-a', 'refund-allowed') },
  { caseId: 'c'.repeat(64), definition: denialDef('refund-isolated', CONTRACTS.isolated, 'admin-b', 'valid', 'tenant-a', 'refund-allowed') },
  { caseId: 'd'.repeat(64), definition: denialDef('refund-no-effect', CONTRACTS.noSideEffect, 'member-a', 'valid', 'tenant-a', 'refund-allowed') },
  { caseId: 'e'.repeat(64), definition: denialDef('refund-forged', CONTRACTS.forged, 'admin-a', 'corrupted', 'tenant-a', 'refund-allowed') },
];

function catalog() {
  return {
    schemaVersion: 1,
    catalogDigest: 'f'.repeat(64),
    cases: CASES.map((item) => ({
      caseId: item.caseId,
      specDigest: 'e'.repeat(64),
      resourceId: ENDPOINT,
      endpointResourceId: ENDPOINT,
      obligationIds: [obligationId(item.definition.contract as string)],
      definition: item.definition,
      effects: [
        {
          id: 'refunds',
          resourceId: 'tenant.refunds',
          adapter: 'refunds',
          scope: 'fixture-refunds',
          identityFields: ['id'],
          fields: ['amount_cents', 'tenant_id', 'status'],
          completion: 'immediate',
        },
      ],
      sourceFiles: ['example/auth/server.js'],
    })),
    requirements: Object.fromEntries(CASES.map((item) => [obligationId(item.definition.contract as string), [item.caseId]])),
    dependencies: { [ENDPOINT]: ['tenant.refunds'] },
  };
}

const ROUTES = [{ resourceId: ENDPOINT, method: 'POST', canonicalPath: '/billing/refund' }];
const AUTH_DIGEST = 'a'.repeat(64);

function namespaceFor(runId: string, caseId: string, lease: number): string {
  return `fixture-${runId}-${caseId}-${String(lease)}`.toLowerCase().replace(/[^a-z0-9-]/g, '-');
}

function writeAdapter(adaptersDir: string) {
  mkdirSync(adaptersDir, { recursive: true });
  writeFileSync(
    join(adaptersDir, 'refunds.mjs'),
    [
      "import { readFileSync, existsSync } from 'node:fs';",
      "import { join, dirname } from 'node:path';",
      "import { fileURLToPath } from 'node:url';",
      'const STATE_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "behavior-state");',
      'export default {',
      '  async read() { return null; },',
      '  normalize() { return { entityId: null, fields: {} }; },',
      "  deletion: 'hard',",
      "  environmentFingerprint: 'auth-test-fp',",
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

/** File-backed refund ledger: the app writes through it, the adapter reads the file. */
function fileLedger(stateDir: string, namespace: string) {
  const file = join(stateDir, `${namespace}.json`);
  let clock = 0;
  const readEntities = () =>
    (existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as { entities: Array<{ entityId: unknown; fields: Record<string, unknown> }> }).entities : []);
  const toRow = (entity: { entityId: unknown; fields: Record<string, unknown> }) => ({
    id: entity.entityId,
    ...entity.fields,
  });
  const write = () => {
    clock += 1;
    const entities = ledger.all().map((row: Record<string, unknown>) => ({ entityId: row['id'], fields: row }));
    writeFileSync(file, `${JSON.stringify({ checkpoint: `${namespace}:${String(clock)}`, entities })}\n`);
  };
  const ledger = {
    find: (id: unknown) => {
      const rows = readEntities();
      const found = rows.find((entity) => entity.entityId === id);
      return found === undefined ? null : toRow(found);
    },
    all: () => readEntities().map(toRow),
    save: (record: Record<string, unknown>) => {
      const rows = readEntities();
      const stored = { ...record };
      if (stored['id'] === undefined || stored['id'] === null) {
        stored['id'] = `rfn-${rows.length + 1}`;
      }
      const next = rows.filter((entity) => entity.entityId !== stored['id']);
      next.push({ entityId: stored['id'], fields: stored as Record<string, unknown> });
      clock += 1;
      writeFileSync(file, `${JSON.stringify({ checkpoint: `${namespace}:${String(clock)}`, entities: next })}\n`);
      return { ...stored };
    },
  };
  // Seed the empty authoritative before-state.
  writeFileSync(file, `${JSON.stringify({ checkpoint: `${namespace}:0`, entities: [] })}\n`);
  return ledger;
}

function mintToken(role: string, tenantId: string, sub: string): string {
  return mintAuthToken(SECRET, { sub, role, tenantId, exp: Math.floor(Date.now() / 1000) + 3600 }) as string;
}

async function post(url: string, path: string, body: unknown, headers: Record<string, string> = {}) {
  const response = await fetch(`${url}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', [RUN_HEADER]: TOKEN, ...headers },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

describe('auth contracts end to end (real example server)', () => {
  it('allowed passes; denied/isolated/no-effect/forged deny with no side effect and no leak', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gateforge-auth-'));
    const adaptersDir = join(root, '.gateforge', 'adapters');
    const stateDir = join(root, 'behavior-state');
    mkdirSync(stateDir, { recursive: true });
    writeAdapter(adaptersDir);
    const runId = randomUUID();
    // One isolated ledger file per case (pre-seeded empty before-state).
    const ledgers = new Map<string, ReturnType<typeof fileLedger>>();
    for (const item of CASES) {
      const ns = namespaceFor(runId, item.caseId, 1);
      ledgers.set(item.caseId, fileLedger(stateDir, ns));
    }
    const servers: Array<{ close(cb: () => void): void }> = [];
    const providerOptions = () => ({
      actors: {
        'admin-a': { principalId: 'admin-a', tenantId: 'tenant-a', roles: ['admin'] },
        'member-a': { principalId: 'member-a', tenantId: 'tenant-a', roles: ['member'] },
        'admin-b': { principalId: 'admin-b', tenantId: 'tenant-b', roles: ['admin'] },
      },
      credentials: {
        'admin-a': { authorization: `Bearer ${mintToken('admin', 'tenant-a', 'admin-a')}` },
        'member-a': { authorization: `Bearer ${mintToken('member', 'tenant-a', 'member-a')}` },
        'admin-b': { authorization: `Bearer ${mintToken('admin', 'tenant-b', 'admin-b')}` },
      },
      subjects: { 'refund-ledger': {} },
    });
    try {
      const results: string[] = [];
      for (const item of CASES) {
        const ledger = ledgers.get(item.caseId);
        if (ledger === undefined) throw new Error('missing ledger');
        const caseApp = createAuthApp({ secret: SECRET, ledger });
        await new Promise<void>((resolve) => caseApp.listen(0, '127.0.0.1', resolve));
        servers.push(caseApp);
        const caseAddress = caseApp.address();
        if (caseAddress === null || typeof caseAddress === 'string') throw new Error('no case app port');
        const caseWitness = await startWitness({
          runId,
          token: TOKEN,
          verifierKey: VERIFIER_KEY,
          adaptersDir,
          targetBaseUrl: `http://127.0.0.1:${String(caseAddress.port)}`,
          fixtureProvider: createMemoryFixtureProvider(providerOptions()),
          now: () => '2026-09-19T00:00:00.000Z',
        });
        try {
          const single = await post(
            caseWitness.url,
            '/runs/behavior-catalog',
            {
              catalog: {
                ...catalog(),
                catalogDigest: '1'.repeat(64),
                cases: catalog().cases.filter((row) => row.caseId === item.caseId),
                requirements: { [obligationId(item.definition.contract as string)]: [item.caseId] },
              },
              assignments: { [TEST_ID]: [item.caseId] },
              routes: ROUTES,
              authorityProfileDigest: AUTH_DIGEST,
            },
            { [VERIFIER_HEADER]: VERIFIER_KEY },
          );
          expect(single.status).toBe(200);
          const opened = (await (
            await fetch(`${caseWitness.url}/sessions/open`, {
              method: 'POST',
              headers: { 'content-type': 'application/json', [RUN_HEADER]: TOKEN, [VERIFIER_HEADER]: VERIFIER_KEY },
              body: JSON.stringify({ testId: TEST_ID, workerIndex: 0 }),
            })
          ).json()) as { sessionId: string; sessionToken: string };
          const executed = await post(caseWitness.url, '/behavior/execute', {
            sessionId: opened.sessionId,
            sessionToken: opened.sessionToken,
            caseId: item.caseId,
          });
          expect(executed.status, item.definition.id).toBe(200);
          const sealed = await post(caseWitness.url, '/behavior/principal', {
            sessionId: opened.sessionId,
            sessionToken: opened.sessionToken,
            executionId: (executed.body as { executionId: string }).executionId,
          });
          expect(sealed.status, item.definition.id).toBe(200);
          const ledger = await (await fetch(`${caseWitness.url}/records`, { headers: { [RUN_HEADER]: TOKEN } })).json() as {
            records: Array<Record<string, unknown>>;
          };
          const issued = ledger.records.find((record) => record['kind'] === 'behavior.case');
          expect(issued).toBeDefined();
          const outcome = evaluateRequiredCases({
            obligation: {
              schemaVersion: 1,
              id: obligationId(item.definition.contract),
              resourceId: ENDPOINT,
              contract: item.definition.contract,
              policyId: 'behavior-policy',
              lifecycle: { create: true, read: true, update: true, delete: true, deleteSemantics: 'hard' },
            } as never,
            requiredCaseIds: [item.caseId],
            records: ledger.records as never,
            context: {
              catalog: catalog() as never,
              requirements: { [obligationId(item.definition.contract)]: [item.caseId] },
              authorityProfileDigest: AUTH_DIGEST,
              plannedTestIds: [TEST_ID],
            },
            httpRoutes: ROUTES as never,
          });
          expect(outcome.status, `${item.definition.id}: ${outcome.status === 'satisfied' ? '' : (outcome as { reason: string }).reason}`).toBe('satisfied');
          results.push(item.definition.id);
        } finally {
          await caseWitness.stop();
        }
      }
      expect(results).toEqual(['refund-allowed', 'refund-denied', 'refund-isolated', 'refund-no-effect', 'refund-forged']);
    } finally {
      for (const server of servers) {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    }
  });
});
