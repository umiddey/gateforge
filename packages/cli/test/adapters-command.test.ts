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
import { cpSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTempRepo, type TempRepo } from '@gate-forge/core';
import { CLASSIFICATION_POLICY_YML, configYml, POLICIES_YML, runCli, type CliResult } from './helpers.js';

/** The shipped example app (documented, transport-only demo). */
const EXAMPLE_ROOT = fileURLToPath(new URL('../../../example/', import.meta.url));

/** The marker the probe fixture app presents (GF-13). */
const FINGERPRINT = 'fixture-loopback-v1';

/** The login the seat-protected probe fixture app accepts. */
const SEAT_USER = 'probe-seat';
const SEAT_PASSWORD = 'probe-seat-password-do-not-leak';

/** The cookie the fixture app hands out after a successful login. */
const SEAT_COOKIE = 'probe_session=granted';

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
 * A detector whose resource is served by a COMPLETE collection and no
 * by-id route — the list-only shape the kit resolves the member from.
 */
const PLUGIN_WITH_COLLECTION_ONLY = PLUGIN_WITH_ROUTES.replace(
  /.*(?:endpoint|signal)\('GET \/api\/accounts\/:id'.*\n/g,
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

/**
 * Points the repo's `@gate-forge/witness/adapter-kit` at this
 * worktree's built kit, so a generated module resolves in the repo.
 *
 * Args:
 *   repo: the temp repo.
 */
function installWitnessKit(repo: { writeFiles: (files: Record<string, string>) => void }): void {
  repo.writeFiles({
    'node_modules/@gate-forge/witness/package.json': JSON.stringify({
      name: '@gate-forge/witness',
      version: '0.7.1',
      type: 'module',
      exports: {
        './adapter-kit': {
          import: new URL('../../../../packages/witness/dist/adapter-kit/index.js', import.meta.url)
            .pathname,
        },
      },
    }),
  });
}

/**
 * Rewrites the generated adapter into a reviewed one that reads a
 * seat-protected collection through its own cookie-login seat.
 *
 * Args:
 *   repo: the temp repo holding the generated adapter.
 */
function seatProtectAdapter(repo: {
  path: (relative: string) => string;
  writeFiles: (files: Record<string, string>) => void;
}): void {
  const generated = readFileSync(repo.path('.gateforge/adapters/tenant.accounts.mjs'), 'utf8');
  repo.writeFiles({
    '.gateforge/adapters/tenant.accounts.mjs': generated
      .replace('readPath: "/api/accounts/{id}"', 'readPath: "/secure/accounts/{id}"')
      .replace('listPath: "/api/accounts"', 'listPath: "/secure/accounts"')
      .replace(
        '  collectionKey: firstArrayOf,',
        '  collectionKey: firstArrayOf,\n' +
          "  auth: { kind: 'cookie-login', seats: { seat: { loginPath: '/login',\n" +
          "    credentials: { username: 'GATEFORGE_TEST_SEAT_USER',\n" +
          "      password: 'GATEFORGE_TEST_SEAT_PASSWORD' } } } },",
      ),
  });
}

/**
 * Probes the repo's adapters with a seat environment set the way a
 * witnessed run carries credentials: in the process environment only,
 * never in the repo, argv, or the captured output.
 *
 * Args:
 *   repo: the temp repo.
 *   baseUrl: the running app's base URL.
 *   seat: the seat env vars for the probe.
 *
 * Returns:
 *   Promise<CliResult>: the command's result, with the env restored.
 */
async function probeWithSeat(
  repo: TempRepo,
  baseUrl: string,
  seat: Readonly<Record<string, string>>,
): Promise<CliResult> {
  const previous = new Map(Object.keys(seat).map((name) => [name, process.env[name]]));
  for (const [name, value] of Object.entries(seat)) process.env[name] = value;
  try {
    return await runCli(repo, ['adapters', 'check', '--probe', '--base-url', baseUrl]);
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
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
    if (path === '/login' && req.method === 'POST') {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, string>;
        if (body['username'] !== SEAT_USER || body['password'] !== SEAT_PASSWORD) {
          send(401, { ok: false });
          return;
        }
        res.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'x-gateforge-env-fingerprint': FINGERPRINT,
          'set-cookie': `${SEAT_COOKIE}; HttpOnly; Path=/`,
        });
        res.end(JSON.stringify({ ok: true }));
      });
      return;
    }
    // A collection only a logged-in session can read: an
    // unauthenticated probe GET here is answered 401.
    if (path === '/secure/accounts') {
      if (req.headers['cookie'] !== SEAT_COOKIE) {
        send(401, { error: 'login required' });
        return;
      }
      send(200, { accounts: [{ id: 'acc-1', first_name: 'Ada', last_name: 'L', status: 'active' }] });
      return;
    }
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

  it('writes a list-only adapter when the app serves a collection and no by-id route', async () => {
    await withTempRepo({}, async (repo) => {
      install(repo, PLUGIN_WITH_COLLECTION_ONLY);
      const run = await runCli(repo, ['adapters', 'scaffold'], {
        GATEFORGE_TARGET_FINGERPRINT: FINGERPRINT,
      });
      expect(run.code, `${run.stdout}\n${run.stderr}`).toBe(0);
      expect(run.stdout).toContain('wrote .gateforge/adapters/tenant.accounts.mjs');
      const source = readFileSync(repo.path('.gateforge/adapters/tenant.accounts.mjs'), 'utf8');
      // No readPath is invented, and the header says what that costs.
      expect(source).toContain('LIST-ONLY');
      expect(source).toContain('listPath: "/api/accounts"');
      expect(source).not.toContain('readPath:');
      // The generated module is a real adapter: the kit builds it and
      // `adapters check` grades it exactly like a hand-written one.
      installWitnessKit(repo);
      const check = await runCli(repo, ['adapters', 'check']);
      expect(check.code, `${check.stdout}\n${check.stderr}`).toBe(0);
      expect(check.stdout).toContain('[ok] .gateforge/adapters/tenant.accounts.mjs');
      expect(check.stdout).toContain('declares list');
      expect(check.stdout).not.toContain('[invalid]');
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

describe('gateforge adapters on a fresh example project', () => {
  it('scaffolds, checks, and leaves the gate green without touching the app', async () => {
    await withTempRepo({}, async (repo) => {
      cpSync(EXAMPLE_ROOT, repo.root, {
        recursive: true,
        filter: (source) => {
          const path = relative(EXAMPLE_ROOT, source);
          return path === '' || (!path.split(sep).includes('.git') && !path.split(sep).includes('node_modules'));
        },
      });
      const init = await runCli(repo, ['init', '--no-ci', '--no-blocking']);
      expect(init.code, `${init.stdout}\n${init.stderr}`).toBe(0);

      // What the example app actually declares: transport-only HTTP
      // endpoints, no business table — so there is nothing to generate,
      // and the command must say exactly that instead of inventing one.
      const scaffold = await runCli(repo, ['adapters', 'scaffold', '--dry-run'], {
        GATEFORGE_TARGET_FINGERPRINT: FINGERPRINT,
      });
      expect(scaffold.code, `${scaffold.stdout}\n${scaffold.stderr}`).toBe(0);
      expect(scaffold.stdout).toContain('adapters scaffold: 0 to write, 0 already present, 0 needing a human');

      const check = await runCli(repo, ['adapters', 'check']);
      expect(check.code, `${check.stdout}\n${check.stderr}`).toBe(0);
      expect(check.stdout).toContain('0 resource(s) without one');

      const gate = await runCli(repo, ['check']);
      expect(gate.code, `${gate.stdout}\n${gate.stderr}`).toBe(0);
    });
  }, 180_000);
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
      installWitnessKit(repo);

      const check = await runCli(repo, ['adapters', 'check', '--probe', '--base-url', appUrl]);
      expect(check.code, `${check.stdout}\n${check.stderr}`).toBe(0);
      expect(check.stdout).toContain('[ok] .gateforge/adapters/tenant.accounts.mjs');
      expect(check.stdout).toContain('declares list');
      expect(check.stdout).toContain('[ok] tenant.accounts /api/accounts');
      expect(check.stdout).toContain("presents the declared fingerprint 'fixture-loopback-v1'");
      expect(check.stdout).not.toContain('[missing]');
    });
  });

  it('probes a seated adapter THROUGH its seat, and keeps the credential out of everything', async () => {
    const secret = SEAT_PASSWORD;
    await withTempRepo({}, async (repo) => {
      install(repo, PLUGIN_WITH_ROUTES);
      const scaffold = await runCli(repo, ['adapters', 'scaffold'], {
        GATEFORGE_TARGET_FINGERPRINT: FINGERPRINT,
      });
      expect(scaffold.code, `${scaffold.stdout}\n${scaffold.stderr}`).toBe(0);
      // A reviewed adapter whose credentials live ONLY in the witness
      // environment, reading a collection that answers 401 to anyone
      // not logged in.
      seatProtectAdapter(repo);
      installWitnessKit(repo);

      const check = await probeWithSeat(repo, appUrl, {
        GATEFORGE_TEST_SEAT_USER: SEAT_USER,
        GATEFORGE_TEST_SEAT_PASSWORD: secret,
      });
      expect(check.code, `${check.stdout}\n${check.stderr}`).toBe(0);
      // The probe read through the seat, so the app answered 2xx — an
      // unauthenticated probe GET would have reported a false 401.
      expect(check.stdout).toContain('[ok] tenant.accounts /secure/accounts');
      const state = repo.path('.gateforge');
      const files = readdirSync(state, { recursive: true }) as string[];
      const leaks = files.filter((entry) => {
        const full = join(state, String(entry));
        try {
          return readFileSync(full, 'utf8').includes(secret);
        } catch {
          return false;
        }
      });
      // Neither the command output nor any run-state file may carry the
      // credential: it lives in the witness environment, nowhere else.
      expect(leaks).toEqual([]);
      expect(`${check.stdout}\n${check.stderr}`).not.toContain(secret);
    });
  });

  it('names the witness env vars a seat needs instead of blaming the credentials', async () => {
    await withTempRepo({}, async (repo) => {
      install(repo, PLUGIN_WITH_ROUTES);
      const scaffold = await runCli(repo, ['adapters', 'scaffold'], {
        GATEFORGE_TARGET_FINGERPRINT: FINGERPRINT,
      });
      expect(scaffold.code, `${scaffold.stdout}\n${scaffold.stderr}`).toBe(0);
      seatProtectAdapter(repo);
      installWitnessKit(repo);

      const check = await probeWithSeat(repo, appUrl, {
        GATEFORGE_TEST_SEAT_USER: '',
        GATEFORGE_TEST_SEAT_PASSWORD: '',
      });
      expect(check.code, `${check.stdout}\n${check.stderr}`).toBe(0);
      expect(check.stdout).toContain('[auth] tenant.accounts');
      expect(check.stdout).toContain(
        "the seat 'seat' needs GATEFORGE_TEST_SEAT_USER, GATEFORGE_TEST_SEAT_PASSWORD",
      );
      expect(check.stdout).toContain('not probed');
    });
  });

  it('names the login POST status when the seat credentials are rejected', async () => {
    await withTempRepo({}, async (repo) => {
      install(repo, PLUGIN_WITH_ROUTES);
      const scaffold = await runCli(repo, ['adapters', 'scaffold'], {
        GATEFORGE_TARGET_FINGERPRINT: FINGERPRINT,
      });
      expect(scaffold.code, `${scaffold.stdout}\n${scaffold.stderr}`).toBe(0);
      seatProtectAdapter(repo);
      installWitnessKit(repo);

      // The env vars ARE set — the password in them is simply wrong.
      const check = await probeWithSeat(repo, appUrl, {
        GATEFORGE_TEST_SEAT_USER: SEAT_USER,
        GATEFORGE_TEST_SEAT_PASSWORD: 'wrong-password',
      });
      expect(check.code, `${check.stdout}\n${check.stderr}`).toBe(0);
      expect(check.stdout).toContain('[auth] tenant.accounts');
      expect(check.stdout).toContain('login failed: POST /login -> 401');
      expect(check.stdout).not.toContain('wrong-password');
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
