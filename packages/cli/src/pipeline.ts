/**
 * The shared run pipeline: config → path expansion → plugin discovery →
 * resource graph → obligations → manifest. Every subcommand that touches
 * the engine (discover, obligations, check, test-gates) runs the same
 * pipeline so outputs agree byte-for-byte across commands.
 *
 * Staleness populations (invariant 9 / GF-06) are loaded here for every
 * run: claims from the run-state dir, adapters from the configured
 * adapters directory, waivers from the configured waivers directory
 * (judged against the injected clock). The changed-file provider is the
 * caller's choice — `all-files` for full runs, a resolved diff provider
 * for `check --changed` — and is stamped into the manifest.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { parse as parseYaml } from 'yaml';
import {
  ClaimSchema,
  ClassificationPolicySchema,
  ClassificationSignalSchema,
  PolicyFileSchema,
  RunManifestSchema,
  buildResourceGraph,
  compareStrings,
  evaluatePolicies,
  jsonPathFor,
  loadWaivers,
  normalizeChangedFiles,
  runClassification,
    type ChangedProvider,
  type Claim,
  type ClassificationFile,
  type ClassificationPolicy,
  type ClassificationResult,
  type ClassificationSignal,
  type DetectorOutput,
  type GateforgeConfig,
  type GraphResource,
  type PolicyEvaluationResult,
  type ResourceGraph,
  type RunManifest,
} from '@gateforge/core';
import { UsageError } from './errors.js';
import { assertBundledDetectors, validateCoverageTrust } from './detector-trust.js';
import { clockFromConfig } from './clock.js';
import { expandIncludePaths, type ExpandError } from './glob.js';
import { runPlugins } from './plugins.js';
import { compileEndpointContribution, type EndpointInventory } from './endpoint-compiler.js';
import { readJsonArray } from './state.js';
import { providerFor } from './providers.js';

/** Everything one pipeline run needs. */
export interface PipelineOptions {
  /** Repo root; all repo-relative paths resolve against it. */
  cwd: string;
  /** Process environment (CI provider variables, …). */
  env: NodeJS.ProcessEnv;
  /** Validated `.gateforge.yml`. */
  config: GateforgeConfig;
  /** Changed-provider identity stamped into the manifest (pin #4). */
  provider: ChangedProvider;
  /** Absolute run-state directory (claims source; may not exist). */
  stateDir: string;
  /** Fixed run id; default is a fresh random UUID. */
  runId?: string;
  /**
   * Fixed changed-file set (Phase 5 staged-candidate runs): when present
   * it IS the changed set (computed from the frozen index vs base by the
   * staged-candidate module) and no diff provider runs — the checkout the
   * pipeline executes in has no diff basis of its own.
   */
  changedFilesOverride?: readonly string[];
}

/** The complete pipeline result. */
export interface PipelineResult {
  /** One validated contribution per configured plugin (config order). */
  contributions: DetectorOutput[];
  /** Compiled endpoint inventory (ADR 0004 D6): facts, endpoints, blocks. */
  endpointInventory: EndpointInventory;
  /** The built resource graph with effective classifications bound. */
  graph: ResourceGraph;
  /** Policy evaluation: obligations, blocking entries, claim assessments. */
  policy: PolicyEvaluationResult;
  /** Run manifest (pin #4), validated. */
  manifest: RunManifest;
  /** The injected run instant (used for verdicts and waivers too). */
  now: string;
  /** Changed files per the chosen provider ([] for all-files). */
  changedFiles: string[];
  /** The raw classifier result (decisions with traces, stale/invalid signals). */
  classification: ClassificationResult;
  /**
   * The effective-classification view (plan phase 5): every resolved
   * resource's classification keyed by plane-qualified id. Derived
   * artifact — the engine recomputes it from signals on every run and
   * never reads it back as input.
   */
  classificationsView: ClassificationFile;
}

