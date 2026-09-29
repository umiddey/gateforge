/**
 * `gateforge adapters scaffold|check`: the connect-your-project half.
 *
 * What these lock down:
 * - scaffold writes a reviewable starting point for a business resource
 *   that has none, never overwrites one that does, and says plainly
 *   what it could not do and why;
 * - the generated file is honest about every guess, and the "needs you"
 *   cases (no read route, no collection route, unknown fingerprint)
 *   produce NO file at all rather than a broken one;
 * - check loads and validates real adapter modules, reports the
 *   resources that still have none, and probes one GET per adapter
 *   against a running app.
 */
import { existsSync, readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTempRepo } from '@gate-forge/core';
import { CLASSIFICATION_POLICY_YML, configYml, POLICIES_YML, runCli } from './helpers.js';

/** The marker the probe fixture app presents (GF-13). */
const FINGERPRINT = 'fixture-loopback-v1';

/**
 * The fixture detector: one business resource with its two GET routes,
 * so the scaffolder has a read path, a collection path, a classified
 * primary key, and declared delete semantics to work from.
 */
const PLUGIN_WITH_ROUTES = `export default {
  async discover() {
    const location = { file: 'src/accounts.js', line: 1, col: 0 };
    const signal = (resourceName, dimension, assertion) => ({
      schemaVersion: 1,
      target: { resourceName },
      dimension,
      assertion,
      basis: 'declaration',
      source: 'fixture.plugin',
      location,
      detector: { id: 'fixture.plugin', version: '1.0.0' },
    });
    const endpoint = (identity, method, canonicalPath) => ({
      schemaVersion: 1,
      id: 'http.endpoint:' + identity,
      kind: 'http.endpoint',
      source: 'src/accounts.js',
      location,
      detectorVersion: '1.0.0',
      attributes: {
        resourceName: identity,
        method,
        canonicalPath,
        identity,
        linkedResourceName: 'accounts',
      },
    });
    return {
      resources: [
        {
          schemaVersion: 1,
          id: 'accounts',
          kind: 'fixture.entity',
          source: 'src/accounts.js',
          location,
          detectorVersion: '1.0.0',
          attributes: {
            resourceName: 'accounts',
            updateableFields: ['first_name', 'last_name', 'status'],
          },
        },
        endpoint('GET /api/accounts', 'GET', '/api/accounts'),
        endpoint('GET /api/accounts/:id', 'GET', '/api/accounts/:id'),
      ],
      unresolved: [],
      findings: [],
      classificationSignals: [
        signal('accounts', 'plane', 'tenant'),
        signal('accounts', 'identity', ['id']),
        signal('accounts', 'adapter-binding', 'tenant.accounts'),
        signal('accounts', 'lifecycle.create', true),
        signal('accounts', 'lifecycle.read', true),
        signal('accounts', 'delete-semantics', 'archive'),
        signal('GET /api/accounts', 'plane', 'tenant'),
        signal('GET /api/accounts', 'identity', ['method', 'path']),
        signal('GET /api/accounts/:id', 'plane', 'tenant'),
        signal('GET /api/accounts/:id', 'identity', ['method', 'path']),
      ],
    };
  },
};
`;

