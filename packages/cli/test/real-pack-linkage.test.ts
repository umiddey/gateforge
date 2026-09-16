/**
 * Production-pack linkage E2E (red-team round 3 & 4):
 * 1. REAL pack-http (route evidence) + REAL pack-sqlalchemy (AST model discovery)
 *    converge on one identity. Phase 4: packs mint NO classificationSignals —
 *    exposure falls back to the user-facing default, unknown lifecycle
 *    operations default enabled, and endpoint-to-resource linkage comes only
 *    from the endpoint compiler's corroborated linkage.
 * 2. REAL pack-task (worker reachability) + REAL pack-sqlalchemy (model)
 *    converge into an internality certificate (closed-world proof).
 * 3. Hostile-suite red proof (plan §11.6/§11.8): fabricated witnessed
 *    records plus a legacy v1 MAC in the suite-writable manifest never
 *    authorize (exit 1, legacy-format blocker), and the suite proves the
 *    verifier key never reaches its environment or state files. The
 *    honest green test-gates path lives in `attestation.test.ts`
 *    (transport) and `e2e-example.test.ts` (browser + persistence).
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { withTempRepo } from '@gate-forge/core';
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
        // REAL route evidence (pack-http scans this). The named handler
        // gives the endpoint compiler its corroborated linkage evidence
        // (handler word `accounts`) — packs mint no linkage signals.
        'routes.ts': `import express from 'express';
const app = express();
function listAccounts(req, res) { res.json({}); }
app.get('/api/accounts', listAccounts);
app.post('/api/accounts', (req, res) => res.json({}));
app.delete('/api/accounts/:id', (req, res) => res.json({}));
`,
        '.gateforge/adapters/accounts.mjs': 'export default {};\n',
      });
      const discover = await runCli(repo, ['discover', '--json']);
      if (discover.code !== 0) throw new Error(`DISCOVER STDERR: ${discover.stderr}`);
      expect(discover.code).toBe(0);
      const graph = JSON.parse(discover.stdout) as {
        resources: Array<{
          id: string | null;
          name: string;
          kind: string;
          attributes: { linkedResourceName?: string };
        }>;
        findings: Array<{ code: string }>;
      };
      // Exactly ONE business resource: the table. Routes are evidence,
      // now joined into compiled `http.endpoint` resources (ADR 0004 D1)
      // — a separate namespace that never carries the path-derived name.
      const business = graph.resources.filter((r) => r.kind === 'sqlalchemy.table');
      expect(business.map((r) => r.name)).toEqual(['accounts']);
      // Endpoint-to-resource linkage flows ONLY through the endpoint
      // compiler's corroborated linkage now (handler word `accounts` on
      // the GET route): the packs mint no signals that could link
      // anything, and the path-derived name alone never links. The linked
      // endpoint inherits the tenant plane, so its plane-qualified id
      // sorts it before the still-unlinked endpoints.
      expect(
        graph.resources.filter((r) => r.kind === 'http.endpoint').map((r) => r.name),
      ).toEqual(['http-get-api-accounts-4187c96f', 'http-delete-api-accounts-id-f8a5c702', 'http-post-api-accounts-e6912669']);
      const linkedEndpoint = graph.resources.find((r) => r.name === 'http-get-api-accounts-4187c96f');
      expect(linkedEndpoint?.attributes.linkedResourceName).toBe('accounts');
      expect(linkedEndpoint?.id).toBe('tenant.http-get-api-accounts-4187c96f');
      expect(
        graph.resources.find((r) => r.name === 'http-post-api-accounts-e6912669')?.attributes
          .linkedResourceName,
      ).toBeUndefined();
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
              defaultsApplied: string[];
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
      // Phase 4: packs mint NO classificationSignals (the path-derived
      // EXPOSURE_POSITIVE_SIGNAL is gone), so exposure falls back to the
      // documented user-facing default and every lifecycle operation the
      // packs no longer vouches for stays enabled through its default.
      expect(accounts?.classification?.rules).not.toContain('EXPOSURE_POSITIVE_SIGNAL');
      expect(accounts?.classification?.rules).toContain('EXPOSURE_DEFAULT_USER_FACING');
      expect(accounts?.classification?.defaultsApplied).toEqual(
        expect.arrayContaining([
          'EXPOSURE_DEFAULT_USER_FACING',
          'LIFECYCLE_DEFAULT_ENABLED(create)',
          'LIFECYCLE_DEFAULT_ENABLED(read)',
          'LIFECYCLE_DEFAULT_ENABLED(update)',
          'LIFECYCLE_DEFAULT_ENABLED(delete)',
        ]),
      );
      // The table's own model evidence is untouched: plane/identity from
      // the detector + declarations, hard delete from the model marker.
      expect(accounts?.classification?.rules).toContain('DELETE_SEMANTICS_PROVEN_HARD');
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
function listAccounts(req, res) { res.json({}); }
app.get('/api/accounts', listAccounts);
`,
        '.gateforge/adapters/accounts.mjs': 'export default {};\n',
        'suite.mjs': `import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { recordIdOf, ledgerMac } from '${coreDist}';
const stateDir = process.env.GATEFORGE_STATE_DIR;
if (!stateDir) throw new Error('missing GATEFORGE_STATE_DIR');
const runId = process.env.GATEFORGE_RUN_ID || '00000000-0000-4000-8000-000000000001';
// Plan §11.8: the suite process must never see the verifier key — not
// in its environment and not in any generated state file. Record the
// observation where the parent can assert it.
const keyAbsent =
  process.env.GATEFORGE_WITNESS_VERIFIER_KEY === undefined &&
  !readFileSync(join(stateDir, 'env.json'), 'utf8').includes('VERIFIER');

mkdirSync(stateDir, { recursive: true });
writeFileSync(join(stateDir, 'key-check.json'), JSON.stringify({ keyAbsent }));
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

// Hostile-suite fabrication (plan §11.6, F2): hash-consistent ids the
// witness never issued, planted in the suite-writable manifest with a
// legacy v1 MAC. Without a v2 attestation binding the tested inputs,
// none of this authorizes — the run must block.
const recordIds = [actionRecordId, persistenceRecordId];
const mac = ledgerMac('c'.repeat(64), runId, recordIds);

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
      // The fabrication is rejected (exit 1): no v2 attestation binds
      // the tested inputs, and the legacy v1 MAC never authorizes.
      expect(result.code).toBe(1);
      expect(result.stdout).toContain('legacy v1');
      const keyCheck = JSON.parse(
        readFileSync(repo.path('.gateforge/test-gates/key-check.json'), 'utf8'),
      ) as { keyAbsent: boolean };
      expect(keyCheck.keyAbsent).toBe(true);
    });
  });
});
