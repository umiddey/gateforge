/**
 * `gateforge explain <resourceId|path>`: the complete signal/rule/obligation
 * trace for one resource (plan phase 5). A repo-relative PATH is also a
 * first-class target: when no discovered resource matches it, the command
 * prints what the file IS and what governs it (Gateforge-owned policy
 * input, declared gate input, owner-declared documentation folder, known
 * source of a resource, or an unclassified change), so an unmapped change
 * can be attributed. For a resource it prints the effective
 * classification with its decision trace (rules, conservative defaults,
 * contributing signals + detector versions, contradictions, decision
 * fingerprint) and every obligation the policy engine generated from it
 * — or, when the classifier blocked the resource, every typed block with
 * its in-code resolution path. Deterministic: re-running the command on
 * an unchanged repository prints byte-identical output.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalJson, type GateforgeConfig, fingerprintObligation, type JsonValue } from '@gate-forge/core';
import { parseArgs } from '../args.js';
import { classifyGateforgeOwnedInput } from '../gateforge-owned.js';
import { loadDocsExclusions } from '../docs-exclusions.js';
import { GIT_SCOPE_CONTROL_BASENAMES, MANIFEST_NAMES } from '../input-snapshot.js';
import type { Io } from '../io.js';
import { writeLine } from '../io.js';
import { runPipeline } from '../pipeline.js';
import { resolveStateDir } from '../state.js';
import { loadConfigAt, rejectUnknownFlags } from './common.js';

export const EXPLAIN_USAGE = 'usage: gateforge explain <resourceId|path> [--json]';

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
    // 0.9.0 problem 26: a repo-relative path is a first-class target. When no
    // discovered resource matches it, explain what the file IS and what
    // governs it — that is the answer an owner needs to attribute an unmapped
    // change (or to see that the file is Gateforge-owned). A target that is
    // not a path-shaped governance question stays an unknown target.
    const pathAnswer = pathGovernance({
      cwd: io.cwd,
      target,
      config,
      resourceSources: resourceSourcesByFile(pipeline.graph.resources),
      docsFolders: declaredDocsFolders(io.cwd, config),
    });
    if (pathAnswer !== null) {
      if (asJson) {
        writeLine(
          io.stdout,
          canonicalJson({
            schemaVersion: 1 as const,
            path: { target, ...pathAnswer } as unknown as JsonValue,
          }),
        );
        return 0;
      }
      writeLine(io.stdout, `path ${target}`);
      writeLine(io.stdout, `  what: ${pathAnswer.what}`);
      writeLine(io.stdout, `  governed by: ${pathAnswer.governedBy}`);
      if (pathAnswer.resources.length > 0) {
        writeLine(io.stdout, `  known source of: ${pathAnswer.resources.join(', ')}`);
      }
      if (pathAnswer.nextStep !== null) {
        writeLine(io.stdout, `  next step: ${pathAnswer.nextStep}`);
      }
      return 0;
    }
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
      `  ${obligation.id} (policy ${obligation.policyId}, fingerprint ${fingerprintObligation(obligation)})`,
    );
  }
  const blocked = (decision?.blocks.length ?? 0) > 0 || resource.classification === null;
  return blocked ? 1 : 0;
}

/** What the gate knows about one repo-relative path. */
interface PathGovernance {
  /** The governance class the path falls into. */
  kind: 'policy-input' | 'documentation' | 'gate-input' | 'resource-source' | 'unclassified';
  /** What the file is. */
  what: string;
  /** What governs it. */
  governedBy: string;
  /** Discovered resources that read this file as a source. */
  resources: string[];
  /** The command/step that resolves the situation, when one exists. */
  nextStep: string | null;
}

/**
 * Maps every resource source file to the resource labels that read it.
 *
 * Args:
 *   resources: discovered graph resources.
 *
 * Returns:
 *   Map<string, string[]>: repo-relative source file -> sorted labels.
 */
function resourceSourcesByFile(
  resources: readonly { name: string; source: string }[],
): Map<string, string[]> {
  const byFile = new Map<string, string[]>();
  for (const entry of resources) {
    byFile.set(entry.source, [...(byFile.get(entry.source) ?? []), entry.name]);
  }
  return new Map([...byFile].map(([file, labels]) => [file, labels.sort()]));
}

