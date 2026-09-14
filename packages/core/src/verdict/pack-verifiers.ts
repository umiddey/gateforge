/**
 * Built-in semantic verifiers for the pack contract namespaces (ADR 0004
 * D8, plan phase 5). Registered once at module init; the registry rejects
 * re-registration, so no pack can override another namespace.
 *
 * Trust model (invariant, ADR 0001): ONLY witnessed records satisfy.
 * Suite-submitted records are claimed-tier at issuance. Fabricated
 * provenance is rejected before verifiers run (the engine re-computes
 * record hashes).
 *
 * HTTP namespace (plan §8 / D1, honest transport semantics):
 * `http:frontend-request-observed` remains REGISTERED BUT UNAVAILABLE:
 * the supervised session channel (plan Phase 1) now attributes exchanges
 * to a test session's dedicated proxy port inside witness-kept action
 * intervals, but that attribution is by ORIGIN, not by browser — any
 * process holding the session credential can send traffic through the
 * port — so it still does not prove WHICH browser (or that any browser)
 * produced an exchange, and enabling the contract on it would silently
 * change its meaning (a Node-side direct request through the session
 * port would satisfy "frontend request observed"). It always grades
 * blocking `missing` before any evidence is examined, naming this gap.
 * `http:request-observed` requires a
 * witness-observed `http.request` exchange in the bound run PLUS a
 * provenanced claimed `ui.action` anchor from the declaring test; a
 * suite-submitted network record can never satisfy
 * (`HTTP_OBSERVATION_UNTRUSTED`). `http:response-status-ok` is the same
 * transport proof additionally requiring a 2xx status. A witness-observed
 * exchange proves only that the witness observed an HTTP exchange —
 * test attribution is suite-claimed, never independently verified.
 *
 * Domain namespaces (`auth:*`, `task:*`, `validation:*`, `webhook:*`,
 * `workflow:*`): FAIL-CLOSED, unconditionally, for EVERY contract of the
 * namespace. Proving these behaviors requires an engine-owned observer
 * over application state — audit logs, FSM/state observation,
 * identity/role material (plan §6) — and no such producer exists yet.
 * Grading them from a witnessed check record whose witness-derived
 * outcome is merely the observed HTTP status class (2xx → accepted, 4xx
 * → rejected) is forged green: any 2xx would "prove" `audit-emitted` or
 * `persisted-final-state`, any 4xx would "prove" `tenant-isolated` or
 * `denied-no-side-effect`, and a response hash proves nothing about
 * `error-message-explicit`. Every contract of these namespaces therefore
 * grades `missing` with a reason naming the missing channel — never
 * `satisfied`, never `invalid`, whatever evidence arrives.
 */
import { isProvenancedRecord } from '../provenance.js';
import { compareStrings } from '../graph/util.js';

/**
 * Stable typed code for untrusted runtime observations. Mirrors
 * `HTTP_OBSERVATION_UNTRUSTED` in `@gateforge/http-contract` (core
 * cannot depend on it); keep the two in lockstep.
 */
const HTTP_OBSERVATION_UNTRUSTED = 'HTTP_OBSERVATION_UNTRUSTED';
import {
  registerContractCapabilities,
  registerContractVerifier,
  type ClaimEvidenceInput,
  type ClaimOutcome,
  type ContractCapability,
  type ContractVerifier,
  type HttpRouteCandidate,
} from './registry.js';

/** Record kinds the witness and suites exchange. */
const UI_ACTION_KIND = 'ui.action';
const HTTP_REQUEST_KIND = 'http.request';

/**
 * The only HTTP contracts the verifier knows (plan §7): a namespace
 * registration never implies every operation in it. Any other `http:*`
 * name fails closed through {@link unknownContract} before anchor or
 * record checks run.
 */
const SUPPORTED_HTTP_CONTRACTS: readonly string[] = [
  'http:frontend-request-observed',
  'http:request-observed',
  'http:response-status-ok',
];

function payloadOf(record: ClaimEvidenceInput['evidence'][number]['record']): Record<string, unknown> | null {
  const payload = record.payload;
  return payload !== null && typeof payload === 'object' ? (payload as Record<string, unknown>) : null;
}

