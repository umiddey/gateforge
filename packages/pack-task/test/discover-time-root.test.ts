/**
 * Discover-time root resolution — the staged gate's correctness hinge.
 *
 * The pack's default export is `createTaskDetector()` evaluated at MODULE
 * IMPORT (the CLI imports `@gate-forge/pack-task` statically at startup),
 * and `gateforge check --staged` moves the process cwd to the staged
 * candidate checkout before discovery runs. A detector that captured
 * `rootDir` at factory time would resolve repo-relative scan paths against
 * the loader's cwd: the staged files would not be found at all (every one
 * surfaces as a `PARSE_ERROR` read failure).
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

/** A temp project holding one worker module named `queue`. */
function makeProject(name: string): string {
  const root = mkdtempSync(join(tmpdir(), `gateforge-task-root-${name}-`));
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(
    join(root, 'src', 'queue.ts'),
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

describe('createTaskDetector resolves the repo root at discover time', () => {
  it('scans the repository in force at the discover call, not at factory time', async () => {
    const factoryCwd = makeProject('factory');
    const discoverCwd = makeProject('discover');
    try {
      process.chdir(factoryCwd);
      const detector = createTaskDetector();
      process.chdir(discoverCwd);
      const outcome = (await detector.discover(['src'])) as DiscoveryOutcome;
      // A factory-time root would have looked under `factoryCwd/src` — the
      // staged candidate's files would never be read.
      expect(outcome.findings).toEqual([]);
      expect((outcome.scannedPaths as string[]).sort()).toEqual(['src/queue.ts']);
    } finally {
      process.chdir(ORIGINAL_CWD);
      rmSync(factoryCwd, { recursive: true, force: true });
      rmSync(discoverCwd, { recursive: true, force: true });
    }
  });

  it('an explicit rootDir option still wins over the cwd at discover time', async () => {
    const pinned = makeProject('pinned');
    const discoverCwd = makeProject('elsewhere');
    try {
      const detector = createTaskDetector({ rootDir: pinned });
      process.chdir(discoverCwd);
      const outcome = (await detector.discover(['src'])) as DiscoveryOutcome;
      expect(outcome.findings).toEqual([]);
      expect((outcome.scannedPaths as string[]).sort()).toEqual(['src/queue.ts']);
    } finally {
      process.chdir(ORIGINAL_CWD);
      rmSync(pinned, { recursive: true, force: true });
      rmSync(discoverCwd, { recursive: true, force: true });
    }
  });
});