/**
 * Shared test helpers for the GPP/2 suites: fixture paths and the expected
 * discovery outcome for the `app/routes.gfx` fixture (computed by hand, so
 * the tests check plugin output against an independent ground truth).
 */
import { fileURLToPath } from 'node:url';
import type { PluginSpawnOptions } from '../src/index.js';

export const FIXTURE_ROOT = fileURLToPath(new URL('./fixtures', import.meta.url));

/** Absolute path of a fixture plugin script. */
export function pluginPath(name: string): string {
  return fileURLToPath(new URL(`./fixtures/plugins/${name}`, import.meta.url));
}

/** Absolute path of the Python reference detector. */
export const PYTHON_PLUGIN = fileURLToPath(
  new URL('../python/plugins/reference_detector.py', import.meta.url),
);

export interface RouteRow {
  method: string;
  path: string;
  line: number;
}

/** Physical lines of test/fixtures/app/routes.gfx (1-based line numbers). */
export const ROUTES: RouteRow[] = [
  { method: 'GET', path: '/users', line: 2 },
  { method: 'GET', path: '/users', line: 3 },
  { method: 'POST', path: '/users', line: 4 },
  { method: 'DELETE', path: '/users/:id', line: 5 },
];

/** The resources both reference detectors must emit for the fixture. */
export const EXPECTED_RESOURCES = ROUTES.map((route) => ({
  schemaVersion: 1,
  id: `web.routes:${route.method} ${route.path}`,
  kind: 'http-route',
  source: 'app/routes.gfx',
  location: { file: 'app/routes.gfx', line: route.line, col: 0 },
  detectorVersion: '1.0.0',
  attributes: { method: route.method, path: route.path },
}));

/** The findings both reference detectors must emit for the fixture. */
export const EXPECTED_FINDINGS = [
  {
    code: 'DUPLICATE_ROUTE',
    detail: "route 'GET /users' declared 2 times",
    locations: [
      { file: 'app/routes.gfx', line: 2, col: 0 },
      { file: 'app/routes.gfx', line: 3, col: 0 },
    ],
  },
];

/** Host spawn options for a fixture plugin with fast watchdogs. */
export function jsPluginOptions(
  name: string,
  overrides: Partial<PluginSpawnOptions> = {},
): PluginSpawnOptions {
  return {
    command: [process.execPath, pluginPath(name), FIXTURE_ROOT],
    pluginId: 'js-fixture-detector',
    pluginVersion: '1.0.0',
    timeouts: { handshakeMs: 5_000, requestMs: 5_000, shutdownMs: 5_000 },
    ...overrides,
  };
}

/** Host spawn options for the Python reference detector. */
export function pythonPluginOptions(
  overrides: Partial<PluginSpawnOptions> = {},
): PluginSpawnOptions {
  return {
    command: ['python3', PYTHON_PLUGIN, FIXTURE_ROOT],
    pluginId: 'python-fixture-detector',
    pluginVersion: '1.0.0',
    timeouts: { handshakeMs: 10_000, requestMs: 10_000, shutdownMs: 10_000 },
    ...overrides,
  };
}
