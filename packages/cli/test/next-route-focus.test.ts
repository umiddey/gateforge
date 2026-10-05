/**
 * `gateforge next` orders items of the SAME cause by business weight
 * (0.9.0, problem 22).
 *
 * On a repository with a thousand unresolved routes, alphabetical order
 * put a fifteen-line demo app's `/api/test` at the top, so the first
 * thing an agent or an owner was told to do was a throwaway. A route
 * that serves business data — linked to a model, or consumed by the
 * frontend — comes first inside one rank. The cause rank itself is
 * untouched: a capability gap still outranks everything.
 *
 * The fixture is built so alphabetical order and business weight
 * DISAGREE, which is the only way the regression is real:
 * `demo` sorts before `status` and before `v2-orders`.
 */
import { describe, expect, it } from 'vitest';
import { withTempRepo, type TempRepo } from '@gate-forge/core';
import { POLICIES_YML, CLASSIFICATION_POLICY_YML, runCli } from './helpers.js';

/** The fixture detector: one unresolved business model plus three routes. */
const DETECTOR = `const SOURCE = 'src/routes.js';
const LOCATION = { file: SOURCE, line: 1, col: 0 };
const DETECTOR = { id: 'gateforge.focus-fixture', version: '1.0.0' };

function signal(resourceName, dimension, assertion) {
  return {
    schemaVersion: 1,
    target: { resourceName },
    dimension,
    assertion,
    basis: 'declaration',
    source: 'gateforge.focus-fixture',
    location: LOCATION,
    detector: DETECTOR,
  };
}

function endpoint(name, method, canonicalPath, extra) {
  return {
    schemaVersion: 1,
    id: name,
    kind: 'http.endpoint',
    source: SOURCE,
    location: LOCATION,
    detectorVersion: DETECTOR.version,
    attributes: Object.assign(
      { resourceName: name, method, canonicalPath, identity: method + ' ' + canonicalPath },
      extra || {},
    ),
  };
}

const DEMO = 'http-get-api-demo-bbbbbbbb';
const STATUS = 'http-get-api-status-cccccccc';
const ORDERS_ROUTE = 'http-get-api-v2-orders-aaaaaaaa';

export default {
  async discover() {
    return {
      resources: [
        endpoint(DEMO, 'GET', '/api/demo'),
        endpoint(STATUS, 'GET', '/api/status', { frontendConsumed: true }),
        endpoint(ORDERS_ROUTE, 'GET', '/api/v2/orders', { linkedResourceName: 'orders' }),
        {
          schemaVersion: 1,
          id: 'orders',
          kind: 'fixture.entity',
          source: SOURCE,
          location: LOCATION,
          detectorVersion: DETECTOR.version,
          attributes: { resourceName: 'orders', updateableFields: ['id', 'total'] },
        },
      ],
      unresolved: [],
      findings: [],
      classificationSignals: [
        signal(DEMO, 'identity', ['method', 'path']),
        signal(STATUS, 'identity', ['method', 'path']),
        signal(ORDERS_ROUTE, 'identity', ['method', 'path']),
        signal(ORDERS_ROUTE, 'adapter-binding', 'orders'),
        signal('orders', 'identity', ['id']),
        signal('orders', 'adapter-binding', 'tenant.orders'),
        signal('orders', 'lifecycle.read', true),
        signal('orders', 'delete-semantics', 'hard'),
      ],
    };
  },
};
`;

/** The three route resource names the fixture declares. */
const DEMO = 'http-get-api-demo-bbbbbbbb';
const STATUS = 'http-get-api-status-cccccccc';
const ORDERS_ROUTE = 'http-get-api-v2-orders-aaaaaaaa';
const CONFIG = `schemaVersion: 1
project:
  languages: [javascript]
  paths:
    include: ['src/**/*.js']
    exclude: []
plugins:
  - id: gateforge.focus-fixture
    version: '1.0.0'
    transport: in-process
    module: ./plugin.mjs
policies: .gateforge/policies.yml
classificationPolicy: .gateforge/classification-policy.yml
adapters: .gateforge/adapters
waivers: .gateforge/waivers
baselines: .gateforge/baselines/obligations.json
scan:
  scanRoots: ['src/**/*.txt']
  declarations:
    internality: gateforge:internal
  volatileFields: []
changed:
  provider: auto
witness:
  maxDurationSeconds: 5
clock:
  mode: system
`;

/** The first item `next --json` points at. */
async function firstNext(repo: TempRepo): Promise<string> {
  const { code, stdout, stderr } = await runCli(repo, ['next', '--json']);
  expect(code, `${stdout}\n${stderr}`).toBe(1);
  const parsed = JSON.parse(stdout) as { next: string | null };
  expect(parsed.next).not.toBeNull();
  return parsed.next as string;
}

describe('next orders a rank by business weight, not by name', () => {
  it('prefers a consumed route over an unlinked demo route that sorts first', async () => {
    await withTempRepo({}, async (repo) => {
      repo.writeFiles({
        'src/routes.js': 'export const routes = [];\n',
        'plugin.mjs': DETECTOR,
        '.gateforge.yml': CONFIG,
        '.gateforge/policies.yml': POLICIES_YML,
        '.gateforge/classification-policy.yml': CLASSIFICATION_POLICY_YML,
      });
      // Alphabetical order starts with the demo route; business weight
      // starts with the route the frontend actually calls.
      expect(DEMO < STATUS).toBe(true);
      expect(await firstNext(repo)).toBe(STATUS);
    });
  });

  it('prefers a route linked to a model when nothing is consumed', async () => {
    await withTempRepo({}, async (repo) => {
      repo.writeFiles({
        'src/routes.js': 'export const routes = [];\n',
        'plugin.mjs': DETECTOR.replace(
          "        endpoint(STATUS, 'GET', '/api/status', { frontendConsumed: true }),\n",
          '',
        ),
        '.gateforge.yml': CONFIG,
        '.gateforge/policies.yml': POLICIES_YML,
        '.gateforge/classification-policy.yml': CLASSIFICATION_POLICY_YML,
      });
      expect(DEMO < ORDERS_ROUTE).toBe(true);
      expect(await firstNext(repo)).toBe(ORDERS_ROUTE);
    });
  });

  it('still reports a throwaway route when there is no business route at all', async () => {
    await withTempRepo({}, async (repo) => {
      repo.writeFiles({
        'src/routes.js': 'export const routes = [];\n',
        'plugin.mjs': DETECTOR.replace(
          "        endpoint(STATUS, 'GET', '/api/status', { frontendConsumed: true }),\n        endpoint(ORDERS_ROUTE, 'GET', '/api/v2/orders', { linkedResourceName: 'orders' }),\n",
          '',
        ),
        '.gateforge.yml': CONFIG,
        '.gateforge/policies.yml': POLICIES_YML,
        '.gateforge/classification-policy.yml': CLASSIFICATION_POLICY_YML,
      });
      // Nothing is hidden by the preference: with no business route in
      // the graph, the unlinked one is still the item to work on.
      expect(await firstNext(repo)).toBe(DEMO);
    });
  });
});
