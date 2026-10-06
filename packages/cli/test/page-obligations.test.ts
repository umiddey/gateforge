import { describe, expect, it } from 'vitest';
import type { ResourceGraph } from '@gate-forge/core';
import {
  bindPageRouteParams,
  createdEntityIdsFromRecords,
  pageObligationsFromGraph,
} from '../src/page-obligations.js';
import { configYml, installFixture, runCli, withTempRepo } from './helpers.js';

describe('page obligation family', () => {
  it('creates loads and data-ok obligations using the page resource identity', () => {
    const graph = {
      schemaVersion: 1,
      resources: [{ schemaVersion: 1, id: 'tenant.page-orders-1234abcd', name: 'page-orders-1234abcd', plane: 'tenant', kind: 'ui.page', source: 'src/routes.tsx', location: { file: 'src/routes.tsx', line: 12, col: 0 }, exposure: 'user-facing', classification: null, classificationTrace: null, detector: { id: 'gateforge.pack-react-router', version: '0.13.0' }, attributes: { path: '/orders', audience: 'tenant' } }],
      unresolved: [], findings: [], stale: [],
    } as unknown as ResourceGraph;
    expect(pageObligationsFromGraph(graph).map(({ id, contract }) => [id, contract])).toEqual([
      ['tenant.page-orders-1234abcd:page:data-ok', 'page:data-ok'],
      ['tenant.page-orders-1234abcd:page:loads', 'page:loads'],
    ]);
  });

  it('uses seeded or uniquely matching engine-created IDs for dynamic routes without guessing', () => {
    const created = (entityId: string, resourceId = 'tenant.orders') => ({
      schemaVersion: 1,
      recordId: 'a'.repeat(64),
      runId: '00000000-0000-4000-8000-000000000001',
      trust: 'witnessed',
      obligationId: `${resourceId}:persistence:create`,
      kind: 'ui.action',
      testId: 'orders-journey',
      payload: { operation: 'create', entityId },
      origin: 'engine-observed',
    });
    const oneCreated = createdEntityIdsFromRecords([created('seed/42')]);
    expect(bindPageRouteParams('/orders/:id', 'tenant', undefined, oneCreated)).toEqual({
      path: '/orders/seed%2F42',
      unbound: [],
    });
    const ambiguous = createdEntityIdsFromRecords([created('42'), created('43')]);
    expect(bindPageRouteParams('/orders/:id', 'tenant', undefined, ambiguous)).toEqual({
      path: null,
      unbound: ['id'],
    });
    expect(bindPageRouteParams('/orders/:id', 'tenant', { id: 'seeded' }, ambiguous)).toEqual({
      path: '/orders/seeded',
      unbound: [],
    });
    expect(
      bindPageRouteParams('/orders/:id', 'tenant', undefined, createdEntityIdsFromRecords([created('42', 'tenant.customers')])),
    ).toEqual({ path: null, unbound: ['id'] });
  });

  it('lists page promises in check and adoption forgives existing page debt', async () => {
    await withTempRepo({}, async (repo) => {
      const plugins = `  - id: gateforge.pack-react-router\n    version: '0.13.0'\n    transport: in-process\n    module: '@gate-forge/pack-react-router'`;
      const coverage = "coverage: [{ capability: pages.react-router, detector: gateforge.pack-react-router, appliesTo: ['src/**/*.tsx'] }]";
      installFixture(repo, { include: "['src/**/*.tsx']", plugins, scan: { scanRoots: "['src/**/*.tsx']", coverage } });
      repo.writeFiles({
        '.gateforge.yml': `${configYml({ include: "['src/**/*.tsx']", plugins, scan: { scanRoots: "['src/**/*.tsx']", coverage } })}pages:\n  router: react-router\n  audiences:\n    - name: tenant\n      loginRoute: /login\n      guard: TenantGuard\n  errorMarkers: []\n  params: {}\n  exclude: []\n  sweep: true\n`,
        'src/routes.tsx': `export const routes = <><Route path="/orders" element={<TenantGuard><Orders /></TenantGuard>} /><Route path="/customers" element={<TenantGuard><Customers /></TenantGuard>} /></>;\n`,
      });
      const check = await runCli(repo, ['check']);
      expect(check.stdout).toContain(':page:loads');
      expect(check.stdout).toContain(':page:data-ok');
      expect(await runCli(repo, ['adopt'])).toMatchObject({ code: 0 });
      const adoptedCheck = await runCli(repo, ['check']);
      expect(adoptedCheck.code).toBe(0);
    });
  });

  it('does not guess an obligation plane for unresolved audience resources', () => {
    const graph = { schemaVersion: 1, resources: [{ id: null, kind: 'ui.page' }], unresolved: [], findings: [], stale: [] } as unknown as ResourceGraph;
    expect(pageObligationsFromGraph(graph)).toEqual([]);
  });
});
