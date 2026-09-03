/**
 * The automatic conservative classifier (ADR 0003): signal/decision
 * schemas, the deterministic lattice, and typed blocks.
 */
export { BLOCK_DIMENSIONS, CLASSIFIER_BLOCK_CODES, ClassifierBlockCodeSchema, ClassifierBlockSchema, ClassifierContradictionSchema, ClassificationDecisionTraceSchema, EffectiveClassificationSchema, } from './schema.js';
export type { ClassifierBlock, ClassifierBlockCode, ClassifierContradiction, ClassificationDecisionTrace, EffectiveClassification, } from './schema.js';
export { RULES, classifyResources, type ClassifierResourceRef, type ClassificationDecision, type ClassificationResult, type ClassifierScanInput, type ClassifyResourcesInput, } from './classify.js';
export { compileGlob, globMatch, pathInScope } from './glob.js';
export { classifierBlocking, resourceRef, runClassification, type GraphClassification, type RunClassificationInput, } from './bind.js';
//# sourceMappingURL=index.d.ts.map