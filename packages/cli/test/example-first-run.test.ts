import { cpSync, mkdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { withTempRepo } from '@gate-forge/core';
import { runCli } from './helpers.js';

const EXAMPLE_ROOT = fileURLToPath(new URL('../../../example/', import.meta.url));
const WORKSPACE_NODE_MODULES = join(EXAMPLE_ROOT, '..', 'node_modules');

describe('example first run', () => {
  it('initializes, checks, and navigates a fresh copy without blocking', async () => {
    await withTempRepo({}, async (repo) => {
      cpSync(EXAMPLE_ROOT, repo.root, {
        recursive: true,
        filter: (source) => {
          const path = relative(EXAMPLE_ROOT, source);
          return path === '' || (!path.split(sep).includes('.git') && !path.split(sep).includes('node_modules'));
        },
      });
      const behaviorModules = repo.path('behavior/node_modules');
      mkdirSync(join(behaviorModules, '@gate-forge'), { recursive: true });
      // The physical-package check: a real consumer install materializes
      // pack-playwright's whole dependency closure, so this list has to
      // as well. `witness` is the runner-neutral package the witness
      // service moved into — omitting it is exactly the broken-install
      // shape this fixture exists to catch.
      const packages = [
        [join(EXAMPLE_ROOT, '..', 'packages', 'pack-playwright'), join(behaviorModules, '@gate-forge', 'pack-playwright')],
        [join(EXAMPLE_ROOT, '..', 'packages', 'witness'), join(behaviorModules, '@gate-forge', 'witness')],
        [join(EXAMPLE_ROOT, '..', 'packages', 'core'), join(behaviorModules, '@gate-forge', 'core')],
        ...['playwright', 'playwright-core', 'typescript', 'yaml', 'zod'].map((name) => [
          join(WORKSPACE_NODE_MODULES, name),
          join(behaviorModules, name),
        ]),
      ];
      for (const [source, destination] of packages) {
        cpSync(source as string, destination as string, { recursive: true, dereference: true });
      }
      const init = await runCli(repo, ['init', '--no-ci', '--no-blocking']);
      expect(init.code).toBe(0);
      const check = await runCli(repo, ['check']);
      expect(check.code, `${check.stdout}\n${check.stderr}`).toBe(0);
      expect(check.stdout).toContain('gateforge run: 0 obligation(s) — 0 satisfied, 0 waived, 0 blocking');
      const next = await runCli(repo, ['next']);
      expect(next.code, `${next.stdout}\n${next.stderr}`).toBe(0);
      expect(next.stdout).toContain('next: none — clean');
      repo.writeFiles({ '.gateforge/planes.json': '{"rules":[]}\n' });
      const unresolved = await runCli(repo, ['next']);
      expect(unresolved.code).toBe(1);
      expect(unresolved.stdout).toContain('which data plane owns its records?');
      expect(unresolved.stdout).toContain(
        "gateforge classify plane 'behavior/server.js' tenant --reason 'Owner review confirms the tenant plane for GET /admin/accounts.' --confirm",
      );
      expect(unresolved.stdout).toContain(
        "gateforge classify plane 'behavior/server.js' master --reason 'Owner review confirms the master plane for GET /admin/accounts.' --confirm",
      );
      expect(unresolved.stdout).toContain(
        "gateforge classify plane 'behavior/server.js' global --reason 'Owner review confirms the global plane for GET /admin/accounts.' --confirm",
      );
      expect(unresolved.stdout).toContain('Owner-only alternative');
      expect(unresolved.stdout).toContain('.gateforge/classification-policy.yml');
      expect(unresolved.stdout).toContain('internal rule is certificate-checked');
      const unresolvedJson = await runCli(repo, ['next', '--json']);
      expect(unresolvedJson.code).toBe(1);
      const parsed = JSON.parse(unresolvedJson.stdout) as { guidance: string[] };
      expect(parsed.guidance).toContain(
        "gateforge classify plane 'behavior/server.js' tenant --reason 'Owner review confirms the tenant plane for GET /admin/accounts.' --confirm",
      );
      const writer = await runCli(repo, [
        'classify',
        'plane',
        'behavior/server.js',
        'tenant',
        '--reason',
        'Owner review confirms the tenant plane for GET /admin/accounts.',
        '--confirm',
      ]);
      expect(writer.code, `${writer.stdout}\n${writer.stderr}`).toBe(0);
      const resolved = await runCli(repo, ['next']);
      expect(resolved.code, `${resolved.stdout}\n${resolved.stderr}`).toBe(0);
      expect(resolved.stdout).toContain('next: none — clean');
    });
  }, 120_000);
});
