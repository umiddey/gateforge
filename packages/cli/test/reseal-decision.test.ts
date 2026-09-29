/**
 * The test-only re-seal decision (plan phase 2): given a verified parent
 * receipt and the two sealed trees, may this `--scope changed` run
 * re-run exactly the affected tests and re-seal? Every rule is decided
 * by Gateforge's own recomputation, and every refusal is ONE plain line
 * naming the first offending path or test.
 */
import { describe, expect, it } from 'vitest';
import { withTempRepo, GateReceiptSchema, type GateReceipt, type ExecutionResult, type TestCatalog, type TestCatalogEntry, type Obligation } from '@gate-forge/core';
import { computeCandidateTreeId, resolveGitDir } from '../src/candidate-tree.js';
import { decideTestOnlyReseal } from '../src/commands/test-gates.js';

const SPEC = [
  "import { test, expect } from '@playwright/test';",
  '',
  "test('reads an account', async () => {",
  '  expect(1).toBe(1);',
  '});',
  '',
].join('\n');

const BASE_FILES: Record<string, string> = {
  'src/accounts.ts': 'export const accounts = 1;\n',
  'e2e/helper.ts': 'export const amount = () => 1;\n',
  'e2e/accounts.spec.ts': SPEC,
  'e2e/orders.spec.ts': SPEC,
  '.gitignore': '.gateforge/\n',
};

function treeOf(root: string): string {
  const gitDir = resolveGitDir(root, process.env);
  return computeCandidateTreeId(gitDir as string, root, process.env, '.gateforge') as string;
}

