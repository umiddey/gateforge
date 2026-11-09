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
import { BEHAVIOR_CASE_DOMAIN, GateReceiptSchema, RunManifestSchema, loadConfig, sha256Canonical, withTempRepo, fingerprint, type TempRepo } from '@gate-forge/core';
import { PLUGIN_SOURCE, configYml, fixtureFingerprint, installFixture, runCli, stubPlaywrightFiles } from './helpers.js';
import { trustedPolicyDigestForConfig } from '../src/execution.js';
import { mintCompleteRunReceipt } from './gate-receipts.js';
import { behaviorCaseAssignments } from '../src/commands/test-gates.js';
import type { BehaviorCatalog, TestCatalog, TestMap } from '@gate-forge/core';

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
      expect(obligations.obligations.map((o) => o.id).toSorted()).toEqual([
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
        ...stubPlaywrightFiles([
          "const { writeFileSync } = require('node:fs');",
          'if (process.argv.includes("--list")) {',
          "  const title = process.env.GATEFORGE_RUN_TOKEN ? 'wired registration' : 'scrubbed registration';",
          "  process.stdout.write(JSON.stringify({ config: { rootDir: process.cwd() }, suites: [{ file: 'e2e/registration.spec.mjs', specs: [{ id: 'registration', title, line: 3, column: 0, tests: [{ projectId: 'chromium', projectName: 'chromium', expectedStatus: 'passed', annotations: [] }] }] }] }));",
          '} else {',
          `  writeFileSync(${JSON.stringify(marker)}, 'runner invoked');`,
          '}',
          '',
        ].join('\n')),
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


/**
 * The fixture plugin plus one detector finding — a blocking ENTRY, not an
 * obligation, so `gateforge adopt` records it in the baseline while the RAW
 * policy blocking list stays non-empty for the rest of the repository's life.
 */
const ADOPTED_FINDING_PLUGIN_SOURCE = PLUGIN_SOURCE.replace(
  'return { resources, unresolved: [], findings: [], classificationSignals, scannedPaths };',
  'return { resources, unresolved: [], findings: [{ code: "PARTIAL_DISCOVERY", detail: "fixture finding: one route unverified", locations: [{ file: "src/logs.txt", line: 1, col: 0 }] }], classificationSignals, scannedPaths };',
);

/**
 * The same plugin with the finding's DETAIL derived from the bytes of the
 * inert file a carry-forward run changes, so that edit mints a NEW blocking
 * entry no adoption receipt ever forgave.
 */
const NEW_FINDING_PLUGIN_SOURCE = PLUGIN_SOURCE.replace(
  'const resources = [];',
  "const resources = [];\n    let logConstant = '';",
)
  .replace(
    'scannedPaths.push(rel);',
    "scannedPaths.push(rel);\n      if (rel === 'src/logs.txt') logConstant = text.trim();",
  )
  .replace(
    'return { resources, unresolved: [], findings: [], classificationSignals, scannedPaths };',
    "return { resources, unresolved: [], findings: [{ code: \"PARTIAL_DISCOVERY\", detail: \"fixture finding: the log constant reads \" + logConstant, locations: [{ file: \"src/logs.txt\", line: 1, col: 0 }] }], classificationSignals, scannedPaths };",
  );

/**
 * A gated repository that ADOPTED its existing debt (one detector finding),
 * with a sealed parent receipt over the bytes the adoption produced.
 *
 * Returns the base sha and the owner pin of those bytes.
 */
async function adoptedCarryForwardParent(
  repo: TempRepo,
  pluginSource: string,
  verifierKey: string,
): Promise<{ baseSha: string | null; approvedPolicyDigest: string }> {
  installFixture(repo);
  repo.writeFiles({
    '.gateforge.yml': `${configYml()}\nenforcement:\n  receiptStage: pre-push\n`,
    '.gitignore': '.gateforge/test-gates/\n',
    'src/logs.txt': '# base log constant\n',
    'plugin.mjs': pluginSource,
  });
  repo.commitFiles({}, 'existing product code, no gate yet');
  const adopted = await runCli(repo, ['adopt']);
  expect(adopted.code, `${adopted.stdout}\n${adopted.stderr}`).toBe(0);
  // Adoption WIRES the gate: committed, so the change the carry-forward run
  // evaluates is the inert one alone and every changed file was scanned.
  repo.commitFiles({}, 'adopt the gate');
  const baseSha = repo.headSha();
  // Taken AFTER adoption: the baseline it wrote is a trusted policy input.
  const approvedPolicyDigest = trustedPolicyDigestForConfig(
    repo.root,
    loadConfig(repo.path('.gateforge.yml')),
  );
  await mintCompleteRunReceipt(repo, {
    verifierKey,
    parentSha: baseSha,
    approvedPolicyDigest,
    verdictSummary: { total: 2, satisfied: 0, waived: 2, blocking: 0 },
  });
  return { baseSha, approvedPolicyDigest };
}

/** The empty slice a carry-forward serves: one inert committed change. */
const INERT_LOG_UPDATE = '# updated log constant\n';

describe('carry-forward over an adopted baseline', () => {
  it('carries forward when every policy blocking entry was adopted', async () => {
    await withTempRepo({}, async (repo) => {
      const verifierKey = 'carry-forward-adopted-debt-key';
      const { baseSha, approvedPolicyDigest } = await adoptedCarryForwardParent(
        repo,
        ADOPTED_FINDING_PLUGIN_SOURCE,
        verifierKey,
      );
      repo.commitFiles({ 'src/logs.txt': INERT_LOG_UPDATE }, 'inert log update');

      const result = await runCli(
        repo,
        ['test-gates', '--changed', '--scope', 'changed', '--format', 'json'],
        {
          GATEFORGE_WITNESS_VERIFIER_KEY: verifierKey,
          GATEFORGE_APPROVED_POLICY_DIGEST: approvedPolicyDigest,
          CI_MERGE_REQUEST_DIFF_BASE_SHA: baseSha ?? '',
        },
      );
      const output = `${result.stdout}\n${result.stderr}`;
      expect(result.code, output).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        carriedForward: true,
        carriedFrom: baseSha,
        testsPerformedThisInvocation: 0,
      });
    });
  }, 180_000);

  it('refuses to carry forward a policy blocking entry adoption never forgave', async () => {
    await withTempRepo({}, async (repo) => {
      const verifierKey = 'carry-forward-new-debt-key';
      const { baseSha, approvedPolicyDigest } = await adoptedCarryForwardParent(
        repo,
        NEW_FINDING_PLUGIN_SOURCE,
        verifierKey,
      );
      // The same inert edit, but the finding's DETAIL moves with it: the
      // entry is NEW debt, which no adoption receipt forgives.
      repo.commitFiles({ 'src/logs.txt': INERT_LOG_UPDATE }, 'inert log update');

      const result = await runCli(
        repo,
        ['test-gates', '--changed', '--scope', 'changed', '--format', 'json'],
        {
          GATEFORGE_WITNESS_VERIFIER_KEY: verifierKey,
          GATEFORGE_APPROVED_POLICY_DIGEST: approvedPolicyDigest,
          CI_MERGE_REQUEST_DIFF_BASE_SHA: baseSha ?? '',
        },
      );
      const output = `${result.stdout}\n${result.stderr}`;
      expect(result.code, output).not.toBe(0);
      expect(result.stdout).not.toContain('"carriedForward":true');
      // The new finding is reported as debt, exactly as any un-adopted entry.
      expect(result.stdout, output).toContain('PARTIAL_DISCOVERY');
      expect(existsSync(repo.path('.gateforge/test-gates/receipt.json'))).toBe(false);
    });
  }, 180_000);
});

