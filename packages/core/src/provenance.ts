/**
 * Witness provenance verification (pin #7, ADR 0001 D2c, GF-23).
 *
 * The witness derives every record id as `sha256(canonicalJson({
 * runId, obligationId, kind, testId, payload }))` (pin #1) — a
 * deterministic function of the record's identity alone. That makes
 * provenance CHECKABLE by any consumer without contacting the witness:
 * an entry that never passed through the service cannot carry a record
 * id that both recomputes correctly and appears in an AUTHENTICATED
 * copy of the witness-issued set.
 *
 * Three independent checks exist, and all must pass for witnessed tier:
 * 1. {@link isProvenancedRecord} — the record id recomputes from the
 *    record's own contents (structural integrity; catches arbitrary or
 *    transplanted hex ids). Verified here, in the engine, so every
 *    consumer of `evaluateObligation` gets it.
 * 2. Authenticated issuance membership — the id appears in a set whose
 *    integrity is protected by a secret the tested suite never
 *    receives: the witness's verifier key. The witness serves the live
 *    set at `GET /ledger-attestation` (verifier-key header) and stamps
 *    the durable manifest append with {@link ledgerMac}. Hash
 *    recomputation is public, and the run manifest lives in the
 *    suite-writable state directory, so PLAIN manifest membership is
 *    trustworthiness-neutral: a hostile suite can fabricate both the
 *    records and the id list, but it cannot produce a valid MAC for an
 *    id set the witness never attested.
 * 3. Run identity — record.runId equals the manifest's runId, so ids
 *    cannot be transplanted across runs.
 *
 * Enforcement lives in the CLI's provenance gate (packages/cli), which
 * owns the run manifest and the verifier key surface.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { canonicalJson, isJsonValue, sha256Canonical } from './canonical-json.js';
import { compareStrings } from './graph/util.js';
import type { RecordOrigin } from './schemas/evidence.js';

/** The record identity a witness hashes into the service-issued id. */
export interface RecordIdentity {
  /** Run manifest identity the record was issued under. */
  runId: string;
  /** Obligation the record evidences. */
  obligationId: string;
  /** Evidence kind (e.g. `ui.action`, `persistence.entity`). */
  kind: string;
  /** Witness-issued test attribution. */
  testId: string;
  /** Where the contents came from (drives the trust stamp at issuance). */
  origin: RecordOrigin;
  /** JSON-representable evidence payload. */
  payload: unknown;
}

/** Shape a 64-char lowercase hex record id must have. */
const RECORD_ID_PATTERN = /^[0-9a-f]{64}$/;

/**
 * Derives the service-issued record id: sha256 over the GF-canonical
 * JSON of exactly the identity fields (pin #1/#7). Deterministic and
 * stable across runs.
 *
 * Args:
 *   identity: runId, obligationId, kind, testId, origin, and payload.
 *
 * Returns:
 *   string: 64-char lowercase hex digest.
 *
 * Throws:
 *   TypeError: when the payload is not JSON-representable (the witness
 *   refuses to issue such records; callers issuing must too).
 */
export function recordIdOf(identity: {
  runId: string;
  obligationId: string;
  kind: string;
  testId: string;
  origin: RecordOrigin;
  payload: unknown;
}): string {
  if (!isJsonValue(identity.payload)) {
    throw new TypeError('recordIdOf: payload is not GF-canonical-JSON-representable');
  }
  if (identity.origin !== 'suite-submitted' && identity.origin !== 'engine-observed') {
    throw new TypeError('recordIdOf: origin must be suite-submitted or engine-observed');
  }
  return sha256Canonical({
    runId: identity.runId,
    obligationId: identity.obligationId,
    kind: identity.kind,
    testId: identity.testId,
    origin: identity.origin,
    payload: identity.payload,
  });
}

/**
 * Verifies a lenient record view against its own provenance (check 1):
 * the recordId must be 64-hex, every identity field present, and the
 * id must recompute from the contents. Adversary-controlled input can
 * never throw — any structural problem is `false` (the record then
 * demotes to claimed tier, GF-23).
 *
 * Args:
 *   record: an arbitrary record-shaped value (e.g. a `records.json`
 *     entry or a witness ledger row).
 *
 * Returns:
 *   boolean: true only when the record's own contents hash to its id.
 */
