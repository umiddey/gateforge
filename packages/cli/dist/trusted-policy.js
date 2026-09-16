/**
 * Approved-policy-revision authority (review 2026-09-13 P1 #5: "candidate
 * policy is treated as trusted"). The trusted policy digest is computed
 * from the CANDIDATE repository (`.gateforge.yml`, policies,
 * classification policy, mapping sidecar) — by itself it proves only
 * WHICH policy revision a run used, never that anyone APPROVED it. This
 * module supplies the missing half: the owner-approved digest must be
 * provisioned from OUTSIDE the candidate, and every strict gate compares
 * the candidate's recomputed digest against it via core's
 * `policyWeakenedCandidate` (which until now had no production caller).
 *
 * Trusted provisioning channels (in resolution order, all must agree):
 * - `--approved-policy-digest <hex>` on the gate invocation (an operator
 *   flag; only as trustworthy as the process boundary running the CLI);
 * - `GATEFORGE_APPROVED_POLICY_DIGEST` (a protected CI variable /
 *   managed-service environment — the intended deployment channel);
 * - `enforcement.approvedPolicyDigest` in a gateforge config loaded
 *   through `GATEFORGE_TRUSTED_CONFIG` — honored ONLY when that file
 *   lives outside the candidate repository (lexical path check).
 *
 * Trust boundaries honored here:
 * - the candidate's OWN `.gateforge.yml` is NEVER a source: declaring
 *   `enforcement.approvedPolicyDigest` there is a typed strict-mode block
 *   (candidate-controlled files cannot approve policy);
 * - multiple channels supplying DIFFERENT digests fail closed;
 * - a malformed digest fails closed;
 * - in strict mode a MISSING digest blocks with the exact provisioning
 *   step the owner must perform — the gate never silently proceeds.
 *
 * Standard (non-strict) runs without a provisioned digest keep the exact
 * historical behavior — the pin is opt-in; `enforcement doctor` reports
 * its absence honestly.
 */
import { existsSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { loadConfig, policyWeakenedCandidate } from '@gate-forge/core';
/** Env var carrying the owner-approved policy digest (protected CI variable / managed service). */
export const APPROVED_POLICY_DIGEST_ENV = 'GATEFORGE_APPROVED_POLICY_DIGEST';
/**
 * Env var carrying an explicit trusted config path: a gateforge config
 * file OUTSIDE the candidate repository whose
 * `enforcement.approvedPolicyDigest` is honored as the approved policy
 * revision. A path inside the candidate is candidate-controlled and is
 * rejected in strict mode.
 */
export const TRUSTED_CONFIG_ENV = 'GATEFORGE_TRUSTED_CONFIG';
/** Shape every digest must have (matches core trusted-policy digests). */
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
/**
 * The precise next action for a policy-ownership block: names exactly
 * what happened (owner-owned policy changed) and what must happen (owner
 * approves and repins). Shared by every surface so text, JSON, SARIF,
 * broker rejections, and stderr notes all agree.
 */
export const WEAKENED_POLICY_NEXT_ACTION = 'the candidate changes owner-owned policy (classifiers/exclusions/waivers/baselines/coverage); ' +
    'have the owner approve and repin the revision, then rerun';
/** The provisioning next action for a strict run with no pinned revision. */
export const PROVISION_PIN_NEXT_ACTION = 'provision the owner-approved policy digest OUTSIDE the candidate ' +
    `(${APPROVED_POLICY_DIGEST_ENV} as a protected variable, --approved-policy-digest on the gate invocation, ` +
    `or enforcement.approvedPolicyDigest in a ${TRUSTED_CONFIG_ENV} file outside the candidate), then rerun`;
/**
 * Resolves the owner-approved policy digest from trusted channels (flag,
 * protected env, trusted config outside the candidate). Never reads
 * policy approval from candidate-controlled files: a candidate config
 * that DECLARES `enforcement.approvedPolicyDigest` yields
 * `candidate-controlled`, and a `GATEFORGE_TRUSTED_CONFIG` path inside
 * the candidate does too. Deterministic; performs no candidate-policy
 * hashing (the caller supplies the candidate digest separately).
 *
 * Args:
 *   options.flag: the `--approved-policy-digest` value, when supplied.
 *   options.env: the process environment (read-only).
 *   options.candidateCwd: the candidate repository root.
 *   options.candidateConfig: the candidate-loaded gateforge config, used
 *     ONLY to detect candidate-declared pins (never as a source).
 *
 * Returns:
 *   ApprovedPolicyResolution: the typed resolution (fail-closed shapes
 *   for candidate-controlled, malformed, and conflicting provisioning).
 */
export function resolveApprovedPolicyDigest(options) {
    // The candidate's own config is never a source. Its declaring the key
    // at all is reported so strict gates can block deterministically.
    const candidateDeclared = options.candidateConfig?.enforcement?.approvedPolicyDigest;
    if (candidateDeclared !== undefined) {
        return {
            status: 'candidate-controlled',
            detail: `the candidate's own .gateforge.yml declares enforcement.approvedPolicyDigest; ` +
                'candidate-controlled files cannot approve policy (remove the key and provision the digest outside the candidate)',
        };
    }
    const sources = [];
    // 1. Explicit operator flag.
    if (options.flag !== undefined && options.flag.length > 0) {
        if (!DIGEST_PATTERN.test(options.flag)) {
            return {
                status: 'invalid',
                detail: `--approved-policy-digest must be 64-char lowercase hex (got '${options.flag}')`,
            };
        }
        sources.push({ origin: 'flag', digest: options.flag });
    }
    // 2. Protected CI variable / managed service.
    const envDigest = options.env[APPROVED_POLICY_DIGEST_ENV];
    if (envDigest !== undefined && envDigest.length > 0) {
        if (!DIGEST_PATTERN.test(envDigest)) {
            return {
                status: 'invalid',
                detail: `${APPROVED_POLICY_DIGEST_ENV} must be 64-char lowercase hex (got '${envDigest}'); ` +
                    'fix the protected variable (fail closed)',
            };
        }
        sources.push({ origin: 'env', digest: envDigest });
    }
    // 3. Trusted config OUTSIDE the candidate.
    const trustedConfigPath = options.env[TRUSTED_CONFIG_ENV];
    if (trustedConfigPath !== undefined && trustedConfigPath.length > 0) {
        const resolvedTrusted = resolve(trustedConfigPath);
        if (isInside(resolvedTrusted, resolve(options.candidateCwd))) {
            return {
                status: 'candidate-controlled',
                detail: `${TRUSTED_CONFIG_ENV} points at '${trustedConfigPath}', which is inside the candidate repository; ` +
                    'candidate-controlled files cannot approve policy — place the trusted config outside the candidate',
            };
        }
        if (!existsSync(resolvedTrusted)) {
            return {
                status: 'invalid',
                detail: `${TRUSTED_CONFIG_ENV} points at '${trustedConfigPath}', which does not exist (fail closed)`,
            };
        }
        let config;
        try {
            // The trusted config must be a full, valid gateforge config document.
            config = loadConfig(resolvedTrusted);
        }
        catch (error) {
            return {
                status: 'invalid',
                detail: `${TRUSTED_CONFIG_ENV} file '${trustedConfigPath}' is not a valid gateforge config: ` +
                    `${error.message.split('\n')[0] ?? 'unknown error'}`,
            };
        }
        const declared = config.enforcement?.approvedPolicyDigest;
        if (declared !== undefined) {
            sources.push({ origin: 'trusted-config', digest: declared });
        }
    }
    // All supplied channels must agree — two different "approved" revisions
    // mean no approved revision (fail closed, never last-writer-wins).
    const distinct = new Set(sources.map((source) => source.digest));
    if (distinct.size > 1) {
        const listed = sources.map((source) => `${source.origin}=${source.digest.slice(0, 12)}…`).join(', ');
        return {
            status: 'invalid',
            detail: `conflicting approved policy digests provisioned (${listed}); the owner must pin exactly one revision`,
        };
    }
    const only = sources[0];
    return only === undefined
        ? { status: 'ok', digest: null, origins: [] }
        : { status: 'ok', digest: only.digest, origins: [only.origin] };
}
/**
 * THE single-call integration point for strict gates (the orchestrator
 * wires `test-gates --changed` with exactly this call): compare the
 * CANDIDATE's recomputed trusted policy digest against the OWNER-APPROVED
 * digest via core's `policyWeakenedCandidate` — a mismatch is a typed
 * ENFORCEMENT_UNTRUSTED block, a missing pin in strict mode is a
 * fail-closed block naming exactly what the owner must provision, and a
 * non-strict call without a pin keeps current behavior.
 *
 * Args:
 *   candidateDigest: the candidate's recomputed trusted policy digest
 *     (core `trustedPolicyDigest` over the candidate's effective bytes).
 *   input: the resolved approved digest (null when none provisioned) and
 *     whether this surface binds the revision (strict).
 *
 * Returns:
 *   ApprovedPolicyResult: ok+enforced (pin matched), ok+unenforced
 *   (standard run, no pin), or a typed fail-closed block.
 */
export function assertApprovedPolicy(candidateDigest, input) {
    if (input.approved === null) {
        if (!input.strict)
            return { ok: true, enforced: false };
        return {
            ok: false,
            cause: 'ENFORCEMENT_UNTRUSTED',
            detail: 'no owner-approved policy digest is provisioned, so strict enforcement cannot verify who owns the ' +
                "candidate's policy revision — a weakened candidate could otherwise approve its own weaker checks (fail closed)",
            nextAction: PROVISION_PIN_NEXT_ACTION,
        };
    }
    const weakening = policyWeakenedCandidate(input.approved, candidateDigest);
    if (weakening.weakened) {
        return {
            ok: false,
            cause: 'ENFORCEMENT_UNTRUSTED',
            detail: `candidate policy digest does not match the owner-approved revision: ${weakening.reason}`,
            nextAction: WEAKENED_POLICY_NEXT_ACTION,
        };
    }
    return { ok: true, enforced: true, approved: input.approved };
}
/**
 * Full gate evaluation from a {@link resolveApprovedPolicyDigest}
 * outcome: maps candidate-controlled/invalid provisioning onto blocks in
 * strict mode (ignored — honestly unenforced — otherwise), then applies
 * {@link assertApprovedPolicy}. This is the shape `check --require-e2e`
 * and the broker consume.
 *
 * Args:
 *   resolution: the resolved approved digest (see above).
 *   candidateDigest: the candidate's recomputed trusted policy digest.
 *   strict: whether this surface binds the revision (strict surfaces:
 *     require-e2e under enforcement.strictE2E, the managed broker).
 *
 * Returns:
 *   ApprovedPolicyGate: enforced / unenforced / blocked (fail closed).
 */
export function evaluateApprovedPolicy(resolution, candidateDigest, strict) {
    if (resolution.status !== 'ok') {
        if (!strict)
            return { status: 'unenforced' };
        return {
            status: 'blocked',
            cause: 'ENFORCEMENT_UNTRUSTED',
            detail: resolution.detail,
            nextAction: resolution.status === 'candidate-controlled'
                ? WEAKENED_POLICY_NEXT_ACTION
                : PROVISION_PIN_NEXT_ACTION,
        };
    }
    const assertion = assertApprovedPolicy(candidateDigest, { approved: resolution.digest, strict });
    if (!assertion.ok) {
        return { status: 'blocked', cause: assertion.cause, detail: assertion.detail, nextAction: assertion.nextAction };
    }
    return assertion.enforced ? { status: 'enforced', approved: assertion.approved } : { status: 'unenforced' };
}
/**
 * Binds a verified receipt to the currently approved policy revision
 * (review item 3): a receipt sealed under a since-revoked or different
 * approved revision is a typed reject — "policy revision changed after
 * sealing". Under a provisioned pin, strict verification also demands
 * the field outright: receipts sealed without it predate the pin and
 * cannot prove which approved revision they used. Never called without a
 * provisioned pin (without a pin there is nothing to bind; old receipts
 * stay verifiable — pinned with tests).
 *
 * Args:
 *   receipt: a MAC-verified gate receipt (the approvedPolicyDigest field
 *     is additive and may be absent).
 *   approved: the currently approved digest (non-null).
 *
 * Returns:
 *   ApprovedPolicyResult: ok when the receipt binds the current pin;
 *   otherwise a typed ENFORCEMENT_UNTRUSTED reject.
 */
export function assertReceiptApprovedPolicy(receipt, approved) {
    const sealed = receipt.approvedPolicyDigest;
    if (sealed === undefined) {
        return {
            ok: false,
            cause: 'ENFORCEMENT_UNTRUSTED',
            detail: 'the gate receipt carries no approvedPolicyDigest binding, so it cannot prove it was sealed under the ' +
                'currently approved policy revision (sealed before the pin was provisioned, or the policy revision ' +
                'changed after sealing) — strict verification demands the binding (fail closed)',
            nextAction: RESEAL_NEXT_ACTION,
        };
    }
    if (sealed !== approved) {
        return {
            ok: false,
            cause: 'ENFORCEMENT_UNTRUSTED',
            detail: `the gate receipt was sealed under approved policy '${sealed}' but the currently approved revision is ` +
                `'${approved}' (policy revision changed after sealing; fail closed)`,
            nextAction: RESEAL_NEXT_ACTION,
        };
    }
    return { ok: true, enforced: true, approved };
}
/** The next action for a receipt that does not bind the current pin. */
export const RESEAL_NEXT_ACTION = 'rerun `gateforge test-gates --changed` with the currently approved policy digest provisioned to seal a fresh receipt';
/**
 * Renders a resolution for honest doctor-style surfaces (never blocks):
 * 'absent' when nothing is provisioned, 'pinned (<short> via <channels>)'
 * otherwise, plus the fail-closed descriptions.
 *
 * Args:
 *   resolution: the resolved approved digest.
 *
 * Returns:
 *   string: the one-line honest description.
 */
export function describeApprovedPolicyResolution(resolution) {
    if (resolution.status === 'candidate-controlled') {
        return `approved policy digest: DECLARED IN CANDIDATE-CONTROLLED FILES (not trusted; ${resolution.detail})`;
    }
    if (resolution.status === 'invalid') {
        return `approved policy digest: invalid provisioning (${resolution.detail})`;
    }
    if (resolution.digest === null) {
        return ('approved policy digest: absent (policy-revision ownership NOT enforced — provision ' +
            `${APPROVED_POLICY_DIGEST_ENV} outside the candidate to pin the approved revision)`);
    }
    return `approved policy digest: pinned (${resolution.digest.slice(0, 12)}… via ${resolution.origins.join('+')})`;
}
/**
 * Lexical containment check: is `candidate` inside (or equal to)
 * `root`? Deterministic path reasoning; a symlinked trusted config that
 * resolves back into the candidate is a deployment concern the doctor
 * and this check cannot fully see (documented boundary, ADR 0005 D1).
 *
 * Args:
 *   candidate: absolute path to classify.
 *   root: absolute candidate-repository root.
 *
 * Returns:
 *   boolean: true when `candidate` is inside `root`.
 */
function isInside(candidate, root) {
    const rel = relative(root, candidate);
    return rel === '' || (!rel.startsWith(`..${'/'}`) && rel !== '..' && !isAbsolute(rel));
}
//# sourceMappingURL=trusted-policy.js.map