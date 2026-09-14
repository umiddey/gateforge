import type { Io } from '../io.js';
export declare const TESTS_USAGE = "usage: gateforge tests discover [--json] [--pytest]\n       gateforge tests suggest [--changed] [--json]\n       gateforge tests mark --test <key> --kind <kind> [--category <c>]... \\\n         --obligation <id>... --reason \"<text>\"\n       gateforge tests explain --test <key> [--json]\n       gateforge tests diagnose [--suite <name>] [--json]";
/** The derived catalog file under the run-state directory. */
export declare const CATALOG_FILE_NAME = "test-catalog.json";
/**
 * Runs the `tests` command family (discover/suggest/mark/explain).
 *
 * Args:
 *   io: process context.
 *   argv: flags + positionals after the `tests` subcommand.
 *
 * Returns:
 *   number: exit code — 0 on success (unresolved catalog rows and
 *     blocking mapping problems are DATA on the inspection surfaces),
 *     2 for config/usage errors.
 * @throws UsageError for unknown subcommands/flags, unknown test keys or
 *   obligation ids, contradictory declarations, and failed native
 *   enumeration; config errors propagate from core (all exit 2).
 */
export declare function testsCommand(io: Io, argv: readonly string[]): Promise<number>;
//# sourceMappingURL=tests.d.ts.map