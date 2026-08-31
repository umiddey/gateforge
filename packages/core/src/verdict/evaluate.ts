/**
 * Verdict engine (Interface pin #9, ADR 0001 D1–D4): the pure evaluator
 * that turns one obligation plus its run evidence into one of the seven
 * verdicts.
 *
 * Contract (pin #9): `evaluateObligation(obligation, {claims, records,
 * waivers, classification, now}) → {verdict, reason, recordIds}` —
 * deterministic, no I/O, clock injected via `now`.
 *
 * Rules encoded here:
 * - `satisfied` requires COMPLETE WITNESSED evidence: a service-witnessed
 *   `ui.action` record matching the contract's operation plus a
 *   service-witnessed `persistence.*` record for the SAME entity
 *   (plan §5.3). Claimed-tier records can drive `missing`/`invalid` but
 *   never `satisfied` (D2, GF-23).
 * - Records lacking service-issued provenance markers (sha256-hex
 *   `recordId` + `runId`) are demoted to `claimed` regardless of their
 *   `trust` field (pin #7, GF-23).
 * - Same-entity enforcement (invariant 3): every satisfying record carries
 *   an `entityId` equal to the UI action's entity. Composite identity is a
 *   column-keyed object whose keys are exactly the `primaryKey` columns
 *   (D3); single-column resources require a scalar id.
 * - Internal resources carry no CRUD obligations; their claims are invalid
 *   (ADR 0001, matching the policy engine's claim assessment).
 * - Unclassified resources block as `unclassified` (invariant 1).
 *   Unresolved resources never reach this evaluator: they generate no
 *   obligations — the policy engine emits blocking entries for them.
 * - A waiver matching the exact (resourceId, fingerprint) pair that is
 *   unexpired yields `waived`; an expired waiver yields `invalid` (D4);
 *   a waiver whose owner is stale yields `stale` (GF-17).
 */
import { z } from 'zod';
import { canonicalJson, type JsonValue } from '../canonical-json.js';
import { fingerprint } from '../fingerprints.js';
import { compareStrings } from '../graph/util.js';
import { ClassificationSchema } from '../schemas/classification.js';
import { ClaimSchema, type Claim } from '../schemas/claim.js';
import { ObligationSchema, type Obligation } from '../schemas/obligation.js';
import type { TrustTier } from '../schemas/common.js';
import type { Verdict } from '../schemas/verdict.js';
import { WaiverSchema, type Waiver } from '../schemas/waiver.js';
import { CRUD_CONTRACT_PREFIX } from '../policy/index.js';

/** Evidence kinds the built-in CRUD contract speaks (plan §5.3). */
const UI_ACTION_KIND = 'ui.action';
const UI_VISIBLE_KIND = 'ui.visible-result';
const PERSISTENCE_KIND_PREFIX = 'persistence.';

/** Verdicts that block a run (exit code 1). Clean: satisfied, waived. */
export const BLOCKING_VERDICTS: readonly Verdict[] = [
  'missing',
  'invalid',
  'unclassified',
  'unresolved',
  'stale',
];

/**
 * Fail-closed verdict-engine error: raised only for engine-internal
 * contract violations (malformed obligation, invalid `now`) — never for
 * adversary-controlled evidence, which must degrade to a verdict.
 */
export class GateforgeVerdictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GateforgeVerdictError';
  }
}

/** A waiver plus the engine-only stale-owner flag (GF-17). */
export type WaiverRef = Waiver & { readonly ownerStale?: boolean };

/** The pinned pin-#9 result shape for one obligation. */
export interface VerdictOutcome {
  /** One of the seven verdicts (ADR 0001 D1). */
  verdict: Verdict;
  /**
   * Single-cause human explanation. `null` only for `satisfied`;
   * every other verdict explains itself (invariant 8).
   */
  reason: string | null;
  /**
   * Record ids that drove the verdict — the satisfying witnessed set for
   * `satisfied`; all considered records for `missing`/`invalid`; empty for
   * verdicts decided before evidence is consulted. Sorted, deduplicated.
   */
  recordIds: string[];
}

