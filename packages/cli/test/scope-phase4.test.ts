/**
 * Phase 4 conservative scope-expansion tests (plan 2026-09-13 Phase 4
 * item 2, E15): test-only, test-fixture/helper, mapping-sidecar,
 * runner-config, and (strict E2E mode) unclassified changes expand
 * `check --changed` to the full relevant suite; an unclassified change
 * additionally surfaces as a `CHANGE_UNMAPPED` blocking entry unless a
 * mapping sidecar covers it. Known-source changes keep the narrow scope.
 */
import { describe, expect, it } from 'vitest';
import { loadConfig, withTempRepo } from '@gate-forge/core';
import { installFixture, runCli } from './helpers.js';
import { computeEvaluationScope } from '../src/scope.js';

describe('Phase 4: conservative expansion inputs (E15)', () => {
  it('a test-only change expands to the full suite (test:<file> reason)', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      const config = loadConfig(`${repo.root}/.gateforge.yml`);
      const decision = computeEvaluationScope({
        config,
        changedFiles: ['e2e/accounts.spec.ts'],
        testFiles: ['e2e/accounts.spec.ts', 'e2e/orders.spec.ts'],
      });
      expect(decision.mode).toBe('all');
      expect(decision.expandedBecause).toEqual(['test:e2e/accounts.spec.ts']);
    });
  });

  it('a fixture/helper change in a test directory expands without being a catalog file', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      const config = loadConfig(`${repo.root}/.gateforge.yml`);
      const decision = computeEvaluationScope({
        config,
        changedFiles: ['e2e/fixtures/entity-registry.js'],
        testFiles: ['e2e/accounts.spec.ts'],
      });
      expect(decision.mode).toBe('all');
      expect(decision.expandedBecause).toEqual(['test-infra:e2e/fixtures']);
    });
  });

  it('a runner-config change expands (playwright.config.ts)', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      const config = loadConfig(`${repo.root}/.gateforge.yml`);
      const decision = computeEvaluationScope({
        config,
        changedFiles: ['playwright.config.ts'],
        runnerConfigs: ['playwright.config.ts'],
      });
      expect(decision.mode).toBe('all');
      expect(decision.expandedBecause).toEqual(['playwright.config.ts']);
    });
  });

  it('a mapping-sidecar change expands; sidecar coverage of a file does not excuse other unmapped files', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      const config = loadConfig(`${repo.root}/.gateforge.yml`);
      const decision = computeEvaluationScope({
        config,
        changedFiles: ['.gateforge/test-map.yml'],
        mappingSidecar: true,
      });
      expect(decision.mode).toBe('all');
      expect(decision.expandedBecause).toEqual(['.gateforge/test-map.yml']);
    });
  });

  it('a known source-only change keeps the narrowed scope even with Phase 4 inputs present', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      const config = loadConfig(`${repo.root}/.gateforge.yml`);
      const decision = computeEvaluationScope({
        config,
        changedFiles: ['src/orders.txt'],
        testFiles: ['e2e/accounts.spec.ts'],
        runnerConfigs: ['playwright.config.ts'],
        mappingSidecar: true,
        knownSourceFiles: ['src/accounts.txt', 'src/orders.txt'],
      });
      expect(decision.mode).toBe('changed');
      expect(decision.expandedBecause).toEqual([]);
      expect(decision.unmappedFiles).toEqual([]);
    });
  });

  it('strict E2E mode: an unclassified change expands AND surfaces as unmapped; non-strict keeps history', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      const config = loadConfig(`${repo.root}/.gateforge.yml`);
      const strict = computeEvaluationScope({
        config,
        changedFiles: ['src/mystery.js'],
        knownSourceFiles: ['src/accounts.txt'],
        strictE2E: true,
      });
      expect(strict.mode).toBe('all');
      expect(strict.expandedBecause).toEqual(['unclassified:src/mystery.js']);
      expect(strict.unmappedFiles).toEqual(['src/mystery.js']);
      // Non-strict: the historical narrowed contract is unchanged and no
      // unmapped set is produced.
      const nonStrict = computeEvaluationScope({
        config,
        changedFiles: ['src/mystery.js'],
        knownSourceFiles: ['src/accounts.txt'],
        strictE2E: false,
      });
      expect(nonStrict.mode).toBe('changed');
      expect(nonStrict.unmappedFiles).toEqual([]);
    });
  });

  it('`check --changed` under strict mode blocks an unclassified change with CHANGE_UNMAPPED', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      // Turn strict E2E on (the strict mode itself is Phase-0-tested; here
      // it only enables the conservative-expansion surface).
      const { readFileSync, writeFileSync } = await import('node:fs');
      const configPath = `${repo.root}/.gateforge.yml`;
      writeFileSync(
        configPath,
        `${readFileSync(configPath, 'utf8')}enforcement:\n  strictE2E: true\n`,
        'utf8',
      );
      repo.commitFiles({}, 'base');
      // src/mystery.js is changed (staged, like the local-staged provider
      // reads) and no detector/resource join or mapping covers it →
      // conservative expansion + CHANGE_UNMAPPED, blocking.
      repo.writeFiles({ 'src/mystery.js': 'export const mystery = 1;\n' });
      repo.stage(['src/mystery.js']);
      const result = await runCli(repo, ['check', '--changed']);
      expect(result.code).toBe(1);
      expect(result.stdout).toMatch(/CHANGE_UNMAPPED/);
      expect(result.stdout).toMatch(/src\/mystery\.js/);
    });
  });
});
