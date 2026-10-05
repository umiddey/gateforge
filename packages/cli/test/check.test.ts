/**
 * `gateforge check`: the full gate — red/green paths, waiver-driven
 * passes, GF-23 claimed-records degradation at the CLI boundary,
 * config-error exit 2, `--changed` scoping, and GF-09 provider parity.
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { attestationMac, ledgerMac, loadConfig, recordIdOf, withTempRepo } from '@gate-forge/core';
import {
  CLASSIFICATION_POLICY_YML,
  classificationsYml,
  configYml,
  currentInputDigest,
  fixtureFingerprint,
  installFixture,
  OBLIGATION_ACCOUNTS,
  OBLIGATION_ORDERS,
  PLUGIN_SOURCE,
  pythonPluginBlock,
  referenceDetectorPath,
  runCli,
  writeV2Manifest,
  type CliResult,
} from './helpers.js';
import { trustedPolicyDigestForConfig } from '../src/execution.js';
import { mintCompleteRunReceipt } from './gate-receipts.js';

/** A valid, unexpired waiver for one fixture obligation. */
function waiverJson(resourceId: string): string {
  return JSON.stringify({
    schemaVersion: 1,
    owner: 'team-' + resourceId.split('.')[1],
    justificationUrl: 'https://example.invalid/justification',
    approver: 'approver@example.invalid',
    scope: { kind: 'exact', resourceId, fingerprint: fixtureFingerprint(resourceId) },
    expiresAt: '2027-01-01T00:00:00.000Z',
  });
}

/** Parses the json-format check report. */
function parseReport(report: string): {
  summary: { blocking: number };
  verdicts: Array<{
    obligationId: string;
    contract: string;
    verdict: string;
    cause?: string | null;
    reason: string | null;
    recordIds: string[];
    policyId: string;
    fingerprint: string;
    inScopeBecause?: string[];
  }>;
  blocking: Array<{ kind: string; detail?: string }>;
  run: { provider: string };
  engine: { version: string; source: string; unpublished: boolean };
} {
  return JSON.parse(report);
}

/** Narrowing guard for closure-assigned run results (TS cannot narrow them). */
function resultOrThrow(value: CliResult | null, label: string): CliResult {
  if (value === null) {
    throw new Error(`${label} parity run did not execute`);
  }
  return value;
}