/**
 * The provenanced claimed `ui.action` anchor: a suite assertion that the
 * declaring test drove the UI (hash-verified issuance only — the hash
 * proves the witness issued the anchor record, not that a UI action
 * occurred). Satisfaction weight lives in the witnessed records; test
 * attribution throughout is suite-claimed.
 */

/**
 * Blocking reason for `http:frontend-request-observed` (plan §8 / D1):
 * returned BEFORE anchor or record examination. DECISION (Phase 1
 * review, 2026-09-13): the supervised session channel provides
 * browser-SESSION-bound exchange observation (dedicated proxy port,
 * witness-kept action intervals), but the attribution is by port
 * ORIGIN, not by browser — a hostile test retains its own process and
 * can drive its session port from Node inside an interval — so enabling
 * the contract on that channel would silently change its meaning. It
 * stays unavailable; the UI-semantic `crud:*` contracts carry the
 * session-channel proof instead, backed by the persistence echo that a
 * bare transport claim has no equivalent of.
 */
function frontendProofUnavailable(input: ClaimEvidenceInput): ClaimOutcome {
  return {
    status: 'missing',
    reason:
      `'${input.obligation.id}': contract 'http:frontend-request-observed' has no independent ` +
      'browser/test observation channel: the witness observes HTTP exchanges but cannot prove ' +
      'which browser, UI action, or test produced an exchange; test attribution is suite-claimed. ' +
      'The supervised session channel (plan Phase 1) attributes exchanges to a test session\'s ' +
      'dedicated proxy port inside witness-kept action intervals, but that attribution is by ' +
      'ORIGIN, not by browser — any process holding the session credential can send traffic ' +
      'through the port — so enabling this contract on it would silently change its meaning. ' +
      'Use the UI-semantic crud contracts for browser proof over the session channel, or the ' +
      "narrower transport contract 'http:request-observed' when a witness-observed " +
      'HTTP exchange suffices',
    recordIds: [],
  };
}
/**
 * Deduplicates string ids into a codepoint-sorted array (local: the
 * sibling helper in `evaluate.ts` is not importable here without
 * widening module coupling; kept in lockstep semantics).
 *
 * Args:
 *   ids: candidate record ids (empty entries dropped).
 *
 * Returns:
 *   string[]: sorted unique ids.
 */
