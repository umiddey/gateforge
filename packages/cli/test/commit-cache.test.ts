/**
 * Commit-time check reuse (plan 20260928_1430): per-step `--timing`
 * observability and the spawn-count contract — an unchanged second
 * `check --changed` run must reuse the cached detector and pytest
 * collection results instead of re-spawning the same work. The cache
 * result must equal a fresh full scan, and one changed input byte must
 * force a miss (full scan).
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { withTempRepo, type TempRepo } from '@gate-forge/core';
import {
  configYml,
  installFixture,
  OBLIGATION_ACCOUNTS,
  PLUGIN_SOURCE,
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

/** The counting collector: one spawn line per invocation + a fixed node id. */
function countingCollectorScript(collectorCounter: string): string {
  return [
    `open(${JSON.stringify(collectorCounter)}, 'a').write('spawn\\n')`,
    `print('tests/test_cache.py::test_covers_cache')`,
  ].join('\n');
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
    '.gitignore': '.gateforge/test-gates/\n',
    '.gateforge/counting-collector.py': countingCollectorScript(collectorCounter),
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

  it('reuses the cached detector result on an unchanged second run', async () => {
    const counterDir = mkdtempSync(join(tmpdir(), 'gateforge-cache-reuse-'));
    try {
      await withTempRepo({}, async (repo) => {
        installFixture(repo);
        const fixture = installCountingFixture(repo, counterDir);
        repo.stage();
        repo.commit('candidate');
        const first = await runCli(repo, ['check', '--changed', '--timing', '--format', 'json'], { CI: undefined });
        expect(first.code, `${first.stdout}\n${first.stderr}`).toBe(1);
        expect(countSpawns(fixture.detectorCounter)).toBe(1);
        expect(first.stdout).toContain('"cache":{"hits":0,"misses":2}');

        // Identical inputs: the second commit-time run must reuse the
        // cached detector AND pytest collection results, and its report
        // must equal the fresh one (modulo the per-run manifest run id,
        // which is a fresh UUID).
        const second = await runCli(repo, ['check', '--changed', '--timing', '--format', 'json'], { CI: undefined });
        expect(second.code, `${second.stdout}\n${second.stderr}`).toBe(1);
        expect(countSpawns(fixture.detectorCounter)).toBe(1);
        expect(countSpawns(fixture.collectorCounter)).toBe(1);
        expect(first.stdout).toContain('"timing":');
        expect(second.stdout).toContain('"timing":');
        expect(second.stdout).toContain('"cache":{"hits":2,"misses":0}');
        const stripRunId = (report: string): unknown => {
          const document = JSON.parse(report) as {
            run?: { runId?: string };
            cache?: { hits: number; misses: number };
            timing?: { detectorsMs: number; collectionMs: number; tsScanMs: number; planningMs: number; totalMs: number };
          };
          if (document.run !== undefined) delete document.run.runId;
          // Cache accounting and timings vary by run; verdict and all
          // other consumer-visible results must remain identical.
          delete document.cache;
          delete document.timing;
          return document;
        };
        expect(stripRunId(second.stdout)).toStrictEqual(stripRunId(first.stdout));
      });
    } finally {
      rmSync(counterDir, { recursive: true, force: true });
    }
  }, 120_000);

  it('reuses the cached in-process plugin result and refuses it after the module changes', async () => {
    const markerDir = mkdtempSync(join(tmpdir(), 'gateforge-cache-inproc-'));
    try {
      await withTempRepo({}, async (repo) => {
        installFixture(repo);
        const marker = join(markerDir, 'inproc-ran');
        // The marker write lives INSIDE discover(): Node caches a module
        // instance per URL for the whole process, so a top-level write
        // would count imports, not fresh discoveries.
        const markerPluginSource =
          PLUGIN_SOURCE.replace(
            "import { readFileSync } from 'node:fs';",
            "import { appendFileSync, readFileSync } from 'node:fs';",
          ).replace(
            '    return { resources, unresolved: [], findings: [], classificationSignals, scannedPaths };',
            `    appendFileSync(${JSON.stringify(marker)}, 'ran\\n');\n` +
            '    return { resources, unresolved: [], findings: [], classificationSignals, scannedPaths };',
          );
        repo.writeFiles({
          '.gitignore': '.gateforge/test-gates/\n',
          'plugin.mjs': markerPluginSource,
        });
        repo.stage();
        repo.commit('candidate');
        const first = await runCli(repo, ['check', '--format', 'json'], { CI: undefined });
        expect(first.code, `${first.stdout}\n${first.stderr}`).toBe(1);
        expect(readFileSync(marker, 'utf8').split('\n').filter((line) => line === 'ran')).toHaveLength(1);

        const second = await runCli(repo, ['check', '--format', 'json'], { CI: undefined });
        expect(second.code, `${second.stdout}\n${second.stderr}`).toBe(1);
        expect(readFileSync(marker, 'utf8').split('\n').filter((line) => line === 'ran')).toHaveLength(1);
        expect(second.stdout).toContain('"cache":{"hits":1,"misses":0}');

        // A changed plugin module must invalidate its cached result (the
        // marker write stays so the fresh discovery is still observable).
        repo.writeFiles({
          'plugin.mjs': `${markerPluginSource}// comment changes the module bytes\n`,
        });
        repo.stage();
        repo.commit('plugin change');
        const third = await runCli(repo, ['check', '--format', 'json'], { CI: undefined });
        expect(third.code, `${third.stdout}\n${third.stderr}`).toBe(1);
        expect(readFileSync(marker, 'utf8').split('\n').filter((line) => line === 'ran')).toHaveLength(2);
        expect(third.stdout).toContain('"cache":{"hits":0,"misses":1}');
      });
    } finally {
      rmSync(markerDir, { recursive: true, force: true });
    }
  }, 120_000);

  it('forces a full scan when one input byte changes', async () => {
    const counterDir = mkdtempSync(join(tmpdir(), 'gateforge-cache-byte-'));
    try {
      await withTempRepo({}, async (repo) => {
        installFixture(repo);
        const fixture = installCountingFixture(repo, counterDir);
        repo.stage();
        repo.commit('candidate');
        const first = await runCli(repo, ['check', '--changed', '--format', 'json'], { CI: undefined });
        expect(first.code, `${first.stdout}\n${first.stderr}`).toBe(1);
        expect(countSpawns(fixture.detectorCounter)).toBe(1);
        expect(countSpawns(fixture.collectorCounter)).toBe(1);
        repo.writeFiles({ 'src/accounts.txt': 'accounts fixture.table # touched\n' });
        repo.stage();
        const second = await runCli(repo, ['check', '--changed', '--format', 'json'], { CI: undefined });
        expect(second.code, `${second.stdout}\n${second.stderr}`).toBe(1);
        expect(countSpawns(fixture.detectorCounter)).toBe(2);
        expect(countSpawns(fixture.collectorCounter)).toBe(1);
        expect(second.stdout).toContain('"cache":{"hits":1,"misses":1}');
      });
    } finally {
      rmSync(counterDir, { recursive: true, force: true });
    }
  }, 120_000);

  it('recollects pytest when any python byte changes even with unchanged sources', async () => {
    const counterDir = mkdtempSync(join(tmpdir(), 'gateforge-cache-py-'));
    try {
      await withTempRepo({}, async (repo) => {
        installFixture(repo);
        const fixture = installCountingFixture(repo, counterDir);
        repo.stage();
        repo.commit('candidate');
        const first = await runCli(repo, ['check', '--changed', '--format', 'json'], { CI: undefined });
        expect(first.code, `${first.stdout}\n${first.stderr}`).toBe(1);
        expect(countSpawns(fixture.collectorCounter)).toBe(1);

        // Any .py byte (here: the suite's own collector script) invalidates
        // the collection cache — app code can change test ids.
        repo.writeFiles({
          '.gateforge/counting-collector.py': `${countingCollectorScript(fixture.collectorCounter)}\n# touched\n`,
        });
        repo.stage();
        repo.commit('touch a python byte');
        const second = await runCli(repo, ['check', '--changed', '--format', 'json'], { CI: undefined });
        expect(second.code, `${second.stdout}\n${second.stderr}`).toBe(1);
        expect(countSpawns(fixture.collectorCounter)).toBe(2);
        expect(second.stdout).toContain('"cache":{"hits":1,"misses":1}');
      });
    } finally {
      rmSync(counterDir, { recursive: true, force: true });
    }
  }, 120_000);

  it('invalidates subprocess detector and pytest caches when detector source bytes change', async () => {
    const counterDir = mkdtempSync(join(tmpdir(), 'gateforge-cache-detector-source-'));
    try {
      await withTempRepo({}, async (repo) => {
        installFixture(repo);
        const fixture = installCountingFixture(repo, counterDir);
        repo.stage();
        repo.commit('candidate');
        const first = await runCli(repo, ['check', '--changed', '--format', 'json'], { CI: undefined });
        expect(first.code, `${first.stdout}\n${first.stderr}`).toBe(1);
        expect(countSpawns(fixture.detectorCounter)).toBe(1);
        expect(countSpawns(fixture.collectorCounter)).toBe(1);

        const detectorScript = readFileSync(join(repo.root, '.gateforge/counting-detector.py'), 'utf8');
        repo.writeFiles({ '.gateforge/counting-detector.py': `${detectorScript}# source byte changed\n` });
        repo.stage();
        repo.commit('change detector source');
        const second = await runCli(repo, ['check', '--changed', '--format', 'json'], { CI: undefined });
        expect(second.code, `${second.stdout}\n${second.stderr}`).toBe(1);
        expect(countSpawns(fixture.detectorCounter)).toBe(2);
        expect(countSpawns(fixture.collectorCounter)).toBe(2);
        expect(second.stdout).toContain('"cache":{"hits":0,"misses":2}');
      });
    } finally {
      rmSync(counterDir, { recursive: true, force: true });
    }
  }, 120_000);

  it('forces a full scan under GATEFORGE_NO_CACHE and on a corrupt cache entry', async () => {
    const counterDir = mkdtempSync(join(tmpdir(), 'gateforge-cache-kill-'));
    try {
      await withTempRepo({}, async (repo) => {
        installFixture(repo);
        const fixture = installCountingFixture(repo, counterDir);
        repo.stage();
        repo.commit('candidate');
        const first = await runCli(repo, ['check', '--changed', '--format', 'json'], { CI: undefined });
        expect(first.code, `${first.stdout}\n${first.stderr}`).toBe(1);
        expect(countSpawns(fixture.detectorCounter)).toBe(1);

        // Kill switch: no read, no write — a fresh detector run.
        const killed = await runCli(repo, ['check', '--changed'], {
          CI: undefined,
          GATEFORGE_NO_CACHE: '1',
        });
        expect(killed.code, `${killed.stdout}\n${killed.stderr}`).toBe(1);
        expect(countSpawns(fixture.detectorCounter)).toBe(2);

        // Corrupt entries: any doubt is a miss, never a wrong reuse.
        const cacheDir = join(repo.root, '.gateforge', 'test-gates', 'cache', 'plugin');
        const pytestCacheDir = join(repo.root, '.gateforge', 'test-gates', 'cache', 'pytest');
        for (const dir of [cacheDir, pytestCacheDir]) {
          const entries = readdirSync(dir);
          expect(entries.length).toBeGreaterThan(0);
          for (const entry of entries) {
            writeFileSync(join(dir, entry), '{ not json');
          }
        }
        const corrupted = await runCli(repo, ['check', '--changed', '--format', 'json'], { CI: undefined });
        expect(corrupted.code, `${corrupted.stdout}\n${corrupted.stderr}`).toBe(1);
        expect(countSpawns(fixture.detectorCounter)).toBe(3);
        expect(countSpawns(fixture.collectorCounter)).toBe(3);
        expect(corrupted.stdout).toContain('"cache":{"hits":0,"misses":2}');
      });
    } finally {
      rmSync(counterDir, { recursive: true, force: true });
    }
  }, 120_000);
});
