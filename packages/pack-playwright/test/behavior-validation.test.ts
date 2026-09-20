/**
 * Validation semantics (plan 2026-09-19 §4.2/§8.2, Phase 7): boundary,
 * required-field, type, and envelope contracts proved through actual
 * engine-controlled requests against the REAL example validation
 * server, graded against independent file-mediated state scopes.
 * Accepted inputs must create exactly the declared row; rejected
 * inputs must change nothing and name the offending field.
 */
import { describe, expect, it } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { startWitness } from '../src/witness/server.js';
import { createMemoryFixtureProvider } from '../src/witness/fixture-provider.js';
import { evaluateRequiredCases } from '@gate-forge/core';
// The validation example is an untyped checked-in fixture (not a workspace package).
// @ts-expect-error: no declaration file for the example fixture
import { createValidationApp, createMemoryLedger } from '../../../example/validation/server.js';
import { RUN_HEADER, VERIFIER_HEADER } from '../src/constants.js';

const TOKEN = 'validation-run-token';
const VERIFIER_KEY = 'validation-verifier-the-suite-never-sees';
const TEST_ID = 'playwright:chromium:e2e/accounts.spec.ts:account validation';
const ENDPOINT = 'tenant.http-accounts';
const AUTH_DIGEST = 'a'.repeat(64);

const CONTRACTS = {
  accepted: 'validation:boundary-accepted',
  rejected: 'validation:boundary-rejected',
  noSideEffect: 'validation:no-side-effect-on-reject',
  explicit: 'validation:error-message-explicit',
  envelope: 'validation:envelope-shape-stable',
} as const;

function obligationId(contract: string): string {
  return `${ENDPOINT}:${contract}`;
}

function accountFields(firstName: unknown, lastName = 'Lovelace', email = 'ada@example.com') {
  return {
    first_name: { from: 'literal', value: firstName },
    last_name: { from: 'literal', value: lastName },
    email: { from: 'literal', value: email },
  };
}

function validationDefinition(
  slug: string,
  contract: string,
  fields: Record<string, { from: string; value: unknown }>,
  statuses: number[],
  state: unknown[],
  response: unknown[] = [],
  controlCase?: string,
) {
  return {
    id: slug,
    contract,
    channel: 'engine-http',
    fixture: 'account-ledger',
    actor: 'anonymous',
    action: {
      kind: 'request',
      method: 'POST',
      pathTemplate: '/accounts',
      path: {},
      query: {},
      body: { encoding: 'json', fields },
      credentialVariant: 'valid',
    },
    expect: { statuses, response, state },
    ...(controlCase === undefined ? {} : { controlCase }),
  };
}

const FIFTY = 'n'.repeat(50);
const FIFTY_ONE = 'n'.repeat(51);

