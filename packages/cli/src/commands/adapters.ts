/**
 * `gateforge adapters`: the evidence-adapter half of connecting a
 * project, in two subcommands.
 *
 * - `adapters scaffold [--dry-run]` writes ONE starting-point adapter
 *   per business resource that has none, from the compiled graph and
 *   the route inventory. It never overwrites, marks every guess in the
 *   file's own header, and prints the "needs you" cases with reasons.
 *   A generated adapter is a review starting point, never proof.
 * - `adapters check [--probe --base-url URL [--probe-id ID]]` loads
 *   every adapter, validates it against the same contract the witness
 *   validates, reports the resources that still have none, and (with
 *   `--probe`, the app running) issues ONE read-only GET per adapter
 *   and reports what the app actually answered.
 *
 * Both subcommands are read-only apart from writing new adapter files,
 * and neither ever blocks the gate: `adapters check` exits 0 when the
 * audit ran, 2 on a usage/config error.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import {
  canonicalJson,
  humanMessage,
  HTTP_ENDPOINT_RESOURCE_KIND,
  type JsonValue,
  type ResourceGraph,
} from '@gate-forge/core';
import { parseArgs, stringFlag } from '../args.js';
import { UsageError } from '../errors.js';
import type { Io } from '../io.js';
import { writeLine } from '../io.js';
import { runPipeline, type PipelineResult } from '../pipeline.js';
import { httpRoutesView, resolveStateDir } from '../state.js';
import {
  auditAdapters,
  listAdapterFiles,
  probeAdapter,
  type AdapterProbeReport,
  type UnresolvedRoute,
} from '../adapter-audit.js';
import { planAdapters, type AdapterTarget, type ScaffoldPlan } from '../adapter-scaffold.js';
import { loadConfigAt, rejectUnknownFlags } from './common.js';

export const ADAPTERS_USAGE =
  'usage: gateforge adapters scaffold [--dry-run] | gateforge adapters check [--probe --base-url URL] [--probe-id ID]';

/** Environment variable naming the target environment's marker. */
const TARGET_FINGERPRINT_ENV = 'GATEFORGE_TARGET_FINGERPRINT';

/**
 * The resources the classifier demands an evidence adapter for.
 *
 * Args:
 *   pipeline: a completed pipeline run.
 *
 * Returns:
 *   readonly GraphResource[]: the business resources blocked with
 *   ADAPTER_MISSING, in graph order.
 */
function resourcesNeedingAdapters(pipeline: PipelineResult): readonly AdapterTarget[] {
  // A resource blocked definitionally keeps its RAW graph id, so the
  // adapter name the classifier names is matched on both spellings.
  const wanted = new Map<string, { adapterId: string; deleteSemantics: 'hard' | 'archive' | null }>();
  for (const decision of pipeline.classification.decisions) {
    const block = decision.blocks.find((entry) => entry.code === 'ADAPTER_MISSING');
    if (block === undefined) continue;
    const adapterId = block.resourceId ?? decision.resourceId;
    if (adapterId === null) continue;
    wanted.set(decision.name, {
      adapterId,
      // A definitional block leaves the graph resource unclassified, so
      // the lifecycle the adapter must declare is not readable here: the
      // planner guesses `deletion` and says so in the file header.
      deleteSemantics: decision.classification?.lifecycle.deleteSemantics ?? null,
    });
  }
  const targets: AdapterTarget[] = [];
  for (const resource of pipeline.graph.resources) {
    const target = wanted.get(resource.name);
    if (target === undefined) continue;
    targets.push({ resource, adapterId: target.adapterId, deleteSemantics: target.deleteSemantics });
  }
  return targets;
}

/**
 * The GET routes the runtime route inventory omits because the
 * endpoint's plane is unanswered: such an endpoint has no
 * plane-qualified graph id, so `httpRoutesView` skips it. The route is
 * compiled and it exists — the scaffolder must name it with that
 * blocker instead of reporting the resource as unserved (GF-12).
 *
 * Args:
 *   graph: built resource graph.
 *
 * Returns:
 *   UnresolvedRoute[]: the plane-unanswered GET routes, path-sorted.
 */