/** A detector whose resource has NO routes at all. */
const PLUGIN_WITHOUT_ROUTES = PLUGIN_WITH_ROUTES.replace(
  /endpoint\('GET \/api\/accounts[\s\S]*?endpoint\('GET \/api\/accounts\/:id', 'GET', '\/api\/accounts\/:id'\),\n/,
  '',
);

/**
 * Installs a fixture project with one adapter-less business resource.
 *
 * Args:
 *   repo: the temp repo.
 *   plugin: the detector source to install.
 */
function install(repo: { writeFiles: (files: Record<string, string>) => void }, plugin: string): void {
  repo.writeFiles({
    '.gitignore': '.gateforge/test-gates/\n',
    '.gateforge.yml': configYml({ include: "['src/**/*.js']" }),
    '.gateforge/policies.yml': POLICIES_YML,
    '.gateforge/classification-policy.yml': CLASSIFICATION_POLICY_YML,
    'plugin.mjs': plugin,
    'src/accounts.js': 'export const accounts = 1;\n',
  });
}

/** The probe fixture app. */
let app: Server;
/** Its loopback base URL. */
let appUrl: string;

beforeAll(async () => {
  app = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0];
    const send = (status: number, body: unknown): void => {
      res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'x-gateforge-env-fingerprint': FINGERPRINT,
      });
      res.end(JSON.stringify(body));
    };
    if (path === '/api/accounts') {
      send(200, { accounts: [{ id: 'acc-1', first_name: 'Ada', last_name: 'L', status: 'active' }] });
      return;
    }
    if (path === '/api/accounts/acc-1') {
      send(200, { id: 'acc-1', first_name: 'Ada', last_name: 'L', status: 'active' });
      return;
    }
    send(404, { error: 'not found' });
  });
  await new Promise<void>((resolve) => app.listen(0, '127.0.0.1', resolve));
  appUrl = `http://127.0.0.1:${String((app.address() as AddressInfo).port)}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => app.close(() => resolve()));
});

describe('gateforge adapters scaffold', () => {
  it('writes a reviewable starting point for a resource that has no adapter', async () => {
    await withTempRepo({}, async (repo) => {
      install(repo, PLUGIN_WITH_ROUTES);
      const dry = await runCli(repo, ['adapters', 'scaffold', '--dry-run'], {
        GATEFORGE_TARGET_FINGERPRINT: FINGERPRINT,
      });
      expect(dry.code, `${dry.stdout}\n${dry.stderr}`).toBe(0);
      expect(dry.stdout).toContain('would write .gateforge/adapters/tenant.accounts.mjs');
      expect(existsSync(repo.path('.gateforge/adapters/tenant.accounts.mjs'))).toBe(false);

      const run = await runCli(repo, ['adapters', 'scaffold'], {
        GATEFORGE_TARGET_FINGERPRINT: FINGERPRINT,
      });
      expect(run.code, `${run.stdout}\n${run.stderr}`).toBe(0);
      expect(run.stdout).toContain('wrote .gateforge/adapters/tenant.accounts.mjs');
      const source = readFileSync(repo.path('.gateforge/adapters/tenant.accounts.mjs'), 'utf8');
      // Every guess is marked in the file the reviewer opens.
      expect(source).toContain('GENERATED by `gateforge adapters scaffold`');
      expect(source).toContain("import { defineHttpAdapter, firstArrayOf } from '@gate-forge/witness/adapter-kit';");
      expect(source).toContain("readPath: \"/api/accounts/{id}\"");
      expect(source).toContain("listPath: \"/api/accounts\"");
      expect(source).toContain('collectionKey: firstArrayOf');
      // The resource is blocked, so the delete semantics are unprovable:
      // the generator guesses and says so in the header, never silently.
      expect(source).toContain('deletion: "hard"');
      expect(source).toContain('GUESSED: the classifier could not prove the delete semantics');
      expect(source).toMatch(/Guesses in this file:\n \*   1\./);
      expect(source).toContain("environmentFingerprint: \"fixture-loopback-v1\"");
    });
  });

  it('never overwrites an adapter that already exists', async () => {
    await withTempRepo({}, async (repo) => {
      install(repo, PLUGIN_WITH_ROUTES);
      const first = await runCli(repo, ['adapters', 'scaffold'], {
        GATEFORGE_TARGET_FINGERPRINT: FINGERPRINT,
      });
      expect(first.code, `${first.stdout}\n${first.stderr}`).toBe(0);
      const generated = readFileSync(repo.path('.gateforge/adapters/tenant.accounts.mjs'), 'utf8');
      // A reviewer edits the generated file...
      repo.writeFiles({
        '.gateforge/adapters/tenant.accounts.mjs': `${generated}\n// reviewed by a human\n`,
      });
      const second = await runCli(repo, ['adapters', 'scaffold'], {
        GATEFORGE_TARGET_FINGERPRINT: FINGERPRINT,
      });
      expect(second.code, `${second.stdout}\n${second.stderr}`).toBe(0);
      // ...and a second run must leave the reviewed file exactly as it is.
      expect(second.stdout).toContain('0 to write');
      expect(readFileSync(repo.path('.gateforge/adapters/tenant.accounts.mjs'), 'utf8')).toBe(
        `${generated}\n// reviewed by a human\n`,
      );
    });
  });

  it('writes nothing and explains itself when no route serves the resource', async () => {
    await withTempRepo({}, async (repo) => {
      install(repo, PLUGIN_WITHOUT_ROUTES);
      const run = await runCli(repo, ['adapters', 'scaffold'], {
        GATEFORGE_TARGET_FINGERPRINT: FINGERPRINT,
      });
      expect(run.code, `${run.stdout}\n${run.stderr}`).toBe(0);
      expect(run.stdout).toContain('needs you:');
      expect(run.stdout).toContain('no GET route serves one accounts entity');
      expect(run.stdout).toContain('a create cannot be witnessed without a complete collection read');
      expect(existsSync(repo.path('.gateforge/adapters/tenant.accounts.mjs'))).toBe(false);
    });
  });

  it('refuses to guess the environment fingerprint', async () => {
    await withTempRepo({}, async (repo) => {
      install(repo, PLUGIN_WITH_ROUTES);
      const run = await runCli(repo, ['adapters', 'scaffold']);
      expect(run.code, `${run.stdout}\n${run.stderr}`).toBe(0);
      expect(run.stdout).toContain('GATEFORGE_TARGET_FINGERPRINT');
      expect(existsSync(repo.path('.gateforge/adapters/tenant.accounts.mjs'))).toBe(false);
    });
  });
});