/**
 * The owner-declared documentation folders. An absent or invalid
 * declaration yields none here — `check` reports the declaration problem
 * on its own gate.
 *
 * Args:
 *   cwd: absolute repo root.
 *   config: the loaded gateforge config.
 *
 * Returns:
 *   string[]: declared documentation folders.
 */
function declaredDocsFolders(cwd: string, config: GateforgeConfig): string[] {
  try {
    return loadDocsExclusions(cwd, config);
  } catch {
    return [];
  }
}

/**
 * Explains what a repo-relative path is and what governs it (0.9.0 D2 /
 * problem 26).
 *
 * Args:
 *   args: the repo root, the target, the config, the discovered
 *     source-file index and the declared documentation folders.
 *
 * Returns:
 *   PathGovernance | null: the answer, or null when the target is not a
 *   path-shaped governance question at all (unknown target stays exit 1).
 */
function pathGovernance(args: {
  cwd: string;
  target: string;
  config: GateforgeConfig;
  resourceSources: Map<string, string[]>;
  docsFolders: readonly string[];
}): PathGovernance | null {
  const { cwd, target, config } = args;
  const posix = target.split('\\').join('/');
  // Absolute paths, parent escapes and targets that name nothing on disk are
  // not path-shaped governance questions.
  if (posix.length === 0 || posix.startsWith('/') || posix.split('/').includes('..')) return null;
  const owned = classifyGateforgeOwnedInput(cwd, posix, config);
  if (owned !== null) {
    return {
      kind: 'policy-input',
      what: `Gateforge-owned policy input (${owned.kind}) — ${owned.path}`,
      governedBy:
        'the owner-approved policy digest: a pin mismatch still blocks, and it is never an ' +
        'unmapped (CHANGE_UNMAPPED) product change',
      resources: [],
      nextStep: null,
    };
  }
  const documentation = args.docsFolders.find(
    (folder) => posix === folder || posix.startsWith(`${folder}/`),
  );
  if (documentation !== undefined) {
    return {
      kind: 'documentation',
      what: `file inside the owner-declared documentation folder '${documentation}'`,
      governedBy:
        'an owner assertion, not proof: Gateforge does not prove it cannot affect behavior or tests',
      resources: [],
      nextStep: null,
    };
  }
  if (!existsSync(join(cwd, ...posix.split('/')))) return null;
  const basename = posix.slice(posix.lastIndexOf('/') + 1);
  if (MANIFEST_NAMES.includes(basename)) {
    return {
      kind: 'gate-input',
      what: 'declared gate input (dependency manifest or lockfile)',
      governedBy:
        'the gate itself: a change here can change the scanned inventory, so it expands the scope ' +
        'to the whole repository and is never unmapped',
      resources: [],
      nextStep: null,
    };
  }
  if (GIT_SCOPE_CONTROL_BASENAMES.includes(basename)) {
    return {
      kind: 'gate-input',
      what: 'declared gate input (git ignore/scope control)',
      governedBy:
        'the gate itself: a change here can change the scanned inventory, so it expands the scope ' +
        'to the whole repository and is never unmapped',
      resources: [],
      nextStep: null,
    };
  }
  const sources = args.resourceSources.get(posix) ?? [];
  if (sources.length > 0) {
    return {
      kind: 'resource-source',
      what: 'source file of a discovered resource',
      governedBy: 'the obligations of those resources (each has its own `gateforge explain`)',
      resources: sources,
      nextStep: null,
    };
  }
  return {
    kind: 'unclassified',
    what:
      'unclassified product file: no discovered resource claims it as a source and no gate input covers it',
    governedBy:
      'strict E2E mode keeps an unmapped change visible and blocking (CHANGE_UNMAPPED) until it is mapped',
    resources: [],
    nextStep:
      'map the resource it belongs to, declare documentation folders with `gateforge init --docs-exclude <folders>`, ' +
      "declare developer/CI tooling with `project.paths.testTooling` in `.gateforge.yml` " +
      "(a `scripts/e2e/**` helper only `package.json` names — the declaration expands the scope and is " +
      'never a skip), or add the detection that owns it. Never weaken the policy.',
  };
}
