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
 * The environment every re-seal fixture run shares: the witness key,
 * the owner-approved policy digest, and the CI diff base.
 *
 * The diff base belongs to a DIFFERENT consumer: `check --changed`
 * asks the diff provider what changed, and that is the only thing
 * that reads it here. A re-seal binds the parent to the commit the
 * parent document names, so the suite that re-seals with the
 * variable REMOVED proves the path needs no such variable, and the
 * suite that publishes a base naming another commit proves it
 * ignores one.
 *
 * Args:
 *   repo: the repository whose config pins the approved policy.
 *
 * Returns:
 *   ResealEnv: the environment the runs and the check share.
 */
export function resealRunEnv(repo: TempRepo): ResealEnv {
  const config = loadConfig(repo.path('.gateforge.yml'));
  return {
    GATEFORGE_WITNESS_VERIFIER_KEY: VERIFIER_KEY,
    GATEFORGE_APPROVED_POLICY_DIGEST: trustedPolicyDigestForConfig(repo.root, config),
    CI_MERGE_REQUEST_DIFF_BASE_SHA: repo.headSha() as string,
  };
}

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
    // `.auth/` is gitignored: the witnessed login stage writes its
    // storage state there, so it exists in the sealed candidate tree as
    // ignored workspace bytes and never in a commit.
    '.gitignore': '.gateforge/test-gates/\nnode_modules/\n.auth/\n',
  });
  repo.commitFiles({}, 'base');
  const env = resealRunEnv(repo);
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
 *   options.uncommittedChanges: files edited AFTER the base commit and
 *     BEFORE the run, so the run seals a tree the merge-base commit does
 *     not contain — the consumer's uncommitted-change case.
 *
 * Returns:
 *   ResealEnv: the environment the later runs and the check share.
 */
export async function installAndRunFailingParent(
  repo: TempRepo,
  gateConfig = `mode: changed\nenforcement:\n  reseal: true\n`,
  { uncommittedChanges = {} }: { uncommittedChanges?: Record<string, string> } = {},
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
    '.gitignore': '.gateforge/test-gates/\nnode_modules/\n.auth/\n',
  });
  repo.commitFiles({}, 'base');
  if (Object.keys(uncommittedChanges).length > 0) repo.writeFiles(uncommittedChanges);
  const env = resealRunEnv(repo);
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
 * Writes the gitignored storage state a witnessed login stage rewrites
 * on every run. The bytes live only in the workspace: `git ls-files`
 * never lists them and `git check-ignore` claims them.
 *
 * Args:
 *   repo: the repository whose workspace gains the runtime file.
 *   name: the state file name inside `.auth/`.
 *   token: the fresh value the run leaves behind.
 *
 * Returns:
 *   void.
 */
