/**
 * `gateforge disposition list [--json]` (plan 2026-10-19 "one disposition
 * shape"): the read-only inventory of every disposition the two policy
 * documents declare — behaviorPolicy endpoints and coveragePolicy tables
 * — with surface, id, kind, reason, expiresAt and the state judged by
 * the shared injected-clock `dispositionExpiry`. The command runs no
 * pipeline and writes nothing: a document-level listing must never need
 * the graph, and listing is not approving.
 */
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TempRepo } from '@gate-forge/core';
import { runCli, withTempRepo } from '../../test/helpers.js';

/** Recursively collects every file path under a directory (relative, sorted). */
function allFiles(root: string, dir: string = root, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) allFiles(root, full, out);
    else out.push(full.slice(root.length + 1));
  }
  return out.sort();
}

const DETECTOR = `const DETECTOR = { id: 'gateforge.behavior-fixture', version: '1.0.0' };
export default { discover(paths) { return { resources: [], unresolved: [], findings: [], classificationSignals: [], scannedPaths: paths }; } };
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
disposition: { maxDays: 200 }
behaviorPolicy: .gateforge/behavior.yml
coveragePolicy:
  tables:
    - name: raw.orders
      requiredOperations: [read]
      disposition:
        kind: read-only-surface
        note: legacy alias entry
`;

const BEHAVIOR_YML = `schemaVersion: 1
resources: []
endpoints:
  - resourceId: global.http-get-health-live
    effects: []
    cases: []
    disposition:
      kind: operational-only
      reason: infra probe route
  - resourceId: global.http-post-orders-import
    effects: []
    cases: []
    disposition:
      kind: out-of-scope
      reason: vendor screen expired
      expiresAt: '2025-06-01T00:00:00.000Z'
  - resourceId: tenant.http-get-users-list
    effects: []
    cases: []
    disposition:
      kind: out-of-scope
      reason: vendor screen
      expiresAt: '2026-06-01T00:00:00.000Z'
`;

/** Installs a repo whose two documents carry dispositions in every state. */
function installDispositionFixture(repo: TempRepo): void {
  repo.writeFiles({
    '.gitignore': '.gateforge/test-gates/\n',
    '.gateforge.yml': GATEFORGE_YML,
    '.gateforge/policies.yml':
      'schemaVersion: 1\npolicies:\n  - id: endpoint-observed\n    when:\n      kind: http.endpoint\n    require: [http:request-observed]\n',
    '.gateforge/classification-policy.yml':
      'schemaVersion: 1\ntrustedInternalEntryPoints: []\ninternalRules: []\n',
    '.gateforge/adapters/.gitkeep': '',
    '.gateforge/waivers/.gitkeep': '',
    '.gateforge/fixture-detector.mjs': DETECTOR,
    '.gateforge/behavior.yml': BEHAVIOR_YML,
    'src/api.js': '// fixture source: the endpoints live here.\n',
  });
}

describe('gateforge disposition list (plan 2026-10-19)', () => {
  it('lists both surfaces with kind, judged state and reason, endpoints sorted before tables', async () => {
    await withTempRepo({}, async (repo) => {
      installDispositionFixture(repo);
      const { code, stdout } = await runCli(repo, ['disposition', 'list']);
      expect(code).toBe(0);
      // Injected clock 2026-01-01: the three judged states appear.
      expect(stdout).toContain('dispositions (4):');
      const order = [
        'endpoint global.http-get-health-live',
        'endpoint global.http-post-orders-import',
        'endpoint tenant.http-get-users-list',
        'table raw.orders',
      ];
      let cursor = -1;
      for (const line of order) {
        const at = stdout.indexOf(line, cursor + 1);
        expect(at).toBeGreaterThan(cursor);
        cursor = at;
      }
      expect(stdout).toContain('endpoint global.http-get-health-live  kind=operational-only  state=no-expiry');
      expect(stdout).toContain('endpoint global.http-post-orders-import  kind=out-of-scope  state=expired');
      expect(stdout).toContain('endpoint tenant.http-get-users-list  kind=out-of-scope  state=active');
      expect(stdout).toContain('table raw.orders  kind=read-only-surface  state=no-expiry');
      // Reasons are the recorded owner justification — alias included.
      expect(stdout).toContain('reason: infra probe route');
      expect(stdout).toContain('reason: vendor screen');
      expect(stdout).toContain('reason: legacy alias entry');
    });
  });

  it('--json prints the canonical machine-readable entries', async () => {
    await withTempRepo({}, async (repo) => {
      installDispositionFixture(repo);
      const { code, stdout } = await runCli(repo, ['disposition', 'list', '--json']);
      expect(code).toBe(0);
      const entries = JSON.parse(stdout) as Array<{
        surface: string;
        id: string;
        kind: string;
        reason: string;
        expiresAt: string | null;
        state: string;
        excuses: 'rule-obligations' | 'persistence' | null;
      }>;
      expect(entries).toHaveLength(4);
      expect(entries[0]).toEqual({
        surface: 'endpoint',
        id: 'global.http-get-health-live',
        kind: 'operational-only',
        reason: 'infra probe route',
        expiresAt: null,
        state: 'no-expiry',
        excuses: null,
      });
      const active = entries.find((entry) => entry.id === 'tenant.http-get-users-list');
      expect(active?.excuses).toBe('rule-obligations');
      const expired = entries.find((entry) => entry.id === 'global.http-post-orders-import');
      expect(expired?.excuses).toBeNull();
      const table = entries.find((entry) => entry.surface === 'table');
      expect(table?.excuses).toBe('persistence');
      const orders = entries.find((entry) => entry.id === 'global.http-post-orders-import');
      expect(orders?.state).toBe('expired');
      expect(orders?.expiresAt).toBe('2025-06-01T00:00:00.000Z');
      // The deprecated alias is mapped onto reason for every consumer.
      expect(table?.reason).toBe('legacy alias entry');
    });
  });

  it('writes nothing: the repository file set is unchanged', async () => {
    await withTempRepo({}, async (repo) => {
      installDispositionFixture(repo);
      const before = allFiles(repo.root);
      const { code } = await runCli(repo, ['disposition', 'list']);
      expect(code).toBe(0);
      expect(allFiles(repo.root)).toEqual(before);
    });
  });
});