function unresolvedPlaneRoutes(graph: ResourceGraph): UnresolvedRoute[] {
  const routes: UnresolvedRoute[] = [];
  for (const resource of graph.resources) {
    if (resource.id !== null || resource.kind !== HTTP_ENDPOINT_RESOURCE_KIND) continue;
    const method = resource.attributes['method'];
    const canonicalPath = resource.attributes['canonicalPath'];
    if (typeof method !== 'string' || method !== 'GET') continue;
    if (typeof canonicalPath !== 'string' || canonicalPath === '') continue;
    const linkedResourceName = resource.attributes['linkedResourceName'];
    routes.push({
      method,
      canonicalPath,
      ...(typeof linkedResourceName === 'string' ? { linkedResourceName } : {}),
    });
  }
  return routes.sort((a, b) =>
    a.canonicalPath < b.canonicalPath ? -1 : a.canonicalPath > b.canonicalPath ? 1 : 0,
  );
}

/**
 * Runs `gateforge adapters scaffold`.
 *
 * Args:
 *   io: process context.
 *   dryRun: print the plan without writing anything.
 *
 * Returns:
 *   number: the process exit code (0 on success).
 */
async function scaffold(io: Io, dryRun: boolean): Promise<number> {
  const config = loadConfigAt(io.cwd);
  const pipeline = await runPipeline({
    cwd: io.cwd,
    env: io.env,
    config,
    provider: 'all-files',
    stateDir: resolveStateDir(io.cwd),
  });
  const adaptersDir = join(io.cwd, config.adapters ?? '.gateforge/adapters');
  const existing = listAdapterFiles(adaptersDir).map((file) => file.slice(file.lastIndexOf(sep) + 1, -4));
  const targets = resourcesNeedingAdapters(pipeline);
  const plans = planAdapters({
    targets,
    routes: httpRoutesView(pipeline.graph),
    existing,
    environmentFingerprint: io.env[TARGET_FINGERPRINT_ENV] ?? null,
    unresolvedRoutes: unresolvedPlaneRoutes(pipeline.graph),
  });
  const created: ScaffoldPlan[] = [];
  const skipped: ScaffoldPlan[] = [];
  const needsYou: ScaffoldPlan[] = [];
  for (const plan of plans) {
    if (plan.status === 'exists') {
      skipped.push(plan);
      continue;
    }
    if (plan.status === 'needs-you') {
      needsYou.push(plan);
      continue;
    }
    created.push(plan);
    if (dryRun || plan.source === null) continue;
    mkdirSync(adaptersDir, { recursive: true });
    writeFileSync(join(adaptersDir, `${plan.resourceId}.mjs`), plan.source, 'utf8');
  }

  writeLine(
    io.stdout,
    `adapters scaffold: ${String(created.length)} to write, ${String(skipped.length)} already present, ` +
      `${String(needsYou.length)} needing a human${dryRun ? ' (--dry-run: nothing written)' : ''}`,
  );
  for (const plan of created) {
    writeLine(io.stdout, `  ${dryRun ? 'would write' : 'wrote'} ${config.adapters ?? '.gateforge/adapters'}/${plan.resourceId}.mjs`);
    for (const guess of plan.guesses) writeLine(io.stdout, `      guess: ${guess}`);
  }
  for (const plan of skipped) {
    writeLine(io.stdout, `  kept ${plan.resourceId}.mjs (already present; scaffold never overwrites)`);
  }
  if (needsYou.length > 0) {
    writeLine(io.stdout, 'needs you:');
    for (const plan of needsYou) {
      writeLine(io.stdout, `  ${plan.resourceId}: no adapter written`);
      for (const reason of plan.needsYou) writeLine(io.stdout, `      - ${reason}`);
    }
  }
  if (created.length > 0) {
    writeLine(
      io.stdout,
      'next: review each generated file, then `gateforge adapters check --probe --base-url <app-url>`',
    );
  }
  if (needsYou.length > 0) {
    writeLine(io.stdout, 'next: resolve the "needs you" cases above, then re-run `gateforge adapters scaffold`');
  }
  return 0;
}

/**
 * Renders one probe row.
 *
 * Args:
 *   io: process context.
 *   probe: the probe result.
 *
 * Returns:
 *   void: writes the row.
 */
function printProbe(io: Io, probe: AdapterProbeReport): void {
  const path = probe.path === '' ? '' : ` ${probe.path}`;
  writeLine(io.stdout, `  [${probe.outcome}] ${probe.name}${path} — ${probe.detail}`);
}

/**
 * Runs `gateforge adapters check`.
 *
 * Args:
 *   io: process context.
 *   options: parsed flags (`probe`, `base-url`, `probe-id`, `json`).
 *
 * Returns:
 *   number: the process exit code (0 on success).
 */
