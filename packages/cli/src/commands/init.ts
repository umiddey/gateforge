/**
 * `gateforge init`: generate `.gateforge.yml` plus the skeleton
 * directories the config points at.
 *
 * Idempotent and never destructive: every file is written only when it
 * does not already exist, so a user-modified config or policy document
 * survives repeated runs untouched. The generated `.gateforge.yml` is
 * self-checked against the pinned schema before anything is written — a
 * template drift from the frozen config must fail here, loudly, never
 * ship broken.
 *
 * Automatic classification (plan phase 5, ADR 0003 D5): the skeleton
 * carries a `classification-policy.yml` with scan roots and trusted
 * internal entry-point categories — there is NO per-resource
 * classification file to fill in. Effective classifications are computed
 * from detector signals on every run.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { isAbsolute, join } from 'node:path';
import { parse as parseYaml, parseDocument, isSeq as isYamlSeq, isMap as isYamlMap } from 'yaml';
import {
  ClassificationPolicySchema,
  PolicyFileSchema,
  loadConfig,
  parseConfig,
  resolveStrictnessMode,
  serializeBaseline,
  strictCapabilityGaps,
} from '@gate-forge/core';
import type { GateforgeConfig, StrictnessMode } from '@gate-forge/core';
import {
  DEFAULT_PLANES_CONFIG,
  PLANES_CONFIG_PATH,
  createSqlalchemyDetector,
  parsePlanesConfigText,
  PACK_VERSION as PACK_SQLALCHEMY_VERSION,
  type PlaneConfigRule,
  type SqlalchemyPlane,
} from '@gate-forge/pack-sqlalchemy';
import {
  collectRoutePlaneFacts,
  proposeRouteFolderPlanes,
} from '../route-plane-proposals.js';
import { PACK_VERSION as PACK_FASTAPI_VERSION } from '@gate-forge/pack-fastapi';
import { PACK_VERSION as PACK_HTTP_VERSION } from '@gate-forge/pack-http';
import { PACK_VERSION as PACK_TASK_VERSION } from '@gate-forge/pack-task';
import { renderAlembicOptIn } from '@gate-forge/pack-alembic';
import { parseArgs, stringFlag } from '../args.js';
import type { Io } from '../io.js';
import { recordInitPath, writeLine } from '../io.js';
import { UsageError } from '../errors.js';
import { languageDefaultPlugins, recommendPlugins, renderScanBlock, scanRepo, type RepoScan } from '../repo-scan.js';
import { rejectUnknownFlags } from './common.js';
import { expandScanPaths, type ExpandError } from '../glob.js';
import { gitIgnoredPaths } from '../git-ignored.js';
import { inferPlanesConfig } from '../planes-inference.js';
import { hasGateforgeMarker, installCommitHook, installPrePushHook, writeStandaloneGateScript } from '../git-hooks.js';
import {
  appendPreCommitHook,
  ensureHookScript,
  engineRootFromInvocation,
  detectCiProvider,
  writeGitlabCiTemplate as writeSharedGitlabCiTemplate,
  writeServerProtectionInstructions,
} from './blocking.js';
import { trustedPolicyDigestForConfig } from '../execution.js';
import {
  DOCS_EXCLUSIONS_GUARANTEE,
  DOCS_EXCLUSIONS_SOURCE,
  loadDocsExclusions,
  validateRequestedDocsFolders,
} from '../docs-exclusions.js';
import {
  CACHE_EXCLUSIONS_GUARANTEE,
  CACHE_EXCLUSIONS_SOURCE,
  loadCacheExclusions,
  validateRequestedCacheFiles,
} from '../cache-exclusions.js';
import { setEvidenceExclude, declaresEvidenceExclude } from '../evidence-config-text.js';
import { legacyExclusionPathsPresent, rejectLegacyExclusions } from '../legacy-exclusion-paths.js';
import {
  ENGINE_STATE_IGNORE_COMMENT,
  ENGINE_STATE_IGNORE_ENTRIES,
} from '../gateforge-owned.js';
import {
  CHOOSE_ANOTHER_GOAL_ADVICE,
  INIT_PRESETS,
  isInitPresetName,
  parseGoalAnswer,
  renderGoalQuestion,
  renderPresetTable,
  renderPresetSummary,
  type InitPresetName,
  type InitPresetSettings,
} from './init-presets.js';
import {
  BEHAVIOR_NAMESPACES,
  behaviorPackEvidence,
  behaviorSkeletonExamples,
  detectBehaviorPacks,
  parseBehaviorPacks,
  type BehaviorNamespace,
  type DetectedBehaviorPack,
} from '../behavior-setup.js';
export const INIT_USAGE =
  '[--preset light|normal|strict] [--explain-presets] [--no-scan] [--proof overlay|observe] ' +
  '[--blocking] [--no-blocking] [--pre-commit] [--no-pre-commit] [--mode changed|staged] ' +
  '[--witnessed staged|full] [--ci] [--no-ci] ' +
  '[--docs-exclude <folder,...> [--docs-exclude-file <path>] [--confirm-doc-exclusions]] [--cache-exclude <file,...> ' +
  '[--confirm-cache-exclusions]] [--strict-e2e] [--planes] [--no-planes] ' +
  '[--behavior] [--no-behavior] [--behavior-packs <pack,...>] [--unmatched-routes block|warn]';

/** Template for the complete-behavior owner document (plan §4.1). */
export const BEHAVIOR_TEMPLATE = `\
# Complete-behavior owner document.
# Presence of this file enables the complete-behavior profile: every
# discovered endpoint must have an approved declaration (cases or an
# owner disposition). There is no warnOnly or silent fallback.
#
# This scaffold is NOT approval: fill in real cases per endpoint, then
# run 'gateforge check' — missing declarations block with
# ENDPOINT_BEHAVIOR_MISSING until you define them.
schemaVersion: 1
endpoints: []
resources: []
`;


/** The behavior-setup checklist: the work no scaffold can do. */
export const BEHAVIOR_CHECKLIST = [
  'behavior setup is NOT complete: this scaffold only enables the profile',
  'next: run `gateforge check` — every discovered endpoint is listed as ENDPOINT_BEHAVIOR_MISSING',
  'next: for each endpoint, declare cases (or an owner disposition) in .gateforge/behavior.yml',
  'next: map each case to a test with `tests mark --case`, then prove it through the witness',
  'note: strong HTTP contracts stay blocking until witness-produced case evidence exists',
].map((line) => `  ${line}`).join('\n');

const BUNDLED_PLUGIN_MODULES: Readonly<Record<string, string>> = Object.freeze({
  'gateforge.pack-fastapi': '@gate-forge/pack-fastapi',
  'gateforge.pack-http': '@gate-forge/pack-http',
  'gateforge.pack-sqlalchemy': '@gate-forge/pack-sqlalchemy',
  'gateforge.pack-task': '@gate-forge/pack-task',
});

/**
 * The bundled plugins' detector-identity versions, imported from each
 * pack's own constant — NEVER a hardcoded literal. The GPP/3 handshake
 * pins the plugin entry's version and every classification signal is
 * checked against that pin, so a stale literal in this template made
 * every generated config fail closed the moment a pack's detector
 * identity moved (pack-sqlalchemy 0.2.0 did exactly that).
 */
const BUNDLED_PLUGIN_VERSIONS: Readonly<Record<string, string>> = Object.freeze({
  'gateforge.pack-fastapi': PACK_FASTAPI_VERSION,
  'gateforge.pack-http': PACK_HTTP_VERSION,
  'gateforge.pack-sqlalchemy': PACK_SQLALCHEMY_VERSION,
  'gateforge.pack-task': PACK_TASK_VERSION,
});

/**
 * The bundled plugin ids init may write (the four trusted detector
 * packs). `gateforge.pack-task` is opt-in only via `--plugins` — never
 * recommended, never defaulted — because the `task:*` contracts it
 * discovers are gradable ONLY once the owner configures a
 * `queueObserver` (the engine's own queue read); without one every one
 * of them stays `VERIFIER_UNSUPPORTED`/fail-closed.
 */
const KNOWN_BUNDLED_PLUGIN_IDS: ReadonlySet<string> = new Set(Object.keys(BUNDLED_PLUGIN_MODULES));

/**
 * Selects the bundled detectors required by the generated coverage and
 * trusted-entry-point rules for the requested source languages.
 * `gateforge.pack-task` is NEVER included: it is opt-in only via
 * `--plugins`, because its contracts grade only with a configured
 * `queueObserver` and a generated default would promise coverage the
 * repository cannot produce.
 *
 * Args:
 *   languages (readonly string[]): Languages selected by `gateforge init`.
 *
 * Returns:
 *   string[]: Deterministically ordered bundled detector ids.
 */
function bundledPluginIds(languages: readonly string[]): string[] {
  return languageDefaultPlugins(languages);
}

/** Renders the trusted bundled plugin entries for `.gateforge.yml`. */
function pluginsTemplate(pluginIds: readonly string[]): string {
  return pluginIds
    .map(
      (id) =>
        `  - id: ${id}\n    version: '${BUNDLED_PLUGIN_VERSIONS[id]}'\n    transport: in-process\n    module: '${BUNDLED_PLUGIN_MODULES[id]}'`,
    )
    .join('\n');
}

/**
 * Adds the requested bundled detectors to an existing `.gateforge.yml`
 * without touching anything else in the owner's file.
 *
 * The merge is ADDITIVE: an id already present keeps its owner's entry
 * (version pin, transport, module) byte for byte, an id that is absent
 * is appended with the bundled module/version, and no entry is ever
 * removed — `--plugins` chooses what to ADD, and the plugin list is the
 * one config section the product's own tip tells a user to change.
 * Everything outside the `plugins:` sequence (keys, comments, the
 * owner's own edits) is preserved exactly.
 *
 * Args:
 *   existingText: the current `.gateforge.yml` contents.
 *   pluginIds: the bundled detector ids to ensure are present.
 *
 * Returns:
 *   string | null: the merged document, or null when every requested id
 *   is already present (nothing to write).
 *
 * Throws:
 *   UsageError: the merged document would not satisfy the pinned
 *   config schema (a broken merge must fail here, not at the next run).
 */
function mergePluginsIntoConfig(existingText: string, pluginIds: readonly string[]): string | null {
  const document = parseDocument(existingText);
  const pluginsNode = document.get('plugins');
  if (!isYamlSeq(pluginsNode)) {
    throw new UsageError(
      'init --plugins: the existing .gateforge.yml has no `plugins:` list to add to; ' +
        'add the entry by hand (one block per detector: `id`, `version`, `transport`, `module`)',
    );
  }
  const present = new Set<string>();
  for (const item of pluginsNode.items) {
    // A `plugins:` entry is a YAML mapping node, not a plain object.
    if (!isYamlMap(item)) continue;
    const id = item.get('id');
    if (typeof id === 'string') present.add(id);
  }
  const missing = pluginIds.filter((id) => !present.has(id));
  if (missing.length === 0) return null;
  for (const id of missing) {
    pluginsNode.add({
      id,
      version: BUNDLED_PLUGIN_VERSIONS[id],
      transport: 'in-process',
      module: BUNDLED_PLUGIN_MODULES[id],
    });
  }
  const merged = document.toString();
  // Self-check against the pinned schema BEFORE writing (the same
  // contract the fresh-config path keeps).
  parseConfig(parseYaml(merged), { file: '.gateforge.yml' });
  return merged;
}

/**
 * Selects source-only include globs so AST detectors do not parse
 * dependencies, caches, lockfiles, or arbitrary repository assets.
 *
 * Args:
 *   languages (readonly string[]): Languages selected by `gateforge init`.
 *
 * Returns:
 *   string[]: Deterministically ordered source globs.
 */
function sourceIncludePatterns(languages: readonly string[]): string[] {
  const normalized = new Set(languages.map((language) => language.toLowerCase()));
  const patterns: string[] = [];
  if (normalized.has('python')) patterns.push('**/*.py');
  if (normalized.has('javascript') || normalized.has('typescript') || normalized.has('node')) {
    patterns.push('**/*.js', '**/*.jsx', '**/*.mjs', '**/*.cjs');
  }
  if (normalized.has('typescript')) patterns.push('**/*.ts', '**/*.tsx');
  return patterns.length > 0 ? patterns : ['**/*'];
}
/**
 * The starter policies preserve available persistence evidence and use
 * only transport-level proof for consumed HTTP endpoints.
 */
/**
 * Transport-only endpoint policy example (plan §8 / D1): proves only that
 * the witness observed a matching HTTP exchange in the bound run. Test
 * attribution is suite-claimed — it does not prove which browser, UI
 * action, or test produced the exchange.
 */