function entry(file: string, title: string): TestCatalogEntry {
  const titlePath = ['Suite', title];
  return {
    logicalKey: `playwright:chromium:${file}:${titlePath.join('>')}`,
    runner: 'playwright',
    project: 'chromium',
    file,
    titlePath,
    title,
    sourceLocation: { file, line: 3, col: 0 },
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

function catalog(entries: TestCatalogEntry[]): TestCatalog {
  return { schemaVersion: 1, entries, unresolved: [], parseErrors: [], inventoryComplete: true, runnerSummaries: [] };
}

function obligation(id: string): Obligation {
  return {
    schemaVersion: 1,
    id,
    resourceId: id.split(':')[0] as string,
    contract: 'persistence:read',
    policyId: 'user-facing-crud',
    lifecycle: { create: true, read: true, update: true, delete: true, deleteSemantics: 'hard' },
  };
}

const ACCOUNTS_KEY = 'playwright:chromium:e2e/accounts.spec.ts:Suite>reads an account';
const ORDERS_KEY = 'playwright:chromium:e2e/orders.spec.ts:Suite>reads an account';

function parentReceipt(overrides: Partial<GateReceipt> = {}): GateReceipt {
  return GateReceiptSchema.parse({
    schemaVersion: 1,
    receiptVersion: 2,
    receiptId: '22222222-3333-4333-8444-555555555555',
    runId: '11111111-2222-4333-8444-555555555555',
    invocationId: '66666666-7777-4888-8999-000000000000',
    inputDigest: 'a'.repeat(64),
    gitSha: 'b'.repeat(40),
    parentSha: null,
    trustedPolicyDigest: 'c'.repeat(64),
    invocation: 'test-gates --changed',
    selectionDigest: 'd'.repeat(64),
    catalogDigest: 'e'.repeat(64),
    executionResultDigest: 'f'.repeat(64),
    evidenceAttestationDigest: null,
    candidateTreeId: '1'.repeat(40),
    behaviorCatalogDigest: '2'.repeat(64),
    requiredCaseSetDigest: '3'.repeat(64),
    caseExecutionDigest: '4'.repeat(64),
    engineBundleDigest: '5'.repeat(64),
    executionBoundaryDigest: '6'.repeat(64),
    targetArtifactDigest: '7'.repeat(64),
    verdictSummary: { total: 2, satisfied: 2, waived: 0, blocking: 0 },
    issuedAt: '2026-01-01T00:00:00.000Z',
    mac: '8'.repeat(64),
    ...overrides,
  });
}

function parentExecution(outcomes: Array<{ logicalKey: string; status: string }>): ExecutionResult {
  return {
    schemaVersion: 1,
    runId: '11111111-2222-4333-8444-555555555555',
    invocationId: '66666666-7777-4888-8999-000000000000',
    inputDigest: 'a'.repeat(64),
    trustedPolicyDigest: 'c'.repeat(64),
    runner: 'playwright',
    complete: true,
    causes: [],
    planned: [
      { logicalKey: ACCOUNTS_KEY, project: 'chromium', file: 'e2e/accounts.spec.ts', titlePath: ['Suite', 'reads an account'], frameworkId: null },
      { logicalKey: ORDERS_KEY, project: 'chromium', file: 'e2e/orders.spec.ts', titlePath: ['Suite', 'reads an account'], frameworkId: null },
    ],
    outcomes: outcomes.map((outcome) => ({ ...outcome, attempt: 1, expectedFailure: false, file: 'e2e/accounts.spec.ts', titlePath: ['Suite', 'reads an account'], project: 'chromium' })),
    sessionTrace: [],
    engines: { node: process.version },
    browsers: {},
    environmentIdentity: {},
    shardCompleteness: null,
    maxAttemptObserved: 1,
    runnerExit: { code: 0 },
    enumerationDigest: '9'.repeat(64),
    catalogDigest: 'e'.repeat(64),
    selectionDigest: 'd'.repeat(64),
    claimInventory: [],
    fixtureOutcome: null,
    startedAt: '2026-01-01T00:00:00.000Z',
    finishedAt: '2026-01-01T00:00:00.000Z',
  } as unknown as ExecutionResult;
}

const PASSED = [
  { logicalKey: ACCOUNTS_KEY, status: 'passed' },
  { logicalKey: ORDERS_KEY, status: 'passed' },
];

describe('test-only re-seal decision', () => {
  it('re-runs exactly the changed test file and carries the rest', async () => {
    await withTempRepo({}, async (repo) => {
      repo.writeFiles(BASE_FILES);
      repo.commitFiles({}, 'base');
      const parentTree = treeOf(repo.root);
      repo.commitFiles({ 'e2e/accounts.spec.ts': `${SPEC}\n// the race fix\n` }, 'test fix');
      const current = treeOf(repo.root);
      const decision = decideTestOnlyReseal({
        io: { cwd: repo.root, env: process.env, stdout: '', stderr: '' } as never,
        gitDir: resolveGitDir(repo.root, process.env) as string,
        parent: {
          receipt: parentReceipt({ candidateTreeId: parentTree }),
          receiptDigest: 'a1'.repeat(32),
          treeId: parentTree,
          execution: parentExecution(PASSED),
        },
        currentTreeId: current,
        catalog: catalog([entry('e2e/accounts.spec.ts', 'reads an account'), entry('e2e/orders.spec.ts', 'reads an account')]),
        obligations: [obligation('tenant.accounts:persistence:read'), obligation('tenant.orders:persistence:read')],
        enabled: true,
      });
      expect(decision.reason).toBeNull();
      expect(decision.plan).toMatchObject({
        parentDigest: 'a1'.repeat(32),
        parentTreeId: parentTree,
        affectedFiles: ['e2e/accounts.spec.ts'],
        carriedTests: 1,
      });
      expect(decision.plan?.classification.changedPaths).toEqual(['e2e/accounts.spec.ts']);
    });
  });

  it('re-runs every importer when the changed file is a test helper', async () => {
    await withTempRepo({}, async (repo) => {
      repo.writeFiles({
        ...BASE_FILES,
        'e2e/accounts.spec.ts': SPEC.replace("import { test, expect }", "import { amount } from './helper.js';\nimport { test, expect }"),
        'e2e/orders.spec.ts': SPEC.replace("import { test, expect }", "import { amount } from './helper.js';\nimport { test, expect }"),
      });
      repo.commitFiles({}, 'base');
      const parentTree = treeOf(repo.root);
      repo.commitFiles({ 'e2e/helper.ts': 'export const amount = () => 2;\n' }, 'helper fix');
      const decision = decideTestOnlyReseal({
        io: { cwd: repo.root, env: process.env, stdout: '', stderr: '' } as never,
        gitDir: resolveGitDir(repo.root, process.env) as string,
        parent: { receipt: parentReceipt({ candidateTreeId: parentTree }), receiptDigest: 'a1'.repeat(32), treeId: parentTree, execution: parentExecution(PASSED) },
        currentTreeId: treeOf(repo.root),
        catalog: catalog([entry('e2e/accounts.spec.ts', 'reads an account'), entry('e2e/orders.spec.ts', 'reads an account')]),
        obligations: [obligation('tenant.accounts:persistence:read'), obligation('tenant.orders:persistence:read')],
        enabled: true,
      });
      expect(decision.reason).toBeNull();
      expect(decision.plan?.affectedFiles).toEqual(['e2e/accounts.spec.ts', 'e2e/orders.spec.ts']);
      expect(decision.plan?.carriedTests).toBe(0);
    });
  });

  it('refuses a changed setup test the runner project depends on', async () => {
    await withTempRepo({}, async (repo) => {
      repo.writeFiles({
        ...BASE_FILES,
        'e2e/auth.setup.ts': "import { test } from '@playwright/test';\ntest('auth state', async () => {});\n",
        'playwright.config.ts': [
          "import { defineConfig } from '@playwright/test';",
          'export default defineConfig({',
          '  projects: [',
          "    { name: 'setup', testMatch: '**/*.setup.ts' },",
          "    { name: 'chromium', dependencies: ['setup'] },",
          '  ],',
          '});',
          '',
        ].join('\n'),
      });
      repo.commitFiles({}, 'base');
      const parentTree = treeOf(repo.root);
      repo.commitFiles(
        { 'e2e/auth.setup.ts': "import { test } from '@playwright/test';\ntest('auth state', async () => {});\n// a fix\n" },
        'setup fix',
      );
      const decision = decideTestOnlyReseal({
        io: { cwd: repo.root, env: process.env, stdout: '', stderr: '' } as never,
        gitDir: resolveGitDir(repo.root, process.env) as string,
        parent: { receipt: parentReceipt({ candidateTreeId: parentTree }), receiptDigest: 'a1'.repeat(32), treeId: parentTree, execution: parentExecution(PASSED) },
        currentTreeId: treeOf(repo.root),
        catalog: catalog([entry('e2e/accounts.spec.ts', 'reads an account'), entry('e2e/orders.spec.ts', 'reads an account'), entry('e2e/auth.setup.ts', 'auth state')]),
        obligations: [obligation('tenant.accounts:persistence:read'), obligation('tenant.orders:persistence:read')],
        enabled: true,
      });
      expect(decision.plan).toBeNull();
      expect(decision.reason).toBe('setup test changed: e2e/auth.setup.ts → full run');
    });
  });

  it('refuses an app file changed beside a test file, naming the app path', async () => {
    await withTempRepo({}, async (repo) => {
      repo.writeFiles(BASE_FILES);
      repo.commitFiles({}, 'base');
      const parentTree = treeOf(repo.root);
      repo.commitFiles({ 'src/accounts.ts': 'export const accounts = 2;\n' }, 'app change');
      const decision = decideTestOnlyReseal({
        io: { cwd: repo.root, env: process.env, stdout: '', stderr: '' } as never,
        gitDir: resolveGitDir(repo.root, process.env) as string,
        parent: { receipt: parentReceipt({ candidateTreeId: parentTree }), receiptDigest: 'a1'.repeat(32), treeId: parentTree, execution: parentExecution(PASSED) },
        currentTreeId: treeOf(repo.root),
        catalog: catalog([entry('e2e/accounts.spec.ts', 'reads an account'), entry('e2e/orders.spec.ts', 'reads an account')]),
        obligations: [obligation('tenant.accounts:persistence:read'), obligation('tenant.orders:persistence:read')],
        enabled: true,
      });
      expect(decision.plan).toBeNull();
      expect(decision.reason).toBe('app file changed: src/accounts.ts → full run');
    });
  });

  it('refuses when a carried test outside the affected set did not pass', async () => {
    await withTempRepo({}, async (repo) => {
      repo.writeFiles(BASE_FILES);
      repo.commitFiles({}, 'base');
      const parentTree = treeOf(repo.root);
      repo.commitFiles({ 'e2e/accounts.spec.ts': `${SPEC}\n// the race fix\n` }, 'test fix');
      const decision = decideTestOnlyReseal({
        io: { cwd: repo.root, env: process.env, stdout: '', stderr: '' } as never,
        gitDir: resolveGitDir(repo.root, process.env) as string,
        parent: {
          receipt: parentReceipt({ candidateTreeId: parentTree }),
          receiptDigest: 'a1'.repeat(32),
          treeId: parentTree,
          execution: parentExecution([
            { logicalKey: ACCOUNTS_KEY, status: 'passed' },
            { logicalKey: ORDERS_KEY, status: 'failed' },
          ]),
        },
        currentTreeId: treeOf(repo.root),
        catalog: catalog([entry('e2e/accounts.spec.ts', 'reads an account'), entry('e2e/orders.spec.ts', 'reads an account')]),
        obligations: [obligation('tenant.accounts:persistence:read'), obligation('tenant.orders:persistence:read')],
        enabled: true,
      });
      expect(decision.plan).toBeNull();
      expect(decision.reason).toBe(
        `the previous receipt's test ${ORDERS_KEY} did not pass outside the affected set → full run`,
      );
    });
  });

  it('refuses a vanished test no changed file explains', async () => {
    await withTempRepo({}, async (repo) => {
      repo.writeFiles(BASE_FILES);
      repo.commitFiles({}, 'base');
      const parentTree = treeOf(repo.root);
      repo.commitFiles({ 'e2e/accounts.spec.ts': `${SPEC}\n// the race fix\n` }, 'test fix');
      const decision = decideTestOnlyReseal({
        io: { cwd: repo.root, env: process.env, stdout: '', stderr: '' } as never,
        gitDir: resolveGitDir(repo.root, process.env) as string,
        parent: { receipt: parentReceipt({ candidateTreeId: parentTree }), receiptDigest: 'a1'.repeat(32), treeId: parentTree, execution: parentExecution(PASSED) },
        currentTreeId: treeOf(repo.root),
        // The orders spec lost every test without the file being touched.
        catalog: catalog([entry('e2e/accounts.spec.ts', 'reads an account')]),
        obligations: [obligation('tenant.accounts:persistence:read'), obligation('tenant.orders:persistence:read')],
        enabled: true,
      });
      expect(decision.plan).toBeNull();
      expect(decision.reason).toBe(
        `the previous receipt's test ${ORDERS_KEY} no longer exists and no changed file explains it → full run`,
      );
    });
  });

  it('refuses when the re-seal path is off, when the parent sealed a slice, or when the parent graded fewer obligations', async () => {
    await withTempRepo({}, async (repo) => {
      repo.writeFiles(BASE_FILES);
      repo.commitFiles({}, 'base');
      const parentTree = treeOf(repo.root);
      repo.commitFiles({ 'e2e/accounts.spec.ts': `${SPEC}\n// the race fix\n` }, 'test fix');
      const current = treeOf(repo.root);
      const base = {
        io: { cwd: repo.root, env: process.env, stdout: '', stderr: '' } as never,
        gitDir: resolveGitDir(repo.root, process.env) as string,
        currentTreeId: current,
        catalog: catalog([entry('e2e/accounts.spec.ts', 'reads an account'), entry('e2e/orders.spec.ts', 'reads an account')]),
        obligations: [obligation('tenant.accounts:persistence:read'), obligation('tenant.orders:persistence:read')],
        enabled: true,
      };
      const parent = {
        receipt: parentReceipt({ candidateTreeId: parentTree }),
        receiptDigest: 'a1'.repeat(32),
        treeId: parentTree,
        execution: parentExecution(PASSED),
      };
      expect(decideTestOnlyReseal({ ...base, parent, enabled: false })).toEqual({
        plan: null,
        reason: 'the re-seal path is off (`enforcement.reseal` is not true) → full run',
      });
      expect(
        decideTestOnlyReseal({
          ...base,
          parent: {
            ...parent,
            receipt: parentReceipt({
              candidateTreeId: parentTree,
              scope: 'changed',
              coveredObligationFingerprints: ['a'.repeat(64)],
            }),
          },
        }).reason,
      ).toBe('the previous receipt sealed a slice, not a whole-suite run → full run');
      expect(
        decideTestOnlyReseal({
          ...base,
          parent: {
            ...parent,
            receipt: parentReceipt({ candidateTreeId: parentTree, verdictSummary: { total: 1, satisfied: 1, waived: 0, blocking: 0 } }),
          },
        }).reason,
      ).toBe('the previous receipt graded 1 obligation(s) while this candidate declares 2 → full run');
    });
  });

  it('stays silent and unchanged when there is no parent receipt at all', async () => {
    await withTempRepo({}, async (repo) => {
      repo.writeFiles(BASE_FILES);
      repo.commitFiles({}, 'base');
      const tree = treeOf(repo.root);
      repo.commitFiles({ 'e2e/accounts.spec.ts': `${SPEC}\n// the race fix\n` }, 'test fix');
      expect(
        decideTestOnlyReseal({
          io: { cwd: repo.root, env: process.env, stdout: '', stderr: '' } as never,
          gitDir: resolveGitDir(repo.root, process.env) as string,
          parent: null,
          currentTreeId: treeOf(repo.root),
          catalog: catalog([entry('e2e/accounts.spec.ts', 'reads an account')]),
          obligations: [obligation('tenant.accounts:persistence:read')],
          enabled: true,
        }),
      ).toEqual({ plan: null, reason: null });
    });
  });
});
