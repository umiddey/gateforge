/**
 * Exact-value echo instants (plan 20261020_1130, item c): two RFC 3339
 * date-time strings WITH an explicit offset (`Z` or `±hh:mm`) that name
 * the SAME instant are equal for the §3.6 echo check — the PM real case
 * was `responsibility_delegations.end_at` sent `"…09:33:00.000Z"` and
 * read back `"…09:33:00Z"`, which failed `EVIDENCE_VALUE_MISMATCH` on a
 * difference no application could observe. Every echo comparison site
 * (the browser channel's entered-input echo and the observe channel's
 * witness-observed request echo) shares ONE helper.
 *
 * Still a mismatch — no tolerance window, no partial timestamps:
 * date-only strings, offset-less date-times, and values differing by any
 * real time amount (including 1 ms).
 *
 * The tests drive the REAL persistence verifier (`verifierFor`), with
 * honestly provenanced records (`recordIdOf`), so the grading path —
 * postcondition, then echo — is the engine's own.
 */
import { describe, expect, it } from 'vitest';
import { verifierFor, type RegistryRecordLike } from '../src/verdict/index.js';
import { recordIdOf } from '../src/provenance.js';
import type { Claim } from '../src/schemas/claim.js';
import type { Obligation } from '../src/schemas/obligation.js';

const RUN_ID = 'run-exact-value-echo';
const TEST_ID = 'suite/tests/update.test.ts:1';
const OBLIGATION_ID = 'tenant.meter_readings:persistence:update';

const OBLIGATION: Obligation = {
  schemaVersion: 1,
  id: OBLIGATION_ID,
  resourceId: 'tenant.meter_readings',
  contract: 'persistence:update',
  policyId: 'test-policy',
  lifecycle: {
    create: true,
    read: true,
    update: true,
    delete: false,
    updateableFields: ['status'],
  },
};

const CLAIM: Claim = { schemaVersion: 1, obligationId: OBLIGATION_ID, testId: TEST_ID };

