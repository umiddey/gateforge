/**
 * Discover-time root resolution — the staged gate's correctness hinge.
 *
 * The pack's default export is `createAuthDetector()` evaluated at MODULE
 * IMPORT (the CLI imports `@gate-forge/pack-auth` statically at startup),
 * and `gateforge check --staged` moves the process cwd to the staged
 * candidate checkout before discovery runs. A detector that captured
 * `process.cwd()` at factory time would compute every repo-relative
 * `source`/`location` against the loader's cwd instead of the gated
 * repository root — so a staged scan reports paths outside the repo.
 *
 * An explicit `root` still wins.
 */
import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DiscoveryOutcome } from '@gate-forge/plugin-protocol';
import { createAuthDetector } from '../src/index.js';

const ORIGINAL_CWD = process.cwd();

/** A temp project holding one guarded Express endpoint at `routePath`. */
function makeProject(name: string, routePath: string): string {
  const root = mkdtempSync(join(tmpdir(), `gateforge-auth-root-${name}-`));
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(
    join(root, 'src', 'routes.js'),
    `const express = require('express');\nconst router = express.Router();\n\nrouter.post(\n  '${routePath}',\n  requireRole('admin'),\n  requireTenant(),\n  handler\n);\n`,
    'utf8',
  );
  return root;
}

const sourcesOf = (outcome: DiscoveryOutcome): string[] =>
  outcome.resources.map((resource) => String(resource.source)).sort();

describe('createAuthDetector resolves the repo root at discover time', () => {
  it('reports repo-relative sources against the cwd at discover time, not at factory time', () => {
    const factoryCwd = makeProject('factory', '/factory');
    const discoverCwd = makeProject('discover', '/discover');
    try {
      process.chdir(factoryCwd);
      const detector = createAuthDetector();
      process.chdir(discoverCwd);
      const outcome = detector.discover(['src/routes.js']);
      // Read from the discover-time cwd, and reported relative to it: a
      // factory-time root would emit a `../…` path escaping the repo.
      expect(sourcesOf(outcome)).toEqual(['src/routes.js']);
      expect(outcome.resources.map((resource) => resource.location['file'])).toEqual(['src/routes.js']);
    } finally {
      process.chdir(ORIGINAL_CWD);
      rmSync(factoryCwd, { recursive: true, force: true });
      rmSync(discoverCwd, { recursive: true, force: true });
    }
  });

  it('an explicit root option still wins over the cwd at discover time', () => {
    const pinned = makeProject('pinned', '/pinned');
    const discoverCwd = makeProject('elsewhere', '/elsewhere');
    try {
      const detector = createAuthDetector({ root: pinned });
      process.chdir(discoverCwd);
      const outcome = detector.discover([join(pinned, 'src', 'routes.js')]);
      expect(sourcesOf(outcome)).toEqual(['src/routes.js']);
    } finally {
      process.chdir(ORIGINAL_CWD);
      rmSync(pinned, { recursive: true, force: true });
      rmSync(discoverCwd, { recursive: true, force: true });
    }
  });
});