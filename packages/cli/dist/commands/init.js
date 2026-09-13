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
import { ClassificationPolicySchema, parseConfig, serializeBaseline, } from '@gateforge/core';
import { parseArgs } from '../args.js';
import { writeLine } from '../io.js';
import { UsageError } from '../errors.js';
export const INIT_USAGE = 'usage: gateforge init [--languages <comma,list>] [--blocking]';
const BUNDLED_PLUGIN_MODULES = Object.freeze({
    'gateforge.pack-fastapi': '@gateforge/pack-fastapi',
    'gateforge.pack-http': '@gateforge/pack-http',
    'gateforge.pack-sqlalchemy': '@gateforge/pack-sqlalchemy',
    'gateforge.pack-task': '@gateforge/pack-task',
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
function configTemplate(languages) {
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
`;
}
const HOOK_SCRIPT_TEMPLATE = `#!/bin/sh
# Generated by \`gateforge init --blocking\`: fail the commit when the
# static gate reports unresolved findings or unwaived obligations.
set -e
if command -v gateforge >/dev/null 2>&1; then
  exec gateforge check --changed
fi
if [ -n "$GATEFORGE_CLI" ]; then
  exec node "$GATEFORGE_CLI" check --changed
fi
echo "gateforge: CLI not found (install gateforge or set GATEFORGE_CLI)" >&2
exit 1
`;
const PRE_COMMIT_BLOCK = `# --- gateforge (generated): blocking static gate ---------------------
 - repo: local
   hooks:
     - id: gateforge-check
       name: gateforge — unresolved findings / unwaived obligations
       entry: .gateforge/hooks/gateforge-check.sh
       language: system
       pass_filenames: false
`;
const GITLAB_CI_TEMPLATE = `# Generated by \`gateforge init --blocking\`. Edit the install steps to
# match how this repo installs gateforge, then include from .gitlab-ci.yml:
#   include:
#     - local: '.gateforge/ci/gitlab-gateforge.yml'
gateforge:check:
  stage: test
  image: node:22
  script:
    - npm install                       # replace with your engine install step
    - node packages/cli/bin/gateforge.js check --changed
  rules:
    - if: $CI_PIPELINE_SOURCE == "merge_request_event"
# The witnessed browser suite is repo-specific (dev stack + fixtures).
# Recommended: run your witnessed-gate script here on merge requests and
# fail when report.json summary.satisfied regresses.
`;
/** Appends the gateforge-check hook to .pre-commit-config.yaml (idempotent). */
function appendPreCommitHook(io) {
    const path = '.pre-commit-config.yaml';
    if (existsSync(path)) {
        const current = readFileSync(path, 'utf8');
        if (current.includes('gateforge-check')) {
            writeLine(io.stdout, `exists, leaving untouched: ${path} (gateforge-check)`);
            return;
        }
        writeFileSync(path, `${current.endsWith('\n') ? current : current + '\n'}${PRE_COMMIT_BLOCK}`);
        writeLine(io.stdout, `updated: ${path} (gateforge-check hook appended)`);
        return;
    }
    writeFileSync(path, `repos:\n${PRE_COMMIT_BLOCK}`);
    writeLine(io.stdout, `created: ${path} (with gateforge-check hook)`);
}
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
    if (!existsSync(gitlabCi)) {
        writeFileSync(gitlabCi, `include:\n  - local: '.gateforge/ci/gitlab-gateforge.yml'\n`);
        writeLine(io.stdout, `created: ${gitlabCi} (includes the gateforge jobs)`);
    }
    else if (!readFileSync(gitlabCi, 'utf8').includes('gitlab-gateforge.yml')) {
        writeLine(io.stdout, `action needed: add "include: - local: '.gateforge/ci/gitlab-gateforge.yml'" to ${gitlabCi} (file left untouched)`);
    }
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
                parseConfig(parseYaml(configTemplate(languages)), { file: '.gateforge.yml' });
                writeFileSync(join(cwd, '.gateforge.yml'), configTemplate(languages), 'utf8');
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
    const blocking = await resolveBlocking(io, options);
    if (blocking) {
        const hookDir = join(gateforgeDir, 'hooks');
        mkdirSync(hookDir, { recursive: true });
        const hookScript = join(hookDir, 'gateforge-check.sh');
        if (!existsSync(hookScript)) {
            writeFileSync(hookScript, HOOK_SCRIPT_TEMPLATE);
            chmodSync(hookScript, 0o755);
            writeLine(io.stdout, `created: ${hookScript}`);
        }
        else {
            writeLine(io.stdout, `exists, leaving untouched: ${hookScript}`);
        }
        appendPreCommitHook(io);
        writeGitlabCiTemplate(io);
        writeLine(io.stdout, 'blocking gate wired: pre-commit (gateforge check --changed) + .gitlab-ci.yml include');
    }
    writeLine(io.stdout, 'skeleton ready: .gateforge/adapters, .gateforge/waivers, .gateforge/baselines');
    return 0;
}
//# sourceMappingURL=init.js.map