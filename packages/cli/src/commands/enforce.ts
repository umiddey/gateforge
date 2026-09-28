/**
 * `gateforge enforce`: wire the blocking gate into an ALREADY initialized
 * repo — the retroactive path for repos created before `init --blocking`
 * existed, or by repos that opted out at init time and changed their mind.
 *
 * Writes, idempotently and never overwriting user files:
 *   .gateforge/hooks/gateforge-check.sh   (executable; runs `gateforge check --changed`)
 *   .pre-commit-config.yaml               (gateforge-check local hook appended)
 *   .gateforge/ci/gitlab-gateforge.yml or .github/workflows/gateforge.yml
 *   provider include wiring
 *
 * Requires .gateforge.yml: without a compiled-obligations config the check
 * has nothing to gate on.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Io } from '../io.js';
import { writeLine } from '../io.js';
import { UsageError } from '../errors.js';
import { installPrePushHook } from '../git-hooks.js';
import { loadConfigAt } from './common.js';
import { ensureBlockingWiring, engineRootFromInvocation } from './blocking.js';

export const ENFORCE_USAGE = 'usage: gateforge enforce [--ci github|gitlab]';

/**
 * Selects CI wiring from `--ci`, repository files, or the GitLab default.
 *
 * Args:
 *   io: process context.
 *   argv: arguments after the subcommand.
 *
 * Returns:
 *   number: exit code — 0 wired, 2 config/usage.
 */
export function enforceCommand(io: Io, argv: readonly string[]): number {
  let ci: 'github' | 'gitlab' | null = null;
  if (argv.length === 2 && argv[0] === '--ci' && (argv[1] === 'github' || argv[1] === 'gitlab')) {
    ci = argv[1];
  } else if (argv.length !== 0) {
    throw new UsageError(`unknown arguments for enforce (${ENFORCE_USAGE}): ${argv.join(' ')}`);
  }
  if (!existsSync(join(io.cwd, '.gateforge.yml'))) {
    throw new UsageError('no .gateforge.yml found — run `gateforge init` first');
  }
  const selectedCi =
    ci ??
    (existsSync(join(io.cwd, '.github')) && !existsSync(join(io.cwd, '.gitlab-ci.yml')) ? 'github' : 'gitlab');
  const receiptStage = loadConfigAt(io.cwd).enforcement?.receiptStage;
  const gateArgs = receiptStage === 'pre-commit' ? ['check', '--changed', '--require-e2e'] : ['check', '--changed'];
  ensureBlockingWiring(io, engineRootFromInvocation(), gateArgs, 'check', selectedCi);
  if (receiptStage === 'pre-push') {
    const outcome = installPrePushHook(io.cwd, io.env);
    if (outcome.status === 'conflict' || outcome.status === 'incomplete') {
      throw new UsageError(`${outcome.detail}\nRequired action:\n${outcome.action}`);
    }
    writeLine(io.stdout, `${outcome.status}: ${outcome.detail}`);
  }
  writeLine(
    io.stdout,
    `blocking gate wired: ${receiptStage === 'pre-push' ? 'pre-push receipt lane' : 'pre-commit static lane'} + ${selectedCi} CI`,
  );
  return 0;
}
