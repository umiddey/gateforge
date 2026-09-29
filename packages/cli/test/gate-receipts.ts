/**
 * Phase 5 test fixture: mints REAL authenticated gate receipts for a
 * fixture repository — the same trusted machinery `test-gates --changed`
 * uses (execution.ts `sealExecutionResult` + `issueGateReceipt`, core
 * HMAC over the `gateforge.receipt.v2` domain) — so hook/broker/doctor
 * tests exercise the genuine receipt path end to end. The planned
 * executed run is a data-level complete supervised run (no browser is
 * launched); git, digests, and signatures are all real.
 */
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import {
  loadConfig,
  selectionDigestOf,
  sha256Canonical,
  type Claim,
  deriveLogicalKey,
  type RunnerExecutionEnvelope,
  type TempRepo,
  type TestCatalog,
  type TestCatalogEntry,
} from '@gate-forge/core';
import {
  trustedPolicyDigestForConfig,
  issueGateReceipt,
  sealExecutionResult,
  SUPERVISED_INVOCATION,
} from '../src/execution.js';
import { computeCandidateTreeSnapshot, resolveGitDir } from '../src/candidate-tree.js';
import {
  caseExecutionDigestOf,
  EMPTY_BEHAVIOR_CATALOG_DIGEST,
  engineBundleDigestOf,
  executionBoundaryDigestOf,
  LOCAL_UNISOLATED_BOUNDARY,
  requiredCaseSetDigestOf,
  targetArtifactDigestOf,
} from '@gate-forge/core';
import { engineIdentity } from '../src/engine-identity.js';
import { VERSION } from '../src/commands/common.js';
import { TEST_MAP_RELATIVE } from '../src/mapping.js';
import { environmentVerifierKeyId } from '../src/verifier-keys.js';
import { resolveStateDir, writeCandidateTreeEntries, writeExecutionResult, writeGateReceipt } from '../src/state.js';
import { currentInputDigest, FIXED_AT } from './helpers.js';

/** The supervised catalog row the minted complete run reports. */
export const RECEIPT_FILE = 'e2e/accounts.spec.ts';
export const RECEIPT_TITLE = ['Accounts', 'deletes an account'];
export const RECEIPT_KEY = 'playwright:chromium:e2e/accounts.spec.ts:Accounts>deletes an account';

/**
 * The identity one minted run reports. A non-Playwright run names its
 * own runner, project and file — the schemas treat the runner as a
 * string, so a pytest/vitest/cypress receipt is sealed exactly like the
 * Playwright one (this is the runner-agnostic evidence contract).
 */
interface RunIdentity {
  runner: string;
  project: string | null;
  file: string;
  titlePath: readonly string[];
  /** The runner's own framework id when it reports one (null otherwise). */
  frameworkId: string | null;
}

/** The Playwright identity (the default, byte-identical to before). */
const PLAYWRIGHT_IDENTITY: RunIdentity = {
  runner: 'playwright',
  project: 'chromium',
  file: RECEIPT_FILE,
  titlePath: RECEIPT_TITLE,
  frameworkId: null,
};

/** The identity for another configured runner (e.g. `vitest`). */
function identityOf(runner: string): RunIdentity {
  if (runner === 'playwright') return PLAYWRIGHT_IDENTITY;
  const file = `tests/${runner}/accounts.test.ts`;
  return { runner, project: null, file, titlePath: RECEIPT_TITLE, frameworkId: `${runner}-test-1` };
}

/** One discovered catalog row for the minted run. */
function catalogRow(identity: RunIdentity): TestCatalogEntry {
  return {
    logicalKey: deriveLogicalKey({
      runner: identity.runner,
      project: identity.project,
      file: identity.file,
      titlePath: [...identity.titlePath],
    }),
    runner: identity.runner,
    project: identity.project,
    file: identity.file,
    titlePath: [...identity.titlePath],
    title: identity.titlePath[identity.titlePath.length - 1] ?? 'case',
    sourceLocation: { file: identity.file, line: 3, col: 0 },
    parameterIdentity: identity.frameworkId,
    sourceDigest: 'aa'.repeat(32),
    discoveryStatus: 'discovered',
    reconciliation: 'matched',
    inferredKind: 'browser-e2e',
    kindSignals: [],
    weakSignals: [],
    rulesFired: [],
    categorySignals: [],
    suppressionSignals: [],
  };
}

