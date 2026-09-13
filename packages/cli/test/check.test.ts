/**
 * `gateforge check`: the full gate — red/green paths, waiver-driven
 * passes, GF-23 claimed-records degradation at the CLI boundary,
 * config-error exit 2, `--changed` scoping, and GF-09 provider parity.
 */
import { describe, expect, it } from 'vitest';
import { attestationMac, ledgerMac, recordIdOf, withTempRepo } from '@gateforge/core';
import {
  classificationsYml,
  currentInputDigest,
  fixtureFingerprint,
  installFixture,
  OBLIGATION_ACCOUNTS,
  OBLIGATION_ORDERS,
  PLUGIN_SOURCE,
  pythonPluginBlock,
  runCli,
  writeV2Manifest,
  type CliResult,
} from './helpers.js';

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
    reason: string | null;
    recordIds: string[];
    policyId: string;
    fingerprint: string;
  }>;
  blocking: Array<{ kind: string; detail?: string }>;
  run: { provider: string };
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

  it('GF-23 at the CLI boundary: claimed-only records never satisfy', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      repo.writeFiles({
        '.gateforge/test-gates/claims.json': JSON.stringify([
          {
            schemaVersion: 1,
            obligationId: OBLIGATION_ACCOUNTS,
            testId: 'suite-test',
            testFile: 'tests/accounts.spec.ts',
          },
        ]),
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
      const { code, stdout } = await runCli(repo, ['check', '--format', 'json']);
      expect(code).toBe(1);
      const report = parseReport(stdout);
      const accounts = report.verdicts.find((v) => v.obligationId === OBLIGATION_ACCOUNTS);
      // The fabricated bundle is considered and rejected (GF-23).
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
      repo.writeFiles({
        '.gateforge/test-gates/claims.json': JSON.stringify([
          {
            schemaVersion: 1,
            obligationId: OBLIGATION_ACCOUNTS,
            testId: 'suite-test',
            testFile: 'tests/accounts.spec.ts',
          },
        ]),
        '.gateforge/test-gates/records.json': JSON.stringify([action, persistence, visible]),
        // orders is not under test here: keep it waived so the accounts
        // verdict alone decides the exit code.
        '.gateforge/waivers/orders.json': waiverJson('tenant.orders'),
      });
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

      // Bypass attempt (exactly what a hostile suite can do): plant the
      // computed ids in the suite-writable manifest, no MAC. Never green —
      // with or without a verifier key on the CLI.
      writeManifest({ recordIds });
      expect(await accountsVerdict(['check', '--format', 'json'])).toMatchObject({
        code: 1,
        verdict: 'invalid',
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
      // trust requires verification — fail closed, never "trust on
      // presence".
      expect(await accountsVerdict(['check', '--format', 'json'])).toMatchObject({
        code: 1,
        verdict: 'invalid',
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
        '.gateforge/test-gates/claims.json': JSON.stringify([
          {
            schemaVersion: 1,
            obligationId: 'tenant.accounts:http:does-not-exist',
            testId: 'suite-test',
            testFile: 'tests/accounts.spec.ts',
          },
          {
            schemaVersion: 1,
            obligationId: 'tenant.orders:http:does-not-exist',
            testId: 'suite-test',
            testFile: 'tests/orders.spec.ts',
          },
        ]),
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
      expect(
        report.verdicts.every(
          (v) => v.reason !== null && v.reason.includes("'http:does-not-exist'"),
        ),
      ).toBe(true);
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
      // Only the changed resource's obligation is in scope.
      expect(report.verdicts.map((v) => v.obligationId)).toEqual([OBLIGATION_ORDERS]);
      expect(report.summary.blocking).toBe(1);

      // The unrestricted check still sees both obligations.
      const full = await runCli(repo, ['check', '--format', 'json']);
      expect(full.code).toBe(1);
      expect(parseReport(full.stdout).verdicts).toHaveLength(2);
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
        'schemaVersion: 1\nscanRoots: [\'src/**/*.txt\']\ntrustedInternalEntryPoints: []\ninternalRules: []\ndeclarations:\n  internality: gateforge:internal\nvolatileFields: []\n',
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
changed:
  provider: auto
witness:
  maxDurationSeconds: 5
clock:
  mode: fixed
  fixedAt: '2026-01-01T00:00:00.000Z'
`,
        '.gateforge/policies.yml': 'schemaVersion: 1\npolicies:\n  - id: noop\n    when: {}\n    require: [persistence:read]\n',
        '.gateforge/classification-policy.yml': 'schemaVersion: 1\nscanRoots: [\'fixtures/**/*.gfx\']\ntrustedInternalEntryPoints: []\ninternalRules: []\ndeclarations:\n  internality: gateforge:internal\nvolatileFields: []\n',
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