async function check(io: Io, options: Record<string, string | boolean | string[]>): Promise<number> {
  const asJson = options['json'] === true;
  const probe = options['probe'] === true;
  const baseUrl = stringFlag(options, 'base-url');
  if (probe && baseUrl === undefined) {
    throw new UsageError(`--probe needs --base-url <app-url> (${ADAPTERS_USAGE})`);
  }
  const config = loadConfigAt(io.cwd);
  const pipeline = await runPipeline({
    cwd: io.cwd,
    env: io.env,
    config,
    provider: 'all-files',
    stateDir: resolveStateDir(io.cwd),
  });
  const adaptersDir = join(io.cwd, config.adapters ?? '.gateforge/adapters');
  const reports = await auditAdapters(adaptersDir);
  const present = new Set(reports.map((report) => report.name));
  const missing = resourcesNeedingAdapters(pipeline).filter(
    (target) => !present.has(target.adapterId),
  );

  const probes: AdapterProbeReport[] = [];
  if (probe && baseUrl !== undefined) {
    for (const report of reports) {
      probes.push(await probeAdapter(report, baseUrl, stringFlag(options, 'probe-id')));
    }
  }
  const document = {
    schemaVersion: 1,
    adaptersDir: relative(io.cwd, adaptersDir).split(sep).join('/'),
    adapters: reports.map((report) => ({
      name: report.name,
      file: relative(io.cwd, report.file).split(sep).join('/'),
      ok: report.ok,
      ...(report.issues.length > 0 ? { issues: report.issues } : {}),
      declares: report.declares,
    })),
    missingAdapters: missing.map((target) => ({
      resourceId: target.adapterId,
      name: target.resource.name,
      location: target.resource.location,
    })),
    ...(probes.length > 0 ? { probes } : {}),
  };
  if (asJson) {
    writeLine(io.stdout, canonicalJson(document as unknown as JsonValue));
    return 0;
  }

  writeLine(
    io.stdout,
    `adapters: ${String(reports.length)} in ${document.adaptersDir}, ${String(missing.length)} resource(s) without one`,
  );
  for (const report of reports) {
    const file = relative(io.cwd, report.file).split(sep).join('/');
    writeLine(io.stdout, `  [${report.ok ? 'ok' : 'invalid'}] ${file}`);
    for (const issue of report.issues) writeLine(io.stdout, `      ${issue}`);
    if (report.ok) {
      const capabilities = [
        report.declares.list ? 'list' : null,
        report.declares.naturalKey ? 'natural-key' : null,
        report.declares.volatileFields.length > 0
          ? `volatile[${report.declares.volatileFields.join(',')}]`
          : null,
      ].filter((entry): entry is string => entry !== null);
      if (capabilities.length > 0) writeLine(io.stdout, `      declares ${capabilities.join(', ')}`);
    }
  }
  for (const target of missing) {
    writeLine(
      io.stdout,
      `  [missing] ${target.adapterId} — run \`gateforge adapters scaffold\``,
    );
  }
  if (probes.length > 0) {
    writeLine(io.stdout, `probe (one GET per adapter against ${String(baseUrl)}):`);
    for (const row of probes) printProbe(io, row);
  }
  if (probe === false && reports.length > 0) {
    writeLine(io.stdout, 'next: `gateforge adapters check --probe --base-url <app-url>` with the app running');
  }
  const invalid = reports.filter((report) => !report.ok);
  if (invalid.length > 0) {
    writeLine(
      io.stderr,
      humanMessage({
        detail: `adapters check: ${String(invalid.length)} adapter(s) do not satisfy the contract: ` +
          invalid.map((report) => report.name).join(', '),
        nextAction: 'Fix the adapter module, or delete the file you no longer need',
      }),
    );
  }
  return 0;
}

/**
 * Runs the `adapters` command.
 *
 * Args:
 *   io: process context.
 *   argv: arguments after `adapters`.
 *
 * Returns:
 *   number: the process exit code.
 * @throws UsageError for an unknown subcommand or flag.
 */
export async function adaptersCommand(io: Io, argv: readonly string[]): Promise<number> {
  const { options, positionals } = parseArgs(argv);
  const sub = positionals[0];
  if (sub === undefined) {
    throw new UsageError(`missing subcommand (${ADAPTERS_USAGE})`);
  }
  if (options['help'] === true) {
    writeLine(io.stdout, ADAPTERS_USAGE);
    return 0;
  }
  if (sub === 'scaffold') {
    rejectUnknownFlags(options, ['dry-run', 'help'], ADAPTERS_USAGE);
    return scaffold(io, options['dry-run'] === true);
  }
  if (sub === 'check') {
    rejectUnknownFlags(options, ['probe', 'base-url', 'probe-id', 'json', 'help'], ADAPTERS_USAGE);
    return check(io, options);
  }
  throw new UsageError(`unknown adapters subcommand '${sub}' (scaffold|check)`);
}
