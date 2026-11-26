/**
 * P47 CLI end-to-end cases (plan:145-160). The bundled sqlalchemy pack reads
 * a copied fixture through `gateforge classify --json`. No mocks: the real
 * in-process detector, the real pipeline and the real policy loader run.
 */
import { counterFile, restorePath } from './internal-reachability-spawn-shim.js';
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { withTempRepo, type TempRepo } from '@gate-forge/core';
import { configYml, POLICIES_YML, runCli, type CliResult } from './helpers.js';
import { ROOT } from './witnessed-run-fixture.js';

const FIXTURE = join(ROOT, 'packages/pack-sqlalchemy/test/fixtures/reachability');
const SQL = 'gateforge.pack-sqlalchemy';
const CATEGORIES = ['migration', 'maintenance-command', 'worker'];
const TABLES = ['seed_codes', 'export_logs', 'ledger_entries', 'orphan_rows', 'route_notes', 'indirect_rows'];

const PLUGINS = `  - id: ${SQL}
    version: '0.2.0'
    transport: in-process
    module: '@gate-forge/pack-sqlalchemy'`;

const COVERAGE = `coverage:
    - capability: exposure.models
      detector: ${SQL}
      appliesTo: ['**/*.py']
      exhaustive: true
    - capability: models.sqlalchemy
      detector: ${SQL}
      appliesTo: ['**/*.py']`;

/** The trusted-internal category list; `detector` and `patterns` vary per case. */
function trusted(options: { detector?: boolean; workerPatterns?: boolean } = {}): string {
  const withDetector = options.detector ?? true;
  return CATEGORIES.map((category) => {
    const detector = withDetector ? `\n    detector: ${SQL}` : '';
    const patterns =
      options.workerPatterns === true && category === 'worker' ? "\n    patterns: ['**/jobs/**']" : '';
    return `  - category: ${category}${detector}${patterns}`;
  }).join('\n');
}

function policyYml(trustedBlock: string): string {
  const internal = TABLES.map(
    (table) =>
      `  - match:\n      resourceName: ${table}\n    reason: 'fixture: organization-declared internal table'`,
  ).join('\n');
  return `schemaVersion: 1
trustedInternalEntryPoints:
${trustedBlock}
planes:
  rules:
    - match: '**/*.py'
      plane: tenant
      reason: 'fixture: every table is tenant data'
internalRules:
${internal}
deleteRules:
  - match: app/models.py
    semantics: hard
    reason: 'fixture: hard delete'
`;
}

function writeRepoFile(repo: TempRepo, rel: string, text: string): void {
  const abs = repo.path(rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, text, 'utf8');
}

/** Copies the fixture in and writes the config, the policy and the reviewed adapters. */
function setupRepo(repo: TempRepo, policy: string): void {
  // models_admin.py and models_tenant.py both declare dup_rows. A duplicate-table
  // finding inside scanRoots fails the run-wide complete-scan attestation
  // (scan.py:1643 _duplicate_findings, classify.ts:826), which turns every
  // internal claim into INCOMPLETE_PROOF_SCOPE. The dup_rows ambiguity is pinned
  // by pack case R4 (plan line 62); the pack fixture is unchanged. Here the two
  // files are left out of the copied repo only.
  cpSync(FIXTURE, repo.root, {
    recursive: true,
    filter: (source) => !/models_(admin|tenant)\.py$/.test(source),
  });
  writeRepoFile(
    repo,
    '.gateforge.yml',
    configYml({ include: "['**/*.py']", plugins: PLUGINS, scan: { coverage: COVERAGE } }),
  );
  writeRepoFile(repo, '.gateforge/classification-policy.yml', policy);
  writeRepoFile(repo, '.gateforge/policies.yml', POLICIES_YML);
  for (const table of TABLES) writeRepoFile(repo, `.gateforge/adapters/${table}.mjs`, 'export default {};\n');
}

function classifyJson(result: CliResult): { classification: { decisions: Array<{ name: string }> } } {
  try {
    return JSON.parse(result.stdout) as {
      classification: { decisions: Array<{ name: string }> };
    };
  } catch {
    throw new Error(`classify --json printed no JSON (exit ${String(result.code)}): ${result.stderr}`);
  }
}

/** The JSON text of one resource's decision, with its blocks and classification. */
function decision(result: CliResult, name: string): string {
  const found = classifyJson(result).classification.decisions.find((d) => d.name === name);
  expect(found).toBeDefined();
  return JSON.stringify(found);
}

