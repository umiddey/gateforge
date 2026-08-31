/**
 * `gateforge test-gates`: the orchestration surface G6 consumes —
 * run-state materialization (manifest, obligations with fingerprints,
 * env contract), suite execution with the ambient env, post-suite
 * verdict evaluation, and failure propagation.
 */
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RunManifestSchema, withTempRepo, fingerprint } from '@gateforge/core';
import { fixtureFingerprint, installFixture, runCli } from './helpers.js';

/** A stub suite: reports one claimed ui.action record for the target. */
const SUITE_SOURCE = `import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
const stateDir = process.env.GATEFORGE_STATE_DIR;
if (!stateDir) throw new Error('missing GATEFORGE_STATE_DIR');
mkdirSync(stateDir, { recursive: true });
const obligationId = process.env.GATEFORGE_TARGET || 'tenant.accounts:crud:read';
writeFileSync(join(stateDir, 'claims.json'), JSON.stringify([
  { schemaVersion: 1, obligationId, testId: 'suite-test', testFile: 'tests/accounts.spec.ts' },
]));
writeFileSync(join(stateDir, 'records.json'), JSON.stringify([
  {
    schemaVersion: 1,
    recordId: 'b'.repeat(64),
    runId: '00000000-0000-4000-8000-000000000002',
    trust: 'claimed',
    obligationId,
    testId: 'suite-test',
    kind: 'ui.action',
    payload: { operation: 'read', entityId: 'acc-1' },
  },
]));
console.log('suite-ran');
`;

