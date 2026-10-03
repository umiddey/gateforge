/**
 * Re-sealed receipt verification (plan phase 3, design rule 8): a
 * receipt that claims `changeClass: 'test-only'` is a CLAIM, and every
 * consumer recomputes it from the sealed bytes with its OWN engine and
 * key. Nothing here trusts a field: the retained parent chain is
 * authenticated hop by hop, the tree difference is re-diffed, the
 * change set is re-classified from the catalog the run itself planned
 * from, and the affected set is recomputed and matched against the
 * fresh outcomes. Any mismatch is `EVIDENCE_STALE` with the exact
 * reason — a re-seal is never half-believed.
 *
 * The chain is retained as additive run-state files (never inside the
 * sealed candidate tree): one hop directory per consecutive re-seal,
 * holding the parent receipt, the parent execution result needed to
 * verify it, and the catalog of the child tree the classification is
 * recomputed with. Every one of those documents is authenticated by a
 * digest the receipts already bind (`resealedFrom`,
 * `executionResultDigest`, `catalogDigest`).
 */
import { mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CAUSE_NEXT_ACTIONS,
  ExecutionResultSchema,
  AttestationSchema,
  GateReceiptSchema,
  TestCatalogSchema,
  executionResultDigestOf,
  sha256Canonical,
  type BlockingEntry,
  type ExecutionResult,
  type GateReceipt,
  type TestCatalog,
  type RunRecord,
  testOutcomesDigestOf,
} from '@gate-forge/core';
import { loadOptionalTestMap } from './mapping.js';
import { classifyResealChange, diffSealedTrees, resealRefusalVerdict } from './reseal.js';
import {
  authenticateContributingEvidence,
  carriedEvidenceDigestOf,
  carriedEvidenceDocuments,
  carriedTestIdentities,
  mappedTestIdentities,
  stringField,
  type CarriedEvidenceContribution,
  type CarriedEvidenceSet,
  type EvidenceContributor,
} from './reseal-evidence.js';
import { readJsonArray, readStateDocument } from './state.js';
import { verifyGateReceiptWithKeyring, verifyRunRecordWithKeyring, type VerifierKeyring } from './verifier-keys.js';

/** Run-state subdirectory holding the retained re-seal chain. */
export const RESEAL_CHAIN_DIRECTORY = 'reseal-chain';

/**
 * How many consecutive re-seals a receipt may carry. Each hop re-runs
 * only the tests its change set can affect, so the drift a chain can
 * accumulate is bounded; past the bound the only honest answer is a
 * full run.
 */
export const RESEAL_CHAIN_MAX_HOPS = 5;

/**
 * One retained hop: the parent a re-seal carried from, plus the catalog
 * its classification used and the witness EVIDENCE its carried tests
 * were proven with.
 */
export interface ResealChainHop {
  /** The parent receipt document, exactly as it was issued (null for a run-record parent). */
  receipt: unknown;
  /** The parent run record, exactly as it was issued (null for a receipt parent). */
  runRecord: unknown;
  /** The parent execution result bound by that receipt or record. */
  execution: unknown;
  /** The test catalog of the CHILD tree (the re-sealed candidate). */
  catalog: unknown;
  /** The parent run's witness-issued records (the ledger copy it graded). */
  records: unknown;
  /** The parent run's claims. */
  claims: unknown;
  /**
   * The witness attestation envelopes of every run that contributed to
   * the evidence above, the parent itself first. A chain of re-seals
   * carries a union, and each run's records are authorized only by the
   * envelope that run's witness issued.
   */
  attestations: unknown[];
}

function hopFileNames(hop: number): [string, string, string, string, string, string, string] {
  return [
    `hop-${String(hop)}-receipt.json`,
    `hop-${String(hop)}-run-record.json`,
    `hop-${String(hop)}-execution-result.json`,
    `hop-${String(hop)}-catalog.json`,
    `hop-${String(hop)}-records.json`,
    `hop-${String(hop)}-claims.json`,
    `hop-${String(hop)}-attestations.json`,
  ];
}

/**
 * Moves every retained hop one place back so hop 1 is free for the
 * hop about to be written.
 *
 * Args:
 *   directory: the chain directory.
 *   retained: how many hops are currently retained.
 *
 * Returns:
 *   void.
 */
function shiftResealChain(directory: string, retained: number): void {
  for (let index = retained; index >= 1; index -= 1) {
    const from = hopFileNames(index);
    const to = hopFileNames(index + 1);
    for (let file = 0; file < from.length; file += 1) {
      const source = join(directory, from[file] as string);
      try {
        renameSync(source, join(directory, to[file] as string));
      } catch {
        // A missing member makes the chain unreadable, which the
        // verifier rejects; nothing to repair here.
      }
    }
  }
}

