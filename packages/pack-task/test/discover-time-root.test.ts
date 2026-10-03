/**
 * Discover-time root resolution — the staged gate's correctness hinge.
 *
 * The pack's default export is `createTaskDetector()` evaluated at MODULE
 * IMPORT (the CLI imports `@gate-forge/pack-task` statically at startup),
 * and `gateforge check --staged` moves the process cwd to the staged
 * candidate checkout before discovery runs. A detector that captured
 * `rootDir` at factory time would resolve repo-relative scan paths against
 * the loader's cwd — so the staged files would never be read and the
 * loader's own files would be scanned instead.
 *
 * The two temp projects therefore hold DIFFERENT worker files: a factory-
 * time root reports the other project's name, a discover-time root the
 * staged one. On the factory-time-capturing detector the first case FAILS.
 *
 * An explicit `rootDir` still wins.
 */
import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DiscoveryOutcome } from '@gate-forge/plugin-protocol';
import { createTaskDetector } from '../src/index.js';

const ORIGINAL_CWD = process.cwd();

/** A temp project whose `src/` holds exactly one worker module. */
function makeProject(name: string, moduleName: string): string {
  const root = mkdtempSync(join(tmpdir(), `gateforge-task-root-${name}-`));
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(
    join(root, 'src', `${moduleName}.ts`),
    [
      `import { Queue } from 'bullmq';`,
      `export const emailQueue = new Queue('email');`,
      '',
      `emailQueue.process('send', async () => {});`,
      '',
    ].join('\n'),
    'utf8',
  );
  return root;
}

const scannedOf = (outcome: DiscoveryOutcome): string[] =>
  [...((outcome.scannedPaths ?? []) as string[])].sort();

describe('createTaskDetector resolves the repo root at discover time', () => {
  it('scans the repository in force at the discover call, not at factory time', async () => {
    const factoryCwd = makeProject('factory', 'factoryWorker');
    const discoverCwd = makeProject('discover', 'stagedWorker');
    try {
      process.chdir(factoryCwd);
      const detector = createTaskDetector();
      process.chdir(discoverCwd);
      const outcome = (await detector.discover(['src'])) as DiscoveryOutcome;
      // A factory-time root would have reported `src/factoryWorker.ts`.
      expect(scannedOf(outcome)).toEqual(['src/stagedWorker.ts']);
      expect(outcome.findings).toEqual([]);
    } finally {
      process.chdir(ORIGINAL_CWD);
      rmSync(factoryCwd, { recursive: true, force: true });
      rmSync(discoverCwd, { recursive: true, force: true });
    }
  });

  it('an explicit rootDir option still wins over the cwd at discover time', async () => {
    const pinned = makeProject('pinned', 'pinnedWorker');
    const discoverCwd = makeProject('elsewhere', 'elsewhereWorker');
    try {
      const detector = createTaskDetector({ rootDir: pinned });
      process.chdir(discoverCwd);
      const outcome = (await detector.discover(['src'])) as DiscoveryOutcome;
      expect(scannedOf(outcome)).toEqual(['src/pinnedWorker.ts']);
      expect(outcome.findings).toEqual([]);
    } finally {
      process.chdir(ORIGINAL_CWD);
      rmSync(pinned, { recursive: true, force: true });
      rmSync(discoverCwd, { recursive: true, force: true });
    }
  });
});