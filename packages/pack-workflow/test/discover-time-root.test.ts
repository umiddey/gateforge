/**
 * Discover-time root resolution — the staged gate's correctness hinge.
 *
 * The pack's default export is `createWorkflowDetector()` evaluated at
 * MODULE IMPORT (the CLI imports `@gate-forge/pack-workflow` statically at
 * startup), and `gateforge check --staged` moves the process cwd to the
 * staged candidate checkout before discovery runs. A detector that captured
 * `process.cwd()` at factory time would resolve repo-relative scan paths
 * against the loader's cwd: the staged machines would not be read at all
 * (every path surfaces as `WORKFLOW_READ_FAILED`).
 *
 * An explicit `cwd` still wins.
 */
import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorkflowDetector, WORKFLOW_CONTRACT_KIND } from '../src/index.js';

const ORIGINAL_CWD = process.cwd();

/** A temp project holding one XState machine named `machineName`. */
function makeProject(name: string, machineName: string): string {
  const root = mkdtempSync(join(tmpdir(), `gateforge-workflow-root-${name}-`));
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(
    join(root, 'src', 'contract.ts'),
    [
      `type StateConfig = { on?: Record<string, { target: string }>; type?: 'final' | string };`,
      `export function createMachine(config: { states: Record<string, StateConfig> }): { id: string; config: typeof config } {`,
      `  return { id: 'machine', config };`,
      `}`,
      '',
      `export const ${machineName} = createMachine({`,
      `  states: {`,
      `    draft: { on: { submit: { target: 'done' } } },`,
      `    done: { type: 'final' },`,
      `  },`,
      `});`,
      '',
    ].join('\n'),
    'utf8',
  );
  return root;
}

const sourcesOf = (outcome: { resources: readonly unknown[] }): string[] =>
  (outcome.resources as Array<{ kind: string; source: string }>)
    .filter((resource) => resource.kind === WORKFLOW_CONTRACT_KIND)
    .map((resource) => resource.source)
    .sort();

describe('createWorkflowDetector resolves the repo root at discover time', () => {
  it('reads the repository in force at the discover call, not at factory time', async () => {
    const factoryCwd = makeProject('factory', 'factoryMachine');
    const discoverCwd = makeProject('discover', 'discoverMachine');
    try {
      process.chdir(factoryCwd);
      const detector = createWorkflowDetector();
      process.chdir(discoverCwd);
      const outcome = await detector.discover(['src/contract.ts']);
      // A factory-time root would have resolved `src/contract.ts` under
      // `factoryCwd` — the staged candidate's machine would never be read.
      expect(outcome.findings).toEqual([]);
      expect(sourcesOf(outcome)).toEqual(['src/contract.ts']);
    } finally {
      process.chdir(ORIGINAL_CWD);
      rmSync(factoryCwd, { recursive: true, force: true });
      rmSync(discoverCwd, { recursive: true, force: true });
    }
  });

  it('an explicit cwd option still wins over the cwd at discover time', async () => {
    const pinned = makeProject('pinned', 'pinnedMachine');
    const discoverCwd = makeProject('elsewhere', 'elsewhereMachine');
    try {
      const detector = createWorkflowDetector({ cwd: pinned });
      process.chdir(discoverCwd);
      const outcome = await detector.discover(['src/contract.ts']);
      expect(outcome.findings).toEqual([]);
      expect(sourcesOf(outcome)).toEqual(['src/contract.ts']);
    } finally {
      process.chdir(ORIGINAL_CWD);
      rmSync(pinned, { recursive: true, force: true });
      rmSync(discoverCwd, { recursive: true, force: true });
    }
  });
});