describe('gateforge test-gates', () => {
  it('materializes the run state (manifest, obligations, env) before evaluating', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      repo.commitFiles({}, 'base');
      const { code, stdout } = await runCli(repo, ['test-gates', '--format', 'json']);
      expect(code).toBe(1); // no claims → obligations missing

      const stateDir = repo.path('.gateforge/test-gates');
      expect(existsSync(join(stateDir, 'manifest.json'))).toBe(true);
      expect(existsSync(join(stateDir, 'obligations.json'))).toBe(true);
      expect(existsSync(join(stateDir, 'env.json'))).toBe(true);
      expect(existsSync(join(stateDir, 'report.json'))).toBe(true);

      const manifest = RunManifestSchema.parse(
        JSON.parse(readFileSync(join(stateDir, 'manifest.json'), 'utf8')),
      );
      expect(manifest.provider).toBe('all-files');
      expect(manifest.plugins).toEqual([
        { id: 'fixture.plugin', version: '1.0.0', transport: 'in-process' },
      ]);
      expect(manifest.gitSha).toMatch(/^[0-9a-f]{40}$/);

      const obligations = JSON.parse(
        readFileSync(join(stateDir, 'obligations.json'), 'utf8'),
      ) as { obligations: Array<{ id: string; fingerprint: string; source: string }> };
      expect(obligations.obligations.map((o) => o.id).sort()).toEqual([
        'tenant.accounts:crud:read',
        'tenant.orders:crud:read',
      ]);
      expect(obligations.obligations[0]?.fingerprint).toBe(
        fixtureFingerprint('tenant.accounts'),
      );
      expect(obligations.obligations[0]?.source).toBe('src/accounts.txt');

      const env = JSON.parse(readFileSync(join(stateDir, 'env.json'), 'utf8')) as Record<
        string,
        string | null
      >;
      expect(typeof env['GATEFORGE_RUN_ID']).toBe('string');
      expect(typeof env['GATEFORGE_RUN_TOKEN']).toBe('string');
      expect(env['GATEFORGE_RUN_TOKEN']).toBeTruthy();
      expect(env['GATEFORGE_STATE_DIR']).toBe(stateDir);
      expect(env['GATEFORGE_OBLIGATIONS']).toBe(join(stateDir, 'obligations.json'));
      expect(env['GATEFORGE_WITNESS_URL']).toBeNull();

      // report.json is the canonical json-format report.
      const report = JSON.parse(readFileSync(join(stateDir, 'report.json'), 'utf8')) as {
        summary: { blocking: number };
      };
      expect(report.summary.blocking).toBe(2);
      // stdout carried the passed format (json).
      expect(stdout).toContain('"schemaVersion":1');
    });
  });

  it('runs the suite with the ambient env and evaluates its claims/records (GF-23)', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      repo.writeFiles({ 'suite.mjs': SUITE_SOURCE });
      const { code, stdout, stderr } = await runCli(repo, [
        'test-gates',
        '--suite',
        `node ${repo.path('suite.mjs')}`,
        '--format',
        'json',
      ]);
      expect(stderr).toBe('');
      // Claimed-only evidence degrades to invalid (GF-23) → exit 1.
      expect(code).toBe(1);
      expect(stdout).toContain('suite-ran');
      const report = JSON.parse((stdout.trim().split('\n').at(-1) ?? '') as string) as {
        verdicts: Array<{ obligationId: string; verdict: string; recordIds: string[] }>;
      };
      const accounts = report.verdicts.find(
        (v) => v.obligationId === 'tenant.accounts:crud:read',
      );
      expect(accounts?.verdict).toBe('invalid');
      expect(accounts?.recordIds).toEqual(['b'.repeat(64)]);
    });
  });

  it('fails the run when the suite exits nonzero, even with clean verdicts', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      // Waive every obligation AND make the suite fail: the suite failure
      // must still surface as exit 1.
      repo.writeFiles({
        '.gateforge/waivers/accounts.json': JSON.stringify({
          schemaVersion: 1,
          owner: 'team',
          justificationUrl: 'https://example.invalid/justification',
          approver: 'approver@example.invalid',
          scope: {
            kind: 'exact',
            resourceId: 'tenant.accounts',
            fingerprint: fixtureFingerprint('tenant.accounts'),
          },
          expiresAt: '2027-01-01T00:00:00.000Z',
        }),
        '.gateforge/waivers/orders.json': JSON.stringify({
          schemaVersion: 1,
          owner: 'team',
          justificationUrl: 'https://example.invalid/justification',
          approver: 'approver@example.invalid',
          scope: {
            kind: 'exact',
            resourceId: 'tenant.orders',
            fingerprint: fixtureFingerprint('tenant.orders'),
          },
          expiresAt: '2027-01-01T00:00:00.000Z',
        }),
      });
      const { code, stderr } = await runCli(repo, ['test-gates', '--suite', 'exit 3']);
      expect(code).toBe(1);
      expect(stderr).toContain('suite exited with status 3');
    });
  });

  it('supports an explicit --out state directory and adopts a wired witness run identity', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      // A live stub witness: /health answers with the runId the CLI
      // must adopt (fail-closed contract); /records answers empty.
      const stubRunId = '11111111-2222-4333-8444-555555555555';
      const stub = createServer((req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          req.url === '/health'
            ? JSON.stringify({ ok: true, runId: stubRunId })
            : JSON.stringify({ records: [] }),
        );
      });
      await new Promise<void>((resolve) => stub.listen(0, '127.0.0.1', resolve));
      const stubPort = (stub.address() as { port: number }).port;
      const witnessUrl = `http://127.0.0.1:${stubPort}`;
      const out = 'custom-state';
      const { code } = await runCli(repo, [
        'test-gates',
        '--out',
        out,
        '--witness-url',
        witnessUrl,
        '--run-token',
        'stub-token',
      ]);
      expect(code).toBe(1);
      const stateDir = repo.path(out);
      const env = JSON.parse(readFileSync(join(stateDir, 'env.json'), 'utf8')) as Record<
        string,
        string | null
      >;
      expect(env['GATEFORGE_STATE_DIR']).toBe(stateDir);
      expect(env['GATEFORGE_WITNESS_URL']).toBe(witnessUrl);
      // The CLI adopted the witness's run identity, not its own.
      expect(env['GATEFORGE_RUN_ID']).toBe(stubRunId);
      const manifest = JSON.parse(
        readFileSync(join(stateDir, 'manifest.json'), 'utf8'),
      ) as { runId?: string };
      expect(manifest.runId).toBe(stubRunId);
      // The default state dir was not created.
      expect(existsSync(repo.path('.gateforge/test-gates'))).toBe(false);
      stub.close();
    });
  });

  it('exposes real fingerprints the suite can verify against', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      const { code } = await runCli(repo, ['test-gates', '--format', 'json']);
      expect(code).toBe(1);
      const document = JSON.parse(
        readFileSync(repo.path('.gateforge/test-gates/obligations.json'), 'utf8'),
      ) as {
        obligations: Array<{ id: string; resourceId: string; lifecycle: unknown; fingerprint: string }>;
      };
      for (const entry of document.obligations) {
        // The stored fingerprint equals pin #2 computed from the document.
        const recomputed = fingerprint({
          resourceId: entry.resourceId,
          contract: entry.id.slice(entry.id.indexOf(':') + 1),
          policyId: 'user-facing-crud',
          lifecycle: entry.lifecycle as {
            create: boolean;
            read: boolean;
            update: boolean;
            delete: boolean;
          },
        });
        expect(entry.fingerprint).toBe(recomputed);
      }
    });
  });
});