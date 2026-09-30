/**
 * Engine-read task grading (plan 20260925-2011 Phase 3): `attempts`
 * rules settled from the witness's OWN read of the delivery queue, plus
 * the namespace gate that keeps `task` unavailable until the owner
 * configures a queue observer.
 *
 * Every case here builds the sealed observation by hand — a suite
 * cannot mint one, which is exactly why these probes exercise the
 * grader's rejection arms rather than any producer's happy path.
 */
import { describe, expect, it } from 'vitest';
import {
  behaviorActionDigestOf,
  bindQueueObserver,
  capabilityFor,
  evaluateRequiredCases,
  type BehaviorCatalog,
  type BehaviorGradeContext,
  type Obligation,
  type QueueJobObservation,
  type QueueJobSample,
  type RequiredCaseOutcome,
} from '../src/index.js';

const HEX = (seed: string): string => seed.repeat(64).slice(0, 64);
const CASE_ID = HEX('c');
const SPEC_DIGEST = HEX('e');
const AUTH_DIGEST = HEX('a');
const ENDPOINT = 'task.email.send';
const CONTRACT = 'task:retry-policy-enforced';
const OBLIGATION_ID = `${ENDPOINT}:${CONTRACT}`;
const TEST_ID = 'test-1';

const DELIVER_ACTION = {
  kind: 'deliver',
  resourceId: ENDPOINT,
  payload: { from: 'literal', value: { subject: 'welcome' } },
  idempotencyKey: { from: 'literal', value: 'welcome-42' },
  deliveryId: { from: 'literal', value: 'delivery-1' },
  count: 1,
  schedule: 'serial',
} as const;

/** Builds a deliver-case definition with the given `attempts` rule. */
function deliverDefinition(stateRule: Record<string, unknown>, deliveries = 1) {
  return {
    id: 'welcome-delivery',
    contract: CONTRACT,
    channel: 'engine-task',
    fixture: 'one-account',
    actor: 'system',
    action: { ...DELIVER_ACTION, count: deliveries },
    // Every delivery writes one outbox row: the queue read settles the
    // job, and this effect scope settles the application side effect.
    expect: {
      statuses: [],
      response: [],
      state: [stateRule, { kind: 'created', scope: 'sends', rows: [{ fields: { id: { from: 'literal', value: 'out-1' } } }] }],
    },
  };
}

/** Compiles the catalog the grader reads (trusted context, not a record). */
function catalogFor(stateRule: Record<string, unknown>, deliveries = 1): BehaviorCatalog {
  return {
    schemaVersion: 1,
    catalogDigest: HEX('f'),
    cases: [
      {
        caseId: CASE_ID,
        specDigest: SPEC_DIGEST,
        resourceId: ENDPOINT,
        endpointResourceId: null,
        obligationIds: [OBLIGATION_ID],
        definition: deliverDefinition(stateRule, deliveries) as never,
        effects: [
          {
            id: 'sends',
            resourceId: 'mail.outbox',
            adapter: 'outbox',
            scope: 'fixture-outbox',
            identityFields: ['id'],
            fields: ['id'],
            completion: 'immediate',
          },
        ],
        sourceFiles: ['app/queue/email.js'],
      },
    ],
    requirements: { [OBLIGATION_ID]: [CASE_ID] },
    dependencies: {},
  };
}

const OBLIGATION: Obligation = {
  schemaVersion: 1,
  id: OBLIGATION_ID,
  resourceId: ENDPOINT,
  contract: CONTRACT,
  policyId: 'behavior-policy',
  lifecycle: { create: true, read: true, update: true, delete: true, deleteSemantics: 'hard' },
};

/** One engine-read job as the observer seals it. */
function job(overrides: Partial<QueueJobObservation> = {}): QueueJobObservation {
  return {
    jobId: 'job-1',
    deliveryId: 'delivery-1#1',
    idempotencyKey: 'welcome-42',
    state: 'completed',
    attemptsMade: 3,
    maxAttempts: 3,
    failedReason: null,
    processedAt: 1,
    ...overrides,
  };
}

/** One engine-sampled transition. */
function sample(overrides: Partial<QueueJobSample> = {}): QueueJobSample {
  return { jobId: 'job-1', state: 'waiting', attemptsMade: 0, failedReason: null, atMs: 0, ...overrides };
}