function sortedUniqueIds(ids: readonly string[]): string[] {
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
 * Validates the required suite anchor once and selects it
 * deterministically: when several provenanced anchors qualify, the
 * codepoint-smallest record id wins so input order never matters.
 *
 * Args:
 *   input: the claim plus its attributed evidence and obligation.
 *
 * Returns:
 *   `{ok: true, anchorId}` with the selected anchor, or `{ok: false,
 *   outcome}` with the blocking missing result (wording unchanged).
 */
function selectTransportAnchor(
  input: ClaimEvidenceInput,
): { ok: true; anchorId: string } | { ok: false; outcome: ClaimOutcome } {
  const actions = input.evidence.filter((entry) => entry.record.kind === UI_ACTION_KIND);
  const provenanced = actions.filter((entry) => isProvenancedRecord(entry.record));
  if (provenanced.length === 0) {
    const detail =
      actions.length === 0
        ? `no '${UI_ACTION_KIND}' anchor from the declaring test`
        : `'${UI_ACTION_KIND}' records exist but none verifies its provenance`;
    return {
      ok: false,
      outcome: {
        status: 'missing',
        reason: `'${input.obligation.id}': ${detail}`,
      },
    };
  }
  const ids = provenanced.map((entry) => String(entry.record.recordId));
  const selected = sortedUniqueIds(ids)[0] as string;
  return { ok: true, anchorId: selected };
}

/**
 * Concrete methods a route candidate or observation may carry. `ANY`
 * (exposure-only evidence) is deliberately absent: an unknown/dynamic
 * method can never establish uniqueness (plan §9 step 9).
 */
const CONCRETE_HTTP_METHODS: ReadonlySet<string> = new Set([
  'GET',
  'HEAD',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'OPTIONS',
]);

/**
 * Single deterministic path interpretation for runtime observations
 * (plan §9 steps 1-3). Conservative and lockstep with the witness
 * proxy storage (`normalizeObservedPath` in
 * `@gateforge/pack-playwright`'s witness/server.ts — same rules, no
 * collapsing, no decoding on either side):
 * - query (`?...`) and fragment (`#...`) are stripped;
 * - one leading slash is required (a missing one is added);
 * - trailing slashes are dropped (root `/` stays `/`) — routers treat
 *   these as the same resource;
 * - case and segment boundaries are PRESERVED: duplicate slashes are
 *   NOT collapsed (collapsing would let `//` masquerade across segment
 *   boundaries), and percent-encodings are NEVER decoded (`%2F` stays a
 *   literal part of its segment, never a separator).
 *
 * Noncanonical input whose routing meaning is uncertain (duplicate
 * slashes, an encoded slash, a non-path-absolute value) does NOT match
 * a different endpoint — it fails with a reason so the verifier blocks
 * instead of substituting a route.
 *
 * Local on purpose: core must not depend on `@gateforge/http-contract`.
 *
 * Args:
 *   rawUrl: the observed URL carried by the witnessed record.
 *
 * Returns:
 *   `{ok: true, path}` with the interpreted path, or `{ok: false,
 *   reason}` naming the noncanonical input.
 */
export function interpretObservedPath(
  rawUrl: unknown,
): { ok: true; path: string } | { ok: false; reason: string } {
  if (typeof rawUrl !== 'string' || rawUrl.length === 0) {
    return { ok: false, reason: 'observed url is empty or not a string' };
  }
  let path = rawUrl.split('?')[0]?.split('#')[0] ?? '/';
  if (!path.startsWith('/')) path = `/${path}`;
  if (path.includes('//')) {
    return {
      ok: false,
      reason: `observed path '${rawUrl}' contains a duplicate slash whose routing meaning is uncertain; it cannot attribute any endpoint`,
    };
  }
  if (/%2f/i.test(path)) {
    return {
      ok: false,
      reason: `observed path '${rawUrl}' contains an encoded slash that is never decoded into a separator; it cannot attribute any endpoint`,
    };
  }
  if (path.length > 1) path = path.replace(/\/+$/, '');
  if (path.length === 0) path = '/';
  return { ok: true, path };
}

/**
 * Whether a candidate's canonical path is a supported route shape for
 * runtime attribution (plan §9 steps 4/9): path-absolute, no duplicate
 * slashes, no `..` escape segments, and at most one `{*}` wildcard in
 * trailing position. Anything else (notably a non-trailing wildcard,
 * which the positional matcher can never match) makes the inventory
 * incomplete — uniqueness cannot be established against it.
 *
 * Args:
 *   canonicalPath: the candidate's compiled canonical path.
 *
 * Returns:
 *   boolean: true only for attributable shapes.
 */
function isSupportedRouteShape(canonicalPath: unknown): boolean {
  if (typeof canonicalPath !== 'string' || !canonicalPath.startsWith('/')) return false;
  if (canonicalPath.includes('//')) return false;
  const segments = canonicalPath.split('/').filter((segment) => segment.length > 0);
  let wildcards = 0;
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index] ?? '';
    if (segment === '{*}') {
      wildcards += 1;
      if (index !== segments.length - 1) return false;
    } else if (segment === '..') {
      return false;
    }
  }
  return wildcards <= 1;
}

/**
 * Whether a candidate carries a concrete attributable method (plan §9
 * step 9): uppercase and in the concrete set. `ANY`, lowercase, empty,
 * and unknown methods make the inventory incomplete.
 */
function isConcreteRouteMethod(method: unknown): boolean {
  return typeof method === 'string' && method.length > 0 && CONCRETE_HTTP_METHODS.has(method);
}

/** Canonical identity text for one candidate (`METHOD path (resourceId)`). */
function candidateIdentityText(candidate: HttpRouteCandidate): string {
  return `${candidate.method} ${candidate.canonicalPath} (${candidate.resourceId})`;
}