export const TRANSPORT_ONLY_POLICY_EXAMPLE = `\
# Transport-only endpoint policy.
# Each obligation proves only that the witness observed a matching HTTP
# exchange in the bound run ("witness observed an HTTP exchange");
# test attribution is suite-claimed ("suite-claimed"), never proven
# browser-issued by an independent channel.
schemaVersion: 1
policies:
  - id: frontend-consumed-endpoints-transport-only
    when:
      kind: http.endpoint
      consumed: true
    require:
      - http:request-observed
      - http:response-status-ok
`;

export const POLICIES_TEMPLATE = `\
# Declarative policies: when a resource matches, the required contracts
# become obligations. Lifecycle-gated persistence:* contracts are emitted
# only for the lifecycle operations the automatic classification enables,
# and are graded on the witness's own engine-side observation.
# UI-semantic crud:* contracts intentionally fail closed (no
# witness-controlled UI observation channel exists yet) — add them only
# deliberately. Consumed HTTP endpoints use transport-only proof;
# 'http:frontend-request-observed' has no independent browser/test channel
# and is never included in a new-install starter.
#
# A route no UI calls owes nothing below, so a NEW endpoint with no test is
# invisible until it is consumed. To make every discovered route owe the
# observation contracts (only NEW debt blocks; run 'gateforge adopt' to
# forgive what already exists), uncomment the options section below:
#
# options:
#   'http.endpoint.requireObservation': all
schemaVersion: 1
policies:
  # Capability-scoped endpoint policies (workflow/validation/...) may be added
  # ONLY when the owning pack ships an engine-owned state-observing producer;
  # until then those contracts cannot be honestly evidenced and stay blocking.
  - id: user-facing-persistence
    when:
      exposure: user-facing
    require:
      - persistence:create
      - persistence:read
      - persistence:update
      - persistence:delete
  - id: frontend-consumed-endpoints-transport-only
    when:
      kind: http.endpoint
      consumed: true
    require:
      - http:request-observed
      - http:response-status-ok
`;

/**
 * The classification policy (plan phase 5, ADR 0003 D4/D5): scan roots
 * scope every closed-world proof, trusted categories name the internal
 * entry points an internality certificate may rely on. Organization
 * internal rules and declaration syntax go here too — a name rule alone
 * NEVER proves internality; the certificate is re-derived every run.
 */
/**
 * Builds the classification policy (plan phase 5, ADR 0003 D4/D5): scan roots
 * scope every closed-world proof, trusted categories name the internal
 * entry points an internality certificate may rely on. Organization
 * internal rules and declaration syntax go here too.
 *
 * Task-scoped rules (the `linkage.task` coverage rule and the worker
 * entry-point detector binding) are emitted ONLY when `pack-task` is in
 * the selected plugin set: a coverage rule or detector binding naming an
 * unconfigured detector fails every run closed, and task is opt-in —
 * its contracts grade only with a configured `queueObserver`.
 */
function classificationPolicyTemplate(
  languages: readonly string[],
  pluginIds: readonly string[],
): string {
  const selected = new Set(pluginIds);
  const taskSelected = selected.has('gateforge.pack-task');
  const httpSelected = selected.has('gateforge.pack-http');
  const sqlalchemySelected = selected.has('gateforge.pack-sqlalchemy');
  const coverageRules: string[] = [];
  // Capabilities (red-team round 6): a rule grants a capability over its
  // files. Model/task discovery NEVER grants exposure, and no generated
  // rule declares `exhaustive: true` — today's detectors are heuristics,
  // so generated policies keep the internality certificate UNAVAILABLE
  // until the organization asserts an exhaustive exposure parser itself.
  // Every rule names a detector from the SELECTED plugin set: a rule
  // naming an unconfigured detector fails every run closed.
  if (
    httpSelected &&
    (languages.includes('typescript') || languages.includes('javascript') || languages.includes('node'))
  ) {
    coverageRules.push(
      `  - capability: exposure.http\n    detector: gateforge.pack-http\n    appliesTo:\n      - '**/*.ts'\n      - '**/*.js'\n      - '**/*.tsx'\n      - '**/*.jsx'\n      - '**/*.mjs'\n      - '**/*.cjs'`,
    );
    if (taskSelected) {
      coverageRules.push(
        `  - capability: linkage.task\n    detector: gateforge.pack-task\n    appliesTo:\n      - '**/*.ts'\n      - '**/*.js'\n      - '**/*.tsx'\n      - '**/*.jsx'\n      - '**/*.mjs'\n      - '**/*.cjs'`,
      );
    }
  }
  if (sqlalchemySelected && languages.includes('python')) {
    // Model discovery is NOT an exposure capability: python exposure stays
    // uncovered until an exhaustive python exposure detector exists.
    coverageRules.push(
      `  - capability: models.sqlalchemy\n    detector: gateforge.pack-sqlalchemy\n    appliesTo:\n      - '**/*.py'`,
    );
  }
  const coverageBlock =
    coverageRules.length > 0 ? `coverage:\n${coverageRules.join('\n')}` : 'coverage: []';
  // The worker entry-point category keeps its detector binding only when
  // task is selected; otherwise it is an unbound category (can never
  // certify reachability) rather than a fail-closed dangling reference.
  const workerEntry = taskSelected
    ? `  - category: worker\n    patterns: ['**/workers/**', '**/jobs/**']\n    # Reachability is only honored from this bundled detector (round 5).\n    detector: gateforge.pack-task`
    : `  - category: worker\n    patterns: ['**/workers/**', '**/jobs/**']\n    # No detector binding: task is opt-in (no semantic verifier), so this\n    # category can never certify reachability until pack-task is selected.`;

  return `\
# Repository-wide deterministic classification rules (ADR 0003 D5).
# Effective classifications are computed automatically from detector
# signals on every run: unknown exposure defaults user-facing, unknown
# lifecycle operations default enabled, and internal requires a complete
# closed-world certificate. This file NEVER classifies a resource by hand.
schemaVersion: 1
# Globs a closed-world proof must cover; any parse/unresolved hole inside
# them invalidates every suppressive decision in scope.
scanRoots:
  - '**/*'
# Entry-point categories trusted as internal reachability (an internality
# certificate may rely only on these).
trustedInternalEntryPoints:
${workerEntry}
  # Categories WITHOUT a detector binding can never certify: no plugin may
  # assert their reachability. Bind one when a bundled detector exists.
  - category: migration
    patterns: ['**/migrations/**']
  - category: maintenance-command
    patterns: ['**/scripts/maintenance/**']
# Organization internal rules — certificate INPUTS, never overrides.
internalRules: []
# Coverage requirements for COMPLETE-scan proofs (closed-world
# certificates). Each rule: the named detector must report examining
# every file matching appliesTo. Declaring none means no scan is
# provably complete and closed-world proofs stay unavailable.
${coverageBlock}
# Supported source declaration syntax consumed by the classifier.
declarations:
  internality: 'gateforge:internal'
  archiveState: 'gateforge:archive-state'
# Bookkeeping columns that never satisfy an update by themselves.
volatileFields:
  - updated_at
  - created_at
`;
}
/**
 * The runner names the repository scan can detect, in the order the scan
 * reports its signals. `playwright` is the frozen default: it is never
 * written into a new config.
 */
const DETECTABLE_RUNNERS = ['playwright', 'vitest', 'cypress', 'pytest'] as const;

/** Builds the `.gateforge.yml` document for the requested languages. */
function configTemplate(
  languages: readonly string[],
  pluginIds: readonly string[],
  /** `strictnessMode` writes the owner-owned `mode:` key; undefined writes NO key, which is today's byte-identical config. */
  options: {
    strictE2E?: boolean;
    enforcement?: boolean;
    historyRetentionDays?: number | 'off';
    strictnessMode?: StrictnessMode;
    /** `runner` writes the owner-owned `runner:` key; undefined writes NO key (playwright is the default). */
    runner?: string;
    /** `unmatchedRoutes` writes the owner-owned `endpoints.unmatchedRoutes` key; undefined writes NO key. */
    unmatchedRoutes?: 'block' | 'warn';
  } = {},
): string {
  const enforcementBlock =
    options.enforcement === true
      ? `# Enforcement: standard mode combines the local hook with a mandatory
# trusted server check. strictE2E makes waived/baselined in-scope E2E
# obligations NOT proof (they block with ENFORCEMENT_UNTRUSTED).
enforcement:
  mode: standard
  strictE2E: ${String(options.strictE2E === true)}
  receiptStage: pre-push
`
      : '';
  // The owner-owned strictness key. Only written when a preset named it:
  // without a preset the config stays byte-identical to today's, and an
  // ABSENT key means `strict` (the frozen behavior).
  const strictnessBlock =
    options.strictnessMode === undefined
      ? ''
      : `# How hard the gate blocks: strict = block everything, changed = block
# only the debt this change touches, warn = report everything and block
# nothing. This softens the GATE, never the evidence.
mode: ${options.strictnessMode}
`;
  // The owner-owned runner key: only written when the scan detected a
  // single non-Playwright runner. An absent key means `playwright`, the
  // frozen default, so an existing/ambiguous setup is byte-identical.
  const runnerBlock =
    options.runner === undefined
      ? ''
      : `# The test runner the supervised gate drives. Playwright is the default when
# this key is absent; the scan detected another runner in this repository.
runner: ${options.runner}
`;
  const historyBlock =
    options.historyRetentionDays === undefined
      ? ''
      : `history:\n  retentionDays: ${String(options.historyRetentionDays)}\n`;
  // The owner-owned unmatched-route grading. Only written when the owner
  // answered (the terminal question, the flag, or the non-interactive
  // `warn`); an existing config that said nothing keeps saying nothing,
  // and the `check`/`next` banner keeps asking.
  const endpointsBlock =
    options.unmatchedRoutes === undefined
      ? ''
      : `# Routes whose name matches no discovered resource (ENDPOINT_RESOURCE_CANDIDATE_UNMATCHED).
# 'warn' reports them as advisories with a banner; 'block' makes them
# blocking entries like any other finding. Absent means 'warn'.
endpoints:
  unmatchedRoutes: ${options.unmatchedRoutes}
`;
  return `\
# gateforge project configuration (schemaVersion 1)
schemaVersion: 1
project:
  # Languages detectors should run for (your detector packs decide).
  languages:
${languages.map((language) => `    - ${language}`).join('\n')}
  paths:
    # Globs scanned by every detector; results drive obligations.
    include:
${sourceIncludePatterns(languages).map((pattern) => `      - '${pattern}'`).join('\n')}
    exclude:
      - '**/node_modules/**'
      - '**/.venv/**'
      - '**/venv/**'
      - '**/__pycache__/**'
      - '**/.pytest_cache/**'
      - '**/.mypy_cache/**'
      - '**/dist/**'
      - '**/build/**'
      # Hidden dot-folders (agent tooling like .claude/ or .cursor/,
      # editor/tool caches, leftover merge or working folders) hold
      # tooling and debris, never application code. The rule is generic
      # -- it keys on the dot prefix at any depth -- so any hidden folder
      # is skipped, whatever it is called. .gateforge is the ONE
      # exception and is deliberately NOT matched here: Gateforge's own
      # configuration stays in scope.
      - '**/.(!(gateforge))/**'
      - '.!(gateforge)/**'
# Detector plugins. Bundled detectors are preconfigured for the selected
# languages and are loaded from their trusted package entry points.
plugins:
${pluginsTemplate(pluginIds)}
policies: .gateforge/policies.yml
classificationPolicy: .gateforge/classification-policy.yml
adapters: .gateforge/adapters
waivers: .gateforge/waivers
baselines: .gateforge/baselines/obligations.json
changed:
  provider: auto
witness:
  maxDurationSeconds: 5
clock:
  mode: system
${endpointsBlock}${runnerBlock}${historyBlock}${strictnessBlock}${enforcementBlock}\
`;
}


/**
 * Strict-setup preflight (plan Phase 0 item 4, ADR 0005 D1): when the
 * requested setup enables strict E2E mode, every contract its policies
 * require must have an AVAILABLE proof channel (per the verifier
 * capability registry — the single source of truth). A new strict setup
 * lacking browser observation cannot advertise an operational blocking
 * E2E gate, so this fails closed with a precise capability error naming
 * the contract, the missing observer, and the VERIFIER_UNSUPPORTED next
 * action.
 *
 * Args:
 *   policiesYaml: the policies document text the setup would write.
 *
 * Throws:
 *   UsageError: when any required contract's capability is unavailable
 *     (exit 2; nothing is written).
 */
