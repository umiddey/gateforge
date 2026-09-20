/**
 * Gate-receipt gate tests (plan 2026-09-13 Phase 4 items 5/8, ADR 0005
 * D3, E07/E13): `check --require-e2e` probes — missing receipt for the
 * current input digest → RUN_INCOMPLETE, stale (source/helper changed
 * after green) → EVIDENCE_STALE, forged/tampered → ENFORCEMENT_UNTRUSTED
 * — plus issuance only after complete success, the bound-execution-result
 * integrity check, failure-after-evidence blocking a later check, and
 * exact cache reuse on identical authenticated inputs only.
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  caseExecutionDigestOf,
  loadConfig,
  recordIdOf,
  sha256Canonical,
  type BehaviorCatalog,
  type ObligationVerdict,
  type TempRepo,
  type TestCatalog,
} from '@gate-forge/core';
import { currentInputDigest, FIXED_AT, PLUGIN_SOURCE, runCli, withTempRepo } from './helpers.js';
import {
  trustedPolicyDigestForConfig,
  issueGateReceipt,
  sealExecutionResult,
  type PlannedRow,
} from '../src/execution.js';
import { loadReceiptFor, receiptGateBlocking, tryReuseReceipt } from '../src/receipts.js';
import { testReceiptV2Bindings } from './gate-receipts.js';
import { executedBehaviorCaseDigest } from '../src/commands/test-gates.js';
import {
  clearGateReceipt,
  readStateDocument,
  resolveStateDir,
  writeExecutionResult,
  writeGateReceipt,
} from '../src/state.js';
import { VERIFIER_KEY_ENV } from '../src/commands/common.js';
import type { RunnerOutcomesDocument } from '@gate-forge/pack-playwright';

const KEY = 'e2e-receipt-verifier-key';
const RUN_ID = '11111111-2222-4333-8444-555555555555';
const INVOCATION_ID = '66666666-7777-4888-8999-000000000000';
const PLANNED_KEY = 'playwright:chromium:e2e/accounts.spec.ts:deletes an account';

/**
 * Minimal fixture repo: the standard gate documents but NO resource
 * files, so the run carries zero obligations and the require-e2e exit
 * code is driven entirely by the receipt gate.
 */
function installReceiptFixture(repo: TempRepo): void {
  repo.writeFiles({
    '.gateforge.yml': [
      'schemaVersion: 1',
      'project:',
      '  languages: [python]',
      '  paths:',
      "    include: ['src/**/*.txt']",
      '    exclude: []',
      'plugins:',
      "  - id: fixture.plugin",
      "    version: '1.0.0'",
      '    transport: in-process',
      '    module: ./plugin.mjs',
      'policies: .gateforge/policies.yml',
      'classificationPolicy: .gateforge/classification-policy.yml',
      'adapters: .gateforge/adapters',
      'waivers: .gateforge/waivers',
      'baselines: .gateforge/baselines/obligations.json',
      'changed:',
      '  provider: auto',
      'witness:',
      '  maxDurationSeconds: 5',
      'clock:',
      '  mode: fixed',
      `  fixedAt: '${FIXED_AT}'`,
      '',
    ].join('\n'),
    '.gateforge/policies.yml': 'schemaVersion: 1\npolicies:\n  - id: user-facing-crud\n    when:\n      exposure: user-facing\n    require:\n      - persistence:read\n',
    '.gateforge/classification-policy.yml':
      "schemaVersion: 1\nscanRoots: ['src/**/*.txt']\ntrustedInternalEntryPoints: []\ninternalRules: []\ndeclarations:\n  internality: gateforge:internal\nvolatileFields: []\n",
    'plugin.mjs': PLUGIN_SOURCE,
  });
}

/** One planned playwright instance (the expected-set row). */
function plannedRow(): PlannedRow {
  return {
    planned: {
      logicalKey: PLANNED_KEY,
      project: 'chromium',
      file: 'e2e/accounts.spec.ts',
      titlePath: ['deletes an account'],
      frameworkId: null,
    },
    input: {
      logicalKey: PLANNED_KEY,
      project: 'chromium',
      file: 'e2e/accounts.spec.ts',
      titlePath: ['deletes an account'],
      blockingAnnotations: [],
    },
  };
}

