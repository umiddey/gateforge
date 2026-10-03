/**
 * `gateforge test-gates`: the orchestration surface G6 consumes —
 * run-state materialization (manifest, obligations with fingerprints,
 * env contract), suite execution with the ambient env, post-suite
 * verdict evaluation, and failure propagation.
 */
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { GateReceiptSchema, RunManifestSchema, loadConfig, withTempRepo, fingerprint } from '@gate-forge/core';
import { configYml, fixtureFingerprint, installFixture, runCli } from './helpers.js';
import { trustedPolicyDigestForConfig } from '../src/execution.js';
import { mintCompleteRunReceipt } from './gate-receipts.js';

/** A stub suite: reports one claimed ui.action record for the target. */
const SUITE_SOURCE = `import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
const stateDir = process.env.GATEFORGE_STATE_DIR;
if (!stateDir) throw new Error('missing GATEFORGE_STATE_DIR');
mkdirSync(stateDir, { recursive: true });
const obligationId = process.env.GATEFORGE_TARGET || 'tenant.accounts:persistence:read';
writeFileSync(join(stateDir, 'claims.json'), JSON.stringify([
  { schemaVersion: 1, obligationId, testId: 'suite-test', testFile: 'tests/accounts.spec.ts' },
]));
writeFileSync(join(stateDir, 'records.json'), JSON.stringify([
  {
    schemaVersion: 1,
    recordId: 'b'.repeat(64),
    runId: '00000000-0000-4000-8000-000000000002',
    trust: 'claimed',
    obligationId,
    testId: 'suite-test',
    kind: 'ui.action',
    payload: { operation: 'read', entityId: 'acc-1' },
  },
]));
console.log('suite-ran');
`;

