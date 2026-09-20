/**
 * Workflow/task/webhook semantics (plan 2026-09-19 §8.3–8.5, Phase 8):
 * the remaining domain contracts proved through actual engine-controlled
 * requests against the REAL example servers, graded across required
 * cases with independent file-mediated state scopes. The trusted
 * harness owns delivery identity (idempotency keys), the finite attempt
 * schedule, and webhook signing over exact bytes.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';
import { randomUUID, createHmac } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { startWitness } from '../src/witness/server.js';
import { createMemoryFixtureProvider } from '../src/witness/fixture-provider.js';
import { evaluateRequiredCases } from '@gate-forge/core';
// The domain examples are untyped checked-in fixtures (not workspace packages).
// @ts-expect-error: no declaration file for the example fixture
import { createApp as createTaskApp, createTaskState } from '../../../example/task/server.js';
// @ts-expect-error: no declaration file for the example fixture
import { createWebhookState } from '../../../example/webhook/server.js';
// The workflow example reads AUDIT_FILE at module load; the harness sets
// the env first and imports dynamically inside the test.
type WorkflowModule = { createApp: (options: unknown) => { server: import('node:http').Server } };
let createWorkflowApp: WorkflowModule['createApp'] | null = null;
import { RUN_HEADER, VERIFIER_HEADER } from '../src/constants.js';

const TOKEN = 'domain-run-token';
const VERIFIER_KEY = 'domain-verifier-the-suite-never-sees';
const TEST_ID = 'playwright:chromium:e2e/domain.spec.ts:domain semantics';
const AUTH_DIGEST = 'a'.repeat(64);
const WEBHOOK_SECRET = 'gateforge-webhook-loopback-secret-v1';

function hex(seed: string): string {
  return seed.repeat(64).slice(0, 64);
}

interface DomainCase {
  caseId: string;
  endpoint: string;
  contract: string;
  definition: Record<string, unknown>;
  effects: Array<{ id: string; resourceId: string; adapter: string; scope: string; identityFields: string[]; fields: string[]; completion: 'immediate' }>;
}

function endpointId(route: string): string {
  return `tenant.http-${route}`;
}

function requestDef(slug: string, contract: string, endpoint: string, method: string, pathTemplate: string, body: unknown, statuses: number[], state: unknown[], response: unknown[] = [], controlCase?: string, signatureProfile?: string, actionPath?: Record<string, { from: string; value?: unknown }>, credentialVariant?: 'valid' | 'missing' | 'corrupted') {
  return {
    id: slug,
    contract,
    channel: 'engine-http',
    fixture: 'domain-fixture',
    actor: 'anonymous',
    action: {
      kind: 'request',
      method,
      pathTemplate,
      path: actionPath ?? {},
      query: {},
      body,
      credentialVariant: credentialVariant ?? 'valid',
      ...(signatureProfile === undefined ? {} : { signatureProfile }),
    },
    expect: { statuses, response, state },
    ...(controlCase === undefined ? {} : { controlCase }),
  };
}

const SUBMIT_BODY = {
  encoding: 'json' as const,
  fields: {
    actor: { from: 'literal', value: 'owner-a' },
    event: { from: 'literal', value: 'submit' },
  },
};
const REJECT_BODY = {
  encoding: 'json' as const,
  fields: {
    actor: { from: 'literal', value: 'owner-a' },
    event: { from: 'literal', value: 'sign' },
  },
};

const ENROLL_PATH = { id: { from: 'literal', value: 'con-1' } };

const WORKFLOW_CASES: DomainCase[] = [
  {
    caseId: hex('01'),
    endpoint: endpointId('contracts-transitions'),
    contract: 'workflow:transition-allowed',
    effects: [
      { id: 'contracts', resourceId: 'tenant.contracts', adapter: 'domain', scope: 'contracts', identityFields: ['id'], fields: ['status'], completion: 'immediate' },
      { id: 'audit', resourceId: 'tenant.audit', adapter: 'domain', scope: 'audit', identityFields: ['id'], fields: ['actor', 'from', 'to'], completion: 'immediate' },
    ],
    definition: {
      ...requestDef(
        'transition-allowed',
        'workflow:transition-allowed',
        'contracts-transitions',
        'POST',
        '/contracts/{id}/transitions',
        SUBMIT_BODY,
        [200],
        [
          {
            kind: 'transition',
            scope: 'contracts',
            subject: { from: 'literal', value: 'con-1' },
            field: 'status',
            from: { from: 'literal', value: 'draft' },
            to: { from: 'literal', value: 'pending' },
          },
          {
            kind: 'append-only',
            scope: 'audit',
            rows: [
              {
                fields: {
                  actor: { from: 'literal', value: 'owner-a' },
                  from: { from: 'literal', value: 'draft' },
                  to: { from: 'literal', value: 'pending' },
                },
              },
            ],
          },
        ],
        undefined,
        undefined,
        undefined,
        { id: { from: 'literal', value: 'con-1' } },
      ),
    },
  },
  {
    caseId: hex('02'),
    endpoint: endpointId('contracts-transitions'),
    contract: 'workflow:transition-rejected',
    effects: [
      { id: 'contracts', resourceId: 'tenant.contracts', adapter: 'domain', scope: 'contracts', identityFields: ['id'], fields: ['status'], completion: 'immediate' },
    ],
    definition: {
      ...requestDef(
        'transition-rejected',
        'workflow:transition-rejected',
        'contracts-transitions',
        'POST',
        '/contracts/{id}/transitions',
        REJECT_BODY,
        [409],
        [{ kind: 'unchanged', scope: 'contracts' }],
        [{ kind: 'absent', pointer: '/status' }],
        'transition-allowed',
        undefined,
        { id: { from: 'literal', value: 'con-1' } },
      ),
    },
  },
];

const TASK_CASES: DomainCase[] = [
  {
    caseId: hex('11'),
    endpoint: endpointId('task-enqueue'),
    contract: 'task:idempotent',
    effects: [
      { id: 'effects', resourceId: 'tenant.task-effects', adapter: 'domain', scope: 'effects', identityFields: ['id'], fields: ['key'], completion: 'immediate' },
    ],
    definition: requestDef(
      'idempotent-duplicate',
      'task:idempotent',
      'task-enqueue',
      'POST',
      '/enqueue',
      {
        encoding: 'json' as const,
        fields: {
          name: { from: 'literal', value: 'task.email.send' },
          key: { from: 'literal', value: 'key-shared' },
          profile: { from: 'literal', value: 'duplicate' },
        },
      },
      [202],
      [
        {
          kind: 'exact-set',
          scope: 'effects',
          rows: [{ subject: { from: 'literal', value: 'effect-0' }, fields: { key: { from: 'literal', value: 'key-shared' } } }],
        },
      ],
    ),
  },
  {
    caseId: hex('12'),
    endpoint: endpointId('task-enqueue'),
    contract: 'task:terminal-handled',
    effects: [
      { id: 'effects', resourceId: 'tenant.task-effects', adapter: 'domain', scope: 'effects', identityFields: ['id'], fields: ['key'], completion: 'immediate' },
    ],
    definition: requestDef(
      'terminal-once',
      'task:terminal-handled',
      'task-enqueue',
      'POST',
      '/enqueue',
      {
        encoding: 'json' as const,
        fields: {
          name: { from: 'literal', value: 'task.email.send' },
          key: { from: 'literal', value: 'key-terminal' },
          profile: { from: 'literal', value: 'terminal' },
        },
      },
      [202],
      [
        {
          kind: 'unchanged',
          scope: 'effects',
        },
      ],
    ),
  },
];

const WEBHOOK_CASES: DomainCase[] = [
  {
    caseId: hex('21'),
    endpoint: endpointId('webhook-stripe'),
    contract: 'webhook:signature-accepted',
    effects: [
      { id: 'deliveries', resourceId: 'tenant.deliveries', adapter: 'domain', scope: 'deliveries', identityFields: ['id'], fields: ['eventId'], completion: 'immediate' },
    ],
    definition: requestDef(
      'signature-accepted',
      'webhook:signature-accepted',
      'webhook-stripe',
      'POST',
      '/webhook/stripe',
      {
        encoding: 'raw' as const,
        fixture: 'signed-event',
      },
      [200],
      [
        {
          kind: 'created',
          scope: 'deliveries',
          rows: [{ fields: { eventId: { from: 'literal', value: 'evt-signed' } } }],
        },
      ],
      [{ kind: 'equals', pointer: '/ok', value: { from: 'literal', value: true } }],
      undefined,
      'hmac-sha256',
    ),
  },
  {
    caseId: hex('22'),
    endpoint: endpointId('webhook-stripe'),
    contract: 'webhook:signature-rejected',
    effects: [
      { id: 'deliveries', resourceId: 'tenant.deliveries', adapter: 'domain', scope: 'deliveries', identityFields: ['id'], fields: ['eventId'], completion: 'immediate' },
    ],
    definition: {
      ...requestDef(
        'signature-rejected',
        'webhook:signature-rejected',
        'webhook-stripe',
        'POST',
        '/webhook/stripe',
        {
          encoding: 'raw' as const,
          fixture: 'tampered-event',
        },
        [401],
        [{ kind: 'unchanged', scope: 'deliveries' }],
        [],
        'signature-accepted',
        'hmac-sha256',
        undefined,
        'corrupted',
      ),
    },
  },
];

const ALL_CASES = [...WORKFLOW_CASES, ...TASK_CASES, ...WEBHOOK_CASES];

/** Engine-side fixture bytes for raw bodies (subjects carry the exact bytes). */
const DOMAIN_SUBJECTS: Record<string, Record<string, unknown>> = {
  'domain-fixture': {
    'signed-event': JSON.stringify({ event_id: 'evt-signed', type: 'payment.completed' }),
    'tampered-event': JSON.stringify({ event_id: 'evt-signed', type: 'payment.failed' }),
  },
};

