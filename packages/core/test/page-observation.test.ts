import { describe, expect, it } from 'vitest';
import {
  evaluateObligation,
  fingerprintObligation,
  recordIdOf,
  type Obligation,
  type VerdictContext,
  type Waiver,
} from '../src/index.js';

const PAGE_ID = 'tenant.page-orders';
const RUN_ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const cleanPayload = {
  routeId: PAGE_ID,
  finalUrl: 'http://127.0.0.1/orders/42',
  loads: { satisfied: true, refusalReasons: [] as string[] },
  dataOk: { satisfied: true, refusalReasons: [] as string[] },
  apiRequestsSettled: true,
  observationSequence: 1,
};

function obligation(contract: 'page:loads' | 'page:data-ok'): Obligation {
  return {
    schemaVersion: 1,
    id: `${PAGE_ID}:${contract}`,
    resourceId: PAGE_ID,
    contract,
    policyId: 'page-policy',
    lifecycle: { create: false, read: false, update: false, delete: false },
  };
}

function record(contract: 'page:loads' | 'page:data-ok', payload: Record<string, unknown> = cleanPayload, testId = 'orders-test') {
  const obligationId = `${PAGE_ID}:${contract}`;
  return {
    schemaVersion: 1,
    runId: RUN_ID,
    trust: 'witnessed',
    obligationId,
    testId,
    kind: 'page.observed',
    origin: 'engine-observed',
    payload,
    recordId: recordIdOf({ runId: RUN_ID, obligationId, kind: 'page.observed', testId, origin: 'engine-observed', payload }),
  };
}

function context(records: readonly unknown[]): VerdictContext {
  return { claims: [], records, waivers: [], classification: null, now: '2026-10-06T00:00:00.000Z' };
}

describe('page obligation verification', () => {
  it('accepts witness-issued clean page records without suite claims or business classification', () => {
    expect(evaluateObligation(obligation('page:loads'), context([record('page:loads')])).verdict).toBe('satisfied');
    expect(evaluateObligation(obligation('page:data-ok'), context([record('page:data-ok')])).verdict).toBe('satisfied');
  });

  it('rejects bounced pages, exceptions, error screens, API failures and local fulfilment', () => {
    for (const refusal of ['PAGE_BOUNCED_TO_LOGIN', 'PAGE_UNCAUGHT_EXCEPTION', 'PAGE_ERROR_MARKER', 'PAGE_LOCALLY_FULFILLED']) {
      const payload = { ...cleanPayload, loads: { satisfied: false, refusalReasons: [refusal] } };
      expect(evaluateObligation(obligation('page:loads'), context([record('page:loads', payload)])).verdict).toBe('invalid');
    }
    const payload = { ...cleanPayload, dataOk: { satisfied: false, refusalReasons: ['PAGE_API_ERROR'] } };
    expect(evaluateObligation(obligation('page:data-ok'), context([record('page:data-ok', payload)])).verdict).toBe('invalid');
    expect(evaluateObligation(obligation('page:loads'), context([record('page:loads', payload)])).verdict).toBe('satisfied');
  });

  it('requires witness provenance and reports no passing observation as missing', () => {
    const fabricated = { ...record('page:loads'), trust: 'claimed' };
    expect(evaluateObligation(obligation('page:loads'), context([fabricated])).verdict).toBe('missing');
    expect(evaluateObligation(obligation('page:loads'), context([])).verdict).toBe('missing');
  });
});

