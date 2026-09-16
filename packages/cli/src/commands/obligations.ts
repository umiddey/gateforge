/**
 * `gateforge obligations`: evaluate the policies against the built graph
 * and dump the generated obligations (plus blocking entries and claim
 * assessments).
 *
 * `--json` prints the GF-canonical JSON of the policy-engine result; the
 * default text form lists obligations, blocking entries, and claims. The
 * command never gates — it is the introspection half of the pipeline.
 */
import { canonicalJson, type JsonValue } from '@gate-forge/core';
import { parseArgs } from '../args.js';
import type { Io } from '../io.js';
import { writeLine } from '../io.js';
import { runPipeline } from '../pipeline.js';
import { resolveStateDir } from '../state.js';
import { loadConfigAt, rejectUnknownFlags } from './common.js';

export const OBLIGATIONS_USAGE = 'usage: gateforge obligations [--json]';

/**
 * Runs the obligations subcommand.
 *
 * Args:
 *   io: process context.
 *   argv: flags after the subcommand.
 *
 * Returns:
 *   number: exit code (0 on success).
 * @throws fail-closed errors (exit 2) from config/plugin/pipeline layers.
 */
export async function obligationsCommand(io: Io, argv: readonly string[]): Promise<number> {
  const { options } = parseArgs(argv);
  if (options['help'] === true) {
    writeLine(io.stdout, OBLIGATIONS_USAGE);
    return 0;
  }
  rejectUnknownFlags(options, ['json', 'help'], OBLIGATIONS_USAGE);
  const asJson = options['json'] === true;

  const config = loadConfigAt(io.cwd);
  const pipeline = await runPipeline({
    cwd: io.cwd,
    env: io.env,
    config,
    provider: 'all-files',
    stateDir: resolveStateDir(io.cwd),
  });

  if (asJson) {
    writeLine(io.stdout, canonicalJson(pipeline.policy as unknown as JsonValue));
    return 0;
  }
  const policy = pipeline.policy;
  writeLine(io.stdout, `obligations (${policy.obligations.length}):`);
  for (const obligation of policy.obligations) {
    writeLine(io.stdout, `  ${obligation.id}  (policy '${obligation.policyId}')`);
  }
  writeLine(io.stdout, `blocking (${policy.blocking.length}):`);
  for (const entry of policy.blocking) {
    const where =
      entry.location !== null ? ` at ${entry.location.file}:${entry.location.line}` : '';
    writeLine(
      io.stdout,
      `  [${entry.kind}] ${entry.resourceId ?? entry.name ?? '<unnamed>'} — ${entry.detail}${where}`,
    );
  }
  writeLine(io.stdout, `claims (${policy.claims.length}):`);
  for (const assessment of policy.claims) {
    const status = assessment.status === 'valid' ? 'valid' : `invalid (${assessment.reason ?? ''})`;
    writeLine(io.stdout, `  ${assessment.claim.testId} → ${assessment.claim.obligationId}: ${status}`);
  }
  return 0;
}