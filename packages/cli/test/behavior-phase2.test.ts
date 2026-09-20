/**
 * Phase 2 CLI wiring (plan 2026-09-19): changed-file selection follows
 * declared effects; behavior-policy edits are gate-defining and digest-bound.
 */
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { sourcesByResourceId } from '../src/pipeline.js';
import { computeEvaluationScope } from '../src/scope.js';
import { buildGateContext } from '../src/input-snapshot.js';
import { computeTrustedPolicyDigest } from '../src/execution.js';
import type { BehaviorCatalog } from '@gate-forge/core';

const LIFECYCLE = {
  create: true,
  read: true,
  update: true,
  delete: true,
  deleteSemantics: 'hard' as const,
};

function resource(id: string, source: string, attributes: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1 as const,
    id,
    name: id,
    plane: 'tenant' as const,
    kind: 'http.endpoint',
    source,
    location: { file: source, line: 1, col: 0 },
    exposure: 'user-facing' as const,
    classification: {
      exposure: 'user-facing' as const,
      plane: 'tenant' as const,
      lifecycle: LIFECYCLE,
      primaryKey: ['id'],
      evidenceAdapter: 'accounts',
    },
    classificationTrace: null,
    detector: { id: 'd', version: '1' },
    attributes,
  };
}

function graphOf(resources: ReturnType<typeof resource>[]) {
  return { schemaVersion: 1 as const, resources: resources as never, unresolved: [], findings: [], stale: [] } as never;
}

function behaviorCatalog(): BehaviorCatalog {
  return {
    schemaVersion: 1,
    catalogDigest: 'd'.repeat(64),
    cases: [
      {
        caseId: 'c'.repeat(64),
        specDigest: 'e'.repeat(64),
        resourceId: 'tenant.http-profile',
        endpointResourceId: 'tenant.http-profile',
        obligationIds: ['tenant.http-profile:http:effect-verified'],
        definition: {
          id: 'owner-update',
          contract: 'http:effect-verified',
          channel: 'engine-http',
          fixture: 'one-account',
          actor: 'owner-a',
          action: {
            kind: 'request',
            method: 'POST',
            pathTemplate: '/profile',
            path: {},
            query: {},
            body: { encoding: 'json', fields: {} },
            credentialVariant: 'valid',
          },
          expect: {
            statuses: [200],
            response: [],
            state: [{ kind: 'unchanged', scope: 'accounts' }],
          },
        },
        effects: [
          {
            id: 'accounts',
            resourceId: 'tenant.accounts',
            adapter: 'accounts',
            scope: 'fixture-accounts',
            identityFields: ['id'],
            fields: ['first_name'],
            completion: 'immediate',
          },
        ],
        sourceFiles: ['backend/profile.js', 'models/accounts.py'],
      },
    ],
    requirements: { 'tenant.http-profile:http:effect-verified': ['c'.repeat(64)] },
    dependencies: { 'tenant.http-profile': ['tenant.accounts'] },
  };
}

const BASE_CONFIG = {
  project: { paths: { include: ['**/*.js'], exclude: [] } },
  policies: 'policies.yml',
  classificationPolicy: 'classification.yml',
  baselines: '.gateforge/baselines.json',
  adapters: '.gateforge/adapters',
  waivers: '.gateforge/waivers',
  plugins: [],
  changed: { provider: 'all-files' },
  witness: { url: 'http://127.0.0.1:1' },
  clock: { fixed: '2026-01-01T00:00:00.000Z' },
};

describe('Phase 2 changed selection follows effects', () => {
  it('a table source change selects the endpoint declaring an effect on it', () => {
    const graph = graphOf([
      resource('tenant.http-profile', 'backend/profile.js'),
      resource('tenant.accounts', 'models/accounts.py'),
      resource('tenant.http-invoices', 'backend/invoices.js'),
    ]);
    const without = sourcesByResourceId(graph, null);
    expect(without.get('tenant.http-profile')).toEqual(['backend/profile.js']);
    const withCatalog = sourcesByResourceId(graph, behaviorCatalog());
    expect(withCatalog.get('tenant.http-profile')).toContain('models/accounts.py');
    expect(withCatalog.get('tenant.http-invoices')).not.toContain('models/accounts.py');
  });
});

describe('Phase 2 behavior policy is gate-defining', () => {
  it('a behavior-policy change forces full scope', () => {
    const config = { ...BASE_CONFIG, behaviorPolicy: '.gateforge/behavior.yml' } as never;    const decision = computeEvaluationScope({
      config,
      changedFiles: ['.gateforge/behavior.yml'],
      knownSourceFiles: ['backend/profile.js'],
    });
    expect(decision.mode).toBe('all');
    expect(decision.expandedBecause).toContain('.gateforge/behavior.yml');
  });

  it('trusted policy digest binds the behavior document bytes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gf-behavior-'));
    mkdirSync(join(dir, '.gateforge', 'adapters'), { recursive: true });
    mkdirSync(join(dir, '.gateforge', 'waivers'), { recursive: true });
    writeFileSync(join(dir, '.gateforge.yml'), 'config: 1\n');
    writeFileSync(join(dir, 'policies.yml'), 'policies: 1\n');
    writeFileSync(join(dir, 'classification.yml'), 'classification: 1\n');
    writeFileSync(join(dir, '.gateforge', 'behavior.yml'), 'endpoints: []\n');
    const paths = {
      config: '.gateforge.yml',
      policies: 'policies.yml',
      classificationPolicy: 'classification.yml',
      behaviorPolicy: '.gateforge/behavior.yml',
      sidecar: '.gateforge/test-map.yml',
      adaptersDir: '.gateforge/adapters',
      waiverFiles: [],
      pluginModules: [],
    };
    const before = computeTrustedPolicyDigest(dir, paths);
    writeFileSync(join(dir, '.gateforge', 'behavior.yml'), 'endpoints: [changed]\n');
    const after = computeTrustedPolicyDigest(dir, paths);
    expect(before).toMatch(/^[0-9a-f]{64}$/);
    expect(after).not.toBe(before);
  });

  it('gate context binds requirementsDigest so expectation edits move the input digest', () => {
    const obligation = {
      schemaVersion: 1 as const,
      id: 'tenant.http-profile:http:effect-verified',
      resourceId: 'tenant.http-profile',
      contract: 'http:effect-verified',
      policyId: 'behavior-policy',
      lifecycle: LIFECYCLE,
      requirementsDigest: 'f'.repeat(64),
    };
    const context = buildGateContext(BASE_CONFIG as never, [], {}, [obligation as never], []);
    expect(context.obligations[0]).toMatchObject({ requirementsDigest: 'f'.repeat(64) });
  });
});
