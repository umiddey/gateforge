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
 * Both transport contracts accept a SECOND channel (plan 0.9.2 item D):
 * the OBSERVE channel. ONLY when the engine-browser anchor path comes
 * back `missing` is a witnessed `http.observed` record stamped
 * `channel: 'observe'` consulted — carrying the exchanges the witness
 * proxied for THIS session, minted only for claims the supervisor
 * registered `observed-e2e`. It grades through the SAME
 * {@link gradeObservedExchange} matcher, so a normal suite-driven test
 * mapped `observed-e2e` can discharge the obligation without any second
 * endpoint resolver. An anchor-path `invalid` is final (I6): an
 * engine-found error is never masked by a second channel's match.
 * Admission is trust- AND channel-gated exactly as for persistence
 * (I3), and `http:frontend-request-observed` still grades blocking
 * before any of this runs (I1).
 *
 * Domain namespaces (`auth:*`, `task:*`, `validation:*`, `webhook:*`,
 * `workflow:*`): their approved contract vocabularies are available only
 * through the required-case aggregation. A genuine engine-issued,
 * witnessed `behavior.case` record can satisfy a compiled case; the
 * per-claim fallback remains fail-closed when the obligation has no
 * compiled requirement set. Transport-shaped records never substitute.
 * Proving these behaviors requires an engine-owned observer over application
 * state — audit logs, FSM/state observation, identity/role material
 * (plan §6) — and legacy status-only records cannot carry that meaning.
 */
import { isProvenancedRecord } from '../provenance.js';
import { compareStrings } from '../graph/util.js';
import type { QueueObserverConfig } from '../schemas/queue-observer.js';

/**
 * Stable typed code for untrusted runtime observations. Mirrors
 * `HTTP_OBSERVATION_UNTRUSTED` in `@gate-forge/http-contract` (core
 * cannot depend on it); keep the two in lockstep.
 */
const HTTP_OBSERVATION_UNTRUSTED = 'HTTP_OBSERVATION_UNTRUSTED';
import {
  registerContractCapabilities,
  setContractAvailability,
  registerContractVerifier,
  type ClaimEvidenceInput,
  type ClaimOutcome,
  type ContractAvailability,
  type ContractCapability,
  type ContractVerifier,
  type HttpRouteCandidate,
} from './registry.js';

/** Record kinds the witness and suites exchange. */
const UI_ACTION_KIND = 'ui.action';
const HTTP_REQUEST_KIND = 'http.request';

/**
 * Observe-channel transport kind: issued ONLY by the witness's
 * observe finalize (the declaring session's own proxied exchanges).
 * Mirrors `HTTP_OBSERVED_KIND` in `@gate-forge/pack-playwright`'s
 * constants.ts — keep the two in lockstep, exactly as
 * `OBSERVED_RECORD_KIND` mirrors the witness's `OBSERVED_KIND`.
 */
const HTTP_OBSERVED_KIND = 'http.observed';

/**
 * Payload discriminant the witness stamps on every observe-finalized
 * record. Mirrors `OBSERVE_CHANNEL` in `@gate-forge/pack-playwright`
 * (and `evaluate.ts`'s local constant) — keep the three in lockstep.
 */
const OBSERVE_CHANNEL = 'observe';

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
  'http:effect-verified',
  'http:read-result-verified',
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
 * Blocking reason for strong HTTP contracts when no trusted behavior
 * context reaches the per-claim path (plan 2026-09-19 Phase 5). The
 * genuine producer exists (witness principal driver + required-case
 * aggregation in `evaluateObligation`); this fallback fires only when
 * an obligation names a strong contract outside a compiled requirement
 * set — transport evidence must not silently satisfy effect/read-result
 * verification.
 *
 * Args:
 *   input (ClaimEvidenceInput): claim plus obligation.
 *
 * Returns:
 *   ClaimOutcome: missing, naming the absent case set.
 */
