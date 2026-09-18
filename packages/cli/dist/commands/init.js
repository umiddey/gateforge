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
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { ClassificationPolicySchema, PolicyFileSchema, loadConfig, parseConfig, serializeBaseline, strictCapabilityGaps, } from '@gate-forge/core';
import { DEFAULT_PLANES_CONFIG, PLANES_CONFIG_PATH, createSqlalchemyDetector, parsePlanesConfigText, } from '@gate-forge/pack-sqlalchemy';
import { parseArgs } from '../args.js';
import { writeLine } from '../io.js';
import { UsageError } from '../errors.js';
import { expandIncludePaths } from '../glob.js';
import { inferPlanesConfig } from '../planes-inference.js';
import { installCommitHook, writeStandaloneGateScript } from '../git-hooks.js';
import { appendPreCommitHook, ensureHookScript, engineRootFromInvocation } from './blocking.js';
export const INIT_USAGE = 'usage: gateforge init [--languages <comma,list>] [--blocking] [--pre-commit] [--mode changed|staged] [--ci] [--no-ci] [--strict-e2e] [--planes]';
const BUNDLED_PLUGIN_MODULES = Object.freeze({
    'gateforge.pack-fastapi': '@gate-forge/pack-fastapi',
    'gateforge.pack-http': '@gate-forge/pack-http',
    'gateforge.pack-sqlalchemy': '@gate-forge/pack-sqlalchemy',
    'gateforge.pack-task': '@gate-forge/pack-task',
});
/**
 * Selects the bundled detectors required by the generated coverage and
 * trusted-entry-point rules for the requested source languages.
 *
 * Args:
 *   languages (readonly string[]): Languages selected by `gateforge init`.
 *
 * Returns:
 *   string[]: Deterministically ordered bundled detector ids.
 */
