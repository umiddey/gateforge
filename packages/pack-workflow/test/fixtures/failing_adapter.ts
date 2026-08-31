/**
 * Failing workflow adapter fixture.
 *
 * Missing `readAuditLog` — must be rejected by `validateWorkflowAdapter`
 * with a single-cause diagnostic (`readAuditLog: must be a function …`).
 */
const failing = {
  resourceId: 'workflow.contract.contracts.draft',
  readEntity: async () => ({}),
  // readAuditLog intentionally missing
  attemptTransition: async () => ({ accepted: true }),
  allowedTransition: async () => ({ accepted: true, finalState: 'pending' }),
  deletion: 'archive',
  environmentFingerprint: 'gateforge-example-workflow/0.1.0',
};

export default failing;