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
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { join } from 'node:path';
import { parse as parseYaml, parseDocument, isSeq as isYamlSeq, isMap as isYamlMap } from 'yaml';
import {
  ClassificationPolicySchema,
  PolicyFileSchema,
  loadConfig,
  parseConfig,
  serializeBaseline,
  strictCapabilityGaps,
} from '@gate-forge/core';
import type { StrictnessMode } from '@gate-forge/core';
import {
  DEFAULT_PLANES_CONFIG,
  PLANES_CONFIG_PATH,
  createSqlalchemyDetector,
  parsePlanesConfigText,
  PACK_VERSION as PACK_SQLALCHEMY_VERSION,
} from '@gate-forge/pack-sqlalchemy';
import { PACK_VERSION as PACK_FASTAPI_VERSION } from '@gate-forge/pack-fastapi';
import { PACK_VERSION as PACK_HTTP_VERSION } from '@gate-forge/pack-http';
import { PACK_VERSION as PACK_TASK_VERSION } from '@gate-forge/pack-task';
import { renderAlembicOptIn } from '@gate-forge/pack-alembic';
import { parseArgs, stringFlag } from '../args.js';
import type { Io } from '../io.js';
import { recordInitPath, writeLine } from '../io.js';
import { UsageError } from '../errors.js';
import { languageDefaultPlugins, recommendPlugins, renderScanBlock, scanRepo } from '../repo-scan.js';
import { rejectUnknownFlags } from './common.js';
import { expandIncludePaths, type ExpandError } from '../glob.js';
import { inferPlanesConfig } from '../planes-inference.js';
import { hasGateforgeMarker, installCommitHook, installPrePushHook, writeStandaloneGateScript } from '../git-hooks.js';
import {
  appendPreCommitHook,
  ensureHookScript,
  engineRootFromInvocation,
  writeGitlabCiTemplate as writeSharedGitlabCiTemplate,
  writeServerProtectionInstructions,
} from './blocking.js';
import { trustedPolicyDigestForConfig } from '../execution.js';
import {
  DOCS_EXCLUSIONS_GUARANTEE,
  DOCS_EXCLUSIONS_PATH,
  loadDocsExclusions,
  renderDocsExclusions,
  validateRequestedDocsFolders,
} from '../docs-exclusions.js';
import {
  CACHE_EXCLUSIONS_GUARANTEE,
  CACHE_EXCLUSIONS_PATH,
  loadCacheExclusions,
  renderCacheExclusions,
  validateRequestedCacheFiles,
} from '../cache-exclusions.js';
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
export const INIT_USAGE =
  '[--preset light|normal|strict] [--explain-presets] [--no-scan] [--proof overlay|observe] ' +
  '[--blocking] [--no-blocking] [--pre-commit] [--no-pre-commit] [--mode changed|staged] ' +
  '[--witnessed staged|full] [--ci] [--no-ci] ' +
  '[--docs-exclude <folder,...> [--confirm-doc-exclusions]] [--cache-exclude <file,...> ' +
  '[--confirm-cache-exclusions]] [--strict-e2e] [--planes] [--no-planes] [--behavior]';

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
 * packs). `gateforge.pack-task` carries no semantic verifier, so it is
 * opt-in only via `--plugins` — never recommended, never defaulted.
 */
const KNOWN_BUNDLED_PLUGIN_IDS: ReadonlySet<string> = new Set(Object.keys(BUNDLED_PLUGIN_MODULES));