describe('page lane waiver precedence (the same core waiver contracts)', () => {
  const loads = obligation('page:loads');
  const loadsFingerprint = fingerprintObligation(loads);
  const waiver = (overrides: Partial<Waiver> = {}): Waiver => ({
    schemaVersion: 1,
    owner: 'owner',
    approver: 'approver',
    justificationUrl: 'https://example.test/page-waiver',
    scope: { kind: 'exact', resourceId: PAGE_ID, fingerprint: loadsFingerprint },
    expiresAt: '2027-01-01T00:00:00.000Z',
    ...overrides,
  });

  it('an unexpired waiver waives the page before its evidence grade (an exemption, never proof)', () => {
    const outcome = evaluateObligation(loads, { ...context([]), waivers: [waiver()] });
    expect(outcome.verdict).toBe('waived');
    expect(outcome.reason).toContain("waived by 'owner'");
    expect(outcome.recordIds).toEqual([]);
  });

  it('an active waiver precedes even clean evidence, exactly like the ordinary lane', () => {
    const outcome = evaluateObligation(loads, { ...context([record('page:loads')]), waivers: [waiver()] });
    expect(outcome.verdict).toBe('waived');
  });

  it('an expired page waiver grades invalid, not missing (ADR 0001 D4)', () => {
    const outcome = evaluateObligation(loads, {
      ...context([]),
      waivers: [waiver({ expiresAt: '2025-01-01T00:00:00.000Z' })],
    });
    expect(outcome.verdict).toBe('invalid');
    expect(outcome.reason).toContain('expired waivers block');
  });

  it('a stale-owner page waiver grades stale (GF-17)', () => {
    const outcome = evaluateObligation(loads, {
      ...context([]),
      waivers: [{ ...waiver(), ownerStale: true }],
    });
    expect(outcome.verdict).toBe('stale');
    expect(outcome.reason).toContain('is stale (owner check failed)');
  });

  it('a waiver scoped to the OTHER page promise never matches (exact fingerprint scope)', () => {
    const outcome = evaluateObligation(loads, {
      ...context([]),
      waivers: [
        waiver({
          scope: {
            kind: 'exact',
            resourceId: PAGE_ID,
            fingerprint: fingerprintObligation(obligation('page:data-ok')),
          },
        }),
      ],
    });
    expect(outcome.verdict).toBe('missing');
  });

  it('a revoked waiver stops speaking: the page grades on its evidence again (missing, never adopted debt)', () => {
    expect(evaluateObligation(loads, context([])).verdict).toBe('missing');
    expect(evaluateObligation(obligation('page:data-ok'), context([])).verdict).toBe('missing');
  });
});

