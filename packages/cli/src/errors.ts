/**
 * Fail-closed error handling for the CLI.
 *
 * Exit-code contract (architecture contract 4 / pin #4): 0 clean or
 * waived, 1 unresolved obligations, 2 config/usage error. Every
 * fail-closed class in the engine (config, waivers, baselines, policy,
 * GPP/3 protocol failures) maps to 2 with its single-cause diagnostic on
 * stderr; gate outcomes map to 0/1 through `runExitCode`.
 */
import type { Io } from './io.js';
import { writeLine } from './io.js';

/** Error classes that mean "config/usage problem" → exit 2. */
const CONFIG_ERROR_NAMES = new Set([
  'GateforgeConfigError',
  'GateforgeWaiverError',
  'GateforgeBaselineError',
  'PolicyEvaluationError',
  'GateforgeVerdictError',
  'ProtocolFailure',
]);

/** A CLI usage error (unknown subcommand, bad flags, bad state files). */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

/**
 * Whether an error is a config/usage failure (exit 2) rather than a gate
 * outcome. Protocol failures carry subtype names (FrameJsonError etc.)
 * but are all `instanceof ProtocolFailure` — checked by name here to
 * keep the CLI decoupled from the protocol package's class hierarchy.
 */
export function isConfigError(error: unknown): boolean {
  if (error instanceof UsageError) return true;
  if (error instanceof Error && CONFIG_ERROR_NAMES.has(error.name)) return true;
  return false;
}

/** Print a fail-closed diagnostic to stderr: `gateforge: <message>`. */
export function printFailure(io: Io, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  writeLine(io.stderr, `gateforge: ${message}`);
}

/**
 * Runs a command body, mapping expected failures to their exit code.
 * The body's own return value is an exit code already; only thrown
 * failures are classified here.
 */
export async function runWithExitCodes(io: Io, body: () => Promise<number>): Promise<number> {
  try {
    return await body();
  } catch (error) {
    if (isConfigError(error)) {
      printFailure(io, error);
      return 2;
    }
    throw error;
  }
}