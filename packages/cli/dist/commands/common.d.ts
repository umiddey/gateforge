import { type GateforgeConfig } from '@gate-forge/core';
export declare const VERSION: string;
/**
 * Env var carrying the witness verifier key (pin #7, GF-23). The key is
 * read from the environment, NEVER from argv: `/proc/<pid>/cmdline` is
 * world-readable, so a command-line flag would publish the orchestrator
 * secret to every local process — including the tested suite. (Env is
 * readable only by the same uid and, under the default yama
 * ptrace_scope ≥ 1, a child cannot read its parent's environ; for
 * stronger isolation run the suite as a distinct user or container.)
 * `test-gates` strips this var from the suite child's environment so a
 * suite can never inherit it.
 */
export declare const VERIFIER_KEY_ENV = "GATEFORGE_WITNESS_VERIFIER_KEY";
/** Report formats renderRun accepts (pin #10). */
export declare const REPORT_FORMATS: readonly ["text", "json", "sarif"];
/** One of the report formats. */
export type ReportFormat = (typeof REPORT_FORMATS)[number];
/**
 * Validates a `--format` value against the report formats.
 *
 * Args:
 *   value: raw flag value (already defaulted to 'text').
 *
 * Returns:
 *   ReportFormat: the validated format.
 * @throws Error naming the invalid value.
 */
export declare function parseRunFormat(value: string): ReportFormat;
/**
 * Loads `.gateforge.yml` from the io cwd (fail-closed via core).
 *
 * Args:
 *   cwd: repo root.
 *
 * Returns:
 *   GateforgeConfig: validated config.
 * @throws GateforgeConfigError (config error, exit 2) on any problem.
 */
export declare function loadConfigAt(cwd: string): GateforgeConfig;
/**
 * Rejects flags a command does not declare (typos fail loud).
 *
 * Args:
 *   options: parsed option map.
 *   allowed: flag names the command accepts.
 *   usage: usage line for diagnostics.
 *
 * @throws Error naming the first unknown flag.
 */
export declare function rejectUnknownFlags(options: Record<string, unknown>, allowed: readonly string[], usage: string): void;
//# sourceMappingURL=common.d.ts.map