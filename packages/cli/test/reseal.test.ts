/**
 * Test-only change classification (plan phase 1): the change set is
 * computed from the two SEALED candidate trees, every changed path is
 * classified from the runner's own catalog plus the repository's import
 * graph, and any doubt is refused with one plain reason line.
 */
import { describe, expect, it } from 'vitest';
import { withTempRepo } from '@gate-forge/core';
import { computeCandidateTreeId, resolveGitDir } from '../src/candidate-tree.js';
import { classifyResealChange } from '../src/reseal.js';

const TEST_FILES = ['e2e/accounts.spec.ts', 'e2e/orders.spec.ts'];

const SPEC = [
  "import { test, expect } from '@playwright/test';",
  "import { amount } from './helper.js';",
  '',
  "test('reads an account', async () => {",
  '  expect(amount()).toBeGreaterThan(0);',
  '});',
  '',
].join('\n');

const BASE_FILES: Record<string, string> = {
  'src/accounts.ts': 'export const accounts = 1;\n',
  'e2e/helper.ts': "export const amount = () => 1;\n",
  'e2e/accounts.spec.ts': SPEC,
  'e2e/orders.spec.ts': SPEC,
  '.gitignore': '.gateforge/\n',
};

/** Seals the candidate tree of the repository as it stands right now. */
function treeOf(repo: { root: string }): string {
  const gitDir = resolveGitDir(repo.root, process.env);
  expect(gitDir).not.toBeNull();
  const tree = computeCandidateTreeId(gitDir as string, repo.root, process.env, '.gateforge');
  expect(tree).not.toBeNull();
  return tree as string;
}

function classify(repo: { root: string }, parentTreeId: string, currentTreeId: string) {
  const gitDir = resolveGitDir(repo.root, process.env);
  return classifyResealChange({
    gitDir: gitDir as string,
    env: process.env,
    cwd: repo.root,
    parentTreeId,
    currentTreeId,
    testFiles: TEST_FILES,
  });
}