/**
 * Deterministic runtime route attribution over the COMPLETE candidate
 * set (plan §9 steps 4-9, D2). No literal-precedence shortcut: when
 * both `/accounts/export` and `/accounts/{}` match the observation,
 * the transport status is known but handler attribution is ambiguous
 * and the claim blocks.
 *
 * Args:
 *   observedMethod: the witnessed record's method (any case).
 *   observedPath: the interpreted observed path (from
 *     `interpretObservedPath`).
 *   candidates: the complete host-derived route inventory.
 *   obligationResourceId: the obligation's own resource id.
 *
 * Returns:
 *   - `{status: 'incomplete', reason}` when any candidate carries an
 *     unknown/dynamic method or an unsupported shape (uniqueness
 *     cannot be established);
 *   - `{status: 'nomatch', reason}` when zero candidates match;
 *   - `{status: 'ambiguous', candidates}` with the sorted identity
 *     texts when more than one distinct resource matches;
 *   - `{status: 'mismatch', matched}` when exactly one candidate
 *     matches but it is a different endpoint;
 *   - `{status: 'match', matched}` when the unique match is the
 *     obligation's own endpoint.
 */
export function resolveHttpRoute(
  observedMethod: string,
  observedPath: string,
  candidates: readonly HttpRouteCandidate[],
  obligationResourceId: string,
):
  | { status: 'match'; matched: HttpRouteCandidate }
  | { status: 'mismatch'; matched: HttpRouteCandidate }
  | { status: 'nomatch'; reason: string }
  | { status: 'ambiguous'; candidates: string[] }
  | { status: 'incomplete'; reason: string } {
  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index] as HttpRouteCandidate | undefined;
    if (
      candidate === undefined ||
      typeof candidate.resourceId !== 'string' ||
      candidate.resourceId.length === 0 ||
      !isConcreteRouteMethod(candidate.method) ||
      !isSupportedRouteShape(candidate.canonicalPath)
    ) {
      return {
        status: 'incomplete',
        reason:
          `route inventory entry ${index} is not attributable ` +
          `(unknown/dynamic method or unsupported shape); uniqueness cannot be established ` +
          `against an incomplete inventory, so '${obligationResourceId}' stays blocking`,
      };
    }
  }
  const upperMethod = observedMethod.toUpperCase();
  const matched = candidates.filter(
    (candidate) => candidate.method === upperMethod && pathMatchesShape(observedPath, candidate.canonicalPath),
  );
  // Deduplicate repeated facts for the same resource identity only —
  // never merge different resource IDs or planes.
  const seen: Record<string, true> = {};
  const distinct: HttpRouteCandidate[] = [];
  for (const candidate of matched) {
    if (candidate.resourceId in seen) continue;
    seen[candidate.resourceId] = true;
    distinct.push(candidate);
  }
  if (distinct.length === 0) {
    return {
      status: 'nomatch',
      reason:
        `observed ${upperMethod} ${observedPath} matches none of the ` +
        `${candidates.length} inventoried routes; evidence from a different endpoint can never ` +
        `satisfy '${obligationResourceId}'`,
    };
  }
  if (distinct.length > 1) {
    return {
      status: 'ambiguous',
      candidates: distinct.map(candidateIdentityText).sort(compareStrings),
    };
  }
  const only = distinct[0] as HttpRouteCandidate;
  if (only.resourceId !== obligationResourceId) {
    return { status: 'mismatch', matched: only };
  }
  return { status: 'match', matched: only };
}

/**
 * Positional match of a concrete observed path against a compiled
 * canonical shape (ADR 0004 D2/D3 semantics): literal segments must be
 * equal, `{}` matches any single non-empty segment, and a TRAILING `{*}`
 * matches one or more trailing segments. Non-trailing wildcards and any
 * other shape never match. Case-sensitive.
 *
 * Args:
 *   observedPath: the concrete observed path (query already stripped).
 *   canonicalPath: the endpoint's compiled canonical shape.
 *
 * Returns:
 *   boolean: true only when the observed path instantiates the shape.
 */
export function pathMatchesShape(observedPath: string, canonicalPath: string): boolean {
  const observed = observedPath.split('/').filter((segment) => segment.length > 0);
  const shape = canonicalPath.split('/').filter((segment) => segment.length > 0);
  const wildcardIndex = shape.indexOf('{*}');
  // Fail closed: only a TRAILING `{*}` is a wildcard — a shape that
  // carries one anywhere else (or more than once) never matches.
  if (wildcardIndex !== -1 && wildcardIndex !== shape.length - 1) return false;
  if (wildcardIndex !== -1) {
    // The wildcard consumes one or more trailing segments, so the
    // observed path needs at least the shape's leading literals.
    if (observed.length < shape.length) return false;
  } else if (observed.length !== shape.length) {
    return false;
  }
  const literalPositions = wildcardIndex === -1 ? shape.length : wildcardIndex;
  for (let i = 0; i < literalPositions; i++) {
    const pattern = shape[i];
    // `{}` matches any single (non-empty — empties were dropped)
    // segment; anything else must be literally equal. Case-sensitive.
    if (pattern !== '{}' && pattern !== observed[i]) return false;
  }
  return true;
}