/**
 * A per-obligation verdict enriched for reporting: the batch wrapper adds
 * the obligation identity, the highest trust tier among considered
 * records, and optional detector provenance (invariant 8 trace).
 */
export interface ObligationVerdict extends VerdictOutcome {
  /** The obligation this verdict is about. */
  obligation: Obligation;
  /** Highest trust tier among the obligation's records; null when none. */
  trustTier: TrustTier | null;
  /** Detector provenance for the trace; attached by the caller when known. */
  detector?: { id: string; version: string } | null;
}

/** Pin-#9 evaluation context. Malformed entries degrade, never crash. */
export interface VerdictContext {
  /** Reporter claims (Claim-shaped); entries failing the schema are ignored. */
  claims: readonly unknown[];
  /**
   * Witness records — deliberately lenient input: records that fail the
   * EvidenceRecord shape or lack service-issued provenance are treated as
   * claimed-tier (GF-23), never rejected.
   */
  records: readonly unknown[];
  /** Loaded waivers; `ownerStale: true` entries yield `stale` (GF-17). */
  waivers: readonly WaiverRef[];
  /** Classification of `obligation.resourceId`; null ⇒ `unclassified`. */
  classification: unknown;
  /** Injected clock instant (invariant 7) — the only time source. */
  now: Date | string;
}

/**
 * Normalizes the injected clock to a Date. Accepts Date or ISO-8601
 * string; anything else is an engine-internal contract violation.
 *
 * Args:
 *   now: the injected clock instant.
 *
 * Returns:
 *   Date: the parsed instant.
 *
 * Throws:
 *   GateforgeVerdictError: when `now` is not a valid ISO-8601 instant.
 */
export function parseInstant(now: Date | string): Date {
  if (now instanceof Date) {
    if (Number.isNaN(now.getTime())) {
      throw new GateforgeVerdictError('now: invalid Date (NaN time)');
    }
    return now;
  }
  const parsed = z.iso.datetime().safeParse(now);
  if (!parsed.success) {
    throw new GateforgeVerdictError(
      `now: expected an ISO-8601 instant, got ${JSON.stringify(now)}`,
    );
  }
  return new Date(parsed.data);
}

/**
 * Internal lenient view of one witness record. Every field stays unknown:
 * the claimed-tier rule requires accepting records the strict schema
 * would reject.
 */
interface RecordLike {
  readonly recordId: unknown;
  readonly runId: unknown;
  readonly trust: unknown;
  readonly obligationId: unknown;
  readonly testId: unknown;
  readonly kind: unknown;
  readonly payload: unknown;
}

/**
 * Reads one evidence entry into the lenient view; non-objects are
 * ignored (a hostile reporter may emit anything).
 */
function asRecord(value: unknown): RecordLike | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  return {
    recordId: record['recordId'],
    runId: record['runId'],
    trust: record['trust'],
    obligationId: record['obligationId'],
    testId: record['testId'],
    kind: record['kind'],
    payload: record['payload'],
  };
}

/**
 * Derives the trust tier of a record (D2 + pin #7): `witnessed` only when
 * the record asserts the witnessed tier AND carries service-issued
 * provenance (64-hex recordId + non-empty runId). Everything else is
 * claimed-tier — GF-23 fabricated bundles demote here.
 */
function trustOf(record: RecordLike): TrustTier {
  const provenanced =
    typeof record.recordId === 'string' && /^[0-9a-f]{64}$/.test(record.recordId);
  const hasRun = typeof record.runId === 'string' && record.runId.length > 0;
  return record.trust === 'witnessed' && provenanced && hasRun ? 'witnessed' : 'claimed';
}

/**
 * Stable label for a record in reasons, provenance-aware: unprovenanced
 * records (the interesting adversarial case) label themselves as such.
 * Shared by every record-citing reason so test assertions stay in
 * lockstep with emitted text.
 */
