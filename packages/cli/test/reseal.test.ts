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
      expect(classification.reason).toBe('app file changed: src/accounts.ts → changed-scope run');
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
        'unresolvable import: e2e/dynamic.spec.ts loads a module through a computed specifier → changed-scope run',
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
        'app file changed: src/helper-consumer.ts imports the changed test helper e2e/helper.ts → changed-scope run',
      );
    });
  });

  it.each<{ kind: string; applicationFiles: Record<string, string> }>([
    {
      kind: 'entry point',
      applicationFiles: {
        'src/app.ts': "import { amount } from './helper.js';\nexport const total = amount();\n",
      },
    },
    {
      kind: 'import cycle',
      applicationFiles: {
        'src/app.ts': "import './other.js';\nimport { amount } from './helper.js';\nexport const total = amount();\n",
        'src/other.ts': "import './app.js';\nexport const other = 1;\n",
      },
    },
  ])('refuses an application $kind beside colocated tests', async ({ applicationFiles }) => {
    await withTempRepo({}, async (repo) => {
      repo.writeFiles({
        'src/helper.ts': 'export const amount = () => 1;\n',
        'src/accounts.spec.ts': SPEC,
        'src/orders.spec.ts': SPEC,
        ...applicationFiles,
      });
      repo.commitFiles({}, 'base');
      const parent = treeOf(repo);
      repo.commitFiles({ 'src/helper.ts': 'export const amount = () => 2;\n' }, 'change shared application code');
      const classification = classify(repo, parent, treeOf(repo), ['src/accounts.spec.ts', 'src/orders.spec.ts']);
      expect(classification.eligible).toBe(false);
      expect(classification.helperFiles).toEqual([]);
      expect(classification.affectedTestFiles).toEqual([]);
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
        'app file changed: e2e/orphan.ts is imported by no test file, so it is not a test helper → changed-scope run',
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
        'unresolvable import: e2e/dynamic.spec.ts loads a module through a computed specifier → changed-scope run',
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
      expect(deletedApp.reason).toBe('app file deleted: src/accounts.ts → changed-scope run');
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
        'the sealed trees are identical, so there is nothing to classify → changed-scope run',
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
      expect(classification.reason).toBe('setup test changed: e2e/auth.setup.ts → changed-scope run');
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
      expect(classification.reason).toBe('setup test changed: e2e/global-setup.ts → changed-scope run');
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
        'setup test changed: e2e/accounts.spec.ts (the runner config declares a dependency project whose tests cannot be resolved) → changed-scope run',
      );
    });
  });

  it('refuses a helper change when dependency ownership cannot be resolved', async () => {
    await withTempRepo({}, async (repo) => {
      repo.writeFiles({
        ...BASE_FILES,
        'e2e/auth.setup.ts': SPEC,
        'playwright.config.ts': [
          "const setupProject = 'setup';",
          'export default {',
          "  projects: [{ name: 'setup', testMatch: '**/auth.setup.ts' },",
          "    { name: 'chromium', testMatch: '**/*.spec.ts', dependencies: [setupProject] }],",
          '};',
          '',
        ].join('\n'),
      });
      repo.commitFiles({}, 'base');
      const parent = treeOf(repo);
      repo.commitFiles({ 'e2e/helper.ts': 'export const amount = () => 2;\n' }, 'fix helper');
      const classification = classify(repo, parent, treeOf(repo), [...TEST_FILES, 'e2e/auth.setup.ts']);
      expect(classification.eligible).toBe(false);
      expect(classification.affectedTestFiles).toEqual([]);
    });
  });

  it('re-runs the setup project when a dependent test changes', async () => {
    await withTempRepo({}, async (repo) => {
      // The standard Playwright auth pattern: a `setup` project owns
      // `**\/*.setup.ts` and `chromium` depends on it. A supervised run
      // re-runs the setup project's tests BEFORE the dependent ones
      // (the dependency edge the enumeration captured), so the
      // classifier's affected set must name the setup file too — it is
      // the set the re-seal receipt is later recomputed against, and a
      // fresh outcome outside it is refused as EVIDENCE_STALE.
      const catalog = ['e2e/accounts.spec.ts', 'e2e/orders.spec.ts', 'e2e/auth.setup.ts'];
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
      const parent = treeOf(repo);
      repo.commitFiles({ 'e2e/accounts.spec.ts': `${SPEC}\n// a fix\n` }, 'dependent fix');
      const classification = classify(repo, parent, treeOf(repo), catalog);
      expect(classification.eligible).toBe(true);
      expect(classification.affectedTestFiles).toEqual(['e2e/accounts.spec.ts', 'e2e/auth.setup.ts']);
      // The untouched sibling spec is NOT affected: it stays carried.
      expect(classification.affectedTestFiles).not.toContain('e2e/orders.spec.ts');
    });
  });

  it('reads nested dependency projects and resolves their testDir from the config directory', async () => {
    await withTempRepo({}, async (repo) => {
      const catalog = [
        'frontend/e2e/accounts.spec.ts',
        'frontend/e2e/orders.spec.ts',
        'frontend/e2e/prepare-auth.ts',
      ];
      const spec = "import { test } from '@playwright/test';\ntest('account', async () => {});\n";
      repo.writeFiles({
        'frontend/e2e/accounts.spec.ts': spec,
        'frontend/e2e/orders.spec.ts': spec,
        'frontend/e2e/prepare-auth.ts': "import { test } from '@playwright/test';\ntest('auth state', async () => {});\n",
        'vitest.config.ts': 'export default {};\n',
        'frontend/playwright.config.ts': [
          "import { defineConfig } from '@playwright/test';",
          'export default defineConfig({',
          '  projects: [',
          "    { name: 'setup', testDir: './e2e', testMatch: 'prepare-auth.ts' },",
          "    { name: 'chromium', testDir: './e2e', testMatch: '*.spec.ts', dependencies: ['setup'] },",
          '  ],',
          '});',
          '',
        ].join('\n'),
      });
      repo.commitFiles({}, 'base');
      const parent = treeOf(repo);
      repo.commitFiles({ 'frontend/e2e/accounts.spec.ts': `${spec}\n// a fix\n` }, 'dependent fix');
      const current = treeOf(repo);
      repo.writeFiles({ 'frontend/playwright.config.ts': 'export default {};\n' });
      const classification = classify(repo, parent, current, catalog);
      expect(classification.eligible).toBe(true);
      expect(classification.affectedTestFiles).toEqual([
        'frontend/e2e/accounts.spec.ts',
        'frontend/e2e/prepare-auth.ts',
      ]);
      expect(classification.changedPaths).toEqual(['frontend/e2e/accounts.spec.ts']);
    });
  });

  it('reads a literal dynamic import as an ordinary import edge', async () => {
    await withTempRepo({}, async (repo) => {
      repo.writeFiles({
        ...BASE_FILES,
        'e2e/accounts.spec.ts': `import './lazy.js';\n${SPEC}`,
        // The consumer shape: a tracked file loads its sibling through
        // a LITERAL dynamic import, in each quoting form. The specifier
        // is fixed at parse time, so the edge is an ordinary one and
        // its importers re-run like any importer's.
        'e2e/lazy.ts': [
          "export const single = () => import('./helper.js');",
          'export const double = () => import("./helper.js");',
          'export const template = () => import(`./helper.js`);',
          '',
        ].join('\n'),
      });
      repo.commitFiles({}, 'base');
      const parent = treeOf(repo);
      repo.commitFiles({ 'e2e/helper.ts': 'export const amount = () => 5;\n' }, 'fix the helper');
      const classification = classify(repo, parent, treeOf(repo));
      expect(classification.eligible).toBe(true);
      expect(classification.helperFiles).toEqual(['e2e/helper.ts']);
      expect(classification.affectedTestFiles).toEqual(TEST_FILES);
    });
  });

  it('reads a literal Python importlib call as an ordinary import edge', async () => {
    await withTempRepo({}, async (repo) => {
      repo.writeFiles({
        ...BASE_FILES,
        'e2e/pyloads.py': [
          'import importlib',
          'import os',
          '',
          'def load():',
          "    return importlib.import_module('os').path",
          '',
          'def built_in():',
          "    return __import__('os').path",
          '',
        ].join('\n'),
      });
      repo.commitFiles({}, 'base');
      const parent = treeOf(repo);
      repo.commitFiles({ 'e2e/accounts.spec.ts': `${SPEC}\n// a real fix\n` }, 'test fix');
      const classification = classify(repo, parent, treeOf(repo));
      expect(classification.eligible).toBe(true);
      expect(classification.affectedTestFiles).toEqual(['e2e/accounts.spec.ts']);
    });
  });

  it('refuses a variable specifier, naming the file that computes it', async () => {
    await withTempRepo({}, async (repo) => {
      repo.writeFiles({
        ...BASE_FILES,
        'e2e/computed.ts': "export const load = (name) => import(name);\n",
      });
      repo.commitFiles({}, 'base');
      const parent = treeOf(repo);
      repo.commitFiles({ 'e2e/accounts.spec.ts': `${SPEC}\n// a real fix\n` }, 'test fix');
      const classification = classify(repo, parent, treeOf(repo));
      expect(classification.eligible).toBe(false);
      expect(classification.reason).toBe(
        'unresolvable import: e2e/computed.ts loads a module through a computed specifier → changed-scope run',
      );
    });
  });

  it('refuses an interpolated template specifier', async () => {
    await withTempRepo({}, async (repo) => {
      repo.writeFiles({
        ...BASE_FILES,
        'e2e/interpolated.ts': 'export const load = (name) => import(`./${name}.js`);\n',
      });
      repo.commitFiles({}, 'base');
      const parent = treeOf(repo);
      repo.commitFiles({ 'e2e/accounts.spec.ts': `${SPEC}\n// a real fix\n` }, 'test fix');
      const classification = classify(repo, parent, treeOf(repo));
      expect(classification.eligible).toBe(false);
      expect(classification.reason).toBe(
        'unresolvable import: e2e/interpolated.ts loads a module through a computed specifier → changed-scope run',
      );
    });
  });

  it('refuses a Python importlib call whose module name is computed', async () => {
    await withTempRepo({}, async (repo) => {
      repo.writeFiles({
        ...BASE_FILES,
        'e2e/pycomputed.py': [
          'import importlib',
          '',
          'def load(name):',
          '    return importlib.import_module(name)',
          '',
        ].join('\n'),
      });
      repo.commitFiles({}, 'base');
      const parent = treeOf(repo);
      repo.commitFiles(
        { 'e2e/accounts.spec.ts': `${SPEC}\n// a real fix\n`, 'e2e/pydata.py': 'VALUE = 1\n' },
        'test fix plus a python file',
      );
      const classification = classify(repo, parent, treeOf(repo));
      expect(classification.eligible).toBe(false);
      expect(classification.reason).toBe(
        'unresolvable import: e2e/pycomputed.py loads a module through a computed specifier → changed-scope run',
      );
    });
  });

  it('reads a JSDoc paragraph that names a reviewed import as prose, not as a computed import', async () => {
    await withTempRepo({}, async (repo) => {
      repo.writeFiles({
        ...BASE_FILES,
        // The consumer shape: a tracked file whose ONLY match for an
        // import call is a JSDoc paragraph. Prose is not syntax, so
        // the file declares no computed import and the re-seal stands.
        'e2e/approval.ts': [
          '/**',
          ' * The approval record for this helper. A reviewer reads',
          ' *   the reviewed import (always approved, active) and the journey imports',
          ' * side by side, then signs the run off.',
          ' */',
          'export const amount = () => 2;',
          '',
        ].join('\n'),
      });
      repo.commitFiles({}, 'base');
      const parent = treeOf(repo);
      repo.commitFiles({ 'e2e/helper.ts': 'export const amount = () => 3;\n' }, 'fix the helper');
      const classification = classify(repo, parent, treeOf(repo));
      expect(classification.eligible).toBe(true);
      expect(classification.helperFiles).toEqual(['e2e/helper.ts']);
      expect(classification.affectedTestFiles).toEqual(TEST_FILES);
    });
  });

  it('reads an import call inside a line comment or a string as prose, not as a computed import', async () => {
    await withTempRepo({}, async (repo) => {
      repo.writeFiles({
        ...BASE_FILES,
        'e2e/prose.ts': [
          '// import(name) is what refuses a re-seal, and this line only says so.',
          '// require(name) too.',
          "export const sample = 'import(x)';",
          'export const other = `require(y)`;',
          'export const amount = () => 3;',
          '',
        ].join('\n'),
      });
      repo.commitFiles({}, 'base');
      const parent = treeOf(repo);
      repo.commitFiles({ 'e2e/helper.ts': 'export const amount = () => 4;\n' }, 'fix the helper');
      const classification = classify(repo, parent, treeOf(repo));
      expect(classification.eligible).toBe(true);
      expect(classification.helperFiles).toEqual(['e2e/helper.ts']);
    });
  });

  it('reads a file with non-ASCII text in full, not cut at a character count', async () => {
    await withTempRepo({}, async (repo) => {
      repo.writeFiles({
        ...BASE_FILES,
        // Sorted before the other sources, so its bytes sit in the middle
        // of the object batch: a size read as characters instead of bytes
        // pulls the next record's header into this file's text.
        'e2e/a-notes.ts': [
          '// Übersicht → Buchungen: Größe in Bytes, nicht in Zeichen.',
          `// ${'→'.repeat(40)}`,
          'export const note = 1;',
          '',
        ].join('\n'),
      });
      repo.commitFiles({}, 'base');
      const parent = treeOf(repo);
      repo.commitFiles({ 'e2e/helper.ts': 'export const amount = () => 5;\n' }, 'fix the helper');
      const classification = classify(repo, parent, treeOf(repo));
      expect(classification.reason).toBeNull();
      expect(classification.eligible).toBe(true);
      expect(classification.helperFiles).toEqual(['e2e/helper.ts']);
    });
  });

  it('reads a local re-export without `from` as no import at all', async () => {
    await withTempRepo({}, async (repo) => {
      repo.writeFiles({
        ...BASE_FILES,
        'e2e/runtime.ts': ["import { amount } from './helper';", '', 'export { amount };', ''].join('\n'),
      });
      repo.commitFiles({}, 'base');
      const parent = treeOf(repo);
      repo.commitFiles({ 'e2e/accounts.spec.ts': `${SPEC}\n// a real fix\n` }, 'test fix');
      const classification = classify(repo, parent, treeOf(repo));
      expect(classification.reason).toBeNull();
      expect(classification.eligible).toBe(true);
    });
  });

  it('ignores a computed Python import when the change set holds only script files', async () => {
    await withTempRepo({}, async (repo) => {
      repo.writeFiles({
        ...BASE_FILES,
        // A backend test that imports every module by name: a Python
        // import can load only Python modules, so it can hide no edge to
        // a changed TypeScript helper.
        'backend/tests/test_modules.py': 'import importlib\n\nfor name in NAMES:\n    importlib.import_module(name)\n',
      });
      repo.commitFiles({}, 'base');
      const parent = treeOf(repo);
      repo.commitFiles({ 'e2e/helper.ts': 'export const amount = () => 6;\n' }, 'fix the helper');
      const classification = classify(repo, parent, treeOf(repo));
      expect(classification.reason).toBeNull();
      expect(classification.helperFiles).toEqual(['e2e/helper.ts']);
    });
  });

  it('still refuses that computed Python import once a Python file is in the change set', async () => {
    await withTempRepo({}, async (repo) => {
      repo.writeFiles({
        ...BASE_FILES,
        'backend/tests/test_modules.py': 'import importlib\n\nfor name in NAMES:\n    importlib.import_module(name)\n',
      });
      repo.commitFiles({}, 'base');
      const parent = treeOf(repo);
      repo.commitFiles(
        { 'e2e/helper.ts': 'export const amount = () => 7;\n', 'e2e/data_helper.py': 'VALUE = 7\n' },
        'change a script helper and a python file',
      );
      const classification = classify(repo, parent, treeOf(repo));
      expect(classification.eligible).toBe(false);
      expect(classification.reason).toBe(
        'unresolvable import: backend/tests/test_modules.py loads a module through a computed specifier → changed-scope run',
      );
    });
  });

  it('names a changed app file before any doubt about an unrelated import', async () => {
    await withTempRepo({}, async (repo) => {
      repo.writeFiles({
        ...BASE_FILES,
        'backend/tests/test_modules.py': 'import importlib\n\nfor name in NAMES:\n    importlib.import_module(name)\n',
        'backend/app/invoices.py': 'TOTAL = 1\n',
      });
      repo.commitFiles({}, 'base');
      const parent = treeOf(repo);
      repo.commitFiles(
        { 'backend/app/invoices.py': 'TOTAL = 2\n', 'e2e/accounts.spec.ts': `${SPEC}\n// with the app change\n` },
        'app and test change',
      );
      const classification = classify(repo, parent, treeOf(repo));
      expect(classification.reason).toBe('app file changed: backend/app/invoices.py → changed-scope run');
    });
  });

  it('reads a byte-order mark before a shebang as an encoding artifact, not a syntax error', async () => {
    await withTempRepo({}, async (repo) => {
      repo.writeFiles({
        ...BASE_FILES,
        '.gateforge/adapters/tenant.accounts.mjs': [
          '﻿#!/usr/bin/env node',
          "import { amount } from '../../e2e/helper.js';",
          'export const accounts = amount();',
          '',
        ].join('\n'),
      });
      repo.commitFiles({}, 'base');
      const parent = treeOf(repo);
      repo.commitFiles({ 'e2e/accounts.spec.ts': `${SPEC}\n// a real fix\n` }, 'test fix');
      const classification = classify(repo, parent, treeOf(repo));
      expect(classification.eligible).toBe(true);
      expect(classification.affectedTestFiles).toEqual(['e2e/accounts.spec.ts']);
    });
  });

  it('still refuses a real computed import in a file whose comments also name one', async () => {
    await withTempRepo({}, async (repo) => {
      repo.writeFiles({
        ...BASE_FILES,
        'e2e/mixed.ts': [
          '/**',
          ' * Only the reviewed import (always approved, active) is loaded here.',
          ' */',
          'export const load = (name) => import(name);',
          '',
        ].join('\n'),
      });
      repo.commitFiles({}, 'base');
      const parent = treeOf(repo);
      repo.commitFiles({ 'e2e/accounts.spec.ts': `${SPEC}\n// a real fix\n` }, 'test fix');
      const classification = classify(repo, parent, treeOf(repo));
      expect(classification.eligible).toBe(false);
      expect(classification.reason).toBe(
        'unresolvable import: e2e/mixed.ts loads a module through a computed specifier → changed-scope run',
      );
    });
  });

  it('refuses a file whose bytes do not parse, naming the file', async () => {
    await withTempRepo({}, async (repo) => {
      repo.writeFiles({
        ...BASE_FILES,
        'e2e/broken.ts': 'export const amount = () => ;\n',
      });
      repo.commitFiles({}, 'base');
      const parent = treeOf(repo);
      repo.commitFiles({ 'e2e/accounts.spec.ts': `${SPEC}\n// a real fix\n` }, 'test fix');
      const classification = classify(repo, parent, treeOf(repo));
      expect(classification.eligible).toBe(false);
      expect(classification.reason).toBe(
        'unresolvable import: e2e/broken.ts does not parse as a script → changed-scope run',
      );
    });
  });

  it('reads a Python comment and docstring naming a computed import as prose', async () => {
    await withTempRepo({}, async (repo) => {
      repo.writeFiles({
        ...BASE_FILES,
        'e2e/pyprose.py': [
          '"""Module notes: importlib.import_module(name) is refused here,',
          'and so is __import__(name). Neither runs in this module.',
          '"""',
          '',
          '# importlib.import_module(name) — prose in a comment, not a call.',
          'import importlib',
          '',
          '',
          'def amount():',
          "    return importlib.import_module('os').path.sep",
          '',
        ].join('\n'),
      });
      repo.commitFiles({}, 'base');
      const parent = treeOf(repo);
      repo.commitFiles({ 'e2e/accounts.spec.ts': `${SPEC}\n// a real fix\n` }, 'test fix');
      const classification = classify(repo, parent, treeOf(repo));
      expect(classification.eligible).toBe(true);
      expect(classification.affectedTestFiles).toEqual(['e2e/accounts.spec.ts']);
    });
  });

  it('still refuses a real computed Python import in a file whose comment names one', async () => {
    await withTempRepo({}, async (repo) => {
      repo.writeFiles({
        ...BASE_FILES,
        'e2e/pymixed.py': [
          'import importlib',
          '',
          '# importlib.import_module(name) is what a computed load looks like.',
          '',
          '',
          'def load(name):',
          '    return importlib.import_module(name)',
          '',
        ].join('\n'),
      });
      repo.commitFiles({}, 'base');
      const parent = treeOf(repo);
      repo.commitFiles(
        { 'e2e/accounts.spec.ts': `${SPEC}\n// a real fix\n`, 'e2e/pydata.py': 'VALUE = 1\n' },
        'test fix plus a python file',
      );
      const classification = classify(repo, parent, treeOf(repo));
      expect(classification.eligible).toBe(false);
      expect(classification.reason).toBe(
        'unresolvable import: e2e/pymixed.py loads a module through a computed specifier → changed-scope run',
      );
    });
  });

  it('counts a type-position import as an edge an app file owns', async () => {
    await withTempRepo({}, async (repo) => {
      repo.writeFiles({
        ...BASE_FILES,
        'e2e/typed.ts': 'export type Amount = number;\nexport const amount = (): Amount => 1;\n',
        'src/type-consumer.ts': "export type Alias = import('../e2e/typed.js').Amount;\n",
      });
      repo.commitFiles({}, 'base');
      const parent = treeOf(repo);
      repo.commitFiles(
        { 'e2e/typed.ts': 'export type Amount = number;\nexport const amount = (): Amount => 2;\n' },
        'typed change',
      );
      const classification = classify(repo, parent, treeOf(repo));
      expect(classification.eligible).toBe(false);
      expect(classification.reason).toBe(
        'app file changed: src/type-consumer.ts imports the changed test helper e2e/typed.ts → changed-scope run',
      );
    });
  });
});

