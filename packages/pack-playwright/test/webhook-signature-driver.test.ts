/**
 * The webhook signature driver against the pack's REAL example receiver
 * (plan 2026-09-25 Phase 1): the receiver's own handler, a real witness,
 * engine-side signing over the exact raw bytes, and a trusted scope the
 * engine reads itself — the referee pokes and then looks by itself.
 *
 * Cases, all engine-driven (the harness never posts a webhook itself):
 *   - a valid signature is accepted and the log gains exactly one row;
 *   - a forged signature is rejected 401 and the log is UNCHANGED;
 *   - a replay of the accepted event leaves the log unchanged (one row);
 *   - an over-limit body and a stale stamp both fail closed in the
 *     driver, before any request reaches the receiver;
 *   - the engine-side secret appears in NO sealed record.
 */
import type { Server } from 'node:http';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
// The pack's own example receiver: the REAL handler, not a stand-in.
// @ts-expect-error: no declaration file for the example fixture
import { createWebhookState, startWebhookServer } from '../../../example/webhook/server.js';
import { startWitness } from '../src/witness/server.js';
import { createMemoryFixtureProvider } from '../src/witness/fixture-provider.js';
import { evaluateRequiredCases, type BehaviorSignatureProfile } from '@gate-forge/core';
import { RUN_HEADER, VERIFIER_HEADER } from '../src/constants.js';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const TOKEN = 'webhook-signature-run-token';
const VERIFIER_KEY = 'webhook-signature-verifier-the-suite-never-sees';
const TEST_ID = 'playwright:chromium:e2e/webhook-signature.spec.ts:webhook signature cases';
const AUTH_DIGEST = 'a'.repeat(64);
const ENDPOINT = 'global.http-post-webhook-stripe-1fd2bace';
/** The receiver's own loopback secret; the driver only ever signs with it. */
const WEBHOOK_SECRET = 'gateforge-webhook-loopback-secret-v1';
/** The exact bytes one delivery carries. */
const ACCEPTED_BYTES = JSON.stringify({ event_id: 'evt-accepted', type: 'payment.completed' });

function hex(seed: string): string {
  return seed.repeat(64).slice(0, 64);
}

/** One declared case: the driver action plus what the owner expects. */
interface WebhookCase {
  caseId: string;
  contract: string;
  profile: string;
  statuses: number[];
  state: unknown[];
  controlCase?: string;
  subjects?: Record<string, unknown>;
}

/** Builds one required case over the shared endpoint + delivery scope. */
function webhookCase(overrides: Partial<WebhookCase> & { id: string }): WebhookCase & { definition: Record<string, unknown> } {
  const caseId = createHash('sha256').update(`case:${overrides.id}`).digest('hex');
  const definition = {
    id: overrides.id,
    contract: overrides.contract ?? 'webhook:signature-accepted',
    channel: 'engine-http',
    fixture: 'webhook-deliveries',
    actor: 'provider',
    ...(overrides.controlCase === undefined ? {} : { controlCase: overrides.controlCase }),
    action: {
      kind: 'request',
      method: 'POST',
      pathTemplate: '/webhook/stripe',
      path: {},
      query: {},
      body: { encoding: 'raw', fixture: 'accepted-event' },
      credentialVariant: 'valid',
      signatureProfile: overrides.profile ?? 'hmac-sha256',
    },
    expect: { statuses: overrides.statuses ?? [200], response: [], state: overrides.state ?? [] },
  };
  return {
    caseId,
    contract: definition.contract as string,
    profile: overrides.profile ?? 'hmac-sha256',
    statuses: overrides.statuses ?? [200],
    state: overrides.state ?? [],
    ...(overrides.controlCase === undefined ? {} : { controlCase: overrides.controlCase }),
    ...(overrides.subjects === undefined ? {} : { subjects: overrides.subjects }),
    definition,
  };
}

const EFFECTS = [
  {
    id: 'deliveries',
    resourceId: 'global.deliveries',
    adapter: 'deliveries',
    scope: 'deliveries',
    identityFields: ['eventId'],
    fields: ['eventId', 'sideEffectCount'],
    completion: 'immediate' as const,
  },
];

/**
 * The reviewed adapter: it reads the TRUSTED scope file the harness
 * mirrors from the receiver's own state — never the receiver's HTTP
 * answer, which the witness refuses as snapshot evidence.
 */
