import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  GateforgeConfigError,
  loadConfig,
  parseConfig,
  RuntimeConfigSchema,
} from '../src/index.js';
import { parse as parseYaml } from 'yaml';

/** A minimal valid config payload (pin #6). */
const validConfig = {
  schemaVersion: 1,
  project: {
    languages: ['python'],
    paths: { include: ['backend/**/*.py'], exclude: ['backend/migrations/**'] },
  },
  plugins: [
    {
      id: 'gateforge.pack-sqlalchemy',
      version: '0.1.0',
      transport: 'subprocess',
      command: ['python', '-m', 'gateforge_sqlalchemy'],
    },
    {
      id: 'gateforge.detector-fastapi',
      version: '0.1.0',
      transport: 'in-process',
      module: '@gate-forge/pack-sqlalchemy/detector-fastapi',
    },
  ],
  policies: '.gateforge/policies.yml',
  classificationPolicy: '.gateforge/classification-policy.yml',
  adapters: '.gateforge/adapters',
  waivers: '.gateforge/waivers',
  baselines: '.gateforge/baselines/obligations.json',
  // Scanner settings (0.11.0): REQUIRED in `.gateforge.yml`; the same four
  // keys used to sit at the top of `classification-policy.yml`.
  scan: {
    scanRoots: ['backend/**'],
    coverage: [{ capability: 'models.sqlalchemy', detector: 'gateforge.pack-sqlalchemy', appliesTo: ['backend/**'] }],
    declarations: { internality: 'gateforge:internal' },
    volatileFields: ['updated_at'],
  },
  changed: { provider: 'auto' },
  witness: { maxDurationSeconds: 30 },
  clock: { mode: 'system' },
};