/** Plugin spawns logged so far. */
function spawns(counter: string): number {
  if (!existsSync(counter)) return 0;
  return readFileSync(counter, 'utf8').split('\n').filter((line) => line.includes('gateforge_sqlalchemy_detector')).length;
}

/** The additive `cache` key of `check --json`. */
function cacheOf(result: CliResult): { hits: number; misses: number } {
  if (result.stdout === '') throw new Error(`check --json wrote no stdout: ${result.stderr}`);
  const document: { cache: { hits: number; misses: number } } = JSON.parse(result.stdout);
  return document.cache;
}

describe('internal reachability end-to-end (classify --json)', () => {
  afterAll(() => {
    restorePath();
  });
  // Omits dup_rows declarations (see setupRepo and pack case R4).
  it('X1 tables reached from trusted internal entry points are internal', async () => {
    await withTempRepo({}, async (repo) => {
      setupRepo(repo, policyYml(trusted()));
      const result = await runCli(repo, ['classify', '--json']);
      for (const name of ['seed_codes', 'export_logs', 'ledger_entries']) {
        expect(decision(result, name)).toContain('"exposure":"internal"');
      }
    });
  });

  it('X2 tables with no trusted-internal reachability signal are INCOMPLETE_PROOF_SCOPE', async () => {
    await withTempRepo({}, async (repo) => {
      setupRepo(repo, policyYml(trusted()));
      const result = await runCli(repo, ['classify', '--json']);
      for (const name of ['orphan_rows', 'route_notes', 'indirect_rows']) {
        const text = decision(result, name);
        expect(text).toContain('INCOMPLETE_PROOF_SCOPE');
        expect(text).toContain('no trusted-internal reachability signal');
      }
    });
  });

  it('X3 categories listed without a detector binding never raise UNAUTHORIZED_SUPPRESSIVE_SIGNAL', async () => {
    await withTempRepo({}, async (repo) => {
      setupRepo(repo, policyYml(trusted({ detector: false })));
      const result = await runCli(repo, ['classify', '--json']);
      expect(result.stdout).not.toContain('UNAUTHORIZED_SUPPRESSIVE_SIGNAL');
      for (const name of ['seed_codes', 'export_logs', 'ledger_entries']) {
        expect(decision(result, name)).toContain('INCOMPLETE_PROOF_SCOPE');
      }
    });
  });

  it('X4 a worker pattern that matches no worker file makes its reachability untrusted', async () => {
    await withTempRepo({}, async (repo) => {
      setupRepo(repo, policyYml(trusted({ workerPatterns: true })));
      const result = await runCli(repo, ['classify', '--json']);
      const text = decision(result, 'export_logs');
      expect(text).toContain('INCOMPLETE_PROOF_SCOPE');
      expect(text).toContain('worker at app/tasks.py:');
      expect(text).toContain('trusted worker patterns: **/jobs/**');
    });
  });

  it('X7 a binding to an unknown category is a usage error that names trustedInternalEntryPoints', async () => {
    await withTempRepo({}, async (repo) => {
      setupRepo(repo, policyYml(`  - category: migrate\n    detector: ${SQL}`));
      const result = await runCli(repo, ['classify', '--json']);
      expect(result.code).toBe(2);
      expect(result.stderr).toContain('trustedInternalEntryPoints');
    });
  });

  it('X5 init reuses the classify cache entry for identical sections: no new detector spawn', async () => {
    await withTempRepo({}, async (repo) => {
      setupRepo(repo, policyYml(trusted()));
      const start = spawns(counterFile);
      await runCli(repo, ['classify', '--json']);
      const afterClassify = spawns(counterFile);
      expect(afterClassify - start, 'classify spawns').toBeGreaterThan(0);
      const init = await runCli(repo, ['init', '--no-ci', '--no-blocking']);
      expect(init.code, `${init.stdout}\n${init.stderr}`).toBe(0);
      expect(spawns(counterFile) - afterClassify, 'init spawns after classify').toBe(0);
    });
  });

  it('X6 a repeated check reuses the cache; changing a trusted binding forces a miss', async () => {
    await withTempRepo({}, async (repo) => {
      setupRepo(repo, policyYml(trusted()));
      await runCli(repo, ['check', '--format', 'json']);
      const second = cacheOf(await runCli(repo, ['check', '--format', 'json']));
      expect(second.hits).toBeGreaterThan(0);
      expect(second.misses).toBe(0);
      writeRepoFile(repo, '.gateforge/classification-policy.yml', policyYml(trusted({ workerPatterns: true })));
      const changed = cacheOf(await runCli(repo, ['check', '--format', 'json']));
      expect(changed.misses).toBeGreaterThanOrEqual(1);
    });
  });
});