/**
 * Retains the parent run's evidence BEFORE the re-seal's own run
 * overwrites `records.json`, `claims.json` and the run manifest, and
 * shifts the existing chain one place back at the same moment: the hop
 * being built IS the chain's new hop 1, so an earlier hop must never
 * keep the evidence written for it. The hop's parent document,
 * execution result and catalog are written when the receipt seals, and
 * a run that seals nothing leaves no hop-1 parent behind, so a stale
 * evidence file is never read as a chain.
 *
 * Args:
 *   stateDir: absolute run-state directory.
 *   evidence: the authenticated parent records, claims and attestation.
 *
 * Returns:
 *   void.
 */
export function writeResealChainParentEvidence(
  stateDir: string,
  evidence: { records: readonly unknown[]; claims: readonly unknown[]; attestations: readonly unknown[] },
): void {
  const directory = join(stateDir, RESEAL_CHAIN_DIRECTORY);
  mkdirSync(directory, { recursive: true });
  shiftResealChain(directory, resealChainHopCount(stateDir));
  const [, , , , recordsName, claimsName, attestationsName] = hopFileNames(1);
  writeFileSync(join(directory, recordsName), `${JSON.stringify(evidence.records, null, 2)}\n`, 'utf8');
  writeFileSync(join(directory, claimsName), `${JSON.stringify(evidence.claims, null, 2)}\n`, 'utf8');
  writeFileSync(join(directory, attestationsName), `${JSON.stringify(evidence.attestations, null, 2)}\n`, 'utf8');
}

/**
 * True when a hop retains a run record as its parent. Only the
 * IMMEDIATE parent of a re-seal can be a run record: the parent it
 * produces is a gate receipt, and a receipt is the only document a
 * later hop may carry from.
 */
function hopCarriesRunRecord(hop: ResealChainHop): boolean {
  return hop.runRecord !== null && hop.runRecord !== undefined;
}

/**
 * Counts the consecutive re-seals already retained in the run state.
 *
 * Args:
 *   stateDir: absolute run-state directory.
 *
 * Returns:
 *   number: the highest contiguous hop index (0 when no hop is retained).
 */
export function resealChainHopCount(stateDir: string): number {
  let names: string[];
  try {
    names = readdirSync(join(stateDir, RESEAL_CHAIN_DIRECTORY));
  } catch {
    return 0;
  }
  let hop = 0;
  for (;;) {
    const [receiptName, runRecordName] = hopFileNames(hop + 1);
    if (!names.includes(receiptName) && !names.includes(runRecordName)) return hop;
    hop += 1;
  }
}

/**
 * Retains one re-seal hop as hop 1 of the chain. The chain was already
 * shifted when the parent evidence was retained (that is the same
 * hop), so this only writes the hop's own members.
 *
 * Args:
 *   stateDir: absolute run-state directory.
 *
 *   hop: the parent receipt OR run record, its execution result, and
 *     the catalog of the tree this re-seal sealed.
 *
 * Returns:
 *   void.
 */
export function writeResealChainHop(stateDir: string, hop: ResealChainHop): void {
  const directory = join(stateDir, RESEAL_CHAIN_DIRECTORY);
  mkdirSync(directory, { recursive: true });
  const [receiptName, runRecordName, executionName, catalogName, recordsName, claimsName, attestationsName] =
    hopFileNames(1);
  writeFileSync(join(directory, receiptName), `${JSON.stringify(hop.receipt, null, 2)}\n`, 'utf8');
  writeFileSync(join(directory, executionName), `${JSON.stringify(hop.execution, null, 2)}\n`, 'utf8');
  writeFileSync(join(directory, catalogName), `${JSON.stringify(hop.catalog, null, 2)}\n`, 'utf8');
  writeFileSync(join(directory, recordsName), `${JSON.stringify(hop.records, null, 2)}\n`, 'utf8');
  writeFileSync(join(directory, claimsName), `${JSON.stringify(hop.claims, null, 2)}\n`, 'utf8');
  writeFileSync(join(directory, attestationsName), `${JSON.stringify(hop.attestations, null, 2)}\n`, 'utf8');
  // A leftover run record from an earlier chain would be read as this
  // hop's parent, so the absent member is removed rather than left.
  if (hopCarriesRunRecord(hop)) {
    writeFileSync(join(directory, runRecordName), `${JSON.stringify(hop.runRecord, null, 2)}\n`, 'utf8');
  } else {
    rmSync(join(directory, runRecordName), { force: true });
  }
}

/**
 * Drops every retained hop (a run that sealed an ordinary receipt has no
 * re-seal chain, and a stale chain would be read as one).
 *
 * Args:
 *   stateDir: absolute run-state directory.
 *
 * Returns:
 *   void.
 */