/** Source-file map resourceId → repo-relative source (for diff scoping). */
export function sourceByResourceId(graph: ResourceGraph): Map<string, string> {
  const map = new Map<string, string>();
  for (const resource of graph.resources) {
    if (resource.id !== null) map.set(resource.id, resource.source);
  }
  return map;
}

/**
 * Join-aware change sources (plan phase 7.4): an endpoint obligation is
 * in scope when the backend route source OR any joined frontend-call
 * source changed — a change on either end of the join pulls the joined
 * endpoint's obligations into scope.
 */
export function sourcesByResourceId(graph: ResourceGraph): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const resource of graph.resources) {
    if (resource.id === null) continue;
    const sources = new Set<string>([resource.source]);
    const callSources = resource.attributes['callSources'];
    if (Array.isArray(callSources)) {
      for (const entry of callSources) {
        if (typeof entry === 'string') {
          // `file:line:col` — the change scope is file-grained.
          const file = entry.split(':').slice(0, -2).join(':');
          if (file.length > 0) sources.add(file);
        }
      }
    }
    map.set(resource.id, [...sources].sort(compareStrings));
  }
  return map;
}

/** Reads the HEAD sha of the repo in `cwd`, or null when unavailable. */
export function headSha(cwd: string): string | null {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' });
  if (result.error !== undefined || result.status !== 0) return null;
  const sha = (result.stdout ?? '').trim();
  return /^[0-9a-f]{40}$/.test(sha) ? sha : null;
}

/** Reads a YAML document fail-closed (missing/unparsable → UsageError). */
export function loadYaml(path: string, label: string): unknown {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? 'UNKNOWN';
    throw new UsageError(`cannot read ${label} file '${path}' (${code})`);
  }
  try {
    return parseYaml(raw);
  } catch (error) {
    throw new UsageError(
      `${label} file '${path}' is not valid YAML: ${(error as Error).message.split('\n')[0] ?? 'parse error'}`,
    );
  }
}

/** Lists adapter names (basenames sans `.mjs`) from the adapters dir. */
export function loadAdapterNames(cwd: string, dir: string): string[] {
  const absolute = resolveRepoPath(cwd, dir);
  let entries: string[];
  try {
    entries = readdirSync(absolute);
  } catch {
    return []; // no adapters directory: nothing to watch
  }
  return entries
    .filter((entry) => entry.endsWith('.mjs'))
    .map((entry) => entry.slice(0, -'.mjs'.length))
    .sort(compareStrings);
}

/** Resolves a repo-root-relative config path against the cwd. */
export function resolveRepoPath(cwd: string, repoRelative: string): string {
  const normalized = repoRelative.split('\\').join('/');
  if (normalized.startsWith('/')) {
    throw new UsageError(`config path '${repoRelative}' must be repo-root-relative, not absolute`);
  }
  return join(cwd, ...normalized.split('/'));
}

/** First zod issue as one actionable `path: message` line. */
function firstIssueText(
  error: { issues?: Array<{ path: PropertyKey[]; message: string }> },
  fallback: string,
): string {
  const issue = error.issues?.[0];
  return issue === undefined ? fallback : `${jsonPathFor(issue.path)}: ${issue.message}`;
}

/**
 * Runs the full pipeline.
 *
 * Args:
 *   options: cwd, env, validated config, provider identity, state dir.
 *
 * Returns:
 *   PipelineResult: contributions, graph, policy result, manifest, the
 *   injected run instant, and changed files.
 *
 * Throws:
 *   UsageError (exit 2): fail-closed problems — plugin failures, missing
 *   policy/classification-policy documents, invalid documents, or an
 *   unreadable git state for the chosen provider.
 */