function labelOf(record: RecordLike): string {
  return typeof record.recordId === 'string' && record.recordId.length > 0
    ? record.recordId
    : '<unprovenanced>';
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPrimitive(value: unknown): value is string | number | boolean {
  if (typeof value === 'number') return Number.isFinite(value);
  return typeof value === 'string' || typeof value === 'boolean';
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return true;
  }
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (isPlainObject(value)) return Object.values(value).every(isJsonValue);
  return false;
}

/**
 * Extracts the CRUD operation a contract requires (`crud:update` →
 * `update`); null for contracts outside the crud namespace, which the
 * generic two-record completeness rule covers.
 */
function crudOperation(contract: string): string | null {
  if (!contract.startsWith(CRUD_CONTRACT_PREFIX)) return null;
  return contract.slice(CRUD_CONTRACT_PREFIX.length);
}

/** The payload of a record when it is a plain object, else undefined. */
function payloadOf(record: RecordLike): Record<string, unknown> | undefined {
  return isPlainObject(record.payload) ? record.payload : undefined;
}

/**
 * Deduplicates string ids into a sorted array without Set: string-keyed
 * membership uses a Record lookup so the seen-table serializes and
 * diffs like any other literal object.
 */
function sortedUnique(ids: readonly string[]): string[] {
  const seen: Record<string, true> = {};
  const unique: string[] = [];
  for (const id of ids) {
    if (id.length === 0 || id in seen) continue;
    seen[id] = true;
    unique.push(id);
  }
  return unique.sort(compareStrings);
}

/**
 * Validates an entityId against the classification's primaryKey (D3) and
 * returns its canonical comparable form. Single-column resources require
 * a scalar id; composite resources require a column-keyed object whose
 * key set is exactly the primaryKey columns with primitive values.
 * Missing or unknown key parts are checkable violations (ADR 0001 D3).
 *
 * Args:
 *   entityId: the raw entityId from a record payload.
 *   primaryKey: the ordered primary-key columns of the classification.
 *
 * Returns:
 *   {ok: true, key} when valid — `key` is the canonical JSON used for
 *   equality comparison and reasons; {ok: false, detail} otherwise.
 */
function normalizeEntityId(
  entityId: unknown,
  primaryKey: readonly string[],
): { ok: true; key: string } | { ok: false; detail: string } {
  if (primaryKey.length === 1) {
    if (!isPrimitive(entityId)) {
      return {
        ok: false,
        detail: isPlainObject(entityId) || Array.isArray(entityId)
          ? `scalar entityId is required for single-column primary key '${primaryKey[0]}' (composite identity is column-keyed per ADR 0001 D3)`
          : 'entityId must be a string/number/boolean scalar',
      };
    }
    if (typeof entityId === 'string' && entityId.length === 0) {
      return { ok: false, detail: 'entityId must not be empty' };
    }
    return { ok: true, key: canonicalJson(entityId as JsonValue) };
  }
  if (!isPlainObject(entityId)) {
    return {
      ok: false,
      detail:
        `composite entityId must be a column-keyed object with keys ` +
        `[${primaryKey.join(', ')}] (ADR 0001 D3)`,
    };
  }
  const keys = Object.keys(entityId);
  const missing = primaryKey.filter((column) => !keys.includes(column));
  if (missing.length > 0) {
    return { ok: false, detail: `entityId is missing key parts: [${missing.join(', ')}]` };
  }
  const unknownKeys = keys.filter((key) => !primaryKey.includes(key));
  if (unknownKeys.length > 0) {
    return {
      ok: false,
      detail: `entityId carries unknown key parts: [${unknownKeys.sort().join(', ')}]`,
    };
  }
  for (const column of primaryKey) {
    if (!isPrimitive(entityId[column])) {
      return {
        ok: false,
        detail: `entityId column '${column}' must be a string/number/boolean primitive`,
      };
    }
  }
  return { ok: true, key: canonicalJson(entityId as JsonValue) };
}

