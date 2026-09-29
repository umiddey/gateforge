/**
 * Runner-aware gate surfaces: `check --changed`, `next --changed` and
 * `check --require-e2e` follow the CONFIGURED runner (`runner:` in
 * `.gateforge.yml`) instead of probing the Playwright config only.
 *
 * - a repo declaring `runner: vitest` expands its evaluation scope on a
 *   staged `vitest.config.ts` change (before: the runner config was
 *   looked up through the Playwright probe only, so the change stayed
 *   invisible and the gate reported nothing to do);
 * - `next --changed` honours the same scope, so it keeps ranking the
 *   whole gate instead of silently going clean;
 * - `check --require-e2e` accepts a receipt whose sealed execution
 *   result names a non-Playwright runner — the runner is a STRING in
 *   the schemas, and the evidence contract is the digest binding, not
 *   the runner's name.
 *
 * Red-probe rule: on the pre-fix tree the first two cases fail (scope
 * stays `changed` / `next: none — clean`) and the third passes already.
 */
import { describe, expect, it } from 'vitest';
import { loadConfig, withTempRepo } from '@gate-forge/core';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { trustedPolicyDigestForConfig } from '../src/execution.js';
import {
  configYml,
  fixtureFingerprint,
  installFixture,
  OBLIGATION_ACCOUNTS,
  OBLIGATION_ORDERS,
  runCli,
} from './helpers.js';
import { mintCompleteRunReceipt } from './gate-receipts.js';

/** The fixture config with the configured runner set to `runner`. */
function configWithRunner(runner: string): string {
  return configYml().replace('changed:', `runner: ${runner}\nchanged:`);
}

/** A minimal, syntactically valid vitest config (never executed here). */
const VITEST_CONFIG = "import { defineConfig } from 'vitest/config';\nexport default defineConfig({ test: {} });\n";

/** The two fixture obligations in a stable order. */
const ALL_OBLIGATIONS = [OBLIGATION_ACCOUNTS, OBLIGATION_ORDERS].sort();

describe('gate surfaces follow the configured runner', () => {
  it('check --changed expands the scope on a staged vitest config change', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      repo.writeFiles({
        '.gateforge.yml': configWithRunner('vitest'),
        'vitest.config.ts': VITEST_CONFIG,
      });
      repo.commitFiles({}, 'base with a vitest runner');
      repo.writeFiles({ 'vitest.config.ts': `${VITEST_CONFIG}// changed\n` });
      repo.stage(['vitest.config.ts']);

      const { code, stdout } = await runCli(repo, ['check', '--changed', '--format', 'json']);
      expect(code).toBe(1);
      const report = JSON.parse(stdout) as {
        scope?: { mode: string; expandedBecause: string[] };
        verdicts: Array<{ obligationId: string }>;
      };
      expect(report.scope?.mode).toBe('all');
      expect(report.scope?.expandedBecause).toContain('vitest.config.ts');
      expect(report.verdicts.map((verdict) => verdict.obligationId).sort()).toEqual(ALL_OBLIGATIONS);
    });
  });

  it('next --changed keeps ranking the whole gate for a vitest config change', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      repo.writeFiles({
        '.gateforge.yml': configWithRunner('vitest'),
        'vitest.config.ts': VITEST_CONFIG,
      });
      repo.commitFiles({}, 'base with a vitest runner');
      repo.writeFiles({ 'vitest.config.ts': `${VITEST_CONFIG}// changed\n` });
      repo.stage(['vitest.config.ts']);

      const { code, stdout } = await runCli(repo, ['next', '--changed', '--json']);
      expect(code).toBe(1);
      const report = JSON.parse(stdout) as { next: string; remainingBlocking: number };
      expect(report.next).toBe(OBLIGATION_ACCOUNTS);
      expect(report.remainingBlocking).toBeGreaterThan(0);
    });
  });

  it('check --require-e2e accepts a receipt sealed by a vitest run', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      repo.writeFiles({
        '.gateforge.yml': `${configWithRunner('vitest')}enforcement:\n  receiptStage: pre-push\n`,
        '.gateforge/waivers/accounts.json': waiverJson('tenant.accounts'),
        '.gateforge/waivers/orders.json': waiverJson('tenant.orders'),
      });
      repo.stage();
      repo.commit('candidate tree');
      const candidateSha = repo.headSha();
      expect(candidateSha).not.toBeNull();
      const config = loadConfig(repo.path('.gateforge.yml'));
      const approvedDigest = trustedPolicyDigestForConfig(repo.root, config);
      await mintCompleteRunReceipt(repo, {
        verifierKey: 'vitest-run-key',
        parentSha: null,
        approvedPolicyDigest: approvedDigest,
        runner: 'vitest',
      });

      const result = await runCli(
        repo,
        ['check', '--candidate-commit', candidateSha ?? '', '--require-e2e', '--format', 'json'],
        {
          GATEFORGE_WITNESS_VERIFIER_KEY: 'vitest-run-key',
          GATEFORGE_APPROVED_POLICY_DIGEST: approvedDigest,
        },
      );
      expect(result.code, result.stdout).toBe(0);
    });
  }, 120_000);
});