/** The entered values the browser channel's ui.action record carries. */
function actionRecord(fields: Record<string, unknown>): RegistryRecordLike {
  const payload = { operation: 'update', entityId: '42', fields };
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

/**
 * The engine-observed persisted state (witnessed). `before` carries the
 * pre-action read; the delta touches only `status` so the update
 * postcondition holds and grading reaches the echo.
 */
function persistenceRecord(fields: Record<string, unknown>): RegistryRecordLike {
  const payload = {
    entityId: '42',
    found: true,
    before: { found: true, fields: { status: 'open', end_at: '2026-10-20T09:33:00Z' } },
    fields,
  };
  return {
    recordId: recordIdOf({
      runId: RUN_ID,
      obligationId: OBLIGATION_ID,
      kind: 'persistence.entity',
      testId: TEST_ID,
      origin: 'engine-observed',
      payload,
    }),
    runId: RUN_ID,
    obligationId: OBLIGATION_ID,
    kind: 'persistence.entity',
    testId: TEST_ID,
    origin: 'engine-observed',
    payload,
    trust: 'witnessed',
  };
}

/**
 * The observe-channel record: witness-observed request fields
 * (`observedFields`) plus the adapter's persisted read (`fields`) on ONE
 * witnessed record.
 */
function observeRecord(params: {
  observedFields: Record<string, unknown>;
  fields: Record<string, unknown>;
}): RegistryRecordLike {
  const payload = {
    channel: 'observe',
    entityId: '42',
    found: true,
    before: { found: true, fields: { status: 'open', end_at: '2026-10-20T09:33:00Z' } },
    observedFields: params.observedFields,
    fields: params.fields,
  };
  return {
    recordId: recordIdOf({
      runId: RUN_ID,
      obligationId: OBLIGATION_ID,
      kind: 'persistence.observed',
      testId: TEST_ID,
      origin: 'engine-observed',
      payload,
    }),
    runId: RUN_ID,
    obligationId: OBLIGATION_ID,
    kind: 'persistence.observed',
    testId: TEST_ID,
    origin: 'engine-observed',
    payload,
    trust: 'witnessed',
  };
}

/** Grades the browser channel: ui.action echo against the persisted read. */
function gradeBrowser(fields: Record<string, unknown>): { status: string; reason: string } {
  return gradeBrowserFields(fields, { status: 'closed', end_at: '2026-10-20T09:33:00Z' });
}

/**
 * (d) The browser-channel grade with the persisted read spelled out, so a
 * (d) case can echo an entered number against a persisted decimal string.
 */
function gradeBrowserFields(
  fields: Record<string, unknown>,
  persistedFields: Record<string, unknown>,
): { status: string; reason: string } {
  const verifier = verifierFor(OBLIGATION.contract);
  expect(verifier).not.toBeNull();
  const outcome = verifier?.({
    claim: CLAIM,
    obligation: OBLIGATION,
    evidence: [
      { record: actionRecord(fields), trust: 'claimed' },
      {
        record: persistenceRecord(persistedFields),
        trust: 'witnessed',
      },
    ],
    primaryKey: ['id'],
    resource: null,
    httpRoutes: null,
  });
  return {
    status: outcome?.status ?? '<none>',
    // `reason` exists only on the invalid/missing variants of ClaimOutcome.
    reason: outcome !== undefined && outcome.status !== 'satisfied' ? outcome.reason : '',
  };
}

/** Grades the observe channel: witness-observed request echo. */
function gradeObserve(observedEndAt: string): { status: string; reason: string } {
  return gradeObserveFields(
    { status: 'closed', end_at: observedEndAt },
    { status: 'closed', end_at: '2026-10-20T09:33:00Z' },
  );
}

/**
 * (d) The observe-channel grade with observed and persisted fields spelled
 * out, so a (d) case can echo an observed number against a persisted
 * decimal string.
 */
function gradeObserveFields(
  observedFields: Record<string, unknown>,
  persistedFields: Record<string, unknown>,
): { status: string; reason: string } {
  const verifier = verifierFor(OBLIGATION.contract);
  expect(verifier).not.toBeNull();
  const outcome = verifier?.({
    claim: CLAIM,
    obligation: OBLIGATION,
    evidence: [
      {
        record: observeRecord({
          observedFields,
          fields: persistedFields,
        }),
        trust: 'witnessed',
      },
    ],
    primaryKey: ['id'],
    resource: null,
    httpRoutes: null,
  });
  return {
    status: outcome?.status ?? '<none>',
    // `reason` exists only on the invalid/missing variants of ClaimOutcome.
    reason: outcome !== undefined && outcome.status !== 'satisfied' ? outcome.reason : '',
  };
}

describe('exact-value echo: same-instant RFC 3339 date-times (item c)', () => {
  it('control: identical values satisfy the obligation on the browser channel', () => {
    const outcome = gradeBrowser({ status: 'closed', end_at: '2026-10-20T09:33:00Z' });
    expect(outcome.status).toBe('satisfied');
  });

  it('(c) ".000Z" entered and "Z" persisted name the same instant and satisfy', () => {
    const outcome = gradeBrowser({ status: 'closed', end_at: '2026-10-20T09:33:00.000Z' });
    expect(outcome.status).toBe('satisfied');
  });

  it('(c) different explicit offsets naming the same instant satisfy', () => {
    const outcome = gradeBrowser({ status: 'closed', end_at: '2026-10-20T11:33:00+02:00' });
    expect(outcome.status).toBe('satisfied');
  });

  it('(c) the observe channel treats ".000Z" and "Z" as the same instant', () => {
    const outcome = gradeObserve('2026-10-20T09:33:00.000Z');
    expect(outcome.status).toBe('satisfied');
  });

  it('a date-only string never instant-compares: same midnight instant stays a mismatch', () => {
    // '2026-10-19T23:00:00-01:00' IS 2026-10-20T00:00:00Z — but a
    // date-only string is not a full RFC 3339 date-time, so the echo
    // keeps the exact string rule.
    const outcome = gradeBrowser({ status: 'closed', end_at: '2026-10-20' });
    expect(outcome.status).toBe('invalid');
    expect(outcome.reason).toContain('EVIDENCE_VALUE_MISMATCH');
  });

  it('an offset-less date-time never instant-compares and stays a mismatch', () => {
    const outcome = gradeBrowser({ status: 'closed', end_at: '2026-10-20T09:33:00' });
    expect(outcome.status).toBe('invalid');
    expect(outcome.reason).toContain('EVIDENCE_VALUE_MISMATCH');
  });

  it('values 1 ms apart stay a mismatch (no tolerance window)', () => {
    const outcome = gradeBrowser({ status: 'closed', end_at: '2026-10-20T09:33:00.001Z' });
    expect(outcome.status).toBe('invalid');
    expect(outcome.reason).toContain('EVIDENCE_VALUE_MISMATCH');
  });

  it('non-timestamp strings stay exact-value compared', () => {
    const outcome = gradeBrowser({ status: 'closed', end_at: 'published' });
    expect(outcome.status).toBe('invalid');
    expect(outcome.reason).toContain('EVIDENCE_VALUE_MISMATCH');
  });

  it('the observe channel keeps 1 ms apart a mismatch', () => {
    const outcome = gradeObserve('2026-10-20T09:33:00.001Z');
    expect(outcome.status).toBe('invalid');
    expect(outcome.reason).toContain('EVIDENCE_VALUE_MISMATCH');
  });
});

describe('exact-value echo: number vs decimal-string (item d)', () => {
  it('(d) entered number 0 echoes persisted "0.00" (PM r8 real case)', () => {
    const outcome = gradeBrowserFields(
      { status: 'closed', deduction_amount: 0 },
      { status: 'closed', end_at: '2026-10-20T09:33:00Z', deduction_amount: '0.00' },
    );
    expect(outcome.status).toBe('satisfied');
  });

  it('(d) 12.5 echoes "12.50"', () => {
    const outcome = gradeBrowserFields(
      { status: 'closed', deduction_amount: 12.5 },
      { status: 'closed', end_at: '2026-10-20T09:33:00Z', deduction_amount: '12.50' },
    );
    expect(outcome.status).toBe('satisfied');
  });

  it('(d) -3 echoes "-3.0"', () => {
    const outcome = gradeBrowserFields(
      { status: 'closed', deduction_amount: -3 },
      { status: 'closed', end_at: '2026-10-20T09:33:00Z', deduction_amount: '-3.0' },
    );
    expect(outcome.status).toBe('satisfied');
  });

  it('(d) the decimal echo is symmetric: entered "0.00" echoes persisted 0', () => {
    const outcome = gradeBrowserFields(
      { status: 'closed', deduction_amount: '0.00' },
      { status: 'closed', end_at: '2026-10-20T09:33:00Z', deduction_amount: 0 },
    );
    expect(outcome.status).toBe('satisfied');
  });

  it('(d) number vs number keeps the exact rule: equal 12.5 still satisfies', () => {
    const outcome = gradeBrowserFields(
      { status: 'closed', deduction_amount: 12.5 },
      { status: 'closed', end_at: '2026-10-20T09:33:00Z', deduction_amount: 12.5 },
    );
    expect(outcome.status).toBe('satisfied');
  });

  it('(d) the observe channel echoes observed number 0 against persisted "0.00"', () => {
    const outcome = gradeObserveFields(
      { status: 'closed', deduction_amount: 0 },
      { status: 'closed', end_at: '2026-10-20T09:33:00Z', deduction_amount: '0.00' },
    );
    expect(outcome.status).toBe('satisfied');
  });

  // Stays a mismatch — exact decimals: no float conversion of the string,
  // no tolerance window.
  it('(d) 0.1 vs "0.10000001" stays a mismatch', () => {
    const outcome = gradeBrowserFields(
      { status: 'closed', deduction_amount: 0.1 },
      { status: 'closed', end_at: '2026-10-20T09:33:00Z', deduction_amount: '0.10000001' },
    );
    expect(outcome.status).toBe('invalid');
    expect(outcome.reason).toContain('EVIDENCE_VALUE_MISMATCH');
  });

  it('(d) 1 vs "1.01" stays a mismatch', () => {
    const outcome = gradeBrowserFields(
      { status: 'closed', deduction_amount: 1 },
      { status: 'closed', end_at: '2026-10-20T09:33:00Z', deduction_amount: '1.01' },
    );
    expect(outcome.status).toBe('invalid');
    expect(outcome.reason).toContain('EVIDENCE_VALUE_MISMATCH');
  });

  it('(d) a non-numeric string never decimal-compares: 2 vs "NaN"', () => {
    const outcome = gradeBrowserFields(
      { status: 'closed', deduction_amount: 2 },
      { status: 'closed', end_at: '2026-10-20T09:33:00Z', deduction_amount: 'NaN' },
    );
    expect(outcome.status).toBe('invalid');
    expect(outcome.reason).toContain('EVIDENCE_VALUE_MISMATCH');
  });

  it('(d) "Infinity" stays a mismatch: 2 vs "Infinity"', () => {
    const outcome = gradeBrowserFields(
      { status: 'closed', deduction_amount: 2 },
      { status: 'closed', end_at: '2026-10-20T09:33:00Z', deduction_amount: 'Infinity' },
    );
    expect(outcome.status).toBe('invalid');
    expect(outcome.reason).toContain('EVIDENCE_VALUE_MISMATCH');
  });

  it('(d) an empty string stays a mismatch: 2 vs ""', () => {
    const outcome = gradeBrowserFields(
      { status: 'closed', deduction_amount: 2 },
      { status: 'closed', end_at: '2026-10-20T09:33:00Z', deduction_amount: '' },
    );
    expect(outcome.status).toBe('invalid');
    expect(outcome.reason).toContain('EVIDENCE_VALUE_MISMATCH');
  });

  it('(d) a leading "+" stays a mismatch: 1 vs "+1"', () => {
    const outcome = gradeBrowserFields(
      { status: 'closed', deduction_amount: 1 },
      { status: 'closed', end_at: '2026-10-20T09:33:00Z', deduction_amount: '+1' },
    );
    expect(outcome.status).toBe('invalid');
    expect(outcome.reason).toContain('EVIDENCE_VALUE_MISMATCH');
  });

  it('(d) an exponent form on the string stays literal: 100 vs "1e2"', () => {
    const outcome = gradeBrowserFields(
      { status: 'closed', deduction_amount: 100 },
      { status: 'closed', end_at: '2026-10-20T09:33:00Z', deduction_amount: '1e2' },
    );
    expect(outcome.status).toBe('invalid');
    expect(outcome.reason).toContain('EVIDENCE_VALUE_MISMATCH');
  });

  it('(d) a number whose shortest string has an exponent stays literal: 1e-7 vs "0.0000001"', () => {
    const outcome = gradeBrowserFields(
      { status: 'closed', deduction_amount: 1e-7 },
      { status: 'closed', end_at: '2026-10-20T09:33:00Z', deduction_amount: '0.0000001' },
    );
    expect(outcome.status).toBe('invalid');
    expect(outcome.reason).toContain('EVIDENCE_VALUE_MISMATCH');
  });

  it('(d) number vs number keeps the exact rule: 0.1 vs 0.10000001 stays a mismatch', () => {
    const outcome = gradeBrowserFields(
      { status: 'closed', deduction_amount: 0.1 },
      { status: 'closed', end_at: '2026-10-20T09:33:00Z', deduction_amount: 0.10000001 },
    );
    expect(outcome.status).toBe('invalid');
    expect(outcome.reason).toContain('EVIDENCE_VALUE_MISMATCH');
  });

  it('(d) string vs string keeps the literal rule: "0.00" vs "0.0" stays a mismatch', () => {
    const outcome = gradeBrowserFields(
      { status: 'closed', deduction_amount: '0.00' },
      { status: 'closed', end_at: '2026-10-20T09:33:00Z', deduction_amount: '0.0' },
    );
    expect(outcome.status).toBe('invalid');
    expect(outcome.reason).toContain('EVIDENCE_VALUE_MISMATCH');
  });
});