/**
 * When both visible and persisted field maps are present, verifies that
 * every shared key agrees (plan §5.3: visible and persisted fields must
 * agree). Returns the first disagreement description, or null.
 */
function fieldsDisagreement(visible: unknown, persisted: unknown): string | null {
  if (!isPlainObject(visible) || !isPlainObject(persisted)) return null;
  const shared = Object.keys(visible).filter((key) => key in persisted);
  for (const key of shared) {
    const a = visible[key];
    const b = persisted[key];
    if (!isJsonValue(a) || !isJsonValue(b)) continue;
    if (canonicalJson(a) !== canonicalJson(b)) {
      return `'${key}': visible ${canonicalJson(a)} vs persisted ${canonicalJson(b)}`;
    }
  }
  return null;
}

/** Per-claim evidence evaluation, aggregated by evaluateObligation. */
type ClaimOutcome =
  | { status: 'satisfied'; recordIds: string[] }
  | { status: 'invalid'; reason: string }
  | { status: 'missing'; reason: string };

/**
 * Evaluates one claim's evidence against the obligation's contract:
 * witnessed ui.action (+ operation for crud contracts) → entityId
 * extraction and D3 validation → witnessed persistence.* record for the
 * same entity → optional visible/persisted field agreement.
 *
 * Args:
 *   claim: the validated claim under evaluation.
 *   evidence: records attributed to this claim (obligation + testId).
 *   obligation: the verified obligation (id/contract used in reasons).
 *   primaryKey: the classification's ordered identity columns.
 *
 * Returns:
 *   ClaimOutcome: satisfied with used record ids, or the single-cause
 *   invalid/missing explanation (invariant 8).
 */
