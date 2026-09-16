import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { withTempRepo } from '@gate-forge/core';
import { runCli } from './helpers.js';

/** Exercises the real CLI discovery-to-classification path from source only. */
describe('source-only automatic classification', () => {
  it('runs init, discover, classify, and obligations without a resource map', async () => {
    await withTempRepo({}, async (repo) => {
      const httpPack = join(process.cwd(), 'packages/pack-http/src/index.ts');
      const init = await runCli(repo, ['init', '--languages', 'typescript']);
      expect(init.code).toBe(0);
      repo.writeFiles({
        '.gateforge.yml': `schemaVersion: 1
project:
  languages: [typescript]
  paths:
    include: ['src/**/*.ts']
    exclude: []
plugins:
  - id: gateforge.pack-http
    version: '0.1.0'
    transport: in-process
    module: ${httpPack}
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
        '.gateforge/policies.yml': 'schemaVersion: 1\npolicies:\n  - id: persistence\n    when: { exposure: user-facing }\n    require: [persistence:read]\n',
        '.gateforge/classification-policy.yml': 'schemaVersion: 1\nscanRoots: [\'src/**/*.ts\']\ntrustedInternalEntryPoints: []\ninternalRules: []\ndeclarations:\n  internality: gateforge:internal\nvolatileFields: []\n',
        'src/routes.ts': "app.get('/accounts', handler);\n",
      });
      const discover = await runCli(repo, ['discover', '--json']);
      expect(discover.code).toBe(0);
      // Routes are EVIDENCE (red-team round 3, ADR 0004 D1): the pack
      // emits no business resources — the only resource is the compiled
      // endpoint, which stays classification-blocked without any
      // business resource to converge with.
      const resources = JSON.parse(discover.stdout).resources as Array<{ kind: string; name: string }>;
      expect(resources.filter((r) => r.kind !== 'http.endpoint')).toEqual([]);
      expect(resources.map((r) => r.kind)).toEqual(['http.endpoint']);
      const classify = await runCli(repo, ['classify', '--json']);
      expect(classify.code).toBe(1);
      expect(classify.stdout).toContain('"decisions"');
      const obligations = await runCli(repo, ['obligations', '--json']);
      expect(obligations.code).toBe(0);
      expect(obligations.stdout).toContain('"kind":"classification"');
    });
  });
});

describe('host-issued authority channel (red-team V1/V2/V4 remediation)', () => {
  it('mints declarations from source markers and certifies through the REAL pipeline with trusted coverage', async () => {
    await withTempRepo({}, async (repo) => {
      const httpPack = join(process.cwd(), 'packages/pack-http/src/index.ts');
      const sqlalchemyPack = join(process.cwd(), 'packages/pack-sqlalchemy/src/index.ts');
      const taskPack = join(process.cwd(), 'packages/pack-task/src/index.ts');
      const init = await runCli(repo, ['init', '--languages', 'typescript']);
      expect(init.code).toBe(0);
      // FULLY REAL PACKS: model facts from the REAL pack-sqlalchemy
      // subprocess scan (identity, delete-semantics dunder), worker
      // reachability from the REAL pack-task (import-based model
      // linkage), declarations from the HOST minter (plane + internality
      // markers). Coverage rules name TRUSTED bundled detectors only
      // (red-team rounds 4/5): arbitrary plugins can never contribute
      // scan completeness or reachability.
      const CONFIG_TEMPLATE = `schemaVersion: 1
project:
  languages: [typescript, python]
  paths:
    include: ['**/*.ts', '**/*.py']
    exclude: []
plugins:
  - id: gateforge.pack-http
    version: '0.1.0'
    transport: in-process
    module: ${httpPack}
  - id: gateforge.pack-sqlalchemy
    version: '0.1.0'
    transport: in-process
    module: ${sqlalchemyPack}
  - id: gateforge.pack-task
    version: '0.1.0'
    transport: in-process
    module: ${taskPack}
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
`;
      repo.writeFiles({
        '.gateforge.yml': CONFIG_TEMPLATE,
        '.gateforge/policies.yml': 'schemaVersion: 1\npolicies:\n  - id: persistence\n    when: { exposure: user-facing }\n    require: [persistence:read]\n',
        '.gateforge/classification-policy.yml': `schemaVersion: 1
scanRoots: ['**/*.ts', '**/*.py']
trustedInternalEntryPoints:
  - category: worker
    patterns: ['**/workers/**']
    detector: gateforge.pack-task
internalRules: []
coverage:
  - capability: exposure.http
    detector: gateforge.pack-http
    appliesTo: ['**/*.ts']
  - capability: models.sqlalchemy
    detector: gateforge.pack-sqlalchemy
    appliesTo: ['**/*.py']
  - capability: linkage.task
    detector: gateforge.pack-task
    appliesTo: ['**/*.ts']
declarations:
  internality: gateforge:internal
  plane.tenant: gateforge:tenant-plane
volatileFields: []
`,
        'models.py': `from sqlalchemy import Column, Integer, String
from sqlalchemy.orm import DeclarativeBase


class Base(DeclarativeBase):
    pass


class Account(Base):
    __tablename__ = "accounts"
    __gateforge_delete_semantics__ = "hard"

    id = Column(Integer, primary_key=True)
    status = Column(String)
# gateforge:internal
# gateforge:tenant-plane
`,
        // A REAL worker: imports the model module (pack-task's
        // import-based linkage resolves the target) and registers a task.
        'workers/sync.ts': `import { run } from '../lib/runner';
import { Account } from '../models/accounts';
register('sync_accounts', async (job) => {
  await run(job.data);
});
`,
        'lib/runner.ts': "export async function run(data: unknown): Promise<void> {}\n",
        '.gateforge/adapters/accounts.mjs': 'export default {};\n',
      });
      const discover = await runCli(repo, ['discover', '--json']);
      expect(discover.code).toBe(0);
      const classify = await runCli(repo, ['classify', '--json']);
      const parsed = JSON.parse(classify.stdout) as {
        classification: {
          decisions: Array<{ name: string; classification: { exposure: string; rules: string[] } | null }>;
        };
      };
      const accounts = parsed.classification.decisions.find((d) => d.name === 'accounts');
      // Round-6 soundness: the marker, the trusted reachability, and the
      // structural coverage all hold — but NO real detector is an
      // exhaustive exposure parser, so the certificate stays UNAVAILABLE
      // and the resource remains conservatively user-facing.
      expect(accounts?.classification?.exposure).toBe('user-facing');
      expect(JSON.stringify(parsed.classification.decisions)).toContain(
        'EXHAUSTIVE exposure.* coverage rule',
      );
      // And a sneaky plugin that CLAIMS suppressive intent is rejected
      // loudly: a typed block names the attempt and blocks the gate.
      repo.writeFiles({
        'sneaky.mjs': `export default {
          discover(paths) {
            const signals = [];
            for (const rel of paths) {
              signals.push({
                schemaVersion: 1,
                target: { resourceName: 'accounts' },
                dimension: 'internality',
                assertion: { category: 'worker' },
                basis: 'organization-policy',
                source: 'gateforge:internal',
                location: { file: rel, line: 1, col: 0 },
                detector: { id: 'sneaky.plugin', version: '1.0.0' },
              });
            }
            return { resources: [], unresolved: [], findings: [], classificationSignals: signals, scannedPaths: paths };
          },
        };
        `,
        '.gateforge.yml': ((cfg) =>
          cfg.replace(
            '    module: ./sneaky.mjs-replace-me',
            'x',
          ).replace(
            `    module: ${taskPack}`,
            `    module: ${taskPack}
  - id: sneaky.plugin
    version: '1.0.0'
    transport: in-process
    module: ./sneaky.mjs`,
          ))(CONFIG_TEMPLATE),
      });
      const sneaky = await runCli(repo, ['classify', '--json']);
      expect(`${sneaky.stdout}\n${sneaky.stderr}`).toContain('UNAUTHORIZED_SUPPRESSIVE_SIGNAL');
    });
  });
});

describe('coverage trust validation (red-team round 4)', () => {
  it('rejects a coverage rule naming a non-bundled detector', async () => {
    await withTempRepo({}, async (repo) => {
      const httpPack = join(process.cwd(), 'packages/pack-http/src/index.ts');
      const init = await runCli(repo, ['init', '--languages', 'typescript']);
      expect(init.code).toBe(0);
      repo.writeFiles({
        '.gateforge.yml': `schemaVersion: 1
project:
  languages: [typescript]
  paths:
    include: ['src/**/*.ts']
    exclude: []
plugins:
  - id: gateforge.pack-http
    version: '0.1.0'
    transport: in-process
    module: ${httpPack}
  - id: evil.plugin
    version: '0.1.0'
    transport: in-process
    module: ./evil.mjs
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
        '.gateforge/policies.yml': 'schemaVersion: 1\npolicies:\n  - id: persistence\n    when: { exposure: user-facing }\n    require: [persistence:read]\n',
        '.gateforge/classification-policy.yml': `schemaVersion: 1
scanRoots: ['src/**/*.ts']
trustedInternalEntryPoints: []
internalRules: []
coverage:
  - capability: exposure.http
    detector: evil.plugin
    appliesTo: ['src/**/*.ts']
declarations:
  internality: gateforge:internal
volatileFields: []
`,
        'src/routes.ts': "app.get('/accounts', handler);\n",
        'evil.mjs': `export default {
          discover(paths) {
            // Fake completeness: claim everything, examine nothing.
            return { resources: [], unresolved: [], findings: [], classificationSignals: [], scannedPaths: paths };
          },
        };`,
      });
      const classify = await runCli(repo, ['classify', '--json']);
      // Fails closed BEFORE discovery: an arbitrary plugin can never
      // contribute scan completeness.
      expect(classify.code).toBe(2);
      expect(classify.stderr).toContain('not a bundled Gateforge detector');
    });
  });

  it('rejects a trusted detector id aimed at a repository-local module', async () => {
    await withTempRepo({}, async (repo) => {
      const init = await runCli(repo, ['init', '--languages', 'typescript']);
      expect(init.code).toBe(0);
      repo.writeFiles({
        '.gateforge.yml': `schemaVersion: 1
project:
  languages: [typescript]
  paths:
    include: ['src/**/*.ts']
    exclude: []
plugins:
  - id: gateforge.pack-http
    version: '0.1.0'
    transport: in-process
    module: ./evil.mjs
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
        '.gateforge/policies.yml': 'schemaVersion: 1\npolicies:\n  - id: persistence\n    when: { exposure: user-facing }\n    require: [persistence:read]\n',
        '.gateforge/classification-policy.yml': `schemaVersion: 1
scanRoots: ['src/**/*.ts']
trustedInternalEntryPoints: []
internalRules: []
coverage:
  - capability: exposure.http
    detector: gateforge.pack-http
    appliesTo: ['src/**/*.ts']
declarations:
  internality: gateforge:internal
volatileFields: []
`,
        'src/routes.ts': "app.get('/accounts', handler);\n",
        'evil.mjs': `export default {
          discover(paths) {
            // Fake completeness under a TRUSTED id (A1 config control).
            return { resources: [], unresolved: [], findings: [], classificationSignals: [], scannedPaths: paths };
          },
        };`,
      });
      const classify = await runCli(repo, ['classify', '--json']);
      expect(classify.code).toBe(2);
      expect(classify.stderr).toContain('cannot contribute scan completeness');
      expect(classify.stderr).toContain('gateforge.pack-http');
    });
  });
});
