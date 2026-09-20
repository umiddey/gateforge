/**
 * Phase 11 repository-side qualification for trusted retry and attempt
 * semantics (plan 2026-09-19 §9, B34–B35).
 *
 * These tests exercise only engine-owned core decisions. They do not claim
 * queue-host, browser, or managed Linux proof: the task delivery trace is
 * not yet available in the repository-side evaluator, so attempt rules must
 * fail closed rather than trusting an application-reported count.
 */
import { describe, expect, it } from 'vitest';
import {
  behaviorActionDigestOf,
  evaluateRequiredCases,
  type BehaviorCatalog,
  type Obligation,
} from '../src/index.js';

const CASE_ID = 'c'.repeat(64);
const SPEC_DIGEST = 'e'.repeat(64);
const AUTHORITY_DIGEST = 'a'.repeat(64);
const ENDPOINT = 'tenant.http-task-run';
const OBLIGATION_ID = `${ENDPOINT}:task:retry-policy-enforced`;
const TEST_ID = 'task-qualification';
type TaskDefinition = {
  id: string;
  contract: string;
  channel: 'engine-http';
  fixture: string;
  actor: string;
  action: {
    kind: 'request';
    method: 'POST';
    pathTemplate: string;
    path: Record<string, unknown>;
    query: Record<string, unknown>;
    body: { encoding: 'json'; fields: Record<string, unknown> };
    credentialVariant: 'valid';
  };
  expect: { statuses: number[]; response: unknown[]; state: unknown[] };
};

function taskDefinition(state: unknown[]): TaskDefinition {
  return {
    id: 'task-run',
    contract: 'task:retry-policy-enforced',
    channel: 'engine-http',
    fixture: 'task-run-fixture',
    actor: 'worker',
    action: {
      kind: 'request',
      method: 'POST',
      pathTemplate: '/tasks/run',
      path: {},
      query: {},
      body: { encoding: 'json', fields: {} },
      credentialVariant: 'valid',
    },
    expect: {
      statuses: [202],
      response: [],
      state,
    },
  };
}

function taskPayload(definition: TaskDefinition) {
  return {
    payloadVersion: 1,
    caseId: CASE_ID,
    caseSpecDigest: SPEC_DIGEST,
    obligationIds: [OBLIGATION_ID],
    endpointResourceId: ENDPOINT,
    operationId: 'operation-1',
    sessionId: 'session-1',
    executionId: 'execution-1',
    fixtureNamespace: 'run-1',
    actor: { principalId: 'worker-1', tenantId: 'tenant-a', roles: ['worker'] },
    actionDigest: behaviorActionDigestOf(definition.action),
    submittedValues: { path: '/tasks/run', query: {}, body: {} },
    attempts: [
      {
        engineRequestId: 'request-1',
        method: 'POST',
        path: '/tasks/run',
        endpointResourceId: ENDPOINT,
        actorRef: 'worker-1',
        requestDigest: '1'.repeat(64),
        status: 202,
        responseDigest: '2'.repeat(64),
      },
    ],
    requestObservations: [
      {
        engineRequestId: 'request-1',
        method: 'POST',
        path: '/tasks/run',
        query: {},
        body: {},
        status: 202,
        responseBody: { accepted: true },
      },
    ],
    fixtureValues: {},
    before: [
      {
        scope: 'task-runs',
        fixtureNamespace: 'run-1',
        complete: true,
        checkpoint: 'before',
        entities: [{ entityId: 'run-1', fields: { status: 'queued', attempts: 0 } }],
      },
    ],
    after: [
      {
        scope: 'task-runs',
        fixtureNamespace: 'run-1',
        complete: true,
        checkpoint: 'after',
        entities: [{ entityId: 'run-1', fields: { status: 'done', attempts: 3 } }],
      },
    ],
    completion: { complete: true, checkpoint: 'after' },
    channel: 'engine-http',
    authorityProfileDigest: AUTHORITY_DIGEST,
    state: 'sealed',
  };
}

function gradeTaskCase(definition: TaskDefinition) {
  const catalog: BehaviorCatalog = {
    schemaVersion: 1,
    catalogDigest: 'f'.repeat(64),
    cases: [
      {
        caseId: CASE_ID,
        specDigest: SPEC_DIGEST,
        resourceId: ENDPOINT,
        endpointResourceId: ENDPOINT,
        obligationIds: [OBLIGATION_ID],
        definition: definition as never,
        effects: [
          {
            id: 'runs',
            resourceId: 'tenant.task-runs',
            adapter: 'task-audit',
            scope: 'task-runs',
            identityFields: ['id'],
            fields: ['status', 'attempts'],
            completion: 'immediate',
          },
        ],
        sourceFiles: ['worker.ts'],
      },
    ],
    requirements: { [OBLIGATION_ID]: [CASE_ID] },
    dependencies: { [ENDPOINT]: ['tenant.task-runs'] },
  };
  const obligation: Obligation = {
    schemaVersion: 1,
    id: OBLIGATION_ID,
    resourceId: ENDPOINT,
    contract: 'task:retry-policy-enforced',
    policyId: 'behavior-policy',
    lifecycle: { create: true, read: true, update: true, delete: true, deleteSemantics: 'hard' },
  };
  return evaluateRequiredCases({
    obligation,
    requiredCaseIds: [CASE_ID],
    records: [
      {
        recordId: 'record-1',
        testId: TEST_ID,
        kind: 'behavior.case',
        origin: 'engine-observed',
        trust: 'witnessed',
        payload: taskPayload(definition),
      },
    ] as never,
    context: {
      catalog,
      requirements: catalog.requirements,
      authorityProfileDigest: AUTHORITY_DIGEST,
      plannedTestIds: [TEST_ID],
    },
    httpRoutes: [{ resourceId: ENDPOINT, method: 'POST', canonicalPath: '/tasks/run' }],
  });
}

describe('Phase 11 B34/B35 trusted task qualification', () => {
  const acceptedState = [
    {
      kind: 'updated',
      scope: 'runs',
      subject: { from: 'literal', value: 'run-1' },
      fields: { status: { from: 'literal', value: 'done' } },
    },
  ];

  function expectAttemptTraceBlocked(state: unknown[]) {
    const result = gradeTaskCase(taskDefinition(state));
    expect(result.status).toBe('missing');
    const reason = result.status === 'satisfied' ? '' : result.reason;
    expect(reason).toMatch(/Phase 8 delivery trace|blocked/);
    expect(result.recordIds).toEqual(['record-1']);
  }

  it('positive control: the same task request and trusted state effect satisfy the case', () => {
    expect(gradeTaskCase(taskDefinition(acceptedState)).status).toBe('satisfied');
  });

  it('B34 blocks a terminal/above-limit claim without an engine delivery trace', () => {
    expectAttemptTraceBlocked([
      {
        kind: 'attempts',
        resourceId: 'tenant.task-runs',
        count: 6,
        terminal: 'failed',
      },
    ]);
  });

  it('B35 rejects an application-reported attempt count without an engine delivery trace', () => {
    expectAttemptTraceBlocked([
      {
        kind: 'attempts',
        resourceId: 'tenant.task-runs',
        count: 1,
        terminal: 'succeeded',
      },
    ]);
  });
});
