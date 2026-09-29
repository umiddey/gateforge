/**
 * Shared fixture for the real-CLI test-only re-seal suites (end to end
 * through `test-gates`, and the broker's recomputation of the result).
 * The runner child is a stub CLI (the wired-registration pattern):
 * discovery, planning, supervision, sealing and verification are all
 * the product's own code; what the stub cannot do is lie about WHICH
 * files it was asked to run.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect } from 'vitest';
import { GateReceiptSchema, loadConfig, type GateReceipt, type TempRepo } from '@gate-forge/core';
import { configYml, fixtureFingerprint, installFixture, runCli } from './helpers.js';
import { issueGateReceipt, trustedPolicyDigestForConfig } from '../src/execution.js';
import { environmentVerifierKeyId } from '../src/verifier-keys.js';

export const VERIFIER_KEY = 'reseal-e2e-verifier-key';

/** The two spec files, one test each, as the catalog and runner see them. */
export const SPECS: Record<string, string> = {
  'e2e/accounts.spec.mjs': ["import { test } from 'playwright/test';", "test('reads an account', async () => {});", ''].join('\n'),
  'e2e/orders.spec.mjs': ["import { test } from 'playwright/test';", "test('reads an order', async () => {});", ''].join('\n'),
};

const TITLES: Record<string, string> = {
  'e2e/accounts.spec.mjs': 'reads an account',
  'e2e/orders.spec.mjs': 'reads an order',
};

/** A contract-valid adapter: the witness the run spawns validates it. */
export const ADAPTER = [
  'export default {',
  '  read: async () => null,',
  '  normalize: (body) => ({ entityId: body.id, fields: {} }),',
  "  deletion: 'hard',",
  "  environmentFingerprint: 'reseal-e2e',",
  '};',
  '',
].join('\n');

const STUB_LIST_BODY = [
  "if (argv.includes('--list')) {",
  '  process.stdout.write(JSON.stringify({',
  '    config: { rootDir: process.cwd() },',
  '    suites: files.map((file) => ({',
  '      file,',
  '      specs: [{',
  '        id: file,',
  '        title: titles[file],',
  '        line: 2,',
  '        column: 0,',
  "        tests: [{ projectId: 'chromium', projectName: 'chromium', expectedStatus: 'passed', annotations: [] }],",
  '      }],',
  '    })),',
  '  }));',
  '} else {',
  "  const config = readFileSync(argv[argv.indexOf('--config') + 1], 'utf8');",
  "  const selected = JSON.parse(/testMatch: (\\[[^\\]]*\\])/.exec(config)[1]);",
  "  const reporter = /\"stateDir\":\"([^\"]+)\",\"runId\":\"([^\"]+)\",\"outcomesPath\":\"([^\"]+)\"/.exec(config);",
  "  const spool = reporter[1] + '/spool/' + reporter[2] + '/events.jsonl';",
  "  mkdirSync(spool.replace(/\\/[^/]+$/, ''), { recursive: true });",
  '  const fails = (file) => readFileSync(file, "utf8").includes("__FAIL__");',
  '  const events = selected.flatMap((file) => [',
  "    { kind: 'testBegin', testId: file, workerIndex: 0, file, titlePath: [titles[file]], project: 'chromium' },",
  "    { kind: 'testEnd', testId: file, workerIndex: 0, file, titlePath: [titles[file]], project: 'chromium', outcome: fails(file) ? 'failed' : 'passed', attempt: 1 },",
  '  ]);',
  "  writeFileSync(spool, events.map((event) => JSON.stringify(event)).join('\\n') + '\\n');",
  "  writeFileSync(reporter[3], JSON.stringify({",
  '    schemaVersion: 1,',
  "    runStatus: selected.some(fails) ? 'failed' : 'passed',",
  '    runnerErrors: [],',
  '    shard: null,',
  '    outcomes: selected.map((file) => ({',
  '      testId: file,',
  '      file,',
  '      titlePath: [titles[file]],',
  "      project: 'chromium',",
  "      status: fails(file) ? 'failed' : 'passed',",
  '      attempt: 1,',
  '      expectedFailure: false,',
  '    })),',
  '  }));',
  '}',
].join('\n');

export const STUB_CLI = [
  "const { readFileSync, writeFileSync, mkdirSync } = require('node:fs');",
  'const argv = process.argv.slice(2);',
  `const files = ${JSON.stringify(Object.keys(SPECS))};`,
  `const titles = ${JSON.stringify(TITLES)};`,
  STUB_LIST_BODY,
  '',
].join('\n');

export function waivers(): Record<string, string> {
  return Object.fromEntries(
    ['accounts', 'orders'].map((resource) => [
      `.gateforge/waivers/${resource}.json`,
      JSON.stringify({
        schemaVersion: 1,
        owner: 'team',
        justificationUrl: 'https://example.invalid/justification',
        approver: 'approver@example.invalid',
        scope: {
          kind: 'exact',
          resourceId: `tenant.${resource}`,
          fingerprint: fixtureFingerprint(`tenant.${resource}`),
        },
        expiresAt: '2027-01-01T00:00:00.000Z',
      }),
    ]),
  );
}

