import { describe, expect, it } from 'vitest';
import { evaluateObligation, recordIdOf, type Obligation, type VerdictContext } from '../src/index.js';

const PAGE_ID = 'tenant.page-orders';
const RUN_ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const cleanPayload = {
  routeId: PAGE_ID,
  finalUrl: 'http://127.0.0.1/orders/42',
  loads: { satisfied: true, refusalReasons: [] },
  dataOk: { satisfied: true, refusalReasons: [] },
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

function record(contract: 'page:loads' | 'page:data-ok', payload = cleanPayload) {
  const obligationId = `${PAGE_ID}:${contract}`;
  return {
    schemaVersion: 1,
    runId: RUN_ID,
    trust: 'witnessed',
    obligationId,
    testId: 'orders-test',
    kind: 'page.observed',
    origin: 'engine-observed',
    payload,
    recordId: recordIdOf({ runId: RUN_ID, obligationId, kind: 'page.observed', testId: 'orders-test', origin: 'engine-observed', payload }),
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
