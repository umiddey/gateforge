/**
 * Commit-time check reuse (plan 20260928_1430): per-step `--timing`
 * observability and the spawn-count contract — an unchanged second
 * `check --changed` run must reuse the cached detector and pytest
 * collection results instead of re-spawning the same work. The cache
 * result must equal a fresh full scan, and one changed input byte must
 * force a miss (full scan).
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { withTempRepo, type TempRepo } from '@gate-forge/core';
import {
  configYml,
  installFixture,
  OBLIGATION_ACCOUNTS,
  pythonPluginBlock,
  referenceDetectorPath,
  runCli,
} from './helpers.js';

/** Counting fixture paths: one spawn counter per measured child. */
interface CountingFixture {
  /** Absolute counter file with one `spawn` line per detector run. */
  detectorCounter: string;
  /** Absolute counter file with one `spawn` line per collector run. */
  collectorCounter: string;
}

/** Reads a newline-per-spawn counter file; absent file means 0 spawns. */
function countSpawns(counterPath: string): number {
  try {
    return readFileSync(counterPath, 'utf8').split('\n').filter((line) => line === 'spawn').length;
  } catch {
    return 0;
  }
}

/**
 * Installs the reuse fixture: the standard fixture project with its
 * in-process plugin replaced by a COUNTING subprocess python detector,
 * plus one counting pytest diagnostic suite whose collected node id is
 * mapped in the tracked sidecar (so the check mapping pass collects
 * pytest). Counters live OUTSIDE the repo so they never enter the input
 * snapshot.
 *
 * Args:
 *   repo: fixture repository (installFixture already applied).
 *   counterDir: absolute directory for the spawn counter files.
 *
 * Returns:
 *   CountingFixture: counter readers for detector and collector spawns.
 */
function installCountingFixture(repo: TempRepo, counterDir: string): CountingFixture {
  const detectorCounter = join(counterDir, 'detector-counts');
  const collectorCounter = join(counterDir, 'collector-counts');
  const counterDirLiteral = JSON.stringify(counterDir);
  const detectorRelativePath = '.gateforge/counting-detector.py';
  const detectorSource = [
    'from pathlib import Path',
    'import runpy',
    `Path(${JSON.stringify(detectorCounter)}).open('a').write('spawn\\n')`,
    `runpy.run_path(${JSON.stringify(referenceDetectorPath())}, run_name='__main__')`,
  ].join('\n');
  const subprocessPlugin = pythonPluginBlock().replace(
    JSON.stringify(referenceDetectorPath()),
    JSON.stringify(detectorRelativePath),
  );
  const collectorSource = [
    `open(${JSON.stringify(collectorCounter)}, 'a').write('spawn\\n')`,
    `print('tests/test_cache.py::test_covers_cache')`,
  ].join('\n');
  repo.writeFiles({
    '.gateforge.yml': `${configYml({ plugins: subprocessPlugin })}diagnostics:
  suites:
    - name: backend-pytest
      runner: pytest
      cwd: .
      argv: ['python3', '.gateforge/counting-collector.py']
      testPaths: ['tests']
      timeoutMs: 15000
`,
    '.gateforge/counting-collector.py': collectorSource,
    [detectorRelativePath]: detectorSource,
    '.gateforge/test-map.yml': [
      'schemaVersion: 1',
      'tests:',
      '  - key: pytest:backend-pytest:tests/test_cache.py:test_covers_cache',
      '    selector:',
      '      runner: pytest',
      '      file: tests/test_cache.py',
      '      titlePath:',
      '        - test_covers_cache',
      '    kind: unit',
      `    claims:`,
      `      - ${OBLIGATION_ACCOUNTS}`,
      '    reason: The counting collector proves pytest collection reuse.',
    ].join('\n'),
  });
  return { detectorCounter, collectorCounter };
}

describe('commit-time check reuse (plan 20260928_1430)', () => {
  it('reports per-step timings behind --timing (json and text)', async () => {
    const counterDir = mkdtempSync(join(tmpdir(), 'gateforge-cache-timing-'));
    try {
      await withTempRepo({}, async (repo) => {
        installFixture(repo);
        const fixture = installCountingFixture(repo, counterDir);
        repo.stage();
        repo.commit('candidate');
        const result = await runCli(
          repo,
          ['check', '--changed', '--timing', '--format', 'json'],
          { CI: undefined },
        );
        expect(result.code, `${result.stdout}\n${result.stderr}`).toBe(1);
        const report = JSON.parse(result.stdout) as {
          timing?: {
            detectorsMs: number;
            collectionMs: number;
            tsScanMs: number;
            planningMs: number;
            totalMs: number;
          };
        };
        expect(report.timing).toBeDefined();
        expect(report.timing?.detectorsMs ?? -1).toBeGreaterThanOrEqual(0);
        expect(report.timing?.collectionMs ?? -1).toBeGreaterThanOrEqual(0);
        expect(report.timing?.tsScanMs ?? -1).toBeGreaterThanOrEqual(0);
        expect(report.timing?.planningMs ?? -1).toBeGreaterThanOrEqual(0);
        expect(report.timing?.totalMs ?? -1).toBeGreaterThanOrEqual(report.timing?.detectorsMs ?? -1);
        expect(countSpawns(fixture.detectorCounter)).toBe(1);
        expect(countSpawns(fixture.collectorCounter)).toBe(1);
      });
    } finally {
      rmSync(counterDir, { recursive: true, force: true });
    }
  }, 120_000);

  it('reports the timing line in text format', async () => {
    const counterDir = mkdtempSync(join(tmpdir(), 'gateforge-cache-timing-text-'));
    try {
      await withTempRepo({}, async (repo) => {
        installFixture(repo);
        installCountingFixture(repo, counterDir);
        repo.stage();
        repo.commit('candidate');
        const result = await runCli(repo, ['check', '--changed', '--timing'], { CI: undefined });
        expect(result.code, result.stderr).toBe(1);
        expect(result.stdout).toMatch(
          /timing: detectors=\d+ms collection=\d+ms tsScan=\d+ms planning=\d+ms total=\d+ms/,
        );
      });
    } finally {
      rmSync(counterDir, { recursive: true, force: true });
    }
  }, 120_000);
});