describe('gateforge check', () => {
  it('red path: obligations without evidence are missing → exit 1', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      const { code, stdout } = await runCli(repo, ['check', '--format', 'json']);
      expect(code).toBe(1);
      const report = parseReport(stdout);
      expect(report.summary.blocking).toBe(2);
      expect(report.verdicts.map((v) => v.obligationId).sort()).toEqual([
        OBLIGATION_ACCOUNTS,
        OBLIGATION_ORDERS,
      ]);
      expect(report.verdicts.every((v) => v.verdict === 'missing')).toBe(true);
      expect(report.run.provider).toBe('all-files');
    });
  });
  it('checks the requested commit tree instead of later worktree bytes', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      repo.commitFiles({}, 'candidate base');
      const candidateSha = repo.headSha();
      expect(candidateSha).not.toBeNull();
      const candidateTree = repo.git(['rev-parse', `${candidateSha}^{tree}`]).stdout.trim();
      repo.writeFiles({ 'src/accounts.txt': 'changed after candidate\n' });
      const result = await runCli(repo, ['check', '--candidate-commit', candidateSha ?? '', '--format', 'json']);
      expect(result.code).toBe(1);
      const report = JSON.parse(result.stdout) as { diagnosticContext: { candidateTreeId: string | null } };
      expect(report.diagnosticContext.candidateTreeId).toBe(candidateTree);
    });
  });

  it('verifies a matching externally pinned receipt before loading detector code', async () => {
    const markerDir = mkdtempSync(join(tmpdir(), 'gateforge-fast-path-'));
    try {
      await withTempRepo({}, async (repo) => {
        installFixture(repo);
        const marker = join(markerDir, 'detector-ran');
        const detectorRelativePath = '.gateforge/fast-path-detector.py';
        const detectorSource = [
          'from pathlib import Path',
          'import runpy',
          `Path(${JSON.stringify(marker)}).write_text('detector ran')`,
          `runpy.run_path(${JSON.stringify(referenceDetectorPath())}, run_name='__main__')`,
        ].join('\n');
        const subprocessPlugin = pythonPluginBlock().replace(
          JSON.stringify(referenceDetectorPath()),
          JSON.stringify(detectorRelativePath),
        );
        repo.writeFiles({
          '.gateforge.yml': `${configYml({
            include: "['fixtures/**/*.gfx']",
            plugins: subprocessPlugin,
          })}\nenforcement:\n  receiptStage: pre-push\n`,
          '.gitignore': '.gateforge/test-gates/\n',
          'fixtures/resource.gfx': 'unresolved fixture resource\n',
          [detectorRelativePath]: detectorSource,
        });
        repo.stage();
        repo.commit('sealed candidate');
        const candidateSha = repo.headSha();
        expect(candidateSha).not.toBeNull();
        const config = loadConfig(repo.path('.gateforge.yml'));
        const approvedDigest = trustedPolicyDigestForConfig(repo.root, config);
        const parentResult = repo.git(['rev-parse', 'HEAD^'], { allowFailure: true });
        await mintCompleteRunReceipt(repo, {
          verifierKey: 'fast-path-key',
          parentSha: parentResult.status === 0 ? parentResult.stdout.trim() : null,
          approvedPolicyDigest: approvedDigest,
        });
        rmSync(marker, { force: true });

        const startedAt = performance.now();
        const result = await runCli(
          repo,
          ['check', '--candidate-commit', candidateSha ?? '', '--require-e2e', '--format', 'json'],
          {
            GATEFORGE_WITNESS_VERIFIER_KEY: 'fast-path-key',
            GATEFORGE_APPROVED_POLICY_DIGEST: approvedDigest,
          },
        );
        const elapsedMs = performance.now() - startedAt;
        expect(result.code, result.stdout).toBe(0);
        expect((JSON.parse(result.stdout) as { fastPath?: boolean }).fastPath).toBe(true);
        expect(elapsedMs).toBeLessThan(2_000);
        expect(existsSync(marker)).toBe(false);

        rmSync(marker, { force: true });
        const wrongKey = await runCli(
          repo,
          ['check', '--candidate-commit', candidateSha ?? '', '--require-e2e', '--format', 'json'],
          {
            GATEFORGE_WITNESS_VERIFIER_KEY: 'different-fast-path-key',
            GATEFORGE_APPROVED_POLICY_DIGEST: approvedDigest,
          },
        );
        expect(wrongKey.code).not.toBe(0);
        expect((JSON.parse(wrongKey.stdout) as { fastPath?: boolean }).fastPath).not.toBe(true);
        expect(existsSync(marker)).toBe(true);
        rmSync(marker, { force: true });
        const wrongPolicyDigest = 'f'.repeat(64);
        expect(wrongPolicyDigest).not.toBe(approvedDigest);
        const wrongPin = await runCli(
          repo,
          ['check', '--candidate-commit', candidateSha ?? '', '--require-e2e', '--format', 'json'],
          {
            GATEFORGE_WITNESS_VERIFIER_KEY: 'fast-path-key',
            GATEFORGE_APPROVED_POLICY_DIGEST: wrongPolicyDigest,
          },
        );
        expect(wrongPin.code).not.toBe(0);
        expect(wrongPin.stdout).not.toContain('"fastPath":true');
        expect(existsSync(marker)).toBe(false);
      });
    } finally {
      rmSync(markerDir, { recursive: true, force: true });
    }
  }, 120_000);

  it('fails fast on an authenticated receipt for a different candidate tree', async () => {
    const markerDir = mkdtempSync(join(tmpdir(), 'gateforge-stale-fast-path-'));
    try {
      await withTempRepo({}, async (repo) => {
        installFixture(repo);
        const marker = join(markerDir, 'detector-ran');
        repo.writeFiles({
          '.gateforge.yml': `${configYml()}\nenforcement:\n  receiptStage: pre-push\n`,
          '.gitignore': '.gateforge/test-gates/\n',
          '.gateforge/waivers/accounts.json': waiverJson('tenant.accounts'),
          '.gateforge/waivers/orders.json': waiverJson('tenant.orders'),
          'plugin.mjs':
            `${PLUGIN_SOURCE}\nimport { writeFileSync } from 'node:fs';\n` +
            `writeFileSync(${JSON.stringify(marker)}, 'detector ran');\n`,
        });
        repo.stage();
        repo.commit('candidate tree');
        const candidateSha = repo.headSha();
        expect(candidateSha).not.toBeNull();
        const parentResult = repo.git(['rev-parse', 'HEAD^'], { allowFailure: true });
        repo.writeFiles({ 'src/accounts.txt': 'receipt was sealed against changed bytes\n' });
        const config = loadConfig(repo.path('.gateforge.yml'));
        const approvedDigest = trustedPolicyDigestForConfig(repo.root, config);
        await mintCompleteRunReceipt(repo, {
          verifierKey: 'stale-fast-path-key',
          parentSha: parentResult.status === 0 ? parentResult.stdout.trim() : null,
          approvedPolicyDigest: approvedDigest,
        });
        rmSync(marker, { force: true });
        const startedAt = performance.now();

        const result = await runCli(
          repo,
          ['check', '--candidate-commit', candidateSha ?? '', '--require-e2e'],
          {
            GATEFORGE_WITNESS_VERIFIER_KEY: 'stale-fast-path-key',
            GATEFORGE_APPROVED_POLICY_DIGEST: approvedDigest,
          },
        );
        expect(result.code, result.stdout).toBe(1);
        expect(performance.now() - startedAt).toBeLessThan(2_000);
        expect(result.stdout).toContain('EVIDENCE_STALE');
        expect(result.stdout).toContain('src/accounts.txt');
        expect(existsSync(marker), result.stdout).toBe(false);
      });
    } finally {
      rmSync(markerDir, { recursive: true, force: true });
    }
  });

  it('verifies a matching receipt via the fast path when approved docs exclusions exist', async () => {
    const markerDir = mkdtempSync(join(tmpdir(), 'gateforge-docs-fast-path-'));
    try {
      await withTempRepo({}, async (repo) => {
        installFixture(repo);
        const marker = join(markerDir, 'detector-ran');
        repo.writeFiles({
          '.gateforge.yml': `${configYml({ evidence: { docs: ['docs'] } })}\nenforcement:\n  receiptStage: pre-push\n`,
          '.gitignore': '.gateforge/test-gates/\n',
          'docs/architecture.md': '# Architecture notes\n',
          'plugin.mjs':
            `${PLUGIN_SOURCE}\nimport { writeFileSync } from 'node:fs';\n` +
            `writeFileSync(${JSON.stringify(marker)}, 'detector ran');\n`,
        });
        repo.stage();
        repo.commit('sealed candidate with docs exclusion');
        const candidateSha = repo.headSha();
        expect(candidateSha).not.toBeNull();
        const parentResult = repo.git(['rev-parse', 'HEAD^'], { allowFailure: true });
        const config = loadConfig(repo.path('.gateforge.yml'));
        const approvedDigest = trustedPolicyDigestForConfig(repo.root, config);
        await mintCompleteRunReceipt(repo, {
          verifierKey: 'docs-fast-path-key',
          parentSha: parentResult.status === 0 ? parentResult.stdout.trim() : null,
          approvedPolicyDigest: approvedDigest,
          docsExclusions: ['docs'],
        });
        rmSync(marker, { force: true });
        const startedAt = performance.now();
        const result = await runCli(
          repo,
          ['check', '--candidate-commit', candidateSha ?? '', '--require-e2e', '--format', 'json'],
          {
            GATEFORGE_WITNESS_VERIFIER_KEY: 'docs-fast-path-key',
            GATEFORGE_APPROVED_POLICY_DIGEST: approvedDigest,
            CI: undefined,
          },
        );
        const elapsedMs = performance.now() - startedAt;
        expect(result.code, result.stdout).toBe(0);
        expect((JSON.parse(result.stdout) as { fastPath?: boolean }).fastPath).toBe(true);
        expect(elapsedMs).toBeLessThan(2_000);
        expect(existsSync(marker), result.stdout).toBe(false);
      });
    } finally {
      rmSync(markerDir, { recursive: true, force: true });
    }
  }, 120_000);

  it('still accepts a docs-only edit after sealing when the exclusion is approved', async () => {
    const markerDir = mkdtempSync(join(tmpdir(), 'gateforge-docs-edit-fast-path-'));
    try {
      await withTempRepo({}, async (repo) => {
        installFixture(repo);
        const marker = join(markerDir, 'detector-ran');
        repo.writeFiles({
          '.gateforge.yml': `${configYml({ evidence: { docs: ['docs'] } })}\nenforcement:\n  receiptStage: pre-push\n`,
          '.gitignore': '.gateforge/test-gates/\n',
          'docs/architecture.md': '# Architecture notes\n',
          'plugin.mjs':
            `${PLUGIN_SOURCE}\nimport { writeFileSync } from 'node:fs';\n` +
            `writeFileSync(${JSON.stringify(marker)}, 'detector ran');\n`,
        });
        repo.stage();
        repo.commit('sealed base');
        const sealedSha = repo.headSha();
        expect(sealedSha).not.toBeNull();
        const sealedParent = repo.git(['rev-parse', 'HEAD^'], { allowFailure: true });
        const config = loadConfig(repo.path('.gateforge.yml'));
        const approvedDigest = trustedPolicyDigestForConfig(repo.root, config);
        await mintCompleteRunReceipt(repo, {
          verifierKey: 'docs-edit-key',
          parentSha: sealedParent.status === 0 ? sealedParent.stdout.trim() : null,
          approvedPolicyDigest: approvedDigest,
          docsExclusions: ['docs'],
        });
        repo.writeFiles({ 'docs/new-note.md': '# A later docs-only edit\n' });
        repo.stage();
        const candidateSha = repo.commit('docs only change');
        rmSync(marker, { force: true });
        const startedAt = performance.now();
        const result = await runCli(
          repo,
          ['check', '--candidate-commit', candidateSha, '--require-e2e', '--format', 'json'],
          {
            GATEFORGE_WITNESS_VERIFIER_KEY: 'docs-edit-key',
            GATEFORGE_APPROVED_POLICY_DIGEST: approvedDigest,
            CI: undefined,
          },
        );
        expect(result.code, result.stdout).toBe(0);
        expect((JSON.parse(result.stdout) as { fastPath?: boolean }).fastPath).toBe(true);
        expect(performance.now() - startedAt).toBeLessThan(2_000);
        expect(existsSync(marker), result.stdout).toBe(false);
      });
    } finally {
      rmSync(markerDir, { recursive: true, force: true });
    }
  }, 120_000);

  it('fails fast naming the file for a code edit when a docs exclusion is approved', async () => {
    const markerDir = mkdtempSync(join(tmpdir(), 'gateforge-code-edit-fast-path-'));
    try {
      await withTempRepo({}, async (repo) => {
        installFixture(repo);
        const marker = join(markerDir, 'detector-ran');
        repo.writeFiles({
          '.gateforge.yml': `${configYml({ evidence: { docs: ['docs'] } })}\nenforcement:\n  receiptStage: pre-push\n`,
          '.gitignore': '.gateforge/test-gates/\n',
          'docs/architecture.md': '# Architecture notes\n',
          'plugin.mjs':
            `${PLUGIN_SOURCE}\nimport { writeFileSync } from 'node:fs';\n` +
            `writeFileSync(${JSON.stringify(marker)}, 'detector ran');\n`,
        });
        repo.stage();
        repo.commit('sealed base');
        const sealedSha = repo.headSha();
        expect(sealedSha).not.toBeNull();
        const sealedParent = repo.git(['rev-parse', 'HEAD^'], { allowFailure: true });
        const config = loadConfig(repo.path('.gateforge.yml'));
        const approvedDigest = trustedPolicyDigestForConfig(repo.root, config);
        await mintCompleteRunReceipt(repo, {
          verifierKey: 'code-edit-key',
          parentSha: sealedParent.status === 0 ? sealedParent.stdout.trim() : null,
          approvedPolicyDigest: approvedDigest,
          docsExclusions: ['docs'],
        });
        repo.writeFiles({ 'src/accounts.txt': 'accounts changed after sealing\n' });
        repo.stage();
        const candidateSha = repo.commit('code change after sealing');
        rmSync(marker, { force: true });
        const startedAt = performance.now();
        const result = await runCli(
          repo,
          ['check', '--candidate-commit', candidateSha, '--require-e2e'],
          {
            GATEFORGE_WITNESS_VERIFIER_KEY: 'code-edit-key',
            GATEFORGE_APPROVED_POLICY_DIGEST: approvedDigest,
            CI: undefined,
          },
        );
        expect(result.code, result.stdout).toBe(1);
        expect(result.stdout).toContain('EVIDENCE_STALE');
        expect(result.stdout).toContain('src/accounts.txt');
        expect(performance.now() - startedAt).toBeLessThan(2_000);
        expect(existsSync(marker), result.stdout).toBe(false);
      });
    } finally {
      rmSync(markerDir, { recursive: true, force: true });
    }
  }, 120_000);

  it('warns when a server route is reached only by statically matched mocks', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo, {
        include: "['src/**/*.txt', 'src/**/*.js', 'tests/**/*.spec.js']",
        plugins:
          "  - id: fixture.plugin\n    version: '1.0.0'\n    transport: in-process\n    module: ./plugin.mjs\n" +
          "  - id: gateforge.pack-http\n    version: '0.1.0'\n    transport: in-process\n    module: '@gate-forge/pack-http'",
      });
      repo.writeFiles({
        'src/server.js':
          "import express from 'express';\nconst app = express();\napp.get('/api/accounts', (_req, res) => res.json([]));\n",
        'tests/mock.spec.js': [
          "import { test } from '@playwright/test';",
          "test('mocks the account route', async ({ page }) => {",
          "  await page.route('**/api/accounts', (route) => route.fulfill({ status: 200 }));",
          "  await page.goto('http://app.test');",
          '});',
          '',
        ].join('\n'),
        // 0.11.0: the plane and endpoint answers are SECTIONS of the one
        // owner-answers document, not `.gateforge/planes.json` /
        // `.gateforge/endpoints.json`.
        '.gateforge/classification-policy.yml': `${CLASSIFICATION_POLICY_YML}planes:
  rules:
    - match: src/server.js
      plane: tenant
      reason: The fixture route is tenant-scoped.
endpoints:
  rules:
    - match: src/server.js
      paths:
        - /api/accounts
      method: GET
      capability: crud-read
      reason: The route reads account records.
`,
      });

      const result = await runCli(repo, ['check']);
      const advisoryStart = result.stdout.indexOf('advisories (non-blocking):');
      const blockingStart = result.stdout.indexOf('blocking entries');
      expect(advisoryStart).toBeGreaterThanOrEqual(0);
      expect(result.stdout.slice(advisoryStart, blockingStart)).toContain(
        'only mocked tests reach GET /api/accounts',
      );
      expect(result.stdout.slice(blockingStart)).not.toContain('only mocked tests reach GET /api/accounts');
    });
  });

  it('green path: every obligation waived → exit 0, waived verdicts', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      repo.writeFiles({
        '.gateforge/waivers/accounts.json': waiverJson('tenant.accounts'),
        '.gateforge/waivers/orders.json': waiverJson('tenant.orders'),
      });
      const { code, stdout } = await runCli(repo, ['check', '--format', 'json']);
      expect(code).toBe(0);
      const report = parseReport(stdout);
      expect(report.summary.blocking).toBe(0);
      expect(report.verdicts.every((v) => v.verdict === 'waived')).toBe(true);
      expect(report.verdicts[0]?.fingerprint).toBe(fixtureFingerprint('tenant.accounts'));
    });
  });

  it('GF-23 at the CLI boundary: claimed-only records never satisfy a receipt-bound claim', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      const claimInventory = [
        {
          schemaVersion: 1 as const,
          obligationId: OBLIGATION_ACCOUNTS,
          testId: 'suite-test',
          testFile: 'tests/accounts.spec.ts',
        },
      ];
      const verifierKey = 'claimed-record-verifier-key';
      repo.writeFiles({
        '.gateforge/test-gates/claims.json': JSON.stringify(claimInventory),
        '.gateforge/test-gates/records.json': JSON.stringify([
          {
            schemaVersion: 1,
            recordId: 'a'.repeat(64),
            runId: '00000000-0000-4000-8000-000000000001',
            trust: 'claimed',
            obligationId: OBLIGATION_ACCOUNTS,
            testId: 'suite-test',
            kind: 'ui.action',
            payload: { operation: 'read', entityId: 'acc-1' },
          },
        ]),
      });
      await mintCompleteRunReceipt(repo, { verifierKey, claimInventory });
      const { code, stdout } = await runCli(repo, ['check', '--format', 'json'], {
        GATEFORGE_WITNESS_VERIFIER_KEY: verifierKey,
      });
      expect(code).toBe(1);
      const report = parseReport(stdout);
      const accounts = report.verdicts.find((v) => v.obligationId === OBLIGATION_ACCOUNTS);
      expect(accounts?.verdict).toBe('invalid');
      expect(accounts?.recordIds).toEqual(['a'.repeat(64)]);
      expect(report.verdicts.find((v) => v.obligationId === OBLIGATION_ORDERS)?.verdict).toBe(
        'missing',
      );
    });
  });

  it('blocks the gate when a detector emits a finding (fail closed, audit remediation)', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      // A detector that succeeds but reports a PARSE_ERROR: discovery
      // only partly succeeded, so the gate must not stay green.
      repo.writeFiles({
        'plugin.mjs': PLUGIN_SOURCE.replace(
          'return { resources, unresolved: [], findings: [], classificationSignals, scannedPaths };',
          `return {
    resources,
    unresolved: [],
    findings: [{
      code: 'PARSE_ERROR',
      detail: 'failed to read src/broken.txt: EACCES',
      locations: [{ file: 'src/broken.txt', line: 1, col: 0 }],
    }],
    classificationSignals,
  };`,
        ),
      });
      const { code, stdout } = await runCli(repo, ['check', '--format', 'json']);
      expect(code).toBe(1);
      const report = parseReport(stdout);
      const finding = report.blocking.find((b) => b.kind === 'finding');
      expect(finding).toBeDefined();
      expect(JSON.stringify(report.blocking)).toContain('PARSE_ERROR');
    });
  });
  it('ignores obsolete manual classification files', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      repo.writeFiles({
        '.gateforge/classifications.yml': classificationsYml(['accounts', 'orders', 'ghosts']),
        '.gateforge/waivers/accounts.json': waiverJson('tenant.accounts'),
        '.gateforge/waivers/orders.json': waiverJson('tenant.orders'),
      });
      const { code, stdout } = await runCli(repo, ['check', '--format', 'json']);
      expect(code).toBe(0);
      const report = parseReport(stdout);
      expect(report.verdicts.every((v) => v.verdict === 'waived')).toBe(true);
      expect(report.blocking).toHaveLength(0);
      expect(JSON.stringify(report.blocking)).not.toContain('ghosts');
    });
  });

  it('GF-23 issuance gate: manifest ids satisfy only under a verifier-key MAC', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      // Hash-consistent, witnessed-tier records with a runId matching the
      // manifest: the engine's structural check alone accepts them. The
      // manifest — like records.json — is suite-writable, so its id list
      // is trusted ONLY under a verifier-key MAC: an attacker who can
      // write records.json can equally add computed ids to manifest.json,
      // but it cannot mint the MAC (the verifier key never reaches the
      // suite).
      const runId = '00000000-0000-4000-8000-000000000003';
      const verifierKey = 'verifier-secret-the-suite-never-sees';
      const actionPayload = { operation: 'read', entityId: 'acc-1' };
      const persistencePayload = {
        entityId: 'acc-1',
        found: true,
        fields: { status: 'active' },
        expectFields: { status: 'active' },
      };
      const visiblePayload = { entityId: 'acc-1', fields: { status: 'active' } };
      const visibleRecordId = recordIdOf({
        runId,
        obligationId: OBLIGATION_ACCOUNTS,
        kind: 'ui.visible-result',
        testId: 'suite-test',
        origin: 'suite-submitted',
        payload: visiblePayload,
      });
      const actionRecordId = recordIdOf({
        runId,
        obligationId: OBLIGATION_ACCOUNTS,
        kind: 'ui.action',
        testId: 'suite-test',
        origin: 'suite-submitted',
        payload: actionPayload,
      });
      const persistenceRecordId = recordIdOf({
        runId,
        obligationId: OBLIGATION_ACCOUNTS,
        kind: 'persistence.entity',
        testId: 'suite-test',
        origin: 'engine-observed',
        payload: persistencePayload,
      });
      const action = {
        schemaVersion: 1,
        recordId: actionRecordId,
        runId,
        trust: 'witnessed',
        obligationId: OBLIGATION_ACCOUNTS,
        kind: 'ui.action',
        testId: 'suite-test',
        origin: 'suite-submitted',
        payload: actionPayload,
      };
      const persistence = {
        schemaVersion: 1,
        recordId: persistenceRecordId,
        runId,
        trust: 'witnessed',
        obligationId: OBLIGATION_ACCOUNTS,
        kind: 'persistence.entity',
        testId: 'suite-test',
        origin: 'engine-observed',
        payload: persistencePayload,
      };
      // crud:read's postcondition requires observed UI visibility: a
      // provenance-valid visible-result record (claimed tier — the suite
      // asserted it) agreeing with the engine-observed state.
      const visible = {
        schemaVersion: 1,
        recordId: visibleRecordId,
        runId,
        trust: 'claimed',
        obligationId: OBLIGATION_ACCOUNTS,
        kind: 'ui.visible-result',
        testId: 'suite-test',
        origin: 'suite-submitted',
        payload: visiblePayload,
      };
      const manifestBase = {
        schemaVersion: 1,
        runId,
        startedAt: '2026-08-30T12:00:00.000Z',
        gitSha: null,
        provider: 'all-files',
        plugins: [],
        attestationScope: null,
      };
      const recordIds = [actionRecordId, persistenceRecordId];
      const claimInventory = [
        {
          schemaVersion: 1 as const,
          obligationId: OBLIGATION_ACCOUNTS,
          testId: 'suite-test',
          testFile: 'tests/accounts.spec.ts',
        },
      ];
      repo.writeFiles({
        '.gateforge/test-gates/claims.json': JSON.stringify(claimInventory),
        '.gateforge/test-gates/records.json': JSON.stringify([action, persistence, visible]),
        // orders is not under test here: keep it waived so the accounts
        // verdict alone decides the exit code.
        '.gateforge/waivers/orders.json': waiverJson('tenant.orders'),
      });
      await mintCompleteRunReceipt(repo, { verifierKey, claimInventory });
      const writeManifest = (extra: Record<string, unknown>): void => {
        repo.writeFiles({
          '.gateforge/test-gates/manifest.json': `${JSON.stringify({ ...manifestBase, ...extra })}\n`,
        });
      };
      const accountsVerdict = async (
        argv: readonly string[],
        env: Record<string, string> = {},
      ): Promise<{ code: number; verdict: string | undefined }> => {
        const result = await runCli(repo, argv, env);
        const report = parseReport(result.stdout);
        return {
          code: result.code,
          verdict: report.verdicts.find((v) => v.obligationId === OBLIGATION_ACCOUNTS)?.verdict,
        };
      };
      // The verifier key travels by ENVIRONMENT, never argv (audit round
      // 3: /proc/<pid>/cmdline is world-readable).
      const withKey = { GATEFORGE_WITNESS_VERIFIER_KEY: verifierKey };

      // A missing MAC cannot authorize the manifest. Without a verifier
      // key, the receipt-bound annotation inventory is unavailable too.
      writeManifest({ recordIds });
      expect(await accountsVerdict(['check', '--format', 'json'])).toMatchObject({
        code: 1,
        verdict: 'missing',
      });
      expect(await accountsVerdict(['check', '--format', 'json'], withKey)).toMatchObject({
        code: 1,
        verdict: 'invalid',
      });

      // Forged MAC (guessing the secret does not help either).
      writeManifest({ recordIds, recordIdsMac: 'd'.repeat(64) });
      expect(await accountsVerdict(['check', '--format', 'json'], withKey)).toMatchObject({
        code: 1,
        verdict: 'invalid',
      });

      // GENUINE legacy v1 MAC (correct key, correct ids) still never
      // authorizes (plan §11.3/§11.6, F2): it binds no input snapshot,
      // so old evidence cannot certify the current tree. The verdict
      // blocks AND an explicit legacy-format evidence-context blocker
      // names the migration (fresh test-gates run required).
      writeManifest({
        recordIds,
        recordIdsMac: ledgerMac(verifierKey, runId, recordIds),
      });
      expect(await accountsVerdict(['check', '--format', 'json'], withKey)).toMatchObject({
        code: 1,
        verdict: 'invalid',
      });
      {
        const result = await runCli(repo, ['check', '--format', 'json'], withKey);
        const report = parseReport(result.stdout);
        expect(
          report.blocking.some(
            (entry) => entry.kind === 'finding' && (entry.detail ?? '').includes('legacy v1'),
          ),
        ).toBe(true);
      }

      // Genuine v2 witness attestation (plan §11.3): digest computed
      // over the CURRENT inputs with the real snapshot helpers, MAC
      // minted with the real producer → the ids prove issuance for
      // THIS tree → satisfied, exit 0.
      const invocationId = '22222222-2222-4222-8222-222222222222';
      await writeV2Manifest(repo, { runId, verifierKey, recordIds, invocationId });
      expect(await accountsVerdict(['check', '--format', 'json'], withKey)).toMatchObject({
        code: 0,
        verdict: 'satisfied',
      });

      // The same genuine envelope is not evaluable without the key:
      // trust requires verification — the raw run-state claim cannot
      // restore its mapping.
      expect(await accountsVerdict(['check', '--format', 'json'])).toMatchObject({
        code: 1,
        verdict: 'missing',
      });

      // Tampered digest: the envelope's inputDigest rewritten without a
      // fresh MAC → signature fails → invalid (missing vs malformed vs
      // forged stay distinguished: this is a MAC failure).
      {
        const digest = await currentInputDigest(repo);
        const tampered = 'f'.repeat(64);
        const sortedIds = [...recordIds].sort();
        const mac = attestationMac(verifierKey, {
          runId,
          invocationId,
          inputDigest: digest,
          recordIds: sortedIds,
        });
        writeManifest({
          invocationId,
          inputDigest: tampered,
          recordIds: sortedIds,
          attestation: {
            attestationVersion: 2,
            runId,
            invocationId,
            inputDigest: tampered,
            recordIds: sortedIds,
            mac,
          },
        });
        const result = await runCli(repo, ['check', '--format', 'json'], withKey);
        const report = parseReport(result.stdout);
        expect(result.code).toBe(1);
        expect(report.verdicts.find((v) => v.obligationId === OBLIGATION_ACCOUNTS)?.verdict).toBe(
          'invalid',
        );
        expect(
          report.blocking.some((entry) => (entry.detail ?? '').includes('signature fails')),
        ).toBe(true);
      }

      // Genuine envelope over OLD inputs (a run sealed before the tree
      // changed, or by an earlier engine): the MAC verifies, the digest
      // does not → the finding names the re-seal, never the read-only
      // `discover --json` dump.
      {
        const old = 'e'.repeat(64);
        const sortedIds = [...recordIds].sort();
        const mac = attestationMac(verifierKey, { runId, invocationId, inputDigest: old, recordIds: sortedIds });
        writeManifest({
          invocationId,
          inputDigest: old,
          recordIds: sortedIds,
          attestation: { attestationVersion: 2, runId, invocationId, inputDigest: old, recordIds: sortedIds, mac },
        });
        const result = await runCli(repo, ['check', '--format', 'json'], withKey);
        expect(result.code).toBe(1);
        const report = JSON.parse(result.stdout) as { blocking: Array<{ detail?: string; message?: string }> };
        const stale = report.blocking.find((entry) =>
          (entry.detail ?? '').includes('does not match the current input snapshot'),
        );
        expect(stale, result.stdout).toBeDefined();
        expect(stale?.message, result.stdout).toContain('Run `gateforge test-gates --changed`');
      }

      // Transplanted record: an id issued under another run inserted
      // into the current bundle → demotes (run identity binds per
      // envelope) → invalid.
      {
        await writeV2Manifest(repo, { runId, verifierKey, recordIds, invocationId });
        const foreignId = recordIdOf({
          runId: '00000000-0000-4000-8000-000000000099',
          obligationId: OBLIGATION_ACCOUNTS,
          kind: 'persistence.entity',
          testId: 'suite-test',
          origin: 'engine-observed',
          payload: persistencePayload,
        });
        repo.writeFiles({
          '.gateforge/test-gates/records.json': JSON.stringify([
            action,
            { ...persistence, recordId: foreignId, runId: '00000000-0000-4000-8000-000000000099' },
            visible,
          ]),
        });
        expect(await accountsVerdict(['check', '--format', 'json'], withKey)).toMatchObject({
          code: 1,
          verdict: 'invalid',
        });
      }
    });
  });

  it('F3: an unknown http contract blocks the gate (exit 1, never waived)', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      repo.writeFiles({
        '.gateforge/policies.yml':
          'schemaVersion: 1\npolicies:\n  - id: user-facing-crud\n    when:\n      exposure: user-facing\n    require: [http:does-not-exist]\n',
      });
      const { code, stdout } = await runCli(repo, ['check', '--format', 'json']);
      expect(code).toBe(1);
      const report = parseReport(stdout);
      expect(report.summary.blocking).toBe(2);
      expect(report.verdicts.map((v) => v.obligationId).sort()).toEqual([
        'tenant.accounts:http:does-not-exist',
        'tenant.orders:http:does-not-exist',
      ]);
      expect(report.verdicts.every((v) => v.verdict === 'missing')).toBe(true);
      expect(report.verdicts.every((v) => v.contract === 'http:does-not-exist')).toBe(true);
    });
  });

  it('config errors exit 2 with an actionable diagnostic', async () => {
    await withTempRepo({}, async (repo) => {
      repo.writeFiles({ '.gateforge.yml': 'schemaVersion: 1\nproject: {}\n' });
      const { code, stderr } = await runCli(repo, ['check']);
      expect(code).toBe(2);
      expect(stderr).toContain('gateforge:');
      expect(stderr).toContain('invalid gateforge config');
    });
    await withTempRepo({}, async (repo) => {
      repo.writeFiles({ '.gateforge.yml': 'not: [valid yaml\n' });
      const { code, stderr } = await runCli(repo, ['check']);
      expect(code).toBe(2);
      expect(stderr).toContain('invalid YAML');
    });
  });

  it('unknown flags and formats are usage errors (exit 2)', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      const badFlag = await runCli(repo, ['check', '--bogus=x']);
      expect(badFlag.code).toBe(2);
      expect(badFlag.stderr).toContain("unknown flag '--bogus'");
      const badFormat = await runCli(repo, ['check', '--format', 'xml']);
      expect(badFormat.code).toBe(2);
      expect(badFormat.stderr).toContain('--format');
    });
  });

  it('--changed evaluates only obligations of changed files', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      repo.commitFiles({}, 'base');
      // Change ONLY orders.txt (comment-only diff: no new resources).
      repo.writeFiles({ 'src/orders.txt': 'orders fixture.table\n# changed\n' });
      repo.stage(['src/orders.txt']);

      const { code, stdout } = await runCli(repo, ['check', '--changed', '--format', 'json']);
      expect(code).toBe(1);
      const report = parseReport(stdout);
      expect(report.run.provider).toBe('local-staged');
      expect(report.engine.version).toMatch(/^\d+\.\d+\.\d+$/);
      expect(report.engine.source).toMatch(/^(registry|local path )/);
      expect(typeof report.engine.unpublished).toBe('boolean');
      // Only the changed resource's obligation is in scope.
      expect(report.verdicts.map((v) => v.obligationId)).toEqual([OBLIGATION_ORDERS]);
      expect(report.verdicts[0]?.inScopeBecause).toEqual(['src/orders.txt']);
      expect(report.summary.blocking).toBe(1);
      expect((JSON.parse(stdout) as { newDebt?: { count: number; obligationIds: string[] } }).newDebt).toEqual({
        count: 1,
        obligationIds: [OBLIGATION_ORDERS],
      });
      const text = await runCli(repo, ['check', '--changed']);
      expect(text.stdout).toContain(`this change adds 1 unproven obligations: ${OBLIGATION_ORDERS}`);

      // The unrestricted check still sees both obligations.
      const full = await runCli(repo, ['check', '--format', 'json']);
      expect(full.code).toBe(1);
      expect(parseReport(full.stdout).verdicts).toHaveLength(2);
    });
  });

  it('does not count adopted baseline obligations as newly introduced debt', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      expect((await runCli(repo, ['adopt'])).code).toBe(0);
      repo.commitFiles({}, 'adopted base');
      repo.writeFiles({ 'src/orders.txt': 'orders fixture.table\n# changed\n' });
      repo.stage(['src/orders.txt']);

      const result = await runCli(repo, ['check', '--changed', '--format', 'json']);
      expect(result.code).toBe(0);
      expect((JSON.parse(result.stdout) as { newDebt?: { count: number; obligationIds: string[] } }).newDebt).toEqual({
        count: 0,
        obligationIds: [],
      });
      // This run PASSES: there is no debt to report and nothing to
      // re-seal, so the text report prints no remedy line at all (0.11.0 —
      // it used to print `0 unproven obligations: <none>` plus a command,
      // advice to fix a commit that is already committable; see
      // `new-debt-cause.test.ts` for the blocked counterpart).
      const text = await runCli(repo, ['check', '--changed']);
      expect(text.code).toBe(0);
      expect(text.stdout).not.toContain('[NEW_DEBT]');
      expect(text.stdout).not.toContain('unproven obligations: <none>');
    });
  });

  it('GF-09: local-staged and gitlab-mr diff scopes agree on identical repos', async () => {
    const baseFiles = (): Record<string, string> => ({
      '.gateforge.yml': `schemaVersion: 1
project:
  languages: [python]
  paths:
    include: ['src/**/*.txt']
    exclude: []
plugins:
  - id: fixture.plugin
    version: '1.0.0'
    transport: in-process
    module: ./plugin.mjs
policies: .gateforge/policies.yml
classificationPolicy: .gateforge/classification-policy.yml
adapters: .gateforge/adapters
waivers: .gateforge/waivers
baselines: .gateforge/baselines/obligations.json
scan:
  scanRoots: ['src/**/*.txt']
  declarations:
    internality: gateforge:internal
  volatileFields: []
changed:
  provider: auto
witness:
  maxDurationSeconds: 5
clock:
  mode: fixed
  fixedAt: '2026-01-01T00:00:00.000Z'
`,
      '.gateforge/policies.yml':
        'schemaVersion: 1\npolicies:\n  - id: user-facing-crud\n    when:\n      exposure: user-facing\n    require: [persistence:read]\n',
      '.gateforge/classification-policy.yml':
        'schemaVersion: 1\ntrustedInternalEntryPoints: []\ninternalRules: []\n',
      'plugin.mjs': `import { readFileSync } from 'node:fs';
export default {
  discover(paths) {
    const resources = [];
    for (const rel of paths) {
      for (const line of readFileSync(rel, 'utf8').split('\\n')) {
        const name = line.trim().split(/\\s+/)[0];
        if (!name || name.startsWith('#')) continue;
        resources.push({
          schemaVersion: 1,
          id: 'raw.' + name,
          kind: 'fixture.table',
          source: rel,
          location: { file: rel, line: 1, col: 0 },
          detectorVersion: '1.0.0',
          attributes: { resourceName: name },
        });
      }
    }
    return { resources, unresolved: [], findings: [], classificationSignals: [] };
  },
};
`,
      'src/accounts.txt': 'accounts fixture.table\n',
      'src/orders.txt': 'orders fixture.table\n',
    });
    const change = { 'src/orders.txt': 'orders fixture.table\n# changed\n' };

    // Local mode: the change is staged, never committed.
    let local: CliResult | null = null;
    await withTempRepo({}, async (repo) => {
      repo.commitFiles(baseFiles(), 'base');
      repo.writeFiles(change);
      repo.stage(['src/orders.txt']);
      local = await runCli(repo, ['check', '--changed', '--format', 'json']);
      expect(local?.code).toBe(1);
    });

    // CI mode: the change is committed on top of the base; the env pins
    // the merge-base sha.
    let mr: CliResult | null = null;
    await withTempRepo({}, async (repo) => {
      repo.commitFiles(baseFiles(), 'base');
      const baseSha = repo.headSha();
      expect(baseSha).not.toBeNull();
      repo.commitFiles(change, 'change');
      mr = await runCli(repo, ['check', '--changed', '--format', 'json'], {
        CI_MERGE_REQUEST_DIFF_BASE_SHA: baseSha ?? '',
      });
      expect(mr?.code).toBe(1);
    });

    const localReport = parseReport(resultOrThrow(local, 'local').stdout);
    const mrReport = parseReport(resultOrThrow(mr, 'mr').stdout);
    // Identical resource-change sets and verdicts (invariant 10 / GF-09).
    expect(localReport.run.provider).toBe('local-staged');
    expect(mrReport.run.provider).toBe('gitlab-mr');
    expect(localReport.verdicts).toEqual(mrReport.verdicts);
    expect(localReport.verdicts).toEqual([]);
  });

  it('blocks through the real GPP/3 subprocess when discovery leaves resources unresolved', async () => {
    await withTempRepo({}, async (repo) => {
      repo.writeFiles({
        '.gateforge.yml': `schemaVersion: 1
project:
  languages: [python]
  paths:
    include: ['fixtures/**/*.gfx']
    exclude: []
plugins:
${pythonPluginBlock()}
policies: .gateforge/policies.yml
classificationPolicy: .gateforge/classification-policy.yml
adapters: .gateforge/adapters
waivers: .gateforge/waivers
baselines: .gateforge/baselines/obligations.json
scan:
  scanRoots: ['fixtures/**/*.gfx']
  declarations:
    internality: gateforge:internal
  volatileFields: []
changed:
  provider: auto
witness:
  maxDurationSeconds: 5
clock:
  mode: fixed
  fixedAt: '2026-01-01T00:00:00.000Z'
`,
        '.gateforge/policies.yml': 'schemaVersion: 1\npolicies:\n  - id: noop\n    when: {}\n    require: [persistence:read]\n',
        '.gateforge/classification-policy.yml': 'schemaVersion: 1\ntrustedInternalEntryPoints: []\ninternalRules: []\n',
        'fixtures/routes.gfx': 'GET /accounts\n',
      });
      const { code, stdout } = await runCli(repo, ['check', '--format', 'json']);
      expect(code).toBe(1);
      const report = parseReport(stdout);
      // The unresolved entry blocks the run (fail visible).
      expect(report.blocking.length).toBeGreaterThan(0);
      expect(report.blocking[0]).toMatchObject({ kind: 'classification' });
    });
  });
});