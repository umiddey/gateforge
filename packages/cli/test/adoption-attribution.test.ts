/**
 * Attribution of a repository's own test infrastructure (0.10.2, R3):
 * the files a first adoption commit always touches must be attributable,
 * and the ones nobody declared must stay `CHANGE_UNMAPPED`.
 *
 * Four independent seams, each tested where its decision is made:
 * - `runnerConfigPaths` — every config the runner can be pointed at, not
 *   only the one that resolved;
 * - `runtimeDeclaredInputs` — the scripts, compose overrides and env files
 *   `runtime.yml` NAMES, and nothing it does not;
 * - the input snapshot — a runtime input binds the receipt's identity;
 * - `gateforgeOwnedInput` — and, deliberately, what it must NOT claim;
 * - `computeEvaluationScope` — the import graph, not a folder name, and
 *   the honest reading of a deletion no runner ever collected.
 *
 * `engine` class: pure reads and a pure scope function; no runner spawns.
 */
import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { loadConfig, parseConfig, withTempRepo } from '@gate-forge/core';
import { configYml, currentInputDigest, installFixture } from './helpers.js';
import { computeEvaluationScope } from '../src/scope.js';
import { collectDeclaredInputs } from '../src/input-snapshot.js';
import type { GateforgeConfig } from '@gate-forge/core';
import { gateforgeOwnedInput } from '../src/gateforge-owned.js';
import { runnerConfigPaths, runtimeDeclaredInputs } from '../src/test-infrastructure.js';

/** Writes a file tree (repo-relative posix keys) into a temp directory. */
function writeTree(root: string, files: Record<string, string>): void {
  for (const [key, content] of Object.entries(files)) {
    const absolute = join(root, ...key.split('/'));
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, content, 'utf8');
  }
}

/** A temp repository root, removed by the caller. */
function makeRoot(): string {
  return mkdtempSync(join(tmpdir(), 'gateforge-adoption-'));
}

/** The minimal config the runtime-declaration reader needs. */
function runtimeConfig(): GateforgeConfig {
  return parseConfig({
    schemaVersion: 1,
    project: { languages: ['python'], paths: { include: ['src/**/*.txt'], exclude: [] } },
    plugins: [],
    policies: '.gateforge/policies.yml',
    classificationPolicy: '.gateforge/classification-policy.yml',
    adapters: '.gateforge/adapters',
    waivers: '.gateforge/waivers',
    baselines: '.gateforge/baselines/obligations.json',
    changed: { provider: 'auto' },
    runtime: '.gateforge/runtime.yml',
    witness: { maxDurationSeconds: 5 },
    clock: { mode: 'fixed', fixedAt: '2026-01-01T00:00:00.000Z' },
  });
}