export function clearResealChain(stateDir: string): void {
  rmSync(join(stateDir, RESEAL_CHAIN_DIRECTORY), { recursive: true, force: true });
}

/** Reads the retained hops, stopping at the first missing member (fail closed). */
function readResealChain(stateDir: string): ResealChainHop[] {
  const hops: ResealChainHop[] = [];
  for (let index = 1; ; index += 1) {
    const [receiptName, runRecordName, executionName, catalogName, recordsName, claimsName, attestationsName] =
      hopFileNames(index);
    const directory = join(stateDir, RESEAL_CHAIN_DIRECTORY);
    const receipt = readStateDocument(directory, receiptName);
    const runRecord = readStateDocument(directory, runRecordName);
    if (receipt === null && runRecord === null) return hops;
    const execution = readStateDocument(directory, executionName);
    const catalog = readStateDocument(directory, catalogName);
    const records = readStateDocument(directory, recordsName);
    const claims = readStateDocument(directory, claimsName);
    const attestations = readStateDocument(directory, attestationsName);
    const envelopes = Array.isArray(attestations) ? attestations : [];
    if (execution === null || catalog === null) {
      return [...hops, { receipt, runRecord, execution: null, catalog: null, records, claims, attestations: envelopes }];
    }
    hops.push({ receipt, runRecord, execution, catalog, records, claims, attestations: envelopes });
  }
}

/**
 * The carried-evidence channels a GRADER needs for a re-sealed run:
 * one per run that contributed to the retained evidence union, each
 * naming the identity, input digest and record ids the contributing
 * document binds. Nothing here is trusted — every envelope's MAC is
 * verified inside the evaluator and the whole chain is recomputed by
 * `resealChainBlocking` — this only tells the grader which envelope
 * belongs to which run of the chain it is grading.
 *
 * Args:
 *   stateDir: absolute run-state directory.
 *
 * Returns:
 *   the channels, or null when the state holds no re-sealed receipt,
 *   no retained hop, or no envelope to carry.
 */
export function retainedCarriedEvidence(stateDir: string): CarriedEvidenceContribution[] | null {
  const receipt = readStateDocument(stateDir, 'receipt.json');
  if (stringField(receipt, 'resealedFrom') === null) return null;
  const chain = readResealChain(stateDir);
  const contributions: CarriedEvidenceContribution[] = [];
  for (const hop of chain) {
    const parent = hopCarriesRunRecord(hop) ? hop.runRecord : hop.receipt;
    const runId = stringField(parent, 'runId');
    const inputDigest = stringField(parent, 'inputDigest');
    if (runId === null || inputDigest === null) continue;
    for (const attestation of hop.attestations) {
      const parsed = AttestationSchema.safeParse(attestation);
      if (!parsed.success) continue;
      contributions.push({
        attestation,
        runId,
        inputDigest,
        recordIds: [...parsed.data.recordIds],
      });
    }
  }
  return contributions.length === 0 ? null : contributions;
}

/**
 * Every run that contributed evidence to the state a re-seal is about
 * to carry from, the parent document first: the parent plus its own
 * run manifest envelope, then one per retained hop, each with the
 * document that binds it and the envelope that run issued. The
 * documents are authenticated with the consumer's own keyring, so a
 * retained file nobody signed contributes nothing.
 *
 * Args:
 *   stateDir: absolute run-state directory.
 *   parent: the verified parent document of the re-seal.
 *   parentAttestation: the envelope the parent's own run fetched.
 *   verifierKeyring: the consumer's own trusted key ring.
 *
 * Returns:
 *   the contributors, or the first binding that failed in plain words.
 */
export function retainedEvidenceContributors(input: {
  stateDir: string;
  parent: { kind: 'receipt' | 'run-record'; receipt: GateReceipt | null; record: RunRecord | null };
  parentAttestation: unknown;
  verifierKeyring: VerifierKeyring | null;
}): { contributors: EvidenceContributor[]; reason: string | null } {
  if (input.verifierKeyring === null) {
    return { contributors: [], reason: 'no verifier key is available to authenticate it' };
  }
  const parentDocument = input.parent.record ?? input.parent.receipt;
  const contributors: EvidenceContributor[] = [
    {
      runId: stringField(parentDocument, 'runId') ?? '',
      inputDigest: stringField(parentDocument, 'inputDigest') ?? '',
      evidenceAttestationDigest: stringField(parentDocument, 'evidenceAttestationDigest'),
      attestation: input.parentAttestation,
    },
  ];
  const chain = readResealChain(input.stateDir);
  // EVERY retained hop contributed evidence the state still holds: the
  // parent itself is the receipt it sealed, and the hops behind it are
  // the runs whose records that receipt had already carried. Each is
  // authenticated with its own document, and only that run's envelope
  // authorizes its own records.
  for (const hop of chain) {
    const document = hopCarriesRunRecord(hop) ? hop.runRecord : hop.receipt;
    const authenticated = hopCarriesRunRecord(hop)
      ? verifyRunRecordWithKeyring(input.verifierKeyring, hop.runRecord)
      : verifyGateReceiptWithKeyring(input.verifierKeyring, hop.receipt);
    if (!authenticated.ok) {
      return {
        contributors: [],
        reason: `the run it carried from does not authenticate with this keyring: ${authenticated.detail}`,
      };
    }
    contributors.push({
      runId: stringField(document, 'runId') ?? '',
      inputDigest: stringField(document, 'inputDigest') ?? '',
      evidenceAttestationDigest: stringField(document, 'evidenceAttestationDigest'),
      attestation: hop.attestations[0] ?? null,
    });
  }
  return { contributors, reason: null };
}