describe('parseConfig (pin #6)', () => {
  it('accepts a fully-valid config and types it', () => {
    const config = parseConfig(validConfig);
    expect(config.project.languages).toEqual(['python']);
    expect(config.plugins).toHaveLength(2);
    expect(config.clock.mode).toBe('system');
  });
  it('defaults HTTP route-source selection to both and rejects unknown sources', () => {
    expect(parseConfig(validConfig).http.routeSource).toBe('both');
    for (const routeSource of ['openapi', 'detectors', 'both']) {
      expect(parseConfig({ ...validConfig, http: { routeSource } }).http.routeSource).toBe(routeSource);
    }
    expect(() => parseConfig({ ...validConfig, http: { routeSource: 'guess' } })).toThrow(GateforgeConfigError);
  });
  it('validates pages router, audiences, error markers and sweep settings', () => {
    const pages = parseConfig({
      ...validConfig,
      pages: {
        router: 'react-router',
        audiences: [{ name: 'tenant', loginRoute: '/login', guard: 'TenantGuard' }],
        errorMarkers: ['Something went wrong'],
        params: { '/orders/:id': { id: 'seeded-order' } },
        exclude: [],
        sweep: true,
      },
    }).pages;
    expect(pages?.audiences[0]?.guard).toBe('TenantGuard');
    expect(() => parseConfig({
      ...validConfig,
      pages: { router: 'other', audiences: [], errorMarkers: [], params: {}, exclude: [], sweep: true },
    })).toThrow();
    expect(() => parseConfig({
      ...validConfig,
      pages: { router: 'manual', audiences: [{ name: 'bad', loginRoute: '/login' }], errorMarkers: [], params: {}, exclude: [], sweep: true },
    })).toThrow();
  });

  it('validates pages.basePath as the deployment prefix outside the code', () => {
    const base = { router: 'react-router', audiences: [], errorMarkers: [], params: {}, exclude: [], sweep: true };
    expect(parseConfig({ ...validConfig, pages: { ...base, basePath: '/app' } }).pages?.basePath).toBe('/app');
    expect(parseConfig({ ...validConfig, pages: { ...base } }).pages?.basePath).toBeUndefined();
    for (const bad of ['app', '', 'app/', '/app/']) {
      let caught: unknown;
      try {
        parseConfig({ ...validConfig, pages: { ...base, basePath: bad } });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(GateforgeConfigError);
      const diagnostics = (caught as GateforgeConfigError).diagnostics;
      expect(diagnostics.some((diagnostic) => diagnostic.jsonPath === '$.pages.basePath')).toBe(true);
      expect(diagnostics.some((diagnostic) => diagnostic.message.includes("pages.basePath must start with '/'"))).toBe(true);
    }
  });

  it('defaults an absent runner key to playwright (frozen behavior)', () => {
    const config = parseConfig(validConfig);
    expect(config.runner).toBe('playwright');
  });

  it('accepts each supported runner value', () => {
    for (const runner of ['pytest', 'vitest', 'cypress'] as const) {
      expect(parseConfig({ ...validConfig, runner }).runner).toBe(runner);
    }
    expect(parseConfig({ ...validConfig, runner: 'playwright' }).runner).toBe('playwright');
  });

  it('accepts repo-relative runtime-file globs and rejects anything that escapes the repo root', () => {
    expect(
      parseConfig({
        ...validConfig,
        enforcement: { reseal: true, resealRuntimeFiles: ['e2e/.auth/*.json', 'e2e/.auth/**'] },
      }).enforcement?.resealRuntimeFiles,
    ).toEqual(['e2e/.auth/*.json', 'e2e/.auth/**']);
    // Absent by default: a repository that declares nothing is untouched.
    expect(parseConfig(validConfig).enforcement?.resealRuntimeFiles).toBeUndefined();
    for (const bad of ['/etc/.env', '../outside.json', 'e2e//state.json', 'C:/state.json', '']) {
      expect(() => parseConfig({ ...validConfig, enforcement: { resealRuntimeFiles: [bad] } })).toThrow();
    }
  });

  it('rejects an unknown runner through the plain config-error path', () => {
    let caught: unknown;
    try {
      parseConfig({ ...validConfig, runner: 'mocha' });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(GateforgeConfigError);
    const diagnostics = (caught as GateforgeConfigError).diagnostics;
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.jsonPath).toBe('$.runner');
    expect(diagnostics[0]?.expected).toContain('"playwright"');
    expect(diagnostics[0]?.got).toBe('"mocha"');
  });

  it("rejects the reserved engine issuer id 'gateforge.core' (red-team V1)", () => {
    const forged = {
      ...validConfig,
      plugins: [
        {
          id: 'gateforge.core',
          version: '1',
          transport: 'in-process',
          module: './forged-plugin.mjs',
        },
      ],
    };
    expect(() => parseConfig(forged)).toThrow(/reserved/);
  });

  it('round-trips through YAML text', () => {
    const yamlText = `
schemaVersion: 1
project:
  languages: [python]
  paths:
    include: ["**/*.py"]
    exclude: []
plugins: []
policies: .gateforge/policies.yml
classificationPolicy: .gateforge/classification-policy.yml
adapters: .gateforge/adapters
waivers: .gateforge/waivers
scan:
  scanRoots: ["**/*.py"]
  declarations: {internality: 'gateforge:internal'}
  volatileFields: []
baselines: .gateforge/baselines/obligations.json
changed:
  provider: local-staged
witness:
  maxDurationSeconds: 5
clock:
  mode: fixed
  fixedAt: 2026-08-30T00:00:00.000Z
`;
    const config = parseConfig(parseYaml(yamlText));
    expect(config.changed.provider).toBe('local-staged');
    expect(config.clock).toEqual({ mode: 'fixed', fixedAt: '2026-08-30T00:00:00.000Z' });
  });

  it('rejects unknown top-level keys (typos fail loud)', () => {
    expect(() =>
      parseConfig({ ...validConfig, clasifications: 'typo.yml' }),
    ).toThrow(GateforgeConfigError);
  });

  it('accepts an optional behaviorPolicy path and still rejects unknown keys', () => {
    const config = parseConfig({ ...validConfig, behaviorPolicy: '.gateforge/behavior.yml' });
    expect(config.behaviorPolicy).toBe('.gateforge/behavior.yml');
    expect(() => parseConfig({ ...validConfig, behaviorPolicy: '' })).toThrow(GateforgeConfigError);
  });
  it('accepts evidence.exclude lists and rejects everything else', () => {
    const config = parseConfig({
      ...validConfig,
      evidence: { exclude: { docs: ['docs'], cache: ['backend/__pycache__/x.cpython-312.pyc'] } },
    });
    expect(config.evidence?.exclude?.docs).toEqual(['docs']);
    expect(config.evidence?.exclude?.cache).toEqual(['backend/__pycache__/x.cpython-312.pyc']);
    // Either list may stand alone; ABSENT stays ABSENT.
    expect(parseConfig({ ...validConfig, evidence: { exclude: { docs: [] } } }).evidence?.exclude?.cache).toBeUndefined();
    expect(parseConfig(validConfig).evidence).toBeUndefined();
    // Empty strings, wrong types, and unknown keys all fail the load.
    expect(() => parseConfig({ ...validConfig, evidence: { exclude: { docs: [''] } } })).toThrow(GateforgeConfigError);
    expect(() => parseConfig({ ...validConfig, evidence: { exclude: { docs: 'docs' } } })).toThrow(
      GateforgeConfigError,
    );
    expect(() =>
      parseConfig({ ...validConfig, evidence: { exclude: { folders: ['docs'] } } }),
    ).toThrow(GateforgeConfigError);
    expect(() => parseConfig({ ...validConfig, evidence: { includes: { docs: ['docs'] } } })).toThrow(
      GateforgeConfigError,
    );
  });


  it('accepts an owner-declared tenant scope column list, and nothing else', () => {
    const config = parseConfig({ ...validConfig, tenancy: { scopeColumns: ['contractor_id'] } });
    expect(config.tenancy?.scopeColumns).toEqual(['contractor_id']);
    // An empty list declares nothing; it is rejected rather than read as
    // "this repository has no tenant scope at all".
    expect(() => parseConfig({ ...validConfig, tenancy: { scopeColumns: [] } })).toThrow(GateforgeConfigError);
    expect(() => parseConfig({ ...validConfig, tenancy: { scopeColumn: ['contractor_id'] } })).toThrow(
      GateforgeConfigError,
    );
    // ABSENT stays absent: today's behavior, byte-identical.
    expect(parseConfig({ ...validConfig }).tenancy).toBeUndefined();
  });

  it('accepts only block|warn for how unmatched by-id routes are graded', () => {
    expect(parseConfig({ ...validConfig, endpoints: { unmatchedRoutes: 'block' } }).endpoints).toEqual({
      unmatchedRoutes: 'block',
    });
    expect(parseConfig({ ...validConfig, endpoints: { unmatchedRoutes: 'warn' } }).endpoints).toEqual({
      unmatchedRoutes: 'warn',
    });
    // An empty section declares nothing and stays absent; a value that is
    // neither answer is refused rather than read as one of them.
    expect(parseConfig({ ...validConfig, endpoints: {} }).endpoints).toEqual({});
    expect(() => parseConfig({ ...validConfig, endpoints: { unmatchedRoutes: 'loud' } })).toThrow(
      GateforgeConfigError,
    );
    expect(() => parseConfig({ ...validConfig, endpoints: { unmatchedRoute: 'block' } })).toThrow(
      GateforgeConfigError,
    );
    // ABSENT stays absent: an upgraded repository keeps today's parsing,
    // and the engine reads that absence as the non-blocking default.
    expect(parseConfig({ ...validConfig }).endpoints).toBeUndefined();
  });
  it('accepts optional harness commands and bounded history retention', () => {
    const config = parseConfig({
      ...validConfig,
      harness: {
        up: 'tools/up.sh',
        reset: 'tools/reset.sh',
        seed: 'tools/seed.sh',
        health: 'tools/health.sh',
        down: 'tools/down.sh',
        serviceLogs: { command: 'docker compose logs --tail ${lines} ${service}', services: ['db', 'worker'] },
      },
      history: {},
    });
    expect(config.harness?.seed).toBe('tools/seed.sh');
    expect(config.history?.retentionDays).toBe(14);
  });

  it('validates absent-log health probes as one runtime probe kind', () => {
    const runtime = RuntimeConfigSchema.parse({
      schemaVersion: 1,
      health: [{
        name: 'worker-startup',
        logAbsent: { command: './tools/recent-worker-logs.sh', pattern: 'worker startup failed' },
      }],
    });
    expect(runtime.health?.[0]?.logAbsent?.pattern).toBe('worker startup failed');
    expect(RuntimeConfigSchema.safeParse({
      schemaVersion: 1,
      health: [{
        name: 'ambiguous',
        tcp: '127.0.0.1:5432',
        logAbsent: { command: './tools/logs.sh', pattern: 'failed' },
      }],
    }).success).toBe(false);
  });

  it('accepts an owner-declared expect timeout and rejects out-of-range values', () => {
    expect(RuntimeConfigSchema.parse({ schemaVersion: 1, expectTimeoutSeconds: 15 }).expectTimeoutSeconds).toBe(15);
    for (const seconds of [0, 601, 1.5]) {
      expect(RuntimeConfigSchema.safeParse({ schemaVersion: 1, expectTimeoutSeconds: seconds }).success).toBe(false);
    }
  });

  it('accepts an owner-declared trace and rejects values Playwright does not know', () => {
    for (const trace of ['off', 'on', 'retain-on-failure', 'on-first-retry', 'on-all-retries', 'retain-on-first-failure']) {
      expect(RuntimeConfigSchema.parse({ schemaVersion: 1, trace }).trace).toBe(trace);
    }
    for (const trace of ['always', 'sometimes', true, 1]) {
      expect(RuntimeConfigSchema.safeParse({ schemaVersion: 1, trace }).success).toBe(false);
    }
  });

  it('rejects history retention above ninety days', () => {
    expect(() => parseConfig({ ...validConfig, history: { retentionDays: 91 } })).toThrow(GateforgeConfigError);
  });

  it('rejects schemaVersion drift with the never-migrated message', () => {
    try {
      parseConfig({ ...validConfig, schemaVersion: 2 });
      expect.unreachable('expected GateforgeConfigError');
    } catch (error) {
      expect(error).toBeInstanceOf(GateforgeConfigError);
      const diagnostics = (error as GateforgeConfigError).diagnostics;
      expect(diagnostics[0]?.jsonPath).toBe('$.schemaVersion');
      expect(diagnostics[0]?.message).toMatch(/never migrates/);
    }
  });

  it('subprocess plugin without command fails closed', () => {
    const broken = {
      ...validConfig,
      plugins: [{ id: 'p', version: '1', transport: 'subprocess' }],
    };
    try {
      parseConfig(broken);
      expect.unreachable('expected GateforgeConfigError');
    } catch (error) {
      const diagnostics = (error as GateforgeConfigError).diagnostics;
      expect(
        diagnostics.some(
          (diagnostic) =>
            diagnostic.jsonPath === '$.plugins[0].command' &&
            /requires 'command'/.test(diagnostic.message),
        ),
      ).toBe(true);
    }
  });

  it('fixed clock without fixedAt and system clock with fixedAt both fail', () => {
    expect(() =>
      parseConfig({
        ...validConfig,
        clock: { mode: 'fixed' },
      }),
    ).toThrow(GateforgeConfigError);
    expect(() =>
      parseConfig({
        ...validConfig,
        clock: { mode: 'system', fixedAt: '2026-08-30T00:00:00.000Z' },
      }),
    ).toThrow(GateforgeConfigError);
  });

  it('diagnostics carry file, jsonPath, and expected-vs-got', () => {
    const broken = {
      ...validConfig,
      witness: { maxDurationSeconds: 0 },
      changed: { provider: 'perforce' },
    };
    try {
      parseConfig(broken, { file: '.gateforge.yml' });
      expect.unreachable('expected GateforgeConfigError');
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain('.gateforge.yml');
      expect(message).toContain('$.witness.maxDurationSeconds');
      expect(message).toContain('$.changed.provider');
      expect(message).toContain('got: "perforce"');
      expect(message).toContain('"auto" | "local-staged" | "github-pr" | "gitlab-mr"');
    }
  });
});

describe('loadConfig (fail-closed file handling)', () => {
  it('loads a valid YAML file from disk', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gateforge-config-'));
    const path = join(dir, '.gateforge.yml');
    writeFileSync(path, `
schemaVersion: 1
project:
  languages: [python]
  paths:
    include: ["**/*.py"]
    exclude: []
plugins: []
policies: .gateforge/policies.yml
classificationPolicy: .gateforge/classification-policy.yml
adapters: .gateforge/adapters
waivers: .gateforge/waivers
baselines: .gateforge/baselines/obligations.json
scan:
  scanRoots: ["**/*.py"]
  declarations: {internality: 'gateforge:internal'}
  volatileFields: []
changed:
  provider: auto
witness:
  maxDurationSeconds: 10
clock:
  mode: system
`);
    const config = loadConfig(path);
    expect(config.witness.maxDurationSeconds).toBe(10);
  });

  it('fails closed on a missing file with an actionable message', () => {
    expect(() => loadConfig('/nonexistent/path/.gateforge.yml')).toThrow(
      /cannot read config file \(ENOENT\)/,
    );
  });

  it('fails closed on unparsable YAML', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gateforge-config-'));
    const path = join(dir, 'broken.yml');
    writeFileSync(path, 'project: [unclosed\n  bad: : :');
    try {
      loadConfig(path);
      expect.unreachable('expected GateforgeConfigError');
    } catch (error) {
      expect(error).toBeInstanceOf(GateforgeConfigError);
      expect((error as Error).message).toContain('invalid YAML');
    }
  });
});

describe('http.responseShape (WP4 step 4)', () => {
  it('defaults to off, accepts report and block, and rejects other values', () => {
    expect(parseConfig(validConfig).http.responseShape).toBe('off');
    expect(parseConfig({ ...validConfig, http: { responseShape: 'block' } }).http.responseShape).toBe('block');
    expect(parseConfig({ ...validConfig, http: { responseShape: 'report' } }).http.responseShape).toBe('report');
    expect(() => parseConfig({ ...validConfig, http: { responseShape: 'strict' } })).toThrow(GateforgeConfigError);
  });
});