/** A passing first-attempt runner-outcomes document matching the plan. */
function outcomesDoc(): RunnerOutcomesDocument {
  return {
    schemaVersion: 1,
    runStatus: 'passed',
    runnerErrors: [],
    shard: null,
    outcomes: [
      {
        testId: 'spec-1',
        file: 'e2e/accounts.spec.ts',
        titlePath: ['deletes an account'],
        project: 'chromium',
        status: 'passed',
        attempt: 1,
        expectedFailure: false,
      },
    ],
  };
}

const EMPTY_CATALOG: TestCatalog = {
  schemaVersion: 1,
  entries: [],
  unresolved: [],
  parseErrors: [],
  inventoryComplete: true,
  runnerSummaries: [],
};

/**
 * Simulates exactly what a complete supervised `test-gates --changed`
 * seals for the CURRENT tree: a complete execution result + a receipt
 * bound to it, written into the run state.
 */
async function sealGreenRun(
  repo: TempRepo,
  inputDigest: string,
): Promise<string> {
  const config = loadConfig(join(repo.root, '.gateforge.yml'));
  const stateDir = resolveStateDir(repo.root);
  const trustedPolicyDigest = trustedPolicyDigestForConfig(repo.root, config);
  const plannedRows = [plannedRow()];
  const sealed = sealExecutionResult({
    runId: RUN_ID,
    invocationId: INVOCATION_ID,
    inputDigest,
    trustedPolicyDigest,
    runner: 'playwright',
    logicalKeys: [PLANNED_KEY],
    catalog: EMPTY_CATALOG,
    plannedRows,
    envelope: {
      processExit: 0,
      complete: true,
      outcomes: [],
      fixtureOutcome: 'passed',
      shards: null,
      retriesDetected: false,
      engines: { node: process.version },
      browsers: {},
    },
    outcomesDoc: outcomesDoc(),
    startedAt: FIXED_AT,
    finishedAt: FIXED_AT,
  });
  writeExecutionResult(stateDir, sealed.result);
  const receipt = issueGateReceipt({
    verifierKey: KEY,
    runId: RUN_ID,
    invocationId: INVOCATION_ID,
    inputDigest,
    gitSha: null,
    parentSha: null,
    trustedPolicyDigest,
    invocation: 'test-gates --changed',
    selectionDigest: sealed.result.selectionDigest,
    catalogDigest: sha256Canonical(EMPTY_CATALOG as unknown as Record<string, never>),
    executionResultDigest: sealed.digest,
    evidenceAttestationDigest: null,
    ...testReceiptV2Bindings(trustedPolicyDigest),
    verdictSummary: { total: 0, satisfied: 0, waived: 0, blocking: 0 },
    issuedAt: FIXED_AT,
  });
  writeGateReceipt(stateDir, receipt);
  return receipt.receiptId;
}