describe('gateforge adapters check', () => {
  it('loads the generated adapter, validates it, and probes it against a running app', async () => {
    await withTempRepo({}, async (repo) => {
      install(repo, PLUGIN_WITH_ROUTES);
      const scaffold = await runCli(repo, ['adapters', 'scaffold'], {
        GATEFORGE_TARGET_FINGERPRINT: FINGERPRINT,
      });
      expect(scaffold.code, `${scaffold.stdout}\n${scaffold.stderr}`).toBe(0);
      // The generated module must be loadable IN THE REPO: the kit
      // resolves from the project's installed witness package.
      repo.writeFiles({
        'node_modules/@gate-forge/witness/package.json': JSON.stringify({
          name: '@gate-forge/witness',
          version: '0.7.1',
          type: 'module',
          exports: {
            './adapter-kit': {
              import: new URL(
                '../../../../packages/witness/dist/adapter-kit/index.js',
                import.meta.url,
              ).pathname,
            },
          },
        }),
      });

      const check = await runCli(repo, ['adapters', 'check', '--probe', '--base-url', appUrl]);
      expect(check.code, `${check.stdout}\n${check.stderr}`).toBe(0);
      expect(check.stdout).toContain('[ok] .gateforge/adapters/tenant.accounts.mjs');
      expect(check.stdout).toContain('declares list');
      expect(check.stdout).toContain('[ok] tenant.accounts /api/accounts');
      expect(check.stdout).toContain("presents the declared fingerprint 'fixture-loopback-v1'");
      expect(check.stdout).not.toContain('[missing]');
    });
  });

  it('reports a resource that still has no adapter', async () => {
    await withTempRepo({}, async (repo) => {
      install(repo, PLUGIN_WITH_ROUTES);
      const check = await runCli(repo, ['adapters', 'check']);
      expect(check.code, `${check.stdout}\n${check.stderr}`).toBe(0);
      expect(check.stdout).toContain('[missing] tenant.accounts');
      expect(check.stdout).toContain('gateforge adapters scaffold');
    });
  });

  it('rejects --probe without a base URL', async () => {
    await withTempRepo({}, async (repo) => {
      install(repo, PLUGIN_WITH_ROUTES);
      const check = await runCli(repo, ['adapters', 'check', '--probe']);
      expect(check.code).toBe(2);
      expect(check.stderr).toContain('--probe needs --base-url');
    });
  });

  it('surfaces an invalid adapter as invalid, not as a crash', async () => {
    await withTempRepo({}, async (repo) => {
      install(repo, PLUGIN_WITH_ROUTES);
      repo.writeFiles({
        '.gateforge/adapters/tenant.accounts.mjs':
          'export default { resourceId: "tenant.accounts" };\n',
      });
      const check = await runCli(repo, ['adapters', 'check', '--json']);
      expect(check.code, `${check.stdout}\n${check.stderr}`).toBe(0);
      const parsed = JSON.parse(check.stdout) as {
        adapters: Array<{ ok: boolean; issues: string[] }>;
      };
      expect(parsed.adapters[0]?.ok).toBe(false);
      expect(parsed.adapters[0]?.issues.join(' ')).toContain('read must be');
    });
  });
});