function completeCatalog(identity: RunIdentity): TestCatalog {
  return {
    schemaVersion: 1,
    entries: [catalogRow(identity)],
    unresolved: [],
    parseErrors: [],
    inventoryComplete: true,
    runnerSummaries: [],
  };
}

const COMPLETE_ENVELOPE: RunnerExecutionEnvelope = {
  processExit: 0,
  complete: true,
  outcomes: [],
  fixtureOutcome: 'passed',
  shards: null,
  retriesDetected: false,
  engines: { node: 'v22.0.0' },
  browsers: { chromium: '131.0.0.0' },
};

/** Everything minted for one candidate (also returned to the caller). */
export interface MintedReceipt {  /** The workspace/candidate input digest the receipt binds. */
  inputDigest: string;
  /** The trusted policy revision digest the receipt binds. */
  trustedPolicyDigest: string;
  /** The approved-policy digest bound into the receipt, when provided. */
  approvedPolicyDigest?: string;
  /** The absolute path the receipt was written to. */
  receiptPath: string;
  /** The receipt id. */
  receiptId: string;
  /** The parent sha bound into the receipt (null for unborn bases). */
  parentSha: string | null;
}

/**
 * Mints a complete-run receipt + execution result for the repository's
 * CURRENT bytes and writes both into the run-state directory — exactly
 * the artifacts a successful `test-gates --changed` leaves behind.
 *
 * Args:
 *   repo: fixture repository (gateforge config + sources committed).
 *   options: signing key, optional parentSha/digest override/policy pin,
 *     claim inventory, execution boundary, and verdict summary for a
 *     carry-forward parent fixture.
 *
 * Returns:
 *   Promise<MintedReceipt>: the minted binding values.
 */
