/**
 * Shared command helpers: config loading, flag validation, the report
 * format vocabulary, and the tool version stamp.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig, type GateforgeConfig } from '@gate-forge/core';
import { UsageError } from '../errors.js';
import { rejectLegacyExclusions } from '../legacy-exclusion-paths.js';
import { writeLine, type Io } from '../io.js';

/**
 * Tool version stamped into SARIF `tool.driver.version` (pin #10) and
 * reported by `--version`. Read from the package manifest at runtime so
 * the reported version always matches the published release — a
 * hardcoded constant drifted silently across releases (0.1.0 lie).
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
export const VERSION: string = require('../../package.json').version;

/**
 * Env var carrying the witness verifier key (pin #7, GF-23). The key is
 * read from the environment, NEVER from argv: `/proc/<pid>/cmdline` is
 * world-readable, so a command-line flag would publish the orchestrator
 * secret to every local process — including the tested suite. (Env is
 * readable only by the same uid and, under the default yama
 * ptrace_scope ≥ 1, a child cannot read its parent's environ; for
 * stronger isolation run the suite as a distinct user or container.)
 * The explicit key-file source is resolved by verifier-keys.ts. Both
 * source variables are stripped from suite and runner child environments.
 */
export const VERIFIER_KEY_ENV = 'GATEFORGE_WITNESS_VERIFIER_KEY';

/** Explicit external owner-only key-ring file path. */
export const VERIFIER_KEY_FILE_ENV = 'GATEFORGE_WITNESS_VERIFIER_KEY_FILE';

/** Report formats renderRun accepts (pin #10). */
export const REPORT_FORMATS = ['text', 'json', 'sarif'] as const;

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
export function parseRunFormat(value: string): ReportFormat {
  if (!(REPORT_FORMATS as readonly string[]).includes(value)) {
    throw new UsageError(`--format must be one of: text, json, sarif (got '${value}')`);
  }
  return value as ReportFormat;
}

/**
 * Loads `.gateforge.yml` from the io cwd (fail closed via core).
 *
 * Refuses a repository that still carries a pre-0.10 evidence-exclusion
 * declaration: reading it would silently drop the owner's exclusions,
 * so EVERY command that loads config stops and names `gateforge migrate`.
 *
 * Args:
 *   cwd: repo root.
 *
 * Returns:
 *   GateforgeConfig: validated config.
 * @throws GateforgeConfigError (config error, exit 2) on any problem.
 * @throws UsageError when a pre-0.10 exclusion declaration is present.
 */
export function loadConfigAt(cwd: string): GateforgeConfig {
  rejectLegacyExclusions(cwd);
  return loadConfig(join(cwd, '.gateforge.yml'));
}

/**
 * The default runtime document (`.gateforge/runtime.yml`):
 * the document the gate commands read ONLY when `.gateforge.yml`
 * declares it with a `runtime:` key.
 */
const DEFAULT_RUNTIME_DOCUMENT = '.gateforge/runtime.yml';

/**
 * Warns when the default runtime document exists on disk but
 * `.gateforge.yml` never declared it.
 *
 * The document is a TRUSTED POLICY INPUT: it is hashed into
 * the policy digest only when declared, so the gate commands
 * (`check`, `test-gates`, the commit hook) resolve
 * `config.runtime` to null and silently ignore the owner's
 * `envAllowlist`, `prepare` and services — the first symptom
 * is a witnessed run whose test process sees none of the
 * `E2E_*` variables the recipe was supposed to grant. This
 * warning is the only place that names the cause before that
 * run. The document is NEVER read here: reading it
 * implicitly would hash different bytes into the policy
 * digest without the owner approving the change.
 *
 * Args:
 *   io: process context (cwd + stderr).
 *   config: the loaded `.gateforge.yml`.
 *
 * Returns:
 *   void — one warning line, or nothing when the declaration
 *   matches reality.
 */
export function warnUndeclaredRuntime(io: Io, config: GateforgeConfig): void {
  if (config.runtime !== undefined) return;
  if (!existsSync(join(io.cwd, ...DEFAULT_RUNTIME_DOCUMENT.split('/')))) return;
  writeLine(
    io.stderr,
    `warning: ${DEFAULT_RUNTIME_DOCUMENT} exists but .gateforge.yml declares no runtime key — ` +
      'its envAllowlist, prepare and services are ignored by every gate command. ' +
      `fix: add \`runtime: ${DEFAULT_RUNTIME_DOCUMENT}\` to .gateforge.yml`,
  );
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
export function rejectUnknownFlags(
  options: Record<string, unknown>,
  allowed: readonly string[],
  usage: string,
): void {
  const allowedSet = new Set(allowed);
  for (const name of Object.keys(options)) {
    if (!allowedSet.has(name)) {
      throw new UsageError(`unknown flag '--${name}' (${usage})`);
    }
  }
}
