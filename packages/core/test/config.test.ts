import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  GateforgeConfigError,
  loadConfig,
  parseConfig,
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
      module: '@gateforge/pack-sqlalchemy/detector-fastapi',
    },
  ],
  policies: '.gateforge/policies.yml',
  classifications: '.gateforge/classifications.yml',
  adapters: '.gateforge/adapters',
  waivers: '.gateforge/waivers',
  baselines: '.gateforge/baselines/obligations.json',
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
classifications: .gateforge/classifications.yml
adapters: .gateforge/adapters
waivers: .gateforge/waivers
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
classifications: .gateforge/classifications.yml
adapters: .gateforge/adapters
waivers: .gateforge/waivers
baselines: .gateforge/baselines/obligations.json
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
