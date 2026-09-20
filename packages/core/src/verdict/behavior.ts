/**
 * Required-case aggregation (plan 2026-09-19 §4.7, Phase 5): the pure
 * semantic grader for obligations compiled from the behavior catalog.
 *
 * Aggregation is across the REQUIRED CASES, never inside the legacy
 * "any claim satisfied" shortcut: every required case must pass exactly
 * once. A legacy record never contributes to the new case set, and
 * suite-expanded claim ids never widen it — only the compiled
 * requirement set (trusted context, not record payloads) decides what
 * is required, and only payload-listed obligation ids decide what a
 * record may satisfy.
 *
 * Per case the grader validates provenance, catalog/spec digests,
 * endpoint/effect/actor bindings, and state-machine facts, then grades
 * with the namespace's pure semantic rules:
 * - exact method, canonical endpoint, and all relevant route/query/body
 *   identity selectors from approved case data;
 * - authoritative before/after checkpoints with normalized declared
 *   effect projections (multi-resource changes grade atomically; an
 *   unexplained delta in any declared scope is an unexpected effect);
 * - declarative bulk/import exact-set comparison (missing, extra, or
 *   duplicate entities fail).
 *
 * Phase 5 grades `request` actions over the `engine-http` channel.
 * `surface` (Phase 6), `deliver`, and `sequence` (Phase 8) actions, and
 * non-HTTP channels, block with an explicit phase cause — never a pass.
 */
import { canonicalJson, sha256Canonical, type JsonValue } from '../canonical-json.js';
import { compareStrings } from '../graph/util.js';
import type { BehaviorCatalog, CompiledBehaviorCase } from '../schemas/behavior-catalog.js';
import {
  BEHAVIOR_CASE_KIND,
  BEHAVIOR_CASE_PAYLOAD_VERSION,
  BehaviorCasePayloadSchema,
  type BehaviorCasePayload,
} from '../schemas/behavior-evidence.js';
import type { Obligation } from '../schemas/obligation.js';
import type { HttpRouteCandidate } from './registry.js';
import { interpretObservedPath, resolveHttpRoute } from './pack-verifiers.js';

/** Strong HTTP contracts graded here (engine-http request actions). */
export const STRONG_HTTP_CONTRACTS: ReadonlySet<string> = new Set([
  'http:effect-verified',
  'http:read-result-verified',
]);

/** Authentication contracts graded here (Phase 7, same case machinery). */
export const AUTH_CONTRACTS: ReadonlySet<string> = new Set([
  'auth:role-allowed',
  'auth:role-denied',
  'auth:tenant-isolated',
  'auth:denied-no-side-effect',
  'auth:forged-token-rejected',
]);

/** Validation contracts graded here (Phase 7, same case machinery). */
export const VALIDATION_CONTRACTS: ReadonlySet<string> = new Set([
  'validation:boundary-accepted',
  'validation:boundary-rejected',
  'validation:no-side-effect-on-reject',
  'validation:error-message-explicit',
  'validation:envelope-shape-stable',
]);

/** Workflow contracts graded through authenticated behavior.case evidence. */
export const WORKFLOW_CONTRACTS: ReadonlySet<string> = new Set([
  'workflow:transition-allowed',
  'workflow:transition-rejected',
  'workflow:terminal-immutable',
  'workflow:audit-emitted',
  'workflow:persisted-final-state',
]);

/** Task contracts graded through authenticated behavior.case evidence. */
export const TASK_CONTRACTS: ReadonlySet<string> = new Set([
  'task:retry-policy-enforced',
  'task:idempotent',
  'task:terminal-handled',
  'task:observability-recorded',
  'task:duplicate-delivery-handled',
]);

/** Webhook contracts graded through authenticated behavior.case evidence. */
export const WEBHOOK_CONTRACTS: ReadonlySet<string> = new Set([
  'webhook:signature-accepted',
  'webhook:signature-rejected',
  'webhook:malformed-rejected',
  'webhook:replay-idempotent',
  'webhook:retry-bounded',
]);

/** Every contract the required-case aggregation grades. */
export const BEHAVIOR_CASE_CONTRACTS: ReadonlySet<string> = new Set([
  ...STRONG_HTTP_CONTRACTS,
  ...AUTH_CONTRACTS,
  ...VALIDATION_CONTRACTS,
  ...WORKFLOW_CONTRACTS,
  ...TASK_CONTRACTS,
  ...WEBHOOK_CONTRACTS,
]);

/** Trusted behavior slice of VerdictContext (controller-bound, never CLI config). */
export interface BehaviorObligationContext {
  /** Compiled behavior catalog (case specs, effects, obligations). */
  catalog: BehaviorCatalog;
  /** obligationId → required caseIds (usually the catalog requirements). */
  requirements: Record<string, string[]>;
  /**
   * Expected authority profile digest (engine bundle binding). When
   * present the sealed value must equal it.
   */
  authorityProfileDigest?: string | null;
}

/** Trusted context for required-case grading (never record payloads). */
export interface BehaviorGradeContext {
  /** Compiled behavior catalog (case specs, effects, obligations). */
  catalog: BehaviorCatalog;
  /** obligationId → required caseIds (usually the catalog requirements). */
  requirements: Record<string, string[]>;
  /**
   * Expected authority profile digest (engine bundle binding). When
   * present the sealed value must equal it; the CLI always provisions
   * it from the trusted policy digest.
   */
  authorityProfileDigest?: string | null;
  /** Allowed test identities (the obligation's declared claim testIds). */
  plannedTestIds: readonly string[];
}

/** One ledger record view for required-case grading. */
export interface BehaviorRecordLike {
  readonly recordId: unknown;
  readonly testId: unknown;
  readonly kind: unknown;
  readonly origin: unknown;
  readonly trust: unknown;
  readonly payload: unknown;
}

/** Required-case aggregation outcome. */
export type RequiredCaseOutcome =
  | { status: 'satisfied'; recordIds: string[] }
  | { status: 'invalid'; reason: string; recordIds: string[] }
  | { status: 'missing'; reason: string; recordIds: string[] };

/**
 * Canonical digest over a case action descriptor. The witness seals
 * this; the grader recomputes it from the compiled catalog — both use
 * GF-canonical JSON, so equal actions hash equally on both sides.
 */
export function behaviorActionDigestOf(action: unknown): string {
  return sha256Canonical(action as JsonValue);
}

/** Identity key mirroring the witness snapshot validation (lockstep). */
function identityKeyOf(entityId: unknown, identityFields: string[]): string | null {
  if (entityId === null || entityId === undefined) return null;
  if (typeof entityId === 'string' || typeof entityId === 'number' || typeof entityId === 'boolean') {
    return `${typeof entityId}:${String(entityId)}`;
  }
  if (typeof entityId !== 'object' || Array.isArray(entityId)) return null;
  const record = entityId as Record<string, unknown>;
  const parts: string[] = [];
  for (const column of [...identityFields].sort()) {
    const value = record[column];
    if (value === undefined || value === null) return null;
    if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') return null;
    parts.push(`${column}=${typeof value}:${String(value)}`);
  }
  if (parts.length === 0) return null;
  return `composite:${parts.join('|')}`;
}

/** Deep equality over JSON values (canonical form). */
function valuesEqual(left: unknown, right: unknown): boolean {
  try {
    return canonicalJson(left as JsonValue) === canonicalJson(right as JsonValue);
  } catch {
    return false;
  }
}

/** Unsafe lookup segments (no prototype-chain traversal). */
const FORBIDDEN_SEGMENTS: ReadonlySet<string> = new Set(['__proto__', 'prototype', 'constructor']);

/** Splits a value pointer: `/a/b` (JSON-pointer) or `a.b` (dotted). */
function pointerSegments(pointer: string): string[] | null {
  const segments = pointer.startsWith('/')
    ? pointer
      .split('/')
      .slice(1)
      .map((segment) => segment.replace(/~1/g, '/').replace(/~0/g, '~'))
    : pointer.split('.');
  if (segments.some((segment) => segment.length === 0 || FORBIDDEN_SEGMENTS.has(segment))) return null;
  return segments;
}