function preflightStrictSetup(policiesYaml: string): void {
  const parsed = PolicyFileSchema.safeParse(parseYaml(policiesYaml));
  if (!parsed.success) {
    throw new UsageError(
      `policies document is invalid: ${(parsed.error.issues[0]?.message) ?? 'unknown issue'}`,
    );
  }
  const required = [
    ...new Set(parsed.data.policies.flatMap((policy) => [...policy.require])),
  ].sort();
  const gaps = strictCapabilityGaps(required.map((contract) => ({ id: contract, contract })));
  if (gaps.length === 0) return;
  const lines = gaps.map(
    (gap) =>
      `  - contract '${gap.contract}': ${gap.detail} Required observer: ${gap.observer} ` +
      `Next action: ${gap.nextAction}`,
  );
  throw new UsageError(
    `strict E2E setup is incomplete: ${String(gaps.length)} required contract(s) have no ` +
      'available proof channel, so this setup cannot advertise an operational blocking E2E ' +
      `gate (fail closed)\n${lines.join('\n')}`,
  );
}


/**
 * The agent skill file init writes at the repo root (only when absent).
 * One loop, one action, no self-approval — the overlay-first contract.
 */
const GATEFORGE_MD_TEMPLATE = `# GATEFORGE.md — agent loop (written by \`gateforge init\`; safe to edit)

You are gated by Gateforge. Work one blocking item at a time.

## The loop

1. If blocked, run \`gateforge next\` (or \`gateforge next --json\` for machines).
2. Read the single \`next:\` block: \`cause\`, \`why\`, and exactly one \`do:\` line.
3. Do the single \`do:\` line. Stop. Re-run \`gateforge next\`.


## Setup guides

- Environment rules: \`node_modules/@gate-forge/cli/guides/TEST-ENVIRONMENT.md\`.
- Quickstart: \`node_modules/@gate-forge/cli/guides/QUICKSTART.md\`.
  (both ship with the installed CLI package)

## Proof lives in the overlay

- New proof tests go in \`tests/e2e/gateforge/\` (engine-driven fixture:
  \`evidence.ui.*\` + \`persistence.verify\`).
- Never rewrite existing \`tests/e2e/**\` journeys into \`evidence.ui\`.
- Never run \`gateforge tests mark\` as proof — mappings declare intent;
  only witnessed overlay evidence satisfies an obligation.
- \`tests suggest\` is inspection, not a gate.

## Never self-approve

- Never edit \`.gateforge/policies.yml\`, \`coveragePolicy\`, waivers,
  baselines, or plugin lists to make the gate pass. Those are
  owner-controlled; an agent edit never authorizes weaker checks.
- Coverage dispositions are owner acts. Strict-E2E waivers are not proof.

## Capability gaps

- \`VERIFIER_UNSUPPORTED\` means no honest proof channel exists: tell the
  human (remove the contract from \`.gateforge/policies.yml\` or drop the
  pack). Do not invent tests for it.
- \`http:frontend-request-observed\` has no independent browser channel;
  transport-only \`http:request-observed\` is a separate, weaker opt-in.
- Observe proof (\`--proof observe\`): existing suite-driven browser tests
  prove persistence via the witness (proxy traffic + independent adapter
  read) once mapped \`--kind observed-e2e\`. Weaker than overlay by
  design — proves "the server stored it", not "the engine typed it".
`;

/**
 * The overlay proof-directory README init scaffolds (only when absent):
 * what the overlay is, and where the fixture shape is documented.
 */
const OVERLAY_README_TEMPLATE = `# tests/e2e/gateforge/ — overlay proof tests

Thin engine-driven tests that prove persistence obligations. They use the
Gateforge Playwright fixture (\`evidence.ui.*\` + \`persistence.verify\`)
with a surface map — they do NOT rewrite existing journeys.

- New proof tests go here: \`tests/e2e/gateforge/<resource>.<op>.spec.js\`.
- Do not rewrite existing \`tests/e2e/**\` journeys into \`evidence.ui\`.
- Do not use \`gateforge tests mark\` as proof: mappings are intent, not proof.
- Fixture shape: \`node_modules/@gate-forge/pack-playwright/examples/overlay-proof.spec.js\`
  (a complete, runnable proof test shipped with the pack you installed —
  copy it here and change the surface). Journey-writing rules:
  \`node_modules/@gate-forge/pack-playwright/README.md\`.
`;

/**
 * The Observe proof checklist init prints (never writes) for
 * `--proof observe`: the per-repo wiring no scaffold can do. Each step
 * is owner/agent work; the gate stays blocking until all three hold.
 */
const OBSERVE_CHECKLIST = `observe proof checklist (existing suite through the witness — no new tests):
  1. Point the Playwright config baseURL at the witness session proxy
     (GATEFORGE_APP_BASE_URL) so browser traffic is attributable to its test.
  2. Give each .gateforge/adapters/<name>.mjs an \`observe\` binding
     ({create/read/update/delete: {method, path}}, {id} on id-bearing
     routes) plus list() for before-snapshots.
  3. Map existing tests with \`gateforge tests mark --kind observed-e2e\`
     (suite-driven browser tests only — fixture tests stay overlay).
  4. Run \`gateforge test-gates --changed\`, then \`gateforge check --require-e2e\`.
Honest scope: proves persistence (the server stored what the proxied
request sent), not "the engine typed the form".`;

/**
 * The adoption block init prints on the FIRST init of a repository that
 * already has code. Such a repository is not green on day one: the very
 * next commit sees everything discovery found as existing debt. Without
 * this block the owner meets that as a wall of findings with no name
 * for the sanctioned way through it — `gateforge adopt` — which is why
 * the command had to be discovered from a source file instead of from
 * `init`.
 *
 * Everything here is exactly what `adopt` does: the recorded set, its
 * shrink-only standing, and the one case where an adopted E2E
 * obligation still blocks.
 */
const ADOPT_ADVICE = `this repository already had code, so \`gateforge check\` reports what discovery finds today, and today\'s findings block the first commit:
  gateforge adopt — records today\'s blocking findings as forgiven debt, in a baseline plus a dated, count-annotated receipt, then wires the blocking gate.
  it is shrink-only from here: it never forgives new work. Resolve debt and run \`gateforge baseline update\` to shrink the recorded set; new unproven work keeps blocking.
  with strictE2E enabled, an adopted E2E obligation still blocks with ENFORCEMENT_UNTRUSTED as soon as a change touches it — baselined is not proof.`;

/**
 * Asks (TTY only) whether init should write the recommended setup.
 * Flags win: `--accept-recommended` forces yes, `--plugins` (an explicit
 * choice) skips the prompt, and non-interactive runs default to yes —
 * writing the recommended set with a tip, never hanging on a prompt.
 */
async function resolveRecommended(io: Io, options: Readonly<Record<string, unknown>>): Promise<boolean> {
  if (options['accept-recommended'] === true) return true;
  if (!process.stdin.isTTY) {
    writeLine(
      io.stdout,
      'tip: re-run with --plugins <comma,list> to add detectors (entries already in .gateforge.yml are kept; nothing else in the file changes)',
    );
    return true;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question('Enable recommended setup? [Y/n] ')).trim().toLowerCase();
    return answer === '' || answer === 'y' || answer === 'yes';
  } finally {
    rl.close();
  }
}
/**
 * The wiring flags each preset already implies (R1-1): a flag the
 * preset implies is a no-op — the preset the owner named is the
 * goal that applies. `light` wires nothing, so it implies no flag
 * and no `--no-*` flag can contradict it.
 */
const PRESET_IMPLIED_FLAGS: Readonly<Record<InitPresetName, readonly string[]>> = {
  light: [],
  normal: ['pre-commit', 'ci'],
  strict: ['blocking', 'pre-commit', 'ci', 'strict-e2e'],
};

/** What one wiring flag decides, named in the contradiction error. */
const PRESET_FLAG_THING: Readonly<Record<string, string>> = {
  blocking: 'the gate wiring',
  'pre-commit': 'the pre-commit hook',
  ci: 'the CI job',
  'strict-e2e': 'strict E2E',
};

/**
 * The preset/flag contradiction (R1-1): null when every given flag
 * is consistent with the preset (implied by it, or a `--no-*` for
 * something the preset does not wire — both are no-ops); the
 * conflicting flag otherwise: a positive wiring flag the preset
 * does NOT wire, or a `--no-*` flag for something it DOES wire.
 * Both spellings ask for two different goals at once, so the owner
 * must drop one of them — silently overriding the named preset
 * (the old "is ignored" note) hid the choice instead.
 */
function presetFlagConflict(
  preset: InitPresetName,
  options: Readonly<Record<string, unknown>>,
): string | null {
  const implied = PRESET_IMPLIED_FLAGS[preset];
  for (const flag of ['blocking', 'pre-commit', 'ci', 'strict-e2e'] as const) {
    const wired = implied.includes(flag);
    if (options[flag] === true && !wired) return flag;
    if (wired && options[`no-${flag}`] === true) return `no-${flag}`;
  }
  return null;
}
/**
 * The config settings a run REQUESTS that an existing
 * `.gateforge.yml` already owns with a different value
 * (R1-2): a chosen preset's strictness `mode` and
 * `enforcement.strictE2E`, plus the `--strict-e2e` and
 * `--unmatched-routes` flags. init never rewrites an
 * existing config, so a differing request is a usage error
 * the owner resolves by setting the key in the file — one
 * line per differing key, BEFORE anything is written.
 *
 * Absent keys compare as their effective values (`mode`
 * defaults to `strict`, `strictE2E` to false, absent
 * `unmatchedRoutes` grades advisories — `warn`), so a
 * request that matches what the file already does is not a
 * conflict. Only an explicit `--preset` names a request:
 * the non-interactive auto-chosen light goal and a
 * terminal answer to the goal question are default
 * behavior paths, not requests — a headless re-run of
 * `init` on an initialized repository must keep working.
 */
function requestedConfigConflicts(
  cwd: string,
  options: Readonly<Record<string, unknown>>,
  goal: { settings: InitPresetSettings; autoChosen?: boolean } | null,
): Array<{ key: string; current: string; requested: string }> {
  const conflicts: Array<{ key: string; current: string; requested: string }> = [];
  if (!existsSync(join(cwd, '.gateforge.yml'))) return conflicts;
  // An unparseable document is today's path (the draft load
  // below rethrows or falls back); there is no value to
  // compare a request against, so nothing is a conflict.
  let existing: GateforgeConfig;
  try {
    existing = loadConfig(join(cwd, '.gateforge.yml'));
  } catch {
    return conflicts;
  }
  const requests: Array<{ key: string; current: string; requested: string }> = [];
  if (goal !== null && options['preset'] !== undefined) {
    requests.push(
      {
        key: 'mode',
        current: resolveStrictnessMode(existing),
        requested: goal.settings.strictnessMode,
      },
      {
        key: 'enforcement.strictE2E',
        current: existing.enforcement?.strictE2E === true ? 'true' : 'false',
        requested: goal.settings.strictE2E ? 'true' : 'false',
      },
    );
  }
  if (options['strict-e2e'] === true) {
    requests.push({
      key: 'enforcement.strictE2E',
      current: existing.enforcement?.strictE2E === true ? 'true' : 'false',
      requested: 'true',
    });
  }
  const unmatchedRoutes = stringFlag(options, 'unmatched-routes');
  if (unmatchedRoutes !== undefined) {
    requests.push({
      key: 'endpoints.unmatchedRoutes',
      current: existing.endpoints?.unmatchedRoutes ?? 'warn',
      requested: unmatchedRoutes.trim().toLowerCase(),
    });
  }
  for (const request of requests) {
    if (request.current !== request.requested) conflicts.push(request);
  }
  return conflicts;
}
/**
 * Resolves the goal `init` should set up. Three paths, in order:
 *
 * 1. `--preset light|normal|strict` — an agent or CI run picks
 *    the goal explicitly. An enforcement flag the preset already
 *    implies is a no-op (the preset applies); one that
 *    contradicts it throws (R1-1) before any file is written.
 * 2. A real terminal — ONE question ("What should Gateforge do
 *    for you?") with three choices, each explained in one line.
 * 3. No terminal and no `--preset` — light only, stated ONCE on
 *    the line that also names `--preset <light|normal|strict>`.
 *    Gateforge never guesses normal or strict for someone who is
 *    not there: guessing strict blocks a team, guessing normal
 *    pretends a gate nobody asked for.
 *
 * A run WITHOUT a preset that carries explicit enforcement flags
 * (`--blocking`, `--strict-e2e`, …) has chosen for itself: no
 * preset is applied and the generated config keeps today's
 * exact bytes.
 *
 * Args:
 *   io: process context (prompt + informational output).
 *   options: parsed init flags.
 *   enforcementFlagGiven (boolean): true when an enforcement flag
 *     was passed and therefore wins over any preset.
 *
 * Returns:
 *   Promise<{ name: InitPresetName; settings: InitPresetSettings;
 *   autoChosen?: boolean } | null>: the applied goal (with
 *   `autoChosen` when no human chose it), or null when the run
 *   kept today's behavior.
 * @throws UsageError (exit 2): a flag contradicts the named
 *   preset (R1-1) — nothing is written.
 */
