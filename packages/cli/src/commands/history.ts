import { join } from 'node:path';
import { parseArgs, stringFlag } from '../args.js';
import { queryRunHistory } from '../history.js';
import { UsageError } from '../errors.js';
import type { Io } from '../io.js';
import { writeLine } from '../io.js';
import { resolveStateDir } from '../state.js';
import { rejectUnknownFlags } from './common.js';

const HISTORY_USAGE = 'usage: gateforge history [--test <text>] [--failed] [--since <ISO-8601>]';

/** Prints retained supervised run history with optional test, failure, and date filters.
 *
 * Args:
 *   io: process context.
 *   argv: history command flags.
 *
 * Returns:
 *   number: 0 for a valid query, 2 for invalid options or dates.
 */
export function historyCommand(io: Io, argv: readonly string[]): number {
  const options = parseArgs(argv);
  rejectUnknownFlags(options.options, ['test', 'failed', 'since'], HISTORY_USAGE);
  const test = stringFlag(options.options, 'test');
  const since = stringFlag(options.options, 'since');
  const failed = options.options['failed'] === true;
  if (options.options['failed'] !== undefined && options.options['failed'] !== true) {
    throw new UsageError('--failed does not accept a value');
  }
  let runs;
  try {
    runs = queryRunHistory(join(resolveStateDir(io.cwd), 'history'), {
      ...(test === undefined ? {} : { test }),
      failed,
      ...(since === undefined ? {} : { since }),
    });
  } catch (error) {
    throw new UsageError((error as Error).message);
  }
  for (const run of runs) {
    writeLine(
      io.stdout,
      `${run.finishedAt} ${run.status} tests=${String(run.testCount)} failed=${String(run.failedCount)} run=${run.runId}`,
    );
  }
  if (runs.length === 0) writeLine(io.stdout, 'no retained runs matched');
  return 0;
}