describe('test-only re-seal change classification', () => {
  it('reads a test-file-only change as test-only and re-runs exactly that file', async () => {
    await withTempRepo({}, async (repo) => {
      repo.writeFiles(BASE_FILES);
      repo.commitFiles({}, 'base');
      const parent = treeOf(repo);
      repo.commitFiles({ 'e2e/accounts.spec.ts': `${SPEC}\n// a real fix inside the test\n` }, 'fix the race');
      const current = treeOf(repo);

      const classification = classify(repo, parent, current);
      expect(classification).toEqual({
        eligible: true,
        reason: null,
        changedPaths: ['e2e/accounts.spec.ts'],
        testFiles: ['e2e/accounts.spec.ts'],
        helperFiles: [],
        affectedTestFiles: ['e2e/accounts.spec.ts'],
      });
    });
  });

  it('refuses an app file changed next to a test file, naming the app path', async () => {
    await withTempRepo({}, async (repo) => {
      repo.writeFiles(BASE_FILES);
      repo.commitFiles({}, 'base');
      const parent = treeOf(repo);
      repo.commitFiles(
        {
          'src/accounts.ts': 'export const accounts = 2;\n',
          'e2e/accounts.spec.ts': `${SPEC}\n// and the matching test\n`,
        },
        'app plus test',
      );
      const classification = classify(repo, parent, treeOf(repo));
      expect(classification.eligible).toBe(false);
      expect(classification.reason).toBe('app file changed: src/accounts.ts → full run');
      expect(classification.affectedTestFiles).toEqual([]);
    });
  });

  it('re-runs every importer of a changed test helper', async () => {
    await withTempRepo({}, async (repo) => {
      repo.writeFiles(BASE_FILES);
      repo.commitFiles({}, 'base');
      const parent = treeOf(repo);
      repo.commitFiles({ 'e2e/helper.ts': 'export const amount = () => 2;\n' }, 'fix the helper');
      const classification = classify(repo, parent, treeOf(repo));
      expect(classification.eligible).toBe(true);
      expect(classification.helperFiles).toEqual(['e2e/helper.ts']);
      expect(classification.affectedTestFiles).toEqual(TEST_FILES);
    });
  });

  it('refuses a helper whose importers cannot be fully resolved', async () => {
    await withTempRepo({}, async (repo) => {
      repo.writeFiles(BASE_FILES);
      repo.commitFiles({}, 'base');
      const parent = treeOf(repo);
      repo.commitFiles(
        {
          'e2e/dynamic.spec.ts': "const name = 'helper';\nimport(`./${'${name}'}.js`);\n",
          'e2e/helper.ts': 'export const amount = () => 3;\n',
        },
        'dynamic importer plus helper change',
      );
      const classification = classify(repo, parent, treeOf(repo));
      expect(classification.eligible).toBe(false);
      expect(classification.reason).toBe(
        'unresolvable import: e2e/dynamic.spec.ts loads a module through a computed specifier → full run',
      );
    });
  });

  it('refuses a helper an app file imports', async () => {
    await withTempRepo({}, async (repo) => {
      repo.writeFiles({
        ...BASE_FILES,
        'src/helper-consumer.ts': "import { amount } from '../e2e/helper.js';\nexport const total = amount();\n",
      });
      repo.commitFiles({}, 'base');
      const parent = treeOf(repo);
      repo.commitFiles({ 'e2e/helper.ts': 'export const amount = () => 4;\n' }, 'helper change');
      const classification = classify(repo, parent, treeOf(repo));
      expect(classification.eligible).toBe(false);
      expect(classification.reason).toBe(
        'app file changed: src/helper-consumer.ts imports the changed test helper e2e/helper.ts → full run',
      );
    });
  });

  it('refuses a changed file no test imports', async () => {
    await withTempRepo({}, async (repo) => {
      repo.writeFiles({ ...BASE_FILES, 'e2e/orphan.ts': 'export const orphan = 1;\n' });
      repo.commitFiles({}, 'base');
      const parent = treeOf(repo);
      repo.commitFiles({ 'e2e/orphan.ts': 'export const orphan = 2;\n' }, 'orphan change');
      const classification = classify(repo, parent, treeOf(repo));
      expect(classification.eligible).toBe(false);
      expect(classification.reason).toBe(
        'app file changed: e2e/orphan.ts is imported by no test file, so it is not a test helper → full run',
      );
    });
  });

  it('classifies a deleted test file as test-only and a deleted app file as app code', async () => {
    await withTempRepo({}, async (repo) => {
      repo.writeFiles(BASE_FILES);
      repo.commitFiles({}, 'base');
      const parent = treeOf(repo);
      repo.git(['rm', 'e2e/orders.spec.ts']);
      repo.commitFiles({ 'e2e/accounts.spec.ts': SPEC }, 'drop the orders spec');
      const deletedTest = classify(repo, parent, treeOf(repo));
      expect(deletedTest.eligible).toBe(true);
      expect(deletedTest.changedPaths).toEqual(['e2e/orders.spec.ts']);
      expect(deletedTest.affectedTestFiles).toEqual(["e2e/orders.spec.ts"]);
    });
    await withTempRepo({}, async (repo) => {
      repo.writeFiles(BASE_FILES);
      repo.commitFiles({}, 'base');
      const parent = treeOf(repo);
      repo.git(['rm', 'src/accounts.ts']);
      const deletedApp = classify(repo, parent, treeOf(repo));
      expect(deletedApp.eligible).toBe(false);
      expect(deletedApp.reason).toBe('app file deleted: src/accounts.ts → full run');
    });
  });

  it('refuses when the parent receipt sealed this very tree (nothing changed)', async () => {
    await withTempRepo({}, async (repo) => {
      repo.writeFiles(BASE_FILES);
      repo.commitFiles({}, 'base');
      const tree = treeOf(repo);
      const classification = classify(repo, tree, tree);
      expect(classification.eligible).toBe(false);
      expect(classification.reason).toBe(
        'the sealed trees are identical, so there is nothing to classify → full run',
      );
    });
  });

  it('refuses when the sealed trees cannot be diffed', async () => {
    await withTempRepo({}, async (repo) => {
      repo.writeFiles(BASE_FILES);
      repo.commitFiles({}, 'base');
      const tree = treeOf(repo);
      const classification = classify(repo, '0'.repeat(40), tree);
      expect(classification.eligible).toBe(false);
      expect(classification.reason).toContain('the sealed trees could not be diffed');
    });
  });
});