/**
 * Grades the explicit transport contracts (`http:request-observed`,
 * `http:response-status-ok`): one shared path, no divergent verifier.
 * Proves only that the witness observed an HTTP exchange in the bound
 * run; test attribution is suite-claimed.
 *
 * Args:
 *   input: the claim plus its attributed evidence and obligation.
 *
 * Returns:
 *   ClaimOutcome: satisfied only for a witnessed engine-observed
 *   exchange matching the endpoint shape (plus 2xx for status-ok).
 */
/**
 * Scans the route inventory once for a blocking incomplete reason
 * (plan §10 step 2): a null context or any unattributable entry makes
 * every eligible record `missing`, never satisfied. Computed once so
 * per-record grading stays a pure function of the record.
 *
 * Args:
 *   input: the claim plus its attributed evidence and obligation.
 *
 * Returns:
 *   string | null: the blocking reason, or null when the inventory is
 *   usable for attribution.
 */
function transportInventoryBlock(input: ClaimEvidenceInput): string | null {
  const candidates = input.httpRoutes;
  if (candidates === null || candidates === undefined) {
    return (
      `'${input.obligation.id}': no route inventory context for ` +
      `'${input.obligation.contract}'; HTTP satisfaction requires the complete host-derived ` +
      'route inventory (every applicable http.endpoint resource, including routes with no ' +
      'consumer and no obligation) — without it no endpoint-specific pass is authoritative, ' +
      `so '${input.obligation.id}' stays blocking`
    );
  }
  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index] as HttpRouteCandidate | undefined;
    if (
      candidate === undefined ||
      typeof candidate.resourceId !== 'string' ||
      candidate.resourceId.length === 0 ||
      !isConcreteRouteMethod(candidate.method) ||
      !isSupportedRouteShape(candidate.canonicalPath)
    ) {
      return (
        `'${input.obligation.id}': route inventory entry ${index} is not attributable ` +
        `(unknown/dynamic method or unsupported shape); uniqueness cannot be established ` +
        `against an incomplete inventory, so '${input.obligation.resourceId}' stays blocking`
      );
    }
  }
  return null;
}

/** Per-record transport grade: satisfied carries the record id, blocks carry a reason. */
type TransportRecordGrade =
  | { status: 'satisfied'; recordId: string }
  | { status: 'invalid'; reason: string }
  | { status: 'missing'; reason: string };

/**
 * Grades ONE `http.request` record independently for origin, trust,
 * provenance, payload, route identity, and required status (plan §10
 * step 3). Never returns from the outer verifier; the caller
 * aggregates every grade. All reason wordings are verbatim from the
 * single-record grader.
 *
 * Args:
 *   record: the lenient record view to grade.
 *   trust: the engine-derived trust tier for the record.
 *   input: the claim plus its obligation (for ids/contract/status rule).
 *   inventoryBlock: the precomputed inventory reason, or null when usable.
 *   candidates: the usable route inventory (ignored when inventoryBlock
 *     is set).
 *
 * Returns:
 *   TransportRecordGrade: the independent grade for this record.
 */