/** Resolves pointer segments into records/arrays (numeric indexes arrays). */
function resolvePointer(root: unknown, pointer: string): { found: boolean; value: unknown } {
  const segments = pointerSegments(pointer);
  if (segments === null) return { found: false, value: undefined };
  let current = root;
  for (const segment of segments) {
    if (Array.isArray(current)) {
      if (!/^[0-9]+$/.test(segment)) return { found: false, value: undefined };
      const index = Number(segment);
      if (index >= current.length) return { found: false, value: undefined };
      current = current[index];
      continue;
    }
    if (typeof current !== 'object' || current === null) return { found: false, value: undefined };
    if (!Object.prototype.hasOwnProperty.call(current, segment)) return { found: false, value: undefined };
    current = (current as Record<string, unknown>)[segment];
  }
  return { found: true, value: current };
}

/** Resolves a dotted fixture key (`accountA.id`) inside sealed fixture values. */
function resolveFixtureKey(fixtureValues: unknown, key: string): { ok: boolean; value: unknown } {
  const segments = key.split('.');
  if (segments.some((segment) => segment.length === 0 || FORBIDDEN_SEGMENTS.has(segment))) {
    return { ok: false, value: undefined };
  }
  let current = fixtureValues;
  for (const segment of segments) {
    if (typeof current !== 'object' || current === null || Array.isArray(current)) {
      return { ok: false, value: undefined };
    }
    if (!Object.prototype.hasOwnProperty.call(current, segment)) return { ok: false, value: undefined };
    current = (current as Record<string, unknown>)[segment];
  }
  return { ok: true, value: current };
}

type InputValueLike = { from: string; value?: unknown; key?: unknown };
type ExpectedValueLike = InputValueLike & { attempt?: unknown; pointer?: unknown; transform?: unknown };

/** Observation sections addressable by request-derived expectations. */
interface ObservationSections {
  path: unknown;
  query: unknown;
  body: unknown;
  response: unknown;
  status: unknown;
}

/** Resolution context for one case grade. */
interface GradeValueContext {
  fixtureValues: unknown;
  observation: ObservationSections | null;
  before: Map<string, Map<string, { entityId: unknown; fields: Record<string, unknown> }>>;
}

/** Resolves an InputValue (literal or fixture key). */
function resolveInputValue(value: unknown, fixtureValues: unknown): { ok: boolean; value: unknown } {
  const v = value as InputValueLike | null;
  if (typeof v !== 'object' || v === null) return { ok: false, value: undefined };
  if (v.from === 'literal') return { ok: true, value: v.value };
  if (v.from === 'fixture' && typeof v.key === 'string') return resolveFixtureKey(fixtureValues, v.key);
  return { ok: false, value: undefined };
}

/** Applies a comparison transform to a string value. */
function applyTransform(value: unknown, transform: unknown): unknown {
  if (typeof value !== 'string') return value;
  if (transform === 'trim') return value.trim();
  if (transform === 'lowercase') return value.toLowerCase();
  return value;
}

/** Resolves an ExpectedValue (literal, fixture, observed request, or before-state). */
function resolveExpectedValue(
  value: unknown,
  ctx: GradeValueContext,
): { ok: boolean; value: unknown } {
  const v = value as ExpectedValueLike | null;
  if (typeof v !== 'object' || v === null) return { ok: false, value: undefined };
  if (v.from === 'literal') return { ok: true, value: v.value };
  if (v.from === 'fixture' && typeof v.key === 'string') return resolveFixtureKey(ctx.fixtureValues, v.key);
  if (v.from === 'request') {
    if (ctx.observation === null || typeof v.pointer !== 'string') return { ok: false, value: undefined };
    if (typeof v.attempt !== 'number' || v.attempt !== 0) return { ok: false, value: undefined };
    const resolved = resolvePointer(ctx.observation, v.pointer);
    if (!resolved.found) return { ok: false, value: undefined };
    return { ok: true, value: applyTransform(resolved.value, v.transform) };
  }
  if (v.from === 'before') {
    const scopeName = (v as { scope?: unknown }).scope;
    const subject = (v as { subject?: unknown }).subject;
    const field = (v as { field?: unknown }).field;
    if (typeof scopeName !== 'string' || typeof field !== 'string') return { ok: false, value: undefined };
    const subjectResolved = resolveInputValue(subject, ctx.fixtureValues);
    if (!subjectResolved.ok) return { ok: false, value: undefined };
    const scopeIndex = ctx.before.get(scopeName);
    if (scopeIndex === undefined) return { ok: false, value: undefined };
    // Identity fields are scope-specific; find by serialized entity match.
    for (const entity of scopeIndex.values()) {
      if (valuesEqual(entity.entityId, subjectResolved.value)) {
        if (!Object.prototype.hasOwnProperty.call(entity.fields, field)) return { ok: false, value: undefined };
        return { ok: true, value: entity.fields[field] };
      }
    }
    return { ok: false, value: undefined };
  }
  return { ok: false, value: undefined };
}

/** Indexed scope snapshots (scope key → identity key → entity). */
type ScopeIndex = Map<string, Map<string, { entityId: unknown; fields: Record<string, unknown> }>>;

/** Builds an index over sealed scope snapshots with scope-identity keys. */
function indexSnapshots(
  snapshots: Array<{ scope: string; entities: Array<{ entityId: unknown; fields: Record<string, unknown> }> }>,
  compiled: CompiledBehaviorCase,
): { ok: boolean; index?: ScopeIndex; reason?: string } {
  const index: ScopeIndex = new Map();
  const effectByScope = new Map(compiled.effects.map((effect) => [effect.scope, effect]));
  for (const snapshot of snapshots) {
    const effect = effectByScope.get(snapshot.scope);
    if (effect === undefined) {
      return { ok: false, reason: `sealed snapshot scope '${snapshot.scope}' is not a declared effect` };
    }
    const scopeIndex = new Map<string, { entityId: unknown; fields: Record<string, unknown> }>();
    for (const entity of snapshot.entities) {
      const key = identityKeyOf(entity.entityId, effect.identityFields);
      if (key === null || scopeIndex.has(key)) {
        return { ok: false, reason: `sealed snapshot scope '${snapshot.scope}' has unknown or duplicate identity` };
      }
      scopeIndex.set(key, { entityId: entity.entityId, fields: entity.fields });
    }
    index.set(snapshot.scope, scopeIndex);
  }
  return { ok: true, index };
}

/** True when a scalar value identifies an entity present in before-state. */
function beforeContains(before: ScopeIndex, value: unknown): boolean {
  if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') return false;
  for (const scopeIndex of before.values()) {
    for (const entity of scopeIndex.values()) {
      if (valuesEqual(entity.entityId, value)) return true;
      if (typeof entity.entityId === 'object' && entity.entityId !== null && !Array.isArray(entity.entityId)) {
        const columns = Object.values(entity.entityId as Record<string, unknown>);
        if (columns.some((column) => valuesEqual(column, value))) return true;
      }
    }
  }
  return false;
}

/** Per-scope explained-identity ledger for unexpected-effect detection. */
interface ExplainedLedger {
  added: Set<string>;
  removed: Set<string>;
  changed: Set<string>;
  /** Scopes fully explained by their rules (unchanged, exact-set). */
  complete: Set<string>;
}

function newLedger(): ExplainedLedger {
  return { added: new Set(), removed: new Set(), changed: new Set(), complete: new Set() };
}

/** Scope delta between before and after indexes. */
function scopeDelta(
  before: Map<string, { entityId: unknown; fields: Record<string, unknown> }>,
  after: Map<string, { entityId: unknown; fields: Record<string, unknown> }>,
): { added: string[]; removed: string[]; changed: string[] } {
  const added: string[] = [];
  const removed: string[] = [];
  const changed: string[] = [];
  for (const [key, entity] of after) {
    const prior = before.get(key);
    if (prior === undefined) added.push(key);
    else if (!valuesEqual(prior.fields, entity.fields)) changed.push(key);
  }
  for (const key of before.keys()) {
    if (!after.has(key)) removed.push(key);
  }
  return { added, removed, changed };
}

type RuleGrade = { ok: true } | { ok: false; reason: string };

