/**
 * The init policies template (ADR 0004 D8): endpoint capability
 * classification must compile capability-specific obligations and never
 * serve browser-exercise obligations to server-only (unconsumed)
 * endpoints. The template is validated against the same pinned
 * `PolicyFileSchema` the pipeline enforces on `.gateforge/policies.yml`.
 */
import { parse as parseYaml } from 'yaml';
import { describe, expect, it } from 'vitest';
import { PolicyFileSchema } from '@gateforge/core';
import { POLICIES_TEMPLATE } from '../src/commands/init.js';

const parsed = PolicyFileSchema.parse(parseYaml(POLICIES_TEMPLATE));
const byId = new Map(parsed.policies.map((policy) => [policy.id, policy]));

describe('init policies template: endpoint policies (ADR 0004 D8)', () => {
  it('parses and lists the three endpoint policies before the persistence policy', () => {
    expect(parsed.policies.map((policy) => policy.id)).toEqual([
      'frontend-consumed-endpoints',
      'workflow-command-endpoints',
      'validation-preview-endpoints',
      'user-facing-persistence',
    ]);
  });

  it('scopes frontend-consumed-endpoints to consumed endpoints with no capability clause', () => {
    const policy = byId.get('frontend-consumed-endpoints');
    expect(policy?.when).toEqual({ kind: 'http.endpoint', consumed: true });
    expect(policy?.require).toEqual([
      'http:frontend-request-observed',
      'http:response-status-ok',
    ]);
  });

  it('compiles workflow obligations for consumed command-shaped endpoints', () => {
    const policy = byId.get('workflow-command-endpoints');
    expect(policy?.when).toEqual({ capability: 'workflow-command', consumed: true });
    expect(policy?.require).toEqual([
      'workflow:transition-allowed',
      'workflow:transition-rejected',
      'workflow:terminal-immutable',
    ]);
  });

  it('compiles validation obligations for consumed validation-preview endpoints', () => {
    const policy = byId.get('validation-preview-endpoints');
    expect(policy?.when).toEqual({ capability: 'validation-preview', consumed: true });
    expect(policy?.require).toEqual([
      'validation:boundary-accepted',
      'validation:boundary-rejected',
      'validation:no-side-effect-on-reject',
    ]);
  });

  it('leaves the user-facing-persistence policy unchanged (tables are not endpoints)', () => {
    const policy = byId.get('user-facing-persistence');
    expect(policy?.when).toEqual({ exposure: 'user-facing' });
    expect(policy?.require).toEqual([
      'persistence:create',
      'persistence:read',
      'persistence:update',
      'persistence:delete',
    ]);
  });
});

// The config template keeps its own init-time self-check via parseConfig
// (asserted end-to-end by test/init.test.ts through `loadConfig`), so it
// is not re-asserted here.
