/**
 * CLI dispatch: usage, version, unknown commands, unknown flags, exit
 * codes, and the in-process main() contract.
 */
import { describe, expect, it } from 'vitest';
import { withTempRepo } from '@gateforge/core';
import { main, USAGE, CaptureStream, VERSION, type Io } from '../src/index.js';

async function run(argv: readonly string[], cwd = process.cwd()): Promise<{ code: number; stdout: string; stderr: string }> {
  const stdout = new CaptureStream();
  const stderr = new CaptureStream();
  const io: Io = { cwd, env: process.env, stdout, stderr };
  const code = await main(argv, io);
  return { code, stdout: stdout.text(), stderr: stderr.text() };
}

describe('gateforge main', () => {
  it('prints usage with exit 0 for --help, -h, help, and empty argv', async () => {
    expect((await run(['--help'])).code).toBe(0);
    expect((await run(['-h'])).stdout).toContain('usage: gateforge');
    expect((await run(['help'])).stdout).toBe(USAGE + '\n');
    expect((await run([])).stdout).toBe(USAGE + '\n');
  });

  it('prints the version with exit 0', async () => {
    const result = await run(['--version']);
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe(VERSION);
  });

  it('rejects unknown commands with exit 2', async () => {
    const result = await run(['frobnicate']);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("unknown command 'frobnicate'");
  });

  it('unknown command without config never touches the filesystem', async () => {
    const result = await run(['frobnicate'], '/nonexistent-cwd');
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("unknown command 'frobnicate'");
  });

  it('missing config is a fail-closed exit 2 for engine commands', async () => {
    await withTempRepo({}, async (repo) => {
      const result = await run(['check'], repo.root);
      expect(result.code).toBe(2);
      expect(result.stderr).toContain('cannot read config file');
    });
  });
});