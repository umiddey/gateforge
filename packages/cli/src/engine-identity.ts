import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VERSION } from './commands/common.js';

/** Public identity of the engine installation that produced a report. */
export interface EngineIdentity {
  /** Package version. */
  version: string;
  /** Registry package or the local package path. */
  source: string;
  /** True when CI will not install the local workspace code automatically. */
  unpublished: boolean;
}

/**
 * Identifies the installed engine without executing package code from the project.
 *
 * Args:
 *   none.
 *
 * Returns:
 *   EngineIdentity: version, source, and whether the engine is unpublished.
 */
export function engineIdentity(): EngineIdentity {
  let current = dirname(fileURLToPath(import.meta.url));
  let packageRoot: string | null = null;
  while (true) {
    const manifest = join(current, 'package.json');
    if (existsSync(manifest)) {
      try {
        const value = JSON.parse(readFileSync(manifest, 'utf8')) as { name?: unknown };
        if (value.name === '@gate-forge/cli') {
          packageRoot = realpathSync(current);
          break;
        }
      } catch {
        // Continue upward; a malformed unrelated manifest is not this package's identity.
      }
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  if (packageRoot === null) {
    return { version: VERSION, source: 'registry', unpublished: false };
  }
  const normalized = packageRoot.split('\\').join('/');
  const fromRegistry = normalized.includes('/node_modules/');
  return fromRegistry
    ? { version: VERSION, source: 'registry', unpublished: false }
    : { version: VERSION, source: `local path ${packageRoot}`, unpublished: true };
}