function gradeTransportRecord(
  record: ClaimEvidenceInput['evidence'][number]['record'],
  trust: ClaimEvidenceInput['evidence'][number]['trust'],
  input: ClaimEvidenceInput,
  inventoryBlock: string | null,
  candidates: readonly HttpRouteCandidate[],
): TransportRecordGrade {
  const label = String(record.recordId);
  if (record.origin !== 'engine-observed') {
    return {
      status: 'invalid',
      reason:
        `'${input.obligation.id}': suite-submitted network record ` +
        `'${label}' cannot satisfy an HTTP runtime contract ` +
        `(${HTTP_OBSERVATION_UNTRUSTED}); only a witness-observed HTTP exchange proves ` +
        'transport, and test attribution is suite-claimed',
    };
  }
  if (trust !== 'witnessed' || !isProvenancedRecord(record)) {
    return {
      status: 'missing',
      reason:
        `'${input.obligation.id}': observed requests exist but none carries witnessed ` +
        'provenance bound to this run',
    };
  }
  const payload = payloadOf(record);
  if (payload === null || typeof payload['method'] !== 'string' || typeof payload['url'] !== 'string') {
    return {
      status: 'invalid',
      reason:
        `'${input.obligation.id}': witnessed '${HTTP_REQUEST_KIND}' record ` +
        `'${label}' carries no method/url pair`,
    };
  }
  if (inventoryBlock !== null) {
    return { status: 'missing', reason: inventoryBlock };
  }
  const observedMethod = payload['method'];
  const interpreted = interpretObservedPath(payload['url']);
  if (interpreted.ok === false) {
    return {
      status: 'invalid',
      reason:
        `'${input.obligation.id}': witnessed '${HTTP_REQUEST_KIND}' record ` +
        `'${label}' carries a noncanonical observed path: ` +
        `${interpreted.reason}`,
    };
  }
  // Identity match (plan §9, D2 — fail closed, no any-endpoint
  // fallback): the witnessed observation must attribute to EXACTLY the
  // obligation's endpoint within the host-derived COMPLETE route
  // inventory. Missing/incomplete context blocks satisfaction: without
  // every applicable `http.endpoint` resource a literal-vs-parameter
  // overlap (or an unconsumed sibling) could silently steal credit.
  const resolution = resolveHttpRoute(
    observedMethod,
    interpreted.path,
    candidates,
    input.obligation.resourceId,
  );
  if (resolution.status === 'incomplete') {
    return {
      status: 'missing',
      reason: `'${input.obligation.id}': ${resolution.reason}`,
    };
  }
  if (resolution.status === 'nomatch') {
    return {
      status: 'invalid',
      reason:
        `'${input.obligation.id}': witnessed '${HTTP_REQUEST_KIND}' record ` +
        `'${label}' ${resolution.reason}`,
    };
  }
  if (resolution.status === 'ambiguous') {
    return {
      status: 'invalid',
      reason:
        `'${input.obligation.id}': ambiguous route attribution: observed ` +
        `${observedMethod.toUpperCase()} ${interpreted.path} matches ${resolution.candidates.length} ` +
        `distinct routes [${resolution.candidates.join('; ')}]; the transport status is known ` +
        'but handler attribution is not, so no endpoint-specific claim passes until ' +
        'engine-owned handler proof resolves the overlap',
    };
  }
  if (resolution.status === 'mismatch') {
    return {
      status: 'invalid',
      reason:
        `'${input.obligation.id}': witnessed '${HTTP_REQUEST_KIND}' record ` +
        `'${label}' observed ${observedMethod.toUpperCase()} ` +
        `${interpreted.path} uniquely matches route ${candidateIdentityText(resolution.matched)} ` +
        `but the obligation requires endpoint '${input.obligation.resourceId}'; evidence from ` +
        'a different endpoint can never satisfy it',
    };
  }
  if (input.obligation.contract === 'http:response-status-ok') {
    const status = payload['status'];
    if (typeof status !== 'number' || !Number.isInteger(status) || status < 200 || status > 299) {
      return {
        status: 'invalid',
        reason:
          `'${input.obligation.id}': observed status ` +
          `'${String(status)}' is not a 2xx response`,
      };
    }
  }
  return { status: 'satisfied', recordId: label };
}

/**
 * Grades the explicit transport contracts (`http:request-observed`,
 * `http:response-status-ok`): one shared path, no divergent verifier.
 * Proves only that the witness observed an HTTP exchange in the bound
 * run; test attribution is suite-claimed.
 *
 * Deterministic aggregation (plan §10 steps 1-8): the exact contract
 * and the suite anchor are validated once (codepoint-smallest anchor
 * when several qualify); the route inventory is scanned once; then
 * EVERY `http.request` record is graded independently with NO early
 * return on the first bad record. `satisfied > invalid > missing`
 * decides; ≥1 satisfying record selects the codepoint-smallest
 * record id joined with the anchor — identical for every input
 * permutation. Otherwise the codepoint-smallest invalid reason wins,
 * else the smallest missing reason. Untrusted records never satisfy;
 * status-ok still means ≥1 eligible 2xx (no new success rule).
 *
 * Args:
 *   input: the claim plus its attributed evidence and obligation.
 *
 * Returns:
 *   ClaimOutcome: satisfied only for a witnessed engine-observed
 *   exchange matching the endpoint shape (plus 2xx for status-ok).
 */