describe('doctor readiness follows the configured runner', () => {
  /** The `runner` check of the deterministic doctor JSON report. */
  async function runnerCheck(
    repo: { root: string },
    env: Record<string, string | undefined> = {},
  ): Promise<{ status: string; detail: string }> {
    const result = await runCli(repo as never, ['enforcement', 'doctor', '--json'], env);
    expect(result.code).toBe(0); // the doctor is a diagnostic: it always runs
    const report = JSON.parse(result.stdout) as {
      checks: Array<{ id: string; status: string; detail: string }>;
    };
    const found = report.checks.find((entry) => entry.id === 'runner');
    expect(found, "the 'runner' check is present").toBeTruthy();
    return found as { status: string; detail: string };
  }

  it('keeps the Playwright readiness byte-identical without a runner key', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      const check = await runnerCheck(repo);
      expect(check.status).toBe('fail');
      expect(check.detail).toBe(
        'playwright is not installed (no node_modules/playwright found from the repo root); ' +
          'the supervised E2E runner cannot execute',
      );
    });
  });

  it('reports a missing vitest config when vitest is the configured runner', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      repo.writeFiles({ '.gateforge.yml': configWithRunner('vitest') });
      const check = await runnerCheck(repo);
      expect(check.status).toBe('fail');
      expect(check.detail).toContain('vitest');
      expect(check.detail).toContain('vitest.config.*');
      expect(check.detail).not.toContain('playwright');
    });
  });

  it('reports vitest ready once its config and package are present', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      repo.writeFiles({
        '.gateforge.yml': configWithRunner('vitest'),
        'vitest.config.ts': VITEST_CONFIG,
        'node_modules/vitest/package.json': '{"name":"vitest","version":"3.0.0"}\n',
      });
      const check = await runnerCheck(repo);
      expect(check.status).toBe('ok');
      expect(check.detail).toContain('vitest.config.ts');
    });
  });

  it('reports a missing pytest suite when pytest is the configured runner', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      repo.writeFiles({ '.gateforge.yml': configWithRunner('pytest') });
      const check = await runnerCheck(repo);
      expect(check.status).toBe('fail');
      expect(check.detail).toContain('pytest');
      expect(check.detail).toContain('suite');
    });
  });

  it('reports pytest ready with a configured suite and a resolvable binary', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      repo.writeFiles({
        '.gateforge.yml': `${configWithRunner('pytest')}diagnostics:
  suites:
    - name: backend
      runner: pytest
      cwd: .
      argv: ['python', '-m', 'pytest']
      testPaths: ['tests']
      timeoutMs: 120000
`,
      });
      const binDir = join(repo.root, 'fake-bin');
      mkdirSync(binDir, { recursive: true });
      const binary = join(binDir, 'pytest');
      writeFileSync(binary, '#!/bin/sh\nexit 0\n');
      chmodSync(binary, 0o755);
      const check = await runnerCheck(repo, { PATH: binDir });
      expect(check.status).toBe('ok');
      expect(check.detail).toContain('backend');
    });
  });
});

/** A valid, unexpired waiver for one fixture obligation. */
function waiverJson(resourceId: string): string {
  return JSON.stringify({
    schemaVersion: 1,
    owner: `team-${resourceId.split('.')[1]}`,
    justificationUrl: 'https://example.invalid/justification',
    approver: 'approver@example.invalid',
    scope: { kind: 'exact', resourceId, fingerprint: fixtureFingerprint(resourceId) },
    expiresAt: '2027-01-01T00:00:00.000Z',
  });
}