const CASES: Array<{ caseId: string; definition: ReturnType<typeof validationDefinition> }> = [
  {
    caseId: 'a'.repeat(64),
    definition: validationDefinition(
      'boundary-accepted',
      CONTRACTS.accepted,
      accountFields(FIFTY),
      [201],
      [
        {
          kind: 'created',
          scope: 'accounts',
          rows: [{ fields: { first_name: { from: 'literal', value: FIFTY } } }],
        },
      ],
      [
        {
          kind: 'envelope',
          schema: {
            type: 'object',
            properties: {
              id: { type: 'string', minLength: 1, maxLength: 64 },
              first_name: { type: 'string', minLength: 1, maxLength: 50 },
              last_name: { type: 'string', minLength: 1, maxLength: 50 },
              email: { type: 'string', minLength: 1, maxLength: 256 },
            },
            required: ['id', 'first_name', 'last_name', 'email'],
            additionalProperties: false,
          },
        },
      ],
    ),
  },
  {
    caseId: 'b'.repeat(64),
    definition: validationDefinition(
      'boundary-rejected',
      CONTRACTS.rejected,
      accountFields(FIFTY_ONE),
      [400],
      [{ kind: 'unchanged', scope: 'accounts' }],
      [
        {
          kind: 'field-error',
          field: 'first_name',
          fieldPointer: '/errors/0/field',
          codePointer: '/errors/0/message',
          allowedCodes: ['must be 1..50 chars'],
        },
      ],
      'boundary-accepted',
    ),
  },
  {
    caseId: 'c'.repeat(64),
    definition: validationDefinition(
      'no-side-effect',
      CONTRACTS.noSideEffect,
      accountFields('Ada', 'Lovelace', 'not-an-email'),
      [400],
      [{ kind: 'unchanged', scope: 'accounts' }],
      [],
      'boundary-accepted',
    ),
  },
  {
    caseId: 'd'.repeat(64),
    definition: validationDefinition(
      'explicit-message',
      CONTRACTS.explicit,
      { first_name: { from: 'literal', value: 'Ada' }, email: { from: 'literal', value: 'ada@example.com' } },
      [400],
      [{ kind: 'unchanged', scope: 'accounts' }],
      [
        {
          kind: 'field-error',
          field: 'last_name',
          fieldPointer: '/errors/0/field',
          codePointer: '/errors/0/message',
          allowedCodes: ['must be 1..50 chars'],
        },
      ],
    ),
  },
  {
    caseId: 'e'.repeat(64),
    definition: validationDefinition(
      'envelope-stable',
      CONTRACTS.envelope,
      accountFields('Grace', 'Hopper', 'grace@example.com'),
      [201],
      [
        {
          kind: 'created',
          scope: 'accounts',
          rows: [{ fields: { email: { from: 'literal', value: 'grace@example.com' } } }],
        },
      ],
      [
        {
          kind: 'envelope',
          schema: {
            type: 'object',
            properties: {
              id: { type: 'string', minLength: 1, maxLength: 64 },
              first_name: { type: 'string', minLength: 1, maxLength: 50 },
              last_name: { type: 'string', minLength: 1, maxLength: 50 },
              email: { type: 'string', minLength: 1, maxLength: 256 },
            },
            required: ['id', 'first_name', 'last_name', 'email'],
            additionalProperties: false,
          },
        },
      ],
    ),
  },
];

function catalogForCase(item: { caseId: string; definition: ReturnType<typeof validationDefinition> }) {
  return {
    schemaVersion: 1,
    catalogDigest: '1'.repeat(64),
    cases: [
      {
        caseId: item.caseId,
        specDigest: 'e'.repeat(64),
        resourceId: ENDPOINT,
        endpointResourceId: ENDPOINT,
        obligationIds: [obligationId(item.definition.contract as string)],
        definition: item.definition,
        effects: [
          {
            id: 'accounts',
            resourceId: 'tenant.accounts',
            adapter: 'accounts',
            scope: 'fixture-accounts',
            identityFields: ['id'],
            fields: ['first_name', 'last_name', 'email'],
            completion: 'immediate',
          },
        ],
        sourceFiles: ['example/validation/server.js'],
      },
    ],
    requirements: { [obligationId(item.definition.contract as string)]: [item.caseId] },
    dependencies: { [ENDPOINT]: ['tenant.accounts'] },
  };
}

const ROUTES = [{ resourceId: ENDPOINT, method: 'POST', canonicalPath: '/accounts' }];

function namespaceFor(runId: string, caseId: string): string {
  return `fixture-${runId}-${caseId}-1`.toLowerCase().replace(/[^a-z0-9-]/g, '-');
}

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
      "  environmentFingerprint: 'validation-test-fp',",
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