/**
 * The tests a re-seal carries, read from the retained chain: a test
 * carries when NO hop of the chain re-ran it, so the evidence of the
 * original run survives for exactly those. A parent that is itself a
 * re-seal planned only the tests IT re-ran, so its own plan cannot
 * count the rest; the chain can.
 *
 * Args:
 *   stateDir: absolute run-state directory holding the retained chain.
 *   childFiles: the test files this run re-runs (the immediate
 *     child's affected set).
 *
 * Returns:
 *   the carried files, identities and count, or null when the state
 *   retains no chain at all (a whole-suite parent counts from its own
 *   plan, exactly as before). A hop whose execution result is
 *   unreadable carries nothing (fail closed).
 */
export function retainedChainCarriedTests(input: {
  stateDir: string;
  childFiles: readonly string[];
}): { files: Set<string>; identities: Set<string>; count: number } | null {
  const chain = readResealChain(input.stateDir);
  if (chain.length === 0) return null;
  const rerun = new Set(input.childFiles);
  const files = new Set<string>();
  const identities = new Set<string>();
  let count = 0;
  for (const hop of chain) {
    const parsed = ExecutionResultSchema.safeParse(hop.execution);
    if (!parsed.success) return { files: new Set(), identities: new Set(), count: 0 };
    const execution = parsed.data as ExecutionResult;
    const carried = execution.outcomes.filter((outcome) => !rerun.has(outcome.file));
    count += carried.length;
    for (const outcome of carried) files.add(outcome.file);
    for (const identity of carriedTestIdentities(execution, [...rerun])) identities.add(identity);
    for (const outcome of execution.outcomes) rerun.add(outcome.file);
  }
  return { files, identities, count };
}

/**
 * One typed `EVIDENCE_STALE` entry naming the exact mismatch; the
 * caller prefixes it with its own surface (`require-e2e: `, `broker: `).
 */
function stale(detail: string): BlockingEntry[] {
  return [
    {
      kind: 'finding',
      resourceId: null,
      name: null,
      detail,
      location: null,
      cause: 'EVIDENCE_STALE',
      nextAction: CAUSE_NEXT_ACTIONS['EVIDENCE_STALE'],
    },
  ];
}

/**
 * The repository's own test-map entries, read from the candidate tree
 * this consumer is verifying (a sealed file inside the input digest).
 * An unreadable or absent sidecar contributes no entries — the union
 * comparison then fails closed rather than inventing an identity.
 *
 * Args:
 *   cwd: the repository root.
 *
 * Returns:
 *   the entries (empty when the repository declares none).
 */
function testMapEntries(cwd: string): readonly { key: string; selector: { file: string } }[] {
  try {
    return loadOptionalTestMap(cwd)?.tests ?? [];
  } catch {
    return [];
  }
}

function names(paths: readonly string[]): string {
  return paths.length === 0 ? '<none>' : paths.join(', ');
}

/**
 * Recomputes — with the consumer's own engine, keyring and object store
 * — everything a re-sealed receipt claims, hop by hop. A receipt that
 * is not a re-seal returns no blockers; every mismatch, missing
 * document or unreadable parent returns one `EVIDENCE_STALE` entry
 * naming the exact difference.
 *
 * Args:
 *   stateDir: absolute run-state directory holding receipt.json,
 *     execution-result.json and the retained chain.
 *   receipt: the verified receipt under inspection.
 *   verifierKeyring: the consumer's own keyring (the parent is
 *     authenticated with it, never with the candidate's key).
 *   gitDir: the consumer's object store, holding both sealed trees.
 *   cwd: the repository root (import-graph alias resolution).
 *   env: the process environment (Git redirectors are stripped).
 *
 * Returns:
 *   BlockingEntry[]: empty when the re-seal recomputes exactly, else one
 *   typed `EVIDENCE_STALE` blocker.
 */

