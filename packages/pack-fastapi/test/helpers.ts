/**
 * Test helpers: fixture roots, the documented subprocess invocation
 * (`python3 -m gateforge_fastapi_detector` with cwd = fixture root),
 * and a one-shot discover driver over a hardened GPP/3 session.
 */
import { delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PluginSession, type DiscoveryOutcome } from '@gate-forge/plugin-protocol';
import { createFastapiDetector } from '../src/detector.js';
import { PACK_PLUGIN_ID, PACK_VERSION } from '../src/version.js';

/** Absolute dir of the pack's test fixtures. */
export const FIXTURE_ROOT = fileURLToPath(new URL('./fixtures', import.meta.url));

/** Absolute dir of this pack's python detector package. */
export const PACK_PYTHON = fileURLToPath(new URL('../python', import.meta.url));

/** Absolute dir of the sibling GPP/3 python client. */
export const PROTOCOL_PYTHON = fileURLToPath(
  new URL('../../../plugin-protocol/python', import.meta.url),
);

/** Every fixture scanned as one discovery request. */
export const ALL_FIXTURES = [
  'simple/main.py',
  'simple/routers.py',
  'simple/standalone.py',
  'simple/computed.py',
  'simple/broken.py',
  'unsupported.py',
  'app/__init__.py',
  'app/main.py',
  'app/routers.py',
  'app/alias.py',
  'import-roots/backend/main.py',
  'import-roots/backend/api/__init__.py',
  'import-roots/backend/api/v1/__init__.py',
  'import-roots/backend/api/v1/activities.py',
  'import-roots/backend/api/v1/endpoints/__init__.py',
  'import-roots/backend/api/v1/endpoints/leases.py',
  'import-roots/backend/api/v1/endpoints/health.py',
  'import-roots/backend/api/v1/endpoints/reports.py',
  'import-roots/backend/api/v1/endpoints/archive.py',
  'import-roots/backend/api/v1/routers.py',
  'import-roots/backend/registry.py',
  'import-roots/backend/server.py',
  'import-roots/backend/ops/__init__.py',
  'import-roots/backend/ops/endpoints.py',
  'import-roots/admin/api/v1/activities.py',
] as const;

/** The registry fixture files (backend + the ambiguous second root). */
export const IMPORT_ROOTS_FIXTURES = [
  'import-roots/backend/main.py',
  'import-roots/backend/api/__init__.py',
  'import-roots/backend/api/v1/__init__.py',
  'import-roots/backend/api/v1/activities.py',
  'import-roots/backend/api/v1/endpoints/__init__.py',
  'import-roots/backend/api/v1/endpoints/leases.py',
  'import-roots/backend/api/v1/endpoints/health.py',
  'import-roots/backend/api/v1/routers.py',
  'import-roots/admin/api/v1/activities.py',
] as const;

/**
 * The registry-FUNCTION fixture files (phase 3): includes written on a
 * function parameter, mounted from module-level call sites whose
 * arguments are `FastAPI()` instances — the dogfood
 * `register_all_routers(fastapi_app)` shape — plus a chained helper, a
 * never-called orphan, an unresolvable-argument negative, and a
 * `from ops import router` package-attribute re-export.
 */
export const REGISTRY_FIXTURES = [
  'import-roots/backend/server.py',
  'import-roots/backend/registry.py',
  'import-roots/backend/ops/__init__.py',
  'import-roots/backend/ops/endpoints.py',
  'import-roots/backend/api/__init__.py',
  'import-roots/backend/api/v1/__init__.py',
  'import-roots/backend/api/v1/endpoints/__init__.py',
  'import-roots/backend/api/v1/endpoints/reports.py',
  'import-roots/backend/api/v1/endpoints/archive.py',
] as const;

/** Import-root config that points at the fixture's `backend` tree. */
export const BACKEND_IMPORT_ROOTS = ['import-roots/backend'] as const;

/** Both fixture trees declare the same `api.v1.activities` module path. */
export const AMBIGUOUS_IMPORT_ROOTS = ['import-roots/backend', 'import-roots/admin'] as const;

/** The subprocess environment: host env + deterministic PYTHONPATH. */
export function pythonEnv(extra: string[] = []): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PYTHONPATH: [...extra, PACK_PYTHON, PROTOCOL_PYTHON].join(delimiter),
  };
}

/**
 * One RAW subprocess session: start → discover → dispose. This is the
 * bare GPP/3 surface WITHOUT the wrapper's canonicalization — used to
 * pin the protocol behavior itself.
 */
export async function runDiscover(paths: readonly string[]): Promise<DiscoveryOutcome> {
  const session = new PluginSession({
    command: ['python3', '-m', 'gateforge_fastapi_detector'],
    pluginId: PACK_PLUGIN_ID,
    pluginVersion: PACK_VERSION,
    cwd: FIXTURE_ROOT,
    env: pythonEnv(),
    timeouts: { handshakeMs: 15_000, requestMs: 30_000, shutdownMs: 10_000 },
  });
  try {
    await session.start();
    return await session.discover([...paths]);
  } finally {
    await session.dispose();
  }
}

/** The wrapper outcome shape (resources stay untyped wire JSON). */
export interface WrapperOutcome {
  resources: unknown[];
  unresolved: unknown[];
  findings: unknown[];
  classificationSignals: unknown[];
  scannedPaths?: string[];
}

/**
 * The full pack surface (wrapper): canonical paths, typed dynamic
 * outcomes, and minted signals — what the CLI actually consumes.
 */
export function runDetector(paths: readonly string[]): Promise<WrapperOutcome> {
  const detector = createFastapiDetector({ env: pythonEnv(), cwd: FIXTURE_ROOT });
  return detector.discover(paths) as Promise<WrapperOutcome>;
}

/**
 * The full pack surface with explicit import roots (the
 * `.gateforge/fastapi.json` `importRoots` option path).
 */
export function runDetectorWithImportRoots(
  paths: readonly string[],
  importRoots: readonly string[],
): Promise<WrapperOutcome> {
  const detector = createFastapiDetector({
    env: pythonEnv(),
    cwd: FIXTURE_ROOT,
    importRoots,
  });
  return detector.discover(paths) as Promise<WrapperOutcome>;
}
