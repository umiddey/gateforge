/**
 * `gateforge init`: generation, idempotence, and the no-overwrite rule
 * (plan Phase 2 verification).
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { withTempRepo, loadConfig } from '@gateforge/core';
import { runCli } from './helpers.js';

const TARGETS = [
  '.gateforge.yml',
  '.gateforge/policies.yml',
  '.gateforge/classifications.yml',
  '.gateforge/baselines/obligations.json',
];

describe('gateforge init', () => {
  it('generates the config, documents, and skeleton dirs', async () => {
    await withTempRepo({}, async (repo) => {
      const { code, stdout } = await runCli(repo, ['init']);
      expect(code).toBe(0);
      for (const target of TARGETS) {
        expect(existsSync(repo.path(target)), `${target} exists`).toBe(true);
        expect(stdout).toContain(`created: ${repo.path(target)}`);
      }
      expect(existsSync(repo.path('.gateforge/adapters'))).toBe(true);
      expect(existsSync(repo.path('.gateforge/waivers'))).toBe(true);
      // The generated config must be loadable by the pinned schema.
      expect(() => loadConfig(join(repo.root, '.gateforge.yml'))).not.toThrow();
    });
  });

  it('is idempotent and never overwrites user files', async () => {
    await withTempRepo({}, async (repo) => {
      const first = await runCli(repo, ['init']);
      expect(first.code).toBe(0);

      // The user edits the generated config; init must leave it alone.
      const configPath = repo.path('.gateforge.yml');
      const userEdit = readFileSync(configPath, 'utf8') + '\n# user customization\nlanguages: [ruby]\n';
      repo.writeFiles({ '.gateforge.yml': userEdit });

      const second = await runCli(repo, ['init']);
      expect(second.code).toBe(0);
      expect(second.stdout).not.toContain('created:');
      expect(second.stdout).toContain('exists, leaving untouched');
      expect(readFileSync(configPath, 'utf8')).toBe(userEdit);
    });
  });

  it('honors --languages and rejects an empty list', async () => {
    await withTempRepo({}, async (repo) => {
      const { code, stdout } = await runCli(repo, ['init', '--languages', 'python,node']);
      expect(code).toBe(0);
      const config = readFileSync(repo.path('.gateforge.yml'), 'utf8');
      expect(config).toContain('- python');
      expect(config).toContain('- node');
      expect(stdout).toContain('created:');
    });
    await withTempRepo({}, async (repo) => {
      const { code, stderr } = await runCli(repo, ['init', '--languages', ' , ']);
      expect(code).toBe(2);
      expect(stderr).toContain('--languages');
    });
  });

  it('keeps existing skeleton files when the config is regenerated', async () => {
    await withTempRepo({}, async (repo) => {
      const first = await runCli(repo, ['init']);
      expect(first.code).toBe(0);
      // A waiver file the user dropped into the skeleton survives init.
      repo.writeFiles({ '.gateforge/waivers/custom.json': '{"user": true}' });
      const second = await runCli(repo, ['init']);
      expect(second.code).toBe(0);
      expect(readFileSync(repo.path('.gateforge/waivers/custom.json'), 'utf8')).toBe(
        '{"user": true}',
      );
    });
  });
});