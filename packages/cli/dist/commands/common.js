/**
 * Shared command helpers: config loading, flag validation, the report
 * format vocabulary, and the tool version stamp.
 */
import { join } from 'node:path';
import { loadConfig } from '@gate-forge/core';
import { UsageError } from '../errors.js';
/**
 * Tool version stamped into SARIF `tool.driver.version` (pin #10) and
 * reported by `--version`. Read from the package manifest at runtime so
 * the reported version always matches the published release — a
 * hardcoded constant drifted silently across releases (0.1.0 lie).
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
export const VERSION = require('../../package.json').version;
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
export const VERIFIER_KEY_ENV = 'GATEFORGE_WITNESS_VERIFIER_KEY';
/** Report formats renderRun accepts (pin #10). */
export const REPORT_FORMATS = ['text', 'json', 'sarif'];
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
export function parseRunFormat(value) {
    if (!REPORT_FORMATS.includes(value)) {
        throw new UsageError(`--format must be one of: text, json, sarif (got '${value}')`);
    }
    return value;
}
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
export function loadConfigAt(cwd) {
    return loadConfig(join(cwd, '.gateforge.yml'));
}
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
export function rejectUnknownFlags(options, allowed, usage) {
    const allowedSet = new Set(allowed);
    for (const name of Object.keys(options)) {
        if (!allowedSet.has(name)) {
            throw new UsageError(`unknown flag '--${name}' (${usage})`);
        }
    }
}
//# sourceMappingURL=common.js.map