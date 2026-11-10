/**
 * Observe-channel transport grader (plan gf-honest P2): exchanges on other
 * endpoints must not outrank a missing claim on the obligation's own route.
 */
import { describe, expect, it } from 'vitest';
import { recordIdOf } from '../src/provenance.js';
import type { Claim } from '../src/schemas/claim.js';
import type { Obligation } from '../src/schemas/obligation.js';
import {
  registerPackVerifiers,
  verifierFor,
  type HttpRouteCandidate,
  type RegistryRecordLike,
} from '../src/verdict/index.js';

registerPackVerifiers();

const RUN_ID = 'run-observe-other-endpoint';
const TEST_ID = 'suite/tests/rooms-update.test.ts:1';
const ROOMS_RESOURCE = 'tenant.rooms';
const OBLIGATION_ID = `${ROOMS_RESOURCE}:http:request-observed`;

const OBLIGATION: Obligation = {
  schemaVersion: 1,
  id: OBLIGATION_ID,
  resourceId: ROOMS_RESOURCE,
  contract: 'http:request-observed',
  policyId: 'test-policy',
  lifecycle: { create: false, read: true, update: true, delete: false },
};

const CLAIM: Claim = { schemaVersion: 1, obligationId: OBLIGATION_ID, testId: TEST_ID };

const HTTP_ROUTES: readonly HttpRouteCandidate[] = [
  {
    resourceId: 'tenant.auth_login',
    method: 'GET',
    canonicalPath: '/login',
  },
  {
    resourceId: 'tenant.misc_x',
    method: 'GET',
    canonicalPath: '/api/v1/x',
  },
  {
    resourceId: ROOMS_RESOURCE,
    method: 'PATCH',
    canonicalPath: '/api/v1/rooms/{}',
  },
];

function uiActionAnchor(): RegistryRecordLike {
  const payload = { operation: 'click', target: 'save' };
  return {
    recordId: recordIdOf({
      runId: RUN_ID,
      obligationId: OBLIGATION_ID,
      kind: 'ui.action',
      testId: TEST_ID,
      origin: 'suite-submitted',
      payload,
    }),
    runId: RUN_ID,
    obligationId: OBLIGATION_ID,
    kind: 'ui.action',
    testId: TEST_ID,
    origin: 'suite-submitted',
    payload,
    trust: 'claimed',
  };
}

function observeTransportRecord(exchanges: Array<Record<string, unknown>>): RegistryRecordLike {
  const payload = { channel: 'observe', exchanges };
  return {
    recordId: recordIdOf({
      runId: RUN_ID,
      obligationId: OBLIGATION_ID,
      kind: 'http.observed',
      testId: TEST_ID,
      origin: 'engine-observed',
      payload,
    }),
    runId: RUN_ID,
    obligationId: OBLIGATION_ID,
    kind: 'http.observed',
    testId: TEST_ID,
    origin: 'engine-observed',
    payload,
    trust: 'witnessed',
  };
}

function gradeObserveTransport(exchanges: Array<Record<string, unknown>>) {
  const verifier = verifierFor('http:request-observed');
  expect(verifier).not.toBeNull();
  return verifier?.({
    claim: CLAIM,
    obligation: OBLIGATION,
    evidence: [
      { record: uiActionAnchor(), trust: 'claimed' },
      { record: observeTransportRecord(exchanges), trust: 'witnessed' },
    ],
    primaryKey: ['id'],
    resource: null,
    httpRoutes: HTTP_ROUTES,
  });
}

/** Only non-satisfied outcomes carry a reason. */
function reasonOf(outcome: { status: string } | null | undefined): string | undefined {
  return (outcome as { reason?: string } | null | undefined)?.reason;
}

describe('Observe channel: other-endpoint exchanges', () => {
  it('missing when the session has traffic but not on the claimed endpoint', () => {
    const outcome = gradeObserveTransport([
      { method: 'GET', url: '/login', status: 200 },
      { method: 'GET', url: '/api/v1/x', status: 200 },
    ]);
    expect(outcome?.status).toBe('missing');
    expect(reasonOf(outcome)).toContain('no PATCH /api/v1/rooms/{}');
    expect(reasonOf(outcome)).toMatch(/waitForResponse/i);
    expect(reasonOf(outcome)).not.toMatch(/matches none of/i);
  });

  it('invalid when the obligation endpoint appears but status is not 2xx', () => {
    const statusObligation: Obligation = { ...OBLIGATION, contract: 'http:response-status-ok' };
    const verifier = verifierFor('http:response-status-ok');
    expect(verifier).not.toBeNull();
    const outcome = verifier?.({
      claim: { ...CLAIM, obligationId: `${ROOMS_RESOURCE}:http:response-status-ok` },
      obligation: statusObligation,
      evidence: [
        { record: uiActionAnchor(), trust: 'claimed' },
        {
          record: observeTransportRecord([
            { method: 'GET', url: '/login', status: 200 },
            { method: 'PATCH', url: '/api/v1/rooms/42', status: 404 },
          ]),
          trust: 'witnessed',
        },
      ],
      primaryKey: ['id'],
      resource: null,
      httpRoutes: HTTP_ROUTES,
    });
    expect(outcome?.status).toBe('invalid');
    expect(reasonOf(outcome)).toMatch(/not a 2xx/i);
  });

  it('invalid for a noncanonical observed path on a would-be own-endpoint call', () => {
    const outcome = gradeObserveTransport([{ method: 'PATCH', url: '/api//v1/rooms/42', status: 200 }]);
    expect(outcome?.status).toBe('invalid');
    expect(reasonOf(outcome)).toMatch(/noncanonical observed path/i);
  });

  it('missing when the own-endpoint call was test-initiated', () => {
    const outcome = gradeObserveTransport([
      {
        method: 'PATCH',
        url: '/api/v1/rooms/42',
        status: 200,
        initiator: 'test-code',
      },
    ]);
    expect(outcome?.status).toBe('missing');
    expect(reasonOf(outcome)).toMatch(/test code running in the page/i);
  });
});