describe('behaviorCaseAssignments binds canonical case ids only', () => {
  const catalog = { entries: [{ logicalKey: 'k1', parameterIdentity: 'runner-id-1' }] } as unknown as TestCatalog;
  const behaviorCatalog = {
    cases: [{ caseId: 'CANON-1', definition: { id: 'alias-1' }, obligationIds: ['OBL-1'] }],
  } as unknown as BehaviorCatalog;

  it('sends the canonical id for a definition.id alias and drops a stale id', () => {
    const sidecar = {
      tests: [{ key: 'k1', claims: ['OBL-1'], caseIds: ['alias-1', 'gone-id'] }],
    } as unknown as TestMap;
    expect(behaviorCaseAssignments(catalog, sidecar, behaviorCatalog)).toEqual({ 'runner-id-1': ['CANON-1'] });
  });

  it('binds nothing when every declared id is stale or outside the claims', () => {
    const sidecar = {
      tests: [{ key: 'k1', claims: ['OBL-2'], caseIds: ['alias-1', 'gone-id'] }],
    } as unknown as TestMap;
    expect(behaviorCaseAssignments(catalog, sidecar, behaviorCatalog)).toEqual({});
  });
});

/**
 * Route source: an in-process plugin string written into the temp repo, the
 * same precedent as `behavior draft`'s hand-built `http.endpoint` detector.
 * The shared fixture plugin emits only `raw.*` resources, so it cannot
 * satisfy `registerWitnessBehaviorCatalog`'s non-empty route requirement.
 * No new file: the plugin, policy, sidecar, and runner stub are fixture
 * text this test writes, like every other case in this file.
 *
 * The behavior-catalog route records the body, then applies the witness's
 * canonical-id check (server.ts: names unknown case unless the assignment
 * id is a compiled `caseId`). Every other route returns the existing stub
 * body `{records: []}`, plus the fields the supervised path reads before
 * it writes a report (`enumerationDigest`, `tests`, `sessionId`). Without
 * those fields the run throws and assertion (1) cannot be observed.
 */
