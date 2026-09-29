/**
 * Test-only change classification (plan phase 1): the change set is
 * computed from the two SEALED candidate trees, every changed path is
 * classified from the runner's own catalog plus the repository's import
 * graph, and any doubt is refused with one plain reason line.
 */
import { describe, expect, it } from 'vitest';
import { withTempRepo } from '@gate-forge/core';
import { computeCandidateTreeId, resolveGitDir } from '../src/candidate-tree.js';
import { carryDiffIsWithinScope, classifyResealChange } from '../src/reseal.js';

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

function classify(
  repo: { root: string },
  parentTreeId: string,
  currentTreeId: string,
  testFiles: readonly string[] = TEST_FILES,
) {
  const gitDir = resolveGitDir(repo.root, process.env);
  return classifyResealChange({
    gitDir: gitDir as string,
    env: process.env,
    cwd: repo.root,
    parentTreeId,
    currentTreeId,
    testFiles,
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

  it('re-runs the importers of a changed test file, not only the file itself', async () => {
    const shared = [
      "import { test as base } from '@playwright/test';",
      'export const test = base.extend({});',
      '',
      "test('reads an account', async () => {});",
      '',
    ].join('\n');
    await withTempRepo({}, async (repo) => {
      repo.writeFiles({
        ...BASE_FILES,
        // A shared `test.extend` declared in a spec file the catalog
        // enumerates: changing it changes every importing spec.
        'e2e/accounts.spec.ts': shared,
        'e2e/orders.spec.ts': [
          "import { test } from './accounts.spec.js';",
          '',
          "test('reads an account', async () => {});",
          '',
        ].join('\n'),
      });
      repo.commitFiles({}, 'base');
      const parent = treeOf(repo);
      repo.commitFiles({ 'e2e/accounts.spec.ts': `${shared}\n// a fix\n` }, 'shared fixture change');
      const classification = classify(repo, parent, treeOf(repo));
      expect(classification.eligible).toBe(true);
      expect(classification.testFiles).toEqual(['e2e/accounts.spec.ts']);
      expect(classification.affectedTestFiles).toEqual(['e2e/accounts.spec.ts', 'e2e/orders.spec.ts']);
    });
  });

  it('refuses a test-file change the graph cannot fully resolve', async () => {
    await withTempRepo({}, async (repo) => {
      repo.writeFiles({
        ...BASE_FILES,
        'e2e/dynamic.spec.ts': "const name = 'helper';\nimport(`./${'${name}'}.js`);\n",
      });
      repo.commitFiles({}, 'base');
      const parent = treeOf(repo);
      repo.commitFiles({ 'e2e/accounts.spec.ts': `${SPEC}\n// a real fix inside the test\n` }, 'test fix');
      const classification = classify(repo, parent, treeOf(repo));
      expect(classification.eligible).toBe(false);
      expect(classification.reason).toBe(
        'unresolvable import: e2e/dynamic.spec.ts loads a module through a computed specifier → full run',
      );
    });
  });

  it('re-runs the importers of a deleted test file that shared its fixture', async () => {
    await withTempRepo({}, async (repo) => {
      repo.writeFiles({
        ...BASE_FILES,
        'e2e/orders.spec.ts': [
          "import { amount } from './accounts.spec.js';",
          "import { test, expect } from '@playwright/test';",
          '',
          "test('reads an account', async () => {",
          '  expect(amount()).toBeGreaterThan(0);',
          '});',
          '',
        ].join('\n'),
      });
      repo.commitFiles({}, 'base');
      const parent = treeOf(repo);
      repo.git(['rm', 'e2e/accounts.spec.ts']);
      repo.commitFiles({}, 'drop the shared spec');
      const classification = classify(repo, parent, treeOf(repo));
      expect(classification.eligible).toBe(true);
      expect(classification.changedPaths).toEqual(['e2e/accounts.spec.ts']);
      expect(classification.affectedTestFiles).toEqual(['e2e/accounts.spec.ts', 'e2e/orders.spec.ts']);
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

  it('refuses a changed test file a runner project depends on (setup stage)', async () => {
    await withTempRepo({}, async (repo) => {
      const files = {
        ...BASE_FILES,
        'e2e/auth.setup.ts': "import { test } from '@playwright/test';\ntest('auth state', async () => {});\n",
        'playwright.config.ts': [
          "import { defineConfig } from '@playwright/test';",
          'export default defineConfig({',
          "  projects: [",
          "    { name: 'setup', testMatch: '**/*.setup.ts' },",
          "    { name: 'chromium', dependencies: ['setup'] },",
          '  ],',
          '});',
          '',
        ].join('\n'),
      };
      const catalog = ['e2e/accounts.spec.ts', 'e2e/orders.spec.ts', 'e2e/auth.setup.ts'];
      repo.writeFiles(files);
      repo.commitFiles({}, 'base');
      const parent = treeOf(repo);
      repo.commitFiles({ 'e2e/auth.setup.ts': `${files['e2e/auth.setup.ts']}\n// a fix\n` }, 'setup fix');
      const classification = classify(repo, parent, treeOf(repo), catalog);
      expect(classification.eligible).toBe(false);
      expect(classification.reason).toBe('setup test changed: e2e/auth.setup.ts → full run');
    });
  });

  it('refuses a changed spec the runner names as a setup file by convention', async () => {
    await withTempRepo({}, async (repo) => {
      const catalog = ['e2e/accounts.spec.ts', 'e2e/global-setup.ts'];
      repo.writeFiles({
        ...BASE_FILES,
        'e2e/global-setup.ts': "import { test } from '@playwright/test';\ntest('global setup', async () => {});\n",
      });
      repo.commitFiles({}, 'base');
      const parent = treeOf(repo);
      repo.commitFiles(
        { 'e2e/global-setup.ts': "import { test } from '@playwright/test';\ntest('global setup', async () => {});\n// a fix\n" },
        'global setup fix',
      );
      const classification = classify(repo, parent, treeOf(repo), catalog);
      expect(classification.eligible).toBe(false);
      expect(classification.reason).toBe('setup test changed: e2e/global-setup.ts → full run');
    });
  });

  it('refuses when the config declares a dependency project whose tests cannot be resolved', async () => {
    await withTempRepo({}, async (repo) => {
      const catalog = ['e2e/accounts.spec.ts', 'e2e/orders.spec.ts'];
      repo.writeFiles({
        ...BASE_FILES,
        'playwright.config.ts': [
          "import { defineConfig } from '@playwright/test';",
          'export default defineConfig({',
          "  projects: [{ name: 'chromium', dependencies: [setupProject] }],",
          '});',
          '',
        ].join('\n'),
      });
      repo.commitFiles({}, 'base');
      const parent = treeOf(repo);
      repo.commitFiles({ 'e2e/accounts.spec.ts': `${SPEC}\n// a fix\n` }, 'test fix');
      const classification = classify(repo, parent, treeOf(repo), catalog);
      expect(classification.eligible).toBe(false);
      expect(classification.reason).toBe(
        'setup test changed: e2e/accounts.spec.ts (the runner config declares a dependency project whose tests cannot be resolved) → full run',
      );
    });
  });
});

describe('plain carry-forward over sealed candidate trees', () => {
  it('accepts a difference confined to the evaluated paths and refuses anything else', async () => {
    await withTempRepo({}, async (repo) => {
      repo.writeFiles({ ...BASE_FILES, 'node_modules/pkg/index.js': 'module.exports = "v1";\n' });
      repo.commitFiles({}, 'base');
      const gitDir = resolveGitDir(repo.root, process.env) as string;
      const parent = treeOf(repo);

      repo.commitFiles({ 'src/accounts.ts': 'export const accounts = 2;\n' }, 'inert change');
      expect(
        carryDiffIsWithinScope({
          gitDir,
          env: process.env,
          parentTreeId: parent,
          currentTreeId: treeOf(repo),
          evaluatedPaths: ['src/accounts.ts'],
        }),
      ).toBe(true);

      // A gitignored byte inside the sealed tree that the evaluation
      // never saw is a proof nobody produced.
      repo.writeFiles({ 'node_modules/pkg/index.js': 'module.exports = "v2";\n' });
      expect(
        carryDiffIsWithinScope({
          gitDir,
          env: process.env,
          parentTreeId: parent,
          currentTreeId: treeOf(repo),
          evaluatedPaths: ['src/accounts.ts'],
        }),
      ).toBe(false);

      // An undiffable pair fails closed.
      expect(
        carryDiffIsWithinScope({
          gitDir,
          env: process.env,
          parentTreeId: '0'.repeat(40),
          currentTreeId: treeOf(repo),
          evaluatedPaths: [],
        }),
      ).toBe(false);
    });
  });
});
