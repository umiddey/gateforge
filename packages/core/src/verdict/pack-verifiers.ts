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
 * Contract → scenario table for the domain packs. The scenario string is
 * the contract's verb; the record payload must assert it, and positive
 * scenarios must carry their observed outcome.
 */
interface NamespaceSpec {
  namespace: string;
  kind: string;
  scenarios: Readonly<Record<string, { requiresObservedFalse?: boolean }>>;
}

const NAMESPACE_SPECS: readonly NamespaceSpec[] = [
  {
    namespace: 'auth',
    kind: 'auth.check',
    scenarios: {
      'role-allowed': {},
      'role-denied': { requiresObservedFalse: true },
      'tenant-isolated': { requiresObservedFalse: true },
      'denied-no-side-effect': { requiresObservedFalse: true },
      'forged-token-rejected': { requiresObservedFalse: true },
    },
  },
  {
    namespace: 'workflow',
    kind: 'workflow.check',
    scenarios: {
      'transition-allowed': {},
      'transition-rejected': { requiresObservedFalse: true },
      'terminal-immutable': { requiresObservedFalse: true },
      'audit-emitted': {},
      'persisted-final-state': {},
    },
  },
  {
    namespace: 'webhook',
    kind: 'webhook.check',
    scenarios: {
      'signature-accepted': {},
      'signature-rejected': { requiresObservedFalse: true },
      'malformed-rejected': { requiresObservedFalse: true },
      'replay-idempotent': {},
      'retry-bounded': {},
    },
  },
  {
    namespace: 'task',
    kind: 'task.check',
    scenarios: {
      'retry-policy-enforced': {},
      idempotent: {},
      'terminal-handled': {},
      'observability-recorded': {},
      'duplicate-delivery-handled': {},
    },
  },
  {
    namespace: 'validation',
    kind: 'validation.check',
    scenarios: {
      'boundary-accepted': {},
      'boundary-rejected': { requiresObservedFalse: true },
      'no-side-effect-on-reject': { requiresObservedFalse: true },
      'error-message-explicit': {},
      'envelope-shape-stable': {},
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
    if (scenarioSpec.requiresObservedFalse) {
      if (payload['allowed'] !== false && payload['observed'] !== false) {
        return {
          status: 'invalid',
          reason:
            `'${input.obligation.id}': witnessed record ` +
            `'${String(proven.record.recordId)}' does not assert the negative outcome ` +
            `required by '${input.obligation.contract}'`,
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
