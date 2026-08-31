/**
 * `gateforge discover`: graph dumps, determinism, and both plugin
 * transports (in-process fixture + real GPP/2 python subprocess).
 */
import { describe, expect, it } from 'vitest';
import { withTempRepo } from '@gateforge/core';
import { installFixture, pythonPluginBlock, runCli } from './helpers.js';

describe('gateforge discover', () => {
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

  it('runs the real GPP/2 python reference detector over .gfx fixtures', async () => {
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