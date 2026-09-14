/**
 * Cause mapping for the shared report model (plan 2026-09-13 §5.4, ADR
 * 0005): derives a stable cause code plus its next action from a
 * blocking verdict's contract and reason. Mapped today: unsupported
 * proof channels (VERIFIER_UNSUPPORTED — including a crud claim whose
 * session exchange cannot be attributed for lack of a route inventory),
 * a connected test whose required observations are absent
 * (EVIDENCE_NOT_COLLECTED — including the crud session-channel rules:
 * direct mutation outside the supervised channel, no visible result, no
 * session-bound anchor), an obligation no test is connected to
 * (TEST_MAPPING_MISSING), and the §3.6 exact-value echo violation
 * (EVIDENCE_VALUE_MISMATCH). Remaining causes are populated by the
 * phases that build their subsystems (catalog/mapping: Phase 2-3;
 * execution results: Phase 4); an unmapped blocking verdict carries a
 * null cause rather than a guess.
 *
 * The mapping matches the verifier reasons verbatim — those strings are
 * engine-owned (single grading sites, kept in lockstep by tests), never
 * adversary-controlled input.
 */
import { capabilityFor } from './registry.js';
import { CAUSE_NEXT_ACTIONS, type CauseCode } from '../schemas/verdict.js';

/** Cause plus its plan §5.4 next action, attached to a report entry. */
export interface VerdictCause {
  /** Stable cause code, or null when Phase 0 has no honest mapping. */
  cause: CauseCode | null;
  /** Human next action for the cause, or null when unmapped. */
  nextAction: string | null;
}

/** Verdicts that never carry a cause: clean runs have nothing to explain. */
const CLEAN_VERDICTS: ReadonlySet<string> = new Set(['satisfied', 'waived']);

/**
 * Evidence-absence reasons produced by the built-in verifiers for a
 * CONNECTED test (a claim exists) whose required observations are
 * missing — the plan §5.4 `EVIDENCE_NOT_COLLECTED` shape ("a mapped test
 * lacks required observations"). Matched verbatim; each is emitted from
 * exactly one grading site. The last two are the crud session-channel
 * rules (plan Phase 1 item 8): a mutation performed outside the
 * supervised session channel (direct API/Node-side) and a journey that
 * never read the rendered result back.
 */
const EVIDENCE_NOT_COLLECTED_PATTERNS: readonly string[] = [
  'produced no evidence records',
  "no 'ui.action' anchor from the declaring test",
  'the witness observed no matching HTTP exchange',
  "no witnessed session-bound 'http.request' exchange",
  'no witnessed visible-result record',
  "no session-bound 'ui.action' anchor from the declaring test",
  "carries no witness session binding",
];

/**
 * The plan §5.4 exact-value echo violation (plan §3.6, implemented in
 * Phase 1): the persisted state does not echo the journey's entered
 * input on the same entity. Matched verbatim from the single grading
 * site in the persistence verifier (reused verbatim by the crud
 * session-channel verifier).
 */
const EVIDENCE_VALUE_MISMATCH_PATTERN = 'exact-value echo violation (EVIDENCE_VALUE_MISMATCH)';

/**
 * A crud session exchange that cannot be attributed because the host
 * supplied no route inventory (plan §9, D2): the proof channel the
 * contract needs is not wired into this setup. Scoped to the crud
 * namespace's wording so the http transport grader's own inventory
 * reason keeps its existing (unmapped) cause.
 */
const CRUD_INVENTORY_UNSUPPORTED_PATTERN = "no route inventory context for 'crud:";

/**
 * Maps one blocking verdict to its cause and next action (plan §5.4).
 * Deterministic and pure: identical inputs produce identical output.
 *
 * Mapping (Phase 0, extended in Phase 1):
 * - clean verdicts (`satisfied`, `waived`) → null cause;
 * - no capability record for the contract's namespace →
 *   VERIFIER_UNSUPPORTED (nothing is registered to prove it with);
 * - a registered namespace that does not implement the contract (e.g.
 *   `http:frontend-request-observed`, unknown `crud:*`/`http:*` names)
 *   or an unavailable namespace (the five domain namespaces) →
 *   VERIFIER_UNSUPPORTED;
 * - a supported contract whose reason reports the §3.6 exact-value echo
 *   violation → EVIDENCE_VALUE_MISMATCH;
 * - a crud claim whose session exchange cannot be attributed because the
 *   host supplied no route inventory → VERIFIER_UNSUPPORTED (the setup
 *   lacks the derived inventory the proof channel needs);
 * - a supported contract whose reason reports absent required
 *   observations (including the crud session-channel rules: direct
 *   mutation outside the session channel, no visible result, no
 *   session-bound anchor) → EVIDENCE_NOT_COLLECTED;
 * - `no claim declares '<id>'` → TEST_MAPPING_MISSING (no existing test
 *   is connected to the obligation; the Phase 2-3 mapping subsystem
 *   refines this into catalog-backed causes);
 * - anything else → null (precise single-cause reason; no guessed code).
 *
 * Args:
 *   params: obligationId, contract, verdict value, and engine reason of
 *     the report entry being rendered.
 *
 * Returns:
 *   VerdictCause: `{cause, nextAction}` — cause/nextAction are null when
 *   the verdict is clean or no honest mapping exists yet.
 */
