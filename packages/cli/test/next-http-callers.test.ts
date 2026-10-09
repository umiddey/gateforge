/**
 * `gateforge next` names WHO calls a used-but-unproven route (0.14 WP3
 * step 3, plan §4.5). A route the static frontend join consumed owes its
 * two transport contracts; until one is proved, the single next action
 * has to say which call site (or which witnessing test) makes it real —
 * "the route is unproven" alone is not an action anyone can take.
 *
 * The facts come from the same detector contribution the product already
 * produces: one server route plus one frontend call. No new scanner.
 */
import { describe, expect, it } from 'vitest';
import { withTempRepo } from '@gate-forge/core';
import { configYml, runCli } from './helpers.js';

/** One served route plus the frontend call that consumes it. */
const ROUTE_AND_CALL_PLUGIN_SOURCE = `export default {
  discover(paths) {
    const route = {
      schemaVersion: 1,
      id: 'http.contract:backend/api/v1/accounts.py:app.get_x:GET:/x',
      kind: 'http.contract',
      source: 'backend/api/v1/accounts.py',
      location: { file: 'backend/api/v1/accounts.py', line: 10, col: 0 },
      detectorVersion: '1.0.0',
      attributes: {
        role: 'server-route',
        method: 'GET',
        normalizedPath: '/x',
        rawPath: '/x',
        framework: 'test',
        handlerSymbol: 'app.get_x',
        responseSchemaSymbols: ['RouteOut'],
      },
    };
    const call = {
      schemaVersion: 1,
      id: 'http.contract:frontend/api.ts:2:GET:/x',
      kind: 'http.contract',
      source: 'frontend/api.ts',
      location: { file: 'frontend/api.ts', line: 2, col: 2 },
      detectorVersion: '1.0.0',
      attributes: {
        role: 'frontend-call',
        method: 'GET',
        normalizedPath: '/x',
        rawPath: '/x',
        framework: 'fetch',
        callsites: ['frontend/api.ts:2'],
      },
    };
    return {
      resources: [route, call],
      unresolved: [],
      findings: [],
      classificationSignals: [],
      scannedPaths: [...paths],
    };
  },
};
`;

const POLICIES_YML = `\
schemaVersion: 1
policies:
  - id: consumed-endpoints-transport
    when:
      kind: http.endpoint
      consumed: true
    require:
      - http:request-observed
      - http:response-status-ok
`;

const CLASSIFICATION_POLICY_YML = `\
schemaVersion: 1
trustedInternalEntryPoints: []
internalRules: []
planes:
  rules:
    - match: backend/api/v1/**
      plane: tenant
      reason: tenant router tree
`;

describe('next names the caller of a used-but-unproven route', () => {
  it('prints the static call site that makes the route real', async () => {
    await withTempRepo({}, async (repo) => {
      repo.writeFiles({
        '.gitignore': '.gateforge/test-gates/\n',
        '.gateforge.yml': configYml({ include: "['backend/**/*.py']" }),
        '.gateforge/policies.yml': POLICIES_YML,
        '.gateforge/classification-policy.yml': CLASSIFICATION_POLICY_YML,
        'plugin.mjs': ROUTE_AND_CALL_PLUGIN_SOURCE,
        'backend/api/v1/accounts.py': '# router fixture\n',
        'frontend/api.ts': 'export const load = () => fetch("/x");\n',
      });
      const { code, stdout } = await runCli(repo, ['next']);
      // The route is USED (the frontend consumes it) and UNPROVEN, so the
      // single next action must name the call site.
      expect(code, stdout).toBe(1);
      expect(stdout).toContain('http:request-observed');
      expect(stdout).toMatch(/why: .*frontend\/api\.ts:2/);
    });
  }, 60_000);
});