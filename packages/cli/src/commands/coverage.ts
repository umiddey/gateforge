/**
 * `gateforge coverage draft`: print a paste-ready `coveragePolicy:` block
 * derived from the current resource inventory (plan 2026-10-18) — one
 * entry per user-facing table, `requiredOperations` = that table's
 * lifecycle-enabled operations, sorted by name.
 *
 * The command is strictly READ-ONLY: it never writes any file. Declaring
 * the policy is the owner's act (GATEFORGE.md "Never self-approve") — an
 * agent pasting it into `.gateforge.yml` would be self-approving the very
 * guard meant to stop agent edits, so the draft only prints and the owner
 * reviews, pastes, and repins.
 *
 * `--json` prints the GF-canonical JSON of the draft policy object (the
 * same shape `CoveragePolicySchema` validates).
 */
import { canonicalJson, CoveragePolicySchema, type JsonValue } from '@gate-forge/core';
import { parseArgs } from '../args.js';
import type { Io } from '../io.js';
import { writeLine } from '../io.js';
import { UsageError } from '../errors.js';
import { coverageInventory } from '../evaluate.js';
import { runPipeline } from '../pipeline.js';
import { resolveStateDir } from '../state.js';
import { loadConfigAt, rejectUnknownFlags } from './common.js';

export const COVERAGE_USAGE = 'usage: gateforge coverage draft [--json]';

/** The header comment printed above every text draft. */
const DRAFT_HEADER =
  '# coveragePolicy draft — owner review required; pasting it is the owner act; repin afterwards';

/**
 * Runs the coverage subcommand.
 *
 * Args:
 *   io: process context.
 *   argv: tokens after the subcommand (`draft` positionals + flags).
 *
 * Returns:
 *   number: exit code (0 on success).
 * @throws UsageError (exit 2) for an unknown subcommand/flag or when the
 *   inventory yields a table no valid policy can name (duplicate names,
 *   a table with no lifecycle-enabled operation).
 */
export async function coverageCommand(io: Io, argv: readonly string[]): Promise<number> {
  const { options, positionals } = parseArgs(argv);
  if (options['help'] === true) {
    writeLine(io.stdout, COVERAGE_USAGE);
    return 0;
  }
  rejectUnknownFlags(options, ['json', 'help'], COVERAGE_USAGE);
  if (positionals[0] !== 'draft' || positionals.length !== 1) {
    throw new UsageError(`coverage requires exactly one subcommand 'draft' (${COVERAGE_USAGE})`);
  }
  const asJson = options['json'] === true;

  const config = loadConfigAt(io.cwd);
  const pipeline = await runPipeline({
    cwd: io.cwd,
    env: io.env,
    config,
    provider: 'all-files',
    stateDir: resolveStateDir(io.cwd),
  });
  const draft = CoveragePolicySchema.parse({
    tables: coverageInventory(pipeline.graph).map((table) => ({
      name: table.name,
      requiredOperations: [...table.operations],
    })),
  });

  if (asJson) {
    writeLine(io.stdout, canonicalJson(draft as unknown as JsonValue));
    return 0;
  }
  const lines = [
    DRAFT_HEADER,
    'coveragePolicy:',
    '  tables:',
    ...draft.tables.map(
      (table) =>
        `    - name: ${table.name}\n      requiredOperations: [${table.requiredOperations.join(', ')}]`,
    ),
  ];
  writeLine(io.stdout, lines.join('\n'));
  return 0;
}