async function resolveGoal(
  io: Io,
  options: Readonly<Record<string, unknown>>,
  enforcementFlagGiven: boolean,
  configExisted: boolean,
): Promise<{ name: InitPresetName; settings: InitPresetSettings; autoChosen?: boolean } | null> {
  const explicit = options['preset'];
  if (explicit !== undefined && isInitPresetName(explicit)) {
    const conflict = presetFlagConflict(explicit, options);
    if (conflict !== null) {
      throw new UsageError(
        `--preset ${explicit} already decides ${PRESET_FLAG_THING[conflict.replace(/^no-/, '')]}; ` +
          `--${conflict} contradicts it — drop one of them`,
      );
    }
    // Every given flag is one the preset already implies (or a
    // `--no-*` for something it does not wire): a no-op. The
    // goal the owner named is the one that applies.
    return { name: explicit, settings: INIT_PRESETS[explicit] };
  }
  if (enforcementFlagGiven) return null;
  const interactive = process.stdin.isTTY === true && process.stdout.isTTY === true;
  if (!interactive) {
    // ONE line: which goal this run applied, and the flag that changes
    // it. The closing summary used to state the same choice a second
    // time, twenty lines later, in different words.
    writeLine(
      io.stdout,
      configExisted
        ? 'no terminal: keeping your existing .gateforge.yml — its `mode:` still decides how hard the gate blocks (the light goal wrote nothing here); ' +
          CHOOSE_ANOTHER_GOAL_ADVICE
        : `no terminal: writing the light preset (report everything, block nothing) — ${CHOOSE_ANOTHER_GOAL_ADVICE}`,
    );
    return { name: 'light', settings: INIT_PRESETS.light, autoChosen: true };
  }
  writeLine(io.stdout, renderGoalQuestion());
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let name: InitPresetName;
  try {
    name = parseGoalAnswer(await rl.question(' '));
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  } finally {
    rl.close();
  }
  return { name, settings: INIT_PRESETS[name] };
}
/**
 * Asks (TTY only) whether gateforge should be a blocking gate. Flags win:
 * --blocking forces yes, --no-blocking forces no, and non-interactive
 * runs default to no so tests and CI never hang on a prompt.
 */
async function resolveBlocking(io: Io, options: Readonly<Record<string, unknown>>): Promise<boolean> {
  if (options['blocking'] === true) return true;
  if (options['no-blocking'] === true) return false;
  if (!process.stdin.isTTY) {
    writeLine(io.stdout, 'tip: gateforge init --blocking wires a pre-commit + CI blocking gate (idempotent)');
    return false;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question('Enforce gateforge as a blocking gate (pre-commit + CI wiring)? [y/N] ')).trim().toLowerCase();
    return answer === 'y' || answer === 'yes';
  } finally {
    rl.close();
  }
}

/** Asks how long to retain supervised run history in a new interactive setup.
 *
 * Args:
 *   io: process context used for the prompt and informational output.
 *
 * Returns:
 *   Promise<number | 'off' | undefined>: selected retention; undefined leaves the feature off.
 */
async function resolveHistoryRetention(io: Io): Promise<number | 'off' | undefined> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return undefined;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question('Keep supervised run history? [14 days/off] (default 14): ')).trim().toLowerCase();
    if (answer === '') return 14;
    if (answer === 'off') return 'off';
    const days = Number(answer);
    if (Number.isInteger(days) && days >= 1 && days <= 90) return days;
    throw new UsageError("init: history retention must be an integer from 1 to 90, or 'off'");
  } finally {
    rl.close();
  }
}

/**
 * Resolves how a NEW repository grades unmatched by-id routes (0.9.0,
 * owner decision D7).
 *
 * Flags win, then the terminal question, then `warn`. A non-interactive
 * run (an agent, a CI job, a test) writes `warn` and prints the exact
 * setting to choose `block` — it never blocks a repository the owner
 * never asked to gate on. A repository that ALREADY has a
 * `.gateforge.yml` is left untouched: an existing config that has said
 * nothing keeps saying nothing, and the banner keeps asking.
 *
 * Args:
 *   io: process context (prompt + informational output).
 *   options: parsed init flags.
 *   configExisted: whether `.gateforge.yml` was already present.
 *
 * Returns:
 *   Promise<{ mode: 'block' | 'warn' | undefined; note: string | undefined }>:
 *   the answer to write (`undefined` writes no key) and the non-interactive
 *   line to print.
 */
async function resolveUnmatchedRoutes(
  io: Io,
  options: Record<string, unknown>,
  configExisted: boolean,
): Promise<{ mode: 'block' | 'warn' | undefined; note: string | undefined }> {
  const flagValue = stringFlag(options, 'unmatched-routes');
  if (flagValue !== undefined) {
    const mode = flagValue.trim().toLowerCase();
    if (mode !== 'block' && mode !== 'warn') {
      throw new UsageError("init: --unmatched-routes must be 'block' or 'warn'");
    }
    return { mode, note: undefined };
  }
  if (configExisted) return { mode: undefined, note: undefined };
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return {
      mode: 'warn',
      note:
        "note: routes whose name matches no table will be REPORTED, not blocking. " +
        "set 'endpoints:\n  unmatchedRoutes: block' in .gateforge.yml (or re-run with --unmatched-routes block) to block on them",
    };
  }
  // The question is printed by the command (like the goal question), so it
  // is in the run's own output and survives a non-interactive transcript;
  // the readline prompt only takes the answer.
  writeLine(io.stdout, 'Routes whose name matches no table: block commits, or warn only? [block/warn] (default warn)');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(' ')).trim().toLowerCase();
    if (answer === '') return { mode: 'warn', note: undefined };
    if (answer !== 'block' && answer !== 'warn') {
      throw new UsageError("init: unmatched-route grading must be 'block' or 'warn'");
    }
    return { mode: answer, note: undefined };
  } finally {
    rl.close();
  }
}

/**
 * Resolves which behavior packs' cases `init` enables (plan 2026-09-30
 * Phase 4). Flags win, then the terminal question, then nothing.
 *
 * A non-interactive run — an agent, a CI job, a test — NEVER enables a
 * pack silently: it prints what it found and the exact flag that
 * enables each pack, and returns none. `--no-behavior` prints nothing at
 * all, so a repository that shows no behavior pack keeps `init`
 * byte-identical.
 *
 * Args:
 *   io: process context (the question is asked on the real terminal).
 *   input: the detected packs and the owner's explicit flags.
 *
 * Returns:
 *   Promise<BehaviorNamespace[]>: the enabled namespaces, in print order.
 */
async function resolveBehaviorPacks(
  io: Io,
  input: {
    detectedPacks: readonly DetectedBehaviorPack[];
    explicit: readonly BehaviorNamespace[];
    enableAll: boolean;
    disabled: boolean;
  },
): Promise<BehaviorNamespace[]> {
  if (input.disabled) return [];
  if (input.explicit.length > 0) return [...input.explicit];
  if (input.detectedPacks.length === 0) return [];
  if (input.enableAll) return input.detectedPacks.map((pack) => pack.namespace);
  if (!process.stdin.isTTY) {
    writeLine(
      io.stdout,
      'behavior packs detected in this repository (nothing is enabled without a flag):',
    );
    for (const pack of input.detectedPacks) {
      writeLine(io.stdout, `  ${pack.namespace} — ${behaviorPackEvidence(pack)}`);
    }
    writeLine(io.stdout, 'enable their cases, then re-run init:');
    for (const pack of input.detectedPacks) {
      writeLine(io.stdout, `  gateforge init --behavior-packs ${pack.namespace}`);
    }
    if (input.detectedPacks.length > 1) {
      const all = input.detectedPacks.map((pack) => pack.namespace).join(',');
      writeLine(io.stdout, `  gateforge init --behavior-packs ${all}`);
    }
    return [];
  }
  const enabled: BehaviorNamespace[] = [];
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    writeLine(
      io.stdout,
      'behavior packs detected in this repository — enable the cases for the ones this app really has:',
    );
    for (const pack of input.detectedPacks) {
      writeLine(io.stdout, `  ${pack.namespace} — ${behaviorPackEvidence(pack)}`);
      const answer = (await rl.question(`enable ${pack.namespace} behavior cases? [y/N] `))
        .trim()
        .toLowerCase();
      if (answer === 'y' || answer === 'yes') enabled.push(pack.namespace);
    }
  } finally {
    rl.close();
  }
  return BEHAVIOR_NAMESPACES.filter((namespace) => enabled.includes(namespace));
}

/**
 * Asks (TTY only) whether init should propose `.gateforge/planes.json`
 * from the discovered model directories. Flags win: --planes forces
 * yes, --no-planes forces no, non-interactive runs default to no (the
 * same contract as {@link resolveBlocking}).
 */
async function resolvePlanes(io: Io, options: Readonly<Record<string, unknown>>): Promise<boolean> {
  if (options['planes'] === true) return true;
  if (options['no-planes'] === true) return false;
  if (!process.stdin.isTTY) {
    writeLine(
      io.stdout,
      'tip: gateforge init --planes proposes .gateforge/planes.json from discovered model directories (review before the next run)',
    );
    return false;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (
      await rl.question(
        'Propose .gateforge/planes.json from discovered model directories (review before the next run)? [y/N] ',
      )
    )
      .trim()
      .toLowerCase();
    return answer === 'y' || answer === 'yes';
  } finally {
    rl.close();
  }
}

/**
 * Reads an owner-supplied folder list file: ONE folder per line, blank
 * lines and `#` comments ignored. The comma list stays supported; this
 * is the same declaration in a form that survives a long repository
 * (typing or pasting dozens of folder names into one prompt wraps
 * unreadably, and `paste -sd,` is not discoverable).
 *
 * Args:
 *   cwd: absolute repository root the relative path resolves against.
 *   filePath: the value given to `--docs-exclude-file`.
 *
 * Returns:
 *   string[]: the folders named by the file, in file order.
 *
 * Throws:
 *   UsageError: the file is missing or unreadable (never guessed at).
 */