function evaluateClaimEvidence(
  claim: Claim,
  evidence: Array<{ record: RecordLike; trust: TrustTier }>,
  obligation: Obligation,
  primaryKey: readonly string[],
): ClaimOutcome {
  const requiredOp = crudOperation(obligation.contract);
  if (evidence.length === 0) {
    return {
      status: 'missing',
      reason:
        `claim '${claim.testId}' declares '${obligation.id}' but produced no evidence records`,
    };
  }

  // Requirement 1: a witnessed ui.action anchoring the entity.
  const actions = evidence.filter((entry) => entry.record.kind === UI_ACTION_KIND);
  const matchingAction = actions.find(
    (entry) =>
      entry.trust === 'witnessed' &&
      (requiredOp === null || payloadOf(entry.record)?.['operation'] === requiredOp),
  );
  if (matchingAction === undefined) {
    const claimedAction = actions.find((entry) => entry.trust === 'claimed');
    if (claimedAction !== undefined) {
      return {
        status: 'invalid',
        reason:
          `claimed-tier '${UI_ACTION_KIND}' record '${labelOf(claimedAction.record)}' cannot ` +
          `satisfy '${obligation.contract}': only service-witnessed evidence satisfies (GF-23)`,
      };
    }
    const wrongOp = actions.find((entry) => entry.trust === 'witnessed');
    if (wrongOp !== undefined && requiredOp !== null) {
      const got = String(payloadOf(wrongOp.record)?.['operation'] ?? '<none>');
      return {
        status: 'invalid',
        reason:
          `witnessed '${UI_ACTION_KIND}' record '${labelOf(wrongOp.record)}' has operation ` +
          `'${got}' but '${obligation.contract}' requires '${requiredOp}'`,
      };
    }
    return {
      status: 'missing',
      reason: `no witnessed '${UI_ACTION_KIND}' evidence for '${obligation.id}'`,
    };
  }

  const actionPayload = payloadOf(matchingAction.record);
  if (actionPayload?.['entityId'] === undefined) {
    return {
      status: 'invalid',
      reason:
        `'${UI_ACTION_KIND}' record '${labelOf(matchingAction.record)}' carries no entityId; ` +
        'same-entity enforcement (invariant 3) is impossible without it',
    };
  }
  const actionEntity = normalizeEntityId(actionPayload['entityId'], primaryKey);
  if (!actionEntity.ok) {
    return {
      status: 'invalid',
      reason:
        `'${UI_ACTION_KIND}' record '${labelOf(matchingAction.record)}': ${actionEntity.detail}; ` +
        'same-entity enforcement (invariant 3) is impossible without it',
    };
  }

  // Requirement 2: a witnessed persistence record for the same entity.
  const persistence = evidence.filter(
    (entry) =>
      typeof entry.record.kind === 'string' &&
      entry.record.kind.startsWith(PERSISTENCE_KIND_PREFIX),
  );
  const witnessedPersistence = persistence.filter((entry) => entry.trust === 'witnessed');
  const matchingPersistence = witnessedPersistence.find((entry) => {
    const entity = normalizeEntityId(payloadOf(entry.record)?.['entityId'], primaryKey);
    return entity.ok && entity.key === actionEntity.key;
  });
  if (matchingPersistence === undefined) {
    const claimedPersistence = persistence.find((entry) => entry.trust === 'claimed');
    if (claimedPersistence !== undefined) {
      return {
        status: 'invalid',
        reason:
          `claimed-tier '${String(claimedPersistence.record.kind)}' record ` +
          `'${labelOf(claimedPersistence.record)}' cannot satisfy '${obligation.contract}': ` +
          'only service-witnessed evidence satisfies (GF-23)',
      };
    }
    const mismatched = witnessedPersistence.find((entry) => {
      const entity = normalizeEntityId(payloadOf(entry.record)?.['entityId'], primaryKey);
      return !entity.ok || entity.key !== actionEntity.key;
    });
    if (mismatched !== undefined) {
      const entity = normalizeEntityId(payloadOf(mismatched.record)?.['entityId'], primaryKey);
      const target = entity.ok ? entity.key : entity.detail;
      return {
        status: 'invalid',
        reason:
          `same-entity violation: persistence record '${labelOf(mismatched.record)}' targets ` +
          `entity ${target} but the '${UI_ACTION_KIND}' targeted ${actionEntity.key}`,
      };
    }
    return {
      status: 'missing',
      reason:
        `no witnessed '${PERSISTENCE_KIND_PREFIX}*' record for entity ${actionEntity.key} ` +
        `of '${obligation.id}'`,
    };
  }

  // Consistency hardening: visible vs persisted fields must agree when a
  // witnessed visible-result record for the same entity exists.
  const visible = evidence.find((entry) => {
    if (entry.record.kind !== UI_VISIBLE_KIND || entry.trust !== 'witnessed') return false;
    const entity = normalizeEntityId(payloadOf(entry.record)?.['entityId'], primaryKey);
    return entity.ok && entity.key === actionEntity.key;
  });
  if (visible !== undefined) {
    const disagreement = fieldsDisagreement(
      payloadOf(visible.record)?.['fields'],
      payloadOf(matchingPersistence.record)?.['fields'],
    );
    if (disagreement !== null) {
      return {
        status: 'invalid',
        reason:
          `visible and persisted fields disagree on ${disagreement} ` +
          `(obligation '${obligation.id}')`,
      };
    }
  }

  const used = [
    matchingAction.record,
    matchingPersistence.record,
    ...(visible !== undefined ? [visible.record] : []),
  ]
    .map((record) => (typeof record.recordId === 'string' ? record.recordId : ''));
  return { status: 'satisfied', recordIds: sortedUnique(used) };
}

/**
 * Evaluates ONE obligation against the run's claims, records, waivers,
 * classification, and injected clock (pin #9). Pure and deterministic:
 * identical inputs produce identical outcomes.
 *
 * Args:
 *   obligation: the obligation under evaluation (validated schema shape).
 *   context: claims, records, waivers, classification, and `now`.
 *
 * Returns:
 *   VerdictOutcome: {verdict, reason, recordIds} — reason is null only
 *   for `satisfied`; recordIds is always a sorted array.
 *
 * Throws:
 *   GateforgeVerdictError: when the obligation or `now` violates the
 *   engine-internal contract (evidence problems NEVER throw — they
 *   produce `invalid`/`missing` verdicts).
 */
