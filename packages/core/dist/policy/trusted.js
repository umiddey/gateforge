/**
 * Protected policy ownership foundation (plan 2026-09-13 Phase 0 item 5,
 * ADR 0005 D6). Classifiers, exclusions, mappings that suppress scope,
 * adapters, runner definitions, gate binaries, CI jobs, baselines, and
 * waivers are TRUSTED-REVISION-OWNED: a candidate change that edits them
 * cannot authorize its own weaker checks. The engine therefore computes a
 * domain-separated digest over the effective policy/config bytes and
 * evaluates candidates against it.
 *
 * Phase 0 delivers the typed foundation only: the digest computation and
 * the pure weakening check, both unit-testable. Receipt binding and real
 * enforcement land in Phases 4-5 (plan §5.1 gate receipt: "trusted
 * policy/verifier digest").
 */
import { sha256Canonical, sha256Hex } from '../canonical-json.js';
import { compareStrings } from '../graph/util.js';
/** Domain tag separating trusted-policy digests from every other hash. */
export const TRUSTED_POLICY_DOMAIN = 'gateforge.trusted-policy.v1';
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
export function trustedPolicyDigest(inputs) {
    const seen = new Set();
    for (const input of inputs) {
        if (seen.has(input.name)) {
            throw new TypeError(`trustedPolicyDigest: duplicate policy input name '${input.name}'`);
        }
        seen.add(input.name);
    }
    const files = [...inputs]
        .sort((a, b) => compareStrings(a.name, b.name))
        .map((input) => ({ name: input.name, sha256: sha256Hex(input.bytes) }));
    return sha256Canonical({ domain: TRUSTED_POLICY_DOMAIN, files });
}
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
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
export function policyWeakenedCandidate(trustedDigest, candidateDigest) {
    if (!DIGEST_PATTERN.test(trustedDigest)) {
        return {
            weakened: true,
            reason: `trusted policy digest is missing or malformed ('${trustedDigest}'); a candidate cannot be trusted against an unverifiable revision (fail closed)`,
            trustedDigest,
            candidateDigest,
        };
    }
    if (!DIGEST_PATTERN.test(candidateDigest)) {
        return {
            weakened: true,
            reason: `candidate policy digest is missing or malformed ('${candidateDigest}'); the candidate's effective policy cannot be verified (fail closed)`,
            trustedDigest,
            candidateDigest,
        };
    }
    if (trustedDigest !== candidateDigest) {
        return {
            weakened: true,
            reason: 'candidate policy digest differs from the trusted policy revision: candidate edits to ' +
                'classifiers, exclusions, scope-suppressing mappings, adapters, runner definitions, ' +
                'baselines, or waivers cannot authorize their own weaker checks (a trusted update is required)',
            trustedDigest,
            candidateDigest,
        };
    }
    return { weakened: false, trustedDigest, candidateDigest };
}
//# sourceMappingURL=trusted.js.map