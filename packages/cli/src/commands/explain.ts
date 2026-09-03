/**
 * `gateforge explain <resourceId>`: the complete signal/rule/obligation
 * trace for one resource (plan phase 5). Prints the effective
 * classification with its decision trace (rules, conservative defaults,
 * contributing signals + detector versions, contradictions, decision
 * fingerprint) and every obligation the policy engine generated from it
 * — or, when the classifier blocked the resource, every typed block with
 * its in-code resolution path. Deterministic: re-running the command on
 * an unchanged repository prints byte-identical output.
 */
import { canonicalJson, fingerprint, type JsonValue } from '@gateforge/core';
import { parseArgs } from '../args.js';
import type { Io } from '../io.js';
import { writeLine } from '../io.js';
import { runPipeline } from '../pipeline.js';
import { resolveStateDir } from '../state.js';
import { loadConfigAt, rejectUnknownFlags } from './common.js';

export const EXPLAIN_USAGE = 'usage: gateforge explain <resourceId> [--json]';

/**
 * Runs the explain subcommand.
 *
 * Args:
 *   io: process context.
 *   argv: flags after the subcommand.
 *
 * Returns:
 *   number: exit code — 0 when the resource resolved, 1 when unknown or
 *   blocked (fail visible), 2 config/usage.
 * @throws fail-closed errors (exit 2) from config/plugin/pipeline layers.
 */
