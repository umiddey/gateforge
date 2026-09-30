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
  testOutcomesDigestOf,
} from '@gate-forge/core';
import { classifyResealChange, diffSealedTrees, resealRefusalVerdict } from './reseal.js';
import {
  authenticateParentEvidence,
  carriedEvidenceDigestOf,
  carriedEvidenceDocuments,
  carriedTestIdentities,
  stringField,
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
  /** The parent's v2 attestation envelope, the document that binds those records. */
  attestation: unknown;
}

function hopFileNames(hop: number): [string, string, string, string, string, string, string] {
  return [
    `hop-${String(hop)}-receipt.json`,
    `hop-${String(hop)}-run-record.json`,
    `hop-${String(hop)}-execution-result.json`,
    `hop-${String(hop)}-catalog.json`,
    `hop-${String(hop)}-records.json`,
    `hop-${String(hop)}-claims.json`,
    `hop-${String(hop)}-attestation.json`,
  ];
}

/**
 * Retains the parent run's evidence BEFORE the re-seal's own run
 * overwrites `records.json`, `claims.json` and the run manifest. It
 * writes only the three evidence members of hop 1, without shifting the
 * chain: the hop itself is written when the receipt seals, and a run
 * that seals nothing leaves no hop-1 parent behind, so a stale evidence
 * file is never read as a chain.
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
  evidence: { records: readonly unknown[]; claims: readonly unknown[]; attestation: unknown },
): void {
  const directory = join(stateDir, RESEAL_CHAIN_DIRECTORY);
  mkdirSync(directory, { recursive: true });
  const [, , , , recordsName, claimsName, attestationName] = hopFileNames(1);
  writeFileSync(join(directory, recordsName), `${JSON.stringify(evidence.records, null, 2)}\n`, 'utf8');
  writeFileSync(join(directory, claimsName), `${JSON.stringify(evidence.claims, null, 2)}\n`, 'utf8');
  writeFileSync(join(directory, attestationName), `${JSON.stringify(evidence.attestation, null, 2)}\n`, 'utf8');
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
 * Retains one re-seal hop, shifting every earlier hop one place back so
 * the chain stays contiguous (hop 1 is always the immediate parent).
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
  const retained = resealChainHopCount(stateDir);
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
  const [receiptName, runRecordName, executionName, catalogName, recordsName, claimsName, attestationName] =
    hopFileNames(1);
  writeFileSync(join(directory, receiptName), `${JSON.stringify(hop.receipt, null, 2)}\n`, 'utf8');
  writeFileSync(join(directory, executionName), `${JSON.stringify(hop.execution, null, 2)}\n`, 'utf8');
  writeFileSync(join(directory, catalogName), `${JSON.stringify(hop.catalog, null, 2)}\n`, 'utf8');
  writeFileSync(join(directory, recordsName), `${JSON.stringify(hop.records, null, 2)}\n`, 'utf8');
  writeFileSync(join(directory, claimsName), `${JSON.stringify(hop.claims, null, 2)}\n`, 'utf8');
  writeFileSync(join(directory, attestationName), `${JSON.stringify(hop.attestation, null, 2)}\n`, 'utf8');
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
    const [receiptName, runRecordName, executionName, catalogName, recordsName, claimsName, attestationName] =
      hopFileNames(index);
    const directory = join(stateDir, RESEAL_CHAIN_DIRECTORY);
    const receipt = readStateDocument(directory, receiptName);
    const runRecord = readStateDocument(directory, runRecordName);
    if (receipt === null && runRecord === null) return hops;
    const execution = readStateDocument(directory, executionName);
    const catalog = readStateDocument(directory, catalogName);
    const records = readStateDocument(directory, recordsName);
    const claims = readStateDocument(directory, claimsName);
    const attestation = readStateDocument(directory, attestationName);
    if (execution === null || catalog === null) {
      return [...hops, { receipt, runRecord, execution: null, catalog: null, records, claims, attestation }];
    }
    hops.push({ receipt, runRecord, execution, catalog, records, claims, attestation });
  }
}

/**
 * The carried-evidence metadata a GRADER needs for a re-sealed run: the
 * retained parent envelope plus the identity and input digest the
 * retained parent document binds. Nothing here is trusted — the
 * envelope's MAC is verified inside the evaluator and the whole chain is
 * recomputed by `resealChainBlocking` — this only tells the grader which
 * envelope belongs to the run it is grading.
 *
 * Args:
 *   stateDir: absolute run-state directory.
 *
 * Returns:
 *   the metadata, or null when the state holds no re-sealed receipt, no
 *   retained hop, or no envelope to carry.
 */
