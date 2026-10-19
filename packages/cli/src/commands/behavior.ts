/**
 * `gateforge behavior draft`: print a paste-ready `behavior.yml` body
 * derived from the current endpoint inventory (plan 2026-10-18) — one
 * entry per discovered `http.endpoint`, sorted by resource id, each with
 * its `cases` commented out and a TODO comment, because the cases are
 * exactly the part no tool may invent.
 *
 * The command is strictly READ-ONLY: it never writes any file. Declaring
 * behavior is the owner's act (GATEFORGE.md "Never self-approve") — an
 * agent pasting the draft into `.gateforge/behavior.yml` would be
 * self-approving the very guard meant to stop agent edits, so the draft
 * only prints and the owner reviews, fills the real cases in, pastes,
 * and repins. An undeclared endpoint keeps blocking with
 * ENDPOINT_BEHAVIOR_MISSING until the owner declares it.
 *
 * `--json` prints the GF-canonical JSON of the draft document skeleton.
 * Unlike the coverage draft, the skeleton is deliberately NOT parsed
 * through `BehaviorPolicySchema` before printing: an entry with empty
 * `cases` is invalid by design (in-scope endpoints require cases or an
 * owner disposition), and the draft must show that honest, unfinished
 * state instead of pretending it validates.
 */
import { canonicalJson, HTTP_ENDPOINT_RESOURCE_KIND, type JsonValue } from '@gate-forge/core';
import { parseArgs } from '../args.js';
import type { Io } from '../io.js';
import { writeLine } from '../io.js';
import { UsageError } from '../errors.js';
import { runPipeline } from '../pipeline.js';
import { resolveStateDir } from '../state.js';
import { loadConfigAt, rejectUnknownFlags } from './common.js';

export const BEHAVIOR_USAGE = 'usage: gateforge behavior draft [--json]';

/** The header comment printed above every text draft. */
const DRAFT_HEADER =
  '# behavior draft — owner review required; pasting it is the owner act; repin afterwards';

/** The per-entry TODO the owner must answer before the document is valid. */
const ENTRY_TODO =
    '# TODO(owner): declare real behavior cases for this endpoint, or record an owner\n' +
    '# disposition (kind: out-of-scope|operational-only — `reason` is required).';

/**
 * Runs the pipeline read-only and returns the discovered endpoint ids,
 * sorted (deterministic draft order).
 *
 * Args:
 *   io: process context (cwd runs the pipeline, env feeds providers).
 *
 * Returns:
 *   string[]: every discovered `http.endpoint` resource id, sorted.
 */
export async function behaviorDraftEndpointIds(io: Io): Promise<string[]> {
  const config = loadConfigAt(io.cwd);
  const pipeline = await runPipeline({
    cwd: io.cwd,
    env: io.env,
    config,
    provider: 'all-files',
    stateDir: resolveStateDir(io.cwd),
  });
  return pipeline.graph.resources
    .filter((resource) => resource.kind === HTTP_ENDPOINT_RESOURCE_KIND && resource.id !== null)
    .map((resource) => resource.id as string)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * Runs the behavior subcommand.
 *
 * Args:
 *   io: process context.
 *   argv: tokens after the subcommand (`draft` positionals + flags).
 *
 * Returns:
 *   number: exit code (0 on success).
 * @throws UsageError (exit 2) for an unknown subcommand/flag.
 */
export async function behaviorCommand(io: Io, argv: readonly string[]): Promise<number> {
  const { options, positionals } = parseArgs(argv);
  if (options['help'] === true) {
    writeLine(io.stdout, BEHAVIOR_USAGE);
    return 0;
  }
  rejectUnknownFlags(options, ['json', 'help'], BEHAVIOR_USAGE);
  if (positionals[0] !== 'draft' || positionals.length !== 1) {
    throw new UsageError(`behavior requires exactly one subcommand 'draft' (${BEHAVIOR_USAGE})`);
  }
  const asJson = options['json'] === true;

  const endpointIds = await behaviorDraftEndpointIds(io);

  if (asJson) {
    const draft = {
      schemaVersion: 1 as const,
      endpoints: endpointIds.map((resourceId) => ({ resourceId, effects: [], cases: [] })),
      resources: [],
    };
    writeLine(io.stdout, canonicalJson(draft as unknown as JsonValue));
    return 0;
  }
  const lines = [
    DRAFT_HEADER,
    'schemaVersion: 1',
    'endpoints:',
    ...endpointIds.map(
      (resourceId) =>
        `  - resourceId: ${resourceId}\n    effects: []\n${ENTRY_TODO}\n    # cases: []`,
    ),
    'resources: []',
  ];
  writeLine(io.stdout, lines.join('\n'));
  return 0;
}