const ADAPTER_TEMPLATE = `import { readFileSync, existsSync } from 'node:fs';
const SCOPE_FILE = process.env.GATEFORGE_WEBHOOK_SCOPE_FILE;
export default {
  async read() { return null; },
  normalize() { return { entityId: null, fields: {} }; },
  deletion: 'hard',
  environmentFingerprint: 'example-webhook-v1',
  async snapshotScope(ctx, input) {
    const stored = existsSync(SCOPE_FILE) ? JSON.parse(readFileSync(SCOPE_FILE, 'utf8')) : { checkpoint: '0', entities: [] };
    return { scope: input.scope, fixtureNamespace: input.fixtureNamespace, complete: true, checkpoint: stored.checkpoint, entities: stored.entities, exhausted: true };
  },
};
`;

/**
 * Writes the adapter into a fresh adapters directory.
 *
 * Args:
 *   scopeFile: the trusted scope file the adapter snapshots.
 *
 * Returns:
 *   string: the adapters directory the witness loads from.
 */
function adaptersDir(scopeFile: string): string {
  const root = mkdtempSync(join(tmpdir(), 'gateforge-webhook-signature-'));
  const dir = join(root, 'adapters');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'deliveries.mjs'), ADAPTER_TEMPLATE);
  process.env['GATEFORGE_WEBHOOK_SCOPE_FILE'] = scopeFile;
  return dir;
}

interface Receiver {
  url: string;
  scopeFile: string;
  rows: () => Array<Record<string, unknown>>;
  stop: () => Promise<void>;
}

/**
 * Boots the REAL receiver over a harness-owned state, mirroring every
 * delivery-log write into the trusted scope file (the same
 * file-mediated trust boundary the other domain cases use).
 */
