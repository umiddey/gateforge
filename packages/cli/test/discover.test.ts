/**
 * `gateforge discover`: graph dumps, determinism, and both plugin
 * transports (in-process fixture + real GPP/3 python subprocess).
 */
import { describe, expect, it } from 'vitest';
import { withTempRepo } from '@gateforge/core';
import { configYml, installFixture, pythonPluginBlock, runCli } from './helpers.js';

// A plugin module that forges the ENGINE's suppressive authority: the
// signal claims `gateforge.core@1` while the pinned plugin is something
// else entirely (red-team V1).
const FORGING_PLUGIN_SOURCE = `export default {
  discover(paths) {
    return {
      resources: [],
      unresolved: [],
      findings: [],
      classificationSignals: [
        {
          schemaVersion: 1,
          target: { resourceName: 'accounts' },
          dimension: 'internality',
          assertion: true,
          basis: 'declaration',
          source: 'gateforge:internal',
          location: { file: 'src/accounts.txt', line: 1, col: 0 },
          detector: { id: 'gateforge.core', version: '1' },
        },
      ],
    };
  },
};
`;

describe('gateforge discover', () => {
  it('fails closed when an in-process plugin forges engine signal authority (V1)', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      repo.writeFiles({ 'forged.mjs': FORGING_PLUGIN_SOURCE });
      repo.writeFiles({
        '.gateforge.yml': configYml({
          plugins: `  - id: forged.plugin
    version: '1.0.0'
    transport: in-process
    module: ./forged.mjs`,
        }),
      });
      const result = await runCli(repo, ['discover', '--json']);
      expect(result.code).toBe(2);
      expect(result.stderr).toContain('signal identity must equal the pinned plugin identity');
      expect(result.stderr).toContain('gateforge.core');
    });
  });

  it('dumps a deterministic graph from the in-process plugin', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      const first = await runCli(repo, ['discover', '--json']);
      const second = await runCli(repo, ['discover', '--json']);
      expect(first.code).toBe(0);
      expect(second.code).toBe(0);
      // Byte-for-byte determinism across runs.
      expect(first.stdout).toBe(second.stdout);
      const graph = JSON.parse(first.stdout) as {
        resources: Array<{ id: string; kind: string }>;
      };
      expect(graph.resources.map((r) => r.id).sort()).toEqual([
        'tenant.accounts',
        'tenant.orders',
      ]);
      expect(graph.resources[0]).toMatchObject({ kind: 'fixture.table' });
    });
  });

  it('renders a human-readable listing without --json', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      const { code, stdout } = await runCli(repo, ['discover']);
      expect(code).toBe(0);
      expect(stdout).toContain('tenant.accounts [fixture.table] src/accounts.txt:1');
      expect(stdout).toContain('tenant.orders [fixture.table] src/orders.txt:1');
      expect(stdout).toContain('resources (2):');
    });
  });

  it('runs the real GPP/3 python reference detector over .gfx fixtures', async () => {
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
        'fixtures/routes.gfx': 'GET /accounts\nGET /accounts\nPOST /orders\n',
      });
      const first = await runCli(repo, ['discover', '--json']);
      expect(first.code).toBe(0);
      const second = await runCli(repo, ['discover', '--json']);
      expect(first.stdout).toBe(second.stdout);
      const graph = JSON.parse(first.stdout) as {
        resources: unknown[];
        unresolved: Array<{ reason: { code: string; location: { file: string } } }>;
        findings: Array<{ code: string }>;
      };
      // The reference detector emits resources without a resourceName
      // attribute, so the graph holds them unresolved-but-visible — the
      // honest no_resource_name path (GF-19 discipline, fail visible).
      expect(graph.resources).toEqual([]);
      expect(graph.unresolved.some((e) => e.reason.code === 'no_resource_name')).toBe(true);
      expect(graph.unresolved[0]?.reason.location.file).toBe('fixtures/routes.gfx');
      // Duplicate route detection survived the round trip.
      expect(graph.findings.some((f) => f.code === 'DUPLICATE_ROUTE')).toBe(true);
    });
  });

  it('ignores nothing: empty include expansion yields an empty contribution', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo, { include: "['no-such-dir/**']" });
      const { code, stdout } = await runCli(repo, ['discover', '--json']);
      expect(code).toBe(0);
      const graph = JSON.parse(stdout) as { resources: unknown[]; unresolved: unknown[] };
      expect(graph.resources).toEqual([]);
      expect(graph.unresolved).toEqual([]);
    });
  });
});