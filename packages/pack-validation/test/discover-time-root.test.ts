/**
 * Discover-time root resolution — the staged gate's correctness hinge.
 *
 * The pack's default export is `createValidationDetector()` evaluated at
 * MODULE IMPORT (the CLI imports `@gate-forge/pack-validation` statically
 * at startup), and `gateforge check --staged` moves the process cwd to the
 * staged candidate checkout before discovery runs. A detector that captured
 * `process.cwd()` at factory time would resolve repo-relative scan paths
 * against the loader's cwd: the staged schemas would not be found at all.
 *
 * An explicit `root` still wins.
 */
import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createValidationDetector } from '../src/index.js';

const ORIGINAL_CWD = process.cwd();

/** A temp project holding one zod schema named `name`. */
function makeProject(name: string, schemaName: string): string {
  const root = mkdtempSync(join(tmpdir(), `gateforge-validation-root-${name}-`));
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(
    join(root, 'src', 'schemas.ts'),
    [
      `import { z } from 'zod';`,
      `export const ${schemaName} = z.object({`,
      `  email: z.string().email(),`,
      `});`,
      '',
    ].join('\n'),
    'utf8',
  );
  return root;
}

const idsOf = (outcome: { resources: readonly unknown[] }): string[] =>
  (outcome.resources as Array<{ id: string }>).map((resource) => resource.id).sort();

describe('createValidationDetector resolves the repo root at discover time', () => {
  it('scans the repository in force at the discover call, not at factory time', () => {
    const factoryCwd = makeProject('factory', 'factorySchema');
    const discoverCwd = makeProject('discover', 'discoverSchema');
    try {
      process.chdir(factoryCwd);
      const detector = createValidationDetector();
      process.chdir(discoverCwd);
      const outcome = detector.discover(['src']);
      // A factory-time root would have looked under `factoryCwd/src`.
      expect(idsOf(outcome)).toEqual(['validation.zod.discoverschema']);
      expect((outcome.scannedPaths as string[]).sort()).toEqual(['src/schemas.ts']);
    } finally {
      process.chdir(ORIGINAL_CWD);
      rmSync(factoryCwd, { recursive: true, force: true });
      rmSync(discoverCwd, { recursive: true, force: true });
    }
  });

  it('an explicit root option still wins over the cwd at discover time', () => {
    const pinned = makeProject('pinned', 'pinnedSchema');
    const discoverCwd = makeProject('elsewhere', 'elsewhereSchema');
    try {
      const detector = createValidationDetector({ root: pinned });
      process.chdir(discoverCwd);
      const outcome = detector.discover(['src']);
      expect(idsOf(outcome)).toEqual(['validation.zod.pinnedschema']);
    } finally {
      process.chdir(ORIGINAL_CWD);
      rmSync(pinned, { recursive: true, force: true });
      rmSync(discoverCwd, { recursive: true, force: true });
    }
  });
});