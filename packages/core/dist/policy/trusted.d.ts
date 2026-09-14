/** Domain tag separating trusted-policy digests from every other hash. */
export declare const TRUSTED_POLICY_DOMAIN = "gateforge.trusted-policy.v1";
/** One trusted policy/config document's effective bytes. */
export interface TrustedPolicyInput {
    /** Stable repo-root-relative name, e.g. `.gateforge/policies.yml`. */
    name: string;
    /** The exact effective bytes of the document. */
    bytes: string;
}
/**
 * Computes the trusted policy digest: a domain-separated canonical hash
 * over the named document bytes (each byte-hashed, entries sorted by
 * name). Deterministic — identical policy revisions produce identical
 * digests, so a receipt can bind "evaluated under this policy revision"
 * and any later byte change breaks the binding.
 *
 * Args:
 *   inputs: the effective policy/config documents (config, policies,
 *     classification policy, adapters, baselines, waivers, runner
 *     definitions — the trusted-revision-owned set).
 *
 * Returns:
 *   string: 64-char lowercase hex digest.
 *
 * Throws:
 *   TypeError: when the same name appears twice (an ambiguous trusted
 *     revision is a caller bug, never silently deduplicated).
 */
export declare function trustedPolicyDigest(inputs: readonly TrustedPolicyInput[]): string;
/** The typed outcome of comparing a candidate revision to the trusted one. */
export type PolicyWeakeningCheck = {
    weakened: false;
    trustedDigest: string;
    candidateDigest: string;
} | {
    /** True when the candidate is not byte-identical to the trusted revision. */
    weakened: true;
    /** Single-cause fail-closed explanation. */
    reason: string;
    trustedDigest: string;
    candidateDigest: string;
};
/**
 * The pure weakening check (ADR 0005 D6): a candidate whose policy digest
 * differs from the trusted revision is a WEAKENING CANDIDATE — it may
 * only proceed after a separate trusted update is accepted, never by
 * self-approval. Fail-closed: a missing or malformed digest cannot be
 * verified, so it counts as weakened rather than trusted.
 *
 * Args:
 *   trustedDigest: the digest of the trusted policy revision.
 *   candidateDigest: the digest of the candidate's effective policy.
 *
 * Returns:
 *   PolicyWeakeningCheck: `{weakened: false}` only for an exact, well-formed
 *   match; otherwise `{weakened: true, reason}` naming the failure.
 */
export declare function policyWeakenedCandidate(trustedDigest: string, candidateDigest: string): PolicyWeakeningCheck;
//# sourceMappingURL=trusted.d.ts.map