async function post(url: string, path: string, body: unknown, headers: Record<string, string> = {}) {
  const response = await fetch(`${url}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', [RUN_HEADER]: TOKEN, ...headers },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

describe('validation contracts end to end (real example server)', () => {
  it('accepted creates; rejected/explicit deny with field errors and no side effects; envelopes hold', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gateforge-validation-'));
    const adaptersDir = join(root, '.gateforge', 'adapters');
    const stateDir = join(root, 'behavior-state');
    mkdirSync(stateDir, { recursive: true });
    writeAdapter(adaptersDir);
    const runId = randomUUID();
    const servers: Server[] = [];
    const syncFile = (namespace: string, ledger: { list(): Array<Record<string, unknown>> }, clock: { n: number }) => {
      writeFileSync(
        join(stateDir, `${namespace}.json`),
        `${JSON.stringify({
          checkpoint: `${namespace}:${String(clock.n)}`,
          entities: ledger.list().map((row) => ({ entityId: row['id'], fields: { ...row } })),
        })}\n`,
      );
    };
    try {
      const results: string[] = [];
      for (const item of CASES) {
        const ns = namespaceFor(runId, item.caseId);
        // File-backed ledger: the app writes through it, the adapter reads the file.
        const backing = createMemoryLedger() as {
          list(): Array<Record<string, unknown>>;
          push(fields: Record<string, unknown>): Record<string, unknown>;
        };
        const clock = { n: 0 };
        const ledger = {
          list: () => backing.list(),
          push: (fields: Record<string, unknown>) => {
            const created = backing.push(fields);
            clock.n += 1;
            syncFile(ns, backing, clock);
            return created;
          },
        };
        syncFile(ns, backing, clock);
        const app = createValidationApp({ ledger });
        await new Promise<void>((resolve) => app.listen(0, '127.0.0.1', resolve));
        servers.push(app as Server);
        const address = (app as Server).address();
        if (address === null || typeof address === 'string') throw new Error('no app port');
        const witness = await startWitness({
          runId,
          token: TOKEN,
          verifierKey: VERIFIER_KEY,
          adaptersDir,
          targetBaseUrl: `http://127.0.0.1:${String(address.port)}`,
          fixtureProvider: createMemoryFixtureProvider({
            actors: { anonymous: { principalId: 'anonymous', tenantId: null, roles: [] } },
            credentials: { anonymous: {} },
            subjects: {},
          }),
          now: () => '2026-09-19T00:00:00.000Z',
        });
        try {
          const bound = await post(
            witness.url,
            '/runs/behavior-catalog',
            {
              catalog: catalogForCase(item),
              assignments: { [TEST_ID]: [item.caseId] },
              routes: ROUTES,
              authorityProfileDigest: AUTH_DIGEST,
            },
            { [VERIFIER_HEADER]: VERIFIER_KEY },
          );
          expect(bound.status).toBe(200);
          const opened = (await (
            await fetch(`${witness.url}/sessions/open`, {
              method: 'POST',
              headers: { 'content-type': 'application/json', [RUN_HEADER]: TOKEN, [VERIFIER_HEADER]: VERIFIER_KEY },
              body: JSON.stringify({ testId: TEST_ID, workerIndex: 0 }),
            })
          ).json()) as { sessionId: string; sessionToken: string };
          const executed = await post(witness.url, '/behavior/execute', {
            sessionId: opened.sessionId,
            sessionToken: opened.sessionToken,
            caseId: item.caseId,
          });
          expect(executed.status, item.definition.id).toBe(200);
          const sealed = await post(witness.url, '/behavior/principal', {
            sessionId: opened.sessionId,
            sessionToken: opened.sessionToken,
            executionId: (executed.body as { executionId: string }).executionId,
          });
          expect(sealed.status, item.definition.id).toBe(200);
          const ledger = await (await fetch(`${witness.url}/records`, { headers: { [RUN_HEADER]: TOKEN } })).json() as {
            records: Array<Record<string, unknown>>;
          };
          const issued = ledger.records.find((record) => record['kind'] === 'behavior.case');
          expect(issued).toBeDefined();
          const outcome = evaluateRequiredCases({
            obligation: {
              schemaVersion: 1,
              id: obligationId(item.definition.contract as string),
              resourceId: ENDPOINT,
              contract: item.definition.contract,
              policyId: 'behavior-policy',
              lifecycle: { create: true, read: true, update: true, delete: true, deleteSemantics: 'hard' },
            } as never,
            requiredCaseIds: [item.caseId],
            records: ledger.records as never,
            context: {
              catalog: catalogForCase(item) as never,
              requirements: { [obligationId(item.definition.contract as string)]: [item.caseId] },
              authorityProfileDigest: AUTH_DIGEST,
              plannedTestIds: [TEST_ID],
            },
            httpRoutes: ROUTES as never,
          });
          expect(outcome.status, `${item.definition.id}: ${outcome.status === 'satisfied' ? '' : (outcome as { reason: string }).reason}`).toBe('satisfied');
          results.push(item.definition.id as string);
        } finally {
          await witness.stop();
        }
      }
      expect(results).toEqual(['boundary-accepted', 'boundary-rejected', 'no-side-effect', 'explicit-message', 'envelope-stable']);
    } finally {
      for (const server of servers) {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    }
  });

  it('a validator that rejects everything cannot pass the accepted case (B30)', async () => {
    const stub: Server = createServer((_req, res) => {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ errors: [{ field: 'first_name', message: 'must be 1..50 chars' }] }));
    });
    await new Promise<void>((resolve) => stub.listen(0, '127.0.0.1', resolve));
    const address = stub.address();
    if (address === null || typeof address === 'string') throw new Error('no stub port');
    const root = mkdtempSync(join(tmpdir(), 'gateforge-validation-neg-'));
    const adaptersDir = join(root, '.gateforge', 'adapters');
    const stateDir = join(root, 'behavior-state');
    mkdirSync(stateDir, { recursive: true });
    writeAdapter(adaptersDir);
    const runId = randomUUID();
    const item = CASES[0] as (typeof CASES)[number];
    const ns = namespaceFor(runId, item.caseId);
    writeFileSync(join(stateDir, `${ns}.json`), `${JSON.stringify({ checkpoint: `${ns}:0`, entities: [] })}\n`);
    const witness = await startWitness({
      runId,
      token: TOKEN,
      verifierKey: VERIFIER_KEY,
      adaptersDir,
      targetBaseUrl: `http://127.0.0.1:${String(address.port)}`,
      fixtureProvider: createMemoryFixtureProvider({
        actors: { anonymous: { principalId: 'anonymous', tenantId: null, roles: [] } },
        credentials: { anonymous: {} },
        subjects: {},
      }),
      now: () => '2026-09-19T00:00:00.000Z',
    });
    try {
      const bound = await post(
        witness.url,
        '/runs/behavior-catalog',
        {
          catalog: catalogForCase(item),
          assignments: { [TEST_ID]: [item.caseId] },
          routes: ROUTES,
          authorityProfileDigest: AUTH_DIGEST,
        },
        { [VERIFIER_HEADER]: VERIFIER_KEY },
      );
      expect(bound.status).toBe(200);
      const opened = (await (
        await fetch(`${witness.url}/sessions/open`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', [RUN_HEADER]: TOKEN, [VERIFIER_HEADER]: VERIFIER_KEY },
          body: JSON.stringify({ testId: TEST_ID, workerIndex: 0 }),
        })
      ).json()) as { sessionId: string; sessionToken: string };
      const executed = await post(witness.url, '/behavior/execute', {
        sessionId: opened.sessionId,
        sessionToken: opened.sessionToken,
        caseId: item.caseId,
      });
      expect(executed.status).toBe(200);
      // The witness seals what it observed (a 400 for valid input); the
      // grader rejects: negative-only testing would be misleading.
      const sealed = await post(witness.url, '/behavior/principal', {
        sessionId: opened.sessionId,
        sessionToken: opened.sessionToken,
        executionId: (executed.body as { executionId: string }).executionId,
      });
      expect(sealed.status).toBe(200);
      const ledger = await (await fetch(`${witness.url}/records`, { headers: { [RUN_HEADER]: TOKEN } })).json() as {
        records: Array<Record<string, unknown>>;
      };
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
          catalog: catalogForCase(item) as never,
          requirements: { [obligationId(item.definition.contract)]: [item.caseId] },
          authorityProfileDigest: AUTH_DIGEST,
          plannedTestIds: [TEST_ID],
        },
        httpRoutes: ROUTES as never,
      });
      expect(outcome.status).toBe('invalid');
    } finally {
      await witness.stop();
      await new Promise<void>((resolve) => stub.close(() => resolve()));
    }
  });

  it('a valid payload with a smuggled extra row fails (B29 unexpected effect)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gateforge-validation-b29-'));
    const adaptersDir = join(root, '.gateforge', 'adapters');
    const stateDir = join(root, 'behavior-state');
    mkdirSync(stateDir, { recursive: true });
    writeAdapter(adaptersDir);
    const runId = randomUUID();
    // Accepted case: the declared row is created exactly, but the
    // hostile app smuggles a second full-shape row beside it.
    const item = CASES[0] as (typeof CASES)[number];
    const ns = namespaceFor(runId, item.caseId);
    writeFileSync(join(stateDir, `${ns}.json`), `${JSON.stringify({ checkpoint: `${ns}:0`, entities: [] })}\n`);
    const stub: Server = createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk) => {
        raw += String(chunk);
      });
      req.on('end', () => {
        const body = JSON.parse(raw === '' ? '{}' : raw) as Record<string, unknown>;
        const path = join(stateDir, `${ns}.json`);
        const stored = JSON.parse(readFileSync(path, 'utf8')) as {
          checkpoint: string;
          entities: Array<{ entityId: unknown; fields: Record<string, unknown> }>;
        };
        stored.entities.push({
          entityId: 'acc-1',
          fields: { first_name: body['first_name'], last_name: body['last_name'], email: body['email'] },
        });
        stored.entities.push({
          entityId: 'acc-9',
          fields: { first_name: 'Shadow', last_name: 'Row', email: 'shadow@example.com' },
        });
        writeFileSync(path, `${JSON.stringify({ checkpoint: stored.checkpoint, entities: stored.entities })}\n`);
        res.writeHead(201, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({ id: 'acc-1', first_name: body['first_name'], last_name: body['last_name'], email: body['email'] }),
        );
      });
    });
    await new Promise<void>((resolve) => stub.listen(0, '127.0.0.1', resolve));
    const address = stub.address();
    if (address === null || typeof address === 'string') throw new Error('no stub port');
    const witness = await startWitness({
      runId,
      token: TOKEN,
      verifierKey: VERIFIER_KEY,
      adaptersDir,
      targetBaseUrl: `http://127.0.0.1:${String(address.port)}`,
      fixtureProvider: createMemoryFixtureProvider({
        actors: { anonymous: { principalId: 'anonymous', tenantId: null, roles: [] } },
        credentials: { anonymous: {} },
        subjects: {},
      }),
      now: () => '2026-09-19T00:00:00.000Z',
    });
    try {
      const bound = await post(
        witness.url,
        '/runs/behavior-catalog',
        {
          catalog: catalogForCase(item),
          assignments: { [TEST_ID]: [item.caseId] },
          routes: ROUTES,
          authorityProfileDigest: AUTH_DIGEST,
        },
        { [VERIFIER_HEADER]: VERIFIER_KEY },
      );
      expect(bound.status).toBe(200);
      const opened = (await (
        await fetch(`${witness.url}/sessions/open`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', [RUN_HEADER]: TOKEN, [VERIFIER_HEADER]: VERIFIER_KEY },
          body: JSON.stringify({ testId: TEST_ID, workerIndex: 0 }),
        })
      ).json()) as { sessionId: string; sessionToken: string };
      const executed = await post(witness.url, '/behavior/execute', {
        sessionId: opened.sessionId,
        sessionToken: opened.sessionToken,
        caseId: item.caseId,
      });
      expect(executed.status).toBe(200);
      const sealed = await post(witness.url, '/behavior/principal', {
        sessionId: opened.sessionId,
        sessionToken: opened.sessionToken,
        executionId: (executed.body as { executionId: string }).executionId,
      });
      expect(sealed.status).toBe(200);
      const ledger = await (await fetch(`${witness.url}/records`, { headers: { [RUN_HEADER]: TOKEN } })).json() as {
        records: Array<Record<string, unknown>>;
      };
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
          catalog: catalogForCase(item) as never,
          requirements: { [obligationId(item.definition.contract)]: [item.caseId] },
          authorityProfileDigest: AUTH_DIGEST,
          plannedTestIds: [TEST_ID],
        },
        httpRoutes: ROUTES as never,
      });
      // The 400 is declared, but the smuggled outbox row is a forbidden
      // business mutation: unexpected effect.
      expect(outcome.status).toBe('invalid');
      expect((outcome as { reason: string }).reason).toMatch(/UNEXPECTED_EFFECT/);
    } finally {
      await witness.stop();
      await new Promise<void>((resolve) => stub.close(() => resolve()));
    }
  });
});
