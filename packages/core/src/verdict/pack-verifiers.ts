/**
 * Built-in semantic verifiers for the pack contract namespaces (ADR 0004
 * D8, plan phase 5). Registered once at module init; the registry rejects
 * re-registration, so no pack can override another namespace.
 *
 * Trust model (invariant, ADR 0001): ONLY witnessed records satisfy.
 * Suite-submitted records are claimed-tier at issuance; a claimed record
 * with the right shape leaves the obligation `missing` (honest gap:
 * independent observation still owed), while a record whose payload
 * contradicts the contract grades `invalid`. Fabricated provenance is
 * rejected before verifiers run (the engine re-computes record hashes).
 *
 * HTTP namespace: `http:frontend-request-observed` requires an
 * engine-observed `http.request` record bound to the run (the
 * witness-owned observation channel, phase 6) PLUS a provenanced
 * claimed `ui.action` anchor from the declaring test; a suite-submitted
 * network record can never satisfy (`HTTP_OBSERVATION_UNTRUSTED`).
 * `http:response-status-ok` additionally requires a 2xx status.
 *
 * Domain-check namespaces (`auth.check`, `workflow.check`,
 * `webhook.check`, `task.check`, `validation.check`): the WITNESS derives
 * the outcome from the observed HTTP exchange. The record payload carries
 * the witness-derived `outcome` (`'accepted'` for a 2xx, `'rejected'`
 * for a 4xx), the observed `method`/`url`/`status`, the response digest
 * and byte count, and — for dual-observation scenarios — the observed
 * exchange count. The caller-asserted `allowed`/`observed` booleans the
 * payload once carried are gone: a suite can assert anything, only the
 * witness's derived outcome grades. Identity binding uses the same
 * positional shape match as the http namespace (`pathMatchesShape`),
 * so `/accounts/123` satisfies an `/accounts/{}` endpoint (ADR 0004
 * D2/D3).
 */
import type { Obligation } from '../schemas/index.js';
import { isProvenancedRecord } from '../provenance.js';

/**
 * Stable typed code for untrusted runtime observations. Mirrors
 * `HTTP_OBSERVATION_UNTRUSTED` in `@gateforge/http-contract` (core
 * cannot depend on it); keep the two in lockstep.
 */
const HTTP_OBSERVATION_UNTRUSTED = 'HTTP_OBSERVATION_UNTRUSTED';
import {
  registerContractVerifier,
  type ClaimEvidenceInput,
  type ClaimOutcome,
  type ContractVerifier,
} from './registry.js';

/** Record kinds the witness and suites exchange. */
const UI_ACTION_KIND = 'ui.action';
const HTTP_REQUEST_KIND = 'http.request';

function recordIdsOf(
  evidence: ClaimEvidenceInput['evidence'],
  predicate: (entry: ClaimEvidenceInput['evidence'][number]) => boolean,
): string[] {
  return [...new Set(evidence.filter(predicate).map((entry) => String(entry.record.recordId)))].sort();
}

function payloadOf(record: ClaimEvidenceInput['evidence'][number]['record']): Record<string, unknown> | null {
  const payload = record.payload;
  return payload !== null && typeof payload === 'object' ? (payload as Record<string, unknown>) : null;
}

/**
 * The provenanced claimed `ui.action` anchor: proves the declaring test
 * actually drove the UI (suite-asserted, hash-verified issuance). Any
 * tier anchors — satisfaction weight lives in the witnessed records.
 */
function uiAnchorFailure(input: ClaimEvidenceInput): ClaimOutcome | null {
  const actions = input.evidence.filter((entry) => entry.record.kind === UI_ACTION_KIND);
  const anchor = actions.find((entry) => isProvenancedRecord(entry.record));
  if (anchor === undefined) {
    const detail =
      actions.length === 0
        ? `no '${UI_ACTION_KIND}' anchor from the declaring test`
        : `'${UI_ACTION_KIND}' records exist but none verifies its provenance`;
    return {
      status: 'missing',
      reason: `'${input.obligation.id}': ${detail}`,
    };
  }
  return null;
}

/**
 * Canonicalizes an observed request path the same way the witness does
 * (query/hash stripped, one leading slash, trailing slashes dropped,
 * root '/' stays '/'); duplicate slashes collapse so a path can never
 * masquerade across segment boundaries. Local on purpose: core must not
 * depend on `@gateforge/http-contract`.
 */
