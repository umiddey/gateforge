/**
 * Protected policy ownership foundation tests (plan 2026-09-13 Phase 0
 * item 5, ADR 0005 D6): the trusted policy digest is domain-separated and
 * byte-sensitive, and the pure weakening check fails closed — any digest
 * difference (or a missing/malformed digest) is a weakening candidate
 * until a separate trusted update is accepted.
 */
import { describe, expect, it } from 'vitest';
import {
  TRUSTED_POLICY_DOMAIN,
  policyWeakenedCandidate,
  trustedPolicyDigest,
  type TrustedPolicyInput,
} from '../src/index.js';

const POLICY_SET: readonly TrustedPolicyInput[] = [
  { name: '.gateforge/policies.yml', bytes: 'schemaVersion: 1\npolicies: []\n' },
  { name: '.gateforge.yml', bytes: 'schemaVersion: 1\n' },
];

describe('trustedPolicyDigest', () => {
  it('is deterministic regardless of input order', () => {
    const a = trustedPolicyDigest(POLICY_SET);
    const b = trustedPolicyDigest([...POLICY_SET].reverse());
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it('changes when any trusted document byte changes', () => {
    const base = trustedPolicyDigest(POLICY_SET);
    const weakened: readonly TrustedPolicyInput[] = [
      POLICY_SET[0] as TrustedPolicyInput,
      { name: '.gateforge.yml', bytes: 'schemaVersion: 1\nenforcement:\n  strictE2E: false\n' },
    ];
    expect(trustedPolicyDigest(weakened)).not.toBe(base);
  });

  it('is domain-separated from other named inputs', () => {
    const digest = trustedPolicyDigest([{ name: 'p', bytes: 'x' }]);
    const renamed = trustedPolicyDigest([{ name: 'q', bytes: 'x' }]);
    // The name participates in the hash, so the digest is not a bare
    // byte hash and cannot be reused across documents.
    expect(digest).not.toBe(renamed);
    expect(TRUSTED_POLICY_DOMAIN).toBe('gateforge.trusted-policy.v1');
  });

  it('rejects duplicate input names (ambiguous revisions fail closed)', () => {
    expect(() =>
      trustedPolicyDigest([
        { name: 'same', bytes: 'a' },
        { name: 'same', bytes: 'b' },
      ]),
    ).toThrow(TypeError);
    expect(() => trustedPolicyDigest([{ name: 'same', bytes: 'a' }])).not.toThrow();
  });
});

describe('policyWeakenedCandidate', () => {
  const trusted = trustedPolicyDigest(POLICY_SET);

  it('an identical candidate revision is not weakened', () => {
    const result = policyWeakenedCandidate(trusted, trusted);
    expect(result.weakened).toBe(false);
  });

  it('a different candidate digest is a weakening candidate with a precise reason', () => {
    const candidate = trustedPolicyDigest([
      POLICY_SET[0] as TrustedPolicyInput,
      { name: '.gateforge.yml', bytes: 'schemaVersion: 1\n# weakened\n' },
    ]);
    const result = policyWeakenedCandidate(trusted, candidate);
    expect(result.weakened).toBe(true);
    if (result.weakened) {
      expect(result.reason).toContain('cannot authorize their own weaker checks');
    }
  });

  it('missing or malformed digests count as weakened (fail closed)', () => {
    for (const [trustedDigest, candidateDigest] of [
      ['', trusted],
      ['not-a-digest', trusted],
      [trusted, ''],
      [trusted, 'Z'.repeat(64)],
    ] as const) {
      const result = policyWeakenedCandidate(trustedDigest, candidateDigest);
      expect(result.weakened).toBe(true);
    }
  });
});
