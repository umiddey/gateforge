/**
 * Test helpers: fixture roots, the documented subprocess invocation
 * (`python3 -m gateforge_sqlalchemy_detector` with cwd = fixture root),
 * and a one-shot discover driver over a hardened GPP/3 session.
 */
import { delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PluginSession,
  type DiscoveryOutcome,
  type PluginSpawnOptions,
} from '@gateforge/plugin-protocol';
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
	'legacy_declarative.py',
	'modern_declarative.py',
	'collisions.py',
	'function_local.py',
	'computed_names.py',
	'malformed.py',
	'cross_module/base.py',
	'cross_module/child.py',
	'cross_module/computed.py',
	'example_models.py',
	'composite_pk.py',
	'signals_archive.py',
	'signals_computed_pk.py',
	'candidates.py',
	'candidate_closure.py',
 	'non_models.py',
	'denylisted_base.py',
	'shadow_schemas.py',
	'shadow_models.py',
] as const;

/**
 * The subprocess environment: the host env plus a PYTHONPATH that makes
 * `python3 -m gateforge_sqlalchemy_detector` importable.
 *
 * Args:
 *   extra: Additional leading PYTHONPATH entries.
 *
 * Returns:
 *   NodeJS.ProcessEnv: environment for the GPP/3 spawn.
 */
export function pythonEnv(extra: string[] = []): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PYTHONPATH: [...extra, PACK_PYTHON, PROTOCOL_PYTHON].join(delimiter),
  };
}

/**
 * Host spawn options for the documented subprocess transport: the
 * exact command G4's config entry uses, run against the fixture root.
 *
 * Args:
 *   overrides: Per-test overrides (e.g. cwd or env).
 *
 * Returns:
 *   PluginSpawnOptions: ready for `new PluginSession(...)`.
 */
export function pythonSessionOptions(
  overrides: Partial<PluginSpawnOptions> = {},
): PluginSpawnOptions {
  return {
    command: ['python3', '-m', 'gateforge_sqlalchemy_detector'],
    pluginId: PACK_PLUGIN_ID,
    pluginVersion: PACK_VERSION,
    cwd: FIXTURE_ROOT,
    env: pythonEnv(),
    timeouts: { handshakeMs: 10_000, requestMs: 30_000, shutdownMs: 10_000 },
    ...overrides,
  };
}

/**
 * Runs one discover request over a fresh GPP/3 session (spawn →
 * handshake → discover → shutdown), cleaning the session up always.
 *
 * Args:
 *   paths: Repo-root-relative fixture paths.
 *   overrides: Optional spawn overrides.
 *
 * Returns:
 *   Promise<DiscoveryOutcome>: The validated discovery outcome.
 */
export async function runDiscover(
  paths: readonly string[],
  overrides: Partial<PluginSpawnOptions> = {},
): Promise<DiscoveryOutcome> {
  const session = new PluginSession(pythonSessionOptions(overrides));
  try {
    await session.start();
    return await session.discover([...paths]);
  } finally {
    await session.dispose();
  }
}