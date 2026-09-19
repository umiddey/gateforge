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
import type { Io } from './io.js';
import { processIo, writeLine } from './io.js';
import { VERSION } from './commands/common.js';
import { initCommand } from './commands/init.js';
import { enforceCommand } from './commands/enforce.js';
import { adoptCommand } from './commands/adopt.js';
import { discoverCommand } from './commands/discover.js';
import { obligationsCommand } from './commands/obligations.js';
import { checkCommand } from './commands/check.js';
import { nextCommand } from './commands/next.js';
import { testGatesCommand } from './commands/test-gates.js';
import { baselineCommand } from './commands/baseline.js';
import { waiveCommand } from './commands/waive.js';
import { classifyCommand } from './commands/classify.js';
import { explainCommand } from './commands/explain.js';
import { testsCommand } from './commands/tests.js';
import { enforcementCommand } from './commands/enforcement.js';
import { brokerCommand } from './broker.js';

/** The top-level usage text (also printed for `--help`). */
export const USAGE = `\
usage: gateforge <command> [options]

commands:
  init [--languages <comma,list>] [--plugins <comma,list>] [--accept-recommended] [--no-scan]
        [--proof overlay|observe] [--blocking] [--strict-e2e]
                                         scan the repo, print the recommended install, and write
                                         .gateforge.yml + skeleton + GATEFORGE.md + overlay README
                                         (idempotent; --blocking installs AND verifies an active
                                         pre-commit hook + CI wiring)
  enforce                                 wire the blocking pre-commit + CI gate into an initialized repo (idempotent)
  adopt                                   adopt enforcement: seed the baseline from current debt (the one bulk-add) + wire the gate
  discover [--json]                      run detectors and dump the resource graph
  classify [--json] [--write-snapshot P] inspect effective classifications + typed blocks
  explain <resourceId> [--json]          full signal/rule/obligation trace for one resource
  tests discover [--json] [--pytest]     inventory existing tests into the run-state catalog
  tests suggest [--changed] [--json]     suggest existing tests for uncovered obligations (inspection, never a gate)
  tests mark --test K --kind K [--category C]...
        --obligation ID... --reason "T"  declare an existing test in .gateforge/test-map.yml (atomic, idempotent)
  tests explain --test K [--json]        requirements/mapping/next action for one existing test
  tests diagnose [--suite N] [--json]    run the configured pytest diagnostic suites (advisory; exit 0/1/2)
  obligations [--json]                   evaluate policies and dump obligations
  check [--changed] [--staged]           run the full gate and report (F: text|json|sarif). --staged gates the
        [--require-e2e] [--format F]     EXACT staged candidate (frozen index checkout, never the worktree);
                                         --require-e2e blocks without a valid, non-stale gate receipt
  next [--changed] [--json]              print the ONE blocking next action (navigation, not the gate)
  test-gates [--changed] [--suite CMD]   supervised E2E run over the obligations (--changed) or the
        [--out DIR] [--format F]         legacy suite escape hatch; seals a gate receipt on complete success
        [--witness-url URL]
  broker commit --workspace DIR          managed-mode commit broker (MECHANISM, not deployment): verifies a gate
        --message MSG [--receipt P]      receipt for the exact workspace bytes, then commits via compare-and-swap
        [--ref REF]                      ref update. Guaranteed only when the broker runs outside the agent's
                                         write/process boundary (ADR 0005 D1)
  enforcement doctor [--json]            honest enforcement diagnostics: hook activation, runner/observer readiness,
                                         trusted binary/policy ownership, snapshot mode, standard/managed boundary
  baseline update <fp...>                shrink the baseline to a strict subset (invariant 4)
  waive <resourceId:contract>            write an expiring, owner-approved waiver for one obligation
        --owner N --approver N           (GF-15: all fields mandatory; justification URL required;
        --justification-url U --expires D  no --force — renewal is a hand-edit of the written file)
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
export async function main(argv: readonly string[], io: Io = processIo()): Promise<number> {
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
    case 'enforce':
      return runWithExitCodes(io, () => Promise.resolve(enforceCommand(io, rest)));
    case 'adopt':
      return runWithExitCodes(io, () => adoptCommand(io, rest));
    case 'init':
      return runWithExitCodes(io, () => Promise.resolve(initCommand(io, rest)));
    case 'discover':
      return runWithExitCodes(io, () => discoverCommand(io, rest));
    case 'classify':
      return runWithExitCodes(io, () => classifyCommand(io, rest));
    case 'explain':
      return runWithExitCodes(io, () => explainCommand(io, rest));
    case 'tests':
      return runWithExitCodes(io, () => testsCommand(io, rest));
    case 'obligations':
      return runWithExitCodes(io, () => obligationsCommand(io, rest));
    case 'check':
      return runWithExitCodes(io, () => checkCommand(io, rest));
    case 'next':
      return runWithExitCodes(io, () => nextCommand(io, rest));
    case 'test-gates':
      return runWithExitCodes(io, () => testGatesCommand(io, rest));
    case 'enforcement':
      return runWithExitCodes(io, () => enforcementCommand(io, rest));
    case 'broker':
      return runWithExitCodes(io, () => brokerCommand(io, rest));
    case 'baseline':
      return runWithExitCodes(io, () => Promise.resolve(baselineCommand(io, rest)));
    case 'waive':
      return runWithExitCodes(io, () => waiveCommand(io, rest));
    default:
      return runWithExitCodes(io, async () => {
        // parseArgs validates flag syntax; unknown commands are usage errors.
        parseArgs(rest);
        throw new UsageError(`unknown command '${command}'`);
      });
  }
}