export function isProvenancedRecord(record: unknown): boolean {
  if (typeof record !== 'object' || record === null || Array.isArray(record)) {
    return false;
  }
  const candidate = record as Record<string, unknown>;
  const recordId = candidate['recordId'];
  if (typeof recordId !== 'string' || !RECORD_ID_PATTERN.test(recordId)) return false;
  const runId = candidate['runId'];
  const obligationId = candidate['obligationId'];
  const kind = candidate['kind'];
  const testId = candidate['testId'];
  if (
    typeof runId !== 'string' ||
    runId.length === 0 ||
    typeof obligationId !== 'string' ||
    obligationId.length === 0 ||
    typeof kind !== 'string' ||
    kind.length === 0 ||
    typeof testId !== 'string' ||
    testId.length === 0
  ) {
    return false;
  }
  const payload = candidate['payload'];
  if (!isJsonValue(payload)) return false;
  const origin = candidate['origin'];
  if (origin !== 'suite-submitted' && origin !== 'engine-observed') return false;
  try {
    return (
      recordIdOf({
        runId,
        obligationId,
        kind,
        testId,
        origin,
        payload,
      }) === recordId
    );
  } catch {
    return false;
  }
}

/**
 * True when a record asserts the witnessed tier AND its provenance
 * verifies ({@link isProvenancedRecord}). The single witnessed-tier
 * predicate for the engine and the reporter's trust display, so a
 * record can never display as witnessed while the engine would demote
 * it (or vice versa).
 *
 * Args:
 *   record: an arbitrary record-shaped value.
 *
 * Returns:
 *   boolean: witnessed tier with verified provenance.
 */
export function isWitnessedRecord(record: unknown): boolean {
  if (typeof record !== 'object' || record === null || Array.isArray(record)) {
    return false;
  }
  return (
    (record as Record<string, unknown>)['trust'] === 'witnessed' &&
    isProvenancedRecord(record)
  );
}

/** Shape a 64-char lowercase hex MAC must have. */
const MAC_PATTERN = /^[0-9a-f]{64}$/;

/**
 * Normalizes a record-id set for MAC computation: deduplicated and
 * sorted by codepoint, so the witness and every verifier hash the same
 * canonical list regardless of insertion or serialization order.
 */
function canonicalIdSet(recordIds: readonly string[]): string[] {
  return [...new Set(recordIds)].sort(compareStrings);
}

/**
 * Computes the witness-ledger MAC (pin #7): HMAC-SHA256 over the
 * GF-canonical JSON of `{runId, recordIds}` keyed by the witness's
 * VERIFIER KEY — a secret handed to the witness and the verifying CLI
 * by the run orchestrator, never to the tested suite (the suite's run
 * token authorizes submissions; it must not authorize attestation).
 * The MAC makes the durable, suite-writable manifest append tamper-
 * evident: changing one id, adding a forged id, or transplanting the
 * set across runs invalidates it.
 *
 * Args:
 *   verifierKey: the witness verifier secret (non-empty).
 *   runId: the run manifest identity binding the set to THIS run.
 *   recordIds: the issued record ids (normalized internally).
 *
 * Returns:
 *   string: 64-char lowercase hex HMAC.
 *
 * Throws:
 *   TypeError: when the verifier key is empty.
 */
export function ledgerMac(
  verifierKey: string,
  runId: string,
  recordIds: readonly string[],
): string {
  if (typeof verifierKey !== 'string' || verifierKey.length === 0) {
    throw new TypeError('ledgerMac: verifier key must be a non-empty string');
  }
  if (typeof runId !== 'string' || runId.length === 0) {
    throw new TypeError('ledgerMac: runId must be a non-empty string');
  }
  return createHmac('sha256', verifierKey)
    .update(canonicalJson({ runId, recordIds: canonicalIdSet(recordIds) }))
    .digest('hex');
}

/**
 * Verifies a ledger MAC ({@link ledgerMac}) in constant time where the
 * inputs allow it. Adversary-controlled input never throws.
 *
 * Args:
 *   verifierKey: the witness verifier secret (non-empty).
 *   runId: the run manifest identity the set claims.
 *   recordIds: the record-id set the MAC must cover (normalized
 *     internally, exactly like the witness computed it).
 *   mac: the claimed MAC (64-char lowercase hex).
 *
 * Returns:
 *   boolean: true only when the MAC verifies over the exact set.
 */
export function verifyLedgerMac(
  verifierKey: string,
  runId: string,
  recordIds: readonly string[],
  mac: unknown,
): boolean {
  if (typeof mac !== 'string' || !MAC_PATTERN.test(mac)) return false;
  try {
    const expected = Buffer.from(ledgerMac(verifierKey, runId, recordIds), 'hex');
    const claimed = Buffer.from(mac, 'hex');
    return expected.length === claimed.length && timingSafeEqual(expected, claimed);
  } catch {
    return false;
  }
}
