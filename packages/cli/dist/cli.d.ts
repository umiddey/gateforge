import type { Io } from './io.js';
/** The top-level usage text (also printed for `--help`). */
export declare const USAGE = "usage: gateforge <command> [options]\n\ncommands:\n  init [--languages <comma,list>]        create .gateforge.yml + skeleton (idempotent, never overwrites)\n  discover [--json]                      run detectors and dump the resource graph\n  obligations [--json]                   evaluate policies and dump obligations\n  check [--changed] [--format F]         run the full gate and report (F: text|json|sarif)\n  test-gates [--suite CMD] [--out DIR]   orchestrate a suite run over the obligations\n             [--format F] [--witness-url URL]\n  baseline update <fp...>                shrink the baseline to a strict subset (invariant 4)\n  --version                              print the version\n  --help                                 show this help\n\nexit codes: 0 clean/waived, 1 unresolved obligations, 2 config/usage error";
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