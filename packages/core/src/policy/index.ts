/**
 * Policy engine (G2): declarative policies → obligations, lifecycle
 * gating (plan §5.2), internal-resource claim invalidation (ADR 0001),
 * and gate-visible blocking entries for unclassified/unresolved
 * resources (invariants 1, 8).
 *
 * Also (plan 2026-09-13 Phase 0): the closed-world CRUD coverage
 * evaluator (§3.6) and the protected-policy-ownership foundation
 * (trusted policy digest + weakening check, ADR 0005 D5/D6).
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
export {
  evaluateCoveragePolicy,
  type CoverageInventoryTable,
  type MappedCoverage,
  type CoverageConfigError,
  type CoverageBlockingFinding,
  type CoveragePolicyResult,
} from './coverage.js';
export {
  TRUSTED_POLICY_DOMAIN,
  trustedPolicyDigest,
  policyWeakenedCandidate,
  type TrustedPolicyInput,
  type PolicyWeakeningCheck,
} from './trusted.js';
