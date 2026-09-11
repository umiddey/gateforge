/**
 * `gateforge enforce`: wire the blocking gate into an ALREADY initialized
 * repo — the retroactive path for repos created before `init --blocking`
 * existed, or by repos that opted out at init time and changed their mind.
 *
 * Writes, idempotently and never overwriting user files:
 *   .gateforge/hooks/gateforge-check.sh   (executable; runs `gateforge check --changed`)
 *   .pre-commit-config.yaml               (gateforge-check local hook appended)
 *   .gateforge/ci/gitlab-gateforge.yml    (CI job template)
 *   .gitlab-ci.yml                        (include, only when the file is absent)
 *
 * Requires .gateforge.yml: without a compiled-obligations config the check
 * has nothing to gate on.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { writeLine } from '../io.js';
import { UsageError } from '../errors.js';
import { ensureBlockingWiring, engineRootFromInvocation } from './blocking.js';
export const ENFORCE_USAGE = 'usage: gateforge enforce';
/**
 * Runs `gateforge enforce` in the io cwd.
 *
 * Args:
 *   io: process context.
 *   argv: flags after the subcommand.
 *
 * Returns:
 *   number: exit code — 0 wired, 2 config/usage.
 */
export function enforceCommand(io, argv) {
    if (argv.length > 0) {
        throw new UsageError(`unknown arguments for enforce (${ENFORCE_USAGE}): ${argv.join(' ')}`);
    }
    if (!existsSync(join(io.cwd, '.gateforge.yml'))) {
        throw new UsageError('no .gateforge.yml found — run `gateforge init` first');
    }
    ensureBlockingWiring(io, engineRootFromInvocation());
    writeLine(io.stdout, 'blocking gate wired: pre-commit (gateforge check --changed) + .gitlab-ci.yml include');
    return 0;
}
//# sourceMappingURL=enforce.js.map