function bundledPluginIds(languages) {
    const normalized = new Set(languages.map((language) => language.toLowerCase()));
    const ids = ['gateforge.pack-task'];
    if (normalized.has('python')) {
        ids.unshift('gateforge.pack-sqlalchemy');
        ids.unshift('gateforge.pack-fastapi');
    }
    if (normalized.has('javascript') || normalized.has('typescript')) {
        ids.splice(ids.length - 1, 0, 'gateforge.pack-http');
    }
    return ids;
}
/** Renders the trusted bundled plugin entries for `.gateforge.yml`. */
function pluginsTemplate(languages) {
    return bundledPluginIds(languages)
        .map((id) => `  - id: ${id}\n    version: '0.1.0'\n    transport: in-process\n    module: '${BUNDLED_PLUGIN_MODULES[id]}'`)
        .join('\n');
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
function sourceIncludePatterns(languages) {
    const normalized = new Set(languages.map((language) => language.toLowerCase()));
    const patterns = [];
    if (normalized.has('python'))
        patterns.push('**/*.py');
    if (normalized.has('javascript') || normalized.has('typescript') || normalized.has('node')) {
        patterns.push('**/*.js', '**/*.jsx', '**/*.mjs', '**/*.cjs');
    }
    if (normalized.has('typescript'))
        patterns.push('**/*.ts', '**/*.tsx');
    return patterns.length > 0 ? patterns : ['**/*'];
}
/**
 * The starter policies document (plan phase 5): the gradable
 * `persistence:*` namespace for automatically classified resources.
 * UI-semantic `crud:*` stays opt-in and visibly fail-closed until a
 * trusted UI observer exists (ADR 0003 §3).
 */
/**
 * Opt-in transport-only endpoint policy (plan §8 / D1): proves only that
 * the witness observed a matching HTTP exchange in the bound run. Test
 * attribution is suite-claimed — it does not prove which browser, UI
 * action, or test produced the exchange. Selecting this document
 * changes the guarantee: it is a SEPARATE opt-in policy, never an
 * automatic migration of the default frontend requirement, baselines,
 * or waivers.
 */
export const TRANSPORT_ONLY_POLICY_EXAMPLE = `\
# Transport-only endpoint policy (plan §8 / D1, explicit opt-in).
# Each obligation proves only that the witness observed a matching HTTP
# exchange in the bound run ("witness observed an HTTP exchange");
# test attribution is suite-claimed ("suite-claimed"), never proven
# browser-issued by an independent channel. Selecting this policy narrows the
# guarantee relative to the default frontend requirement below.
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
# deliberately.
schemaVersion: 1
policies:
  - id: frontend-consumed-endpoints
    # ADR 0004 D8 + plan §8 / D1: only endpoints the frontend actually
    # consumes (static join) owe browser-exercise obligations;
    # server-only routes never do. NOTE: 'http:frontend-request-observed'
    # is BLOCKING with the current observer — no independent
    # browser/test observation channel exists yet, so the verifier
    # returns missing before examining evidence (test attribution is
    # suite-claimed). Keep this requirement to hold the frontend-proof
    # bar; or SEPARATELY opt in to the narrower transport-only policy
    # (TRANSPORT_ONLY_POLICY_EXAMPLE: 'http:request-observed', proving
    # only a witness-observed HTTP exchange) when that smaller guarantee
    # suffices. Never auto-migrate policies, baselines, or waivers.
    when:
      kind: http.endpoint
      consumed: true
    require:
      - http:frontend-request-observed
      - http:response-status-ok
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
 */
function classificationPolicyTemplate(languages) {
    const coverageRules = [];
    // Capabilities (red-team round 6): a rule grants a capability over its
    // files. Model/task discovery NEVER grants exposure, and no generated
    // rule declares `exhaustive: true` — today's detectors are heuristics,
    // so generated policies keep the internality certificate UNAVAILABLE
    // until the organization asserts an exhaustive exposure parser itself.
    if (languages.includes('typescript') || languages.includes('javascript') || languages.includes('node')) {
        coverageRules.push(`  - capability: exposure.http\n    detector: gateforge.pack-http\n    appliesTo:\n      - '**/*.ts'\n      - '**/*.js'\n      - '**/*.tsx'\n      - '**/*.jsx'\n      - '**/*.mjs'\n      - '**/*.cjs'`);
        coverageRules.push(`  - capability: linkage.task\n    detector: gateforge.pack-task\n    appliesTo:\n      - '**/*.ts'\n      - '**/*.js'\n      - '**/*.tsx'\n      - '**/*.jsx'\n      - '**/*.mjs'\n      - '**/*.cjs'`);
    }
    if (languages.includes('python')) {
        // Model discovery is NOT an exposure capability: python exposure stays
        // uncovered until an exhaustive python exposure detector exists.
        coverageRules.push(`  - capability: models.sqlalchemy\n    detector: gateforge.pack-sqlalchemy\n    appliesTo:\n      - '**/*.py'`);
    }
    const coverageBlock = coverageRules.length > 0 ? `coverage:\n${coverageRules.join('\n')}` : 'coverage: []';
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
  - category: worker
    patterns: ['**/workers/**', '**/jobs/**']
    # Reachability is only honored from this bundled detector (round 5).
    detector: gateforge.pack-task
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
/** Builds the `.gateforge.yml` document for the requested languages. */
function configTemplate(languages, options = {}) {
    const enforcementBlock = options.strictE2E === true
        ? `# Enforcement modes (plan §3.4/§3.3, ADR 0005): 'standard' = local hook +
# mandatory trusted server check (honest about --no-verify); 'managed' =
# additionally puts the authoritative commit service outside the agent's
# write/process boundary. strictE2E makes waived/baselined in-scope E2E
# obligations NOT proof (they block with ENFORCEMENT_UNTRUSTED).
enforcement:
  mode: standard
  strictE2E: true
`
        : '';
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
${pluginsTemplate(languages)}
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
${enforcementBlock}\
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
function preflightStrictSetup(policiesYaml) {
    const parsed = PolicyFileSchema.safeParse(parseYaml(policiesYaml));
    if (!parsed.success) {
        throw new UsageError(`policies document is invalid: ${(parsed.error.issues[0]?.message) ?? 'unknown issue'}`);
    }
    const required = [
        ...new Set(parsed.data.policies.flatMap((policy) => [...policy.require])),
    ].sort();
    const gaps = strictCapabilityGaps(required.map((contract) => ({ id: contract, contract })));
    if (gaps.length === 0)
        return;
    const lines = gaps.map((gap) => `  - contract '${gap.contract}': ${gap.detail} Required observer: ${gap.observer} ` +
        `Next action: ${gap.nextAction}`);
    throw new UsageError(`strict E2E setup is incomplete: ${String(gaps.length)} required contract(s) have no ` +
        'available proof channel, so this setup cannot advertise an operational blocking E2E ' +
        `gate (fail closed)\n${lines.join('\n')}`);
}
/**
 * The GitLab CI strict-gate template (plan 2026-09-13 Phase 6 items 1-2,
 * ADR 0005 D1/D2): the SERVER-side strict E2E gate — pinned engine, the
 * supervised `test-gates --changed` receipt seal, and the strict
 * `check --require-e2e` saved-state gate. No `allow_failure`, no manual
 * gate. The header comments carry the honest limits: the job alone is
 * not the enforcement boundary (required-pipeline + protected-branch +
 * pipeline-policy settings are the server-side act), signing material
 * never belongs in a candidate-controlled job, and a base change makes
 * the receipt stale.
 */
const GITLAB_CI_TEMPLATE = `# Generated by \`gateforge init --blocking\` (plan 2026-09-13 Phase 6,
# ADR 0005 D1/D2): the SERVER-side strict E2E gate — the same strict flow
# as the local pre-commit hook (\`gateforge check --staged --require-e2e\`),
# executed by CI against the checked-out candidate.
#
# Wire-up (idempotent; \`init\` also creates .gitlab-ci.yml with this
# include when absent):
#   # .gitlab-ci.yml
#   include:
#     - local: '.gateforge/ci/gitlab-gateforge.yml'
#
# WHAT THE JOB RUNS
#   1. \`npm ci\` — lockfile install. Keep gateforge as an EXACT
#      devDependency (\`npm install --save-exact -D gateforge\`) so this
#      lockfile pins the engine; the version assertion below fails the
#      job if the installed engine drifts from the pin.
#   2. \`gateforge test-gates --changed\` — trusted runner supervision:
#      resolves the test catalog + mappings, fixes the expected test set
#      BEFORE the run, executes the configured Playwright suite through
#      the adapter, enforces planned-vs-executed completeness (zero
#      selected tests, skips, .only, retries, teardown failures, and
#      incomplete shards all fail), and seals an AUTHENTICATED gate
#      receipt bound to THIS candidate's input digest.
#   3. \`gateforge check --changed --require-e2e\` — the strict
#      saved-state gate: a missing receipt (RUN_INCOMPLETE), a receipt
#      for different bytes (EVIDENCE_STALE), or a forged/tampered one
#      (ENFORCEMENT_UNTRUSTED) blocks. An old green report authorizes
#      nothing.
#
# HONEST LIMITS — THIS JOB ALONE IS NOT THE ENFORCEMENT BOUNDARY
#   A candidate-controlled CI job cannot protect itself. The gate holds
#   only when these server-side settings are in place (owner action in
#   the GitLab UI; do NOT grant the agent role access to change them):
#     - Settings > Merge requests > Merge checks: enable the
#       "Pipelines must succeed" merge check; a skipped pipeline is not
#       a successful pipeline (enable the skipped-pipelines-block
#       option where your GitLab version offers it).
#       https://docs.gitlab.com/user/project/merge_requests/auto_merge/
#     - Settings > Repository > Protected branches: protect the target
#       branch and set "Allowed to push and merge" so the agent role
#       cannot push directly (direct pushes bypass MR pipelines).
#       https://docs.gitlab.com/user/project/repository/branches/protected/
#     - Enforce this job independently of candidate CI edits via an
#       organization-controlled pipeline execution policy (or a trusted
#       merge service): a policy-injected job cannot be deleted by
#       editing .gitlab-ci.yml, so a candidate cannot merge on a green
#       pipeline that lacks the gate.
#       https://docs.gitlab.com/user/application_security/policies/pipeline-execution-policies/
#
# SIGNING MATERIAL BOUNDARY (ADR 0005 D1/D2)
#   GATEFORGE_WITNESS_VERIFIER_KEY is the receipt signing/MAC authority.
#   It must NEVER be readable by a candidate-controlled job: an agent
#   that can read or set it could mint receipts for arbitrary bytes.
#   Keep it as a PROTECTED, masked variable reachable only by the
#   policy-owned gate job on PROTECTED runners — or, for managed-mode
#   enforcement, run receipt issuance in a trusted gate service entirely
#   outside the agent's write/process boundary. The engine fails closed
#   without trusted material: \`test-gates --changed\` refuses to seal a
#   receipt and \`check --require-e2e\` blocks — it never downgrades to a
#   weaker pass.
#
# APPROVED POLICY PIN (enforcement review item 3 / E17)
#   GATEFORGE_APPROVED_POLICY_DIGEST is the owner-approved trusted
#   policy revision (hash of .gateforge.yml, policies, classification
#   policy, the sidecar test-map.yml, adapters, waivers, and local
#   plugin modules). The strict gate refuses to run without it
#   (provision the pin), and a candidate that edits any of those
#   documents fails before any test runs (ENFORCEMENT_UNTRUSTED) — a
#   candidate cannot weaken its own required checks and self-approve.
#   Provision it EXACTLY like the verifier key: a PROTECTED variable the
#   candidate cannot read or set, recomputed by the owner whenever a
#   trusted policy revision is intentionally accepted (\`gateforge
#   enforcement doctor\` reports the current candidate digest), never by
#   the agent.
#
# RESTART ON BASE CHANGE
#   A receipt binds the exact tested inputs, including the merge
#   result's base. When the target branch advances, the old receipt is
#   stale (EVIDENCE_STALE) and cannot authorize the merge: enable
#   merged-results pipelines (merge trains re-run on target-branch
#   changes) so this job re-runs for the new merge result.
#   https://docs.gitlab.com/ci/pipelines/merged_results_pipelines/
gateforge:e2e-gate:
  stage: test
  image: node:22
  variables:
    # Exact engine pin: no ^, no ~, no 'latest'. Must equal the
    # gateforge version resolved by the lockfile (\`npm ci\` below).
    GATEFORGE_VERSION: "0.1.0"
  script:
    - npm ci
    - echo "gateforge engine $(node_modules/.bin/gateforge --version) (pinned \${GATEFORGE_VERSION})"
    - |
      [ "$(node_modules/.bin/gateforge --version)" = "$GATEFORGE_VERSION" ] ||
        { echo "FATAL: gateforge engine is not the pinned \${GATEFORGE_VERSION}; fix the lockfile/pin" >&2; exit 1; }
    # Supervised E2E run: seals the authenticated receipt for THIS
    # candidate (skips/retries/incomplete runs never produce one).
    - node_modules/.bin/gateforge test-gates --changed
    # Strict saved-state gate (same gate as the local hook's
    # \`check --staged --require-e2e\`).
    - node_modules/.bin/gateforge check --changed --require-e2e
  rules:
    # Merge requests only. Deliberately NO \`when: manual\`, NO
    # \`allow_failure\`, and no pipeline path that can go green without
    # this job: a failed or skipped gate must block the merge.
    - if: $CI_PIPELINE_SOURCE == "merge_request_event"
  artifacts:
    # Audit trail: the run report and the authenticated gate receipt.
    # The REST of the run-state directory is deliberately not uploaded
    # (env.json carries the per-run GATEFORGE_RUN_TOKEN; records.json is
    # bulky); run state also never enters the tracked input snapshot.
    when: always
    paths:
      - .gateforge/test-gates/report.json
      - .gateforge/test-gates/receipt.json
    expire_in: 1 week
`;
/** Writes the GitLab CI job template + include wiring (idempotent). */
function writeGitlabCiTemplate(io) {
    const dir = join(io.cwd, '.gateforge', 'ci');
    mkdirSync(dir, { recursive: true });
    const path = join(dir, 'gitlab-gateforge.yml');
    if (!existsSync(path)) {
        writeFileSync(path, GITLAB_CI_TEMPLATE);
        writeLine(io.stdout, `created: ${path}`);
    }
    else {
        writeLine(io.stdout, `exists, leaving untouched: ${path}`);
    }
    const gitlabCi = '.gitlab-ci.yml';
    const local = "  - local: '.gateforge/ci/gitlab-gateforge.yml'";
    if (!existsSync(gitlabCi)) {
        writeFileSync(gitlabCi, `include:\n${local}\n`);
        writeLine(io.stdout, `created: ${gitlabCi} (includes the gateforge jobs)`);
        return;
    }
    const current = readFileSync(gitlabCi, 'utf8');
    if (current.includes('gitlab-gateforge.yml')) {
        writeLine(io.stdout, `exists, leaving untouched: ${gitlabCi} (gateforge include present)`);
        return;
    }
    if (/^include:/m.test(current)) {
        // Append the local entry under the existing include: key (block style).
        writeFileSync(gitlabCi, current.replace(/^include:[^\n]*/m, (match) => `${match}\n${local}`));
        writeLine(io.stdout, `updated: ${gitlabCi} (gateforge include added under existing include)`);
        return;
    }
    writeFileSync(gitlabCi, `${current.endsWith('\n') ? current : current + '\n'}include:\n${local}\n`);
    writeLine(io.stdout, `updated: ${gitlabCi} (include appended)`);
}
/**
 * Asks (TTY only) whether gateforge should be a blocking gate. Flags win:
 * --blocking forces yes, --no-blocking forces no, and non-interactive
 * runs default to no so tests and CI never hang on a prompt.
 */
async function resolveBlocking(io, options) {
    if (options['blocking'] === true)
        return true;
    if (options['no-blocking'] === true)
        return false;
    if (!process.stdin.isTTY) {
        writeLine(io.stdout, 'tip: gateforge init --blocking wires a pre-commit + CI blocking gate (idempotent)');
        return false;
    }
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
        const answer = (await rl.question('Enforce gateforge as a blocking gate (pre-commit + CI wiring)? [y/N] ')).trim().toLowerCase();
        return answer === 'y' || answer === 'yes';
    }
    finally {
        rl.close();
    }
}
/**
 * Asks (TTY only) whether init should propose `.gateforge/planes.json`
 * from the discovered model directories. Flags win: --planes forces
 * yes, --no-planes forces no, non-interactive runs default to no (the
 * same contract as {@link resolveBlocking}).
 */
async function resolvePlanes(io, options) {
    if (options['planes'] === true)
        return true;
    if (options['no-planes'] === true)
        return false;
    if (!process.stdin.isTTY) {
        writeLine(io.stdout, 'tip: gateforge init --planes proposes .gateforge/planes.json from discovered model directories (review before the next run)');
        return false;
    }
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
        const answer = (await rl.question('Propose .gateforge/planes.json from discovered model directories (review before the next run)? [y/N] '))
            .trim()
            .toLowerCase();
        return answer === 'y' || answer === 'yes';
    }
    finally {
        rl.close();
    }
}
/**
 * Runs discovery over the repo's own include/exclude config, infers a
 * planes proposal from the discovered table directories, self-checks
 * the draft against the runtime's strict parser, and writes
 * `.gateforge/planes.json` — only when absent (never overwrites a
 * reviewed document). Inference failure is surfaced as a visible
 * warning, never silently skipped, but does not abort the scaffold.
 */
async function proposePlanesConfig(cwd, io) {
    const planesPath = join(cwd, PLANES_CONFIG_PATH);
    if (existsSync(planesPath)) {
        writeLine(io.stdout, `exists, leaving untouched: ${planesPath}`);
        return;
    }
    let tableSources;
    try {
        const config = loadConfig(join(cwd, '.gateforge.yml'));
        const expandErrors = [];
        const paths = expandIncludePaths(config.project.paths.include, config.project.paths.exclude, cwd, expandErrors);
        // The planes config plays no role in inference (only table SOURCE
        // paths matter), so the detector runs with the default no-mapping
        // rule — immune to whatever a previous run wrote.
        const outcome = await createSqlalchemyDetector({ planesConfig: DEFAULT_PLANES_CONFIG }).discover(paths);
        tableSources = outcome.resources
            .filter((resource) => resource.kind === 'sqlalchemy.table' &&
            typeof resource.source === 'string')
            .map((resource) => resource.source);
    }
    catch (cause) {
        writeLine(io.stdout, `warning: plane inference failed (${cause instanceof Error ? cause.message : String(cause)}); ` +
            'add .gateforge/planes.json manually — init continues');
        return;
    }
    const inference = inferPlanesConfig(tableSources);
    if (inference.skippedTestTables > 0) {
        writeLine(io.stdout, `note: ${inference.skippedTestTables} table(s) under test directories were excluded from plane inference (fixtures are not business surface)`);
    }
    if (inference.config === null) {
        writeLine(io.stdout, `tip: ${inference.note ?? 'nothing to propose'}`);
        return;
    }
    const serialized = `${JSON.stringify(inference.config, null, 2)}\n`;
    // Self-check the draft against the runtime's strict reader contract
    // BEFORE writing (a broken proposal must fail here, not at the next run).
    parsePlanesConfigText(serialized, planesPath);
    writeFileSync(planesPath, serialized, 'utf8');
    writeLine(io.stdout, `created: ${planesPath} (${inference.config.rules.length} rule(s) inferred from model directories — review the reasons before the next gateforge run)`);
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
export async function initCommand(io, argv) {
    const { options } = parseArgs(argv);
    if (options['help'] === true) {
        writeLine(io.stdout, INIT_USAGE);
        return 0;
    }
    const languagesValue = options['languages'];
    if (typeof languagesValue === 'boolean' || Array.isArray(languagesValue)) {
        throw new UsageError(`flag '--languages' may only be given once`);
    }
    const languages = (languagesValue ?? 'python')
        .split(',')
        .map((language) => language.trim().toLowerCase())
        .filter((language) => language.length > 0);
    if (languages.length === 0) {
        throw new UsageError(`flag '--languages' requires at least one language`);
    }
    const strictE2E = options['strict-e2e'] === true;
    if (typeof options['strict-e2e'] !== 'boolean' && options['strict-e2e'] !== undefined) {
        throw new UsageError(`flag '--strict-e2e' must be a boolean flag`);
    }
    // Strict-setup preflight (plan Phase 0 item 4): BEFORE anything is
    // written — a strict setup demanding an unavailable proof channel (the
    // starter policies require browser observation no pack provides yet)
    // stays visibly incomplete instead of shipping a false green.
    if (strictE2E) {
        preflightStrictSetup(POLICIES_TEMPLATE);
    }
    const cwd = io.cwd;
    const gateforgeDir = join(cwd, '.gateforge');
    const targets = [
        {
            path: join(cwd, '.gateforge.yml'),
            label: 'config',
            write: () => {
                // Self-check the template against the pinned schema before
                // writing anything (a broken template must fail here, not in
                // every later command).
                parseConfig(parseYaml(configTemplate(languages, { strictE2E })), { file: '.gateforge.yml' });
                writeFileSync(join(cwd, '.gateforge.yml'), configTemplate(languages, { strictE2E }), 'utf8');
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
                const policyText = classificationPolicyTemplate(languages);
                // Self-check against the pinned policy schema (same contract as
                // the config template).
                ClassificationPolicySchema.parse(parseYaml(policyText));
                writeFileSync(join(gateforgeDir, 'classification-policy.yml'), policyText, 'utf8');
            },
        },
        {
            path: join(gateforgeDir, 'baselines', 'obligations.json'),
            label: 'baseline (empty)',
            write: () => writeFileSync(join(gateforgeDir, 'baselines', 'obligations.json'), serializeBaseline({ schemaVersion: 1, fingerprints: [] }), 'utf8'),
        },
    ];
    mkdirSync(join(gateforgeDir, 'adapters'), { recursive: true });
    mkdirSync(join(gateforgeDir, 'waivers'), { recursive: true });
    mkdirSync(join(gateforgeDir, 'baselines'), { recursive: true });
    for (const target of targets) {
        if (existsSync(target.path)) {
            writeLine(io.stdout, `exists, leaving untouched: ${target.path}`);
            continue;
        }
        target.write();
        writeLine(io.stdout, `created: ${target.path}`);
    }
    // Plane-config proposal (flags win; TTY prompt fills the gap;
    // non-interactive defaults to scaffold-only, like every granular step):
    //   --planes / --no-planes
    //       propose .gateforge/planes.json from the model directories the
    //       discovered tables live in — a review artifact with a reason on
    //       every rule, written only when absent, never silently applied
    //       (the next run reads it and the user reviews first).
    if (languages.includes('python')) {
        if (await resolvePlanes(io, options)) {
            await proposePlanesConfig(cwd, io);
        }
    }
    // Enforcement wiring is granular (flags win; TTY prompts fill the gaps;
    // non-interactive runs default to scaffold-only so tests and CI never
    // hang on a prompt):
    //   --pre-commit        wire the pre-commit gate hook
    //   --mode changed|staged
    //                       changed = debt-friendly `check --changed`;
    //                       staged  = strict `check --staged --require-e2e`
    //                       (+ the standalone staged-gate script)
    //   --ci / --no-ci      wire the .gitlab-ci.yml include + job template
    //   --blocking          legacy all-in: pre-commit (staged) + CI
    const modeValue = options['mode'];
    if (modeValue !== undefined) {
        if (typeof modeValue !== 'string' || (modeValue !== 'changed' && modeValue !== 'staged')) {
            throw new UsageError(`flag '--mode' must be 'changed' or 'staged'`);
        }
    }
    const blocking = await resolveBlocking(io, options);
    const preCommit = options['pre-commit'] === true || blocking;
    const ci = options['ci'] === true || blocking;
    const mode = typeof modeValue === 'string'
        ? modeValue
        : blocking
            ? 'staged'
            : 'changed';
    if (preCommit) {
        const hookDir = join(gateforgeDir, 'hooks');
        mkdirSync(hookDir, { recursive: true });
        // One generated hook across all wiring commands: the resolution order
        // is shared; only the gate invocation differs, recorded at generation
        // time by the wiring command's mode.
        const gateArgs = mode === 'staged' ? ['check', '--staged', '--require-e2e'] : ['check', '--changed'];
        ensureHookScript(io, engineRootFromInvocation(), gateArgs);
        // The ACTIVE hook (plan Phase 5 item 1): install into the resolved
        // hooks directory AND verify activation — never merely write a
        // config file.
        if (mode === 'staged') {
            const gateScript = writeStandaloneGateScript(cwd);
            writeLine(io.stdout, `created: ${gateScript} (standalone staged gate: check --staged --require-e2e)`);
        }
        const outcome = installCommitHook(cwd, io.env);
        // A pre-commit-FRAMEWORK-managed .git hook is not a conflict: the
        // framework regenerates that file from .pre-commit-config.yaml on every
        // install, so chaining into it would be silently wiped. Gateforge
        // integrates through the framework config instead (appendPreCommitHook
        // below) — the hook block runs on every commit like any other.
        const frameworkManaged = outcome.status === 'framework';
        switch (outcome.status) {
            case 'installed':
                writeLine(io.stdout, `installed: ${outcome.detail}`);
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
                throw new UsageError(`init --blocking: hook installation incomplete — ${outcome.detail}\nRequired action:\n${outcome.action}`);
        }
        appendPreCommitHook(io);
        writeGitlabCiTemplate(io);
        writeLine(io.stdout, frameworkManaged
            ? `blocking gate wired through the pre-commit framework (gateforge-check in .pre-commit-config.yaml, ${gateArgs.join(' ')}) + .gitlab-ci.yml include. ` +
                'Honest limit: `git commit --no-verify` bypasses the local hook (ADR 0005 D1) — standard enforcement also requires the trusted server check.'
            : `blocking gate wired: active pre-commit hook (${gateArgs.join(' ')}) + .gitlab-ci.yml include. ` +
                'Honest limit: `git commit --no-verify` bypasses the local hook (ADR 0005 D1) — standard enforcement also requires the trusted server check.');
    }
    writeLine(io.stdout, 'skeleton ready: .gateforge/adapters, .gateforge/waivers, .gateforge/baselines');
    return 0;
}
//# sourceMappingURL=init.js.map