describe('gateforge test-gates', () => {
  it('materializes the run state (manifest, obligations, env) before evaluating', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      repo.commitFiles({}, 'base');
      const { code, stdout } = await runCli(repo, ['test-gates', '--format', 'json'], { NODE_ENV: 'development' });
      expect(code).toBe(1); // no claims → obligations missing

      const stateDir = repo.path('.gateforge/test-gates');
      expect(existsSync(join(stateDir, 'manifest.json'))).toBe(true);
      expect(existsSync(join(stateDir, 'obligations.json'))).toBe(true);
      expect(existsSync(join(stateDir, 'env.json'))).toBe(true);
      expect(existsSync(join(stateDir, 'report.json'))).toBe(true);

      const manifest = RunManifestSchema.parse(
        JSON.parse(readFileSync(join(stateDir, 'manifest.json'), 'utf8')),
      );
      expect(manifest.provider).toBe('all-files');
      expect(manifest.plugins).toEqual([
        { id: 'fixture.plugin', version: '1.0.0', transport: 'in-process' },
      ]);
      expect(manifest.gitSha).toMatch(/^[0-9a-f]{40}$/);

      const obligations = JSON.parse(
        readFileSync(join(stateDir, 'obligations.json'), 'utf8'),
      ) as { obligations: Array<{ id: string; fingerprint: string; source: string }> };
      expect(obligations.obligations.map((o) => o.id).sort()).toEqual([
        'tenant.accounts:persistence:read',
        'tenant.orders:persistence:read',
      ]);
      expect(obligations.obligations[0]?.fingerprint).toBe(
        fixtureFingerprint('tenant.accounts'),
      );
      expect(obligations.obligations[0]?.source).toBe('src/accounts.txt');

      const env = JSON.parse(readFileSync(join(stateDir, 'env.json'), 'utf8')) as Record<
        string,
        string | null
      >;
      expect(typeof env['GATEFORGE_RUN_ID']).toBe('string');
      expect(typeof env['GATEFORGE_RUN_TOKEN']).toBe('string');
      expect(env['GATEFORGE_RUN_TOKEN']).toBeTruthy();
      expect(env['GATEFORGE_STATE_DIR']).toBe(stateDir);
      expect(env['GATEFORGE_OBLIGATIONS']).toBe(join(stateDir, 'obligations.json'));
      expect(env['GATEFORGE_WITNESS_URL']).toBeNull();
      expect(env['frontendBuildMode']).toBe('development');

      // report.json is the canonical json-format report.
      const report = JSON.parse(readFileSync(join(stateDir, 'report.json'), 'utf8')) as {
        summary: { blocking: number };
      };
      expect(report.summary.blocking).toBe(2);
      // stdout carried the passed format (json).
      expect(stdout).toContain('"schemaVersion":1');
    });
  });

  it('blocks before the suite when harness seed fails and still runs teardown', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      const teardownMarker = repo.path('teardown-ran');
      repo.writeFiles({
        '.gateforge.yml': `${configYml()}\nharness:\n  up: 'exit 0'\n  reset: 'exit 0'\n  seed: "printf 'seed failed visibly\\\\n'; exit 7"\n  health: 'exit 99'\n  down: ${JSON.stringify(`touch ${teardownMarker}`)}\n`,
      });
      repo.commitFiles({}, 'base');

      const result = await runCli(repo, ['test-gates', '--changed', '--format', 'json']);
      expect(result.code).toBe(1);
      expect(result.stderr, JSON.stringify(result)).toContain('HARNESS_FAILED seed');
      expect(result.stderr, JSON.stringify(result)).toContain('seed failed visibly');
      expect(existsSync(teardownMarker)).toBe(true);
      expect(existsSync(repo.path('.gateforge/test-gates/manifest.json'))).toBe(false);
    });
  });

  it('carries a verified base receipt across a completely scanned empty slice', async () => {
    await withTempRepo({}, async (repo) => {
      const verifierKey = 'carry-forward-test-key';
      installFixture(repo);
      repo.writeFiles({
        '.gateforge.yml': `${configYml()}\nenforcement:\n  receiptStage: pre-push\n`,
        '.gitignore': '.gateforge/test-gates/\n',
        'src/logs.txt': '# base log constant\n',
      });
      repo.commitFiles({}, 'base');
      const baseSha = repo.headSha();
      expect(baseSha).not.toBeNull();
      const baseParent = repo.git(['rev-parse', 'HEAD^'], { allowFailure: true });
      const config = loadConfig(repo.path('.gateforge.yml'));
      const approvedPolicyDigest = trustedPolicyDigestForConfig(repo.root, config);
      await mintCompleteRunReceipt(repo, {
        verifierKey,
        parentSha: baseParent.status === 0 ? baseParent.stdout.trim() : null,
        approvedPolicyDigest,
        verdictSummary: { total: 2, satisfied: 0, waived: 2, blocking: 0 },
      });
      repo.commitFiles({ 'src/logs.txt': '# updated log constant\n' }, 'inert log update');
      const candidateSha = repo.headSha();
      expect(candidateSha).not.toBeNull();
      const env = {
        GATEFORGE_WITNESS_VERIFIER_KEY: verifierKey,
        GATEFORGE_APPROVED_POLICY_DIGEST: approvedPolicyDigest,
        CI_MERGE_REQUEST_DIFF_BASE_SHA: baseSha ?? '',
      };

      const carried = await runCli(
        repo,
        ['test-gates', '--changed', '--scope', 'changed', '--format', 'json'],
        env,
      );
      expect(carried.code, `${carried.stdout}\n${carried.stderr}`).toBe(0);
      const carryReport = JSON.parse(carried.stdout) as {
        carriedForward?: boolean;
        carriedFrom?: string;
        parentReceiptDigest?: string;
        testsPerformedThisInvocation?: number;
      };
      expect(carryReport).toMatchObject({
        carriedForward: true,
        carriedFrom: baseSha,
        testsPerformedThisInvocation: 0,
      });
      expect(carryReport.parentReceiptDigest).toMatch(/^[0-9a-f]{64}$/);

      const stateDir = repo.path('.gateforge/test-gates');
      const receipt = GateReceiptSchema.parse(JSON.parse(readFileSync(join(stateDir, 'receipt.json'), 'utf8')));
      expect(receipt.carriedFrom).toBe(baseSha);
      expect(receipt.parentReceiptDigest).toBe(carryReport.parentReceiptDigest);

      const checked = await runCli(
        repo,
        ['check', '--changed', '--candidate-commit', candidateSha ?? '', '--require-e2e', '--format', 'json'],
        env,
      );
      expect(checked.code, checked.stdout).toBe(0);
      expect((JSON.parse(checked.stdout) as { fastPath?: boolean }).fastPath).toBe(true);
    });
  }, 120_000);
  it('refuses carry-forward when the parent tree and the workspace differ outside the evaluated change set', async () => {
    await withTempRepo({}, async (repo) => {
      const verifierKey = 'carry-forward-workspace-drift-key';
      installFixture(repo);
      repo.writeFiles({
        '.gateforge.yml': `${configYml()}\nenforcement:\n  receiptStage: pre-push\n`,
        '.gitignore': '.gateforge/test-gages/\nnode_modules/\n',
        'src/logs.txt': '# base log constant\n',
        // Gitignored, so the provider diff never sees it — but the sealed
        // candidate tree carries it, so the parent's outcomes were proven
        // against THESE bytes and not against the ones below.
        'node_modules/pkg/index.js': 'module.exports = "v1";\n',
      });
      repo.commitFiles({}, 'base');
      const baseSha = repo.headSha();
      expect(baseSha).not.toBeNull();
      const config = loadConfig(repo.path('.gateforge.yml'));
      const approvedPolicyDigest = trustedPolicyDigestForConfig(repo.root, config);
      await mintCompleteRunReceipt(repo, {
        verifierKey,
        parentSha: baseSha,
        approvedPolicyDigest,
        verdictSummary: { total: 2, satisfied: 0, waived: 2, blocking: 0 },
      });

      // One inert committed change (the empty slice the carry serves) and
      // an UNEVALUATED change to a gitignored byte inside the sealed tree.
      repo.writeFiles({ 'src/logs.txt': '# updated log constant\n' });
      repo.stage(['src/logs.txt']);
      repo.commit('inert log update');
      repo.writeFiles({ 'node_modules/pkg/index.js': 'module.exports = "v2";\n' });

      const result = await runCli(
        repo,
        ['test-gates', '--changed', '--scope', 'changed', '--format', 'json'],
        {
          GATEFORGE_WITNESS_VERIFIER_KEY: verifierKey,
          GATEFORGE_APPROVED_POLICY_DIGEST: approvedPolicyDigest,
          CI_MERGE_REQUEST_DIFF_BASE_SHA: baseSha ?? '',
        },
      );
      expect(result.code, `${result.stdout}\n${result.stderr}`).not.toBe(0);
      expect(result.stdout).not.toContain('"carriedForward":true');
      expect(existsSync(repo.path('.gateforge/test-gates/receipt.json'))).toBe(false);
    });
  }, 120_000);

  it('refuses carry-forward for a different verifier key or a gate configuration diff', async () => {
    await withTempRepo({}, async (repo) => {
      const verifierKey = 'carry-forward-binding-key';
      const approvedVerifierKey = 'different-verifier-key';
      installFixture(repo);
      repo.writeFiles({
        '.gateforge.yml': `${configYml()}\nenforcement:\n  receiptStage: pre-push\n`,
        '.gitignore': '.gateforge/test-gates/\n',
        'src/logs.txt': '# base log constant\n',
      });
      repo.commitFiles({}, 'base');
      const baseSha = repo.headSha();
      const config = loadConfig(repo.path('.gateforge.yml'));
      const approvedPolicyDigest = trustedPolicyDigestForConfig(repo.root, config);
      const baseParent = repo.git(['rev-parse', 'HEAD^'], { allowFailure: true });
      await mintCompleteRunReceipt(repo, {
        verifierKey,
        parentSha: baseParent.status === 0 ? baseParent.stdout.trim() : null,
        approvedPolicyDigest,
        verdictSummary: { total: 2, satisfied: 0, waived: 2, blocking: 0 },
      });
      const env = {
        GATEFORGE_WITNESS_VERIFIER_KEY: approvedVerifierKey,
        GATEFORGE_APPROVED_POLICY_DIGEST: approvedPolicyDigest,
        CI_MERGE_REQUEST_DIFF_BASE_SHA: baseSha ?? '',
      };

      repo.commitFiles({ 'src/logs.txt': '# inert change\n' }, 'inert log change');
      const wrongKey = await runCli(
        repo,
        ['test-gates', '--changed', '--scope', 'changed', '--format', 'json'],
        env,
      );
      expect(wrongKey.code).not.toBe(0);
      const configBaseSha = repo.headSha();
      await mintCompleteRunReceipt(repo, {
        verifierKey,
        parentSha: baseSha,
        approvedPolicyDigest,
        verdictSummary: { total: 2, satisfied: 0, waived: 2, blocking: 0 },
      });

      repo.writeFiles({
        '.gateforge.yml': `${configYml()}\nenforcement:\n  receiptStage: pre-push\n# configuration file changed\n`,
      });
      repo.commitFiles({}, 'gate configuration diff');
      const gateConfigDiff = await runCli(
        repo,
        ['test-gates', '--changed', '--scope', 'changed', '--format', 'json'],
        {
          ...env,
          GATEFORGE_WITNESS_VERIFIER_KEY: verifierKey,
          CI_MERGE_REQUEST_DIFF_BASE_SHA: configBaseSha ?? '',
        },
      );
      expect(gateConfigDiff.code).not.toBe(0);

    });
    await withTempRepo({}, async (repo) => {
      const verifierKey = 'carry-forward-missing-parent-key';
      installFixture(repo);
      repo.writeFiles({
        '.gateforge.yml': `${configYml()}\nenforcement:\n  receiptStage: pre-push\n`,
        '.gitignore': '.gateforge/test-gates/\n',
        'src/logs.txt': '# base log constant\n',
      });
      repo.commitFiles({}, 'base without a receipt');
      const baseSha = repo.headSha();
      const approvedPolicyDigest = trustedPolicyDigestForConfig(
        repo.root,
        loadConfig(repo.path('.gateforge.yml')),
      );
      repo.commitFiles({ 'src/logs.txt': '# inert change\n' }, 'inert log change');
      const result = await runCli(
        repo,
        ['test-gates', '--changed', '--scope', 'changed', '--format', 'json'],
        {
          GATEFORGE_WITNESS_VERIFIER_KEY: verifierKey,
          GATEFORGE_APPROVED_POLICY_DIGEST: approvedPolicyDigest,
          CI_MERGE_REQUEST_DIFF_BASE_SHA: baseSha ?? '',
        },
      );
      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain('no receipt was sealed');
      expect(existsSync(repo.path('.gateforge/test-gates/receipt.json'))).toBe(false);
    });
  }, 120_000);


  it('runs the suite with the ambient env and evaluates its claims/records (GF-23)', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      repo.writeFiles({ 'suite.mjs': SUITE_SOURCE });
      const { code, stdout, stderr } = await runCli(repo, [
        'test-gates',
        '--suite',
        `node ${repo.path('suite.mjs')}`,
        '--format',
        'json',
      ]);
      expect(stderr).toBe('');
      // Claimed-only evidence degrades to invalid (GF-23) → exit 1.
      expect(code).toBe(1);
      expect(stdout).toContain('suite-ran');
      const report = JSON.parse((stdout.trim().split('\n').at(-1) ?? '') as string) as {
        verdicts: Array<{ obligationId: string; verdict: string; recordIds: string[] }>;
      };
      const accounts = report.verdicts.find(
        (v) => v.obligationId === 'tenant.accounts:persistence:read',
      );
      expect(accounts?.verdict).toBe('invalid');
      expect(accounts?.recordIds).toEqual(['b'.repeat(64)]);
    });
  });
  it('refuses to execute when wired registration differs from scrubbed discovery', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      const marker = repo.path('wired-test-ran');
      const adapterSource = [
        'export default {',
        '  read: async () => null,',
        '  normalize: (body) => ({ entityId: body.id, fields: {} }),',
        "  deletion: 'hard',",
        "  environmentFingerprint: 'preflight-test',",
        '};',
        '',
      ].join('\n');
      repo.writeFiles({
        '.gateforge/adapters/accounts.mjs': adapterSource,
        '.gateforge/adapters/orders.mjs': adapterSource,
        'playwright.config.mjs': "export default { testDir: 'e2e', projects: [{ name: 'chromium' }] };\n",
        'e2e/registration.spec.mjs': [
          "import { test } from 'playwright/test';",
          'if (process.env.GATEFORGE_RUN_TOKEN === undefined) {',
          "  test('scrubbed registration', () => {});",
          '} else {',
          "  test('wired registration', () => {});",
          '}',
          '',
        ].join('\n'),
        'node_modules/playwright/cli.js': [
          "const { writeFileSync } = require('node:fs');",
          'if (process.argv.includes("--list")) {',
          "  const title = process.env.GATEFORGE_RUN_TOKEN ? 'wired registration' : 'scrubbed registration';",
          "  process.stdout.write(JSON.stringify({ config: { rootDir: process.cwd() }, suites: [{ file: 'e2e/registration.spec.mjs', specs: [{ id: 'registration', title, line: 3, column: 0, tests: [{ projectId: 'chromium', projectName: 'chromium', expectedStatus: 'passed', annotations: [] }] }] }] }));",
          '} else {',
          `  writeFileSync(${JSON.stringify(marker)}, 'runner invoked');`,
          '}',
          '',
        ].join('\n'),
      });
      repo.commitFiles({}, 'base');

      const started = Date.now();
      const result = await runCli(
        repo,
        ['test-gates', '--changed', '--format', 'json'],
        { GATEFORGE_WITNESS_VERIFIER_KEY: 'preflight-verifier-key' },
      );

      expect(result.code).toBe(2);
      expect(result.stderr).toContain('registration differs');
      expect(result.stderr).toContain('e2e/registration.spec.mjs');
      expect(result.stderr).toContain('wired registration');
      expect(Date.now() - started).toBeLessThan(10_000);
      expect(existsSync(marker)).toBe(false);
    });
  }, 30_000);


  it('fails the run when the suite exits nonzero, even with clean verdicts', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      // Waive every obligation AND make the suite fail: the suite failure
      // must still surface as exit 1.
      repo.writeFiles({
        '.gateforge/waivers/accounts.json': JSON.stringify({
          schemaVersion: 1,
          owner: 'team',
          justificationUrl: 'https://example.invalid/justification',
          approver: 'approver@example.invalid',
          scope: {
            kind: 'exact',
            resourceId: 'tenant.accounts',
            fingerprint: fixtureFingerprint('tenant.accounts'),
          },
          expiresAt: '2027-01-01T00:00:00.000Z',
        }),
        '.gateforge/waivers/orders.json': JSON.stringify({
          schemaVersion: 1,
          owner: 'team',
          justificationUrl: 'https://example.invalid/justification',
          approver: 'approver@example.invalid',
          scope: {
            kind: 'exact',
            resourceId: 'tenant.orders',
            fingerprint: fixtureFingerprint('tenant.orders'),
          },
          expiresAt: '2027-01-01T00:00:00.000Z',
        }),
      });
      const { code, stderr } = await runCli(repo, ['test-gates', '--suite', 'exit 3']);
      expect(code).toBe(1);
      expect(stderr).toContain('suite exited with status 3');
    });
  });

  it('supports an explicit --out state directory and adopts a wired witness run identity', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      // A live stub witness: /health answers with the runId the CLI
      // must adopt (fail-closed contract); /records answers empty.
      const stubRunId = '11111111-2222-4333-8444-555555555555';
      const stub = createServer((req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          req.url === '/health'
            ? JSON.stringify({ ok: true, runId: stubRunId })
            : JSON.stringify({ records: [] }),
        );
      });
      await new Promise<void>((resolve) => stub.listen(0, '127.0.0.1', resolve));
      const stubPort = (stub.address() as { port: number }).port;
      const witnessUrl = `http://127.0.0.1:${stubPort}`;
      const out = 'custom-state';
      const { code } = await runCli(repo, [
        'test-gates',
        '--out',
        out,
        '--witness-url',
        witnessUrl,
        '--run-token',
        'stub-token',
      ]);
      expect(code).toBe(1);
      const stateDir = repo.path(out);
      const env = JSON.parse(readFileSync(join(stateDir, 'env.json'), 'utf8')) as Record<
        string,
        string | null
      >;
      expect(env['GATEFORGE_STATE_DIR']).toBe(stateDir);
      expect(env['GATEFORGE_WITNESS_URL']).toBe(witnessUrl);
      // The CLI adopted the witness's run identity, not its own.
      expect(env['GATEFORGE_RUN_ID']).toBe(stubRunId);
      const manifest = JSON.parse(
        readFileSync(join(stateDir, 'manifest.json'), 'utf8'),
      ) as { runId?: string };
      expect(manifest.runId).toBe(stubRunId);
      // The default state dir was not created.
      expect(existsSync(repo.path('.gateforge/test-gates'))).toBe(false);
      stub.close();
    });
  });

  it('exposes real fingerprints the suite can verify against', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      const { code } = await runCli(repo, ['test-gates', '--format', 'json']);
      expect(code).toBe(1);
      const document = JSON.parse(
        readFileSync(repo.path('.gateforge/test-gates/obligations.json'), 'utf8'),
      ) as {
        obligations: Array<{ id: string; resourceId: string; lifecycle: unknown; fingerprint: string }>;
      };
      for (const entry of document.obligations) {
        // The stored fingerprint equals pin #2 computed from the document.
        const recomputed = fingerprint({
          resourceId: entry.resourceId,
          contract: entry.id.slice(entry.id.indexOf(':') + 1),
          policyId: 'user-facing-crud',
          lifecycle: entry.lifecycle as {
            create: boolean;
            read: boolean;
            update: boolean;
            delete: boolean;
          },
        });
        expect(entry.fingerprint).toBe(recomputed);
      }
    });
  });
});