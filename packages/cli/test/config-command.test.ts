import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { withTempRepo } from '@gate-forge/core';
import { configYml, runCli } from './helpers.js';

describe('gateforge config get/set/list', () => {
  it('get prints the effective value, defaults included', async () => {
    await withTempRepo({ files: { '.gateforge.yml': configYml() } }, async (repo) => {
      const result = await runCli(repo, ['config', 'get', 'http.responseShape']);
      expect(result.code).toBe(0);
      expect(result.stdout.trim()).toBe('off');
    });
  });

  it('set writes a valid value and get reads it back', async () => {
    await withTempRepo({ files: { '.gateforge.yml': configYml() } }, async (repo) => {
      const set = await runCli(repo, ['config', 'set', 'http.responseShape', 'block']);
      expect(set.code).toBe(0);
      const get = await runCli(repo, ['config', 'get', 'http.responseShape']);
      expect(get.code).toBe(0);
      expect(get.stdout.trim()).toBe('block');
    });
  });

  it('set refuses a value the schema rejects and leaves the file untouched', async () => {
    await withTempRepo({ files: { '.gateforge.yml': configYml() } }, async (repo) => {
      const before = await runCli(repo, ['config', 'get', 'http.responseShape']);
      const result = await runCli(repo, ['config', 'set', 'http.responseShape', 'sometimes']);
      expect(result.code).not.toBe(0);
      expect(result.stderr).toMatch(/responseShape/);
      const after = await runCli(repo, ['config', 'get', 'http.responseShape']);
      expect(after.stdout).toBe(before.stdout);
    });
  });

  it('get refuses an unknown key', async () => {
    await withTempRepo({ files: { '.gateforge.yml': configYml() } }, async (repo) => {
      const result = await runCli(repo, ['config', 'get', 'http.noSuchSetting']);
      expect(result.code).not.toBe(0);
      expect(result.stderr).toMatch(/http\.noSuchSetting/);
    });
  });

  it('set refuses a key the schema does not know and writes nothing', async () => {
    await withTempRepo({ files: { '.gateforge.yml': configYml() } }, async (repo) => {
      const before = readFileSync(repo.path('.gateforge.yml'), 'utf8');
      const result = await runCli(repo, ['config', 'set', 'http.noSuchSetting', 'block']);
      expect(result.code).not.toBe(0);
      expect(result.stderr).toMatch(/http\.noSuchSetting/);
      expect(readFileSync(repo.path('.gateforge.yml'), 'utf8')).toBe(before);
    });
  });

  it('list prints every effective key as key = value', async () => {
    await withTempRepo({ files: { '.gateforge.yml': configYml() } }, async (repo) => {
      const result = await runCli(repo, ['config', 'list']);
      expect(result.code).toBe(0);
      expect(result.stdout).toMatch(/^http\.responseShape = off$/m);
      expect(result.stdout).toMatch(/^http\.openapiPath = \/openapi\.json$/m);
    });
  });
});
