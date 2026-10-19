/**
 * `gateforge behavior draft` (plan 2026-10-18): the read-only command
 * prints a paste-ready `behavior.yml` body with one entry per discovered
 * `http.endpoint` (sorted by resource id), each entry's `cases`
 * commented out under a TODO — the cases are the part no tool may
 * invent. Once the owner fills real cases in, the document parses
 * through the production `BehaviorPolicySchema`; `--json` prints the
 * draft skeleton as canonical JSON; and NOTHING is written to disk —
 * declaring behavior is the owner's act, never the agent's.
 */
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { BehaviorPolicySchema, TempRepo, withTempRepo } from '@gate-forge/core';
import { runCli } from '../../test/helpers.js';

/** Recursively collects every file path under a directory (relative, sorted). */
function allFiles(root: string, dir: string = root, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) allFiles(root, full, out);
    else out.push(full.slice(root.length + 1));
  }
  return out.sort();
}

const ENDPOINTS = [
  {
    id: 'global.http-post-orders-import',
    attributes: {
      resourceName: 'http-post-orders-import',
      method: 'POST',
      canonicalPath: '/orders/import',
      capabilities: ['crud-create', 'file-transfer'],
    },
  },
  {
    id: 'global.http-get-health-live',
    attributes: {
      resourceName: 'http-get-health-live',
      method: 'GET',
      canonicalPath: '/health/live',
      capabilities: ['health-operations'],
    },
  },
  {
    id: 'tenant.http-get-users-list',
    attributes: {
      resourceName: 'http-get-users-list',
      method: 'GET',
      canonicalPath: '/users',
      capabilities: ['crud-read'],
    },
  },
];
/** The draft order: resource ids sorted, never discovery order. */
const SORTED_IDS = [...ENDPOINTS.map((endpoint) => endpoint.id)].sort((a, b) => (a < b ? -1 : 1));

const DETECTOR = `const DETECTOR = { id: 'gateforge.behavior-fixture', version: '1.0.0' };
const ENDPOINTS = ${JSON.stringify(ENDPOINTS)};
const PLANE = { 'global.http-post-orders-import': 'global', 'global.http-get-health-live': 'global', 'tenant.http-get-users-list': 'tenant' };
export default {
  discover(paths) {
    const signals = ENDPOINTS.flatMap((endpoint) => [
      {
        schemaVersion: 1,
        target: { resourceName: endpoint.attributes.resourceName },
        dimension: 'plane',
        assertion: PLANE[endpoint.id],
        basis: 'code-positive',
        source: 'gateforge.behavior-fixture',
        location: { file: 'src/api.js', line: 1, col: 0 },
        detector: DETECTOR,
      },
      {
        schemaVersion: 1,
        target: { resourceName: endpoint.attributes.resourceName },
        dimension: 'identity',
        assertion: ['method', 'path'],
        basis: 'code-positive',
        source: 'gateforge.behavior-fixture',
        location: { file: 'src/api.js', line: 1, col: 0 },
        detector: DETECTOR,
      },
    ]);
    return {
      resources: [
        ...ENDPOINTS.map((endpoint) => ({
          schemaVersion: 1,
          id: endpoint.id,
          kind: 'http.endpoint',
          source: 'src/api.js',
          location: { file: 'src/api.js', line: 1, col: 0 },
          detectorVersion: DETECTOR.version,
          attributes: endpoint.attributes,
        })),
        {
          schemaVersion: 1,
          id: 'raw.orders',
          kind: 'fixture.table',
          source: 'src/api.js',
          location: { file: 'src/api.js', line: 2, col: 0 },
          detectorVersion: DETECTOR.version,
          attributes: { resourceName: 'orders' },
        },
      ],
      unresolved: [],
      findings: [],
      classificationSignals: signals,
      scannedPaths: paths,
    };
  },
};
`;

const GATEFORGE_YML = `schemaVersion: 1
project:
  languages: [javascript]
  paths:
    include: ['src/**']
    exclude: []
plugins:
  - id: gateforge.behavior-fixture
    version: 1.0.0
    transport: in-process
    module: ./.gateforge/fixture-detector.mjs
policies: .gateforge/policies.yml
classificationPolicy: .gateforge/classification-policy.yml
adapters: .gateforge/adapters
waivers: .gateforge/waivers
baselines: .gateforge/baselines/obligations.json
scan:
  scanRoots: ['src/**']
  declarations:
    internality: gateforge:internal
  volatileFields: []
changed: { provider: auto }
witness: { maxDurationSeconds: 5 }
clock: { mode: fixed, fixedAt: '2026-01-01T00:00:00.000Z' }
`;

/** Installs the three-endpoint fixture repository. */
export function installBehaviorFixture(repo: TempRepo): void {
  repo.writeFiles({
    '.gitignore': '.gateforge/test-gates/\n',
    '.gateforge.yml': GATEFORGE_YML,
    '.gateforge/policies.yml':
      'schemaVersion: 1\npolicies:\n  - id: endpoint-observed\n    when:\n      kind: http.endpoint\n    require: [http:request-observed]\n',
    '.gateforge/classification-policy.yml':
      'schemaVersion: 1\ntrustedInternalEntryPoints: []\ninternalRules: []\n',
    '.gateforge/adapters/.gitkeep': '',
    '.gateforge/fixture-detector.mjs': DETECTOR,
    'src/api.js': '// fixture source: the endpoints live here.\n',
  });
}

