export { PACK_PLUGIN_ID, PACK_VERSION } from './version.js';
export { createWorkflowDetector, WORKFLOW_CONTRACT_KIND, type FsmStyle, type WorkflowContractAttributes, type WorkflowDetector, type WorkflowDetectorOptions, type WorkflowTransition, } from './detector.js';
export { WORKFLOW_OBLIGATION_CONTRACTS, WORKFLOW_TRANSITION_ALLOWED, WORKFLOW_TRANSITION_REJECTED, WORKFLOW_TERMINAL_IMMUTABLE, WORKFLOW_AUDIT_EMITTED, WORKFLOW_PERSISTED_FINAL_STATE, obligationsForWorkflowResource, } from './obligations.js';
export { WorkflowAdapterSchema, auditLogContainsTransition, projectAuditRow, validateWorkflowAdapter, type AuditRow, type RawAuditLog, type RawEntity, type TransitionOutcome, type TransitionRequest, type WorkflowAdapter, type WorkflowAdapterContext, type WorkflowAdapterValidation, } from './adapter-schema.js';
/** The default CLI in-process plugin module: `{ discover(paths) }`. */
declare const _default: import("./detector.js").WorkflowDetector;
export default _default;
//# sourceMappingURL=index.d.ts.map