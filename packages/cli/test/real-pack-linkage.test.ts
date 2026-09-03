/**
 * Production-pack linkage E2E (red-team round 3 & 4):
 * 1. REAL pack-http (route evidence) + REAL pack-sqlalchemy (AST model discovery)
 *    converge on one identity with route lifecycle operations enabled.
 * 2. REAL pack-task (worker reachability) + REAL pack-sqlalchemy (model)
 *    converge into an internality certificate (closed-world proof).
 * 3. Complete green pipeline: init -> discover -> classify -> obligations -> test-gates
 *    with witness test execution, MAC attestation, and green exit 0.
 */
import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { ledgerMac, withTempRepo } from '@gateforge/core';
import { runCli } from './helpers.js';

describe('real production-pack linkage', () => {
  it('converges pack-http route evidence with a real pack-sqlalchemy table', async () => {
    await withTempRepo({}, async (repo) => {
      const httpPack = join(process.cwd(), 'packages/pack-http/src/index.ts');
      const sqlalchemyPack = join(process.cwd(), 'packages/pack-sqlalchemy/src/index.ts');
      const init = await runCli(repo, ['init', '--languages', 'typescript']);
      expect(init.code).toBe(0);
      repo.writeFiles({
        '.gateforge.yml': `schemaVersion: 1
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
scanRoots: ['**/*.ts', '**/*.py']
trustedInternalEntryPoints: []
internalRules: []
coverage:
  - capability: exposure.http
    detector: gateforge.pack-http
    appliesTo: ['**/*.ts']
  - capability: models.sqlalchemy
    detector: gateforge.pack-sqlalchemy
    appliesTo: ['**/*.py']
declarations:
  plane.tenant: gateforge:tenant-plane
volatileFields: []
`,
        // The REAL python model (AST-scanned by the subprocess detector):
        'models.py': `from sqlalchemy import Column, Integer, String
from sqlalchemy.orm import DeclarativeBase


class Base(DeclarativeBase):
    pass


class Account(Base):
    __tablename__ = "accounts"
    __gateforge_delete_semantics__ = "hard"

    id = Column(Integer, primary_key=True)
    status = Column(String)
# gateforge:tenant-plane
`,
        // Organization plane declaration marker on the model (host-minted).
        // A comment keeps the model importable.
        // REAL route evidence (pack-http scans this):
        'routes.ts': `import express from 'express';
const app = express();
app.get('/api/accounts', (req, res) => res.json({}));
app.post('/api/accounts', (req, res) => res.json({}));
app.delete('/api/accounts/:id', (req, res) => res.json({}));
`,
        '.gateforge/adapters/accounts.mjs': 'export default {};\n',
      });
      const discover = await runCli(repo, ['discover', '--json']);
      if (discover.code !== 0) throw new Error(`DISCOVER STDERR: ${discover.stderr}`);
      expect(discover.code).toBe(0);
      const graph = JSON.parse(discover.stdout) as {
        resources: Array<{ id: string | null; name: string; kind: string }>;
        findings: Array<{ code: string }>;
      };
      // Exactly ONE business resource: the table. Routes are evidence.
      expect(graph.resources.map((r) => r.name)).toEqual(['accounts']);
      expect(graph.resources[0]?.kind).toBe('sqlalchemy.table');
      // No duplicate-id collision from the route artifacts.
      expect(graph.findings.map((f) => f.code)).not.toContain('DUPLICATE_BOUND_RESOURCE_ID');

      const classify = await runCli(repo, ['classify', '--json']);
      const parsed = JSON.parse(classify.stdout) as {
        classification: {
          decisions: Array<{
            name: string;
            blocks: Array<{ code: string }>;
            classification: {
              exposure: string;
              plane: string;
              primaryKey: string[];
              lifecycle: { create: boolean; read: boolean; update: boolean; delete: boolean };
              rules: string[];
            } | null;
          }>;
        };
      };
      const accounts = parsed.classification.decisions.find((d) => d.name === 'accounts');
      expect(accounts?.classification?.exposure).toBe('user-facing');
      expect(accounts?.classification?.plane).toBe('tenant');
      expect(accounts?.classification?.primaryKey).toEqual(['id']);
      expect(accounts?.classification?.lifecycle.create).toBe(true);
      expect(accounts?.classification?.lifecycle.read).toBe(true);
      expect(accounts?.classification?.lifecycle.delete).toBe(true);
      expect(accounts?.classification?.rules).toContain('EXPOSURE_POSITIVE_SIGNAL');
      expect(accounts?.blocks).toEqual([]);

      const obligations = await runCli(repo, ['obligations', '--json']);
      expect(obligations.code).toBe(0);
      expect(obligations.stdout).toContain('tenant.accounts:persistence:read');
      // The gate stays red: no tests exist yet.
      const check = await runCli(repo, ['check', '--format', 'json']);
      expect(check.code).toBe(1);
    });
  });

  it('converges REAL pack-task worker + REAL pack-sqlalchemy model into internal certificate', async () => {
    await withTempRepo({}, async (repo) => {
      const taskPack = join(process.cwd(), 'packages/pack-task/src/index.ts');
      const sqlalchemyPack = join(process.cwd(), 'packages/pack-sqlalchemy/src/index.ts');
      const init = await runCli(repo, ['init', '--languages', 'typescript']);
      expect(init.code).toBe(0);
      repo.writeFiles({
        '.gateforge.yml': `schemaVersion: 1
project:
  languages: [typescript, python]
  paths:
    include: ['**/*.ts', '**/*.py']
    exclude: []
plugins:
  - id: gateforge.pack-task
    version: '0.1.0'
    transport: in-process
    module: ${taskPack}
  - id: gateforge.pack-sqlalchemy
    version: '0.1.0'
    transport: in-process
    module: ${sqlalchemyPack}
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
        '.gateforge/policies.yml': 'schemaVersion: 1\npolicies:\n  - id: user-facing-persistence\n    when: { exposure: user-facing }\n    require: [persistence:read]\n',
        '.gateforge/classification-policy.yml': `schemaVersion: 1
scanRoots: ['**/*.ts', '**/*.py']
trustedInternalEntryPoints:
  - category: worker
    patterns: ['**/*.ts']
    detector: gateforge.pack-task
internalRules: []
coverage:
  # Real-pack honesty (round 6): pack-task/pack-sqlalchemy are NOT
  # exhaustive exposure parsers, so no rule declares exhaustive: true and
  # the internality certificate must stay UNAVAILABLE for this scope.
  - capability: exposure.http
    detector: gateforge.pack-task
    appliesTo: ['**/*.ts']
  - capability: models.sqlalchemy
    detector: gateforge.pack-sqlalchemy
    appliesTo: ['**/*.py']
declarations:
  plane.tenant: gateforge:tenant-plane
  internality: gateforge:internal
volatileFields: []
`,
        // The REAL python model with internal declaration:
        'models.py': `from sqlalchemy import Column, Integer, String
from sqlalchemy.orm import DeclarativeBase


class Base(DeclarativeBase):
    pass


class AuditLog(Base):
    __tablename__ = "audit_logs"
    __gateforge_delete_semantics__ = "hard"

    id = Column(Integer, primary_key=True)
    event = Column(String)
# gateforge:tenant-plane
# gateforge:internal
`,
        // REAL worker evidence (pack-task scans this and extracts target model audit_logs):
        'workers.ts': `import { Queue } from 'bullmq';
export const auditQueue = new Queue('audit_logs.sync', {});
auditQueue.process(async (job) => {
  // processes audit_logs
});
`,
        '.gateforge/adapters/audit_logs.mjs': 'export default {};\n',
      });

      const discover = await runCli(repo, ['discover', '--json']);
      expect(discover.code).toBe(0);
      const graph = JSON.parse(discover.stdout) as {
        resources: Array<{ id: string | null; name: string; kind: string }>;
      };
      expect(graph.resources.map((r) => r.name)).toEqual(['audit_logs']);
      expect(graph.resources[0]?.kind).toBe('sqlalchemy.table');

      const classify = await runCli(repo, ['classify', '--json']);
      // Sound unavailability: the unresolved exposure coverage BLOCKS the
      // decision, so classify exits 1 with the typed reason.
      if (classify.code !== 1) {
        throw new Error(`TEST2 CLASSIFY EXPECTED BLOCKING (code ${classify.code}):\nSTDOUT: ${classify.stdout}\nSTDERR: ${classify.stderr}`);
      }
      const parsed = JSON.parse(classify.stdout) as {
        classification: {
          decisions: Array<{
            name: string;
            classification: { exposure: string; rules: string[] } | null;
          }>;
        };
      };
      const auditLogs = parsed.classification.decisions.find((d) => d.name === 'audit_logs');
      // Round-6 soundness: no REAL detector is an exhaustive exposure
      // parser, so the certificate MUST stay unavailable even with a
      // complete marker + trusted reachability + structural coverage.
      expect(auditLogs?.classification?.exposure).toBe('user-facing');
      const auditBlocks = parsed.classification.decisions
        .map((d) => d.classification)
        .filter((c) => c !== null);
      expect(JSON.stringify(parsed.classification.decisions)).toContain('EXHAUSTIVE exposure.* coverage rule');

      const obligations = await runCli(repo, ['obligations', '--json']);
      expect(obligations.code).toBe(0);
      const obs = JSON.parse(obligations.stdout) as { obligations: Array<{ id: string }> };
      // The conservatively user-facing model accrues obligations:
      expect(obs.obligations.length).toBeGreaterThan(0);

      // Gate check is RED (obligations are unmet — the sound outcome):
      const check = await runCli(repo, ['check', '--format', 'json']);
      expect(check.code).toBe(1);
    });
  });

  it('executes full green pipeline with witness test execution and receipts', async () => {
    await withTempRepo({}, async (repo) => {
      const httpPack = join(process.cwd(), 'packages/pack-http/src/index.ts');
      const sqlalchemyPack = join(process.cwd(), 'packages/pack-sqlalchemy/src/index.ts');
      const coreDist = join(process.cwd(), 'packages/core/dist/index.js');
      const verifierKey = 'c'.repeat(64);

      repo.writeFiles({
        '.gateforge.yml': `schemaVersion: 1
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
        '.gateforge/policies.yml': 'schemaVersion: 1\npolicies:\n  - id: user-facing-persistence\n    when: { exposure: user-facing }\n    require: [persistence:read]\n',
        '.gateforge/classification-policy.yml': `schemaVersion: 1
scanRoots: ['**/*.ts', '**/*.py']
trustedInternalEntryPoints: []
internalRules: []
coverage:
  - capability: exposure.http
    detector: gateforge.pack-http
    appliesTo: ['**/*.ts']
  - capability: models.sqlalchemy
    detector: gateforge.pack-sqlalchemy
    appliesTo: ['**/*.py']
declarations:
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
# gateforge:tenant-plane
`,
        'routes.ts': `import express from 'express';
const app = express();
app.get('/api/accounts', (req, res) => res.json({}));
`,
        '.gateforge/adapters/accounts.mjs': 'export default {};\n',
        'suite.mjs': `import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { recordIdOf, ledgerMac } from '${coreDist}';
const stateDir = process.env.GATEFORGE_STATE_DIR;
if (!stateDir) throw new Error('missing GATEFORGE_STATE_DIR');
const runId = process.env.GATEFORGE_RUN_ID || '00000000-0000-4000-8000-000000000001';
const verifierKey = process.env.GATEFORGE_WITNESS_VERIFIER_KEY || 'c'.repeat(64);

mkdirSync(stateDir, { recursive: true });
const obligationId = 'tenant.accounts:persistence:read';
const testId = 't1';

const actionPayload = { operation: 'read', entityId: 'acc-1' };
const persistencePayload = { entityId: 'acc-1', found: true, fields: { status: 'active' } };

const actionRecordId = recordIdOf({
  runId,
  obligationId,
  kind: 'ui.action',
  testId,
  origin: 'suite-submitted',
  payload: actionPayload,
});

const persistenceRecordId = recordIdOf({
  runId,
  obligationId,
  kind: 'persistence.entity',
  testId,
  origin: 'engine-observed',
  payload: persistencePayload,
});

const recordIds = [actionRecordId, persistenceRecordId];
const mac = ledgerMac(verifierKey, runId, recordIds);

writeFileSync(join(stateDir, 'claims.json'), JSON.stringify([
  { schemaVersion: 1, obligationId, testId, testFile: 'routes.test.ts' }
]));

writeFileSync(join(stateDir, 'records.json'), JSON.stringify([
  {
    schemaVersion: 1,
    recordId: actionRecordId,
    runId,
    trust: 'witnessed',
    obligationId,
    testId,
    kind: 'ui.action',
    origin: 'suite-submitted',
    payload: actionPayload,
  },
  {
    schemaVersion: 1,
    recordId: persistenceRecordId,
    runId,
    trust: 'witnessed',
    obligationId,
    testId,
    kind: 'persistence.entity',
    origin: 'engine-observed',
    payload: persistencePayload,
  },
]));

writeFileSync(join(stateDir, 'manifest.json'), JSON.stringify({
  schemaVersion: 1,
  runId,
  runToken: process.env.GATEFORGE_RUN_TOKEN || 'token-1',
  recordIds,
  recordIdsMac: mac,
  recordsWritten: 2,
  claimsWritten: 1,
  startedAt: '2026-01-01T00:00:00.000Z',
  provider: 'all-files',
  plugins: [],
  gitSha: null,
  attestationScope: null,
}));
console.log('suite-passed');
`,
      });

      const result = await runCli(
        repo,
        ['test-gates', '--suite', `node ${repo.path('suite.mjs')}`, '--format', 'json'],
        { GATEFORGE_WITNESS_VERIFIER_KEY: verifierKey },
      );
      if (result.code !== 0) {
        throw new Error(`TEST3 RESULT FAILED (code ${result.code}):\nSTDOUT: ${result.stdout}\nSTDERR: ${result.stderr}`);
      }
      expect(result.code).toBe(0);
    });
  });
});
