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
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import {
  ClassificationPolicySchema,
  parseConfig,
  serializeBaseline,
} from '@gateforge/core';
import { parseArgs } from '../args.js';
import type { Io } from '../io.js';
import { writeLine } from '../io.js';
import { UsageError } from '../errors.js';

export const INIT_USAGE = 'usage: gateforge init [--languages <comma,list>]';

/**
 * The starter policies document (plan phase 5): the gradable
 * `persistence:*` namespace for automatically classified resources.
 * UI-semantic `crud:*` stays opt-in and visibly fail-closed until a
 * trusted UI observer exists (ADR 0003 §3).
 */
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
    # ADR 0004 D8: only endpoints the frontend actually consumes (static
    # join) owe browser-exercise obligations; server-only routes never do.
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
function classificationPolicyTemplate(languages: readonly string[]): string {
  const coverageRules: string[] = [];
  // Capabilities (red-team round 6): a rule grants a capability over its
  // files. Model/task discovery NEVER grants exposure, and no generated
  // rule declares `exhaustive: true` — today's detectors are heuristics,
  // so generated policies keep the internality certificate UNAVAILABLE
  // until the organization asserts an exhaustive exposure parser itself.
  if (languages.includes('typescript') || languages.includes('javascript')) {
    coverageRules.push(
      `  - capability: exposure.http\n    detector: gateforge.pack-http\n    appliesTo:\n      - '**/*.ts'\n      - '**/*.js'\n      - '**/*.tsx'\n      - '**/*.jsx'`,
    );
    coverageRules.push(
      `  - capability: linkage.task\n    detector: gateforge.pack-task\n    appliesTo:\n      - '**/*.ts'\n      - '**/*.js'\n      - '**/*.tsx'\n      - '**/*.jsx'`,
    );
  }
  if (languages.includes('python')) {
    // Model discovery is NOT an exposure capability: python exposure stays
    // uncovered until an exhaustive python exposure detector exists.
    coverageRules.push(
      `  - capability: models.sqlalchemy\n    detector: gateforge.pack-sqlalchemy\n    appliesTo:\n      - '**/*.py'`,
    );
  }
  const coverageBlock =
    coverageRules.length > 0 ? `coverage:\n${coverageRules.join('\n')}` : 'coverage: []';

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
function configTemplate(languages: readonly string[]): string {
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
      - '**/*'
    exclude:
      - '**/node_modules/**'
# Detector plugins. Subprocess plugins spawn a GPP/3 session; in-process
# plugins default-export { discover(paths) }.
plugins: []
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
export function initCommand(io: Io, argv: readonly string[]): number {
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
    .map((language) => language.trim())
    .filter((language) => language.length > 0);
  if (languages.length === 0) {
    throw new UsageError(`flag '--languages' requires at least one language`);
  }

  const cwd = io.cwd;
  const gateforgeDir = join(cwd, '.gateforge');
  const targets: Array<{ path: string; write: () => void; label: string }> = [
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
  writeLine(io.stdout, 'skeleton ready: .gateforge/adapters, .gateforge/waivers, .gateforge/baselines');
  return 0;
}
