/**
 * Discover-time root resolution — the staged gate's correctness hinge.
 *
 * The pack's default export is `createWorkflowDetector()` evaluated at
 * MODULE IMPORT (the CLI imports `@gate-forge/pack-workflow` statically at
 * startup), and `gateforge check --staged` moves the process cwd to the
 * staged candidate checkout before discovery runs. A detector that captured
 * `process.cwd()` at factory time would resolve repo-relative scan paths
 * against the loader's cwd — so the staged machines would never be read.
 *
 * Both temp projects declare the SAME module path with DIFFERENT machine
 * names, and the machine name is part of the emitted resource id: a
 * factory-time root reports the other project's machine. On the factory-
 * time-capturing detector the first case FAILS.
 *
 * An explicit `cwd` still wins.
 */
import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorkflowDetector, WORKFLOW_CONTRACT_KIND } from '../src/index.js';

const ORIGINAL_CWD = process.cwd();

/** A temp project whose `src/contract.ts` declares `machineName`. */
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

/** Ids of the workflow contracts the outcome carries, joined for matching. */
const contractIds = (outcome: { resources: readonly unknown[] }): string =>
  (outcome.resources as Array<{ kind: string; id: string }>)
    .filter((resource) => resource.kind === WORKFLOW_CONTRACT_KIND)
    .map((resource) => resource.id)
    .sort()
    .join(' ');

describe('createWorkflowDetector resolves the repo root at discover time', () => {
  it('reads the repository in force at the discover call, not at factory time', async () => {
    const factoryCwd = makeProject('factory', 'factoryMachine');
    const discoverCwd = makeProject('discover', 'stagedMachine');
    try {
      process.chdir(factoryCwd);
      const detector = createWorkflowDetector();
      process.chdir(discoverCwd);
      const outcome = await detector.discover(['src/contract.ts']);
      // A factory-time root would have reported `factoryMachine` instead.
      expect(contractIds(outcome)).toContain('stagedmachine');
      expect(contractIds(outcome)).not.toContain('factorymachine');
      expect(outcome.findings).toEqual([]);
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
      expect(contractIds(outcome)).toContain('pinnedmachine');
      expect(contractIds(outcome)).not.toContain('elswheremachine');
      expect(outcome.findings).toEqual([]);
    } finally {
      process.chdir(ORIGINAL_CWD);
      rmSync(pinned, { recursive: true, force: true });
      rmSync(discoverCwd, { recursive: true, force: true });
    }
  });
});