export function writeIgnoredRuntimeState(repo: TempRepo, name: string, token: string): void {
  repo.writeFiles({ [`.auth/${name}`]: `{"token":"${token}"}\n` });
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
 *   resealDisregarded: the disregarded-list claim, when the test forges
 *     that field instead of `changedPaths`.
 *
 * Returns:
 *   void.
 */
export function reforgeReceipt(
  repo: TempRepo,
  changedPaths: readonly string[],
  resealDisregarded?: readonly string[],
): void {
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
    ...(resealDisregarded !== undefined
      ? { resealDisregarded }
      : current.resealDisregarded !== undefined
        ? { resealDisregarded: current.resealDisregarded }
        : {}),
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

/* ------------------------------------------------------------------ *
 * Witnessed-evidence variant: the same re-seal, but the obligations
 * are proven by WITNESS-ISSUED records (the server-witnessed
 * persistence channel) instead of owner waivers, so a carried test's
 * evidence is the only thing that can satisfy what it proved in the
 * parent run.
 * ------------------------------------------------------------------ */

/** The environment marker the attested app presents (GF-13). */
export const EVIDENCE_FINGERPRINT = 'reseal-e2e-env';

/** The two evidence spec files; `__EVIDENCE__` drives the witness intent. */
export const EVIDENCE_SPECS: Record<string, string> = {
  'e2e/accounts.spec.mjs': [
    "import { test } from 'playwright/test';",
    "test('reads an account', async () => {});",
    '// __EVIDENCE__ tenant.accounts',
    '',
  ].join('\n'),
  'e2e/orders.spec.mjs': [
    "import { test } from 'playwright/test';",
    "test('reads an order', async () => {});",
    '// __EVIDENCE__ tenant.orders',
    '',
  ].join('\n'),
};

/** The sidecar identity (and so the claim's testId) of each evidence spec. */
export const EVIDENCE_KEYS: Record<string, string> = {
  'e2e/accounts.spec.mjs': 'accounts-e2e',
  'e2e/orders.spec.mjs': 'orders-e2e',
};

/** The evidence adapter: an attested read base plus the server-side probe. */
export function evidenceAdapter(baseUrl: string): string {
  return [
    'export default {',
    `  baseUrl: '${baseUrl}',`,
    '  read: async () => null,',
    '  normalize: (body) => ({ entityId: body.id, fields: {} }),',
    "  deletion: 'hard',",
    `  environmentFingerprint: '${EVIDENCE_FINGERPRINT}',`,
    '  probeServer: async () => ({ found: true, fields: { id: "acc-1" } }),',
    '};',
    '',
  ].join('\n');
}

/** The sidecar mapping both evidence tests, declared `server-e2e`. */
export const EVIDENCE_TEST_MAP = [
  'schemaVersion: 1',
  'tests:',
  '  - key: accounts-e2e',
  '    selector:',
  '      runner: playwright',
  '      file: e2e/accounts.spec.mjs',
  '      titlePath:',
  '        - reads an account',
  '    kind: server-e2e',
  '    claims:',
  '      - tenant.accounts:persistence:read',
  '    reason: the witness probes the account row server-side while this test runs',
  '  - key: orders-e2e',
  '    selector:',
  '      runner: playwright',
  '      file: e2e/orders.spec.mjs',
  '      titlePath:',
  '        - reads an order',
  '    kind: server-e2e',
  '    claims:',
  '      - tenant.orders:persistence:read',
  '    reason: the witness probes the order row server-side while this test runs',
  '',
].join('\n');

/**
 * The evidence stub runner: the wire-registration pattern plus the two
 * suite-side channels a real reporter drives — the persistence-intent
 * spool (the witness observes; the suite only declares) and the
 * witness-issued ledger copy the evaluator reads.
 */
export const EVIDENCE_STUB_CLI = [
  "const { readFileSync, writeFileSync, mkdirSync } = require('node:fs');",
  'const argv = process.argv.slice(2);',
  `const files = ${JSON.stringify(Object.keys(EVIDENCE_SPECS))};`,
  `const titles = ${JSON.stringify({
    'e2e/accounts.spec.mjs': 'reads an account',
    'e2e/orders.spec.mjs': 'reads an order',
  })};`,
  `const keys = ${JSON.stringify(EVIDENCE_KEYS)};`,
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
  '  const selected = JSON.parse(/testMatch: (\\[[^\\]]*\\])/.exec(config)[1]);',
  '  const reporter = /"stateDir":"([^"]+)","runId":"([^"]+)","outcomesPath":"([^"]+)"/.exec(config);',
  '  const stateDir = reporter[1];',
  '  const runId = reporter[2];',
  "  const spool = stateDir + '/spool/' + runId;",
  '  mkdirSync(spool, { recursive: true });',
  "  const fails = (file) => readFileSync(file, 'utf8').includes('__FAIL__');",
  '  const intents = [];',
  '  const events = selected.flatMap((file) => {',
  '    const declared = /__EVIDENCE__ (tenant\\.[a-z]+)/.exec(readFileSync(file, "utf8"));',
  '    if (declared !== null) {',
  '      intents.push({',
  '        entity: declared[1],',
  '        operation: "read",',
  '        phase: "post",',
  '        intent: "expect-present",',
  '        key: "acc-1",',
  '        claimId: declared[1] + ":persistence:read",',
  '        testId: keys[file],',
  '        sequence: 1,',
  '      });',
  '    }',
  "    return [",
  "      { kind: 'testBegin', testId: file, workerIndex: 0, file, titlePath: [titles[file]], project: 'chromium' },",
  "      { kind: 'testEnd', testId: file, workerIndex: 0, file, titlePath: [titles[file]], project: 'chromium', outcome: fails(file) ? 'failed' : 'passed', attempt: 1 },",
  '    ];',
  '  });',
  "  writeFileSync(spool + '/events.jsonl', events.map((event) => JSON.stringify(event)).join('\\n') + '\\n');",
  "  writeFileSync(spool + '/persistence-intents.jsonl', intents.map((intent) => JSON.stringify(intent)).join('\\n') + '\\n');",
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
  '  const url = process.env.GATEFORGE_WITNESS_URL;',
  '  const token = process.env.GATEFORGE_RUN_TOKEN;',
  '  // The engine reporter copies the WITNESS-ISSUED ledger once every',
  '  // session answered; the suite can only read it, never write it.',
  '  const copyLedger = async () => {',
  '    if (url === undefined || token === undefined) return;',
  '    for (let attempt = 0; attempt < 200; attempt += 1) {',
  '      const response = await fetch(url + "/records", { headers: { "x-gateforge-run": token } });',
  '      const body = await response.json();',
  '      if (Array.isArray(body.records) && body.records.length >= intents.length) {',
  '        writeFileSync(stateDir + "/records.json", JSON.stringify(body.records, null, 2) + "\\n");',
  '        return;',
  '      }',
  '      await new Promise((resolve) => setTimeout(resolve, 25));',
  '    }',
  '  };',
  '  copyLedger();',
  '}',
  '',
].join('\n');

/** The attested app the witness probes before every adapter read (GF-13). */
export interface EvidenceApp {
  url: string;
  close: () => Promise<void>;
}

/** Starts the attested environment on a free loopback port. */
export async function startEvidenceApp(): Promise<EvidenceApp> {
  const { createServer } = await import('node:http');
  const server = createServer((_request, response) => {
    response.setHeader('x-gateforge-env-fingerprint', EVIDENCE_FINGERPRINT);
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end('{}');
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve();
    });
  });
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return {
    url: `http://127.0.0.1:${String(port)}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      }),
  };
}

/** Writes the evidence repository (specs, sidecar, attested adapters). */
export function installEvidenceRepo(repo: TempRepo, appUrl: string, specOverrides: Record<string, string> = {}): void {
  repo.writeFiles({
    ...EVIDENCE_SPECS,
    ...specOverrides,
    '.gateforge/adapters/accounts.mjs': evidenceAdapter(appUrl),
    '.gateforge/adapters/orders.mjs': evidenceAdapter(appUrl),
    '.gateforge/test-map.yml': EVIDENCE_TEST_MAP,
    'playwright.config.mjs': "export default { testDir: 'e2e', projects: [{ name: 'chromium' }] };\n",
    'node_modules/playwright/cli.js': EVIDENCE_STUB_CLI,
    '.gitignore': '.gateforge/test-gates/\nnode_modules/\n',
  });
}

/**
 * Installs the evidence repository and seals a CLEAN whole-suite parent
 * receipt whose two obligations are proven by witnessed records.
 *
 * Args:
 *   repo: the temporary repository.
 *
 * Returns:
 *   { env, close }: the shared run environment, and the attested app the
 *   witness probes — it must stay up for EVERY later run in the test,
 *   not just the parent.
 */
export async function installAndSealEvidenceParent(repo: TempRepo): Promise<{ env: ResealEnv; close: () => Promise<void> }> {
  const app = await startEvidenceApp();
  installFixture(repo);
  installEvidenceRepo(repo, app.url);
  repo.writeFiles({ '.gateforge.yml': `mode: changed\nenforcement:\n  reseal: true\n${configYml()}` });
  repo.commitFiles({}, 'base');
  const env = resealRunEnv(repo);
  const full = await runCli(repo, ['test-gates', '--changed', '--format', 'json'], env);
  expect(full.code, `${full.stdout}\n${full.stderr}`).toBe(0);
  return { env, close: app.close };
}

/**
 * Installs the evidence repository and runs a whole suite in which the
 * ORDERS test fails on a planted test bug: the run seals no receipt and
 * leaves the run record a re-seal may carry from.
 */
export async function installAndRunFailingEvidenceParent(
  repo: TempRepo,
): Promise<{ env: ResealEnv; close: () => Promise<void> }> {
  const app = await startEvidenceApp();
  installFixture(repo);
  installEvidenceRepo(repo, app.url, {
    'e2e/orders.spec.mjs': `${EVIDENCE_SPECS['e2e/orders.spec.mjs'] as string}// __FAIL__ a race in this test\n`,
  });
  repo.writeFiles({ '.gateforge.yml': `mode: changed\nenforcement:\n  reseal: true\n${configYml()}` });
  repo.commitFiles({}, 'base');
  const env = resealRunEnv(repo);
  const full = await runCli(repo, ['test-gates', '--changed', '--format', 'json'], env);
  expect(full.code, `${full.stdout}\n${full.stderr}`).not.toBe(0);
  expect(existsSync(join(repo.root, '.gateforge/test-gates/receipt.json'))).toBe(false);
  return { env, close: app.close };
}

