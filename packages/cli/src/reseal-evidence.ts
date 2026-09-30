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
 * - The evidence documents are read from the run state BEFORE the
 *   re-seal's own run overwrites them.
 * - A CHAIN of re-seals has more than one contributing run: the state
 *   holds a union whose records were issued under different run
 *   identities, each with its own witness envelope. Every envelope is
 *   verified with the CONSUMER'S OWN KEY, must name the run and input
 *   digest the contributing document binds, and — when that document
 *   sealed one — must hash to its `evidenceAttestationDigest`. A
 *   record is authorized only by the envelope of the run that issued
 *   it; nobody's envelope vouches for anybody else's records.
 * - Attribution is by the witness-issued test identity: a record or
 *   claim survives only when its `testId` is a CARRIED test's own
 *   identity. A record of a test this run re-ran never survives — its
 *   fresh record replaced it, and a re-run that stopped proving
 *   anything leaves its obligation unproven.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  AttestationSchema,
  sha256Canonical,
  verifyAttestationMac,
  type ExecutionResult,
} from '@gate-forge/core';

/** The evidence documents a run's state holds, before any carry. */
export interface ParentEvidenceDocuments {
  /** `records.json` of the run (witness-issued ledger). */
  records: unknown[];
  /** `claims.json` of the run (what the tests declared). */
  claims: unknown[];
}

/**
 * ONE run that contributed evidence to the state, with the witness
 * envelope that run issued. The contributing document (a verified
 * receipt or run record) binds the run identity, the input digest and
 * — when the run fetched its envelope live — the envelope's own digest.
 */
export interface EvidenceContributor {
  /** The run identity the contributing document binds. */
  runId: string;
  /** The input digest the contributing document binds. */
  inputDigest: string;
  /** The envelope digest the document seals, or null when it sealed none. */
  evidenceAttestationDigest: string | null;
  /** The envelope that run issued, exactly as the run state holds it. */
  attestation: unknown;
}

/** The authenticated evidence of every contributing run, as one union. */
export interface CarriedEvidenceSet {
  /** Every attested record, deduplicated by record id. */
  records: unknown[];
  /** Every claim (they are declarations, not evidence). */
  claims: unknown[];
  /**
   * One channel entry per contributing run: the envelope that issued
   * its records, with exactly the record ids it attests.
   */
  contributions: readonly CarriedEvidenceContribution[];
}

/** What the evaluator needs to authorize ONE contributing run's records. */
export interface CarriedEvidenceContribution {
  /** The witness envelope itself, exactly as the run state holds it. */
  attestation: unknown;
  /** The run identity that envelope binds. */
  runId: string;
  /** The input digest that envelope binds. */
  inputDigest: string;
  /** Exactly the record ids that envelope attests. */
  recordIds: readonly string[];
}

/**
 * The outcome of authenticating the carried evidence: the evidence
 * itself, or a refusal in plain words (the caller prints one reason
 * line). null is no longer an outcome: an evidence set with no
 * contributor is not evidence, and the caller decides what to do
 * about that.
 */
export type ParentEvidenceResult =
  | { ok: true; evidence: CarriedEvidenceSet }
  | { ok: false; reason: string };

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
 * Reads the evidence documents a run's state holds. Called BEFORE
 * the re-seal's own run overwrites them.
 *
 * Args:
 *   stateDir: absolute run-state directory.
 *
 * Returns:
 *   ParentEvidenceDocuments: the raw documents (empty arrays when absent).
 */
export function readParentEvidenceDocuments(stateDir: string): ParentEvidenceDocuments {
  return {
    records: readJsonArrayFile(join(stateDir, 'records.json')),
    claims: readJsonArrayFile(join(stateDir, 'claims.json')),
  };
}

/**
 * The witness envelope the run in this state fetched, from its run
 * manifest. Null when the run witnessed nothing.
 *
 * Args:
 *   stateDir: absolute run-state directory.
 *
 * Returns:
 *   unknown: the envelope document, or null.
 */
export function readRunAttestation(stateDir: string): unknown {
  const manifest = readJsonFile(join(stateDir, 'manifest.json'));
  if (typeof manifest !== 'object' || manifest === null) return null;
  return (manifest as Record<string, unknown>)['attestation'] ?? null;
}

/**
 * Authenticates the evidence of every contributing run against the
 * document that run sealed.
 *
 * Each contributing document already binds the run identity, the
 * input digest and — when that run fetched its attestation live — the
 * attestation's own digest. This function demands exactly that
 * agreement under the consumer's own witness verifier key, and keeps
 * only the records the attestations say the witness issued, each run's
 * records under that run's envelope.
 *
 * Args:
 *   documents: the raw evidence documents (the union in the run state).
 *   contributors: one entry per run that contributed evidence, the
 *     parent itself first.
 *   verifierKeys: the consumer's witness verifier keys.
 *
 * Returns:
 *   CarriedEvidenceSet | ParentEvidenceRefusal: the authenticated
 *     union, or the exact reason it cannot be carried.
 */
export function authenticateContributingEvidence(
  documents: ParentEvidenceDocuments,
  contributors: readonly EvidenceContributor[],
  verifierKeys: readonly string[],
): ParentEvidenceResult {
  const records: unknown[] = [];
  const seen = new Set<string>();
  const contributions: CarriedEvidenceContribution[] = [];
  for (const contributor of contributors) {
    const parsed = AttestationSchema.safeParse(contributor.attestation);
    if (!parsed.success) return refuse('its evidence carries no witness attestation envelope');
    const envelope = parsed.data;
    if (envelope.runId !== contributor.runId || envelope.inputDigest !== contributor.inputDigest) {
      return refuse('its evidence attestation names a different run or input digest than the parent document');
    }
    if (
      contributor.evidenceAttestationDigest !== null &&
      contributor.evidenceAttestationDigest !== sha256Canonical(envelope as unknown as Record<string, never>)
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
    for (const record of documents.records) {
      const recordId = stringField(record, 'recordId');
      if (recordId === null || seen.has(recordId)) continue;
      if (stringField(record, 'runId') !== envelope.runId || !attested.has(recordId)) continue;
      seen.add(recordId);
      records.push(record);
    }
    contributions.push({
      attestation: envelope,
      runId: envelope.runId,
      inputDigest: envelope.inputDigest,
      recordIds: [...envelope.recordIds],
    });
  }
  return { ok: true, evidence: { records, claims: documents.claims, contributions } };
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
 * Reduces the carried evidence to what the carried tests actually
 * proved.
 *
 * Args:
 *   evidence: the authenticated evidence union.
 *   identities: the carried test identities.
 *
 * Returns:
 *   { records, claims }: the records and claims whose witness-issued
 *     `testId` is a carried test's own identity.
 */
export function carriedEvidenceDocuments(
  evidence: { records: readonly unknown[]; claims: readonly unknown[] },
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
 * attestations must still vouch for when the evaluator grades the union.
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
