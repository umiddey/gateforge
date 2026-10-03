/**
 * The signature-profile grammar (plan 2026-09-25 Phase 1): one parser
 * shared by the config schema and the witness request driver, so a
 * profile is either understood everywhere or refused everywhere — never
 * silently defaulted.
 */
import { describe, expect, it } from 'vitest';
import {
  BEHAVIOR_SIGNING_SECRET_HEADER,
  DEFAULT_SIGNATURE_ATTEMPT_HEADER,
  DEFAULT_SIGNATURE_HEADER,
  DEFAULT_SIGNATURE_TIMESTAMP_HEADER,
  parseBehaviorSignatureProfile,
} from '../src/index.js';

describe('parseBehaviorSignatureProfile', () => {
  it('a bare hmac-sha256 profile is exactly the historical default', () => {
    const parsed = parseBehaviorSignatureProfile('hmac-sha256');
    expect(parsed.ok).toBe(true);
    expect(parsed.ok && parsed.profile).toEqual({
      algorithm: 'hmac-sha256',
      header: DEFAULT_SIGNATURE_HEADER,
      timestampHeader: DEFAULT_SIGNATURE_TIMESTAMP_HEADER,
      toleranceMs: null,
      attemptHeader: DEFAULT_SIGNATURE_ATTEMPT_HEADER,
      attempt: 1,
      forgery: 'none',
    });
  });

  it('every parameter is honored, and an explicit none drops its header', () => {
    const parsed = parseBehaviorSignatureProfile(
      'hmac-sha256;header=x-hub-signature-256;timestampHeader=none;attemptHeader=x-attempt;attempt=2;forgery=signature',
    );
    expect(parsed.ok && parsed.profile).toEqual({
      algorithm: 'hmac-sha256',
      header: 'x-hub-signature-256',
      timestampHeader: null,
      // Dropping the timestamp header drops its tolerance with it: a
      // tolerance on a header that is never stamped is not a fact.
      toleranceMs: null,
      attemptHeader: 'x-attempt',
      attempt: 2,
      forgery: 'signature',
    });
  });

  it('a declared tolerance survives a declared timestamp', () => {
    const parsed = parseBehaviorSignatureProfile('hmac-sha256;timestampHeader=x-ts;toleranceMs=300000');
    expect(parsed.ok && parsed.profile.toleranceMs).toBe(300_000);
  });

  it('refuses an unknown algorithm, parameter, forgery, or value', () => {
    expect(parseBehaviorSignatureProfile('md5')).toMatchObject({ ok: false });
    expect(parseBehaviorSignatureProfile('hmac-sha256;algorithm=md5')).toEqual({
      ok: false,
      error: "unknown signature profile parameter 'algorithm'",
    });
    expect(parseBehaviorSignatureProfile('hmac-sha256;forgery=payload')).toMatchObject({ ok: false });
    expect(parseBehaviorSignatureProfile('hmac-sha256;attempt=0')).toMatchObject({ ok: false });
    expect(parseBehaviorSignatureProfile('hmac-sha256;attempt=-1')).toMatchObject({ ok: false });
    expect(parseBehaviorSignatureProfile('hmac-sha256;toleranceMs=99999999999')).toMatchObject({ ok: false });
    expect(parseBehaviorSignatureProfile('hmac-sha256;header')).toMatchObject({ ok: false });
    expect(parseBehaviorSignatureProfile('hmac-sha256;header=;forgery=none')).toMatchObject({ ok: false });
    expect(parseBehaviorSignatureProfile('hmac-sha256;header=x sig')).toMatchObject({ ok: false });
    expect(parseBehaviorSignatureProfile('hmac-sha256;attempt=1;attempt=2')).toMatchObject({ ok: false });
  });

  it('never lets the engine signing secret be stamped as a header', () => {
    const parsed = parseBehaviorSignatureProfile(`hmac-sha256;header=${BEHAVIOR_SIGNING_SECRET_HEADER}`);
    expect(parsed.ok).toBe(false);
    expect(parsed.ok === false && parsed.error).toContain('reserved');
  });

  it('rejects a header name that could inject a line into the request', () => {
    for (const name of ['x-sig\r\nx-evil', 'x sig', 'x:sig', '', 'x/sig']) {
      expect(parseBehaviorSignatureProfile(`hmac-sha256;header=${name}`).ok, name).toBe(false);
    }
  });
});
