/**
 * Provenance verification tests (pin #7, GF-23): the record-id hash is
 * a pure function of the record identity, `isProvenancedRecord`
 * recomputes it and never throws on hostile input, and
 * `isWitnessedRecord` couples the trust assertion to provenance.
 */
import { describe, expect, it } from 'vitest';
import {
  ATTESTATION_DOMAIN,
  ATTESTATION_VERSION,
  attestationMac,
  canonicalJson,
  isProvenancedRecord,
  isWitnessedRecord,
  ledgerMac,
  recordIdOf,
  sha256Hex,
  verifyAttestationMac,
  verifyLedgerMac,
} from '../src/index.js';

const IDENTITY = {
  runId: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
  obligationId: 'tenant.accounts:crud:update',
  kind: 'ui.action',
  testId: 'test-1',
  origin: 'suite-submitted' as const,
  payload: { operation: 'update', entityId: 'acc-1' },
};

describe('recordIdOf (pin #1/#7)', () => {
  it('is sha256 over the canonical JSON of exactly the identity fields', () => {
    expect(recordIdOf(IDENTITY)).toBe(
      sha256Hex(
        canonicalJson({
          runId: IDENTITY.runId,
          obligationId: IDENTITY.obligationId,
          kind: IDENTITY.kind,
          testId: IDENTITY.testId,
          origin: IDENTITY.origin,
          payload: IDENTITY.payload,
        }),
      ),
    );
  });

  it('is independent of key insertion order and changes with any field', () => {
    const reordered = {
      payload: IDENTITY.payload,
      origin: IDENTITY.origin,
      testId: IDENTITY.testId,
      kind: IDENTITY.kind,
      obligationId: IDENTITY.obligationId,
      runId: IDENTITY.runId,
    };
    expect(recordIdOf(reordered)).toBe(recordIdOf(IDENTITY));
    expect(recordIdOf({ ...IDENTITY, payload: { ...IDENTITY.payload, entityId: 'acc-2' } })).not.toBe(
      recordIdOf(IDENTITY),
    );
    expect(recordIdOf({ ...IDENTITY, testId: 'test-2' })).not.toBe(recordIdOf(IDENTITY));
    expect(recordIdOf({ ...IDENTITY, origin: 'engine-observed' })).not.toBe(recordIdOf(IDENTITY));
  });

  it('throws on a payload that has no canonical JSON representation', () => {
    expect(() => recordIdOf({ ...IDENTITY, payload: { at: new Date() } })).toThrow(TypeError);
    expect(() => recordIdOf({ ...IDENTITY, payload: undefined })).toThrow(TypeError);
    expect(() => recordIdOf({ ...IDENTITY, origin: 'forged' as never })).toThrow(TypeError);
  });
});

describe('isProvenancedRecord (adversary-safe recomputation)', () => {
  const recordId = recordIdOf(IDENTITY);

  it('accepts a witness-issued record', () => {
    expect(isProvenancedRecord({ ...IDENTITY, recordId, trust: 'witnessed' })).toBe(true);
  });

  it('rejects arbitrary 64-hex ids that do not recompute (audit repro)', () => {
    expect(isProvenancedRecord({ ...IDENTITY, recordId: 'a'.repeat(64) })).toBe(false);
  });

  it('rejects a correct id over altered contents', () => {
    expect(
      isProvenancedRecord({
        ...IDENTITY,
        payload: { operation: 'update', entityId: 'acc-9' },
        recordId,
      }),
    ).toBe(false);
  });

  it('rejects malformed structure without throwing', () => {
    const hostile: unknown[] = [
      null,
      42,
      'record',
      [],
      {},
      { ...IDENTITY, recordId: 'made-up-id-not-issued-by-the-witness' },
      { ...IDENTITY, recordId: 'A'.repeat(64) }, // uppercase: not the issued form
      { ...IDENTITY, recordId, runId: '' },
      { ...IDENTITY, recordId, obligationId: undefined },
      { ...IDENTITY, recordId, kind: 7 },
      { ...IDENTITY, recordId, testId: null },
      { ...IDENTITY, recordId, origin: 'forged' }, // not an issued origin
      { ...IDENTITY, recordId, origin: undefined }, // pre-origin record: demotes
      { ...IDENTITY, recordId, payload: { at: new Date() } }, // non-JSON payload
    ];
    for (const entry of hostile) {
      expect(() => isProvenancedRecord(entry)).not.toThrow();
      expect(isProvenancedRecord(entry)).toBe(false);
    }
  });
});