describe('page observation chronology (the latest observation sequence per test decides)', () => {
  const loads = obligation('page:loads');
  const cleanAt = (sequence: number, testId = 'orders-test') =>
    record('page:loads', { ...cleanPayload, observationSequence: sequence }, testId);
  const refusedAt = (sequence: number, testId = 'orders-test') =>
    record(
      'page:loads',
      { ...cleanPayload, observationSequence: sequence, loads: { satisfied: false, refusalReasons: ['PAGE_BOUNCED_TO_LOGIN'] } },
      testId,
    );
  const unsettledAt = (sequence: number) =>
    record('page:loads', { ...cleanPayload, observationSequence: sequence, apiRequestsSettled: false });

  it('a later refusal supersedes an earlier clean visit from the same test, in either array order', () => {
    const earlierClean = cleanAt(1);
    const laterRefused = refusedAt(2);
    for (const records of [[earlierClean, laterRefused], [laterRefused, earlierClean]]) {
      const outcome = evaluateObligation(loads, context(records));
      expect(outcome.verdict).toBe('invalid');
      expect(outcome.reason).toContain('PAGE_BOUNCED_TO_LOGIN');
      expect(outcome.recordIds).toEqual([laterRefused.recordId]);
    }
  });

  it('a later clean visit supersedes an earlier refusal from the same test, in either array order', () => {
    const earlierRefused = refusedAt(1);
    const laterClean = cleanAt(2);
    for (const records of [[earlierRefused, laterClean], [laterClean, earlierRefused]]) {
      const outcome = evaluateObligation(loads, context(records));
      expect(outcome.verdict).toBe('satisfied');
      expect(outcome.recordIds).toEqual([laterClean.recordId]);
    }
  });

  it("another test's latest clean record satisfies when this test's latest observation was refused", () => {
    const refusedLatest = refusedAt(2);
    const otherTestClean = cleanAt(1, 'orders-retry-test');
    for (const records of [
      [cleanAt(1), refusedLatest, otherTestClean],
      [otherTestClean, refusedLatest, cleanAt(1)],
    ]) {
      const outcome = evaluateObligation(loads, context(records));
      expect(outcome.verdict).toBe('satisfied');
      expect(outcome.recordIds).toEqual([otherTestClean.recordId]);
    }
  });

  it('missing or malformed observation sequences never satisfy (inadmissible, not refusal)', () => {
    const withoutSequence: Record<string, unknown> = { ...cleanPayload };
    delete withoutSequence.observationSequence;
    expect(evaluateObligation(loads, context([record('page:loads', withoutSequence)])).verdict).toBe('missing');
    for (const malformed of [-1, 2.5, '2']) {
      const payload = { ...cleanPayload, observationSequence: malformed };
      expect(evaluateObligation(loads, context([record('page:loads', payload)])).verdict).toBe('missing');
    }
    const laterRefused = refusedAt(2);
    for (const records of [[record('page:loads', withoutSequence), laterRefused], [laterRefused, record('page:loads', withoutSequence)]]) {
      const outcome = evaluateObligation(loads, context(records));
      expect(outcome.verdict).toBe('invalid');
      expect(outcome.recordIds).toEqual([laterRefused.recordId]);
    }
  });

  it('an unsettled latest visit is refused as PAGE_API_UNSETTLED, never proof, in either array order', () => {
    const earlierClean = cleanAt(1);
    const laterUnsettled = unsettledAt(2);
    for (const records of [[earlierClean, laterUnsettled], [laterUnsettled, earlierClean]]) {
      const outcome = evaluateObligation(loads, context(records));
      expect(outcome.verdict).toBe('invalid');
      expect(outcome.reason).toContain('PAGE_API_UNSETTLED');
    }
    const withoutSettled: Record<string, unknown> = { ...cleanPayload, observationSequence: 3 };
    delete withoutSettled.apiRequestsSettled;
    const outcome = evaluateObligation(loads, context([record('page:loads', withoutSettled)]));
    expect(outcome.verdict).toBe('invalid');
    expect(outcome.reason).toContain('PAGE_API_UNSETTLED');
    expect(evaluateObligation(obligation('page:data-ok'), context([
      record('page:data-ok', { ...cleanPayload, apiRequestsSettled: false }),
    ])).reason).toContain('PAGE_API_UNSETTLED');
  });

  it('a later settled clean visit supersedes an earlier unsettled one, in either array order', () => {
    const earlierUnsettled = unsettledAt(1);
    const laterClean = cleanAt(2);
    for (const records of [[earlierUnsettled, laterClean], [laterClean, earlierUnsettled]]) {
      expect(evaluateObligation(loads, context(records)).verdict).toBe('satisfied');
    }
  });

  it('identical duplicate observations at the top sequence still satisfy (one payload reused for both promises)', () => {
    const first = cleanAt(2);
    const duplicate = cleanAt(2);
    expect(duplicate.recordId).toBe(first.recordId);
    for (const records of [[first, duplicate], [duplicate, first]]) {
      const outcome = evaluateObligation(loads, context(records));
      expect(outcome.verdict).toBe('satisfied');
      expect(outcome.recordIds).toEqual([first.recordId]);
    }
  });

  it('contradictory payloads at the same top sequence fail closed in either array order', () => {
    const cleanCopy = cleanAt(2);
    const conflicting = record(
      'page:loads',
      { ...cleanPayload, observationSequence: 2, dataOk: { satisfied: false, refusalReasons: ['PAGE_API_ERROR'] } },
    );
    for (const records of [[cleanCopy, conflicting], [conflicting, cleanCopy]]) {
      const outcome = evaluateObligation(loads, context(records));
      expect(outcome.verdict).toBe('invalid');
      expect(outcome.reason).toContain('PAGE_OBSERVATION_CONFLICT');
      expect(outcome.reason).toContain("'orders-test'");
      expect(outcome.reason).toContain('observation sequence 2');
    }
  });

  it('a contradiction below the latest sequence does not poison the later clean observation', () => {
    const conflictA = record('page:loads', { ...cleanPayload, observationSequence: 1, finalUrl: 'http://127.0.0.1/orders/41' });
    const conflictB = record('page:loads', { ...cleanPayload, observationSequence: 1 });
    const laterClean = cleanAt(2);
    for (const records of [[conflictA, conflictB, laterClean], [laterClean, conflictB, conflictA]]) {
      expect(evaluateObligation(loads, context(records)).verdict).toBe('satisfied');
    }
  });
});