describe('runner configurations: every config the runner can be pointed at', () => {
  it('resolves the canonical config, its root siblings, and a script-named one', () => {
    const root = makeRoot();
    try {
      writeTree(root, {
        'playwright.config.ts': 'export default { testDir: "." };\n',
        'playwright.config.dev-stack.ts': 'export default { testDir: "." };\n',
        'playwright.config.headed.ts': 'export default { testDir: "." };\n',
        'package.json': JSON.stringify({
          scripts: {
            'e2e': 'playwright test --config playwright.config.ts',
            'e2e:headed': 'playwright test --config=playwright.config.headed.ts',
            'lint': 'eslint . --config tools/eslint.config.js',
          },
        }),
        'tools/eslint.config.js': 'export default [];\n',
      });
      const paths = runnerConfigPaths(root, 'playwright');
      expect(paths).toEqual(
        expect.arrayContaining(['playwright.config.ts', 'playwright.config.dev-stack.ts', 'playwright.config.headed.ts']),
      );
      // The lint config is named by a script too, so a change to it is
      // attributable as runner configuration rather than unmapped.
      expect(paths).toContain('tools/eslint.config.js');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('never reports a config the repository does not have', () => {
    const root = makeRoot();
    try {
      writeTree(root, { 'package.json': '{"scripts":{"e2e":"playwright test --config playwright.config.ts"}}' });
      expect(runnerConfigPaths(root, 'playwright')).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('runtime-declared inputs: what `runtime.yml` NAMES, and only that', () => {
  it('attributes the declared runner script, compose override and env file', () => {
    const root = makeRoot();
    try {
      writeTree(root, {
        '.gateforge/runtime.yml': [
          'schemaVersion: 1',
          'services_up:',
          '  commands:',
          '    - ["bash", "scripts/e2e/run.sh", "--profile", "ci"]',
          'reset:',
          '  commands:',
          '    - ["docker", "compose", "-f", "docker-compose.e2e.yml", "down", "-v"]',
          'env_files:',
          '  - .gateforge/e2e.env',
          '',
        ].join('\n'),
        '.gateforge/e2e.env': 'E2E_PROFILE=ci\n',
        'scripts/e2e/run.sh': '#!/usr/bin/env bash\n',
        'docker-compose.e2e.yml': 'services: {}\n',
        'docker-compose.prod.yml': 'services: {}\n',
        'scripts/other/thing.sh': '#!/usr/bin/env bash\n',
      });
      const paths = runtimeDeclaredInputs(root, runtimeConfig());
      expect(paths).toEqual(
        expect.arrayContaining(['scripts/e2e/run.sh', 'docker-compose.e2e.yml', '.gateforge/e2e.env']),
      );
      // An UNDECLARED stack file can change what runs by being picked up
      // elsewhere; it is not test infrastructure the gate may excuse.
      expect(paths).not.toContain('docker-compose.prod.yml');
      expect(paths).not.toContain('scripts/other/thing.sh');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('declares nothing when the repository stages no runtime', () => {
    const root = makeRoot();
    try {
      writeTree(root, { 'scripts/e2e/run.sh': '#!/usr/bin/env bash\n' });
      expect(runtimeDeclaredInputs(root, runtimeConfig())).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('the depth-one dotenv is a RUNTIME input, never an owner-pinned one', () => {
  it('is not classified as a Gateforge-owned policy input', () => {
    const config = runtimeConfig();
    // It is NOT in the owner-approved policy digest and NOT a policy
    // input: a port changes far too often to justify a re-pin. Calling it
    // one would make it unpinned, unsnapshotted and invisible — a free
    // pass, not attribution.
    expect(gateforgeOwnedInput('.gateforge/e2e.env', config)).toBeNull();
    expect(gateforgeOwnedInput('.gateforge/.env', config)).toBeNull();
  });

  it('expands the scope when it changes, because the run reads it', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      const config = loadConfig(`${repo.root}/.gateforge.yml`);
      const decision = computeEvaluationScope({
        config,
        changedFiles: ['.gateforge/e2e.env'],
        runtimeInputs: ['.gateforge/e2e.env'],
        strictE2E: true,
      });
      expect(decision.mode).toBe('all');
      expect(decision.expandedBecause).toEqual(['.gateforge/e2e.env']);
      expect(decision.unmappedFiles).toEqual([]);
    });
  });

  it('joins the input snapshot, so changing it changes the receipt identity', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      repo.writeFiles({ '.gateforge.yml': `runtime: .gateforge/runtime.yml\n${configYml()}` });
      repo.writeFiles({
        '.gateforge/runtime.yml': ['schemaVersion: 1', 'env_files:', '  - .gateforge/e2e.env', ''].join('\n'),
        '.gateforge/e2e.env': 'E2E_PROFILE=ci\n',
      });
      const config = loadConfig(`${repo.root}/.gateforge.yml`);
      expect(collectDeclaredInputs(repo.root, config)).toContain('.gateforge/e2e.env');
      const before = await currentInputDigest(repo);
      repo.writeFiles({ '.gateforge/e2e.env': 'E2E_PROFILE=headed\n' });
      // The receipt must bind the bytes the run actually read.
      expect(await currentInputDigest(repo)).not.toBe(before);
    });
  });

  it('records a declared env file that does not exist yet as an absence', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      repo.writeFiles({ '.gateforge.yml': `runtime: .gateforge/runtime.yml\n${configYml()}` });
      repo.writeFiles({
        '.gateforge/runtime.yml': ['schemaVersion: 1', 'env_files:', '  - .gateforge/e2e.env', ''].join('\n'),
      });
      const config = loadConfig(`${repo.root}/.gateforge.yml`);
      // Creating it later must change the receipt's identity, so the
      // missing state is declared rather than silently absent.
      expect(collectDeclaredInputs(repo.root, config)).toContain('absent:.gateforge/e2e.env');
    });
  });
});

describe('scope: the import graph, not a folder name', () => {
  it('attributes a helper a catalog test imports and leaves an unimported folder unmapped', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      const config = loadConfig(`${repo.root}/.gateforge.yml`);
      const attributed = computeEvaluationScope({
        config,
        changedFiles: ['tests/e2e/support/fixtures.ts'],
        testFiles: ['tests/e2e/real/accounts.spec.ts'],
        testInfrastructureFiles: ['tests/e2e/support/fixtures.ts'],
        strictE2E: true,
      });
      expect(attributed.mode).toBe('all');
      expect(attributed.expandedBecause).toEqual(['test-infra:tests/e2e/support/fixtures.ts']);
      expect(attributed.unmappedFiles).toEqual([]);

      // The same path in a repository whose catalog imports NOTHING from
      // it: a folder called `support` is not test infrastructure.
      const unattributed = computeEvaluationScope({
        config,
        changedFiles: ['tests/e2e/support/fixtures.ts'],
        testFiles: ['tests/e2e/real/accounts.spec.ts'],
        testInfrastructureFiles: [],
        strictE2E: true,
      });
      expect(unattributed.unmappedFiles).toEqual(['tests/e2e/support/fixtures.ts']);
    });
  });
});

describe('scope: the first adoption commit\'s whole file set', () => {
  it('attributes every infrastructure file except the documentation edit', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      const config = loadConfig(`${repo.root}/.gateforge.yml`);
      const decision = computeEvaluationScope({
        config,
        changedFiles: [
          'package.json',
          'package-lock.json',
          '.gateforge.yml',
          '.gateforge/test-map.yml',
          'playwright.config.ts',
          'playwright.config.e2e.ts',
          'tests/e2e/real/accounts.spec.ts',
          'tests/e2e/support/fixtures.ts',
          'scripts/e2e/run.sh',
          'docker-compose.e2e.yml',
          '.gateforge/e2e.env',
          'docs/testing/e2e.md',
        ],
        testFiles: ['tests/e2e/real/accounts.spec.ts'],
        runnerConfigs: ['playwright.config.ts', 'playwright.config.e2e.ts'],
        testInfrastructureFiles: ['tests/e2e/support/fixtures.ts'],
        runtimeInputs: ['scripts/e2e/run.sh', 'docker-compose.e2e.yml', '.gateforge/e2e.env'],
        mappingSidecar: true,
        strictE2E: true,
      });
      // Every expansion input is named, so the message a reader gets says
      // exactly which files demanded the full scope.
      expect(decision.expandedBecause).toEqual(
        expect.arrayContaining([
          'package-lock.json',
          'package.json',
          '.gateforge.yml',
          '.gateforge/test-map.yml',
          'playwright.config.ts',
          'playwright.config.e2e.ts',
          'test:tests/e2e/real/accounts.spec.ts',
          'test-infra:tests/e2e/support/fixtures.ts',
          'scripts/e2e/run.sh',
          'docker-compose.e2e.yml',
          '.gateforge/e2e.env',
        ]),
      );
      // The dotenv is a runtime input: attributable and scope-expanding,
      // because the supervised run reads it. It is NOT an owner-pinned
      // policy document, so it must not be excused the way one is.
      expect(decision.policyInputs).toEqual([]);
      // Only the documentation edit stays unmapped — the one refusal the
      // engine owns by design (a mixed docs+code commit is never
      // docs-only).
      expect(decision.unmappedFiles).toEqual(['docs/testing/e2e.md']);
    });
  });

  it('keeps an UNDECLARED compose override unmapped', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      const config = loadConfig(`${repo.root}/.gateforge.yml`);
      const decision = computeEvaluationScope({
        config,
        changedFiles: ['docker-compose.prod.yml'],
        runtimeInputs: ['docker-compose.e2e.yml'],
        strictE2E: true,
      });
      expect(decision.unmappedFiles).toEqual(['docker-compose.prod.yml']);
      expect(decision.expandedBecause).toEqual(['unclassified:docker-compose.prod.yml']);
    });
  });
});

describe('scope: a deletion the runner never collected', () => {
  it('neither expands the scope nor blocks as unmapped', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      const config = loadConfig(`${repo.root}/.gateforge.yml`);
      const removed = computeEvaluationScope({
        config,
        changedFiles: ['.merge-review-main-variants/accounts.spec.js'],
        removedUnclaimedFiles: ['.merge-review-main-variants/accounts.spec.js'],
        strictE2E: true,
      });
      expect(removed.mode).toBe('changed');
      expect(removed.expandedBecause).toEqual([]);
      expect(removed.unmappedFiles).toEqual([]);
    });
  });

  it('leaves a collected test file\'s deletion to every other rule', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      const config = loadConfig(`${repo.root}/.gateforge.yml`);
      // A spec a runner DOES collect is not in `removedUnclaimedFiles`;
      // deleting it must still be visible, not silently exempt.
      const decision = computeEvaluationScope({
        config,
        changedFiles: ['tests/e2e/real/accounts.spec.ts'],
        testFiles: [],
        removedUnclaimedFiles: [],
        strictE2E: true,
      });
      expect(decision.unmappedFiles).toEqual(['tests/e2e/real/accounts.spec.ts']);
    });
  });
});