/** A sealed pass payload for the given rule/observation/jobs/samples. */
function sealedPayload(input: {
  stateRule: Record<string, unknown>;
  jobs: QueueJobObservation[];
  samples?: QueueJobSample[];
  complete?: boolean;
  deliveryIds?: string[];
  submittedValues?: Record<string, unknown>;
  deliveries?: number;
}) {
  const after = [
    {
      scope: 'fixture-outbox',
      fixtureNamespace: 'ns-1',
      complete: true,
      checkpoint: 'ns-1:2',
      entities: [{ entityId: 'out-1', fields: { id: 'out-1' } }],
    },
  ];
  return {
    payloadVersion: 1,
    caseId: CASE_ID,
    caseSpecDigest: SPEC_DIGEST,
    obligationIds: [OBLIGATION_ID],
    endpointResourceId: null,
    operationId: 'delivery-1',
    sessionId: 'sess-1',
    executionId: 'exec-1',
    fixtureNamespace: 'ns-1',
    actor: { principalId: 'system', tenantId: null, roles: [] },
    actionDigest: behaviorActionDigestOf(
      deliverDefinition(input.stateRule, input.deliveries ?? 1).action,
    ),
    submittedValues: input.submittedValues ?? {
      resourceId: ENDPOINT,
      queue: 'mailer',
      deliveryId: 'delivery-1',
      idempotencyKey: 'welcome-42',
      count: 1,
      schedule: 'serial',
      maxAttempts: 3,
    },
    attempts: [],
    requestObservations: [],
    fixtureValues: {},
    before: [
      {
        scope: 'fixture-outbox',
        fixtureNamespace: 'ns-1',
        complete: true,
        checkpoint: 'ns-1:1',
        entities: [],
      },
    ],
    after,
    completion: { complete: true, checkpoint: 'ns-1:2' },
    channel: 'engine-task',
    authorityProfileDigest: AUTH_DIGEST,
    state: 'sealed',
    queueObservation: {
      kind: 'bullmq',
      queue: 'mailer',
      deliveryIds: input.deliveryIds ?? ['delivery-1#1'],
      jobs: input.jobs,
      samples: input.samples ?? [],
      complete: input.complete ?? true,
      waitedMs: 900,
    },
  };
}

/** Grades one deliver case over the given payload. */
function grade(stateRule: Record<string, unknown>, payload: unknown, deliveries = 1): RequiredCaseOutcome {
  const catalog = catalogFor(stateRule, deliveries);
  return evaluateRequiredCases({
    obligation: OBLIGATION,
    requiredCaseIds: [CASE_ID],
    records: [
      {
        recordId: 'rec-1',
        testId: TEST_ID,
        kind: 'behavior.case',
        origin: 'engine-observed',
        trust: 'witnessed',
        payload,
      },
    ],
    context: {
      catalog,
      requirements: catalog.requirements,
      authorityProfileDigest: AUTH_DIGEST,
      plannedTestIds: [TEST_ID],
    } satisfies BehaviorGradeContext,
    httpRoutes: null,
  });
}

const RETRY_RULE = { kind: 'attempts', resourceId: ENDPOINT, count: 3, terminal: 'succeeded', minAttempts: 3 };

