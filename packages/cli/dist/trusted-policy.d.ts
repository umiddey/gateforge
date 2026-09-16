import { type CauseCode, type GateforgeConfig } from '@gate-forge/core';
/** Env var carrying the owner-approved policy digest (protected CI variable / managed service). */
export declare const APPROVED_POLICY_DIGEST_ENV = "GATEFORGE_APPROVED_POLICY_DIGEST";
/**
 * Env var carrying an explicit trusted config path: a gateforge config
 * file OUTSIDE the candidate repository whose
 * `enforcement.approvedPolicyDigest` is honored as the approved policy
 * revision. A path inside the candidate is candidate-controlled and is
 * rejected in strict mode.
 */
export declare const TRUSTED_CONFIG_ENV = "GATEFORGE_TRUSTED_CONFIG";
/**
 * The precise next action for a policy-ownership block: names exactly
 * what happened (owner-owned policy changed) and what must happen (owner
 * approves and repins). Shared by every surface so text, JSON, SARIF,
 * broker rejections, and stderr notes all agree.
 */
export declare const WEAKENED_POLICY_NEXT_ACTION: string;
/** The provisioning next action for a strict run with no pinned revision. */
export declare const PROVISION_PIN_NEXT_ACTION: string;
/** Where a resolved approved digest came from (stable identifiers for reports). */
export type ApprovedPolicyOrigin = 'flag' | 'env' | 'trusted-config';
/**
 * The typed outcome of resolving the approved policy digest from trusted
 * channels:
 * - `ok` — zero or one agreed digest (digest null = none provisioned);
 * - `candidate-controlled` — the digest would come from candidate-controlled
 *   files (the candidate's own config, or a GATEFORGE_TRUSTED_CONFIG path
 *   inside the candidate); never honored, strict mode blocks;
 * - `invalid` — malformed or conflicting provisioning; strict mode blocks.
 */
export type ApprovedPolicyResolution = {
    status: 'ok';
    digest: string | null;
    origins: ApprovedPolicyOrigin[];
} | {
    status: 'candidate-controlled';
    detail: string;
} | {
    status: 'invalid';
    detail: string;
};
/** Inputs of {@link assertApprovedPolicy} (the spec'd integration point). */
export interface ApprovedPolicyInput {
    /**
     * The owner-approved digest resolved from trusted channels, or null
     * when none is provisioned.
     */
    approved: string | null;
    /**
     * Whether this gate binds the policy revision (strict surfaces:
     * `check --require-e2e` under `enforcement.strictE2E`, the managed
     * broker, receipt verification under a provisioned pin).
     */
    strict: boolean;
}
/**
 * The typed outcome of one approved-policy gate evaluation.
 * - `enforced` — a provisioned pin matched the candidate revision;
 * - `unenforced` — no pin is in force on this surface (standard run);
 *   the caller keeps current behavior;
 * - `blocked` — fail-closed block with a §5.4 cause, precise detail, and
 *   the exact owner next action.
 */
export type ApprovedPolicyGate = {
    status: 'enforced';
    approved: string;
} | {
    status: 'unenforced';
} | {
    status: 'blocked';
    cause: CauseCode;
    detail: string;
    nextAction: string;
};
/** The result of {@link assertApprovedPolicy} / {@link assertReceiptApprovedPolicy}. */
export type ApprovedPolicyResult = {
    ok: true;
    enforced: true;
    approved: string;
} | {
    ok: true;
    enforced: false;
} | {
    ok: false;
    cause: CauseCode;
    detail: string;
    nextAction: string;
};
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
export declare function resolveApprovedPolicyDigest(options: {
    flag?: string;
    env: NodeJS.ProcessEnv;
    candidateCwd: string;
    candidateConfig?: GateforgeConfig;
}): ApprovedPolicyResolution;
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
export declare function assertApprovedPolicy(candidateDigest: string, input: ApprovedPolicyInput): ApprovedPolicyResult;
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
export declare function evaluateApprovedPolicy(resolution: ApprovedPolicyResolution, candidateDigest: string, strict: boolean): ApprovedPolicyGate;
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
export declare function assertReceiptApprovedPolicy(receipt: {
    approvedPolicyDigest?: string;
}, approved: string): ApprovedPolicyResult;
/** The next action for a receipt that does not bind the current pin. */
export declare const RESEAL_NEXT_ACTION = "rerun `gateforge test-gates --changed` with the currently approved policy digest provisioned to seal a fresh receipt";
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
export declare function describeApprovedPolicyResolution(resolution: ApprovedPolicyResolution): string;
//# sourceMappingURL=trusted-policy.d.ts.map