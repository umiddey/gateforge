/**
 * In-process transport suite: the pack's TS discover entry (the CLI
 * `transport: in-process, module: "@gate-forge/pack-sqlalchemy"` contract)
 * and the configurable tenant/master plane mapping.
 *
 * The in-process entry spawns the SAME python detector over a hardened
 * GPP/3 session, so its output must be byte-identical to the subprocess
 * transport for the same paths (one detector implementation, both
 * transports). Plane attribution is unit-tested against a temp project
 * carrying `.gateforge.yml` + a classifications file (the "mapping from
 * the project config" surface).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, copyFileSync, cpSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { DetectorOutputSchema, type Resource } from '@gate-forge/core';
import { fileURLToPath } from 'node:url';
import defaultPack, {
  byTableName,
  createSqlalchemyDetector,
  pythonEnvironment,
} from '../src/index.js';
import { ALL_FIXTURES, FIXTURE_ROOT, runDiscover } from './helpers.js';

const ORIGINAL_CWD = process.cwd();

/** The full `.gateforge.yml` document (frozen pin-#6 shape). */
const GATEFORGE_YML = `schemaVersion: 1
project:
  languages: [python]
  paths:
    include: ['**/*.py']
    exclude: []
plugins:
  - id: gateforge.pack-sqlalchemy
    version: 0.1.0
    transport: in-process
    module: '@gate-forge/pack-sqlalchemy'
policies: policies.yml
classifications: classifications.yml
adapters: .gateforge/adapters
waivers: .gateforge/waivers
baselines: .gateforge/baselines/obligations.json
scan:
  scanRoots: ['**/*.py']
  declarations:
    internality: gateforge:internal
  volatileFields: []
changed:
  provider: auto
witness:
  maxDurationSeconds: 30
clock:
  mode: system
`;

/** Classifies the example accounts table onto the master plane. */
const CLASSIFICATIONS_YML = `schemaVersion: 1
resources:
  accounts:
    exposure: user-facing
    plane: master
    lifecycle: { create: true, read: true, update: true, delete: true, deleteSemantics: archive, archiveFields: { status: archived } }
    primaryKey: [id]
    evidenceAdapter: example.accounts
`;

describe('in-process transport (default export)', () => {
  beforeEach(() => {
    process.chdir(FIXTURE_ROOT);
  });
  afterEach(() => {
    process.chdir(ORIGINAL_CWD);
  });

  it('emits byte-identical discovery to the subprocess transport', async () => {
    const inProcess = await defaultPack.discover([...ALL_FIXTURES]);
    const subprocess = await runDiscover(ALL_FIXTURES);
    expect(JSON.stringify(inProcess)).toBe(JSON.stringify(subprocess));
  }, 60_000);

  it('output validates against the pinned DetectorOutputSchema', async () => {
    const outcome = await defaultPack.discover(['example_models.py']);
    const parsed = DetectorOutputSchema.safeParse({
      detectorId: 'gateforge.pack-sqlalchemy',
      detectorVersion: '0.1.0',
      ...outcome,
    });
    expect(parsed.success).toBe(true);
  }, 60_000);

  it('returns an empty outcome for an empty path list (no spawn)', async () => {
    const outcome = await defaultPack.discover([]);
    expect(outcome).toEqual({ resources: [], unresolved: [], findings: [], classificationSignals: [] });
  });

  it('ignores obsolete project classification files', async () => {
    const project = mkdtempSync(join(tmpdir(), 'gateforge-pack-'));
    try {
      writeFileSync(join(project, '.gateforge.yml'), GATEFORGE_YML);
      writeFileSync(join(project, 'classifications.yml'), CLASSIFICATIONS_YML);
      copyFileSync(join(FIXTURE_ROOT, 'example_models.py'), join(project, 'example_models.py'));
      process.chdir(project);
      const detector = createSqlalchemyDetector();
      const outcome = await detector.discover(['example_models.py']);
      const account = (outcome.resources as Resource[]).find(
        (r) => r.kind === 'sqlalchemy.table' && r.attributes['resourceName'] === 'accounts',
      );
      expect(account?.attributes['plane']).toBeUndefined();
    } finally {
      process.chdir(ORIGINAL_CWD);
      rmSync(project, { recursive: true, force: true });
    }
  }, 60_000);

  it('attaches no plane when the project carries no classifications mapping', async () => {
    const outcome = await defaultPack.discover(['example_models.py']);
    const account = (outcome.resources as Resource[]).find(
      (r) => r.kind === 'sqlalchemy.table' && r.attributes['resourceName'] === 'accounts',
    );
    expect(account?.attributes['plane']).toBeUndefined();
  }, 60_000);
  it('does not write bytecode while launching the detector', async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'gateforge-sqlalchemy-bytecode-'));
    const packageCopy = join(tempRoot, 'gateforge_sqlalchemy_detector');
    const protocolCopy = join(tempRoot, 'gateforge_plugin');
    const previousBytecodeSetting = process.env['PYTHONDONTWRITEBYTECODE'];
    delete process.env['PYTHONDONTWRITEBYTECODE'];
    try {
      cpSync(fileURLToPath(new URL('../python/gateforge_sqlalchemy_detector', import.meta.url)), packageCopy, {
        recursive: true,
        filter: (source) => !source.split(sep).includes('__pycache__') && !/\.(?:pyc|pyo)$/.test(source),
      });
      cpSync(fileURLToPath(new URL('../../plugin-protocol/python/gateforge_plugin', import.meta.url)), protocolCopy, {
        recursive: true,
        filter: (source) => !source.split(sep).includes('__pycache__') && !/\.(?:pyc|pyo)$/.test(source),
      });
      process.chdir(FIXTURE_ROOT);
      const detector = createSqlalchemyDetector({ env: pythonEnvironment([tempRoot]) });
      await detector.discover(['example_models.py']);
      expect(existsSync(join(packageCopy, '__pycache__'))).toBe(false);
      expect(existsSync(join(protocolCopy, '__pycache__'))).toBe(false);
    } finally {
      if (previousBytecodeSetting === undefined) delete process.env['PYTHONDONTWRITEBYTECODE'];
      else process.env['PYTHONDONTWRITEBYTECODE'] = previousBytecodeSetting;
      process.chdir(ORIGINAL_CWD);
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});

describe('plane mapping (programmatic rules)', () => {
  beforeEach(() => {
    process.chdir(FIXTURE_ROOT);
  });
  afterEach(() => {
    process.chdir(ORIGINAL_CWD);
  });

  it('byTableName maps the accounts table to the tenant plane', async () => {
    const detector = createSqlalchemyDetector({ plane: byTableName({ accounts: 'tenant' }) });
    const outcome = await detector.discover(['example_models.py']);
    const account = (outcome.resources as Resource[]).find(
      (r) => r.kind === 'sqlalchemy.table' && r.attributes['resourceName'] === 'accounts',
    ) as { attributes: Record<string, unknown> };
    expect(account.attributes['plane']).toBe('tenant');
  }, 60_000);

  it('leaves unmapped tables without a plane (graph classifies alone)', async () => {
    const detector = createSqlalchemyDetector({ plane: byTableName({}) });
    const outcome = await detector.discover(['example_models.py']);
    const account = (outcome.resources as Resource[]).find(
      (r) => r.kind === 'sqlalchemy.table' && r.attributes['resourceName'] === 'accounts',
    ) as { attributes: Record<string, unknown> };
    expect(account.attributes['plane']).toBeUndefined();
  }, 60_000);

});