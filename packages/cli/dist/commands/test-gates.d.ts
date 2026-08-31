import type { Io } from '../io.js';
export declare const TEST_GATES_USAGE: string;
/**
 * Runs the test-gates subcommand.
 *
 * Args:
 *   io: process context.
 *   argv: flags after the subcommand.
 *
 * Returns:
 *   number: exit code — 0 clean/waived, 1 unresolved or suite failure,
 *   2 config/usage.
 * @throws fail-closed errors (exit 2) from config/plugin/pipeline layers.
 */
export declare function testGatesCommand(io: Io, argv: readonly string[]): Promise<number>;
//# sourceMappingURL=test-gates.d.ts.map