/** The real sealed receipt of the run that just finished. */
export function sealedReceipt(repo: { root: string }): GateReceipt {
  return GateReceiptSchema.parse(
    JSON.parse(readFileSync(join(repo.root, '.gateforge/test-gates/receipt.json'), 'utf8')),
  );
}

/** The real sealed execution result of the run that just finished. */
export function sealedExecution(repo: { root: string }): {
  planned: Array<{ logicalKey: string; file: string }>;
  outcomes: Array<{ logicalKey: string; status: string }>;
} {
  return JSON.parse(readFileSync(join(repo.root, '.gateforge/test-gates/execution-result.json'), 'utf8'));
}

/** The environment the two runs and the check share. */
export type ResealEnv = Record<string, string>;

/**
 * Installs the repository and seals a whole-suite parent receipt.
 *
 * Args:
 *   repo: the temporary repository to build.
 *   gateConfig: the gate-mode + enforcement header the fixture declares;
 *     the re-seal path is opt-in, so it must ask for it explicitly.
 *
 * Returns:
 *   ResealEnv: the environment the runs and the check share.
 */
export async function installAndSealParent(
  repo: TempRepo,
  gateConfig = `mode: changed\nenforcement:\n  reseal: true\n`,
): Promise<ResealEnv> {
  installFixture(repo);
  repo.writeFiles({
    ...waivers(),
    ...SPECS,
    '.gateforge/adapters/accounts.mjs': ADAPTER,
    '.gateforge/adapters/orders.mjs': ADAPTER,
    '.gateforge.yml': `${gateConfig}${configYml()}`,
    'playwright.config.mjs': "export default { testDir: 'e2e', projects: [{ name: 'chromium' }] };\n",
    'node_modules/playwright/cli.js': STUB_CLI,
    '.gitignore': '.gateforge/test-gates/\nnode_modules/\n',
  });
  repo.commitFiles({}, 'base');
  const baseSha = repo.headSha() as string;
  const config = loadConfig(repo.path('.gateforge.yml'));
  const approvedPolicyDigest = trustedPolicyDigestForConfig(repo.root, config);
  const env = {
    GATEFORGE_WITNESS_VERIFIER_KEY: VERIFIER_KEY,
    GATEFORGE_APPROVED_POLICY_DIGEST: approvedPolicyDigest,
    CI_MERGE_REQUEST_DIFF_BASE_SHA: baseSha,
  };
  const full = await runCli(repo, ['test-gates', '--changed', '--format', 'json'], env);
  expect(full.code, `${full.stdout}\n${full.stderr}`).toBe(0);
  return env;
}

/**
 * Installs the repository and runs a whole suite in which ONE test
 * fails — the consumer's 563/562 case. A failing test issues no gate
 * receipt, so the run leaves no receipt behind; what it must leave is
 * the MAC'd run record that binds the same evidence without a verdict.
 *
 * Args:
 *   repo: the temporary repository to build.
 *   gateConfig: the gate-mode + enforcement header the fixture declares.
 *
 * Returns:
 *   ResealEnv: the environment the later runs and the check share.
 */
export async function installAndRunFailingParent(
  repo: TempRepo,
  gateConfig = `mode: changed\nenforcement:\n  reseal: true\n`,
): Promise<ResealEnv> {
  installFixture(repo);
  repo.writeFiles({
    ...waivers(),
    ...SPECS,
    'e2e/accounts.spec.mjs': `${SPECS['e2e/accounts.spec.mjs'] as string}// __FAIL__ a race in this test\n`,
    '.gateforge/adapters/accounts.mjs': ADAPTER,
    '.gateforge/adapters/orders.mjs': ADAPTER,
    '.gateforge.yml': `${gateConfig}${configYml()}`,
    'playwright.config.mjs': "export default { testDir: 'e2e', projects: [{ name: 'chromium' }] };\n",
    'node_modules/playwright/cli.js': STUB_CLI,
    '.gitignore': '.gateforge/test-gates/\nnode_modules/\n',
  });
  repo.commitFiles({}, 'base');
  const baseSha = repo.headSha() as string;
  const config = loadConfig(repo.path('.gateforge.yml'));
  const env = {
    GATEFORGE_WITNESS_VERIFIER_KEY: VERIFIER_KEY,
    GATEFORGE_APPROVED_POLICY_DIGEST: trustedPolicyDigestForConfig(repo.root, config),
    CI_MERGE_REQUEST_DIFF_BASE_SHA: baseSha,
  };
  const full = await runCli(repo, ['test-gates', '--changed', '--format', 'json'], env);
  expect(full.code, `${full.stdout}\n${full.stderr}`).not.toBe(0);
  // A failing test seals no receipt (and clears an old one): there is
  // nothing for `check --require-e2e` to accept.
  expect(existsSync(join(repo.root, '.gateforge/test-gates/receipt.json'))).toBe(false);
  return env;
}

