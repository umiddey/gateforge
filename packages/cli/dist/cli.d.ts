import type { Io } from './io.js';
/** The top-level usage text (also printed for `--help`). */
export declare const USAGE = "usage: gateforge <command> [options]\n\ncommands:\n  init [--languages <comma,list>] [--blocking]  create .gateforge.yml + skeleton; --blocking wires pre-commit + CI gate (idempotent)\n  enforce                                 wire the blocking pre-commit + CI gate into an initialized repo (idempotent)\n  adopt                                   adopt enforcement: seed the baseline from current debt (the one bulk-add) + wire the gate\n  discover [--json]                      run detectors and dump the resource graph\n  classify [--json] [--write-snapshot P] inspect effective classifications + typed blocks\n  explain <resourceId> [--json]          full signal/rule/obligation trace for one resource\n  obligations [--json]                   evaluate policies and dump obligations\n  check [--changed] [--format F]         run the full gate and report (F: text|json|sarif)\n  test-gates [--suite CMD] [--out DIR]   orchestrate a suite run over the obligations\n             [--format F] [--witness-url URL]\n  baseline update <fp...>                shrink the baseline to a strict subset (invariant 4)\n  --version                              print the version\n  --help                                 show this help\n\nexit codes: 0 clean/waived, 1 unresolved obligations, 2 config/usage error";
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
export declare function main(argv: readonly string[], io?: Io): Promise<number>;
//# sourceMappingURL=cli.d.ts.map