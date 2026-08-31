/**
 * @gateforge/pack-workflow — workflow / state-machine discovery pack.
 *
 * Detects state machines from TypeScript / JavaScript source via the
 * TypeScript compiler API (AST only — no execution, no module
 * resolution) and exposes the pinned GPP/2 discovery vocabulary of
 * the resource graph: one `workflow.contract.<domain>.<name>` resource
 * per detected FSM carrying `states[]`, `transitions[]`,
 * `terminal[]`, `auditEvent: boolean`, and `style`.
 *
 * The five workflow obligation contracts (mirrored by
 * {@link WORKFLOW_OBLIGATION_CONTRACTS}) drive policy generation:
 * `workflow:transition-allowed`, `workflow:transition-rejected`,
 * `workflow:terminal-immutable`, `workflow:audit-emitted`,
 * `workflow:persisted-final-state`.
 *
 * The default export is the CLI in-process plugin contract
 * (`discover(paths)`); the same `createWorkflowDetector()` factory
 * underpins tests and the witness service's adapter binding.
 *
 * See README.md for the adapter schema and the example workflow
 * server on port 3002.
 */
import { createWorkflowDetector } from './detector.js';

export { PACK_PLUGIN_ID, PACK_VERSION } from './version.js';
export {
  createWorkflowDetector,
  WORKFLOW_CONTRACT_KIND,
  type FsmStyle,
  type WorkflowContractAttributes,
  type WorkflowDetector,
  type WorkflowDetectorOptions,
  type WorkflowTransition,
} from './detector.js';
export {
  WORKFLOW_OBLIGATION_CONTRACTS,
  WORKFLOW_TRANSITION_ALLOWED,
  WORKFLOW_TRANSITION_REJECTED,
  WORKFLOW_TERMINAL_IMMUTABLE,
  WORKFLOW_AUDIT_EMITTED,
  WORKFLOW_PERSISTED_FINAL_STATE,
  obligationsForWorkflowResource,
} from './obligations.js';
export {
  WorkflowAdapterSchema,
  auditLogContainsTransition,
  projectAuditRow,
  validateWorkflowAdapter,
  type AuditRow,
  type RawAuditLog,
  type RawEntity,
  type TransitionOutcome,
  type TransitionRequest,
  type WorkflowAdapter,
  type WorkflowAdapterContext,
  type WorkflowAdapterValidation,
} from './adapter-schema.js';

/** The default CLI in-process plugin module: `{ discover(paths) }`. */
export default createWorkflowDetector();