export async function mintCompleteRunReceipt(
  repo: TempRepo,
  options: {
    verifierKey: string;
    parentSha?: string | null;
    digestOverride?: string;
    approvedPolicyDigest?: string;
    executionBoundaryProfile?: string;
    claimInventory?: readonly Claim[];
    verdictSummary?: { total: number; satisfied: number; waived: number; blocking: number };
    docsExclusions?: readonly string[];
    /** The runner that sealed the run (default `playwright`). */
    runner?: string;
  },
): Promise<MintedReceipt> {
  const actualDigest = await currentInputDigest(repo, options.docsExclusions ?? []);
  // digestOverride simulates stale/different-bytes receipts: every bound
  // digest (execution result + receipt) consistently names OTHER bytes
  // while all signatures stay valid — exactly the E13 stale candidate.
  const inputDigest = options.digestOverride ?? actualDigest;
  const config = loadConfig(join(repo.root, '.gateforge.yml'));
  const trustedPolicyDigest = trustedPolicyDigestForConfig(repo.root, config);
  const runId = randomUUID();
  const invocationId = randomUUID();
  const identity = identityOf(options.runner ?? 'playwright');
  const logicalKey = deriveLogicalKey({
    runner: identity.runner,
    project: identity.project,
    file: identity.file,
    titlePath: [...identity.titlePath],
  });
  const catalog = completeCatalog(identity);
  const selection = {
    runner: identity.runner,
    mode: 'full-relevant-suite' as const,
    logicalKeys: [logicalKey],
  };
  const sealed = sealExecutionResult({
    runId,
    invocationId,
    inputDigest,
    trustedPolicyDigest,
    runner: identity.runner,
    logicalKeys: selection.logicalKeys,
    ...(options.claimInventory !== undefined ? { claimInventory: options.claimInventory } : {}),
    catalog,
    plannedRows: [
      {
        planned: {
          logicalKey,
          project: identity.project,
          file: identity.file,
          titlePath: [...identity.titlePath],
          frameworkId: identity.frameworkId,
        },
        input: {
          logicalKey,
          project: identity.project,
          file: identity.file,
          titlePath: [...identity.titlePath],
          blockingAnnotations: [],
        },
      },
    ],
    envelope: COMPLETE_ENVELOPE,
    outcomesDoc: {
      schemaVersion: 1,
      runStatus: 'passed',
      runnerErrors: [],
      shard: null,
      outcomes: [
        {
          testId: 'spec-1',
          file: identity.file,
          titlePath: [...identity.titlePath],
          project: identity.project,
          status: 'passed',
          attempt: 1,
          expectedFailure: false,
        },
      ],
    },
    startedAt: FIXED_AT,
    finishedAt: FIXED_AT,
  });
  const parentSha = options.parentSha !== undefined ? options.parentSha : repo.headSha();
  // v2 bindings mirror production sealing: the raw candidate tree, the
  // (empty here) behavior catalog + required case set, no executed cases,
  // the engine bundle, the local boundary, and the source-tree artifact.
  const mintGitDir = resolveGitDir(repo.root, process.env);
  const stateDir = resolveStateDir(repo.root);
  const treeSnapshot =
    mintGitDir === null
      ? null
      : computeCandidateTreeSnapshot(mintGitDir, repo.root, process.env, stateDir, 'record', [], options.docsExclusions ?? [], []);
  const candidateTreeId = treeSnapshot?.treeId ?? null;
  const receipt = issueGateReceipt({
    verifierKey: options.verifierKey,
    verifierKeyId: environmentVerifierKeyId(options.verifierKey),
    runId,
    invocationId,
    inputDigest,
    gitSha: repo.headSha(),
    parentSha,
    trustedPolicyDigest,
    ...(options.approvedPolicyDigest !== undefined ? { approvedPolicyDigest: options.approvedPolicyDigest } : {}),
    receiptStage: config.enforcement?.receiptStage,
    engine: engineIdentity(),
    invocation: SUPERVISED_INVOCATION,
    selectionDigest: selectionDigestOf(selection),
    catalogDigest: sha256Canonical(catalog as unknown as Record<string, never>),
    executionResultDigest: sealed.digest,
    evidenceAttestationDigest: null,
    candidateTreeId,
    behaviorCatalogDigest: EMPTY_BEHAVIOR_CATALOG_DIGEST,
    requiredCaseSetDigest: requiredCaseSetDigestOf([]),
    caseExecutionDigest: caseExecutionDigestOf([]),
    executionBoundaryDigest: executionBoundaryDigestOf(options.executionBoundaryProfile ?? LOCAL_UNISOLATED_BOUNDARY),
    engineBundleDigest: engineBundleDigestOf(VERSION, trustedPolicyDigest),
    targetArtifactDigest: targetArtifactDigestOf(candidateTreeId),
    verdictSummary: options.verdictSummary ?? { total: 0, satisfied: 0, waived: 0, blocking: 0 },
    issuedAt: FIXED_AT,
  });
  writeExecutionResult(stateDir, sealed.result);
  writeGateReceipt(stateDir, receipt);
  writeCandidateTreeEntries(stateDir, treeSnapshot?.entries ?? []);
  return {
    inputDigest,
    trustedPolicyDigest,
    ...(options.approvedPolicyDigest !== undefined ? { approvedPolicyDigest: options.approvedPolicyDigest } : {}),
    receiptPath: join(stateDir, 'receipt.json'),
    receiptId: receipt.receiptId,
    parentSha,
  };
}

/**
 * Standard v2 receipt bindings for unit-style tests that seal receipts
 * directly (no behavior catalog, no executed cases, null tree, local
 * boundary, source-tree artifact). Spread into `issueGateReceipt` input.
 */
export function testReceiptV2Bindings(trustedPolicyDigest: string, engineVersion = 'test-engine/0') {
  return {
    candidateTreeId: null as string | null,
    behaviorCatalogDigest: EMPTY_BEHAVIOR_CATALOG_DIGEST,
    requiredCaseSetDigest: requiredCaseSetDigestOf([]),
    caseExecutionDigest: caseExecutionDigestOf([]),
    engineBundleDigest: engineBundleDigestOf(engineVersion, trustedPolicyDigest),
    executionBoundaryDigest: executionBoundaryDigestOf(LOCAL_UNISOLATED_BOUNDARY),
    targetArtifactDigest: targetArtifactDigestOf(null),
  };
}
