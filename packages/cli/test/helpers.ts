/**
 * Shared CLI-test fixtures: temp repos preloaded with a working
 * `.gateforge` project (in-process fixture plugin + policies +
 * classifications), the run helper, and the python reference detector
 * path for real GPP/2 round-trips.
 */
import { fileURLToPath } from 'node:url';
import { fingerprint, withTempRepo, type TempRepo } from '@gateforge/core';
import { main, CaptureStream, type Io } from '../src/index.js';

/** The fixed clock all fixture configs use (deterministic verdicts). */
export const FIXED_AT = '2026-01-01T00:00:00.000Z';

/** Policy id the fixture policies document declares. */
export const POLICY_ID = 'user-facing-crud';

/** Lifecycle the fixture classifications declare for both resources. */
export const LIFECYCLE = { create: false, read: true, update: false, delete: false };

/** Built-in test obligations of the standard fixture. */
export const OBLIGATION_ACCOUNTS = 'tenant.accounts:crud:read';
export const OBLIGATION_ORDERS = 'tenant.orders:crud:read';

/** Pin-#2 fingerprint for one fixture obligation. */
export function fixtureFingerprint(resourceId: string): string {
  return fingerprint({
    resourceId,
    contract: 'crud:read',
    policyId: POLICY_ID,
    lifecycle: LIFECYCLE,
  });
}

/** In-process fixture plugin: one resource per non-comment line. */
export const PLUGIN_SOURCE = `import { readFileSync } from 'node:fs';
export default {
  discover(paths) {
    const resources = [];
    for (const rel of paths) {
      const text = readFileSync(rel, 'utf8');
      for (const line of text.split('\\n')) {
        const trimmed = line.trim();
        if (trimmed === '' || trimmed.startsWith('#')) continue;
        const [name, kind] = trimmed.split(/\\s+/);
        if (!name) continue;
        resources.push({
          schemaVersion: 1,
          id: 'raw.' + name,
          kind: kind || 'fixture.resource',
          source: rel,
          location: { file: rel, line: 1, col: 0 },
          detectorVersion: '1.0.0',
          attributes: { resourceName: name },
        });
      }
    }
    return { resources, unresolved: [], findings: [] };
  },
};
`;

/** Policies document: one user-facing crud:read policy. */
export const POLICIES_YML = `\
schemaVersion: 1
policies:
  - id: ${POLICY_ID}
    when:
      exposure: user-facing
    require:
      - crud:read
`;

/**
 * Classifications document for the named resources (user-facing
 * tenant tables with a single-column primary key).
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
classifications: .gateforge/classifications.yml
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

/** Installs the standard fixture project into a temp repo. */
export function installFixture(repo: TempRepo, options: Parameters<typeof configYml>[0] = {}): void {
  repo.writeFiles({
    '.gateforge.yml': configYml(options),
    '.gateforge/policies.yml': POLICIES_YML,
    '.gateforge/classifications.yml': classificationsYml(['accounts', 'orders']),
    'plugin.mjs': PLUGIN_SOURCE,
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

/** Absolute path of the python reference detector (GPP/2 round-trips). */
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