function strongHttpProofUnavailable(input: ClaimEvidenceInput): ClaimOutcome {
  return {
    status: 'missing',
    reason:
      `'${input.obligation.id}': contract '${input.obligation.contract}' has no trusted ` +
      'behavior.case observer: strong HTTP contracts require engine-issued case records with ' +
      'independent state-scope snapshots; existing transport evidence cannot satisfy them',
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
 * `@gate-forge/pack-playwright`'s witness/server.ts — same rules, no
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
 * Local on purpose: core must not depend on `@gate-forge/http-contract`.
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
 * One candidate's validated registration range. `orderMax` defaults to
 * `order` for a single-order (unmerged) route.
 */
interface ValidatedRegistration {
  scope: string;
  order: number;
  orderMax: number;
}

/**
 * The validated `registration` of one candidate, or null when the field
 * is absent or malformed (host-derived inventory — never trusted). A
 * merged (slash-variant) endpoint carries a RANGE
 * `{scope, order, orderMax}`; a single-order endpoint carries
 * `{scope, order}` and validates to `orderMax === order`.
 */
function routeRegistration(candidate: HttpRouteCandidate): ValidatedRegistration | null {
  const registration = candidate.registration;
  if (
    registration === undefined ||
    typeof registration.scope !== 'string' ||
    registration.scope.length === 0 ||
    typeof registration.order !== 'number' ||
    !Number.isInteger(registration.order) ||
    registration.order < 0
  ) {
    return null;
  }
  const orderMax = registration.orderMax ?? registration.order;
  if (typeof orderMax !== 'number' || !Number.isInteger(orderMax) || orderMax < registration.order) {
    return null;
  }
  return { scope: registration.scope, order: registration.order, orderMax };
}

/**
 * The registration-order winner over multiple matched candidates, or
 * null when precedence cannot be proven (0.14; 0.13.9 covers merged
 * slash-variant endpoints).
 *
 * Starlette (and therefore FastAPI) matches routes in REGISTRATION
 * order: each router's routes copy at its `include_router` call,
 * depth-first in call order, decorator source order within one router;
 * the first FULL match (path AND method) serves. When the detector
 * proved that order for the whole matched set, the smallest order IS
 * the serving route — the claim resolves against it instead of
 * blocking forever.
 *
 * A merged endpoint (one handler under two decorators — e.g.
 * `include_in_schema=False` literal over the trailing-slash variant)
 * carries the RANGE of its raw routes' proven orders as
 * `{scope, order, orderMax}`: which raw variant serves depends on the
 * request URL's trailing slash, which the normalized observed path no
 * longer carries. The winner is therefore certain only when the
 * earliest-ordered candidate's LATEST order is lower than every other
 * candidate's EARLIEST order — then every possible serving variant of
 * that candidate beats every possible variant of the rest. Two
 * candidates can never both qualify (each would have to lie wholly
 * before the other), and a tie or an interleaved order (a competitor
 * order inside the literal's range) keeps the whole overlap
 * ambiguous — fail closed. Precedence applies ONLY when
 *
 * - every matched candidate carries a well-formed `registration` (a
 *   single missing or malformed proof keeps the whole overlap
 *   ambiguous),
 * - all proven scopes are the SAME app (two apps' flattened orders do
 *   not compare),
 * - and the earliest-ordered candidate carries NO `typedPathParams`:
 *   a typed convertor (`{id:int}`, `{p:path}`) matches narrower than
 *   the canonical slot shape, so the convertor might reject the
 *   observed segment and let a later route serve — the "candidate
 *   ordered before the winner" of the framework's own match loop is
 *   exactly that smallest-order route, and precedence past it is not
 *   certain.
 *
 * A plain `{name}` parameter is the `str` convertor and matches any
 * single segment (the canonical shape's whole meaning), so a plain
 * winner is certain. A function annotation (`event_id: UUID`) never
 * affects routing — it validates after the match (422) — so it is
 * correctly absent from this decision.
 */
function registrationOrderWinner(
  distinct: readonly HttpRouteCandidate[],
): HttpRouteCandidate | null {
  const scopes = new Set<string>();
  const entries: Array<{ candidate: HttpRouteCandidate; registration: ValidatedRegistration }> = [];
  for (const candidate of distinct) {
    const registration = routeRegistration(candidate);
    if (registration === null) return null;
    scopes.add(registration.scope);
    entries.push({ candidate, registration });
  }
  if (scopes.size !== 1) return null;
  // Only the earliest-ordered candidate can possibly qualify: any
  // other candidate would need a wholly-later range to still beat the
  // earliest one. Sort by earliest order and check exactly that.
  const ordered = [...entries].sort((a, b) => a.registration.order - b.registration.order);
  const earliest = ordered[0];
  if (earliest === undefined) return null;
  const servesBeforeEveryOther = ordered.every(
    (entry, index) => index === 0 || earliest.registration.orderMax < entry.registration.order,
  );
  if (!servesBeforeEveryOther || earliest.candidate.typedPathParams === true) return null;
  return earliest.candidate;
}

/**
 * Deterministic runtime route attribution over the COMPLETE candidate
 * set (plan §9 steps 4-9, D2; 0.14 registration-order precedence).
 * When more than one candidate matches the observation — the literal
 * `/accounts/export` against the parameter `/accounts/{}` — attribution
 * resolves by the framework's OWN registration order, but only when the
 * detector proved it for the whole matched set: same scope, distinct
 * orders, no typed path convertor on the smallest-order candidate (see
 * {@link registrationOrderWinner}). The winner then grades like any
 * unique match — `match` for its own obligation, `mismatch` for every
 * other endpoint's. Without a proven order (other packs, unprovable
 * constructs, mixed scopes, a missing or tied proof, a typed convertor
 * ahead of the field) the transport status is still known but handler
 * attribution is ambiguous and the claim blocks, exactly as before.
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
 *     texts when more than one distinct resource matches and no proven
 *     registration order singles one out;
 *   - `{status: 'mismatch', matched}` when exactly one candidate
 *     matches (or the proven order winner is) a different endpoint;
 *   - `{status: 'match', matched}` when the unique match (or the
 *     proven order winner) is the obligation's own endpoint.
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
    // Registration-order precedence (0.14): when the detector proved the
    // framework's own match order for the whole matched set, the
    // smallest order IS the serving route and the overlap resolves;
    // otherwise the transport status is known but handler attribution
    // stays ambiguous.
    const winner = registrationOrderWinner(distinct);
    if (winner !== null) {
      if (winner.resourceId !== obligationResourceId) {
        return { status: 'mismatch', matched: winner };
      }
      return { status: 'match', matched: winner };
    }
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
 * equal, a parameter slot (`{}`, `:name`, or `{name}`) matches any
 * single non-empty segment, and a TRAILING `{*}` matches one or more
 * trailing segments. Non-trailing wildcards and any other shape never
 * match. Case-sensitive.
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
    if (pattern === undefined) continue;
    // A parameter slot matches any single (non-empty — empties were
    // dropped) segment; anything else must be literally equal.
    // Case-sensitive. A host declares its routes with NAMED parameters
    // (Express `:id`, FastAPI/Next `{id}`) and the host detector keeps
    // that framework spelling on the route fact, so all three spellings
    // denote the same positional slot — a route whose id segment never
    // resolves could never be proven, a silent failure rather than a
    // fail-closed one. `{*}` is the trailing wildcard and never
    // reaches this loop.
    const isSlot =
      pattern === '{}' || /^:[^/]+$/.test(pattern) || /^\{[^/{}]+\}$/.test(pattern);
    if (!isSlot && pattern !== observed[i]) return false;
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
 * ONE observed HTTP exchange, stripped of the record that carried it:
 * the same three facts an `http.request` payload holds, and the same
 * ones an Observe-channel `http.observed` record's `exchanges` entries
 * hold. Grading them HERE is what keeps both evidence channels on ONE
 * matcher — there is no second endpoint resolver that could drift from
 * the first.
 */
interface ObservedExchangeFacts {
  method: unknown;
  url: unknown;
  status: unknown;
}

/**
 * One exchange's grade: ok, or the typed reason it blocks with.
 * `ownRoute` marks an invalid grade about the obligation's OWN route (an
 * ambiguity that includes it, or its non-2xx status) as opposed to an
 * exchange of some other endpoint, so a reason can name the call that
 * actually blocked the claim.
 */
type ExchangeGrade =
  | { ok: true }
  | { ok: false; status: 'invalid'; reason: string; ownRoute: boolean }
  | { ok: false; status: 'missing'; reason: string };

/**
 * Grades ONE observed HTTP exchange against the obligation's endpoint
 * (plan §9/§10): the observed path must be interpretable, the COMPLETE
 * route inventory must attribute it to EXACTLY the obligation's own
 * endpoint, and `http:response-status-ok` additionally requires a 2xx.
 * The single matcher for both the engine-browser (`http.request`) and
 * the Observe channel (`http.observed`).
 *
 * Args:
 *   facts: the exchange's method, url and observed status.
 *   input: the claim plus its obligation (for ids/contract/status rule).
 *   subject: how the exchange's source is named in reasons — e.g.
 *     ``witnessed 'http.request' record 'r-1'`` on the anchor path, and
 *     ``observe-channel exchange in witnessed 'http.observed' record
 *     'r-1'`` on the Observe path.
 *   inventoryBlock: the precomputed inventory reason, or null when usable.
 *   candidates: the usable route inventory (ignored when inventoryBlock
 *     is set).
 *
 * Returns:
 *   ExchangeGrade: ok only for a uniquely attributed exchange (plus a
 *   2xx for the status contract).
 */
function gradeObservedExchange(
  facts: ObservedExchangeFacts,
  input: ClaimEvidenceInput,
  subject: string,
  inventoryBlock: string | null,
  candidates: readonly HttpRouteCandidate[],
): ExchangeGrade {
  if (typeof facts.method !== 'string' || typeof facts.url !== 'string') {
    return {
      ok: false,
      status: 'invalid',
      reason: `'${input.obligation.id}': ${subject} carries no method/url pair`,
      ownRoute: false,
    };
  }
  if (inventoryBlock !== null) {
    return { ok: false, status: 'missing', reason: inventoryBlock };
  }
  const observedMethod = facts.method;
  const interpreted = interpretObservedPath(facts.url);
  if (interpreted.ok === false) {
    return {
      ok: false,
      status: 'invalid',
      reason:
        `'${input.obligation.id}': ${subject} carries a noncanonical observed path: ` +
        `${interpreted.reason}`,
      ownRoute: false,
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
      ok: false,
      status: 'missing',
      reason: `'${input.obligation.id}': ${resolution.reason}`,
    };
  }
  if (resolution.status === 'nomatch') {
    return {
      ok: false,
      status: 'invalid',
      reason: `'${input.obligation.id}': ${subject} ${resolution.reason}`,
      ownRoute: false,
    };
  }
  if (resolution.status === 'ambiguous') {
    return {
      ok: false,
      status: 'invalid',
      reason:
        `'${input.obligation.id}': ambiguous route attribution: observed ` +
        `${observedMethod.toUpperCase()} ${interpreted.path} matches ${resolution.candidates.length} ` +
        `distinct routes [${resolution.candidates.join('; ')}]; the transport status is known ` +
        'but handler attribution is not, so no endpoint-specific claim passes until ' +
        'engine-owned handler proof resolves the overlap',
      ownRoute: resolution.candidates.some((text) =>
        text.endsWith(`(${input.obligation.resourceId})`),
      ),
    };
  }
  if (resolution.status === 'mismatch') {
    return {
      ok: false,
      status: 'invalid',
      reason:
        `'${input.obligation.id}': ${subject} observed ${observedMethod.toUpperCase()} ` +
        `${interpreted.path} uniquely matches route ${candidateIdentityText(resolution.matched)} ` +
        `but the obligation requires endpoint '${input.obligation.resourceId}'; evidence from ` +
        'a different endpoint can never satisfy it',
      ownRoute: false,
    };
  }
  if (input.obligation.contract === 'http:response-status-ok') {
    const status = facts.status;
    if (typeof status !== 'number' || !Number.isInteger(status) || status < 200 || status > 299) {
      return {
        ok: false,
        status: 'invalid',
        reason:
          `'${input.obligation.id}': observed status ` +
          `'${String(status)}' is not a 2xx response`,
        ownRoute: true,
      };
    }
  }
  return { ok: true };
}

/**
 * Grades ONE `http.request` record independently for origin, trust,
 * provenance and payload (plan §10 step 3), then hands its
 * method/url/status to the shared {@link gradeObservedExchange}. Never
 * returns from the outer verifier; the caller aggregates every grade.
 * All reason wordings are verbatim from the single-exchange grader.
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
  const subject = `witnessed '${HTTP_REQUEST_KIND}' record '${label}'`;
  if (payload === null) {
    return {
      status: 'invalid',
      reason: `'${input.obligation.id}': ${subject} carries no method/url pair`,
    };
  }
  const exchange = gradeObservedExchange(
    { method: payload['method'], url: payload['url'], status: payload['status'] },
    input,
    subject,
    inventoryBlock,
    candidates,
  );
  if (exchange.ok) return { status: 'satisfied', recordId: label };
  return exchange;
}

/**
 * The ANCHOR channel of the transport grader: the historical rule,
 * byte-identical. The suite anchor is validated once (codepoint-smallest
 * anchor when several qualify); the route inventory is scanned once;
 * then EVERY `http.request` record is graded independently with NO
 * early return on the first bad record. `satisfied > invalid > missing`
 * decides; ≥1 satisfying record selects the codepoint-smallest record
 * id joined with the anchor — identical for every input permutation.
 * Otherwise the codepoint-smallest invalid reason wins, else the
 * smallest missing reason. Untrusted records never satisfy; status-ok
 * still means ≥1 eligible 2xx (no new success rule).
 *
 * Args:
 *   input: the claim plus its attributed evidence and obligation.
 *
 * Returns:
 *   ClaimOutcome: satisfied only for a witnessed engine-observed
 *   exchange matching the endpoint shape (plus 2xx for status-ok).
 */
function gradeAnchoredTransport(input: ClaimEvidenceInput): ClaimOutcome {
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

/**
 * The OBSERVE channel of the transport grader: the exchanges the
 * witness proxied for THIS test session, stamped into one witnessed
 * `http.observed` record by the observe finalize. Admission mirrors the
 * persistence Observe channel exactly: `trust === 'witnessed'` AND the
 * `channel: 'observe'` stamp (both witness-issued, both covered by the
 * ledger MAC) — a suite-asserted or untrusted `http.observed` record is
 * admissible NOWHERE. Only obligations the supervisor registered
 * `observed-e2e` ever carry such a record, so the gate lives in the
 * witness's declarations, not here.
 *
 * Returns null — the channel says NOTHING, so the anchor outcome stands
 * verbatim — when no record qualifies (the persistence channel's
 * `observeFailure === null` rule: an absent channel never rewords an
 * absent anchor).
 *
 * Args:
 *   input: the claim plus its attributed evidence and obligation.
 *
 * Returns:
 *   ClaimOutcome | null: satisfied with the record id carrying a
 *   matching exchange, the sharpest typed reason otherwise, or null
 *   when no witnessed Observe-channel record is present at all.
 */
function gradeObservedTransport(input: ClaimEvidenceInput): ClaimOutcome | null {
  const records = input.evidence.filter(
    (entry) =>
      entry.trust === 'witnessed' &&
      typeof entry.record.kind === 'string' &&
      entry.record.kind === HTTP_OBSERVED_KIND &&
      payloadOf(entry.record)?.['channel'] === OBSERVE_CHANNEL,
  );
  if (records.length === 0) return null;

  const inventoryBlock = transportInventoryBlock(input);
  const candidates = (input.httpRoutes ?? []) as readonly HttpRouteCandidate[];
  const satisfied: string[] = [];
  // Reasons about the obligation's own route outrank exchanges of other
  // endpoints the same session also made (a login before the call).
  const ownInvalidReasons: string[] = [];
  const invalidReasons: string[] = [];
  const missingReasons: string[] = [];
  for (const entry of records) {
    const label = String(entry.record.recordId);
    const subject = `observe-channel exchange in witnessed '${HTTP_OBSERVED_KIND}' record '${label}'`;
    const payload = payloadOf(entry.record);
    const exchanges = payload?.['exchanges'];
    if (!Array.isArray(exchanges)) {
      invalidReasons.push(
        `'${input.obligation.id}': ${subject} carries no exchanges list — the witness records ` +
          "only the session's own proxied exchanges, and this one names none",
      );
      continue;
    }
    if (exchanges.length === 0) {
      invalidReasons.push(
        `'${input.obligation.id}': ${subject} carries an EMPTY exchanges list; a session that ` +
          'proxied no HTTP exchange gets a typed missing-traffic note instead of a record',
      );
      continue;
    }
    let invalid: string | null = null;
    let ownInvalid: string | null = null;
    let missing: string | null = null;
    let matchedHere = false;
    for (const raw of exchanges) {
      const facts =
        typeof raw === 'object' && raw !== null && !Array.isArray(raw)
          ? { method: raw['method'], url: raw['url'], status: raw['status'] }
          : { method: undefined, url: undefined, status: undefined };
      const grade = gradeObservedExchange(facts, input, subject, inventoryBlock, candidates);
      if (grade.ok) {
        matchedHere = true;
        break;
      }
      if (grade.status === 'invalid') {
        if (grade.ownRoute) {
          if (ownInvalid === null) ownInvalid = grade.reason;
        } else if (invalid === null) {
          invalid = grade.reason;
        }
      } else if (missing === null) {
        missing = grade.reason;
      }
    }
    if (matchedHere) satisfied.push(label);
    else if (ownInvalid !== null) ownInvalidReasons.push(ownInvalid);
    else if (invalid !== null) invalidReasons.push(invalid);
    else if (missing !== null) missingReasons.push(missing);
  }
  if (satisfied.length > 0) {
    // ONE selected id, codepoint-smallest exactly as the anchor path
    // does: the result never depends on the input order.
    return {
      status: 'satisfied',
      recordIds: [sortedUniqueIds(satisfied)[0] as string],
    };
  }
  if (ownInvalidReasons.length > 0) {
    return { status: 'invalid', reason: ownInvalidReasons.sort(compareStrings)[0] as string };
  }
  if (invalidReasons.length > 0) {
    return { status: 'invalid', reason: invalidReasons.sort(compareStrings)[0] as string };
  }
  return { status: 'missing', reason: missingReasons.sort(compareStrings)[0] as string };
}

/**
 * Grades the explicit transport contracts (`http:request-observed`,
 * `http:response-status-ok`): ONE matcher, two evidence channels, no
 * divergent verifier. Proves only that the witness observed an HTTP
 * exchange in the bound run; test attribution is suite-claimed on both.
 *
 * Channel order (plan 0.9.2 item D, invariants I4/I6): the engine
 * browser anchor path grades FIRST and decides everything:
 * - satisfied → returned verbatim, with the same record ids;
 * - invalid → returned verbatim too. An engine-found ERROR (a
 *   witnessed exchange of a different endpoint, a non-2xx response) is
 *   FINAL: a second channel's match never masks it. When the engine
 *   observed the traffic and it was wrong, no other evidence may make
 *   the claim pass.
 * - missing → and only then is the Observe channel consulted, which is
 *   what lets a normal suite-driven test mapped `observed-e2e` discharge
 *   the same obligation without weakening what the engine path proves.
 *
 * When the anchor path is missing and the Observe channel does not
 * satisfy either, the sharpest reason wins — `invalid > missing`, then
 * codepoint-smallest — so a witnessed exchange of the wrong endpoint is
 * never reported as an absent anchor. With no admissible Observe
 * record the anchor outcome is returned BYTE-IDENTICAL: the channel
 * that said nothing cannot reword the channel that did.
 *
 * Args:
 *   input: the claim plus its attributed evidence and obligation.
 *
 * Returns:
 *   ClaimOutcome: satisfied only for a witnessed exchange matching the
 *   endpoint shape (plus 2xx for status-ok), on either channel.
 */
function gradeTransportObservation(input: ClaimEvidenceInput): ClaimOutcome {
  const anchored = gradeAnchoredTransport(input);
  if (anchored.status !== 'missing') return anchored;
  const observed = gradeObservedTransport(input);
  if (observed === null) return anchored;
  if (observed.status === 'satisfied') return observed;
  if (observed.status === 'invalid') return observed;
  return {
    status: 'missing',
    reason: [anchored.reason, observed.reason].sort(compareStrings)[0] as string,
  };
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
  if (
    input.obligation.contract === 'http:effect-verified' ||
    input.obligation.contract === 'http:read-result-verified'
  ) {
    return strongHttpProofUnavailable(input);
  }
  return gradeTransportObservation(input);
}

/**
 * The honest evidence channel each domain namespace would need. Wording
 * is per-namespace on purpose: the fail-closed reason must name WHAT is
 * missing, not a generic unsupported hole.
 */
const DOMAIN_NAMESPACES: readonly { namespace: string; channel: string; contracts: readonly string[] }[] = [
  {
    namespace: 'auth',
    channel: 'identity/role material and tenant-scoped application state',
    contracts: [
      'auth:role-allowed',
      'auth:role-denied',
      'auth:tenant-isolated',
      'auth:denied-no-side-effect',
      'auth:forged-token-rejected',
    ],
  },
  {
    namespace: 'task',
    channel: 'queue/job delivery state',
    contracts: [
      'task:retry-policy-enforced',
      'task:idempotent',
      'task:terminal-handled',
      'task:observability-recorded',
      'task:duplicate-delivery-handled',
    ],
  },
  {
    namespace: 'validation',
    channel: 'boundary semantics over application state and the response envelope',
    contracts: [
      'validation:boundary-accepted',
      'validation:boundary-rejected',
      'validation:no-side-effect-on-reject',
      'validation:error-message-explicit',
      'validation:envelope-shape-stable',
    ],
  },
  {
    namespace: 'webhook',
    channel: 'signature/replay verification over application-received deliveries',
    contracts: [
      'webhook:signature-accepted',
      'webhook:signature-rejected',
      'webhook:malformed-rejected',
      'webhook:replay-idempotent',
      'webhook:retry-bounded',
    ],
  },
  {
    namespace: 'workflow',
    channel: 'the workflow state machine and its audit log',
    contracts: [
      'workflow:transition-allowed',
      'workflow:transition-rejected',
      'workflow:terminal-immutable',
      'workflow:audit-emitted',
      'workflow:persisted-final-state',
    ],
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
function failClosedVerifier(namespace: string, channel: string, contracts: readonly string[] = []): ContractVerifier {
  return (input: ClaimEvidenceInput): ClaimOutcome => {
    // A contract string that does not parse into this namespace is
    // genuinely unknown, not merely unproducible.
    if (!input.obligation.contract.startsWith(`${namespace}:`)) {
      return unknownContract(input);
    }
    if (contracts.includes(input.obligation.contract)) {
      // Implemented contracts grade through required-case aggregation
      // (evaluateObligation) once a compiled requirement set exists.
      // Reaching the per-claim fallback means no approved case set
      // covers this obligation — transport evidence must not substitute.
      return {
        status: 'missing',
        reason:
          `'${input.obligation.id}': contract '${input.obligation.contract}' has no compiled ` +
          'required-case set covering this obligation: strong behavior contracts grade only ' +
          'across approved required cases with engine-issued case records (a missing behavior ' +
          'declaration blocks; transport evidence cannot satisfy them)',
        recordIds: [],
      };
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
 * The http namespace's capability record (plan Phase 0 item 3, Phase 5
 * item 9): transport contracts prove over the witness HTTP proxy
 * channel; `http:effect-verified` and `http:read-result-verified` are
 * available once genuine witness-produced case evidence exercises the
 * required-case grader (behavior-catalog obligations aggregate across
 * their required cases — transport evidence alone still cannot satisfy
 * them). `http:frontend-request-observed` stays registered but
 * unavailable — the supervised session channel (plan Phase 1) binds
 * exchanges to a session's proxy ORIGIN, not to a browser, so the
 * independent browser/test observation the contract names still does not
 * exist and enabling it would silently change its meaning.
 */
const HTTP_CAPABILITY: ContractCapability = {
  namespace: 'http',
  contracts: ['http:request-observed', 'http:response-status-ok', 'http:effect-verified', 'http:read-result-verified'],
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
    'engine-owned behavior driver plus independent state-scope snapshots: a witness-issued behavior.case ' +
    'record binding the exact endpoint, request, actor, and before/after effects, graded across every required case',
  testKinds: ['browser-e2e', 'api-e2e'],
  availability: { status: 'available' },
};

/**
 * Fail-closed availability of the `task` namespace while no queue
 * observer is configured. A task contract is a claim about a
 * background job's delivery state, and only an engine-owned read of
 * the queue can settle one — so without the observer nothing in the
 * namespace is provable.
 */
const TASK_UNAVAILABLE: ContractAvailability = {
  status: 'unavailable',
  reason:
    "no engine-owned queue observer is configured: a background job's attempts, state and " +
    'idempotency live in the queue and no engine-side producer reads them, so every task ' +
    "contract fails closed (a suite's own \"the job succeeded\" is never proof) — declare a " +
    '`queueObserver` block in .gateforge.yml to make the namespace available',
};

/** Builds the fail-closed capability record for one domain namespace. */
function domainCapability(
  namespace: string,
  channel: string,
  contracts: readonly string[] = [],
): ContractCapability {
  if (contracts.length === 0) {
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
  return {
    namespace,
    contracts: [...contracts],
    unavailableContracts: [],
    observer:
      `engine-owned behavior driver plus independent state-scope snapshots over ${channel}: ` +
      'a witness-issued behavior.case record binding the exact endpoint, request, actor, and ' +
      'before/after effects, graded across every required case',
    testKinds: ['browser-e2e', 'api-e2e'],
    availability: namespace === 'task' ? TASK_UNAVAILABLE : { status: 'available' },
  };
}

/**
 * Binds the engine-owned queue observer and
 * moves the `task` namespace's availability with it: available while a
 * `queueObserver` block is configured, unavailable (every task contract
 * fails closed) otherwise. Called from the engine's own config load —
 * the only place the owner-approved block is known. Idempotent.
 *
 * Args:
   observer: the validated `queueObserver` block, or null/undefined
     when the repository declares none.
 */
export function bindQueueObserver(observer: QueueObserverConfig | null | undefined): void {
  setContractAvailability(
    'task',
    observer === null || observer === undefined ? TASK_UNAVAILABLE : { status: 'available' },
  );
}

/** Registers every pack namespace + the http namespace. Idempotent. */
export function registerPackVerifiers(): void {
  if (registered) return;
  registered = true;
  registerContractVerifier('http', httpVerifier);
  registerContractCapabilities(HTTP_CAPABILITY);
  for (const { namespace, channel, contracts } of DOMAIN_NAMESPACES) {
    registerContractVerifier(namespace, failClosedVerifier(namespace, channel, contracts));
    registerContractCapabilities(domainCapability(namespace, channel, contracts));
  }
}
