/**
 * `gateforge check`: the full gate — red/green paths, waiver-driven
 * passes, GF-23 claimed-records degradation at the CLI boundary,
 * config-error exit 2, `--changed` scoping, and GF-09 provider parity.
 */
import { describe, expect, it } from 'vitest';
import { withTempRepo } from '@gateforge/core';
import {
  fixtureFingerprint,
  installFixture,
  OBLIGATION_ACCOUNTS,
  OBLIGATION_ORDERS,
  pythonPluginBlock,
  runCli,
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
    verdict: string;
    recordIds: string[];
    policyId: string;
    fingerprint: string;
  }>;
  blocking: Array<{ kind: string }>;
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
classifications: .gateforge/classifications.yml
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
        'schemaVersion: 1\npolicies:\n  - id: user-facing-crud\n    when:\n      exposure: user-facing\n    require: [crud:read]\n',
      '.gateforge/classifications.yml':
        'schemaVersion: 1\nresources:\n  accounts:\n    exposure: user-facing\n    plane: tenant\n    lifecycle: { create: false, read: true, update: false, delete: false }\n    primaryKey: [id]\n    evidenceAdapter: accounts\n  orders:\n    exposure: user-facing\n    plane: tenant\n    lifecycle: { create: false, read: true, update: false, delete: false }\n    primaryKey: [id]\n    evidenceAdapter: orders\n',
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
    return { resources, unresolved: [], findings: [] };
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
    expect(localReport.verdicts.map((v) => v.obligationId)).toEqual([OBLIGATION_ORDERS]);
  });

  it('blocks through the real GPP/2 subprocess when discovery leaves resources unresolved', async () => {
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
classifications: .gateforge/classifications.yml
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
        '.gateforge/policies.yml': 'schemaVersion: 1\npolicies:\n  - id: noop\n    when: {}\n    require: [crud:read]\n',
        '.gateforge/classifications.yml': 'schemaVersion: 1\nresources: {}\n',
        'fixtures/routes.gfx': 'GET /accounts\n',
      });
      const { code, stdout } = await runCli(repo, ['check', '--format', 'json']);
      expect(code).toBe(1);
      const report = parseReport(stdout);
      // The unresolved entry blocks the run (fail visible).
      expect(report.blocking.length).toBeGreaterThan(0);
      expect(report.blocking[0]).toMatchObject({ kind: 'unresolved' });
    });
  });
});