describe('declared runtime files the run itself rewrites', () => {
  // The consumer's layout: the specs live in their own test root, and
  // the gitignored storage state the login stage writes sits beside it
  // under `e2e/.auth/`, outside every test root — so today it reads as
  // app code, exactly as it does on the consumer.
  const SCENARIO_FILES = ['e2e/scenarios/accounts.spec.ts', 'e2e/scenarios/orders.spec.ts'];
  const RUNTIME_FILES = {
    'src/accounts.ts': 'export const accounts = 1;\n',
    'e2e/scenarios/accounts.spec.ts': SPEC,
    'e2e/scenarios/orders.spec.ts': SPEC,
    '.gitignore': '.gateforge/\ne2e/.auth/\n',
  };

  /**
   * Classifies with the owner declaration the config carries: the
   * globs, plus the two COMMIT trees the parent and this run sealed.
   */
  const classifyDeclared = (
    repo: { root: string },
    parentTreeId: string,
    currentTreeId: string,
    parentSha: string,
    currentSha: string,
    globs: readonly string[] = ['e2e/.auth/*.json'],
  ) =>
    classifyResealChange({
      gitDir: resolveGitDir(repo.root, process.env) as string,
      env: process.env,
      cwd: repo.root,
      parentTreeId,
      currentTreeId,
      testFiles: SCENARIO_FILES,
      runtimeFileGlobs: globs,
      parentCommitTreeId: `${parentSha}^{tree}`,
      currentCommitTreeId: `${currentSha}^{tree}`,
    });

  it('refuses a rewritten gitignored state file when the owner declared nothing', async () => {
    await withTempRepo({}, async (repo) => {
      repo.writeFiles(RUNTIME_FILES);
      repo.commitFiles({}, 'base');
      repo.writeFiles({ 'e2e/.auth/contractor.json': '{"token":"a"}\n' });
      const parent = treeOf(repo);
      const parentSha = repo.headSha() as string;
      repo.writeFiles({ 'e2e/.auth/contractor.json': '{"token":"b"}\n' });
      repo.commitFiles(
        { 'e2e/scenarios/accounts.spec.ts': `${SPEC}\n// the real fix\n` },
        'the login stage rewrote its state, and the test was fixed',
      );
      const current = treeOf(repo);
      const currentSha = repo.headSha() as string;

      expect(classify(repo, parent, current, SCENARIO_FILES).reason).toBe(
        'app file changed: e2e/.auth/contractor.json → changed-scope run',
      );
      // The declaration changes the decision, and names what it dropped.
      const declared = classifyDeclared(repo, parent, current, parentSha, currentSha);
      expect(declared.eligible).toBe(true);
      expect(declared.reason).toBeNull();
      expect(declared.changedPaths).toEqual(['e2e/.auth/contractor.json', 'e2e/scenarios/accounts.spec.ts']);
      expect(declared.disregardedPaths).toEqual(['e2e/.auth/contractor.json']);
      expect(declared.testFiles).toEqual(['e2e/scenarios/accounts.spec.ts']);
      expect(declared.affectedTestFiles).toEqual(['e2e/scenarios/accounts.spec.ts']);
    });
  });

  it('never lets a declaration hide a TRACKED file, however the glob reads', async () => {
    await withTempRepo({}, async (repo) => {
      repo.writeFiles(RUNTIME_FILES);
      repo.writeFiles({ 'e2e/.auth/contractor.json': '{"token":"a"}\n' });
      repo.git(['add', '-f', 'e2e/.auth/contractor.json']);
      repo.commit('base');
      const parent = treeOf(repo);
      const parentSha = repo.headSha() as string;
      repo.writeFiles({ 'e2e/.auth/contractor.json': '{"token":"b"}\n' });
      const currentSha = repo.commitFiles(
        { 'e2e/scenarios/accounts.spec.ts': `${SPEC}\n// the real fix\n` },
        'a tracked state file changed next to a test fix',
      );
      const current = treeOf(repo);

      const declared = classifyDeclared(repo, parent, current, parentSha, currentSha, [
        'e2e/.auth/contractor.json',
        'e2e/.auth/*.json',
        'e2e/**',
      ]);
      expect(declared.eligible).toBe(false);
      expect(declared.reason).toBe('app file changed: e2e/.auth/contractor.json → changed-scope run');
      expect(declared.disregardedPaths).toEqual([]);
    });
  });

  it('keeps the identical-tree refusal when the declaration covers the whole change', async () => {
    await withTempRepo({}, async (repo) => {
      repo.writeFiles(RUNTIME_FILES);
      repo.commitFiles({}, 'base');
      repo.writeFiles({ 'e2e/.auth/contractor.json': '{"token":"a"}\n' });
      const parent = treeOf(repo);
      const parentSha = repo.headSha() as string;
      repo.writeFiles({ 'e2e/.auth/contractor.json': '{"token":"b"}\n' });
      const current = treeOf(repo);
      const currentSha = repo.headSha() as string;

      const declared = classifyDeclared(repo, parent, current, parentSha, currentSha);
      expect(declared.eligible).toBe(false);
      expect(declared.reason).toBe(
        'the sealed trees are identical, so there is nothing to classify → changed-scope run',
      );
    });
  });

  it('declares nothing when the key is absent, so the classification is byte-identical', async () => {
    await withTempRepo({}, async (repo) => {
      repo.writeFiles(RUNTIME_FILES);
      repo.commitFiles({}, 'base');
      const parent = treeOf(repo);
      const parentSha = repo.headSha() as string;
      repo.commitFiles({ 'e2e/scenarios/accounts.spec.ts': `${SPEC}\n// the real fix\n` }, 'the real fix');
      const current = treeOf(repo);
      const currentSha = repo.headSha() as string;

      const plain = classify(repo, parent, current, SCENARIO_FILES);
      expect(plain).toEqual(classifyDeclared(repo, parent, current, parentSha, currentSha, []));
      expect(plain.disregardedPaths).toBeUndefined();
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
