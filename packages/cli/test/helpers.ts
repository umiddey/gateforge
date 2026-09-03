/**
 * Shared CLI-test fixtures: temp repos preloaded with a working
 * `.gateforge` project (in-process fixture plugin + policies +
 * classifications), the run helper, and the python reference detector
 * path for real GPP/3 round-trips.
 */
import { fileURLToPath } from 'node:url';
import { fingerprint, withTempRepo, type TempRepo } from '@gateforge/core';
import { main, CaptureStream, type Io } from '../src/index.js';

/** The fixed clock all fixture configs use (deterministic verdicts). */
export const FIXED_AT = '2026-01-01T00:00:00.000Z';

/** Policy id the fixture policies document declares. */
export const POLICY_ID = 'user-facing-crud';

/** Lifecycle the fixture classification resolves to: every operation
 * conservatively enabled (plugin signals cannot disable — suppression is
 * engine-issued), with delete semantics proven `hard` by declaration. */
export const LIFECYCLE = {
  create: true,
  read: true,
  update: true,
  delete: true,
  deleteSemantics: 'hard',
} as const;

/** Built-in test obligations of the standard fixture. */
export const OBLIGATION_ACCOUNTS = 'tenant.accounts:persistence:read';
export const OBLIGATION_ORDERS = 'tenant.orders:persistence:read';

/** Pin-#2 fingerprint for one fixture obligation. */
export function fixtureFingerprint(resourceId: string): string {
  return fingerprint({
    resourceId,
    contract: 'persistence:read',
    policyId: POLICY_ID,
    lifecycle: LIFECYCLE,
  });
}

/** In-process fixture plugin: one resource per non-comment line.
 *
 * Trust note (ADR 0003 D6): every signal carries the plugin's OWN pinned
 * identity. Suppressive authority (`gateforge.core@1`) is engine-issued
 * and rejected at the plugin boundary — a fixture, like any plugin, can
 * only contribute code-derived facts, so lifecycle operations resolve to
 * the conservative enabled defaults and `delete-semantics: hard` (which
 * is not suppressive) keeps delete semantics resolved.
 */
export const PLUGIN_SOURCE = `import { readFileSync } from 'node:fs';
export default {
  discover(paths) {
    const resources = [];
    const classificationSignals = [];
    const scannedPaths = [];
    for (const rel of paths) {
      const text = readFileSync(rel, 'utf8');
      scannedPaths.push(rel);
      for (const line of text.split('\\n')) {
        const trimmed = line.trim();
        if (trimmed === '' || trimmed.startsWith('#')) continue;
        const [name, kind] = trimmed.split(/\\s+/);
        if (!name) continue;
        const location = { file: rel, line: 1, col: 0 };
        resources.push({
          schemaVersion: 1,
          id: 'raw.' + name,
          kind: kind || 'fixture.resource',
          source: rel,
          location,
          detectorVersion: '1.0.0',
          attributes: { resourceName: name },
        });
        const signal = (dimension, assertion, basis = 'code-positive') =>
          classificationSignals.push({
            schemaVersion: 1,
            target: { resourceName: name },
            dimension,
            assertion,
            basis,
            source: 'fixture.plugin',
            location,
            detector: { id: 'fixture.plugin', version: '1.0.0' },
          });
        signal('plane', 'tenant');
        signal('identity', ['id']);
        signal('lifecycle.read', true);
        signal('delete-semantics', 'hard');
        signal('adapter-binding', name);
      }
    }
    return { resources, unresolved: [], findings: [], classificationSignals, scannedPaths };
  },
};
`;


/** Policies document: one user-facing persistence:read policy. */
export const POLICIES_YML = `\
schemaVersion: 1
policies:
  - id: ${POLICY_ID}
    when:
      exposure: user-facing
    require:
      - persistence:read
`;

/** Classification policy for the fixture's complete source scan. */
export const CLASSIFICATION_POLICY_YML = `\
schemaVersion: 1
scanRoots: ['src/**/*.txt']
trustedInternalEntryPoints: []
internalRules: []
declarations:
  internality: gateforge:internal
volatileFields: []
`;