/** Grades one state rule; records explained identities for atomicity. */
function gradeStateRule(
  obligationId: string,
  rule: Record<string, unknown>,
  before: ScopeIndex,
  after: ScopeIndex,
  valueCtx: GradeValueContext,
  explained: Map<string, ExplainedLedger>,
  scopeKeyOf: (effectId: string) => string | null,
): RuleGrade {
  const kind = rule['kind'];
  if (kind === 'attempts') {
    return {
      ok: false,
      reason: `'${obligationId}': 'attempts' rules require the Phase 8 delivery trace — blocked, never satisfied`,
    };
  }
  if (typeof rule['scope'] !== 'string') {
    return { ok: false, reason: `'${obligationId}': state rule has no scope` };
  }
  // Rule scopes name declared EFFECT ids; snapshots are keyed by the
  // effect's approved scope key.
  const scopeName = scopeKeyOf(rule['scope'] as string);
  if (scopeName === null) {
    return { ok: false, reason: `'${obligationId}': state rule scope '${rule['scope'] as string}' is not a declared effect` };
  }
  const beforeScope = before.get(scopeName);
  const afterScope = after.get(scopeName);
  if (beforeScope === undefined || afterScope === undefined) {
    return { ok: false, reason: `'${obligationId}': scope '${scopeName}' lacks before/after snapshots` };
  }
  const ledger = explained.get(scopeName) ?? newLedger();
  explained.set(scopeName, ledger);
  const fail = (reason: string): RuleGrade => ({ ok: false, reason: `'${obligationId}': ${reason}` });

  if (kind === 'unchanged') {
    const delta = scopeDelta(beforeScope, afterScope);
    if (delta.added.length > 0 || delta.removed.length > 0 || delta.changed.length > 0) {
      return fail(`scope '${scopeName}' changed but the rule requires unchanged`);
    }
    ledger.complete.add(scopeName);
    return { ok: true };
  }

  if (kind === 'updated' || kind === 'archived') {
    const subject = resolveInputValue(rule['subject'], valueCtx.fixtureValues);
    if (!subject.ok) return fail(`scope '${scopeName}' ${kind} subject does not resolve`);
    // Find the entity by serialized identity (scope-local key needs identity fields).
    let key: string | null = null;
    for (const [candidate, entity] of beforeScope) {
      if (valuesEqual(entity.entityId, subject.value)) {
        key = candidate;
        break;
      }
    }
    if (key === null) return fail(`scope '${scopeName}' ${kind} subject is absent before the operation`);
    const afterEntity = afterScope.get(key);
    if (afterEntity === undefined) return fail(`scope '${scopeName}' ${kind} subject vanished after the operation`);
    const fields = rule['fields'];
    if (typeof fields !== 'object' || fields === null || Array.isArray(fields)) {
      return fail(`scope '${scopeName}' ${kind} fields must be a non-empty map`);
    }
    const names = Object.keys(fields);
    if (names.length === 0) return fail(`scope '${scopeName}' ${kind} fields must be non-empty`);
    const beforeEntity = beforeScope.get(key) as { fields: Record<string, unknown> };
    let deltaSeen = false;
    for (const name of names) {
      const expected = resolveExpectedValue((fields as Record<string, unknown>)[name], valueCtx);
      if (!expected.ok) return fail(`scope '${scopeName}' ${kind} field '${name}' does not resolve`);
      if (!Object.prototype.hasOwnProperty.call(afterEntity.fields, name)) {
        return fail(`scope '${scopeName}' ${kind} field '${name}' is absent after the operation`);
      }
      if (!valuesEqual(afterEntity.fields[name], expected.value)) {
        return fail(`scope '${scopeName}' ${kind} field '${name}' differs from the expected effect`);
      }
      if (!valuesEqual(beforeEntity.fields[name], afterEntity.fields[name])) deltaSeen = true;
    }
    if (!deltaSeen) {
      return fail(`scope '${scopeName}' declares an update with zero state delta — a 200 without a saved change proves nothing`);
    }
    ledger.changed.add(key);
    return { ok: true };
  }

  if (kind === 'created' || kind === 'append-only') {
    const rows = rule['rows'];
    if (!Array.isArray(rows) || rows.length === 0) {
      return fail(`scope '${scopeName}' ${kind} rows must be non-empty`);
    }
    const afterOnly = [...afterScope.keys()].filter((key) => !beforeScope.has(key));
    const claimed = new Set<string>();
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index] as { fields?: unknown };
      const fields = row?.fields;
      if (typeof fields !== 'object' || fields === null || Array.isArray(fields)) {
        return fail(`scope '${scopeName}' ${kind} row ${String(index)} fields must be a map`);
      }
      const match = afterOnly.find((key) => {
        if (claimed.has(key)) return false;
        const entity = afterScope.get(key) as { fields: Record<string, unknown> };
        return Object.entries(fields as Record<string, unknown>).every(([name, expectedRaw]) => {
          const expected = resolveExpectedValue(expectedRaw, valueCtx);
          return (
            expected.ok &&
            Object.prototype.hasOwnProperty.call(entity.fields, name) &&
            valuesEqual(entity.fields[name], expected.value)
          );
        });
      });
      if (match === undefined) {
        return fail(`scope '${scopeName}' ${kind} row ${String(index)} matches no created entity`);
      }
      claimed.add(match);
      ledger.added.add(match);
    }
    if (kind === 'append-only') {
      // Pre-existing entities must be untouched.
      for (const [key, entity] of beforeScope) {
        const current = afterScope.get(key);
        if (current === undefined || !valuesEqual(current.fields, entity.fields)) {
          return fail(`scope '${scopeName}' append-only changed a pre-existing entity`);
        }
      }
    }
    return { ok: true };
  }

  if (kind === 'absent') {
    const subjects = rule['subjects'];
    if (!Array.isArray(subjects) || subjects.length === 0) {
      return fail(`scope '${scopeName}' absent subjects must be non-empty`);
    }
    for (const subjectRaw of subjects) {
      const subject = resolveInputValue(subjectRaw, valueCtx.fixtureValues);
      if (!subject.ok) return fail(`scope '${scopeName}' absent subject does not resolve`);
      // Known-existing target (plan §4.5): a denial/absent proof against
      // a nonexistent record proves nothing — "denied" might merely mean
      // malformed fixture. The subject must exist in before-state.
      let present = false;
      for (const scopeIndex of valueCtx.before.values()) {
        for (const entity of scopeIndex.values()) {
          if (valuesEqual(entity.entityId, subject.value)) {
            present = true;
            break;
          }
        }
        if (present) break;
      }
      if (!present) {
        return fail(
          `scope '${scopeName}' absent subject does not exist in before-state — the denial target must be a known existing record (fixture validation)`,
        );
      }
      for (const [key, entity] of afterScope) {
        if (valuesEqual(entity.entityId, subject.value)) {
          return fail(`scope '${scopeName}' still contains a forbidden entity ('${key}')`);
        }
      }
    }
    // Removals explained: any before-only key is accounted for.
    for (const key of beforeScope.keys()) {
      if (!afterScope.has(key)) ledger.removed.add(key);
    }
    return { ok: true };
  }

  if (kind === 'exact-set') {
    const rows = rule['rows'];
    if (!Array.isArray(rows) || rows.length === 0) {
      return fail(`scope '${scopeName}' exact-set rows must be non-empty`);
    }
    if (afterScope.size !== rows.length) {
      return fail(
        `scope '${scopeName}' exact set mismatch: ${String(afterScope.size)} observed, ${String(rows.length)} expected`,
      );
    }
    const matched = new Set<string>();
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index] as { subject?: unknown; fields?: unknown };
      const subject = resolveInputValue(row?.subject, valueCtx.fixtureValues);
      if (!subject.ok) return fail(`scope '${scopeName}' exact-set row ${String(index)} subject does not resolve`);
      let key: string | null = null;
      for (const [candidate, entity] of afterScope) {
        if (valuesEqual(entity.entityId, subject.value)) {
          key = candidate;
          break;
        }
      }
      if (key === null || matched.has(key)) {
        return fail(`scope '${scopeName}' exact set is missing or duplicates an expected entity (row ${String(index)})`);
      }
      matched.add(key);
      const fields = row?.fields;
      if (typeof fields === 'object' && fields !== null && !Array.isArray(fields)) {
        const entity = afterScope.get(key) as { fields: Record<string, unknown> };
        for (const [name, expectedRaw] of Object.entries(fields as Record<string, unknown>)) {
          const expected = resolveExpectedValue(expectedRaw, valueCtx);
          if (
            !expected.ok ||
            !Object.prototype.hasOwnProperty.call(entity.fields, name) ||
            !valuesEqual(entity.fields[name], expected.value)
          ) {
            return fail(`scope '${scopeName}' exact-set row ${String(index)} field '${name}' differs`);
          }
        }
      }
    }
    ledger.complete.add(scopeName);
    return { ok: true };
  }

  if (kind === 'count-delta') {
    const delta = rule['delta'];
    if (typeof delta !== 'number' || !Number.isInteger(delta)) {
      return fail(`scope '${scopeName}' count-delta needs an integer delta`);
    }
    if (afterScope.size - beforeScope.size !== delta) {
      return fail(
        `scope '${scopeName}' count delta ${String(afterScope.size - beforeScope.size)} is not the declared ${String(delta)}`,
      );
    }
    return { ok: true };
  }

  if (kind === 'transition') {
    const subject = resolveInputValue(rule['subject'], valueCtx.fixtureValues);
    const field = rule['field'];
    const from = resolveExpectedValue(rule['from'], valueCtx);
    const to = resolveExpectedValue(rule['to'], valueCtx);
    if (!subject.ok || typeof field !== 'string' || !from.ok || !to.ok) {
      return fail(`scope '${scopeName}' transition subject/field/from/to must resolve`);
    }
    let key: string | null = null;
    for (const [candidate, entity] of beforeScope) {
      if (valuesEqual(entity.entityId, subject.value)) {
        key = candidate;
        break;
      }
    }
    if (key === null) return fail(`scope '${scopeName}' transition subject is absent before the operation`);
    const beforeEntity = beforeScope.get(key) as { fields: Record<string, unknown> };
    const afterEntity = afterScope.get(key);
    if (afterEntity === undefined) return fail(`scope '${scopeName}' transition subject vanished`);
    if (!valuesEqual(beforeEntity.fields[field], from.value)) {
      return fail(`scope '${scopeName}' transition starts from an unexpected state`);
    }
    if (!valuesEqual(afterEntity.fields[field], to.value)) {
      return fail(`scope '${scopeName}' transition did not reach the declared state`);
    }
    ledger.changed.add(key);
    return { ok: true };
  }

  return { ok: false, reason: `'${obligationId}': unknown state rule kind '${String(kind)}' — blocked, never satisfied` };
}

