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

/** Two server-witnessed spec files; their bodies do not imply browser traffic. */
export const SPECS: Record<string, string> = {
  'e2e/accounts.spec.mjs': ["import { test } from '@gate-forge/pack-playwright';", "test('reads an account', async () => {});", ''].join('\n'),
  'e2e/orders.spec.mjs': ["import { test } from '@gate-forge/pack-playwright';", "test('reads an order', async () => {});", ''].join('\n'),
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

/**
 * Every evidence spec the fixture can install: the runner sees one test
 * per file, the sidecar maps it, and the witness probes the row while
 * it runs. A test names its resource in `__EVIDENCE__`, so the suite
 * scales to N specs without changing any runner code.
 */
const EVIDENCE_SPEC_TABLE = [
  { name: 'accounts', title: 'reads an account', row: 'account' },
  { name: 'orders', title: 'reads an order', row: 'order' },
  { name: 'invoices', title: 'reads an invoice', row: 'invoice' },
] as const;

/** The two-spec evidence repository every existing suite installs. */
export const DEFAULT_EVIDENCE_NAMES: readonly string[] = ['accounts', 'orders'];

/** The fixture's spec rows; exported for suites that extend the stub runner. */
export function evidenceSpecTable(names: readonly string[]): Array<(typeof EVIDENCE_SPEC_TABLE)[number]> {
  const chosen = EVIDENCE_SPEC_TABLE.filter((row) => names.includes(row.name));
  if (chosen.length !== names.length) throw new Error(`unknown evidence spec: ${names.join(', ')}`);
  return chosen;
}

function evidenceSpecFile(name: string): string {
  return `e2e/${name}.spec.mjs`;
}

function evidenceSpecsOf(names: readonly string[], serverWitnessed = false): Record<string, string> {
  return Object.fromEntries(
    evidenceSpecTable(names).map((row) => [
      evidenceSpecFile(row.name),
      [
        serverWitnessed
          ? "import { test } from '@gate-forge/pack-playwright';"
          : "import { test } from 'playwright/test';",
        serverWitnessed
          ? `test('${row.title}', async () => {});`
          : `test('${row.title}', async ({ page }) => {`,
        ...(serverWitnessed ? [] : ["  await page.goto('/');", "  await page.getByRole('button', { name: 'Open' }).click();", '});']),
        `// __EVIDENCE__ tenant.${row.name}`,
        '',
      ].join('\n'),
    ]),
  );
}

/** The evidence spec files; `__EVIDENCE__` drives the witness intent. */
export function evidenceSpecs(
  names: readonly string[] = DEFAULT_EVIDENCE_NAMES,
  serverWitnessed = false,
): Record<string, string> {
  return evidenceSpecsOf(names, serverWitnessed);
}

/** The evidence spec files of the standard two-spec server-witnessed repository. */
export const EVIDENCE_SPECS: Record<string, string> = evidenceSpecsOf(DEFAULT_EVIDENCE_NAMES, true);

/** The sidecar identity (and so the claim's testId) of each evidence spec. */
export function evidenceKeys(names: readonly string[] = DEFAULT_EVIDENCE_NAMES): Record<string, string> {
  return Object.fromEntries(
    evidenceSpecTable(names).map((row) => [evidenceSpecFile(row.name), `${row.name}-e2e`]),
  );
}

export const EVIDENCE_KEYS: Record<string, string> = evidenceKeys();

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

/** The sidecar mapping the named evidence tests, declared `server-e2e`. */
export function evidenceTestMap(names: readonly string[] = DEFAULT_EVIDENCE_NAMES): string {
  return [
    'schemaVersion: 1',
    'tests:',
    ...evidenceSpecTable(names).flatMap((row) => [
      `  - key: ${row.name}-e2e`,
      '    selector:',
      '      runner: playwright',
      `      file: ${evidenceSpecFile(row.name)}`,
      '      titlePath:',
      `        - ${row.title}`,
      '    kind: server-e2e',
      '    claims:',
      `      - tenant.${row.name}:persistence:read`,
      `    reason: the witness probes the ${row.row} row server-side while this test runs`,
    ]),
    '',
  ].join('\n');
}

export const EVIDENCE_TEST_MAP: string = evidenceTestMap();

/**
 * The evidence stub runner: the wire-registration pattern plus the two
 * suite-side channels a real reporter drives — the persistence-intent
 * spool (the witness observes; the suite only declares) and the
 * witness-issued ledger copy the evaluator reads.
 */
export function evidenceStubCli(names: readonly string[] = DEFAULT_EVIDENCE_NAMES): string {
  return [
  "const { readFileSync, writeFileSync, mkdirSync } = require('node:fs');",
  'const argv = process.argv.slice(2);',
  `const files = ${JSON.stringify(Object.keys(evidenceSpecs(names)))};`,
  `const titles = ${JSON.stringify(
    Object.fromEntries(evidenceSpecTable(names).map((row) => [evidenceSpecFile(row.name), row.title])),
  )};`,
  `const keys = ${JSON.stringify(evidenceKeys(names))};`,
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
}

export const EVIDENCE_STUB_CLI: string = evidenceStubCli();

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

/**
 * Writes the evidence repository (specs, sidecar, attested adapters,
 * and the resource file each obligation is derived from).
 *
 * Args:
 *   repo: the temporary repository.
 *   appUrl: the attested app's loopback base URL.
 *   specOverrides: spec bodies written over the generated ones.
 *   names: the specs to install; the whole table minus these is absent,
 *     so a suite can ask for a two- or a three-spec repository.
 */
export function installEvidenceRepo(
  repo: TempRepo,
  appUrl: string,
  specOverrides: Record<string, string> = {},
  names: readonly string[] = DEFAULT_EVIDENCE_NAMES,
): void {
  const table = evidenceSpecTable(names);
  repo.writeFiles({
    ...evidenceSpecs(names, true),
    ...specOverrides,
    ...Object.fromEntries(table.map((row) => [`src/${row.name}.txt`, `${row.name} fixture.table\n`])),
    ...Object.fromEntries(table.map((row) => [`.gateforge/adapters/${row.name}.mjs`, evidenceAdapter(appUrl)])),
    '.gateforge/test-map.yml': evidenceTestMap(names),
    'playwright.config.mjs': "export default { testDir: 'e2e', projects: [{ name: 'chromium' }] };\n",
    'node_modules/playwright/cli.js': evidenceStubCli(names),
    '.gitignore': '.gateforge/test-gates/\nnode_modules/\n',
  });
}

/** The evidence repository a test sealed its parent from. */
export interface EvidenceParent {
  env: ResealEnv;
  close: () => Promise<void>;
}

/**
 * Installs the evidence repository and seals a CLEAN whole-suite parent
 * receipt whose obligations are proven by witnessed records.
 *
 * Args:
 *   repo: the temporary repository.
 *   names: the specs to install.
 *
 * Returns:
 *   { env, close }: the shared run environment, and the attested app the
 *   witness probes — it must stay up for EVERY later run in the test,
 *   not just the parent.
 */
export async function installAndSealEvidenceParent(
  repo: TempRepo,
  names: readonly string[] = DEFAULT_EVIDENCE_NAMES,
): Promise<EvidenceParent> {
  const app = await startEvidenceApp();
  installFixture(repo);
  installEvidenceRepo(repo, app.url, {}, names);
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
  names: readonly string[] = DEFAULT_EVIDENCE_NAMES,
): Promise<EvidenceParent> {
  const app = await startEvidenceApp();
  installFixture(repo);
  installEvidenceRepo(
    repo,
    app.url,
    { 'e2e/orders.spec.mjs': `${evidenceSpecs(names, true)['e2e/orders.spec.mjs'] as string}// __FAIL__ a race in this test\n` },
    names,
  );
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

/**
 * Commits a change to ONE evidence spec and asks for the re-seal. The
 * carried count is a parameter because it grows with the chain: a
 * three-spec repository carries two tests on the first hop and keeps
 * carrying them on every hop after it.
 *
 * Args:
 *   repo: the temporary repository.
 *   env: the shared run environment.
 *   spec: the spec file to change.
 *   options.carried: the kept-test count the printed line must state.
 *   options.parentKind: which document the parent is, which the
 *     printed line names (`run` for a run record, `receipt` otherwise).
 *   options.message: the commit message.
 *   options.fix: strips a planted `__FAIL__` marker, so the re-run of
 *     a spec the previous run failed actually passes.
 *   options.expectReseal: false where the run must NOT re-seal.
 *
 * Returns:
 *   { code, stdout, stderr }: the re-seal invocation's own result.
 */
export async function changeEvidenceSpecAndReseal(
  repo: TempRepo,
  env: ResealEnv,
  spec: string,
  {
    carried,
    parentKind = 'receipt',
    message,
    fix = false,
    expectReseal = true,
  }: {
    carried: number;
    parentKind?: 'run' | 'receipt';
    message: string;
    fix?: boolean;
    expectReseal?: boolean;
  },
): Promise<{ code: number; stdout: string; stderr: string }> {
  const body = readFileSync(join(repo.root, spec), 'utf8')
    .split('\n')
    .filter((line) => !fix || !line.includes('__FAIL__'))
    .join('\n');
  repo.commitFiles({ [spec]: `${body}// ${message}\n` }, message);
  const resealed = await runCli(repo, ['test-gates', '--changed', '--scope', 'changed', '--format', 'json'], env);
  if (!expectReseal) return resealed;
  expect(resealed.code, `${resealed.stdout}\n${resealed.stderr}`).toBe(0);
  expect(resealed.stderr).toContain(
    `only test files changed: re-ran 1 test(s), kept ${String(carried)} from the previous ${parentKind}`,
  );
  return resealed;
}

/**
 * Changes ONE of the non-evidence fixture's spec files and asks for the
 * re-seal. Kept separate from {@link changeOneSpecAndReseal} so a
 * chain's SECOND hop can touch a different file, which is what makes
 * the first re-seal its parent.
 *
 * Args:
 *   repo: the temporary repository.
 *   env: the shared run environment.
 *   spec: the spec file to change.
 *
 * Returns:
 *   { code, stdout, stderr }: the re-seal invocation's own result.
 */
export async function changeSpecAndReseal(
  repo: TempRepo,
  env: ResealEnv,
  spec: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  repo.commitFiles({ [spec]: `${readFileSync(join(repo.root, spec), 'utf8')}// one more fix\n` }, 'one more fix');
  const resealed = await runCli(repo, ['test-gates', '--changed', '--scope', 'changed', '--format', 'json'], env);
  expect(resealed.code, `${resealed.stdout}\n${resealed.stderr}`).toBe(0);
  expect(resealed.stderr).toContain('only test files changed: re-ran 1 test(s), kept 1 from the previous receipt');
  return resealed;
}

/** The state-dir evidence ledger of the run that just finished. */
export function stateRecords(repo: { root: string }): unknown[] {
  return JSON.parse(readFileSync(join(repo.root, '.gateforge/test-gates/records.json'), 'utf8')) as unknown[];
}