/**
 * The evidence contributors of one hop and every hop below it: the
 * document each hop retained, paired with the witness envelope that
 * run issued. The evidence those documents hold is a union, so every
 * one of them must authenticate for any of it to carry.
 *
 * Args:
 *   chain: the retained hops, innermost first.
 *   index: the hop whose evidence is being authenticated.
 *
 * Returns:
 *   the contributors, or null when a contributing hop retained no
 *   envelope at all (fail closed).
 */
function chainContributors(chain: readonly ResealChainHop[], index: number): EvidenceContributor[] | null {
  const contributors: EvidenceContributor[] = [];
  for (let position = index; position < chain.length; position += 1) {
    const hop = chain[position] as ResealChainHop;
    const document = hopCarriesRunRecord(hop) ? hop.runRecord : hop.receipt;
    const attestation = hop.attestations[0] ?? null;
    if (attestation === null) return null;
    contributors.push({
      runId: stringField(document, 'runId') ?? '',
      inputDigest: stringField(document, 'inputDigest') ?? '',
      evidenceAttestationDigest: stringField(document, 'evidenceAttestationDigest'),
      attestation,
    });
  }
  return contributors;
}
export function resealChainBlocking(input: {
  stateDir: string;
  receipt: GateReceipt;
  verifierKeyring: VerifierKeyring | null;
  gitDir: string | null;
  cwd: string;
  env: NodeJS.ProcessEnv;
  /**
   * The owner-declared runtime files (`enforcement.resealRuntimeFiles`)
   * the candidate config carries, applied to the recomputation exactly
   * as the sealing run applied them. Absent or empty changes nothing.
   */
  runtimeFileGlobs?: readonly string[];
}): BlockingEntry[] {
  const child = input.receipt;
  if (child.resealedFrom === undefined) return [];
  if (input.verifierKeyring === null || input.gitDir === null) {
    return stale(
      'this consumer has no verifier keyring or object store, so the re-seal cannot be recomputed (fail closed)',
    );
  }
  const chain = readResealChain(input.stateDir);
  if (chain.length === 0) {
    return stale(
      `the re-sealed receipt names parent ${child.resealedFrom} but the run state retains no parent receipt (fail closed)`,
    );
  }
  if (chain.length > RESEAL_CHAIN_MAX_HOPS) {
    return stale(
      `the re-sealed receipt carries ${String(chain.length)} consecutive re-seals, past the bound of ` +
        `${String(RESEAL_CHAIN_MAX_HOPS)} — run the full suite`,
    );
  }
  const childExecutionParsed = ExecutionResultSchema.safeParse(
    readStateDocument(input.stateDir, 'execution-result.json'),
  );
  if (!childExecutionParsed.success) {
    return stale('the re-sealed receipt binds no readable execution result (fail closed)');
  }
  const childExecution = childExecutionParsed.data as ExecutionResult;
  if (executionResultDigestOf(childExecution) !== child.executionResultDigest) {
    return stale('the re-sealed receipt\'s execution result no longer matches its bound digest (fail closed)');
  }

  // Walk outward: hop 1 is the immediate parent of the receipt under
  // inspection, hop 2 the parent of that receipt, and so on.
  let currentReceipt: GateReceipt = child;
  let currentExecution = childExecution;
  // What the whole chain carries: the count and the identities of the
  // tests NO hop re-ran. `reranFiles` grows with every fresh outcome the
  // walk sees, so an outer hop's carry is reduced by what an inner hop
  // already re-ran — a test is carried once, by the whole chain.
  const reranFiles = new Set<string>();
  let carriedTotal = 0;
  const carriedFiles = new Set<string>();
  const carriedIdentities = new Set<string>();
  // Hop 1's authenticated evidence, kept for the state-evidence union
  // check the walk can only make once every hop has contributed.
  let hopOneEvidence: CarriedEvidenceSet | null = null;
  for (let index = 0; index < chain.length; index += 1) {
    const childFiles = new Set(currentExecution.outcomes.map((outcome) => outcome.file));
    const hop = chain[index] as ResealChainHop;
    if (hop.execution === null || hop.catalog === null) {
      return stale(
        `re-seal hop ${String(index + 1)} retains no parent execution result or catalog (fail closed)`,
      );
    }
    const parentExecutionParsed = ExecutionResultSchema.safeParse(hop.execution);
    if (!parentExecutionParsed.success) {
      return stale(`re-seal hop ${String(index + 1)} retains a malformed parent execution result (fail closed)`);
    }
    const parentExecution = parentExecutionParsed.data as ExecutionResult;
    const catalogParsed = TestCatalogSchema.safeParse(hop.catalog);
    if (!catalogParsed.success) {
      return stale(`re-seal hop ${String(index + 1)} retains a malformed test catalog (fail closed)`);
    }
    const catalog = catalogParsed.data as TestCatalog;

    // The parent is whatever the child CLAIMS it is, and the claim must
    // match what the chain retains: a hop holding a run record never
    // stands in for a receipt parent, or the reverse.
    const hopNumber = String(index + 1);
    const claimedKind = currentReceipt.resealedFromKind ?? 'receipt';
    const retainedKind: 'receipt' | 'run-record' = hopCarriesRunRecord(hop) ? 'run-record' : 'receipt';
    if (claimedKind !== retainedKind) {
      return stale(
        `re-seal hop ${hopNumber} claims a ${claimedKind} parent but the run state retains a ${retainedKind} ` +
          '(fail closed)',
      );
    }
    let parentDigest: string;
    let parentTreeId: string | null;
    let parentSha: string | null;
    let parentReceipt: GateReceipt | null = null;
    if (retainedKind === 'run-record') {
      // A run-record parent is recomputed exactly like a parent
      // receipt: it must authenticate with the consumer's own keyring,
      // it must name this very execution result and its outcomes, and
      // its engine bundle, execution boundary and trusted policy must
      // be the ones the re-sealed receipt itself binds.
      const authenticatedRecord = verifyRunRecordWithKeyring(input.verifierKeyring, hop.runRecord);
      if (!authenticatedRecord.ok) {
        return stale(
          `re-seal hop ${hopNumber}'s parent run record does not authenticate with this keyring: ` +
            `${authenticatedRecord.detail} (fail closed)`,
        );
      }
      const record = authenticatedRecord.record;
      if (
        executionResultDigestOf(parentExecution) !== record.executionResultDigest ||
        testOutcomesDigestOf(parentExecution.outcomes) !== record.testOutcomesDigest ||
        record.plannedTests !== parentExecution.planned.length
      ) {
        return stale(
          `re-seal hop ${hopNumber}'s parent execution result does not match the run record's bound digests ` +
            '(fail closed)',
        );
      }
      if (
        record.engineBundleDigest !== currentReceipt.engineBundleDigest ||
        record.executionBoundaryDigest !== currentReceipt.executionBoundaryDigest ||
        record.trustedPolicyDigest !== currentReceipt.trustedPolicyDigest
      ) {
        return stale(
          `re-seal hop ${hopNumber}'s parent run record was sealed under a different engine bundle, execution ` +
            'boundary or trusted policy than the receipt it parented (fail closed)',
        );
      }
      parentDigest = sha256Canonical(record as unknown as Record<string, never>);
      parentTreeId = record.candidateTreeId;
      parentSha = record.gitSha;
    } else {
      const parentParsed = GateReceiptSchema.safeParse(hop.receipt);
      if (!parentParsed.success) {
        return stale(`re-seal hop ${hopNumber} retains a malformed parent receipt (fail closed)`);
      }
      const parent = parentParsed.data as GateReceipt;
      const authenticated = verifyGateReceiptWithKeyring(input.verifierKeyring, hop.receipt);
      if (!authenticated.ok) {
        return stale(
          `re-seal hop ${hopNumber}'s parent receipt does not authenticate with this keyring: ` +
            `${authenticated.detail} (fail closed)`,
        );
      }
      if (executionResultDigestOf(parentExecution) !== parent.executionResultDigest) {
        return stale(
          `re-seal hop ${hopNumber}'s parent execution result does not match its receipt digest (fail closed)`,
        );
      }
      parentReceipt = parent;
      parentDigest = sha256Canonical(parent as unknown as Record<string, never>);
      parentTreeId = parent.candidateTreeId;
      parentSha = parent.gitSha;
    }
    if (parentDigest !== currentReceipt.resealedFrom) {
      return stale(
        `re-seal hop ${hopNumber} names parent ${String(currentReceipt.resealedFrom)} but the retained ` +
          `parent ${retainedKind} hashes to ${parentDigest} (fail closed)`,
      );
    }
    if (sha256Canonical(catalog as unknown as Record<string, never>) !== currentExecution.catalogDigest) {
      return stale(
        `re-seal hop ${String(index + 1)}'s retained catalog does not match the catalog digest the re-seal ` +
          'planned from (fail closed)',
      );
    }
    if (parentTreeId === null || currentReceipt.candidateTreeId === null) {
      return stale(`re-seal hop ${hopNumber} has no sealed candidate tree on one side (fail closed)`);
    }
    const changed = diffSealedTrees(
      input.gitDir,
      input.env,
      parentTreeId,
      currentReceipt.candidateTreeId,
    );
    if (changed === null) {
      return stale(
        `re-seal hop ${hopNumber}: the sealed trees ${parentTreeId} → ` +
          `${currentReceipt.candidateTreeId} could not be diffed (fail closed)`,
      );
    }
    const diffPaths = changed.map((entry) => entry.path).sort();
    const claimed = [...(currentReceipt.changedPaths ?? [])].sort();
    if (
      diffPaths.length !== claimed.length ||
      diffPaths.some((path, position) => path !== claimed[position])
    ) {
      return stale(
        `re-sealed receipt names changed paths ${names(claimed)} but the trees differ in ${names(diffPaths)}`,
      );
    }
    // The two commit trees say which paths are TRACKED, and that single
    // reading serves both decisions this recomputation makes: the owner
    // declaration may hide only an untracked path, and a declared browser
    // state counts as generated output only when neither commit tracks
    // it. Both are applied here exactly as the sealing run applied them,
    // so CI reaches the identical decision with its own engine. A
    // document that names no commit has no committed file list, so
    // nothing can be proven untracked: the classifier then disregards
    // nothing, treats no state as generated, and a receipt that claims
    // either is stale below.
    const commitTrees =
      parentSha !== null && currentReceipt.gitSha !== null
        ? { parentCommitTreeId: `${parentSha}^{tree}`, currentCommitTreeId: `${currentReceipt.gitSha}^{tree}` }
        : {};
    const classification = classifyResealChange({
      gitDir: input.gitDir,
      env: input.env,
      cwd: input.cwd,
      parentTreeId: parentTreeId,
      currentTreeId: currentReceipt.candidateTreeId,
      testFiles: [...new Set(catalog.entries.map((entry) => entry.file))],
      runtimeFileGlobs: input.runtimeFileGlobs ?? [],
      ...commitTrees,
    });
    if (!classification.eligible) {
      return stale(`re-sealed receipt does not recompute: ${resealRefusalVerdict(classification.reason)}`);
    }
    // The receipt says which paths the declaration hid. Reproducing the
    // decision is not enough: it must hide exactly the same ones.
    const recomputed = classification.disregardedPaths ?? [];
    const claimedDisregarded = currentReceipt.resealDisregarded ?? [];
    if (recomputed.join(' ') !== claimedDisregarded.join(' ')) {
      return stale(
        `re-sealed receipt names ${String(claimedDisregarded.length)} disregarded declared runtime file(s) ` +
          `(${names(claimedDisregarded)}) but the recomputation disregards ${String(recomputed.length)} ` +
          `(${names(recomputed)}) (fail closed)`,
      );
    }
    const affected = new Set(classification.affectedTestFiles);
    const freshFiles = new Set(currentExecution.outcomes.map((outcome) => outcome.file));
    const outside = [...freshFiles].filter((file) => !affected.has(file)).sort();
    if (outside.length > 0) {
      return stale(
        `re-sealed receipt re-ran tests outside the recomputed affected set (${names(outside)}); ` +
          `the affected set is ${names(classification.affectedTestFiles)}`,
      );
    }
    const missing = classification.affectedTestFiles.filter((file) => !freshFiles.has(file)).sort();
    if (missing.length > 0) {
      return stale(
        `re-sealed receipt carries no fresh outcome for the recomputed affected set (${names(missing)})`,
      );
    }
    const failed = currentExecution.outcomes.filter((outcome) => outcome.status !== 'passed');
    if (failed.length > 0) {
      return stale(
        `re-sealed receipt re-ran ${String(failed.length)} test(s) that did not pass ` +
          `(${names(failed.map((outcome) => outcome.logicalKey))})`,
      );
    }
    if (currentReceipt.rerunTests !== currentExecution.outcomes.length) {
      return stale(
        `re-sealed receipt claims ${String(currentReceipt.rerunTests ?? -1)} re-run test(s) but its execution ` +
          `result holds ${String(currentExecution.outcomes.length)} outcome(s)`,
      );
    }
    // A test an INNER hop already re-ran is not carried by this hop:
    // its fresh outcome is already part of the chain, and counting it
    // twice is exactly the double-count a chain must not have.
    for (const file of freshFiles) reranFiles.add(file);
    const carriedOutcomes = parentExecution.outcomes.filter(
      (outcome) => !affected.has(outcome.file) && !reranFiles.has(outcome.file),
    );
    const parentFailures = carriedOutcomes.filter((outcome) => outcome.status !== 'passed');
    if (parentFailures.length > 0) {
      return stale(
        `re-sealed receipt carries ${String(parentFailures.length)} parent outcome(s) that did not pass ` +
          `(${names(parentFailures.map((outcome) => outcome.logicalKey))})`,
      );
    }
    // A re-seal's parent may itself be a re-seal, so what this hop
    // carries is only PART of what the run carries: every deeper hop
    // carried its own untouched tests too. The count and the carried
    // identities therefore accumulate across the whole chain, and the
    // receipt under inspection (the immediate child) states the total —
    // so the claim is checked ONCE, after the walk has seen every hop.
    carriedTotal += carriedOutcomes.length;
    for (const identity of carriedTestIdentities(parentExecution, [...reranFiles])) {
      carriedIdentities.add(identity);
    }
    for (const outcome of carriedOutcomes) carriedFiles.add(outcome.file);
    // The carried EVIDENCE (the second half of what a re-seal carries):
    // the retained parent records and claims are authenticated against
    // the envelope of EVERY run that contributed them — this hop's own
    // parent first, then each deeper hop's — with THIS keyring, and
    // reduced to the tests no hop of the chain re-ran.
    if (hop.records === null || hop.claims === null) {
      return stale(`re-seal hop ${hopNumber} retains no parent evidence documents (fail closed)`);
    }
    const contributors = chainContributors(chain, index);
    if (contributors === null) {
      return stale(`re-seal hop ${hopNumber} retains no witness envelope for a contributing run (fail closed)`);
    }
    const authenticated = authenticateContributingEvidence(
      {
        records: Array.isArray(hop.records) ? hop.records : [],
        claims: Array.isArray(hop.claims) ? hop.claims : [],
      },
      contributors,
      input.verifierKeyring.keys.map((entry) => entry.key),
    );
    if (index === 0 && authenticated.ok) hopOneEvidence = authenticated.evidence;
    if (!authenticated.ok) {
      return stale(`re-seal hop ${hopNumber}'s retained evidence does not recompute: ${authenticated.reason} (fail closed)`);
    }
    // A run record is the tail of a chain by construction: it is the
    // only parent a re-seal can have before any receipt exists, so a
    // retained hop beyond it is a chain that cannot be recomputed.
    if (retainedKind === 'run-record' && index + 1 < chain.length) {
      return stale(
        `re-seal hop ${hopNumber} retains a run record as a parent, but the chain continues past it ` +
          '(fail closed)',
      );
    }
    if (retainedKind === 'run-record') break;
    if (parentReceipt !== null) currentReceipt = parentReceipt;
    currentExecution = parentExecution;
  }
  // What the IMMEDIATE re-seal claims it carried is only knowable once
  // the whole chain has been walked: each hop carried its own untouched
  // tests, and they accumulate. Both the count and the carried evidence
  // are therefore checked here, against the receipt under inspection.
  if (hopOneEvidence === null) {
    return stale('the run state retains no authenticated evidence for the re-sealed receipt (fail closed)');
  }
  if (child.carriedTests !== carriedTotal) {
    return stale(
      `re-sealed receipt claims ${String(child.carriedTests ?? -1)} carried test(s) but its chain ` +
        `holds ${String(carriedTotal)} carried outcome(s)`,
    );
  }
  // The state evidence is the IMMEDIATE re-seal's union, so it is
  // compared with hop 1 alone: a deeper hop's own union was the run
  // that sealed its successor, whose evidence this chain no longer
  // retains.
  if (child.carriedEvidenceDigest === undefined) {
    return stale('re-seal hop 1 seals no carriedEvidenceDigest (fail closed)');
  }
  for (const key of mappedTestIdentities(carriedFiles, testMapEntries(input.cwd))) {
    carriedIdentities.add(key);
  }
  const carried = carriedEvidenceDocuments(hopOneEvidence, carriedIdentities);
  const stateRecords = readJsonArray(input.stateDir, 'records.json');
  const stateClaims = readJsonArray(input.stateDir, 'claims.json');
  if (carriedEvidenceDigestOf({ records: stateRecords, claims: stateClaims }) !== child.carriedEvidenceDigest) {
    return stale(
      're-seal hop 1: the state evidence no longer hashes to the carriedEvidenceDigest the receipt ' +
        'sealed (fail closed)',
    );
  }
  // The state evidence must BE the union: the retained carried
  // evidence plus exactly this run's own (never a contributing
  // run's records twice).
  const contributingRuns = new Set(hopOneEvidence.contributions.map((entry) => entry.runId));
  const recomputedUnion = {
    records: [
      ...carried.records,
      ...stateRecords.filter((record) => !contributingRuns.has(stringField(record, 'runId') ?? '')),
    ],
    claims: [
      ...carried.claims,
      ...stateClaims.filter((claim) => {
        const testId = stringField(claim, 'testId');
        return testId !== null && !carriedIdentities.has(testId);
      }),
    ],
  };
  if (carriedEvidenceDigestOf(recomputedUnion) !== child.carriedEvidenceDigest) {
    return stale(
      're-seal hop 1: the state evidence is not the union of the retained parent evidence ' +
        `(${String(carried.records.length)} carried record(s)) and this run's own (fail closed)`,
    );
  }
  return [];
}