export function retainedCarriedEvidence(
  stateDir: string,
): { attestation: unknown; runId: string; inputDigest: string; recordIds: string[] } | null {
  const receipt = readStateDocument(stateDir, 'receipt.json');
  if (stringField(receipt, 'resealedFrom') === null) return null;
  const chain = readResealChain(stateDir);
  const hop = chain[0];
  if (hop === undefined || hop === null || hop.attestation === null) return null;
  const parent = hopCarriesRunRecord(hop) ? hop.runRecord : hop.receipt;
  const runId = stringField(parent, 'runId');
  const inputDigest = stringField(parent, 'inputDigest');
  if (runId === null || inputDigest === null) return null;
  const parsed = AttestationSchema.safeParse(hop.attestation);
  return {
    attestation: hop.attestation,
    runId,
    inputDigest,
    recordIds: parsed.success ? [...parsed.data.recordIds] : [],
  };
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
  for (let index = 0; index < chain.length; index += 1) {
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
    // The owner declaration the candidate config carries is applied to
    // the recomputation too, so CI reaches the identical decision with
    // its own engine: the two commit trees say which paths are
    // TRACKED, and a tracked path never matches, whatever the glob reads.
    // A document that names no commit has no committed file list, so
    // nothing can be proven untracked: the classifier then disregards
    // nothing and a receipt that claims otherwise is stale below.
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
    const carriedOutcomes = parentExecution.outcomes.filter((outcome) => !affected.has(outcome.file));
    const parentFailures = carriedOutcomes.filter((outcome) => outcome.status !== 'passed');
    if (parentFailures.length > 0) {
      return stale(
        `re-sealed receipt carries ${String(parentFailures.length)} parent outcome(s) that did not pass ` +
          `(${names(parentFailures.map((outcome) => outcome.logicalKey))})`,
      );
    }
    if (currentReceipt.carriedTests !== carriedOutcomes.length) {
      return stale(
        `re-sealed receipt claims ${String(currentReceipt.carriedTests ?? -1)} carried test(s) but its parent ` +
          `holds ${String(carriedOutcomes.length)} carried outcome(s)`,
      );
    }
    // The carried EVIDENCE (the second half of what a re-seal carries):
    // the retained parent records and claims are authenticated against
    // the parent document's own attestation with THIS keyring and
    // reduced to the tests the recomputed affected set left untouched.
    if (hop.records === null || hop.claims === null || hop.attestation === null) {
      return stale(`re-seal hop ${hopNumber} retains no parent evidence documents (fail closed)`);
    }
    const parentDocument = retainedKind === 'run-record' ? hop.runRecord : parentReceipt;
    const authenticated = authenticateParentEvidence(
      {
        records: Array.isArray(hop.records) ? hop.records : [],
        claims: Array.isArray(hop.claims) ? hop.claims : [],
        attestation: hop.attestation,
      },
      {
        runId: stringField(parentDocument, 'runId') ?? '',
        inputDigest: stringField(parentDocument, 'inputDigest') ?? '',
        evidenceAttestationDigest: stringField(parentDocument, 'evidenceAttestationDigest'),
      },
      input.verifierKeyring.keys.map((entry) => entry.key),
    );
    if (authenticated === null) {
      return stale(`re-seal hop ${hopNumber} retains no parent evidence to carry (fail closed)`);
    }
    if (!authenticated.ok) {
      return stale(`re-seal hop ${hopNumber}'s retained evidence does not recompute: ${authenticated.reason} (fail closed)`);
    }
    // The state evidence is the IMMEDIATE re-seal's union, so only the
    // first hop can be compared with it: a deeper hop's own union was
    // the run that sealed its successor, whose evidence this chain no
    // longer retains.
    if (index === 0) {
      if (currentReceipt.carriedEvidenceDigest === undefined) {
        return stale(`re-seal hop ${hopNumber} seals no carriedEvidenceDigest (fail closed)`);
      }
      const identities = carriedTestIdentities(parentExecution, classification.affectedTestFiles);
      const carried = carriedEvidenceDocuments(authenticated.evidence, identities);
      const stateRecords = readJsonArray(input.stateDir, 'records.json');
      const stateClaims = readJsonArray(input.stateDir, 'claims.json');
      if (carriedEvidenceDigestOf({ records: stateRecords, claims: stateClaims }) !== currentReceipt.carriedEvidenceDigest) {
        return stale(
          `re-seal hop ${hopNumber}: the state evidence no longer hashes to the carriedEvidenceDigest the receipt ` +
            'sealed (fail closed)',
        );
      }
      // The state evidence must BE the union: the retained carried
      // evidence plus exactly this run's own (never the parent's twice).
      const recomputedUnion = {
        records: [
          ...carried.records,
          ...stateRecords.filter((record) => stringField(record, 'runId') !== authenticated.evidence.runId),
        ],
        claims: [
          ...carried.claims,
          ...stateClaims.filter((claim) => {
            const testId = stringField(claim, 'testId');
            return testId !== null && !identities.has(testId);
          }),
        ],
      };
      if (carriedEvidenceDigestOf(recomputedUnion) !== currentReceipt.carriedEvidenceDigest) {
        return stale(
          `re-seal hop ${hopNumber}: the state evidence is not the union of the retained parent evidence ` +
            `(${String(carried.records.length)} carried record(s)) and this run's own (fail closed)`,
        );
      }
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
    if (retainedKind === 'run-record') return [];
    if (parentReceipt !== null) currentReceipt = parentReceipt;
    currentExecution = parentExecution;
  }
  return [];
}