export function causeForVerdict(params: {
  obligationId: string;
  contract: string;
  verdict: string;
  reason: string | null;
}): VerdictCause {
  if (CLEAN_VERDICTS.has(params.verdict)) return { cause: null, nextAction: null };
  const capability = capabilityFor(params.contract);
  const implemented = capability?.contracts.includes(params.contract) ?? false;
  if (capability === null || capability.availability.status === 'unavailable' || !implemented) {
    return nextActionFor('VERIFIER_UNSUPPORTED');
  }
  const reason = params.reason ?? '';
  if (reason.includes(EVIDENCE_VALUE_MISMATCH_PATTERN)) {
    return nextActionFor('EVIDENCE_VALUE_MISMATCH');
  }
  if (reason.includes(CRUD_INVENTORY_UNSUPPORTED_PATTERN)) {
    return nextActionFor('VERIFIER_UNSUPPORTED');
  }
  if (EVIDENCE_NOT_COLLECTED_PATTERNS.some((pattern) => reason.includes(pattern))) {
    return nextActionFor('EVIDENCE_NOT_COLLECTED');
  }
  if (reason === `no claim declares '${params.obligationId}'`) {
    return nextActionFor('TEST_MAPPING_MISSING');
  }
  return { cause: null, nextAction: null };
}

/** Pairs a cause with its frozen plan §5.4 next action. */
function nextActionFor(cause: CauseCode): VerdictCause {
  return { cause, nextAction: CAUSE_NEXT_ACTIONS[cause] };
}

/**
 * One precise capability gap (plan Phase 0 item 4, ADR 0005 D1/D5): a
 * required contract whose proof channel is unavailable. `detail` names
 * the contract, the missing observer, and the fail-closed consequence;
 * `nextAction` is always the plan §5.4 `VERIFIER_UNSUPPORTED` action.
 */
export interface CapabilityGap {
  /** The unsupported contract name. */
  contract: string;
  /** The independent observer channel whose absence blocks this contract. */
  observer: string;
  /** Single-cause precise explanation (fail-closed wording). */
  detail: string;
  /** Always `VERIFIER_UNSUPPORTED` (plan §5.4). */
  cause: Extract<CauseCode, 'VERIFIER_UNSUPPORTED'>;
  /** Plan §5.4 next action for an unsupported proof channel. */
  nextAction: string;
}

/**
 * Computes the capability gap for one contract, or null when the
 * contract's namespace is registered, available, and implements the
 * contract. Pure; reads only the capability registry (single source of
 * truth — no duplicated contract lists at call sites).
 *
 * Args:
 *   contract: the required contract name, e.g. `http:request-observed`.
 *
 * Returns:
 *   CapabilityGap | null: the gap, or null when the contract is provable.
 */
export function capabilityGap(contract: string): CapabilityGap | null {
  const capability = capabilityFor(contract);
  if (capability === null) {
    return {
      contract,
      observer: 'a registered semantic verifier and its independent observation channel',
      detail:
        `contract '${contract}' has no registered verifier or capability record: no honest ` +
        'proof channel exists, so obligations requiring it can never be satisfied',
      cause: 'VERIFIER_UNSUPPORTED',
      nextAction: CAUSE_NEXT_ACTIONS['VERIFIER_UNSUPPORTED'],
    };
  }
  if (capability.availability.status === 'unavailable') {
    return {
      contract,
      observer: capability.observer,
      detail:
        `contract '${contract}' is unprovable: its namespace '${capability.namespace}' is ` +
        `fail-closed (${capability.availability.reason}). Required observer: ${capability.observer}.`,
      cause: 'VERIFIER_UNSUPPORTED',
      nextAction: CAUSE_NEXT_ACTIONS['VERIFIER_UNSUPPORTED'],
    };
  }
  const unavailable = capability.unavailableContracts.find((entry) => entry.contract === contract);
  if (unavailable !== undefined) {
    return {
      contract,
      observer: capability.observer,
      detail:
        `contract '${contract}' is registered but unavailable: ${unavailable.reason}. ` +
        `Required observer: ${capability.observer}.`,
      cause: 'VERIFIER_UNSUPPORTED',
      nextAction: CAUSE_NEXT_ACTIONS['VERIFIER_UNSUPPORTED'],
    };
  }
  if (!capability.contracts.includes(contract)) {
    return {
      contract,
      observer: capability.observer,
      detail:
        `contract '${contract}' is not implemented by its namespace '${capability.namespace}': ` +
        `the namespace implements [${capability.contracts.join(', ')}]. No honest proof ` +
        'channel exists for this name',
      cause: 'VERIFIER_UNSUPPORTED',
      nextAction: CAUSE_NEXT_ACTIONS['VERIFIER_UNSUPPORTED'],
    };
  }
  return null;
}

/**
 * Preflight for strict setups (plan Phase 0 item 4): returns one gap per
 * obligation whose contract cannot be proven. A strict setup demanding an
 * unavailable contract must fail closed with these precise errors — it
 * cannot advertise an operational blocking E2E gate.
 *
 * Args:
 *   obligations: the obligations to preflight (`id` + `contract`).
 *
 * Returns:
 *   Array<CapabilityGap & {obligationId: string}>: one entry per
 *   unsupported obligation, sorted by obligation id (deterministic).
 */
export function strictCapabilityGaps(obligations: readonly {
  id: string;
  contract: string;
}[]): Array<CapabilityGap & { obligationId: string }> {
  const gaps: Array<CapabilityGap & { obligationId: string }> = [];
  for (const obligation of obligations) {
    const gap = capabilityGap(obligation.contract);
    if (gap === null) continue;
    gaps.push({
      ...gap,
      detail: `obligation '${obligation.id}': ${gap.detail}`,
      obligationId: obligation.id,
    });
  }
  return gaps.sort((a, b) =>
    a.obligationId < b.obligationId ? -1 : a.obligationId > b.obligationId ? 1 : 0,
  );
}