describe("task 'attempts' rules over the engine's queue observation", () => {
  it('satisfies a flaky job that used the whole declared bound and completed', () => {
    const outcome = grade(RETRY_RULE, sealedPayload({ stateRule: RETRY_RULE, jobs: [job()] }));
    expect(outcome).toEqual({ status: 'satisfied', recordIds: ['rec-1'] });
  });

  it('blocks a queue that never retried, however well the job ended', () => {
    const rule = { ...RETRY_RULE };
    const outcome = grade(
      rule,
      sealedPayload({ stateRule: rule, jobs: [job({ attemptsMade: 1 })] }),
    );
    expect(outcome.status).toBe('invalid');
    expect(outcome.status === 'invalid' ? outcome.reason : '').toContain('the retry path was never exercised');
  });

  it('blocks a delivery that never settled inside the bound', () => {
    const outcome = grade(
      RETRY_RULE,
      sealedPayload({ stateRule: RETRY_RULE, jobs: [job({ state: 'active', attemptsMade: 1 })], complete: false }),
    );
    expect(outcome.status).toBe('invalid');
    expect(outcome.status === 'invalid' ? outcome.reason : '').toContain('never reached a terminal state');
  });

  it('blocks a job that ended failed under a succeeded rule', () => {
    const outcome = grade(
      RETRY_RULE,
      sealedPayload({
        stateRule: RETRY_RULE,
        jobs: [job({ state: 'failed', attemptsMade: 3, failedReason: 'smtp refused' })],
      }),
    );
    expect(outcome.status).toBe('invalid');
    expect(outcome.status === 'invalid' ? outcome.reason : '').toContain('BEHAVIOR_EFFECT_MISMATCH');
  });

  it("satisfies a terminal-on-error job that failed on its first attempt", () => {
    const rule = { kind: 'attempts', resourceId: ENDPOINT, count: 3, terminal: 'rejected' };
    const outcome = grade(
      rule,
      sealedPayload({
        stateRule: rule,
        jobs: [job({ state: 'failed', attemptsMade: 1, failedReason: 'bad address' })],
      }),
    );
    expect(outcome).toEqual({ status: 'satisfied', recordIds: ['rec-1'] });
  });

  it('blocks a terminal-on-error job the queue retried', () => {
    const rule = { kind: 'attempts', resourceId: ENDPOINT, count: 3, terminal: 'rejected' };
    const outcome = grade(
      rule,
      sealedPayload({
        stateRule: rule,
        jobs: [job({ state: 'failed', attemptsMade: 2, failedReason: 'bad address' })],
      }),
    );
    expect(outcome.status).toBe('invalid');
    expect(outcome.status === 'invalid' ? outcome.reason : '').toContain('the error class was retried');
  });

  it('blocks a job whose queue-declared bound exceeds the policy bound', () => {
    const outcome = grade(RETRY_RULE, sealedPayload({ stateRule: RETRY_RULE, jobs: [job({ maxAttempts: 9 })] }));
    expect(outcome.status).toBe('invalid');
    expect(outcome.status === 'invalid' ? outcome.reason : '').toContain('above the declared 3');
  });

  it('blocks a duplicate delivery of one engine-produced idempotency key', () => {
    const outcome = grade(
      RETRY_RULE,
      sealedPayload({
        stateRule: RETRY_RULE,
        deliveryIds: ['delivery-1#1', 'delivery-1#2'],
        jobs: [job(), job({ jobId: 'job-2', deliveryId: 'delivery-1#2' }), job({ jobId: 'job-3' })],
        submittedValues: {
          resourceId: ENDPOINT,
          queue: 'mailer',
          deliveryId: 'delivery-1',
          idempotencyKey: 'welcome-42',
          count: 2,
          schedule: 'serial',
          maxAttempts: 3,
        },
        deliveries: 2,
      }),
      2,
    );
    expect(outcome.status).toBe('invalid');
    expect(outcome.status === 'invalid' ? outcome.reason : '').toContain('a duplicate or an extra delivery');
  });

  it('satisfies two engine deliveries of one idempotency key that both completed', () => {
    const outcome = grade(
      RETRY_RULE,
      sealedPayload({
        stateRule: RETRY_RULE,
        deliveryIds: ['delivery-1#1', 'delivery-1#2'],
        jobs: [job(), job({ jobId: 'job-2', deliveryId: 'delivery-1#2' })],
        submittedValues: {
          resourceId: ENDPOINT,
          queue: 'mailer',
          deliveryId: 'delivery-1',
          idempotencyKey: 'welcome-42',
          count: 2,
          schedule: 'serial',
          maxAttempts: 3,
        },
        deliveries: 2,
      }),
      2,
    );
    expect(outcome).toEqual({ status: 'satisfied', recordIds: ['rec-1'] });
  });

  it('blocks a delivery case that declares no attempts rule at all', () => {
    const scopeOnly = {
      kind: 'created',
      scope: 'sends',
      rows: [{ fields: { id: { from: 'literal', value: 'out-1' } } }],
    };
    const outcome = grade(scopeOnly, sealedPayload({ stateRule: scopeOnly, jobs: [job()] }));
    expect(outcome.status).toBe('invalid');
    expect(outcome.status === 'invalid' ? outcome.reason : '').toContain("declares no 'attempts' rule");
  });

  it('reports a sealed case with no queue observation as missing evidence', () => {
    const payload = sealedPayload({ stateRule: RETRY_RULE, jobs: [job()] });
    delete (payload as { queueObservation?: unknown }).queueObservation;
    const outcome = grade(RETRY_RULE, payload);
    expect(outcome.status).toBe('missing');
    expect(outcome.status === 'missing' ? outcome.reason : '').toContain('sealed no queue observation');
  });

  it('blocks an extra queue job the engine did not produce', () => {
    const outcome = grade(
      RETRY_RULE,
      sealedPayload({ stateRule: RETRY_RULE, jobs: [job(), job({ jobId: 'job-2', deliveryId: 'delivery-9#1' })] }),
    );
    expect(outcome.status).toBe('invalid');
    expect(outcome.status === 'invalid' ? outcome.reason : '').toContain('a duplicate or an extra delivery');
  });

  it('blocks a queue job carrying no engine delivery identity', () => {
    const outcome = grade(RETRY_RULE, sealedPayload({ stateRule: RETRY_RULE, jobs: [job({ deliveryId: null })] }));
    expect(outcome.status).toBe('invalid');
    expect(outcome.status === 'invalid' ? outcome.reason : '').toContain('no engine delivery identity');
  });

  it('blocks a job whose idempotency key is not the engine-stamped one', () => {
    const outcome = grade(RETRY_RULE, sealedPayload({ stateRule: RETRY_RULE, jobs: [job({ idempotencyKey: 'other' })] }));
    expect(outcome.status).toBe('invalid');
    expect(outcome.status === 'invalid' ? outcome.reason : '').toContain("engine-stamped 'welcome-42'");
  });

  it('blocks an attempts rule naming a resource the case does not deliver to', () => {
    const rule = { ...RETRY_RULE, resourceId: 'task.other' };
    const outcome = grade(rule, sealedPayload({ stateRule: rule, jobs: [job()] }));
    expect(outcome.status).toBe('invalid');
    expect(outcome.status === 'invalid' ? outcome.reason : '').toContain('BEHAVIOR_BINDING_MISMATCH');
  });
});

