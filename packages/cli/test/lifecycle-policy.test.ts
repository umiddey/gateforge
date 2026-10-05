import { join } from 'node:path';
import { existsSync, rmSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { loadConfig, withTempRepo } from '@gate-forge/core';
import { runPipeline } from '../src/pipeline.js';
import { httpRoutesView, resolveStateDir } from '../src/state.js';
import { computeInputSnapshot } from '../src/input-snapshot.js';
import { trustedPolicyDigestForConfig } from '../src/execution.js';
import {
  CLASSIFICATION_POLICY_YML,
  installFixture,
  POLICIES_YML,
} from './helpers.js';

const SQLALCHEMY_PACK = join(process.cwd(), 'packages/pack-sqlalchemy/src/index.ts');

const CRUD_POLICIES_YML = `schemaVersion: 1
policies:
  - id: full-crud
    when: { exposure: user-facing }
    require:
      - crud:create
      - crud:read
      - crud:update
      - crud:delete
      - persistence:create
      - persistence:read
      - persistence:update
      - persistence:delete
`;

function lifecyclePolicy(reason: string, resourceId = 'tenant.accounts'): string {
  return `schemaVersion: 1
trustedInternalEntryPoints: []
internalRules: []
lifecycleRules:
  - match:
      resourceId: ${resourceId}
    disable: [update, delete]
    reason: '${reason}'
`;
}

/**
 * The plane answer every fixture table shares. Since 0.11.0 the plane
 * rules are the `planes:` SECTION of the one owner-answers document, so a
 * fixture that rewrites that document has to carry the section along
 * instead of leaving it behind in a file no command reads.
 */
const PLANES_SECTION = `planes:
  rules:
    - tables:
        - accounts
        - orders
      plane: tenant
      reason: fixture data
`;

/**
 * Appends the fixture's plane answer to an owner-answers document.
 *
 * @param rules the answers document written so far
 * @returns the same document with its `planes:` section
 */
function withPlanesSection(rules: string): string {
  return `${rules}${rules.endsWith('\n') ? '' : '\n'}${PLANES_SECTION}`;
}

function installBundledFixture(repo: Parameters<typeof installFixture>[0], rules: string): void {
  repo.writeFiles({
    '.gateforge.yml': `schemaVersion: 1
project:
  languages: [python]
  paths:
    include: ['models/**/*.py']
    exclude: []
plugins:
  - id: gateforge.pack-sqlalchemy
    version: '0.2.0'
    transport: in-process
    module: ${SQLALCHEMY_PACK}
policies: .gateforge/policies.yml
classificationPolicy: .gateforge/classification-policy.yml
adapters: .gateforge/adapters
waivers: .gateforge/waivers
baselines: .gateforge/baselines/obligations.json
scan:
  scanRoots: ['models/**/*.py']
  coverage:
    - capability: models.sqlalchemy
      detector: gateforge.pack-sqlalchemy
      appliesTo: ['models/**/*.py']
  declarations: {}
  volatileFields: []
changed:
  provider: auto
witness:
  maxDurationSeconds: 5
clock:
  mode: fixed
  fixedAt: '2026-01-01T00:00:00.000Z'
`,
    '.gateforge/policies.yml': CRUD_POLICIES_YML,
    // 0.11.0: the plane answer is the `planes:` SECTION of the one
    // owner-answers document (it was `.gateforge/planes.json`).
    '.gateforge/classification-policy.yml': withPlanesSection(rules),
    '.gateforge/adapters/tenant.accounts.mjs': 'export default {}\n',
    '.gateforge/adapters/tenant.orders.mjs': 'export default {}\n',
    'models/accounts.py': `from sqlalchemy import Column, Integer
from sqlalchemy.orm import declarative_base

Base = declarative_base()

class Account(Base):
    __tablename__ = 'accounts'
    __gateforge_delete_semantics__ = 'hard'
    id = Column(Integer, primary_key=True)
`,
    'models/orders.py': `from sqlalchemy import Column, Integer
from sqlalchemy.orm import declarative_base

Base = declarative_base()

class Order(Base):
    __tablename__ = 'orders'
    __gateforge_delete_semantics__ = 'hard'
    id = Column(Integer, primary_key=True)
`,
  });
}

async function runFixture(repoRoot: string) {
  const config = loadConfig(join(repoRoot, '.gateforge.yml'));
  const previousCwd = process.cwd();
  if (previousCwd !== repoRoot) process.chdir(repoRoot);
  try {
    return {
      config,
      pipeline: await runPipeline({
        cwd: repoRoot,
        env: { ...process.env },
        config,
        provider: 'all-files',
        stateDir: resolveStateDir(repoRoot),
      }),
    };
  } finally {
    if (previousCwd !== repoRoot) process.chdir(previousCwd);
  }
}

describe('classification policy lifecycleRules pipeline', () => {
  it('mints exact-resource policy disables alongside detector derivations', async () => {
    await withTempRepo({}, async (repo) => {
      installBundledFixture(repo, lifecyclePolicy('accounting history is append-only'));
      repo.writeFiles({
        '.gateforge/policies.yml': CRUD_POLICIES_YML,
      });

      const { pipeline } = await runFixture(repo.root);
      const accounts = pipeline.classification.decisions.find((entry) => entry.name === 'accounts');
      const orders = pipeline.classification.decisions.find((entry) => entry.name === 'orders');
      expect(accounts?.classification?.lifecycle).toMatchObject({
        create: true,
        read: false,
        update: false,
        delete: false,
      });
      expect(accounts?.classification?.rules).toContain(
        'LIFECYCLE_POLICY_DISABLED(update:accounting history is append-only)',
      );
      const accountDerivations = accounts?.classification?.lifecycleDerivation?.map(
        (entry) => entry.operation,
      );
      expect(accountDerivations).toEqual(['read']);
      expect(orders?.classification?.lifecycle).toMatchObject({
        create: true,
        read: false,
        update: true,
        delete: false,
      });
      expect(pipeline.policy.obligations.map((obligation) => obligation.id)).toEqual([
        'tenant.accounts:crud:create',
        'tenant.accounts:persistence:create',
        'tenant.orders:crud:create',
        'tenant.orders:crud:update',
        'tenant.orders:persistence:create',
        'tenant.orders:persistence:update',
      ]);
      expect(pipeline.policy.blocking).toEqual([]);
    });
  });
  it('omits operations the detector facts show cannot be performed', async () => {
    await withTempRepo({}, async (repo) => {
      installBundledFixture(
        repo,
        `schemaVersion: 1
trustedInternalEntryPoints: []
internalRules: []
`,
      );
      repo.writeFiles({
        '.gateforge/policies.yml': CRUD_POLICIES_YML,
        'models/accounts.py': `from sqlalchemy import Column, Integer
from sqlalchemy.orm import declarative_base

Base = declarative_base()

class Account(Base):
    __tablename__ = 'accounts'
    __gateforge_delete_semantics__ = 'hard'
    __gateforge_updateable_fields__ = ()
    id = Column(Integer, primary_key=True)
`,
      });
      const { pipeline } = await runFixture(repo.root);
      const accountDecision = pipeline.classification.decisions.find((entry) => entry.name === 'accounts');
      expect(accountDecision?.classification?.lifecycle).toMatchObject({
        create: true,
        read: false,
        update: false,
        delete: false,
      });
      expect(accountDecision?.classification?.lifecycleDerivation).toEqual([
        {
          operation: 'read',
          disposition: 'not-observable',
          reason: 'no-read-route',
          detail: expect.any(String),
        },
        {
          operation: 'update',
          disposition: 'disabled',
          reason: 'no-updateable-fields',
          detail: expect.any(String),
        },
        {
          operation: 'delete',
          disposition: 'disabled',
          reason: 'no-delete-route-or-method',
          detail: expect.any(String),
        },
      ]);
      const accounts = pipeline.policy.obligations.filter((entry) => entry.resourceId === 'tenant.accounts');
      expect(accounts.map((entry) => entry.contract)).toContain('persistence:create');
      expect(accounts.map((entry) => entry.contract)).not.toContain('persistence:read');
      expect(accounts.map((entry) => entry.contract)).not.toContain('persistence:update');
      expect(accounts.map((entry) => entry.contract)).not.toContain('persistence:delete');
      expect(pipeline.lifecycleDerivation).toEqual([
        expect.objectContaining({
          resourceId: 'tenant.accounts',
          resourceName: 'accounts',
          operation: 'read',
          disposition: 'not-observable',
          reason: 'no-read-route',
        }),
        expect.objectContaining({
          resourceId: 'tenant.accounts',
          resourceName: 'accounts',
          operation: 'update',
          disposition: 'disabled',
          reason: 'no-updateable-fields',
        }),
        expect.objectContaining({
          resourceId: 'tenant.accounts',
          resourceName: 'accounts',
          operation: 'delete',
          disposition: 'disabled',
          reason: 'no-delete-route-or-method',
        }),
        expect.objectContaining({
          resourceId: 'tenant.orders',
          resourceName: 'orders',
          operation: 'read',
          disposition: 'not-observable',
          reason: 'no-read-route',
        }),
        expect.objectContaining({
          resourceId: 'tenant.orders',
          resourceName: 'orders',
          operation: 'delete',
          disposition: 'disabled',
          reason: 'no-delete-route-or-method',
        }),
      ]);
    });
  });

  it('blocks when a model updateable field is missing from adapter projection', async () => {
    await withTempRepo({}, async (repo) => {
      installBundledFixture(
        repo,
        `schemaVersion: 1
trustedInternalEntryPoints: []
internalRules: []
`,
      );
      const marker = repo.path('adapter-evaluated');
      repo.writeFiles({
        '.gateforge/policies.yml': CRUD_POLICIES_YML,
        '.gateforge/adapters/tenant.accounts.mjs': [
          "import { writeFileSync } from 'node:fs';",
          `writeFileSync(${JSON.stringify(marker)}, 'evaluated');`,
          "export default { fields: ['id', 'name'] };",
          '',
        ].join('\n'),
        'models/accounts.py': `from sqlalchemy import Column, Integer, String
from sqlalchemy.orm import declarative_base

Base = declarative_base()

class Account(Base):
    __tablename__ = 'accounts'
    __gateforge_delete_semantics__ = 'hard'
    __gateforge_updateable_fields__ = ('description',)
    id = Column(Integer, primary_key=True)
    description = Column(String)
`,
      });
      const { pipeline } = await runFixture(repo.root);
      expect(existsSync(marker)).toBe(false);
      const contradiction = pipeline.policy.blocking.find((entry) => entry.detail.includes('description'));
      expect(contradiction).toMatchObject({ kind: 'classification', resourceId: 'tenant.accounts' });
      expect(contradiction?.detail).toContain("field description is not exposed by adapter 'tenant.accounts' (fields: id, name)");
    });
  });
  it('reports a stale exact-resource rule instead of silently dropping it', async () => {
    await withTempRepo({}, async (repo) => {
      installBundledFixture(
        repo,
        lifecyclePolicy('removed accounting resource', 'tenant.removed_accounting_resource'),
      );
      repo.writeFiles({
        '.gateforge/policies.yml': CRUD_POLICIES_YML,
      });

      const { pipeline } = await runFixture(repo.root);
      expect(pipeline.classification.staleTargets).toHaveLength(2);
      expect(pipeline.classification.staleTargets.every((block) => block.code === 'STALE_SIGNAL_TARGET')).toBe(true);
      expect(pipeline.policy.blocking.some((entry) => entry.detail.includes('STALE_SIGNAL_TARGET'))).toBe(true);
    });
  });

  it('uses project exclusions for proof scope while keeping included coverage gaps blocking', async () => {
    await withTempRepo({}, async (repo) => {
      installBundledFixture(repo, lifecyclePolicy('excluded model is outside the scan'));
      repo.writeFiles({
        '.gateforge.yml': `schemaVersion: 1
project:
  languages: [python]
  paths:
    include: ['models/**/*.py']
    exclude: ['models/orders.py']
plugins:
  - id: gateforge.pack-sqlalchemy
    version: '0.2.0'
    transport: in-process
    module: ${SQLALCHEMY_PACK}
policies: .gateforge/policies.yml
classificationPolicy: .gateforge/classification-policy.yml
adapters: .gateforge/adapters
waivers: .gateforge/waivers
baselines: .gateforge/baselines/obligations.json
scan:
  scanRoots: ['models/**/*.py']
  coverage:
    - capability: models.sqlalchemy
      detector: gateforge.pack-sqlalchemy
      appliesTo: ['models/**/*.py']
  declarations: {}
  volatileFields: []
changed:
  provider: auto
witness:
  maxDurationSeconds: 5
clock:
  mode: fixed
  fixedAt: '2026-01-01T00:00:00.000Z'
`,
        '.gateforge/policies.yml': CRUD_POLICIES_YML,
      });
      rmSync(repo.path('.gateforge/adapters/tenant.orders.mjs'));

      const excluded = await runFixture(repo.root);
      const accounts = excluded.pipeline.classification.decisions.find(
        (entry) => entry.name === 'accounts',
      );
      expect(accounts?.classification?.lifecycle).toMatchObject({ update: false, delete: false });
      expect(excluded.pipeline.policy.blocking).toEqual([]);

      repo.writeFiles({
        '.gateforge.yml': `schemaVersion: 1
project:
  languages: [python]
  paths:
    include: ['models/**/*.py']
    exclude: []
plugins:
  - id: gateforge.pack-sqlalchemy
    version: '0.2.0'
    transport: in-process
    module: ${SQLALCHEMY_PACK}
policies: .gateforge/policies.yml
classificationPolicy: .gateforge/classification-policy.yml
adapters: .gateforge/adapters
waivers: .gateforge/waivers
baselines: .gateforge/baselines/obligations.json
scan:
  scanRoots: ['models/**/*.py']
  coverage:
    - capability: models.sqlalchemy
      detector: gateforge.pack-sqlalchemy
      appliesTo: ['models/orders.py']
  declarations: {}
  volatileFields: []
changed:
  provider: auto
witness:
  maxDurationSeconds: 5
clock:
  mode: fixed
  fixedAt: '2026-01-01T00:00:00.000Z'
`,
        // The coverage rule narrows to `models/orders.py` alone (above), so
        // `models/accounts.py` is an INCLUDED file no detector covers.
        '.gateforge/classification-policy.yml': withPlanesSection(
          lifecyclePolicy('included uncovered model must block'),
        ),
      });

      const uncovered = await runFixture(repo.root);
      expect(
        uncovered.pipeline.policy.blocking.some((entry) =>
          entry.detail.includes('INCOMPLETE_PROOF_SCOPE'),
        ),
      ).toBe(true);
    });
  });

  it('rejects invalid or duplicate lifecycle policy rules at pipeline load', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      repo.writeFiles({
        '.gateforge/classification-policy.yml': `${CLASSIFICATION_POLICY_YML}lifecycleRules:
  - match:
      resourceId: tenant.accounts*
    disable: [update]
    reason: wildcard
  - match:
      resourceId: tenant.accounts
    disable: [delete]
    reason: first
  - match:
      resourceId: tenant.accounts
    disable: [create]
    reason: duplicate
`,
      });
      await expect(runFixture(repo.root)).rejects.toThrow(/classification-policy document is invalid/);
    });
  });

  it('changes trusted policy and input snapshot digests when a lifecycle rule changes', async () => {
    await withTempRepo({}, async (repo) => {
      installBundledFixture(repo, lifecyclePolicy('append-only accounting history'));
      repo.writeFiles({
        '.gateforge/policies.yml': POLICIES_YML,
      });
      repo.stage();
      const first = await runFixture(repo.root);
      const stateDir = resolveStateDir(repo.root);
      const firstTrusted = trustedPolicyDigestForConfig(repo.root, first.config);
      const firstSnapshot = computeInputSnapshot({
        cwd: repo.root,
        config: first.config,
        stateDir,
        classifications: first.pipeline.classificationsView.resources,
        obligations: first.pipeline.policy.obligations,
        httpRoutes: httpRoutesView(first.pipeline.graph),
        plugins: first.pipeline.manifest.plugins.map((plugin) => ({
          id: plugin.id,
          version: plugin.version,
        })),
      }).inputDigest;

      repo.writeFiles({
        '.gateforge/classification-policy.yml': withPlanesSection(
          lifecyclePolicy('append-only accounting history with no updates'),
        ),
      });
      const second = await runFixture(repo.root);
      const secondTrusted = trustedPolicyDigestForConfig(repo.root, second.config);
      const secondSnapshot = computeInputSnapshot({
        cwd: repo.root,
        config: second.config,
        stateDir,
        classifications: second.pipeline.classificationsView.resources,
        obligations: second.pipeline.policy.obligations,
        httpRoutes: httpRoutesView(second.pipeline.graph),
        plugins: second.pipeline.manifest.plugins.map((plugin) => ({
          id: plugin.id,
          version: plugin.version,
        })),
      }).inputDigest;
      expect(secondTrusted).not.toBe(firstTrusted);
      expect(secondSnapshot).not.toBe(firstSnapshot);
    });
  });
});
