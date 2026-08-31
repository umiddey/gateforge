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
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { parseConfig, serializeBaseline } from '@gateforge/core';
import { parseArgs } from '../args.js';
import { writeLine } from '../io.js';
import { UsageError } from '../errors.js';
export const INIT_USAGE = 'usage: gateforge init [--languages <comma,list>]';
/** The starter policies document (one user-facing CRUD policy). */
const POLICIES_TEMPLATE = `\
# Declarative policies: when a resource matches, the required contracts
# become obligations. Lifecycle-gated crud:* contracts are emitted only
# for the lifecycle operations the classification enables.
schemaVersion: 1
policies:
  - id: user-facing-crud
    when:
      exposure: user-facing
    require:
      - crud:create
      - crud:read
      - crud:update
      - crud:delete
`;
/** The empty classifications document (user fills it in). */
const CLASSIFICATIONS_TEMPLATE = `\
# Classify discovered resources here. Keys are resource names (or
# plane-qualified ids). User-facing entries require exposure, plane,
# lifecycle, primaryKey, and an evidenceAdapter.
schemaVersion: 1
resources: {}
`;
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
      - '**/*'
    exclude:
      - '**/node_modules/**'
# Detector plugins. Subprocess plugins spawn a GPP/2 session; in-process
# plugins default-export { discover(paths) }.
plugins: []
policies: .gateforge/policies.yml
classifications: .gateforge/classifications.yml
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
export function initCommand(io, argv) {
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
            path: join(gateforgeDir, 'classifications.yml'),
            label: 'classifications document',
            write: () => writeFileSync(join(gateforgeDir, 'classifications.yml'), CLASSIFICATIONS_TEMPLATE, 'utf8'),
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
    writeLine(io.stdout, 'skeleton ready: .gateforge/adapters, .gateforge/waivers, .gateforge/baselines');
    return 0;
}
//# sourceMappingURL=init.js.map