describe('isWitnessedRecord', () => {
  it('couples the trust assertion to verified provenance', () => {
    const recordId = recordIdOf(IDENTITY);
    expect(isWitnessedRecord({ ...IDENTITY, recordId, trust: 'witnessed' })).toBe(true);
    expect(isWitnessedRecord({ ...IDENTITY, recordId, trust: 'claimed' })).toBe(false);
    expect(isWitnessedRecord({ ...IDENTITY, recordId: 'a'.repeat(64), trust: 'witnessed' })).toBe(
      false,
    );
    expect(isWitnessedRecord('witnessed')).toBe(false);
  });
});

describe('ledgerMac / verifyLedgerMac (verifier-key attestation, GF-23)', () => {
  const KEY = 'verifier-secret-the-suite-never-sees';
  const OTHER_KEY = 'another-verifier-secret';
  const RUN = '6f1c3f90-2d5e-4b1a-9c6d-0f0e2b8a1c9d';
  const IDS = ['b'.repeat(64), 'a'.repeat(64)];

  it('is stable across key order and normalization of the id set', () => {
    expect(ledgerMac(KEY, RUN, IDS)).toBe(ledgerMac(KEY, RUN, [...IDS].reverse()));
    expect(ledgerMac(KEY, RUN, ['a'.repeat(64), 'a'.repeat(64), 'b'.repeat(64)])).toBe(
      ledgerMac(KEY, RUN, IDS),
    );
  });

  it('binds the exact (runId, id set, key) triple', () => {
    const mac = ledgerMac(KEY, RUN, IDS);
    expect(verifyLedgerMac(KEY, RUN, IDS, mac)).toBe(true);
    // Tampered id set: adding a forged id invalidates the MAC even when
    // the attacker fully controls the manifest file.
    expect(verifyLedgerMac(KEY, RUN, [...IDS, 'c'.repeat(64)], mac)).toBe(false);
    expect(verifyLedgerMac(KEY, RUN, [IDS[0] as string], mac)).toBe(false);
    // Transplanted run identity.
    expect(verifyLedgerMac(KEY, '00000000-0000-4000-8000-000000000009', IDS, mac)).toBe(false);
    // Wrong verifier key (the only secret that can mint a valid MAC).
    expect(verifyLedgerMac(OTHER_KEY, RUN, IDS, mac)).toBe(false);
  });

  it('rejects malformed MACs and hostile inputs without throwing', () => {
    const hostile: Array<[string, string, readonly string[], unknown]> = [
      [KEY, RUN, IDS, 'made-up-mac'],
      [KEY, RUN, IDS, 'A'.repeat(64)],
      [KEY, RUN, IDS, ''],
      [KEY, RUN, IDS, null],
      [KEY, RUN, IDS, 42],
      [KEY, '', IDS, ledgerMac(KEY, 'x', IDS)],
    ];
    for (const [key, run, ids, mac] of hostile) {
      expect(() => verifyLedgerMac(key, run, ids, mac)).not.toThrow();
      expect(verifyLedgerMac(key, run, ids, mac)).toBe(false);
    }
  });

  it('throws on an empty verifier key (never mint unauthenticated MACs)', () => {
    expect(() => ledgerMac('', RUN, IDS)).toThrow(TypeError);
    expect(() => verifyLedgerMac('', RUN, IDS, 'a'.repeat(64))).not.toThrow();
  });
});