function normalizeObservedPath(rawUrl: string): string {
  let path = rawUrl.split('?')[0]?.split('#')[0] ?? '/';
  if (!path.startsWith('/')) path = `/${path}`;
  path = path.replace(/\/{2,}/g, '/');
  if (path.length > 1) path = path.replace(/\/+$/, '');
  return path;
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

/** Grades the HTTP runtime-observation contracts (phase 5/6 semantics). */
function httpVerifier(input: ClaimEvidenceInput): ClaimOutcome {
  const anchorFailure = uiAnchorFailure(input);
  if (anchorFailure !== null) return anchorFailure;

  const requests = input.evidence.filter((entry) => entry.record.kind === HTTP_REQUEST_KIND);
  if (requests.length === 0) {
    return {
      status: 'missing',
      reason:
        `'${input.obligation.id}': no '${HTTP_REQUEST_KIND}' record; the browser request ` +
        'must be observed by the witness-owned channel',
      recordIds: [],
    };
  }
  const untrusted = requests.find((entry) => entry.record.origin !== 'engine-observed');
  if (untrusted !== undefined) {
    return {
      status: 'invalid',
      reason:
        `'${input.obligation.id}': suite-submitted network record ` +
        `'${String(untrusted.record.recordId)}' cannot satisfy an HTTP runtime contract ` +
        `(${HTTP_OBSERVATION_UNTRUSTED}); only the witness-owned observation channel proves ` +
        'that the browser issued the request',
    };
  }
  const proven = requests.find(
    (entry) => entry.trust === 'witnessed' && isProvenancedRecord(entry.record),
  );
  if (proven === undefined) {
    return {
      status: 'missing',
      reason:
        `'${input.obligation.id}': observed requests exist but none carries witnessed ` +
        'provenance bound to this run',
    };
  }
  const payload = payloadOf(proven.record);
  if (payload === null || typeof payload['method'] !== 'string' || typeof payload['url'] !== 'string') {
    return {
      status: 'invalid',
      reason:
        `'${input.obligation.id}': witnessed '${HTTP_REQUEST_KIND}' record ` +
        `'${String(proven.record.recordId)}' carries no method/url pair`,
    };
  }
  // Identity match (fail-closed): when the host supplies the obligation's
  // graph resource, the witnessed observation must come from THAT
  // endpoint — a `/health` observation can never satisfy a `/contracts`
  // obligation. The comparison is positional against the endpoint's
  // canonical SHAPE (ADR 0004 D2/D3): `/accounts/123` satisfies
  // `/accounts/{}`; evidence from a different endpoint shape never does.
  // Absent resource (test harnesses) keeps the historical any-endpoint
  // behavior; the real CLI always supplies it.
  if (input.resource !== null && input.resource !== undefined && input.resource.kind === 'http.endpoint') {
    const expectedMethod = String(input.resource.attributes['method']).toUpperCase();
    const expectedPath = String(input.resource.attributes['canonicalPath']);
    const observedMethod = payload['method'].toUpperCase();
    const observedPath = normalizeObservedPath(payload['url']);
    if (observedMethod !== expectedMethod || !pathMatchesShape(observedPath, expectedPath)) {
      return {
        status: 'invalid',
        reason:
          `'${input.obligation.id}': witnessed '${HTTP_REQUEST_KIND}' record ` +
          `'${String(proven.record.recordId)}' observed ${observedMethod} ${payload['url']} does not ` +
          `match endpoint shape ${expectedMethod} ${expectedPath}; evidence from a different ` +
          'endpoint can never satisfy it',
      };
    }
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
  return {
    status: 'satisfied',
    recordIds: [String(proven.record.recordId)],
  };
}

/**
 * The outcome class of a domain-check scenario, DERIVED by the witness
 * from the last observed HTTP status: `accepted` requires 200-299,
 * `rejected` requires 400-499.
 */
type ScenarioClass = 'accepted' | 'rejected';

/**
 * One scenario's grading requirements (mirror of the witness payload
 * contract). The witness uses the same table, so the verifier's
 * expectations never come from the tested suite.
 */
interface ScenarioSpec {
  /** Outcome class the witness must have derived for the scenario. */
  outcomeClass: ScenarioClass;
  /** Set (=== 2) only for dual-observation scenarios: the witness must
   * have consumed TWO matching proxied requests of the exchange. */
  observations?: 2;
}

/**
 * Namespace → scenario table for the domain packs. The scenario string
 * is the contract's verb; the witnessed record's payload must carry the
 * witness-derived outcome class for it.
 */
interface NamespaceSpec {
  namespace: string;
  kind: string;
  scenarios: Readonly<Record<string, ScenarioSpec>>;
}

const NAMESPACE_SPECS: readonly NamespaceSpec[] = [
  {
    namespace: 'auth',
    kind: 'auth.check',
    scenarios: {
      'denied-no-side-effect': { outcomeClass: 'rejected' },
      'forged-token-rejected': { outcomeClass: 'rejected' },
      'role-allowed': { outcomeClass: 'accepted' },
      'role-denied': { outcomeClass: 'rejected' },
      'tenant-isolated': { outcomeClass: 'rejected' },
    },
  },
  {
    namespace: 'workflow',
    kind: 'workflow.check',
    scenarios: {
      'audit-emitted': { outcomeClass: 'accepted' },
      'persisted-final-state': { outcomeClass: 'accepted' },
      'terminal-immutable': { outcomeClass: 'rejected' },
      'transition-allowed': { outcomeClass: 'accepted' },
      'transition-rejected': { outcomeClass: 'rejected' },
    },
  },
  {
    namespace: 'webhook',
    kind: 'webhook.check',
    scenarios: {
      'malformed-rejected': { outcomeClass: 'rejected' },
      'replay-idempotent': { outcomeClass: 'accepted', observations: 2 },
      'retry-bounded': { outcomeClass: 'accepted' },
      'signature-accepted': { outcomeClass: 'accepted' },
      'signature-rejected': { outcomeClass: 'rejected' },
    },
  },
  {
    namespace: 'task',
    kind: 'task.check',
    scenarios: {
      'duplicate-delivery-handled': { outcomeClass: 'accepted', observations: 2 },
      idempotent: { outcomeClass: 'accepted', observations: 2 },
      'observability-recorded': { outcomeClass: 'accepted' },
      'retry-policy-enforced': { outcomeClass: 'accepted' },
      'terminal-handled': { outcomeClass: 'accepted' },
    },
  },
  {
    namespace: 'validation',
    kind: 'validation.check',
    scenarios: {
      'boundary-accepted': { outcomeClass: 'accepted' },
      'boundary-rejected': { outcomeClass: 'rejected' },
      'envelope-shape-stable': { outcomeClass: 'accepted' },
      'error-message-explicit': { outcomeClass: 'accepted' },
      'no-side-effect-on-reject': { outcomeClass: 'rejected' },
    },
  },
];

/** Builds one namespace's verifier from its spec (table-driven). */
function packVerifier(spec: NamespaceSpec): ContractVerifier {
  return (input: ClaimEvidenceInput): ClaimOutcome => {
    const verb = input.obligation.contract.slice(spec.namespace.length + 1);
    const scenarioSpec = spec.scenarios[verb];
    if (scenarioSpec === undefined) {
      return unknownContract(input);
    }
    const anchorFailure = uiAnchorFailure(input);
    if (anchorFailure !== null) return anchorFailure;

    const checks = input.evidence.filter((entry) => entry.record.kind === spec.kind);
    if (checks.length === 0) {
      return {
        status: 'missing',
        reason:
          `'${input.obligation.id}': no '${spec.kind}' record for scenario '${verb}'; ` +
          'the pack-specific check must be observed by the witness',
        recordIds: [],
      };
    }
    const untrusted = checks.find((entry) => entry.record.origin !== 'engine-observed');
    if (untrusted !== undefined) {
      return {
        status: 'missing',
        reason:
          `'${input.obligation.id}': '${spec.kind}' records exist only as suite-submitted ` +
          '(claimed) observations; independent witnessed evidence is still owed',
      };
    }
    const proven = checks.find(
      (entry) => entry.trust === 'witnessed' && isProvenancedRecord(entry.record),
    );
    if (proven === undefined) {
      return {
        status: 'missing',
        reason:
          `'${input.obligation.id}': observed '${spec.kind}' records exist but none carries ` +
          'witnessed provenance bound to this run',
      };
    }
    const payload = payloadOf(proven.record);
    if (payload === null || payload['scenario'] !== verb) {
      const got = payload === null ? '<no payload>' : String(payload['scenario']);
      return {
        status: 'invalid',
        reason:
          `'${input.obligation.id}': witnessed '${spec.kind}' record ` +
          `'${String(proven.record.recordId)}' asserts scenario '${got}' but ` +
          `'${input.obligation.contract}' requires '${verb}'`,
      };
    }
    // The outcome is WITNESS-DERIVED (from the observed HTTP status), not
    // caller-asserted: a scenario's class demands exactly one outcome.
    const outcomeClass = scenarioSpec.outcomeClass;
    if (payload['outcome'] !== outcomeClass) {
      return {
        status: 'invalid',
        reason:
          `'${input.obligation.id}': witnessed '${spec.kind}' record ` +
          `'${String(proven.record.recordId)}' witness-derived outcome ` +
          `'${String(payload['outcome'])}' cannot evidence '${input.obligation.contract}'`,
      };
    }
    const method = payload['method'];
    const url = payload['url'];
    if (typeof method !== 'string' || typeof url !== 'string') {
      return {
        status: 'invalid',
        reason:
          `'${input.obligation.id}': witnessed '${spec.kind}' record ` +
          `'${String(proven.record.recordId)}' carries no witnessed method/url pair of the exchange`,
      };
    }
    const status = payload['status'];
    const statusRange = outcomeClass === 'accepted' ? '200-299' : '400-499';
    const minStatus = outcomeClass === 'accepted' ? 200 : 400;
    const maxStatus = outcomeClass === 'accepted' ? 299 : 499;
    if (typeof status !== 'number' || !Number.isInteger(status) || status < minStatus || status > maxStatus) {
      return {
        status: 'invalid',
        reason:
          `'${input.obligation.id}': witnessed '${spec.kind}' record ` +
          `'${String(proven.record.recordId)}' observed status '${String(status)}', which cannot ` +
          `evidence '${input.obligation.contract}' (${outcomeClass} scenarios require ${statusRange})`,
      };
    }
    const responseSha256 = payload['responseSha256'];
    const responseBytes = payload['responseBytes'];
    if (
      typeof responseSha256 !== 'string' ||
      /^[0-9a-f]{64}$/.test(responseSha256) === false ||
      typeof responseBytes !== 'number' ||
      !Number.isInteger(responseBytes) ||
      responseBytes < 0
    ) {
      return {
        status: 'invalid',
        reason:
          `'${input.obligation.id}': witnessed '${spec.kind}' record ` +
          `'${String(proven.record.recordId)}' carries no witness-derived response evidence ` +
          '(responseSha256 must be 64 lowercase hex and responseBytes a non-negative integer)',
      };
    }
    if (scenarioSpec.observations === 2 && payload['observations'] !== 2) {
      return {
        status: 'invalid',
        reason:
          `'${input.obligation.id}': witnessed '${spec.kind}' record ` +
          `'${String(proven.record.recordId)}' requires two witnessed observations of the exchange ` +
          `for '${input.obligation.contract}' (payload.observations must be 2)`,
      };
    }
    // Identity match against the obligation's endpoint (same semantics as
    // the http namespace): the witnessed exchange must have hit THAT
    // endpoint shape, with THAT method.
    if (input.resource !== null && input.resource !== undefined && input.resource.kind === 'http.endpoint') {
      const expectedMethod = String(input.resource.attributes['method']).toUpperCase();
      const expectedPath = String(input.resource.attributes['canonicalPath']);
      const observedMethod = method.toUpperCase();
      const observedPath = normalizeObservedPath(url);
      if (observedMethod !== expectedMethod || !pathMatchesShape(observedPath, expectedPath)) {
        return {
          status: 'invalid',
          reason:
            `'${input.obligation.id}': witnessed '${spec.kind}' record ` +
            `'${String(proven.record.recordId)}' observed ${observedMethod} ${url} does not ` +
            `match endpoint shape ${expectedMethod} ${expectedPath}; evidence from a different ` +
            'endpoint can never satisfy it',
        };
      }
    }
    return {
      status: 'satisfied',
      recordIds: [String(proven.record.recordId)],
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

/** Registers every pack namespace + the http namespace. Idempotent. */
export function registerPackVerifiers(): void {
  if (registered) return;
  registered = true;
  registerContractVerifier('http', httpVerifier);
  for (const spec of NAMESPACE_SPECS) {
    registerContractVerifier(spec.namespace, packVerifier(spec));
  }
}