function readFolderListFile(cwd: string, filePath: string): string[] {
  const absolute = isAbsolute(filePath) ? filePath : join(cwd, filePath);
  let text: string;
  try {
    text = readFileSync(absolute, 'utf8');
  } catch (error) {
    throw new UsageError(
      `init: cannot read --docs-exclude-file '${filePath}': ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return text
    .split('\n')
    .map((line) => line.split('#')[0]?.trim() ?? '')
    .filter((line) => line.length > 0);
}

/** Resolves the init owner's explicit documentation-folder declaration. */
async function resolveDocsExclusionsForInit(
  io: Io,
  options: Readonly<Record<string, unknown>>,
  config: ReturnType<typeof loadConfig>,
): Promise<{ folders: string[]; changed: boolean }> {
  const current = loadDocsExclusions(io.cwd, config);
  const requestedValue = stringFlag(options, 'docs-exclude');
  const fileValue = stringFlag(options, 'docs-exclude-file');
  const confirmUpdate = options['confirm-doc-exclusions'] === true;
  if (typeof options['confirm-doc-exclusions'] !== 'boolean' && options['confirm-doc-exclusions'] !== undefined) {
    throw new UsageError("init: '--confirm-doc-exclusions' must be a boolean flag");
  }
  if (requestedValue !== undefined || fileValue !== undefined) {
    // Both flags are the SAME declaration in two spellings, so they
    // combine into one ordered, deduplicated list instead of one
    // silently winning over the other.
    const declared = [
      ...(requestedValue === undefined || requestedValue.trim() === ''
        ? []
        : requestedValue.split(',').map((folder) => folder.trim()).filter((folder) => folder.length > 0)),
      ...(fileValue === undefined ? [] : readFolderListFile(io.cwd, fileValue)),
    ];
    const requested = [...new Set(declared)];
    if (current.length > 0 && JSON.stringify(requested) !== JSON.stringify(current) && !confirmUpdate) {
      throw new UsageError(
        `init: changing ${DOCS_EXCLUSIONS_SOURCE} needs explicit owner review; repeat with --confirm-doc-exclusions`,
      );
    }
    if (current.length === 0 && requested.length === 0 && confirmUpdate) {
      throw new UsageError('init: --confirm-doc-exclusions requires a non-empty --docs-exclude update');
    }
    return { folders: validateRequestedDocsFolders(io.cwd, requested, config), changed: JSON.stringify(requested) !== JSON.stringify(current) };
  }
  if (confirmUpdate) {
    throw new UsageError('init: --confirm-doc-exclusions requires --docs-exclude or --docs-exclude-file');
  }
  if (current.length > 0) return { folders: current, changed: false };
  if (process.stdin.isTTY === true && process.stdout.isTTY === true) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      const answer = await rl.question(
        'Owner assertion: enter documentation-only folders to exclude from evidence identity, or leave blank for none. ' +
          'Gateforge cannot prove that app/tests do not read these files. Folders (comma-separated; for a long list ' +
          'write them one per line to a file and pass --docs-exclude-file <path>): ',
      );
      const raw = answer.trim();
      const folders = raw.length === 0
        ? []
        : validateRequestedDocsFolders(
            io.cwd,
            raw.split(',').map((folder) => folder.trim()).filter((folder) => folder.length > 0),
            config,
          );
      return { folders, changed: folders.length > 0 };
    } finally {
      rl.close();
    }
  }
  writeLine(
    io.stdout,
    'tip: non-interactive init keeps full evidence identity; use --docs-exclude <folder,...> (or --docs-exclude-file <path>, one folder per line) to opt in',
  );
  return { folders: [], changed: false };
}
/**
 * Resolves the init owner's explicit Python bytecode exclusion list.
 *
 * Args:
 *   io: process context.
 *   options: parsed init flags.
 *   config: validated Gateforge configuration.
 *
 * Returns:
 *   object: validated files and whether the declaration must be written.
 *
 * Throws:
 *   UsageError: invalid flags or an unconfirmed owner-list change.
 */
function resolveCacheExclusionsForInit(
  io: Io,
  options: Readonly<Record<string, unknown>>,
  config: ReturnType<typeof loadConfig>,
): { files: string[]; changed: boolean } {
  const current = loadCacheExclusions(io.cwd, config);
  const configPath = join(io.cwd, '.gateforge.yml');
  const declarationExists = existsSync(configPath) && declaresEvidenceExclude(readFileSync(configPath, 'utf8'), 'cache');
  const requestedValue = stringFlag(options, 'cache-exclude');
  const confirmUpdate = options['confirm-cache-exclusions'] === true;
  if (
    typeof options['confirm-cache-exclusions'] !== 'boolean' &&
    options['confirm-cache-exclusions'] !== undefined
  ) {
    throw new UsageError("init: '--confirm-cache-exclusions' must be a boolean flag");
  }
  if (requestedValue === undefined) {
    if (confirmUpdate) throw new UsageError('init: --confirm-cache-exclusions requires --cache-exclude');
    return { files: current, changed: false };
  }
  const requested = requestedValue.trim() === ''
    ? []
    : validateRequestedCacheFiles(
        io.cwd,
        requestedValue.split(',').map((file) => file.trim()).filter((file) => file.length > 0),
        config,
      );
  const changed = JSON.stringify(requested) !== JSON.stringify(current);
  if (declarationExists && changed && !confirmUpdate) {
    throw new UsageError(
      `init: changing ${CACHE_EXCLUSIONS_SOURCE} needs explicit owner review; repeat with --confirm-cache-exclusions`,
    );
  }
  if (declarationExists && !changed && confirmUpdate) {
    throw new UsageError('init: --confirm-cache-exclusions requires a changed --cache-exclude list');
  }
  return { files: requested, changed };
}


/**
 * Asks the owner ONE plane question per ROUTE folder that still has
 * unresolved endpoints (owner decision D1: ask, never infer).
 *
 * The linked model's plane is shown as a HINT and is never applied: an
 * `accounts` route can serve master data, so the owner answers for the
 * ROUTES. `proposeRouteFolderPlaneRules` already withholds the hint when
 * the linked models disagree or are themselves unresolved, so a hint
 * here always means "these routes serve a model whose plane IS this".
 *
 * A non-interactive run proposes nothing and writes nothing: it prints
 * the folders and the runnable `gateforge classify plane` shape for each,
 * with the plane and the reason LEFT AS PLACEHOLDERS — printing a concrete
 * plane would be inferring it for the owner, which is exactly what D1
 * forbids, and an agent that copies the line would apply a wrong plane to
 * a folder whose models init inferred as `master`.
 *
 * Args:
 *   cwd: absolute repository root.
 *   io: process context.
 *
 * Returns:
 *   Promise<PlaneConfigRule[]>: the rules the owner answered for.
 */
async function askRouteFolderPlanes(cwd: string, io: Io): Promise<PlaneConfigRule[]> {
  let proposals;
  try {
    proposals = proposeRouteFolderPlanes(await collectRoutePlaneFacts(cwd));
  } catch (cause) {
    writeLine(
      io.stdout,
      `warning: route plane discovery failed (${cause instanceof Error ? cause.message : String(cause)}); ` +
        'answer the route folders with `gateforge classify plane <folder> <tenant|master|global> --reason "<why>" --confirm` — init continues',
    );
    return [];
  }
  if (proposals.length === 0) return [];
  const planes = new Set<SqlalchemyPlane>(['tenant', 'master', 'global']);
  const answers: PlaneConfigRule[] = [];
  if (process.stdin.isTTY !== true || process.stdout.isTTY !== true) {
    writeLine(
      io.stdout,
      `route folders with no answered plane (${proposals.length}) — one owner answer each, ` +
        'never inferred from the linked model:',
    );
    for (const proposal of proposals) {
      writeLine(
        io.stdout,
        `  ${proposal.folder} (${proposal.routeCount} route(s)` +
          `${proposal.hintPlane === null ? '' : `, linked model(s) ${proposal.linkedModels.join(', ')} answer to ${proposal.hintPlane} — a hint only`})`,
      );
      writeLine(
        io.stdout,
        `    gateforge classify plane ${proposal.folder} <tenant|master|global> --reason '<why the ROUTES in this folder serve that data>' --confirm`,
      );
    }
    return answers;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    writeLine(
      io.stdout,
      'route folders whose plane is still unanswered — one answer per folder, asked because ' +
        'a route linked to a model can still serve different data:',
    );
    for (const proposal of proposals) {
      const hint =
        proposal.hintPlane === null
          ? ''
          : ` — hint only: the linked model(s) ${proposal.linkedModels.join(', ')} answer to ${proposal.hintPlane}; ` +
            'a route can serve other data, so this is your answer to make';
      const answer = (
        await rl.question(`plane for '${proposal.folder}' (${proposal.routeCount} route(s)) — tenant/master/global, blank to skip${hint}: `)
      )
        .trim()
        .toLowerCase();
      if (!planes.has(answer as SqlalchemyPlane)) {
        if (answer !== '') writeLine(io.stdout, `  skipped '${proposal.folder}': '${answer}' is not a plane`);
        continue;
      }
      answers.push({
        match: `${proposal.folder}/**`,
        plane: answer as SqlalchemyPlane,
        reason: `answered for the route folder '${proposal.folder}' during gateforge init; review before relying on this`,
      });
    }
  } finally {
    rl.close();
  }
  return answers;
}
/**
 * Runs discovery over the repo's own include/exclude config, infers a
 * planes proposal from the discovered table directories, adds the owner's
 * answered ROUTE-folder rules, self-checks the draft against the runtime's
 * strict parser, and writes `.gateforge/planes.json` — only when absent
 * (never overwrites a reviewed document). Inference failure is surfaced as a
 * visible warning, never silently skipped, but does not abort the scaffold.
 */

async function proposePlanesConfig(
  cwd: string,
  io: Io,
  routeRules: readonly PlaneConfigRule[] = [],
): Promise<void> {
  const planesPath = join(cwd, PLANES_CONFIG_PATH);
  if (existsSync(planesPath)) {
    writeLine(io.stdout, `exists, leaving untouched: ${planesPath}`);
    return;
  }
  let tableSources: string[];
  try {
    const config = loadConfig(join(cwd, '.gateforge.yml'));
    const expandErrors: ExpandError[] = [];
    // The same DETECTOR-INPUT scope the pipeline scans: a gitignored
    // tree (a built report bundle, a local cache) holds no table the
    // planes proposal should infer from.
    const paths = expandScanPaths(
      config.project.paths.include,
      config.project.paths.exclude,
      cwd,
      gitIgnoredPaths(cwd),
      expandErrors,
    );
    // The planes config plays no role in inference (only table SOURCE
    // paths matter), so the detector runs with the default no-mapping
    // rule — immune to whatever a previous run wrote.
    const outcome = await createSqlalchemyDetector({ planesConfig: DEFAULT_PLANES_CONFIG }).discover(paths);
    tableSources = outcome.resources
      .filter(
        (resource): resource is { attributes: Record<string, unknown>; source: string } =>
          (resource as { kind?: string }).kind === 'sqlalchemy.table' &&
          typeof (resource as { source?: string }).source === 'string',
      )
      .map((resource) => resource.source);
  } catch (cause) {
    writeLine(
      io.stdout,
      `warning: plane inference failed (${cause instanceof Error ? cause.message : String(cause)}); ` +
        'add .gateforge/planes.json manually — init continues',
    );
    return;
  }
  const inference = inferPlanesConfig(tableSources);
  if (inference.skippedTestTables > 0) {
    writeLine(
      io.stdout,
      `note: ${inference.skippedTestTables} table(s) under test directories were excluded from plane inference (fixtures are not business surface)`,
    );
  }
  // A reviewed file with zero rules is a real answer, not a failure:
  // it declares no plane, which is exactly what the classifier already
  // assumes while the file is absent. Writing it anyway is what makes
  // `gateforge init --planes` the runnable prerequisite the
  // `gateforge next` guidance prints for an unresolved route.
  // The owner's ROUTE-folder answers join the inferred model rules in the
  // one file init writes: both are reviewed proposals, and splitting them
  // across two writes would make the second overwrite the first.
  const combined = [...(inference.config?.rules ?? []), ...routeRules];
  const serialized = `${JSON.stringify(combined.length === 0 ? { rules: [] } : { rules: combined }, null, 2)}\n`;
  // Self-check the draft against the runtime's strict reader contract
  // BEFORE writing (a broken proposal must fail here, not at the next run).
  parsePlanesConfigText(serialized, planesPath);
  writeFileSync(planesPath, serialized, 'utf8');
  if (inference.config === null) {
    writeLine(
      io.stdout,
      `created: ${planesPath} (no rule could be inferred — ${inference.note ?? 'nothing to propose'}; ` +
        'the file declares no plane, so every table still blocks until you add a reviewed rule)',
    );
    return;
  }
  writeLine(
    io.stdout,
    `created: ${planesPath} (${combined.length} rule(s) — ${inference.config?.rules.length ?? 0} inferred from model directories, ` +
      `${routeRules.length} answered for route folders — review the reasons before the next gateforge run)`,
  );
}

/**
 * Whether a `.gitignore` already covers one engine-state entry.
 *
 * Comparison is line-wise and tolerant of the forms a human writes
 * (leading `/`, a trailing `/`, surrounding spaces, a comment) so a
 * repeated `init` never appends the same rule twice.
 *
 * Args:
 *   text: the current `.gitignore` contents (empty when absent).
 *   entry: the repo-relative directory to ignore.
 *
 * Returns:
 *   boolean: true when the file already ignores that path.
 */
function ignoresEngineState(text: string, entry: string): boolean {
  const wanted = entry.replace(/\/+$/, '');
  return text.split('\n').some((line) => {
    const trimmed = line.trim().replace(/^\/+|\/+$/g, '');
    return trimmed === wanted || trimmed === `${wanted}/**`;
  });
}

/**
 * Adds the engine-owned state directories to the repository's
 * `.gitignore`, creating the file when absent and appending when
 * present. The owner's own lines are preserved byte for byte and a
 * second run reports "already ignored" instead of appending again.
 *
 * Args:
 *   io: process context.
 *   cwd: absolute repository root.
 *
 * Returns:
 *   void.
 */
function ignoreEngineState(io: Io, cwd: string): void {
  const path = join(cwd, '.gitignore');
  const existed = existsSync(path);
  const existing = existed ? readFileSync(path, 'utf8') : '';
  const missing = ENGINE_STATE_IGNORE_ENTRIES.filter((entry) => !ignoresEngineState(existing, entry));
  if (missing.length === 0) {
    if (existed) {
      recordInitPath(io, cwd, path, 'preserved');
      writeLine(io.stdout, `exists, leaving untouched: ${path} (gateforge engine state already ignored)`);
    }
    return;
  }
  const block = [
    ENGINE_STATE_IGNORE_COMMENT,
    ...missing,
    '',
  ].join('\n');
  const prefix = existing.length === 0 || existing.endsWith('\n') ? existing : `${existing}\n`;
  writeFileSync(path, `${prefix}${block}`, 'utf8');
  recordInitPath(io, cwd, path, existed ? 'modified' : 'created');
  writeLine(
    io.stdout,
    `${existed ? 'updated' : 'created'}: ${path} (gateforge engine state ignored: ${missing.join(', ')} — ` +
      'without this, `git add -A` stages the run cache and the gate blocks on its own files)',
  );
}

/** The dependency files whose uncommitted state the install note names. */
const INSTALL_MANIFEST_FILES: readonly string[] = [
  'package.json',
  'package-lock.json',
  'npm-shrinkwrap.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lockb',
  'bun.lock',
];

/** The one line an init run prints while the install is uncommitted. */
const INSTALL_COMMIT_NOTE =
  'note: commit the Gateforge install (package.json and lockfile) on its own BEFORE committing the setup files — a setup commit that also changes dependencies is a product change, and under strictE2E it re-grades the adopted E2E debt as blocking. Commit it now, before the commit gate is wired.';

/**
 * Prints the install-commit note when the install itself (the
 * dependency change that brought Gateforge into the repository)
 * is still uncommitted: the setup commit must stay
 * product-behavior-neutral, so the install belongs in its own
 * commit BEFORE the setup files are committed.
 *
 * Args:
 *   io: process context.
 *
 * Returns:
 *   void: a non-repository, a repository without commits, or a
 *   clean install prints nothing; the run always proceeds
 *   exactly as before (never refuses, never changes the exit
 *   code).
 */
function noteUncommittedInstall(io: Io): void {
  const head = spawnSync('git', ['rev-parse', '--verify', '-q', 'HEAD'], {
    cwd: io.cwd,
    env: io.env,
    encoding: 'utf8',
  });
  if (head.status !== 0) return;
  const status = spawnSync(
    'git',
    ['status', '--porcelain', '--', ...INSTALL_MANIFEST_FILES],
    { cwd: io.cwd, env: io.env, encoding: 'utf8' },
  );
  if (status.status !== 0 || (status.stdout ?? '').trim().length === 0) return;
  writeLine(io.stdout, INSTALL_COMMIT_NOTE);
}

/**
 * Runs `gateforge init` in the io cwd.
 *
 * Args:
 *   io: process context.
 *   argv: flags after the subcommand.
 *
 * Returns:
 *   number: exit code (0).
 */
export async function initCommand(io: Io, argv: readonly string[]): Promise<number> {
  // The ledger every writer below fills: the closing summary names only
  // what THIS run created or kept, so it can never offer to delete the
  // owner's pre-existing config, baselines, waivers, hooks or CI file.
  io.initPaths ??= { created: [], modified: [], preserved: [] };
  const { options } = parseArgs(argv);
  if (options['help'] === true) {
    writeLine(io.stdout, INIT_USAGE);
    return 0;
  }
  rejectUnknownFlags(
    options,
    [
      'preset',
      'explain-presets',
      'languages',
      'plugins',
      'accept-recommended',
      'no-scan',
      'proof',
      'blocking',
      'no-blocking',
      'pre-commit',
      'no-pre-commit',
      'mode',
      'witnessed',
      'ci',
      'no-ci',
      'strict-e2e',
      'planes',
      'no-planes',
      'behavior',
      'unmatched-routes',
      'no-behavior',
      'behavior-packs',
      'docs-exclude',
      'docs-exclude-file',
      'confirm-doc-exclusions',
      'cache-exclude',
      'confirm-cache-exclusions',
      'help',
    ],
    INIT_USAGE,
  );
  // --explain-presets prints the ONE mapping table and exits: it must
  // never scan, prompt or write, so an agent can read what a preset
  // means before choosing one.
  if (options['explain-presets'] === true) {
    writeLine(io.stdout, renderPresetTable());
    return 0;
  }
  if (typeof options['explain-presets'] !== 'boolean' && options['explain-presets'] !== undefined) {
    throw new UsageError("flag '--explain-presets' must be a boolean flag");
  }
  const presetValue = options['preset'];
  if (presetValue !== undefined && !isInitPresetName(presetValue)) {
    throw new UsageError(
      `flag '--preset' must be 'light', 'normal' or 'strict' (got '${String(presetValue)}')`,
    );
  }
  // --proof validation BEFORE any writes: the selected proof path
  // (overlay default, observe reuses the existing suite).
  const proofValue = options['proof'];
  if (proofValue !== undefined) {
    if (typeof proofValue !== 'string' || Array.isArray(proofValue)) {
      throw new UsageError(`flag '--proof' may only be given once`);
    }
    if (proofValue !== 'overlay' && proofValue !== 'observe') {
      throw new UsageError(`flag '--proof' must be 'overlay' or 'observe' (got '${proofValue}')`);
    }
  }
  const proofMode = proofValue === 'observe' ? ('observe' as const) : ('overlay' as const);
  // --plugins validation BEFORE any writes: explicit ids must be known.
  const pluginsValue = options['plugins'];
  if (pluginsValue !== undefined && (typeof pluginsValue === 'boolean' || Array.isArray(pluginsValue))) {
    throw new UsageError(`flag '--plugins' may only be given once`);
  }
  let explicitPlugins: string[] | null = null;
  if (typeof pluginsValue === 'string') {
    const seen = new Set<string>();
    explicitPlugins = [];
    for (const raw of pluginsValue.split(',')) {
      const id = raw.trim();
      if (id.length === 0) continue;
      if (!KNOWN_BUNDLED_PLUGIN_IDS.has(id)) {
        throw new UsageError(
          `unknown plugin '${id}' (known bundled ids: ${[...KNOWN_BUNDLED_PLUGIN_IDS].sort().join(', ')})`,
        );
      }
      if (!seen.has(id)) {
        seen.add(id);
        explicitPlugins.push(id);
      }
    }
  }
  const languagesValue = options['languages'];
  if (typeof languagesValue === 'boolean' || Array.isArray(languagesValue)) {
    throw new UsageError(`flag '--languages' may only be given once`);
  }
  const explicitLanguages =
    languagesValue === undefined
      ? null
      : languagesValue
          .split(',')
          .map((language) => language.trim().toLowerCase())
          .filter((language) => language.length > 0);
  if (explicitLanguages !== null && explicitLanguages.length === 0) {
    throw new UsageError(`flag '--languages' requires at least one language`);
  }
  if (typeof options['strict-e2e'] !== 'boolean' && options['strict-e2e'] !== undefined) {
    throw new UsageError("flag '--strict-e2e' must be a boolean flag");
  }
  // The install-commit note (0.9.1): the dependency change that
  // brought Gateforge in belongs in its own commit BEFORE the
  // setup files — a setup commit that also changes dependencies
  // is a product change. Printed at the START of the run; never
  // refuses and never changes the exit code.
  noteUncommittedInstall(io);
  // Goal resolution (plan Phase 1/2): --preset wins, then the one goal
  // question in a terminal, then light with a loud note. A run that
  // already carries explicit enforcement flags has chosen for itself, so
  // no preset is applied and today's byte-identical behavior is kept.
  const enforcementFlagGiven =
    options['blocking'] === true ||
    options['no-blocking'] === true ||
    options['pre-commit'] === true ||
    options['no-pre-commit'] === true ||
    options['witnessed'] !== undefined ||
    options['mode'] !== undefined ||
    options['ci'] === true ||
    options['no-ci'] === true ||
    options['strict-e2e'] === true;
  const goal = await resolveGoal(io, options, enforcementFlagGiven, existsSync(join(io.cwd, '.gateforge.yml')));
  const strictE2E = goal !== null ? goal.settings.strictE2E : options['strict-e2e'] === true;

  // An existing config is never rewritten (R1-2): a run that
  // REQUESTS a setting the file already owns with a different
  // value — a chosen preset's `mode`/`enforcement.strictE2E`,
  // or the `--strict-e2e` / `--unmatched-routes` flags — exits
  // 2 BEFORE anything is written, one line per differing key,
  // naming the key, both values, and the edit that fixes it.
  // Same value (or no such request) behaves exactly as today.
  const configConflicts = requestedConfigConflicts(io.cwd, options, goal);
  if (configConflicts.length > 0) {
    throw new UsageError(
      configConflicts
        .map(
          (conflict) =>
            `.gateforge.yml exists and has ${conflict.key}: ${conflict.current}; ` +
              `you asked for ${conflict.requested}. init never rewrites an existing config — ` +
              `set ${conflict.key}: ${conflict.requested} in .gateforge.yml yourself.`,
        )
        .join('\n'),
    );
  }

  // Strict-setup preflight (plan Phase 0 item 4): BEFORE anything is
  // written — a strict setup demanding an unavailable proof channel
  // stays visibly incomplete instead of shipping a false green. The
  // starter policy is persistence-only (available), so this passes for
  // the recommended install.
  if (strictE2E) {
    preflightStrictSetup(POLICIES_TEMPLATE);
  }

  // Scan + recommend + choose (Phase 1 item 1): heuristics inform the
  // install; nothing extra is silently enabled. `--no-scan` skips the
  // filesystem walk and falls back to the language-derived set (and
  // claims nothing about how much code is there); `--languages` skips
  // only the language DERIVATION — the signals and the number of files
  // the walk really saw are still true.
  const noScan = options['no-scan'] === true;
  const walked = noScan ? null : scanRepo(io.cwd);
  const scan: RepoScan =
    walked === null
      ? { languages: explicitLanguages ?? ['python'], signals: [], reasons: undefined, files: 0 }
      : explicitLanguages === null
        ? walked
        : { ...walked, languages: explicitLanguages };
  // Which runner the scan saw. The `runner:` key is owner-owned, so it
  // is written ONLY when exactly one non-Playwright runner was detected:
  // Playwright stays the frozen default, and an ambiguous repository
  // (Playwright + something else, or several others) keeps today's
  // behavior plus one plain line naming the choice it left to the owner.
  const detectedRunners = DETECTABLE_RUNNERS.filter((runner) => scan.signals.includes(runner));
  const otherRunners = detectedRunners.filter((runner) => runner !== 'playwright');
  const detectedRunner =
    detectedRunners.includes('playwright') || otherRunners.length !== 1 ? undefined : otherRunners[0];
  if (otherRunners.length > 0 && detectedRunner === undefined) {
    writeLine(
      io.stdout,
      `note: other test runners detected (${otherRunners.join(', ')}); the new config keeps the default runner — ` +
        "set `runner: <playwright|pytest|vitest|cypress>` in .gateforge.yml to pick one",
    );
  }
  const recommended = explicitPlugins ?? recommendPlugins(scan);
  writeLine(io.stdout, renderScanBlock(scan, recommended, proofMode));

  // Flags win: an explicit --plugins choice skips the prompt entirely.
  if (explicitPlugins === null && !(await resolveRecommended(io, options))) {
    writeLine(io.stdout, 'skipped by user choice; re-run with --accept-recommended to write the recommended setup');
    return 0;
  }

  const cwd = io.cwd;
  // Which CI provider this repository ALREADY used, captured BEFORE any
  // CI file is written by this run: a repository that shows no provider
  // at all gets both sets of instructions, and after wiring
  // `.gitlab-ci.yml` always exists — the question would then be answered
  // by us rather than read from the repository.
  const ciProviderBeforeWiring = detectCiProvider(cwd);
  // Whether `.gateforge.yml` was already there BEFORE this run: the
  // preset summary must tell the truth about what changed.
  const existedConfigAtStart = existsSync(join(io.cwd, '.gateforge.yml'));
  const historyRetentionDays = existsSync(join(cwd, '.gateforge.yml')) ? undefined : await resolveHistoryRetention(io);
  // How a NEW repository grades unmatched by-id routes (0.9.0, owner
  // decision D7). Asked once, in a terminal; `warn` and the exact key to
  // choose `block` on a non-interactive run; an existing config is left
  // alone and keeps the `check`/`next` banner asking.
  const unmatchedRoutes = await resolveUnmatchedRoutes(io, options, existedConfigAtStart);
  if (unmatchedRoutes.note !== undefined) writeLine(io.stdout, unmatchedRoutes.note);
  const languages = scan.languages;
  const pluginIds = recommended;
  const configOptions = {
    strictE2E,
    enforcement:
      strictE2E ||
      options['blocking'] === true ||
      options['pre-commit'] === true ||
      (options['witnessed'] === 'staged' || options['witnessed'] === 'full'),
    historyRetentionDays,
    // A preset names the owner-owned strictness key; without one the key
    // stays absent, which means `strict` (today's frozen behavior).
    strictnessMode: goal?.settings.strictnessMode,
    // The scanned runner, when it is unambiguous and not Playwright.
    runner: detectedRunner,
    // The owner's answer for unmatched by-id routes; undefined writes no key.
    unmatchedRoutes: unmatchedRoutes.mode,
  };
  const generatedDraftConfig = (): ReturnType<typeof loadConfig> =>
    parseConfig(parseYaml(configTemplate(languages, pluginIds, configOptions)), { file: '.gateforge.yml' });
  // A pre-0.10 exclusion declaration is never silently ignored, not even
  // by init: the owner is told to migrate instead of losing the list.
  if (legacyExclusionPathsPresent(cwd).length > 0) rejectLegacyExclusions(cwd);
  let draftConfig: ReturnType<typeof loadConfig>;
  if (existsSync(join(cwd, '.gateforge.yml'))) {
    try {
      draftConfig = loadConfig(join(cwd, '.gateforge.yml'));
    } catch (error) {
      const docsChoiceRequested = stringFlag(options, 'docs-exclude') !== undefined;
      const cacheChoiceRequested = stringFlag(options, 'cache-exclude') !== undefined;
      if (
        docsChoiceRequested ||
        cacheChoiceRequested ||
        (process.stdin.isTTY === true && process.stdout.isTTY === true)
      ) {
        throw error;
      }
      draftConfig = generatedDraftConfig();
    }
  } else {
    draftConfig = generatedDraftConfig();
  }
  const docsExclusionChoice = await resolveDocsExclusionsForInit(io, options, draftConfig);
  const cacheExclusionChoice = resolveCacheExclusionsForInit(io, options, draftConfig);
  const gateforgeDir = join(cwd, '.gateforge');
  const targets: Array<{ path: string; write: () => void; label: string }> = [
    {
      path: join(cwd, '.gateforge.yml'),
      label: 'config',
      write: () => {
        // Self-check the template against the pinned schema before
        // writing anything (a broken template must fail here, not in
        // every later command).
        parseConfig(parseYaml(configTemplate(languages, pluginIds, configOptions)), { file: '.gateforge.yml' });
        writeFileSync(join(cwd, '.gateforge.yml'), configTemplate(languages, pluginIds, configOptions), 'utf8');
      },
    },
    {
      path: join(gateforgeDir, 'policies.yml'),
      label: 'policies document',
      write: () => writeFileSync(join(gateforgeDir, 'policies.yml'), POLICIES_TEMPLATE, 'utf8'),
    },
    {
      path: join(gateforgeDir, 'classification-policy.yml'),
      label: 'classification policy',
      write: () => {
        const policyText = classificationPolicyTemplate(languages, pluginIds);
        // Self-check against the pinned policy schema (same contract as
        // the config template).
        ClassificationPolicySchema.parse(parseYaml(policyText));
        writeFileSync(
          join(gateforgeDir, 'classification-policy.yml'),
          policyText,
          'utf8',
        );
      },
    },
    {
      path: join(gateforgeDir, 'baselines', 'obligations.json'),
      label: 'baseline (empty)',
      write: () =>
        writeFileSync(
          join(gateforgeDir, 'baselines', 'obligations.json'),
          serializeBaseline({ schemaVersion: 1, fingerprints: [] }),
          'utf8',
        ),
    },
    {
      path: join(cwd, 'GATEFORGE.md'),
      label: 'agent skill file',
      write: () => writeFileSync(join(cwd, 'GATEFORGE.md'), GATEFORGE_MD_TEMPLATE, 'utf8'),
    },
    // Overlay proof README (overlay proof only): the observe path reuses
    // the existing suite, so no overlay directory is scaffolded for it.
    ...(proofMode === 'overlay'
      ? [
          {
            path: join(cwd, 'tests', 'e2e', 'gateforge', 'README.md'),
            label: 'overlay proof README',
            write: () => {
              mkdirSync(join(cwd, 'tests', 'e2e', 'gateforge'), { recursive: true });
              writeFileSync(join(cwd, 'tests', 'e2e', 'gateforge', 'README.md'), OVERLAY_README_TEMPLATE, 'utf8');
            },
          },
        ]
      : []),
  ];
  /**
   * Queues one scaffold file, keyed by path. Two steps of the same run
   * can want the SAME file with different content (the config and the
   * config-with-behaviorPolicy); pushing both made the second entry
   * report "exists, leaving untouched" about a file the same run had
   * just created, and silently dropped the richer content. The later
   * entry wins, in the later entry's position, so exactly one line per
   * file is ever printed and the fullest content is what lands.
   */
  const pushTarget = (target: { path: string; write: () => void; label: string }): void => {
    const existing = targets.findIndex((candidate) => candidate.path === target.path);
    if (existing === -1) {
      targets.push(target);
      return;
    }
    targets[existing] = target;
  };

  mkdirSync(join(gateforgeDir, 'adapters'), { recursive: true });
  mkdirSync(join(gateforgeDir, 'waivers'), { recursive: true });
  mkdirSync(join(gateforgeDir, 'baselines'), { recursive: true });

  // Behavior-case setup (plan 2026-09-19 §4.11, Phase 4 of
  // 2026-09-25): `--behavior` scaffolds .gateforge/behavior.yml
  // (scaffold only — never real approval) and wires `behaviorPolicy`
  // into a NEW .gateforge.yml; an existing config is left untouched with
  // the exact line to add. `--behavior-packs <pack,...>` enables the
  // named packs' example cases; `--no-behavior` skips.
  //
  // Detection decides what init OFFERS, never what it enables: flags
  // win, then the terminal question, then nothing. A non-interactive
  // (agent/CI) run prints the exact flag for each pack it found and
  // enables none of them.
  const noBehavior = options['no-behavior'] === true;
  const behaviorFlag = options['behavior'] === true;
  const packsValue = options['behavior-packs'];
  if (typeof packsValue === 'boolean' || Array.isArray(packsValue)) {
    throw new UsageError("flag '--behavior-packs' may only be given once");
  }
  if (typeof packsValue !== 'string' && packsValue !== undefined) {
    throw new UsageError("flag '--behavior-packs' must be a comma-separated list of pack names");
  }
  let requestedNamespaces: BehaviorNamespace[] = [];
  if (packsValue !== undefined) {
    try {
      requestedNamespaces = parseBehaviorPacks(packsValue);
    } catch (cause) {
      throw new UsageError(
        `flag '--behavior-packs': ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }
    if (requestedNamespaces.length === 0) {
      throw new UsageError("flag '--behavior-packs' requires at least one pack name");
    }
  }
  // The `task` pack is offered ONLY when the owner's config declares a
  // `queueObserver`: without the engine's own queue read every `task:*`
  // case fails closed, so recommending it would print a flag whose cases
  // can never be satisfied. Absent the block the offer is byte-identical
  // to a repository that has no background work at all.
  const detectedPacks =
    noScan || noBehavior
      ? []
      : detectBehaviorPacks(cwd, draftConfig.queueObserver !== undefined);
  const enabledNamespaces = await resolveBehaviorPacks(io, {
    detectedPacks,
    explicit: requestedNamespaces,
    enableAll: behaviorFlag && requestedNamespaces.length === 0,
    disabled: noBehavior,
  });
  const wantBehavior = enabledNamespaces.length > 0 || (behaviorFlag && !noBehavior);
  if (wantBehavior) {
    const behaviorPath = join(gateforgeDir, 'behavior.yml');
    const enabledPacks = detectedPacks.filter((pack) => enabledNamespaces.includes(pack.namespace));
    const template = `${BEHAVIOR_TEMPLATE}${behaviorSkeletonExamples(enabledPacks)}`;
    if (existsSync(behaviorPath)) {
      writeLine(io.stdout, `exists, leaving untouched: ${behaviorPath}`);
      for (const pack of enabledPacks) {
        writeLine(
          io.stdout,
          `  the ${pack.namespace} example case for this repository — add it under 'endpoints:' in ${behaviorPath}:`,
        );
        for (const line of behaviorSkeletonExamples([pack]).split('\n').slice(1)) {
          writeLine(io.stdout, `  ${line}`);
        }
      }
    } else {
      pushTarget({
        path: behaviorPath,
        label: 'complete-behavior document (SCAFFOLD — not approval)',
        write: () => writeFileSync(behaviorPath, template, 'utf8'),
      });
    }
    if (!existsSync(join(cwd, '.gateforge.yml'))) {
      pushTarget({
        path: join(cwd, '.gateforge.yml'),
        label: 'config (with behaviorPolicy)',
        write: () => {
          const text = configTemplate(languages, pluginIds, configOptions);
          const withBehavior = text.replace(
            /^policies:/m,
            'behaviorPolicy: .gateforge/behavior.yml\npolicies:',
          );
          parseConfig(parseYaml(withBehavior), { file: '.gateforge.yml' });
          writeFileSync(join(cwd, '.gateforge.yml'), withBehavior, 'utf8');
        },
      });
    } else {
      writeLine(
        io.stdout,
        'note: existing .gateforge.yml left untouched — add this line to it to enable the profile:',
      );
      writeLine(io.stdout, '  behaviorPolicy: .gateforge/behavior.yml');
    }
  }

  // An EXPLICIT `--plugins` on an initialized repository ADDS the
  // requested detectors to the owner's config instead of being ignored.
  // The merge is additive (an existing entry keeps the owner's version
  // pin; nothing is removed) and touches only the `plugins:` list, so
  // the product's own tip — "re-run with --plugins … to change
  // detectors" — is finally true. Every other key, comment, and edit in
  // the file is preserved byte for byte, and the schema is checked
  // before anything is written.
  if (explicitPlugins !== null && existsSync(join(cwd, '.gateforge.yml'))) {
    const configPath = join(cwd, '.gateforge.yml');
    const merged = mergePluginsIntoConfig(readFileSync(configPath, 'utf8'), explicitPlugins);
    if (merged === null) {
      writeLine(
        io.stdout,
        `${explicitPlugins.join(', ')} already configured in ${configPath}; leaving it untouched`,
      );
    } else {
      writeFileSync(configPath, merged, 'utf8');
      const added = loadConfig(configPath).plugins
        .map((plugin) => plugin.id)
        .filter((id) => explicitPlugins.includes(id));
      recordInitPath(io, cwd, configPath, 'modified');
      writeLine(
        io.stdout,
        `updated: ${configPath} (added detector(s): ${added.join(', ')} — every other key left as it was)`,
      );
    }
  }

  const configExistedBefore = existsSync(join(cwd, '.gateforge.yml'));
  for (const target of targets) {
    if (existsSync(target.path)) {
      recordInitPath(io, cwd, target.path, 'preserved');
      writeLine(io.stdout, `exists, leaving untouched: ${target.path}`);
      continue;
    }
    target.write();
    recordInitPath(io, cwd, target.path, 'created');
    writeLine(io.stdout, `created: ${target.path}`);
  }
  // Evidence exclusions live in `.gateforge.yml` (0.10.0), so they are
  // written AFTER the scaffold loop: the config is on disk by now (the
  // loop created it or preserved the owner's), and the declaration is
  // spliced into that exact text — comments, key order and quoting stay
  // byte for byte, and only the `evidence.exclude` block is new.
  if (docsExclusionChoice.changed || cacheExclusionChoice.changed) {
    const configPath = join(cwd, '.gateforge.yml');
    const before = readFileSync(configPath, 'utf8');
    const after = setEvidenceExclude(
      before,
      {
        ...(docsExclusionChoice.changed ? { docs: docsExclusionChoice.folders } : {}),
        ...(cacheExclusionChoice.changed ? { cache: cacheExclusionChoice.files } : {}),
      },
      '.gateforge.yml',
    );
    const temporaryPath = join(gateforgeDir, `.evidence-exclusions-${randomUUID()}.tmp`);
    try {
      writeFileSync(temporaryPath, after, { flag: 'wx', encoding: 'utf8' });
      renameSync(temporaryPath, configPath);
    } catch (error) {
      if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
      throw error;
    }
    recordInitPath(io, cwd, configPath, configExistedBefore ? 'modified' : 'created');
    writeLine(io.stdout, `${configExistedBefore ? 'updated' : 'created'}: ${configPath} (evidence.exclude)`);
  }
  // Engine-owned state is never a product change: without this the
  // first `git add -A` stages the run cache the gate just wrote, and the
  // gate then blocks on its own files.
  ignoreEngineState(io, cwd);
  // Observe proof checklist (observe proof only): the work no scaffold
  // can do — proxy wiring, adapter bindings, and kind declarations.
  if (proofMode === 'observe') {
    writeLine(io.stdout, OBSERVE_CHECKLIST);
  }
  // Behavior checklist (behavior setup only): honest "not ready" — the
  // scaffold enables the profile but every endpoint blocks until the
  // owner declares cases and they are proven through the witness.
  if (wantBehavior) {
    writeLine(io.stdout, BEHAVIOR_CHECKLIST);
  }
  if (docsExclusionChoice.folders.length > 0) {
    const writtenConfig = loadConfig(join(cwd, '.gateforge.yml'));
    const approvalDigest = trustedPolicyDigestForConfig(cwd, writtenConfig);
    writeLine(io.stdout, `owner-declared documentation folders: ${docsExclusionChoice.folders.join(', ')}`);
    writeLine(io.stdout, `warning: ${DOCS_EXCLUSIONS_GUARANTEE}`);
    writeLine(io.stdout, `candidate policy digest to approve outside the repository: ${approvalDigest}`);
    writeLine(
      io.stdout,
      'set GATEFORGE_APPROVED_POLICY_DIGEST in a protected owner environment to this exact digest; without a matching pin, Gateforge refuses to use the exclusions',
    );
  }
  if (cacheExclusionChoice.files.length > 0) {
    const writtenConfig = loadConfig(join(cwd, '.gateforge.yml'));
    const approvalDigest = trustedPolicyDigestForConfig(cwd, writtenConfig);
    writeLine(io.stdout, `owner-declared Python bytecode files: ${cacheExclusionChoice.files.join(', ')}`);
    writeLine(io.stdout, `warning: ${CACHE_EXCLUSIONS_GUARANTEE}`);
    writeLine(io.stdout, `candidate policy digest to approve outside the repository: ${approvalDigest}`);
    writeLine(
      io.stdout,
      'set GATEFORGE_APPROVED_POLICY_DIGEST in a protected owner environment to this exact digest; without a matching pin, Gateforge refuses to use the exclusions',
    );
  }
  // Plane-config proposal (flags win; TTY prompt fills the gap;
  // non-interactive defaults to scaffold-only, like every granular step):
  //   --planes / --no-planes
  //       propose .gateforge/planes.json from the model directories the
  //       discovered tables live in — a review artifact with a reason on
  //       every rule, written only when absent, never silently applied
  //       (the next run reads it and the user reviews first).
  //
  // An EXPLICIT `--planes` is always honored: it is the runnable
  // prerequisite the `gateforge next` guidance prints for an unresolved
  // route, and a language gate would make that printed command a no-op
  // on exactly the repositories that need it. The proposal itself is
  // conservative — no discovered table means no inferred rule.
  const planesRequested = options['planes'] === true;
  if (planesRequested || languages.includes('python')) {
    if (await resolvePlanes(io, options)) {
      // The route folders are asked in the SAME flow, right before the
      // model folders are written, so both sets of answers land in one
      // reviewed `.gateforge/planes.json`.
      const routeRules = await askRouteFolderPlanes(cwd, io);
      await proposePlanesConfig(cwd, io, routeRules);
    }
  }
  // Behavior-profile setup (plan 2026-09-19 §4.11): `--behavior` scaffolds
  // .gateforge/behavior.yml (scaffold only — never real approval) and
  // wires `behaviorPolicy` into a NEW .gateforge.yml; an existing config
  // is left untouched with an instruction to add the key manually.
  // `--no-behavior` skips; default (flag absent) skips.
  // Enforcement wiring is granular (flags win; TTY prompts fill the gaps;
  // non-interactive runs default to scaffold-only so tests and CI never
  // hang on a prompt):
  //   --pre-commit        wire the pre-commit gate hook
  //   --mode changed|staged
  //                       changed = debt-friendly `check --changed`;
  //                       staged  = strict `check --staged --require-e2e`
  //                       (+ the standalone staged-gate script)
  //   --witnessed staged|full
  //                       run a fresh supervised witness gate in the
  //                       exact staged checkout before receipt validation;
  //                       staged selects affected tests, full selects all
  //   --ci / --no-ci      wire the .gitlab-ci.yml include + job template
  //   --blocking          legacy all-in: pre-commit (staged) + CI
  const modeValue = options['mode'];
  if (modeValue !== undefined) {
    if (typeof modeValue !== 'string' || (modeValue !== 'changed' && modeValue !== 'staged')) {
      throw new UsageError(`flag '--mode' must be 'changed' or 'staged'`);
    }
  }
  const witnessedValue = options['witnessed'];
  if (
    witnessedValue !== undefined &&
    (typeof witnessedValue !== 'string' || (witnessedValue !== 'staged' && witnessedValue !== 'full'))
  ) {
    throw new UsageError(`flag '--witnessed' must be 'staged' or 'full'`);
  }
  if (witnessedValue !== undefined && modeValue !== undefined) {
    throw new UsageError("init: --witnessed selects the pre-commit execution mode and cannot be combined with '--mode'");
  }
  // The goal decides the wiring; explicit flags already short-circuited
  // goal resolution above, so nothing here can contradict a flag. When
  // there is no goal, today's granular behavior is unchanged.
  const blocking = goal !== null ? goal.settings.wiring === 'blocking' : await resolveBlocking(io, options);
  const preCommit =
    options['pre-commit'] === true ||
    blocking ||
    witnessedValue !== undefined ||
    (goal !== null && goal.settings.wiring === 'pre-commit');
  const ci = options['ci'] === true || blocking || (goal !== null && goal.settings.ci);
  const receiptStage = preCommit ? loadConfig(join(cwd, '.gateforge.yml')).enforcement?.receiptStage : undefined;
  const mode: 'changed' | 'staged' =
    typeof modeValue === 'string'
      ? (modeValue as 'changed' | 'staged')
      : goal !== null
        ? goal.settings.mode
        : blocking
          ? 'staged'
          : 'changed';
  if (preCommit) {
    const hookDir = join(gateforgeDir, 'hooks');
    mkdirSync(hookDir, { recursive: true });
    // One generated hook across all wiring commands: the resolution order
    // is shared; only the gate invocation differs, recorded at generation
    // time by the wiring command's mode.
    const gateArgs =
      witnessedValue === 'staged'
        ? ['pre-commit', '--scope', 'staged']
        : witnessedValue === 'full'
          ? ['pre-commit', '--scope', 'full']
          : mode === 'staged'
            ? receiptStage === 'pre-push' || receiptStage === 'ci'
              ? ['check', '--staged']
              : ['check', '--staged', '--require-e2e']
            : receiptStage === 'pre-commit'
              ? ['check', '--changed', '--require-e2e']
              : ['check', '--changed'];
    ensureHookScript(io, engineRootFromInvocation(), gateArgs);
    // The ACTIVE hook (plan Phase 5 item 1): install into the resolved
    // hooks directory AND verify activation — never merely write a
    // config file.
    if (mode === 'staged' || witnessedValue !== undefined) {
      const standaloneBefore = existsSync(join(cwd, '.gateforge', 'hooks', 'gateforge-staged.sh'))
        ? readFileSync(join(cwd, '.gateforge', 'hooks', 'gateforge-staged.sh'), 'utf8')
        : null;
      const gateScript = writeStandaloneGateScript(cwd, gateArgs);
      const standaloneAfter = readFileSync(gateScript, 'utf8');
      const standaloneState =
        standaloneBefore === null
          ? 'created'
          : hasGateforgeMarker(standaloneAfter)
            ? standaloneBefore === standaloneAfter
              ? 'verified'
              : 'updated'
            : 'preserved foreign file';
      writeLine(io.stdout, `${standaloneState}: ${gateScript} (standalone staged gate: ${gateArgs.join(' ')})`);
    }
    const outcome = installCommitHook(cwd, io.env, gateArgs);
    // A pre-commit-FRAMEWORK-managed .git hook is not a conflict: the
    // framework regenerates that file from .pre-commit-config.yaml on every
    // install, so chaining into it would be silently wiped. Gateforge
    // integrates through the framework config instead (appendPreCommitHook
    // below) — the hook block runs on every commit like any other.
    const frameworkManaged = outcome.status === 'framework';
    // The undo list must name the hook this run installed and NOT name
    // one that was already there.
    if (outcome.hookPath !== null) {
      recordInitPath(io, cwd, outcome.hookPath, outcome.status === 'installed' ? 'created' : 'preserved');
    }
    switch (outcome.status) {
      case 'installed':
        writeLine(io.stdout, `installed: ${outcome.detail}`);
        break;
      case 'updated':
        writeLine(io.stdout, `updated: ${outcome.detail}`);
        break;
      case 'verified':
        writeLine(io.stdout, `verified: ${outcome.detail}`);
        break;
      case 'framework':
        if (outcome.hookPath !== null && !existsSync(outcome.hookPath)) {
          writeLine(
            io.stdout,
            'pre-commit framework config found: gateforge-check added to .pre-commit-config.yaml — run `pre-commit install` to activate the gate',
          );
        } else {
          writeLine(io.stdout, `framework-managed pre-commit hook detected: wiring through .pre-commit-config.yaml`);
        }
        break;
      case 'conflict':
      case 'incomplete':
        writeLine(io.stdout, `incomplete installation: ${outcome.detail}`);
        writeLine(io.stdout, `required action:\n${outcome.action}`);
        throw new UsageError(
          `init --blocking: hook installation incomplete — ${outcome.detail}\nRequired action:\n${outcome.action}`,
        );
    }
    appendPreCommitHook(io);
    writeSharedGitlabCiTemplate(io, 'strict');
    writeLine(
      io.stdout,
      frameworkManaged
        ? `blocking gate wired through the pre-commit framework (gateforge-check in .pre-commit-config.yaml, ${gateArgs.join(' ')}) + .gitlab-ci.yml include. ` +
            'Honest limit: `git commit --no-verify` bypasses the local hook (ADR 0005 D1) — standard enforcement also requires the trusted server check.'
        : `blocking gate wired: active pre-commit hook (${gateArgs.join(' ')}) + .gitlab-ci.yml include. ` +
            'Honest limit: `git commit --no-verify` bypasses the local hook (ADR 0005 D1) — standard enforcement also requires the trusted server check.',
    );
    if (receiptStage === 'pre-push') {
      const pushHook = installPrePushHook(cwd, io.env);
      if (pushHook.status === 'conflict' || pushHook.status === 'incomplete') {
        throw new UsageError(`${pushHook.detail}\nRequired action:\n${pushHook.action}`);
      }
      if (pushHook.hookPath !== null) {
        recordInitPath(io, cwd, pushHook.hookPath, pushHook.status === 'installed' ? 'created' : 'preserved');
      }
      writeLine(io.stdout, `${pushHook.status}: ${pushHook.detail}`);
    }
    writeServerProtectionInstructions(io, ciProviderBeforeWiring);
  }
  // A preset can ask for the CI job without a local hook (`normal`):
  // the server check is then the only place the gate runs, which is a
  // real choice, not a fallback.
  if (ci && !preCommit) {
    writeSharedGitlabCiTemplate(io, 'strict');
  }
  // What the goal wrote, in plain words, plus the command that undoes it.
  if (goal !== null) {
    const ledger = io.initPaths;
    for (const line of renderPresetSummary(goal.name, {
      configExisted: existedConfigAtStart,
      autoChosen: goal.autoChosen === true,
      created: [...(ledger?.created ?? [])],
      modified: [...(ledger?.modified ?? [])],
      repoHasCommitHook: existsSync(join(cwd, '.git/hooks/pre-commit')),
      repoHasCi: existsSync(join(cwd, '.gitlab-ci.yml')) || existsSync(join(cwd, '.github/workflows/gateforge.yml')),
    })) {
      writeLine(io.stdout, line);
    }
  }
  // A repository that already had code before this run gets the
  // adoption path named HERE, where the owner is deciding what the
  // gate will do to them. `init` on a fresh project has no debt and
  // must not talk about adopting one.
  if (!existedConfigAtStart && scan.files > 0) {
    writeLine(io.stdout, ADOPT_ADVICE);
  }
  writeLine(io.stdout, 'skeleton ready: .gateforge/adapters, .gateforge/waivers, .gateforge/baselines');
  const alembicOptIn = renderAlembicOptIn(cwd);
  if (alembicOptIn !== null) writeLine(io.stdout, alembicOptIn);
  return 0;
}
