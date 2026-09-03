/**
 * The init policies template (ADR 0004 D8): endpoint capability
 * classification must compile capability-specific obligations and never
 * serve browser-exercise obligations to server-only (unconsumed)
 * endpoints. Domain-capability policies are deliberately ABSENT: the
 * auth/workflow/webhook/task/validation contracts have no honest
 * evidence channel until their packs ship engine-owned state-observing
 * producers, so the template must not require them. The template is
 * validated against the same pinned `PolicyFileSchema` the pipeline
 * enforces on `.gateforge/policies.yml`.
 */
import { parse as parseYaml } from 'yaml';
import { describe, expect, it } from 'vitest';
import { PolicyFileSchema } from '@gateforge/core';
import { POLICIES_TEMPLATE } from '../src/commands/init.js';

const parsed = PolicyFileSchema.parse(parseYaml(POLICIES_TEMPLATE));
const byId = new Map(parsed.policies.map((policy) => [policy.id, policy]));

/** Contract namespaces with no honest evidence channel today. */
const UNPRODUCIBLE_NAMESPACES = ['auth:', 'workflow:', 'webhook:', 'task:', 'validation:'];

describe('init policies template: endpoint policies (ADR 0004 D8)', () => {
  it('parses and lists exactly the two honest policies', () => {
    expect(parsed.policies.map((policy) => policy.id)).toEqual([
      'frontend-consumed-endpoints',
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

  it('no policy requires an auth:/workflow:/webhook:/task:/validation: contract', () => {
    for (const policy of parsed.policies) {
      for (const contract of policy.require) {
        const unproducible = UNPRODUCIBLE_NAMESPACES.some((namespace) =>
          contract.startsWith(namespace),
        );
        expect(
          unproducible,
          `policy '${policy.id}' requires '${contract}', which has no honest evidence ` +
            'channel until its pack ships a state-observing producer',
        ).toBe(false);
      }
    }
  });

  it('no policy matches on a capability when-clause', () => {
    for (const policy of parsed.policies) {
      expect(
        policy.when,
        `policy '${policy.id}' must not match on 'capability'`,
      ).not.toHaveProperty('capability');
    }
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
