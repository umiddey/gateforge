/**
 * Phase 5 test fixture: mints REAL authenticated gate receipts for a
 * fixture repository — the same trusted machinery `test-gates --changed`
 * uses (execution.ts `sealExecutionResult` + `issueGateReceipt`, core
 * HMAC over the `gateforge.receipt.v1` domain) — so hook/broker/doctor
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
import { TEST_MAP_RELATIVE } from '../src/mapping.js';
import { resolveStateDir, writeExecutionResult, writeGateReceipt } from '../src/state.js';
import { currentInputDigest, FIXED_AT } from './helpers.js';

/** The supervised catalog row the minted complete run reports. */
export const RECEIPT_FILE = 'e2e/accounts.spec.ts';
export const RECEIPT_TITLE = ['Accounts', 'deletes an account'];
export const RECEIPT_KEY = 'playwright:chromium:e2e/accounts.spec.ts:Accounts>deletes an account';

/** One discovered catalog row for the minted run. */
function catalogRow(): TestCatalogEntry {
  return {
    logicalKey: RECEIPT_KEY,
    runner: 'playwright',
    project: 'chromium',
    file: RECEIPT_FILE,
    titlePath: RECEIPT_TITLE,
    title: RECEIPT_TITLE[RECEIPT_TITLE.length - 1] ?? 'case',
    sourceLocation: { file: RECEIPT_FILE, line: 3, col: 0 },
    parameterIdentity: null,
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

function completeCatalog(): TestCatalog {
  return {
    schemaVersion: 1,
    entries: [catalogRow()],
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
export interface MintedReceipt {
  /** The workspace/candidate input digest the receipt binds. */
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
 *   options: verifierKey (signing authority), an optional parentSha
 *     override (defaults to the repo HEAD; pass a sha to simulate a
 *     receipt sealed against a specific base), digestOverride
 *     (simulate stale/different-bytes receipts: the MAC then covers the
 *     overridden digest, so the receipt no longer matches the repo), and
 *     approvedPolicyDigest (the additive v1 approved-policy binding —
 *     omitted when not provided, matching pre-pin receipts).
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
  },
): Promise<MintedReceipt> {
  const actualDigest = await currentInputDigest(repo);
  // digestOverride simulates stale/different-bytes receipts: every bound
  // digest (execution result + receipt) consistently names OTHER bytes
  // while all signatures stay valid — exactly the E13 stale candidate.
  const inputDigest = options.digestOverride ?? actualDigest;
  const config = loadConfig(join(repo.root, '.gateforge.yml'));
  const trustedPolicyDigest = trustedPolicyDigestForConfig(repo.root, config);
  const runId = randomUUID();
  const invocationId = randomUUID();
  const catalog = completeCatalog();
  const selection = {
    runner: 'playwright',
    mode: 'full-relevant-suite' as const,
    logicalKeys: [RECEIPT_KEY],
  };
  const sealed = sealExecutionResult({
    runId,
    invocationId,
    inputDigest,
    trustedPolicyDigest,
    runner: 'playwright',
    logicalKeys: selection.logicalKeys,
    catalog,
    plannedRows: [
      {
        planned: {
          logicalKey: RECEIPT_KEY,
          project: 'chromium',
          file: RECEIPT_FILE,
          titlePath: [...RECEIPT_TITLE],
          frameworkId: null,
        },
        input: {
          logicalKey: RECEIPT_KEY,
          project: 'chromium',
          file: RECEIPT_FILE,
          titlePath: [...RECEIPT_TITLE],
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
          file: RECEIPT_FILE,
          titlePath: [...RECEIPT_TITLE],
          project: 'chromium',
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
  const receipt = issueGateReceipt({
    verifierKey: options.verifierKey,
    runId,
    invocationId,
    inputDigest,
    gitSha: repo.headSha(),
    parentSha,
    trustedPolicyDigest,
    ...(options.approvedPolicyDigest !== undefined ? { approvedPolicyDigest: options.approvedPolicyDigest } : {}),
    invocation: SUPERVISED_INVOCATION,
    selectionDigest: selectionDigestOf(selection),
    catalogDigest: sha256Canonical(catalog as unknown as Record<string, never>),
    executionResultDigest: sealed.digest,
    evidenceAttestationDigest: null,
    verdictSummary: { total: 0, satisfied: 0, waived: 0, blocking: 0 },
    issuedAt: FIXED_AT,
  });
  const stateDir = resolveStateDir(repo.root);
  writeExecutionResult(stateDir, sealed.result);
  writeGateReceipt(stateDir, receipt);
  return {
    inputDigest,
    trustedPolicyDigest,
    ...(options.approvedPolicyDigest !== undefined ? { approvedPolicyDigest: options.approvedPolicyDigest } : {}),
    receiptPath: join(stateDir, 'receipt.json'),
    receiptId: receipt.receiptId,
    parentSha,
  };
}
