/**
 * Discover-time root resolution — the staged gate's correctness hinge.
 *
 * The pack's default export already builds a detector per discover call,
 * but the FACTORY is not allowed to capture the cwd: the CLI imports
 * `@gate-forge/pack-http` statically at startup and
 * `gateforge check --staged` moves the process cwd to the staged candidate
 * checkout before discovery runs. A factory-time capture would compute
 * every repo-relative `source`/`location` — and read
 * `.gateforge/http-clients.json` — against the loader's cwd instead of the
 * gated repository root.
 *
 * An explicit `root` (and an explicit `clientScan`) still win.
 */
import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createHttpDetector } from '../src/index.js';

const ORIGINAL_CWD = process.cwd();

/** Writes `{ files }` into a fresh temp project and returns its root. */
function project(name: string, files: Readonly<Record<string, string>>): string {
  const root = mkdtempSync(join(tmpdir(), `gateforge-http-root-${name}-`));
  for (const [relative, text] of Object.entries(files)) {
    const absolute = join(root, relative);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, text, 'utf8');
  }
  return root;
}

/** An Express app whose single route path is `routePath`. */
function expressApp(routePath: string): string {
  return [
    `import express from 'express';`,
    `const app = express();`,
    `app.get('${routePath}', (req, res) => res.json({}));`,
  ].join('\n');
}

const sourcesOf = (outcome: { resources: readonly unknown[] }): string[] =>
  (outcome.resources as Array<{ source: string }>).map((resource) => resource.source).sort();

describe('createHttpDetector resolves the repo root at discover time', () => {
  it('reports repo-relative sources against the cwd at discover time, not at factory time', () => {
    const factoryCwd = project('factory', { 'src/app.ts': expressApp('/factory') });
    const discoverCwd = project('discover', { 'src/app.ts': expressApp('/discover') });
    try {
      process.chdir(factoryCwd);
      const detector = createHttpDetector();
      process.chdir(discoverCwd);
      const outcome = detector.discover(['src']);
      expect(sourcesOf(outcome)).toEqual(['src/app.ts']);
      // The raw effective paths prove the discover-time bytes were scanned.
      expect(JSON.stringify(outcome)).toContain('/discover');
    } finally {
      process.chdir(ORIGINAL_CWD);
      rmSync(factoryCwd, { recursive: true, force: true });
      rmSync(discoverCwd, { recursive: true, force: true });
    }
  });

  it('reads .gateforge/http-clients.json from the root at discover time', () => {
    // `serverScanRoots` is the config channel's server scoping: with the
    // route directory declared, the route is scanned as a server artifact.
    const factoryCwd = project('config-factory', {
      'src/app.ts': expressApp('/factory'),
      '.gateforge/http-clients.json': JSON.stringify({ serverScanRoots: ['server/**'] }),
    });
    const discoverCwd = project('config-discover', {
      'server/app.ts': expressApp('/discover'),
      '.gateforge/http-clients.json': JSON.stringify({ serverScanRoots: ['src/**'] }),
    });
    try {
      process.chdir(factoryCwd);
      const detector = createHttpDetector();
      process.chdir(discoverCwd);
      const outcome = detector.discover(['server']);
      // The discover-time document scopes server routes to `src/**`, which
      // does NOT cover `server/**` — so the route yields no artifact. A
      // factory-time read (scoping `server/**`) would have emitted it.
      expect(outcome.resources).toEqual([]);
      expect((outcome.scannedPaths as string[]).sort()).toEqual(['server/app.ts']);
    } finally {
      process.chdir(ORIGINAL_CWD);
      rmSync(factoryCwd, { recursive: true, force: true });
      rmSync(discoverCwd, { recursive: true, force: true });
    }
  });

  it('an explicit root option still wins over the cwd at discover time', () => {
    const pinned = project('pinned', { 'src/app.ts': expressApp('/pinned') });
    const discoverCwd = project('elsewhere', { 'src/app.ts': expressApp('/elsewhere') });
    try {
      const detector = createHttpDetector({ root: pinned });
      process.chdir(discoverCwd);
      const outcome = detector.discover(['src']);
      expect(sourcesOf(outcome)).toEqual(['src/app.ts']);
      expect(JSON.stringify(outcome)).toContain('/pinned');
    } finally {
      process.chdir(ORIGINAL_CWD);
      rmSync(pinned, { recursive: true, force: true });
      rmSync(discoverCwd, { recursive: true, force: true });
    }
  });

  it('an explicit clientScan option still wins over the config document', () => {
    const root = project('explicit-scan', {
      'src/app.ts': expressApp('/explicit'),
      '.gateforge/http-clients.json': JSON.stringify({ serverScanRoots: ['nowhere/**'] }),
    });
    try {
      const detector = createHttpDetector({ clientScan: { serverScanRoots: ['src/**'] } });
      process.chdir(root);
      const outcome = detector.discover(['src']);
      expect(sourcesOf(outcome)).toEqual(['src/app.ts']);
    } finally {
      process.chdir(ORIGINAL_CWD);
      rmSync(root, { recursive: true, force: true });
    }
  });
});