/**
 * Coverage-policy ↔ test-mapping wiring (plan 2026-09-13 §3.6, Phase 7
 * E27 "mapped journey clears" leg): a browser-e2e-declared binding for a
 * CRUD-contract obligation supplies the coverage fact that clears its
 * table/operation requirement in `check`, exactly as an owner
 * disposition does; non-browser kinds and absent mappings keep blocking.
 * `example-e2e` class: CLI process behavior over a real project tree
 * (discovery resolves the real playwright runner, no browsers needed).
 */
import { existsSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { withTempRepo, type TempRepo } from '@gate-forge/core';
import { installFixture, OBLIGATION_ACCOUNTS, runCli } from './helpers.js';

/** The gateforge monorepo root (for playwright module resolution). */
const ROOT = fileURLToPath(new URL('../../..', import.meta.url));

/** The consumer's playwright config (ESM; project pinned to chromium). */
const PW_CONFIG = "export default { testDir: 'e2e', projects: [{ name: 'chromium' }] };\n";

const ACCOUNTS_SPEC = [
  "import { test } from 'playwright/test';",
  "test('deletes an account', async ({ page }) => {",
  '  await page.goto("/accounts");',
  '});',
  '',
].join('\n');

const DELETE_KEY = 'playwright:chromium:e2e/accounts.spec.js:deletes an account';

/**
 * Installs the standard fixture (persistence:read obligation on the
 * accounts table) plus a real playwright project whose runner resolves
 * through node_modules links (no browsers needed for `--list`).
 */
function installConsumer(repo: TempRepo): void {
  installFixture(repo, { include: "['src/**/*.txt', 'e2e/**/*.spec.js']" });
  repo.writeFiles({
    'playwright.config.js': PW_CONFIG,
    'e2e/accounts.spec.js': ACCOUNTS_SPEC,
    '.gitignore': 'node_modules\n',
  });
  const nm = join(repo.root, 'node_modules');
  mkdirSync(nm, { recursive: true });
  for (const name of ['playwright', 'playwright-core']) {
    const target = join(nm, name);
    if (!existsSync(target)) {
      symlinkSync(join(ROOT, 'node_modules', name), target, 'dir');
    }
  }
}

/** Appends a coverage policy requiring read+update on accounts (orders dispositioned). */
function withCoveragePolicy(repo: TempRepo): void {
  const path = join(repo.root, '.gateforge.yml');
  writeFileSync(
    path,
    `${readFileSync(path, 'utf8')}coveragePolicy:\n` +
      '  tables:\n' +
      '    - name: accounts\n' +
      '      requiredOperations: [read, update]\n' +
      '    - name: orders\n' +
      '      requiredOperations: [read]\n' +
      '      disposition:\n' +
      '        kind: read-only-surface\n' +
      '        note: orders are read-only in the fixture UI\n',
    'utf8',
  );
}

/** Writes the sidecar directly (identical validation, per §5.3). */
function writeSidecar(repo: TempRepo, kind: string): void {
  repo.writeFiles({
    '.gateforge/test-map.yml': `\
schemaVersion: 1
tests:
  - key: ${DELETE_KEY}
    selector:
      runner: playwright
      project: chromium
      file: e2e/accounts.spec.js
      titlePath:
        - deletes an account
    kind: ${kind}
    claims:
      - ${OBLIGATION_ACCOUNTS}
    reason: The existing journey reads the accounts list in the rendered UI.
`,
  });
}

interface ReportJson {
  blocking: Array<{ name: string | null; cause?: string | null; detail: string }>;
}

async function coverageFindings(repo: TempRepo): Promise<Array<{ operation: string }>> {
  const { code, stdout, stderr } = await runCli(repo, ['check', '--format', 'json']);
  expect(code, stderr).toBe(1);
  const report = JSON.parse(stdout) as ReportJson;
  return report.blocking
    .filter((entry) => entry.cause === 'CRUD_COVERAGE_MISSING')
    .map((entry) => ({
      operation: /mapped real-UI '([a-z]+)' coverage/.exec(entry.detail)?.[1] ?? '',
    }));
}

describe('coverage policy consumes resolved test mappings', () => {
  it('an unmapped table blocks; a browser-e2e sidecar binding clears its operation; a non-browser kind does not', async () => {
    await withTempRepo({}, async (repo) => {
      installConsumer(repo);
      withCoveragePolicy(repo);

      // No sidecar: read and update are both uncovered.
      expect(await coverageFindings(repo)).toEqual([{ operation: 'read' }, { operation: 'update' }]);

      // A browser-e2e declaration for the read obligation clears read;
      // update stays blocking (the same journey cannot fake it).
      writeSidecar(repo, 'browser-e2e');
      expect(await coverageFindings(repo)).toEqual([{ operation: 'update' }]);

      // An observed-e2e declaration clears exactly like browser-e2e
      // (both are real-UI journeys).
      writeSidecar(repo, 'observed-e2e');
      expect(await coverageFindings(repo)).toEqual([{ operation: 'update' }]);

      // A non-browser kind never satisfies closed-world coverage.
      writeSidecar(repo, 'api-e2e');
      expect(await coverageFindings(repo)).toEqual([{ operation: 'read' }, { operation: 'update' }]);
    });
  });

  it('clearing goes through the same mark path agents use (tests mark → check)', async () => {
    await withTempRepo({}, async (repo) => {
      installConsumer(repo);
      withCoveragePolicy(repo);
      const marked = await runCli(repo, [
        'tests', 'mark',
        '--test', DELETE_KEY,
        '--kind', 'browser-e2e',
        '--obligation', OBLIGATION_ACCOUNTS,
        '--reason', 'The existing journey reads the accounts list in the rendered UI.',
      ]);
      expect(marked.code, marked.stderr).toBe(0);
      expect(existsSync(join(repo.root, '.gateforge', 'test-map.yml'))).toBe(true);
      expect(await coverageFindings(repo)).toEqual([{ operation: 'update' }]);
    });
  });
});