/** Credential material incl. the signing secret the driver consumes (never sent). */
function domainCredentials() {
  return {
    anonymous: {
      'x-gateforge-signing-secret': WEBHOOK_SECRET,
    },
  };
}

function fileSnapshot(adaptersDir: string, stateDir: string) {
  mkdirSync(adaptersDir, { recursive: true });
  const scopeFiles: Record<string, string> = {};
  for (const item of ALL_CASES) {
    for (const effect of item.effects) {
      scopeFiles[effect.scope] = join(stateDir, `${effect.scope}.json`);
    }
  }
  for (const [, path] of Object.entries(scopeFiles)) {
    if (!existsSync(path)) {
      writeFileSync(path, `${JSON.stringify({ checkpoint: '0', entities: [] })}\n`);
    }
  }
  writeFileSync(
    join(adaptersDir, 'domain.mjs'),
    [
      "import { readFileSync, existsSync } from 'node:fs';",
      "import { join, dirname } from 'node:path';",
      "import { fileURLToPath } from 'node:url';",
      `const STATE_DIR = ${JSON.stringify(stateDir)};`,
      'const FILES = ' + JSON.stringify(scopeFiles) + ';',
      'export default {',
      '  async read() { return null; },',
      '  normalize() { return { entityId: null, fields: {} }; },',
      "  deletion: 'hard',",
      "  environmentFingerprint: 'domain-test-fp',",
      '  async snapshotScope(ctx, input) {',
      '    const path = FILES[input.scope] ?? join(STATE_DIR, `${input.fixtureNamespace}.json`);',
      '    const stored = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : { checkpoint: "0", entities: [] };',
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

/** Boots one case: its app on its own state + a dedicated witness. */
async function runCase(item: DomainCase, options: {
  adaptersDir: string;
  runId: string;
  catalogCases?: DomainCase[];
  buildApp: () => Promise<{ server: import('node:http').Server; before: () => void; after: () => void; snapshot(): unknown }>;
  credentialVariant: 'valid' | 'corrupted';
}): Promise<{ sealStatus: number; records: Array<Record<string, unknown>> }> {
  const { server, before, after, snapshot } = await options.buildApp();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no app port');
  const witness = await startWitness({
    runId: options.runId,
    token: TOKEN,
    verifierKey: VERIFIER_KEY,
    adaptersDir: options.adaptersDir,
    targetBaseUrl: `http://127.0.0.1:${String(address.port)}`,
    fixtureProvider: createMemoryFixtureProvider({
      actors: { anonymous: { principalId: 'anonymous', tenantId: null, roles: [] } },
      credentials: domainCredentials(),
      subjects: DOMAIN_SUBJECTS,
    }),
    now: () => '2026-09-19T00:00:00.000Z',
  });
  try {
    before();
    const catalogCases = (options.catalogCases ?? [item]).map((entry) => ({
      caseId: entry.caseId,
      specDigest: hex('e'),
      resourceId: entry.endpoint,
      endpointResourceId: entry.endpoint,
      obligationIds: [`${entry.endpoint}:${entry.contract}`],
      definition: entry.definition,
      effects: entry.effects,
      sourceFiles: ['example'],
    }));
    const bound = await post(
      witness.url,
      '/runs/behavior-catalog',
      {
        catalog: {
          schemaVersion: 1,
          catalogDigest: hex('f'),
          cases: catalogCases,
          requirements: { [`${item.endpoint}:${item.contract}`]: [item.caseId] },
          dependencies: {},
        },
        assignments: { [TEST_ID]: [item.caseId] },
        routes: [
          {
            resourceId: item.endpoint,
            method: 'POST',
            // Route shapes use `{}` wildcards (core pathMatchesShape), not named params.
            canonicalPath: (item.definition as { action: { pathTemplate: string } }).action.pathTemplate.replace(/\{[^/]+\}/g, '{}'),
          },
        ],
        authorityProfileDigest: AUTH_DIGEST,
      },
      { [VERIFIER_HEADER]: VERIFIER_KEY },
    );
    expect(bound.status, item.contract + ': ' + JSON.stringify(bound.body)).toBe(200);
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
    expect(executed.status, item.contract).toBe(200);
    const sealed = await post(witness.url, '/behavior/principal', {
      sessionId: opened.sessionId,
      sessionToken: opened.sessionToken,
      executionId: (executed.body as { executionId: string }).executionId,
    });
    expect(sealed.status, item.contract + ": " + JSON.stringify(sealed.body)).toBe(200);
    const ledger = await (await fetch(`${witness.url}/records`, { headers: { [RUN_HEADER]: TOKEN } })).json() as {
      records: Array<Record<string, unknown>>;
    };
    after();
    void snapshot;
    return { sealStatus: sealed.status, records: ledger.records };
  } finally {
    await witness.stop();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function gradeCase(item: DomainCase, records: Array<Record<string, unknown>>) {
  const outcome = evaluateRequiredCases({
    obligation: {
      schemaVersion: 1,
      id: `${item.endpoint}:${item.contract}`,
      resourceId: item.endpoint,
      contract: item.contract,
      policyId: 'behavior-policy',
      lifecycle: { create: true, read: true, update: true, delete: true, deleteSemantics: 'hard' },
    } as never,
    requiredCaseIds: [item.caseId],
    records: records as never,
    context: {
      catalog: {
        schemaVersion: 1,
        catalogDigest: hex('f'),
        cases: [
          {
            caseId: item.caseId,
            specDigest: hex('e'),
            resourceId: item.endpoint,
            endpointResourceId: item.endpoint,
            obligationIds: [`${item.endpoint}:${item.contract}`],
            definition: item.definition,
            effects: item.effects,
            sourceFiles: ['example'],
          },
        ],
        requirements: { [`${item.endpoint}:${item.contract}`]: [item.caseId] },
        dependencies: {},
      } as never,
      requirements: { [`${item.endpoint}:${item.contract}`]: [item.caseId] },
      authorityProfileDigest: AUTH_DIGEST,
      plannedTestIds: [TEST_ID],
    },
    httpRoutes: [
      {
        resourceId: item.endpoint,
        method: 'POST',
        canonicalPath: (item.definition as { action: { pathTemplate: string } }).action.pathTemplate.replace(/\{[^/]+\}/g, '{}'),
      },
    ] as never,
  });
  return outcome;
}

describe('domain contracts end to end (workflow/task/webhook)', () => {
  it('workflow: allowed transition persists state + actor-qualified audit; rejection changes nothing', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gateforge-domain-wf-'));
    const adaptersDir = join(root, 'adapters');
    const stateDir = join(root, 'state');
    mkdirSync(stateDir, { recursive: true });
    fileSnapshot(adaptersDir, stateDir);
    const runId = randomUUID();
    // Allowed case.
    {
      const contracts = new Map<string, Record<string, unknown>>();
      const item = WORKFLOW_CASES[0] as DomainCase;
      // The example workflow app appends audit rows to AUDIT_FILE; point
      // it at the trusted scope file the adapter snapshots.
      const auditFile = join(stateDir, 'audit-w1.json');
      process.env['AUDIT_FILE'] = auditFile;
      // @ts-expect-error untyped example fixture
      const workflowModule = (await import('../../../example/workflow/server.js')) as unknown as WorkflowModule;
      createWorkflowApp = workflowModule.createApp;
      const writeContracts = (status: string, checkpoint: string): void => {
        writeFileSync(
          join(stateDir, 'contracts.json'),
          `${JSON.stringify({ checkpoint, entities: [{ entityId: 'con-1', fields: { id: 'con-1', status } }] })}\n`,
        );
      };
      const writeAudit = (): void => {
        const rows = existsSync(auditFile)
          ? (JSON.parse(readFileSync(auditFile, 'utf8')) as Array<Record<string, unknown>>)
          : [];
        writeFileSync(
          join(stateDir, 'audit.json'),
          `${JSON.stringify({ checkpoint: `a${String(rows.length)}`, entities: rows.map((entry, i) => ({ entityId: String(i), fields: entry })) })}\n`,
        );
      };
      // The scope file must reflect the app's mutation AT the moment it
      // happens (the witness after-snapshot runs during the principal,
      // before the harness regains control). Define the contract with a
      // status setter that projects each app write into the scope file.
      const con1: Record<string, unknown> = { id: 'con-1', history: ['draft'] };
      let con1Status = 'draft';
      Object.defineProperty(con1, 'status', {
        configurable: true,
        get: () => con1Status,
        set: (next: string) => {
          con1Status = next;
          writeContracts(next, `c-${next}`);
          // The app appends its audit row right after the status write;
          // defer the audit projection one microtask so it includes it.
          queueMicrotask(() => writeAudit());
        },
      });
      contracts.set('con-1', con1);
      const result = await runCase(item, {
        adaptersDir,
        runId,
        buildApp: async () => {
          const { server } = createWorkflowApp!({
            store: {
              get: (id: string) => contracts.get(id) ?? null,
              list: () => [...contracts.values()],
            },
            clock: { now: () => new Date('2026-09-19T00:00:00.000Z') },
          }) as { server: import('node:http').Server };
          return {
            server,
            before: () => {
              // Seed the trusted scope files the adapter snapshots.
              writeContracts('draft', 'c-draft');
              writeAudit();
            },
            after: () => undefined,
            snapshot: () => undefined,
          };
        },
        credentialVariant: 'valid',
      });
      expect(result.sealStatus).toBe(200);
      const outcome = gradeCase(item, result.records);
      expect(outcome.status, (outcome as { reason: string }).reason ?? '').toBe('satisfied');
    }
    // Rejection case.
    {
      const contracts = new Map<string, Record<string, unknown>>();
      contracts.set('con-1', { id: 'con-1', status: 'active' });
      const item = WORKFLOW_CASES[1] as DomainCase;
      const result = await runCase(item, {
        adaptersDir,
        runId: randomUUID(),
        catalogCases: WORKFLOW_CASES,
        buildApp: async () => {
          const { server } = createWorkflowApp!({
            store: {
              get: (id: string) => contracts.get(id) ?? null,
              list: () => [...contracts.values()],
            },
            clock: { now: () => new Date('2026-09-19T00:00:00.000Z') },
          }) as { server: import('node:http').Server };
          return {
            server,
            before: () => {
              writeFileSync(
                join(stateDir, 'contracts.json'),
                `${JSON.stringify({ checkpoint: 'c1', entities: [{ entityId: 'con-1', fields: { id: 'con-1', status: 'active' } }] })}\n`,
              );
            },
            after: () => {
              writeFileSync(
                join(stateDir, 'contracts.json'),
                `${JSON.stringify({ checkpoint: 'c1', entities: [{ entityId: 'con-1', fields: { id: 'con-1', status: 'active' } }] })}\n`,
              );
            },
            snapshot: () => undefined,
          };
        },
        credentialVariant: 'valid',
      });
      expect(result.sealStatus).toBe(200);
      const outcome = gradeCase(item, result.records);
      expect(outcome.status, (outcome as { reason: string }).reason ?? '').toBe('satisfied');
    }
  });

  it('task: duplicate key produces exactly one effect; terminal error produces none', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gateforge-domain-task-'));
    const adaptersDir = join(root, 'adapters');
    const stateDir = join(root, 'state');
    mkdirSync(stateDir, { recursive: true });
    fileSnapshot(adaptersDir, stateDir);
    // Idempotent case: same key enqueued twice through the engine driver —
    // the second enqueue is DEDUPED by the app, so the trusted scope sees
    // exactly one effect entity.
    {
      const state = createTaskState();
      const effectsFile = join(stateDir, 'effects.json');
      const writeEffects = (): void => {
        const count = state.sideEffectCount('task.email.send');
        writeFileSync(
          effectsFile,
          `${JSON.stringify({ checkpoint: `e${String(count)}`, entities: Array.from({ length: count }, (_, i) => ({ entityId: `effect-${String(i)}`, fields: { key: 'key-shared' } })) })}\n`,
        );
      };
      const originalIncrement = state.incrementSideEffect.bind(state);
      state.incrementSideEffect = (name: string) => {
        const next = originalIncrement(name);
        writeEffects();
        return next;
      };
      const item = TASK_CASES[0] as DomainCase;
      const result = await runCase(item, {
        adaptersDir,
        runId: randomUUID(),
        buildApp: async () => {
          const server = createTaskApp(state);
          return {
            server,
            before: () => writeEffects(),
            after: () => writeEffects(),
            snapshot: () => undefined,
          };
        },
        credentialVariant: 'valid',
      });
      expect(result.sealStatus).toBe(200);
      const outcome = gradeCase(item, result.records);
      expect(outcome.status, (outcome as { reason: string }).reason ?? '').toBe('satisfied');
    }
    // Terminal case: AuthError is terminal — no side effect, no retry.
    {
      const state = createTaskState();
      const effectsFile = join(stateDir, 'effects.json');
      const writeEffects = (): void => {
        const count = state.sideEffectCount('task.email.send');
        writeFileSync(
          effectsFile,
          `${JSON.stringify({ checkpoint: `e${String(count)}`, entities: Array.from({ length: count }, (_, i) => ({ entityId: `effect-${String(i)}`, fields: {} })) })}\n`,
        );
      };
      const originalIncrement = state.incrementSideEffect.bind(state);
      state.incrementSideEffect = (name: string) => {
        const next = originalIncrement(name);
        writeEffects();
        return next;
      };
      const item = TASK_CASES[1] as DomainCase;
      const result = await runCase(item, {
        adaptersDir,
        runId: randomUUID(),
        buildApp: async () => {
          const server = createTaskApp(state);
          return {
            server,
            before: () => writeEffects(),
            after: () => writeEffects(),
            snapshot: () => undefined,
          };
        },
        credentialVariant: 'valid',
      });
      expect(result.sealStatus).toBe(200);
      const outcome = gradeCase(item, result.records);
      expect(outcome.status, (outcome as { reason: string }).reason ?? '').toBe('satisfied');
    }

    // B33: concurrent duplicate deliveries race the SAME key — the app's
    // idempotency dedupe must still yield exactly one effect entity.
    {
      const state = createTaskState();
      const effectsFile = join(stateDir, 'effects.json');
      const writeEffects = (): void => {
        const count = state.sideEffectCount('task.email.send');
        writeFileSync(
          effectsFile,
          `${JSON.stringify({ checkpoint: `e${String(count)}`, entities: Array.from({ length: count }, (_, i) => ({ entityId: `effect-${String(i)}`, fields: { key: 'key-race' } })) })}\n`,
        );
      };
      const originalIncrement = state.incrementSideEffect.bind(state);
      state.incrementSideEffect = (name: string) => {
        const next = originalIncrement(name);
        writeEffects();
        return next;
      };
      const raceServer = createTaskApp(state);
      await new Promise<void>((resolve) => raceServer.listen(0, '127.0.0.1', resolve));
      const raceAddress = raceServer.address();
      if (raceAddress === null || typeof raceAddress === 'string') throw new Error('no race app port');
      const raceBase = `http://127.0.0.1:${String(raceAddress.port)}`;
      const raceBody = JSON.stringify({ name: 'task.email.send', key: 'key-race', profile: 'duplicate', payload: {} });
      const [resA, resB] = await Promise.all([
        fetch(`${raceBase}/enqueue`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: raceBody }),
        fetch(`${raceBase}/enqueue`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: raceBody }),
      ]);
      const [jsonA, jsonB] = (await Promise.all([resA.json(), resB.json()])) as [
        { sideEffectCount: number },
        { sideEffectCount: number },
      ];
      expect(jsonA.sideEffectCount).toBe(1);
      expect(jsonB.sideEffectCount).toBe(1);
      expect(state.sideEffectCount('task.email.send')).toBe(1);
      writeEffects();
      const persisted = JSON.parse(readFileSync(effectsFile, 'utf8')) as { entities: unknown[] };
      expect(persisted.entities).toHaveLength(1);
      raceServer.close();
    }
  });

  it('webhook: valid signature creates the delivery; tampered bytes rejected with none', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gateforge-domain-hook-'));
    const adaptersDir = join(root, 'adapters');
    const stateDir = join(root, 'state');
    mkdirSync(stateDir, { recursive: true });
    fileSnapshot(adaptersDir, stateDir);
    const SIGNED_BYTES = JSON.stringify({ event_id: 'evt-signed', type: 'payment.completed' });
    const sign = (body: string): string =>
      createHmac('sha256', WEBHOOK_SECRET).update(body).digest('hex');
    // Accepted case: the ENGINE computes the signature over the exact raw
    // fixture bytes (binding secret is engine-side only) and sends them.
    {
      const item = WEBHOOK_CASES[0] as DomainCase;
      const deliveriesFile = join(stateDir, 'deliveries.json');
      const writeDeliveries = (count: number): void => {
        writeFileSync(
          deliveriesFile,
          `${JSON.stringify({
            checkpoint: `d${String(count)}`,
            entities: Array.from({ length: count }, (_, i) => ({ entityId: `evt-${String(i)}`, fields: { eventId: i === 0 ? 'evt-signed' : `evt-${String(i)}` } })),
          })}\n`,
        );
      };
      writeDeliveries(0);
      const result = await runCase(item, {
        adaptersDir,
        runId: randomUUID(),
        buildApp: async () => {
          const server = createServer((req, res) => {
            let chunks: Buffer[] = [];
            req.on('data', (chunk: Buffer) => chunks.push(chunk));
            req.on('end', () => {
              const raw = Buffer.concat(chunks).toString('utf8');
              const expected = sign(raw);
              const provided = req.headers['x-signature'];
              if (provided !== expected) {
                res.writeHead(401, { 'content-type': 'application/json' });
                res.end(JSON.stringify({ error: 'bad-signature' }));
                return;
              }
              writeDeliveries(1);
              res.writeHead(200, { 'content-type': 'application/json' });
              res.end(JSON.stringify({ ok: true, deduplicated: false, eventId: 'evt-signed' }));
            });
          });
          return { server, before: () => undefined, after: () => undefined, snapshot: () => undefined };
        },
        credentialVariant: 'valid',
      });
      expect(result.sealStatus).toBe(200);
      const outcome = gradeCase(item, result.records);
      expect(outcome.status, (outcome as { reason: string }).reason ?? '').toBe('satisfied');
    }
    // Rejected case: the driver sends the tampered fixture bytes with the
    // signature over the SIGNED bytes — the app verifies over the exact
    // received bytes and rejects; the trusted scope shows zero delta.
    {
      const item = WEBHOOK_CASES[1] as DomainCase;
      const deliveriesFile = join(stateDir, 'deliveries.json');
      const writeEmpty = (): void => {
        writeFileSync(deliveriesFile, `${JSON.stringify({ checkpoint: 'd0', entities: [] })}\n`);
      };
      writeEmpty();
      const result = await runCase(item, {
        adaptersDir,
        runId: randomUUID(),
        buildApp: async () => {
          const server = createServer((req, res) => {
            let chunks: Buffer[] = [];
            req.on('data', (chunk: Buffer) => chunks.push(chunk));
            req.on('end', () => {
              const raw = Buffer.concat(chunks).toString('utf8');
              const expected = sign(raw);
              const provided = req.headers['x-signature'];
              if (provided !== expected) {
                writeEmpty();
                res.writeHead(401, { 'content-type': 'application/json' });
                res.end(JSON.stringify({ error: 'bad-signature' }));
                return;
              }
              writeFileSync(
                deliveriesFile,
                `${JSON.stringify({ checkpoint: 'd1', entities: [{ entityId: 'evt-x', fields: { eventId: 'evt-x' } }] })}\n`,
              );
              res.writeHead(200, { 'content-type': 'application/json' });
              res.end(JSON.stringify({ ok: true, deduplicated: false }));
            });
          });
          return { server, before: () => undefined, after: () => undefined, snapshot: () => undefined };
        },
        credentialVariant: 'valid',
      });
      expect(result.sealStatus).toBe(200);
      const outcome = gradeCase(item, result.records);
      expect(outcome.status, (outcome as { reason: string }).reason ?? '').toBe('satisfied');
    }
  });
});