/** Validates one response rule against the principal response body. */
function gradeResponseRule(
  obligationId: string,
  rule: Record<string, unknown>,
  responseBody: unknown,
  valueCtx: GradeValueContext,
): RuleGrade {
  const kind = rule['kind'];
  const fail = (reason: string): RuleGrade => ({ ok: false, reason: `'${obligationId}': ${reason}` });
  if (kind === 'equals') {
    if (typeof rule['pointer'] !== 'string') return fail('equals rule needs a pointer');
    const actual = resolvePointer(responseBody, rule['pointer'] as string);
    if (!actual.found) return fail(`response pointer '${rule['pointer'] as string}' resolves to nothing`);
    const expected = resolveExpectedValue(rule['value'], valueCtx);
    if (!expected.ok) return fail('equals rule value does not resolve');
    if (!valuesEqual(actual.value, expected.value)) return fail('response value differs from the expected result');
    return { ok: true };
  }
  if (kind === 'field-error') {
    const field = rule['field'];
    const fieldPointer = rule['fieldPointer'];
    const codePointer = rule['codePointer'];
    const allowedCodes = rule['allowedCodes'];
    if (typeof field !== 'string' || typeof fieldPointer !== 'string' || typeof codePointer !== 'string' || !Array.isArray(allowedCodes)) {
      return fail('field-error rule needs field, fieldPointer, codePointer, and allowedCodes');
    }
    const actualField = resolvePointer(responseBody, fieldPointer);
    const actualCode = resolvePointer(responseBody, codePointer);
    if (!actualField.found || !valuesEqual(actualField.value, field)) {
      return fail(`response error does not identify field '${field}'`);
    }
    if (!actualCode.found || !allowedCodes.some((code) => valuesEqual(code, actualCode.value))) {
      return fail('response error code is not an approved code');
    }
    return { ok: true };
  }
  if (kind === 'absent') {
    if (typeof rule['pointer'] !== 'string') return fail('absent rule needs a pointer');
    const actual = resolvePointer(responseBody, rule['pointer'] as string);
    if (actual.found) return fail(`forbidden response field '${rule['pointer'] as string}' is present`);
    return { ok: true };
  }
  if (kind === 'entity-set') {
    const pointer = rule['pointer'];
    const identityFields = rule['identityFields'];
    const expected = rule['expected'];
    if (typeof pointer !== 'string' || !Array.isArray(identityFields) || !Array.isArray(expected)) {
      return fail('entity-set rule needs pointer, identityFields, and expected');
    }
    const actual = resolvePointer(responseBody, pointer);
    if (!actual.found || !Array.isArray(actual.value)) {
      return fail(`response pointer '${pointer}' is not an entity array`);
    }
    const actualRows = actual.value as unknown[];
    if (actualRows.length !== expected.length) {
      return fail(
        `response entity set has ${String(actualRows.length)} rows, expected ${String(expected.length)}`,
      );
    }
    const used = new Set<number>();
    for (let index = 0; index < expected.length; index += 1) {
      const resolved = resolveExpectedValue(expected[index], valueCtx);
      if (!resolved.ok || typeof resolved.value !== 'object' || resolved.value === null) {
        return fail(`entity-set expected row ${String(index)} does not resolve to an entity`);
      }
      const expectedRow = resolved.value as Record<string, unknown>;
      const match = actualRows.findIndex((row, rowIndex) => {
        if (used.has(rowIndex) || typeof row !== 'object' || row === null) return false;
        const actualRow = row as Record<string, unknown>;
        return (
          (identityFields as unknown[]).every(
            (column) =>
              typeof column === 'string' &&
              Object.prototype.hasOwnProperty.call(actualRow, column) &&
              Object.prototype.hasOwnProperty.call(expectedRow, column) &&
              valuesEqual(actualRow[column], expectedRow[column]),
          ) &&
          Object.entries(expectedRow).every(
            ([name, value]) =>
              Object.prototype.hasOwnProperty.call(actualRow, name) && valuesEqual(actualRow[name], value),
          )
        );
      });
      if (match === -1) return fail(`entity-set expected row ${String(index)} matches no returned row`);
      used.add(match);
    }
    return { ok: true };
  }
  if (kind === 'envelope') {
    const shape = rule['schema'];
    const outcome = validateEnvelopeShape(responseBody, shape);
    if (!outcome.ok) return fail(`response envelope mismatch: ${outcome.reason}`);
    return { ok: true };
  }
  return { ok: false, reason: `'${obligationId}': unknown response rule kind '${String(kind)}' — blocked` };
}

type EnvelopeShapeLike =
  | { type: 'object'; properties: Record<string, EnvelopeShapeLike>; required: string[]; additionalProperties: false }
  | { type: 'array'; items: EnvelopeShapeLike; minItems: number; maxItems: number }
  | { type: 'string'; minLength: number; maxLength: number; enum?: string[] }
  | { type: 'number'; minimum: number; maximum: number }
  | { type: 'integer'; minimum: number; maximum: number }
  | { type: 'boolean' }
  | { type: 'null' };

