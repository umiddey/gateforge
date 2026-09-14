/**
 * Verdict engine (G3) — the pure pin-#9 evaluator plus its batch
 * wrapper. See ./evaluate.ts for the encoded ADR 0001 rules.
 */
export {
  BLOCKING_VERDICTS,
  GateforgeVerdictError,
  evaluateObligation,
  evaluateObligations,
  parseInstant,
} from './evaluate.js';
export type {
  ObligationVerdict,
  VerdictContext,
  VerdictOutcome,
  WaiverRef,
} from './evaluate.js';
export {
  registerContractVerifier,
  verifierFor,
  registeredNamespaces,
  registerContractCapabilities,
  capabilityFor,
  allCapabilities,
  type ClaimEvidenceInput,
  type ClaimOutcome,
  type ContractVerifier,
  type ContractCapability,
  type ContractAvailability,
  type HttpRouteCandidate,
} from './registry.js';
/**
 * Cause mapping for the shared report model (plan §5.4): stable cause
 * codes + next actions for blocking verdicts, and the precise capability
 * gaps strict preflight fails closed on (ADR 0005).
 */
export {
  causeForVerdict,
  capabilityGap,
  strictCapabilityGaps,
  type VerdictCause,
  type CapabilityGap,
} from './cause.js';
/**
 * Deterministic runtime route attribution (plan §9, D2): the single
 * path interpretation plus the complete-inventory resolver the HTTP
 * transport verifier grades against. No literal-precedence shortcut;
 * ambiguity blocks.
 */
export {
  registerPackVerifiers,
  interpretObservedPath,
  resolveHttpRoute,
  pathMatchesShape,
} from './pack-verifiers.js';
