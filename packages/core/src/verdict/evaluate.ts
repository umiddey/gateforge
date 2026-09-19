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
 * - `satisfied` requires a `ui.action` record matching the contract's
 *   operation PLUS a service-witnessed `persistence.*` record for the
 *   SAME entity that MEETS THE OPERATION'S POSTCONDITION (plan §5.3).
 *   Trust asymmetry (2026-08-31 audits): the UI action is suite-asserted
 *   — submitted through the run token, stamped claimed-tier at issuance
 *   — and only anchors the entity/operation. The satisfaction weight is
 *   the persistence record, whose contents the witness observed itself
 *   via the engine-side adapter read (`origin: 'engine-observed'`), and
 *   the engine grades that observation against the claimed operation
 *   with EXPECTATIONS THAT NEVER COME FROM THE SUITE (round 5):
 *   create ⇒ engine-observed absence before + presence after; update ⇒
 *   an engine-observed before/after field delta; read ⇒ presence;
 *   delete ⇒ absent (hard) or matching the classification's
 *   owner-declared `archiveFields` (archive). Fabricated persistence
 *   records demote to claimed and can never satisfy (D2, GF-23).
 * - `crud:<op>` (UI-semantic, plan Phase 1 item 8 + §3.6) is graded on
 *   the SUPERVISED SESSION CHANNEL only: within one witness session the
 *   claim needs (i) a provenanced session-bound `ui.action` with the
 *   matching operation, (ii) the witness-observed HTTP exchange of that
 *   same session — issued only for traffic traversing the session's
 *   dedicated proxy INSIDE a witness-kept action interval — attributed
 *   by the complete host route inventory, (iii) a session-bound visible
 *   result for the same entity, and (iv) the engine-observed
 *   persistence postcondition + exact-value echo on that entity. Every
 *   shortcut grades typed-blocking (session binding, unobserved direct
 *   mutation, value mismatch, missing visible result). Contracts
 *   outside the persistence/crud namespaces still fail closed.
 * - Records whose provenance does not verify — a recordId that does not
 *   recompute from the record's own contents (sha256 over the canonical
 *   identity) — are demoted to `claimed` regardless of their `trust`
 *   field (pin #7, GF-23).
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
import {
  capabilityFor,
  registerContractCapabilities,
  registerContractVerifier,
  verifierFor,
  type ContractCapability,
  type HttpRouteCandidate,
} from './registry.js';
import { registerPackVerifiers, interpretObservedPath, resolveHttpRoute } from './pack-verifiers.js';
import { causeForVerdict } from './cause.js';
import { canonicalJson, type JsonValue } from '../canonical-json.js';
import { fingerprint } from '../fingerprints.js';
import { compareStrings } from '../graph/util.js';
import { isProvenancedRecord } from '../provenance.js';
import { ClassificationSchema } from '../schemas/classification.js';
import { ClaimSchema, type Claim } from '../schemas/claim.js';
import { ObligationSchema, type Obligation } from '../schemas/obligation.js';
import type { TrustTier } from '../schemas/common.js';
import type { CauseCode, Verdict } from '../schemas/verdict.js';
import { WaiverSchema, type Waiver } from '../schemas/waiver.js';
import { CRUD_CONTRACT_PREFIX, PERSISTENCE_CONTRACT_PREFIX } from '../policy/index.js';

/** Evidence kinds the built-in CRUD contract speaks (plan §5.3). */
const UI_ACTION_KIND = 'ui.action';
const UI_VISIBLE_KIND = 'ui.visible-result';
const PERSISTENCE_KIND_PREFIX = 'persistence.';
/**
 * The exact record kind the witness stamps browser/server-channel
 * persistence on. Channel qualifiers below key off exact kinds (never
 * prefixes): a channel stamp on any other kind is admissible NOWHERE.
 */
const PERSISTENCE_ENTITY_KIND = 'persistence.entity';
/**
 * Observe-channel record kind + payload discriminant (Phase 2). String
 * literals (not pack imports — core never depends on packs); kept in
 * lockstep with `@gate-forge/pack-playwright`'s OBSERVED_KIND /
 * OBSERVE_CHANNEL.
 */
const OBSERVED_RECORD_KIND = 'persistence.observed';
const OBSERVE_CHANNEL = 'observe';
/**
 * The server-witnessed persistence channel (product-gap fix: backend-only
 * tables — e.g. a transactional outbox — can never honestly appear in a
 * UI, so their `persistence:*` obligations were unprovable by design).
 * A `persistence.entity` record the witness stamped from its OWN
 * server-side adapter probe carries `payload.channel: 'server'` plus
 * `payload.declaredKind: 'server-e2e'`; both ride in the payload, so the
 * provenance hash AND the v2 attestation MAC cover them exactly like the
 * rest of the witnessed ledger.
 */
const SERVER_CHANNEL = 'server';
/**
 * The mapping kind that unlocks the server channel: the witness stamps
 * `declaredKind` only for obligations the trusted supervisor registered
 * as `server-e2e` on the verifier-key surface (`POST
 * /runs/server-e2e-declarations`), so a provenance-verified record
 * carrying the stamp IS the "claim declared server-e2e" fact. WHY via
 * record metadata: the test-map `kind` resolves in the CLI mapping layer
 * and does not reach core grading as a claim field today, so the fact is
 * threaded through the metadata the witness already stamps — enforced at
 * issuance, verified here, and impossible for the suite to self-declare.
 */
const SERVER_E2E_KIND = 'server-e2e';

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
 * records, optional detector provenance (invariant 8 trace), and the
 * stable cause code + next action for the shared report model (plan
 * §5.4). Cause/nextAction are null when the verdict is clean or no
 * honest mapping exists yet (later phases populate).
 */
export interface ObligationVerdict extends VerdictOutcome {
  /** The obligation this verdict is about. */
  obligation: Obligation;
  /** Highest trust tier among the obligation's records; null when none. */
  trustTier: TrustTier | null;
  /** Detector provenance for the trace; attached by the caller when known. */
  detector?: { id: string; version: string } | null;
  /** Stable plan §5.4 cause code; null when unmapped or clean. */
  readonly cause?: CauseCode | null;
  /** Human next action for the cause; null when unmapped or clean. */
  readonly nextAction?: string | null;
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
  /** The obligation's graph resource (kind + attributes), when the host can supply it. Verifiers use it to bind evidence to identity. */
  resource?: { kind: string; attributes: Record<string, unknown> } | null;
  /**
   * The COMPLETE runtime route inventory for HTTP attribution (plan
   * §9, D2). Host-derived from the graph; absent blocks HTTP
   * satisfaction (no any-endpoint fallback).
   */
  httpRoutes?: readonly HttpRouteCandidate[] | null;
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
  readonly origin: unknown;
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
    origin: record['origin'],
    payload: record['payload'],
  };
}

/**
 * Derives the trust tier of a record (D2 + pin #7): `witnessed` only when
 * the record asserts the witnessed tier AND its provenance verifies —
 * the 64-hex recordId must recompute from the record's own contents
 * (`sha256` over the canonical identity; pin #1). Everything else is
 * claimed-tier: GF-23 fabricated bundles and transplanted-but-never-
 * issued ids demote here. Issuance membership (the recordId appearing
 * in the witness-issued manifest set) is enforced separately by the
 * CLI's provenance gate, which owns the run manifest.
 */