/** Validates a response body against the approved envelope shape (bounded vocabulary). */
function validateEnvelopeShape(body: unknown, shape: unknown): { ok: true } | { ok: false; reason: string } {
  const s = shape as EnvelopeShapeLike | null;
  if (typeof s !== 'object' || s === null) return { ok: false, reason: 'shape must be an object' };
  switch (s.type) {
    case 'object': {
      if (typeof body !== 'object' || body === null || Array.isArray(body)) {
        return { ok: false, reason: 'expected an object' };
      }
      const record = body as Record<string, unknown>;
      for (const name of s.required ?? []) {
        if (!Object.prototype.hasOwnProperty.call(record, name)) return { ok: false, reason: `missing required field '${name}'` };
      }
      for (const [name, sub] of Object.entries(s.properties ?? {})) {
        if (Object.prototype.hasOwnProperty.call(record, name)) {
          const outcome = validateEnvelopeShape(record[name], sub);
          if (!outcome.ok) return { ok: false, reason: `field '${name}': ${outcome.reason}` };
        }
      }
      for (const name of Object.keys(record)) {
        if (!(name in (s.properties ?? {}))) return { ok: false, reason: `additional property '${name}' is forbidden` };
      }
      return { ok: true };
    }
    case 'array': {
      if (!Array.isArray(body)) return { ok: false, reason: 'expected an array' };
      if (body.length < (s.minItems ?? 0) || body.length > (s.maxItems ?? Number.MAX_SAFE_INTEGER)) {
        return { ok: false, reason: 'array length out of bounds' };
      }
      for (let index = 0; index < body.length; index += 1) {
        const outcome = validateEnvelopeShape(body[index], s.items);
        if (!outcome.ok) return { ok: false, reason: `item ${String(index)}: ${outcome.reason}` };
      }
      return { ok: true };
    }
    case 'string': {
      if (typeof body !== 'string') return { ok: false, reason: 'expected a string' };
      if (body.length < (s.minLength ?? 0) || body.length > (s.maxLength ?? Number.MAX_SAFE_INTEGER)) {
        return { ok: false, reason: 'string length out of bounds' };
      }
      if (s.enum !== undefined && !s.enum.includes(body)) return { ok: false, reason: 'string is not an approved value' };
      return { ok: true };
    }
    case 'number': {
      if (typeof body !== 'number' || !Number.isFinite(body)) return { ok: false, reason: 'expected a number' };
      if (body < (s.minimum ?? -Infinity) || body > (s.maximum ?? Infinity)) {
        return { ok: false, reason: 'number out of bounds' };
      }
      return { ok: true };
    }
    case 'integer': {
      if (typeof body !== 'number' || !Number.isInteger(body)) return { ok: false, reason: 'expected an integer' };
      if (body < (s.minimum ?? -Infinity) || body > (s.maximum ?? Infinity)) {
        return { ok: false, reason: 'integer out of bounds' };
      }
      return { ok: true };
    }
    case 'boolean':
      return typeof body === 'boolean' ? { ok: true } : { ok: false, reason: 'expected a boolean' };
    case 'null':
      return body === null ? { ok: true } : { ok: false, reason: 'expected null' };
    default:
      return { ok: false, reason: 'unknown shape type' };
  }
}

/**
 * Aggregates the required cases of one obligation (plan §4.7): resolves
 * the required set from trusted context, matches case records to
 * allowed planned test identities, validates provenance and bindings,
 * grades each case with the pure semantic rules, and requires every
 * case to pass exactly once.
 */
export function evaluateRequiredCases(input: {
  obligation: Obligation;
  requiredCaseIds: readonly string[];
  records: readonly BehaviorRecordLike[];
  context: BehaviorGradeContext;
  httpRoutes: readonly HttpRouteCandidate[] | null | undefined;
}): RequiredCaseOutcome {
  const obligationId = input.obligation.id;
  const sortedRequired = [...new Set(input.requiredCaseIds)].sort(compareStrings);
  if (sortedRequired.length === 0) {
    return { status: 'missing', reason: `'${obligationId}': no required cases are declared for this obligation`, recordIds: [] };
  }
  const consideredIds = sortedUniqueRecordIds(input.records);
  const satisfied: string[] = [];
  let firstInvalid: { reason: string } | null = null;
  let firstMissing: { reason: string } | null = null;
  for (const caseId of sortedRequired) {
    const outcome = gradeRequiredCase(input.obligation, caseId, input.records, input.context, input.httpRoutes);
    if (outcome.status === 'satisfied') {
      satisfied.push(...outcome.recordIds);
      continue;
    }
    if (outcome.status === 'invalid' && firstInvalid === null) {
      firstInvalid = { reason: outcome.reason };
    }
    if (outcome.status === 'missing' && firstMissing === null) {
      firstMissing = { reason: outcome.reason };
    }
  }
  if (firstInvalid !== null) {
    return { status: 'invalid', reason: firstInvalid.reason, recordIds: consideredIds };
  }
  if (firstMissing !== null) {
    return { status: 'missing', reason: firstMissing.reason, recordIds: consideredIds };
  }
  return { status: 'satisfied', recordIds: [...new Set(satisfied)].sort(compareStrings) };
}

function sortedUniqueRecordIds(records: readonly BehaviorRecordLike[]): string[] {
  return [...new Set(records.map((record) => (typeof record.recordId === 'string' ? record.recordId : ''))) ]
    .filter((id) => id.length > 0)
    .sort(compareStrings);
}

