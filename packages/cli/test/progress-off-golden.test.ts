/**
 * The progress stream is OFF unless someone asks for it, and a local
 * run's bytes are exactly what they were before it existed.
 *
 * This is the golden for that claim at the CLI surface: the same
 * supervised command, the same fixture repository, the same environment
 * but for `CI`, must produce byte-identical stdout and stderr minus the
 * stream's own `gateforge:` lines. Nothing else may move — no extra
 * line, no reordered line, no changed byte.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { withTempRepo } from '@gate-forge/core';

import { installFixture, runCli } from './helpers.js';

/** Every line the progress stream owns, whatever target it writes to. */
const STREAM_LINE = /^gateforge: (run started|run finished|✓|✘|–|alive) /;

describe('the progress stream off is byte-identical', () => {
  it('adds nothing at all to a local run', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      const local = await runCli(repo, ['test-gates', '--changed', '--format', 'json'], { CI: undefined });
      const ci = await runCli(repo, ['test-gates', '--changed', '--format', 'json'], { CI: 'true' });
      // The CI run's extra output is the stream, and nothing else.
      expect(ci.stdout).toBe(local.stdout);
      const withoutStream = ci.stderr
        .split('\n')
        .filter((line) => !STREAM_LINE.test(line))
        .join('\n');
      expect(withoutStream).toBe(local.stderr);
      // A local run prints no progress line at all.
      expect(local.stderr).not.toMatch(STREAM_LINE);
    });
  });

  it('writes no failures artifact when the stream is off', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      const result = await runCli(repo, ['test-gates', '--changed', '--format', 'json'], { CI: undefined });
      expect(result.stderr).not.toMatch(STREAM_LINE);
      expect(existsSync(join(repo.root, '.gateforge', 'test-gates', 'failures.json'))).toBe(false);
    });
  });

  it('honours --progress off even under CI', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      const off = await runCli(repo, ['test-gates', '--changed', '--progress', 'off', '--format', 'json'], {
        CI: 'true',
      });
      expect(off.stderr).not.toMatch(STREAM_LINE);
    });
  });

  it('refuses an unusable --progress target instead of dropping the stream', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      const result = await runCli(repo, ['test-gates', '--changed', '--progress', 'stdout'], { CI: 'true' });
      expect(result.code).toBe(2);
      expect(result.stderr).toMatch(/--progress/);
    });
  });
});
