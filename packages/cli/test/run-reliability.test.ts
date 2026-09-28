import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureServiceLogs, postRunHealthNotices, probeHealth, runHarnessSetup, runHarnessTeardown, runPreflightCommands } from '../src/run-reliability.js';

const roots: string[] = [];

/** Creates an isolated working directory for process-level reliability tests.
 *
 * Args:
 *   none.
 *
 * Returns:
 *   string: the temporary directory path.
 */
function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'gf-reliability-'));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('run reliability preflight and health', () => {
  it('reports a failed preflight command and bounded output', async () => {
    const result = await runPreflightCommands(
      [{ name: 'cheap-check', command: "printf 'failure detail\\n'; exit 1", timeoutSeconds: 3 }],
      tempRoot(),
      process.env,
    );
    expect(result).toMatchObject({ name: 'cheap-check', exitCode: 1 });
    expect(result?.output).toContain('failure detail');
  });

  it('blocks on a closed TCP health endpoint before any suite starts', async () => {
    const result = await probeHealth(
      [{ name: 'closed-fixture', tcp: '127.0.0.1:1', timeoutSeconds: 1 }],
      tempRoot(),
      process.env,
    );
    expect(result).toMatchObject({ name: 'closed-fixture', healthy: false });
    expect(result?.reason).toMatch(/connect|refused|timeout/i);
  });

  it('fails a health probe when the configured startup log pattern is present', async () => {
    const result = await probeHealth(
      [{
        name: 'fixture-startup',
        logAbsent: { command: "printf 'S3 endpoint unreachable\\n'", pattern: 'S3 endpoint unreachable' },
      }],
      tempRoot(),
      process.env,
    );
    expect(result).toMatchObject({ name: 'fixture-startup', healthy: false });
    expect(result?.reason).toContain('pattern');
  });
  it('labels every failed test when a fixture is unhealthy at run end', () => {
    expect(postRunHealthNotices(
      { name: 'database', healthy: false, reason: 'TCP connection failed for 127.0.0.1:5432' },
      [
        { file: 'tests/accounts.spec.ts', titlePath: ['accounts', 'creates row'] },
        { file: 'tests/orders.spec.ts', titlePath: ['orders', 'loads row'] },
      ],
    )).toEqual([
      'tests/accounts.spec.ts > accounts > creates row: fixture database was down at end of run: TCP connection failed for 127.0.0.1:5432',
      'tests/orders.spec.ts > orders > loads row: fixture database was down at end of run: TCP connection failed for 127.0.0.1:5432',
    ]);
  });

  it('stops at a failing seed with its last output lines and permits teardown', async () => {
    const root = tempRoot();
    const result = await runHarnessSetup(
      {
        up: 'exit 0',
        reset: 'exit 0',
        seed: "printf 'seed failure detail\\n'; exit 7",
        health: 'exit 99',
        down: 'exit 0',
      },
      root,
      process.env,
    );
    expect(result).toMatchObject({ step: 'seed', exitCode: 7 });
    expect(result?.output).toContain('seed failure detail');
    expect(await runHarnessTeardown({ down: 'exit 0' }, root, process.env)).toBeNull();
  });

  it('captures only the configured trailing service log lines', async () => {
    const root = tempRoot();
    const artifact = await captureServiceLogs(
      { command: "printf 'first\\nsecond\\nthird\\n'", services: ['database'], lines: 2 },
      root,
      root,
      process.env,
    );
    expect(artifact).not.toBeNull();
    const content = readFileSync(artifact as string, 'utf8');
    expect(content).toContain('second');
    expect(content).toContain('third');
    expect(content).not.toContain('first');
  });
});