/** Grades one required case: binding validation then semantic grading. */
function gradeRequiredCase(
  obligation: Obligation,
  caseId: string,
  records: readonly BehaviorRecordLike[],
  context: BehaviorGradeContext,
  httpRoutes: readonly HttpRouteCandidate[] | null | undefined,
): RequiredCaseOutcome {
  const obligationId = obligation.id;
  const compiled = context.catalog.cases.find((item) => item.caseId === caseId);
  if (compiled === undefined) {
    return {
      status: 'missing',
      reason: `'${obligationId}': required case '${caseId}' is not in the compiled catalog — repair reviewed references and rerun`,
      recordIds: [],
    };
  }
  const action = compiled.definition.action as Record<string, unknown>;
  if (compiled.definition.channel !== 'engine-http' && action['kind'] === 'request') {
    const phase = compiled.definition.channel === 'engine-browser' ? 'Phase 6' : 'Phase 8';
    return {
      status: 'missing',
      reason:
        `'${obligationId}': case '${compiled.definition.id}' requires the '${compiled.definition.channel}' ` +
        `channel (${phase}) — blocked until that driver produces genuine evidence`,
      recordIds: [],
    };
  }
  if (action['kind'] !== 'request' && action['kind'] !== 'surface') {
    return {
      status: 'missing',
      reason:
        `'${obligationId}': case '${compiled.definition.id}' uses a '${String(action['kind'])}' action ` +
        `(Phase 8) — blocked until that driver produces genuine evidence`,
      recordIds: [],
    };
  }
  if (action['kind'] === 'surface') {
    return gradeSurfaceCase(obligation, compiled, caseId, records, context);
  }
  // Candidate records: this case, engine-issued, witnessed, planned test.
  // Records naming this case for another test stay other tests' business
  // unless they claim THIS obligation from an unplanned test (replay).
  const matched = matchSingleCaseRecord(obligation, compiled, caseId, records, context);
  if (matched.kind === 'outcome') return matched.outcome;
  const { record, recordId, payload } = matched;

  // Binding validation (trusted catalog vs sealed payload).
  const bound = validateCaseBindings(obligation, compiled, caseId, recordId, payload, context);
  if (bound.kind === 'outcome') return bound.outcome;

  // Principal attempt: re-resolve method+path against the full inventory
  // with the obligation's endpoint as expected — the grader never trusts
  // witness attribution blindly.
  if (httpRoutes === null || httpRoutes === undefined || httpRoutes.length === 0) {
    return {
      status: 'missing',
      reason: `'${obligationId}': no complete route inventory — endpoint attribution is impossible without every applicable route (no any-endpoint fallback)`,
      recordIds: [recordId],
    };
  }
  const expectedMethod = (action['method'] as string).toUpperCase();
  const principals: Array<{ attempt: (typeof payload.attempts)[number]; path: string }> = [];
  let bindingViolation: string | null = null;
  for (const attempt of payload.attempts) {
    const interpreted = interpretObservedPath(attempt.path);
    if (!interpreted.ok) {
      bindingViolation = `'${obligationId}': case record '${recordId}' carries a noncanonical observed path`;
      continue;
    }
    const resolution = resolveHttpRoute(attempt.method, interpreted.path, httpRoutes, obligation.resourceId);
    if (resolution.status === 'match') {
      principals.push({ attempt, path: interpreted.path });
    } else if (resolution.status === 'ambiguous') {
      return {
        status: 'invalid',
        reason: `'${obligationId}': ambiguous route attribution for ${attempt.method.toUpperCase()} ${interpreted.path} (BEHAVIOR_BINDING_MISMATCH)`,
        recordIds: [recordId],
      };
    } else if (resolution.status === 'mismatch' || resolution.status === 'nomatch') {
      bindingViolation =
        `'${obligationId}': case record '${recordId}' captures ${attempt.method.toUpperCase()} ` +
        `${interpreted.path}, not the required endpoint '${obligation.resourceId}' (BEHAVIOR_BINDING_MISMATCH)`;
    } else {
      return { status: 'missing', reason: `'${obligationId}': ${resolution.reason}`, recordIds: [recordId] };
    }
  }
  if (principals.length === 0) {
    return {
      status: bindingViolation === null ? 'missing' : 'invalid',
      reason:
        bindingViolation ??
        `'${obligationId}': case '${compiled.definition.id}' captured no request to the required endpoint (BEHAVIOR_CASE_MISSING)`,
      recordIds: [recordId],
    };
  }
  if (principals.length > 1) {
    return {
      status: 'invalid',
      reason:
        `'${obligationId}': case '${compiled.definition.id}' captures ${String(principals.length)} matching ` +
        'requests — unexplained extra mutations are ambiguity, not proof (BEHAVIOR_BINDING_MISMATCH)',
      recordIds: [recordId],
    };
  }
  const principal = principals[0] as { attempt: (typeof payload.attempts)[number]; path: string };
  if (principal.attempt.method.toUpperCase() !== expectedMethod) {
    return {
      status: 'invalid',
      reason: `'${obligationId}': principal request uses ${principal.attempt.method.toUpperCase()}, expected ${expectedMethod} (BEHAVIOR_BINDING_MISMATCH)`,
      recordIds: [recordId],
    };
  }
  // Domain subjects carry no approved endpoint: HTTP attempts sealed
  // for them cannot attribute to a reviewed route.
  if (compiled.endpointResourceId === null && payload.attempts.length > 0) {
    return {
      status: 'invalid',
      reason: `'${obligationId}': domain-resource case captured HTTP attempts without an approved endpoint binding — attach the case to its endpoint (BEHAVIOR_BINDING_MISMATCH)`,
      recordIds: [recordId],
    };
  }
  // Indexes first: identity-selector presence checks need before-state.
  const beforeBuilt = indexSnapshots(payload.before, compiled);
  const afterBuilt = indexSnapshots(payload.after, compiled);
  if (!beforeBuilt.ok || !afterBuilt.ok) {
    return {
      status: 'invalid',
      reason: `'${obligationId}': ${(beforeBuilt.ok ? afterBuilt : beforeBuilt as { reason: string }).reason}`,
      recordIds: [recordId],
    };
  }
  const earlyBeforeIndex = (beforeBuilt as { index: ScopeIndex }).index;
  // Declared identity selectors: exact concrete path/query/body.
  const selectorViolation = checkIdentitySelectors(compiled, payload, principal, obligationId, recordId, earlyBeforeIndex);
  if (selectorViolation !== null) return { status: 'invalid', reason: selectorViolation, recordIds: [recordId] };

  // Status: the declared allowed statuses (303 included for form POSTs).
  const allowedStatuses = compiled.definition.expect.statuses;
  if (principal.attempt.status === null || !allowedStatuses.includes(principal.attempt.status)) {
    return {
      status: 'invalid',
      reason: `'${obligationId}': principal request status ${String(principal.attempt.status)} is not an allowed outcome (BEHAVIOR_EFFECT_MISMATCH)`,
      recordIds: [recordId],
    };
  }

  // Request observation joined by engine request id.
  const observation = payload.requestObservations.find(
    (item) => item.engineRequestId === principal.attempt.engineRequestId,
  );
  if (observation === undefined) {
    return {
      status: 'invalid',
      reason: `'${obligationId}': principal request has no sealed observation (OBSERVATION_SCOPE_INCOMPLETE)`,
      recordIds: [recordId],
    };
  }
  const sections: ObservationSections = {
    path: principal.path,
    query: observation.query,
    body: observation.body,
    response: observation.responseBody,
    status: observation.status,
  };
  const valueCtx: GradeValueContext = {
    fixtureValues: payload.fixtureValues,
    observation: sections,
    before: earlyBeforeIndex,
  };
  const beforeIndex = earlyBeforeIndex;
  const afterIndex = (afterBuilt as { index: ScopeIndex }).index;

  // Response rules (both contracts grade declared response expectations).
  for (const rule of compiled.definition.expect.response) {
    const graded = gradeResponseRule(obligationId, rule as unknown as Record<string, unknown>, observation.responseBody, valueCtx);
    if (!graded.ok) {
      return { status: 'invalid', reason: `${graded.reason} (BEHAVIOR_EFFECT_MISMATCH)`, recordIds: [recordId] };
    }
  }

  // State rules grade atomically: every declared effect and every
  // forbidden change in one case result.
  const explained = new Map<string, ExplainedLedger>();
  const scopeKeyOf = (effectId: string): string | null =>
    compiled.effects.find((effect) => effect.id === effectId)?.scope ?? null;
  let sawAttemptsRule = false;
  for (const rule of compiled.definition.expect.state) {
    if ((rule as { kind?: unknown }).kind === 'attempts') sawAttemptsRule = true;
    const graded = gradeStateRule(
      obligationId,
      rule as unknown as Record<string, unknown>,
      beforeIndex,
      afterIndex,
      valueCtx,
      explained,
      scopeKeyOf,
    );
    if (!graded.ok) {
      if (graded.reason.includes('Phase 8')) {
        return { status: 'missing', reason: graded.reason, recordIds: [recordId] };
      }
      return { status: 'invalid', reason: `${graded.reason} (BEHAVIOR_EFFECT_MISMATCH)`, recordIds: [recordId] };
    }
  }
  void sawAttemptsRule;

  const declaredScopes = new Set(compiled.effects.map((effect) => effect.scope));
  // Read contracts additionally require zero delta on every scope.
  if (obligation.contract === 'http:read-result-verified') {
    for (const scope of declaredScopes) {
      const beforeScope = beforeIndex.get(scope);
      const afterScope = afterIndex.get(scope);
      if (beforeScope === undefined || afterScope === undefined) {
        return {
          status: 'invalid',
          reason: `'${obligationId}': scope '${scope}' lacks before/after snapshots`,
          recordIds: [recordId],
        };
      }
      const delta = scopeDelta(beforeScope, afterScope);
      if (delta.added.length > 0 || delta.removed.length > 0 || delta.changed.length > 0) {
        return {
          status: 'invalid',
          reason: `'${obligationId}': read case changed scope '${scope}' — reads cause no state change (BEHAVIOR_UNEXPECTED_EFFECT)`,
          recordIds: [recordId],
        };
      }
    }
    return { status: 'satisfied', recordIds: [recordId] };
  }

  // Unexpected effects: any delta the rules did not explain.
  for (const scope of declaredScopes) {
    const beforeScope = beforeIndex.get(scope);
    const afterScope = afterIndex.get(scope);
    if (beforeScope === undefined || afterScope === undefined) continue;
    const ledger = explained.get(scope);
    if (ledger?.complete.has(scope) === true) continue;
    const delta = scopeDelta(beforeScope, afterScope);
    const unexplained = [
      ...delta.added.filter((key) => !ledger?.added.has(key)),
      ...delta.removed.filter((key) => !ledger?.removed.has(key)),
      ...delta.changed.filter((key) => !ledger?.changed.has(key)),
    ];
    if (unexplained.length > 0) {
      return {
        status: 'invalid',
        reason:
          `'${obligationId}': scope '${scope}' has ${String(unexplained.length)} unexplained change(s) ` +
          'beside the declared effect — a correct row plus a wrong secondary effect still fails (BEHAVIOR_UNEXPECTED_EFFECT)',
        recordIds: [recordId],
      };
    }
  }
  return { status: 'satisfied', recordIds: [recordId] };
}

/** Matched single record or an early outcome (missing/invalid). */
type CaseMatch =
  | { kind: 'record'; record: BehaviorRecordLike; recordId: string; payload: BehaviorCasePayload }
  | { kind: 'outcome'; outcome: RequiredCaseOutcome };

/**
 * Matches exactly one sealed record for a required case: engine-issued,
 * witnessed, planned test, claiming this obligation. Duplicates,
 * replays from unplanned tests, and absence resolve here — shared by
 * the request and surface grading paths.
 */