function gradeTransportObservation(input: ClaimEvidenceInput): ClaimOutcome {
  const anchor = selectTransportAnchor(input);
  if (anchor.ok === false) return anchor.outcome;

  const requests = input.evidence.filter((entry) => entry.record.kind === HTTP_REQUEST_KIND);
  if (requests.length === 0) {
    return {
      status: 'missing',
      reason:
        `'${input.obligation.id}': no '${HTTP_REQUEST_KIND}' record; the witness observed no ` +
        'matching HTTP exchange in the bound run; test attribution is suite-claimed',
      recordIds: [],
    };
  }
  const inventoryBlock = transportInventoryBlock(input);
  const candidates = (input.httpRoutes ?? []) as readonly HttpRouteCandidate[];
  const satisfied: string[] = [];
  const invalidReasons: string[] = [];
  const missingReasons: string[] = [];
  for (const entry of requests) {
    const grade = gradeTransportRecord(entry.record, entry.trust, input, inventoryBlock, candidates);
    if (grade.status === 'satisfied') satisfied.push(grade.recordId);
    else if (grade.status === 'invalid') invalidReasons.push(grade.reason);
    else missingReasons.push(grade.reason);
  }
  if (satisfied.length > 0) {
    const selected = sortedUniqueIds(satisfied)[0] as string;
    return {
      status: 'satisfied',
      recordIds: sortedUniqueIds([anchor.anchorId, selected]),
    };
  }
  if (invalidReasons.length > 0) {
    const reason = invalidReasons.sort(compareStrings)[0] as string;
    return { status: 'invalid', reason };
  }
  const reason = missingReasons.sort(compareStrings)[0] as string;
  return { status: 'missing', reason };
}

/** Grades the HTTP namespace: exact dispatch, frontend fail-closed, shared transport path. */
function httpVerifier(input: ClaimEvidenceInput): ClaimOutcome {
  // Exact contract dispatch first (plan §7): an unknown `http:*` name is
  // never waived, never persistence-graded, and never examined for
  // anchors or records — it stays blocking `missing` naming the contract.
  if (!SUPPORTED_HTTP_CONTRACTS.includes(input.obligation.contract)) {
    return unknownContract(input);
  }
  // Decision (pinned by tests, 2026-09-13 Phase 1 review): the frontend
  // contract stays unavailable — the session channel binds exchanges to a
  // session's proxy ORIGIN, not to a browser — so return blocking
  // `missing` BEFORE anchor or record examination. No evidence can
  // satisfy it; see {@link frontendProofUnavailable}.
  if (input.obligation.contract === 'http:frontend-request-observed') {
    return frontendProofUnavailable(input);
  }
  return gradeTransportObservation(input);
}

/**
 * The honest evidence channel each domain namespace would need. Wording
 * is per-namespace on purpose: the fail-closed reason must name WHAT is
 * missing, not a generic unsupported hole.
 */
const DOMAIN_NAMESPACES: readonly { namespace: string; channel: string }[] = [
  {
    namespace: 'auth',
    channel: 'identity/role material and tenant-scoped application state',
  },
  {
    namespace: 'task',
    channel: 'queue/job delivery state',
  },
  {
    namespace: 'validation',
    channel: 'boundary semantics over application state and the response envelope',
  },
  {
    namespace: 'webhook',
    channel: 'signature/replay verification over application-received deliveries',
  },
  {
    namespace: 'workflow',
    channel: 'the workflow state machine and its audit log',
  },
];

/**
 * Builds the honest fail-closed reason for one domain contract: it names
 * the contract, the behavior to prove, the missing engine-owned channel,
 * and why transport evidence can never substitute for it.
 */
