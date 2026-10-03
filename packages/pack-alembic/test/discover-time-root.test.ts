/**
 * Discover-time root resolution — the staged gate's correctness hinge.
 *
 * The pack's default export is `createAlembicDetector()` evaluated at
 * MODULE IMPORT (the CLI imports `@gate-forge/pack-alembic` statically at
 * startup), and `gateforge check --staged` moves the process cwd to the
 * staged candidate checkout before discovery runs. A detector that captured
 * `process.cwd()` at factory time would hand the python child the loader's
 * cwd, so the migration facts would come from the user's WORKING TREE
 * instead of the gated staged bytes.
 *
 * An explicit `cwd` still wins.
 */
import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAlembicDetector, pythonEnvironment } from '../src/index.js';

const ORIGINAL_CWD = process.cwd();

/** A temp project holding one migration revision named `revision`. */
function makeProject(name: string, revision: string): string {
  const root = mkdtempSync(join(tmpdir(), `gateforge-alembic-root-${name}-`));
  mkdirSync(join(root, 'versions'), { recursive: true });
  writeFileSync(
    join(root, 'versions', 'a.py'),
    `revision: str = '${revision}'\ndown_revision: str | None = None\n\n\ndef upgrade() -> None:\n    pass\n\n\ndef downgrade() -> None:\n    pass\n`,
    'utf8',
  );
  return root;
}

const revisionsOf = (outcome: { resources: readonly unknown[] }): string[] =>
  (outcome.resources as Array<{ kind: string; attributes: Record<string, unknown> }>)
    .filter((resource) => resource.kind === 'alembic.migration')
    .map((resource) => String(resource.attributes['revision']))
    .sort();

describe('createAlembicDetector resolves the repo root at discover time', () => {
  it('scans the repository in force at the discover call, not at factory time', async () => {
    const factoryCwd = makeProject('factory', 'factoryrev');
    const discoverCwd = makeProject('discover', 'discoverrev');
    try {
      process.chdir(factoryCwd);
      const detector = createAlembicDetector({ env: pythonEnvironment() });
      process.chdir(discoverCwd);
      const outcome = await detector.discover(['versions']);
      expect(outcome.findings).toEqual([]);
      expect(revisionsOf(outcome)).toEqual(['discoverrev']);
    } finally {
      process.chdir(ORIGINAL_CWD);
      rmSync(factoryCwd, { recursive: true, force: true });
      rmSync(discoverCwd, { recursive: true, force: true });
    }
  });

  it('an explicit cwd option still wins over the cwd at discover time', async () => {
    const pinned = makeProject('pinned', 'pinnedrev');
    const discoverCwd = makeProject('elsewhere', 'elswherev');
    try {
      const detector = createAlembicDetector({ env: pythonEnvironment(), cwd: pinned });
      process.chdir(discoverCwd);
      const outcome = await detector.discover(['versions']);
      expect(outcome.findings).toEqual([]);
      expect(revisionsOf(outcome)).toEqual(['pinnedrev']);
    } finally {
      process.chdir(ORIGINAL_CWD);
      rmSync(pinned, { recursive: true, force: true });
      rmSync(discoverCwd, { recursive: true, force: true });
    }
  });
});