function matchSingleCaseRecord(
  obligation: Obligation,
  compiled: CompiledBehaviorCase,
  caseId: string,
  records: readonly BehaviorRecordLike[],
  context: BehaviorGradeContext,
): CaseMatch {
  const obligationId = obligation.id;
  const matching: BehaviorRecordLike[] = [];
  for (const record of records) {
    if (record.kind !== BEHAVIOR_CASE_KIND) continue;
    if (record.origin !== 'engine-observed' || record.trust !== 'witnessed') continue;
    if (typeof record.testId !== 'string') continue;
    const parsed = BehaviorCasePayloadSchema.safeParse(record.payload);
    if (!parsed.success || parsed.data.caseId !== caseId) continue;
    const planned = context.plannedTestIds.includes(record.testId);
    const claimsThis = parsed.data.obligationIds.includes(obligationId);
    if (!planned && claimsThis) {
      return {
        kind: 'outcome',
        outcome: {
          status: 'invalid',
          reason:
            `'${obligationId}': case '${compiled.definition.id}' record '${String(record.recordId)}' claims ` +
            'this obligation from an unplanned test — replayed evidence never satisfies (BEHAVIOR_BINDING_MISMATCH)',
          recordIds: [String(record.recordId)],
        },
      };
    }
    if (!planned || !claimsThis) continue;
    matching.push(record);
  }
  if (matching.length === 0) {
    return {
      kind: 'outcome',
      outcome: {
        status: 'missing',
        reason: `'${obligationId}': required case '${compiled.definition.id}' produced no complete evidence — execute the case through its required channel (BEHAVIOR_CASE_MISSING)`,
        recordIds: [],
      },
    };
  }
  if (matching.length > 1) {
    return {
      kind: 'outcome',
      outcome: {
        status: 'invalid',
        reason:
          `'${obligationId}': required case '${compiled.definition.id}' has ${String(matching.length)} sealed ` +
          'records — one execution per required case per run; duplicates are ambiguity, not proof (BEHAVIOR_BINDING_MISMATCH)',
        recordIds: matching.map((record) => String(record.recordId)).sort(compareStrings),
      },
    };
  }
  const record = matching[0] as BehaviorRecordLike;
  const payload = BehaviorCasePayloadSchema.parse((record as { payload: unknown }).payload) as BehaviorCasePayload;
  return { kind: 'record', record, recordId: String(record.recordId), payload };
}

/** Validated bindings or an early invalid outcome. */
type BindingCheck =
  | { kind: 'bound' }
  | { kind: 'outcome'; outcome: RequiredCaseOutcome };

/**
 * Validates sealed bindings against the trusted catalog: payload
 * version, sealed state, spec digest, endpoint, channel, action digest,
 * authority profile, snapshot scope coverage, and namespace purity.
 * Shared by the request and surface grading paths.
 */
function validateCaseBindings(
  obligation: Obligation,
  compiled: CompiledBehaviorCase,
  caseId: string,
  recordId: string,
  payload: BehaviorCasePayload,
  context: BehaviorGradeContext,
): BindingCheck {
  const obligationId = obligation.id;
  const invalid = (reason: string): BindingCheck => ({
    kind: 'outcome',
    outcome: { status: 'invalid', reason, recordIds: [recordId] },
  });
  void caseId;
  if (payload.payloadVersion !== BEHAVIOR_CASE_PAYLOAD_VERSION) {
    return invalid(`'${obligationId}': case record '${recordId}' has an unsupported payload version`);
  }
  if (payload.state !== 'sealed') {
    return invalid(`'${obligationId}': case record '${recordId}' is not sealed`);
  }
  if (payload.caseSpecDigest !== compiled.specDigest) {
    return invalid(
      `'${obligationId}': case record '${recordId}' seals a different specification than the approved catalog (BEHAVIOR_BINDING_MISMATCH)`,
    );
  }
  if (payload.endpointResourceId !== compiled.endpointResourceId) {
    return invalid(
      `'${obligationId}': case record '${recordId}' names a different endpoint than the approved case (BEHAVIOR_BINDING_MISMATCH)`,
    );
  }
  if (payload.channel !== compiled.definition.channel) {
    return invalid(
      `'${obligationId}': case record '${recordId}' channel differs from the approved case (BEHAVIOR_BINDING_MISMATCH)`,
    );
  }
  if (payload.actionDigest !== behaviorActionDigestOf(compiled.definition.action)) {
    return invalid(
      `'${obligationId}': case record '${recordId}' action digest differs from the approved case (BEHAVIOR_BINDING_MISMATCH)`,
    );
  }
  if (
    context.authorityProfileDigest !== undefined &&
    context.authorityProfileDigest !== null &&
    payload.authorityProfileDigest !== context.authorityProfileDigest
  ) {
    return invalid(
      `'${obligationId}': case record '${recordId}' was sealed under a different authority profile (ENFORCEMENT_UNTRUSTED)`,
    );
  }
  const declaredScopes = new Set(compiled.effects.map((effect) => effect.scope));
  const beforeScopes = new Set(payload.before.map((snapshot) => snapshot.scope));
  const afterScopes = new Set(payload.after.map((snapshot) => snapshot.scope));
  const scopeSetsEqual =
    beforeScopes.size === declaredScopes.size &&
    afterScopes.size === declaredScopes.size &&
    [...declaredScopes].every((scope) => beforeScopes.has(scope) && afterScopes.has(scope));
  if (!scopeSetsEqual) {
    return invalid(
      `'${obligationId}': case record '${recordId}' snapshots do not cover the declared effect scopes (OBSERVATION_SCOPE_INCOMPLETE)`,
    );
  }
  for (const snapshot of [...payload.before, ...payload.after]) {
    if (snapshot.fixtureNamespace !== payload.fixtureNamespace) {
      return invalid(
        `'${obligationId}': case record '${recordId}' mixes fixture namespaces (BEHAVIOR_BINDING_MISMATCH)`,
      );
    }
    if (snapshot.complete !== true) {
      return invalid(
        `'${obligationId}': case record '${recordId}' seals an incomplete scope (OBSERVATION_SCOPE_INCOMPLETE)`,
      );
    }
  }
  return { kind: 'bound' };
}

/**
 * Grades one surface-driven required case (Phase 6): the engine drove
 * the approved surface descriptor with the approved inputs, observed
 * the rendered result itself, and sealed the visible observation. No
 * HTTP attempt attribution applies — proof is the engine-observed
 * entity/visible outcome plus the exact state effect. Status checks do
 * not apply to surface navigation (form POST redirects are navigation,
 * not API outcomes); visible + state carry the proof.
 */