async function startReceiver(): Promise<Receiver> {
  const root = mkdtempSync(join(tmpdir(), 'gateforge-webhook-receiver-'));
  const scopeFile = join(root, 'deliveries.json');
  const state = createWebhookState() as { deliveryLog: Map<string, Record<string, unknown>> };
  const mirror = (log: Map<string, Record<string, unknown>>): void => {
    const entities = [...log.values()].map((row) => ({ entityId: row['eventId'], fields: row }));
    writeFileSync(scopeFile, `${JSON.stringify({ checkpoint: `d${String(entities.length)}`, entities })}\n`);
  };
  // A Map SUBCLASS (not a Proxy — Map internals reject a proxied
  // receiver) whose every write mirrors the trusted scope.
  class MirroredLog extends Map<string, Record<string, unknown>> {
    override set(key: string, value: Record<string, unknown>): this {
      const result = super.set(key, value);
      mirror(this);
      return result;
    }
  }
  const log = new MirroredLog();
  state.deliveryLog = log;
  mirror(log);
  const { server } = (await startWebhookServer(0, state)) as { server: Server };
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no receiver port');
  return {
    url: `http://127.0.0.1:${String(address.port)}`,
    scopeFile,
    rows: () => [...log.values()],
    stop: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function post(url: string, path: string, body: unknown, extra: Record<string, string> = {}): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${url}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', [RUN_HEADER]: TOKEN, [VERIFIER_HEADER]: VERIFIER_KEY, ...extra },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as unknown };
}

interface RunResult {
  /** Principal seal status per driven case, in drive order. */
  seals: Array<{ caseId: string; status: number; body: unknown }>;
  records: Array<Record<string, unknown>>;
}

/**
 * Drives the declared cases through ONE real witness bound to the
 * receiver, in order, over one catalog — exactly what a supervised run
 * does. A rejected contract's control case is a record from ANOTHER
 * obligation, so the cases that grade together must share the run.
 *
 * Args:
 *   receiver: the running example receiver.
 *   items: the declared cases, in drive order.
 *   extraSubjects: additional lease subjects for the whole run.
 *
 * Returns:
 *   RunResult: per-case seal outcomes plus every sealed record.
 */
async function runCases(
  receiver: Receiver,
  items: ReadonlyArray<WebhookCase & { definition: Record<string, unknown> }>,
  extraSubjects: Record<string, unknown> = {},
): Promise<RunResult> {
  const witness = await startWitness({
    runId: randomUUID(),
    token: TOKEN,
    verifierKey: VERIFIER_KEY,
    adaptersDir: adaptersDir(receiver.scopeFile),
    targetBaseUrl: receiver.url,
    fixtureProvider: createMemoryFixtureProvider({
      actors: { provider: { principalId: 'provider', tenantId: null, roles: [] } },
      credentials: { provider: { 'x-gateforge-signing-secret': WEBHOOK_SECRET } },
      subjects: { 'webhook-deliveries': { 'accepted-event': ACCEPTED_BYTES, ...extraSubjects } },
    }),
    now: () => '2026-09-25T00:00:00.000Z',
  });
  const seals: RunResult['seals'] = [];
  try {
    const bound = await post(witness.url, '/runs/behavior-catalog', {
      catalog: {
        schemaVersion: 1,
        catalogDigest: hex('f'),
        cases: items.map((entry) => ({
          caseId: entry.caseId,
          specDigest: hex('e'),
          resourceId: ENDPOINT,
          endpointResourceId: ENDPOINT,
          obligationIds: [`${ENDPOINT}:${entry.contract}`],
          definition: entry.definition,
          effects: EFFECTS,
          sourceFiles: ['example'],
        })),
        requirements: Object.fromEntries(items.map((entry) => [`${ENDPOINT}:${entry.contract}`, [entry.caseId]])),
        dependencies: {},
      },
      assignments: { [TEST_ID]: items.map((entry) => entry.caseId) },
      routes: [{ resourceId: ENDPOINT, method: 'POST', canonicalPath: '/webhook/stripe' }],
      authorityProfileDigest: AUTH_DIGEST,
    });
    expect(bound.status, JSON.stringify(bound.body)).toBe(200);
    const opened = (await post(witness.url, '/sessions/open', { testId: TEST_ID, workerIndex: 0 }))
      .body as { sessionId: string; sessionToken: string };
    for (const item of items) {
      const executed = await post(witness.url, '/behavior/execute', {
        sessionId: opened.sessionId,
        sessionToken: opened.sessionToken,
        caseId: item.caseId,
      });
      expect(executed.status, `${item.caseId}: ${JSON.stringify(executed.body)}`).toBe(200);
      const sealed = await post(witness.url, '/behavior/principal', {
        sessionId: opened.sessionId,
        sessionToken: opened.sessionToken,
        executionId: (executed.body as { executionId: string }).executionId,
      });
      seals.push({ caseId: item.caseId, status: sealed.status, body: sealed.body });
    }
    const ledger = (await (await fetch(`${witness.url}/records`, { headers: { [RUN_HEADER]: TOKEN } })).json()) as {
      records: Array<Record<string, unknown>>;
    };
    return { seals, records: ledger.records };
  } finally {
    await witness.stop();
  }
}

/** Grades one obligation across its required case, exactly as the engine does. */
function grade(
  item: WebhookCase & { definition: Record<string, unknown> },
  records: Array<Record<string, unknown>>,
  catalog: ReadonlyArray<WebhookCase & { definition: Record<string, unknown> }>,
): { status: string; reason: string } {
  const obligationId = `${ENDPOINT}:${item.contract}`;
  // The engine's own requirement set for the obligation: exactly the
  // cases the compiled catalog binds to it.
  const requiredCaseIds = catalog
    .filter((entry) => entry.contract === item.contract)
    .map((entry) => entry.caseId)
    .sort();
  const outcome = evaluateRequiredCases({
    obligation: {
      schemaVersion: 1,
      id: obligationId,
      resourceId: ENDPOINT,
      contract: item.contract,
      policyId: 'behavior-policy',
      lifecycle: { create: true, read: true, update: true, delete: true, deleteSemantics: 'hard' },
    } as never,
    requiredCaseIds,
    records: records as never,
    context: {
      catalog: {
        schemaVersion: 1,
        catalogDigest: hex('f'),
        cases: catalog.map((entry) => ({
          caseId: entry.caseId,
          specDigest: hex('e'),
          resourceId: ENDPOINT,
          endpointResourceId: ENDPOINT,
          obligationIds: [`${ENDPOINT}:${entry.contract}`],
          definition: entry.definition,
          effects: EFFECTS,
          sourceFiles: ['example'],
        })),
        requirements: { [obligationId]: requiredCaseIds },
        dependencies: {},
      } as never,
      requirements: { [obligationId]: requiredCaseIds },
      authorityProfileDigest: AUTH_DIGEST,
      plannedTestIds: [TEST_ID],
    },
    httpRoutes: [{ resourceId: ENDPOINT, method: 'POST', canonicalPath: '/webhook/stripe' }] as never,
  });
  return outcome as { status: string; reason: string };
}

describe('webhook signature driver (plan 2026-09-25 Phase 1)', () => {
  it('valid signature is accepted, forged signature is rejected with no row, and a replay still leaves one row', async () => {
    const receiver = await startReceiver();
    const accepted = webhookCase({
      id: 'signature-accepted',
      statuses: [200],
      state: [
        {
          kind: 'created',
          scope: 'deliveries',
          rows: [
            {
              fields: {
                eventId: { from: 'literal', value: 'evt-accepted' },
                sideEffectCount: { from: 'literal', value: 1 },
              },
            },
          ],
        },
      ],
    });
    const forged = webhookCase({
      id: 'signature-rejected',
      contract: 'webhook:signature-rejected',
      controlCase: 'signature-accepted',
      profile: 'hmac-sha256;forgery=signature',
      statuses: [401],
      state: [{ kind: 'unchanged', scope: 'deliveries' }],
    });
    const replay = webhookCase({
      id: 'replay-idempotent',
      contract: 'webhook:replay-idempotent',
      statuses: [200],
      state: [{ kind: 'unchanged', scope: 'deliveries' }],
    });
    const catalog = [accepted, forged, replay];
    const run = await runCases(receiver, catalog);
    for (const seal of run.seals) {
      expect(seal.status, `${seal.caseId}: ${JSON.stringify(seal.body)}`).toBe(200);
    }
    const acceptedGrade = grade(accepted, run.records, catalog);
    expect(acceptedGrade.status, acceptedGrade.reason).toBe('satisfied');
    // The forged delivery: a 401 AND a delivery log identical to the
    // one the accepted case left behind — the receiver's own row count
    // is one, so nothing was written.
    const forgedGrade = grade(forged, run.records, catalog);
    expect(forgedGrade.status, forgedGrade.reason).toBe('satisfied');
    expect(receiver.rows()).toHaveLength(1);
    // The replay: the duplicate event is deduplicated, still one row.
    const replayGrade = grade(replay, run.records, catalog);
    expect(replayGrade.status, replayGrade.reason).toBe('satisfied');
    expect(receiver.rows()).toHaveLength(1);
    // The engine-side secret never reaches a sealed record.
    expect(JSON.stringify(run.records)).not.toContain(WEBHOOK_SECRET);
    await receiver.stop();
  }, 120_000);

  it('the declared attempt and clock-tolerance parameters reach the receiver', async () => {
    const receiver = await startReceiver();
    const accepted = webhookCase({
      id: 'declared-params',
      profile: 'hmac-sha256;attempt=1;toleranceMs=300000',
      statuses: [200],
      state: [
        {
          kind: 'created',
          scope: 'deliveries',
          rows: [
            {
              fields: {
                eventId: { from: 'literal', value: 'evt-accepted' },
                sideEffectCount: { from: 'literal', value: 1 },
              },
            },
          ],
        },
      ],
    });
    const run = await runCases(receiver, [accepted]);
    expect(run.seals[0]?.status, JSON.stringify(run.seals[0]?.body)).toBe(200);
    const outcome = grade(accepted, run.records, [accepted]);
    expect(outcome.status, outcome.reason).toBe('satisfied');
    // Attempt 1 of the receiver's budget of 3: the row is there.
    expect(receiver.rows()[0]).toMatchObject({ eventId: 'evt-accepted', attempt: 1, sideEffectCount: 1 });
    await receiver.stop();
  }, 120_000);

  it('a stale declared stamp and an over-limit body both fail closed in the driver', async () => {
    const receiver = await startReceiver();
    // The lease declares a stamp far outside the profile's tolerance:
    // the driver refuses rather than sending a stale-signed delivery.
    const stale = webhookCase({
      id: 'stale-stamp',
      profile: 'hmac-sha256;toleranceMs=1000',
      statuses: [200],
      state: [{ kind: 'unchanged', scope: 'deliveries' }],
    });
    const staleRun = await runCases(receiver, [stale], { signatureTimestampMs: Date.now() - 3_600_000 });
    expect(staleRun.seals[0]?.status).toBe(409);
    expect(String((staleRun.seals[0]?.body as { error?: string }).error)).toContain('outside the declared tolerance');
    expect(receiver.rows()).toHaveLength(0);

    // An over-limit raw body never leaves the driver.
    const oversized = webhookCase({
      id: 'oversized',
      profile: 'hmac-sha256',
      statuses: [200],
      state: [{ kind: 'unchanged', scope: 'deliveries' }],
    });
    oversized.definition['action'] = {
      ...(oversized.definition['action'] as Record<string, unknown>),
      body: { encoding: 'raw', fixture: 'huge-event' },
    };
    const hugeRun = await runCases(receiver, [oversized], {
      'huge-event': JSON.stringify({ event_id: 'evt-huge', padding: 'x'.repeat(300 * 1024) }),
    });
    expect(hugeRun.seals[0]?.status).toBe(409);
    expect(String((hugeRun.seals[0]?.body as { error?: string }).error)).toContain('exceeds the proof bound');
    expect(receiver.rows()).toHaveLength(0);

    await receiver.stop();
  }, 120_000);
});
