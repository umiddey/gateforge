/**
 * Discover-time root resolution — the staged gate's correctness hinge.
 *
 * The pack's default export is `createFastapiDetector()` evaluated at
 * MODULE IMPORT (the CLI imports `@gate-forge/pack-fastapi` statically at
 * startup), and `gateforge check --staged` moves the process cwd to the
 * staged candidate checkout before discovery runs. A detector that
 * captured `process.cwd()` at factory time would pin the loader's cwd and
 * hand the python child the user's WORKING TREE bytes — the gate would
 * then grade unstaged files.
 *
 * Both halves are pinned here: the root AND the `.gateforge/fastapi.json`
 * config document are read at DISCOVER time, while an explicit option
 * still wins. On a factory-time-capturing detector the two
 * "follows the current cwd" cases FAIL (the old root wins).
 */
import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFastapiDetector, type FastapiDetector } from '../src/index.js';
import { pythonEnv, type WrapperOutcome } from './helpers.js';

const ORIGINAL_CWD = process.cwd();

interface ContractFact {
  attributes: Record<string, unknown>;
}

/** Effective method+path of every discovered http.contract fact. */
function effectivePaths(outcome: WrapperOutcome): string[] {
  return (outcome.resources as unknown as ContractFact[])
    .map((fact) => `${String(fact.attributes['method'])} ${String(fact.attributes['normalizedPath'])}`)
    .sort();
}

/** Writes a `.gateforge/fastapi.json` declaring the given import roots. */
function writeImportRootsConfig(root: string, importRoots: readonly string[]): void {
  mkdirSync(join(root, '.gateforge'), { recursive: true });
  writeFileSync(join(root, '.gateforge', 'fastapi.json'), JSON.stringify({ importRoots }), 'utf8');
}

/** Runs `discover` with `root` as the process cwd; always restores it. */
async function discoverFrom(
  detector: FastapiDetector,
  root: string,
  paths: readonly string[],
): Promise<WrapperOutcome> {
  process.chdir(root);
  try {
    return (await detector.discover([...paths])) as WrapperOutcome;
  } finally {
    process.chdir(ORIGINAL_CWD);
  }
}

/** A single-route FastAPI module served at `routePath`. */
function makeProject(name: string, routePath: string): string {
  const root = mkdtempSync(join(tmpdir(), `gateforge-fastapi-root-${name}-`));
  mkdirSync(join(root, 'app'), { recursive: true });
  writeFileSync(
    join(root, 'app', 'main.py'),
    `from fastapi import FastAPI\n\napp = FastAPI()\n\n\n@app.get("${routePath}")\ndef handler() -> dict:\n    return {"ok": True}\n`,
    'utf8',
  );
  return root;
}

/**
 * A central-router-registry project: `backend/app/main.py` mounts
 * `app.api.routes.api_router` with a literal `/api` prefix, and the
 * absolute import only resolves when `backend` is declared as an import
 * root. Import roots that do NOT match leave the mount unfollowable — the
 * route comes back prefix-less with a `FASTAPI_PREFIX_UNRESOLVED` entry —
 * which is what makes the origin of the config document observable.
 */
function makeRegistryProject(name: string): string {
  const root = mkdtempSync(join(tmpdir(), `gateforge-fastapi-registry-${name}-`));
  mkdirSync(join(root, 'backend', 'app', 'api'), { recursive: true });
  writeFileSync(join(root, 'backend', 'app', '__init__.py'), '', 'utf8');
  writeFileSync(join(root, 'backend', 'app', 'api', '__init__.py'), '', 'utf8');
  writeFileSync(
    join(root, 'backend', 'app', 'main.py'),
    'from fastapi import FastAPI\nfrom app.api.routes import api_router\n\napp = FastAPI()\napp.include_router(api_router, prefix="/api")\n',
    'utf8',
  );
  writeFileSync(
    join(root, 'backend', 'app', 'api', 'routes.py'),
    'from fastapi import APIRouter\n\napi_router = APIRouter()\n\n\n@api_router.get("/items")\ndef list_items() -> dict:\n    return {"ok": True}\n',
    'utf8',
  );
  return root;
}

const REGISTRY_PATHS = ['backend/app/main.py', 'backend/app/api/routes.py'];

describe('createFastapiDetector resolves the repo root at discover time', () => {
  it('reads the repository in force at the discover call, not the one at factory time', async () => {
    const factoryCwd = makeProject('factory', '/factory');
    const discoverCwd = makeProject('discover', '/discover');
    try {
      // The detector is created while `factoryCwd` is in force — the
      // situation a default export created at module import is in.
      process.chdir(factoryCwd);
      const detector = createFastapiDetector({ env: pythonEnv() });
      const outcome = await discoverFrom(detector, discoverCwd, ['app/main.py']);
      expect(effectivePaths(outcome)).toEqual(['GET /discover']);
      expect(outcome.findings).toEqual([]);
    } finally {
      rmSync(factoryCwd, { recursive: true, force: true });
      rmSync(discoverCwd, { recursive: true, force: true });
    }
  });

  it('an explicit cwd option still wins over the cwd at discover time', async () => {
    const pinned = makeProject('pinned', '/pinned');
    const discoverCwd = makeProject('elsewhere', '/elsewhere');
    try {
      const detector = createFastapiDetector({ env: pythonEnv(), cwd: pinned });
      const outcome = await discoverFrom(detector, discoverCwd, ['app/main.py']);
      expect(effectivePaths(outcome)).toEqual(['GET /pinned']);
    } finally {
      rmSync(pinned, { recursive: true, force: true });
      rmSync(discoverCwd, { recursive: true, force: true });
    }
  });

  it('reads .gateforge/fastapi.json from the root in force at discover time', async () => {
    const factoryCwd = makeRegistryProject('config-factory');
    const discoverCwd = makeRegistryProject('config-discover');
    try {
      // The document visible at FACTORY time declares roots that do NOT
      // resolve the import; the discover-time root's document declares the
      // matching root. A factory-time read leaves the mount unfollowable;
      // a discover-time read resolves it.
      writeImportRootsConfig(factoryCwd, ['nonexistent-root']);
      writeImportRootsConfig(discoverCwd, ['backend']);
      process.chdir(factoryCwd);
      const detector = createFastapiDetector({ env: pythonEnv() });
      const outcome = await discoverFrom(detector, discoverCwd, REGISTRY_PATHS);
      expect(effectivePaths(outcome)).toEqual(['GET /api/items']);
      expect(outcome.unresolved).toEqual([]);
    } finally {
      rmSync(factoryCwd, { recursive: true, force: true });
      rmSync(discoverCwd, { recursive: true, force: true });
    }
  });

  it('an explicit importRoots option still wins over the config document', async () => {
    const project = makeRegistryProject('explicit-roots');
    try {
      // A config document that would NOT resolve the import, overridden by
      // the explicit option that does.
      writeImportRootsConfig(project, ['nonexistent-root']);
      const detector = createFastapiDetector({ env: pythonEnv(), importRoots: ['backend'] });
      const outcome = await discoverFrom(detector, project, REGISTRY_PATHS);
      expect(effectivePaths(outcome)).toEqual(['GET /api/items']);
      expect(outcome.unresolved).toEqual([]);
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });
});