describe('stall recovery claims', () => {
  const STALL_RULE = {
    kind: 'attempts',
    resourceId: ENDPOINT,
    count: 3,
    terminal: 'succeeded',
    recoveredFromStall: true,
  };

  it('satisfies a delivery reclaimed from a lost worker that then completed', () => {
    const outcome = grade(
      STALL_RULE,
      sealedPayload({
        stateRule: STALL_RULE,
        jobs: [job({ attemptsMade: 1 })],
        // The queue handed the same job out twice with no error between.
        samples: [
          sample({ state: 'active', atMs: 10 }),
          sample({ state: 'waiting', atMs: 1400 }),
          sample({ state: 'active', atMs: 1500 }),
          sample({ state: 'completed', atMs: 2100 }),
        ],
      }),
    );
    expect(outcome).toEqual({ status: 'satisfied', recordIds: ['rec-1'] });
  });

  it('satisfies a reclaim the engine only sampled as a hand-out twice', () => {
    const outcome = grade(
      STALL_RULE,
      sealedPayload({
        stateRule: STALL_RULE,
        jobs: [job({ attemptsMade: 1 })],
        // Sampling can miss the wait-list step: two `active` samples
        // with unchanged attempts and no reason are the reclaim itself.
        samples: [
          sample({ state: 'active', atMs: 10 }),
          sample({ state: 'active', atMs: 1600 }),
          sample({ state: 'completed', atMs: 2200 }),
        ],
      }),
    );
    expect(outcome).toEqual({ status: 'satisfied', recordIds: ['rec-1'] });
  });

  it('blocks a delivery that settled but never showed a lost-worker reclaim', () => {
    const outcome = grade(
      STALL_RULE,
      sealedPayload({
        stateRule: STALL_RULE,
        jobs: [job({ attemptsMade: 3 })],
        samples: [
          sample({ state: 'waiting', atMs: 10 }),
          sample({ state: 'active', atMs: 100, attemptsMade: 0 }),
          sample({ state: 'waiting', atMs: 300, attemptsMade: 1, failedReason: 'flaky' }),
          sample({ state: 'completed', atMs: 900, attemptsMade: 3 }),
        ],
      }),
    );
    expect(outcome.status).toBe('invalid');
    expect(outcome.status === 'invalid' ? outcome.reason : '').toContain('no job was observed being reclaimed');
  });
});

describe("the 'task' namespace availability", () => {
  it('is unavailable with no queue observer and available once one is bound', () => {
    bindQueueObserver(null);
    const unbound = capabilityFor(CONTRACT);
    expect(unbound?.availability.status).toBe('unavailable');
    expect(unbound?.availability.status === 'unavailable' ? unbound.availability.reason : '').toContain(
      'queueObserver',
    );
    expect(unbound?.contracts).toEqual([
      'task:retry-policy-enforced',
      'task:idempotent',
      'task:terminal-handled',
      'task:observability-recorded',
      'task:duplicate-delivery-handled',
    ]);
    bindQueueObserver({
      kind: 'bullmq',
      connection: { host: '127.0.0.1', port: 6379 },
      queues: [{ name: 'mailer', taskResourceId: ENDPOINT }],
    });
    expect(capabilityFor(CONTRACT)?.availability).toEqual({ status: 'available' });
    bindQueueObserver(null);
    expect(capabilityFor(CONTRACT)?.availability.status).toBe('unavailable');
  });
});
