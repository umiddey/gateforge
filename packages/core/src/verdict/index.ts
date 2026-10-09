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
  volatileEchoSkips,
  volatileFieldsOf,
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
  setContractAvailability,
  allCapabilities,
  type ClaimEvidenceInput,
  type ClaimOutcome,
  type ContractVerifier,
  type ContractCapability,
  type ContractAvailability,
  type HttpRouteCandidate,
} from './registry.js';
/**
 * The verdict-time exchange ledger (0.14 WP2): witnessed `http.exchanges`
 * rows resolved by the ONE route matcher — report-only input for the run
 * report's `httpLedger`, never a verdict input.
 */
export {
  buildHttpLedger,
  type HttpLedger,
  type HttpLedgerResolution,
  type HttpLedgerRow,
  type HttpLedgerSummary,
} from './http-ledger.js';
/**
 * The HTTP call rules R1-R5 (0.14 WP3): used/proven/missing counts over
 * the exchange ledger plus the static join, and the typed call findings
 * (`HTTP_CALL_UNMATCHED` / `HTTP_CALL_AMBIGUOUS` /
 * `HTTP_CALL_UNRESOLVED`). Never a verdict input.
 */
export {
  evaluateHttpCoverage,
  httpCallFindingEntries,
  httpResponseShapeEntries,
  HTTP_CALL_UNMATCHED,
  HTTP_CALL_AMBIGUOUS,
  HTTP_CALL_UNRESOLVED,
  HTTP_ROUTE_NOT_INVENTORIED,
  type HttpCallFinding,
  type HttpCallFindingCode,
  type HttpCallFindingsMode,
  type HttpCoverageInput,
  type HttpCoverageResult,
  type HttpCoverageRoute,
  type HttpCoverageSummary,
  type HttpCoverageUnresolved,
  type HttpCoverageVerdict,
  type HttpMissingRoute,
} from './http-coverage.js';
export { HTTP_EXCHANGES_KIND } from './pack-verifiers.js';
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
 * transport verifier grades against. Multiple matches resolve by the
 * framework's own registration order ONLY when the detector proved it
 * (same scope, distinct orders, no typed path convertor ahead of the
 * field — 0.14); otherwise ambiguity blocks.
 */
export {
  registerPackVerifiers,
  bindQueueObserver,
  interpretObservedPath,
  matchHttpRoute,
  resolveHttpRoute,
  pathMatchesShape,
} from './pack-verifiers.js';
/**
 * Required-case aggregation (plan 2026-09-19 §4.7, Phase 5): pure
 * semantic grading across an obligation's required behavior cases —
 * never the legacy any-claim-satisfied shortcut.
 */
export {
  STRONG_HTTP_CONTRACTS,
  AUTH_CONTRACTS,
  VALIDATION_CONTRACTS,
  WORKFLOW_CONTRACTS,
  TASK_CONTRACTS,
  WEBHOOK_CONTRACTS,
  BEHAVIOR_CASE_CONTRACTS,
  behaviorActionDigestOf,
  evaluateRequiredCases,
  type BehaviorGradeContext,
  type BehaviorObligationContext,
  type BehaviorRecordLike,
  type RequiredCaseOutcome,
} from './behavior.js';