function failClosedReason(namespace: string, channel: string, input: ClaimEvidenceInput): string {
  const verb = input.obligation.contract.slice(namespace.length + 1);
  const behavior = verb.length > 0 ? verb : input.obligation.contract;
  return (
    `contract '${input.obligation.contract}' has no honest evidence channel: proving '${behavior}' ` +
    `requires an engine-owned observer over application state (${channel} per plan §6), and no such ` +
    'producer exists yet; transport exchanges (status codes, response bytes) cannot prove these ' +
    `semantics, so '${input.obligation.id}' stays blocking. Do not add this contract to policies ` +
    'until its pack ships a state-observing producer.'
  );
}

/**
 * The domain namespaces' verifier: fail-closed for EVERY contract of the
 * namespace, whatever evidence arrives — old-shape check records,
 * claimed or witnessed, perfectly formed. It never returns `satisfied`
 * and never `invalid`: no existing record can honestly evidence these
 * semantics, and hostile evidence deserves no sharper verdict than the
 * honest-channel reason.
 */
function failClosedVerifier(namespace: string, channel: string): ContractVerifier {
  return (input: ClaimEvidenceInput): ClaimOutcome => {
    // A contract string that does not parse into this namespace is
    // genuinely unknown, not merely unproducible.
    if (!input.obligation.contract.startsWith(`${namespace}:`)) {
      return unknownContract(input);
    }
    return {
      status: 'missing',
      reason: failClosedReason(namespace, channel, input),
      recordIds: [],
    };
  };
}

/** A contract the namespace's spec does not know: fail closed. */
function unknownContract(input: ClaimEvidenceInput): ClaimOutcome {
  return {
    status: 'missing',
    reason:
      `no semantic verifier is registered for contract '${input.obligation.contract}'; ` +
      `'${input.obligation.id}' stays blocking`,
    recordIds: [],
  };
}

/** True once registrations have run (idempotent across imports). */
let registered = false;

/**
 * The http namespace's capability record (plan Phase 0 item 3): the two
 * transport contracts are implemented over the witness HTTP proxy
 * channel; `http:frontend-request-observed` stays registered but
 * unavailable — the supervised session channel (plan Phase 1) binds
 * exchanges to a session's proxy ORIGIN, not to a browser, so the
 * independent browser/test observation the contract names still does not
 * exist and enabling it would silently change its meaning.
 */
const HTTP_CAPABILITY: ContractCapability = {
  namespace: 'http',
  contracts: ['http:request-observed', 'http:response-status-ok'],
  unavailableContracts: [
    {
      contract: 'http:frontend-request-observed',
      reason:
        'no independent browser/test observation channel exists: the witness observes HTTP ' +
        'exchanges but cannot prove which browser, UI action, or test produced an exchange ' +
        '(test attribution is suite-claimed). The supervised session channel (plan Phase 1) ' +
        'attributes exchanges to a test session\'s dedicated proxy port inside witness-kept ' +
        'action intervals, but that attribution is by ORIGIN, not by browser — a hostile test ' +
        'retains its own process and can drive the port directly — so the contract stays ' +
        'fail-closed rather than silently change meaning',
    },
  ],
  observer:
    'witness HTTP proxy channel: a witness-observed http.request exchange bound to the run ' +
    '(origin engine-observed) plus a provenanced claimed ui.action anchor from the declaring test',
  testKinds: ['browser-e2e', 'api-e2e'],
  availability: { status: 'available' },
};

/** Builds the fail-closed capability record for one domain namespace. */
function domainCapability(namespace: string, channel: string): ContractCapability {
  return {
    namespace,
    // none — fail-closed: every contract of the namespace blocks.
    contracts: [],
    unavailableContracts: [],
    observer: `engine-owned observer over application state (${channel})`,
    testKinds: [],
    availability: {
      status: 'unavailable',
      reason:
        `no engine-owned state-observing producer exists for ${channel}; every contract of ` +
        "the namespace fails closed (transport exchanges cannot prove these semantics), so " +
        "the namespace advertises none — fail-closed",
    },
  };
}

/** Registers every pack namespace + the http namespace. Idempotent. */
export function registerPackVerifiers(): void {
  if (registered) return;
  registered = true;
  registerContractVerifier('http', httpVerifier);
  registerContractCapabilities(HTTP_CAPABILITY);
  for (const { namespace, channel } of DOMAIN_NAMESPACES) {
    registerContractVerifier(namespace, failClosedVerifier(namespace, channel));
    registerContractCapabilities(domainCapability(namespace, channel));
  }
}