/**
 * Selects the bundled detectors required by the generated coverage and
 * trusted-entry-point rules for the requested source languages.
 * `gateforge.pack-task` is NEVER included: it has no semantic verifier
 * (every contract grades VERIFIER_UNSUPPORTED), so it is opt-in only
 * via `--plugins`.
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
 * unconfigured detector fails every run closed, and task is opt-in
 * (no semantic verifier).
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
${runnerBlock}${historyBlock}${strictnessBlock}${enforcementBlock}\
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
 * Resolves the goal `init` should set up. Three paths, in order:
 *
 * 1. `--preset light|normal|strict` — an agent or CI run picks the goal
 *    explicitly.
 * 2. A real terminal — ONE question ("What should Gateforge do for
 *    you?") with three choices, each explained in one line.
 * 3. No terminal and no `--preset` — light only, stated ONCE on the
 *    line that also names `--preset <light|normal|strict>`. Gateforge
 *    never guesses normal or strict for someone who is not there:
 *    guessing strict blocks a team, guessing normal pretends a gate
 *    nobody asked for.
 *
 * A run that already carries explicit enforcement flags (`--blocking`,
 * `--strict-e2e`, …) has chosen for itself: no preset is applied and the
 * generated config keeps today's exact bytes.
 *
 * Args:
 *   io: process context (prompt + informational output).
 *   options: parsed init flags.
 *   enforcementFlagGiven (boolean): true when an enforcement flag was
 *     passed and therefore wins over any preset.
 *
 * Returns:
 *   Promise<{ name: InitPresetName; settings: InitPresetSettings;
 *   autoChosen?: boolean } | null>: the applied goal (with
 *   `autoChosen` when no human chose it), or null when the run kept
 *   today's behavior.
 */
