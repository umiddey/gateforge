/**
 * `gateforge coverage draft` (plan 2026-10-18): the read-only command
 * prints a paste-ready `coveragePolicy:` block with one entry per
 * inventory table and its lifecycle-enabled operations, the emitted YAML
 * parses through the production `CoveragePolicySchema`, `--json` prints
 * the same policy as canonical JSON, and NOTHING is written to disk —
 * declaring the policy is the owner's act, never the agent's.
 */
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { CoveragePolicySchema, withTempRepo } from '@gate-forge/core';
import { installFixture, runCli } from '../../test/helpers.js';

/** Recursively collects every file path under a directory (relative, sorted). */
function allFiles(root: string, dir: string = root, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) allFiles(root, full, out);
    else out.push(full.slice(root.length + 1));
  }
  return out.sort();
}

describe('gateforge coverage draft (plan 2026-10-18)', () => {
  it('prints a paste-ready coveragePolicy block that parses through CoveragePolicySchema', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      const { code, stdout } = await runCli(repo, ['coverage', 'draft']);
      expect(code).toBe(0);
      expect(stdout).toContain('owner review required; pasting it is the owner act; repin afterwards');
      expect(stdout).toMatch(/^coveragePolicy:\n  tables:\n/m);
      // Both fixture tables, sorted by name, each with its lifecycle ops.
      expect(stdout).toContain('- name: accounts');
      expect(stdout).toContain('- name: orders');
      expect(stdout.indexOf('- name: accounts')).toBeLessThan(stdout.indexOf('- name: orders'));
      // The block after the header comment is exactly the paste-ready YAML.
      const yaml = stdout.split('\n').filter((line) => !line.startsWith('#')).join('\n');
      const document = parseYaml(yaml) as { coveragePolicy: unknown };
      const policy = CoveragePolicySchema.parse(document.coveragePolicy);
      expect(policy.tables.map((table) => table.name)).toEqual(['accounts', 'orders']);
      expect(policy.tables[0]?.requiredOperations).toContain('delete');
    });
  });

  it('--json prints the canonical policy document', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      const { code, stdout } = await runCli(repo, ['coverage', 'draft', '--json']);
      expect(code).toBe(0);
      const parsed = CoveragePolicySchema.parse(JSON.parse(stdout));
      expect(parsed.tables.map((table) => table.name)).toEqual(['accounts', 'orders']);
      expect(stdout).toBe(`${JSON.stringify(JSON.parse(stdout))}\n`); // canonical: sorted keys, no spaces
    });
  });

  it('never writes any file into the repository', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      repo.commitFiles({}, 'base');
      const before = allFiles(repo.root);
      const { code } = await runCli(repo, ['coverage', 'draft']);
      expect(code).toBe(0);
      expect(allFiles(repo.root)).toEqual(before);
    });
  });

  it('refuses an unknown subcommand (exit 2)', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      const { code, stderr } = await runCli(repo, ['coverage', 'apply']);
      expect(code).toBe(2);
      expect(stderr).toContain('gateforge coverage draft');
    });
  });
});
