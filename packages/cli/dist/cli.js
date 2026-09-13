/**
 * CLI dispatch: argv → subcommand → exit code.
 *
 * Entry contract (architecture contract 4): 0 clean/waived, 1 unresolved
 * obligations (or a failed test-gates suite), 2 config/usage error.
 * Every fail-closed engine error prints its single-cause diagnostic to
 * stderr and maps to 2; unexpected errors propagate to the bin wrapper,
 * which reports them as internal errors (also exit 2, never a clean run).
 */
import { parseArgs } from './args.js';
import { UsageError, runWithExitCodes } from './errors.js';
import { processIo, writeLine } from './io.js';
import { VERSION } from './commands/common.js';
import { initCommand } from './commands/init.js';
import { discoverCommand } from './commands/discover.js';
import { obligationsCommand } from './commands/obligations.js';
import { checkCommand } from './commands/check.js';
import { testGatesCommand } from './commands/test-gates.js';
import { baselineCommand } from './commands/baseline.js';
import { classifyCommand } from './commands/classify.js';
import { explainCommand } from './commands/explain.js';
/** The top-level usage text (also printed for `--help`). */
export const USAGE = `\
usage: gateforge <command> [options]

commands:
  init [--languages <comma,list>] [--blocking]  create .gateforge.yml + skeleton; --blocking wires pre-commit + CI gate (idempotent)
  discover [--json]                      run detectors and dump the resource graph
  classify [--json] [--write-snapshot P] inspect effective classifications + typed blocks
  explain <resourceId> [--json]          full signal/rule/obligation trace for one resource
  obligations [--json]                   evaluate policies and dump obligations
  check [--changed] [--format F]         run the full gate and report (F: text|json|sarif)
  test-gates [--suite CMD] [--out DIR]   orchestrate a suite run over the obligations
             [--format F] [--witness-url URL]
  baseline update <fp...>                shrink the baseline to a strict subset (invariant 4)
  --version                              print the version
  --help                                 show this help

exit codes: 0 clean/waived, 1 unresolved obligations, 2 config/usage error`;
/**
 * Runs the gateforge CLI.
 *
 * Args:
 *   argv: arguments after `gateforge` (node/script already stripped).
 *   io: process context (defaults to the live process).
 *
 * Returns:
 *   Promise<number>: the process exit code.
 */
export async function main(argv, io = processIo()) {
    const first = argv[0];
    if (first === undefined || first === '--help' || first === '-h' || first === 'help') {
        writeLine(io.stdout, USAGE);
        return 0;
    }
    if (first === '--version' || first === '-v') {
        writeLine(io.stdout, VERSION);
        return 0;
    }
    // `--` before the command keeps flag parsing honest (rare, but legal).
    const command = first === '--' ? argv[1] : first;
    if (command === undefined) {
        writeLine(io.stdout, USAGE);
        return 0;
    }
    const rest = first === '--' ? argv.slice(2) : argv.slice(1);
    switch (command) {
        case 'init':
            return runWithExitCodes(io, () => Promise.resolve(initCommand(io, rest)));
        case 'discover':
            return runWithExitCodes(io, () => discoverCommand(io, rest));
        case 'classify':
            return runWithExitCodes(io, () => classifyCommand(io, rest));
        case 'explain':
            return runWithExitCodes(io, () => explainCommand(io, rest));
        case 'obligations':
            return runWithExitCodes(io, () => obligationsCommand(io, rest));
        case 'check':
            return runWithExitCodes(io, () => checkCommand(io, rest));
        case 'test-gates':
            return runWithExitCodes(io, () => testGatesCommand(io, rest));
        case 'baseline':
            return runWithExitCodes(io, () => Promise.resolve(baselineCommand(io, rest)));
        default:
            return runWithExitCodes(io, async () => {
                // parseArgs validates flag syntax; unknown commands are usage errors.
                parseArgs(rest);
                throw new UsageError(`unknown command '${command}'`);
            });
    }
}
//# sourceMappingURL=cli.js.map