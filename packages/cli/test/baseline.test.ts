/**
 * `gateforge baseline update`: strict-subset semantics (invariant 4) —
 * GF-07 reject, GF-08 pass, missing-file fail-closed, writer output.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { withTempRepo } from '@gateforge/core';
import { fixtureFingerprint, installFixture, runCli } from './helpers.js';

const baselinePath = '.gateforge/baselines/obligations.json';

function writeBaseline(repo: { writeFiles: (files: Record<string, string>) => void }, fingerprints: string[]): void {
  const sorted = [...fingerprints].sort();
  repo.writeFiles({
        [baselinePath]: `${JSON.stringify({ schemaVersion: 1, fingerprints: sorted }, null, 2)}\n`,
  });
}

describe('gateforge baseline update', () => {
  it('accepts a strict-subset shrink (GF-08) and writes the new file', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      const accountsFp = fixtureFingerprint('tenant.accounts');
      const ordersFp = fixtureFingerprint('tenant.orders');
      writeBaseline(repo, [accountsFp, ordersFp]);

      const { code, stdout } = await runCli(repo, ['baseline', 'update', accountsFp]);
      expect(code).toBe(0);
      expect(stdout).toContain('baseline updated: 1 fingerprint(s) (was 2)');
      const next = JSON.parse(readFileSync(repo.path(baselinePath), 'utf8')) as {
        fingerprints: string[];
      };
      expect(next.fingerprints).toEqual([accountsFp]);
    });
  });

  it('rejects a laundering update that adds fingerprints (GF-07) → exit 2, file untouched', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      const accountsFp = fixtureFingerprint('tenant.accounts');
      const ordersFp = fixtureFingerprint('tenant.orders');
      writeBaseline(repo, [accountsFp, ordersFp]);

      const { code, stderr } = await runCli(repo, [
        'baseline',
        'update',
        accountsFp,
        'c'.repeat(64),
      ]);
      expect(code).toBe(2);
      expect(stderr).toContain('not a strict subset');
      expect(stderr).toContain('added 1 new fingerprint');
      // The file is unchanged.
      const next = JSON.parse(readFileSync(repo.path(baselinePath), 'utf8')) as {
        fingerprints: string[];
      };
            expect(next.fingerprints).toEqual([accountsFp, ordersFp].sort());
    });
  });

  it('rejects an equal-size update (nothing resolved) → exit 2', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      const accountsFp = fixtureFingerprint('tenant.accounts');
      writeBaseline(repo, [accountsFp]);
      const { code, stderr } = await runCli(repo, ['baseline', 'update', accountsFp]);
      expect(code).toBe(2);
      expect(stderr).toContain('not a strict subset');
    });
  });

  it('fails closed when the baseline file is missing → exit 2', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      const { code, stderr } = await runCli(repo, [
        'baseline',
        'update',
        fixtureFingerprint('tenant.accounts'),
      ]);
      expect(code).toBe(2);
      expect(stderr).toContain('could not be loaded');
    });
  });

  it('requires at least one fingerprint and a known subcommand', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      const empty = await runCli(repo, ['baseline', 'update']);
      expect(empty.code).toBe(2);
      expect(empty.stderr).toContain('requires at least one fingerprint');

      const unknown = await runCli(repo, ['baseline', 'capture']);
      expect(unknown.code).toBe(2);
      expect(unknown.stderr).toContain("unknown baseline subcommand 'capture'");
    });
  });
});