/**
 * The carried EVIDENCE of a test-only re-seal.
 *
 * A re-seal carries two different things out of its parent run, and the
 * second one used to be missing: the parent's test OUTCOMES (which the
 * retained execution result already holds) and the parent's
 * WITNESS-ISSUED EVIDENCE — the records the witness stamped and the
 * claims that name them. Outcomes alone prove nothing to a grader: the
 * evaluator satisfies an obligation from a claim whose test holds a
 * witnessed record, so a re-seal that carried outcomes but dropped the
 * evidence graded every obligation only a carried test had proved as
 * `missing`, and the next `check --require-e2e` failed on evidence the
 * parent run had actually witnessed.
 *
 * This module owns that carry, and it owns it honestly:
 *
 * - The parent's evidence documents are read from the run state BEFORE
 *   the re-seal's own run overwrites them.
 * - The attestation that binds the parent's records is verified with the
 *   CONSUMER'S OWN KEY and must name the parent run and the parent
 *   input digest the parent document itself binds — and, when the parent
 *   document sealed one, must hash to that document's
 *   `evidenceAttestationDigest`. Evidence nobody attested is not carried
 *   at all (it would grade nothing anyway).
 * - Attribution is by the witness-issued test identity: a parent record
 *   or claim survives only when its `testId` is a CARRIED test's own
 *   identity, taken from the parent's execution result. A record of a
 *   test this run re-ran never survives — its fresh record replaced it,
 *   and a re-run that stopped proving anything leaves its obligation
 *   unproven.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  AttestationSchema,
  sha256Canonical,
  verifyAttestationMac,
  type ExecutionResult,
} from '@gate-forge/core';

/** The parent run's raw evidence documents, as the run state holds them. */
export interface ParentEvidenceDocuments {
  /** `records.json` of the parent run (witness-issued ledger). */
  records: unknown[];
  /** `claims.json` of the parent run (what the tests declared). */
  claims: unknown[];
  /** The parent's v2 attestation envelope from its run manifest. */
  attestation: unknown;
}

/** The parent's evidence, authenticated and reduced to what may be carried. */
export interface CarriedParentEvidence {
  /** The parent run's attested, witness-issued records. */
  records: unknown[];
  /** The parent run's claims (they are declarations, not evidence). */
  claims: unknown[];
  /** The parent's verified v2 attestation envelope. */
  attestation: unknown;
  /** Canonical digest of the retained attestation envelope. */
  attestationDigest: string | null;
  /** The parent run identity the envelope binds. */
  runId: string;
  /** The parent input digest the envelope binds. */
  inputDigest: string;
  /** Exactly the record ids the witness says it issued in that run. */
  recordIds: string[];
}

/**
 * The outcome of authenticating the parent evidence: the evidence
 * itself, a refusal in plain words (the caller prints one reason line),
 * or null when the parent run witnessed nothing at all and there is
 * nothing to carry.
 */
export type ParentEvidenceResult =
  | { ok: true; evidence: CarriedParentEvidence }
  | { ok: false; reason: string }
  | null;