describe('executed behavior-case receipt binding', () => {
  it('binds a non-empty executed-case digest only from a satisfied witness case', async () => {
    await withTempRepo({}, async (repo) => {
      const stateDir = resolveStateDir(repo.root);
      mkdirSync(stateDir, { recursive: true });
      const caseId = 'a'.repeat(64);
      const specDigest = 'b'.repeat(64);
      const behaviorCatalog = {
        cases: [{ caseId, specDigest }],
        requirements: { 'tenant.profile:http:effect-verified': [caseId] },
      } as unknown as BehaviorCatalog;
      const payload = {
        payloadVersion: 1,
        caseId,
        caseSpecDigest: specDigest,
        obligationIds: ['tenant.profile:http:effect-verified'],
        endpointResourceId: null,
        operationId: 'update-profile',
        sessionId: 'session-1',
        executionId: 'execution-1',
        fixtureNamespace: 'fixture',
        actor: { principalId: 'principal', tenantId: 'tenant', roles: ['user'] },
        actionDigest: 'c'.repeat(64),
        submittedValues: {},
        attempts: [],
        requestObservations: [],
        fixtureValues: {},
        before: [],
        after: [],
        completion: { complete: true, checkpoint: 'sealed' },
        channel: 'engine-http',
        authorityProfileDigest: 'd'.repeat(64),
        state: 'sealed',
      };
      const identity = {
        runId: RUN_ID,
        obligationId: 'tenant.profile:http:effect-verified',
        kind: 'behavior.case',
        testId: 'test-1',
        origin: 'engine-observed' as const,
        payload,
      };
      const record = {
        schemaVersion: 1,
        recordId: recordIdOf(identity),
        runId: RUN_ID,
        trust: 'witnessed',
        obligationId: identity.obligationId,
        kind: identity.kind,
        testId: identity.testId,
        origin: identity.origin,
        payload,
      };
      writeFileSync(join(stateDir, 'records.json'), `${JSON.stringify([record])}\n`, 'utf8');
      const verdict = {
        obligation: {
          id: identity.obligationId,
          resourceId: 'tenant.profile',
          contract: 'http:effect-verified',
        },
        verdict: 'satisfied',
        reason: null,
        recordIds: [record.recordId],
      } as unknown as ObligationVerdict;
      expect(executedBehaviorCaseDigest(stateDir, RUN_ID, behaviorCatalog, [verdict])).toBe(
        caseExecutionDigestOf([caseId]),
      );
      expect(executedBehaviorCaseDigest(stateDir, RUN_ID, behaviorCatalog, [])).toBe(
        caseExecutionDigestOf([]),
      );
    });
  });
});