function trustOf(record: RecordLike): TrustTier {
  return record.trust === 'witnessed' && isProvenancedRecord(record) ? 'witnessed' : 'claimed';
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
 * Extracts the operation a persistence-level contract requires
 * (`persistence:update` → `update`); null for anything else.
 *
 * Dispatch:
 * - `persistence:<op>` — UI-independent CRUD, graded on the witness's
 *   own engine-side observations with owner/classification-owned
 *   expectations;
 * - `crud:<op>` — UI-SEMANTIC: graded by the session-channel verifier
 *   below (supervised witness session + observed exchange + interval +
 *   persistence echo);
 * - everything else — no semantic verifier registered, fail closed.
 */
function persistenceOperation(
  contract: string,
): 'create' | 'read' | 'update' | 'delete' | null {
  if (!contract.startsWith(PERSISTENCE_CONTRACT_PREFIX)) return null;
  const operation = contract.slice(PERSISTENCE_CONTRACT_PREFIX.length);
  if (operation === 'create' || operation === 'read' || operation === 'update' || operation === 'delete') {
    return operation;
  }
  return null;
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
 * Compares owner-declared expected field values against the
 * engine-observed persisted fields: every expected key must exist and
 * agree (canonical-JSON equality). Returns the first mismatch
 * description, or null. The EXPECTATIONS come from the classification
 * (owner-owned) — never from the tested suite (audit round 5).
 */
function declaredFieldsMatchFailure(
  expected: unknown,
  observed: unknown,
  what: string,
): string | null {
  if (!isPlainObject(expected) || Object.keys(expected).length === 0) {
    return `${what} postcondition cannot be evaluated: the classification declares no expected fields`;
  }
  if (!isPlainObject(observed)) {
    return `${what} postcondition violated: the engine observed no persisted fields`;
  }
  for (const key of Object.keys(expected).sort()) {
    const expectedValue = (expected as Record<string, unknown>)[key];
    if (!isJsonValue(expectedValue)) continue;
    const observedValue = (observed as Record<string, unknown>)[key];
    if (!isJsonValue(observedValue) || canonicalJson(expectedValue) !== canonicalJson(observedValue)) {
      return (
        `${what} postcondition violated: persisted fields do not match the classification-declared ` +
        `state on '${key}' (expected ${canonicalJson(expectedValue)}, persisted ` +
        `${isJsonValue(observedValue) ? canonicalJson(observedValue) : '<none>'})`
      );
    }
  }
  return null;
}

/**
 * Exact-value echo (plan §3.6, adopted from the consumer precedent):
 * for a create/update obligation whose journey collects input in the UI,
 * the witnessed `ui.action` record's DECLARED INPUT fields (what the
 * journey entered) must be echoed exactly by the independently fetched
 * persisted fields on the SAME entity the engine holds. Both sides are
 * engine-held records past provenance (the witness issued them under the
 * supervisor-bound session) — the suite cannot forge either. A 2xx
 * status or row presence alone is insufficient: an echoed value that
 * differs fails the obligation with `EVIDENCE_VALUE_MISMATCH` even when
 * the status was 200. Delete (archive) postconditions are owner-graded
 * via `archiveFields` and carry no entered-input echo.
 *
 * Returns:
 *   string | null: the first echo-violation description, or null when
 *   every declared input value is echoed exactly by the persisted state.
 */
function exactValueEchoFailure(
  operation: 'create' | 'update',
  actionRecord: RecordLike,
  persistenceRecord: RecordLike,
): string | null {
  const entered = payloadOf(actionRecord)?.['fields'];
  if (!isPlainObject(entered) || Object.keys(entered).length === 0) {
    return (
      `exact-value echo violation (EVIDENCE_VALUE_MISMATCH): the '${UI_ACTION_KIND}' record ` +
      `'${labelOf(actionRecord)}' declares no input fields, so the persisted state cannot be ` +
      `echo-checked for the '${operation}' obligation (plan §3.6 requires the journey's ` +
      'entered values to come back exactly on the same entity)'
    );
  }
  const persisted = payloadOf(persistenceRecord)?.['fields'];
  if (!isPlainObject(persisted)) {
    return (
      `exact-value echo violation (EVIDENCE_VALUE_MISMATCH): the persistence record ` +
      `'${labelOf(persistenceRecord)}' observed no persisted fields to echo the ` +
      `'${operation}' input against`
    );
  }
  for (const key of Object.keys(entered).sort()) {
    const enteredValue = entered[key];
    if (!isJsonValue(enteredValue)) continue;
    const persistedValue = persisted[key];
    if (!isJsonValue(persistedValue) || canonicalJson(persistedValue) !== canonicalJson(enteredValue)) {
      return (
        `exact-value echo violation (EVIDENCE_VALUE_MISMATCH): the '${UI_ACTION_KIND}' declared ` +
        `input ${key}=${canonicalJson(enteredValue)} but the engine-observed persisted fields on ` +
        `the same entity carry ${
          isJsonValue(persistedValue) ? canonicalJson(persistedValue) : '<none>'
        } — a 2xx status or row presence alone is insufficient (plan §3.6)`
      );
    }
  }
  return null;
}

/**
 * Observe-channel echo (Phase 2): the witness-observed request fields
 * a suite-driven test sent must be echoed exactly by the independently
 * fetched persisted fields on the SAME entity. Same EVIDENCE_VALUE_MISMATCH
 * semantics as the browser channel, but both sides ride ONE witness
 * record (`payload.observedFields` = proxied request scalars,
 * `payload.fields` = adapter read) — there is no ui.action anchor on
 * this channel.
 *
 * Returns:
 *   string | null: the first echo-violation description, or null when
 *   every observed input value is echoed exactly.
 */
function observedEchoFailure(
  operation: 'create' | 'update',
  record: RecordLike,
): string | null {
  const observed = payloadOf(record)?.['observedFields'];
  if (!isPlainObject(observed) || Object.keys(observed).length === 0) {
    return (
      `exact-value echo violation (EVIDENCE_VALUE_MISMATCH): the observe record ` +
      `'${labelOf(record)}' carries no witness-observed request fields, so the persisted ` +
      `state cannot be echo-checked for the '${operation}' obligation (the proxy must see ` +
      'a JSON or form body to echo against)'
    );
  }
  const persisted = payloadOf(record)?.['fields'];
  if (!isPlainObject(persisted)) {
    return (
      `exact-value echo violation (EVIDENCE_VALUE_MISMATCH): the observe record ` +
      `'${labelOf(record)}' observed no persisted fields to echo the ` +
      `'${operation}' request against`
    );
  }
  for (const key of Object.keys(observed).sort()) {
    const observedValue = observed[key];
    if (!isJsonValue(observedValue)) continue;
    const persistedValue = persisted[key];
    if (!isJsonValue(persistedValue) || canonicalJson(persistedValue) !== canonicalJson(observedValue)) {
      return (
        `exact-value echo violation (EVIDENCE_VALUE_MISMATCH): the test sent ` +
        `${key}=${canonicalJson(observedValue)} (witness-observed request) but the independently ` +
        `read persisted fields on the same entity carry ` +
        `${isJsonValue(persistedValue) ? canonicalJson(persistedValue) : '<none>'} — a 2xx status ` +
        'or row presence alone is insufficient'
      );
    }
  }
  return null;
}

/**
 * The operation-specific postcondition a witnessed persistence record
 * must meet for the claim to be satisfiable. Every EXPECTATION is
 * owner-owned (classification) or engine-observed (pre-observation
 * delta) — never suite-supplied (audit round 5):
 * - create: the engine observed the entity ABSENT before (a witness
 *   id-set pre-observation bound to this read) and PRESENT after.
 * - update: a witness entity pre-observation exists, and the engine
 *   observed an actual field delta between it and the post-action read.
 * - read: the entity is present in the engine-observed state.
 * - delete: hard delete ⇒ entity absent; archive ⇒ entity present and
 *   matching the classification's `archiveFields`.
 *
 * Args:
 *   obligation: the obligation under grading (lifecycle expectations).
 *   operation: the CRUD operation the contract requires (from
 *     `persistence:<op>` or `crud:<op>`).
 *   record: the witnessed persistence record being graded.
 *   actionEntityKey: canonical entityId key of the anchoring UI action.
 *
 * Returns:
 *   string | null: the first postcondition failure, or null when met.
 */
function persistencePostconditionFailure(
  obligation: Obligation,
  operation: 'create' | 'read' | 'update' | 'delete',
  record: RecordLike,
  actionEntityKey: string,
): string | null {
  const payload = payloadOf(record);
  if (payload === undefined) {
    return `persistence record '${labelOf(record)}' carries no payload to evaluate`;
  }
  if (typeof payload['found'] !== 'boolean') {
    return (
      `persistence record '${labelOf(record)}' carries no engine-observed presence ` +
      `observation ('found'), so the '${obligation.contract}' postcondition cannot be evaluated`
    );
  }
  const found = payload['found'];
  const before = payload['before'];

  if (operation === 'create') {
    if (!isPlainObject(before) || before['entityAbsent'] !== true) {
      return 'create postcondition violated: no engine-observed pre-observation shows the entity absent before the action';
    }
    if (!found) {
      return 'create postcondition violated: entity still absent after the action';
    }
    return null;
  }
  if (operation === 'update') {
    if (
      !isPlainObject(before) ||
      before['found'] !== true ||
      !isPlainObject(before['fields'])
    ) {
      return 'update postcondition violated: no engine-observed before-state (a witness pre-observation of the entity is required)';
    }
    if (!found) {
      return 'update postcondition violated: entity absent after the action';
    }
    // Owner-owned relevance (audit round 6): the delta must touch at
    // least one classification-declared updateable field. Bookkeeping
    // columns (e.g. `updated_at`) drifting on an untouched entity can
    // never satisfy.
    const updateable = obligation.lifecycle.updateableFields;
    if (!Array.isArray(updateable) || updateable.length === 0) {
      return 'update postcondition cannot be evaluated: the classification declares no updateableFields';
    }
    if (!isPlainObject(payload['fields'])) {
      return 'update postcondition violated: the engine observed no persisted fields';
    }
    const delta: string[] = [];
    const after = payload['fields'] as Record<string, unknown>;
    const beforeFields = before['fields'] as Record<string, unknown>;
    for (const key of new Set([...Object.keys(beforeFields), ...Object.keys(after)])) {
      const beforeValue = beforeFields[key];
      const afterValue = after[key];
      if (!isJsonValue(beforeValue) || !isJsonValue(afterValue)) continue;
      if (canonicalJson(beforeValue) !== canonicalJson(afterValue)) delta.push(key);
    }
    const qualifying = delta.filter((key) => (updateable as readonly string[]).includes(key));
    if (qualifying.length === 0) {
      return (
        'update postcondition violated: the engine-observed delta ' +
        `[${[...delta].sort().join(', ')}] touches no classification-declared ` +
        `updateable field (updateableFields: [${[...updateable].sort().join(', ')}])`
      );
    }
    return null;
  }
  if (operation === 'read') {
    if (!found) {
      return 'read postcondition violated: entity absent';
    }
    return null;
  }
  if (operation === 'delete') {
    if (obligation.lifecycle.deleteSemantics === 'archive') {
      if (!found) {
        return 'archive postcondition violated: entity absent (archived entities stay present)';
      }
      return declaredFieldsMatchFailure(
        obligation.lifecycle.archiveFields,
        payload['fields'],
        'archive',
      );
    }
    if (found) {
      return 'delete postcondition violated: entity still present after a hard delete';
    }
    return null;
  }
  return null;
}

/**
 * Evaluates one claim's evidence against the obligation's contract:
 * a ui.action (any tier — suite-asserted) matching the operation →
 * entityId extraction and D3 validation → a WITNESSED (engine-observed)
 * persistence.* record for the same entity meeting the operation's
 * postcondition.
 *
 * Dispatch (ADR 0004 D8, plan phase 5 + Phase 1 item 8):
 * - `crud:<op>` — UI-semantic, graded by the session-channel verifier
 *   ({@link crudClaimVerifier}): supervised session binding, witnessed
 *   interval-gated exchange, visible result, persistence echo;
 * - `persistence:<op>` — graded on the witness's own observations with
 *   OWNER-owned expectations (classification `archiveFields`) and
 *   engine-observed before/after deltas. The tested suite never supplies
 *   expectations.
 * - everything else — no semantic verifier registered, fail closed.
 */
/**
 * Per-claim dispatch (ADR 0004 D8, plan phase 5): every contract
 * namespace is graded by exactly one registered semantic verifier;
 * unknown namespaces stay fail-closed blocking. The built-in
 * persistence/crud grader keeps its historical behavior verbatim.
 */
function evaluateClaimEvidence(
  claim: Claim,
  evidence: Array<{ record: RecordLike; trust: TrustTier }>,
  obligation: Obligation,
  primaryKey: readonly string[],
  resource: { kind: string; attributes: Record<string, unknown> } | null | undefined,
  httpRoutes: readonly HttpRouteCandidate[] | null | undefined,
): ClaimOutcome {
  const verifier = verifierFor(obligation.contract);
  if (verifier === null) {
    return {
      status: 'missing',
      reason:
        `no semantic verifier is registered for contract '${obligation.contract}'; the generic ` +
        `CRUD evidence rule does not apply to non-persistence contracts, so '${obligation.id}' stays ` +
        'blocking until its pack-specific verifier grades the evidence',
    };
  }
  return verifier({ claim, obligation, evidence, primaryKey, resource, httpRoutes });
}

// Built-in registrations: persistence/crud semantics stay owned by this
// module; pack namespaces register through './pack-verifiers.js'.
registerContractVerifier('crud', (input) => crudClaimVerifier(input));
registerContractVerifier('persistence', (input) => persistenceClaimVerifier(input.claim, input.evidence, input.obligation, input.primaryKey));
registerPackVerifiers();

/**
 * Capability metadata for the persistence namespace (plan Phase 0 item 7,
 * ADR 0005; Phase 1 implements the echo): implemented over the witness
 * persistence adapter (engine-observed same-entity state reads) plus the
 * supervisor-bound session channel. The metadata text carries the
 * exact-value echo requirement (plan §3.6): for a UI-collected mutation,
 * the independent persistence evidence must echo the user-entered values
 * exactly on the same entity identity — a 2xx status or row presence
 * alone is insufficient, and a mismatched echo fails with
 * `EVIDENCE_VALUE_MISMATCH` even when the status was 2xx.
 */
const PERSISTENCE_CAPABILITY: ContractCapability = {
  namespace: 'persistence',
  contracts: [
    'persistence:create',
    'persistence:read',
    'persistence:update',
    'persistence:delete',
  ],
  unavailableContracts: [],
  observer:
    'witness persistence adapter: engine-observed pre/post state reads on the SAME entity ' +
    "identity the UI action produced; exact-value echo required and enforced (plan §3.6) — " +
    'persisted field values must echo the user-entered input exactly on the same entity, and a ' +
    'mismatched echo fails with EVIDENCE_VALUE_MISMATCH even when the status was 2xx. ' +
    'Backend-only state additionally admits the server-witnessed channel: the witness runs the ' +
    "resource's adapter server probe (probeServer) ITSELF and stamps `channel: 'server'` " +
    "records carrying `declaredKind: 'server-e2e'` — admissible without the ui.action browser " +
    'anchor only for obligations the supervisor registered server-e2e. ' +
    'Suite-driven browser tests additionally admit the Observe channel: the witness matches ' +
    "the test's own proxied mutation exchange against the adapter's trusted observe binding, " +
    "reads the entity itself, and stamps `channel: 'observe'` records carrying the observed " +
    'request fields — admissible without the ui.action anchor only for obligations the ' +
    'supervisor registered observed-e2e; the request echo is graded exactly like the ' +
    'engine-entered echo (EVIDENCE_VALUE_MISMATCH on mismatch)',
  testKinds: ['browser-e2e', 'observed-e2e', 'server-e2e', 'api-e2e'],
  availability: { status: 'available' },
};

/**
 * Capability metadata for the UI-semantic crud namespace (plan Phase 0
 * item 3, Phase 1 item 4/8 + §3.6): AVAILABLE through the engine-owned
 * browser action/observation channel. The engine creates the browser
 * context, executes the constrained surface operations itself, observes
 * the rendered result and the captured application exchange, and issues
 * engine-observed (witnessed-trust) action/visible-result records.
 * Suite-submitted UI records and origin-attributed proxy exchanges can
 * never substitute for it: the anchor and visible-result rules below
 * require witnessed trust, so worker-side replays grade invalid/missing
 * instead of satisfying.
 */
const CRUD_CAPABILITY: ContractCapability = {
  namespace: 'crud',
  contracts: ['crud:create', 'crud:read', 'crud:update', 'crud:delete'],
  unavailableContracts: [],
  observer:
    'the ENGINE-OWNED browser action/observation channel (plan Phase 1 item 4): the engine ' +
    'creates the browser context, executes the constrained UI actions itself, observes the ' +
    'rendered result and the captured application exchange, and issues engine-observed ' +
    "ui.action/ui.visible-result records — suite-submitted UI records and origin-attributed " +
    'proxy exchanges can never substitute for it (test attribution stays suite-claimed)',
  testKinds: ['browser-e2e'],
  availability: { status: 'available' },
};

registerContractCapabilities(PERSISTENCE_CAPABILITY);
registerContractCapabilities(CRUD_CAPABILITY);

/**
 * The built-in persistence grader: dispatches between the three evidence
 * channels an obligation's claim may be proven through.
 *
 * - SERVER-WITNESSED channel (`payload.channel: 'server'` + `payload.
 *   declaredKind: 'server-e2e'`, both witness-stamped and covered by the
 *   record's provenance hash + attestation MAC): satisfies WITHOUT the
 *   ui.action browser anchor when the witnessed probe observation meets
 *   the operation's postcondition (the SAME
 *   {@link persistencePostconditionFailure} semantics as the browser
 *   path — create ⇒ observed absent-before + present-after, update ⇒
 *   observed before-state + qualifying delta, read ⇒ present,
 *   delete ⇒ absent / archive state). The intent that triggered the
 *   probe is suite-writable and proves nothing by itself: only the
 *   witness-issued record grades, and the witness refused to stamp the
 *   channel unless the trusted supervisor registered the obligation
 *   `server-e2e`. Records carrying the channel WITHOUT the kind stamp
 *   (impossible from an honest witness) are admissible NOWHERE — never
 *   server-satisfying and excluded from the browser path (fail closed).
 * - OBSERVE channel (`payload.channel: 'observe'` on a
 *   `persistence.observed` record, witness-stamped): satisfies WITHOUT
 *   the ui.action anchor when the witness-observed proxied mutation
 *   plus the independent adapter read meet the SAME postcondition, and
 *   (create/update) the observed request fields echo exactly
 *   (EVIDENCE_VALUE_MISMATCH on mismatch — same rule as the
 *   engine-entered echo). Admissible only for obligations the supervisor
 *   registered `observed-e2e`. Weaker than the browser channel by
 *   design: the suite drove the browser, so "UI was used" is NOT proven
 *   — only "the server stored what the proxied request sent".
 * - BROWSER channel: the historical ui.action + witnessed persistence
 *   rule, byte-identical to its pre-server-channel behavior for any
 *   evidence set that could exist without the newer channels (server-
 *   and observe-channel records are excluded from its persistence set —
 *   they are not browser evidence and must neither satisfy nor
 *   invalidate a UI-anchored claim).
 *
 * Aggregation: browser satisfaction wins (it is the stricter channel),
 * then server, then observe, then the browser outcome verbatim — except
 * that a typed server/observe-channel postcondition failure upgrades a
 * browser `missing` to `invalid` (the witness DID observe the state;
 * the claim declared the operation and lied).
 */
function persistenceClaimVerifier(
  claim: Claim,
  evidence: Array<{ record: RecordLike; trust: TrustTier }>,
  obligation: Obligation,
  primaryKey: readonly string[],
): ClaimOutcome {
  const requiredOp = persistenceOperation(obligation.contract);
  if (requiredOp === null) {
    return {
      status: 'missing',
      reason:
        `no semantic verifier is registered for contract '${obligation.contract}'; the generic ` +
        `CRUD evidence rule does not apply to non-persistence contracts, so '${obligation.id}' stays ` +
        'blocking until its pack-specific verifier grades the evidence',
    };
  }
  if (evidence.length === 0) {
    return {
      status: 'missing',
      reason:
        `claim '${claim.testId}' declares '${obligation.id}' but produced no evidence records`,
    };
  }

  // Browser channel first (unchanged semantics; server-channel records
  // cannot disturb it).
  const browser = browserAnchoredPersistenceClaim(claim, evidence, obligation, primaryKey, requiredOp);
  if (browser.status === 'satisfied') return browser;

  // SERVER-WITNESSED channel: grade every qualifying server record. Each
  // post-intent record is self-contained (the witness consumed the paired
  // pre-intent observation INTO `payload.before` at stamping time), so
  // records are graded independently against their OWN entityId — there
  // is no ui.action anchor to agree with. The kind must be EXACTLY
  // `persistence.entity`: the witness stamps the server channel only on
  // that kind, so any other kind carrying the stamp is admissible
  // NOWHERE (fail closed — never server-satisfying).
  const serverQualified = evidence.filter(
    (entry) =>
      entry.trust === 'witnessed' &&
      entry.record.kind === PERSISTENCE_ENTITY_KIND &&
      payloadOf(entry.record)?.['channel'] === SERVER_CHANNEL &&
      payloadOf(entry.record)?.['declaredKind'] === SERVER_E2E_KIND,
  );
  let serverFailure: string | null = null;
  if (serverQualified.length > 0) {
    const graded = serverQualified
      .map((entry) => ({
        entry,
        entity: normalizeEntityId(payloadOf(entry.record)?.['entityId'], primaryKey),
      }))
      .sort((a, b) => compareStrings(labelOf(a.entry.record), labelOf(b.entry.record)));
    for (const candidate of graded) {
      if (!candidate.entity.ok) {
        // A broken identity on a witnessed server record is a checkable
        // violation (D3), same as on the browser channel.
        if (serverFailure === null) {
          serverFailure =
            `server-witnessed persistence record '${labelOf(candidate.entry.record)}': ${candidate.entity.detail}`;
        }
        continue;
      }
      const failure = persistencePostconditionFailure(
        obligation,
        requiredOp,
        candidate.entry.record,
        candidate.entity.key,
      );
      if (failure === null) {
        return {
          status: 'satisfied',
          recordIds: sortedUnique(
            [candidate.entry.record.recordId].map((id) => (typeof id === 'string' ? id : '')),
          ),
        };
      }
      if (serverFailure === null) serverFailure = failure;
    }
    // No qualifying server record met the postcondition: remember the
    // sharpest diagnosis (non-empty qualified sets always leave one —
    // every candidate either satisfies or records its failure), but let
    // the Observe channel grade first — the combined upgrade below
    // prefers the server failure, then the observe one, over a bare
    // browser missing.
  }
  // OBSERVE channel (Phase 2): grade every qualifying observe record.
  // Each record is self-contained (the witness consumed the proxied
  // request, the open snapshot, and the adapter read INTO the payload
  // at finalize time), so records grade independently against their OWN
  // entityId — there is no ui.action anchor to agree with. Non-create/
  // update operations carry no echo (presence/absence grades them).
  const observeQualified = evidence.filter(
    (entry) =>
      entry.trust === 'witnessed' &&
      typeof entry.record.kind === 'string' &&
      entry.record.kind === OBSERVED_RECORD_KIND &&
      payloadOf(entry.record)?.['channel'] === OBSERVE_CHANNEL,
  );
  let observeFailure: string | null = null;
  if (observeQualified.length > 0) {
    const graded = observeQualified
      .map((entry) => ({
        entry,
        entity: normalizeEntityId(payloadOf(entry.record)?.['entityId'], primaryKey),
      }))
      .sort((a, b) => compareStrings(labelOf(a.entry.record), labelOf(b.entry.record)));
    for (const candidate of graded) {
      if (!candidate.entity.ok) {
        if (observeFailure === null) {
          observeFailure =
            `observe persistence record '${labelOf(candidate.entry.record)}': ${candidate.entity.detail}`;
        }
        continue;
      }
      const failure = persistencePostconditionFailure(
        obligation,
        requiredOp,
        candidate.entry.record,
        candidate.entity.key,
      );
      if (failure !== null) {
        if (observeFailure === null) observeFailure = failure;
        continue;
      }
      if (requiredOp === 'create' || requiredOp === 'update') {
        const echoFailure = observedEchoFailure(requiredOp, candidate.entry.record);
        if (echoFailure !== null) {
          if (observeFailure === null) observeFailure = echoFailure;
          continue;
        }
      }
      return {
        status: 'satisfied',
        recordIds: sortedUnique(
          [candidate.entry.record.recordId].map((id) => (typeof id === 'string' ? id : '')),
        ),
      };
    }
  }
  // No channel satisfied: a witnessed channel postcondition failure
  // upgrades a bare browser missing to invalid (the witness DID observe
  // state; the claim declared the operation and lied) — server first,
  // then observe. Otherwise the browser outcome stands verbatim.
  if (browser.status === 'missing') {
    const sharp = serverFailure ?? observeFailure;
    if (sharp !== null) {
      return { status: 'invalid', reason: `${sharp} (obligation '${obligation.id}')` };
    }
  }
  return browser;
}

/**
 * The BROWSER channel of the persistence grader — the historical rule
 * kept byte-identical: a provenanced `ui.action` matching the operation
 * anchors the entity; a WITNESSED engine-observed `persistence.*` record
 * for the SAME entity meeting the operation's postcondition satisfies.
 * Server-channel records (`payload.channel: 'server'`) are excluded from
 * its persistence set: they carry no browser anchor and must never be
 * consumed by a UI-anchored claim.
 */
function browserAnchoredPersistenceClaim(
  claim: Claim,
  evidence: Array<{ record: RecordLike; trust: TrustTier }>,
  obligation: Obligation,
  primaryKey: readonly string[],
  requiredOp: 'create' | 'read' | 'update' | 'delete',
): ClaimOutcome {
  // Requirement 1: a ui.action anchoring the entity. The action itself
  // is SUITE-ASSERTED (submitted through the run token; the witness
  // stamps such records claimed-tier at issuance — GF-23 round 3), so
  // any tier anchors — but ONLY records whose provenance verifies:
  // witness-stamped claimed records carry a consistent hash, fabricated
  // ones do not. Satisfaction weight lives in requirement 2, the
  // engine-observed persistence read.
  const actions = evidence.filter((entry) => entry.record.kind === UI_ACTION_KIND);
  const matchingAction = actions.find(
    (entry) =>
      isProvenancedRecord(entry.record) &&
      payloadOf(entry.record)?.['operation'] === requiredOp,
  );
  if (matchingAction === undefined) {
    if (actions.length === 0) {
      return {
        status: 'missing',
        reason: `no '${UI_ACTION_KIND}' evidence for '${obligation.id}'`,
      };
    }
    const fabricated = actions.find((entry) => !isProvenancedRecord(entry.record));
    if (fabricated !== undefined) {
      return {
        status: 'invalid',
        reason:
          `claimed-tier '${UI_ACTION_KIND}' record '${labelOf(fabricated.record)}' cannot ` +
          `satisfy '${obligation.contract}': only service-witnessed evidence satisfies (GF-23)`,
      };
    }
    const wrongOp = actions.find(
      (entry) => payloadOf(entry.record)?.['operation'] !== requiredOp,
    );
    if (wrongOp !== undefined) {
      const got = String(payloadOf(wrongOp.record)?.['operation'] ?? '<none>');
      return {
        status: 'invalid',
        reason:
          `'${UI_ACTION_KIND}' record '${labelOf(wrongOp.record)}' has operation ` +
          `'${got}' but '${obligation.contract}' requires '${requiredOp}'`,
      };
    }
    return {
      status: 'missing',
      reason: `no admissible '${UI_ACTION_KIND}' evidence for '${obligation.id}'`,
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

  // Requirement 2: a WITNESSED persistence record for the same entity
  // whose contents the witness observed engine-side (origin
  // 'engine-observed'), AND whose observed state satisfies the
  // operation's postcondition (2026-08-31 audit round 4): presence
  // alone proves nothing — a claimed delete of a live entity or a
  // "read" nobody ever saw must not satisfy.
  const persistence = evidence.filter(
    (entry) =>
      typeof entry.record.kind === 'string' &&
      entry.record.kind.startsWith(PERSISTENCE_KIND_PREFIX) &&
      payloadOf(entry.record)?.['channel'] !== SERVER_CHANNEL,
  );
  const witnessedPersistence = persistence.filter((entry) => entry.trust === 'witnessed');
  const sameEntity = witnessedPersistence.filter((entry) => {
    const entity = normalizeEntityId(payloadOf(entry.record)?.['entityId'], primaryKey);
    return entity.ok && entity.key === actionEntity.key;
  });
  if (sameEntity.length === 0) {
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

  // At least one same-entity witnessed record must meet the operation's
  // postcondition; otherwise the first failure explains the block.
  let firstPostconditionFailure: string | null = null;
  let matchingPersistence: { record: RecordLike } | undefined;
  for (const entry of sameEntity) {
    const failure = persistencePostconditionFailure(
      obligation,
      requiredOp,
      entry.record,
      actionEntity.key,
    );
    if (failure === null) {
      matchingPersistence = entry;
      break;
    }
    if (firstPostconditionFailure === null) firstPostconditionFailure = failure;
  }
  if (matchingPersistence === undefined) {
    return {
      status: 'invalid',
      reason:
        `${firstPostconditionFailure ?? `no witnessed '${PERSISTENCE_KIND_PREFIX}*' record meets ` +
        `the '${obligation.contract}' postcondition`} (obligation '${obligation.id}')`,
    };
  }

  // Exact-value echo (plan §3.6): for UI-collected create/update, the
  // persisted state on the same entity must echo the journey's entered
  // input EXACTLY — engine-record vs engine-record, never a suite
  // expectation. A mismatch blocks with EVIDENCE_VALUE_MISMATCH even
  // when the status was 200 and the row exists.
  if (requiredOp === 'create' || requiredOp === 'update') {
    const echoFailure = exactValueEchoFailure(
      requiredOp,
      matchingAction.record,
      matchingPersistence.record,
    );
    if (echoFailure !== null) {
      return { status: 'invalid', reason: `${echoFailure} (obligation '${obligation.id}')` };
    }
  }

  // Consistency hardening: visible vs persisted fields must agree when a
  // visible-result record for the same entity exists (any tier — the
  // visible side is suite-asserted, so disagreement with the
  // engine-observed persisted fields is a fabrication signal).
  const visible = evidence.find((entry) => {
    if (entry.record.kind !== UI_VISIBLE_KIND) return false;
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
 * The operation a `crud:` contract requires, or null for any other name
 * inside the namespace (unknown `crud:*` names stay typed-blocking).
 */
function crudOperation(contract: string): 'create' | 'read' | 'update' | 'delete' | null {
  if (!contract.startsWith(CRUD_CONTRACT_PREFIX)) return null;
  const operation = contract.slice(CRUD_CONTRACT_PREFIX.length);
  if (operation === 'create' || operation === 'read' || operation === 'update' || operation === 'delete') {
    return operation;
  }
  return null;
}

/** A non-empty string payload field (the session-binding shape). */
function payloadSessionId(record: RecordLike): string | null {
  const value = payloadOf(record)?.['sessionId'];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * Grades the UI-semantic `crud:<op>` contracts on the SUPERVISED SESSION
 * CHANNEL (plan Phase 1 items 5/8, §3.6; review finding "Phase 1 browser
 * proof is absent"). Satisfies ONLY when ALL of the following hold for
 * the claim, all within the SAME witness session:
 *
 *  (i) a provenanced session-bound `ui.action` record with the matching
 *      operation — the suite-asserted anchor (any trust tier anchors, as
 *      in the persistence rule, but ONLY records whose provenance
 *      verifies), carrying the session id the witness stamped at
 *      issuance;
 *  (ii) the WITNESSED `http.request` exchange of that same session,
 *      attributed to the obligation's endpoint. Interval guarantee: the
 *      witness issues `http.request` records ONLY for exchanges observed
 *      through THAT session's dedicated proxy port INSIDE one of its
 *      witness-kept action intervals, so the record's existence is the
 *      interval proof — setup traffic outside every interval never
 *      becomes a record at all. Route attribution runs through the
 *      existing `resolveHttpRoute` machinery over the COMPLETE
 *      host-derived inventory; without an inventory the claim grades a
 *      typed missing naming the gap (never satisfied), and
 *      non-unique/nomatch attribution blocks. A `crud:` obligation
 *      attaches to a business (entity) resource, so a UNIQUE
 *      single-route attribution is accepted without comparing the
 *      endpoint's resource id; when the obligation's resource IS an
 *      inventoried endpoint id, only the exact match counts;
 *  (iii) a provenanced session-bound `ui.visible-result` record for the
 *      same entity (the rendered result read back through the fixture);
 *  (iv) the engine-observed persistence postcondition + exact-value
 *      echo on the same entity — the create/update/read/archive rules
 *      reused VERBATIM from the persistence grader (declared fields,
 *      updateable delta, archive fields), plus the visible-vs-persisted
 *      field agreement.
 *
 * Typed blocking (deterministic reasons, single grading sites):
 * - direct-API/Node-side mutation without a session exchange → `missing`
 *   carrying the `HTTP_OBSERVATION_UNTRUSTED`-style session reason;
 * - a borrowed cross-session exchange → `invalid` (the session binding
 *   fails it);
 * - 2xx with wrong persisted values → `invalid` `EVIDENCE_VALUE_MISMATCH`
 *   (reused verbatim);
 * - no visible-result → `missing` `EVIDENCE_NOT_COLLECTED`.
 *
 * Sessions are graded as groups (an honest bundle carries exactly one):
 * each candidate session from rule (i) is evaluated independently in
 * codepoint order, and `satisfied` beats `invalid` beats `missing`, the
 * same aggregation the obligation level applies across claims.
 *
 * Args:
 *   input: the claim plus its attributed evidence, obligation, primary
 *     key, graph resource, and the host-derived route inventory.
 *
 * Returns:
 *   ClaimOutcome: the per-claim grade.
 */
/**
 * Grades the UI-semantic `crud:<op>` contracts. The namespace's
 * capability is available through the engine-owned browser channel
 * (see {@link CRUD_CAPABILITY}): only ENGINE-OBSERVED (witnessed-trust)
 * action/visible records can anchor or confirm — suite-submitted UI
 * records grade invalid/missing, never satisfied. The session-channel
 * rules below bind the rendered action, the captured application
 * exchange with route attribution, the rendered visible result, and the
 * engine-observed persistence echo on the same entity in the same
 * session.
 */
function crudClaimVerifier(input: {
  claim: Claim;
  obligation: Obligation;
  evidence: Array<{ record: RecordLike; trust: TrustTier }>;
  primaryKey: readonly string[];
  httpRoutes?: readonly HttpRouteCandidate[] | null;
}): ClaimOutcome {
  const { claim, obligation, evidence, primaryKey } = input;
  const requiredOp = crudOperation(obligation.contract);
  if (requiredOp === null) {
    return {
      status: 'missing',
      reason:
        `contract '${obligation.contract}' is not one of the graded UI-semantic operations ` +
        `(crud:create, crud:read, crud:update, crud:delete), so '${obligation.id}' stays blocking`,
    };
  }
  // Capability gate FIRST (fail closed): crud contracts are reachable
  // only while the engine-owned browser observation channel is
  // available. If a future regression marks it unavailable again, no
  // evidence can satisfy these contracts.
  const capability = capabilityFor(obligation.contract);
  if (capability === null || capability.availability.status === 'unavailable') {
    return {
      status: 'missing',
      reason:
        `'${obligation.id}': UI-semantic crud contracts fail closed — ` +
        `${capability?.availability.status === 'unavailable' ? capability.availability.reason : 'no independent browser observation channel exists'}. ` +
        `The declaring claim '${claim.testId}' carried ${evidence.length} evidence record(s); none of them ` +
        'can prove a rendered browser action without the engine-owned browser action/observation ' +
        'channel (plan Phase 1 item 4) — the gate stays blocking instead of granting browser ' +
        'credit to suite-submitted records',
    };
  }
  if (evidence.length === 0) {
    return {
      status: 'missing',
      reason:
        `claim '${claim.testId}' declares '${obligation.id}' but produced no evidence records`,
    };
  }

  // Rule (i): the ENGINE-OBSERVED ui.action anchor. Only
  // witnessed-trust records can anchor: suite-submitted UI records are
  // worker assertions, never browser proof (plan Phase 1 item 4). An
  // unprovenanced or claimed-tier action is a GF-23 violation.
  const actions = evidence.filter((entry) => entry.record.kind === UI_ACTION_KIND);
  const fabricated = actions.find((entry) => !isProvenancedRecord(entry.record));
  const claimedTier = actions.find((entry) => entry.trust !== 'witnessed');
  const badAction = fabricated ?? claimedTier;
  if (badAction !== undefined) {
    return {
      status: 'invalid',
      reason:
        `claimed-tier '${UI_ACTION_KIND}' record '${labelOf(badAction.record)}' cannot ` +
        `satisfy '${obligation.contract}': only engine-observed browser actions satisfy ` +
        'UI-semantic contracts (suite-submitted UI records never earn browser credit; GF-23)',
    };
  }
  // Normalize each candidate anchor's entityId up front (D3); a broken
  // identity is a checkable violation, reported for the smallest anchor.
  // Lockstep with the persistence grader: only actions whose payload
  // declares the REQUIRED operation can anchor (a wrong-operation action
  // blocks only when no qualifying anchor exists).
  const anchors = actions
    .filter(
      (entry) =>
        isProvenancedRecord(entry.record) &&
        payloadSessionId(entry.record) !== null &&
        payloadOf(entry.record)?.['operation'] === requiredOp,
    )
    .map((entry) => ({
      entry,
      session: payloadSessionId(entry.record) as string,
      entity: normalizeEntityId(payloadOf(entry.record)?.['entityId'], primaryKey),
    }))
    .sort((a, b) => compareStrings(labelOf(a.entry.record), labelOf(b.entry.record)));
  const firstBroken = anchors.find((anchor) => !anchor.entity.ok);
  if (firstBroken !== undefined) {
    return {
      status: 'invalid',
      reason:
        `'${UI_ACTION_KIND}' record '${labelOf(firstBroken.entry.record)}': ` +
        `${firstBroken.entity.ok ? '' : firstBroken.entity.detail}; ` +
        'same-entity enforcement (invariant 3) is impossible without it',
    };
  }
  const qualifying = anchors.filter((anchor) => anchor.entity.ok);
  if (qualifying.length === 0) {
    if (actions.length === 0) {
      return {
        status: 'missing',
        reason:
          `no session-bound '${UI_ACTION_KIND}' anchor from the declaring test: ` +
          `'${obligation.id}' requires the supervised witness session the gateforge reporter ` +
          'opens per test (records without it never carry a session binding)',
      };
    }
    const unbound = actions.find((entry) => payloadSessionId(entry.record) === null);
    if (unbound !== undefined) {
      return {
        status: 'missing',
        reason:
          `'${UI_ACTION_KIND}' record '${labelOf(unbound.record)}' carries no witness session ` +
          `binding, so it cannot anchor the supervised-session contract '${obligation.contract}': ` +
          'the gateforge reporter must open a test session (records without one never carry a ' +
          'session id)',
      };
    }
    const wrongOp = actions.find((entry) => payloadOf(entry.record)?.['operation'] !== requiredOp);
    if (wrongOp !== undefined) {
      const got = String(payloadOf(wrongOp.record)?.['operation'] ?? '<none>');
      return {
        status: 'invalid',
        reason:
          `'${UI_ACTION_KIND}' record '${labelOf(wrongOp.record)}' has operation ` +
          `'${got}' but '${obligation.contract}' requires '${requiredOp}'`,
      };
    }
    return {
      status: 'missing',
      reason: `no admissible '${UI_ACTION_KIND}' evidence for '${obligation.id}'`,
    };
  }

  // Rules (ii)-(iv) are evaluated PER SESSION GROUP, in codepoint order.
  const sessions = sortedUnique(qualifying.map((anchor) => anchor.session));
  let firstInvalid: string | null = null;
  let firstMissing: string | null = null;
  for (const session of sessions) {
    const anchor = qualifying.find((candidate) => candidate.session === session) as {
      entry: { record: RecordLike };
      entity: { ok: true; key: string };
    };
    const outcome = gradeCrudSession({
      session,
      anchorRecord: anchor.entry.record,
      anchorEntityKey: anchor.entity.key,
      requiredOp,
      primaryKey,
      input,
    });
    if (outcome.status === 'satisfied') return outcome;
    if (outcome.status === 'invalid' && firstInvalid === null) firstInvalid = outcome.reason;
    if (outcome.status === 'missing' && firstMissing === null) firstMissing = outcome.reason;
  }
  if (firstInvalid !== null) return { status: 'invalid', reason: firstInvalid };
  return { status: 'missing', reason: firstMissing ?? `no admissible evidence for '${obligation.id}'` };
}

/**
 * Grades rules (ii)-(iv) for ONE witness session: the witnessed
 * session-bound exchange with route attribution, the session-bound
 * visible result, and the engine-observed persistence echo.
 *
 * Args:
 *   params: session id, the anchoring action record, its canonical
 *     entity key, the required operation, and the verifier input.
 *
 * Returns:
 *   ClaimOutcome: the session group's grade.
 */
function gradeCrudSession(params: {
  session: string;
  anchorRecord: RecordLike;
  anchorEntityKey: string;
  requiredOp: 'create' | 'read' | 'update' | 'delete';
  primaryKey: readonly string[];
  input: {
    claim: Claim;
    obligation: Obligation;
    evidence: Array<{ record: RecordLike; trust: TrustTier }>;
    httpRoutes?: readonly HttpRouteCandidate[] | null;
  };
}): ClaimOutcome {
  const { session, anchorRecord, anchorEntityKey, requiredOp, primaryKey, input } = params;
  const { obligation, evidence } = input;

  // Rule (ii): the WITNESSED session-bound exchange. The record's
  // existence proves the interval: the witness issues http.request
  // records only for exchanges traversing THIS session's dedicated
  // proxy port inside a witness-kept action interval.
  const exchanges = evidence.filter((entry) => entry.record.kind === 'http.request');
  if (exchanges.length === 0) {
    return {
      status: 'missing',
      reason:
        `'${obligation.id}': no witnessed session-bound 'http.request' exchange was observed ` +
        `(HTTP_OBSERVATION_UNTRUSTED): a direct API or Node-side mutation never enters the ` +
        'supervised session channel, and traffic outside a witness-kept action interval is ' +
        `never issued as evidence, so the UI-semantic contract '${obligation.contract}' has no ` +
        'independently observed transport; drive the mutation through the rendered UI inside ' +
        'the fixture\'s recorded action interval',
    };
  }
  const forgedExchange = exchanges.find(
    (entry) => entry.trust !== 'witnessed' || !isProvenancedRecord(entry.record),
  );
  if (forgedExchange !== undefined) {
    return {
      status: 'invalid',
      reason:
        `'${obligation.id}': suite-submitted network record '${labelOf(forgedExchange.record)}' ` +
        `cannot satisfy '${obligation.contract}' (HTTP_OBSERVATION_UNTRUSTED): only a ` +
        'witness-issued engine-observed exchange proves transport',
    };
  }
  const foreign = exchanges.find((entry) => payloadSessionId(entry.record) !== session);
  if (foreign !== undefined) {
    return {
      status: 'invalid',
      reason:
        `'${obligation.id}': witnessed 'http.request' record '${labelOf(foreign.record)}' was ` +
        `observed on witness session '${String(payloadSessionId(foreign.record) ?? '<none>')}' ` +
        `but the declaring '${UI_ACTION_KIND}' anchors session '${session}' — exchanges are ` +
        'consumable only by the session whose channel they traversed; borrowed cross-session ' +
        'evidence can never satisfy',
    };
  }
  // Inventory gate FIRST (fail closed): without the complete host-derived
  // route inventory the session exchange can never be attributed.
  if (input.httpRoutes === null || input.httpRoutes === undefined) {
    return {
      status: 'missing',
      reason:
        `'${obligation.id}': no route inventory context for '${obligation.contract}': crud ` +
        'satisfaction requires the complete host-derived route inventory (every applicable ' +
        'http.endpoint resource) so the witnessed session exchange can be attributed to the ' +
        "obligation's endpoint — without it the claim stays blocking and is never satisfied",
    };
  }
  // Pick the codepoint-smallest witnessed same-session exchange whose
  // method/url pair is well-formed; malformed ones are checkable violations.
  const shaped = exchanges
    .filter((entry) => payloadSessionId(entry.record) === session)
    .map((entry) => ({ entry, payload: payloadOf(entry.record) }))
    .sort((a, b) => compareStrings(labelOf(a.entry.record), labelOf(b.entry.record)));
  const malformed = shaped.find(
    (candidate) =>
      candidate.payload === undefined ||
      typeof candidate.payload['method'] !== 'string' ||
      typeof candidate.payload['url'] !== 'string',
  );
  if (malformed !== undefined) {
    return {
      status: 'invalid',
      reason:
        `'${obligation.id}': witnessed 'http.request' record '${labelOf(malformed.entry.record)}' ` +
        'carries no method/url pair',
    };
  }
  let attributed: { entry: (typeof shaped)[number]['entry']; path: string; method: string } | null = null;
  let exchangeBlock: string | null = null;
  for (const candidate of shaped) {
    const payload = candidate.payload as Record<string, unknown>;
    const method = payload['method'] as string;
    const interpreted = interpretObservedPath(payload['url']);
    if (!interpreted.ok) {
      exchangeBlock = `'${obligation.id}': witnessed 'http.request' record ` +
        `'${labelOf(candidate.entry.record)}' carries a noncanonical observed path: ${interpreted.reason}`;
      continue;
    }
    const resolution = resolveHttpRoute(
      method,
      interpreted.path,
      input.httpRoutes,
      obligation.resourceId,
    );
    if (resolution.status === 'incomplete') {
      exchangeBlock = `'${obligation.id}': ${resolution.reason}`;
      continue;
    }
    if (resolution.status === 'nomatch') {
      exchangeBlock =
        `'${obligation.id}': witnessed 'http.request' record ` +
        `'${labelOf(candidate.entry.record)}' ${resolution.reason}`;
      continue;
    }
    if (resolution.status === 'ambiguous') {
      exchangeBlock =
        `'${obligation.id}': ambiguous route attribution: observed ` +
        `${method.toUpperCase()} ${interpreted.path} matches ${resolution.candidates.length} ` +
        `distinct routes [${resolution.candidates.join('; ')}]; no endpoint-specific claim ` +
        'passes on an ambiguous exchange';
      continue;
    }
    // 'match' | 'mismatch': the exchange attributes to EXACTLY one
    // inventoried route. A crud obligation attaches to a business
    // (entity) resource — never the endpoint resource itself — so a
    // unique single-route attribution is the honest endpoint binding;
    // only when the obligation's resource IS an inventoried endpoint id
    // must the matched route be that exact endpoint.
    if (resolution.status === 'mismatch' && obligation.resourceId.startsWith('http.endpoint:')) {
      exchangeBlock =
        `'${obligation.id}': witnessed 'http.request' record ` +
        `'${labelOf(candidate.entry.record)}' observed ${method.toUpperCase()} ` +
        `${interpreted.path} uniquely matches route ${resolution.matched.resourceId} ` +
        `but the obligation requires endpoint '${obligation.resourceId}'`;
      continue;
    }
    attributed = { entry: candidate.entry, path: interpreted.path, method };
    break;
  }
  if (attributed === null) {
    return exchangeBlock === null
      ? { status: 'missing', reason: `'${obligation.id}': no attributable session exchange` }
      : { status: 'invalid', reason: exchangeBlock };
  }

  // Rule (iii): the ENGINE-OBSERVED session-bound visible result for
  // the same entity. Suite-submitted visible records are worker
  // assertions — only the engine's own readback confirms the rendered
  // outcome (plan Phase 1 item 4).
  const visibleRecords = evidence.filter((entry) => entry.record.kind === UI_VISIBLE_KIND);
  const unprovenancedVisible = visibleRecords.find(
    (entry) => !isProvenancedRecord(entry.record) || entry.trust !== 'witnessed',
  );
  if (unprovenancedVisible !== undefined) {
    return {
      status: 'invalid',
      reason:
        `claimed-tier '${UI_VISIBLE_KIND}' record '${labelOf(unprovenancedVisible.record)}' ` +
        'cannot satisfy: only the engine-observed rendered readback confirms the visible ' +
        'outcome (suite-submitted visible records never earn browser credit; GF-23)',
    };
  }
  const sessionVisible = visibleRecords.filter(
    (entry) => payloadSessionId(entry.record) === session,
  );
  if (sessionVisible.length === 0) {
    const otherSession = visibleRecords.find((entry) => payloadSessionId(entry.record) !== null);
    return {
      status: 'missing',
      reason:
        otherSession !== undefined
          ? `'${obligation.id}': witnessed visible-result evidence exists only on witness ` +
            `session '${String(payloadSessionId(otherSession.record))}', not the declaring ` +
            `session '${session}' — the visible result must be read back in the same ` +
            'supervised session'
          : `no witnessed visible-result record for entity ${anchorEntityKey} of '${obligation.id}' ` +
            `(EVIDENCE_NOT_COLLECTED): the journey must read the rendered result back through ` +
            'the fixture\'s visible.confirm inside the same supervised session',
    };
  }
  const matchingVisible = sessionVisible.find((entry) => {
    const entity = normalizeEntityId(payloadOf(entry.record)?.['entityId'], primaryKey);
    return entity.ok && entity.key === anchorEntityKey;
  });
  if (matchingVisible === undefined) {
    return {
      status: 'invalid',
      reason:
        `same-entity violation: the '${UI_VISIBLE_KIND}' records of session '${session}' target ` +
        `other entities than the '${UI_ACTION_KIND}' entity ${anchorEntityKey} ` +
        `(obligation '${obligation.id}')`,
    };
  }

  // Rule (iv): the engine-observed persistence postcondition + exact-value
  // echo on the same entity (rules reused verbatim from the persistence
  // grader), restricted to the same session.
  const persistence = evidence.filter(
    (entry) =>
      typeof entry.record.kind === 'string' &&
      entry.record.kind.startsWith(PERSISTENCE_KIND_PREFIX) &&
      entry.trust === 'witnessed' &&
      payloadSessionId(entry.record) === session,
  );
  const sameEntity = persistence.filter((entry) => {
    const entity = normalizeEntityId(payloadOf(entry.record)?.['entityId'], primaryKey);
    return entity.ok && entity.key === anchorEntityKey;
  });
  if (sameEntity.length === 0) {
    const claimedPersistence = evidence.find(
      (entry) =>
        typeof entry.record.kind === 'string' &&
        entry.record.kind.startsWith(PERSISTENCE_KIND_PREFIX) &&
        entry.trust !== 'witnessed',
    );
    if (claimedPersistence !== undefined) {
      return {
        status: 'invalid',
        reason:
          `claimed-tier '${String(claimedPersistence.record.kind)}' record ` +
          `'${labelOf(claimedPersistence.record)}' cannot satisfy '${obligation.contract}': ` +
          'only service-witnessed evidence satisfies (GF-23)',
      };
    }
    return {
      status: 'missing',
      reason:
        `no witnessed '${PERSISTENCE_KIND_PREFIX}*' record for entity ${anchorEntityKey} in ` +
        `witness session '${session}' of '${obligation.id}' — the engine-observed state read ` +
        'must run under the same supervised session as the UI action',
    };
  }
  let firstPostconditionFailure: string | null = null;
  let matchingPersistence: RecordLike | undefined;
  for (const entry of sameEntity) {
    const failure = persistencePostconditionFailure(
      obligation,
      requiredOp,
      entry.record,
      anchorEntityKey,
    );
    if (failure === null) {
      matchingPersistence = entry.record;
      break;
    }
    if (firstPostconditionFailure === null) firstPostconditionFailure = failure;
  }
  if (matchingPersistence === undefined) {
    return {
      status: 'invalid',
      reason:
        `${firstPostconditionFailure ?? `no witnessed '${PERSISTENCE_KIND_PREFIX}*' record meets ` +
        `the '${obligation.contract}' postcondition`} (obligation '${obligation.id}')`,
    };
  }
  if (requiredOp === 'create' || requiredOp === 'update') {
    const echoFailure = exactValueEchoFailure(requiredOp, anchorRecord, matchingPersistence);
    if (echoFailure !== null) {
      return { status: 'invalid', reason: `${echoFailure} (obligation '${obligation.id}')` };
    }
  }
  const disagreement = fieldsDisagreement(
    payloadOf(matchingVisible.record)?.['fields'],
    payloadOf(matchingPersistence)?.['fields'],
  );
  if (disagreement !== null) {
    return {
      status: 'invalid',
      reason:
        `visible and persisted fields disagree on ${disagreement} ` +
        `(obligation '${obligation.id}')`,
    };
  }

  const used = [anchorRecord, attributed.entry.record, matchingVisible.record, matchingPersistence]
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
    const outcome = evaluateClaimEvidence(
      claim,
      evidence,
      verified,
      classification.primaryKey,
      context.resource,
      context.httpRoutes,
    );
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
 * highest trust tier among its records (SARIF properties), optional
 * detector provenance passthrough, and the plan §5.4 cause code +
 * next action for the shared report model.
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
      const mapped = causeForVerdict({
        obligationId: obligation.id,
        contract: obligation.contract,
        verdict: outcome.verdict,
        reason: outcome.reason,
      });
      return { obligation, ...outcome, trustTier, cause: mapped.cause, nextAction: mapped.nextAction };
    })
    .sort((a, b) => compareStrings(a.obligation.id, b.obligation.id));
}
