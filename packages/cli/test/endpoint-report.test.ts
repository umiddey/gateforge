/**
 * Phase 7 tests: endpoint inventory reporting, join-aware --changed
 * scoping, and the discover/explain text surfaces.
 */
import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ResourceGraph } from '@gate-forge/core';
import { sourcesByResourceId } from '../src/pipeline.js';
import { renderEndpointInventory } from '../src/endpoint-report.js';
import type { EndpointInventory } from '../src/endpoint-compiler.js';

describe('join-aware --changed scoping (sourcesByResourceId)', () => {
  const graph = {
    schemaVersion: 1,
    resources: [
      {
        schemaVersion: 1,
        id: 'tenant.accounts',
        name: 'accounts',
        plane: 'tenant',
        kind: 'sqlalchemy.table',
        source: 'backend/models/account.py',
        location: { file: 'backend/models/account.py', line: 4, col: 0 },
        exposure: 'user-facing',
        classification: null,
        classificationTrace: null,
        detector: { id: 'test', version: '1' },
        attributes: {},
      },
      {
        schemaVersion: 1,
        id: 'tenant.http-post-api-accounts-e6912669',
        name: 'http-post-api-accounts-e6912669',
        plane: 'tenant',
        kind: 'http.endpoint',
        source: 'backend/routes.py',
        location: { file: 'backend/routes.py', line: 10, col: 0 },
        exposure: 'user-facing',
        classification: null,
        classificationTrace: null,
        detector: { id: 'gateforge.endpoint-compiler', version: '1' },
        attributes: {
          callSources: ['frontend/src/api.ts:12:4', 'frontend/src/api.ts:30:6'],
        },
      },
    ],
    unresolved: [],
    findings: [],
    stale: [],
  } as unknown as ResourceGraph;

  it('the endpoint is in scope when its ROUTE source changed', () => {
    const sources = sourcesByResourceId(graph);
    expect(sources.get('tenant.http-post-api-accounts-e6912669')).toContain('backend/routes.py');
  });

  it('the endpoint is in scope when a joined frontend-call source changed', () => {
    const sources = sourcesByResourceId(graph);
    expect(sources.get('tenant.http-post-api-accounts-e6912669')).toContain('frontend/src/api.ts');
  });

  it('a table keeps plain source semantics', () => {
    const sources = sourcesByResourceId(graph);
    expect(sources.get('tenant.accounts')).toEqual(['backend/models/account.py']);
  });
});

describe('endpoint inventory text report', () => {
  const inventory: EndpointInventory = {
    facts: [],
    endpoints: [
      {
        method: 'POST',
        canonicalPath: '/api/v1/accounts',
        identity: 'POST /api/v1/accounts',
        resourceName: 'http-post-api-v1-accounts-e6912669',
        capabilities: ['crud-create'],
        capabilityTrace: [{ capability: 'crud-create', rule: 'POST_WITH_SCHEMA_OR_LINK', evidence: 'schema facts' }],
        linkedResourceName: 'accounts',
        frontendConsumed: true,
        deleteSemantics: null,
        routes: [
          {
            schemaVersion: 1,
            role: 'server-route',
            method: 'POST',
            normalizedPath: '/api/v1/accounts',
            rawPath: '/api/v1/accounts',
            framework: 'fastapi',
            handlerSymbol: 'app.create_account',
            source: { file: 'backend/routes.py', line: 12, col: 0 },
          },
        ],
        calls: [
          {
            schemaVersion: 1,
            role: 'frontend-call',
            method: 'POST',
            normalizedPath: '/api/v1/accounts',
            rawPath: '/api/v1/accounts',
            framework: 'fetch',
            callsites: ['frontend/src/api.ts:30:2'],
            source: { file: 'frontend/src/api.ts', line: 30, col: 2 },
          },
        ],
      },
      {
        method: 'GET',
        canonicalPath: '/health/ready',
        identity: 'GET /health/ready',
        resourceName: 'http-get-health-ready-a1b2c3d4',
        capabilities: ['health-operations'],
        capabilityTrace: [],
        linkedResourceName: null,
        frontendConsumed: false,
        deleteSemantics: null,
        routes: [
          {
            schemaVersion: 1,
            role: 'server-route',
            method: 'GET',
            normalizedPath: '/health/ready',
            rawPath: '/health/ready',
            framework: 'fastapi',
            handlerSymbol: 'app.readiness',
            source: { file: 'backend/routes.py', line: 40, col: 0 },
          },
        ],
        calls: [],
      },
    ],
    unwired: [
      {
        code: 'FRONTEND_ROUTE_UNWIRED',
        detail: "frontend call 'GET /api/ghosts' matches no backend route",
        location: { file: 'frontend/src/api.ts', line: 50, col: 2 },
        candidates: [],
      },
    ],
    ambiguous: [],
  };

  it('renders totals, consumption, capabilities, and both ends of every join', () => {
    const text = renderEndpointInventory(inventory);
    expect(text).toContain('endpoint inventory (2):');
    expect(text).toContain('frontend-consumed: 1 of 2');
    expect(text).toContain('crud-create:1');
    expect(text).toContain('POST /api/v1/accounts  capabilities=crud-create  consumed=yes  link=accounts');
    expect(text).toContain('route=backend/routes.py:12  callsites=1');
    expect(text).toContain('GET /health/ready');
    expect(text).toContain('unmatched frontend calls (1):');
    expect(text).toContain('frontend/src/api.ts:50');
    expect(text).toContain('unconsumed backend routes (1):');
    expect(text).toContain('ambiguous joins (0):');
  });

  it('renders deterministic output under input permutation', () => {
    const reversed: EndpointInventory = {
      ...inventory,
      endpoints: [...inventory.endpoints].reverse(),
    };
    const forward = renderEndpointInventory(inventory);
    const back = renderEndpointInventory(reversed);
    const forwardLines = forward.split('\n').sort();
    const backLines = back.split('\n').sort();
    expect(JSON.stringify(forwardLines)).toBe(JSON.stringify(backLines));
  });
});

describe('discover reports the inventory', () => {
  it('the discover --json document carries the endpointInventory key', async () => {
    const { withTempRepo } = await import('@gate-forge/core');
    const { runCli, installFixture } = await import('./helpers.js');
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      repo.writeFiles({ 'src/routes.ts': "app.get('/accounts', h);\n" });
      const result = await runCli(repo, ['discover', '--json']);
      expect(result.code).toBe(0);
      const parsed = JSON.parse(result.stdout) as { endpointInventory: { endpoints: unknown[] } };
      expect(parsed).toHaveProperty('endpointInventory');
      expect(Array.isArray(parsed.endpointInventory.endpoints)).toBe(true);
    });
  });
});