describe('stale caseId and alias survive a supervised test-gates run', () => {
  const resourceId = 'tenant.http-get-rooms';
  const alias = 'alias-1';
  const stale = 'gone-id';
  const obligationId = `${resourceId}:http:request-observed`;
  const specFile = 'e2e/alias.spec.mjs';
  const title = 'proves the alias';
  const logicalKey = `playwright:chromium:${specFile}:${title}`;
  const canonicalCaseId = sha256Canonical({ domain: BEHAVIOR_CASE_DOMAIN, resourceId, id: alias });
  const loopback = [127, 0, 0, 1].join('.');

  it('sends the canonical case id, drops the stale one, and still writes the report', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      repo.writeFiles({
        '.gateforge.yml': configYml().replace(
          /^policies:/m,
          'behaviorPolicy: .gateforge/behavior.yml\npolicies:',
        ),
        'plugin.mjs': [
          "const DETECTOR = { id: 'fixture.plugin', version: '1.0.0' };",
          'export default {',
          '  discover(paths) {',
          '    return {',
          '      resources: [{',
          '        schemaVersion: 1,',
          `        id: ${JSON.stringify(resourceId)},`,
          "        kind: 'http.endpoint',",
          "        source: 'src/rooms.txt',",
          "        location: { file: 'src/rooms.txt', line: 1, col: 0 },",
          '        detectorVersion: DETECTOR.version,',
          '        attributes: {',
          "          plane: 'tenant',",
          "          resourceName: 'http-get-rooms',",
          "          method: 'GET',",
          "          canonicalPath: '/api/v1/rooms',",
          "          capabilities: ['crud-read'],",
          '        },',
          '      }],',
          '      unresolved: [],',
          '      findings: [],',
          '      classificationSignals: [{',
          '        schemaVersion: 1,',
          "        target: { resourceName: 'http-get-rooms' },",
          "        dimension: 'plane',",
          "        assertion: 'tenant',",
          "        basis: 'code-positive',",
          "        source: 'fixture.plugin',",
          "        location: { file: 'src/rooms.txt', line: 1, col: 0 },",
          '        detector: DETECTOR,',
          '      }, {',
          '        schemaVersion: 1,',
          "        target: { resourceName: 'http-get-rooms' },",
          "        dimension: 'identity',",
          "        assertion: ['method', 'path'],",
          "        basis: 'code-positive',",
          "        source: 'fixture.plugin',",
          "        location: { file: 'src/rooms.txt', line: 1, col: 0 },",
          '        detector: DETECTOR,',
          '      }],',
          '      scannedPaths: paths,',
          '    };',
          '  },',
          '};',
          '',
        ].join('\n'),
        'src/rooms.txt': 'rooms\n',
        '.gateforge/policies.yml':
          'schemaVersion: 1\npolicies:\n  - id: endpoint-observed\n    when:\n      kind: http.endpoint\n    require: [http:request-observed]\n',
        '.gateforge/behavior.yml': [
          'schemaVersion: 1',
          'endpoints:',
          `  - resourceId: ${resourceId}`,
          '    effects: []',
          '    cases:',
          `      - id: ${alias}`,
          '        contract: "http:request-observed"',
          '        channel: engine-http',
          '        fixture: operational',
          '        actor: anonymous',
          '        action:',
          '          kind: request',
          '          method: GET',
          '          pathTemplate: /api/v1/rooms',
          '          path: {}',
          '          query: {}',
          '          body:',
          '            encoding: json',
          '            fields: {}',
          '          credentialVariant: valid',
          '        expect:',
          '          statuses: [200]',
          '          response: []',
          '          state: []',
          'resources: []',
          '',
        ].join('\n'),
        '.gateforge/test-map.yml': [
          'schemaVersion: 1',
          'tests:',
          `  - key: ${JSON.stringify(logicalKey)}`,
          '    selector:',
          '      runner: playwright',
          '      project: chromium',
          `      file: ${specFile}`,
          '      titlePath:',
          `        - ${title}`,
          `    claims: [${JSON.stringify(obligationId)}]`,
          `    caseIds: [${alias}, ${stale}]`,
          '    reason: the live alias plus one id the catalog no longer has',
          '',
        ].join('\n'),
        'playwright.config.mjs': "export default { testDir: 'e2e', projects: [{ name: 'chromium' }] };\n",
        [specFile]: `import { test } from 'playwright/test.js';\ntest(${JSON.stringify(title)}, () => {});\n`,
        ...stubPlaywrightFiles([
          "const { readFileSync, writeFileSync, mkdirSync } = require('node:fs');",
          'const argv = process.argv.slice(2);',
          'if (argv.includes("--list")) {',
          '  const document = {',
          '    config: { rootDir: process.cwd(), projects: [{ name: "chromium" }] },',
          '    suites: [{',
          `      file: ${JSON.stringify(specFile)},`,
          '      specs: [{',
          `        id: ${JSON.stringify(specFile)},`,
          `        title: ${JSON.stringify(title)},`,
          '        line: 2,',
          '        column: 0,',
          '        tests: [{ projectId: "chromium", projectName: "chromium", expectedStatus: "passed", annotations: [] }],',
          '      }],',
          '    }],',
          '  };',
          '  const text = JSON.stringify(document);',
          '  if (process.env.PLAYWRIGHT_JSON_OUTPUT_FILE) writeFileSync(process.env.PLAYWRIGHT_JSON_OUTPUT_FILE, text);',
          '  process.stdout.write(text);',
          '} else {',
          "  const config = readFileSync(argv[argv.indexOf('--config') + 1], 'utf8');",
          '  const reporter = /"stateDir":"([^"]+)","runId":"([^"]+)","outcomesPath":"([^"]+)"/.exec(config);',
          '  if (reporter) {',
          "    const spool = reporter[1] + '/spool/' + reporter[2] + '/events.jsonl';",
          "    mkdirSync(spool.replace(/\\/[^/]+$/, ''), { recursive: true });",
          '    const events = [',
          `      { kind: 'testBegin', testId: ${JSON.stringify(specFile)}, workerIndex: 0, file: ${JSON.stringify(specFile)}, titlePath: [${JSON.stringify(title)}], project: 'chromium' },`,
          `      { kind: 'testEnd', testId: ${JSON.stringify(specFile)}, workerIndex: 0, file: ${JSON.stringify(specFile)}, titlePath: [${JSON.stringify(title)}], project: 'chromium', outcome: 'passed', attempt: 1 },`,
          '    ];',
          "    writeFileSync(spool, events.map((event) => JSON.stringify(event)).join('\\n') + '\\n');",
          '    writeFileSync(reporter[3], JSON.stringify({',
          '      schemaVersion: 1,',
          "      runStatus: 'passed',",
          '      runnerErrors: [],',
          '      shard: null,',
          '      outcomes: [{',
          `        testId: ${JSON.stringify(specFile)},`,
          `        file: ${JSON.stringify(specFile)},`,
          `        titlePath: [${JSON.stringify(title)}],`,
          "        project: 'chromium',",
          "        status: 'passed',",
          '        attempt: 1,',
          '        expectedFailure: false,',
          '      }],',
          '    }));',
          '  }',
          '}',
          '',
        ].join('\n')),
      });
      repo.stage();

      const catalogPosts: string[] = [];
      const stub = createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on('data', (chunk: Buffer) => chunks.push(chunk));
        req.on('end', () => {
          const path = (req.url ?? '').split('?')[0] ?? '';
          const raw = Buffer.concat(chunks).toString('utf8');
          if (req.method === 'POST' && path === '/runs/behavior-catalog') {
            catalogPosts.push(raw);
            const posted = JSON.parse(raw) as {
              catalog?: { cases?: Array<{ caseId?: string }> };
              assignments?: Record<string, string[]>;
            };
            const known = new Set((posted.catalog?.cases ?? []).map((item) => item.caseId));
            for (const [testId, ids] of Object.entries(posted.assignments ?? {})) {
              for (const id of ids) {
                if (!known.has(id)) {
                  res.writeHead(400, { 'content-type': 'application/json' });
                  res.end(JSON.stringify({
                    error: `behavior-catalog assignment for test '${testId}' names unknown case '${id}' — cases resolve by canonical case id only`,
                  }));
                  return;
                }
              }
            }
          }
          res.writeHead(200, { 'content-type': 'application/json' });
          if (path === '/health') {
            res.end(JSON.stringify({ ok: true, runId: '22222222-3333-4444-8555-666666666666' }));
            return;
          }
          if (path === '/runs/expected-set') {
            res.end(JSON.stringify({ bound: true, count: 1, enumerationDigest: 'a'.repeat(64), records: [] }));
            return;
          }
          if (path === '/runs/execution-trace') {
            res.end(JSON.stringify({ tests: [], records: [] }));
            return;
          }
          if (path === '/sessions/open') {
            res.end(JSON.stringify({ sessionId: 'sess-1', openedTick: 1, records: [] }));
            return;
          }
          res.end(JSON.stringify({ records: [] }));
        });
      });
      await new Promise<void>((resolve) => {
        stub.listen(0, loopback, () => resolve());
      });
      const address = stub.address();
      if (address === null || typeof address === 'string') throw new Error('stub witness did not bind a port');
      const port = address.port;
      const out = 'selected-state';
      try {
        const result = await runCli(
          repo,
          [
            'test-gates',
            '--changed',
            '--scope',
            'changed',
            '--result-only',
            '--format',
            'json',
            '--witness-url',
            `http://${loopback}:${String(port)}`,
            '--run-token',
            'stub-token',
            '--out',
            out,
          ],
          { GATEFORGE_WITNESS_VERIFIER_KEY: 'stale-case-verifier-key' },
        );
        const output = `${result.stdout}\n${result.stderr}`;
        expect(output, output).not.toContain('names unknown case');
        expect(existsSync(repo.path(`${out}/report.json`)), output).toBe(true);
        const report = JSON.parse(readFileSync(repo.path(`${out}/report.json`), 'utf8')) as {
          blocking?: Array<{ cause?: string | null }>;
        };
        expect(report.blocking?.some((entry) => entry.cause === 'TEST_MAPPING_STALE'), output).toBe(true);
        expect(catalogPosts, output).toHaveLength(1);
        const posted = JSON.parse(catalogPosts[0] ?? '') as {
          catalog: { cases: Array<{ caseId: string; definition: { id: string } }> };
          assignments: Record<string, string[]>;
        };
        const assigned = Object.values(posted.assignments).flat();
        expect(assigned, JSON.stringify(posted.assignments)).toEqual([canonicalCaseId]);
        expect(JSON.stringify(posted), JSON.stringify(posted.assignments)).not.toContain(stale);
        expect(
          posted.catalog.cases.some((item) => item.caseId === canonicalCaseId && item.definition.id === alias),
        ).toBe(true);
      } finally {
        await new Promise<void>((resolve, reject) => {
          stub.close((error) => (error ? reject(error) : resolve()));
        });
      }
    });
  }, 120_000);
});