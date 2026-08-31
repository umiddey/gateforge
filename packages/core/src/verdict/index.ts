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