describe('check --require-e2e: the receipt gate (E07/E13)', () => {
  it('a missing receipt blocks with RUN_INCOMPLETE even when an old v2 record bundle exists', async () => {
    await withTempRepo({}, async (repo) => {
      installReceiptFixture(repo);
      // Old-style bundle: a manifest with a v2 attestation but NO receipt.
      repo.writeFiles({
        '.gateforge/test-gates/manifest.json': `${JSON.stringify({
          schemaVersion: 1,
          runId: RUN_ID,
          startedAt: FIXED_AT,
          attestation: { attestationVersion: 2, runId: RUN_ID },
        })}\n`,
      });
      const result = await runCli(repo, ['check', '--require-e2e'], { [VERIFIER_KEY_ENV]: KEY });
      expect(result.code).toBe(1);
      expect(result.stdout).toMatch(/RUN_INCOMPLETE/);
      expect(result.stdout).toMatch(/no gate receipt exists/);
    });
  });

  it('a valid complete receipt for the current input digest passes require-e2e', async () => {
    await withTempRepo({}, async (repo) => {
      installReceiptFixture(repo);
      const digest = await currentInputDigest(repo);
      const receiptId = await sealGreenRun(repo, digest);
      const result = await runCli(repo, ['check', '--require-e2e'], { [VERIFIER_KEY_ENV]: KEY });
      expect(result.code).toBe(0);
      expect(result.stdout).not.toMatch(/EVIDENCE_STALE|RUN_INCOMPLETE|ENFORCEMENT_UNTRUSTED/);
      expect(receiptId).toMatch(/^[0-9a-f-]{36}$/);
    });
  });

  it('touching a helper after green makes the receipt stale (EVIDENCE_STALE); resealing clears it', async () => {
    await withTempRepo({}, async (repo) => {
      installReceiptFixture(repo);
      const digestBefore = await currentInputDigest(repo);
      await sealGreenRun(repo, digestBefore);
      expect(await runCli(repo, ['check', '--require-e2e'], { [VERIFIER_KEY_ENV]: KEY }).then((r) => r.code)).toBe(0);

      // The "helper" change: tracked gate-input bytes change (a comment
      // on the plugin module) WITHOUT changing gate outputs — the run
      // stays obligation-free, so the receipt gate alone decides.
      repo.writeFiles({ 'plugin.mjs': `${PLUGIN_SOURCE}\n// helper touched after the green run\n` });
      const stale = await runCli(repo, ['check', '--require-e2e'], { [VERIFIER_KEY_ENV]: KEY });
      expect(stale.code).toBe(1);
      expect(stale.stdout).toMatch(/EVIDENCE_STALE/);

      // Rerun (a fresh supervised seal for the new tree) clears the block.
      const digestAfter = await currentInputDigest(repo);
      expect(digestAfter).not.toBe(digestBefore);
      await sealGreenRun(repo, digestAfter);
      const cleared = await runCli(repo, ['check', '--require-e2e'], { [VERIFIER_KEY_ENV]: KEY });
      expect(cleared.code).toBe(0);
    });
  });

  it('a forged mac is a typed ENFORCEMENT_UNTRUSTED rejection', async () => {
    await withTempRepo({}, async (repo) => {
      installReceiptFixture(repo);
      const digest = await currentInputDigest(repo);
      await sealGreenRun(repo, digest);
      const stateDir = resolveStateDir(repo.root);
      const receipt = readStateDocument(stateDir, 'receipt.json') as Record<string, unknown>;
      const forged = { ...receipt, mac: 'f'.repeat(64) };
      repo.writeFiles({
        '.gateforge/test-gates/receipt.json': JSON.stringify(forged),
      });
      const result = await runCli(repo, ['check', '--require-e2e'], { [VERIFIER_KEY_ENV]: KEY });
      expect(result.code).toBe(1);
      expect(result.stdout).toMatch(/ENFORCEMENT_UNTRUSTED/);
      expect(result.stdout).toMatch(/forged or tampered/);
    });
  });

  it('a tampered binding (digest swapped under the original mac) cannot verify', async () => {
    await withTempRepo({}, async (repo) => {
      installReceiptFixture(repo);
      const digest = await currentInputDigest(repo);
      await sealGreenRun(repo, digest);
      const stateDir = resolveStateDir(repo.root);
      const receipt = readStateDocument(stateDir, 'receipt.json') as Record<string, unknown>;
      const tampered = { ...receipt, inputDigest: 'a'.repeat(64) };
      repo.writeFiles({ '.gateforge/test-gates/receipt.json': JSON.stringify(tampered) });
      const result = await runCli(repo, ['check', '--require-e2e'], { [VERIFIER_KEY_ENV]: KEY });
      expect(result.code).toBe(1);
      expect(result.stdout).toMatch(/ENFORCEMENT_UNTRUSTED/);
    });
  });

  it('swapping the bound execution result is detected (ENFORCEMENT_UNTRUSTED)', async () => {
    await withTempRepo({}, async (repo) => {
      installReceiptFixture(repo);
      const digest = await currentInputDigest(repo);
      await sealGreenRun(repo, digest);
      // A hostile run-state edit rewrites the supervision record after
      // the receipt sealed it: the re-hash no longer matches.
      const stateDir = resolveStateDir(repo.root);
      const execution = readStateDocument(stateDir, 'execution-result.json') as Record<string, unknown>;
      const swapped = {
        ...execution,
        outcomes: [
          {
            logicalKey: PLANNED_KEY,
            project: 'chromium',
            file: 'e2e/accounts.spec.ts',
            titlePath: ['deletes an account'],
            status: 'failed',
            attempt: 1,
            expectedFailure: false,
          },
        ],
      };
      repo.writeFiles({ '.gateforge/test-gates/execution-result.json': JSON.stringify(swapped) });
      const result = await runCli(repo, ['check', '--require-e2e'], { [VERIFIER_KEY_ENV]: KEY });
      expect(result.code).toBe(1);
      expect(result.stdout).toMatch(/ENFORCEMENT_UNTRUSTED/);
    });
  });

  it('without a verifier key nothing verifies (fail closed)', async () => {
    await withTempRepo({}, async (repo) => {
      installReceiptFixture(repo);
      const digest = await currentInputDigest(repo);
      await sealGreenRun(repo, digest);
      const result = await runCli(repo, ['check', '--require-e2e'], { [VERIFIER_KEY_ENV]: undefined });
      expect(result.code).toBe(1);
      expect(result.stdout).toMatch(/ENFORCEMENT_UNTRUSTED/);
    });
  });

  it('failure-after-evidence: a later failing run clears the receipt and a later check blocks (E07)', async () => {
    await withTempRepo({}, async (repo) => {
      installReceiptFixture(repo);
      const digest = await currentInputDigest(repo);
      await sealGreenRun(repo, digest);
      expect((await runCli(repo, ['check', '--require-e2e'], { [VERIFIER_KEY_ENV]: KEY })).code).toBe(0);

      // A later supervised run fails (e.g. a newly failing test):
      // test-gates invalidates the cached receipt before exiting.
      clearGateReceipt(resolveStateDir(repo.root));
      const after = await runCli(repo, ['check', '--require-e2e'], { [VERIFIER_KEY_ENV]: KEY });
      expect(after.code).toBe(1);
      expect(after.stdout).toMatch(/RUN_INCOMPLETE/);
    });
  });
});