/**
 * Fixes ONLY the failing test's file and asks for the re-seal from the
 * run record the failing run left behind.
 *
 * Args:
 *   repo: the temporary repository.
 *   env: the shared run environment.
 *   expectReseal: false where the run must NOT re-seal.
 *
 * Returns:
 *   { code, stdout, stderr }: the re-seal invocation's own result.
 */
export async function fixFailingSpecAndReseal(
  repo: TempRepo,
  env: ResealEnv,
  { expectReseal = true }: { expectReseal?: boolean } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  repo.commitFiles(
    { 'e2e/accounts.spec.mjs': `${SPECS['e2e/accounts.spec.mjs'] as string}// the race is fixed\n` },
    'fix the race in the one failing spec',
  );
  const resealed = await runCli(repo, ['test-gates', '--changed', '--scope', 'changed', '--format', 'json'], env);
  if (!expectReseal) return resealed;
  expect(resealed.code, `${resealed.stdout}\n${resealed.stderr}`).toBe(0);
  expect(resealed.stderr).toContain('only test files changed: re-ran 1 test(s), kept 1 from the previous run');
  return resealed;
}

/** The run record the last whole-suite run left in the run state. */
export function sealedRunRecord(repo: { root: string }): Record<string, unknown> {
  return JSON.parse(readFileSync(join(repo.root, '.gateforge/test-gates/run-record.json'), 'utf8'));
}

/**
 * Changes ONE test file and asks for the re-seal.
 *
 * Args:
 *   repo: the temporary repository.
 *   env: the shared run environment.
 *   expectReseal: false for a repository that must NOT re-seal, where
 *     the run is allowed to fall through to its ordinary path.
 *
 * Returns:
 *   { code, stdout, stderr }: the re-seal invocation's own result.
 */
export async function changeOneSpecAndReseal(
  repo: TempRepo,
  env: ResealEnv,
  { expectReseal = true }: { expectReseal?: boolean } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  repo.commitFiles(
    { 'e2e/accounts.spec.mjs': `${SPECS['e2e/accounts.spec.mjs'] as string}// the race fix\n` },
    'fix the race in one spec',
  );
  const resealed = await runCli(repo, ['test-gates', '--changed', '--scope', 'changed', '--format', 'json'], env);
  if (!expectReseal) return resealed;
  expect(resealed.code, `${resealed.stdout}\n${resealed.stderr}`).toBe(0);
  expect(resealed.stderr).toContain('only test files changed: re-ran 1 test(s), kept 1 from the previous receipt');
  return resealed;
}

/**
 * Re-issues the sealed receipt with a fresh MAC over a DIFFERENT claim —
 * the strongest forgery a holder of the verifier key can make, and
 * exactly what a consumer must catch by recomputing.
 *
 * Args:
 *   repo: the repository whose run state holds the sealed receipt.
 *   changedPaths: the claim the forged receipt carries.
 *
 * Returns:
 *   void.
 */
export function reforgeReceipt(repo: TempRepo, changedPaths: readonly string[]): void {
  const current = sealedReceipt(repo);
  const forged = issueGateReceipt({
    verifierKey: VERIFIER_KEY,
    verifierKeyId: environmentVerifierKeyId(VERIFIER_KEY),
    runId: current.runId,
    invocationId: current.invocationId,
    inputDigest: current.inputDigest,
    gitSha: current.gitSha,
    parentSha: current.parentSha ?? null,
    trustedPolicyDigest: current.trustedPolicyDigest,
    ...(current.approvedPolicyDigest === undefined ? {} : { approvedPolicyDigest: current.approvedPolicyDigest }),
    engine: current.engine,
    ...(current.receiptStage === undefined ? {} : { receiptStage: current.receiptStage }),
    carriedFrom: current.carriedFrom as string,
    parentReceiptDigest: current.parentReceiptDigest as string,
    resealedFrom: current.resealedFrom,
    carriedTests: current.carriedTests,
    rerunTests: current.rerunTests,
    changeClass: current.changeClass,
    changedPaths,
    invocation: current.invocation,
    selectionDigest: current.selectionDigest,
    catalogDigest: current.catalogDigest,
    scope: current.scope,
    coveredObligationFingerprints: current.coveredObligationFingerprints,
    executionResultDigest: current.executionResultDigest,
    evidenceAttestationDigest: current.evidenceAttestationDigest,
    candidateTreeId: current.candidateTreeId,
    behaviorCatalogDigest: current.behaviorCatalogDigest,
    requiredCaseSetDigest: current.requiredCaseSetDigest,
    caseExecutionDigest: current.caseExecutionDigest,
    engineBundleDigest: current.engineBundleDigest,
    executionBoundaryDigest: current.executionBoundaryDigest,
    targetArtifactDigest: current.targetArtifactDigest,
    verdictSummary: current.verdictSummary,
    issuedAt: current.issuedAt,
  });
  writeFileSync(
    join(repo.root, '.gateforge/test-gates/receipt.json'),
    `${JSON.stringify(forged, null, 2)}\n`,
    'utf8',
  );
}