export async function runPipeline(options: PipelineOptions): Promise<PipelineResult> {
  const { cwd, env, config, provider, stateDir } = options;
  const clock = clockFromConfig(config);
  // FAIL-CLOSED coverage (red-team F3): every unreadable path the walk
  // hits is collected and becomes a graph finding below — files may exist
  // behind unreadable directories, and they must not vanish from both the
  // requested and scanned sets.
  const expandErrors: ExpandError[] = [];
  const paths = expandIncludePaths(
    config.project.paths.include,
    config.project.paths.exclude,
    cwd,
    expandErrors,
  );
  const { contributions, registrations } = await runPlugins(config.plugins, paths, cwd);

  const policyDocRaw = loadYaml(resolveRepoPath(cwd, config.classificationPolicy), 'classification-policy');
  const policyDocParsed = ClassificationPolicySchema.safeParse(policyDocRaw);
  if (!policyDocParsed.success) {
    throw new UsageError(
      `classification-policy document is invalid: ${firstIssueText(policyDocParsed.error, 'unknown issue')}`,
    );
  }
  // Coverage-trust validation (red-team round 4): scan-completeness
  // evidence is accepted ONLY from bundled detectors loaded from their
  // fixed packages. A policy rule naming anything else — or a trusted id
  // aimed at a repository-local module — fails the run before discovery.
  validateCoverageTrust(policyDocParsed.data.coverage ?? [], config.plugins, cwd);
  // Reachability trust (red-team round 5): a trusted entry-point category
  // naming a detector binds reachability evidence to that BUNDLED detector.
  assertBundledDetectors(
    policyDocParsed.data.trustedInternalEntryPoints
      .map((entry) => entry.detector)
      .filter((detector): detector is string => detector !== undefined),
    config.plugins,
    cwd,
    'trusted entry point',
  );
  const policiesRaw = loadYaml(resolveRepoPath(cwd, config.policies), 'policies');
  const policiesParsed = PolicyFileSchema.safeParse(policiesRaw);
  if (!policiesParsed.success) {
    throw new UsageError(
      `policies document is invalid: ${firstIssueText(policiesParsed.error, 'unknown issue')}`,
    );
  }

  // Claims reach graph and policy engines as validated documents (the
  // verdict engine re-reads the raw state itself and stays lenient —
  // GF-23 degraded records belong there, not in the policy layer).
  const claimsRaw = readJsonArray(stateDir, 'claims.json');
  const claims = claimsRaw.filter((entry): entry is Claim => ClaimSchema.safeParse(entry).success);
  const adapters = loadAdapterNames(cwd, config.adapters);
  const waiverLoad = loadWaivers(resolveRepoPath(cwd, config.waivers), { now: clock.now() });

  // Endpoint compilation (ADR 0004 D6): deterministic stage over the
  // detectors' contract facts; its output is a synthetic engine
  // contribution that participates in the graph like any detector's.
  // Coverage/successful-detector accounting stays pinned to the PLUGIN
  // contributions — the compiler examines no files itself. The repo root
  // is passed so the declarative endpoint-plane rules in
  // `.gateforge/planes.json` (absence is normal) participate as endpoint
  // plane evidence; a malformed document fails the run closed.
  const { contribution: endpointContribution, inventory: endpointInventory } =
    compileEndpointContribution(contributions, { cwd });

  const built = buildResourceGraph({
    detectors: [...contributions, endpointContribution],
    claims,
    adapters,
    waivers: waiverLoad.waivers,
  });
  // Unreadable scan paths become gate-visible findings: they block the
  // gate outright AND (being inside the scan scope) invalidate every
  // closed-world proof — a hole in the scan is never silently coverage.
  for (const error of expandErrors) {
    built.findings.push({
      code: 'SCAN_PATH_UNREADABLE',
      detail: `${error.path}: ${error.detail}; the scan scope has a hole and closed-world proofs are invalidated`,
      locations: [{ file: error.path, line: 1, col: 0 }],
      detectorId: 'gateforge.pipeline',
    });
  }
  // Host-issued authority channel (ADR 0003 D2): translate configured
  // source-declaration markers into engine-minted declaration signals.
  // This is the ONLY path by which suppressive intent reaches the
  // classifier — plugin output can never carry it. Only the
  // `internality` marker is minted here (a bare marker carries no
  // assertion payload); other declaration keys stay detector-translated.
  const authority = mintDeclarationSignals(cwd, paths, policyDocParsed.data, built.resources);
  // Per-detector coverage (red-team round 3): coverage is judged PER
  // DETECTOR against the policy's declared rules — never flattened into
  // a union (a detector that cannot see routes reading a file proves
  // nothing about route coverage). Detectors that do not report simply
  // have no entry; a rule naming them fails the attestation.
  const coverage = contributions
    .filter((contribution) => contribution.scannedPaths !== undefined)
    .map((contribution) => ({
      detector: contribution.detectorId,
      scannedPaths: contribution.scannedPaths as string[],
    }));

  const scannedPaths = [...new Set(coverage.flatMap((entry) => entry.scannedPaths))].sort(
    compareStrings,
  );
  // Automatic conservative classification (plan phase 5, ADR 0003 D2/D5):
  // every run recomputes effective classifications from the detectors'
  // classification signals over the built graph. Uncertainty resolves
  // toward MORE obligations; typed blocks stay gate-visible.
  const { graph, classification, blocking } = runClassification({
    graph: built,
    signals: [...contributions, endpointContribution].flatMap((contribution) =>
      contribution.classificationSignals,
    ),
    authority,
    policy: policyDocParsed.data,
    adapters,
    scan: {
      requestedPaths: expandIncludePaths(policyDocParsed.data.scanRoots, [], cwd),
      scannedPaths,
      coverage,
      configuredDetectors: config.plugins.length,
      successfulDetectors: contributions.length,
    },
  });
  const policy = evaluatePolicies({
    graph,
    policies: policiesParsed.data,
    claims,
    extraBlocking: blocking,
  });

  const now = clock.now();
  const changedFiles =
    options.changedFilesOverride !== undefined
      ? normalizeChangedFiles([...options.changedFilesOverride])
      : providerFor(provider, cwd, env).changedFiles();
  const manifest = RunManifestSchema.parse({
    schemaVersion: 1,
    runId: options.runId ?? randomUUID(),
    startedAt: now,
    gitSha: headSha(cwd),
    provider,
    plugins: registrations,
    attestationScope: null,
  });

  return {
    contributions,
    endpointInventory,
    graph,
    policy,
    manifest,
    now,
    changedFiles,
    classification,
    classificationsView: effectiveClassifications(graph, classification),
  };
}

