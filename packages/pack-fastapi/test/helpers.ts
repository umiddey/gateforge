/**
 * Test helpers: fixture roots, the documented subprocess invocation
 * (`python3 -m gateforge_fastapi_detector` with cwd = fixture root),
 * and a one-shot discover driver over a hardened GPP/3 session.
 */
import { delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PluginSession, type DiscoveryOutcome } from '@gateforge/plugin-protocol';
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
] as const;

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