export async function explainCommand(io: Io, argv: readonly string[]): Promise<number> {
  const { options, positionals } = parseArgs(argv);
  if (options['help'] === true || positionals.length === 0) {
    writeLine(io.stdout, EXPLAIN_USAGE);
    return positionals.length === 0 && options['help'] !== true ? 2 : 0;
  }
  rejectUnknownFlags(options, ['json', 'help'], EXPLAIN_USAGE);
  const asJson = options['json'] === true;
  const target = positionals[0];
  if (target === undefined || target.length === 0) {
    writeLine(io.stderr, 'explain: a resource id is required');
    writeLine(io.stderr, EXPLAIN_USAGE);
    return 2;
  }

  const config = loadConfigAt(io.cwd);
  const pipeline = await runPipeline({
    cwd: io.cwd,
    env: io.env,
    config,
    provider: 'all-files',
    stateDir: resolveStateDir(io.cwd),
  });

  const resource = pipeline.graph.resources.find(
    (candidate) => candidate.id === target || candidate.name === target,
  );
  if (resource === undefined) {
    writeLine(io.stderr, `explain: no discovered resource matches '${target}'`);
    const known = pipeline.graph.resources.map((candidate) => candidate.id ?? candidate.name);
    if (known.length > 0) writeLine(io.stderr, `discovered: ${known.join(', ')}`);
    return 1;
  }

  const decision = pipeline.classification.decisions.find(
    (candidate) =>
      candidate.name === resource.name &&
      candidate.source === resource.source &&
      candidate.location.file === resource.location.file &&
      candidate.location.line === resource.location.line,
  );
  const obligations = pipeline.policy.obligations.filter(
    (obligation) => obligation.resourceId === resource.id,
  );

  if (asJson) {
    writeLine(
      io.stdout,
      canonicalJson({
        schemaVersion: 1 as const,
        resource: resource as unknown as JsonValue,
        decision: (decision ?? null) as unknown as JsonValue,
        obligations: obligations as unknown as JsonValue,
        blocking: pipeline.policy.blocking.filter(
          (entry) =>
            entry.resourceId === resource.id ||
            entry.name === resource.name ||
            (resource.id !== null && entry.detail.includes(resource.id)),
        ) as unknown as JsonValue,
      }),
    );
    return decision !== undefined && decision.blocks.length === 0 ? 0 : 1;
  }

  writeLine(
    io.stdout,
    `resource ${resource.id ?? `<unresolved:${resource.name}>`} [${resource.kind}]`,
  );
  writeLine(io.stdout, `  source: ${resource.source}:${String(resource.location.line)}`);
  writeLine(io.stdout, `  detector: ${resource.detector.id}@${resource.detector.version}`);
  if (resource.kind === 'http.endpoint') {
    // Plan phase 7: the join trace — capabilities with their rules, the
    // linked business resource, and both ends' sources.
    const attributes = resource.attributes as Record<string, unknown>;
    const canonicalPath = String(attributes['canonicalPath'] ?? '<unknown>');
    writeLine(io.stdout, `  endpoint: ${String(attributes['method'] ?? '?')} ${canonicalPath}`);
    writeLine(io.stdout, `  capabilities: ${(attributes['capabilities'] as string[] | undefined)?.join(', ') || '<unresolved>'}`);
    for (const traceEntry of (attributes['capabilityTrace'] as Array<{ capability: string; rule: string }> | undefined) ?? []) {
      writeLine(io.stdout, `    - ${traceEntry.capability} <- ${traceEntry.rule}`);
    }
    writeLine(io.stdout, `  linkedResource: ${String(attributes['linkedResourceName'] ?? '<none>')}`);
    writeLine(io.stdout, `  frontendConsumed: ${String(attributes['frontendConsumed'] ?? 'false')}`);
    for (const source of (attributes['serverSources'] as string[] | undefined) ?? []) {
      writeLine(io.stdout, `  route source: ${source}`);
    }
    for (const source of (attributes['callSources'] as string[] | undefined) ?? []) {
      writeLine(io.stdout, `  call source: ${source}`);
    }
  }
  const classification = resource.classification;
  const trace = resource.classificationTrace;
  if (classification === null || trace === null || decision === undefined) {
    writeLine(io.stdout, '  classification: BLOCKED');
  } else {
    writeLine(io.stdout, `  exposure: ${String(classification.exposure)}`);
    writeLine(io.stdout, `  plane: ${String(classification.plane)}`);
    writeLine(io.stdout, `  primaryKey: [${classification.primaryKey.join(', ')}]`);
    writeLine(
      io.stdout,
      `  lifecycle: create=${String(classification.lifecycle.create)} read=${String(classification.lifecycle.read)} ` +
        `update=${String(classification.lifecycle.update)} delete=${String(classification.lifecycle.delete)}` +
        (classification.lifecycle.deleteSemantics !== undefined
          ? ` (${classification.lifecycle.deleteSemantics})`
          : ' (semantics UNRESOLVED)'),
    );
    if (classification.evidenceAdapter !== undefined) {
      writeLine(io.stdout, `  evidenceAdapter: ${classification.evidenceAdapter}`);
    }
    writeLine(io.stdout, '  rules:');
    for (const rule of trace.rules) writeLine(io.stdout, `    - ${rule}`);
    if (trace.defaultsApplied.length > 0) {
      writeLine(io.stdout, '  conservative defaults applied:');
      for (const rule of trace.defaultsApplied) writeLine(io.stdout, `    - ${rule}`);
    }
    writeLine(
      io.stdout,
      `  contributing signals: ${String(trace.contributingSignalIds.length)} ` +
        `(${trace.contributingDetectors.join(', ')})`,
    );
    for (const signalId of trace.contributingSignalIds) {
      writeLine(io.stdout, `    - ${signalId}`);
    }
    if (trace.contradictions.length > 0) {
      writeLine(io.stdout, '  contradictions:');
      for (const contradiction of trace.contradictions) {
        writeLine(io.stdout, `    [${contradiction.dimension}] ${contradiction.detail}`);
      }
    }
    writeLine(io.stdout, `  decisionFingerprint: ${trace.decisionFingerprint}`);
  }
  for (const block of decision?.blocks ?? []) {
    const where = block.locations
      .map((location) => `${location.file}:${String(location.line)}`)
      .join(', ');
    writeLine(
      io.stdout,
      `  block [${block.code}] ${block.detail}${where.length > 0 ? ` (${where})` : ''}`,
    );
  }
  writeLine(io.stdout, `obligations (${String(obligations.length)}):`);
  for (const obligation of obligations) {
    writeLine(
      io.stdout,
      `  ${obligation.id} (policy ${obligation.policyId}, fingerprint ${fingerprint({
        resourceId: obligation.resourceId,
        contract: obligation.contract,
        policyId: obligation.policyId,
        lifecycle: obligation.lifecycle,
      })})`,
    );
  }
  const blocked = (decision?.blocks.length ?? 0) > 0 || resource.classification === null;
  return blocked ? 1 : 0;
}