/**
 * Edits ONLY the orders spec and asks for the re-seal.
 *
 * Args:
 *   repo: the temporary repository.
 *   env: the shared run environment.
 *   options.keepEvidence: false makes the fixed test stop declaring its
 *     persistence intent, so the re-run proves nothing and the parent's
 *     record must not survive.
 *   options.expectReseal: false where the run must NOT re-seal.
 *
 * Returns:
 *   { code, stdout, stderr }: the re-seal invocation's own result.
 */
export async function fixOrdersSpecAndReseal(
  repo: TempRepo,
  env: ResealEnv,
  { keepEvidence = true, expectReseal = true }: { keepEvidence?: boolean; expectReseal?: boolean } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  const body = (EVIDENCE_SPECS['e2e/orders.spec.mjs'] as string)
    .split('\n')
    .filter((line) => keepEvidence || !line.includes('__EVIDENCE__'))
    .join('\n');
  repo.commitFiles(
    {
      'e2e/orders.spec.mjs': keepEvidence
        ? `${body}// the race is fixed\n`
        : `${body}// the race is fixed and the assertion was dropped\n`,
    },
    'fix the race in the one failing spec',
  );
  const resealed = await runCli(repo, ['test-gates', '--changed', '--scope', 'changed', '--format', 'json'], env);
  if (!expectReseal) return resealed;
  expect(resealed.code, `${resealed.stdout}\n${resealed.stderr}`).toBe(0);
  expect(resealed.stderr).toContain('only test files changed: re-ran 1 test(s), kept 1 from the previous run');
  return resealed;
}

/** The state-dir evidence ledger of the run that just finished. */
export function stateRecords(repo: { root: string }): unknown[] {
  return JSON.parse(readFileSync(join(repo.root, '.gateforge/test-gates/records.json'), 'utf8')) as unknown[];
}