/**
 * Legacy helper for tests that exercise stale manual references.
 */
export function classificationsYml(resources: readonly string[]): string {
  const entries = resources
    .map(
      (name) => `  ${name}:
    exposure: user-facing
    plane: tenant
    lifecycle: { create: false, read: true, update: false, delete: false }
    primaryKey: [id]
    evidenceAdapter: ${name}
`,
    )
    .join('');
  return `schemaVersion: 1
resources:
${entries}`;
}

/** The standard fixture resource files (one resource per file). */
export const RESOURCE_FILES: Record<string, string> = {
  'src/accounts.txt': 'accounts fixture.table\n',
  'src/orders.txt': 'orders fixture.table\n',
};

/** Builds the fixture `.gateforge.yml` (in-process plugin, fixed clock). */
export function configYml(options: {
  include?: string;
  plugins?: string;
  provider?: string;
  clockMode?: 'fixed' | 'system';
} = {}): string {
  const include = options.include ?? "['src/**/*.txt']";
  const plugins =
    options.plugins ??
    `  - id: fixture.plugin
    version: '1.0.0'
    transport: in-process
    module: ./plugin.mjs`;
  const fixedAt = options.clockMode === 'system' ? '' : `  fixedAt: '${FIXED_AT}'\n`;
  const clockBlock =
    options.clockMode === 'system' ? '  mode: system\n' : `  mode: fixed\n${fixedAt}`;
  return `\
schemaVersion: 1
project:
  languages: [python]
  paths:
    include: ${include}
    exclude: []
plugins:
${plugins}
policies: .gateforge/policies.yml
classificationPolicy: .gateforge/classification-policy.yml
adapters: .gateforge/adapters
waivers: .gateforge/waivers
baselines: .gateforge/baselines/obligations.json
changed:
  provider: ${options.provider ?? 'auto'}
witness:
  maxDurationSeconds: 5
clock:
${clockBlock}
`;
}

/** Installs the standard automatic-classification fixture project. */
export function installFixture(repo: TempRepo, options: Parameters<typeof configYml>[0] = {}): void {
  repo.writeFiles({
    '.gateforge.yml': configYml(options),
    '.gateforge/policies.yml': POLICIES_YML,
    '.gateforge/classification-policy.yml': CLASSIFICATION_POLICY_YML,
    'plugin.mjs': PLUGIN_SOURCE,
    '.gateforge/adapters/accounts.mjs': 'export default {};\n',
    '.gateforge/adapters/orders.mjs': 'export default {};\n',
    ...RESOURCE_FILES,
  });
}

/** Runs the CLI main in-process against a repo with captured output. */
export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

export async function runCli(
  repo: TempRepo,
  argv: readonly string[],
  env: Record<string, string | undefined> = {},
): Promise<CliResult> {
  const stdout = new CaptureStream();
  const stderr = new CaptureStream();
  const io: Io = { cwd: repo.root, env: { ...process.env, ...env }, stdout, stderr };
  // In-process plugins resolve repo-relative paths against the process
  // cwd (production cwd IS the repo root); mirror that for the call.
  const previousCwd = process.cwd();
  if (previousCwd !== io.cwd) process.chdir(io.cwd);
  try {
    const code = await main(argv, io);
    return { code, stdout: stdout.text(), stderr: stderr.text() };
  } finally {
    if (previousCwd !== io.cwd) process.chdir(previousCwd);
  }
}

/** Absolute path of the python reference detector (GPP/3 round-trips). */
export function referenceDetectorPath(): string {
  return fileURLToPath(
    new URL('../../plugin-protocol/python/plugins/reference_detector.py', import.meta.url),
  );
}

/** YAML plugins block driving the python reference detector. */
export function pythonPluginBlock(): string {
  const detector = referenceDetectorPath();
  return `  - id: python-fixture-detector
    version: '1.0.0'
    transport: subprocess
    command: ['python3', ${JSON.stringify(detector)}, '.']
`;
}

export { withTempRepo };