function gradeSurfaceCase(
  obligation: Obligation,
  compiled: CompiledBehaviorCase,
  caseId: string,
  records: readonly BehaviorRecordLike[],
  context: BehaviorGradeContext,
): RequiredCaseOutcome {
  const obligationId = obligation.id;
  if (compiled.definition.channel !== 'engine-browser') {
    return {
      status: 'missing',
      reason:
        `'${obligationId}': surface case '${compiled.definition.id}' requires the ` +
        `'${compiled.definition.channel}' channel (Phase 8) — blocked until that driver produces genuine evidence`,
      recordIds: [],
    };
  }
  const matched = matchSingleCaseRecord(obligation, compiled, caseId, records, context);
  if (matched.kind === 'outcome') return matched.outcome;
  const { recordId, payload } = matched;
  const bound = validateCaseBindings(obligation, compiled, caseId, recordId, payload, context);
  if (bound.kind === 'outcome') return bound.outcome;
  if (payload.attempts.length > 0) {
    return {
      status: 'invalid',
      reason: `'${obligationId}': surface case record '${recordId}' carries HTTP attempts — surface proof is browser observation, not requests (BEHAVIOR_BINDING_MISMATCH)`,
      recordIds: [recordId],
    };
  }
  const browser = payload.browserObservation;
  if (browser === undefined) {
    return {
      status: 'missing',
      reason: `'${obligationId}': surface case '${compiled.definition.id}' has no sealed browser observation — the Phase 6 browser driver produces that evidence`,
      recordIds: [recordId],
    };
  }
  const beforeBuilt = indexSnapshots(payload.before, compiled);
  const afterBuilt = indexSnapshots(payload.after, compiled);
  if (!beforeBuilt.ok || !afterBuilt.ok) {
    return {
      status: 'invalid',
      reason: `'${obligationId}': ${(beforeBuilt.ok ? afterBuilt : beforeBuilt as { reason: string }).reason}`,
      recordIds: [recordId],
    };
  }
  const valueCtx: GradeValueContext = {
    fixtureValues: payload.fixtureValues,
    observation: null,
    before: (beforeBuilt as { index: ScopeIndex }).index,
  };
  const beforeIndex = (beforeBuilt as { index: ScopeIndex }).index;
  const afterIndex = (afterBuilt as { index: ScopeIndex }).index;
  // Visible expectation: the engine-observed entity must be the declared
  // subject, with the declared visible fields.
  const visible = compiled.definition.expect.visible;
  if (visible !== undefined) {
    const subject = resolveInputValue((visible as { subject?: unknown }).subject, payload.fixtureValues);
    if (!subject.ok) {
      return {
        status: 'invalid',
        reason: `'${obligationId}': visible subject does not resolve (BEHAVIOR_BINDING_MISMATCH)`,
        recordIds: [recordId],
      };
    }
    if (!valuesEqual(browser.entityId, subject.value)) {
      return {
        status: 'invalid',
        reason: `'${obligationId}': the engine-observed entity is not the declared case subject (BEHAVIOR_BINDING_MISMATCH)`,
        recordIds: [recordId],
      };
    }
    const fields = (visible as { fields?: unknown }).fields;
    if (typeof fields === 'object' && fields !== null && !Array.isArray(fields)) {
      for (const [name, expectedRaw] of Object.entries(fields as Record<string, unknown>)) {
        const expected = resolveExpectedValue(expectedRaw, valueCtx);
        if (
          !expected.ok ||
          !Object.prototype.hasOwnProperty.call(browser.visibleFields, name) ||
          !valuesEqual(browser.visibleFields[name], expected.value)
        ) {
          return {
            status: 'invalid',
            reason: `'${obligationId}': rendered field '${name}' differs from the declared visible outcome (BEHAVIOR_EFFECT_MISMATCH)`,
            recordIds: [recordId],
          };
        }
      }
    }
  }
  // State rules grade atomically, exactly like request-driven cases.
  const explained = new Map<string, ExplainedLedger>();
  const scopeKeyOf = (effectId: string): string | null =>
    compiled.effects.find((effect) => effect.id === effectId)?.scope ?? null;
  for (const rule of compiled.definition.expect.state) {
    const graded = gradeStateRule(
      obligationId,
      rule as unknown as Record<string, unknown>,
      beforeIndex,
      afterIndex,
      valueCtx,
      explained,
      scopeKeyOf,
    );
    if (!graded.ok) {
      if (graded.reason.includes('Phase 8')) {
        return { status: 'missing', reason: graded.reason, recordIds: [recordId] };
      }
      return { status: 'invalid', reason: `${graded.reason} (BEHAVIOR_EFFECT_MISMATCH)`, recordIds: [recordId] };
    }
  }
  const declaredScopes = new Set(compiled.effects.map((effect) => effect.scope));
  for (const scope of declaredScopes) {
    const beforeScope = beforeIndex.get(scope);
    const afterScope = afterIndex.get(scope);
    if (beforeScope === undefined || afterScope === undefined) continue;
    const ledger = explained.get(scope);
    if (ledger?.complete.has(scope) === true) continue;
    const delta = scopeDelta(beforeScope, afterScope);
    const unexplained = [
      ...delta.added.filter((key) => !ledger?.added.has(key)),
      ...delta.removed.filter((key) => !ledger?.removed.has(key)),
      ...delta.changed.filter((key) => !ledger?.changed.has(key)),
    ];
    if (unexplained.length > 0) {
      return {
        status: 'invalid',
        reason:
          `'${obligationId}': scope '${scope}' has ${String(unexplained.length)} unexplained change(s) ` +
          'beside the declared effect (BEHAVIOR_UNEXPECTED_EFFECT)',
        recordIds: [recordId],
      };
    }
  }
  return { status: 'satisfied', recordIds: [recordId] };
}

/**
 * Checks declared route/query/body identity selectors: the observed
 * concrete path must equal the template filled with resolved params,
 * and declared query/body values must equal the observed ones exactly
 * (the engine driver sends exactly the declared contract — extras are
 * undeclared behavior).
 */
function checkIdentitySelectors(
  compiled: CompiledBehaviorCase,
  payload: BehaviorCasePayload,
  principal: { attempt: BehaviorCasePayload['attempts'][number]; path: string },
  obligationId: string,
  recordId: string,
  before: ScopeIndex,
): string | null {
  const action = compiled.definition.action as unknown as {
    kind: string;
    method: string;
    pathTemplate: string;
    path: Record<string, unknown>;
    query: Record<string, unknown>;
    body: { encoding: string; fields?: Record<string, unknown>; files?: Record<string, unknown>; fixture?: string };
  };
  const observation = payload.requestObservations.find(
    (item) => item.engineRequestId === principal.attempt.engineRequestId,
  );
  if (observation === undefined) {
    return `'${obligationId}': case record '${recordId}' has no sealed observation for the principal request (OBSERVATION_SCOPE_INCOMPLETE)`;
  }
  // Concrete path: substitute resolved path params into the template.
  const templateSegments = action.pathTemplate.split('/');
  const resolvedSegments: string[] = [];
  const pathParamValues: unknown[] = [];
  for (const segment of templateSegments) {
    const match = /^\{([A-Za-z0-9_]+)\}$/.exec(segment);
    if (match === null) {
      resolvedSegments.push(segment);
      continue;
    }
    const resolved = resolveInputValue((action.path as Record<string, unknown>)[match[1] as string], payload.fixtureValues);
    if (!resolved.ok || (typeof resolved.value !== 'string' && typeof resolved.value !== 'number')) {
      return `'${obligationId}': case record '${recordId}' path parameter '${match[1] as string}' does not resolve (BEHAVIOR_BINDING_MISMATCH)`;
    }
    pathParamValues.push(resolved.value);
    resolvedSegments.push(String(resolved.value));
  }
  const expectedPath = resolvedSegments.join('/').replace(/\/+/g, '/');
  if (principal.path !== expectedPath) {
    return `'${obligationId}': observed path '${principal.path}' is not the declared '${expectedPath}' for this subject (BEHAVIOR_BINDING_MISMATCH)`;
  }
  // Known-existing targets (plan §4.5): every resolved path parameter
  // must identify an entity present in before-state — a denial against
  // a nonexistent record might merely mean a malformed fixture.
  for (const value of pathParamValues) {
    if (!beforeContains(before, value)) {
      return `'${obligationId}': path subject '${String(value)}' does not exist in before-state — the target must be a known existing record (fixture validation)`;
    }
  }
  // Declared query must equal observed query exactly.
  const expectedQuery: Record<string, unknown> = {};
  for (const [name, raw] of Object.entries(action.query)) {
    const resolved = resolveInputValue(raw, payload.fixtureValues);
    if (!resolved.ok) {
      return `'${obligationId}': case record '${recordId}' query parameter '${name}' does not resolve (BEHAVIOR_BINDING_MISMATCH)`;
    }
    expectedQuery[name] = resolved.value;
  }
  if (!valuesEqual(observation.query, expectedQuery)) {
    return `'${obligationId}': observed query differs from the declared query for this subject (BEHAVIOR_BINDING_MISMATCH)`;
  }
  // Declared body must equal observed body exactly (json/form only).
  if (action.body.encoding === 'raw') {
    // Raw bodies: exact submitted bytes are graded by comparing the
    // observed body string against the fixture bytes resolved from the
    // sealed fixture values (the engine signed those exact bytes).
    const fixtureName = (action.body as { fixture?: unknown }).fixture;
    if (typeof fixtureName !== 'string') {
      return `'${obligationId}': raw body has no fixture reference (BEHAVIOR_BINDING_MISMATCH)`;
    }
    const resolved = resolveFixtureKey(payload.fixtureValues, fixtureName);
    if (!resolved.ok || typeof resolved.value !== 'string') {
      return `'${obligationId}': raw body fixture '${fixtureName}' does not resolve to exact bytes (BEHAVIOR_BINDING_MISMATCH)`;
    }
    if (observation.body !== resolved.value) {
      return `'${obligationId}': submitted raw bytes differ from the declared fixture bytes (BEHAVIOR_BINDING_MISMATCH)`;
    }
    return null;
  }
  if (action.body.encoding !== 'json' && action.body.encoding !== 'form') {
    return `'${obligationId}': '${action.body.encoding}' bodies need the Phase 6/8 driver — blocked, never satisfied`;
  }
  const expectedBody: Record<string, unknown> = {};
  for (const [name, raw] of Object.entries(action.body.fields ?? {})) {
    const resolved = resolveInputValue(raw, payload.fixtureValues);
    if (!resolved.ok) {
      return `'${obligationId}': case record '${recordId}' body field '${name}' does not resolve (BEHAVIOR_BINDING_MISMATCH)`;
    }
    expectedBody[name] = resolved.value;
  }
  const observedBody = observation.body;
  const observedRecord =
    typeof observedBody === 'object' && observedBody !== null && !Array.isArray(observedBody)
      ? (observedBody as Record<string, unknown>)
      : null;
  if (observedRecord === null || !valuesEqual(observedRecord, expectedBody)) {
    return `'${obligationId}': observed body differs from the declared body for this subject (BEHAVIOR_BINDING_MISMATCH)`;
  }
  return null;
}