async function resolveGoal(
  io: Io,
  options: Readonly<Record<string, unknown>>,
  enforcementFlagGiven: boolean,
  configExisted: boolean,
): Promise<{ name: InitPresetName; settings: InitPresetSettings; autoChosen?: boolean } | null> {
  const explicit = options['preset'];
  if (explicit !== undefined && isInitPresetName(explicit)) {
    if (!enforcementFlagGiven) return { name: explicit, settings: INIT_PRESETS[explicit] };
    writeLine(
      io.stdout,
      `note: --preset ${explicit} is ignored because an enforcement flag decides the wiring; the preset's meaning: ${INIT_PRESETS[explicit].explanation}`,
    );
    return null;
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

/** Resolves the init owner's explicit documentation-folder declaration. */
async function resolveDocsExclusionsForInit(
  io: Io,
  options: Readonly<Record<string, unknown>>,
  config: ReturnType<typeof loadConfig>,
): Promise<{ folders: string[]; changed: boolean }> {
  const current = loadDocsExclusions(io.cwd, config);
  const requestedValue = stringFlag(options, 'docs-exclude');
  const confirmUpdate = options['confirm-doc-exclusions'] === true;
  if (typeof options['confirm-doc-exclusions'] !== 'boolean' && options['confirm-doc-exclusions'] !== undefined) {
    throw new UsageError("init: '--confirm-doc-exclusions' must be a boolean flag");
  }
  if (requestedValue !== undefined) {
    const requested = requestedValue.trim() === ''
      ? []
      : validateRequestedDocsFolders(
          io.cwd,
          requestedValue.split(',').map((folder) => folder.trim()).filter((folder) => folder.length > 0),
          config,
        );
    if (current.length > 0 && JSON.stringify(requested) !== JSON.stringify(current) && !confirmUpdate) {
      throw new UsageError(
        `init: changing ${DOCS_EXCLUSIONS_PATH} needs explicit owner review; repeat with --confirm-doc-exclusions`,
      );
    }
    if (current.length === 0 && requested.length === 0 && confirmUpdate) {
      throw new UsageError('init: --confirm-doc-exclusions requires a non-empty --docs-exclude update');
    }
    return { folders: requested, changed: JSON.stringify(requested) !== JSON.stringify(current) };
  }
  if (confirmUpdate) {
    throw new UsageError('init: --confirm-doc-exclusions requires --docs-exclude');
  }
  if (current.length > 0) return { folders: current, changed: false };
  if (process.stdin.isTTY === true && process.stdout.isTTY === true) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      const answer = await rl.question(
        'Owner assertion: enter documentation-only folders to exclude from evidence identity, or leave blank for none. ' +
          'Gateforge cannot prove that app/tests do not read these files. Folders (comma-separated): ',
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
  writeLine(io.stdout, 'tip: non-interactive init keeps full evidence identity; use --docs-exclude <folder,...> to opt in');
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
  const declarationExists = existsSync(join(io.cwd, ...CACHE_EXCLUSIONS_PATH.split('/')));
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
      `init: changing ${CACHE_EXCLUSIONS_PATH} needs explicit owner review; repeat with --confirm-cache-exclusions`,
    );
  }
  if (declarationExists && !changed && confirmUpdate) {
    throw new UsageError('init: --confirm-cache-exclusions requires a changed --cache-exclude list');
  }
  return { files: requested, changed };
}


/**
 * Runs discovery over the repo's own include/exclude config, infers a
 * planes proposal from the discovered table directories, self-checks
 * the draft against the runtime's strict parser, and writes
 * `.gateforge/planes.json` — only when absent (never overwrites a
 * reviewed document). Inference failure is surfaced as a visible
 * warning, never silently skipped, but does not abort the scaffold.
 */
async function proposePlanesConfig(cwd: string, io: Io): Promise<void> {
  const planesPath = join(cwd, PLANES_CONFIG_PATH);
  if (existsSync(planesPath)) {
    writeLine(io.stdout, `exists, leaving untouched: ${planesPath}`);
    return;
  }
  let tableSources: string[];
  try {
    const config = loadConfig(join(cwd, '.gateforge.yml'));
    const expandErrors: ExpandError[] = [];
    const paths = expandIncludePaths(
      config.project.paths.include,
      config.project.paths.exclude,
      cwd,
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
  const serialized = `${JSON.stringify(inference.config ?? { rules: [] }, null, 2)}\n`;
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
    `created: ${planesPath} (${inference.config.rules.length} rule(s) inferred from model directories — review the reasons before the next gateforge run)`,
  );
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
  io.initPaths ??= { created: [], preserved: [] };
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
      'docs-exclude',
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

  // Strict-setup preflight (plan Phase 0 item 4): BEFORE anything is
  // written — a strict setup demanding an unavailable proof channel
  // stays visibly incomplete instead of shipping a false green. The
  // starter policy is persistence-only (available), so this passes for
  // the recommended install.
  if (strictE2E) {
    preflightStrictSetup(POLICIES_TEMPLATE);
  }

  // Scan + recommend + choose (Phase 1 item 1): heuristics inform the
  // install; nothing extra is silently enabled. --no-scan skips the
  // filesystem walk and falls back to the language-derived set.
  const noScan = options['no-scan'] === true;
  const scan =
    noScan || explicitLanguages !== null
      ? {
          languages: explicitLanguages ?? ['python'],
          signals: noScan ? [] : scanRepo(io.cwd).signals,
        }
      : scanRepo(io.cwd);
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
  // Whether `.gateforge.yml` was already there BEFORE this run: the
  // preset summary must tell the truth about what changed.
  const existedConfigAtStart = existsSync(join(io.cwd, '.gateforge.yml'));
  const historyRetentionDays = existsSync(join(cwd, '.gateforge.yml')) ? undefined : await resolveHistoryRetention(io);
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
  };
  const generatedDraftConfig = (): ReturnType<typeof loadConfig> =>
    parseConfig(parseYaml(configTemplate(languages, pluginIds, configOptions)), { file: '.gateforge.yml' });
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
        existsSync(join(cwd, ...DOCS_EXCLUSIONS_PATH.split('/'))) ||
        existsSync(join(cwd, ...CACHE_EXCLUSIONS_PATH.split('/'))) ||
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
  if (docsExclusionChoice.changed) {
    const exclusionPath = join(cwd, ...DOCS_EXCLUSIONS_PATH.split('/'));
    const exclusionText = renderDocsExclusions(docsExclusionChoice.folders);
    targets.push({
      path: exclusionPath,
      label: 'owner-declared documentation exclusions',
      write: () => {
        const temporaryPath = join(gateforgeDir, `.docs-exclusions-${randomUUID()}.tmp`);
        try {
          writeFileSync(temporaryPath, exclusionText, { flag: 'wx', encoding: 'utf8' });
          renameSync(temporaryPath, exclusionPath);
        } catch (error) {
          if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
          throw error;
        }
      },
    });
  }
  if (cacheExclusionChoice.changed) {
    const exclusionPath = join(cwd, ...CACHE_EXCLUSIONS_PATH.split('/'));
    const exclusionText = renderCacheExclusions(cacheExclusionChoice.files);
    targets.push({
      path: exclusionPath,
      label: 'owner-declared Python bytecode exclusions',
      write: () => {
        const temporaryPath = join(gateforgeDir, `.cache-exclusions-${randomUUID()}.tmp`);
        try {
          writeFileSync(temporaryPath, exclusionText, { flag: 'wx', encoding: 'utf8' });
          renameSync(temporaryPath, exclusionPath);
        } catch (error) {
          if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
          throw error;
        }
      },
    });
  }

  mkdirSync(join(gateforgeDir, 'adapters'), { recursive: true });
  mkdirSync(join(gateforgeDir, 'waivers'), { recursive: true });
  mkdirSync(join(gateforgeDir, 'baselines'), { recursive: true });

  // Behavior-profile setup (plan 2026-09-19 §4.11): `--behavior` scaffolds
  // .gateforge/behavior.yml (scaffold only — never real approval) and
  // wires `behaviorPolicy` into a NEW .gateforge.yml; an existing config
  // is left untouched with an instruction to add the key manually.
  // `--no-behavior` skips; default (flag absent) skips.
  const behaviorFlag = options['behavior'] === true;
  const noBehavior = options['no-behavior'] === true;
  const wantBehavior = behaviorFlag && !noBehavior;
  if (wantBehavior) {
    const behaviorPath = join(gateforgeDir, 'behavior.yml');
    if (existsSync(behaviorPath)) {
      writeLine(io.stdout, `exists, leaving untouched: ${behaviorPath}`);
    } else {
      targets.push({
        path: behaviorPath,
        label: 'complete-behavior document (SCAFFOLD — not approval)',
        write: () => writeFileSync(behaviorPath, BEHAVIOR_TEMPLATE, 'utf8'),
      });
    }
    if (!existsSync(join(cwd, '.gateforge.yml'))) {
      targets.push({
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
        'note: existing .gateforge.yml left untouched — add `behaviorPolicy: .gateforge/behavior.yml` to enable the profile',
      );
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
      recordInitPath(io, cwd, configPath, 'preserved');
      writeLine(
        io.stdout,
        `updated: ${configPath} (added detector(s): ${added.join(', ')} — every other key left as it was)`,
      );
    }
  }

  for (const target of targets) {
    if (existsSync(target.path)) {
      if (
        (target.label === 'owner-declared documentation exclusions' && docsExclusionChoice.changed) ||
        (target.label === 'owner-declared Python bytecode exclusions' && cacheExclusionChoice.changed)
      ) {
        target.write();
        writeLine(io.stdout, `updated: ${target.path}`);
        continue;
      }
      recordInitPath(io, cwd, target.path, 'preserved');
      writeLine(io.stdout, `exists, leaving untouched: ${target.path}`);
      continue;
    }
    target.write();
    recordInitPath(io, cwd, target.path, 'created');
    writeLine(io.stdout, `created: ${target.path}`);
  }
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
      await proposePlanesConfig(cwd, io);
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
        writeLine(io.stdout, `framework-managed pre-commit hook detected: wiring through .pre-commit-config.yaml`);
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
    writeServerProtectionInstructions(io);
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
      repoHasCommitHook: existsSync(join(cwd, '.git/hooks/pre-commit')),
      repoHasCi: existsSync(join(cwd, '.gitlab-ci.yml')) || existsSync(join(cwd, '.github/workflows/gateforge.yml')),
    })) {
      writeLine(io.stdout, line);
    }
  }
  writeLine(io.stdout, 'skeleton ready: .gateforge/adapters, .gateforge/waivers, .gateforge/baselines');
  const alembicOptIn = renderAlembicOptIn(cwd);
  if (alembicOptIn !== null) writeLine(io.stdout, alembicOptIn);
  return 0;
}
