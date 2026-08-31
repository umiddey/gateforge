import { type GateforgeConfig } from '@gateforge/core';
/** Tool version stamped into SARIF `tool.driver.version` (pin #10). */
export declare const VERSION = "0.1.0";
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