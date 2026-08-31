/**
 * Entity-adapter schema (pack deliverable: "entity-adapter schema doc").
 *
 * Mirrors the pack-sqlalchemy posture: an adapter is a reviewed,
 * engine-side module whose default export implements GET-only reads
 * against a workflow resource plus the three transition/audit
 * operations the five workflow contracts need. The witness service
 * loads `.gateforge/adapters/<resourceId>.mjs` and calls
 * `attemptTransition` / `allowedTransition` / `readEntity` /
 * `readAuditLog` when a test asks for evidence; the raw adapter
 * response is never returned to the test process — only the
 * `verdictRelevant` projection is.
 *
 * Adapter responsibilities (enforced by {@link WorkflowAdapterSchema} +
 * {@link validateWorkflowAdapter}):
 * - `resourceId` — the resource this adapter proves; must match the
 *   file name (`<resourceId>.mjs`) so the registry binds by filename.
 * - `readEntity(ctx, id)` — GET-only fetch of one entity; returns the
 *   raw response body. Implementations MUST NOT mutate anything.
 * - `readAuditLog(ctx)` — GET-only fetch of the append-only audit log.
 * - `attemptTransition(ctx, args)` — return whether the transition is
 *   accepted; reject terminal writes; NEVER persist or append.
 * - `allowedTransition(ctx, args)` — apply a valid transition; append
 *   one audit row; return the new final state.
 * - `deletion: 'hard' | 'archive'` — how removal manifests (workflow
 *   resources are state machines; `archive` matches the contract
 *   semantics where terminals are reached, never deleted).
 * - `environmentFingerprint` — the target-environment marker; a
 *   mismatch rejects the record.
 */
import { z } from 'zod';

/** Raw entity body the adapter returns; detector-defined open payload. */
export type RawEntity = unknown;

/** Raw audit-log body the adapter returns. */
export type RawAuditLog = unknown;

/** Arguments the adapter's transition methods receive. */
export interface TransitionRequest {
  /** Identifier of the entity being transitioned (matches `readEntity` id). */
  entityId: string;
  /** Logical event the actor is attempting (e.g. `submit`, `sign`, `terminate`). */
  event: string;
  /** Identifier of the actor; recorded in the audit row. */
  actor: string;
  /** Caller-supplied adapter context (headers, run token, etc.). */
  ctx: WorkflowAdapterContext;
}

/** The outcome a transition attempt produces. */
export interface TransitionOutcome {
  /** True when the transition was accepted and persisted. */
  accepted: boolean;
  /** When `accepted` is true, the new persisted state id. */
  finalState?: string;
  /** When `accepted` is false, the machine-readable rejection reason. */
  reason?: string;
  /** When `accepted` is true, the audit row that was appended. */
  auditRow?: { actor: string; from: string; to: string; at: string };
}

/** Context handed to every adapter method by the witness service. */
export interface WorkflowAdapterContext {
  /** Base URL of the target environment (loopback, trusted). */
  baseUrl: string;
  /** Per-request headers (e.g. the run token for authenticity). */
  headers?: Record<string, string>;
}

/** The frozen adapter module contract. */
export interface WorkflowAdapter {
  resourceId: string;
  readEntity(ctx: WorkflowAdapterContext, id: string): Promise<RawEntity>;
  readAuditLog(ctx: WorkflowAdapterContext): Promise<RawAuditLog>;
  attemptTransition(req: TransitionRequest): Promise<TransitionOutcome>;
  allowedTransition(req: TransitionRequest): Promise<TransitionOutcome>;
  deletion: 'hard' | 'archive';
  environmentFingerprint: string;
}

/**
 * Zod schema for the data fields of an adapter module. Function fields
 * are accepted as `unknown` so zod does not blur the diagnostic
 * message; {@link validateWorkflowAdapter} enforces the type after the
 * data-fields pass.
 */
export const WorkflowAdapterSchema = z
  .object({
    resourceId: z.string().min(1),
    deletion: z.enum(['hard', 'archive']),
    environmentFingerprint: z.string().min(1),
    readEntity: z.unknown(),
    readAuditLog: z.unknown(),
    attemptTransition: z.unknown(),
    allowedTransition: z.unknown(),
  })
  .strict();

/** Outcome of {@link validateWorkflowAdapter}. */
export type WorkflowAdapterValidation =
  | { ok: true; adapter: WorkflowAdapter }
  | { ok: false; issues: string[] };

/**
 * Validates an adapter module against the frozen contract, failing
 * closed with one issue per violated field.
 *
 * Args:
 *   value: The default export of an `.mjs` adapter module.
 *
 * Returns:
 *   WorkflowAdapterValidation: The typed adapter, or every issue found.
 */
export function validateWorkflowAdapter(value: unknown): WorkflowAdapterValidation {
  const parsed = WorkflowAdapterSchema.safeParse(value);
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map(
        (issue) => `${issue.path.join('.')}: ${issue.message}`,
      ),
    };
  }
  const candidate = value as Partial<WorkflowAdapter>;
  const issues: string[] = [];
  if (typeof candidate.readEntity !== 'function') {
    issues.push('readEntity: must be a function (ctx, id) => Promise<unknown>');
  }
  if (typeof candidate.readAuditLog !== 'function') {
    issues.push('readAuditLog: must be a function (ctx) => Promise<unknown>');
  }
  if (typeof candidate.attemptTransition !== 'function') {
    issues.push('attemptTransition: must be a function (req) => Promise<TransitionOutcome>');
  }
  if (typeof candidate.allowedTransition !== 'function') {
    issues.push('allowedTransition: must be a function (req) => Promise<TransitionOutcome>');
  }
  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, adapter: value as WorkflowAdapter };
}

/**
 * Projects an audit-log body onto the row shape the verdict engine
 * expects. The adapter's raw body is its own (often string-keyed JSON);
 * the witness service projects each row to `{ actor, from, to, at }`.
 */
export interface AuditRow {
  actor: string;
  from: string;
  to: string;
  at: string;
}

/**
 * The default audit-row projection. Recognises the canonical
 * `{ actor, from, to, at }` body and returns it as an `AuditRow`;
 * anything else is left as-is so the verdict engine can flag it.
 */
export function projectAuditRow(raw: unknown): AuditRow | null {
  if (raw === null || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  if (
    typeof obj['actor'] === 'string' &&
    typeof obj['from'] === 'string' &&
    typeof obj['to'] === 'string' &&
    typeof obj['at'] === 'string'
  ) {
    return {
      actor: obj['actor'],
      from: obj['from'],
      to: obj['to'],
      at: obj['at'],
    };
  }
  return null;
}

/**
 * Returns true when `rows` contains an entry whose `{ actor, from, to }`
 * equals the target triple. Used by the `workflow:audit-emitted`
 * contract; the timestamp is intentionally NOT compared so callers can
 * pass a projected audit log without normalising timestamps first.
 */
export function auditLogContainsTransition(
  rows: readonly unknown[],
  target: { actor: string; from: string; to: string },
): boolean {
  for (const raw of rows) {
    const row = projectAuditRow(raw);
    if (
      row !== null &&
      row.actor === target.actor &&
      row.from === target.from &&
      row.to === target.to
    ) {
      return true;
    }
  }
  return false;
}