/**
 * Projects the bound effective classifications into the derived
 * view document (plan phase 5): every resource whose classification the
 * classifier resolved, keyed by plane-qualified id. The pipeline never
 * reads this back as input — recomputed from signals on every run.
 */
export function effectiveClassifications(
  graph: ResourceGraph,
  classification: ClassificationResult,
): ClassificationFile {
  const resources: Record<string, ClassificationFile['resources'][string]> = {};
  const decisions = classification.decisions;
  const decisionFor = (resource: ResourceGraph['resources'][number]) =>
    decisions.find(
      (decision) =>
        decision.name === resource.name &&
        decision.source === resource.source &&
        decision.location.file === resource.location.file &&
        decision.location.line === resource.location.line &&
        decision.location.col === resource.location.col,
    );
  for (const resource of graph.resources) {
    if (resource.id === null || resource.classification === null) continue;
    const decision = decisionFor(resource);
    if (decision?.classification === null || decision === undefined) continue;
    const bound = resource.classification;
    resources[resource.id] = {
      exposure: bound.exposure,
      plane: bound.plane,
      lifecycle: bound.lifecycle,
      primaryKey: [...bound.primaryKey],
      // Keep the evidence lane with the entry: a user-facing endpoint is
      // claims-witnessed (no adapter) and must stay schema-valid here too.
      ...(bound.evidenceLane !== undefined ? { evidenceLane: bound.evidenceLane } : {}),
      ...(bound.evidenceAdapter !== undefined ? { evidenceAdapter: bound.evidenceAdapter } : {}),
      notes: `automatic (${decision.classification.decisionFingerprint.slice(0, 12)})`,
    };
  }
  return { schemaVersion: 1, resources };
}
/**
 * Host-issued authority minting (red-team V1/V2 remediation, ADR 0003 D2):
 * translates configured source-declaration markers into ENGINE-minted
 * declaration signals. Suppressive intent reaches the classifier ONLY
 * through this channel — plugin output is structurally non-suppressive.
 *
 * For every configured declaration marker (e.g. `internality:
 * gateforge:internal`), each requested file is searched for the literal
 * marker; every match mints one `internality: true` declaration signal
 * (engine issuer `gateforge.core@1`) targeted at each resource whose
 * source file contains the marker. A marker in a file with no resource
 * mints nothing (an inert owner note, never a guess). Other declaration
 * keys (e.g. `archiveState`) need a structured payload and stay
 * detector-translated.
 *
 * Deterministic: same files + policy + resources ⇒ byte-identical signals.
 */
