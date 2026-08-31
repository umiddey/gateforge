/**
 * `gateforge obligations`: policy → obligation dump (ids, fingerprints
 * via the json form, coherence with discover determinism).
 */
import { describe, expect, it } from 'vitest';
import { withTempRepo } from '@gateforge/core';
import { installFixture, runCli } from './helpers.js';

describe('gateforge obligations', () => {
  it('dumps the generated obligations in text form', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      const { code, stdout } = await runCli(repo, ['obligations']);
      expect(code).toBe(0);
      expect(stdout).toContain('obligations (2):');
      expect(stdout).toContain(`  tenant.accounts:crud:read  (policy 'user-facing-crud')`);
      expect(stdout).toContain(`  tenant.orders:crud:read  (policy 'user-facing-crud')`);
      expect(stdout).toContain('blocking (0):');
    });
  });

  it('is byte-for-byte deterministic in json form', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      const first = await runCli(repo, ['obligations', '--json']);
      const second = await runCli(repo, ['obligations', '--json']);
      expect(first.code).toBe(0);
      expect(first.stdout).toBe(second.stdout);
      const policy = JSON.parse(first.stdout) as {
        obligations: Array<{ id: string; policyId: string }>;
        blocking: unknown[];
      };
      expect(policy.obligations.map((o) => o.id).sort()).toEqual([
        'tenant.accounts:crud:read',
        'tenant.orders:crud:read',
      ]);
      expect(policy.obligations.every((o) => o.policyId === 'user-facing-crud')).toBe(true);
      expect(policy.blocking).toEqual([]);
    });
  });

  it('reports unclassified resources as blocking entries', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      // Drop the orders classification: orders becomes unclassified.
      repo.writeFiles({
        '.gateforge/classifications.yml':
          'schemaVersion: 1\nresources:\n  accounts:\n    exposure: user-facing\n    plane: tenant\n    lifecycle: { create: false, read: true, update: false, delete: false }\n    primaryKey: [id]\n    evidenceAdapter: accounts\n',
      });
      const { code, stdout } = await runCli(repo, ['obligations']);
      expect(code).toBe(0);
      expect(stdout).toContain('obligations (1):');
      expect(stdout).toContain('blocking (1):');
      expect(stdout).toContain('[unclassified] orders');
    });
  });
});