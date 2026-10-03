/**
 * @gate-forge/pack-alembic — Alembic migration detector.
 *
 * Implements the GPP/3 in-process plugin contract over python3 -m gateforge_alembic_detector.
 */

import { delimiter, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PluginSession, type DiscoveryOutcome } from '@gate-forge/plugin-protocol';
import { PACK_PLUGIN_ID, PACK_VERSION } from './version.js';

/** Absolute directory of this pack's python tree. */
const PACK_PYTHON_DIR = fileURLToPath(new URL('../python', import.meta.url));

/** Absolute directory of the sibling plugin-protocol python client. */
const PROTOCOL_PYTHON_DIR = fileURLToPath(
  new URL('../../../plugin-protocol/python', import.meta.url),
);

/** Default subprocess command for the GPP/3 detector. */
export const DEFAULT_COMMAND = ['python3', '-m', 'gateforge_alembic_detector'];

/**
 * Builds the environment the python detector runs under.
 *
 * Args:
 *   extra: Additional leading PYTHONPATH entries.
 *
 * Returns:
 *   NodeJS.ProcessEnv: Combined process environment with PYTHONPATH.
 */
export function pythonEnvironment(extra: readonly string[] = []): NodeJS.ProcessEnv {
  const entries = [...extra, PACK_PYTHON_DIR, PROTOCOL_PYTHON_DIR];
  return {
    ...process.env,
    PYTHONDONTWRITEBYTECODE: '1',
    PYTHONPATH: entries.join(delimiter),
  };
}

/** Options for createAlembicDetector. */
export interface AlembicDetectorOptions {
  /**
   * Repo root directory (default: `process.cwd()` AT DISCOVER TIME — the
   * default export is created at module import, so a factory-time capture
   * would pin the loader's cwd).
   */
  cwd?: string;
  /** Subprocess command. */
  command?: readonly string[];
  /** Subprocess environment. */
  env?: NodeJS.ProcessEnv;
  /** Handshake-pinned plugin id. */
  pluginId?: string;
  /** Handshake-pinned plugin version. */
  pluginVersion?: string;
}

/** The pinned in-process plugin contract: discover(paths). */
export interface AlembicDetector {
  discover(paths: readonly string[]): Promise<DiscoveryOutcome>;
}

/**
 * Creates an Alembic detector instance implementing the GPP/3 in-process contract.
 *
 * Args:
 *   options: Detector configuration options.
 *
 * Returns:
 *   AlembicDetector: The discover-capable detector.
 */
export function createAlembicDetector(options: AlembicDetectorOptions = {}): AlembicDetector {
  const command = options.command ?? DEFAULT_COMMAND;
  const env = options.env ?? pythonEnvironment();
  const pluginId = options.pluginId ?? PACK_PLUGIN_ID;
  const pluginVersion = options.pluginVersion ?? PACK_VERSION;
  // The repo root is resolved at DISCOVER time unless the caller pinned one
  // explicitly: the default export of this pack is created at module import
  // (the CLI imports it at startup), and `gateforge check --staged` moves the
  // process cwd to the staged candidate checkout before discovery runs. A
  // root captured at factory time would pin the loader's cwd and read the
  // user's worktree bytes instead of the gated ones.
  return {
    async discover(paths: readonly string[]): Promise<DiscoveryOutcome> {
      if (paths.length === 0) {
        return {
          resources: [],
          unresolved: [],
          findings: [],
          classificationSignals: [],
        };
      }
      const session = new PluginSession({
        command: [...command],
        pluginId,
        pluginVersion,
        cwd: options.cwd ?? process.cwd(),
        env,
        timeouts: { handshakeMs: 10_000, requestMs: 30_000, shutdownMs: 10_000 },
      });
      try {
        await session.start();
        const outcome = await session.discover([...paths]);
        return outcome;
      } finally {
        await session.dispose();
      }
    },
  };
}