/** A minimal valid transport case, as the operational compiler builds them. */
function transportCase(resourceId: string): Record<string, unknown> {
  const endpoint = ENDPOINTS.find((entry) => entry.id === resourceId);
  const method = typeof endpoint?.attributes['method'] === 'string' ? endpoint.attributes['method'] : 'GET';
  const pathTemplate =
    typeof endpoint?.attributes['canonicalPath'] === 'string' ? endpoint.attributes['canonicalPath'] : '/';
  return {
    id: 'owner-transport',
    contract: 'http:request-observed',
    channel: 'engine-http',
    fixture: 'operational',
    actor: 'anonymous',
    action: {
      kind: 'request',
      method,
      pathTemplate,
      path: {},
      query: {},
      body: { encoding: 'json', fields: {} },
      credentialVariant: 'valid',
    },
    expect: { statuses: [200], response: [], state: [] },
  };
}

describe('gateforge behavior draft (plan 2026-10-18)', () => {
  it('prints a paste-ready skeleton listing every discovered endpoint, sorted', async () => {
    await withTempRepo({}, async (repo) => {
      installBehaviorFixture(repo);
      const { code, stdout } = await runCli(repo, ['behavior', 'draft']);
      expect(code).toBe(0);
      expect(stdout).toContain('owner review required; pasting it is the owner act; repin afterwards');
      expect(stdout).toMatch(/^schemaVersion: 1\nendpoints:\n/m);
      // Every discovered endpoint, sorted by resource id, discovery order ignored.
      let cursor = stdout.indexOf('endpoints:\n');
      for (const id of SORTED_IDS) {
        const at = stdout.indexOf(`- resourceId: ${id}`, cursor);
        expect(at).toBeGreaterThan(-1);
        cursor = at;
      }
      // The business table is NOT an endpoint: never drafted.
      expect(stdout).not.toContain('raw.orders');
      // Each entry ships the TODO and the commented-out empty cases.
      for (const id of SORTED_IDS) {
        const entry = stdout.slice(stdout.indexOf(`- resourceId: ${id}`));
        expect(entry).toContain('# TODO(owner): declare real behavior cases');
        expect(entry).toMatch(/# cases: \[\]/);
      }
    });
  });

  it('parses through BehaviorPolicySchema once the owner fills the cases in', async () => {
    await withTempRepo({}, async (repo) => {
      installBehaviorFixture(repo);
      const { code, stdout } = await runCli(repo, ['behavior', 'draft']);
      expect(code).toBe(0);
      // The draft body is everything after the header comment lines.
      const body = stdout.split('\n').filter((line) => !line.trimStart().startsWith('#')).join('\n');
      const document = parseYaml(body) as {
        schemaVersion: number;
        endpoints: Array<{ resourceId: string; effects: string[] }>;
        resources: unknown[];
      };
      expect(document.endpoints.map((endpoint) => endpoint.resourceId)).toEqual(SORTED_IDS);
      // The owner's fill-in: real cases replace the commented-out stubs.
      const filled = {
        ...document,
        endpoints: document.endpoints.map((endpoint) => ({
          ...endpoint,
          cases: [transportCase(endpoint.resourceId)],
        })),
      };
      const policy = BehaviorPolicySchema.parse(filled);
      expect(policy.endpoints).toHaveLength(3);
      expect(policy.endpoints.every((endpoint) => endpoint.cases.length === 1)).toBe(true);
    });
  });

  it('--json prints the canonical draft skeleton', async () => {
    await withTempRepo({}, async (repo) => {
      installBehaviorFixture(repo);
      const { code, stdout } = await runCli(repo, ['behavior', 'draft', '--json']);
      expect(code).toBe(0);
      const parsed = JSON.parse(stdout) as {
        schemaVersion: number;
        endpoints: Array<{ resourceId: string; effects: string[]; cases: string[] }>;
        resources: string[];
      };
      expect(parsed.schemaVersion).toBe(1);
      expect(parsed.endpoints.map((endpoint) => endpoint.resourceId)).toEqual(SORTED_IDS);
      expect(parsed.endpoints.every((endpoint) => endpoint.effects.length === 0 && endpoint.cases.length === 0)).toBe(true);
      expect(parsed.resources).toEqual([]);
      expect(stdout).toBe(`${JSON.stringify(JSON.parse(stdout))}\n`); // canonical: sorted keys, no spaces
    });
  });

  it('never writes any file into the repository', async () => {
    await withTempRepo({}, async (repo) => {
      installBehaviorFixture(repo);
      const before = allFiles(repo.root);
      const { code } = await runCli(repo, ['behavior', 'draft']);
      expect(code).toBe(0);
      expect(allFiles(repo.root)).toEqual(before);
    });
  });

  it('refuses an unknown subcommand (exit 2)', async () => {
    await withTempRepo({}, async (repo) => {
      installBehaviorFixture(repo);
      const { code, stderr } = await runCli(repo, ['behavior', 'apply']);
      expect(code).toBe(2);
      expect(stderr).toContain('gateforge behavior draft');
    });
  });
});
