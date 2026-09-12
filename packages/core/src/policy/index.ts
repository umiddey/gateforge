/**
 * Policy engine (G2): declarative policies → obligations, lifecycle
 * gating (plan §5.2), internal-resource claim invalidation (ADR 0001),
 * and gate-visible blocking entries for unclassified/unresolved
 * resources (invariants 1, 8).
 */
export {
  CRUD_CONTRACT_PREFIX,
  PERSISTENCE_CONTRACT_PREFIX,
  BlockingEntrySchema,
  ClaimAssessmentSchema,
  PolicyEvaluationError,
  PolicyEvaluationResultSchema,
  classificationBlockedIdentity,
  evaluatePolicies,
  lifecycleAllowsContract,
} from './evaluate.js';
export type {
  BlockingEntry,
  ClaimAssessment,
  PolicyEvaluationInput,
  PolicyEvaluationResult,
} from './evaluate.js';
