/**
 * The automatic conservative classifier (ADR 0003): signal/decision
 * schemas, the deterministic lattice, and typed blocks.
 */

// ---------------------------------------------------------------------------
// Decision/trace/block schemas
// ---------------------------------------------------------------------------

export {
  BLOCK_DIMENSIONS,
  CLASSIFIER_BLOCK_CODES,
  ClassifierBlockCodeSchema,
  ClassifierBlockSchema,
  ClassifierContradictionSchema,
  ClassificationDecisionTraceSchema,
  EffectiveClassificationSchema,
} from './schema.js';
export type {
  ClassifierBlock,
  ClassifierBlockCode,
  ClassifierContradiction,
  ClassificationDecisionTrace,
  EffectiveClassification,
} from './schema.js';

// ---------------------------------------------------------------------------
// The engine
// ---------------------------------------------------------------------------

export {
  RULES,
  classifyResources,
  type ClassifierResourceRef,
  type ClassificationDecision,
  type ClassificationResult,
  type ClassifierScanInput,
  type ClassifyResourcesInput,
} from './classify.js';

// ---------------------------------------------------------------------------
// Deterministic glob matching (scan roots, rule patterns)
// ---------------------------------------------------------------------------

export { compileGlob, globMatch, pathInScope } from './glob.js';

// ---------------------------------------------------------------------------
// Graph binding (plan phase 5, ADR 0003 D5)
// ---------------------------------------------------------------------------

export {
  classifierBlocking,
  resourceRef,
  runClassification,
  type GraphClassification,
  type RunClassificationInput,
} from './bind.js';
