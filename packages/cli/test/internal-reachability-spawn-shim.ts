/**
 * P47 e2e spawn counter. Importing this module puts a python3 shim first on
 * PATH and logs every detector spawn to `counterFile`. It must be the first
 * import of the e2e file: the bundled pack builds its default detector, which
 * snapshots process.env, as soon as the CLI loads it (pack src/index.ts:78).
 *
 * The shim is a python script, not a shell script, on purpose: the plugin
 * cache fingerprints the interpreter behind `python3` (run-cache.ts,
 * pythonTargetOf), and a shell shim would make every plugin result uncacheable.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'p47-shim-'));
/** One line per python3 invocation, appended before the real interpreter runs. */
export const counterFile = join(dir, 'spawns.log');
const real = spawnSync('sh', ['-c', 'command -v python3'], { encoding: 'utf8' }).stdout.trim();
writeFileSync(
  join(dir, 'python3'),
  `#!${real}\n` +
    'import os, sys\n' +
    `with open(${JSON.stringify(counterFile)}, 'a') as log:\n` +
    "    log.write(' '.join(sys.argv[1:]) + '\\n')\n" +
    `os.execv(${JSON.stringify(real)}, [${JSON.stringify(real)}, *sys.argv[1:]])\n`,
  { mode: 0o755 },
);
const previous = process.env.PATH ?? '';
process.env.PATH = `${dir}:${previous}`;

/** Restores PATH and removes the shim directory. */
export function restorePath(): void {
  process.env.PATH = previous;
  rmSync(dir, { recursive: true, force: true });
}
