/**
 * `tests suggest --from-run` over a real repo and real run-state files:
 * the same discovered endpoint inventory every suggest run loads, page
 * records exactly as the 0.13 witness writes them (`apiStatuses` entries
 * carrying the method), the resolved catalog key of the observing test,
 * and the exact `tests mark` command the owner can paste. Advisory only:
 * the command never writes the test map.
 */
import { existsSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { withTempRepo, type TempRepo } from '@gate-forge/core';
import { configYml, runCli } from './helpers.js';

/** The gateforge monorepo root (for playwright module resolution). */
const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const RUN_ID = '4d813a14-807d-42e7-a6b4-3264f1645790';
const ITEMS_KEY = 'playwright:chromium:specs/items.spec.js:items page loads';

/** The in-process plugin emitting the endpoint inventory (real engine path). */
const ROUTES_PLUGIN = `export default {
  discover(paths) {
    const at = (file, line) => ({ file, line, col: 0 });
    const route = (symbol, normalizedPath, rawPath, method, line) => ({
      schemaVersion: 1,
      id: 'http.contract:backend/api/routes.py:' + symbol,
      kind: 'http.contract',
      source: 'backend/api/routes.py',
      location: at('backend/api/routes.py', line),
      detectorVersion: '1.0.0',
      attributes: { role: 'server-route', method, normalizedPath, rawPath, framework: 'test', handlerSymbol: symbol },
    });
    return {
      resources: [
        route('list_items', '/api/items', '/api/items', 'GET', 10),
        route('create_item', '/api/items', '/api/items', 'POST', 20),
        route('ambiguous_slot', '/api/ambiguous/{}', '/api/ambiguous/{id}', 'GET', 30),
        route('ambiguous_wildcard', '/api/ambiguous/{*}', '/api/ambiguous/{*path}', 'GET', 40),
      ],
      unresolved: [],
      findings: [],
      classificationSignals: [],
      scannedPaths: [...paths],
    };
  },
};
`;

const PW_CONFIG = "export default { testDir: 'specs', projects: [{ name: 'chromium' }] };\n";

const ITEMS_SPEC = [
  "import { test } from 'playwright/test';",
  "test('items page loads', async ({ page }) => {",
  "  await page.goto('/items');",
  '});',
  '',
].join('\n');

const POLICIES_YML = `schemaVersion: 1
policies:
  - id: items-observed
    when:
      kind: http.endpoint
    require:
      - http:request-observed
      - http:response-status-ok
`;

const CLASSIFICATION_YML = `schemaVersion: 1
trustedInternalEntryPoints: []
internalRules: []
planes:
  rules:
    - match: backend/**
      plane: tenant
      reason: fixture backend tree
`;

/** The app API exchanges the page made, as the witness records them. */
const API_STATUSES = [
  { method: 'GET', url: 'http://127.0.0.1:13001/api/items?a=1', status: 200, remoteAddress: '127.0.0.1', proxied: true },
  { method: 'POST', url: 'http://127.0.0.1:13001/api/items', status: 201, remoteAddress: '127.0.0.1', proxied: true },
  { method: 'GET', url: 'http://127.0.0.1:13001/api/widgets', status: 200, remoteAddress: '127.0.0.1', proxied: true },
  { method: 'GET', url: 'http://127.0.0.1:13001/api/ambiguous/7', status: 200, remoteAddress: '127.0.0.1', proxied: true },
];

function pageRecord(obligationId: string): Record<string, unknown> {
  return {
    schemaVersion: 1,
    recordId: 'a'.repeat(64),
    runId: RUN_ID,
    trust: 'witnessed',
    obligationId,
    kind: 'page.observed',
    origin: 'engine-observed',
    testId: 'items-1',
    payload: {
      channel: 'observed',
      routeId: 'tenant.page-items',
      finalUrl: 'http://127.0.0.1:13001/items',
      navigations: ['http://127.0.0.1:13001/items'],
      exceptions: [],
      domMarkerHit: true,
      apiStatuses: API_STATUSES,
      apiRequestsSettled: true,
      liveChannels: { count: 0, paths: [] },
      observationSequence: 0,
      loads: { satisfied: true, refusalReasons: [] },
      dataOk: { satisfied: true, refusalReasons: [] },
    },
  };
}

/** Installs the routes repo: endpoint inventory + policy + a playwright test. */
function installFromRunRepo(repo: TempRepo): void {
  const plugins = `  - id: routes.plugin
    version: '1.0.0'
    transport: in-process
    module: ./routes-plugin.mjs`;
  repo.writeFiles({
    '.gitignore': 'node_modules\n.gateforge/test-gates/\n',
    '.gateforge.yml': configYml({ include: "['backend/**', 'specs/**/*.spec.js']", plugins }),
    '.gateforge/policies.yml': POLICIES_YML,
    '.gateforge/classification-policy.yml': CLASSIFICATION_YML,
    '.gateforge/baselines/obligations.json': '{"schemaVersion":1,"fingerprints":[]}\n',
    'routes-plugin.mjs': ROUTES_PLUGIN,
    'playwright.config.js': PW_CONFIG,
    'specs/items.spec.js': ITEMS_SPEC,
    'backend/api/routes.py': '# route fixture\n',
  });
  const nm = join(repo.root, 'node_modules');
  mkdirSync(nm, { recursive: true });
  for (const name of ['playwright', 'playwright-core']) {
    if (!existsSync(join(nm, name))) {
      symlinkSync(join(ROOT, 'node_modules', name), join(nm, name), 'dir');
    }
  }
}

/** Writes the run state exactly as a witnessed run leaves it. */
function writeRunState(repo: TempRepo): void {
  const stateDir = join(repo.root, '.gateforge', 'test-gates');
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(
    join(stateDir, 'manifest.json'),
    JSON.stringify({
      schemaVersion: 1,
      runId: RUN_ID,
      startedAt: '2026-01-01T00:00:00.000Z',
      gitSha: null,
      provider: 'all-files',
      plugins: [],
      attestationScope: null,
    }),
    'utf8',
  );
  writeFileSync(
    join(stateDir, 'records.json'),
    JSON.stringify([
      pageRecord('tenant.page-items:page:loads'),
      pageRecord('tenant.page-items:page:data-ok'),
    ]),
    'utf8',
  );
  writeFileSync(
    join(stateDir, 'runner-outcomes.json'),
    JSON.stringify({
      schemaVersion: 1,
      runStatus: 'passed',
      runnerErrors: [],
      outcomes: [
        {
          testId: 'items-1',
          file: 'specs/items.spec.js',
          titlePath: ['items page loads'],
          project: 'chromium',
          status: 'passed',
          attempt: 1,
          expectedFailure: false,
        },
      ],
      shard: null,
    }),
    'utf8',
  );
}

interface FromRunJson {
  run: { dir: string; runId: string };
  suggestions: Array<{
    resourceId: string;
    route: string;
    obligationIds: string[];
    evidence: Array<{ testId: string; testResolved: string | null; method: string; path: string; status: number }>;
    command: string | null;
  }>;
  unmatched: Array<{ testId: string; testResolved: string | null; method: string; path: string; status: number }>;
  ambiguous: Array<{ testId: string; method: string; path: string; status: number; candidates: string[] }>;
}

describe('tests suggest --from-run', () => {
  it('names tests by observed evidence with the exact mark command and advisories', async () => {
    await withTempRepo({}, async (repo) => {
      installFromRunRepo(repo);
      writeRunState(repo);

      const result = await runCli(repo, ['tests', 'suggest', '--from-run', '--json']);
      expect(result.code, `${result.stdout}\n${result.stderr}`).toBe(0);
      const report = JSON.parse(result.stdout) as FromRunJson;
      expect(report.run.runId).toBe(RUN_ID);

      // One suggestion per matched endpoint: the GET (200) and the POST (201).
      expect(report.suggestions.map((suggestion) => suggestion.route).sort()).toEqual(['GET /api/items', 'POST /api/items']);
      const get = report.suggestions.find((suggestion) => suggestion.route === 'GET /api/items');
      expect(get).toBeDefined();
      expect(get!.resourceId).toMatch(/^tenant\.http-get-api-items-[0-9a-f]{8}$/);
      expect(get!.obligationIds).toEqual([
        `${get!.resourceId}:http:request-observed`,
        `${get!.resourceId}:http:response-status-ok`,
      ]);
      expect(get!.evidence).toEqual([
        { testId: 'items-1', testResolved: ITEMS_KEY, method: 'GET', path: '/api/items', status: 200 },
      ]);
      expect(get!.command).toBe(
        `gateforge tests mark --test '${ITEMS_KEY}' --kind observed-e2e ` +
          `--obligation '${get!.obligationIds[0]!}' --obligation '${get!.obligationIds[1]!}' ` +
          `--reason 'observed in run ${RUN_ID}: GET /api/items -> 200'`,
      );

      // Advisory sections: an unrouted app call and an ambiguous match.
      expect(report.unmatched).toEqual([
        { testId: 'items-1', testResolved: ITEMS_KEY, method: 'GET', path: '/api/widgets', status: 200 },
      ]);
      expect(report.ambiguous).toEqual([
        {
          testId: 'items-1',
          testResolved: ITEMS_KEY,
          method: 'GET',
          path: '/api/ambiguous/7',
          status: 200,
          candidates: ['GET /api/ambiguous/{*}', 'GET /api/ambiguous/{}'],
        },
      ]);

      // Advisory only: suggesting never writes the test map.
      expect(existsSync(join(repo.root, '.gateforge', 'test-map.yml'))).toBe(false);

      // The human surface carries the same data, command included.
      const text = await runCli(repo, ['tests', 'suggest', '--from-run']);
      expect(text.code, `${text.stdout}\n${text.stderr}`).toBe(0);
      expect(text.stdout).toContain('GET /api/items -> 200');
      expect(text.stdout).toContain(`--reason 'observed in run ${RUN_ID}: GET /api/items -> 200'`);
      expect(text.stdout).toContain('matched no endpoint');
      expect(text.stdout).toContain('/api/widgets');
      expect(text.stdout).toContain('ambiguous');

      // Marking the GET obligations for real resolves them; the POST
      // suggestion stays until its own evidence is declared.
      const marked = await runCli(repo, [
        'tests', 'mark',
        '--test', ITEMS_KEY,
        '--kind', 'observed-e2e',
        '--obligation', get!.obligationIds[0]!,
        '--obligation', get!.obligationIds[1]!,
        '--reason', `observed in run ${RUN_ID}: GET /api/items -> 200`,
      ]);
      expect(marked.code, `${marked.stdout}\n${marked.stderr}`).toBe(0);
      const after = await runCli(repo, ['tests', 'suggest', '--from-run', '--json']);
      expect(after.code, `${after.stdout}\n${after.stderr}`).toBe(0);
      const afterReport = JSON.parse(after.stdout) as FromRunJson;
      expect(afterReport.suggestions.map((suggestion) => suggestion.route)).toEqual(['POST /api/items']);
    });
  }, 120_000);
});