export function evaluateObligation(
  obligation: Obligation,
  context: VerdictContext,
): VerdictOutcome {
  const parsedObligation = ObligationSchema.safeParse(obligation);
  if (!parsedObligation.success) {
    throw new GateforgeVerdictError(
      `obligation failed schema validation: ${parsedObligation.error.issues
        .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
        .join('; ')}`,
    );
  }
  const verified = parsedObligation.data;
  const now = parseInstant(context.now);

  // 1. Unclassified resources block (invariant 1); unresolved resources
  //    never reach this evaluator (the policy engine emits blocking
  //    entries because they cannot carry obligations).
  if (context.classification === null || context.classification === undefined) {
    return {
      verdict: 'unclassified',
      reason:
        `resource '${verified.resourceId}' has no classification; obligations cannot bind ` +
        'evidence until it is classified (invariant 1)',
      recordIds: [],
    };
  }
  const parsedClassification = ClassificationSchema.safeParse(context.classification);
  if (!parsedClassification.success) {
    return {
      verdict: 'unclassified',
      reason:
        `classification for resource '${verified.resourceId}' failed validation: ` +
        `${parsedClassification.error.issues
          .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
          .join('; ')}`,
      recordIds: [],
    };
  }
  const classification = parsedClassification.data;

  // 2. Internal resources carry no CRUD obligations; their claims are
  //    invalid (ADR 0001, matching the policy engine's convention).
  if (classification.exposure === 'internal') {
    return {
      verdict: 'invalid',
      reason:
        `resource '${verified.resourceId}' is internal; internal resources carry no CRUD ` +
        'obligations and their claims are invalid (ADR 0001)',
      recordIds: [],
    };
  }

  // 3. Waivers: exact (resourceId, fingerprint) scope only (D4).
  //    Precedence: unexpired non-stale → waived; expired → invalid (D4);
  //    stale owner → stale (GF-17). Sorted for determinism.
  const fp = fingerprint({
    resourceId: verified.resourceId,
    contract: verified.contract,
    policyId: verified.policyId,
    lifecycle: verified.lifecycle,
  });
  const matching = context.waivers
    .map((entry) => {
      // Strip the engine-only flag before strict validation; a waiver
      // entry the schema rejects can never match exactly, so it degrades.
      const { ownerStale, ...plain } = entry;
      const parsed = WaiverSchema.safeParse(plain);
      return parsed.success ? { ownerStale: Boolean(ownerStale), waiver: parsed.data } : null;
    })
    .filter((entry): entry is { ownerStale: boolean; waiver: Waiver } => entry !== null)
    .filter(
      ({ waiver }) =>
        waiver.scope.kind === 'exact' &&
        waiver.scope.resourceId === verified.resourceId &&
        waiver.scope.fingerprint === fp,
    )
    .sort((a, b) =>
      compareStrings(
        `${a.waiver.expiresAt}\u0000${a.waiver.owner}`,
        `${b.waiver.expiresAt}\u0000${b.waiver.owner}`,
      ),
    );
  const unexpired = matching.filter(
    (entry) => now.getTime() < Date.parse(entry.waiver.expiresAt) && !entry.ownerStale,
  );
  if (unexpired.length > 0 && unexpired[0] !== undefined) {
    const waiver = unexpired[0].waiver;
    return {
      verdict: 'waived',
      reason:
        `waived by '${waiver.owner}' until '${waiver.expiresAt}' ` +
        `(approver '${waiver.approver}', ${waiver.justificationUrl})`,
      recordIds: [],
    };
  }
  const expired = matching.filter(
    (entry) => now.getTime() >= Date.parse(entry.waiver.expiresAt) && !entry.ownerStale,
  );
  if (expired.length > 0 && expired[0] !== undefined) {
    const waiver = expired[0].waiver;
    return {
      verdict: 'invalid',
      reason:
        `waiver by '${waiver.owner}' expired at '${waiver.expiresAt}'; expired waivers block ` +
        `as 'invalid' (ADR 0001 D4), obligation '${verified.id}'`,
      recordIds: [],
    };
  }
  const staleOwner = matching.find((entry) => entry.ownerStale);
  if (staleOwner !== undefined) {
    return {
      verdict: 'stale',
      reason:
        `waiver owner '${staleOwner.waiver.owner}' is stale (owner check failed); renewal with a new ` +
        `review is required (GF-17), obligation '${verified.id}'`,
      recordIds: [],
    };
  }

  // 4. Claims on this obligation, deterministically ordered.
  const claims = context.claims
    .map((claim) => ClaimSchema.safeParse(claim))
    .filter((parsed) => parsed.success)
    .map((parsed) => parsed.data)
    .filter((claim) => claim.obligationId === verified.id)
    .sort((a, b) => compareStrings(a.testId, b.testId));
  if (claims.length === 0) {
    return {
      verdict: 'missing',
      reason: `no claim declares '${verified.id}'`,
      recordIds: [],
    };
  }

  // 5. Records attributed to this obligation (lenient view). Records are
  //    bound to a claim via the witness-issued testId; unattributable
  //    records cannot satisfy anything.
  const considered = (Array.isArray(context.records) ? context.records : [])
    .map(asRecord)
    .filter((record): record is RecordLike => record !== null)
    .filter((record) => record.obligationId === verified.id);
  const consideredIds = sortedUnique(
    considered.map((record) => (typeof record.recordId === 'string' ? record.recordId : '')),
  );

  // 6. Per-claim evidence evaluation with deterministic aggregation:
  //    satisfied beats invalid beats missing.
  let firstInvalid: string | null = null;
  let firstMissing: string | null = null;
  for (const claim of claims) {
    const evidence = considered
      .filter((record) => record.testId === claim.testId)
      .map((record) => ({ record, trust: trustOf(record) }));
    const outcome = evaluateClaimEvidence(claim, evidence, verified, classification.primaryKey);
    if (outcome.status === 'satisfied') {
      return { verdict: 'satisfied', reason: null, recordIds: outcome.recordIds };
    }
    if (outcome.status === 'invalid' && firstInvalid === null) {
      firstInvalid = outcome.reason;
    }
    if (outcome.status === 'missing' && firstMissing === null) {
      firstMissing = outcome.reason;
    }
  }
  if (firstInvalid !== null) {
    return { verdict: 'invalid', reason: firstInvalid, recordIds: consideredIds };
  }
  return {
    verdict: 'missing',
    reason: firstMissing ?? `no admissible evidence for '${verified.id}'`,
    recordIds: consideredIds,
  };
}

/**
 * Evaluates a batch of obligations against one context and returns
 * report-ready entries sorted by obligation id, each enriched with the
 * highest trust tier among its records (SARIF properties) and optional
 * detector provenance passthrough.
 *
 * Args:
 *   obligations: obligations to evaluate.
 *   context: the shared pin-#9 evaluation context.
 *
 * Returns:
 *   ObligationVerdict[]: sorted by obligation id; deterministic.
 */
export function evaluateObligations(
  obligations: readonly Obligation[],
  context: VerdictContext,
): ObligationVerdict[] {
  parseInstant(context.now);
  return obligations
    .map((obligation) => {
      const outcome = evaluateObligation(obligation, context);
      const records = (Array.isArray(context.records) ? context.records : [])
        .map(asRecord)
        .filter((record): record is RecordLike => record !== null)
        .filter((record) => record.obligationId === obligation.id);
      const trustTier: TrustTier | null = records.some((record) => trustOf(record) === 'witnessed')
        ? 'witnessed'
        : records.length > 0
          ? 'claimed'
          : null;
      return { obligation, ...outcome, trustTier };
    })
    .sort((a, b) => compareStrings(a.obligation.id, b.obligation.id));
}
