/**
 * The undeclared runtime document (fresh-clone snag 5g):
 * `.gateforge/runtime.yml` on disk with NO `runtime:` key in
 * `.gateforge.yml` is a trusted policy input the gate commands
 * silently ignore — the owner's `envAllowlist` never reaches the
 * supervised runner, and the first symptom is a witnessed run
 * whose test process sees none of `E2E_*`. Every command that
 * loads the config must SAY so, naming the file and the exact
 * line that fixes it; `enforcement doctor` fails a row.
 *
 * The document is never read here: reading it implicitly would
 * hash different bytes into the policy digest without the owner
 * approving them, so the warning keys off the file's existence
 * and the config's declaration alone.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { withTempRepo, type TempRepo } from '@gate-forge/core';
import { installFixture, runCli } from './helpers.js';

/** The undeclared-document body (envAllowlist is the point). */
const RUNTIME_YML = 'schemaVersion: 1\nenvAllowlist: [E2E_DB_URL]\n';

/** The exact declaration line every warning names. */
const FIX_LINE = 'runtime: .gateforge/runtime.yml';

/** Appends the declaration to the fixture config (the fix). */
function declareRuntime(repo: TempRepo): void {
  const configPath = repo.path('.gateforge.yml');
  repo.writeFiles({
    '.gateforge.yml': `${readFileSync(configPath, 'utf8')}${FIX_LINE}\n`,
  });
}

describe('undeclared .gateforge/runtime.yml (the silently ignored trust input)', () => {
  it('check names the file and the exact line to add', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      repo.writeFiles({ '.gateforge/runtime.yml': RUNTIME_YML });
      const result = await runCli(repo, ['check', '--format', 'json']);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('.gateforge/runtime.yml');
      expect(result.stderr).toContain(FIX_LINE);
    });
  });

  it('next names the file and the exact line to add', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      repo.writeFiles({ '.gateforge/runtime.yml': RUNTIME_YML });
      const result = await runCli(repo, ['next']);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('.gateforge/runtime.yml');
      expect(result.stderr).toContain(FIX_LINE);
    });
  });

  it('test-gates names the file and the exact line to add', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      repo.writeFiles({ '.gateforge/runtime.yml': RUNTIME_YML });
      const result = await runCli(repo, ['test-gates', '--suite', 'exit 0']);
      expect(result.stderr).toContain('.gateforge/runtime.yml');
      expect(result.stderr).toContain(FIX_LINE);
    });
  });

  it('enforcement doctor reports it as a FAIL row and prints the warning', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      repo.writeFiles({ '.gateforge/runtime.yml': RUNTIME_YML });
      const json = await runCli(repo, ['enforcement', 'doctor', '--json']);
      expect(json.code).toBe(0);
      const report = JSON.parse(json.stdout) as {
        checks: Array<{ id: string; status: string; detail: string }>;
        ready: boolean;
      };
      const row = report.checks.find((entry) => entry.id === 'runtime-declaration');
      expect(row).toBeDefined();
      expect(row?.status).toBe('fail');
      expect(row?.detail).toContain('.gateforge/runtime.yml');
      expect(row?.detail).toContain(FIX_LINE);
      expect(report.ready).toBe(false);
      expect(json.stderr).toContain(FIX_LINE);
    });
  });

  it('stays silent when the document is declared', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      declareRuntime(repo);
      repo.writeFiles({ '.gateforge/runtime.yml': RUNTIME_YML });
      const check = await runCli(repo, ['check', '--format', 'json']);
      expect(check.stderr).not.toContain(FIX_LINE);
      const json = await runCli(repo, ['enforcement', 'doctor', '--json']);
      const report = JSON.parse(json.stdout) as {
        checks: Array<{ id: string; status: string; detail: string }>;
      };
      const row = report.checks.find((entry) => entry.id === 'runtime-declaration');
      expect(row).toBeDefined();
      expect(row?.status).toBe('ok');
      expect(row?.detail).toContain(FIX_LINE);
    });
  });

  it('stays silent when no runtime document exists', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      const check = await runCli(repo, ['check', '--format', 'json']);
      expect(check.stderr).not.toContain(FIX_LINE);
      const json = await runCli(repo, ['enforcement', 'doctor', '--json']);
      const report = JSON.parse(json.stdout) as {
        checks: Array<{ id: string; status: string; detail: string }>;
      };
      expect(report.checks.find((entry) => entry.id === 'runtime-declaration')?.status).toBe('ok');
    });
  });
});