function mintDeclarationSignals(
  cwd: string,
  paths: readonly string[],
  policy: ClassificationPolicy,
  resources: readonly GraphResource[],
): ClassificationSignal[] {
  // Supported minted dimensions: `internality` (assertion true) and
  // `plane.<value>` (assertion <value>, validated below). Both are
  // organization-owned facts; everything else stays detector-translated.
  const rules: Array<{ dimension: 'internality' | 'plane'; assertion: string | boolean; marker: string }> = [];
  const internalityMarker = policy.declarations['internality'];
  if (typeof internalityMarker === 'string' && internalityMarker.length > 0) {
    rules.push({ dimension: 'internality', assertion: true, marker: internalityMarker });
  }
  for (const [key, marker] of Object.entries(policy.declarations)) {
    if (!key.startsWith('plane.')) continue;
    const plane = key.slice('plane.'.length);
    if (
      marker !== undefined &&
      (plane === 'tenant' || plane === 'master' || plane === 'global')
    ) {
      rules.push({ dimension: 'plane', assertion: plane, marker });
    }
  }
  if (rules.length === 0) return [];
  const minted: ClassificationSignal[] = [];
  for (const relPath of paths) {
    let text: string;
    try {
      text = readFileSync(join(cwd, relPath), 'utf8');
    } catch {
      continue; // unreadable files are the coverage layer's finding, not ours
    }
    const targets = resources.filter((resource) => resource.source === relPath);
    if (targets.length === 0) continue;
    const lines = text.split('\n');
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index];
      if (line === undefined) continue;
      for (const rule of rules) {
        if (!line.includes(rule.marker)) continue;
        const col = Math.max(0, line.indexOf(rule.marker));
        for (const resource of targets) {
          minted.push(
            ClassificationSignalSchema.parse({
              schemaVersion: 1,
              target: { resourceName: resource.name },
              dimension: rule.dimension,
              assertion: rule.assertion,
              basis: 'declaration',
              source: rule.marker,
              location: { file: relPath, line: index + 1, col },
              detector: { id: 'gateforge.core', version: '1' },
            }),
          );
        }
      }
    }
  }
  return minted.sort((a, b) => compareStrings(signalIdText(a), signalIdText(b)));
}

/** Canonical signal identity for deterministic minting order. */
function signalIdText(signal: ClassificationSignal): string {
  return JSON.stringify([
    signal.target.resourceId ?? null,
    signal.target.resourceName ?? null,
    signal.target.symbol ?? null,
    signal.dimension,
    signal.location.file,
    signal.location.line,
    signal.location.col,
  ]);
}