describe('attestationMac / verifyAttestationMac (v2 envelope, plan §11.3)', () => {
  const KEY = 'verifier-secret-the-suite-never-sees';
  const OTHER_KEY = 'another-verifier-secret';
  const BODY = {
    runId: '6f1c3f90-2d5e-4b1a-9c6d-0f0e2b8a1c9d',
    invocationId: 'aaaaaaaa-0000-4000-8000-000000000001',
    inputDigest: 'b'.repeat(64),
    recordIds: ['b'.repeat(64), 'a'.repeat(64)],
  };

  it('uses the versioned domain tag and normalizes the id set', () => {
    expect(ATTESTATION_DOMAIN).toBe('gateforge.ledger.v2');
    expect(ATTESTATION_VERSION).toBe(2);
    expect(attestationMac(KEY, BODY)).toBe(
      attestationMac(KEY, { ...BODY, recordIds: [...BODY.recordIds].reverse() }),
    );
    expect(
      verifyAttestationMac(
        KEY,
        { runId: BODY.runId, invocationId: BODY.invocationId, inputDigest: BODY.inputDigest, recordIds: BODY.recordIds },
        attestationMac(KEY, BODY),
      ),
    ).toBe(true);
  });

  it('binds run, invocation, digest, and key: any change invalidates', () => {
    const mac = attestationMac(KEY, BODY);
    const verify = (body: typeof BODY): boolean =>
      verifyAttestationMac(
        KEY,
        { runId: body.runId, invocationId: body.invocationId, inputDigest: body.inputDigest, recordIds: body.recordIds },
        mac,
      );
    expect(verify({ ...BODY, recordIds: [...BODY.recordIds, 'c'.repeat(64)] })).toBe(false);
    expect(verify({ ...BODY, inputDigest: 'c'.repeat(64) })).toBe(false);
    expect(
      verify({ ...BODY, invocationId: 'bbbbbbbb-0000-4000-8000-000000000002' }),
    ).toBe(false);
    expect(verify({ ...BODY, runId: '00000000-0000-4000-8000-000000000009' })).toBe(false);
    expect(
      verifyAttestationMac(
        OTHER_KEY,
        { runId: BODY.runId, invocationId: BODY.invocationId, inputDigest: BODY.inputDigest, recordIds: BODY.recordIds },
        mac,
      ),
    ).toBe(false);
  });

  it('a legacy v1 MAC never verifies as v2 (F2: old evidence authorizes nothing)', () => {
    const legacy = ledgerMac(KEY, BODY.runId, BODY.recordIds);
    expect(
      verifyAttestationMac(
        KEY,
        { runId: BODY.runId, invocationId: BODY.invocationId, inputDigest: BODY.inputDigest, recordIds: BODY.recordIds },
        legacy,
      ),
    ).toBe(false);
  });

  it('rejects malformed bodies and MACs without throwing', () => {
    const mac = attestationMac(KEY, BODY);
    const hostile: Array<{ body: unknown; mac: unknown }> = [
      { body: null, mac },
      { body: { ...BODY, recordIds: 'not-an-array' }, mac },
      { body: { ...BODY, inputDigest: 'xyz' }, mac },
      { body: BODY, mac: 'made-up-mac' },
      { body: BODY, mac: 'A'.repeat(64) },
      { body: BODY, mac: null },
    ];
    for (const { body, mac: claimed } of hostile) {
      expect(() =>
        verifyAttestationMac(
          KEY,
          body as { runId: unknown; invocationId: unknown; inputDigest: unknown; recordIds: unknown },
          claimed,
        ),
      ).not.toThrow();
      expect(
        verifyAttestationMac(
          KEY,
          body as { runId: unknown; invocationId: unknown; inputDigest: unknown; recordIds: unknown },
          claimed,
        ),
      ).toBe(false);
    }
  });

  it('throws on empty key, empty identities, or a non-hex digest', () => {
    expect(() => attestationMac('', BODY)).toThrow(TypeError);
    expect(() => attestationMac(KEY, { ...BODY, runId: '' })).toThrow(TypeError);
    expect(() => attestationMac(KEY, { ...BODY, invocationId: '' })).toThrow(TypeError);
    expect(() => attestationMac(KEY, { ...BODY, inputDigest: 'xyz' })).toThrow(TypeError);
  });
});
