/**
 * Passing workflow adapter fixture.
 *
 * All four function fields are async, return raw entity / audit bodies,
 * and the data fields validate against the frozen zod schema. The
 * witness service uses the same interface the production example
 * server exposes (HTTP JSON).
 */
import type {
  WorkflowAdapter,
  WorkflowAdapterContext,
  TransitionRequest,
  TransitionOutcome,
} from '../../src/adapter-schema.js';

async function readEntity(ctx: WorkflowAdapterContext, id: string): Promise<unknown> {
  const res = await fetch(`${ctx.baseUrl}/contracts/${id}`, { headers: ctx.headers });
  if (!res.ok) throw new Error(`readEntity status ${res.status}`);
  return res.json();
}

async function readAuditLog(ctx: WorkflowAdapterContext): Promise<unknown> {
  const res = await fetch(`${ctx.baseUrl}/audit`, { headers: ctx.headers });
  if (!res.ok) throw new Error(`readAuditLog status ${res.status}`);
  return res.json();
}

async function attemptTransition(req: TransitionRequest): Promise<TransitionOutcome> {
  const res = await fetch(`${req.ctx.baseUrl}/contracts/${req.entityId}/transitions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...req.ctx.headers },
    body: JSON.stringify({ actor: req.actor, event: req.event }),
  });
  if (res.status === 200) {
    const raw: unknown = await res.json();
    const body = raw as { status?: unknown };
    return { accepted: true, finalState: typeof body.status === 'string' ? body.status : 'unknown' };
  }
  const raw: unknown = await res.json();
  const body = raw as { error?: unknown };
  return { accepted: false, reason: typeof body.error === 'string' ? body.error : 'unknown' };
}

async function allowedTransition(req: TransitionRequest): Promise<TransitionOutcome> {
  // For a valid transition, attemptTransition is enough — the example
  // server persists and audits synchronously.
  return attemptTransition(req);
}

const passing: WorkflowAdapter = {
  resourceId: 'workflow.contract.contracts.draft',
  readEntity,
  readAuditLog,
  attemptTransition,
  allowedTransition,
  deletion: 'archive',
  environmentFingerprint: 'gateforge-example-workflow/0.1.0',
};

export default passing;