describe('receipt load + reuse decisions (Phase 4 item 8: exact cache reuse)', () => {
  it('tryReuseReceipt reuses ONLY identical authenticated inputs', async () => {
    await withTempRepo({}, async (repo) => {
      installReceiptFixture(repo);
      const stateDir = resolveStateDir(repo.root);
      const config = loadConfig(join(repo.root, '.gateforge.yml'));
      const trustedPolicyDigest = trustedPolicyDigestForConfig(repo.root, config);
      const digest = await currentInputDigest(repo);
      await sealGreenRun(repo, digest);
      const expected = { inputDigest: digest, trustedPolicyDigest };

      expect(tryReuseReceipt(stateDir, KEY, expected)).toEqual({ reuse: true, receipt: expect.objectContaining({ runId: RUN_ID }) });

      // ANY changed input → no reuse.
      repo.writeFiles({ 'src/accounts.txt': 'accounts fixture.table v2\n' });
      const changedDigest = await currentInputDigest(repo);
      expect(tryReuseReceipt(stateDir, KEY, { inputDigest: changedDigest, trustedPolicyDigest })).toMatchObject({ reuse: false });

      // Changed trusted policy → no reuse.
      repo.writeFiles({
        '.gateforge/policies.yml':
          'schemaVersion: 1\npolicies:\n  - id: user-facing-crud-changed\n    when:\n      exposure: user-facing\n    require:\n      - persistence:read\n',
      });
      const changedPolicy = trustedPolicyDigestForConfig(repo.root, loadConfig(join(repo.root, '.gateforge.yml')));
      expect(changedPolicy).not.toBe(trustedPolicyDigest);
      expect(tryReuseReceipt(stateDir, KEY, { inputDigest: digest, trustedPolicyDigest: changedPolicy })).toMatchObject({ reuse: false });

      // No verifier key → never reuse.
      expect(tryReuseReceipt(stateDir, null, expected)).toMatchObject({ reuse: false });

      // No receipt at all → no reuse.
      rmSync(join(stateDir, 'receipt.json'), { force: true });
      expect(tryReuseReceipt(stateDir, KEY, expected)).toMatchObject({ reuse: false });
    });
  });

  it('issueGateReceipt is issued ONLY after complete success (blocking summary refused)', async () => {
    await withTempRepo({}, async (repo) => {
      installReceiptFixture(repo);
      const digest = await currentInputDigest(repo);
      expect(() =>
        issueGateReceipt({
          verifierKey: KEY,
          runId: RUN_ID,
          invocationId: INVOCATION_ID,
          inputDigest: digest,
          gitSha: null,
          parentSha: null,
          trustedPolicyDigest: 'b'.repeat(64),
          invocation: 'test-gates --changed',
          selectionDigest: 'c'.repeat(64),
          catalogDigest: 'd'.repeat(64),
          executionResultDigest: 'e'.repeat(64),
          evidenceAttestationDigest: null,
          ...testReceiptV2Bindings('b'.repeat(64)),
          verdictSummary: { total: 3, satisfied: 2, waived: 0, blocking: 1 },
          issuedAt: FIXED_AT,
        }),
      ).toThrow(/blocking/);
    });
  });

  it('receiptGateBlocking maps each typed load outcome onto its §5.4 cause', () => {
    const causesOf = (load: Parameters<typeof receiptGateBlocking>[0]) =>
      receiptGateBlocking(load).map((entry) => entry.cause);
    expect(causesOf({ status: 'absent' })).toEqual(['RUN_INCOMPLETE']);
    expect(causesOf({ status: 'stale', detail: 'd' })).toEqual(['EVIDENCE_STALE']);
    expect(causesOf({ status: 'unverified', detail: 'd' })).toEqual(['ENFORCEMENT_UNTRUSTED']);
    expect(causesOf({ status: 'malformed', detail: 'd' })).toEqual(['ENFORCEMENT_UNTRUSTED']);
    expect(causesOf({ status: 'execution-mismatch', detail: 'd' })).toEqual(['ENFORCEMENT_UNTRUSTED']);
    expect(receiptGateBlocking({ status: 'ok', receipt: {} as never, executionResult: {} as never })).toEqual([]);
  });

  it('loadReceiptFor rejects an incomplete bound execution result (receipts exist only for complete runs)', async () => {
    await withTempRepo({}, async (repo) => {
      installReceiptFixture(repo);
      const digest = await currentInputDigest(repo);
      await sealGreenRun(repo, digest);
      const stateDir = resolveStateDir(repo.root);
      const config = loadConfig(join(repo.root, '.gateforge.yml'));
      const trustedPolicyDigest = trustedPolicyDigestForConfig(repo.root, config);
      // Overwrite the bound execution result with an INCOMPLETE record
      // and re-sign the receipt over it: the signature is valid, the
      // content is not — still rejected.
      const sealed = sealExecutionResult({
        runId: RUN_ID,
        invocationId: INVOCATION_ID,
        inputDigest: digest,
        trustedPolicyDigest,
        runner: 'playwright',
        logicalKeys: [PLANNED_KEY],
        catalog: EMPTY_CATALOG,
        plannedRows: [plannedRow()],
        envelope: {
          processExit: 1,
          complete: false,
          outcomes: [],
          fixtureOutcome: 'unknown',
          shards: null,
          retriesDetected: false,
          engines: {},
          browsers: {},
          incompleteDetail: 'supervised run failed',
        },
        outcomesDoc: null,
        startedAt: FIXED_AT,
        finishedAt: FIXED_AT,
      });
      writeExecutionResult(stateDir, sealed.result);
      const receipt = issueGateReceipt({
        verifierKey: KEY,
        runId: RUN_ID,
        invocationId: INVOCATION_ID,
        inputDigest: digest,
        gitSha: null,
        parentSha: null,
        trustedPolicyDigest,
        invocation: 'test-gates --changed',
        selectionDigest: sealed.result.selectionDigest,
        catalogDigest: sha256Canonical(EMPTY_CATALOG as unknown as Record<string, never>),
        executionResultDigest: sealed.digest,
        evidenceAttestationDigest: null,
        ...testReceiptV2Bindings(trustedPolicyDigest),
        // Forged clean summary over an incomplete run: content check below
        // must still reject (defense in depth beyond the MAC).
        verdictSummary: { total: 0, satisfied: 0, waived: 0, blocking: 0 },
        issuedAt: FIXED_AT,
      });
      writeGateReceipt(stateDir, receipt);
      expect(
        loadReceiptFor(stateDir, KEY, { inputDigest: digest, trustedPolicyDigest }),
      ).toMatchObject({ status: 'execution-mismatch' });
    });
  });
});

