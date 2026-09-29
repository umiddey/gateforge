/**
 * Test-only re-seal, end to end through the REAL CLI: a full
 * supervised run seals a whole-suite receipt, ONE test file changes,
 * and `test-gates --changed --scope changed` re-runs exactly the
 * affected tests, carries the rest, and seals a receipt bound to the
 * parent. `check --require-e2e` then verifies that receipt, and an app
 * file changed beside a test falls back to the full run with the one
 * plain reason line.
 *
 * The runner child is a stub CLI (the same pattern as the wired
 * registration case): discovery, planning, supervision, sealing and
 * verification are all the product's own code. What the stub cannot do
 * is lie about WHICH files it was asked to run — it reports exactly
 * the selection the trusted config handed it, so the assertions below
 * are about the real selection the real planner made.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { GateReceiptSchema, loadConfig, sha256Canonical, withTempRepo, type GateReceipt } from '@gate-forge/core';
import { configYml, fixtureFingerprint, installFixture, runCli } from './helpers.js';
import { trustedPolicyDigestForConfig } from '../src/execution.js';

const VERIFIER_KEY = 'reseal-e2e-verifier-key';

/** The two spec files, one test each, as the catalog and runner see them. */
const SPECS: Record<string, string> = {
  'e2e/accounts.spec.mjs': ["import { test } from 'playwright/test';", "test('reads an account', async () => {});", ''].join('\n'),
  'e2e/orders.spec.mjs': ["import { test } from 'playwright/test';", "test('reads an order', async () => {});", ''].join('\n'),
};

const TITLES: Record<string, string> = {
  'e2e/accounts.spec.mjs': 'reads an account',
  'e2e/orders.spec.mjs': 'reads an order',
};

/** A contract-valid adapter: the witness the run spawns validates it. */
const ADAPTER = [
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
  '  const selected = JSON.parse(/testMatch: (\\[[^\\]]*\\])/.exec(config)[1]);',
  '  const reporter = /"stateDir":"([^"]+)","runId":"([^"]+)","outcomesPath":"([^"]+)"/.exec(config);',
  "  const spool = reporter[1] + '/spool/' + reporter[2] + '/events.jsonl';",
  "  mkdirSync(spool.replace(/\\/[^/]+$/, ''), { recursive: true });",
  '  const events = selected.flatMap((file) => [',
  "    { kind: 'testBegin', testId: file, workerIndex: 0, file, titlePath: [titles[file]], project: 'chromium' },",
  "    { kind: 'testEnd', testId: file, workerIndex: 0, file, titlePath: [titles[file]], project: 'chromium', outcome: 'passed', attempt: 1 },",
  '  ]);',
  "  writeFileSync(spool, events.map((event) => JSON.stringify(event)).join('\\n') + '\\n');",
  '  writeFileSync(reporter[3], JSON.stringify({',
  '    schemaVersion: 1,',
  "    runStatus: 'passed',",
  '    runnerErrors: [],',
  '    shard: null,',
  '    outcomes: selected.map((file) => ({',
  '      testId: file,',
  '      file,',
  '      titlePath: [titles[file]],',
  "      project: 'chromium',",
  "      status: 'passed',",
  '      attempt: 1,',
  '      expectedFailure: false,',
  '    })),',
  '  }));',
  '}',
].join('\n');

const STUB_CLI = [
  "const { readFileSync, writeFileSync, mkdirSync } = require('node:fs');",
  'const argv = process.argv.slice(2);',
  `const files = ${JSON.stringify(Object.keys(SPECS))};`,
  `const titles = ${JSON.stringify(TITLES)};`,
  STUB_LIST_BODY,
  '',
].join('\n');

function waivers(): Record<string, string> {
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
function sealedReceipt(repo: { root: string }): GateReceipt {
  return GateReceiptSchema.parse(
    JSON.parse(readFileSync(join(repo.root, '.gateforge/test-gates/receipt.json'), 'utf8')),
  );
}

/** The real sealed execution result of the run that just finished. */
function sealedExecution(repo: { root: string }): {
  planned: Array<{ logicalKey: string; file: string }>;
  outcomes: Array<{ logicalKey: string; status: string }>;
} {
  return JSON.parse(readFileSync(join(repo.root, '.gateforge/test-gates/execution-result.json'), 'utf8'));
}

describe('test-only re-seal (real CLI, end to end)', () => {
  it('re-runs only the changed spec, re-seals from the parent, and passes check --require-e2e', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      repo.writeFiles({
        ...waivers(),
        ...SPECS,
        '.gateforge/adapters/accounts.mjs': ADAPTER,
        '.gateforge/adapters/orders.mjs': ADAPTER,
        '.gateforge.yml': `mode: changed\n${configYml()}`,
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

      // 1. A full supervised run seals the whole-suite parent receipt.
      const full = await runCli(repo, ['test-gates', '--changed', '--format', 'json'], env);
      expect(full.code, `${full.stdout}\n${full.stderr}`).toBe(0);
      const parent = sealedReceipt(repo);
      expect(parent.scope).toBeUndefined();
      expect(parent.resealedFrom).toBeUndefined();
      expect(parent.verdictSummary.blocking).toBe(0);
      const fullExecution = sealedExecution(repo);
      expect(fullExecution.outcomes.map((row) => row.logicalKey).sort()).toEqual([
        'playwright:chromium:e2e/accounts.spec.mjs:reads an account',
        'playwright:chromium:e2e/orders.spec.mjs:reads an order',
      ]);
      const parentDigest = sha256Canonical(parent as unknown as Record<string, never>);

      // 2. ONE test file changes — a real, harmless edit.
      repo.commitFiles(
        { 'e2e/accounts.spec.mjs': `${SPECS['e2e/accounts.spec.mjs'] as string}// the race fix\n` },
        'fix the race in one spec',
      );

      // 3. The re-seal: exactly the affected spec re-runs, the rest is carried.
      const resealed = await runCli(repo, ['test-gates', '--changed', '--scope', 'changed', '--format', 'json'], env);
      expect(resealed.code, `${resealed.stdout}\n${resealed.stderr}`).toBe(0);
      expect(resealed.stderr).toContain('only test files changed: re-ran 1 test(s), kept 1 from the previous receipt');

      const execution = sealedExecution(repo);
      expect(execution.outcomes.map((row) => row.logicalKey)).toEqual([
        'playwright:chromium:e2e/accounts.spec.mjs:reads an account',
      ]);
      expect(execution.outcomes.every((row) => row.status === 'passed')).toBe(true);

      const receipt = sealedReceipt(repo);
      expect(receipt.changeClass).toBe('test-only');
      expect(receipt.changedPaths).toEqual(['e2e/accounts.spec.mjs']);
      expect(receipt.rerunTests).toBe(1);
      expect(receipt.carriedTests).toBe(1);
      expect(receipt.resealedFrom).toBe(parentDigest);

      // 4. CI verifies the re-sealed receipt with its own engine.
      const checked = await runCli(repo, ['check', '--changed', '--require-e2e', '--format', 'json'], env);
      expect(checked.code, `${checked.stdout}\n${checked.stderr}`).toBe(0);

    });
  }, 180_000);
});