function readJsonArrayFile(path: string): unknown[] {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function readJsonFile(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch {
    return null;
  }
}

function refuse(reason: string): { ok: false; reason: string } {
  return { ok: false, reason };
}

export function stringField(value: unknown, field: string): string | null {
  if (typeof value !== 'object' || value === null) return null;
  const raw = (value as Record<string, unknown>)[field];
  return typeof raw === 'string' && raw.length > 0 ? raw : null;
}

/**
 * Reads the parent run's evidence documents from the run state. Called
 * BEFORE the re-seal's own run overwrites them.
 *
 * Args:
 *   stateDir: absolute run-state directory.
 *
 * Returns:
 *   ParentEvidenceDocuments: the raw documents (empty arrays when absent).
 */
export function readParentEvidenceDocuments(stateDir: string): ParentEvidenceDocuments {
  const manifest = readJsonFile(join(stateDir, 'manifest.json'));
  const attestation =
    typeof manifest === 'object' && manifest !== null
      ? ((manifest as Record<string, unknown>)['attestation'] ?? null)
      : null;
  return {
    records: readJsonArrayFile(join(stateDir, 'records.json')),
    claims: readJsonArrayFile(join(stateDir, 'claims.json')),
    attestation,
  };
}

/**
 * Authenticates the parent run's evidence against the parent document.
 *
 * The parent document (a verified receipt or run record) already binds
 * the run identity, the input digest and — when the run fetched its
 * attestation live — the attestation's own digest. This function demands
 * exactly that agreement under the consumer's own witness verifier key,
 * and keeps only the records the attestation says the witness issued.
 *
 * Args:
 *   documents: the raw parent documents.
 *   parent: the run identity + input digest + attestation digest the
 *     verified parent document binds.
 *   verifierKeys: the consumer's witness verifier keys.
 *
 * Returns:
 *   CarriedParentEvidence | ParentEvidenceRefusal: the authenticated
 *     evidence, or the exact reason it cannot be carried.
 */
export function authenticateParentEvidence(
  documents: ParentEvidenceDocuments,
  parent: { runId: string; inputDigest: string; evidenceAttestationDigest: string | null },
  verifierKeys: readonly string[],
): ParentEvidenceResult {
  const parsed = AttestationSchema.safeParse(documents.attestation);
  if (!parsed.success) {
    // Nothing to carry is a legitimate outcome (a run that witnessed
    // nothing), never a refusal: the re-seal still re-runs and seals.
    return documents.records.length === 0 && documents.claims.length === 0
      ? null
      : refuse('its evidence carries no witness attestation envelope');
    return refuse('its evidence carries no witness attestation envelope');
  }
  const envelope = parsed.data;
  if (envelope.runId !== parent.runId || envelope.inputDigest !== parent.inputDigest) {
    return refuse('its evidence attestation names a different run or input digest than the parent document');
  }
  const attestationDigest = sha256Canonical(envelope as unknown as Record<string, never>);
  if (
    parent.evidenceAttestationDigest !== null &&
    parent.evidenceAttestationDigest !== attestationDigest
  ) {
    return refuse('its retained evidence does not match the attestation its document seals');
  }
  const body = {
    runId: envelope.runId,
    invocationId: envelope.invocationId,
    inputDigest: envelope.inputDigest,
    recordIds: envelope.recordIds,
  };
  if (!verifierKeys.some((key) => verifyAttestationMac(key, body, envelope.mac))) {
    return refuse('its evidence attestation does not verify with this keyring');
  }
  const attested = new Set(envelope.recordIds);
  const records = documents.records.filter(
    (record) =>
      stringField(record, 'runId') === envelope.runId &&
      attested.has(stringField(record, 'recordId') ?? ''),
  );
  return {
    ok: true,
    evidence: {
      records,
      claims: documents.claims,
      attestation: envelope,
      attestationDigest,
      runId: envelope.runId,
      inputDigest: envelope.inputDigest,
      recordIds: [...envelope.recordIds],
    },
  };
}

/**
 * The witness-issued identities of every test this re-seal CARRIES:
 * the parent outcomes whose file the change set cannot affect. Both
 * identities the parent's own execution result holds are included (the
 * logical key and the framework id), because a record is stamped with
 * whichever identity its session carried.
 *
 * Args:
 *   parentExecution: the parent run's sealed execution result.
 *   affectedFiles: the test files this run re-runs.
 *
 * Returns:
 *   Set<string>: the carried test identities.
 */
export function carriedTestIdentities(
  parentExecution: ExecutionResult,
  affectedFiles: readonly string[],
): Set<string> {
  const affected = new Set(affectedFiles);
  const identities = new Set<string>();
  for (const row of parentExecution.outcomes) {
    if (affected.has(row.file)) continue;
    const planned = parentExecution.planned.find((entry) => entry.logicalKey === row.logicalKey);
    identities.add(row.logicalKey);
    if (planned !== undefined && planned.frameworkId !== null) identities.add(planned.frameworkId);
  }
  return identities;
}

/**
 * The trusted-mapping identity of every carried test: the sidecar (or
 * native) key a claim for that test uses. A witness-issued record is
 * stamped with the CLAIMING test's identity, which for a mapped test is
 * the mapping key — not the runner's own id — so the carry must know it
 * too. The keys come from the sealed repository's own mapping
 * (`.gateforge/test-map.yml`, part of the input digest), never from the
 * records themselves.
 *
 * Args:
 *   files: the carried tests' files.
 *   entries: the repository's test-map entries (empty when it declares
 *     none).
 *
 * Returns:
 *   string[]: the mapping keys bound to a carried test's file.
 */
export function mappedTestIdentities(
  files: ReadonlySet<string>,
  entries: readonly { key: string; selector: { file: string } }[],
): string[] {
  return entries.filter((entry) => files.has(entry.selector.file)).map((entry) => entry.key);
}

/**
 * Reduces the parent evidence to what the carried tests actually proved.
 *
 * Args:
 *   evidence: the authenticated parent evidence.
 *   identities: the carried test identities.
 *
 * Returns:
 *   { records, claims }: the parent's records and claims whose
 *     witness-issued `testId` is a carried test's own identity.
 */
export function carriedEvidenceDocuments(
  evidence: CarriedParentEvidence,
  identities: ReadonlySet<string>,
): { records: unknown[]; claims: unknown[] } {
  const belongs = (document: unknown): boolean => {
    const testId = stringField(document, 'testId');
    return testId !== null && identities.has(testId);
  };
  return {
    records: evidence.records.filter(belongs),
    claims: evidence.claims.filter(belongs),
  };
}

/**
 * The record ids the CARRIED records carry — the exact set the parent
 * attestation must still vouch for when the evaluator grades the union.
 *
 * Args:
 *   records: the carried parent records.
 *
 * Returns:
 *   string[]: the witness-issued record ids, sorted and deduplicated.
 */
export function carriedRecordIds(records: readonly unknown[]): string[] {
  return [
    ...new Set(records.map((record) => stringField(record, 'recordId')).filter((id): id is string => id !== null)),
  ].sort();
}

/**
 * Canonical digest of the evidence union a re-seal seals: the parent's
 * carried records and claims together with the re-run's own. The
 * receipt binds it, and every consumer recomputes it from the retained
 * documents and the state evidence.
 *
 * Args:
 *   documents: the union's records and claims, exactly as they are
 *     written to the run state.
 *
 * Returns:
 *   string: the 64-hex digest.
 */
export function carriedEvidenceDigestOf(documents: { records: readonly unknown[]; claims: readonly unknown[] }): string {
  // Canonical order: the union is a SET (the run state writes it in the
  // order the evidence arrived), and both the sealing run and every
  // consumer must hash the same bytes for it.
  const key = (document: unknown): string =>
    `${stringField(document, 'recordId') ?? ''}\u0000${stringField(document, 'runId') ?? ''}`;
  const claimKey = (claim: unknown): string =>
    `${stringField(claim, 'obligationId') ?? ''}\u0000${stringField(claim, 'testId') ?? ''}`;
  return sha256Canonical({
    domain: 'gateforge.carried-evidence.v1',
    records: [...documents.records].sort((left, right) =>
      key(left) < key(right) ? -1 : key(left) > key(right) ? 1 : 0,
    ) as never,
    claims: [...documents.claims].sort((left, right) =>
      claimKey(left) < claimKey(right) ? -1 : claimKey(left) > claimKey(right) ? 1 : 0,
    ) as never,
  });
}